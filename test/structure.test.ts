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

/** The shape of the plugin's Tests/Corpus/Parse/GroupBlocks.dfs: two groups and a loose parameter. */
const GROUPED_SYSTEM = `System(Name="Corpus/NS_GroupBlocks", Root="Plugin.DreamFX")
{
    Properties = {
        Group("Burst") {
            int   SparkCount = 24;
            float SparkSpeed = 450.0;
        }
        Group("Look") {
            Color TintA = (1.0, 0.72, 0.25, 1.0);
        }
        float Loose = 1.0;
    }

    Emitter Sparks
    {
        EmitterUpdate = { EmitterState(); SpawnBurst_Instantaneous(SpawnCount = User.SparkCount, SpawnTime = 0.0); }
        SpriteRenderer Core { }
    }
}
`;

test('a Group scope is an outline node holding its own declarations', () => {
	const model = analyze(GROUPED_SYSTEM);
	assert.deepEqual(model.diagnostics, [], 'the braces of a Group are balanced, whatever opens them');

	const root = rootOf(GROUPED_SYSTEM);
	// Nothing after the Properties block is lost to a brace the walk mistook for the end of it.
	assert.deepEqual(root.children.map((child) => child.name), ['Properties', 'Sparks']);

	const properties = childNamed(root, 'Properties');
	assert.deepEqual(properties.children.map((child) => [child.kind, child.name]), [
		['group', 'Burst'], ['group', 'Look'], ['declaration', 'Loose'],
	]);
	// Parameters, not children: two groups and a loose float are four declarations.
	assert.equal(properties.detail, '4');

	const burst = childNamed(properties, 'Burst');
	assert.equal(burst.detail, 'Group · 2 entries');
	assert.deepEqual(burst.children.map((child) => [child.name, child.detail]), [
		['SparkCount', 'int'], ['SparkSpeed', 'float'],
	]);
	assert.equal(childNamed(properties, 'Look').detail, 'Group · 1 entry');

	const sparks = childNamed(root, 'Sparks');
	assert.deepEqual(sparks.children.map((child) => child.name), ['EmitterUpdate', 'Core']);
});

test('a Group selects its quoted name and spans through its closing brace', () => {
	const model = analyze(GROUPED_SYSTEM);
	const burst = childNamed(childNamed(model.root!, 'Properties'), 'Burst');

	assert.equal(GROUPED_SYSTEM.slice(burst.selectionStart.offset, burst.selectionEnd.offset), '"Burst"');
	assert.ok(GROUPED_SYSTEM.slice(burst.start.offset, burst.end.offset).startsWith('Group("Burst")'));
	assert.ok(GROUPED_SYSTEM.slice(burst.start.offset, burst.end.offset).endsWith('}'));
});

test('nested Groups nest in the outline, and the keyword and a trailing semicolon are tolerated', () => {
	const source = [
		'Module(Name="Modules/M_Nested")',
		'{',
		'    Inputs = {',
		'        group("Outer") {',
		'            float A = 1.0;',
		'            Group("Inner") {',
		'                float B = 2.0 [SortPriority = 5];',
		'                #Region "tail"',
		'                float C = 3.0;',
		'            };',
		'            float D = 4.0;',
		'        };',
		'    }',
		'    Body = { }',
		'}',
		'',
	].join('\n');

	const model = analyze(source);
	assert.deepEqual(model.diagnostics, []);

	const inputs = childNamed(model.root!, 'Inputs');
	assert.equal(inputs.detail, '4');

	const outer = childNamed(inputs, 'Outer');
	assert.deepEqual(outer.children.map((child) => child.name), ['A', 'Inner', 'D']);

	const inner = childNamed(outer, 'Inner');
	assert.deepEqual(inner.children.map((child) => child.name), ['B', 'C']);
	assert.equal(outer.detail, 'Group · 4 entries');
	assert.deepEqual(model.root!.children.map((child) => child.name), ['Inputs', 'Body']);
});

