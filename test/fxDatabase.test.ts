/**
 * The fx.db and .dreamfx/index.db readers against real databases, built here with node:sqlite the way
 * spec 13.3 and 13.4 say the DreamFX plugin writes them (WAL, meta, one row per diagnostic or module).
 * And the server's index cache on top of them: which file wins, the fallbacks, and that an unchanged
 * revision is not re-read. Skipped on a Node without node:sqlite -- the case the extension falls back
 * to JSON for.
 *
 * Opt-in against a real project: DREAMFX_PROJECT_DIR=<project> loads its legacy files read-only and
 * checks that a database made from them reads back as the same objects.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import {
	diagnosticsEnvelopeFromRows,
	isSqliteAvailable,
	loadSqlite,
	quarantineFromRows,
	readDiagnosticsDatabase,
	readIndexDatabase,
	readIndexRevision,
	schemaIndexFromRows,
} from '../src/core/fxDatabase';
import { currentDiagnosticsVersion, envelopeDiagnostics, readEditorDiagnostics, stillCurrent } from '../src/core/editorDiagnostics';
import { nodeFs, resolveProjectLayout } from '../src/core/dreamSource';
import { IndexStateParams } from '../src/lspProtocol';
import { SchemaIndexCache } from '../src/server/schemaIndex';
import { SourceLayouts } from '../src/server/workspace';

const skip = isSqliteAvailable() ? false : 'this Node has no node:sqlite';
const REAL_PROJECT = process.env.DREAMFX_PROJECT_DIR;

type Run = (sql: string, ...params: unknown[]) => void;

function tempDir(t: { after: (fn: () => void) => void }, prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return root;
}

function openWritable(file: string, schema: string): { run: Run; close: () => void } {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const database = new (loadSqlite()!).DatabaseSync(file);
	database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');
	database.exec(schema);
	return {
		run: (sql, ...params) => void database.prepare(sql).run(...params),
		close: () => database.close(),
	};
}

const FX_SCHEMA = `
	CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS diagnostics(seq INTEGER PRIMARY KEY, file TEXT NOT NULL, json TEXT NOT NULL);`;

const INDEX_SCHEMA = `
	CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS modules(ord INTEGER PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL);
	CREATE INDEX IF NOT EXISTS modules_name ON modules(name);
	CREATE TABLE IF NOT EXISTS probe_journal(id INTEGER PRIMARY KEY CHECK (id = 1), package TEXT NOT NULL, started_utc TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS quarantine(package TEXT PRIMARY KEY, quarantined_utc TEXT NOT NULL);`;

function setMeta(run: Run, entries: Record<string, string>): void {
	for (const [key, value] of Object.entries(entries)) {
		run('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', key, value);
	}
}

/** fx.db as the plugin writes it from a diagnostics.json envelope. */
function writeFxDatabase(file: string, envelope: { generatedUtc: string; diagnostics: { file: string }[] },
	meta: Record<string, string> = {}): void {
	const database = openWritable(file, FX_SCHEMA);
	setMeta(database.run, { schema: '1', producer: 'DreamFX@test', revision: '1', diagnostics_revision: '1',
		diagnostics_updated_utc: envelope.generatedUtc, ...meta });
	database.run('DELETE FROM diagnostics');
	envelope.diagnostics.forEach((entry, seq) =>
		database.run('INSERT INTO diagnostics(seq, file, json) VALUES (?, ?, ?)', seq, entry.file, JSON.stringify(entry)));
	database.close();
}

/** index.db as the plugin writes it from a .dfx-index.json object. */
function writeIndexDatabase(file: string, index: Record<string, unknown>, quarantine: string[] = [],
	meta: Record<string, string> = {}): void {
	const database = openWritable(file, INDEX_SCHEMA);
	const header: Record<string, string> = { schema: '1', producer: 'DreamFX@test', revision: '1', modules_revision: '1' };
	header.version = String(index.version);
	if (index.generatedUtc !== undefined) header.generated_utc = String(index.generatedUtc);
	if (index.project !== undefined) header.project = String(index.project);
	if (index.inputsProbed !== undefined) header.inputs_probed = index.inputsProbed ? 'true' : 'false';
	if (index.engine !== undefined) header.engine = String(index.engine);
	if (index.plugins !== undefined) header.plugins = JSON.stringify(index.plugins);
	if (index.searchPaths !== undefined) header.search_paths = JSON.stringify(index.searchPaths);
	setMeta(database.run, { ...header, ...meta });
	database.run('DELETE FROM modules');
	((index.modules ?? []) as { path: string; name: string; kind: string }[]).forEach((module, ord) =>
		database.run('INSERT INTO modules(ord, path, name, kind, json) VALUES (?, ?, ?, ?, ?)',
			ord, module.path, module.name, module.kind, JSON.stringify(module)));
	for (const entry of quarantine) {
		database.run('INSERT INTO quarantine(package, quarantined_utc) VALUES (?, ?)', entry, '2026-11-26T00:00:00Z');
	}
	database.close();
}

