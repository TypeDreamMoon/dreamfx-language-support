/**
 * Where DreamFX's sources and generated data live, per the DreamSource layout
 * (Plan/DreamSource/dreamsource-layout-spec.md, section 13 for this language):
 *
 *   <Project>/DreamSource/FX/                     the project's sources (configurable)
 *   <Project>/DFX/                                the old place: still read, and asked to move
 *   <Plugin>/DreamSource/FX/, <Plugin>/DFX/       a plugin's, same rule, not configurable
 *   <FX root>/.dreamfx/index.db                   the module index (not rebuilt on its own)
 *   <Project>/Intermediate/DreamSource/fx.db      the editor's last diagnostics
 *   <Project>/Intermediate/DreamSource/FX/Bridge  the request/response folder
 *
 * Ported from the dreamgui extension's src/core/dreamSource.ts, the pilot every Dream extension
 * copies; the workspace-file rewrite comes from the dreamshader one. Pure apart from `nodeFs` and
 * the `path` arithmetic of the workspace rewrite: every resolver takes the filesystem as an argument,
 * so the whole table is tested without a disk. No `vscode` here -- the language server uses it too,
 * and membership ("is this file a DreamFX source?") has to get the same answer on both sides.
 */

import * as fs from 'fs';
import * as path from 'path';

/** One Dream language's names, as the layout spec's table spells them. */
export interface DreamLanguage {
	/** The language key: `FX`. Also the folder name under DreamSource/. */
	key: string;
	/** The folder a project or plugin used before DreamSource: `DFX`. */
	legacyName: string;
	/** The ini section the plugin's source-directory setting lives in. */
	settingsSection: string;
	/** The database file under Intermediate/DreamSource/. */
	databaseFile: string;
}

export const DREAM_FX: DreamLanguage = {
	key: 'FX',
	legacyName: 'DFX',
	settingsSection: '/Script/DreamFXEditor.DreamFXSourceSettings',
	databaseFile: 'fx.db',
};

export const DREAM_SOURCE_DIRECTORY = 'DreamSource';
export const SETTINGS_INI = ['Config', 'DefaultDreamSource.ini'];
export const GENERATED_DIRECTORY = ['Intermediate', 'DreamSource'];

/** The module index, relative to an FX source root (spec 13.4). */
export const INDEX_DATABASE = ['.dreamfx', 'index.db'];
/** What an older plugin wrote instead, at the root of the source folder. */
export const LEGACY_INDEX_FILE = '.dfx-index.json';
export const LEGACY_QUARANTINE_FILE = '.dfx-index.json.quarantine';

/** The workspace file the plugin generates inside the source folder (spec 13.2). */
export const WORKSPACE_FILE_NAME = 'DreamFX.code-workspace';

/**
 * What an older plugin generated outside the source folder, cleared by a migration (spec 13.6): the
 * old bridge folder only. `Saved/DreamFX/DynamicMesh` stays where it is, as do Pull/, BuildSafety/,
 * WriteBack/ and the .facts files -- baselines that cannot be rebuilt, or output meant for a person.
 */
export const LEGACY_GENERATED_DIRECTORIES = [
	['Saved', 'DreamFX', 'Bridge'],
];

/** The few filesystem questions this module asks. */
export interface SourceFs {
	isDirectory(target: string): boolean;
	isFile(target: string): boolean;
	/** Undefined when the file cannot be read. */
	readText(target: string): string | undefined;
	/** Entry names, empty when the directory cannot be read. */
	list(target: string): string[];
}

export type Join = (...parts: string[]) => string;

/** The node filesystem, in the shape every resolver below asks for. */
export const nodeFs: SourceFs = {
	isDirectory(target) {
		try {
			return Boolean(target) && fs.statSync(target).isDirectory();
		} catch {
			return false;
		}
	},
	isFile(target) {
		try {
			return Boolean(target) && fs.statSync(target).isFile();
		} catch {
			return false;
		}
	},
	readText(target) {
		try {
			return fs.readFileSync(target, 'utf8');
		} catch {
			return undefined;
		}
	},
	list(target) {
		try {
			return fs.readdirSync(target);
		} catch {
			return [];
		}
	},
};

