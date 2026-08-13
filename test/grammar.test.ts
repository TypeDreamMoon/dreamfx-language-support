/**
 * Real tokenisation of the TextMate grammar, through the same engines VSCode uses.
 *
 * The JSON-integrity tests next door prove the grammar is well-formed; they cannot prove it colours
 * anything. A grammar bug does not raise an error -- the rule simply never fires and one construct
 * quietly loses its colour, which is invisible until someone happens to look at that construct.
 *
 * `source.hlsl` is not loaded here (it ships with VSCode, not with this package), so an include of
 * it resolves to nothing. That is fine and is itself worth knowing: the assertions below are about
 * the *DreamFXLang* scopes and about the raw block being handed over at all, not about how HLSL is
 * coloured once it has been.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import * as oniguruma from 'vscode-oniguruma';
import * as textmate from 'vscode-textmate';

const ROOT = path.join(__dirname, '..', '..');
const GRAMMAR_PATH = path.join(ROOT, 'syntaxes', 'dreamfxlang.tmLanguage.json');

interface TokenInfo {
	line: number;
	text: string;
	scopes: string[];
}

let grammarPromise: Promise<textmate.IGrammar> | undefined;

function loadGrammar(): Promise<textmate.IGrammar> {
	if (!grammarPromise) {
		const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
		const onigLib = oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer)
			.then(() => ({
				createOnigScanner: (patterns: string[]) => new oniguruma.OnigScanner(patterns),
				createOnigString: (text: string) => new oniguruma.OnigString(text),
			}));

		const registry = new textmate.Registry({
			onigLib,
			loadGrammar: async (scopeName: string) =>
				scopeName === 'source.dreamfxlang'
					? textmate.parseRawGrammar(fs.readFileSync(GRAMMAR_PATH, 'utf8'), GRAMMAR_PATH)
					: null,
		});

		grammarPromise = registry.loadGrammar('source.dreamfxlang').then((grammar) => {
			if (!grammar) {
				throw new Error('source.dreamfxlang failed to load');
			}
			return grammar;
		});
	}
	return grammarPromise;
}

async function tokenize(source: string): Promise<TokenInfo[]> {
	const grammar = await loadGrammar();
	const lines = source.split(/\r\n|\r|\n/);

	let stack = textmate.INITIAL;
	const tokens: TokenInfo[] = [];

	lines.forEach((line, index) => {
		const result = grammar.tokenizeLine(line, stack);
		for (const token of result.tokens) {
			const text = line.substring(token.startIndex, token.endIndex);
			if (text.trim().length > 0) {
				tokens.push({ line: index, text, scopes: token.scopes });
			}
		}
		stack = result.ruleStack;
	});

	return tokens;
}

function scopesOf(tokens: TokenInfo[], text: string): string[] {
	const found = tokens.find((token) => token.text.trim() === text);
	if (!found) {
		assert.fail(`no token '${text}' in: ${tokens.map((token) => token.text.trim()).join(' | ')}`);
	}
	return found.scopes;
}

function assertScoped(tokens: TokenInfo[], text: string, scope: string): void {
	const scopes = scopesOf(tokens, text);
	assert.ok(scopes.includes(scope), `'${text}' is ${scopes.join(', ')} -- expected ${scope}`);
}

test('the document header, stacks and sections are keywords', async () => {
	const tokens = await tokenize([
		'System(Name="Samples/NS_Spark", Root="Game")',
		'{',
		'    Settings = { }',
		'    Emitter Sparks',
		'    {',
		'        ParticleUpdate = { }',
		'    }',
		'}',
	].join('\n'));

	assertScoped(tokens, 'System', 'storage.type.document.dreamfxlang');
	assertScoped(tokens, 'Settings', 'keyword.control.section.dreamfxlang');
	assertScoped(tokens, 'Emitter', 'storage.type.emitter.dreamfxlang');
	assertScoped(tokens, 'Sparks', 'entity.name.type.emitter.dreamfxlang');
	assertScoped(tokens, 'ParticleUpdate', 'keyword.control.stack.dreamfxlang');
});

test('module calls, partial paths, versions and aliases', async () => {
	const tokens = await tokenize([
		'ParticleUpdate = {',
		'    GravityForce(Gravity = (0, 0, -680));',
		'    Spawn/Initialization/V2/InitializeParticle(LifetimeMode = Random);',
		'    disabled Drag@1.2(Drag = 1.4);',
		'    Grid3D_ResampleFloat() as Grid3D_ResampleFloat003;',
		'}',
	].join('\n'));

	assertScoped(tokens, 'GravityForce', 'entity.name.function.dreamfxlang');
	assertScoped(tokens, 'Spawn/Initialization/V2/InitializeParticle', 'entity.name.function.dreamfxlang');
	assertScoped(tokens, 'disabled', 'keyword.control.dreamfxlang');
	assertScoped(tokens, '1.2', 'constant.numeric.version.dreamfxlang');
	assertScoped(tokens, 'as', 'keyword.control.dreamfxlang');
	assertScoped(tokens, 'Random', 'variable.other.enummember.dreamfxlang');
});

test('namespaces, types and the expression whitelist', async () => {
	const tokens = await tokenize([
		'Properties = {',
		'    int   SparkCount = 24;',
		'    float SparkSpeed = 24.0;',
		'    DI<SkeletalMesh> TargetMesh;',
		'}',
		'ParticleSpawn = {',
		'    AddVelocityInCone(ConeAxis = normalize(Particles.Velocity), Alpha = User.SparkSpeed);',
		'}',
	].join('\n'));

	assertScoped(tokens, 'int', 'storage.type.dreamfxlang');
	assertScoped(tokens, 'DI', 'storage.type.dreamfxlang');
	assertScoped(tokens, 'SkeletalMesh', 'entity.name.type.dreamfxlang');
	assertScoped(tokens, 'normalize', 'support.function.builtin.dreamfxlang');
	assertScoped(tokens, 'Particles', 'entity.name.namespace.dreamfxlang');
	assertScoped(tokens, 'User', 'entity.name.namespace.dreamfxlang');

	// 24 and 24.0 are different literals and L7 turns on the difference.
	assertScoped(tokens, '24', 'constant.numeric.integer.dreamfxlang');
	assertScoped(tokens, '24.0', 'constant.numeric.float.dreamfxlang');
});

test('renderers are matched by shape, and Bind by its arrow', async () => {
	const tokens = await tokenize([
		'SpriteRenderer Core',
		'{',
		'    Bind SpriteSize -> Particles.SpriteSize;',
		'}',
		'SomeFutureRenderer Later { }',
	].join('\n'));

	assertScoped(tokens, 'SpriteRenderer', 'storage.type.renderer.dreamfxlang');
	assertScoped(tokens, 'Core', 'entity.name.type.renderer.dreamfxlang');
	assertScoped(tokens, 'Bind', 'keyword.control.dreamfxlang');
	assertScoped(tokens, '->', 'keyword.operator.binding.dreamfxlang');
	// L8 is schema-driven, so a renderer type this grammar has never heard of still colours.
	assertScoped(tokens, 'SomeFutureRenderer', 'storage.type.renderer.dreamfxlang');
});

test('comments, regions and back-quoted names', async () => {
	const tokens = await tokenize([
		'// a line comment',
		'/* a block',
		'   comment */',
		'#Region "Initial state"',
		'`Ring/DiscDistributionMode` = Direct;',
		'#EndRegion',
	].join('\n'));

	// Tokens are compared piecewise: the grammar splits a comment into its delimiter and its text,
	// and a back-quoted name into its quotes and the name they hold.
	assertScoped(tokens, '//', 'comment.line.double-slash.dreamfxlang');
	assertScoped(tokens, 'a line comment', 'comment.line.double-slash.dreamfxlang');
	assertScoped(tokens, '/*', 'comment.block.dreamfxlang');
	assertScoped(tokens, 'a block', 'comment.block.dreamfxlang');
	assertScoped(tokens, '*/', 'comment.block.dreamfxlang');
	assertScoped(tokens, '#Region', 'keyword.control.region.dreamfxlang');
	assertScoped(tokens, '#EndRegion', 'keyword.control.region.dreamfxlang');
	assertScoped(tokens, 'Ring/DiscDistributionMode', 'variable.other.quoted.dreamfxlang');
});

