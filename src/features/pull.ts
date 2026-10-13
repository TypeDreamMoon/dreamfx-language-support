/**
 * Pull values from the asset: edits made in the Niagara editor, written back into the text.
 *
 * The rule the whole feature keeps is the curve editor's: the text is the only model, and bytes that
 * did not change are not rewritten. The Unreal side reads what the asset stores and splices only
 * literal values into the text it is sent; this side turns the buffer it gets back into the smallest
 * edits (`planTextEdits`) and applies them as one ordinary, undoable edit. Comments, layout and line
 * endings survive because they are never in an edit.
 *
 * Three decisions that are easy to get wrong:
 *
 *  * **A preview never moves the editor's baseline.** The editor remembers what the asset held at
 *    the last pull so that later pulls only write what moved since. The preview is sent with
 *    `apply: false` precisely so that looking does not count as taking; only the request sent after
 *    the author says yes carries `apply: true`.
 *  * **The edits come from the apply response, not from the preview.** The asset can move between
 *    the two requests, and the baseline that gets recorded is the one that answer was computed from.
 *  * **The document is never saved.** Saving a source builds it in the editor, and that build would
 *    regenerate the asset from the text -- the very thing a pull is for undoing. The author reviews
 *    the pulled values, then saves when they mean to.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
	BridgeDiagnostic,
	DocumentChange,
	PullEdit,
	PullResult,
	describePull,
	isUnknownActionResponse,
	matchLineEndings,
	planTextEdits,
	rebaseEdits,
} from '../core';
import { BridgeClient } from './bridge';
import { DfxRunner, activeSourceDocument } from './dfx';
import { ProblemSink } from './problemSink';

/** The scheme of the read-only document the diff shows on its right-hand side. */
export const PULL_SCHEME = 'dreamfx-pull';

/** Long enough for an editor that is mid-build to get to us; the request just waits in its queue. */
const REQUEST_TIMEOUT_MS = 120_000;

/** How many times a preview is re-run because the text moved under it, before giving up. */
const MAX_RESTARTS = 3;

const PROBLEM_SOURCE = 'dfx pull (editor)';

interface Answer {
	pull: PullResult;
	message: string;
	diagnostics: BridgeDiagnostic[];
}

export class PullFromAsset implements vscode.Disposable, vscode.TextDocumentContentProvider {
	private readonly contents = new Map<string, string>();
	private readonly disposables: vscode.Disposable[] = [];
	/** Files with a request in the air. Prompts are not counted: waiting on the author blocks nothing. */
	private readonly inFlight = new Set<string>();
	/** Bumped by every run, so a prompt left open from an earlier run knows it was replaced. */
	private readonly generation = new Map<string, number>();
	private diffs = 0;

	constructor(
		private readonly runner: DfxRunner,
		private readonly bridge: BridgeClient,
		private readonly problems: ProblemSink,
		private readonly output: vscode.OutputChannel,
		private readonly onBridgeActivity: () => void,
	) {
		this.disposables.push(
			vscode.workspace.registerTextDocumentContentProvider(PULL_SCHEME, this),
			vscode.workspace.onDidCloseTextDocument((document) => {
				if (document.uri.scheme === PULL_SCHEME) {
					this.contents.delete(document.uri.toString());
				} else {
					this.problems.forget(document.uri);
				}
			}),
		);
	}

	dispose(): void {
		this.contents.clear();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.contents.get(uri.toString()) ?? '';
	}

	/** The command. `target` is the explorer's selection when invoked from there. */
	async run(target?: vscode.Uri): Promise<void> {
		const document = await this.resolveDocument(target);
		if (!document) {
			return;
		}

		const file = document.uri.fsPath;
		if (this.inFlight.has(file)) {
			void vscode.window.showWarningMessage(`DreamFXLang: a pull for ${path.basename(file)} is already running.`);
			return;
		}

		const projectDir = this.bridge.findProjectDir(file);
		if (!projectDir || this.bridge.route(projectDir) !== 'bridge') {
			await this.offerCli(document, projectDir);
			return;
		}

		const generation = (this.generation.get(file) ?? 0) + 1;
		this.generation.set(file, generation);

		for (let restart = 0; restart <= MAX_RESTARTS; restart += 1) {
			if (await this.pullOnce(document, projectDir, generation)) {
				return;
			}
			if (restart < MAX_RESTARTS) {
				this.output.appendLine(`pull: ${path.basename(file)} changed while it was being pulled; starting over.`);
			}
		}
		void vscode.window.showWarningMessage(
			`DreamFXLang: ${path.basename(file)} kept changing while it was being pulled. Stop typing for a moment and run it again.`);
	}

	private async resolveDocument(target?: vscode.Uri): Promise<vscode.TextDocument | undefined> {
		let document: vscode.TextDocument | undefined;
		if (target instanceof vscode.Uri) {
			document = await vscode.workspace.openTextDocument(target);
		} else {
			document = activeSourceDocument();
		}

		if (!document || document.uri.scheme !== 'file' || path.extname(document.uri.fsPath).toLowerCase() !== '.dfs') {
			// Only a system builds an asset of its own: a .dfe is copied into the system that references
			// it, so there is nothing to read values back from.
			void vscode.window.showErrorMessage('DreamFXLang: open a .dfs file first — only a system has an asset to pull from.');
			return undefined;
		}
		return document;
	}