export function defaultSourceDirectory(language: DreamLanguage = DREAM_FX): string {
	return `${DREAM_SOURCE_DIRECTORY}/${language.key}`;
}

/** A Windows drive, a UNC share or a rooted path: anything that is not relative to the project. */
export function isAbsoluteSetting(value: string): boolean {
	return /^[A-Za-z]:/.test(value) || value.startsWith('/') || value.startsWith('\\');
}

/**
 * The `SourceDirectory` of one section of DefaultDreamSource.ini, as the project-relative path it
 * names, or undefined when the section or key is missing, empty or absolute (an absolute path is a
 * path that works on one machine; the default stands in for it).
 *
 * Both spellings Unreal produces are read: `(Path="DreamSource/FX")`, which is how an FDirectoryPath
 * property saves, and a bare `DreamSource/FX`, which is how a person writes it.
 */
export function parseSourceDirectorySetting(iniText: string, section: string): string | undefined {
	let inSection = false;
	let found: string | undefined;
	for (const rawLine of iniText.replace(/^﻿/, '').split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith(';') || line.startsWith('#')) {
			continue;
		}
		const header = /^\[(.*)\]$/.exec(line);
		if (header) {
			inSection = header[1].trim().toLowerCase() === section.toLowerCase();
			continue;
		}
		if (!inSection) {
			continue;
		}
		const assignment = /^([+\-.!]?)([^=]+?)\s*=\s*(.*)$/.exec(line);
		if (!assignment || assignment[2].trim().toLowerCase() !== 'sourcedirectory') {
			continue;
		}
		if (assignment[1] === '-' || assignment[1] === '!') {
			found = undefined;
			continue;
		}
		// The last assignment wins, as it does when Unreal reads the file.
		found = unwrapDirectoryValue(assignment[3]);
	}
	if (found === undefined) {
		return undefined;
	}
	const normalized = found.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\.\//, '').trim();
	if (!normalized || normalized === '.' || isAbsoluteSetting(normalized)) {
		return undefined;
	}
	return normalized;
}

function unwrapDirectoryValue(raw: string): string {
	let value = raw.trim();
	const struct = /^\(\s*Path\s*=\s*(.*?)\s*\)$/i.exec(value);
	if (struct) {
		value = struct[1].trim();
	}
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		value = value.slice(1, -1);
	}
	return value;
}

/** The project directory: the nearest ancestor (or the directory itself) holding a .uproject. */
export function findProjectRoot(startDirectory: string, fileSystem: SourceFs, dirname: (target: string) => string,
	maxHops = 16): string | undefined {
	let directory = startDirectory;
	for (let hop = 0; hop <= maxHops; hop++) {
		if (fileSystem.list(directory).some((name) => name.toLowerCase().endsWith('.uproject'))) {
			return directory;
		}
		const parent = dirname(directory);
		if (parent === directory) {
			break;
		}
		directory = parent;
	}
	return undefined;
}

/**
 * Which of the two places the project's sources are read from, per the spec's table (11.2, which
 * 13.2 reuses with `L = <Project>/DFX`):
 *
 *   configured          only the configured directory exists
 *   configuredAndLegacy both exist: the configured one is used, the old one is ignored (and said so)
 *   legacy              only the old one exists: still used, and asked to move
 *   none                neither: anything that creates a source creates it in the configured one
 */
export type SourceRootState = 'configured' | 'configuredAndLegacy' | 'legacy' | 'none';

export interface ProjectSourceRoot {
	projectDir: string;
	/** The configured directory, absolute; where sources belong whether or not it exists yet. */
	configuredDir: string;
	/** The configured directory as written (project-relative), after defaults. */
	configuredSetting: string;
	/** `<Project>/DFX`, absolute. */
	legacyDir: string;
	state: SourceRootState;
	/** The directory sources are read from now; undefined for `none`. */
	activeDir: string | undefined;
	/** The active directory, or the configured one when there is none yet: where things get created. */
	directory: string;
}

