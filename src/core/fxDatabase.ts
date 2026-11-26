/**
 * Reading the two databases the DreamFX plugin writes (spec 13.3 and 13.4), back into the shapes the
 * JSON files they replace had -- so nothing downstream of a reader knows which one it came from.
 *
 *   <Project>/Intermediate/DreamSource/fx.db   diagnostics(seq, file, json) + meta
 *                                              replaces Saved/DreamFX/Bridge/diagnostics.json
 *   <FX root>/.dreamfx/index.db                modules(ord, path, name, kind, json), quarantine + meta
 *                                              replaces .dfx-index.json and its .quarantine
 *
 * Through `node:sqlite`, which is real SQLite: a read sees what is still in the `-wal`, takes the
 * shared lock, and so never reads half of a commit. Read-only and one connection per read, as the
 * dreamgui pilot does: a handle held open would keep a Windows writer from ever replacing the file.
 * That also rules out `PRAGMA data_version` as the change signal -- it only means something across
 * reads on one connection -- so "did anything change" is `meta`'s revisions, checked behind a
 * stat of the file and its `-wal`, which is cheaper still.
 *
 * `node:sqlite` is required lazily and its absence is an answer, not an error: every reader says
 * "absent" and the callers read the old JSON the way they always did. No `vscode` here: the language
 * server reads the index with this, and the tests open real databases with it.
 */

import * as fs from 'fs';
import type * as Sqlite from 'node:sqlite';

/** The fx.db schema this extension reads; any other is refused and said so (spec 5.3). */
export const SUPPORTED_FX_SCHEMA = '1';
/** The index.db schema this extension reads. */
export const SUPPORTED_INDEX_SCHEMA = '1';

let loaded: typeof Sqlite | null | undefined;

/** The module, or undefined when this runtime has none. Asked once. */
export function loadSqlite(): typeof Sqlite | undefined {
	if (loaded === undefined) {
		try {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			loaded = require('node:sqlite') as typeof Sqlite;
		} catch {
			loaded = null;
		}
	}
	return loaded ?? undefined;
}

export function isSqliteAvailable(): boolean {
	return loadSqlite() !== undefined;
}

/** `read(db)` on a fresh read-only connection, or undefined when the file cannot be read as a database. */
export function withDatabase<T>(databasePath: string, read: (database: Sqlite.DatabaseSync) => T): T | undefined {
	const sqlite = loadSqlite();
	if (!sqlite || !databasePath) {
		return undefined;
	}
	let database: Sqlite.DatabaseSync | undefined;
	try {
		database = new sqlite.DatabaseSync(databasePath, { readOnly: true });
		try {
			// A write in flight holds the lock for a moment; wait it out rather than read nothing.
			database.exec('PRAGMA busy_timeout = 2000;');
		} catch {
			// Not fatal: the read below either gets through or throws into the catch.
		}
		return read(database);
	} catch {
		return undefined;
	} finally {
		try {
			database?.close();
		} catch {
			// Closing a connection that failed to open: nothing to release.
		}
	}
}

/**
 * The file's and its `-wal`'s size and time, or undefined when the database itself is not there.
 * Unchanged means unchanged without opening anything; changed only means "look at `meta`".
 */
export function databaseFileTag(databasePath: string): string | undefined {
	const tag = (target: string): string | undefined => {
		try {
			const stat = fs.statSync(target);
			return stat.isFile() ? `${stat.mtimeMs}:${stat.size}` : undefined;
		} catch {
			return undefined;
		}
	};
	const main = tag(databasePath);
	return main === undefined ? undefined : `${main}|${tag(`${databasePath}-wal`) ?? '-'}`;
}

export type Meta = ReadonlyMap<string, string>;

export function readMeta(databasePath: string): Meta | undefined {
	return withDatabase(databasePath, (database) => metaFrom(database));
}

function metaFrom(database: Sqlite.DatabaseSync): Map<string, string> {
	const rows = database.prepare('SELECT key, value FROM meta').all() as { key: unknown; value: unknown }[];
	return new Map(rows.map((row) => [String(row.key), String(row.value)]));
}

/**
 * The revision a reader of one part compares: the part's own when the writer keeps one, else the
 * database's. Together with the schema, so a schema change is a change. A probe recording its
 * progress moves `revision` and not `modules_revision`, and should not cost a 1 MB re-read.
 */
export function partRevision(meta: Meta, part: string): string {
	const own = meta.get(`${part}_revision`);
	return `${meta.get('schema') ?? ''}/${own !== undefined ? `${part}:${own}` : `all:${meta.get('revision') ?? ''}`}`;
}

/** What a reader found: the data, a schema it must not read, or nothing usable. */
export type DatabaseRead<T> =
	| { kind: 'ok'; value: T; revision: string }
	| { kind: 'unsupported'; schema: string | undefined }
	| { kind: 'absent' };

// ---- fx.db: the editor's last diagnostics -----------------------------------------------------

/** The envelope `Saved/DreamFX/Bridge/diagnostics.json` held. */
export interface DiagnosticsEnvelope {
	protocol: number;
	generatedUtc: string;
	diagnostics: unknown[];
}

