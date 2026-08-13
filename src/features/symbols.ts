/**
 * Outline, breadcrumbs and "go to symbol in file", all from the one structural walk.
 *
 * Positions are converted through `document.positionAt` rather than from the walker's own line and
 * column. The walker's numbers exist to match DFXnnnn messages, which are one-based; VSCode is
 * zero-based, and an off-by-one in a navigation feature is the kind of bug that is noticed only
 * after someone has been quietly landing on the wrong line for a week.
 */

import * as vscode from 'vscode';

import { StructureKind, StructureNode, analyze } from '../core';

const SYMBOL_KINDS: Record<StructureKind, vscode.SymbolKind> = {
	document: vscode.SymbolKind.Module,
	emitter: vscode.SymbolKind.Class,
	stack: vscode.SymbolKind.Function,
	section: vscode.SymbolKind.Struct,
	renderer: vscode.SymbolKind.Object,
	moduleCall: vscode.SymbolKind.Method,
	declaration: vscode.SymbolKind.Field,
};

export class DreamFXDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
	provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
		const model = analyze(document.getText());
		return model.root ? [convert(document, model.root)] : [];
	}
}

function convert(document: vscode.TextDocument, node: StructureNode): vscode.DocumentSymbol {
	const range = new vscode.Range(document.positionAt(node.start.offset), document.positionAt(node.end.offset));
	const selectionRaw = new vscode.Range(
		document.positionAt(node.selectionStart.offset),
		document.positionAt(node.selectionEnd.offset));

	// VSCode drops a symbol outright when its selection is not inside its range, and the walker is
	// deliberately forgiving about half-typed text -- so the two are reconciled rather than trusted.
	const selection = range.contains(selectionRaw) ? selectionRaw : range;

	const symbol = new vscode.DocumentSymbol(
		node.name || '(unnamed)',
		node.detail,
		SYMBOL_KINDS[node.kind],
		range,
		selection);

	symbol.children = node.children.map((child) => convert(document, child));
	return symbol;
}
