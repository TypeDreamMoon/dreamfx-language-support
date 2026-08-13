/**
 * Running `dfx.ps1` from VSCode.
 *
 * Two rules shape everything here, and both come from the plugin's own measurements rather than
 * from taste:
 *
 *  * `build` writes packages. If the Unreal Editor is open, both processes save the same packages
 *    and the one that saves second silently wins -- so build is never automatic, never on save, and
 *    asks first by default.
 *  * booting the engine costs tens of seconds. Nothing here may be triggered by typing.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export type DfxCommand = 'verify' | 'lint' | 'build';
export type DfxScope = 'file' | 'all';

export interface DfxTaskDefinition extends vscode.TaskDefinition {
	type: 'dreamfx';
	command: DfxCommand;
	scope?: DfxScope;
	force?: boolean;
	strictVersions?: boolean;
}

export const TASK_TYPE = 'dreamfx';

/** Commands that write packages, and so need the editor closed. */
const WRITES_PACKAGES: ReadonlySet<DfxCommand> = new Set<DfxCommand>(['build']);

export class DfxRunner {
	constructor(private readonly output: vscode.OutputChannel) {}

	/**
	 * Locates `.skill/dfx.ps1`.
	 *
	 * Configured path first, then upward from the file being worked on, then a workspace search.
	 * Upward before workspace because the plugin is frequently open alongside several others, and
	 * the one that owns the file you are editing is the one whose CLI should run it.
	 */
	async findScript(document?: vscode.TextDocument): Promise<string | undefined> {
		const configured = vscode.workspace.getConfiguration('dreamfx').get<string>('dfxScriptPath', '').trim();
		if (configured) {
			if (fs.existsSync(configured)) {
				return configured;
			}
			this.output.appendLine(`dreamfx.dfxScriptPath is set to '${configured}', which does not exist.`);
		}

		const startDirectories: string[] = [];
		if (document && document.uri.scheme === 'file') {
			startDirectories.push(path.dirname(document.uri.fsPath));
		}
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			if (folder.uri.scheme === 'file') {
				startDirectories.push(folder.uri.fsPath);
			}
		}

		for (const start of startDirectories) {
			const found = findUpward(start);
			if (found) {
				return found;
			}
		}

		const candidates = await vscode.workspace.findFiles('**/.skill/dfx.ps1', '**/node_modules/**', 8);
		if (candidates.length === 0) {
			return undefined;
		}
		// A workspace holding more than one plugin: prefer the DreamFX one over a sibling's CLI.
		const preferred = candidates.find((uri) => /[\\/]DreamFX[\\/]/i.test(uri.fsPath));
		return (preferred ?? candidates[0]).fsPath;
	}

	/** Builds the task. Returns undefined when dfx.ps1 could not be found, having said so. */
	async createTask(definition: DfxTaskDefinition, document?: vscode.TextDocument): Promise<vscode.Task | undefined> {
		const script = await this.findScript(document);
		if (!script) {
			void vscode.window.showErrorMessage(
				'DreamFXLang: could not find .skill/dfx.ps1. Set dreamfx.dfxScriptPath, or open the folder containing the DreamFX plugin.');
			return undefined;
		}

		const scope: DfxScope = definition.scope ?? 'file';
		const args: string[] = [definition.command];

		if (scope === 'file') {
			if (!document || document.uri.scheme !== 'file') {
				void vscode.window.showErrorMessage(`DreamFXLang: ${definition.command} needs a saved .dfs/.dfe/.dfm file.`);
				return undefined;
			}
			args.push(document.uri.fsPath);
		} else {
			args.push('-All');
		}

		if (definition.command === 'build' && definition.force) {
			args.push('-Force');
		}
		if (definition.command === 'verify' && definition.strictVersions) {
			args.push('-StrictVersions');
		}

		const shell = vscode.workspace.getConfiguration('dreamfx').get<string>('powershellPath', 'pwsh') || 'pwsh';
		const cwd = this.resolveWorkingDirectory(script, document);

		const execution = new vscode.ProcessExecution(
			shell,
			['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
			{ cwd });

		const label = `${definition.command} ${scope === 'all' ? '(all sources)' : path.basename(args[1])}`;
		const task = new vscode.Task(
			definition,
			vscode.TaskScope.Workspace,
			label,
			'DreamFXLang',
			execution,
			['$dreamfx']);

		task.group = definition.command === 'build' ? vscode.TaskGroup.Build : vscode.TaskGroup.Test;
		task.presentationOptions = {
			reveal: vscode.TaskRevealKind.Always,
			panel: vscode.TaskPanelKind.Dedicated,
			clear: true,
			showReuseMessage: false,
		};

		this.output.appendLine(`${shell} -File ${script} ${args.join(' ')}   (cwd ${cwd})`);
		return task;
	}

	/**
	 * `dfx.ps1` finds the .uproject by walking up from its target, and from the working directory
	 * when there is no target -- so `-All` only works when the cwd is inside the project.
	 */
	private resolveWorkingDirectory(script: string, document?: vscode.TextDocument): string {
		if (document && document.uri.scheme === 'file') {
			const folder = vscode.workspace.getWorkspaceFolder(document.uri);
			if (folder && folder.uri.scheme === 'file') {
				return folder.uri.fsPath;
			}
			return path.dirname(document.uri.fsPath);
		}

		const first = (vscode.workspace.workspaceFolders ?? []).find((folder) => folder.uri.scheme === 'file');
		return first ? first.uri.fsPath : path.dirname(script);
	}

	/**
	 * The guard from the plugin's own docs, worded as what actually goes wrong. Answering "run
	 * anyway" is a real answer, because the editor being open is not the same as the editor having
	 * *this* project open -- which is the same reason dfx.ps1 warns rather than refuses.
	 */
	async confirmIfWriting(command: DfxCommand): Promise<boolean> {
		if (!WRITES_PACKAGES.has(command)) {
			return true;
		}
		if (!vscode.workspace.getConfiguration('dreamfx').get<boolean>('confirmBuild', true)) {
			return true;
		}

		const answer = await vscode.window.showWarningMessage(
			'Build writes Niagara packages. If the Unreal Editor has this project open, both processes save the same packages and the later save silently wins.',
			{ modal: true, detail: 'Close the editor first, or run this from the editor itself.' },
			'Run anyway');
		return answer === 'Run anyway';
	}
}

