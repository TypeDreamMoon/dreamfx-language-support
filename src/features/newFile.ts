/**
 * "New source file", the command behind the W2 acceptance test: what it creates has to build.
 *
 * The asset name is asked for rather than the file name, because in DreamFX they are the same
 * thing: a source at `DFX/Samples/NS_Spark.dfs` declares `Name="Samples/NS_Spark"`, and the plugin's
 * own tree is laid out that way throughout. Asking for the file name and inferring the asset name
 * would let the two drift apart, and the one that decides where the asset lands is the header.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { TEMPLATE_CHOICES, TemplateChoice, renderTemplate } from '../core';

export async function newSourceFile(): Promise<void> {
	const choice = await pickTemplate();
	if (!choice) {
		return;
	}

	const root = await pickDfxRoot();
	if (!root) {
		return;
	}

	const assetName = await vscode.window.showInputBox({
		title: `New ${choice.label}`,
		prompt: `Asset path under the root. The file lands at ${path.basename(root)}/<name>${choice.extension}.`,
		value: `Samples/${choice.namePrefix}`,
		valueSelection: [`Samples/${choice.namePrefix}`.length, `Samples/${choice.namePrefix}`.length],
		validateInput: (value) => {
			const trimmed = value.trim();
			if (!trimmed) {
				return 'A name is required.';
			}
			if (/^[\\/]|[\\/]$/.test(trimmed)) {
				return 'Write the path relative to the root, without a leading or trailing slash.';
			}
			if (/[:*?"<>|]/.test(trimmed)) {
				return 'A name cannot contain : * ? " < > |';
			}
			return undefined;
		},
	});
	if (!assetName) {
		return;
	}

	const normalized = assetName.trim().replace(/\\/g, '/');
	const target = path.join(root, `${normalized.replace(/\//g, path.sep)}${choice.extension}`);

	if (fs.existsSync(target)) {
		void vscode.window.showErrorMessage(`DreamFXLang: ${target} already exists.`);
		return;
	}

	const rootToken = await vscode.window.showInputBox({
		title: `New ${choice.label}`,
		prompt: 'Root token: Game, empty (the same thing), or Plugin.<PluginName>.',
		value: suggestRootToken(root),
	});
	if (rootToken === undefined) {
		return;
	}

	const contents = renderTemplate({ kind: choice.kind, name: normalized, root: rootToken.trim() });

	try {
		await fs.promises.mkdir(path.dirname(target), { recursive: true });
		// 'wx' rather than a plain write: the existence check above raced anything that created the
		// file while the two prompts were open, and silently overwriting someone's source is not a
		// recoverable mistake.
		await fs.promises.writeFile(target, contents, { encoding: 'utf8', flag: 'wx' });
	} catch (error) {
		void vscode.window.showErrorMessage(`DreamFXLang: could not create ${target}. ${String(error)}`);
		return;
	}

	const document = await vscode.workspace.openTextDocument(target);
	await vscode.window.showTextDocument(document);
}

async function pickTemplate(): Promise<TemplateChoice | undefined> {
	const picked = await vscode.window.showQuickPick(
		TEMPLATE_CHOICES.map((choice) => ({ label: choice.label, detail: choice.description, choice })),
		{ title: 'New DreamFXLang source', placeHolder: 'What should this file produce?' });
	return picked?.choice;
}

/**
 * Finds the `DFX/` directory the new file belongs in.
 *
 * The active file's own DFX root wins, because that is the one being worked in. Otherwise every
 * workspace folder is offered its DFX directory -- the generated workspace lists the project and
 * each plugin as separate folders, so "which DFX" is a real question with several right answers.
 */
async function pickDfxRoot(): Promise<string | undefined> {
	const active = vscode.window.activeTextEditor?.document;
	if (active && active.uri.scheme === 'file') {
		const fromActive = enclosingDfxRoot(active.uri.fsPath);
		if (fromActive) {
			return fromActive;
		}
	}

	const folders = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file');
	if (folders.length === 0) {
		void vscode.window.showErrorMessage('DreamFXLang: open a folder first -- a new source needs a DFX root to live in.');
		return undefined;
	}

	const candidates = folders.map((folder) => ({
		label: folder.name,
		description: path.join(folder.uri.fsPath, 'DFX'),
		root: path.join(folder.uri.fsPath, 'DFX'),
	}));

	if (candidates.length === 1) {
		return candidates[0].root;
	}

	const picked = await vscode.window.showQuickPick(candidates, {
		title: 'New DreamFXLang source',
		placeHolder: 'Which DFX root?',
	});
	return picked?.root;
}

function enclosingDfxRoot(filePath: string): string | undefined {
	const parts = filePath.split(/[\\/]/);
	const index = parts.findIndex((part) => part === 'DFX');
	if (index === -1) {
		return undefined;
	}
	return parts.slice(0, index + 1).join(path.sep);
}

/**
 * `Plugin.<Name>` when the root sits inside a plugin, `Game` otherwise -- read off the path, which
 * is the same rule the plugin's own source roots use.
 */
function suggestRootToken(dfxRoot: string): string {
	const parts = dfxRoot.split(/[\\/]/);
	const pluginsIndex = parts.lastIndexOf('Plugins');
	if (pluginsIndex !== -1 && pluginsIndex + 1 < parts.length) {
		return `Plugin.${parts[pluginsIndex + 1]}`;
	}
	return 'Game';
}
