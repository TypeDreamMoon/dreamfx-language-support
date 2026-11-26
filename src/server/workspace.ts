/**
 * The things the server has to answer for itself now that there is no `vscode.workspace`: which
 * Unreal project a file belongs to, and where that project's FX sources are.
 *
 * Where the sources are is the DreamSource layout's question (core/dreamSource.ts), asked of the
 * project: its configured directory from `Config/DefaultDreamSource.ini`, its legacy `DFX/`, and each
 * plugin's root. A file is a DreamFX source when it sits under one of those -- never because some
 * folder in its path happens to be called `DFX` (spec 7). The client resolves with the same module,
 * so the two halves cannot disagree about it.
 *
 * Finding the project is a walk up to the nearest `.uproject`, which is the same walk `dfx.ps1` and the
 * bridge do. A workspace folder that is *above* a project (a folder of several projects, say) gets a
 * short walk down instead: deliberately shallow, skipping the directories that are always noise,
 * because an uncapped walk of an Unreal tree is a very expensive way to find nothing.
 */

import * as fs from 'fs';
import * as path from 'path';

import { URI } from 'vscode-uri';

import { ProjectLayout, findProjectRoot, nodeFs, resolveProjectLayout } from '../core';

/** How far below a workspace folder a `.uproject` is still worth looking for. */
const MAX_SCAN_DEPTH = 3;

/** Directories that never contain a project and are expensive to walk. */
const SKIPPED_DIRECTORIES = new Set([
	'node_modules', '.git', '.vs', '.vscode', '.idea',
	'Binaries', 'Intermediate', 'DerivedDataCache', 'Saved', 'Content', 'Plugins',
]);

/**
 * `file:` URIs to filesystem paths; anything else is not on disk and has no path.
 *
 * Parsed strictly, which is the whole reason this is a function rather than a `URI.parse` at each
 * call site: the lenient parse assumes `file:` when a string carries no scheme at all, so a
 * non-URI would come back as a plausible-looking absolute path instead of nothing.
 *
 * The drive letter comes back lower-cased, because that is what `vscode-uri` normalises to and what
 * the editor's own URIs carry. Every path in the server arrives through here or through a `path.join`
 * onto one that did, so they compare equal to each other -- which matters, because the index cache
 * is a `Map` keyed on a root path and two spellings of one root would be two entries.
 */
export function toFsPath(uri: string): string | undefined {
	try {
		const parsed = URI.parse(uri, /*strict=*/true);
		return parsed.scheme === 'file' ? parsed.fsPath : undefined;
	} catch {
		return undefined;
	}
}

export function toUri(fsPath: string): string {
	return URI.file(fsPath).toString();
}

/** Every directory holding a `.uproject` at or below each folder, nearest-first, up to `limit`. */
export function findProjectsBelow(folderPaths: readonly string[], limit: number): string[] {
	const found: string[] = [];
	const scan = (directory: string, depth: number): void => {
		if (depth > MAX_SCAN_DEPTH || found.length >= limit) {
			return;
		}
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(directory, { withFileTypes: true });
		} catch {
			// Unreadable directories are a fact of life on a project tree; they are not an error here.
			return;
		}
		if (entries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.uproject'))) {
			found.push(directory);
			return; // a project does not hold projects
		}
		for (const entry of entries) {
			if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) {
				scan(path.join(directory, entry.name), depth + 1);
			}
		}
	};
	for (const folder of folderPaths) {
		scan(folder, 0);
		if (found.length >= limit) {
			break;
		}
	}
	return found;
}

/**
 * Projects and their layouts, cached until told otherwise: the answers move only when the ini is
 * edited or a migration moves a folder, and both of those arrive as an `invalidate`.
 */
export class SourceLayouts {
	private readonly projectByDirectory = new Map<string, string | undefined>();
	private readonly layoutByProject = new Map<string, ProjectLayout>();
	private folderPaths: readonly string[] = [];
	private workspaceProjects?: string[];

	setWorkspaceFolders(folderPaths: readonly string[]): void {
		this.folderPaths = folderPaths;
		this.invalidate();
	}

	invalidate(): void {
		this.projectByDirectory.clear();
		this.layoutByProject.clear();
		this.workspaceProjects = undefined;
	}

	/** The project a file belongs to: the nearest `.uproject` above it. */
	projectFor(fsPath: string): string | undefined {
		const directory = path.dirname(fsPath);
		if (!this.projectByDirectory.has(directory)) {
			this.projectByDirectory.set(directory, findProjectRoot(directory, nodeFs, path.dirname));
		}
		return this.projectByDirectory.get(directory);
	}

	/**
	 * The projects of the workspace: each folder's own (walking up), else any a short walk down finds.
	 * The generated workspace lists the FX root and each plugin's as separate folders, which all walk
	 * up to one project.
	 */
	projects(): string[] {
		if (!this.workspaceProjects) {
			const found: string[] = [];
			const add = (project: string | undefined): void => {
				if (project && !found.includes(project)) {
					found.push(project);
				}
			};
			for (const folder of this.folderPaths) {
				add(findProjectRoot(folder, nodeFs, path.dirname));
			}
			if (found.length === 0) {
				findProjectsBelow(this.folderPaths, 8).forEach(add);
			}
			this.workspaceProjects = found;
		}
		return this.workspaceProjects;
	}

	layout(projectDir: string): ProjectLayout {
		let layout = this.layoutByProject.get(projectDir);
		if (!layout) {
			layout = resolveProjectLayout(projectDir, nodeFs, path.join);
			this.layoutByProject.set(projectDir, layout);
		}
		return layout;
	}
}
