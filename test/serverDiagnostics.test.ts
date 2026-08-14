import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DiagnosticSeverity } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { analyze } from '../src/core/structure';
import { DIAGNOSTIC_SOURCE, syntaxDiagnostics } from '../src/server/diagnostics';

function diagnose(text: string) {
	const document = TextDocument.create('file:///test.dfs', 'dreamfxlang', 1, text);
	return syntaxDiagnostics(document, analyze(text));
}

test('an unterminated string is reported against its own code', () => {
	const found = diagnose('System(Name="unterminated\n{\n}\n');
	assert.ok(found.length > 0, 'an unterminated string is a DFX1xxx');

	const [first] = found;
	assert.equal(first.source, DIAGNOSTIC_SOURCE);
	assert.equal(first.severity, DiagnosticSeverity.Error);
	assert.match(String(first.code), /^DFX1/);
});

test('a code carries a link to the page that documents it', () => {
	// `codeDescription.href` is the protocol's spelling of what was a `Uri` on a `code` object. It is
	// a different field name, not a different feature, and dropping it loses the link silently.
	const [first] = diagnose('System(Name="unterminated\n{\n}\n');
	assert.ok(first.codeDescription?.href, 'the code should link to its documentation');
	assert.match(first.codeDescription.href, /DFX1xxx\.md#dfx1\d{3}$/);
});

test('a zero-width span is widened so the squiggle is visible', () => {
	// An empty range renders as nothing at all, which reads as "no problem here".
	for (const diagnostic of diagnose('System(Name="T", Root="P")\n{\n')) {
		const { start, end } = diagnostic.range;
		assert.ok(
			end.line > start.line || end.character > start.character,
			`${diagnostic.message}: an empty range is an invisible squiggle`);
	}
});

test('the fixture-shaped happy path is clean', () => {
	assert.deepEqual(diagnose('System(Name="T", Root="P")\n{\n}\n'), []);
});
