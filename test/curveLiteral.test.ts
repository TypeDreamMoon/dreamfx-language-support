import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	CurveLiteral,
	EditedCurveKey,
	applyReplacements,
	curveLiteralAt,
	findCurveLiterals,
	formatKey,
	planCurveEdit,
	sameKey,
} from '../src/core/curveLiteral';
import { CurveKey, sortKeys } from '../src/core/curveMath';

/** The plugin's own round-trip fixture for tangents (`Tests/Corpus/RoundTrip/CurveTangents.dfs`), trimmed. */
const TANGENTS = `System(Name="Corpus/NS_CurveTangents", Root="Plugin.DreamFX")
{
    Emitter Motes
    {
        EmitterUpdate = {
            SpawnRate(SpawnRate = 20.0);
        }

        ParticleUpdate = {
            ScaleSpriteSize(
                ScaleSpriteSizeMode = Uniform,
                UniformScaleFactor  = FloatFromCurve(
                    FloatCurve = curve {
                        0.0 -> 0.0 [ Interp=Cubic; Tangent=Auto; Arrive=29.182631; Leave=1.5 ];
                        0.3 -> 1.0 [ Interp=Cubic; Arrive=0.25; Leave=0.25 ];
                        0.6 -> 0.8 [ Interp=Cubic; Tangent=Break; Arrive=-4.537578; Leave=0.5 ];
                        0.8 -> 0.4 [ Interp=Cubic; Tangent=Break; Arrive=0.0; Leave=-2.25 ];
                        1.0 -> 0.0 [ Interp=Linear ];
                    },
                    CurveIndex = Particles.NormalizedAge
                )
            );
        }
    }
}
`;

/** Hand-written, commented, columns lined up: the shape an edit must not trample. */
const COMMENTED = `X = FloatFromCurve(
    FloatCurve = curve {
        // rise
        0.0 -> 1.0;
        0.7 -> 0.85 [ Interp=Cubic; Arrive=-0.4; Leave=-1.2 ];   // shoulder
        1.0 -> 0.0  [ Interp=Linear ];
    },
    CurveIndex = Particles.NormalizedAge
)
`;

const INLINE = 'A = FloatFromCurve(FloatCurve = curve { 0.0 -> 1.0; 1.0 -> 0.0; }, CurveIndex = Particles.NormalizedAge)';

function only(source: string): CurveLiteral {
	const literals = findCurveLiterals(source);
	assert.equal(literals.length, 1, `expected one literal, found ${literals.length}`);
	return literals[0];
}

function key(time: number, value: number, extra: Partial<CurveKey> = {}): CurveKey {
	return { time, value, interp: 'Cubic', tangentMode: 'Auto', arrive: 0, leave: 0, ...extra };
}

/** The literal's keys as an edit would start from them. */
function editable(literal: CurveLiteral): EditedCurveKey[] {
	return literal.keys.map(({ time, value, interp, tangentMode, arrive, leave }, origin) =>
		({ time, value, interp, tangentMode, arrive, leave, origin }));
}

/** Plans, applies, re-reads, and checks the result means exactly `next`. */
function edit(source: string, next: EditedCurveKey[]): string {
	const literal = only(source);
	const result = applyReplacements(source, planCurveEdit(source, literal, next));
	const reread = only(result);
	assert.deepEqual(reread.problems, [], `the rewrite does not read back:\n${result}`);
	assert.equal(reread.keys.length, next.length, result);
	reread.keys.forEach((written, index) => {
		assert.ok(sameKey(written, next[index]), `key ${index} reads back differently:\n${result}`);
	});
	return result;
}

// ---------------------------------------------------------------- reading

