/**
 * Syntax-layer diagnostics, and nothing else.
 *
 * The line this draws is the most important decision in the extension. Every DFXnnnn above the
 * 1xxx range is a *semantic* verdict -- does this module exist, does this input take this type, is
 * this static switch written before what it gates -- and all of that already exists, in C++, as the
 * thing that actually decides whether the build succeeds. Re-deriving any of it in TypeScript would
 * produce a second source of truth, and two sources of truth on the same question drift. The way
 * that drift shows up is "the editor says it is fine and the build says it is not", which is worse
 * than having no editor feedback at all.
 *
 * So the rule is: report only what is certain from the characters. That is exactly the DFX1xxx
 * family -- the compiler's own lexical codes, ported from its own lexer -- plus unbalanced braces.
 * Everything else arrives from `dfx` through the problem matcher, wearing the same codes.
 *
 * The two collections are kept separate on purpose. The task's matcher owns `dreamfxlang`; this
 * owns `dreamfxlang-syntax`. Sharing one owner would let a build result wipe the syntax errors, or
 * the reverse, depending on which finished last.
 */

import * as vscode from 'vscode';

import { LexicalDiagnostic, analyze } from '../core';

const DEBOUNCE_MS = 250;

const DIAGNOSTIC_DOCS_BASE = 'https://github.com/TypeDreamMoon/DreamFX/blob/main/Docs/diagnostics';

export class SyntaxDiagnostics implements vscode.Disposable {
	private readonly collection = vscode.languages.createDiagnosticCollection('dreamfxlang-syntax');
	private readonly timers = new Map<string, NodeJS.Timeout>();
	private readonly disposables: vscode.Disposable[] = [];

	constructor() {
		this.disposables.push(
			vscode.workspace.onDidOpenTextDocument((document) => this.schedule(document, 0)),
			vscode.workspace.onDidChangeTextDocument((event) => this.schedule(event.document, DEBOUNCE_MS)),
			vscode.workspace.onDidCloseTextDocument((document) => this.forget(document)),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('dreamfx.syntaxDiagnostics')) {
					this.refreshAll();
				}
			}),
		);

		this.refreshAll();
	}

	dispose(): void {
		for (const timer of this.timers.values()) {
			clearTimeout(timer);
		}
		this.timers.clear();
		this.collection.dispose();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	refreshAll(): void {
		this.collection.clear();
		for (const document of vscode.workspace.textDocuments) {
			this.schedule(document, 0);
		}
	}

	private schedule(document: vscode.TextDocument, delay: number): void {
		if (document.languageId !== 'dreamfxlang') {
			return;
		}

		const key = document.uri.toString();
		const existing = this.timers.get(key);
		if (existing) {
			clearTimeout(existing);
		}

		if (delay === 0) {
			this.timers.delete(key);
			this.run(document);
			return;
		}

		this.timers.set(key, setTimeout(() => {
			this.timers.delete(key);
			this.run(document);
		}, delay));
	}

	private forget(document: vscode.TextDocument): void {
		const key = document.uri.toString();
		const timer = this.timers.get(key);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(key);
		}
		this.collection.delete(document.uri);
	}

	private run(document: vscode.TextDocument): void {
		if (document.languageId !== 'dreamfxlang') {
			return;
		}
		if (!vscode.workspace.getConfiguration('dreamfx').get<boolean>('syntaxDiagnostics', true)) {
			this.collection.delete(document.uri);
			return;
		}

		const model = analyze(document.getText());
		this.collection.set(document.uri, model.diagnostics.map((entry) => toDiagnostic(document, entry)));
	}
}

function toDiagnostic(document: vscode.TextDocument, entry: LexicalDiagnostic): vscode.Diagnostic {
	// A zero-width range renders as an invisible squiggle, so an empty span is widened by one
	// character -- which is the character the message is about anyway.
	const startOffset = entry.start.offset;
	const endOffset = Math.max(entry.end.offset, startOffset + 1);

	const diagnostic = new vscode.Diagnostic(
		new vscode.Range(document.positionAt(startOffset), document.positionAt(endOffset)),
		entry.message,
		entry.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);

	diagnostic.source = 'dreamfxlang';
	if (entry.code) {
		diagnostic.code = {
			value: entry.code,
			target: vscode.Uri.parse(`${DIAGNOSTIC_DOCS_BASE}/${entry.code.slice(0, 4)}xxx.md#${entry.code.toLowerCase()}`),
		};
	}
	return diagnostic;
}
