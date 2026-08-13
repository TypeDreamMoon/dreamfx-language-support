/**
 * DreamFXLang language support.
 *
 * Scope, deliberately: everything here is either purely lexical or a wrapper around the plugin's own
 * CLI. No semantic knowledge is duplicated -- see the note at the top of features/diagnostics.ts for
 * why that boundary is where it is.
 */

import * as vscode from 'vscode';

import { DfxCommand, DfxRunner, DfxScope, DfxTaskProvider, TASK_TYPE, activeSourceDocument } from './features/dfx';
import { SyntaxDiagnostics } from './features/diagnostics';
import { newSourceFile } from './features/newFile';
import { DreamFXDocumentSymbolProvider } from './features/symbols';

const LANGUAGE_SELECTOR: vscode.DocumentSelector = { language: 'dreamfxlang' };

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('DreamFXLang');
	context.subscriptions.push(output);

	const runner = new DfxRunner(output);

	context.subscriptions.push(
		vscode.languages.registerDocumentSymbolProvider(LANGUAGE_SELECTOR, new DreamFXDocumentSymbolProvider()),
		new SyntaxDiagnostics(),
		vscode.tasks.registerTaskProvider(TASK_TYPE, new DfxTaskProvider(runner)),
	);

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

	context.subscriptions.push(
		vscode.commands.registerCommand('dreamfx.newFile', () => newSourceFile()),
		vscode.commands.registerCommand('dreamfx.verifyFile', () => run('verify', 'file')),
		vscode.commands.registerCommand('dreamfx.verifyAll', () => run('verify', 'all')),
		vscode.commands.registerCommand('dreamfx.lintFile', () => run('lint', 'file')),
		vscode.commands.registerCommand('dreamfx.lintAll', () => run('lint', 'all')),
		vscode.commands.registerCommand('dreamfx.buildFile', () => run('build', 'file')),
		vscode.commands.registerCommand('dreamfx.buildAll', () => run('build', 'all')),
		vscode.commands.registerCommand('dreamfx.showOutput', () => output.show(true)),
	);
}

export function deactivate(): void {
	// Everything is registered through context.subscriptions.
}
