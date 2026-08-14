/**
 * One structural walk per document version, shared by everything that needs one.
 *
 * `analyze` is the only expensive thing the server does per keystroke, and two handlers want it for
 * the same text: diagnostics on every change, symbols whenever the outline is showing. In-process
 * those were two unrelated providers and the double walk was invisible; across a pipe they land in
 * the same event loop, so it is worth not doing twice.
 *
 * Keyed on version rather than content because the version is what LSP guarantees is monotonic per
 * document -- hashing the text to find out what the protocol already told us would cost more than
 * the walk being avoided.
 */

import { TextDocument } from 'vscode-languageserver-textdocument';

import { DocumentModel, analyze } from '../core';

export class AnalysisCache {
	private readonly byUri = new Map<string, { version: number; model: DocumentModel }>();

	get(document: TextDocument): DocumentModel {
		const cached = this.byUri.get(document.uri);
		if (cached && cached.version === document.version) {
			return cached.model;
		}

		const model = analyze(document.getText());
		this.byUri.set(document.uri, { version: document.version, model });
		return model;
	}

	forget(uri: string): void {
		this.byUri.delete(uri);
	}
}