test('a type or name that merely starts with Group is still a declaration', () => {
	const source = 'System(Name="x") { Properties = { float Group = 1.0; int GroupCount = 2; } }';
	const model = analyze(source);
	assert.deepEqual(model.diagnostics, []);
	assert.deepEqual(childNamed(model.root!, 'Properties').children.map((child) => [child.kind, child.name]), [
		['declaration', 'Group'], ['declaration', 'GroupCount'],
	]);
});

test('an unclosed Group is reported at its own brace, and a head still being typed costs only the group', () => {
	const unclosed = analyze('System(Name="x")\n{\n    Properties = {\n        Group("Burst") {\n            int A = 1;\n');
	// Three braces are open at the end of the text -- the group's, the section's, the document's --
	// innermost first, and the group's is reported at the line that opened it.
	assert.deepEqual(unclosed.diagnostics.map((diagnostic) => [diagnostic.message, diagnostic.start.line]), [
		["Unclosed '{': this block is never closed.", 4],
		["Unclosed '{': this block is never closed.", 3],
		["Unclosed '{': this block is never closed.", 2],
	]);

	// Closing only the group leaves the other two open, and the group's own contents are intact.
	const half = analyze('System(Name="x")\n{\n    Properties = {\n        Group("Burst") {\n            int A = 1;\n        }\n');
	assert.equal(half.diagnostics.length, 2);
	assert.deepEqual(childNamed(childNamed(half.root!, 'Properties'), 'Burst').children.map((child) => child.name), ['A']);

	// No brace yet: the compiler complains about the head (DFX2027 and friends), this walk stays out.
	for (const head of ['Group("Burst")', 'Group("Burst"', 'Group(', 'Group(Burst)', 'Group("")']) {
		const source = `System(Name="x") { Properties = { ${head}; float After = 1.0; } Emitter E { } }`;
		const model = analyze(source);
		assert.deepEqual(model.diagnostics, [], `head ${JSON.stringify(head)}`);
		const names = childNamed(model.root!, 'Properties').children.map((child) => child.name);
		assert.ok(names.includes('After'), `head ${JSON.stringify(head)} swallowed the next declaration: ${names.join(', ')}`);
		assert.ok(model.root!.children.some((child) => child.name === 'E'));
	}
});

test('a Group with no usable name is still listed, under its keyword', () => {
	const model = analyze('System(Name="x") { Properties = { Group(Burst) { int A = 1; } Group("") { int B = 2; } } }');
	assert.deepEqual(model.diagnostics, []);
	const groups = childNamed(model.root!, 'Properties').children;
	assert.deepEqual(groups.map((group) => [group.kind, group.name, group.children.length]), [
		['group', 'Group', 1], ['group', 'Group', 1],
	]);
});

test('a stack block is not a place to look for a Group', () => {
	// Group is a parameter-block construct. In a stack it is, at most, a module call of that name --
	// whether such a module exists is the compiler's question, but the outline should list it.
	const model = analyze('System(Name="x") { ParticleUpdate = { Group(A = 1.0); } }');
	assert.deepEqual(model.diagnostics, []);
	const update = childNamed(model.root!, 'ParticleUpdate');
	assert.deepEqual(update.children.map((child) => [child.kind, child.name]), [['moduleCall', 'Group']]);
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
	const sources = [readFixture('sample.dfs'), readFixture('module.dfm'), GROUPED_SYSTEM,
		// Heads and bodies caught mid-typing are where a group's range is easiest to get wrong.
		'System(Name="x") { Properties = { Group("a"',
		'System(Name="x") { Properties = { Group("a") { int B = 1; Group(',
		'System(Name="x") { Properties = { Group(a) }'];
	for (const source of sources) {
		walk(rootOf(source), (node) => {
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
		'System(Name="x") { Properties = { Group } }',
		'System(Name="x") { Properties = { Group( } }',
		'System(Name="x") { Properties = { Group("a" } }',
		'System(Name="x") { Properties = { Group("a") { Group("b") { Group("c") {',
		'System(Name="x") { Properties = { Group("a")); } float B = 1.0; }',
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
