/**
 * The DreamSource resolver (spec 3, 4, 7 and 13), against an in-memory filesystem: every row of the
 * C/L table, the ini's two spellings, plugin roots, membership and the workspace-file rewrite.
 */

import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';

import {
	SourceFs,
	deprecationNotice,
	enclosingSourceRoot,
	parseSourceDirectorySetting,
	planMigration,
	pluginSourceRoots,
	resolveProjectLayout,
	resolveProjectSourceRoot,
	rewriteWorkspaceFile,
} from '../src/core/dreamSource';

const SECTION = '/Script/DreamFXEditor.DreamFXSourceSettings';
const P = path.join(path.sep === '\\' ? 'X:\\' : '/', 'Proj');

/** A filesystem of the given directories and files (contents by path). */
function memoryFs(directories: string[], files: Record<string, string> = {}): SourceFs {
	const norm = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
	const dirs = new Set<string>();
	/** Lower-cased for lookups, as Windows compares; listed in the case it was written in. */
	const spelled = new Map<string, string>();
	const add = (value: string) => {
		let current = value;
		for (;;) {
			dirs.add(norm(current));
			spelled.set(norm(current), current.replace(/\\/g, '/').replace(/\/+$/, ''));
			const parent = path.dirname(current);
			if (parent === current) {
				break;
			}
			current = parent;
		}
	};
	directories.forEach(add);
	Object.keys(files).forEach((file) => add(path.dirname(file)));
	const fileMap = new Map(Object.entries(files).map(([key, value]) => [norm(key), value]));
	Object.keys(files).forEach((file) => spelled.set(norm(file), file.replace(/\\/g, '/')));
	const all = [...dirs, ...fileMap.keys()];
	return {
		isDirectory: (target) => dirs.has(norm(target)),
		isFile: (target) => fileMap.has(norm(target)),
		readText: (target) => fileMap.get(norm(target)),
		list: (target) => {
			const prefix = `${norm(target)}/`;
			const children = all.filter((entry) => entry.startsWith(prefix) && !entry.slice(prefix.length).includes('/'));
			return children.map((entry) => spelled.get(entry)!.split('/').pop()!);
		},
	};
}

const ini = (body: string) => ({ [path.join(P, 'Config', 'DefaultDreamSource.ini')]: `[${SECTION}]\n${body}\n` });

test('the ini is read in both spellings, the last assignment wins, and other sections are ignored', () => {
	assert.equal(parseSourceDirectorySetting(`[${SECTION}]\nSourceDirectory=(Path="Art/FX")\n`, SECTION), 'Art/FX');
	assert.equal(parseSourceDirectorySetting(`[${SECTION}]\nSourceDirectory=Art/FX\n`, SECTION), 'Art/FX');
	assert.equal(parseSourceDirectorySetting(`[${SECTION}]\nSourceDirectory="Art\\FX\\"\n`, SECTION), 'Art/FX');
	assert.equal(parseSourceDirectorySetting(`[${SECTION}]\nSourceDirectory=A\nSourceDirectory=B\n`, SECTION), 'B');
	assert.equal(parseSourceDirectorySetting('[/Script/DreamGUI.DreamUISourceSettings]\nSourceDirectory=UI\n', SECTION), undefined);
	assert.equal(parseSourceDirectorySetting(`\uFEFF; comment\n[${SECTION}]\r\nSourceDirectory=(Path="X")\r\n`, SECTION), 'X');
});

test('an absolute or empty setting is no setting: the default stands in', () => {
	for (const value of ['(Path="C:/Elsewhere/FX")', '/abs/FX', '\\\\server\\share', '(Path="")', '']) {
		assert.equal(parseSourceDirectorySetting(`[${SECTION}]\nSourceDirectory=${value}\n`, SECTION), undefined, value);
		const root = resolveProjectSourceRoot(P, memoryFs([], ini(`SourceDirectory=${value}`)), path.join);
		assert.equal(root.configuredSetting, 'DreamSource/FX', value);
	}
});

