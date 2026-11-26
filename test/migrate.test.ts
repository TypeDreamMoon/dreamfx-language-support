/**
 * The migration's disk half (spec 13.6), on a throwaway project: what moves, what is rewritten, what
 * is cleared, what is left alone -- and what it refuses.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { migrateProject } from '../src/core/migrate';

function write(root: string, relative: string, contents = ''): void {
	const file = path.join(root, ...relative.split('/'));
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, contents);
}

function exists(root: string, relative: string): boolean {
	return fs.existsSync(path.join(root, ...relative.split('/')));
}

const WORKSPACE = `{
\t"folders": [
\t\t{ "name": "DreamFX Source", "path": "." },
\t\t{ "name": "Plugin: World", "path": "../Plugins/World/DFX" },
\t\t{ "name": "Plugin: Moved", "path": "../Plugins/Moved/DFX" }
\t]
}
`;

function legacyProject(t: { after: (fn: () => void) => void }): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfx-migrate-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	write(root, 'Game.uproject', '{}');
	write(root, 'DFX/Effects/NS_A.dfs', 'System(Name="Effects/NS_A")\n');
	write(root, 'DFX/.git/HEAD', 'ref: refs/heads/main\n');
	write(root, 'DFX/.dfx-index.json', '{"version":1,"modules":[]}');
	write(root, 'DFX/.dfx-index.json.quarantine', '/Niagara/Modules/Masks/ConeMask');
	write(root, 'DFX/DreamFX.code-workspace', WORKSPACE);
	write(root, 'Plugins/World/World.uplugin', '{}');
	write(root, 'Plugins/World/DFX/Effects/NS_W.dfs');
	write(root, 'Plugins/Moved/Moved.uplugin', '{}');
	write(root, 'Plugins/Moved/DreamSource/FX/Effects/NS_M.dfs');
	write(root, 'Saved/DreamFX/Bridge/diagnostics.json', '{}');
	write(root, 'Saved/DreamFX/Bridge/Requests/r.json', '{}');
	write(root, 'Saved/DreamFX/DynamicMesh/mesh.bin');
	write(root, 'Saved/DreamFX/Pull/NS_A.txt');
	return root;
}

test('the old folder moves whole, its workspace is re-aimed, and only the old bridge is cleared', (t) => {
	const root = legacyProject(t);
	const result = migrateProject(root, false);
	assert.ok(result.ok, result.message);
	assert.equal(result.from, path.join(root, 'DFX'));
	assert.equal(result.to, path.join(root, 'DreamSource', 'FX'));
	assert.equal(result.workspaceRewritten, true);

	assert.ok(!exists(root, 'DFX'));
	assert.equal(fs.readFileSync(path.join(root, 'DreamSource', 'FX', 'Effects', 'NS_A.dfs'), 'utf8'), 'System(Name="Effects/NS_A")\n',
		'sources move unchanged');
	assert.ok(exists(root, 'DreamSource/FX/.git/HEAD'), 'a DFX/ that is its own repository keeps it');
	// Not converted: the plugin imports these on its next index run, and readers fall back meanwhile.
	assert.ok(exists(root, 'DreamSource/FX/.dfx-index.json'));
	assert.ok(exists(root, 'DreamSource/FX/.dfx-index.json.quarantine'));
	assert.ok(!exists(root, 'DreamSource/FX/.dreamfx'));

	const workspace = fs.readFileSync(path.join(root, 'DreamSource', 'FX', 'DreamFX.code-workspace'), 'utf8');
	assert.equal(workspace, WORKSPACE
		.replace('"../Plugins/World/DFX"', '"../../Plugins/World/DFX"')
		.replace('"../Plugins/Moved/DFX"', '"../../Plugins/Moved/DreamSource/FX"'));

	assert.ok(!exists(root, 'Saved/DreamFX/Bridge'));
	assert.ok(exists(root, 'Saved/DreamFX/DynamicMesh/mesh.bin'), 'DynamicMesh stays where it is');
	assert.ok(exists(root, 'Saved/DreamFX/Pull/NS_A.txt'));
});

test('a running editor, an existing target, or nothing to move are refusals that touch nothing', (t) => {
	const running = legacyProject(t);
	const refused = migrateProject(running, true);
	assert.equal(refused.ok, false);
	assert.match(refused.message, /Close it first/);
	assert.ok(exists(running, 'DFX/Effects/NS_A.dfs'));
	assert.ok(exists(running, 'Saved/DreamFX/Bridge/diagnostics.json'));

	const both = legacyProject(t);
	write(both, 'DreamSource/FX/Other.dfs');
	const merge = migrateProject(both, false);
	assert.equal(merge.ok, false);
	assert.match(merge.message, /would be a merge/);
	assert.ok(exists(both, 'DFX/Effects/NS_A.dfs'));

	const done = legacyProject(t);
	assert.ok(migrateProject(done, false).ok);
	const again = migrateProject(done, false);
	assert.equal(again.ok, false);
	assert.match(again.message, /already uses DreamSource\/FX\//);
});

test('a configured source directory is the target', (t) => {
	const root = legacyProject(t);
	write(root, 'Config/DefaultDreamSource.ini', '[/Script/DreamFXEditor.DreamFXSourceSettings]\nSourceDirectory=(Path="Source/Art/FX")\n');
	const result = migrateProject(root, false);
	assert.ok(result.ok, result.message);
	assert.equal(result.to, path.join(root, 'Source', 'Art', 'FX'));
	assert.match(fs.readFileSync(path.join(root, 'Source', 'Art', 'FX', 'DreamFX.code-workspace'), 'utf8'),
		/"path": "\.\.\/\.\.\/\.\.\/Plugins\/World\/DFX"/);
});
