/**
 * The bundle, spoken to over a real pipe.
 *
 * Every other test in here imports a function and checks what it returns, which is the right shape
 * for testing language knowledge and says nothing about whether the thing that ships works. This one
 * spawns `out/server.js` -- the esbuild output, not the `tsc` one -- and holds an LSP conversation
 * with it. It is the only test that would catch a bundler config that dropped a dependency, a
 * capability that was declared but never wired, or a server that throws on boot.
 *
 * `--stdio` rather than the IPC the client actually uses: same server, same handlers, and a
 * transport a test can hold both ends of.
 */

import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import * as path from 'node:path';
import { after, before, test } from 'node:test';

import {
	MessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
	createMessageConnection,
} from 'vscode-jsonrpc/node';
import { CodeLens, Diagnostic, DocumentSymbol, InitializeResult } from 'vscode-languageserver';

const SERVER = path.join(__dirname, '..', 'server.js');

const SOURCE = `System(Name="T", Root="P")
{
\tEmitter E
\t{
\t\tParticleUpdate = {
\t\t\tGravityForce(Gravity = (0, 0, -680));
\t\t}
\t}
}
`;

let child: ChildProcess;
let connection: MessageConnection;
let capabilities: InitializeResult['capabilities'];

/** Resolves with the next diagnostics published for a given document. */
function nextDiagnostics(uri: string): Promise<Diagnostic[]> {
	return new Promise((resolve) => {
		connection.onNotification(
			'textDocument/publishDiagnostics',
			(params: { uri: string; diagnostics: Diagnostic[] }) => {
				if (params.uri === uri) {
					resolve(params.diagnostics);
				}
			});
	});
}

function open(uri: string, text: string): Promise<void> {
	return connection.sendNotification('textDocument/didOpen', {
		textDocument: { uri, languageId: 'dreamfxlang', version: 1, text },
	});
}

before(async () => {
	child = spawn(process.execPath, [SERVER, '--stdio'], { stdio: 'pipe' });
	connection = createMessageConnection(
		new StreamMessageReader(child.stdout!),
		new StreamMessageWriter(child.stdin!));
	connection.listen();

	const result = await connection.sendRequest<InitializeResult>('initialize', {
		processId: process.pid,
		rootUri: null,
		capabilities: {},
		workspaceFolders: null,
	});
	capabilities = result.capabilities;
	await connection.sendNotification('initialized', {});
});

after(() => {
	connection?.dispose();
	child?.kill();
});

test('the bundle boots and declares what it can do', () => {
	// Incremental, specifically. Shipping the whole buffer on every keystroke is the one thing that
	// would make an out-of-process server slower than the providers it replaced.
	assert.equal(capabilities.textDocumentSync, 2);
	assert.equal(capabilities.hoverProvider, true);
	assert.equal(capabilities.documentSymbolProvider, true);
	assert.deepEqual(capabilities.codeLensProvider, { resolveProvider: false });
	assert.deepEqual(capabilities.completionProvider?.triggerCharacters, ['(', ',', '=', ' ']);
});

test('a document opened over the wire comes back as an outline', async () => {
	await open('file:///t.dfs', SOURCE);

	const symbols = await connection.sendRequest<DocumentSymbol[]>('textDocument/documentSymbol', {
		textDocument: { uri: 'file:///t.dfs' },
	});

	assert.equal(symbols.length, 1);
	assert.equal(symbols[0].name, 'T');
	assert.equal(symbols[0].detail, 'System');
	assert.ok(symbols[0].children?.length, 'the System should carry its emitter');
});

test('a clean document publishes an empty diagnostic set, not silence', async () => {
	// Silence and "no problems" are the same thing to a reader and different things to a client:
	// without the empty publish, stale squiggles from a previous version stay on screen.
	const published = nextDiagnostics('file:///clean.dfs');
	await open('file:///clean.dfs', SOURCE);
	assert.deepEqual(await published, []);
});

test('a lexical error arrives with its code and its documentation link', async () => {
	const published = nextDiagnostics('file:///bad.dfs');
	await open('file:///bad.dfs', 'System(Name="unterminated\n{\n');

	const diagnostics = await published;
	assert.ok(diagnostics.length > 0);

	const [first] = diagnostics;
	assert.equal(first.source, 'dreamfxlang');
	assert.match(String(first.code), /^DFX1/);
	assert.match(first.codeDescription!.href, /DFX1xxx\.md#dfx1\d{3}$/);
});

test('hover with no index loaded declines rather than throwing', async () => {
	// No workspace was given at initialize, so there is no `.dfx-index.json` to find. The server has
	// to answer the request anyway: a rejected promise here surfaces as a client-side error popup.
	const hover = await connection.sendRequest('textDocument/hover', {
		textDocument: { uri: 'file:///t.dfs' },
		position: { line: 5, character: 6 },
	});
	assert.equal(hover, null);
});

test('completion with no index loaded is empty, not an error', async () => {
	const items = await connection.sendRequest('textDocument/completion', {
		textDocument: { uri: 'file:///t.dfs' },
		position: { line: 5, character: 3 },
	});
	assert.deepEqual(items, []);
});

test('a curve literal gets a lens that opens the editor on it', async () => {
	const source = [
		'System(Name="C")',
		'{',
		'    Emitter E',
		'    {',
		'        ParticleUpdate = {',
		'            ScaleSpriteSize(UniformScaleFactor = FloatFromCurve(FloatCurve = curve { 0.0 -> 1.0; 1.0 -> 0.0; }));',
		'            M(V = curve { 0.0 -> 1.0 [ Interp=Smooth ]; });',
		'        }',
		'    }',
		'}',
		'',
	].join('\n');
	await open('file:///curve.dfs', source);

	const lenses = await connection.sendRequest<CodeLens[]>('textDocument/codeLens', {
		textDocument: { uri: 'file:///curve.dfs' },
	});

	assert.equal(lenses.length, 2);
	const [good, bad] = lenses;
	assert.equal(good.range.start.line, 5);
	assert.equal(good.command?.command, 'dreamfx.editCurve');
	// The client re-reads its own text; all it needs is which document and where the keyword is.
	assert.deepEqual(good.command?.arguments, ['file:///curve.dfs', source.indexOf('curve {')]);
	assert.match(good.command!.title, /Edit curve · 2 keys/);
	assert.match(bad.command!.title, /read-only/, 'a literal the compiler would refuse is offered for viewing only');
});