test('C exists: C, and nothing to say', () => {
	const root = resolveProjectSourceRoot(P, memoryFs([path.join(P, 'DreamSource', 'FX')]), path.join);
	assert.equal(root.state, 'configured');
	assert.equal(root.activeDir, path.join(P, 'DreamSource', 'FX'));
	assert.equal(deprecationNotice(root), undefined);
});

test('C and L exist: C, and L is said to be ignored', () => {
	const root = resolveProjectSourceRoot(P, memoryFs([path.join(P, 'DreamSource', 'FX'), path.join(P, 'DFX')]), path.join);
	assert.equal(root.state, 'configuredAndLegacy');
	assert.equal(root.activeDir, path.join(P, 'DreamSource', 'FX'));
	assert.match(deprecationNotice(root)!, /DFX\/ is ignored/);
});

test('only L exists: L, and asked to move', () => {
	const root = resolveProjectSourceRoot(P, memoryFs([path.join(P, 'DFX')]), path.join);
	assert.equal(root.state, 'legacy');
	assert.equal(root.activeDir, path.join(P, 'DFX'));
	assert.equal(root.directory, path.join(P, 'DFX'));
	assert.match(deprecationNotice(root)!, /DFX\/ is deprecated\. Move it to DreamSource\/FX\//);
});

test('neither: no active root, and C is where things get created', () => {
	const root = resolveProjectSourceRoot(P, memoryFs([P]), path.join);
	assert.equal(root.state, 'none');
	assert.equal(root.activeDir, undefined);
	assert.equal(root.directory, path.join(P, 'DreamSource', 'FX'));
	assert.equal(deprecationNotice(root), undefined);
});

test('a configured directory is honoured, and one that names DFX itself is not "both"', () => {
	const custom = resolveProjectSourceRoot(P, memoryFs([path.join(P, 'Art', 'FX'), path.join(P, 'DFX')], ini('SourceDirectory=(Path="Art/FX")')), path.join);
	assert.equal(custom.state, 'configuredAndLegacy');
	assert.equal(custom.activeDir, path.join(P, 'Art', 'FX'));

	const pointedAtLegacy = resolveProjectSourceRoot(P, memoryFs([path.join(P, 'DFX')], ini('SourceDirectory=DFX')), path.join);
	assert.equal(pointedAtLegacy.state, 'configured');
	assert.equal(deprecationNotice(pointedAtLegacy), undefined);
});

test('plugin roots: DreamSource/FX first, DFX otherwise, nested plugin folders included', () => {
	const fileSystem = memoryFs([
		path.join(P, 'Plugins', 'A', 'DreamSource', 'FX'),
		path.join(P, 'Plugins', 'A', 'DFX'),
		path.join(P, 'Plugins', 'Group', 'B', 'DFX'),
		path.join(P, 'Plugins', 'C', 'Content'),
	], {
		[path.join(P, 'Plugins', 'A', 'A.uplugin')]: '{}',
		[path.join(P, 'Plugins', 'Group', 'B', 'B.uplugin')]: '{}',
		[path.join(P, 'Plugins', 'C', 'C.uplugin')]: '{}',
	});
	const roots = pluginSourceRoots(P, fileSystem, path.join);
	assert.deepEqual(roots.map((root) => [root.plugin, root.directory, root.legacy]), [
		['A', path.join(P, 'Plugins', 'A', 'DreamSource', 'FX'), false],
		['B', path.join(P, 'Plugins', 'Group', 'B', 'DFX'), true],
	]);
});

test('membership is "under a resolved root", not "has a folder called DFX or FX"', () => {
	const fileSystem = memoryFs([
		path.join(P, 'DreamSource', 'FX'),
		path.join(P, 'Content', 'FX'),
		path.join(P, 'Plugins', 'A', 'DFX'),
	], { [path.join(P, 'Plugins', 'A', 'A.uplugin')]: '{}' });
	const layout = resolveProjectLayout(P, fileSystem, path.join);
	const rootOf = (...segments: string[]) => enclosingSourceRoot(path.join(P, ...segments), layout.roots);

	assert.equal(rootOf('DreamSource', 'FX', 'a.dfs')?.owner, 'project');
	assert.deepEqual(rootOf('Plugins', 'A', 'DFX', 'b.dfs')?.owner, { plugin: 'A', pluginDir: path.join(P, 'Plugins', 'A') });
	assert.equal(rootOf('Content', 'FX', 'c.dfs'), undefined);
	assert.equal(rootOf('DFX', 'd.dfs'), undefined, 'a DFX/ the project no longer uses is not a root');
	assert.equal(rootOf('DreamSource', 'FXOther', 'e.dfs'), undefined, 'a sibling with a common prefix is not inside');
});

test('a migration is planned only from the legacy state, with no editor running', () => {
	const legacy = resolveProjectSourceRoot(P, memoryFs([path.join(P, 'DFX')]), path.join);
	const plan = planMigration(legacy, false, path.join);
	assert.ok(plan.ok);
	assert.equal(plan.from, path.join(P, 'DFX'));
	assert.equal(plan.to, path.join(P, 'DreamSource', 'FX'));
	assert.deepEqual(plan.staleDirectories, [path.join(P, 'Saved', 'DreamFX', 'Bridge')],
		'only the old bridge is cleared; DynamicMesh, Pull and the rest stay');

	assert.match((planMigration(legacy, true, path.join) as { reason: string }).reason, /Close it first/);
	const both = resolveProjectSourceRoot(P, memoryFs([path.join(P, 'DFX'), path.join(P, 'DreamSource', 'FX')]), path.join);
	assert.match((planMigration(both, false, path.join) as { reason: string }).reason, /would be a merge/);
	const none = resolveProjectSourceRoot(P, memoryFs([P]), path.join);
	assert.equal(planMigration(none, false, path.join).ok, false);
});

test('the workspace file is re-aimed from its new place, keeping its formatting', () => {
	// The file the plugin writes, as it is in the reference project.
	const original = [
		'{',
		'\t"folders": [',
		'\t\t{',
		'\t\t\t"name": "DreamFX Source",',
		'\t\t\t"path": "."',
		'\t\t},',
		'\t\t{',
		'\t\t\t"name": "Plugin: DreamDynamicWorld",',
		'\t\t\t"path": "../Plugins/DreamDynamicWorld/DFX"',
		'\t\t},',
		'\t\t{',
		'\t\t\t"name": "Plugin: DreamFX",',
		'\t\t\t"path": "../Plugins/DreamFX/DFX"',
		'\t\t}',
		'\t],',
		'\t"settings":',
		'\t{',
		'\t\t"files.associations": { "*.dfs": "dreamfxlang" }',
		'\t}',
		'}',
	].join('\r\n');
	const migrated = path.join(P, 'Plugins', 'DreamFX', 'DreamSource', 'FX');
	const rewritten = rewriteWorkspaceFile(original, path.join(P, 'DFX'), path.join(P, 'DreamSource', 'FX'),
		(pluginDir) => (pluginDir === path.join(P, 'Plugins', 'DreamFX') ? migrated : undefined));

	const expected = original
		.replace('"../Plugins/DreamDynamicWorld/DFX"', '"../../Plugins/DreamDynamicWorld/DFX"')
		.replace('"../Plugins/DreamFX/DFX"', '"../../Plugins/DreamFX/DreamSource/FX"');
	assert.equal(rewritten, expected);
});

test('a workspace file that is not one, or needs nothing, comes back unchanged', () => {
	const from = path.join(P, 'DFX');
	const to = path.join(P, 'DreamSource', 'FX');
	assert.equal(rewriteWorkspaceFile('not json {', from, to), 'not json {');
	const local = '{ "folders": [ { "path": "." }, { "path": "Effects" }, { "path": "C:/Abs" } ] }';
	assert.equal(rewriteWorkspaceFile(local, from, to), local);
});
