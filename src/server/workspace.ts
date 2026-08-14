/**
 * The three things the server has to answer for itself now that there is no `vscode.workspace`.
 *
 * Finding a DFX root and finding the index inside one used to be `vscode.workspace.findFiles`, which
 * respects the user's `files.exclude` and is backed by a real index. Nothing like that exists here,
 * so the scan below is deliberately small: it walks the workspace folders looking for a directory
 * named `DFX`, refuses to go deep, and skips the directories that are always noise. A plugin-generated
 * workspace puts each DFX root within a couple of levels of a folder root, so the cap costs nothing
 * real -- and an uncapped walk of an Unreal project would be a very expensive way to find nothing.
 */

import * as fs from 'fs';
import * as path from 'path';

import { URI } from 'vscode-uri';

export const INDEX_FILE_NAME = '.dfx-index.json';

/** How far below a workspace folder a `DFX` directory is still worth looking for. */
const MAX_SCAN_DEPTH = 4;

/** Directories that never contain a DFX root and are expensive to walk. */
const SKIPPED_DIRECTORIES = new Set([
	'node_modules', '.git', '.vs', '.vscode', '.idea',
	'Binaries', 'Intermediate', 'DerivedDataCache', 'Saved',
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

/**
 * The `DFX` directory a file lives under, if any.
 *
 * Kept as a path split rather than a walk up the filesystem because it has to work for paths that
 * do not exist yet -- `indexDestination` asks it where an index *would* go.
 */
export function enclosingDfxRoot(filePath: string): string | undefined {
	const parts = filePath.split(/[\\/]/);
	const index = parts.lastIndexOf('DFX');
	return index === -1 ? undefined : parts.slice(0, index + 1).join(path.sep);
}

/** Every `DFX/.dfx-index.json` under the given folders, nearest-first within each folder. */
export function findIndexFiles(folderPaths: readonly string[], limit: number): string[] {
	const found: string[] = [];

	for (const folder of folderPaths) {
		scan(folder, 0, found, limit);
		if (found.length >= limit) {
			break;
		}
	}

	return found;
}

function scan(directory: string, depth: number, found: string[], limit: number): void {
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

	for (const entry of entries) {
		if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) {
			continue;
		}

		const child = path.join(directory, entry.name);
		if (entry.name === 'DFX') {
			const candidate = path.join(child, INDEX_FILE_NAME);
			if (fs.existsSync(candidate)) {
				found.push(candidate);
				if (found.length >= limit) {
					return;
				}
			}
			// A DFX root does not nest inside another one, so there is nothing below this worth walking.
			continue;
		}

		scan(child, depth + 1, found, limit);
	}
}