export function readConfiguredSourceDirectory(projectDir: string, fileSystem: SourceFs, join: Join,
	language: DreamLanguage = DREAM_FX): string {
	const text = fileSystem.readText(join(projectDir, ...SETTINGS_INI));
	return (text !== undefined ? parseSourceDirectorySetting(text, language.settingsSection) : undefined)
		?? defaultSourceDirectory(language);
}

export function resolveProjectSourceRoot(projectDir: string, fileSystem: SourceFs, join: Join,
	language: DreamLanguage = DREAM_FX): ProjectSourceRoot {
	const configuredSetting = readConfiguredSourceDirectory(projectDir, fileSystem, join, language);
	const configuredDir = join(projectDir, ...configuredSetting.split('/'));
	const legacyDir = join(projectDir, language.legacyName);
	const hasConfigured = fileSystem.isDirectory(configuredDir);
	// A setting that names the old folder itself is not "both": it is the configured one.
	const hasLegacy = !samePath(configuredDir, legacyDir) && fileSystem.isDirectory(legacyDir);
	let state: SourceRootState;
	if (hasConfigured) {
		state = hasLegacy ? 'configuredAndLegacy' : 'configured';
	} else {
		state = hasLegacy ? 'legacy' : 'none';
	}
	const activeDir = state === 'legacy' ? legacyDir : state === 'none' ? undefined : configuredDir;
	return { projectDir, configuredDir, configuredSetting, legacyDir, state, activeDir, directory: activeDir ?? configuredDir };
}

/** A plugin's source root: `<Plugin>/DreamSource/FX`, else `<Plugin>/DFX`, else none. Not configurable. */
export function resolvePluginSourceDirectory(pluginDir: string, fileSystem: SourceFs, join: Join,
	language: DreamLanguage = DREAM_FX): { directory: string; legacy: boolean } | undefined {
	const current = join(pluginDir, DREAM_SOURCE_DIRECTORY, language.key);
	if (fileSystem.isDirectory(current)) {
		return { directory: current, legacy: false };
	}
	const legacy = join(pluginDir, language.legacyName);
	if (fileSystem.isDirectory(legacy)) {
		return { directory: legacy, legacy: true };
	}
	return undefined;
}

export interface PluginSourceRoot {
	plugin: string;
	pluginDir: string;
	directory: string;
	/** True when it is the plugin's old `DFX/`. */
	legacy: boolean;
}

/**
 * Every plugin under `<Project>/Plugins` (nested folders included, as Unreal allows) that has
 * sources.
 */
export function pluginSourceRoots(projectDir: string, fileSystem: SourceFs, join: Join,
	language: DreamLanguage = DREAM_FX, maxDepth = 3): PluginSourceRoot[] {
	const out: PluginSourceRoot[] = [];
	const visit = (directory: string, depth: number): void => {
		const entries = fileSystem.list(directory);
		const descriptor = entries.find((name) => name.toLowerCase().endsWith('.uplugin'));
		if (descriptor) {
			const found = resolvePluginSourceDirectory(directory, fileSystem, join, language);
			if (found) {
				out.push({ plugin: descriptor.slice(0, -'.uplugin'.length), pluginDir: directory, ...found });
			}
			return; // a plugin does not hold plugins
		}
		if (depth >= maxDepth) {
			return;
		}
		for (const name of entries) {
			const child = join(directory, name);
			if (!name.startsWith('.') && fileSystem.isDirectory(child)) {
				visit(child, depth + 1);
			}
		}
	};
	visit(join(projectDir, 'Plugins'), 0);
	return out;
}

/** One place a project's FX sources are read from. */
export interface SourceRoot {
	directory: string;
	/** `project` for the project's own, else the plugin's name. */
	owner: 'project' | { plugin: string; pluginDir: string };
	legacy: boolean;
}

/** The project's sources -- and how they were resolved -- plus every plugin's. */
export interface ProjectLayout {
	project: ProjectSourceRoot;
	plugins: PluginSourceRoot[];
	/** Every root that exists, the project's first. */
	roots: SourceRoot[];
}

