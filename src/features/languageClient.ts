/**
 * The client half: starting the server, and the one piece of UI that reports on it.
 *
 * The status bar lives here rather than in `extension.ts` because it is the only editor surface
 * whose whole content comes from the server. Everything else the extension shows -- the bridge
 * indicator, the Problems entries from a `dfx` run -- is about work the client itself did.
 *
 * Note which side decides what. The server knows what the index *is*; the client knows which editor
 * has focus, and therefore which of a workspace's several DFX roots the author means. Neither can
 * answer alone, so the client says what is focused (`dreamfx/activeDocument`) and the server answers
 * with the state for that root (`dreamfx/indexState`). Ageing the timestamp is the client's job for
 * the dull reason that "4m ago" goes stale on a clock tick rather than on an event.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind,
} from 'vscode-languageclient/node';

import {
	ACTIVE_DOCUMENT_NOTIFICATION,
	ActiveDocumentParams,
	INDEX_DESTINATION_REQUEST,
	INDEX_STATE_NOTIFICATION,
	IndexDestinationParams,
	IndexStateParams,
	RELOAD_INDEX_NOTIFICATION,
} from '../lspProtocol';

export const LANGUAGE_ID = 'dreamfxlang';

export class DreamFXLanguageClient implements vscode.Disposable {
	private readonly client: LanguageClient;
	private readonly status: vscode.StatusBarItem;
	private readonly disposables: vscode.Disposable[] = [];
	private state: IndexStateParams = { problem: 'not loaded yet' };

	constructor(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
		const serverModule = context.asAbsolutePath(path.join('out', 'server.js'));
		const serverOptions: ServerOptions = {
			run: { module: serverModule, transport: TransportKind.ipc },
			debug: {
				module: serverModule,
				transport: TransportKind.ipc,
				options: { execArgv: ['--nolazy', '--inspect=6019'] },
			},
		};

		const clientOptions: LanguageClientOptions = {
			// No scheme filter: an untitled buffer is still DreamFXLang, and the lexical half of the
			// server needs nothing from disk to have an opinion about it.
			documentSelector: [{ language: LANGUAGE_ID }],
			// One channel for both halves. A server that logged somewhere else would be a server
			// nobody reads the logs of.
			outputChannel: output,
		};

		this.client = new LanguageClient('dreamfxlang', 'DreamFXLang', serverOptions, clientOptions);

		this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.status.command = 'dreamfx.refreshIndex';

		// Registered before `start`, which the client supports and which matters: the server publishes
		// its first index state as soon as it is asked about a document, and that can be immediately.
		this.disposables.push(
			this.status,
			this.client.onNotification(INDEX_STATE_NOTIFICATION, (state: IndexStateParams) => {
				this.state = state;
				this.render();
			}),
			vscode.window.onDidChangeActiveTextEditor(() => this.announceActiveDocument()),
		);
	}

	async start(): Promise<void> {
		await this.client.start();
		this.announceActiveDocument();
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		void this.client.stop();
	}

	/** Where a `dfx index` run for the focused document should write. */
	async indexDestination(): Promise<string | undefined> {
		const params: IndexDestinationParams = { activeUri: activeSourceUri()?.toString() };
		const destination = await this.client.sendRequest<string | null>(INDEX_DESTINATION_REQUEST, params);
		return destination ?? undefined;
	}

	/**
	 * "An index run just finished."
	 *
	 * The watcher would notice on its own for anything inside a workspace folder, but the destination
	 * is allowed to sit outside one -- it is derived from the focused file's DFX root, which need not
	 * be open as a folder. Saying so explicitly costs a notification and closes that hole.
	 */
	reloadIndex(): void {
		void this.client.sendNotification(RELOAD_INDEX_NOTIFICATION);
	}

	private announceActiveDocument(): void {
		const params: ActiveDocumentParams = { uri: activeSourceUri()?.toString() };
		void this.client.sendNotification(ACTIVE_DOCUMENT_NOTIFICATION, params);
		// The server answers with a fresh state, but the visibility of the bar is the client's call
		// and it should not wait for a round trip to hide.
		this.render();
	}

	private render(): void {
		if (vscode.window.activeTextEditor?.document.languageId !== LANGUAGE_ID) {
			this.status.hide();
			return;
		}

		const summary = describeIndex(this.state);
		if (this.state.loaded) {
			this.status.text = `$(symbol-module) DreamFX: ${summary}`;
			this.status.tooltip = `${summary}\nGenerated ${this.state.loaded.generatedUtc}\nClick to rebuild (boots the engine).`;
		} else {
			this.status.text = '$(warning) DreamFX: no index';
			this.status.tooltip = `${this.state.problem ?? 'no index'}\nClick to build one (boots the engine).`;
		}
		this.status.show();
	}
}

function activeSourceUri(): vscode.Uri | undefined {
	const document = vscode.window.activeTextEditor?.document;
	return document?.languageId === LANGUAGE_ID ? document.uri : undefined;
}

/** A one-line description of the loaded index, for the status bar. */
function describeIndex(state: IndexStateParams): string {
	if (!state.loaded) {
		return state.problem ?? 'no index';
	}
	const generated = Date.parse(state.loaded.generatedUtc);
	const age = Number.isNaN(generated) ? '' : ` · ${describeAge(Date.now() - generated)}`;
	return `${state.loaded.moduleCount} modules${age}`;
}

function describeAge(milliseconds: number): string {
	const minutes = Math.floor(milliseconds / 60000);
	if (minutes < 1) {
		return 'just now';
	}
	if (minutes < 60) {
		return `${minutes}m ago`;
	}
	const hours = Math.floor(minutes / 60);
	return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}
