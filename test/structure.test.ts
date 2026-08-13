import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { StructureNode, analyze } from '../src/core/structure';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');

function readFixture(name: string): string {
	return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

function rootOf(source: string): StructureNode {
	const model = analyze(source);
	if (!model.root) {
		assert.fail('no top-level object was recognised');
	}
	return model.root;
}

function childNamed(node: StructureNode, name: string): StructureNode {
	const found = node.children.find((child) => child.name === name);
	if (!found) {
		assert.fail(`expected a child called '${name}', saw ${node.children.map((child) => child.name).join(', ')}`);
	}
	return found;
}

test('a system decomposes into its sections, emitters, stacks and renderers', () => {
	const source = readFixture('sample.dfs');
	assert.deepEqual(analyze(source).diagnostics, []);

	const root = rootOf(source);
	assert.equal(root.kind, 'document');
	assert.equal(root.name, 'Samples/NS_Fixture');

	assert.deepEqual(root.children.map((child) => child.name), [
		'Settings', 'Properties', 'Sparks', 'Flash',
	]);

	const sparks = childNamed(root, 'Sparks');
	assert.equal(sparks.kind, 'emitter');
	assert.deepEqual(sparks.children.map((child) => child.name), [
		'Settings', 'Defaults', 'EmitterUpdate', 'ParticleSpawn', 'ParticleUpdate',
		'Settle', 'Project', 'OnEvent', 'Core',
	]);

	const flash = childNamed(root, 'Flash');
	assert.equal(flash.detail, 'from "../Emitters/E_MoonFlashCard"');
});

test('user parameters are listed with their declared types', () => {
	const model = analyze(readFixture('sample.dfs'));
	const properties = childNamed(model.root!, 'Properties');

	assert.deepEqual(properties.children.map((child) => [child.name, child.detail]), [
		['SparkCount', 'int'],
		['SparkSpeed', 'float'],
		['TintA', 'Color'],
		['HitNormal', 'Vector'],
		['TargetMesh', 'DI<SkeletalMesh>'],
		['`PillarPower(0~1)`', 'float'],
	]);
});

test('a Defaults entry keeps its namespace-qualified target', () => {
	const model = analyze(readFixture('sample.dfs'));
	const defaults = childNamed(childNamed(model.root!, 'Sparks'), 'Defaults');
	assert.deepEqual(defaults.children.map((child) => child.name), ['Particles.MySize', 'Particles.Home']);
});

test('a stack lists its module calls and not its folded assignments', () => {
	const model = analyze(readFixture('sample.dfs'));
	const spawn = childNamed(childNamed(model.root!, 'Sparks'), 'ParticleSpawn');

	// The two Particles.Moon.* writes are deliberately absent: consecutive assignments fold into one
	// Set Parameters module, so an assignment is a line inside a module rather than a module.
	assert.deepEqual(spawn.children.map((child) => child.name), [
		'InitializeParticle', 'SystemLocation', 'AddVelocityInCone',
	]);
	assert.match(childNamed(spawn, 'AddVelocityInCone').detail, /^disabled/);
});

test('a #Region marker does not swallow the statement after it', () => {
	// The marker has no terminator, so a statement skipper looking for ';' would run straight
	// through the call underneath it.
	const model = analyze(readFixture('sample.dfs'));
	const spawn = childNamed(childNamed(model.root!, 'Sparks'), 'ParticleSpawn');
	assert.equal(spawn.children[0].name, 'InitializeParticle');
});

test('a partial path is listed by its last segment, and @version and `as` show up as detail', () => {
	const model = analyze(readFixture('sample.dfs'));
	const update = childNamed(childNamed(model.root!, 'Sparks'), 'ParticleUpdate');

	assert.deepEqual(update.children.map((child) => child.name), [
		'ParticleState', 'GravityForce', 'Drag', 'SolveForcesAndVelocity',
		'ScaleSpriteSize', 'Grid3D_ResampleFloat',
	]);
	assert.match(childNamed(update, 'Drag').detail, /@1\.2/);
	assert.match(childNamed(update, 'Grid3D_ResampleFloat').detail, /as Grid3D_ResampleFloat003/);
	assert.equal(childNamed(update, 'ScaleSpriteSize').detail, '2 inputs');
});

test('an hlsl block inside a stack does not end the stack', () => {
	const model = analyze(readFixture('sample.dfs'));
	const sparks = childNamed(model.root!, 'Sparks');
	// Everything after the hlsl assignment is still attributed to the emitter, which is only true if
	// the raw block was read as characters.
	assert.ok(sparks.children.some((child) => child.name === 'Settle'));
	assert.ok(sparks.children.some((child) => child.name === 'Core'));
});

test('stage and event headers are summarised by their argument names', () => {
	const model = analyze(readFixture('sample.dfs'));
	const sparks = childNamed(model.root!, 'Sparks');
	assert.equal(childNamed(sparks, 'Project').detail, 'Stage (DataInterface, NumIterations)');
	assert.equal(childNamed(sparks, 'OnEvent').detail, '(Source, Event, Mode, SpawnNumber)');
});

test("a module's Body is read raw, so its own braces do not close the document", () => {
	const source = readFixture('module.dfm');
	assert.deepEqual(analyze(source).diagnostics, []);

	const root = rootOf(source);
	assert.equal(root.name, 'Modules/M_Fixture');
	assert.deepEqual(root.children.map((child) => child.name), ['Settings', 'Inputs', 'Body']);
	assert.match(childNamed(root, 'Body').detail, /^HLSL, \d+ lines$/);
	assert.deepEqual(childNamed(root, 'Inputs').children.map((child) => child.name),
		['SpinRate', 'bClockwise', 'RateScale']);
});

test('an unclosed block is reported once, at the brace that opened it', () => {
	const model = analyze('System(Name="x")\n{\n    Emitter A\n    {\n');
	assert.equal(model.diagnostics.length, 2, 'the emitter body and the document body are both open');
	for (const diagnostic of model.diagnostics) {
		assert.match(diagnostic.message, /Unclosed/);
		assert.equal(diagnostic.code, undefined, 'a structural observation borrows no DFX code it cannot vouch for');
	}
});

test('a stray closing brace is reported', () => {
	const model = analyze('System(Name="x")\n{\n}\n}\n');
	assert.equal(model.diagnostics.length, 1);
	assert.match(model.diagnostics[0].message, /Unexpected '\}'/);
});

test('every symbol range contains its own selection range', () => {
	// VSCode drops a symbol whose selection escapes its range, silently -- so the invariant is
	// asserted here rather than discovered as a hole in the outline.
	for (const fixture of ['sample.dfs', 'module.dfm']) {
		walk(analyze(readFixture(fixture)).root!, (node) => {
			assert.ok(node.start.offset <= node.selectionStart.offset,
				`${node.name}: selection starts before the range`);
			assert.ok(node.selectionEnd.offset <= node.end.offset,
				`${node.name}: selection ends after the range`);
		});
	}
});

test('malformed input terminates instead of hanging', () => {
	// Every block loop is required to consume at least one token per iteration; this is the test
	// that says so, because the failure mode is a frozen editor rather than a wrong answer.
	const cases = [
		'',
		'{',
		'}',
		'System',
		'System(',
		'System(Name=',
		'System(Name="x") {',
		'System(Name="x") { Emitter { } }',
		'System(Name="x") { ParticleUpdate = { GravityForce( } }',
		'System(Name="x") { Properties = { float } }',
		'System(Name="x") { ParticleUpdate = { Color X = hlsl { unclosed } }',
		'#Region',
		'`',
		'"',
		'/*',
		'@@@@@@',
		'System(Name="x") { '.padEnd(20000, 'a '),
	];

	for (const source of cases) {
		const started = Date.now();
		analyze(source);
		assert.ok(Date.now() - started < 2000, `analysing ${JSON.stringify(source.slice(0, 40))} took too long`);
	}
});

function walk(node: StructureNode, visit: (node: StructureNode) => void): void {
	visit(node);
	for (const child of node.children) {
		walk(child, visit);
	}
}