const SAMPLE_INDEX = {
	version: 1,
	generatedUtc: '2026-11-26T10:00:00.000Z',
	project: 'Game',
	inputsProbed: false,
	engine: 'F:/UE/Engine/',
	plugins: ['Niagara', 'NiagaraFluids'],
	searchPaths: ['/Niagara/Modules'],
	modules: [
		{ name: 'GravityForce', path: '/Niagara/Modules/Update/Forces/GravityForce', kind: 'module', stacks: ['ParticleUpdate'] },
		{ name: 'UniformRangedFloat', path: '/Niagara/DynamicInputs/UniformRangedFloat', kind: 'dynamicInput', stacks: [] },
	],
};

const SAMPLE_ENVELOPE = {
	protocol: 1,
	generatedUtc: '2026-11-26T10:00:00.000Z',
	diagnostics: [
		{ file: path.resolve('/P/DreamSource/FX/NS_A.dfs'), line: 3, column: 5, severity: 'error', code: 'DFX3003', message: 'no input' },
		{ file: path.resolve('/P/DreamSource/FX/NS_A.dfs'), line: 9, column: 1, severity: 'info', code: 'DFX5004', message: 'default material' },
	],
};

// ---- the pure reassembly -------------------------------------------------------------------------

test('rows go back into the envelope in seq order, and a bad row costs only itself', () => {
	const meta = new Map([['diagnostics_updated_utc', '2026-11-26T00:00:00Z']]);
	const envelope = diagnosticsEnvelopeFromRows(meta, [
		{ seq: 1, json: '{"code":"B"}' }, { seq: 0, json: '{"code":"A"}' }, { seq: 2, json: 'not json' },
	]);
	assert.deepEqual(envelope, { protocol: 1, generatedUtc: '2026-11-26T00:00:00Z', diagnostics: [{ code: 'A' }, { code: 'B' }] });
});

test('the index header comes back in the spec\'s key order, with only the keys the writer stored', () => {
	const meta = new Map([['version', '1'], ['generated_utc', 'T'], ['engine', 'E'], ['inputs_probed', 'true'],
		['search_paths', '["/a"]'], ['project', 'P'], ['plugins', '["x"]']]);
	const index = schemaIndexFromRows(meta, [{ ord: 1, json: '{"name":"B"}' }, { ord: 0, json: '{"name":"A"}' }]);
	assert.deepEqual(Object.keys(index), ['version', 'generatedUtc', 'project', 'inputsProbed', 'engine', 'plugins', 'searchPaths', 'modules']);
	assert.deepEqual(index.modules, [{ name: 'A' }, { name: 'B' }]);
	assert.equal(index.inputsProbed, true);

	const sparse = schemaIndexFromRows(new Map([['version', '1'], ['generated_utc', 'T']]), []);
	assert.deepEqual(sparse, { version: 1, generatedUtc: 'T', modules: [] });
	assert.deepEqual(quarantineFromRows([{ package: '/b' }, { package: '/a' }]), ['/a', '/b']);
});

// ---- fx.db -----------------------------------------------------------------------------------------

test('fx.db reads back as the diagnostics.json it replaces', { skip }, (t) => {
	const file = path.join(tempDir(t, 'dfx-fxdb-'), 'fx.db');
	writeFxDatabase(file, SAMPLE_ENVELOPE);
	const read = readDiagnosticsDatabase(file);
	assert.equal(read.kind, 'ok');
	assert.deepEqual(read.kind === 'ok' && read.value, SAMPLE_ENVELOPE);
});

test('an fx.db of another schema is refused, not half-read', { skip }, (t) => {
	const file = path.join(tempDir(t, 'dfx-fxdb-'), 'fx.db');
	writeFxDatabase(file, SAMPLE_ENVELOPE, { schema: '2' });
	assert.deepEqual(readDiagnosticsDatabase(file), { kind: 'unsupported', schema: '2' });
});

