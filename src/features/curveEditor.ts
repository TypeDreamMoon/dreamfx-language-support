/**
 * The curve editor: a webview beside the text that draws one `curve { }` literal and edits it.
 *
 * The source stays the only model (see `curveEditorProtocol.ts`). This half owns the conversation:
 * it finds the literal, keeps track of it while the text around it changes, writes the webview's
 * edits into the document as ordinary undoable edits, and sends the re-read result back.
 *
 * One panel, pointed at one literal at a time. Clicking another literal's lens -- or just moving the
 * cursor into one -- points it there, the way the details panel follows the selection in Unreal.
 */

import * as path from 'path';
import * as vscode from 'vscode';

import { CurveLiteral, EditedCurveKey, findCurveLiterals, planCurveEdit } from '../core';
import { CurveEditorState, FromCurveEditor, ToCurveEditor } from '../curveEditorProtocol';
import { curveEditorHtml } from './curveEditorPage';
import { LANGUAGE_ID } from './languageClient';

interface Target {
	uri: vscode.Uri;
	/** Offset of the literal's `curve` keyword, carried through every edit made around it. */
	anchor: number;
	/** Bumped whenever the panel is pointed at a different literal. */
	id: number;
}

const INTERPS = new Set(['Cubic', 'Linear', 'Constant']);
const TANGENT_MODES = new Set(['Auto', 'User', 'Break', 'None']);

