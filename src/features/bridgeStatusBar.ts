/**
 * Which route the next command will take, visible without having to ask.
 *
 * It matters more than a connection indicator usually would: the two routes are not fast and slow
 * versions of the same thing. With an editor open, running `dfx build` from here means two processes
 * saving the same packages and the later save silently winning. Seeing "editor connected" is what
 * tells you the build is going somewhere safe.
 */

import * as vscode from 'vscode';

import { BridgeClient } from './bridge';

const POLL_MS = 4000;

export class BridgeStatusBar implements vscode.Disposable {
	private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	private readonly timer: NodeJS.Timeout;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly bridge: BridgeClient) {
		this.item.command = 'dreamfx.bridgeStatus';
		this.timer = setInterval(() => this.refresh(), POLL_MS);
		this.disposables.push(
			vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
		);
		this.refresh();
	}

	dispose(): void {
		clearInterval(this.timer);
		this.item.dispose();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	/** The project the status bar is describing, or undefined when the active file is not ours. */
	private activeProject(): string | undefined {
		const document = vscode.window.activeTextEditor?.document;
		if (!document || document.languageId !== 'dreamfxlang' || document.uri.scheme !== 'file') {
			return undefined;
		}
		return this.bridge.findProjectDir(document.uri.fsPath);
	}

	refresh(): void {
		const projectDir = this.activeProject();
		if (!projectDir) {
			this.item.hide();
			return;
		}

		const state = this.bridge.liveness(projectDir);
		const status = this.bridge.readStatus(projectDir);

		switch (state) {
			case 'alive':
				this.item.text = `$(plug) DreamFX: ${status?.project ?? 'editor'}`;
				break;
			case 'busy':
				this.item.text = `$(sync~spin) DreamFX: ${status?.busyAction ?? 'working'}`;
				break;
			case 'stale':
				this.item.text = '$(warning) DreamFX: editor not responding';
				break;
			default:
				this.item.text = '$(debug-disconnect) DreamFX: CLI';
				break;
		}

		this.item.tooltip = this.bridge.describe(projectDir);
		this.item.show();
	}
}
