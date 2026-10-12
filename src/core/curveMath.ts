/**
 * The arithmetic of a `curve { }` literal, written to agree with the engine rather than to look right.
 *
 * Every number the curve editor draws is a number the build will produce, so the rules here are
 * Unreal's `FRichCurve`, not a spline that happens to look similar:
 *
 *  * A segment takes its interpolation from its *left* key. The right key's mode says nothing about
 *    the segment that ends at it.
 *  * A cubic segment is a Bézier whose inner control points sit a third of the way along, displaced
 *    by the stored tangents (unweighted -- the compiler writes `RCTWM_WeightedNone`).
 *  * Outside the keys the value holds: the literal never sets an extrapolation, so it is Constant.
 *  * **Tangents are what is stored.** A key written without `Arrive`/`Leave` stores zero, and is
 *    evaluated with zero, whatever its mode says. `Tangent=Auto` only means "re-derive these the
 *    next time something edits the curve" -- see `autoTangent`, which is that re-derivation.
 *
 * No editor types, no DOM: the webview draws with this and the tests check it.
 */

export type CurveInterp = 'Cubic' | 'Linear' | 'Constant';
export type CurveTangentMode = 'Auto' | 'User' | 'Break' | 'None';

export interface CurveKey {
	time: number;
	value: number;
	/** The mode of the segment that *starts* at this key. */
	interp: CurveInterp;
	tangentMode: CurveTangentMode;
	/** Stored slopes, in value per unit time. Zero when the source wrote none. */
	arrive: number;
	leave: number;
}

/** One drawable piece of the curve between two keys, in curve space. */
export type CurveSegment =
	| { kind: 'line'; from: [number, number]; to: [number, number] }
	| { kind: 'step'; from: [number, number]; to: [number, number] }
	| { kind: 'cubic'; from: [number, number]; c1: [number, number]; c2: [number, number]; to: [number, number] };

/** `FRichCurve::Eval` for the subset a literal can express. */
export function evaluate(keys: readonly CurveKey[], time: number): number {
	const count = keys.length;
	if (count === 0) {
		return 0;
	}
	if (count < 2 || time <= keys[0].time) {
		return keys[0].value;
	}
	if (time >= keys[count - 1].time) {
		return keys[count - 1].value;
	}

	// The engine's lower bound, kept as written: with two keys at one time it lands on the later one,
	// which is what makes a duplicated time a jump rather than an average.
	let first = 1;
	let remaining = count - 1 - first;
	while (remaining > 0) {
		const step = Math.floor(remaining / 2);
		const middle = first + step;
		if (time >= keys[middle].time) {
			first = middle + 1;
			remaining -= step + 1;
		} else {
			remaining = step;
		}
	}
	return evaluateBetween(keys[first - 1], keys[first], time);
}

function evaluateBetween(left: CurveKey, right: CurveKey, time: number): number {
	const span = right.time - left.time;
	if (!(span > 0) || left.interp === 'Constant') {
		return left.value;
	}

	const alpha = (time - left.time) / span;
	if (left.interp === 'Linear') {
		return left.value + (right.value - left.value) * alpha;
	}

	const [, [p1, p2]] = cubicControls(left, right);
	return bezier(left.value, p1, p2, right.value, alpha);
}

/** The two inner control *values* of a cubic segment, as `FRichCurve` places them. */
function cubicControls(left: CurveKey, right: CurveKey): [number, [number, number]] {
	const third = (right.time - left.time) / 3;
	return [third, [left.value + left.leave * third, right.value - right.arrive * third]];
}

function bezier(p0: number, p1: number, p2: number, p3: number, alpha: number): number {
	const inverse = 1 - alpha;
	return inverse * inverse * inverse * p0
		+ 3 * inverse * inverse * alpha * p1
		+ 3 * inverse * alpha * alpha * p2
		+ alpha * alpha * alpha * p3;
}

