/**
 * Tests for the declarative half of the extension.
 *
 * Everything here is JSON that VSCode reads and, when it is wrong, ignores. A grammar rule that
 * includes a repository key which does not exist does not raise an error -- the rule simply never
 * fires, and the file is missing one colour with nothing to say why. Same for a problem matcher
 * whose regex does not match: the task turns green and the Problems panel stays empty.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

const ROOT = path.join(__dirname, '..', '..');

function readJson(...segments: string[]): any {
	return JSON.parse(fs.readFileSync(path.join(ROOT, ...segments), 'utf8'));
}

const packageJson = readJson('package.json');
const grammar = readJson('syntaxes', 'dreamfxlang.tmLanguage.json');

// ---------------------------------------------------------------- grammar

test('every #include in the grammar resolves to a repository rule', () => {
	const defined = new Set(Object.keys(grammar.repository));
	const missing: string[] = [];

	forEachRule(grammar, (rule) => {
		if (typeof rule.include === 'string' && rule.include.startsWith('#')) {
			const key = rule.include.slice(1);
			if (!defined.has(key)) {
				missing.push(rule.include);
			}
		}
	});

	assert.deepEqual(missing, []);
});

test('every repository rule is reachable', () => {
	const referenced = new Set<string>();
	forEachRule(grammar, (rule) => {
		if (typeof rule.include === 'string' && rule.include.startsWith('#')) {
			referenced.add(rule.include.slice(1));
		}
	});

	const unreachable = Object.keys(grammar.repository).filter((key) => !referenced.has(key));
	assert.deepEqual(unreachable, [], 'a rule nothing includes is dead weight that will drift');
});

test('every grammar pattern compiles', () => {
	// Oniguruma is a superset of the JS engine, so this proves compilability rather than identical
	// behaviour -- but a typo'd character class fails here, which is the bug that actually happens.
	const failures: string[] = [];
	forEachRule(grammar, (rule) => {
		for (const field of ['match', 'begin', 'end'] as const) {
			const pattern = rule[field];
			if (typeof pattern !== 'string') {
				continue;
			}
			try {
				new RegExp(pattern);
			} catch (error) {
				failures.push(`${field}: ${pattern} -- ${String(error)}`);
			}
		}
	});
	assert.deepEqual(failures, []);
});

test('the grammar claims the scope and file types the language contribution declares', () => {
	const language = packageJson.contributes.languages[0];
	const contributed = packageJson.contributes.grammars[0];

	assert.equal(language.id, 'dreamfxlang',
		'the plugin writes this id into DFX/DreamFX.code-workspace, so it is not a free choice');
	assert.deepEqual(language.extensions, ['.dfs', '.dfe', '.dfm']);
	assert.equal(contributed.scopeName, grammar.scopeName);
	assert.equal(contributed.language, language.id);
	assert.deepEqual(grammar.fileTypes, ['dfs', 'dfe', 'dfm']);
	assert.equal(contributed.embeddedLanguages['meta.embedded.block.hlsl'], 'hlsl',
		'the raw-block rule tags its content with this scope');
});

// ---------------------------------------------------------------- problem matcher

test('the problem matcher reads real dfx output', () => {
	const matcher = packageJson.contributes.problemMatchers[0];
	const pattern = new RegExp(matcher.pattern.regexp);

	// Every shape the CLI actually produces: bare, log-prefixed, and log-prefixed with the engine's
	// timestamp still attached. The message text is never matched against -- diagnostics are a mix of
	// English and Chinese and only the structure around them is stable.
	const cases: Array<{ line: string; file: string; line_: string; column: string; severity: string; code: string }> = [
		{
			line: 'NS_Host.dfs(7,5): error DFX3043: reads user parameters this system does not declare.',
			file: 'NS_Host.dfs', line_: '7', column: '5', severity: 'error', code: 'DFX3043',
		},
		{
			line: 'LogDreamFX: Error: I:/Project/Plugins/DreamFX/DFX/Samples/NS_Spark.dfs(120,17): error DFX4027: a float parameter cannot drive an int32 input.',
			file: 'I:/Project/Plugins/DreamFX/DFX/Samples/NS_Spark.dfs', line_: '120', column: '17', severity: 'error', code: 'DFX4027',
		},
		{
			line: 'LogDreamFX: Warning: C:\\Work\\DFX\\Modules\\M_Spin.dfm(23,9): warning DFX5102: 静态开关按普通输入下放。',
			file: 'C:\\Work\\DFX\\Modules\\M_Spin.dfm', line_: '23', column: '9', severity: 'warning', code: 'DFX5102',
		},
		{
			line: '[2026.08.13-10.00.00:000][  0]LogDreamFX: Display: X.dfs(1,1): info DFX5003: kept the undeclared stack.',
			file: 'X.dfs', line_: '1', column: '1', severity: 'info', code: 'DFX5003',
		},
	];

	for (const expected of cases) {
		const match = pattern.exec(expected.line);
		if (!match) {
			assert.fail(`no match for: ${expected.line}`);
		}
		assert.equal(match[matcher.pattern.file], expected.file);
		assert.equal(match[matcher.pattern.line], expected.line_);
		assert.equal(match[matcher.pattern.column], expected.column);
		assert.equal(match[matcher.pattern.severity], expected.severity);
		assert.equal(match[matcher.pattern.code], expected.code);
		assert.ok(match[matcher.pattern.message].length > 0);
	}
});

test('the problem matcher ignores everything that is not a diagnostic', () => {
	const matcher = packageJson.contributes.problemMatchers[0];
	const pattern = new RegExp(matcher.pattern.regexp);

	const nonDiagnostics = [
		'dfx: build  project=DevTest.uproject  engine=I:/UnrealEngine/UE_5.8',
		'LogDreamFX: Display: Sources: 55, built 55, skipped 0, failed 0',
		'dfx: OK (exit 0)',
		'  DFX/Samples/NS_Spark.dfs  [rewritten, byte-identical]',
		'LogDreamFX: Error: could not open the source file.',
	];

	for (const line of nonDiagnostics) {
		assert.equal(pattern.exec(line), null, `should not have matched: ${line}`);
	}
});

// ---------------------------------------------------------------- commands and tasks

test('every contributed command is registered by the extension', () => {
	const source = fs.readFileSync(path.join(ROOT, 'src', 'extension.ts'), 'utf8');
	const contributed: string[] = packageJson.contributes.commands.map((command: any) => command.command);

	const unregistered = contributed.filter((command) => !source.includes(`'${command}'`));
	assert.deepEqual(unregistered, [], 'a contributed command with no handler shows up in the palette and then fails');
});

test('every menu entry names a contributed command', () => {
	const contributed = new Set<string>(packageJson.contributes.commands.map((command: any) => command.command));
	for (const [menu, entries] of Object.entries<any[]>(packageJson.contributes.menus)) {
		for (const entry of entries) {
			assert.ok(contributed.has(entry.command), `${menu} names an unknown command '${entry.command}'`);
		}
	}
});

test('the task definition covers exactly the commands the runner knows', () => {
	const definition = packageJson.contributes.taskDefinitions.find((entry: any) => entry.type === 'dreamfx');
	assert.ok(definition);
	assert.deepEqual(definition.properties.command.enum, ['verify', 'lint', 'build', 'index']);
	assert.deepEqual(definition.properties.scope.enum, ['file', 'all']);
	assert.deepEqual(definition.required, ['command']);
});

// ---------------------------------------------------------------- snippets

test('the snippets file is valid and every snippet has a prefix and a body', () => {
	const snippets = readJson('snippets', 'dreamfxlang.code-snippets');
	const names = Object.keys(snippets);
	assert.ok(names.length > 0);

	const prefixes = new Set<string>();
	for (const name of names) {
		const snippet = snippets[name];
		assert.equal(typeof snippet.prefix, 'string', `${name} has no prefix`);
		assert.ok(Array.isArray(snippet.body) && snippet.body.length > 0, `${name} has no body`);
		assert.ok(!prefixes.has(snippet.prefix), `two snippets share the prefix '${snippet.prefix}'`);
		prefixes.add(snippet.prefix);
	}
});

test('main points at the compiled entry point', () => {
	// tsc keeps the src/ prefix under outDir because the test tree shares the root, so `main` is not
	// out/extension.js -- and a manifest pointing at a file that is not there installs cleanly and
	// then fails to activate, which is only visible in the extension host log.
	assert.ok(fs.existsSync(path.join(ROOT, packageJson.main)), `${packageJson.main} does not exist; run npm run compile`);
});

test('the DynamicInput snippet does not put a comment inside its body', () => {
	// Same measured hazard as the template: the body is written into Output = (Type)( <body> ), and
	// a comment there swallows the closing paren.
	const snippets = readJson('snippets', 'dreamfxlang.code-snippets');
	const body: string[] = snippets['DynamicInput document'].body;

	const start = body.findIndex((line) => line.includes('Body = {'));
	assert.ok(start !== -1);
	for (const line of body.slice(start)) {
		assert.ok(!line.includes('//') && !line.includes('/*'), `comment inside a DynamicInput body: ${line}`);
	}
});

test('the snippet contribution points at the file that exists', () => {
	const contributed = packageJson.contributes.snippets[0];
	assert.equal(contributed.language, 'dreamfxlang');
	assert.ok(fs.existsSync(path.join(ROOT, contributed.path)));
	assert.ok(fs.existsSync(path.join(ROOT, packageJson.contributes.languages[0].configuration)));
	assert.ok(fs.existsSync(path.join(ROOT, packageJson.contributes.grammars[0].path)));
});

// ---------------------------------------------------------------- helper

function forEachRule(node: any, visit: (rule: any) => void): void {
	if (Array.isArray(node)) {
		for (const entry of node) {
			forEachRule(entry, visit);
		}
		return;
	}
	if (!node || typeof node !== 'object') {
		return;
	}

	visit(node);
	for (const value of Object.values(node)) {
		forEachRule(value, visit);
	}
}
