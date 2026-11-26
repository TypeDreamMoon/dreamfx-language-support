/**
 * "New source file", the command behind the W2 acceptance test: what it creates has to build.
 *
 * The asset name is asked for rather than the file name, because in DreamFX they are the same
 * thing: a source at `DreamSource/FX/Samples/NS_Spark.dfs` declares `Name="Samples/NS_Spark"`, and the plugin's
 * own tree is laid out that way throughout. Asking for the file name and inferring the asset name
 * would let the two drift apart, and the one that decides where the asset lands is the header.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { TEMPLATE_CHOICES, TemplateChoice, enclosingSourceRoot, renderTemplate } from '../core';
import { DreamSourceHost } from './dreamSourceHost';

export async function newSourceFile(host: DreamSourceHost): Promise<void> {
	const choice = await pickTemplate();
	if (!choice) {
		return;
	}

	const root = await pickSourceRoot(host);
	if (!root) {
		return;
	}

	const assetName = await vscode.window.showInputBox({
		title: `New ${choice.label}`,
		prompt: `Asset path under the root. The file lands at ${path.basename(path.dirname(root))}/${path.basename(root)}/<name>${choice.extension}.`,
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
 * Finds the FX source root the new file belongs in.
 *
 * The active file's own root wins, because that is the one being worked in. Otherwise every root of
 * every project the workspace is in is offered -- the project's (the configured DreamSource folder, or
 * a legacy `DFX/` while that is still in use) and each plugin's -- because the generated workspace
 * lists them as separate folders, and "which root" is a real question with several right answers.
 * A project with no source folder yet is offered the configured one, which this creates.
 */
async function pickSourceRoot(host: DreamSourceHost): Promise<string | undefined> {
	const active = vscode.window.activeTextEditor?.document;
	if (active && active.uri.scheme === 'file') {
		const project = host.projectDirFor(active.uri.fsPath);
		const own = project ? enclosingSourceRoot(active.uri.fsPath, host.layout(project).roots) : undefined;
		if (own) {
			return own.directory;
		}
	}

	const projects = host.workspaceProjects();
	if (projects.length === 0) {
		void vscode.window.showErrorMessage(
			'DreamFXLang: no Unreal project (.uproject) found for this window -- a new source needs a project to live in.');
		return undefined;
	}

	const candidates: { label: string; description: string; root: string }[] = [];
	for (const project of projects) {
		const layout = host.layout(project);
		const projectName = path.basename(project);
		candidates.push({
			label: projectName,
			description: layout.project.directory,
			root: layout.project.directory,
		});
		for (const plugin of layout.plugins) {
			candidates.push({ label: `${projectName} · Plugin: ${plugin.plugin}`, description: plugin.directory, root: plugin.directory });
		}
	}

	if (candidates.length === 1) {
		return candidates[0].root;
	}

	const picked = await vscode.window.showQuickPick(candidates, {
		title: 'New DreamFXLang source',
		placeHolder: 'Which source root?',
	});
	return picked?.root;
}

/**
 * `Plugin.<Name>` when the root sits inside a plugin, `Game` otherwise -- read off the path, which
 * is the same rule the plugin's own source roots use.
 */
function suggestRootToken(sourceRoot: string): string {
	const parts = sourceRoot.split(/[\\/]/);
	const pluginsIndex = parts.lastIndexOf('Plugins');
	if (pluginsIndex !== -1 && pluginsIndex + 1 < parts.length) {
		return `Plugin.${parts[pluginsIndex + 1]}`;
	}
	return 'Game';
}
