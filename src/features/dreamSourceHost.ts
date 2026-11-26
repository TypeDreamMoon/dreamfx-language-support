/**
 * The DreamSource layout, wired to the disk and the window: which project a file belongs to, where
 * its FX sources are (core/dreamSource.ts decides), and the watchers that say when any of that, the
 * module index or the editor's diagnostics changed.
 *
 * One instance per window, shared by the new-file command, the migration prompt, the editor
 * diagnostics and the language client, so they agree on every answer. The server resolves with the
 * same core module; this side only has to tell it when to look again.
 *
 * What is watched, per project (spec 3 and 5.3):
 *
 *   Config/DefaultDreamSource.ini                          the source directory moved
 *   <each root>/.dfx-index.json, .dreamfx/index.db(-wal)   the module index changed
 *   Intermediate/DreamSource/fx.db(-wal)                   the editor wrote diagnostics
 *   Saved/DreamFX/Bridge/diagnostics.json                  ...as an older plugin does
 *
 * Never a `-shm`: every reader touches it, so watching it would make each read trigger the next.
 * RelativePatterns rather than workspace globs because a project's roots need not be open as folders
 * -- the generated workspace lists the FX root and the plugins', not the project.
 */

import * as path from 'path';
import * as vscode from 'vscode';

import {
	ProjectLayout,
	findProjectRoot,
	nodeFs,
	resolveProjectLayout,
} from '../core';

/** One burst of watcher events per change: a WAL commit is several. */
const DEBOUNCE_MS = 200;

interface ProjectWatch {
	/** The ini, fx.db and the legacy diagnostics: fixed per project. */
	fixed: vscode.Disposable[];
	/** The index files of each root: re-made whenever the layout moves. */
	roots: vscode.Disposable[];
}

export class DreamSourceHost implements vscode.Disposable {
	private readonly projectByDirectory = new Map<string, string | undefined>();
	private readonly layouts = new Map<string, ProjectLayout>();
	private readonly watches = new Map<string, ProjectWatch>();
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly disposables: vscode.Disposable[] = [];

	private readonly layoutChanged = new vscode.EventEmitter<string>();
	private readonly indexChanged = new vscode.EventEmitter<string>();
	private readonly diagnosticsChanged = new vscode.EventEmitter<string>();

	/** A project's source directories may have moved. Carries the project directory. */
	readonly onDidChangeLayout = this.layoutChanged.event;
	/** One of a project's index files changed. */
	readonly onDidChangeIndex = this.indexChanged.event;
	/** The editor's diagnostics for a project changed (fx.db, or an older plugin's diagnostics.json). */
	readonly onDidChangeDiagnostics = this.diagnosticsChanged.event;

