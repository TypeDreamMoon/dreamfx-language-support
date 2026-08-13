import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { DIAGNOSTIC_PATTERN, LineSplitter, parseDiagnosticLine, stripAnsi } from '../src/core/diagnosticLine';

const ROOT = path.join(__dirname, '..', '..');

test('the contributed problem matcher and the runtime parser use the same pattern', () => {
	// Two readers of the same output -- the task terminal's matcher and the verify runner, which
	// spawns dfx itself and has no terminal to attach a matcher to. One pattern, and this is what
	// stops the copy drifting: a fix applied to one and not the other shows up as diagnostics
	// appearing in one path and not the other, which is a maddening thing to chase.
	const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
	const contributed = packageJson.contributes.problemMatchers[0].pattern.regexp;
	assert.equal(contributed, DIAGNOSTIC_PATTERN);
});

test('a diagnostic is read out of every shape the CLI prints', () => {
	const bare = parseDiagnosticLine('NS_Host.dfs(7,5): error DFX3043: reads user parameters this system does not declare.');
	assert.deepEqual(bare, {
		file: 'NS_Host.dfs',
		line: 7,
		column: 5,
		severity: 'error',
		code: 'DFX3043',
		message: 'reads user parameters this system does not declare.',
	});

	const logged = parseDiagnosticLine(
		'LogDreamFX: Warning: C:\\Work\\DFX\\Modules\\M_Spin.dfm(23,9): warning DFX5102: 静态开关按普通输入下放。');
	assert.equal(logged?.file, 'C:\\Work\\DFX\\Modules\\M_Spin.dfm');
	assert.equal(logged?.severity, 'warning');
	assert.equal(logged?.code, 'DFX5102');

	const stamped = parseDiagnosticLine(
		'[2026.08.13-10.00.00:000][  0]LogDreamFX: Display: X.dfs(1,1): info DFX5003: kept the undeclared stack.');
	assert.equal(stamped?.severity, 'info');
	assert.equal(stamped?.line, 1);
});

test('ANSI colouring does not hide a diagnostic', () => {
	// A task terminal strips these for us; a raw pipe does not, and dfx.ps1 colours its output.
	const coloured = `\u001b[31mNS.dfs(3,1): error DFX1001: Unterminated string literal.\u001b[0m`;
	assert.equal(parseDiagnosticLine(coloured)?.code, 'DFX1001');
	assert.equal(stripAnsi(coloured), 'NS.dfs(3,1): error DFX1001: Unterminated string literal.');
});

test('lines that are not diagnostics are not read as diagnostics', () => {
	const noise = [
		'dfx: build  project=DevTest.uproject  engine=I:/UnrealEngine/UE_5.8',
		'LogDreamFX: Display: Sources: 55, built 55, skipped 0, failed 0',
		'dfx: OK (exit 0)',
		'  DFX/Samples/NS_Spark.dfs  [rewritten, byte-identical]',
		'\t/Engine/Generated/NiagaraEmitterInstance.ush(202): error: syntax error, unexpected \';\'',
	];
	for (const line of noise) {
		assert.equal(parseDiagnosticLine(line), undefined, line);
	}
});

test('a diagnostic split across two chunks is still one line', () => {
	// A spawned process delivers bytes, not lines. Without this the halves each match nothing.
	const splitter = new LineSplitter();
	assert.deepEqual(splitter.push('NS.dfs(1,1): error DFX10'), []);
	assert.deepEqual(splitter.push('01: Unterminated string literal.\nnext line\n'), [
		'NS.dfs(1,1): error DFX1001: Unterminated string literal.',
		'next line',
	]);
	assert.deepEqual(splitter.flush(), []);
});

test('an unterminated final line is not lost', () => {
	const splitter = new LineSplitter();
	assert.deepEqual(splitter.push('tail with no newline'), []);
	assert.deepEqual(splitter.flush(), ['tail with no newline']);
	assert.deepEqual(splitter.flush(), []);
});

test('both line endings split the same', () => {
	const splitter = new LineSplitter();
	assert.deepEqual(splitter.push('a\r\nb\nc\r\n'), ['a', 'b', 'c']);
});