/**
 * The curve as drawing commands, exact rather than sampled.
 *
 * A cubic segment's control times sit at the thirds, so time is linear in the Bézier parameter and
 * the segment is drawable as one cubic Bézier in (time, value) -- the picture is the evaluation,
 * not an approximation of it.
 */
export function segments(keys: readonly CurveKey[]): CurveSegment[] {
	const result: CurveSegment[] = [];
	for (let index = 0; index + 1 < keys.length; index += 1) {
		const left = keys[index];
		const right = keys[index + 1];
		const from: [number, number] = [left.time, left.value];
		const to: [number, number] = [right.time, right.value];

		if (!(right.time > left.time)) {
			// Zero width: the engine jumps, and a vertical line is the honest picture of a jump.
			result.push({ kind: 'line', from, to });
		} else if (left.interp === 'Constant') {
			result.push({ kind: 'step', from, to });
		} else if (left.interp === 'Linear') {
			result.push({ kind: 'line', from, to });
		} else {
			const [third, [p1, p2]] = cubicControls(left, right);
			result.push({ kind: 'cubic', from, c1: [left.time + third, p1], c2: [right.time - third, p2], to });
		}
	}
	return result;
}

/** Lowest and highest value the curve reaches between its first and last key, overshoot included. */
export function valueBounds(keys: readonly CurveKey[]): [number, number] | undefined {
	if (keys.length === 0) {
		return undefined;
	}

	let low = Infinity;
	let high = -Infinity;
	const include = (value: number): void => {
		low = Math.min(low, value);
		high = Math.max(high, value);
	};

	for (const key of keys) {
		include(key.value);
	}
	for (const segment of segments(keys)) {
		if (segment.kind !== 'cubic') {
			continue;
		}
		// Sampled rather than solved: the extrema of a cubic are a quadratic's roots, but sixteen
		// samples are within a pixel at any size this is framed for, and cannot get a sign wrong.
		for (let step = 1; step < 16; step += 1) {
			include(bezier(segment.from[1], segment.c1[1], segment.c2[1], segment.to[1], step / 16));
		}
	}
	return [low, high];
}

/**
 * `FRichCurve::AutoSetTangents` for one key, with the engine's default tension of zero.
 *
 * Kept faithful down to the asymmetries, because the result is written into the source and read back
 * by the engine: the first key loses only its *leave* slope and the last only its *arrive*, an inner
 * cubic key gets the slope of the line between its neighbours, and an inner key next to a constant
 * segment is flattened on the sides that touch it. A key that is not `Auto` comes back unchanged.
 */
export function autoTangent(keys: readonly CurveKey[], index: number): { arrive: number; leave: number } {
	const key = keys[index];
	let { arrive, leave } = key;
	const last = keys.length - 1;

	if (index === 0) {
		if (index < last) {
			if (key.tangentMode === 'Auto') {
				leave = 0;
			}
		} else {
			leave = 0;
		}
	} else if (index < last) {
		const previous = keys[index - 1];
		const next = keys[index + 1];
		if (key.interp === 'Cubic' && key.tangentMode === 'Auto') {
			// ComputeCurveTangent: the uniform-curve tangent, rescaled by the time between neighbours.
			const span = Math.max(1e-4, next.time - previous.time);
			arrive = (next.value - previous.value) / span;
			leave = arrive;
		} else if (previous.interp === 'Constant' || key.interp === 'Constant') {
			if (previous.interp !== 'Cubic') {
				arrive = 0;
			}
			leave = 0;
		}
	} else if (key.interp === 'Cubic' && key.tangentMode === 'Auto') {
		arrive = 0;
	}

	return { arrive, leave };
}

/**
 * Re-derives the `Auto` keys among `indices` in place, the way an edit in the engine's curve editor
 * would. Only the named keys are touched -- the editor passes the keys an edit moved and their
 * neighbours, which are the only ones whose derived slope an edit can change -- so a key nobody went
 * near keeps exactly the slope it was built with.
 */