export function resolveProjectLayout(projectDir: string, fileSystem: SourceFs, join: Join,
	language: DreamLanguage = DREAM_FX): ProjectLayout {
	const project = resolveProjectSourceRoot(projectDir, fileSystem, join, language);
	const plugins = pluginSourceRoots(projectDir, fileSystem, join, language);
	const roots: SourceRoot[] = [];
	if (project.activeDir) {
		roots.push({ directory: project.activeDir, owner: 'project', legacy: project.state === 'legacy' });
	}
	for (const plugin of plugins) {
		roots.push({ directory: plugin.directory, owner: { plugin: plugin.plugin, pluginDir: plugin.pluginDir }, legacy: plugin.legacy });
	}
	return { project, plugins, roots };
}

/**
 * The root a file belongs to, if any (spec 7: membership is "under one of the resolved roots", never
 * "has a folder called DFX somewhere in its path"). The deepest one wins, so a plugin inside a
 * project whose source directory was configured as `.`-adjacent still answers for its own files.
 */
export function enclosingSourceRoot(filePath: string, roots: readonly SourceRoot[]): SourceRoot | undefined {
	let best: SourceRoot | undefined;
	for (const root of roots) {
		if (isUnder(filePath, root.directory)
			&& (!best || normalizeForCompare(root.directory).length > normalizeForCompare(best.directory).length)) {
			best = root;
		}
	}
	return best;
}

export function generatedDirectory(projectDir: string, join: Join): string {
	return join(projectDir, ...GENERATED_DIRECTORY);
}

/** `<Project>/Intermediate/DreamSource/fx.db`. */
export function fxDatabasePath(projectDir: string, join: Join): string {
	return join(generatedDirectory(projectDir, join), DREAM_FX.databaseFile);
}

/** `<Project>/Saved/DreamFX/Bridge/diagnostics.json`, which fx.db replaces. */
export function legacyDiagnosticsPath(projectDir: string, join: Join): string {
	return join(projectDir, 'Saved', 'DreamFX', 'Bridge', 'diagnostics.json');
}

export function indexDatabasePath(sourceDir: string, join: Join): string {
	return join(sourceDir, ...INDEX_DATABASE);
}

export function legacyIndexPath(sourceDir: string, join: Join): string {
	return join(sourceDir, LEGACY_INDEX_FILE);
}

