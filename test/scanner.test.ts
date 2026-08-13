import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Scanner } from '../src/core/scanner';

function tokenize(source: string) {
	const scanner = new Scanner(source);
	const tokens = [];
	for (;;) {
		const token = scanner.next();
		if (token.kind === 'end') {
			break;
		}
		tokens.push(token);
	}
	return { tokens, diagnostics: scanner.diagnostics };
}

test('two-character operators beat their single-character prefixes', () => {
	// `->` lexing as `-` then `>` is what would turn every curve key into a syntax error.
	const { tokens } = tokenize('0.0 -> 1.0;');
	assert.deepEqual(tokens.map((token) => token.text), ['0.0', '->', '1.0', ';']);
});

test('a number never starts with a minus', () => {
	// Otherwise `A-1` lexes as `A` followed by the literal -1 and the subtraction is lost.
	const { tokens } = tokenize('A-1');
	assert.deepEqual(tokens.map((token) => token.text), ['A', '-', '1']);
});

test('integer and float literals are distinguishable', () => {
	const { tokens } = tokenize('24 24.0 24f 2e3 1.5e-2');
	assert.deepEqual(tokens.map((token) => token.isInteger), [true, false, false, false, false]);
	assert.equal(tokens[2].text, '24', 'the f suffix is not part of the digits');
	assert.equal(tokens[4].value, 0.015);
});

test('a back-quoted name is one token, dots included', () => {
	const { tokens, diagnostics } = tokenize('`User.PillarPower(0~1)` = 1;');
	assert.equal(diagnostics.length, 0);
	assert.equal(tokens[0].kind, 'identifier');
	assert.equal(tokens[0].quoted, true);
	assert.equal(tokens[0].text, 'User.PillarPower(0~1)');
});

test('an unterminated back-quoted name is DFX1005 and does not eat the next line', () => {
	const { diagnostics } = tokenize('float `Broken\nfloat Fine = 1.0;\n');
	assert.equal(diagnostics.length, 1);
	assert.equal(diagnostics[0].code, 'DFX1005');
	assert.equal(diagnostics[0].start.line, 1);
});

test('an unterminated string is DFX1001', () => {
	const { diagnostics } = tokenize('Material = "/Game/FX/M_Spark;\n');
	assert.equal(diagnostics.length, 1);
	assert.equal(diagnostics[0].code, 'DFX1001');
});

test('an unterminated block comment is DFX1002', () => {
	const { diagnostics } = tokenize('/* opened and never closed\nSystem(Name="x")\n');
	assert.deepEqual(diagnostics.map((entry) => entry.code), ['DFX1002']);
});

test('a character outside the alphabet is DFX1003', () => {
	// The realistic case is an IME leaving a full-width bracket behind, which otherwise surfaces as
	// a baffling error several lines later.
	const { diagnostics } = tokenize('GravityForce（Gravity = 1);');
	assert.equal(diagnostics.length, 1);
	assert.equal(diagnostics[0].code, 'DFX1003');
	assert.match(diagnostics[0].message, /U\+FF08/);
});

test('escapes are decoded and the raw spelling is not', () => {
	const { tokens } = tokenize('"a\\"b\\nc"');
	assert.equal(tokens[0].kind, 'string');
	assert.equal(tokens[0].text, 'a"b\nc');
});

test('line and column survive mixed line endings', () => {
	const { tokens } = tokenize('a\r\nb\rc\nd');
	assert.deepEqual(tokens.map((token) => token.start.line), [1, 2, 3, 4]);
	assert.deepEqual(tokens.map((token) => token.start.column), [1, 1, 1, 1]);
});

test('a raw block is read as characters, not tokens', () => {
	const scanner = new Scanner('hlsl { float4(Particles.Color.rgb, "{") } trailing');
	scanner.next(); // hlsl
	const block = scanner.readRawBlock();
	if (!block) {
		assert.fail('the raw block should have been read');
	}
	assert.equal(block.text.trim(), 'float4(Particles.Color.rgb, "{")');
	assert.equal(scanner.next().text, 'trailing');
	assert.equal(scanner.diagnostics.length, 0);
});

test('a raw block counts nested braces and ignores braces in comments and strings', () => {
	const source = 'Body = {\n  if (x) {\n    // }\n    y = "}";\n  }\n}\nafter';
	const scanner = new Scanner(source);
	scanner.next(); // Body
	scanner.next(); // =
	const block = scanner.readRawBlock();
	if (!block) {
		assert.fail('the raw block should have been read');
	}
	assert.match(block.text, /y = "\}";/);
	assert.equal(scanner.next().text, 'after');
});

test('an unterminated raw block is DFX1004', () => {
	const scanner = new Scanner('hlsl { float4(1,1,1,1)');
	scanner.next();
	assert.equal(scanner.readRawBlock(), undefined);
	assert.deepEqual(scanner.diagnostics.map((entry) => entry.code), ['DFX1004']);
});

test('peek past the end keeps returning the end token', () => {
	const scanner = new Scanner('a');
	assert.equal(scanner.peek(0).text, 'a');
	assert.equal(scanner.peek(5).kind, 'end');
	scanner.next();
	assert.equal(scanner.next().kind, 'end');
	assert.equal(scanner.next().kind, 'end');
});