export function rederiveAutoTangents(keys: CurveKey[], indices: Iterable<number>): void {
	const computed = new Map<number, { arrive: number; leave: number }>();
	for (const index of indices) {
		if (index >= 0 && index < keys.length && keys[index].tangentMode === 'Auto') {
			computed.set(index, autoTangent(keys, index));
		}
	}
	// Computed first, applied after, so the result cannot depend on the order the indices came in.
	for (const [index, tangents] of computed) {
		keys[index].arrive = tangents.arrive;
		keys[index].leave = tangents.leave;
	}
}

/** Sorted by time, stable, so keys at one time keep their written order -- which is their meaning. */
export function sortKeys<T extends CurveKey>(keys: T[]): T[] {
	return keys
		.map((key, index) => ({ key, index }))
		.sort((a, b) => a.key.time - b.key.time || a.index - b.index)
		.map((entry) => entry.key);
}

/**
 * A number spelled exactly as the plugin's exporter spells it (`FormatFloatLossless`): the short
 * `SanitizeFloat` form when it reads back as the same 32-bit float, otherwise `%.7g`, `%.8g` or
 * `%.9g`, whichever is first to survive.
 *
 * Mirrored rather than merely equivalent. The compiler reads every curve number into a `float`, so
 * any spelling that survives would build the same curve -- but an edited key that the next export
 * spells differently is a diff nobody made.
 */
export function formatNumber(value: number): string {
	if (!Number.isFinite(Math.fround(value))) {
		// Unreachable from the editor, and unwritable in the language: there is no spelling to give.
		throw new RangeError(`${value} has no DreamFXLang spelling`);
	}
	const single = Math.fround(value) || 0; // `|| 0` is StripNegativeZero

	const sanitized = sanitizeFloat(single);
	if (Math.fround(Number(sanitized)) === single) {
		return sanitized;
	}
	for (let digits = 7; digits <= 9; digits += 1) {
		const candidate = printfG(single, digits);
		if (Math.fround(Number(candidate)) === single) {
			return /[.e]/.test(candidate) ? candidate : `${candidate}.0`;
		}
	}
	return sanitized; // unreachable: %.9g always round-trips a float
}

/** `FString::SanitizeFloat`: `%f`, then trailing zeros trimmed down to one fractional digit. */
function sanitizeFloat(value: number): string {
	return value.toFixed(6).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '.0');
}

/** C's `%.*g`: shortest of fixed and exponent style by the C rule, trailing zeros removed, `e-07`. */
function printfG(value: number, precision: number): string {
	const exponential = value.toExponential(precision - 1);
	const exponent = Number(exponential.slice(exponential.indexOf('e') + 1));
	if (exponent >= -4 && exponent < precision) {
		return stripFraction(value.toFixed(precision - 1 - exponent));
	}
	const [mantissa, power] = exponential.split('e');
	const sign = power.startsWith('-') ? '-' : '+';
	const digits = power.replace(/^[+-]/, '').padStart(2, '0');
	return `${stripFraction(mantissa)}e${sign}${digits}`;
}

function stripFraction(text: string): string {
	return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/**
 * A value rounded to the precision a pointer can actually place: one step of the decade below what a
 * single pixel covers. Dragging a key should write `0.45`, not `0.4537812`.
 */
export function roundToResolution(value: number, unitsPerPixel: number): number {
	if (!(unitsPerPixel > 0) || !Number.isFinite(value)) {
		return value;
	}
	const step = Math.pow(10, Math.floor(Math.log10(unitsPerPixel)));
	const rounded = Math.round(value / step) * step;
	// Strip the binary residue (0.30000000000000004) so the formatter sees the decimal that was meant.
	const decimals = Math.max(0, -Math.floor(Math.log10(step)));
	return Number(rounded.toFixed(Math.min(decimals, 9)));
}
