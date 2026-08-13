import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	ModuleIndex,
	SchemaIndex,
	normalizeInputIdentifier,
	parseSchemaIndex,
} from '../src/core/schemaIndex';

function makeIndex(modules: SchemaIndex['modules']): ModuleIndex {
	return new ModuleIndex({ version: 1, generatedUtc: '2026-08-13T00:00:00Z', modules });
}

const SAMPLE = makeIndex([
	{
		name: 'GravityForce',
		path: '/Niagara/Modules/Update/Forces/GravityForce',
		kind: 'module',
		stacks: ['ParticleUpdate', 'ParticleSpawn'],
		inputs: [
			{ name: 'Gravity', type: 'Vector3f' },
			{ name: 'Coordinate Space', type: 'ENiagaraCoordinateSpace', staticSwitch: true, enum: ['Simulation', 'World', 'Local'] },
		],
	},
	{ name: 'ConeMask', path: '/Niagara/Modules/Masks/ConeMask', kind: 'module', stacks: ['ParticleUpdate'] },
	{ name: 'ConeMask', path: '/Niagara/Modules/Masks/V2/ConeMask', kind: 'module', stacks: ['ParticleUpdate'] },
	{ name: 'EmitterState', path: '/Niagara/Modules/Emitter/EmitterState', kind: 'module', stacks: ['EmitterUpdate'] },
	{ name: 'Uncategorised', path: '/Game/FX/Uncategorised', kind: 'module', stacks: [] },
	{ name: 'RandomRangeFloat', path: '/Niagara/DynamicInputs/RandomRangeFloat', kind: 'dynamicInput', stacks: ['ParticleSpawn'] },
]);

test('a short name resolves to every asset that carries it', () => {
	// Plural on purpose: the compiler refuses an ambiguous short name rather than picking one,
	// because picking would make the build depend on asset registry ordering (DFX3002).
	assert.equal(SAMPLE.resolve('GravityForce').length, 1);
	assert.equal(SAMPLE.resolve('ConeMask').length, 2);
	assert.equal(SAMPLE.resolveUnique('ConeMask'), undefined);
	assert.equal(SAMPLE.resolveUnique('GravityForce')?.path, '/Niagara/Modules/Update/Forces/GravityForce');
});

test('a partial path narrows an ambiguous name', () => {
	assert.equal(SAMPLE.resolveUnique('V2/ConeMask')?.path, '/Niagara/Modules/Masks/V2/ConeMask');
	assert.equal(SAMPLE.resolveUnique('Masks/ConeMask')?.path, '/Niagara/Modules/Masks/ConeMask');
	assert.equal(SAMPLE.resolveUnique('/Niagara/Modules/Masks/V2/ConeMask')?.path, '/Niagara/Modules/Masks/V2/ConeMask');
});

test('an unknown name resolves to nothing rather than to something close', () => {
	assert.deepEqual(SAMPLE.resolve('GravityFrce'), []);
});

test('stack filtering offers what the stack accepts', () => {
	const update = SAMPLE.forStack('ParticleUpdate', 'module').map((module) => module.path);
	assert.ok(update.includes('/Niagara/Modules/Update/Forces/GravityForce'));
	assert.ok(!update.includes('/Niagara/Modules/Emitter/EmitterState'));

	assert.deepEqual(
		SAMPLE.forStack('ParticleSpawn', 'dynamicInput').map((module) => module.name),
		['RandomRangeFloat']);
});

test('a module with no recorded stacks is offered everywhere, not nowhere', () => {
	// An empty list means the export could not read the bitmask. Hiding a module because the index
	// is thin would be the editor inventing a restriction the compiler does not have.
	for (const stack of ['ParticleUpdate', 'SystemSpawn', 'EmitterSpawn']) {
		assert.ok(SAMPLE.forStack(stack, 'module').some((module) => module.name === 'Uncategorised'), stack);
	}
});

test('an input is found by the identifier a source file writes', () => {
	// Niagara input names contain spaces; both sides are normalised so `CoordinateSpace` addresses
	// `Coordinate Space`. Comparing any other way would disagree with the build about which input
	// was meant.
	const module = SAMPLE.resolveUnique('GravityForce')!;
	assert.equal(SAMPLE.findInput(module, 'CoordinateSpace')?.type, 'ENiagaraCoordinateSpace');
	assert.equal(SAMPLE.findInput(module, 'coordinatespace')?.staticSwitch, true);
	assert.equal(SAMPLE.findInput(module, 'Gravity')?.type, 'Vector3f');
	assert.equal(SAMPLE.findInput(module, 'Nope'), undefined);
});

test('the normalisation matches the compiler: case, spaces and underscores', () => {
	assert.equal(normalizeInputIdentifier('Loop Duration'), 'loopduration');
	assert.equal(normalizeInputIdentifier('LoopDuration'), 'loopduration');
	assert.equal(normalizeInputIdentifier('loop_duration'), 'loopduration');
});

test('a newer index is refused rather than half-understood', () => {
	const future = JSON.stringify({ version: 99, generatedUtc: '', modules: [] });
	const result = parseSchemaIndex(future);
	assert.ok('error' in result);
	assert.match(result.error, /newer plugin/);
});

test('a malformed index reports why', () => {
	assert.match((parseSchemaIndex('not json') as { error: string }).error, /not valid JSON/);
	assert.match((parseSchemaIndex('{}') as { error: string }).error, /no version/);
	assert.match((parseSchemaIndex('{"version":1}') as { error: string }).error, /no modules/);
});

test('a well-formed index loads', () => {
	const result = parseSchemaIndex(JSON.stringify({
		version: 1,
		generatedUtc: '2026-08-13T00:00:00Z',
		modules: [{ name: 'A', path: '/A', kind: 'module', stacks: [] }],
	}));
	assert.ok('index' in result);
	assert.equal(result.index.modules.length, 1);
});