test('a missing or foreign file is an answer of nothing, not a throw', { skip }, (t) => {
	const directory = tempDir(t, 'dfx-fxdb-');
	assert.deepEqual(readDiagnosticsDatabase(path.join(directory, 'absent.db')), { kind: 'absent' });
	const foreign = path.join(directory, 'foreign.db');
	fs.writeFileSync(foreign, 'not a database at all');
	assert.deepEqual(readDiagnosticsDatabase(foreign), { kind: 'absent' });
	assert.deepEqual(readIndexDatabase(foreign), { kind: 'absent' });
});

test('the editor\'s diagnostics come from fx.db, else the legacy diagnostics.json', { skip }, (t) => {
	const project = tempDir(t, 'dfx-editor-diag-');
	assert.equal(readEditorDiagnostics(project).kind, 'none');

	const legacy = path.join(project, 'Saved', 'DreamFX', 'Bridge', 'diagnostics.json');
	fs.mkdirSync(path.dirname(legacy), { recursive: true });
	fs.writeFileSync(legacy, JSON.stringify({ ...SAMPLE_ENVELOPE, generatedUtc: 'old' }));
	const fromJson = readEditorDiagnostics(project);
	assert.ok(fromJson.kind === 'ok' && fromJson.from === 'json' && fromJson.envelope.generatedUtc === 'old');
	assert.equal(currentDiagnosticsVersion(project), fromJson.version);

	writeFxDatabase(path.join(project, 'Intermediate', 'DreamSource', 'fx.db'), SAMPLE_ENVELOPE);
	const fromDb = readEditorDiagnostics(project);
	assert.ok(fromDb.kind === 'ok' && fromDb.from === 'database');
	assert.equal(fromDb.envelope.generatedUtc, SAMPLE_ENVELOPE.generatedUtc);
	assert.equal(currentDiagnosticsVersion(project), fromDb.version, 'the cheap version matches the full read');
	assert.deepEqual(envelopeDiagnostics(fromDb.envelope).map((entry) => entry.code), ['DFX3003', 'DFX5004']);

	writeFxDatabase(path.join(project, 'Intermediate', 'DreamSource', 'fx.db'), SAMPLE_ENVELOPE, { schema: '9' });
	const refused = readEditorDiagnostics(project);
	assert.equal(refused.kind, 'unsupported', 'a database of an unknown schema is not replaced by the older JSON');
	assert.match(refused.kind === 'unsupported' ? refused.message : '', /schema 9.*Update/);
});

test('an envelope entry that cannot be placed is dropped', () => {
	const kept = envelopeDiagnostics({ protocol: 1, generatedUtc: '', diagnostics: [
		{ file: 'relative.dfs', line: 1 }, null, 'text', { file: path.resolve('/a.dfs'), severity: 'bogus' },
	] });
	assert.deepEqual(kept, [{ file: path.resolve('/a.dfs'), line: 1, column: 1, severity: 'info', code: '', message: '' }]);
});

test('a record keeps only the files not written since it was made', () => {
	const entry = (file: string, line: number) => ({ file, line, column: 1, severity: 'error' as const, code: 'DFX3003', message: 'm' });
	const made = '2026-11-26T06:00:00.000Z';
	const at = Date.parse(made);
	const modified = new Map<string, number | undefined>([
		['/untouched.dfs', at - 60_000], ['/edited.dfs', at + 1], ['/same-instant.dfs', at], ['/gone.dfs', undefined],
	]);
	const record = [entry('/untouched.dfs', 1), entry('/edited.dfs', 2), entry('/untouched.dfs', 3),
		entry('/same-instant.dfs', 4), entry('/gone.dfs', 5)];
	const kept = stillCurrent(record, made, (file) => modified.get(file));
	assert.deepEqual(kept.map((diagnostic) => `${diagnostic.file}:${diagnostic.line}`),
		['/untouched.dfs:1', '/untouched.dfs:3', '/same-instant.dfs:4']);
	// A record that cannot say when it was made vouches for nothing.
	assert.deepEqual(stillCurrent(record, '', () => 0), []);
});

// ---- index.db ---------------------------------------------------------------------------------------

test('index.db reads back as the .dfx-index.json it replaces, with its quarantine', { skip }, (t) => {
	const file = path.join(tempDir(t, 'dfx-index-'), '.dreamfx', 'index.db');
	writeIndexDatabase(file, SAMPLE_INDEX, ['/Niagara/Modules/Masks/ConeMask', '/A/First']);
	const read = readIndexDatabase(file);
	assert.equal(read.kind, 'ok');
	if (read.kind === 'ok') {
		assert.deepEqual(read.value.index, SAMPLE_INDEX);
		assert.deepEqual(Object.keys(read.value.index), Object.keys(SAMPLE_INDEX));
		assert.deepEqual(read.value.quarantine, ['/A/First', '/Niagara/Modules/Masks/ConeMask']);
		assert.equal(read.revision, readIndexRevision(file));
	}
});