	constructor(private readonly output: vscode.OutputChannel) {
		this.disposables.push(
			this.layoutChanged, this.indexChanged, this.diagnosticsChanged,
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.watchWorkspaceProjects()),
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				if (editor?.document.uri.scheme === 'file') {
					const project = this.projectDirFor(editor.document.uri.fsPath);
					if (project) {
						this.watchProject(project);
					}
				}
			}),
		);
		this.watchWorkspaceProjects();
	}

	dispose(): void {
		for (const watch of this.watches.values()) {
			[...watch.fixed, ...watch.roots].forEach((disposable) => disposable.dispose());
		}
		this.watches.clear();
		for (const timer of this.timers.values()) {
			clearTimeout(timer);
		}
		this.disposables.forEach((disposable) => disposable.dispose());
	}

	/**
	 * The project a file belongs to (the nearest .uproject above it), or with no file the first
	 * workspace folder that is in (or under) a project.
	 */
	projectDirFor(documentPath?: string): string | undefined {
		if (documentPath) {
			const found = this.projectOfDirectory(path.dirname(documentPath));
			if (found) {
				return found;
			}
		}
		return this.workspaceProjects()[0];
	}

	/** Every project the workspace folders are in, in folder order. */
	workspaceProjects(): string[] {
		const found: string[] = [];
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			if (folder.uri.scheme !== 'file') {
				continue;
			}
			const project = this.projectOfDirectory(folder.uri.fsPath);
			if (project && !found.includes(project)) {
				found.push(project);
			}
		}
		return found;
	}

	/** Where a project's FX sources are, cached until the ini changes or a migration runs. */
	layout(projectDir: string): ProjectLayout {
		let layout = this.layouts.get(projectDir);
		if (!layout) {
			layout = resolveProjectLayout(projectDir, nodeFs, path.join);
			this.layouts.set(projectDir, layout);
			for (const plugin of layout.plugins.filter((entry) => entry.legacy)) {
				// Plugins are only logged (spec 13.2): their author migrates them, not the person using them.
				this.output.appendLine(`DreamSource: plugin ${plugin.plugin} still keeps its FX sources in DFX/ `
					+ `(${plugin.directory}); its author should move them to DreamSource/FX/.`);
			}
		}
		return layout;
	}

	/** Forget everything resolved for a project and say so: the ini changed, or a migration ran. */
	invalidate(projectDir: string): void {
		this.layouts.delete(projectDir);
		this.projectByDirectory.clear();
		this.rewatchRoots(projectDir);
		this.layoutChanged.fire(projectDir);
	}

	private projectOfDirectory(directory: string): string | undefined {
		if (!this.projectByDirectory.has(directory)) {
			this.projectByDirectory.set(directory, findProjectRoot(directory, nodeFs, path.dirname));
		}
		return this.projectByDirectory.get(directory);
	}

	private watchWorkspaceProjects(): void {
		for (const project of this.workspaceProjects()) {
			this.watchProject(project);
		}
		const active = vscode.window.activeTextEditor?.document;
		if (active?.uri.scheme === 'file') {
			const project = this.projectOfDirectory(path.dirname(active.uri.fsPath));
			if (project) {
				this.watchProject(project);
			}
		}
	}

	private watchProject(projectDir: string): void {
		if (this.watches.has(projectDir)) {
			return;
		}
		const base = vscode.Uri.file(projectDir);
		const fixed = [
			this.watch(new vscode.RelativePattern(base, 'Config/DefaultDreamSource.ini'), `layout|${projectDir}`, () => {
				this.output.appendLine(`DreamSource: ${path.join(projectDir, 'Config', 'DefaultDreamSource.ini')} changed; re-resolving the FX source folder.`);
				this.invalidate(projectDir);
			}),
			this.watch(new vscode.RelativePattern(base, 'Intermediate/DreamSource/{fx.db,fx.db-wal}'), `diagnostics|${projectDir}`,
				() => this.diagnosticsChanged.fire(projectDir)),
			this.watch(new vscode.RelativePattern(base, 'Saved/DreamFX/Bridge/diagnostics.json'), `diagnostics|${projectDir}`,
				() => this.diagnosticsChanged.fire(projectDir)),
		];
		this.watches.set(projectDir, { fixed, roots: [] });
		this.rewatchRoots(projectDir);
	}

	/**
	 * The index files of every root -- the project's configured and legacy folders (either can be the
	 * one in use, and a migration swaps them) and each plugin's.
	 */
	private rewatchRoots(projectDir: string): void {
		const watch = this.watches.get(projectDir);
		if (!watch) {
			return;
		}
		watch.roots.forEach((disposable) => disposable.dispose());
		const layout = this.layout(projectDir);
		const directories = new Set<string>([layout.project.configuredDir, layout.project.legacyDir,
			...layout.plugins.map((plugin) => plugin.directory)]);
		watch.roots = [];
		for (const directory of directories) {
			const base = vscode.Uri.file(directory);
			const fire = (): void => this.indexChanged.fire(projectDir);
			watch.roots.push(
				this.watch(new vscode.RelativePattern(base, '.dfx-index.json'), `index|${projectDir}`, fire),
				this.watch(new vscode.RelativePattern(base, '.dreamfx/{index.db,index.db-wal}'), `index|${projectDir}`, fire));
		}
	}

	private watch(pattern: vscode.RelativePattern, key: string, onChange: () => void): vscode.Disposable {
		const watcher = vscode.workspace.createFileSystemWatcher(pattern);
		const debounced = (): void => {
			const pending = this.timers.get(key);
			if (pending) {
				clearTimeout(pending);
			}
			this.timers.set(key, setTimeout(() => {
				this.timers.delete(key);
				onChange();
			}, DEBOUNCE_MS));
		};
		watcher.onDidCreate(debounced);
		watcher.onDidChange(debounced);
		watcher.onDidDelete(debounced);
		return watcher;
	}
}