function findUpward(startDirectory: string): string | undefined {
	let directory = startDirectory;

	for (;;) {
		const direct = path.join(directory, '.skill', 'dfx.ps1');
		if (fs.existsSync(direct)) {
			return direct;
		}

		const pluginsDirectory = path.join(directory, 'Plugins');
		if (fs.existsSync(pluginsDirectory)) {
			let entries: fs.Dirent[] = [];
			try {
				entries = fs.readdirSync(pluginsDirectory, { withFileTypes: true });
			} catch {
				entries = [];
			}
			for (const entry of entries) {
				if (!entry.isDirectory()) {
					continue;
				}
				const candidate = path.join(pluginsDirectory, entry.name, '.skill', 'dfx.ps1');
				if (fs.existsSync(candidate)) {
					return candidate;
				}
			}
		}

		const parent = path.dirname(directory);
		if (parent === directory) {
			return undefined;
		}
		directory = parent;
	}
}

export class DfxTaskProvider implements vscode.TaskProvider {
	constructor(private readonly runner: DfxRunner) {}

	async provideTasks(): Promise<vscode.Task[]> {
		const document = activeSourceDocument();
		const definitions: DfxTaskDefinition[] = [
			{ type: TASK_TYPE, command: 'verify', scope: 'file' },
			{ type: TASK_TYPE, command: 'verify', scope: 'all' },
			{ type: TASK_TYPE, command: 'lint', scope: 'file' },
			{ type: TASK_TYPE, command: 'lint', scope: 'all' },
			{ type: TASK_TYPE, command: 'build', scope: 'file' },
			{ type: TASK_TYPE, command: 'build', scope: 'all' },
		];

		const tasks: vscode.Task[] = [];
		for (const definition of definitions) {
			// A file-scoped task with nothing open would have to invent a target; it is offered again
			// the moment a source file is focused.
			if (definition.scope === 'file' && !document) {
				continue;
			}
			const task = await this.runner.createTask(definition, document);
			if (task) {
				tasks.push(task);
			}
		}
		return tasks;
	}

	async resolveTask(task: vscode.Task): Promise<vscode.Task | undefined> {
		const definition = task.definition as DfxTaskDefinition;
		if (definition.type !== TASK_TYPE || !definition.command) {
			return undefined;
		}
		return this.runner.createTask(definition, activeSourceDocument());
	}
}

export function activeSourceDocument(): vscode.TextDocument | undefined {
	const editor = vscode.window.activeTextEditor;
	if (editor && editor.document.languageId === 'dreamfxlang') {
		return editor.document;
	}
	return undefined;
}
