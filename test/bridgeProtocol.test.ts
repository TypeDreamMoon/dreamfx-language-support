import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';

import {
	BUSY_STALE_MS,
	HEARTBEAT_STALE_MS,
	PROTOCOL_VERSION,
	bridgePaths,
	buildRequest,
	canServe,
	isUnknownActionResponse,
	livenessOf,
	makeRequestId,
	parsePullResult,
	parseResponse,
	parseStatus,
} from '../src/core/bridgeProtocol';

const NOW = Date.parse('2026-08-13T12:00:00.000Z');
const alwaysAlive = () => true;
const neverAlive = () => false;

function status(overrides: Record<string, unknown> = {}) {
	return {
		protocol: PROTOCOL_VERSION,
		pid: 4242,
		project: 'DevTest',
		projectDir: 'I:/Proj',
		engineDir: 'F:/UE',
		pluginVersion: '1.0.0',
		busy: false,
		heartbeatUtc: new Date(NOW - 1000).toISOString(),
		...overrides,
	} as never;
}

test('no status file means closed, not stale', () => {
	// The distinction decides whether the caller waits: closed goes straight to the CLI, and the
	// editor deletes its status file on shutdown precisely so this is knowable rather than timed out.
	assert.equal(livenessOf(undefined, NOW, alwaysAlive), 'closed');
	assert.equal(canServe('closed'), false);
});

test('a fresh heartbeat with a live pid is alive', () => {
	assert.equal(livenessOf(status(), NOW, alwaysAlive), 'alive');
	assert.equal(canServe('alive'), true);
});

test('a dead pid is closed however fresh the heartbeat looks', () => {
	// The pid is the stronger signal: a timestamp says when the editor last chose to write, a missing
	// process is proof. A crash leaves the last heartbeat behind looking perfectly healthy.
	assert.equal(livenessOf(status(), NOW, neverAlive), 'closed');
});

test('a live pid alone is not enough', () => {
	// Pids get recycled, so a live pid is necessary rather than sufficient.
	const old = status({ heartbeatUtc: new Date(NOW - HEARTBEAT_STALE_MS - 1).toISOString() });
	assert.equal(livenessOf(old, NOW, alwaysAlive), 'stale');
	assert.equal(canServe('stale'), false);
});

test('silence while busy is expected, not suspicious', () => {
	// A build blocks the game thread, which stops the heartbeat with it. Without this the client would
	// declare the editor dead every time it actually did the work that was asked of it.
	const building = status({
		busy: true,
		busyAction: 'build',
		heartbeatUtc: new Date(NOW - HEARTBEAT_STALE_MS * 4).toISOString(),
	});
	assert.equal(livenessOf(building, NOW, alwaysAlive), 'busy');
	assert.equal(canServe('busy'), true);
});

test('busy still has a ceiling', () => {
	// An editor that crashed mid-build leaves busy:true behind forever. Without the ceiling the client
	// would wait on a corpse indefinitely.
	const abandoned = status({ busy: true, heartbeatUtc: new Date(NOW - BUSY_STALE_MS - 1).toISOString() });
	assert.equal(livenessOf(abandoned, NOW, alwaysAlive), 'stale');
});

test('a protocol mismatch is not talked to', () => {
	assert.equal(livenessOf(status({ protocol: PROTOCOL_VERSION + 1 }), NOW, alwaysAlive), 'stale');
});

test('an unparsable heartbeat is stale, not alive', () => {
	assert.equal(livenessOf(status({ heartbeatUtc: 'not a date' }), NOW, alwaysAlive), 'stale');
});

test('the bridge lives under Saved, which is already ignored by git', () => {
	const paths = bridgePaths(path.join('I:', 'Proj'), path.join);
	assert.ok(paths.root.endsWith(path.join('Saved', 'DreamFX', 'Bridge')));
	assert.ok(paths.requests.endsWith(path.join('Bridge', 'Requests')));
	assert.ok(paths.responses.endsWith(path.join('Bridge', 'Responses')));
	assert.ok(paths.status.endsWith('status.json'));
});

test('request ids sort oldest first', () => {
	// The editor drains its queue with a plain string sort, so ordering has to be a property of the
	// name rather than of the filesystem.
	const first = makeRequestId(Date.parse('2026-08-13T12:00:00.000Z'));
	const second = makeRequestId(Date.parse('2026-08-13T12:00:01.000Z'));
	const third = makeRequestId(Date.parse('2026-08-13T12:00:02.000Z'));
	assert.deepEqual([first, second, third].slice().sort(), [first, second, third]);
});

test('two requests in the same millisecond still get different ids', () => {
	const at = Date.parse('2026-08-13T12:00:00.000Z');
	assert.notEqual(makeRequestId(at, () => 0.5), makeRequestId(at, () => 0.5));
});

test('a request always carries the protocol version', () => {
	const request = buildRequest('abc', 'build', { scope: 'file', sourceFile: 'X.dfs' });
	assert.equal(request.protocol, PROTOCOL_VERSION);
	assert.equal(request.action, 'build');
	assert.equal(request.sourceFile, 'X.dfs');
});

test('a truncated response is rejected rather than half-used', () => {
	// The editor renames into place so this should not happen; if it ever does, acting on half a
	// response is far worse than waiting for the next poll.
	assert.equal(parseResponse('{"requestId":"a","ok":tr'), undefined);
	assert.equal(parseResponse(''), undefined);
	assert.equal(parseResponse('{"message":"no id"}'), undefined);
	assert.equal(parseResponse('[]'), undefined);
});