test('every tangent shape the exporter writes reads back as what it means', () => {
	const literal = only(TANGENTS);
	assert.deepEqual(literal.problems, []);
	assert.equal(literal.inputName, 'FloatCurve');
	assert.deepEqual(literal.context, ['Motes', 'ParticleUpdate', 'ScaleSpriteSize', 'UniformScaleFactor = FloatFromCurve']);

	const [autoWithSlope, user, corner, flatCorner, linear] = literal.keys;
	assert.equal(autoWithSlope.tangentMode, 'Auto');
	assert.equal(autoWithSlope.arrive, Math.fround(29.182631));
	assert.equal(autoWithSlope.leave, 1.5);
	assert.equal(user.tangentMode, 'User', 'bare numbers mean User');
	assert.equal(corner.tangentMode, 'Break');
	assert.equal(corner.arrive, Math.fround(-4.537578));
	assert.equal(flatCorner.arrive, 0);
	assert.equal(flatCorner.leave, -2.25);
	assert.equal(linear.interp, 'Linear');
	assert.equal(linear.tangentMode, 'Auto', 'no numbers mean Auto');
	assert.equal(linear.interpWritten, 'Linear');
});

test('an unwritten interpolation is cubic and an unwritten tangent is an Auto zero', () => {
	const literal = only(INLINE);
	assert.deepEqual(literal.problems, []);
	assert.deepEqual(literal.keys.map((entry) => [entry.time, entry.value, entry.interp, entry.tangentMode, entry.arrive, entry.leave]),
		[[0, 1, 'Cubic', 'Auto', 0, 0], [1, 0, 'Cubic', 'Auto', 0, 0]]);
	assert.equal(literal.keys[0].interpWritten, undefined);
});

test('the spans cover the key and its semicolon, and the literal its braces', () => {
	const literal = only(COMMENTED);
	const shoulder = literal.keys[1];
	assert.equal(COMMENTED.slice(shoulder.start, shoulder.end), '0.7 -> 0.85 [ Interp=Cubic; Arrive=-0.4; Leave=-1.2 ]');
	assert.equal(COMMENTED.slice(shoulder.end, shoulder.statementEnd), ';');
	assert.equal(COMMENTED.slice(literal.start, literal.start + 5), 'curve');
	assert.equal(COMMENTED[literal.open], '{');
	assert.equal(COMMENTED[literal.close], '}');
	assert.equal(literal.end, literal.close + 1);
	assert.equal(literal.line, 2);
});

test('only a value position holds a literal, and HLSL is never looked inside', () => {
	const source = `System(Name="T")
{
    Emitter curve
    {
        ParticleUpdate = {
            M(Value = hlsl { curve { 1 -> 2; } });
            N(Value = Curve { 0 -> 1; });
        }
    }
}
Module(Name="M")
{
    Body = {
        struct curve { float x; };
    }
}
`;
	const literals = findCurveLiterals(source);
	assert.equal(literals.length, 1, 'the emitter named curve, the HLSL and the module body are not literals');
	assert.equal(literals[0].inputName, 'Value', 'and the keyword is case-blind, as FString == is');
});

test('literals are found in order, and the one under an offset is the one returned', () => {
	const source = `${INLINE}\n${COMMENTED}`;
	const literals = findCurveLiterals(source);
	assert.equal(literals.length, 2);
	assert.equal(curveLiteralAt(source, literals[1].start + 3)?.start, literals[1].start);
	assert.equal(curveLiteralAt(source, literals[0].end)?.start, literals[0].start, 'the closing brace counts');
	assert.equal(curveLiteralAt(source, 0), undefined);
});

test('what the compiler would refuse is reported, and blocks a rewrite', () => {
	const cases: Array<[string, RegExp]> = [
		['curve { 0.0 -> 1.0 [ Interp=Smooth ]; }', /DFX4039/],
		['curve { 0.0 -> 1.0 [ Tangent=Clamped ]; }', /DFX4042/],
		['curve { 0.0 -> 1.0 [ Weight=2 ]; }', /DFX2020/],
		['curve { 0.0 -> 1.0 [ Arrive=User.Slope ]; }', /plain number/],
		['curve { 0.0 1.0; }', /'->'/],
		['curve { x -> 1.0; }', /DFX2003/],
		['curve { 0.0 -> 1.0;', /closing/],
	];
	for (const [body, expected] of cases) {
		const literal = only(`V = ${body}`);
		assert.ok(literal.problems.some((problem) => expected.test(problem)), `${body}: ${literal.problems.join(' | ')}`);
		assert.throws(() => planCurveEdit(`V = ${body}`, literal, []));
	}
});

