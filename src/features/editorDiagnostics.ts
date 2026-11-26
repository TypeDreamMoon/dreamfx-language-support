/**
 * What the editor's bridge last reported, mirrored into Problems.
 *
 * The bridge answers the request that asked, and this extension publishes that answer itself (verify
 * on save). But the editor also records the diagnostics of its most recent request -- whoever sent
 * it: this window, another one, dream-mcp, a script -- and that record is what this watches:
 *
 *   Intermediate/DreamSource/fx.db           diagnostics(seq, file, json) + meta   (spec 13.3)
 *   Saved/DreamFX/Bridge/diagnostics.json    the same envelope, from a plugin before DreamSource
 *
 * The database is read when it is there; the JSON only when it is not. A database of a schema this
 * extension does not know is not read at all, and said so.
 *
 * Three rules keep this from showing anything wrong:
 *
 *  - Only what still describes its file. The record survives editor restarts, so the one on disk when
 *    the window opens may be weeks old. It is published, but only for files not written since the
 *    record was made; a file edited since then may no longer have what the entry points at.
 *  - Newest result per file. The record replaces the previous record's set wholesale. A file it covers
 *    that verify-on-save also reports keeps verify's entries when the two agree (this window asked,
 *    so the record is the same answer again), and loses them when they differ (someone else compiled
 *    it since). When verify reports on a file later, this stands down for that file.
 *  - Its own collection, so neither side's clearing can wipe the other's.
 */

import * as path from 'path';
import * as vscode from 'vscode';

import {
	BridgeDiagnostic,
	currentDiagnosticsVersion,
	envelopeDiagnostics,
	fileModifiedMs,
	legacyDiagnosticsPath,
	readEditorDiagnostics,
	stillCurrent,
} from '../core';
import { DreamSourceHost } from './dreamSourceHost';
import { ProblemSink } from './problemSink';

const SOURCE = 'dfx (editor)';

export class EditorDiagnostics implements vscode.Disposable {
	/** Each project's record version when last read: `db:<revision>`, `json:<mtime:size>`, or `none`. */
	private readonly seen = new Map<string, string>();
	private readonly told = new Set<string>();
	private readonly own = new ProblemSink('dreamfxlang-editor');
	private readonly disposables: vscode.Disposable[] = [this.own];

	constructor(
		host: DreamSourceHost,
		private readonly verified: ProblemSink,
		private readonly output: vscode.OutputChannel,
	) {
		this.disposables.push(
			host.onDidChangeDiagnostics((projectDir) => this.update(projectDir)),
			verified.onDidPublish((files) => files.forEach((file) => this.own.forget(vscode.Uri.file(file)))),
		);
		for (const projectDir of host.workspaceProjects()) {
			this.update(projectDir);
		}
	}

	dispose(): void {
		this.disposables.forEach((disposable) => disposable.dispose());
	}

	private update(projectDir: string): void {
		if (this.seen.has(projectDir) && this.seen.get(projectDir) === currentDiagnosticsVersion(projectDir)) {
			// A checkpoint, a reader touching the file, or a write to another part of the database.
			return;
		}

		const read = readEditorDiagnostics(projectDir);
		this.seen.set(projectDir, read.version);
		const key = path.join(projectDir, '.dreamfx-editor-diagnostics');

		if (read.kind === 'unsupported') {
			this.tellOnce(read.version + projectDir, () => void vscode.window.showWarningMessage(`DreamFXLang: ${read.message}`));
			this.own.publish(key, [], SOURCE);
			return;
		}
		if (read.kind === 'none') {
			return;
		}
		if (read.from === 'json') {
			this.tellOnce(`legacy|${projectDir}`, () => this.output.appendLine(
				`DreamSource: reading the editor's diagnostics from ${legacyDiagnosticsPath(projectDir, path.join)}. `
				+ 'An updated DreamFX plugin writes them to Intermediate/DreamSource/fx.db instead.'));
		}

		const all = envelopeDiagnostics(read.envelope);
		const current = stillCurrent(all, read.envelope.generatedUtc, fileModifiedMs);
		const shown = this.withoutVerified(current);
		this.own.publish(key, shown, SOURCE);

		const skipped = all.length - current.length;
		this.output.appendLine(`editor diagnostics: ${shown.length} from the ${read.from === 'database' ? 'fx.db' : 'diagnostics.json'} `
			+ `record of ${read.envelope.generatedUtc || 'an unknown time'}`
			+ (skipped > 0 ? `; ${skipped} left out for files changed since` : '')
			+ (current.length > shown.length ? `; ${current.length - shown.length} already shown by verify` : ''));
	}

	/**
	 * Drops the files verify already shows exactly; for the rest the record is newer, so verify's
	 * entries for them are cleared.
	 */
	private withoutVerified(diagnostics: readonly BridgeDiagnostic[]): BridgeDiagnostic[] {
		const byFile = new Map<string, BridgeDiagnostic[]>();
		for (const diagnostic of diagnostics) {
			const bucket = byFile.get(diagnostic.file);
			if (bucket) {
				bucket.push(diagnostic);
			} else {
				byFile.set(diagnostic.file, [diagnostic]);
			}
		}
		const out: BridgeDiagnostic[] = [];
		for (const [file, entries] of byFile) {
			const verified = this.verified.entries(file);
			if (verified.length === 0) {
				out.push(...entries);
			} else if (!sameEntries(entries, verified)) {
				this.verified.forget(vscode.Uri.file(file));
				out.push(...entries);
			}
		}
		return out;
	}

	private tellOnce(key: string, tell: () => void): void {
		if (!this.told.has(key)) {
			this.told.add(key);
			tell();
		}
	}
}

function sameEntries(record: readonly BridgeDiagnostic[], shown: readonly vscode.Diagnostic[]): boolean {
	const describe = (line: number, column: number, code: string, message: string): string =>
		`${line}:${column}:${code}:${message}`;
	const left = record.map((entry) => describe(Math.max(0, entry.line - 1), Math.max(0, entry.column - 1), entry.code, entry.message)).sort();
	const right = shown.map((entry) => describe(entry.range.start.line, entry.range.start.character, String(entry.code ?? ''), entry.message)).sort();
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