test('an index.db without modules is absent, so the JSON is read instead', { skip }, (t) => {
	const file = path.join(tempDir(t, 'dfx-index-'), '.dreamfx', 'index.db');
	writeIndexDatabase(file, { ...SAMPLE_INDEX, modules: [] }, ['/Q']);
	assert.deepEqual(readIndexDatabase(file), { kind: 'absent' });
});

// ---- the server's cache over both -----------------------------------------------------------------

function project(t: { after: (fn: () => void) => void }, sourceDir: string): string {
	const root = tempDir(t, 'dfx-cache-');
	fs.writeFileSync(path.join(root, 'Game.uproject'), '{}');
	fs.mkdirSync(path.join(root, ...sourceDir.split('/')), { recursive: true });
	return root;
}

function cache(): { cache: SchemaIndexCache; logs: string[]; warnings: string[]; states: IndexStateParams[] } {
	const logs: string[] = [];
	const warnings: string[] = [];
	const states: IndexStateParams[] = [];
	return {
		cache: new SchemaIndexCache(new SourceLayouts(), (message) => logs.push(message), (state) => states.push(state),
			(message) => warnings.push(message)),
		logs, warnings, states,
	};
}

test('a legacy project is answered from DFX/.dfx-index.json', { skip }, (t) => {
	const root = project(t, 'DFX');
	fs.writeFileSync(path.join(root, 'DFX', '.dfx-index.json'), JSON.stringify(SAMPLE_INDEX));
	const { cache: indexes } = cache();
	const file = path.join(root, 'DFX', 'NS_A.dfs');
	assert.equal(indexes.indexFor(file)?.modules.length, 2);
	assert.equal(indexes.describe(file).source, 'json');
	assert.deepEqual(indexes.destinationFor(file), { expected: path.join(root, 'DFX', '.dreamfx', 'index.db') },
		'no -Out: the plugin writes its own default');
});

test('index.db wins over the JSON beside it, and an unchanged revision is not re-read', { skip }, (t) => {
	const root = project(t, 'DreamSource/FX');
	const sourceDir = path.join(root, 'DreamSource', 'FX');
	fs.writeFileSync(path.join(sourceDir, '.dfx-index.json'), JSON.stringify({ ...SAMPLE_INDEX, modules: [SAMPLE_INDEX.modules[0]] }));
	const databaseFile = path.join(sourceDir, '.dreamfx', 'index.db');
	writeIndexDatabase(databaseFile, SAMPLE_INDEX);

	const { cache: indexes, logs } = cache();
	const file = path.join(sourceDir, 'Systems', 'NS_A.dfs');
	assert.equal(indexes.indexFor(file)?.modules.length, 2);
	assert.equal(indexes.describe(file).source, 'database');
	const loads = () => logs.filter((line) => line.includes('modules from')).length;
	assert.equal(loads(), 1);

	// A write that does not move modules_revision (a probe journal entry, say).
	const database = openWritable(databaseFile, INDEX_SCHEMA);
	setMeta(database.run, { revision: '2' });
	database.run('INSERT INTO probe_journal(id, package, started_utc) VALUES (1, ?, ?)', '/X', 'now');
	database.close();
	indexes.refresh();
	assert.equal(indexes.indexFor(file)?.modules.length, 2);
	assert.equal(loads(), 1, 'same modules_revision: no re-read');

	// A new index run.
	writeIndexDatabase(databaseFile, { ...SAMPLE_INDEX, modules: [SAMPLE_INDEX.modules[1]] }, [], { modules_revision: '2', revision: '3' });
	indexes.refresh();
	assert.equal(indexes.indexFor(file)?.modules.length, 1);
	assert.equal(loads(), 2);
});

test('an index.db with no modules yet falls back to the JSON; another schema is refused and said', { skip }, (t) => {
	const root = project(t, 'DreamSource/FX');
	const sourceDir = path.join(root, 'DreamSource', 'FX');
	fs.writeFileSync(path.join(sourceDir, '.dfx-index.json'), JSON.stringify(SAMPLE_INDEX));
	const databaseFile = path.join(sourceDir, '.dreamfx', 'index.db');
	writeIndexDatabase(databaseFile, { ...SAMPLE_INDEX, modules: [] });

	const { cache: indexes, warnings } = cache();
	const file = path.join(sourceDir, 'NS_A.dfs');
	assert.equal(indexes.describe(file).source, 'json');

	writeIndexDatabase(databaseFile, SAMPLE_INDEX, [], { schema: '2' });
	indexes.refresh();
	const state = indexes.describe(file);
	assert.equal(state.loaded, undefined);
	assert.match(state.problem ?? '', /schema 2.*Update/);
	assert.equal(warnings.length, 1);
});

