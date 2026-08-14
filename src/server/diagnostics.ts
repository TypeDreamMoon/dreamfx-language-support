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
 * That split is also why the server does not own all the squiggles. The task's matcher and the
 * bridge both publish under `dreamfxlang`, from the client, where the runs they report on happen;
 * this owns `dreamfxlang-syntax` alone. Sharing one owner would let a build result wipe the syntax
 * errors, or the reverse, depending on which finished last -- and putting them in one process would
 * not change that, it would only hide it.
 */

import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { DocumentModel, LexicalDiagnostic } from '../core';

export const DIAGNOSTIC_SOURCE = 'dreamfxlang';

const DIAGNOSTIC_DOCS_BASE = 'https://github.com/TypeDreamMoon/DreamFX/blob/main/Docs/diagnostics';

export function syntaxDiagnostics(document: TextDocument, model: DocumentModel): Diagnostic[] {
	return model.diagnostics.map((entry) => toDiagnostic(document, entry));
}

function toDiagnostic(document: TextDocument, entry: LexicalDiagnostic): Diagnostic {
	// A zero-width range renders as an invisible squiggle, so an empty span is widened by one
	// character -- which is the character the message is about anyway.
	const startOffset = entry.start.offset;
	const endOffset = Math.max(entry.end.offset, startOffset + 1);

	const diagnostic: Diagnostic = {
		range: {
			start: document.positionAt(startOffset),
			end: document.positionAt(endOffset),
		},
		message: entry.message,
		severity: entry.severity === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
		source: DIAGNOSTIC_SOURCE,
	};

	if (entry.code) {
		diagnostic.code = entry.code;
		diagnostic.codeDescription = {
			href: `${DIAGNOSTIC_DOCS_BASE}/${entry.code.slice(0, 4)}xxx.md#${entry.code.toLowerCase()}`,
		};
	}

	return diagnostic;
}