test('attribute names, spellings and separators are read as loosely as the compiler reads them', () => {
	const literal = only('V = curve { 0.0 -> 1.0 [ interp=linear, tangent=BREAK, arrive=+-2, leave=1e-1 ] 1.0 -> -0.5 }');
	assert.deepEqual(literal.problems, []);
	const [first, second] = literal.keys;
	assert.equal(first.interp, 'Linear');
	assert.equal(first.tangentMode, 'Break');
	assert.equal(first.arrive, -2);
	assert.equal(first.leave, Math.fround(0.1));
	assert.equal(second.value, -0.5);
});

// ---------------------------------------------------------------- spelling

test('a key is spelled the way the exporter spells it', () => {
	assert.equal(formatKey(key(0, 1)), '0.0 -> 1.0');
	assert.equal(formatKey(key(1, 0, { interp: 'Linear' })), '1.0 -> 0.0 [ Interp=Linear ]');
	assert.equal(formatKey(key(0.5, 1, { tangentMode: 'User', arrive: 0.25, leave: 0.25 })), '0.5 -> 1.0 [ Arrive=0.25; Leave=0.25 ]');
	assert.equal(formatKey(key(0.5, 1, { tangentMode: 'User' })), '0.5 -> 1.0 [ Arrive=0.0; Leave=0.0 ]',
		'a flat User key keeps its numbers, or it would read back as Auto');
	assert.equal(formatKey(key(0.5, 1, { tangentMode: 'Auto', arrive: 2, leave: 2 })), '0.5 -> 1.0 [ Tangent=Auto; Arrive=2.0; Leave=2.0 ]',
		'an Auto key with a stored slope names its mode, or it would read back as User');
	assert.equal(formatKey(key(0.5, 1, { tangentMode: 'Break', arrive: 0, leave: -2.25 })), '0.5 -> 1.0 [ Tangent=Break; Arrive=0.0; Leave=-2.25 ]');
	assert.equal(formatKey(key(0.5, 1, { tangentMode: 'None' })), '0.5 -> 1.0 [ Tangent=None; Arrive=0.0; Leave=0.0 ]');
	assert.equal(formatKey(key(0.5, 1, { interp: 'Constant', tangentMode: 'Break', arrive: 1, leave: 2 })),
		'0.5 -> 1.0 [ Interp=Constant; Tangent=Break; Arrive=1.0; Leave=2.0 ]');
});

test("an author's spelling survives while it still means the same thing", () => {
	assert.equal(formatKey(key(0, 1), { interpWritten: 'Auto' }), '0.0 -> 1.0 [ Interp=Auto ]');
	assert.equal(formatKey(key(0, 1, { interp: 'Linear' }), { interpWritten: 'Auto' }), '0.0 -> 1.0 [ Interp=Linear ]');
	assert.equal(formatKey(key(0, 1), { interpWritten: 'Cubic' }), '0.0 -> 1.0 [ Interp=Cubic ]', 'written stays written');
	assert.equal(formatKey(key(0, 1, { tangentMode: 'User', arrive: 1, leave: 1 }), { tangentWritten: 'User' }),
		'0.0 -> 1.0 [ Tangent=User; Arrive=1.0; Leave=1.0 ]');
	assert.equal(formatKey(key(0, 1), { tangentWritten: 'Auto' }), '0.0 -> 1.0', 'Auto with no slope says nothing worth a word');
	assert.equal(formatKey(key(0, 1, { arrive: 2, leave: 2 }), { tangentWritten: 'auto' }), '0.0 -> 1.0 [ Tangent=auto; Arrive=2.0; Leave=2.0 ]');
});

