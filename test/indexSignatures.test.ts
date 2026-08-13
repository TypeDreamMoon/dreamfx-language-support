import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ModuleIndex, SchemaIndex } from '../src/core/schemaIndex';

function indexWith(overrides: Partial<SchemaIndex>): ModuleIndex {
	return new ModuleIndex({
		version: 1,
		generatedUtc: '2026-08-13T00:00:00Z',
		modules: [{ name: 'GravityForce', path: '/Niagara/Modules/GravityForce', kind: 'module', stacks: ['ParticleUpdate'] }],
		...overrides,
	} as SchemaIndex);
}

test('an index written without probing says so', () => {
	// The bridge writes one of these: it lists modules but never probes their signatures, because
	// probing walks module graphs and one piece of engine content recurses until the process dies.
	assert.equal(indexWith({ inputsProbed: false }).hasSignatures, false);
});

test('an index that probed says so', () => {
	assert.equal(indexWith({ inputsProbed: true }).hasSignatures, true);
});

test('an index from before the flag existed counts as probed', () => {
	// Every index written before this distinction existed was a probed one. Reading undefined as
	// "unprobed" would silently switch off argument completion for anyone with a cached file.
	assert.equal(indexWith({}).hasSignatures, true);
});

test('module lookup still works without signatures', () => {
	// The stacks come from the usage bitmask, which costs nothing to collect -- so module-name
	// completion survives even when argument completion cannot.
	const index = indexWith({ inputsProbed: false });
	assert.equal(index.resolve('GravityForce').length, 1);
	assert.deepEqual(index.resolve('GravityForce')[0].stacks, ['ParticleUpdate']);
});
