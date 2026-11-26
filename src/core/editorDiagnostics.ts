/**
 * The editor's record of its last bridge request's diagnostics, wherever the plugin keeps it:
 *
 *   Intermediate/DreamSource/fx.db           diagnostics(seq, file, json) + meta   (spec 13.3)
 *   Saved/DreamFX/Bridge/diagnostics.json    the same envelope, from a plugin before DreamSource
 *
 * The database is read when it is there; the JSON only when it is not (spec 13.5). A database of a
 * schema this extension does not know is not read at all -- and not replaced by the JSON either, which
 * an updated plugin no longer writes and so would only be older.
 *
 * No `vscode` here, so the tests run it against fixture databases; features/editorDiagnostics.ts is
 * the window around it.
 */

import * as fs from 'fs';
import * as path from 'path';

import { BridgeDiagnostic } from './bridgeProtocol';
import { fxDatabasePath, legacyDiagnosticsPath } from './dreamSource';
import {
	DiagnosticsEnvelope,
	SUPPORTED_FX_SCHEMA,
	databaseFileTag,
	isSqliteAvailable,
	partRevision,
	readDiagnosticsDatabase,
	readMeta,
} from './fxDatabase';

export type EnvelopeRead =
	| { kind: 'ok'; envelope: DiagnosticsEnvelope; version: string; from: 'database' | 'json' }
	| { kind: 'unsupported'; message: string; version: string }
	| { kind: 'none'; version: string };

/**
 * The project's last diagnostics envelope: from fx.db when it exists (and can be read here), else
 * from the legacy diagnostics.json. Exported for the tests, which run it against fixture databases.
 */
export function readEditorDiagnostics(projectDir: string): EnvelopeRead {
	const database = fxDatabasePath(projectDir, path.join);
	if (databaseFileTag(database) !== undefined && isSqliteAvailable()) {
		const read = readDiagnosticsDatabase(database);
		if (read.kind === 'ok') {
			return { kind: 'ok', envelope: read.value, version: `db:${read.revision}`, from: 'database' };
		}
		if (read.kind === 'unsupported') {
			return {
				kind: 'unsupported',
				version: `db:unsupported:${read.schema ?? ''}`,
				message: `${database} has schema ${read.schema ?? '(none)'}, and this extension reads schema `
					+ `${SUPPORTED_FX_SCHEMA}. Update the DreamFXLang extension or the DreamFX plugin so the two match; `
					+ 'until then the editor\'s diagnostics are not shown here.',
			};
		}
		// Not readable as a database yet (mid-creation): fall through to whatever else there is.
	}

	const legacy = legacyDiagnosticsPath(projectDir, path.join);
	let text: string;
	let version: string;
	try {
		const stat = fs.statSync(legacy);
		version = `json:${stat.mtimeMs}:${stat.size}`;
		text = fs.readFileSync(legacy, 'utf8');
	} catch {
		return { kind: 'none', version: 'none' };
	}
	const envelope = parseEnvelope(text);
	return envelope ? { kind: 'ok', envelope, version, from: 'json' } : { kind: 'none', version };
}

/** The version `readEditorDiagnostics` would report, without reading the rows. */
export function currentDiagnosticsVersion(projectDir: string): string {
	const database = fxDatabasePath(projectDir, path.join);
	if (databaseFileTag(database) !== undefined && isSqliteAvailable()) {
		const meta = readMeta(database);
		if (meta) {
			return meta.get('schema') === SUPPORTED_FX_SCHEMA
				? `db:${partRevision(meta, 'diagnostics')}`
				: `db:unsupported:${meta.get('schema') ?? ''}`;
		}
	}
	try {
		const stat = fs.statSync(legacyDiagnosticsPath(projectDir, path.join));
		return `json:${stat.mtimeMs}:${stat.size}`;
	} catch {
		return 'none';
	}
}

export function parseEnvelope(text: string): DiagnosticsEnvelope | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text.replace(/^﻿/, ''));
	} catch {
		return undefined;
	}
	const candidate = value as Partial<DiagnosticsEnvelope> | null;
	if (!candidate || typeof candidate !== 'object' || !Array.isArray(candidate.diagnostics)) {
		return undefined;
	}
	return {
		protocol: typeof candidate.protocol === 'number' ? candidate.protocol : 0,
		generatedUtc: typeof candidate.generatedUtc === 'string' ? candidate.generatedUtc : '',
		diagnostics: candidate.diagnostics,
	};
}

/**
 * The entries of a record that still describe their file: the file exists and has not been written
 * since the record was made. A record outlives editor restarts, so on a window's first look it can be
 * weeks old; an entry for a file edited since then points at lines that may no longer hold what it
 * says, and is dropped. A record with no readable time cannot vouch for anything, so all of it goes.
 *
 * @param modifiedMs a file's modification time in ms since the epoch, or undefined if it is gone.
 */
export function stillCurrent(
	diagnostics: readonly BridgeDiagnostic[],
	generatedUtc: string,
	modifiedMs: (file: string) => number | undefined,
): BridgeDiagnostic[] {
	const generated = Date.parse(generatedUtc);
	if (Number.isNaN(generated)) {
		return [];
	}
	const current = new Map<string, boolean>();
	return diagnostics.filter((diagnostic) => {
		let keep = current.get(diagnostic.file);
		if (keep === undefined) {
			const modified = modifiedMs(diagnostic.file);
			keep = modified !== undefined && modified <= generated;
			current.set(diagnostic.file, keep);
		}
		return keep;
	});
}

/** A file's modification time for `stillCurrent`, or undefined when it cannot be read. */
export function fileModifiedMs(file: string): number | undefined {
	try {
		return fs.statSync(file).mtimeMs;
	} catch {
		return undefined;
	}
}

/** The entries of an envelope that are diagnostics this side can place; anything else is dropped. */
export function envelopeDiagnostics(envelope: DiagnosticsEnvelope): BridgeDiagnostic[] {
	const out: BridgeDiagnostic[] = [];
	for (const entry of envelope.diagnostics) {
		const candidate = entry as Partial<BridgeDiagnostic> | null;
		if (!candidate || typeof candidate.file !== 'string' || !candidate.file || !path.isAbsolute(candidate.file)) {
			continue;
		}
		const severity = candidate.severity === 'error' || candidate.severity === 'warning' ? candidate.severity : 'info';
		out.push({
			file: candidate.file,
			line: typeof candidate.line === 'number' ? candidate.line : 1,
			column: typeof candidate.column === 'number' ? candidate.column : 1,
			severity,
			code: typeof candidate.code === 'string' ? candidate.code : '',
			message: typeof candidate.message === 'string' ? candidate.message : '',
		});
	}
	return out;
}

