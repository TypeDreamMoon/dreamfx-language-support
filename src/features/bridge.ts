/**
 * The client half of the editor bridge.
 *
 * What it buys is not speed, though it is much faster. `dfx build` writes packages and so does a
 * running editor; when both save the same package the later save silently wins. Before the bridge,
 * "the editor is open" -- the most common state there is -- meant there was no safe way to build
 * from here at all. Routing the work into the editor process removes the second writer.
 *
 * Hence the routing rule in `route()`: when an editor is answering, the bridge is not merely
 * preferred, it is the only correct choice.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
	BridgeAction,
	BridgeResponse,
	BridgeStatus,
	Liveness,
	bridgePaths,
	buildRequest,
	canServe,
	livenessOf,
	makeRequestId,
	parseResponse,
	parseStatus,
} from '../core';

/** How often to look for the response file. Well under the editor's own poll, so it is not the floor. */
const RESPONSE_POLL_MS = 120;

/** Default ceiling for a request. Long, because the answer to "build this" can legitimately take it. */
const DEFAULT_TIMEOUT_MS = 180_000;

export interface BridgeSendResult {
	response?: BridgeResponse;
	error?: string;
}

export class BridgeClient {
	constructor(private readonly output: vscode.OutputChannel) {}

	/**
	 * The project root for a source file: the nearest ancestor holding a `.uproject`.
	 *
	 * The same walk `dfx.ps1` does, and it has to be the same answer -- the bridge directory hangs off
	 * the project, so disagreeing about which project a file belongs to means writing requests
	 * somewhere no editor is reading.
	 */
	findProjectDir(fromPath: string): string | undefined {
		let directory = fs.existsSync(fromPath) && fs.statSync(fromPath).isDirectory()
			? fromPath
			: path.dirname(fromPath);

		for (;;) {
			try {
				if (fs.readdirSync(directory).some((entry) => entry.toLowerCase().endsWith('.uproject'))) {
					return directory;
				}
			} catch {
				return undefined;
			}
			const parent = path.dirname(directory);
			if (parent === directory) {
				return undefined;
			}
			directory = parent;
		}
	}

	readStatus(projectDir: string): BridgeStatus | undefined {
		const paths = bridgePaths(projectDir, path.join);
		try {
			return parseStatus(fs.readFileSync(paths.status, 'utf8'));
		} catch {
			return undefined;
		}
	}

	liveness(projectDir: string): Liveness {
		return livenessOf(this.readStatus(projectDir), Date.now(), isProcessAlive);
	}

	/**
	 * Where a piece of work should run.
	 *
	 * Not a preference. See the class comment: with an editor open, the CLI is not a slower way to do
	 * the same thing, it is a way to lose work.
	 */
	route(projectDir: string): 'bridge' | 'cli' {
		return canServe(this.liveness(projectDir)) ? 'bridge' : 'cli';
	}

	async send(
		projectDir: string,
		action: BridgeAction,
		extra: { scope?: 'file' | 'all'; sourceFile?: string; assetPath?: string; outputPath?: string } = {},
		timeoutMs: number = DEFAULT_TIMEOUT_MS,
		token?: vscode.CancellationToken,
	): Promise<BridgeSendResult> {
		const paths = bridgePaths(projectDir, path.join);
		const requestId = makeRequestId(Date.now());
		const request = buildRequest(requestId, action, extra);

		try {
			fs.mkdirSync(paths.requests, { recursive: true });
		} catch (error) {
			return { error: `Could not create the bridge directory: ${String(error)}` };
		}

		// Written beside the target and renamed, never in place. The editor polls for *.json and reads
		// whatever it finds, so a file that exists while it is still half-written is a request it will
		// pick up and reject -- rarely, and only under load.
		const target = path.join(paths.requests, `request-${requestId}.json`);
		const temporary = `${target}.tmp`;
		try {
			fs.writeFileSync(temporary, JSON.stringify(request, undefined, 2), 'utf8');
			fs.renameSync(temporary, target);
		} catch (error) {
			try { fs.unlinkSync(temporary); } catch { /* nothing to clean up */ }
			return { error: `Could not write the bridge request: ${String(error)}` };
		}

		this.output.appendLine(`bridge -> ${action}${extra.scope ? ` (${extra.scope})` : ''} [${requestId}]`);

		const responsePath = path.join(paths.responses, `${requestId}.json`);
		const deadline = Date.now() + timeoutMs;

		for (;;) {
			if (token?.isCancellationRequested) {
				// The request is left where it is: the editor may already be executing it, and deleting
				// the file would not stop that -- it would only lose the answer.
				return { error: 'Cancelled. The editor may still be working on it.' };
			}

			try {
				const text = fs.readFileSync(responsePath, 'utf8');
				const response = parseResponse(text);
				if (response) {
					try { fs.unlinkSync(responsePath); } catch { /* another reader got there first */ }
					this.output.appendLine(
						`bridge <- ${response.ok ? 'ok' : 'failed'} in ${response.durationMs} ms: ${response.message}`);
					return { response };
				}
				// Present but unreadable. The editor renames into place, so this should not happen;
				// treated as "not yet" rather than an error, and the timeout still applies.
			} catch {
				// Not there yet.
			}

			if (Date.now() > deadline) {
				const state = this.liveness(projectDir);
				return {
					error: state === 'closed'
						? 'The editor closed while the request was waiting.'
						: `No response after ${Math.round(timeoutMs / 1000)}s (editor is ${state}).`,
				};
			}

			await new Promise((resolve) => setTimeout(resolve, RESPONSE_POLL_MS));
		}
	}

	describe(projectDir: string): string {
		const status = this.readStatus(projectDir);
		const state = livenessOf(status, Date.now(), isProcessAlive);
		if (!status || state === 'closed') {
			return 'Editor not running — commands will use the dfx CLI.';
		}
		if (state === 'stale') {
			return `Editor stopped responding (last heartbeat ${status.heartbeatUtc}) — commands will use the dfx CLI.`;
		}
		const busy = status.busy ? ` — busy: ${status.busyAction ?? 'working'}` : '';
		return `Editor connected: ${status.project} (plugin ${status.pluginVersion}, pid ${status.pid})${busy}`;
	}
}

/**
 * Does that process still exist?
 *
 * Signal 0 performs the permission and existence checks without delivering anything. EPERM means it
 * exists and belongs to someone else, which is still "exists" -- and the editor could legitimately be
 * running elevated when VSCode is not.
 */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}