test('every spelling reads back as the key it was spelled from', () => {
	const modes = ['Auto', 'User', 'Break', 'None'] as const;
	const interps = ['Cubic', 'Linear', 'Constant'] as const;
	for (const tangentMode of modes) {
		for (const interp of interps) {
			for (const [arrive, leave] of [[0, 0], [1.5, 1.5], [-2, 0.125]]) {
				const original = key(0.25, -3.5, { interp, tangentMode, arrive, leave });
				const reread = only(`V = curve { ${formatKey(original)}; }`).keys[0];
				assert.ok(sameKey(reread, original), `${formatKey(original)} read back as ${JSON.stringify(reread)}`);
			}
		}
	}
});

// ---------------------------------------------------------------- rewriting

test('an unchanged curve produces no edit at all', () => {
	for (const source of [TANGENTS, COMMENTED, INLINE]) {
		const literal = only(source);
		assert.deepEqual(planCurveEdit(source, literal, editable(literal)), []);
	}
});

test('changing one key rewrites that key and nothing else', () => {
	const next = editable(only(COMMENTED));
	next[1].value = 0.9;
	const result = edit(COMMENTED, next);
	assert.equal(result, COMMENTED.replace('0.7 -> 0.85 [ Interp=Cubic;', '0.7 -> 0.9 [ Interp=Cubic;'),
		'the comment, the padding and the other keys are untouched');
});

test('a removed key takes its line and its comment with it', () => {
	const next = editable(only(COMMENTED)).filter((_, index) => index !== 1);
	const result = edit(COMMENTED, next);
	assert.ok(!result.includes('shoulder'));
	assert.ok(result.includes('        // rise\n        0.0 -> 1.0;\n        1.0 -> 0.0  [ Interp=Linear ];\n    },'), result);
});

test('a new key goes on its own line between its neighbours, at their indentation', () => {
	const next: EditedCurveKey[] = editable(only(COMMENTED));
	next.splice(1, 0, key(0.35, 0.95));
	const result = edit(COMMENTED, next);
	assert.ok(result.includes('        0.0 -> 1.0;\n        0.35 -> 0.95;\n        0.7 -> 0.85'), result);
});

test('new keys at either end land before the first and after the last', () => {
	const next: EditedCurveKey[] = [key(-0.5, 0), ...editable(only(COMMENTED)), key(2, 2), key(3, 3)];
	const result = edit(COMMENTED, next);
	assert.ok(result.includes('        // rise\n        -0.5 -> 0.0;\n        0.0 -> 1.0;'), result);
	assert.ok(result.includes('[ Interp=Linear ];\n        2.0 -> 2.0;\n        3.0 -> 3.0;\n    },'), result);
});

test('an inline literal stays inline', () => {
	const added: EditedCurveKey[] = editable(only(INLINE));
	added.splice(1, 0, key(0.5, 0.25, { interp: 'Linear' }));
	assert.equal(edit(INLINE, added), INLINE.replace('0.0 -> 1.0; 1.0', '0.0 -> 1.0; 0.5 -> 0.25 [ Interp=Linear ]; 1.0'));

	const withoutFirst = editable(only(INLINE)).slice(1);
	assert.equal(edit(INLINE, withoutFirst), INLINE.replace('0.0 -> 1.0; ', ''));

	const withoutLast = editable(only(INLINE)).slice(0, 1);
	assert.equal(edit(INLINE, withoutLast), INLINE.replace(' 1.0 -> 0.0;', ''));

	const prepended: EditedCurveKey[] = [key(-1, 5), ...editable(only(INLINE))];
	assert.equal(edit(INLINE, prepended), INLINE.replace('{ 0.0', '{ -1.0 -> 5.0; 0.0'));
});

test('a key dragged past its neighbour is written back in time order', () => {
	const next = editable(only(COMMENTED));
	next[0].time = 0.8; // past the shoulder
	const sorted = sortKeys(next);
	const result = edit(COMMENTED, sorted);
	const times = only(result).keys.map((entry) => entry.time);
	assert.deepEqual(times, [Math.fround(0.7), Math.fround(0.8), 1]);
	assert.ok(result.includes('// rise') && result.includes('// shoulder'), 'comments stay where they were');
});

