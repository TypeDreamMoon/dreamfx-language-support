/**
 * Loading and watching `DFX/.dfx-index.json`, server side.
 *
 * The two notes that governed the editor-side version still hold and are the reason this reads from
 * disk and never derives anything:
 *
 *  * Completion is only as current as the last `dfx index` run. That is the price of not booting the
 *    engine on a keystroke, and it is the right price -- but it means the extension must never
 *    present the index as authoritative about whether something exists. It offers; the build decides.
 *  * Staleness cannot be *detected* from here. The index records the engine path and the enabled
 *    plugin list precisely because those are what invalidate it, but comparing them needs a live
 *    editor to compare against. The honest move is to show when the index was generated and make
 *    rebuilding one command away, rather than to guess.
 *
 * What did change in the move is the one thing that could not survive it. The editor-side version
 * kept a single index and picked which one by asking for the active editor -- so in a workspace with
 * several DFX roots, which index answered a completion depended on which window had focus when the
 * cache last reloaded. A server has no active editor and cannot ask, which forces the better answer:
 * cache per DFX root, and resolve the root from the document the request is actually about. Focus
 * now decides only what the status bar reports, which is the one place it should decide anything.
 */

import * as fs from 'fs';
import * as path from 'path';

import { ModuleIndex, parseSchemaIndex } from '../core';
import { IndexStateParams } from '../lspProtocol';
import { INDEX_FILE_NAME, enclosingDfxRoot, findIndexFiles } from './workspace';

interface RootEntry {
	/** Absolute path of the index file this root's index came from, or would come from. */
	filePath: string;
	index?: ModuleIndex;
	problem?: string;
}

export class SchemaIndexCache {
	/** Keyed by DFX root path. Entries are dropped wholesale on a watcher event. */
	private readonly byRoot = new Map<string, RootEntry>();
	private folderPaths: readonly string[] = [];
	/** The root the status bar is currently reporting on, from the last `describe` call. */
	private reportedRoot?: string;

	constructor(
		private readonly log: (message: string) => void,
		private readonly onDidChange: (state: IndexStateParams) => void,
	) {}

	setWorkspaceFolders(folderPaths: readonly string[]): void {
		this.folderPaths = folderPaths;
		this.invalidateAll();
	}

	/** Everything is re-read on the next request. Cheap: the work is deferred, not done here. */
	invalidateAll(): void {
		this.byRoot.clear();
		this.republish();
	}

	/** The index that governs a given source file, loading it if this is the first ask. */
	indexFor(fsPath: string | undefined): ModuleIndex | undefined {
		const root = this.resolveRoot(fsPath);
		return root ? this.entryFor(root).index : undefined;
	}

	/**
	 * Point the status bar at whichever root a document belongs to, and say what is there.
	 *
	 * Called when focus moves, so it must stay cheap on the common path -- which it is: the entry is
	 * already loaded unless a watcher event cleared it.
	 */
	describe(fsPath: string | undefined): IndexStateParams {
		this.reportedRoot = this.resolveRoot(fsPath);
		return this.stateOf(this.reportedRoot);
	}

	/** Where a `dfx index` run for this document should write. */
	destinationFor(fsPath: string | undefined): string | undefined {
		const root = this.resolveRoot(fsPath);
		if (root) {
			return path.join(root, INDEX_FILE_NAME);
		}

		// No root anywhere yet -- so name where one would go, rather than refusing. A first run in a
		// fresh project is exactly the case that needs this to answer.
		const folder = this.folderPaths[0];
		return folder ? path.join(folder, 'DFX', INDEX_FILE_NAME) : undefined;
	}

	private republish(): void {
		this.onDidChange(this.stateOf(this.reportedRoot));
	}

	private stateOf(root: string | undefined): IndexStateParams {
		if (!root) {
			return { problem: `no ${INDEX_FILE_NAME} in this workspace` };
		}

		const entry = this.entryFor(root);
		if (!entry.index) {
			return { filePath: entry.filePath, problem: entry.problem ?? 'no index' };
		}

		return {
			filePath: entry.filePath,
			loaded: {
				moduleCount: entry.index.modules.length,
				generatedUtc: entry.index.source.generatedUtc,
			},
		};
	}

	/**
	 * The DFX root a file belongs to.
	 *
	 * A file inside a DFX tree answers for itself. Anything else -- an untitled buffer, a file opened
	 * from outside the project -- falls back to the first index in the workspace, which is both what
	 * the editor-side version did and the only useful answer available.
	 */
	private resolveRoot(fsPath: string | undefined): string | undefined {
		const own = fsPath ? enclosingDfxRoot(fsPath) : undefined;
		if (own) {
			return own;
		}

		const found = findIndexFiles(this.folderPaths, 1);
		return found.length > 0 ? path.dirname(found[0]) : undefined;
	}

	private entryFor(root: string): RootEntry {
		const cached = this.byRoot.get(root);
		if (cached) {
			return cached;
		}

		const entry = this.load(root);
		this.byRoot.set(root, entry);
		return entry;
	}

	private load(root: string): RootEntry {
		const filePath = path.join(root, INDEX_FILE_NAME);

		let text: string;
		try {
			text = fs.readFileSync(filePath, 'utf8');
		} catch (error) {
			return { filePath, problem: `could not read ${filePath}: ${String(error)}` };
		}

		const parsed = parseSchemaIndex(text);
		if ('error' in parsed) {
			this.log(`index: ${parsed.error}`);
			return { filePath, problem: parsed.error };
		}

		this.log(
			`index: ${parsed.index.modules.length} modules from ${filePath} (generated ${parsed.index.source.generatedUtc})`);
		return { filePath, index: parsed.index };
	}
}
