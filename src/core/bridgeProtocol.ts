/**
 * The drop-folder protocol shared with the Unreal Editor side.
 *
 * Kept in core, away from anything that imports `vscode`, for the same reason the rest of core is:
 * it is the half of the contract this side owns, and it is the half worth testing without an editor
 * at either end. Everything here has a counterpart in `DreamFXBridgeService.cpp`; when one changes,
 * `PROTOCOL_VERSION` changes with it, and a mismatched pair says so instead of misreading each other.
 */

export const PROTOCOL_VERSION = 1;

export type BridgeAction =
	| 'ping'
	| 'build'
	| 'verify'
	| 'decompile'
	| 'adopt'
	| 'openAsset'
	| 'revealSource'
	| 'refreshIndex';

export interface BridgeRequest {
	protocol: number;
	requestId: string;
	action: BridgeAction;
	scope?: 'file' | 'all';
	sourceFile?: string;
	assetPath?: string;
	outputPath?: string;
}

export interface BridgeDiagnostic {
	file: string;
	line: number;
	column: number;
	severity: 'error' | 'warning' | 'info';
	code: string;
	message: string;
}

export interface BridgeResponse {
	protocol: number;
	requestId: string;
	ok: boolean;
	durationMs: number;
	message: string;
	diagnostics: BridgeDiagnostic[];
}

export interface BridgeStatus {
	protocol: number;
	pid: number;
	project: string;
	projectDir: string;
	engineDir: string;
	pluginVersion: string;
	busy: boolean;
	busyAction?: string;
	lastResult?: string;
	heartbeatUtc: string;
}

export interface BridgePaths {
	root: string;
	requests: string;
	responses: string;
	status: string;
	diagnostics: string;
}

/** Everything lives under Saved/, which is already outside version control. */
export function bridgePaths(projectDir: string, join: (...parts: string[]) => string): BridgePaths {
	const root = join(projectDir, 'Saved', 'DreamFX', 'Bridge');
	return {
		root,
		requests: join(root, 'Requests'),
		responses: join(root, 'Responses'),
		status: join(root, 'status.json'),
		diagnostics: join(root, 'diagnostics.json'),
	};
}

/**
 * Idle heartbeat budget. The editor rewrites the file every two seconds, so anything inside this is
 * comfortably alive and anything past it has stopped ticking.
 */
export const HEARTBEAT_STALE_MS = 15_000;

/**
 * Busy budget. A build blocks the game thread, which stops the heartbeat with it -- so while an
 * action is running, silence is expected rather than suspicious. It still has to end somewhere: an
 * editor that crashed mid-build leaves `busy: true` behind forever, and without a ceiling the client
 * would wait on a corpse indefinitely.
 */
export const BUSY_STALE_MS = 15 * 60_000;

export type Liveness = 'alive' | 'busy' | 'stale' | 'closed';

/**
 * Is there an editor on the other end?
 *
 * Two independent signals, and the pid is the stronger one: a timestamp only says when the editor
 * last *chose* to write, while a pid that no longer exists is proof. Neither is used alone -- pids
 * get recycled, so a live pid is treated as necessary rather than sufficient, and the heartbeat still
 * has to be recent.
 *
 * `isProcessAlive` is injected so this stays testable and platform-free.
 */
export function livenessOf(
	status: BridgeStatus | undefined,
	nowMs: number,
	isProcessAlive: (pid: number) => boolean,
): Liveness {
	if (!status) {
		// No file at all: the editor either never ran or removed it on the way out. Either way there
		// is nothing to talk to, and the caller should go straight to the CLI rather than time out.
		return 'closed';
	}

	if (status.protocol !== PROTOCOL_VERSION) {
		return 'stale';
	}

	if (Number.isFinite(status.pid) && status.pid > 0 && !isProcessAlive(status.pid)) {
		return 'closed';
	}

	const beat = Date.parse(status.heartbeatUtc);
	if (!Number.isFinite(beat)) {
		return 'stale';
	}

	const age = nowMs - beat;
	if (status.busy) {
		return age < BUSY_STALE_MS ? 'busy' : 'stale';
	}
	return age < HEARTBEAT_STALE_MS ? 'alive' : 'stale';
}

/** Whether a request can be sent, as opposed to falling back to the CLI. */
export function canServe(liveness: Liveness): boolean {
	return liveness === 'alive' || liveness === 'busy';
}

/**
 * Request file names sort oldest-first as plain strings, which is what lets the editor drain them in
 * the order they were sent with a sort rather than a guess. The counter disambiguates two requests
 * inside the same millisecond.
 */
let sequence = 0;

export function makeRequestId(nowMs: number, random: () => number = Math.random): string {
	sequence = (sequence + 1) % 1000;
	const stamp = new Date(nowMs).toISOString().replace(/[-:.TZ]/g, '');
	const salt = Math.floor(random() * 0xffff).toString(16).padStart(4, '0');
	return `${stamp}-${String(sequence).padStart(3, '0')}-${salt}`;
}

export function buildRequest(
	requestId: string,
	action: BridgeAction,
	extra: Omit<Partial<BridgeRequest>, 'protocol' | 'requestId' | 'action'> = {},
): BridgeRequest {
	return { protocol: PROTOCOL_VERSION, requestId, action, ...extra };
}

/** Narrows unknown JSON to a response, so a truncated or foreign file is rejected rather than used. */
export function parseResponse(text: string): BridgeResponse | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const candidate = value as Partial<BridgeResponse>;
	if (typeof candidate.requestId !== 'string' || typeof candidate.ok !== 'boolean') {
		return undefined;
	}
	return {
		protocol: typeof candidate.protocol === 'number' ? candidate.protocol : 0,
		requestId: candidate.requestId,
		ok: candidate.ok,
		durationMs: typeof candidate.durationMs === 'number' ? candidate.durationMs : 0,
		message: typeof candidate.message === 'string' ? candidate.message : '',
		diagnostics: Array.isArray(candidate.diagnostics) ? candidate.diagnostics : [],
	};
}

export function parseStatus(text: string): BridgeStatus | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const candidate = value as Partial<BridgeStatus>;
	if (typeof candidate.heartbeatUtc !== 'string') {
		return undefined;
	}
	return {
		protocol: typeof candidate.protocol === 'number' ? candidate.protocol : 0,
		pid: typeof candidate.pid === 'number' ? candidate.pid : 0,
		project: candidate.project ?? '',
		projectDir: candidate.projectDir ?? '',
		engineDir: candidate.engineDir ?? '',
		pluginVersion: candidate.pluginVersion ?? '',
		busy: candidate.busy === true,
		busyAction: candidate.busyAction,
		lastResult: candidate.lastResult,
		heartbeatUtc: candidate.heartbeatUtc,
	};
}
