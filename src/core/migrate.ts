/**
 * Moving a project's legacy `DFX/` to its DreamSource directory (spec 13.6), the disk half: refuses
 * what `planMigration` refuses, else moves the folder, re-aims its DreamFX.code-workspace and clears
 * the old bridge folder. No `vscode` here, so the tests run it against a real directory;
 * features/migration.ts is the window around it.
 *
 * What it deliberately does not do:
 *
 *  * change any source. `Name=` paths are relative to the source root, and `from "DFX/..."` keeps
 *    resolving in the plugin, so a move is only a move.
 *  * turn `.dfx-index.json` and its `.quarantine` into `.dreamfx/index.db`. The plugin imports them
 *    the next time it opens the index, and until then the readers fall back to the JSON, which
 *    moved with the folder.
 *  * touch `Saved/DreamFX/DynamicMesh`, `Pull/`, `BuildSafety/`, `WriteBack/` or the `.facts` files:
 *    baselines that cannot be rebuilt, or output meant for a person.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
	WORKSPACE_FILE_NAME,
	nodeFs,
	planMigration,
	resolvePluginSourceDirectory,
	resolveProjectSourceRoot,
	rewriteWorkspaceFile,
} from './dreamSource';

export type MigrationResult =
	| { ok: true; from: string; to: string; workspaceRewritten: boolean; message: string }
	| { ok: false; message: string };

/**
 * Moves `from` to `to`: a rename where it can (which takes a `.git` inside along unchanged), a copy
 * and delete across volumes.
 */
export function moveDirectory(from: string, to: string): void {
	fs.mkdirSync(path.dirname(to), { recursive: true });
	try {
		fs.renameSync(from, to);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
			throw error;
		}
		fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
		fs.rmSync(from, { recursive: true, force: true });
	}
}

/**
 * Re-aims the moved folder's DreamFX.code-workspace (its paths are relative to itself). Returns
 * whether it was rewritten; a file that is not there, or not JSON, is left as it is.
 */
export function rewriteMovedWorkspaceFile(from: string, to: string): boolean {
	const workspaceFile = path.join(to, WORKSPACE_FILE_NAME);
	let text: string;
	try {
		text = fs.readFileSync(workspaceFile, 'utf8');
	} catch {
		return false;
	}
	const rewritten = rewriteWorkspaceFile(text, from, to,
		(pluginDir) => resolvePluginSourceDirectory(pluginDir, nodeFs, path.join)?.directory);
	if (rewritten === text) {
		return false;
	}
	fs.writeFileSync(workspaceFile, rewritten, 'utf8');
	return true;
}

/**
 * The whole migration of one project.
 *
 * @param editorRunning whether an editor may have the project open, on either bridge. Asked by the
 *        caller because the answer needs a process check this module has no business making.
 */
export function migrateProject(projectDir: string, editorRunning: boolean): MigrationResult {
	const root = resolveProjectSourceRoot(projectDir, nodeFs, path.join);
	const plan = planMigration(root, editorRunning, path.join);
	if (!plan.ok) {
		return { ok: false, message: plan.reason };
	}
	try {
		moveDirectory(plan.from, plan.to);
	} catch (error) {
		return {
			ok: false,
			message: `could not move ${plan.from} to ${plan.to}: ${(error as Error).message}. `
				+ 'A file in it may be open in another program -- including this window, if the folder is open in it.',
		};
	}
	let workspaceRewritten = false;
	try {
		workspaceRewritten = rewriteMovedWorkspaceFile(plan.from, plan.to);
	} catch {
		// The editor regenerates it on "Open DreamFX Workspace".
	}
	for (const stale of plan.staleDirectories) {
		try {
			fs.rmSync(stale, { recursive: true, force: true });
		} catch {
			// Left behind is harmless: an updated plugin uses Intermediate/DreamSource/FX/Bridge only.
		}
	}
	return {
		ok: true,
		from: plan.from,
		to: plan.to,
		workspaceRewritten,
		message: `moved ${plan.from} to ${plan.to}${workspaceRewritten ? ` and re-aimed its ${WORKSPACE_FILE_NAME}` : ''}.`,
	};
}
