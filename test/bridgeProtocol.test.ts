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
	livenessOf,
	makeRequestId,
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