function normalizeForCompare(value: string): string {
	return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Case-blind, slash-blind: what Windows means by "the same directory". */
export function samePath(a: string, b: string): boolean {
	return normalizeForCompare(a) === normalizeForCompare(b);
}

/** Whether `child` is `parent` or somewhere under it. */
export function isUnder(child: string, parent: string): boolean {
	const c = normalizeForCompare(child);
	const p = normalizeForCompare(parent);
	return c === p || c.startsWith(p + '/');
}

// ---- the old folder: saying so, and moving it ------------------------------------------------

function displayRelative(root: ProjectSourceRoot): string {
	return `${root.configuredSetting.replace(/\/+$/, '')}/`;
}

/**
 * The one-line notice for a project still on (or still carrying) its old folder, per spec 4;
 * undefined when there is nothing to say.
 */
export function deprecationNotice(root: ProjectSourceRoot, language: DreamLanguage = DREAM_FX): string | undefined {
	const legacy = `${language.legacyName}/`;
	const target = displayRelative(root);
	switch (root.state) {
		case 'legacy':
			return `${legacy} is deprecated. Move it to ${target} -- Dream sources now live together under `
				+ `${DREAM_SOURCE_DIRECTORY}/. It keeps working until you do.`;
		case 'configuredAndLegacy':
			return `${legacy} is ignored because ${target} exists. Merge what is in it into ${target} and delete it.`;
		default:
			return undefined;
	}
}

export type MigrationPlan =
	| { ok: true; from: string; to: string; staleDirectories: string[] }
	| { ok: false; reason: string };

/**
 * Whether the old folder can be moved to the configured one: only from the `legacy` state (moving
 * onto an existing folder would be a merge, which is the author's call), and only with no editor
 * running (it resolved its source directory at startup, holds the folder open and writes into it).
 */
export function planMigration(root: ProjectSourceRoot, editorRunning: boolean, join: Join,
	language: DreamLanguage = DREAM_FX): MigrationPlan {
	const legacy = `${language.legacyName}/`;
	const target = displayRelative(root);
	switch (root.state) {
		case 'configured':
			return { ok: false, reason: `The project already uses ${target}; there is no ${legacy} to move.` };
		case 'none':
			return { ok: false, reason: `The project has no ${legacy} to move.` };
		case 'configuredAndLegacy':
			return {
				ok: false,
				reason: `${target} already exists, so moving ${legacy} onto it would be a merge. `
					+ `Merge the two by hand and delete ${legacy}.`,
			};
		case 'legacy':
			break;
	}
	if (editorRunning) {
		return {
			ok: false,
			reason: `The Unreal Editor has this project open. Close it first: it holds ${legacy} open and keeps writing into it.`,
		};
	}
	return {
		ok: true,
		from: root.legacyDir,
		to: root.configuredDir,
		staleDirectories: LEGACY_GENERATED_DIRECTORIES.map((parts) => join(root.projectDir, ...parts)),
	};
}

/**
 * DreamFX.code-workspace after its folder moved from `fromDir` to `toDir`.
 *
 * Every folder `path` is relative to the file, so each one that pointed somewhere else is re-aimed
 * from the new place. A plugin's old `DFX` folder is swapped for the plugin's current root when
 * `resolvePluginRoot` (given the plugin directory) names one. Only the `path` strings change; the
 * rest of the text -- the editor's own formatting included -- is left as it was. Text that is not a
 * workspace comes back unchanged.
 */
export function rewriteWorkspaceFile(text: string, fromDir: string, toDir: string,
	resolvePluginRoot: (pluginDir: string) => string | undefined = () => undefined,
	language: DreamLanguage = DREAM_FX): string {
	let workspace: { folders?: unknown };
	try {
		workspace = JSON.parse(text.replace(/^﻿/, '')) as { folders?: unknown };
	} catch {
		return text;
	}
	if (!workspace || !Array.isArray(workspace.folders)) {
		return text;
	}

	const replacements: { from: string; to: string }[] = [];
	for (const folder of workspace.folders as { path?: unknown }[]) {
		if (!folder || typeof folder.path !== 'string' || path.isAbsolute(folder.path) || isAbsoluteSetting(folder.path)) {
			continue;
		}
		const resolved = path.resolve(fromDir, folder.path);
		if (isUnder(resolved, fromDir)) {
			continue; // "." or a subfolder: it moved with the file, so the relative path still holds
		}
		let target = resolved;
		if (path.basename(resolved).toLowerCase() === language.legacyName.toLowerCase()) {
			target = resolvePluginRoot(path.dirname(resolved)) ?? resolved;
		}
		const rebased = path.relative(toDir, target).replace(/\\/g, '/') || '.';
		if (rebased !== folder.path) {
			replacements.push({ from: folder.path, to: rebased });
			folder.path = rebased;
		}
	}
	if (replacements.length === 0) {
		return text;
	}

	// In place, one `"path": "..."` at a time and in order, so the file keeps its formatting.
	let rewritten = text;
	let cursor = 0;
	for (const { from, to } of replacements) {
		const pattern = new RegExp(`("path"\\s*:\\s*)${escapeRegExp(JSON.stringify(from))}`, 'g');
		pattern.lastIndex = cursor;
		const match = pattern.exec(rewritten);
		if (!match) {
			// Spelled in a way the search did not anticipate (escapes, say): write the parsed form instead.
			const eol = /\r\n/.test(text) ? '\r\n' : '\n';
			return JSON.stringify(workspace, undefined, '\t').replace(/\n/g, eol) + eol;
		}
		const replacement = `${match[1]}${JSON.stringify(to)}`;
		rewritten = rewritten.slice(0, match.index) + replacement + rewritten.slice(match.index + match[0].length);
		cursor = match.index + replacement.length;
	}
	return rewritten;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