	/**
	 * Without an editor there is nothing to read the asset with from here. A saved file can still be
	 * pulled by the CLI, which writes to disk; a buffer with unsaved text cannot, because the CLI would
	 * pull into a file the buffer no longer matches.
	 */
	private async offerCli(document: vscode.TextDocument, projectDir: string | undefined): Promise<void> {
		const name = path.basename(document.uri.fsPath);
		const state = projectDir ? this.bridge.describe(projectDir) : 'No Unreal project was found above this file.';

		if (document.isDirty || !projectDir) {
			void vscode.window.showWarningMessage(
				`DreamFXLang: pulling needs the running Unreal Editor — it reads the asset and compares it with the text in this window. ${state}`
				+ (document.isDirty ? ' Start the editor, or save the file first to use the command line instead.' : ''));
			return;
		}

		const run = 'Run dfx pull -Apply';
		const choice = await vscode.window.showInformationMessage(
			`DreamFXLang: the Unreal Editor is not running. ${state} The command line can pull into ${name} instead — it boots the engine (about 13 seconds) and writes the file on disk.`,
			run);
		if (choice !== run) {
			return;
		}

		const task = await this.runner.createPullTask(document);
		if (task) {
			await vscode.tasks.executeTask(task);
		}
	}

	/**
	 * One preview-review-apply pass. Returns false when the text moved and the pass should start over.
	 */
	private async pullOnce(document: vscode.TextDocument, projectDir: string, generation: number): Promise<boolean> {
		const file = document.uri.fsPath;
		const name = path.basename(file);
		const structure = vscode.workspace.getConfiguration('dreamfx').get<boolean>('pull.structuralEdits', false);

		const version = document.version;
		const text = document.getText();

		const previewed = await this.ask(projectDir, file, text, structure, false, `Pulling values for ${name}`);
		if (!previewed) {
			return true;
		}
		if (document.version !== version) {
			return false;
		}

		const edits = planTextEdits(text, matchLineEndings(text, previewed.pull.newText ?? text));
		if (!previewed.pull.changed || edits.length === 0) {
			await this.reportNothing(previewed, structure);
			return true;
		}

		const right = this.showDiff(document, previewed.pull.newText!);
		const apply = `Apply ${edits.length} edit${edits.length === 1 ? '' : 's'}`;
		const choice = await vscode.window.showInformationMessage(
			`DreamFXLang: ${describePull(previewed.pull, structure)} Applying edits the text; it is not saved.`,
			apply, 'Cancel');
		if (choice !== apply) {
			return true;
		}
		if (this.generation.get(file) !== generation) {
			// A newer pull was started while this prompt was open; it owns the diff now.
			return true;
		}
		if (document.version !== version) {
			void vscode.window.showInformationMessage(`DreamFXLang: ${name} changed while you were reviewing; reading the asset again.`);
			return false;
		}

		// From here the editor will record its baseline, so the values must reach the text or be
		// offered back -- see `applyAnswer`.
		const changes: DocumentChange[][] = [];
		const listener = vscode.workspace.onDidChangeTextDocument((event) => {
			if (event.document === document) {
				changes.push(event.contentChanges.map((change) => ({
					start: change.rangeOffset,
					end: change.rangeOffset + change.rangeLength,
					text: change.text,
				})));
			}
		});
		let applied: Answer | undefined;
		try {
			applied = await this.ask(projectDir, file, text, structure, true, `Applying values to ${name}`);
		} finally {
			listener.dispose();
		}
		if (!applied) {
			return true;
		}

		await this.applyAnswer(document, text, applied, changes, structure, right);
		return true;
	}

	/**
	 * Sends one pull request and returns the usable answer, having said so out loud when there is none.
	 */
	private async ask(
		projectDir: string,
		file: string,
		text: string,
		structure: boolean,
		apply: boolean,
		title: string,
	): Promise<Answer | undefined> {
		this.inFlight.add(file);
		try {
			const busy = this.bridge.readStatus(projectDir);
			const waiting = busy?.busy ? ` (the editor is busy: ${busy.busyAction ?? 'working'})` : '';

			const { response, error } = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `DreamFX: ${title}${waiting}`, cancellable: true },
				(_progress, token) => this.bridge.send(
					projectDir, 'pull', { sourceFile: file, text, structure, apply }, REQUEST_TIMEOUT_MS, token));
			this.onBridgeActivity();

			if (!response) {
				void vscode.window.showErrorMessage(`DreamFXLang: the editor did not answer the pull (${error}).`);
				return undefined;
			}

			// Diagnostics first: a refusal can carry the explanation in them, and a pull that failed
			// part-way still has things worth putting in Problems.
			this.problems.publish(file, response.diagnostics, PROBLEM_SOURCE);

			if (isUnknownActionResponse(response, 'pull')) {
				void vscode.window.showErrorMessage(
					'DreamFXLang: the Unreal Editor is running a DreamFX plugin that does not know how to pull. Update the plugin, then reopen the editor.');
				return undefined;
			}