test('replacing every key keeps the braces and the layout', () => {
	const next = [key(0, 0), key(1, 1, { interp: 'Linear' })];
	const result = edit(COMMENTED, next);
	assert.ok(result.includes('    FloatCurve = curve {\n        // rise\n        0.0 -> 0.0;\n        1.0 -> 1.0 [ Interp=Linear ];\n    },'), result);
});

test('an empty literal is filled, inline or not', () => {
	assert.equal(edit('V = curve { }', [key(0, 1)]), 'V = curve { 0.0 -> 1.0; }');
	assert.equal(edit('V = curve {}', [key(0, 1)]), 'V = curve { 0.0 -> 1.0; }');
	assert.equal(edit('    V = curve {\n    }', [key(0, 1), key(1, 0)]), '    V = curve {\n        0.0 -> 1.0;\n        1.0 -> 0.0;\n    }');
	assert.equal(edit('\tV = curve {\n\t}', [key(0, 1)]), '\tV = curve {\n\t\t0.0 -> 1.0;\n\t}', 'tabs stay tabs');
});

test('a brace on the last key line is kept on the last key line', () => {
	const source = 'V = curve {\n    0.0 -> 1.0; }';
	assert.equal(edit(source, [...editable(only(source)), key(1, 0)]), 'V = curve {\n    0.0 -> 1.0;\n    1.0 -> 0.0; }');
});

test('CRLF stays CRLF', () => {
	const source = COMMENTED.replace(/\n/g, '\r\n');
	const next: EditedCurveKey[] = editable(only(source));
	next.splice(2, 0, key(0.9, 0.5));
	const result = edit(source, next);
	assert.ok(!/[^\r]\n/.test(result), 'a bare LF crept in');
	assert.ok(result.includes('\r\n        0.9 -> 0.5;\r\n'));
});

test('a key that lost its slope stops writing it, and stops naming its mode', () => {
	const literal = only(TANGENTS);
	const next = editable(literal);
	// The first key goes back to a plain Auto zero; the User key gets a new slope.
	next[0].arrive = 0;
	next[0].leave = 0;
	next[1].arrive = next[1].leave = 1;
	const result = edit(TANGENTS, next);
	assert.ok(result.includes('0.0 -> 0.0 [ Interp=Cubic ];'), result);
	assert.ok(result.includes('0.3 -> 1.0 [ Interp=Cubic; Arrive=1.0; Leave=1.0 ];'), result);
});

test('random edit sequences always read back as exactly what was asked for', () => {
	// A small LCG so a failure reproduces.
	let seed = 20261012;
	const random = (): number => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return seed / 2147483648;
	};
	const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)];
	const round = (value: number): number => Math.round(value * 100) / 100;

	for (const start of [COMMENTED, INLINE, TANGENTS, 'V = curve { }', 'V = curve {\n}']) {
		let source = start;
		for (let step = 0; step < 40; step += 1) {
			const literal = only(source);
			let next: EditedCurveKey[] = editable(literal);

			switch (pick(['move', 'add', 'remove', 'mode', 'replace'] as const)) {
				case 'move':
					if (next.length > 0) {
						const target = pick(next);
						target.time = round(random() * 2 - 0.5);
						target.value = round(random() * 4 - 2);
					}
					break;
				case 'add':
					next.push(key(round(random() * 2), round(random() * 2)));
					break;
				case 'remove':
					if (next.length > 0) {
						next.splice(Math.floor(random() * next.length), 1);
					}
					break;
				case 'mode':
					if (next.length > 0) {
						const target = pick(next);
						target.interp = pick(['Cubic', 'Linear', 'Constant'] as const);
						target.tangentMode = pick(['Auto', 'User', 'Break', 'None'] as const);
						target.arrive = round(random() * 4 - 2);
						target.leave = target.tangentMode === 'Break' ? round(random() * 4 - 2) : target.arrive;
					}
					break;
				case 'replace':
					next = [key(0, round(random())), key(1, round(random()))];
					break;
			}

			try {
				source = edit(source, sortKeys(next));
			} catch (error) {
				assert.fail(`step ${step}: ${String(error)}
--- source
${source}
--- next
${JSON.stringify(sortKeys(next))}`);
			}
		}
	}
});
