import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EditContext, HoverTarget, contextAt, targetAt } from '../src/core/context';

/** `|` marks the cursor. Everything here is written the way it looks mid-edit, unclosed braces and all. */
function at(source: string): EditContext {
	const offset = source.indexOf('|');
	assert.notEqual(offset, -1, 'the fixture needs a | for the cursor');
	return contextAt(source.replace('|', ''), offset);
}

function hover(source: string): HoverTarget | undefined {
	const offset = source.indexOf('|');
	assert.notEqual(offset, -1, 'the fixture needs a | for the cursor');
	return targetAt(source.replace('|', ''), offset);
}

const SYSTEM = 'System(Name="x", Root="Game")\n{\n    Emitter E\n    {\n';

test('a statement position inside a stack knows which stack it is', () => {
	assert.deepEqual(at(`${SYSTEM}        ParticleUpdate = {\n            Grav|`), {
		kind: 'stackStatement',
		stack: 'ParticleUpdate',
	});

	assert.deepEqual(at(`${SYSTEM}        EmitterUpdate = {\n            |`), {
		kind: 'stackStatement',
		stack: 'EmitterUpdate',
	});
});

test('a Stage and an OnEvent block are particle-scope stacks', () => {
	// Both run on particles -- a stage after ParticleUpdate, a handler per received event -- so the
	// modules offerable in them are the particle-update ones.
	assert.deepEqual(at(`${SYSTEM}        Stage Settle = {\n            |`), {
		kind: 'stackStatement',
		stack: 'ParticleUpdate',
	});
	assert.deepEqual(at(`${SYSTEM}        Stage Project(NumIterations = 4) = {\n            |`), {
		kind: 'stackStatement',
		stack: 'ParticleUpdate',
	});
	assert.deepEqual(at(`${SYSTEM}        OnEvent(Source = S, Event = "E") = {\n            |`), {
		kind: 'stackStatement',
		stack: 'ParticleUpdate',
	});
});

test('a block that is not a stack offers nothing', () => {
	assert.deepEqual(at(`${SYSTEM}        Settings = {\n            |`), { kind: 'none' });
	assert.deepEqual(at('System(Name="x")\n{\n    Properties = {\n        |'), { kind: 'none' });
});

test('an argument list knows the module it belongs to', () => {
	assert.deepEqual(at(`${SYSTEM}        ParticleUpdate = {\n            GravityForce(|`), {
		kind: 'argumentName',
		module: 'GravityForce',
		stack: 'ParticleUpdate',
		alreadyWritten: [],
	});
});

test('the names already given are reported, so they can be dropped from the offer', () => {
	const context = at(`${SYSTEM}        ParticleUpdate = {\n            EmitterState(LifeCycleMode = Self, LoopBehavior = Once, |`);
	assert.equal(context.kind, 'argumentName');
	assert.deepEqual(context.kind === 'argumentName' ? context.alreadyWritten : [], ['LifeCycleMode', 'LoopBehavior']);
});

test('a value position names the input being written', () => {
	assert.deepEqual(at(`${SYSTEM}        ParticleUpdate = {\n            EmitterState(LifeCycleMode = |`), {
		kind: 'argumentValue',
		module: 'EmitterState',
		input: 'LifeCycleMode',
		stack: 'ParticleUpdate',
	});
});

test('a nested dynamic input is its own argument list', () => {
	// The innermost unclosed paren wins, which is what makes a chain of any depth work.
	assert.deepEqual(
		at(`${SYSTEM}        ParticleUpdate = {\n            ScaleSpriteSize(UniformScaleFactor = FloatFromCurve(CurveIndex = |`),
		{ kind: 'argumentValue', module: 'FloatFromCurve', input: 'CurveIndex', stack: 'ParticleUpdate' });

	assert.deepEqual(
		at(`${SYSTEM}        ParticleSpawn = {\n            AddVelocityInCone(VelocityStrength = RandomRangeFloat(|`),
		{ kind: 'argumentName', module: 'RandomRangeFloat', stack: 'ParticleSpawn', alreadyWritten: [] });
});

test('a partial path, a version pin and `disabled` all still name the module', () => {
	assert.equal(
		(at(`${SYSTEM}        ParticleSpawn = {\n            Spawn/Initialization/V2/InitializeParticle(|`) as any).module,
		'Spawn/Initialization/V2/InitializeParticle');

	assert.equal((at(`${SYSTEM}        ParticleUpdate = {\n            Drag@1.2(|`) as any).module, 'Drag');
	assert.equal((at(`${SYSTEM}        ParticleUpdate = {\n            disabled GravityForce(|`) as any).module, 'GravityForce');
});

test('a vector literal in an argument does not end the argument list', () => {
	const context = at(`${SYSTEM}        ParticleUpdate = {\n            GravityForce(Gravity = (0, 0, -680), |`);
	assert.equal(context.kind, 'argumentName');
	// The commas inside the vector are at depth 1 and must not read as argument separators.
	assert.deepEqual(context.kind === 'argumentName' ? context.alreadyWritten : [], ['Gravity']);
});

test('inside an hlsl block there is no DreamFXLang to complete', () => {
	// The raw block is collapsed to one token; without the guard the cursor would appear to sit in
	// whatever block encloses it and be offered module names.
	assert.deepEqual(
		at(`${SYSTEM}        ParticleUpdate = {\n            Color Particles.Color = hlsl { float4(|, 1) };\n        }\n    }\n}`),
		{ kind: 'none' });
});

test("a module's raw Body is not a stack either", () => {
	assert.deepEqual(
		at('Module(Name="M", Root="Game")\n{\n    Body = {\n        float x = |;\n    }\n}'),
		{ kind: 'none' });
});

test('nothing sensible is claimed at the top level', () => {
	assert.deepEqual(at('|'), { kind: 'none' });
	assert.deepEqual(at('System(Name="x")\n{\n    |'), { kind: 'none' });
});

// ---------------------------------------------------------------- hover

test('hovering a call names the module', () => {
	assert.deepEqual(hover(`${SYSTEM}        ParticleUpdate = {\n            Gravity|Force(Gravity = (0,0,-1));`), {
		kind: 'module',
		name: 'GravityForce',
		stack: 'ParticleUpdate',
	});
});

test('hovering any segment of a partial path names the whole path', () => {
	assert.deepEqual(
		hover(`${SYSTEM}        ParticleSpawn = {\n            Spawn/Init|ialization/V2/InitializeParticle(Lifetime = 1);`),
		{ kind: 'module', name: 'Spawn/Initialization/V2/InitializeParticle', stack: 'ParticleSpawn' });
});

test('hovering an argument name names the input and its module', () => {
	assert.deepEqual(hover(`${SYSTEM}        ParticleUpdate = {\n            EmitterState(LifeCyc|leMode = Self);`), {
		kind: 'input',
		module: 'EmitterState',
		name: 'LifeCycleMode',
		stack: 'ParticleUpdate',
	});
});

test('hovering something that is neither says so', () => {
	assert.equal(hover(`${SYSTEM}        Sett|ings = { }`), undefined);
	assert.equal(hover('System(Name="x|")'), undefined);
});