test('a well-formed response is read whole', () => {
	const response = parseResponse(JSON.stringify({
		protocol: 1,
		requestId: 'r1',
		ok: false,
		durationMs: 1234,
		message: 'Failed.',
		diagnostics: [{ file: 'X.dfs', line: 7, column: 5, severity: 'error', code: 'DFX3003', message: 'no input' }],
	}));
	assert.equal(response?.ok, false);
	assert.equal(response?.durationMs, 1234);
	assert.equal(response?.diagnostics[0].code, 'DFX3003');
});

test('a response missing its diagnostics array still parses', () => {
	// ping and openAsset have nothing to report, and a missing array must not read as a broken file.
	const response = parseResponse('{"protocol":1,"requestId":"r","ok":true}');
	assert.deepEqual(response?.diagnostics, []);
	assert.equal(response?.message, '');
});

test('status parsing rejects what it cannot use', () => {
	assert.equal(parseStatus('{}'), undefined);
	assert.equal(parseStatus('nonsense'), undefined);
	assert.equal(parseStatus(JSON.stringify(status()))?.pid, 4242);
});

// ---------------------------------------------------------------- pull

function pullBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		changed: true,
		newText: 'Value = 2.0;\n',
		edits: 1,
		compared: 12,
		changedValues: 1,
		undeclared: 0,
		unwritable: 0,
		unaddressable: 0,
		withheld: 0,
		added: 0,
		removed: 0,
		structureRefused: 0,
		baselineUsed: true,
		baselineWritten: false,
		wroteFile: false,
		reportPath: 'Saved/DreamFX/Pull/NS_Spark.txt',
		report: ['DFX7116: Value 1.0 -> 2.0'],
		...overrides,
	};
}

test('a pull request carries the text, the structure switch and the apply flag', () => {
	const request = buildRequest('abc', 'pull', { sourceFile: 'X.dfs', text: 'a', structure: false, apply: true });
	assert.equal(request.action, 'pull');
	assert.equal(request.text, 'a');
	assert.equal(request.structure, false);
	assert.equal(request.apply, true);
});

test('the pull result rides inside an ordinary response', () => {
	const response = parseResponse(JSON.stringify({
		protocol: 1, requestId: 'r1', ok: true, durationMs: 40, message: 'Pulled.', diagnostics: [], pull: pullBody(),
	}));
	assert.equal(response?.pull?.changed, true);
	assert.equal(response?.pull?.newText, 'Value = 2.0;\n');
	assert.equal(response?.pull?.compared, 12);
	assert.equal(response?.pull?.baselineUsed, true);
	assert.deepEqual(response?.pull?.report, ['DFX7116: Value 1.0 -> 2.0']);
});

test('a response with no pull field has none', () => {
	const response = parseResponse(JSON.stringify({ protocol: 1, requestId: 'r1', ok: true, message: 'ok' }));
	assert.equal(response?.pull, undefined);
});

test('a changed pull without its text is unusable', () => {
	// Nothing to apply, and guessing "unchanged" would tell the author the asset agrees when it does not.
	assert.equal(parsePullResult(pullBody({ newText: undefined })), undefined);
	assert.equal(parsePullResult(pullBody({ newText: 5 })), undefined);
});

test('an unchanged pull needs no text, and ignores one if sent', () => {
	const pull = parsePullResult(pullBody({ changed: false, newText: 'stray', edits: 0 }));
	assert.equal(pull?.changed, false);
	assert.equal(pull?.newText, undefined);
});

test('a pull result that is not an object with a boolean changed is rejected', () => {
	assert.equal(parsePullResult(undefined), undefined);
	assert.equal(parsePullResult(null), undefined);
	assert.equal(parsePullResult([]), undefined);
	assert.equal(parsePullResult('x'), undefined);
	assert.equal(parsePullResult({ changed: 'yes' }), undefined);
	assert.equal(parsePullResult({}), undefined);
});

test('missing or malformed counters read as zero rather than failing the pull', () => {
	const pull = parsePullResult({ changed: false, withheld: 'two', undeclared: -3, compared: 7.9, report: ['a', 5, 'b'] });
	assert.equal(pull?.withheld, 0);
	assert.equal(pull?.undeclared, 0);
	assert.equal(pull?.compared, 7);
	assert.equal(pull?.added, 0);
	assert.equal(pull?.reportPath, '');
	assert.deepEqual(pull?.report, ['a', 'b']);
});

test('an editor that predates pull is recognised by its refusal', () => {
	const refusal = (message: string, ok = false) =>
		({ protocol: 1, requestId: 'r', ok, durationMs: 0, message, diagnostics: [] });
	assert.equal(isUnknownActionResponse(refusal("Unknown action 'pull'."), 'pull'), true);
	assert.equal(isUnknownActionResponse(refusal('unknown action ‘pull’'), 'pull'), true);
	assert.equal(isUnknownActionResponse(refusal('Unknown action: pull'), 'pull'), false, 'a colon is a different message; do not over-match');
	assert.equal(isUnknownActionResponse(refusal("Unknown action 'adopt'."), 'pull'), false);
	assert.equal(isUnknownActionResponse(refusal('Source is not a .dfs.'), 'pull'), false);
	assert.equal(isUnknownActionResponse(refusal("Unknown action 'pull'", true), 'pull'), false);
});
