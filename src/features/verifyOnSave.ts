/**
 * Verify on save.
 *
 * Two things shape this, and the second is the uncomfortable one.
 *
 * **Single flight, always.** Every `dfx` run boots the Unreal Editor, which on this machine peaks
 * around 10 GB. Two of them at once is not slow, it is a different kind of bad -- so there is one
 * process at a time, a queue behind it, and a save arriving mid-run marks the file for a re-run
 * rather than starting a second engine.
 *
 * **It is off by default, and that is not timidity.** Measured on this project, a single-file verify
 * is 13 seconds, essentially all of it engine boot -- the check itself is a fraction of a second.
 * That is tolerable for a deliberate pass over a file and much too slow to sit behind every save
 * while iterating, and no amount of polish here moves it: the floor is the boot. The machinery is
 * right and the wiring is real; what makes it *affordable* is talking to an editor that is already
 * running. Until then this is opt-in, and its setting description says why.
 *
 * The queue, the single-flight rule, the diagnostic plumbing and the status item are all reusable
 * as-is once the transport changes: only `run` below knows that a verify means spawning anything.
 */

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';

import { BridgeDiagnostic, LineSplitter, WorkQueue, parseDiagnosticLine } from '../core';
import { BridgeClient } from './bridge';
import { DfxRunner } from './dfx';
import { ProblemSink } from './problemSink';

/** Long enough that saving twice in a row is one run, short enough not to feel deferred. */
const DEBOUNCE_MS = 800;

export class VerifyOnSave implements vscode.Disposable {
	private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
	private readonly disposables: vscode.Disposable[] = [];

	/** One engine at a time, deduplicated by path. The rule that matters; tested in core. */
	private readonly queue = new WorkQueue<string>((file) => file, (file) => this.run(file));

	private timer: NodeJS.Timeout | undefined;
	/** No process when the editor is doing the work; there is nothing local to kill in that case. */
	private active: { file: string; process?: ChildProcess } | undefined;
	private disposed = false;

	constructor(
		private readonly runner: DfxRunner,
		private readonly bridge: BridgeClient,
		private readonly problems: ProblemSink,
		private readonly output: vscode.OutputChannel,
	) {
		this.disposables.push(
			vscode.workspace.onDidSaveTextDocument((document) => this.onSaved(document)),
			vscode.workspace.onDidCloseTextDocument((document) => this.problems.forget(document.uri)),
		);
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.active?.process?.kill();
		this.status.dispose();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	/** The command form: verify this file now, regardless of the setting. */
	enqueue(file: string): void {
		this.queue.add(file);
		this.schedule(0);
	}

	private onSaved(document: vscode.TextDocument): void {
		if (document.languageId !== 'dreamfxlang' || document.uri.scheme !== 'file') {
			return;
		}
		if (!vscode.workspace.getConfiguration('dreamfx').get<boolean>('verifyOnSave', false)) {
			return;
		}
		this.queue.add(document.uri.fsPath);
		this.schedule(DEBOUNCE_MS);
	}

	private schedule(delay: number): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (!this.disposed) {
				this.queue.pump();
			}
			this.updateStatus();
		}, delay);
		this.updateStatus();
	}

	/** Both transports produce the same shape, so both clear stale problems the same way. */
	private publish(file: string, found: readonly BridgeDiagnostic[], ok: boolean, source: string, note: string): void {
		const total = this.problems.publish(file, found, source);
		this.output.appendLine(`verify: ${path.basename(file)} ${note}, ${total} diagnostic(s)`);
		this.lastResult = { file, total, ok };
		this.updateStatus();
	}

	/**
	 * Verify through the editor, when there is one.
	 *
	 * This is what makes verify-on-save affordable at all. Through the CLI it costs a 13-second engine
	 * boot per save, which is why the feature ships off by default; through an editor that is already
	 * loaded it costs what the check costs. Returns false when there is no editor to ask, and the
	 * caller falls back.
	 */
	private async runViaBridge(file: string): Promise<boolean> {
		const projectDir = this.bridge.findProjectDir(file);
		if (!projectDir || this.bridge.route(projectDir) !== 'bridge') {
			return false;
		}

		this.active = { file, process: undefined };
		this.updateStatus();

		const { response, error } = await this.bridge.send(projectDir, 'verify', { scope: 'file', sourceFile: file });
		this.active = undefined;

		if (!response) {
			// Not a silent fallback: the editor was there and did not answer, which is worth saying
			// before spending 13 seconds doing it the other way.
			this.output.appendLine(`verify: bridge failed (${error ?? 'no response'}); falling back to the CLI.`);
			return false;
		}

		this.publish(file, response.diagnostics, response.ok,
			'dfx verify (editor)', `via editor in ${response.durationMs} ms`);
		return true;
	}

	private async run(file: string): Promise<void> {
		if (await this.runViaBridge(file)) {
			return;
		}

		const script = await this.runner.findScript();
		if (!script) {
			this.output.appendLine('verify-on-save: no .skill/dfx.ps1 found; nothing to run.');
			return;
		}

		const shell = vscode.workspace.getConfiguration('dreamfx').get<string>('powershellPath', 'pwsh') || 'pwsh';
		const cwd = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))?.uri.fsPath ?? path.dirname(file);

		const child = spawn(shell,
			['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'verify', file],
			{ cwd, windowsHide: true });

		this.active = { file, process: child };
		this.updateStatus();
		this.output.appendLine(`verify-on-save: ${path.basename(file)}`);

		// Parsed into the same shape the bridge returns, so exactly one piece of code turns a
		// diagnostic into a Problems entry regardless of which route produced it.
		const found: BridgeDiagnostic[] = [];
		const splitter = new LineSplitter();

		const consume = (line: string): void => {
			const parsed = parseDiagnosticLine(line);
			if (parsed) {
				found.push(parsed);
			}
		};

		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => splitter.push(chunk).forEach(consume));
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (chunk: string) => this.output.append(chunk));

		const code = await new Promise<number>((resolve) => {
			child.on('error', (error) => {
				this.output.appendLine(`verify-on-save: could not start ${shell}: ${String(error)}`);
				resolve(-1);
			});
			child.on('close', (exitCode) => {
				splitter.flush().forEach(consume);
				resolve(exitCode ?? -1);
			});
		});

		this.active = undefined;

		if (this.disposed) {
			return;
		}

		this.publish(file, found, code === 0, 'dfx verify', `via CLI, exit ${code}`);
	}

	private lastResult: { file: string; total: number; ok: boolean } | undefined;

	private updateStatus(): void {
		if (this.disposed) {
			return;
		}

		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.languageId !== 'dreamfxlang') {
			this.status.hide();
			return;
		}

		if (this.active) {
			this.status.text = `$(sync~spin) verifying ${path.basename(this.active.file)}`;
			this.status.tooltip = 'dfx verify is running. It reads only -- no packages are written.';
		} else if (this.queue.size > 0 || this.timer) {
			this.status.text = `$(clock) verify queued (${this.queue.size})`;
			this.status.tooltip = 'One engine at a time; queued saves run in turn.';
		} else if (this.lastResult) {
			this.status.text = this.lastResult.ok
				? `$(check) ${path.basename(this.lastResult.file)} verified`
				: `$(error) ${path.basename(this.lastResult.file)}: ${this.lastResult.total} problem(s)`;
			this.status.tooltip = 'Last dfx verify result. Click to verify the current file.';
		} else {
			this.status.hide();
			return;
		}

		this.status.command = 'dreamfx.verifyFileNow';
		this.status.show();
	}
}