export class CurveEditor implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private target: Target | undefined;
	private targets = 0;
	/** Origins the webview has selected, highlighted in the text. */
	private selected: number[] = [];
	private applying = false;
	private sawOwnChange = false;
	private cache: { uri: string; version: number; literals: CurveLiteral[] } | undefined;
	private readonly highlight: vscode.TextEditorDecorationType;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly extensionUri: vscode.Uri, private readonly output: vscode.OutputChannel) {
		this.highlight = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
			overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.rangeHighlightForeground'),
			overviewRulerLane: vscode.OverviewRulerLane.Center,
		});

		this.disposables.push(
			this.highlight,
			vscode.workspace.onDidChangeTextDocument((event) => this.onDocumentChanged(event)),
			vscode.workspace.onDidCloseTextDocument((document) => {
				if (this.isTarget(document)) {
					this.publish('external');
				}
			}),
			vscode.window.onDidChangeTextEditorSelection((event) => this.onSelectionChanged(event)),
			vscode.window.onDidChangeVisibleTextEditors(() => this.decorate(false)),
		);
	}

	dispose(): void {
		this.panel?.dispose();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	/**
	 * Opens the editor on the literal at `offset` in `uri` -- the lens passes both -- or on the one
	 * under the cursor when called from the palette.
	 */
	async open(uri?: string | vscode.Uri, offset?: number): Promise<void> {
		let document: vscode.TextDocument | undefined;
		if (uri !== undefined) {
			document = await vscode.workspace.openTextDocument(typeof uri === 'string' ? vscode.Uri.parse(uri) : uri);
		} else {
			const editor = vscode.window.activeTextEditor;
			if (editor?.document.languageId === LANGUAGE_ID) {
				document = editor.document;
				offset = document.offsetAt(editor.selection.active);
			}
		}

		if (!document || offset === undefined) {
			void vscode.window.showInformationMessage('DreamFXLang: put the cursor inside a curve { } literal in a .dfs/.dfe/.dfm file.');
			return;
		}

		const literal = this.literals(document).find((candidate) => offset! >= candidate.start && offset! <= candidate.end);
		if (!literal) {
			void vscode.window.showInformationMessage('DreamFXLang: there is no curve { } literal under the cursor.');
			return;
		}

		this.showPanel();
		this.retarget(document, literal);
	}

	// ---------------------------------------------------------------- panel

	private showPanel(): void {
		if (this.panel) {
			this.panel.reveal(undefined, true);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'dreamfx.curveEditor',
			'Curve',
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
			{ enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'out')] },
		);
		panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'resources', 'icon.png');
		panel.webview.html = this.html(panel.webview);
		panel.webview.onDidReceiveMessage((message: FromCurveEditor) => {
			void this.onMessage(message).catch((error: unknown) => {
				this.output.appendLine(`curve editor: ${String(error)}`);
			});
		});
		panel.onDidDispose(() => {
			this.panel = undefined;
			this.target = undefined;
			this.selected = [];
			this.decorate(false);
		});
		this.panel = panel;
	}

	private retarget(document: vscode.TextDocument, literal: CurveLiteral): void {
		this.targets += 1;
		this.target = { uri: document.uri, anchor: literal.start, id: this.targets };
		this.selected = [];
		this.publish('open');
	}

	private async onMessage(message: FromCurveEditor): Promise<void> {
		switch (message.type) {
			case 'ready':
				this.publish('open');
				return;
			case 'edit':
				await this.applyEdit(message.target, message.version, message.keys);
				return;
			case 'select':
				if (message.target === this.target?.id) {
					this.selected = message.origins;
					this.decorate(true);
				}
				return;
			case 'undo':
			case 'redo':
				await this.undo(message.type);
				return;
			case 'reveal':
				await this.revealInText();
				return;
		}
	}

	/** Reads the target out of the document and sends it. The only way the webview learns anything. */
	private publish(cause: CurveEditorState['cause']): void {
		if (!this.panel || !this.target) {
			return;
		}

		const document = this.document();
		const literal = document ? this.locate(document) : undefined;
		const state: CurveEditorState = {
			type: 'state',
			target: this.target.id,
			version: document?.version ?? -1,
			cause,
			editable: false,
			problems: [],
			name: literal?.inputName ?? 'curve',
			context: literal?.context ?? [],
			fileName: path.basename(this.target.uri.fsPath || this.target.uri.path),
			line: literal?.line ?? 0,
			keys: [],
		};

		if (!document) {
			state.problems = ['The source file was closed. Open the curve again from its lens to keep editing.'];
		} else if (!literal) {
			state.problems = ['The curve literal this panel was showing is no longer in the file.'];
		} else {
			state.keys = literal.keys.map(({ time, value, interp, tangentMode, arrive, leave }) =>
				({ time, value, interp, tangentMode, arrive, leave }));
			state.problems = literal.problems;
			state.editable = literal.problems.length === 0 && literal.close >= 0;
		}

		this.panel.title = `Curve: ${state.name}`;
		void this.panel.webview.postMessage(state satisfies ToCurveEditor);
		this.decorate(false);
	}

	// ---------------------------------------------------------------- the text

	private document(): vscode.TextDocument | undefined {
		const uri = this.target?.uri.toString();
		return vscode.workspace.textDocuments.find((document) => !document.isClosed && document.uri.toString() === uri);
	}

	private isTarget(document: vscode.TextDocument): boolean {
		return this.target !== undefined && document.uri.toString() === this.target.uri.toString();
	}

	/** One scan per document version, shared by the cursor tracking and the publishing. */
	private literals(document: vscode.TextDocument): CurveLiteral[] {
		const uri = document.uri.toString();
		if (this.cache?.uri !== uri || this.cache.version !== document.version) {
			this.cache = { uri, version: document.version, literals: findCurveLiterals(document.getText()) };
		}
		return this.cache.literals;
	}

	/** The target literal, following it if an edit moved its keyword. */
	private locate(document: vscode.TextDocument): CurveLiteral | undefined {
		const anchor = this.target!.anchor;
		const literals = this.literals(document);
		const found = literals.find((literal) => literal.start === anchor)
			?? literals.find((literal) => anchor >= literal.start && anchor <= literal.end);
		if (found) {
			this.target!.anchor = found.start;
		}
		return found;
	}

	private onDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
		if (!this.target || !this.isTarget(event.document) || event.contentChanges.length === 0) {
			return;
		}

		// Carry the anchor through the change. The changes of one event do not overlap, and applying
		// them from the last to the first keeps every offset valid against the text before the event.
		let anchor = this.target.anchor;
		for (const change of [...event.contentChanges].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
			if (change.rangeOffset + change.rangeLength <= anchor) {
				anchor += change.text.length - change.rangeLength;
			} else if (change.rangeOffset < anchor) {
				// The keyword itself was edited; the nearest literal is found by `locate` afterwards.
				anchor = change.rangeOffset;
			}
		}
		this.target.anchor = anchor;

		if (this.applying) {
			this.sawOwnChange = true;
		}
		this.publish(this.applying ? 'edit' : 'external');
	}

	private onSelectionChanged(event: vscode.TextEditorSelectionChangeEvent): void {
		const document = event.textEditor.document;
		// Only a cursor the author moved: a programmatic selection, including the one an applied edit
		// leaves behind, says nothing about which curve they are looking at.
		if (!this.panel || document.languageId !== LANGUAGE_ID || event.kind === undefined
			|| event.kind === vscode.TextEditorSelectionChangeKind.Command) {
			return;
		}

		const active = event.selections[0].active;
		const offset = document.offsetAt(active);
		const literal = this.literals(document).find((candidate) => offset >= candidate.start && offset <= candidate.end);
		if (!literal) {
			return;
		}

		if (!this.target || !this.isTarget(document) || literal.start !== this.target.anchor) {
			this.retarget(document, literal);
			return;
		}

		const origins = literal.keys
			.map((key, index) => ({ index, first: document.positionAt(key.start).line, last: document.positionAt(key.statementEnd).line }))
			.filter((entry) => entry.first <= active.line && active.line <= entry.last)
			.map((entry) => entry.index);
		void this.panel.webview.postMessage({ type: 'focus', target: this.target.id, origins } satisfies ToCurveEditor);
	}

	private async applyEdit(target: number, version: number, keys: EditedCurveKey[]): Promise<void> {
		const document = this.document();
		const literal = document && this.target?.id === target ? this.locate(document) : undefined;

		// Anything stale -- another literal, another version, a literal that stopped being editable --
		// is answered with the current state rather than applied. The webview redraws from it, and the
		// author sees their drag snap back instead of landing somewhere they did not put it.
		if (!document || !literal || document.version !== version || literal.problems.length > 0 || !keys.every(isCurveKey)) {
			this.publish('external');
			return;
		}

		let replacements;
		try {
			replacements = planCurveEdit(document.getText(), literal, keys);
		} catch (error) {
			this.output.appendLine(`curve editor: could not plan the edit -- ${String(error)}`);
			this.publish('external');
			return;
		}

		if (replacements.length === 0) {
			this.publish('edit');
			return;
		}

		const edit = new vscode.WorkspaceEdit();
		for (const replacement of replacements) {
			edit.replace(document.uri,
				new vscode.Range(document.positionAt(replacement.start), document.positionAt(replacement.end)),
				replacement.text);
		}

		this.applying = true;
		this.sawOwnChange = false;
		let applied = false;
		try {
			applied = await vscode.workspace.applyEdit(edit);
		} finally {
			this.applying = false;
		}
		if (!applied || !this.sawOwnChange) {
			this.publish(applied ? 'edit' : 'external');
		}
	}

	/**
	 * Undo goes to the document, not to a history of the panel's own: the edits are ordinary text
	 * edits, so there is one history and it is the editor's. The undo command acts on the focused
	 * editor, hence the hop over to it and back.
	 */
	private async undo(kind: 'undo' | 'redo'): Promise<void> {
		const document = this.document();
		if (!document) {
			return;
		}
		const visible = vscode.window.visibleTextEditors.find((editor) => editor.document === document);
		await vscode.window.showTextDocument(document, { viewColumn: visible?.viewColumn ?? vscode.ViewColumn.One, preserveFocus: false });
		await vscode.commands.executeCommand(kind);
		this.panel?.reveal(undefined, false);
	}

	private async revealInText(): Promise<void> {
		const document = this.document();
		const literal = document ? this.locate(document) : undefined;
		if (!document || !literal) {
			return;
		}
		const visible = vscode.window.visibleTextEditors.find((editor) => editor.document === document);
		const start = document.positionAt(literal.start);
		await vscode.window.showTextDocument(document, {
			viewColumn: visible?.viewColumn ?? vscode.ViewColumn.One,
			selection: new vscode.Range(start, start),
		});
	}

	/** Highlights the selected keys' lines, and scrolls the first into view when asked. */
	private decorate(reveal: boolean): void {
		const document = this.panel ? this.document() : undefined;
		const literal = document ? this.locate(document) : undefined;
		const ranges = literal
			? this.selected
				.filter((origin) => origin >= 0 && origin < literal.keys.length)
				.map((origin) => new vscode.Range(document!.positionAt(literal.keys[origin].start), document!.positionAt(literal.keys[origin].statementEnd)))
			: [];

		for (const editor of vscode.window.visibleTextEditors) {
			const mine = document !== undefined && editor.document === document;
			editor.setDecorations(this.highlight, mine ? ranges : []);
			if (mine && reveal && ranges.length > 0) {
				// The line, not the key's span: revealing a long key's end scrolls the editor sideways
				// and loses the indentation that shows where the key sits.
				const line = ranges[0].start.line;
				editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
			}
		}
	}

	// ---------------------------------------------------------------- page

	private html(webview: vscode.Webview): string {
		return curveEditorHtml({
			cspSource: webview.cspSource,
			nonce: Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join(''),
			scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'out', 'curveEditor.js')).toString(),
		});
	}

}

/** The webview hands back plain JSON, and a malformed key must never reach the formatter. */
function isCurveKey(key: EditedCurveKey): boolean {
	return typeof key === 'object' && key !== null
		&& Number.isFinite(key.time) && Number.isFinite(key.value)
		&& Number.isFinite(key.arrive) && Number.isFinite(key.leave)
		&& INTERPS.has(key.interp) && TANGENT_MODES.has(key.tangentMode)
		&& (key.origin === undefined || Number.isInteger(key.origin));
}
