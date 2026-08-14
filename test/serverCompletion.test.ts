/**
 * The protocol shapes, not the language.
 *
 * What is offered at a given cursor is `core/context.ts`'s answer and is tested next door against
 * the text directly. What is tested here is the translation into the wire format -- which is where
 * a move out of process can break something no type checker will catch, because both sides of every
 * one of these fields are plain JSON.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CompletionItemKind, InsertTextFormat, MarkupKind } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { ModuleIndex, SchemaIndex } from '../src/core/schemaIndex';
import { completionAt, hoverAt } from '../src/server/completion';

function makeIndex(modules: SchemaIndex['modules'], inputsProbed = true): ModuleIndex {
	return new ModuleIndex({ version: 1, generatedUtc: '2026-08-13T00:00:00Z', inputsProbed, modules });
}

const INDEX = makeIndex([
	{
		name: 'GravityForce',
		path: '/Niagara/Modules/Update/Forces/GravityForce',
		kind: 'module',
		stacks: ['ParticleUpdate'],
		inputs: [
			{ name: 'Gravity', type: 'Vector3f' },
			{
				name: 'Coordinate Space',
				type: 'ENiagaraCoordinateSpace',
				staticSwitch: true,
				enum: ['Simulation', 'World'],
			},
		],
	},
	{ name: 'ConeMask', path: '/Niagara/Modules/Masks/ConeMask', kind: 'module', stacks: ['ParticleUpdate'] },
	{ name: 'ConeMask', path: '/Niagara/Modules/Masks/V2/ConeMask', kind: 'module', stacks: ['ParticleUpdate'] },
]);

/** A document plus the offset marked by `|` in the source. */
function at(source: string): { document: TextDocument; position: { line: number; character: number } } {
	const offset = source.indexOf('|');
	assert.notEqual(offset, -1, 'the test source must mark the cursor with |');
	const text = source.replace('|', '');
	const document = TextDocument.create('file:///test.dfs', 'dreamfxlang', 1, text);
	return { document, position: document.positionAt(offset) };
}

const IN_STACK = `System(Name="T", Root="P")
{
	Emitter E
	{
		ParticleUpdate = {
			|
		}
	}
}`;

test('a module completion arrives as a snippet, not as a client-side SnippetString', () => {
	const { document, position } = at(IN_STACK);
	const items = completionAt(INDEX, document, position);

	const gravity = items.find((item) => item.label === 'GravityForce');
	assert.ok(gravity, 'GravityForce should be offered at statement position');
	assert.equal(gravity.kind, CompletionItemKind.Function);
	assert.equal(gravity.insertText, 'GravityForce($0);');
	// Without this the client inserts the literal text `GravityForce($0);`, dollar sign and all.
	assert.equal(gravity.insertTextFormat, InsertTextFormat.Snippet);
});

test('documentation crosses the wire as MarkupContent', () => {
	const { document, position } = at(IN_STACK);
	const items = completionAt(INDEX, document, position);
	const gravity = items.find((item) => item.label === 'GravityForce');

	assert.deepEqual(
		typeof gravity?.documentation === 'object' ? gravity.documentation.kind : undefined,
		MarkupKind.Markdown);
});

test('the no-signatures notice cannot insert its own label', () => {
	// The trap this exists for: `vscode-languageclient` reads `insertText` with a falsy check, so an
	// empty string is dropped and the *label* is inserted instead -- writing the sentence
	// "Input names need a full index" into the author's file.
	const bare = makeIndex(
		[{ name: 'GravityForce', path: '/M/GravityForce', kind: 'module', stacks: ['ParticleUpdate'] }],
		/*inputsProbed=*/false);
	const { document, position } = at(IN_STACK.replace('|', 'GravityForce(|'));

	const items = completionAt(bare, document, position);
	assert.equal(items.length, 1);
	const [hint] = items;

	assert.ok(hint.insertText, 'an empty insertText would be dropped and the label written instead');
	assert.equal(hint.insertText, '$0');
	assert.equal(hint.insertTextFormat, InsertTextFormat.Snippet);
	// Sorted last, so it never displaces a real suggestion when both are somehow present.
	assert.equal(hint.sortText, '￿');
});

test('static switches sort before the inputs they gate', () => {
	const { document, position } = at(IN_STACK.replace('|', 'GravityForce(|'));
	const items = completionAt(INDEX, document, position);

	const gravity = items.find((item) => item.label === 'Gravity');
	const space = items.find((item) => item.label === 'Coordinate Space');
	assert.ok(gravity && space);
	assert.ok(space.sortText! < gravity.sortText!, 'a switch has to be written before what it gates');
	assert.match(space.detail!, /static switch/);
});

test('hover on an ambiguous name lists the candidates rather than picking one', () => {
	const { document, position } = at(IN_STACK.replace('|', 'Cone|Mask();'));
	const hover = hoverAt(INDEX, document, position);

	assert.ok(hover, 'ConeMask should hover');
	const value = typeof hover.contents === 'object' && 'value' in hover.contents ? hover.contents.value : '';
	assert.match(value, /matches 2 assets/);
	assert.match(value, /DFX3002/);
});

test('hover on nothing in particular is undefined, not an empty Hover', () => {
	const { document, position } = at(IN_STACK);
	assert.equal(hoverAt(INDEX, document, position), undefined);
});
