/**
 * "Edit curve" above every `curve { }` literal.
 *
 * The lens is only a door: the editor it opens is client UI (a webview, and edits to a document the
 * client owns), and nothing about it belongs in this process. What belongs here is knowing where the
 * literals are, which is the same lexical knowledge as the outline's.
 */

import { CodeLens } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { findCurveLiterals } from '../core';
import { EDIT_CURVE_COMMAND } from '../lspProtocol';

export function curveLenses(document: TextDocument): CodeLens[] {
	return findCurveLiterals(document.getText()).map((literal) => {
		const position = document.positionAt(literal.start);
		const keys = `${literal.keys.length} ${literal.keys.length === 1 ? 'key' : 'keys'}`;
		const title = literal.problems.length > 0
			? `$(graph-line) View curve · ${keys} · read-only until fixed`
			: `$(graph-line) Edit curve · ${keys}`;
		return {
			range: { start: position, end: position },
			// The offset of the `curve` keyword is the literal's identity: the client re-reads the text
			// it owns rather than trusting anything about the literal sent from here.
			command: { title, command: EDIT_CURVE_COMMAND, arguments: [document.uri, literal.start] },
		};
	});
}
