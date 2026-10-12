import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { SymbolKind } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { analyze } from '../src/core/structure';
import { documentSymbols } from '../src/server/symbols';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');

function symbolsOf(text: string) {
	const document = TextDocument.create('file:///test.dfs', 'dreamfxlang', 1, text);
	return documentSymbols(document, analyze(text));
}

test('the fixture becomes one rooted tree', () => {
	const source = fs.readFileSync(path.join(FIXTURES, 'sample.dfs'), 'utf8');
	const symbols = symbolsOf(source);

	assert.equal(symbols.length, 1);
	assert.equal(symbols[0].kind, SymbolKind.Module);
	assert.ok(symbols[0].children!.length > 0, 'a System with two emitters has children');
});

test('every selection range sits inside its own range', () => {
	// Clients drop a symbol outright when it does not, and a dropped symbol is invisible rather than
	// wrong -- which is exactly the kind of regression that survives a release.
	const source = fs.readFileSync(path.join(FIXTURES, 'sample.dfs'), 'utf8');

	const walk = (nodes: ReturnType<typeof symbolsOf>): void => {
		for (const node of nodes) {
			const { range, selectionRange } = node;
			const startsInside = selectionRange.start.line > range.start.line
				|| (selectionRange.start.line === range.start.line
					&& selectionRange.start.character >= range.start.character);
			const endsInside = selectionRange.end.line < range.end.line
				|| (selectionRange.end.line === range.end.line
					&& selectionRange.end.character <= range.end.character);

			assert.ok(startsInside && endsInside, `${node.name}: selection escapes its range`);
			walk(node.children ?? []);
		}
	};

	walk(symbolsOf(source));
});

test('half-typed text still produces symbols rather than throwing', () => {
	// The walker is deliberately forgiving, and an outline that vanished on every unclosed brace
	// would be an outline nobody could use while writing.
	const symbols = symbolsOf('System(Name="T", Root="P")\n{\n\tEmitter E\n\t{\n');
	assert.equal(symbols.length, 1);
});

test('a Group is a namespace symbol that holds its declarations', () => {
	const source = 'System(Name="T")\n{\n\tProperties = {\n\t\tGroup("Burst") {\n\t\t\tint SparkCount = 24;\n\t\t}\n\t}\n}\n';
	const properties = symbolsOf(source)[0].children![0];
	assert.equal(properties.name, 'Properties');

	const [burst] = properties.children!;
	assert.equal(burst.name, 'Burst');
	assert.equal(burst.kind, SymbolKind.Namespace);
	assert.deepEqual(burst.children!.map((child) => [child.name, child.kind]), [['SparkCount', SymbolKind.Field]]);
	// The row selects the quoted name (line 3, after the opening paren), not the whole block.
	assert.equal(burst.selectionRange.start.line, 3);
	assert.equal(burst.range.end.line, 5);
});

test('an empty document has no root to convert', () => {
	assert.deepEqual(symbolsOf(''), []);
});