test('a string is not a comment, whatever it contains', async () => {
	const tokens = await tokenize('Material = "/Game/FX//M_Spark"; Alignment = Unaligned;');

	assertScoped(tokens, '/Game/FX//M_Spark', 'string.quoted.double.dreamfxlang');
	// The rule that matters: the `//` inside the path must not swallow the rest of the line.
	assertScoped(tokens, 'Unaligned', 'variable.other.enummember.dreamfxlang');
});

test('an hlsl block is handed over as embedded HLSL and ends where it should', async () => {
	const tokens = await tokenize([
		'Color Particles.Color = hlsl {',
		'    float4(Particles.Color.rgb, 1.0)',
		'};',
		'GravityForce(Gravity = (0, 0, -1));',
	].join('\n'));

	assertScoped(tokens, 'hlsl', 'keyword.other.hlsl.dreamfxlang');
	assertScoped(tokens, 'float4(Particles.Color.rgb, 1.0)', 'meta.embedded.block.hlsl');

	// Back in DreamFXLang afterwards: the block did not run away.
	assertScoped(tokens, 'GravityForce', 'entity.name.function.dreamfxlang');
});

test("a module's Body survives its own braces", async () => {
	const tokens = await tokenize([
		'Module(Name="M", Root="Game")',
		'{',
		'    Body = {',
		'        if (RateScale > 0.0)',
		'        {',
		'            Particles.SpriteRotation += SpinRate;',
		'        }',
		'    }',
		'',
		'    Inputs = { }',
		'}',
	].join('\n'));

	// The line inside the nested if is still embedded -- a grammar that could not count braces would
	// have left the block at the inner '}' and coloured the rest of the file as HLSL.
	assertScoped(tokens, 'Particles.SpriteRotation += SpinRate;', 'meta.embedded.block.hlsl');

	// ...and the section after the body is DreamFXLang again.
	assertScoped(tokens, 'Inputs', 'keyword.control.section.dreamfxlang');
});

test('the whole fixture tokenises with no unscoped runaway', async () => {
	// A cheap global invariant: whatever else happens, no DreamFXLang token may escape the grammar's
	// own scope, which is what a mis-terminated begin/end rule looks like from the outside.
	const source = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'sample.dfs'), 'utf8');
	const tokens = await tokenize(source);

	assert.ok(tokens.length > 200, `only ${tokens.length} tokens -- something swallowed the file`);
	for (const token of tokens) {
		assert.equal(token.scopes[0], 'source.dreamfxlang');
	}

	// The last construct in the file is an emitter pulled in with `from`; if any earlier block ran
	// away, this is the token that stops being a keyword.
	assertScoped(tokens, 'from', 'keyword.control.from.dreamfxlang');
});
