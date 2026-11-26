import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { enclosingSourceRoot } from '../src/core/dreamSource';
import { SourceLayouts, findProjectsBelow, toFsPath, toUri } from '../src/server/workspace';

function tempDir(t: { after: (fn: () => void) => void }, prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return root;
}

function write(root: string, ...segments: string[]): void {
	const file = path.join(root, ...segments);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, '{}');
}

test('a file URI survives the round trip, spaces and non-ASCII included', () => {
	// The one conversion that has to be right on Windows: `file:///c%3A/...` is not a path, and a
	// hand-rolled strip-the-slash would have quietly mangled every project under a path with a space
	// -- or under a Chinese one, where every character arrives percent-encoded.
	const original = path.join('C:', 'Program Files', '项目', 'DreamSource', 'FX', 'a.dfs');
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

test('the walk down finds a project, skips the noise, and stops at the cap', (t) => {
	const root = tempDir(t, 'dfx-scan-');
	write(root, 'Games', 'A', 'A.uproject');
	// Under a skipped directory: an Intermediate tree can hold a copy, and walking one costs more
	// than everything else the scan does put together.
	write(root, 'Intermediate', 'B', 'B.uproject');
	// Past the depth cap.
	write(root, 'a', 'b', 'c', 'd', 'e', 'C.uproject');

	assert.deepEqual(findProjectsBelow([root], 10), [path.join(root, 'Games', 'A')]);
	assert.deepEqual(findProjectsBelow([path.join(os.tmpdir(), 'dfx-does-not-exist-9e3f')], 10), [],
		'an unreadable folder is not an error');
});

test('workspace folders inside a project walk up to it, and its roots come from the layout', (t) => {
	const project = tempDir(t, 'dfx-layout-');
	write(project, 'Game.uproject');
	write(project, 'DreamSource', 'FX', 'Systems', 'NS_A.dfs');
	write(project, 'Plugins', 'Fx', 'Fx.uplugin');
	write(project, 'Plugins', 'Fx', 'DFX', 'Samples', 'NS_B.dfs');
	// Folders that happen to be called FX or DFX are not roots (spec 7).
	write(project, 'Content', 'FX', 'NS_C.dfs');
	write(project, 'Tools', 'DFX', 'NS_D.dfs');

	const layouts = new SourceLayouts();
	layouts.setWorkspaceFolders([path.join(project, 'DreamSource', 'FX'), path.join(project, 'Plugins', 'Fx', 'DFX')]);
	assert.deepEqual(layouts.projects(), [project]);

	const layout = layouts.layout(project);
	const rootOf = (...segments: string[]) => enclosingSourceRoot(path.join(project, ...segments), layout.roots)?.directory;
	assert.equal(rootOf('DreamSource', 'FX', 'Systems', 'NS_A.dfs'), path.join(project, 'DreamSource', 'FX'));
	assert.equal(rootOf('Plugins', 'Fx', 'DFX', 'Samples', 'NS_B.dfs'), path.join(project, 'Plugins', 'Fx', 'DFX'));
	assert.equal(rootOf('Content', 'FX', 'NS_C.dfs'), undefined);
	assert.equal(rootOf('Tools', 'DFX', 'NS_D.dfs'), undefined);
	assert.equal(layouts.projectFor(path.join(project, 'Content', 'FX', 'NS_C.dfs')), project);
});

test('a changed ini is seen once the layouts are invalidated', (t) => {
	const project = tempDir(t, 'dfx-ini-');
	write(project, 'Game.uproject');
	write(project, 'Effects', 'NS_A.dfs');
	const layouts = new SourceLayouts();
	assert.equal(layouts.layout(project).project.state, 'none');

	fs.mkdirSync(path.join(project, 'Config'), { recursive: true });
	fs.writeFileSync(path.join(project, 'Config', 'DefaultDreamSource.ini'),
		'[/Script/DreamFXEditor.DreamFXSourceSettings]\nSourceDirectory=(Path="Effects")\n');
	assert.equal(layouts.layout(project).project.state, 'none', 'cached until told');
	layouts.invalidate();
	assert.equal(layouts.layout(project).project.activeDir, path.join(project, 'Effects'));
});
