/**
 * The old `DFX/` folder: said once per project per window (spec 4 and 13.6), with a way to move it and
 * a way to stop hearing about it. What to say is core/dreamSource's; the move itself is core/migrate's;
 * this file asks the window. Mirrors the dreamgui extension's src/migration.ts; the command itself
 * (`dreamfx.migrateToDreamSource`) is registered in extension.ts with the others.
 */

import * as path from 'path';
import * as vscode from 'vscode';

import { deprecationNotice, isUnder, migrateProject, samePath } from '../core';
import { BridgeClient } from './bridge';
import { DreamSourceHost } from './dreamSourceHost';

const DISMISSED_KEY = 'dreamfx.dreamSource.dismissed';
const MIGRATE = 'Migrate to DreamSource';
const DONT_SHOW = "Don't show again";

/** Per project, and per kind of notice: dismissing "DFX/ is deprecated" does not silence "DFX/ is ignored". */
export function dismissalKey(projectDir: string, state: string): string {
	return `${state}|${projectDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()}`;
}

export function registerDreamSourceMigration(
	context: vscode.ExtensionContext,
	host: DreamSourceHost,
	bridge: BridgeClient,
	output: vscode.OutputChannel,
): () => Promise<void> {
	const asked = new Set<string>();

	const isDismissed = (key: string): boolean =>
		(context.globalState.get<string[]>(DISMISSED_KEY) ?? []).includes(key);
	const dismiss = async (key: string): Promise<void> => {
		const current = context.globalState.get<string[]>(DISMISSED_KEY) ?? [];
		if (!current.includes(key)) {
			await context.globalState.update(DISMISSED_KEY, [...current, key]);
		}
	};

	const migrate = async (projectDir: string): Promise<void> => {
		const editorRunning = bridge.editorMayBeRunning(projectDir);
		if (editorRunning) {
			void vscode.window.showWarningMessage(
				'DreamFXLang: the Unreal Editor has this project open. Close it first -- it resolved the FX source '
				+ 'folder when it started and keeps writing into it -- then run "DreamFX: Migrate to DreamSource" again.');
			return;
		}

		const result = migrateProject(projectDir, false);
		output.appendLine(`DreamSource: migrate ${projectDir}: ${result.message}`);
		if (!result.ok) {
			void vscode.window.showWarningMessage(`DreamFXLang: ${result.message}`);
			return;
		}

		host.invalidate(projectDir);

		const openOnOldFolder = (vscode.workspace.workspaceFolders ?? []).some((folder) =>
			folder.uri.scheme === 'file' && isUnder(folder.uri.fsPath, result.from));
		const workspaceFile = vscode.workspace.workspaceFile;
		const onOldWorkspaceFile = workspaceFile?.scheme === 'file' && isUnder(workspaceFile.fsPath, result.from);
		const movedWorkspaceFile = onOldWorkspaceFile && workspaceFile
			? path.join(result.to, path.relative(result.from, workspaceFile.fsPath))
			: undefined;

		const message = `DreamFXLang: ${result.message} The Unreal Editor picks the new folder up when it next starts. `
			+ 'Files open from the old folder need opening again.'
			+ (openOnOldFolder && !movedWorkspaceFile ? ' This window was opened on the old folder; reopen it from the new one.' : '');
		const reopen = movedWorkspaceFile ? 'Reopen Moved Workspace' : undefined;
		const choice = await vscode.window.showInformationMessage(message, ...(reopen ? [reopen] : []));
		if (choice === reopen && movedWorkspaceFile) {
			await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(movedWorkspaceFile));
		}
	};

	const check = (projectDir: string | undefined): void => {
		if (!projectDir) {
			return;
		}
		const root = host.layout(projectDir).project;
		const notice = deprecationNotice(root);
		const key = dismissalKey(projectDir, root.state);
		if (!notice || asked.has(key) || isDismissed(key)) {
			return;
		}
		asked.add(key);
		output.appendLine(`DreamSource: ${projectDir}: ${notice}`);
		const actions = root.state === 'legacy' ? [MIGRATE, DONT_SHOW] : [DONT_SHOW];
		void vscode.window.showWarningMessage(`DreamFXLang: ${notice}`, ...actions).then(async (choice) => {
			if (choice === MIGRATE) {
				await migrate(projectDir);
			} else if (choice === DONT_SHOW) {
				await dismiss(key);
			}
		});
	};

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor((editor) => {
			if (editor?.document.languageId === 'dreamfxlang' && editor.document.uri.scheme === 'file') {
				check(host.projectDirFor(editor.document.uri.fsPath));
			}
		}),
		// The ini moved the folder, or a migration ran: the notice may now be a different one.
		host.onDidChangeLayout((projectDir) => check(projectDir)),
	);

	// On activation: every project the workspace is in, and the active file's.
	const seen: string[] = [];
	const active = vscode.window.activeTextEditor?.document;
	for (const projectDir of [
		...host.workspaceProjects(),
		active?.uri.scheme === 'file' ? host.projectDirFor(active.uri.fsPath) : undefined,
	]) {
		if (projectDir && !seen.some((other) => samePath(other, projectDir))) {
			seen.push(projectDir);
			check(projectDir);
		}
	}

	/** The command: the active file's project, else the workspace's first. */
	return async () => {
		const document = vscode.window.activeTextEditor?.document;
		const projectDir = host.projectDirFor(document?.uri.scheme === 'file' ? document.uri.fsPath : undefined);
		if (!projectDir) {
			void vscode.window.showWarningMessage('DreamFXLang: no Unreal project (.uproject) found for this window.');
			return;
		}
		await migrate(projectDir);
	};
}
