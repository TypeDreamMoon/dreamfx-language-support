import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TextDocument } from 'vscode-languageserver-textdocument';

import { AnalysisCache } from '../src/server/analysisCache';

const SOURCE = 'System(Name="T", Root="P")\n{\n}\n';

test('one walk per version, shared by every handler that asks', () => {
	const cache = new AnalysisCache();
	const document = TextDocument.create('file:///test.dfs', 'dreamfxlang', 1, SOURCE);

	// Identity, not equality: the point is that the second caller did not walk the document again.
	assert.equal(cache.get(document), cache.get(document));
});

test('a new version is a new walk', () => {
	const cache = new AnalysisCache();
	const first = TextDocument.create('file:///test.dfs', 'dreamfxlang', 1, SOURCE);
	const second = TextDocument.create('file:///test.dfs', 'dreamfxlang', 2, `${SOURCE}// edited\n`);

	assert.notEqual(cache.get(first), cache.get(second));
});

test('two documents do not share an entry', () => {
	const cache = new AnalysisCache();
	const a = TextDocument.create('file:///a.dfs', 'dreamfxlang', 1, SOURCE);
	const b = TextDocument.create('file:///b.dfs', 'dreamfxlang', 1, SOURCE);

	assert.notEqual(cache.get(a), cache.get(b));
});

test('a closed document is forgotten', () => {
	const cache = new AnalysisCache();
	const document = TextDocument.create('file:///test.dfs', 'dreamfxlang', 1, SOURCE);

	const before = cache.get(document);
	cache.forget(document.uri);
	assert.notEqual(cache.get(document), before);
});
