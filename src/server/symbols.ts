/**
 * Outline, breadcrumbs and "go to symbol in file", all from the one structural walk.
 *
 * Positions are converted through `document.positionAt` rather than from the walker's own line and
 * column. The walker's numbers exist to match DFXnnnn messages, which are one-based; the protocol is
 * zero-based, and an off-by-one in a navigation feature is the kind of bug that is noticed only
 * after someone has been quietly landing on the wrong line for a week.
 */

import { DocumentSymbol, SymbolKind } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { DocumentModel, StructureKind, StructureNode } from '../core';

const SYMBOL_KINDS: Record<StructureKind, SymbolKind> = {
	document: SymbolKind.Module,
	emitter: SymbolKind.Class,
	stack: SymbolKind.Function,
	section: SymbolKind.Struct,
	renderer: SymbolKind.Object,
	moduleCall: SymbolKind.Method,
	declaration: SymbolKind.Field,
};

export function documentSymbols(document: TextDocument, model: DocumentModel): DocumentSymbol[] {
	return model.root ? [convert(document, model.root)] : [];
}

function convert(document: TextDocument, node: StructureNode): DocumentSymbol {
	// Clients drop a symbol outright when its selection is not inside its range, and the walker is
	// deliberately forgiving about half-typed text -- so the two are reconciled rather than trusted.
	// Compared as offsets: the walker's own numbers, before any conversion that could disagree.
	const contained = node.selectionStart.offset >= node.start.offset
		&& node.selectionEnd.offset <= node.end.offset;

	const range = {
		start: document.positionAt(node.start.offset),
		end: document.positionAt(node.end.offset),
	};

	return {
		name: node.name || '(unnamed)',
		detail: node.detail,
		kind: SYMBOL_KINDS[node.kind],
		range,
		selectionRange: contained
			? {
				start: document.positionAt(node.selectionStart.offset),
				end: document.positionAt(node.selectionEnd.offset),
			}
			: range,
		children: node.children.map((child) => convert(document, child)),
	};
}
