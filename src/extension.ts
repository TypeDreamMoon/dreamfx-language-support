/**
 * DreamFXLang language support.
 *
 * Scope, deliberately: everything here is either purely lexical, a wrapper around the plugin's own
 * CLI, or a reader of the index that CLI exports. No semantic knowledge is duplicated -- see the
 * note at the top of features/diagnostics.ts for why that boundary is where it is.
 */

import * as vscode from 'vscode';

import { DreamFXCompletionProvider, DreamFXHoverProvider } from './features/completion';
import { DfxCommand, DfxRunner, DfxScope, DfxTaskProvider, TASK_TYPE, activeSourceDocument } from './features/dfx';
import { SyntaxDiagnostics } from './features/diagnostics';
import { SchemaIndexCache, describeIndex } from './features/indexCache';
import { newSourceFile } from './features/newFile';
import { DreamFXDocumentSymbolProvider } from './features/symbols';
import { VerifyOnSave } from './features/verifyOnSave';

const LANGUAGE_SELECTOR: vscode.DocumentSelector = { language: 'dreamfxlang' };

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('DreamFXLang');
	context.subscriptions.push(output);

	const runner = new DfxRunner(output);
	const indexCache = new SchemaIndexCache(output);
	const verifier = new VerifyOnSave(runner, output);
	context.subscriptions.push(indexCache, verifier);

	context.subscriptions.push(
		vscode.languages.registerDocumentSymbolProvider(LANGUAGE_SELECTOR, new DreamFXDocumentSymbolProvider()),
		new SyntaxDiagnostics(),
		vscode.tasks.registerTaskProvider(TASK_TYPE, new DfxTaskProvider(runner)),
		// '.' so `User.` offers nothing surprising, '(' and ',' so an argument list keeps offering
		// input names without a retrigger, '=' so a value position offers enum entries immediately.
		vscode.languages.registerCompletionItemProvider(
			LANGUAGE_SELECTOR, new DreamFXCompletionProvider(indexCache), '(', ',', '=', ' '),
		vscode.languages.registerHoverProvider(LANGUAGE_SELECTOR, new DreamFXHoverProvider(indexCache)),
	);

	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	status.command = 'dreamfx.refreshIndex';
	context.subscriptions.push(status, indexCache.onDidChange(() => updateStatus()));

	const updateStatus = (): void => {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.languageId !== 'dreamfxlang') {
			status.hide();
			return;
		}
		const state = indexCache.current;
		status.text = state.index ? `$(symbol-module) DreamFX: ${describeIndex(state)}` : '$(warning) DreamFX: no index';
		status.tooltip = state.index
			? `${describeIndex(state)}\nGenerated ${state.index.source.generatedUtc}\nClick to rebuild (boots the engine).`
			: `${state.problem ?? 'no index'}\nClick to build one (boots the engine).`;
		status.show();
	};

	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => updateStatus()));
	updateStatus();

	const run = async (command: DfxCommand, scope: DfxScope): Promise<void> => {
		if (!await runner.confirmIfWriting(command)) {
			return;
		}

		const document = activeSourceDocument();
		if (scope === 'file' && document && document.isDirty) {
			// dfx reads the file from disk, so an unsaved buffer would be verified in its previous
			// state -- a green result for text that is not what is on screen.
			await document.save();
		}

		const task = await runner.createTask({ type: TASK_TYPE, command, scope }, document);
		if (task) {
			await vscode.tasks.executeTask(task);
		}
	};

	const refreshIndex = async (): Promise<void> => {
		const destination = await indexCache.indexDestination();
		if (!destination) {
			void vscode.window.showErrorMessage('DreamFXLang: open a project folder first.');
			return;
		}

		// Reads only -- no packages are written, so this is safe with the editor open. It still boots
		// the engine, which is why it is a command and never automatic.
		const task = await runner.createIndexTask(destination, activeSourceDocument());
		if (task) {
			await vscode.tasks.executeTask(task);
		}
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('dreamfx.newFile', () => newSourceFile()),
		vscode.commands.registerCommand('dreamfx.verifyFile', () => run('verify', 'file')),
		vscode.commands.registerCommand('dreamfx.verifyAll', () => run('verify', 'all')),
		vscode.commands.registerCommand('dreamfx.lintFile', () => run('lint', 'file')),
		vscode.commands.registerCommand('dreamfx.lintAll', () => run('lint', 'all')),
		vscode.commands.registerCommand('dreamfx.buildFile', () => run('build', 'file')),
		vscode.commands.registerCommand('dreamfx.buildAll', () => run('build', 'all')),
		vscode.commands.registerCommand('dreamfx.refreshIndex', () => refreshIndex()),
		// The quiet form of verify: no terminal, results straight into Problems. The task-based
		// `verifyFile` stays, because when a run misbehaves you want to see it happen.
		vscode.commands.registerCommand('dreamfx.verifyFileNow', async () => {
			const document = activeSourceDocument();
			if (!document || document.uri.scheme !== 'file') {
				void vscode.window.showErrorMessage('DreamFXLang: open a .dfs/.dfe/.dfm file first.');
				return;
			}
			if (document.isDirty) {
				await document.save();
			}
			verifier.enqueue(document.uri.fsPath);
		}),
		vscode.commands.registerCommand('dreamfx.showOutput', () => output.show(true)),
	);
}

export function deactivate(): void {
	// Everything is registered through context.subscriptions.
}
