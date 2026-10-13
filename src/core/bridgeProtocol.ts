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
	| 'refreshIndex'
	| 'pull';

export interface BridgeRequest {
	protocol: number;
	requestId: string;
	action: BridgeAction;
	scope?: 'file' | 'all';
	sourceFile?: string;
	assetPath?: string;
	outputPath?: string;
	/** pull: the buffer the client is looking at. With it the editor answers with new text and writes no file. */
	text?: string;
	/** pull: also carry structural differences (added and removed lines), not just literal values. */
	structure?: boolean;
	/**
	 * pull: the client is about to apply the returned text, so the editor should record what the
	 * asset held as its baseline. A preview sends false -- a preview that moved the baseline would
	 * make the real pull come back empty.
	 */
	apply?: boolean;
}

/** What a caller may add to a request; the envelope fields are the protocol's own. */
export type BridgeRequestExtra = Omit<Partial<BridgeRequest>, 'protocol' | 'requestId' | 'action'>;

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
	/** Present on the answer to a `pull` that got as far as reading the asset. */
	pull?: PullResult;
}

/** The `pull` half of a response. Counts are of literals unless the name says otherwise. */
export interface PullResult {
	changed: boolean;
	/** The full text with the asset's values spliced in. Present when `changed`. */
	newText?: string;
	edits: number;
	compared: number;
	changedValues: number;
	/** The asset stores a value the text does not declare (DFX7106); not written. */
	undeclared: number;
	/** A value that cannot be written as a literal (DFX7111). */
	unwritable: number;
	/** A stack that cannot be addressed (DFX7109). */
	unaddressable: number;
	/** The text is newer than the asset (DFX7115); left alone. */
	withheld: number;
	added: number;
	removed: number;
	/** Structural differences found while the structure switch was off (DFX7113). */
	structureRefused: number;
	baselineUsed: boolean;
	baselineWritten: boolean;
	wroteFile: boolean;
	reportPath: string;
	report: string[];
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
	extra: BridgeRequestExtra = {},
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
		pull: parsePullResult(candidate.pull),
	};
}

/**
 * Narrows the `pull` field of a response, or returns undefined when it is absent or unusable.
 *
 * Strict where acting on a wrong answer would hurt, lenient where it would not: `changed` must be a
 * boolean, and a `changed` result without its text is rejected because the caller would have
 * nothing to apply -- while a missing counter is just zero, so an editor that grows a new count
 * does not break an older client and the reverse.
 */
export function parsePullResult(value: unknown): PullResult | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.changed !== 'boolean') {
		return undefined;
	}
	const newText = typeof candidate.newText === 'string' ? candidate.newText : undefined;
	if (candidate.changed && newText === undefined) {
		return undefined;
	}

	const count = (key: string): number => {
		const field = candidate[key];
		return typeof field === 'number' && Number.isFinite(field) && field >= 0 ? Math.floor(field) : 0;
	};
	const flag = (key: string): boolean => candidate[key] === true;

	return {
		changed: candidate.changed,
		newText: candidate.changed ? newText : undefined,
		edits: count('edits'),
		compared: count('compared'),
		changedValues: count('changedValues'),
		undeclared: count('undeclared'),
		unwritable: count('unwritable'),
		unaddressable: count('unaddressable'),
		withheld: count('withheld'),
		added: count('added'),
		removed: count('removed'),
		structureRefused: count('structureRefused'),
		baselineUsed: flag('baselineUsed'),
		baselineWritten: flag('baselineWritten'),
		wroteFile: flag('wroteFile'),
		reportPath: typeof candidate.reportPath === 'string' ? candidate.reportPath : '',
		report: Array.isArray(candidate.report) ? candidate.report.filter((line): line is string => typeof line === 'string') : [],
	};
}

/**
 * An editor built before `pull` existed answers it with `ok: false` and a message naming the
 * action. Recognised by that wording, which is all such a build offers -- there is no version field
 * in a refusal.
 */
export function isUnknownActionResponse(response: BridgeResponse, action: BridgeAction): boolean {
	// Quotes and spacing are not part of the claim, so they are folded away before looking.
	const folded = response.message.toLowerCase().replace(/[\s'"‘’]+/g, ' ');
	return !response.ok && folded.includes(`unknown action ${action}`);
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
