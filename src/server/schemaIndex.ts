/**
 * Loading and watching the module index, server side.
 *
 * Where it is comes from the DreamSource layout (spec 13.4): `<FX root>/.dreamfx/index.db`, written by
 * `dfx index` and the bridge's `refreshIndex`, and -- from a plugin older than that, or a database that
 * has no modules yet -- the `.dfx-index.json` that used to sit at the root of the source folder. The
 * database wins whenever it has modules; the JSON is the fallback, never a merge.
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
 * Cached per root, resolved from the document a request is about. A root is the project's FX
 * source folder unless a plugin root carries an index of its own (an old `dfx index -Out` put one
 * there); the index describes the project's whole module library, so a plugin's sources are answered
 * from the project's index otherwise.
 *
 * A watcher event does not throw an entry away. It marks it for a check, and the check is cheap in
 * the common case: the files' size and time, then `meta`'s revision. Only a moved revision re-reads a
 * 1 MB index -- which matters, because a WAL commit touches the files more than once per write.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
	ModuleIndex,
	SUPPORTED_INDEX_SCHEMA,
	databaseFileTag,
	enclosingSourceRoot,
	indexDatabasePath,
	isSqliteAvailable,
	legacyIndexPath,
	parseSchemaIndex,
	readIndexDatabase,
	readIndexRevision,
	samePath,
	validateSchemaIndex,
} from '../core';
import { IndexDestination, IndexStateParams } from '../lspProtocol';
import { SourceLayouts } from './workspace';

interface RootEntry {
	root: string;
	/** The file this root's index came from, or where it would come from. */
	filePath: string;
	source?: 'database' | 'json';
	/** The database's tag and the JSON's, as last seen. */
	tag: string;
	/** `meta`'s revision of the modules, when the index came from the database. */
	revision?: string;
	index?: ModuleIndex;
	problem?: string;
	/** A watcher saw something; check the tag before the next use. */
	dirty: boolean;
}

function fileTag(target: string): string {
	try {
		const stat = fs.statSync(target);
		return stat.isFile() ? `${stat.mtimeMs}:${stat.size}` : '-';
	} catch {
		return '-';
	}
}

export class SchemaIndexCache {
	/** Keyed by root path. */
	private readonly byRoot = new Map<string, RootEntry>();
	/** The root the status bar is currently reporting on, from the last `describe` call. */
	private reportedRoot?: string;
	/** Databases already said to be of a schema this extension does not read. */
	private readonly warned = new Set<string>();

	constructor(
		private readonly layouts: SourceLayouts,
		private readonly log: (message: string) => void,
		private readonly onDidChange: (state: IndexStateParams) => void,
		private readonly warn: (message: string) => void = () => undefined,
	) {}

	setWorkspaceFolders(folderPaths: readonly string[]): void {
		this.layouts.setWorkspaceFolders(folderPaths);
		this.byRoot.clear();
		this.republish();
	}

	/**
	 * Something on disk may have changed: check every loaded index before its next use. Nothing is
	 * re-read here, and an index whose files and revision did not move is not re-read at all.
	 */
	refresh(): void {
		for (const entry of this.byRoot.values()) {
			entry.dirty = true;
		}
		this.republish();
	}

