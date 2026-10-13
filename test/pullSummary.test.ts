import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PullResult, describePull } from '../src/core';

function pull(overrides: Partial<PullResult> = {}): PullResult {
	return {
		changed: false, edits: 0, compared: 0, changedValues: 0, undeclared: 0, unwritable: 0, unaddressable: 0,
		withheld: 0, added: 0, removed: 0, structureRefused: 0, baselineUsed: false, baselineWritten: false,
		wroteFile: false, reportPath: '', report: [],
		...overrides,
	};
}

test('nothing changed and nothing skipped', () => {
	assert.equal(describePull(pull({ compared: 14 }), false), 'The text already matches the asset (14 compared).');
	assert.equal(describePull(pull(), false), 'The text already matches the asset.');
});

test('a change names its edits and what they were', () => {
	assert.equal(describePull(pull({ changed: true, edits: 1, changedValues: 1 }), false), '1 edit (1 value changed).');
	assert.equal(
		describePull(pull({ changed: true, edits: 5, changedValues: 3, added: 1, removed: 2 }), true),
		'5 edits (3 values changed, 1 added, 2 removed).');
});

test('what was seen but not written is always named, even when nothing changed', () => {
	const text = describePull(pull({ withheld: 2, undeclared: 1, unwritable: 3, unaddressable: 1 }), false);
	assert.match(text, /^The text already matches the asset/);
	assert.match(text, /2 left alone because the text is newer than the asset/);
	assert.match(text, /1 asset value the text does not declare/);
	assert.match(text, /3 not writable as a literal/);
	assert.match(text, /1 stack could not be addressed/);
});

test('a refused structural difference points at the setting only when it is off', () => {
	assert.match(describePull(pull({ structureRefused: 2 }), false), /2 structural differences found; turn on dreamfx\.pull\.structuralEdits/);
	assert.match(describePull(pull({ structureRefused: 1 }), true), /1 structural difference not applied/);
	assert.doesNotMatch(describePull(pull({ structureRefused: 1 }), true), /structuralEdits/);
});