			if (!response.ok) {
				void vscode.window.showErrorMessage(`DreamFXLang: ${response.message || 'the pull failed.'}`, 'Show Problems')
					.then((picked) => {
						if (picked === 'Show Problems') {
							void vscode.commands.executeCommand('workbench.actions.view.problems');
						}
					});
				return undefined;
			}

			if (!response.pull) {
				this.output.appendLine(`pull: the editor answered ok without a pull result: ${response.message}`);
				void vscode.window.showErrorMessage(
					'DreamFXLang: the editor answered, but not with a pull result. The plugin and this extension may be out of step — update both.');
				return undefined;
			}

			if (response.pull.wroteFile) {
				// A request that carried the text is not supposed to touch the file. Said, because the
				// buffer and the disk may now disagree.
				this.output.appendLine('pull: the editor reports it wrote the file even though the text was sent.');
			}
			for (const line of response.pull.report) {
				this.output.appendLine(`pull: ${line}`);
			}

			return { pull: response.pull, message: response.message, diagnostics: response.diagnostics };
		} finally {
			this.inFlight.delete(file);
		}
	}

	/** The applying half: edits from this answer's text, against the text the request was sent with. */
	private async applyAnswer(
		document: vscode.TextDocument,
		sent: string,
		answer: Answer,
		changes: readonly (readonly DocumentChange[])[],
		structure: boolean,
		diffUri: vscode.Uri,
	): Promise<void> {
		const name = path.basename(document.uri.fsPath);

		if (!answer.pull.changed || answer.pull.newText === undefined) {
			await this.reportNothing(answer, structure);
			return;
		}

		// Keep what is being applied on the right of the diff: if the edits cannot be placed, it is
		// the only copy of the pulled values that exists on this side.
		this.contents.set(diffUri.toString(), answer.pull.newText);

		let edits: PullEdit[] | undefined = planTextEdits(sent, matchLineEndings(sent, answer.pull.newText));
		if (edits.length === 0) {
			await this.reportNothing(answer, structure);
			return;
		}

		if (changes.length > 0) {
			edits = rebaseEdits(edits, changes);
			if (!edits) {
				void vscode.window.showWarningMessage(
					`DreamFXLang: ${name} changed while the values were being applied, in a place the pull also edits, so nothing was written. `
					+ 'The editor has already recorded these values as pulled — the diff beside the file still shows them, to copy from.');
				return;
			}
		}

		const workspaceEdit = new vscode.WorkspaceEdit();
		for (const edit of edits) {
			workspaceEdit.replace(
				document.uri,
				new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)),
				edit.newText);
		}

		if (!await vscode.workspace.applyEdit(workspaceEdit)) {
			void vscode.window.showWarningMessage(
				`DreamFXLang: could not edit ${name}. The editor has already recorded these values as pulled — the diff still shows them.`);
			return;
		}

		const count = `${edits.length} edit${edits.length === 1 ? '' : 's'}`;
		void vscode.window.setStatusBarMessage(`DreamFX: pulled ${count} into ${name} (not saved)`, 8000);
		void vscode.window.showInformationMessage(
			`DreamFXLang: ${describePull(answer.pull, structure)} ${name} is not saved — saving builds it, which is yours to decide. Ctrl+Z undoes the pull.`,
			...this.followUps(answer)).then((picked) => this.followUp(picked, answer));
	}

	/** The summary for a pull that changes nothing: what was compared, and everything left alone. */
	private async reportNothing(answer: Answer, structure: boolean): Promise<void> {
		const buttons = this.followUps(answer);
		const detail = answer.message ? ` (${answer.message})` : '';
		const picked = await vscode.window.showInformationMessage(
			`DreamFXLang: ${describePull(answer.pull, structure)}${detail}`, ...buttons);
		await this.followUp(picked, answer);
	}

	private followUps(answer: Answer): string[] {
		const buttons: string[] = [];
		if (answer.diagnostics.length > 0) {
			buttons.push('Show Problems');
		}
		if (answer.pull.reportPath && fs.existsSync(answer.pull.reportPath)) {
			buttons.push('Open Report');
		}
		return buttons;
	}

	private async followUp(picked: string | undefined, answer: Answer): Promise<void> {
		if (picked === 'Show Problems') {
			await vscode.commands.executeCommand('workbench.actions.view.problems');
		} else if (picked === 'Open Report') {
			await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(answer.pull.reportPath));
		}
	}

	/** Opens document-versus-asset. The document is on the left, so it is still the thing being edited. */
	private showDiff(document: vscode.TextDocument, newText: string): vscode.Uri {
		this.diffs += 1;
		const uri = vscode.Uri.from({
			scheme: PULL_SCHEME,
			path: `/${path.basename(document.uri.fsPath)}`,
			query: String(this.diffs),
		});
		this.contents.set(uri.toString(), newText);
		void vscode.commands.executeCommand(
			'vscode.diff', document.uri, uri, `${path.basename(document.uri.fsPath)}: text ↔ asset values`, { preview: true });
		return uri;
	}
}
