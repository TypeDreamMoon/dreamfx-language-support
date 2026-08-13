/**
 * Where every DFXnnnn from a run ends up, whichever transport carried it.
 *
 * Its own collection, separate from the lexical pass and from the task matcher: sharing an owner
 * would let whichever finished last wipe the others.
 *
 * The reason this is a class rather than a couple of calls is the clearing. A run reports against
 * more than one file -- a `.dfs` that pulls in a broken `.dfe` fails at the `.dfe`'s position -- so
 * "clear what this run last said" means remembering the whole set, not just the file that was asked
 * about. Getting that wrong leaves a fixed error on screen forever, which is worse than never having
 * reported it.
 */

import * as path from 'path';
import * as vscode from 'vscode';

import { BridgeDiagnostic } from '../core';

export class ProblemSink implements vscode.Disposable {
	private readonly collection = vscode.languages.createDiagnosticCollection('dreamfxlang-dfx');
	/** Which files each root file's last run reported. */
	private readonly reported = new Map<string, string[]>();

	dispose(): void {
		this.collection.dispose();
	}

	forget(uri: vscode.Uri): void {
		this.collection.delete(uri);
	}

	/**
	 * Replaces everything the previous run of `rootFile` reported with this run's findings.
	 *
	 * @param rootFile the file the run was asked about -- the key the previous set is remembered under.
	 * @param source what to show in the Problems "source" column, so a bridge result and a CLI result
	 *               are distinguishable when they disagree.
	 * @returns how many diagnostics were published.
	 */
	publish(rootFile: string, diagnostics: readonly BridgeDiagnostic[], source: string): number {
		const found = new Map<string, vscode.Diagnostic[]>();

		for (const diagnostic of diagnostics) {
			// A diagnostic's path is the one the compiler was given. It is normally absolute, but a
			// referenced file reports its own path, so it is resolved against the file being run.
			const resolved = path.isAbsolute(diagnostic.file)
				? diagnostic.file
				: path.resolve(path.dirname(rootFile), diagnostic.file);

			const entry = new vscode.Diagnostic(
				new vscode.Range(
					Math.max(0, diagnostic.line - 1), Math.max(0, diagnostic.column - 1),
					Math.max(0, diagnostic.line - 1), Number.MAX_SAFE_INTEGER),
				diagnostic.message,
				diagnostic.severity === 'error' ? vscode.DiagnosticSeverity.Error
					: diagnostic.severity === 'warning' ? vscode.DiagnosticSeverity.Warning
						: vscode.DiagnosticSeverity.Information);
			entry.source = source;
			entry.code = diagnostic.code;

			const bucket = found.get(resolved);
			if (bucket) {
				bucket.push(entry);
			} else {
				found.set(resolved, [entry]);
			}
		}

		for (const previous of this.reported.get(rootFile) ?? []) {
			this.collection.delete(vscode.Uri.file(previous));
		}
		for (const [target, entries] of found) {
			this.collection.set(vscode.Uri.file(target), entries);
		}
		this.reported.set(rootFile, [...found.keys()]);

		return diagnostics.length;
	}
}
