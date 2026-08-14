import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { enclosingDfxRoot, findIndexFiles, toFsPath, toUri } from '../src/server/workspace';

test('a path inside a DFX tree reports the tree it is in', () => {
	assert.equal(
		enclosingDfxRoot(path.join('C:', 'Game', 'DFX', 'Systems', 'NS_Spark.dfs')),
		path.join('C:', 'Game', 'DFX'));
});

test('the innermost DFX wins, and a path with none says so', () => {
	// Not a construct the plugin generates, but the split is a `lastIndexOf` and the answer it gives
	// should be the one a reader expects rather than an accident of the implementation.
	assert.equal(
		enclosingDfxRoot(path.join('C:', 'DFX', 'Plugins', 'DFX', 'a.dfs')),
		path.join('C:', 'DFX', 'Plugins', 'DFX'));
	assert.equal(enclosingDfxRoot(path.join('C:', 'Game', 'Content', 'a.dfs')), undefined);
});

test('a root is named for a file that does not exist yet', () => {
	// `destinationFor` asks where an index *would* go, so this cannot become a filesystem check.
	assert.equal(
		enclosingDfxRoot(path.join('C:', 'Game', 'DFX', 'nothing-here.dfs')),
		path.join('C:', 'Game', 'DFX'));
});

test('a file URI survives the round trip, spaces and non-ASCII included', () => {
	// The one conversion that has to be right on Windows: `file:///c%3A/...` is not a path, and a
	// hand-rolled strip-the-slash would have quietly mangled every project under a path with a space
	// -- or under a Chinese one, where every character arrives percent-encoded.
	const original = path.join('C:', 'Program Files', '项目', 'DFX', 'a.dfs');
	const roundTripped = toFsPath(toUri(original));

	// Drive letter case is not preserved: `vscode-uri` lower-cases it, as the editor's own URIs do.
	// Everything else has to survive exactly.
	assert.equal(roundTripped?.toLowerCase(), original.toLowerCase());
	assert.equal(roundTripped?.slice(2), original.slice(2), 'only the drive letter may differ');
});

test('the drive letter is normalised the same way every time', () => {
	// Why it is safe that the round trip loses the case: the index cache keys a Map on a root path,
	// so two spellings of one root would be two entries and a doubled parse of the same file.
	assert.equal(
		toFsPath(toUri(path.join('C:', 'Game', 'DFX'))),
		toFsPath(toUri(path.join('c:', 'Game', 'DFX'))));
});

test('a URI that is not on disk has no path', () => {
	assert.equal(toFsPath('untitled:Untitled-1'), undefined);
	assert.equal(toFsPath('https://example.com/a.dfs'), undefined);
});

test('a string that is not a URI is not silently read as a path', () => {
	// The lenient parse assumes `file:` when there is no scheme, which would turn this into
	// `\not a uri at all` -- an absolute path that looks real enough to be acted on.
	assert.equal(toFsPath('not a uri at all'), undefined);
	assert.equal(toFsPath(''), undefined);
});

test('the scan finds an index, skips the noise, and stops at the cap', (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfx-scan-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));

	const write = (...segments: string[]): void => {
		const file = path.join(root, ...segments);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, '{}');
	};

	write('Plugins', 'A', 'DFX', '.dfx-index.json');
	// Under a skipped directory: an Intermediate tree can hold a copy, and walking one costs more
	// than everything else the scan does put together.
	write('Intermediate', 'Build', 'DFX', '.dfx-index.json');
	// Past the depth cap.
	write('a', 'b', 'c', 'd', 'e', 'DFX', '.dfx-index.json');

	const found = findIndexFiles([root], 10);
	assert.deepEqual(found, [path.join(root, 'Plugins', 'A', 'DFX', '.dfx-index.json')]);
});

test('a DFX directory without an index is not a find', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfx-empty-'));
	fs.mkdirSync(path.join(root, 'DFX'), { recursive: true });
	assert.deepEqual(findIndexFiles([root], 10), []);
	fs.rmSync(root, { recursive: true, force: true });
});

test('an unreadable folder is not an error', () => {
	// A project tree always has one, and the scan is best-effort by design.
	assert.deepEqual(findIndexFiles([path.join(os.tmpdir(), 'dfx-does-not-exist-9e3f')], 10), []);
});
