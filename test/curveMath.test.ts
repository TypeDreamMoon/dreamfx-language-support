import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	CurveKey,
	autoTangent,
	evaluate,
	formatNumber,
	rederiveAutoTangents,
	roundToResolution,
	segments,
	sortKeys,
	valueBounds,
} from '../src/core/curveMath';

function key(time: number, value: number, extra: Partial<CurveKey> = {}): CurveKey {
	return { time, value, interp: 'Cubic', tangentMode: 'Auto', arrive: 0, leave: 0, ...extra };
}

/** The Hermite form, written independently of the Bézier form the implementation uses. */
function hermite(p0: number, m0: number, p1: number, m1: number, span: number, t: number): number {
	const t2 = t * t;
	const t3 = t2 * t;
	return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0 * span + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1 * span;
}

function close(actual: number, expected: number, message?: string): void {
	assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ''} expected ${expected}, got ${actual}`);
}

// ---------------------------------------------------------------- evaluation

test('outside the keys the value holds, because the literal never sets an extrapolation', () => {
	const keys = [key(0.2, 3), key(0.8, 7, { interp: 'Linear' })];
	assert.equal(evaluate(keys, -5), 3);
	assert.equal(evaluate(keys, 0.2), 3);
	assert.equal(evaluate(keys, 0.8), 7);
	assert.equal(evaluate(keys, 12), 7);
	assert.equal(evaluate([key(0.5, 4)], 100), 4);
	assert.equal(evaluate([], 1), 0);
});

test('a segment takes its interpolation from its left key', () => {
	const linearThenCubic = [key(0, 0, { interp: 'Linear' }), key(1, 1)];
	close(evaluate(linearThenCubic, 0.25), 0.25);

	const constant = [key(0, 2, { interp: 'Constant' }), key(1, 5, { interp: 'Linear' })];
	assert.equal(evaluate(constant, 0.999), 2);
	assert.equal(evaluate(constant, 1), 5);
});

test('a cubic segment is the Hermite curve of the stored tangents', () => {
	const left = key(0.2, 1, { tangentMode: 'User', leave: 3.5 });
	const right = key(0.7, -0.5, { tangentMode: 'Break', arrive: -2, leave: 9 });
	for (const alpha of [0, 0.1, 0.33, 0.5, 0.9, 1]) {
		const time = 0.2 + alpha * 0.5;
		close(evaluate([left, right], time), hermite(1, 3.5, -0.5, -2, 0.5, alpha), `alpha ${alpha}`);
	}
});

test('an Auto key written without tangents is evaluated flat, not derived', () => {
	// The build stores zero, and FRichCurve reads what is stored. A smooth-looking preview here would
	// be a preview of a curve the build does not make.
	const keys = [key(0, 0), key(0.5, 1), key(1, 0)];
	close(evaluate(keys, 0.25), 0.5);
	close(evaluate(keys, 0.5), 1);
});

test('two keys at one time are a jump that lands on the later key', () => {
	const keys = [key(0, 0, { interp: 'Linear' }), key(0.5, 0, { interp: 'Linear' }), key(0.5, 1, { interp: 'Linear' }), key(1, 1)];
	assert.equal(evaluate(keys, 0.4999), 0);
	assert.equal(evaluate(keys, 0.5), 1);
});

test('the drawn segments are the evaluated curve, not a sampling of it', () => {
	const keys = [key(0, 0, { leave: 2, tangentMode: 'User' }), key(0.6, 1, { interp: 'Constant', arrive: -1, tangentMode: 'User' }), key(1, 0.25)];
	const [cubic, step] = segments(keys);
	assert.equal(cubic.kind, 'cubic');
	assert.equal(step.kind, 'step');
	if (cubic.kind !== 'cubic') {
		return;
	}
	close(cubic.c1[0], 0.2);
	close(cubic.c2[0], 0.4);
	close(cubic.c1[1], 0 + 2 * 0.2);
	close(cubic.c2[1], 1 - -1 * 0.2);

	// Midpoint of the Bézier against the evaluator.
	const bezierMid = (cubic.from[1] + 3 * cubic.c1[1] + 3 * cubic.c2[1] + cubic.to[1]) / 8;
	close(evaluate(keys, 0.3), bezierMid);
});

test('value bounds include the overshoot of a cubic segment', () => {
	// Leaves downwards, arrives from above: dips below 0 early and peaks above 1 late.
	const keys = [key(0, 0, { tangentMode: 'User', leave: -6 }), key(1, 1, { tangentMode: 'User', arrive: -6 })];
	const [low, high] = valueBounds(keys)!;
	assert.ok(high > 1.2, `high ${high}`);
	assert.ok(low < -0.2, `low ${low}`);
	assert.equal(valueBounds([]), undefined);
});

// ---------------------------------------------------------------- auto tangents

test('an inner Auto key gets the slope between its neighbours', () => {
	const keys = [key(0, 0), key(0.25, 2), key(1, 1)];
	assert.deepEqual(autoTangent(keys, 1), { arrive: 1, leave: 1 });
});

test('the end keys flatten only the side the engine flattens', () => {
	// FRichCurve::AutoSetTangents zeroes the first key's leave and the last key's arrive and leaves the
	// other side alone -- which is how a stored `Arrive=29.18` on a first key comes to exist at all.
	const keys = [key(0, 0, { arrive: 7, leave: 3 }), key(1, 1, { arrive: 4, leave: 5 })];
	assert.deepEqual(autoTangent(keys, 0), { arrive: 7, leave: 0 });
	assert.deepEqual(autoTangent(keys, 1), { arrive: 0, leave: 5 });
});

test('keys that are not Auto keep their tangents', () => {
	const keys = [key(0, 0), key(0.5, 1, { tangentMode: 'User', arrive: 3, leave: 3 }), key(1, 0)];
	assert.deepEqual(autoTangent(keys, 1), { arrive: 3, leave: 3 });
	const broken = [key(0, 0), key(0.5, 1, { tangentMode: 'Break', arrive: 3, leave: -1 }), key(1, 0)];
	assert.deepEqual(autoTangent(broken, 1), { arrive: 3, leave: -1 });
});

test('an inner key beside a constant segment is flattened on the sides that touch it', () => {
	const afterConstant = [key(0, 0, { interp: 'Constant' }), key(0.5, 1, { interp: 'Linear', arrive: 2, leave: 2 }), key(1, 0)];
	assert.deepEqual(autoTangent(afterConstant, 1), { arrive: 0, leave: 0 });

	const afterCubic = [key(0, 0), key(0.5, 1, { interp: 'Constant', arrive: 2, leave: 2 }), key(1, 0)];
	assert.deepEqual(autoTangent(afterCubic, 1), { arrive: 2, leave: 0 });
});

test('rederiving touches only the keys it is given', () => {
	const keys = [key(0, 0), key(0.25, 1), key(0.5, 0), key(0.75, 1), key(1, 0)];
	rederiveAutoTangents(keys, [1, 2]);
	assert.equal(keys[1].arrive, 0); // (0 - 0) / 0.5
	assert.equal(keys[2].arrive, 0); // (1 - 1) / 0.5
	assert.equal(keys[3].arrive, 0);

	const sloped = [key(0, 0), key(0.25, 1), key(0.5, 2), key(0.75, 3), key(1, 4)];
	rederiveAutoTangents(sloped, [2]);
	assert.equal(sloped[2].leave, 4);
	assert.equal(sloped[1].leave, 0, 'a key outside the set keeps the slope it was built with');
});

test('sorting by time keeps keys at one time in their written order', () => {
	const a = key(0.5, 1);
	const b = key(0.5, 2);
	assert.deepEqual(sortKeys([key(1, 0), a, b, key(0, 0)]).map((entry) => entry.value), [0, 1, 2, 0]);
	const sorted = sortKeys([b, a]);
	assert.equal(sorted[0], b);
});

// ---------------------------------------------------------------- numbers

test('numbers are spelled as the shortest text that reads back as the same float', () => {
	assert.equal(formatNumber(0), '0.0');
	assert.equal(formatNumber(-0), '0.0');
	assert.equal(formatNumber(1), '1.0');
	assert.equal(formatNumber(-2), '-2.0');
	assert.equal(formatNumber(10), '10.0');
	assert.equal(formatNumber(0.85), '0.85');
	assert.equal(formatNumber(0.1), '0.1');
	assert.equal(formatNumber(-4.537578), '-4.537578');
	assert.equal(formatNumber(29.182631), '29.182631');
	assert.equal(formatNumber(1 / 3), '0.33333334');
	assert.equal(formatNumber(1e-7), '1e-07', "C's %g, exponent and all");
	assert.equal(formatNumber(0.0078125), '0.0078125');
	assert.equal(formatNumber(123456.7), '123456.703125');
	assert.equal(formatNumber(1234567.5), '1234567.5');
	assert.equal(formatNumber(Math.fround(0.7)), '0.7', 'a float that came from the source spells back the same');
	assert.throws(() => formatNumber(Number.NaN));
	assert.throws(() => formatNumber(Infinity));
});

test('a dragged value is rounded to what a pixel can place', () => {
	assert.equal(roundToResolution(0.4537812, 0.0033), 0.454);
	assert.equal(roundToResolution(12.3456, 0.2), 12.3);
	assert.equal(roundToResolution(0.1 + 0.2, 0.001), 0.3);
	assert.equal(roundToResolution(5.5, 0), 5.5);
});
