/**
 * DreamFXLang language support: the client half.
 *
 * Scope, deliberately: everything here is a wrapper around the plugin's own CLI, or a conversation
 * with a running Unreal Editor. The language itself -- completion, hover, outline, syntax
 * diagnostics, and the module index they all read -- lives in the server next door, and the split is
 * not cosmetic. See the note at the top of `core/index.ts` for why the language knowledge was kept
 * editor-agnostic in the first place, and `server/diagnostics.ts` for why the squiggles are owned in
 * two places on purpose.
 */

import * as path from 'path';
import * as vscode from 'vscode';

import { readDocumentHeader } from './core';
import { DfxCommand, DfxRunner, DfxScope, DfxTaskProvider, TASK_TYPE, activeSourceDocument } from './features/dfx';
import { BridgeClient } from './features/bridge';
import { BridgeStatusBar } from './features/bridgeStatusBar';
import { DreamFXLanguageClient } from './features/languageClient';
import { newSourceFile } from './features/newFile';
import { ProblemSink } from './features/problemSink';
import { VerifyOnSave } from './features/verifyOnSave';

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('DreamFXLang');
	context.subscriptions.push(output);

	const runner = new DfxRunner(output);
	const bridge = new BridgeClient(output);
	const problems = new ProblemSink();
	const verifier = new VerifyOnSave(runner, bridge, problems, output);
	const bridgeStatusBar = new BridgeStatusBar(bridge);
	const language = new DreamFXLanguageClient(context, output);
	context.subscriptions.push(problems, verifier, bridgeStatusBar, language);

	context.subscriptions.push(
		vscode.tasks.registerTaskProvider(TASK_TYPE, new DfxTaskProvider(runner)),
		// The index lands on disk minutes after the command was issued, and the server's watcher only
		// covers files inside a workspace folder -- which the destination need not be. Saying so
		// directly is cheaper than widening the watch.
		vscode.tasks.onDidEndTask((event) => {
			const definition = event.execution.task.definition;
			if (definition.type === TASK_TYPE && definition.command === 'index') {
				language.reloadIndex();
			}
		}),
	);

	// Not awaited: a server that failed to start should cost completions, not the build button.
	void language.start().catch((error: unknown) => {
		output.appendLine(`language server: failed to start -- ${String(error)}`);
		void vscode.window.showErrorMessage(
			'DreamFXLang: the language server did not start, so completion and syntax diagnostics are off.',
			'Show Output',
		).then((choice) => {
			if (choice === 'Show Output') {
				output.show(true);
			}
		});
	});

	/**
	 * Runs a command through the editor when one is listening, and through the CLI otherwise.
	 *
	 * Not an optimisation. `build` writes packages and so does a running editor; when both save the
	 * same package the later save silently wins. With an editor up, the bridge is the only correct
	 * route -- which is also why the write-conflict warning is skipped on it: there is no second
	 * writer to warn about. It is still asked before a CLI build, where the hazard is real.
	 *
	 * `lint` stays on the CLI: the bridge has no lint action, and inventing one that fell back
	 * silently would make the two routes disagree about what was checked.
	 */
	const run = async (command: DfxCommand, scope: DfxScope): Promise<void> => {
		const document = activeSourceDocument();

		if (scope === 'file' && document && document.isDirty) {
			// dfx and the editor both read the file from disk, so an unsaved buffer would be checked in
			// its previous state -- a green result for text that is not what is on screen.
			await document.save();
		}

		const projectDir = document && document.uri.scheme === 'file'
			? bridge.findProjectDir(document.uri.fsPath)
			: undefined;

		if ((command === 'build' || command === 'verify') && projectDir && bridge.route(projectDir) === 'bridge') {
			if (scope === 'file' && !document) {
				void vscode.window.showErrorMessage('DreamFXLang: open a .dfs/.dfe/.dfm file first.');
				return;
			}

			const label = `${command} ${scope === 'all' ? '(all sources)' : path.basename(document!.uri.fsPath)}`;
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Window, title: `DreamFX: ${label} in the editor` },
				async () => {
					const { response, error } = await bridge.send(projectDir, command, {
						scope,
						sourceFile: scope === 'file' ? document!.uri.fsPath : undefined,
					});

					if (!response) {
						// Said out loud rather than falling through quietly: the editor was there and did
						// not answer, and the CLI route about to run has a real hazard the bridge did not.
						void vscode.window.showWarningMessage(`DreamFXLang: the editor did not answer (${error}).`);
						return;
					}

					const count = scope === 'file'
						? problems.publish(document!.uri.fsPath, response.diagnostics, `dfx ${command} (editor)`)
						: response.diagnostics.length;

					const summary = `${response.message} (${response.durationMs} ms${count ? `, ${count} diagnostic(s)` : ''})`;
					if (response.ok) {
						void vscode.window.setStatusBarMessage(`DreamFX: ${summary}`, 6000);
					} else {
						void vscode.window.showErrorMessage(`DreamFXLang: ${summary}`, 'Show Problems')
							.then((choice) => {
								if (choice === 'Show Problems') {
									void vscode.commands.executeCommand('workbench.actions.view.problems');
								}
							});
					}
					bridgeStatusBar.refresh();
				});
			return;
		}

		if (!await runner.confirmIfWriting(command)) {
			return;
		}

		const task = await runner.createTask({ type: TASK_TYPE, command, scope }, document);
		if (task) {
			await vscode.tasks.executeTask(task);
		}
	};

	/** An action that names an asset rather than a source file. Bridge only -- the CLI cannot open a window. */
	const assetAction = async (action: 'openAsset' | 'revealSource' | 'decompile' | 'adopt'): Promise<void> => {
		const document = activeSourceDocument();
		if (!document || document.uri.scheme !== 'file') {
			void vscode.window.showErrorMessage('DreamFXLang: open a .dfs/.dfe/.dfm file first.');
			return;
		}

		const projectDir = bridge.findProjectDir(document.uri.fsPath);
		if (!projectDir || bridge.route(projectDir) !== 'bridge') {
			void vscode.window.showWarningMessage(
				'DreamFXLang: this needs the Unreal Editor running — it acts on an open editor, not on files.');
			return;
		}

		const header = readDocumentHeader(document.getText());
		if (!header) {
			void vscode.window.showErrorMessage('DreamFXLang: could not read the document header, so there is no asset to name.');
			return;
		}
		if (!header.producesAsset) {
			// A .dfe is copied into whichever system references it (R3); there is no asset of its own.
			void vscode.window.showInformationMessage(
				`DreamFXLang: a .dfe generates no asset of its own — open the system that references '${header.name}'.`);
			return;
		}

		const { response, error } = await bridge.send(projectDir, action, { assetPath: header.objectPath }, 120_000);
		if (!response) {
			void vscode.window.showErrorMessage(`DreamFXLang: ${error}`);
			return;
		}
		if (response.ok) {
			void vscode.window.setStatusBarMessage(`DreamFX: ${response.message}`, 6000);
		} else {
			void vscode.window.showErrorMessage(`DreamFXLang: ${response.message}`);
		}
		bridgeStatusBar.refresh();
	};

	const refreshIndex = async (): Promise<void> => {
		const destination = await language.indexDestination();
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
		vscode.commands.registerCommand('dreamfx.openAsset', () => assetAction('openAsset')),
		vscode.commands.registerCommand('dreamfx.decompileAsset', () => assetAction('decompile')),
		vscode.commands.registerCommand('dreamfx.adoptAsset', () => assetAction('adopt')),
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
		vscode.commands.registerCommand('dreamfx.bridgeStatus', async () => {
			const document = activeSourceDocument();
			const projectDir = document && document.uri.scheme === 'file'
				? bridge.findProjectDir(document.uri.fsPath)
				: undefined;
			if (!projectDir) {
				void vscode.window.showInformationMessage('DreamFXLang: open a source file inside an Unreal project first.');
				return;
			}
			bridgeStatusBar.refresh();
			const choice = await vscode.window.showInformationMessage(
				bridge.describe(projectDir), 'Ping editor', 'Show output');
			if (choice === 'Show output') {
				output.show(true);
			} else if (choice === 'Ping editor') {
				const { response, error } = await bridge.send(projectDir, 'ping', {}, 5000);
				void vscode.window.showInformationMessage(
					response ? `Editor answered in ${response.durationMs} ms.` : `No answer: ${error}`);
				bridgeStatusBar.refresh();
			}
		}),
		vscode.commands.registerCommand('dreamfx.showOutput', () => output.show(true)),
	);
}

export function deactivate(): void {
	// Everything is registered through context.subscriptions.
}
