/**
 * A sweep of real sources, opt-in via DREAMFX_CORPUS_DIR.
 *
 * The fixtures next door are chosen to exercise particular constructs, which means they are exactly
 * the cases that were thought of. This one runs over whatever the plugin's own tree contains --
 * hand-written samples and decompiled mirrors of third-party content alike -- and asserts the only
 * thing that can be asserted without an engine: a source that is known good produces no lexical
 * complaint, and its structure is recognised.
 *
 *   $env:DREAMFX_CORPUS_DIR = 'I:\...\Plugins\DreamFX'; npm test
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { contextAt } from '../src/core/context';
import { parseSchemaIndex } from '../src/core/schemaIndex';
import { analyze } from '../src/core/structure';

const CORPUS = process.env.DREAMFX_CORPUS_DIR;

test('every known-good source in the corpus scans clean', { skip: CORPUS ? false : 'DREAMFX_CORPUS_DIR is not set' }, () => {
	const files = collect(CORPUS!);
	assert.ok(files.length > 0, `no .dfs/.dfe/.dfm files under ${CORPUS}`);

	const failures: string[] = [];
	let rootless = 0;

	for (const file of files) {
		const model = analyze(fs.readFileSync(file, 'utf8'));
		for (const diagnostic of model.diagnostics) {
			failures.push(`${file}(${diagnostic.start.line},${diagnostic.start.column}): ${diagnostic.code ?? '-'} ${diagnostic.message}`);
		}
		if (!model.root) {
			rootless += 1;
			failures.push(`${file}: no top-level object recognised`);
		}
	}

	assert.deepEqual(failures, [], `${failures.length} problems across ${files.length} files (${rootless} unrecognised)`);
	console.log(`  scanned ${files.length} sources under ${CORPUS}`);
});

/**
 * The real index, end to end.
 *
 * Everything else about the index is tested against fixtures this file wrote, which proves the
 * shapes agree with themselves. This one reads what the plugin actually exported -- 500-odd modules
 * off a real engine -- and asks it the question the completion provider asks.
 */
test('the exported index answers a real completion query', { skip: CORPUS ? false : 'DREAMFX_CORPUS_DIR is not set' }, () => {
	const indexPath = findIndex(CORPUS!);
	if (!indexPath) {
		console.log('  no .dfx-index.json under the corpus dir; run `dfx index` to produce one');
		return;
	}

	const parsed = parseSchemaIndex(fs.readFileSync(indexPath, 'utf8'));
	assert.ok('index' in parsed, `index did not load: ${'error' in parsed ? parsed.error : ''}`);
	const index = parsed.index;

	assert.ok(index.modules.length > 100, `only ${index.modules.length} modules`);

	// A module every Niagara install has, with an input the compiler type-checks against.
	const gravity = index.resolveUnique('GravityForce');
	assert.ok(gravity, 'GravityForce did not resolve uniquely');
	assert.ok(gravity.stacks.includes('ParticleUpdate'));
	assert.ok(index.findInput(gravity, 'Gravity'), 'GravityForce has no Gravity input in the index');

	// The normalisation that lets a source write an identifier for a spaced Niagara name.
	const coordinateSpace = index.findInput(gravity, 'CoordinateSpace');
	assert.ok(coordinateSpace, 'CoordinateSpace did not resolve through the space-insensitive lookup');
	assert.ok((coordinateSpace.enum ?? []).length > 0, 'an enum input carries no entries');

	// And the whole path: cursor position -> context -> the offer that context produces.
	const source = 'System(Name="x")\n{\n    Emitter E\n    {\n        ParticleUpdate = {\n            Grav';
	const context = contextAt(source, source.length);
	assert.equal(context.kind, 'stackStatement');

	const offered = index.forStack('ParticleUpdate', 'module');
	assert.ok(offered.some((module) => module.name === 'GravityForce'));
	assert.ok(!offered.some((module) => module.name === 'EmitterState'),
		'EmitterState is an emitter-scope module and should not be offered in ParticleUpdate');

	console.log(`  index: ${index.modules.length} modules, ${offered.length} offerable in ParticleUpdate`);
});

function findIndex(root: string): string | undefined {
	const direct = path.join(root, 'DFX', '.dfx-index.json');
	if (fs.existsSync(direct)) {
		return direct;
	}
	const nested = path.join(root, '.dfx-index.json');
	return fs.existsSync(nested) ? nested : undefined;
}

function collect(root: string): string[] {
	const found: string[] = [];

	const walk = (directory: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				// Intermediate/ and Binaries/ hold no sources; .git holds a great many objects.
				if (['.git', 'node_modules', 'Intermediate', 'Binaries', 'Saved'].includes(entry.name)) {
					continue;
				}
				walk(full);
				continue;
			}
			// `.bad.` files exist to fail: they are the parser's negative corpus.
			if (/\.(dfs|dfe|dfm)$/i.test(entry.name) && !/\.bad\./i.test(entry.name)) {
				found.push(full);
			}
		}
	};

	walk(root);
	return found;
}
