/**
 * The page and its script agree about the page.
 *
 * The markup lives in the extension and the script that drives it in the webview bundle, and nothing
 * checks one against the other at build time: a renamed id makes `getElementById` return null and
 * the editor dies on load, and a button whose action the script does not handle simply does nothing.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { CURVE_EDITOR_BODY, curveEditorHtml } from '../src/features/curveEditorPage';

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'webview', 'curveEditor.ts'), 'utf8');

test('every element the script looks up is on the page', () => {
	const wanted = [...SCRIPT.matchAll(/element<\w+>\('([\w-]+)'\)/g)].map((match) => match[1]);
	assert.ok(wanted.length >= 8, `only found ${wanted.length} lookups`);
	const missing = wanted.filter((id) => !CURVE_EDITOR_BODY.includes(`id="${id}"`));
	assert.deepEqual(missing, []);
});

test('every button action on the page is handled by the script', () => {
	const actions = [...CURVE_EDITOR_BODY.matchAll(/data-action="(\w+)"/g)].map((match) => match[1]);
	assert.ok(actions.length >= 10);
	const unhandled = actions.filter((action) => !SCRIPT.includes(`case '${action}':`) && !SCRIPT.includes(`=== '${action}'`));
	assert.deepEqual(unhandled, []);
});

test('the page loads only its own script, under a nonce', () => {
	const html = curveEditorHtml({ cspSource: 'vscode-webview://x', nonce: 'abc123', scriptUri: 'vscode-webview://x/out/curveEditor.js' });
	assert.match(html, /default-src 'none'/);
	assert.match(html, /script-src 'nonce-abc123'/);
	assert.ok(!/unsafe-inline|unsafe-eval/.test(html), 'no inline or eval escape hatches');
	assert.equal([...html.matchAll(/<script /g)].length, 1);
	assert.match(html, /<script nonce="abc123" src="vscode-webview:\/\/x\/out\/curveEditor\.js"><\/script>/);
	assert.ok(!/ style="/.test(html), 'inline style attributes are blocked by the policy');
});