	/** The source directories may have moved (the ini changed, or a migration ran). */
	invalidateLayout(): void {
		this.layouts.invalidate();
		this.refresh();
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
	 * already loaded, and a watcher event only costs it a stat.
	 */
	describe(fsPath: string | undefined): IndexStateParams {
		this.reportedRoot = this.resolveRoot(fsPath);
		return this.stateOf(this.reportedRoot);
	}

	/**
	 * Where a `dfx index` run for this document should write.
	 *
	 * Normally nowhere in particular: without `-Out` the plugin writes its own default, which is the
	 * project's `.dreamfx/index.db` -- exactly what this reads. (A plugin from before DreamSource writes
	 * `<Project>/DFX/.dfx-index.json` instead, which is also what this reads for such a project.) Only
	 * a plugin root that already carries its own JSON index is refreshed in place with `-Out`.
	 */
	destinationFor(fsPath: string | undefined): IndexDestination | undefined {
		const root = this.resolveRoot(fsPath);
		if (!root) {
			return undefined;
		}
		const projectDir = this.projectOf(fsPath);
		const projectRoot = projectDir ? this.layouts.layout(projectDir).project.directory : undefined;
		const json = legacyIndexPath(root, path.join);
		if (projectRoot && !samePath(root, projectRoot) && !fs.existsSync(indexDatabasePath(root, path.join)) && fs.existsSync(json)) {
			return { out: json, expected: json };
		}
		return { expected: indexDatabasePath(root, path.join) };
	}

	private republish(): void {
		this.onDidChange(this.stateOf(this.reportedRoot));
	}

	private stateOf(root: string | undefined): IndexStateParams {
		if (!root) {
			return { problem: 'no Unreal project (.uproject) in this workspace' };
		}

		const entry = this.entryFor(root);
		if (!entry.index) {
			return { filePath: entry.filePath, problem: entry.problem ?? 'no index' };
		}

		return {
			filePath: entry.filePath,
			source: entry.source,
			loaded: {
				moduleCount: entry.index.modules.length,
				generatedUtc: entry.index.source.generatedUtc,
			},
		};
	}

	private projectOf(fsPath: string | undefined): string | undefined {
		return (fsPath ? this.layouts.projectFor(fsPath) : undefined) ?? this.layouts.projects()[0];
	}

	/**
	 * The root whose index answers for a file.
	 *
	 * A plugin root with an index of its own answers for its files. Everything else -- the project's
	 * own sources, a plugin's without an index, an untitled buffer, a file opened from outside any
	 * project -- is answered by the project's FX root: the document's project, else the workspace's
	 * first. That root is named even when it does not exist yet, so the status bar can say where an
	 * index would go.
	 */
	private resolveRoot(fsPath: string | undefined): string | undefined {
		const projectDir = this.projectOf(fsPath);
		if (!projectDir) {
			return undefined;
		}
		const layout = this.layouts.layout(projectDir);
		const own = fsPath ? enclosingSourceRoot(fsPath, layout.roots) : undefined;
		if (own && own.owner !== 'project' && this.hasIndexFiles(own.directory)) {
			return own.directory;
		}
		return layout.project.directory;
	}

	private hasIndexFiles(root: string): boolean {
		return fs.existsSync(indexDatabasePath(root, path.join)) || fs.existsSync(legacyIndexPath(root, path.join));
	}

	private tagOf(root: string): string {
		return `${databaseFileTag(indexDatabasePath(root, path.join)) ?? '-'}#${fileTag(legacyIndexPath(root, path.join))}`;
	}

	private entryFor(root: string): RootEntry {
		const cached = this.byRoot.get(root);
		if (cached && !cached.dirty) {
			return cached;
		}
		if (cached && this.unchanged(cached)) {
			cached.dirty = false;
			return cached;
		}

		const entry = this.load(root);
		this.byRoot.set(root, entry);
		return entry;
	}

	/** The `PRAGMA data_version` of a reader that opens a connection per read: the files, then `meta`. */
	private unchanged(entry: RootEntry): boolean {
		const tag = this.tagOf(entry.root);
		if (tag === entry.tag) {
			return true;
		}
		if (entry.source === 'database' && entry.revision !== undefined) {
			const revision = readIndexRevision(indexDatabasePath(entry.root, path.join));
			if (revision === entry.revision) {
				// A checkpoint, or a write that changed nothing the index reads.
				entry.tag = tag;
				return true;
			}
		}
		return false;
	}

	private load(root: string): RootEntry {
		const tag = this.tagOf(root);
		const databaseFile = indexDatabasePath(root, path.join);
		const jsonFile = legacyIndexPath(root, path.join);
		let fellBack = '';

		if (fs.existsSync(databaseFile)) {
			if (!isSqliteAvailable()) {
				fellBack = ` (${databaseFile} exists, but this runtime has no node:sqlite to read it with -- update VS Code)`;
			} else {
				const read = readIndexDatabase(databaseFile);
				if (read.kind === 'unsupported') {
					const problem = `${databaseFile} has schema ${read.schema ?? '(none)'}, and this extension reads schema `
						+ `${SUPPORTED_INDEX_SCHEMA}. Update the DreamFXLang extension or the DreamFX plugin so the two match.`;
					this.log(`index: ${problem}`);
					if (!this.warned.has(databaseFile.toLowerCase())) {
						this.warned.add(databaseFile.toLowerCase());
						this.warn(`DreamFXLang: ${problem}`);
					}
					return { root, filePath: databaseFile, tag, problem, dirty: false };
				}
				if (read.kind === 'ok') {
					const parsed = validateSchemaIndex(read.value.index);
					if ('error' in parsed) {
						this.log(`index: ${parsed.error} (${databaseFile})`);
						return { root, filePath: databaseFile, tag, problem: parsed.error, dirty: false };
					}
					const quarantined = read.value.quarantine.length ? `, ${read.value.quarantine.length} quarantined` : '';
					this.log(`index: ${parsed.index.modules.length} modules from ${databaseFile}`
						+ ` (generated ${parsed.index.source.generatedUtc}${quarantined})`);
					return {
						root, filePath: databaseFile, source: 'database', tag, revision: read.revision,
						index: parsed.index, dirty: false,
					};
				}
				fellBack = ` (${databaseFile} has no modules yet)`;
			}
		}

		let text: string;
		try {
			text = fs.readFileSync(jsonFile, 'utf8');
		} catch {
			const problem = `no index for ${root} yet -- run "Rebuild Module Index"`;
			return { root, filePath: fs.existsSync(databaseFile) ? databaseFile : jsonFile, tag, problem, dirty: false };
		}

		const parsed = parseSchemaIndex(text);
		if ('error' in parsed) {
			this.log(`index: ${parsed.error}`);
			return { root, filePath: jsonFile, tag, problem: parsed.error, dirty: false };
		}

		this.log(`index: ${parsed.index.modules.length} modules from ${jsonFile} (generated ${parsed.index.source.generatedUtc})`
			+ `${fellBack}. An updated DreamFX plugin writes .dreamfx/index.db instead; until then the JSON is read.`);
		return { root, filePath: jsonFile, source: 'json', tag, index: parsed.index, dirty: false };
	}
}