test('a plugin\'s sources are answered from the project\'s index unless the plugin has its own', { skip }, (t) => {
	const root = project(t, 'DreamSource/FX');
	writeIndexDatabase(path.join(root, 'DreamSource', 'FX', '.dreamfx', 'index.db'), SAMPLE_INDEX);
	fs.mkdirSync(path.join(root, 'Plugins', 'Fx', 'DFX'), { recursive: true });
	fs.writeFileSync(path.join(root, 'Plugins', 'Fx', 'Fx.uplugin'), '{}');
	fs.mkdirSync(path.join(root, 'Plugins', 'Own', 'DreamSource', 'FX'), { recursive: true });
	fs.writeFileSync(path.join(root, 'Plugins', 'Own', 'Own.uplugin'), '{}');
	const ownJson = path.join(root, 'Plugins', 'Own', 'DreamSource', 'FX', '.dfx-index.json');
	fs.writeFileSync(ownJson, JSON.stringify({ ...SAMPLE_INDEX, modules: [SAMPLE_INDEX.modules[0]] }));

	const { cache: indexes } = cache();
	indexes.setWorkspaceFolders([path.join(root, 'Plugins', 'Fx', 'DFX')]);
	assert.equal(indexes.indexFor(path.join(root, 'Plugins', 'Fx', 'DFX', 'a.dfs'))?.modules.length, 2);
	const own = path.join(root, 'Plugins', 'Own', 'DreamSource', 'FX', 'b.dfs');
	assert.equal(indexes.indexFor(own)?.modules.length, 1);
	assert.deepEqual(indexes.destinationFor(own), { out: ownJson, expected: ownJson });
	assert.equal(indexes.indexFor(undefined)?.modules.length, 2, 'no document: the workspace project');
});

// ---- the real project, read-only --------------------------------------------------------------------

test('the real project\'s legacy files survive a trip through the databases', { skip: skip || (REAL_PROJECT ? false : 'DREAMFX_PROJECT_DIR is not set') }, (t) => {
	const layout = resolveProjectLayout(REAL_PROJECT!, nodeFs, path.join);
	console.log(`  ${REAL_PROJECT}: FX root ${layout.project.activeDir ?? '(none)'} [${layout.project.state}], `
		+ `${layout.plugins.length} plugin root(s): ${layout.plugins.map((plugin) => `${plugin.plugin}${plugin.legacy ? ' (DFX)' : ''}`).join(', ')}`);
	const sourceDir = layout.project.directory;
	const scratch = tempDir(t, 'dfx-real-');

	const indexJson = path.join(sourceDir, '.dfx-index.json');
	if (fs.existsSync(indexJson)) {
		const original = JSON.parse(fs.readFileSync(indexJson, 'utf8')) as Record<string, unknown>;
		const quarantineFile = `${indexJson}.quarantine`;
		const quarantine = fs.existsSync(quarantineFile)
			? fs.readFileSync(quarantineFile, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
			: [];
		const databaseFile = path.join(scratch, 'index.db');
		writeIndexDatabase(databaseFile, original, quarantine);
		const read = readIndexDatabase(databaseFile);
		assert.ok(read.kind === 'ok');
		assert.deepEqual(read.value.index, original);
		assert.deepEqual(read.value.quarantine, [...quarantine].sort());
		console.log(`  index: ${read.value.moduleCount} modules round-tripped, quarantine ${JSON.stringify(read.value.quarantine)}`);

		// And through the server's cache, on the project as it is.
		const { cache: indexes } = cache();
		const state = indexes.describe(path.join(sourceDir, 'any.dfs'));
		assert.equal(state.loaded?.moduleCount, (original.modules as unknown[]).length);
		console.log(`  server: ${state.loaded?.moduleCount} modules from ${state.filePath} (${state.source})`);
	}

	const editor = readEditorDiagnostics(REAL_PROJECT!);
	if (editor.kind === 'ok') {
		const databaseFile = path.join(scratch, 'fx.db');
		writeFxDatabase(databaseFile, editor.envelope as never);
		const read = readDiagnosticsDatabase(databaseFile);
		assert.ok(read.kind === 'ok');
		assert.deepEqual(read.value, editor.envelope);
		console.log(`  diagnostics: ${editor.envelope.diagnostics.length} from ${editor.from}, round-tripped`);
	}
});
