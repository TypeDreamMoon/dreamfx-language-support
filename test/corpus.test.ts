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