/**
 * The `diagnostics` rows back into the envelope (spec 13.3): `{protocol: 1, generatedUtc:
 * meta.diagnostics_updated_utc, diagnostics: [json by seq]}`. A row whose JSON does not parse costs
 * that row, not the envelope.
 */
export function diagnosticsEnvelopeFromRows(meta: Meta, rows: readonly { seq: unknown; json: unknown }[]): DiagnosticsEnvelope {
	const ordered = [...rows].sort((a, b) => Number(a.seq) - Number(b.seq));
	const diagnostics: unknown[] = [];
	for (const row of ordered) {
		try {
			diagnostics.push(JSON.parse(String(row.json)));
		} catch {
			// One bad row is one lost diagnostic.
		}
	}
	return { protocol: 1, generatedUtc: meta.get('diagnostics_updated_utc') ?? '', diagnostics };
}

export function readDiagnosticsDatabase(databasePath: string): DatabaseRead<DiagnosticsEnvelope> {
	const result = withDatabase(databasePath, (database): DatabaseRead<DiagnosticsEnvelope> => {
		const meta = metaFrom(database);
		if (meta.get('schema') !== SUPPORTED_FX_SCHEMA) {
			return { kind: 'unsupported', schema: meta.get('schema') };
		}
		const rows = database.prepare('SELECT seq, json FROM diagnostics ORDER BY seq').all() as { seq: unknown; json: unknown }[];
		return { kind: 'ok', value: diagnosticsEnvelopeFromRows(meta, rows), revision: partRevision(meta, 'diagnostics') };
	});
	return result ?? { kind: 'absent' };
}

// ---- .dreamfx/index.db: the module index -------------------------------------------------------

/**
 * The header of `.dfx-index.json` as `meta` stores it (spec 13.4), back into the object, in the
 * order the spec gives: `{version, generatedUtc, project, inputsProbed, engine, plugins, searchPaths,
 * modules}`. A key the writer did not store is left out rather than invented, so an index imported
 * from a JSON file without `inputsProbed` reads back the way that file did.
 */
export function schemaIndexFromRows(meta: Meta, rows: readonly { ord: unknown; json: unknown }[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const version = meta.get('version');
	out.version = version !== undefined && Number.isFinite(Number(version)) ? Number(version) : version;
	if (meta.has('generated_utc')) {
		out.generatedUtc = meta.get('generated_utc');
	}
	if (meta.has('project')) {
		out.project = meta.get('project');
	}
	if (meta.has('inputs_probed')) {
		out.inputsProbed = meta.get('inputs_probed') === 'true';
	}
	if (meta.has('engine')) {
		out.engine = meta.get('engine');
	}
	for (const [key, name] of [['plugins', 'plugins'], ['search_paths', 'searchPaths']] as const) {
		const text = meta.get(key);
		if (text === undefined) {
			continue;
		}
		try {
			out[name] = JSON.parse(text);
		} catch {
			// A header field that does not parse is a field the index goes without.
		}
	}
	const modules: unknown[] = [];
	for (const row of [...rows].sort((a, b) => Number(a.ord) - Number(b.ord))) {
		try {
			modules.push(JSON.parse(String(row.json)));
		} catch {
			// As above: one unreadable module, not an unreadable index.
		}
	}
	out.modules = modules;
	return out;
}

/** The quarantine list: `quarantine.package`, sorted by name. */
export function quarantineFromRows(rows: readonly { package: unknown }[]): string[] {
	return rows.map((row) => String(row.package)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export interface IndexDatabaseContents {
	/** The object `.dfx-index.json` held. */
	index: Record<string, unknown>;
	quarantine: string[];
	moduleCount: number;
}

/**
 * The index, or `absent` when there is no database or it has no modules yet -- in which case the
 * reader falls back to `.dfx-index.json` (spec 13.5).
 */
export function readIndexDatabase(databasePath: string): DatabaseRead<IndexDatabaseContents> {
	const result = withDatabase(databasePath, (database): DatabaseRead<IndexDatabaseContents> => {
		const meta = metaFrom(database);
		if (meta.get('schema') !== SUPPORTED_INDEX_SCHEMA) {
			return { kind: 'unsupported', schema: meta.get('schema') };
		}
		const rows = database.prepare('SELECT ord, json FROM modules ORDER BY ord').all() as { ord: unknown; json: unknown }[];
		if (rows.length === 0) {
			return { kind: 'absent' };
		}
		let quarantine: string[] = [];
		try {
			quarantine = quarantineFromRows(database.prepare('SELECT package FROM quarantine').all() as { package: unknown }[]);
		} catch {
			// The list is informational; an index without it is still an index.
		}
		return {
			kind: 'ok',
			value: { index: schemaIndexFromRows(meta, rows), quarantine, moduleCount: rows.length },
			revision: partRevision(meta, 'modules'),
		};
	});
	return result ?? { kind: 'absent' };
}

/** Just the revision `readIndexDatabase` would report, without reading the modules. */
export function readIndexRevision(databasePath: string): string | undefined {
	const meta = readMeta(databasePath);
	return meta ? partRevision(meta, 'modules') : undefined;
}
