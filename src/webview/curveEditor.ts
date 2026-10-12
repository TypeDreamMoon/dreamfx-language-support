/**
 * The curve editor page: draws one curve literal and turns pointer gestures into key edits.
 *
 * It holds no curve of its own for longer than a gesture. The keys come from the host, read out of
 * the source; a finished gesture sends the whole key list back to be written into the source; the
 * host re-reads and sends the result. What is drawn between those two moments is a preview of the
 * edit, computed with the same arithmetic the build uses (`core/curveMath.ts`).
 *
 * Gestures, after Unreal's curve editor:
 *   click / shift-click / ctrl-click   select, add to, toggle
 *   drag a key                         move the selected keys (shift: one axis)
 *   drag a tangent handle              set the slope (an Auto key becomes User; Break keeps sides apart)
 *   drag the background                box select
 *   right or middle drag               pan;  wheel: zoom (shift: time only, alt: value only)
 *   double-click                       add a key -- on the curve when near it
 *   Delete, Ctrl+A, F, Escape, Ctrl+Z / Ctrl+Y
 */

import {
	CurveKey,
	evaluate,
	formatNumber,
	rederiveAutoTangents,
	roundToResolution,
	segments,
	sortKeys,
	valueBounds,
} from '../core/curveMath';
import type { CurveEditorState, FromCurveEditor, ToCurveEditor } from '../curveEditorProtocol';

interface VsCodeApi {
	postMessage(message: FromCurveEditor): void;
	getState(): unknown;
	setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface Key extends CurveKey {
	/** Local identity, stable across re-sorting; selection is kept by it. */
	id: number;
	/** The key's index in the source as last read, or absent for a key added since. */
	origin?: number;
}

interface View {
	t0: number;
	t1: number;
	v0: number;
	v1: number;
}

interface Saved {
	target: number;
	view: View;
}

type Gesture =
	| { kind: 'press'; pointer: number; x: number; y: number; keyId?: number; collapse: boolean }
	| { kind: 'move'; pointer: number; x: number; y: number; snapshot: Key[]; moving: Set<number> }
	| { kind: 'tangent'; pointer: number; keyId: number; side: 'arrive' | 'leave'; snapshot: Key[] }
	| { kind: 'marquee'; pointer: number; x: number; y: number; toX: number; toY: number; base: Set<number> }
	| { kind: 'pan'; pointer: number; x: number; y: number; view: View };

const MARGIN = { left: 52, right: 14, top: 12, bottom: 26 };
const KEY_SIZE = 4.5;
const HIT_RADIUS = 8;
const HANDLE_LENGTH = 52;
const DRAG_THRESHOLD = 3;

/** Unit-range shapes, scaled to the curve's current time range when applied. */
const TEMPLATES: Array<{ name: string; keys: Array<[number, number, Partial<CurveKey>?]> }> = [
	{ name: 'Linear rise', keys: [[0, 0, { interp: 'Linear' }], [1, 1, { interp: 'Linear' }]] },
	{ name: 'Linear fall', keys: [[0, 1, { interp: 'Linear' }], [1, 0, { interp: 'Linear' }]] },
	{ name: 'Ease in', keys: [[0, 0], [1, 1, { tangentMode: 'User', arrive: 2, leave: 2 }]] },
	{ name: 'Ease out', keys: [[0, 0, { tangentMode: 'User', arrive: 2, leave: 2 }], [1, 1]] },
	{ name: 'Smooth rise', keys: [[0, 0], [1, 1]] },
	{ name: 'Smooth fall', keys: [[0, 1], [1, 0]] },
	{ name: 'Bell', keys: [[0, 0], [0.5, 1], [1, 0]] },
	{ name: 'Fade in, hold, fade out', keys: [[0, 0], [0.2, 1], [0.8, 1], [1, 0]] },
	{ name: 'Constant', keys: [[0, 1]] },
];

const vscode = acquireVsCodeApi();

const canvas = element<HTMLCanvasElement>('canvas');
const graph = element<HTMLDivElement>('graph');
const readout = element<HTMLDivElement>('readout');
const banner = element<HTMLDivElement>('banner');
const templateSelect = element<HTMLSelectElement>('template');
const fields = {
	time: element<HTMLInputElement>('time'),
	value: element<HTMLInputElement>('value'),
	arrive: element<HTMLInputElement>('arrive'),
	leave: element<HTMLInputElement>('leave'),
};
const context = canvas.getContext('2d')!;

let state: CurveEditorState | undefined;
let keys: Key[] = [];
let selection = new Set<number>();
let nextId = 1;
let view: View = { t0: -0.05, t1: 1.05, v0: -0.1, v1: 1.1 };
let gesture: Gesture | undefined;
let hover: { x: number; y: number } | undefined;
/** An edit has been sent and its result has not come back yet. */
let pending = false;
/** The latest edit made while one was pending; sent when the result arrives. */
let queued: Key[] | undefined;

function element<T extends HTMLElement>(id: string): T {
	return document.getElementById(id) as T;
}

// ==================================================================== messages

window.addEventListener('message', (event: MessageEvent<ToCurveEditor>) => {
	const message = event.data;
	if (message.type === 'state') {
		receive(message);
	} else if (message.type === 'focus' && state && message.target === state.target && !gesture) {
		selection = new Set(keys.filter((key) => key.origin !== undefined && message.origins.includes(key.origin)).map((key) => key.id));
		refresh();
	}
});

function receive(next: CurveEditorState): void {
	const retargeted = !state || state.target !== next.target;
	const previous = state;
	state = next;

	if (retargeted) {
		gesture = undefined;
		pending = false;
		queued = undefined;
		adopt(next, false);
		const saved = vscode.getState() as Saved | undefined;
		if (saved && saved.target === next.target) {
			view = saved.view;
		} else {
			frame();
		}
	} else if (next.cause === 'edit') {
		pending = false;
		if (queued) {
			// The author kept going while the last edit was in flight; this is the newer one.
			const newer = queued;
			queued = undefined;
			send(newer);
		} else if (!gesture) {
			adopt(next, true);
		}
	} else {
		// A change from outside -- the author typed, undid, or an edit was refused. The text wins.
		pending = false;
		queued = undefined;
		gesture = undefined;
		adopt(next, previous !== undefined && previous.keys.length === next.keys.length);
	}

	renderChrome();
	refresh();
}

/** Takes the host's keys, keeping selection by position when the key count says nothing moved. */
function adopt(next: CurveEditorState, keepSelection: boolean): void {
	const incoming = sortKeys(next.keys.map((key, index): Key => ({ ...key, id: 0, origin: index })));
	const selected = new Set(keys.map((key, index) => (selection.has(key.id) ? index : -1)).filter((index) => index >= 0));
	const reuse = keepSelection && incoming.length === keys.length;

	incoming.forEach((key, index) => {
		key.id = reuse ? keys[index].id : nextId++;
	});
	keys = incoming;
	selection = reuse ? new Set(incoming.filter((_, index) => selected.has(index)).map((key) => key.id)) : new Set();
}

function editable(): boolean {
	return state?.editable === true;
}

/** Sends the keys to be written into the source. They are already in time order. */
function commit(): void {
	if (!editable()) {
		return;
	}
	if (pending) {
		queued = keys.map((key) => ({ ...key }));
		return;
	}
	send(keys);
}

function send(list: Key[]): void {
	vscode.postMessage({
		type: 'edit',
		target: state!.target,
		version: state!.version,
		keys: list.map(({ time, value, interp, tangentMode, arrive, leave, origin }) =>
			({ time, value, interp, tangentMode, arrive, leave, origin })),
	});
	// Once written, the source holds exactly these keys in exactly this order, so this is what each
	// one's origin will be -- which is what lets a second edit follow before the first comes back.
	for (const live of keys) {
		const index = list.findIndex((sent) => sent.id === live.id);
		live.origin = index >= 0 ? index : undefined;
	}
	pending = true;
}

function postSelection(): void {
	if (!state) {
		return;
	}
	const origins = keys.filter((key) => selection.has(key.id) && key.origin !== undefined).map((key) => key.origin!);
	vscode.postMessage({ type: 'select', target: state.target, origins });
}

function persist(): void {
	if (state) {
		vscode.setState({ target: state.target, view } satisfies Saved);
	}
}

// ==================================================================== geometry

function plot(): { x: number; y: number; w: number; h: number } {
	const width = canvas.clientWidth;
	const height = canvas.clientHeight;
	return {
		x: MARGIN.left,
		y: MARGIN.top,
		w: Math.max(10, width - MARGIN.left - MARGIN.right),
		h: Math.max(10, height - MARGIN.top - MARGIN.bottom),
	};
}

function xOf(time: number, area = plot(), within = view): number {
	return area.x + ((time - within.t0) / (within.t1 - within.t0)) * area.w;
}

function yOf(value: number, area = plot(), within = view): number {
	return area.y + ((within.v1 - value) / (within.v1 - within.v0)) * area.h;
}

function timeAt(x: number, area = plot()): number {
	return view.t0 + ((x - area.x) / area.w) * (view.t1 - view.t0);
}

function valueAt(y: number, area = plot()): number {
	return view.v1 - ((y - area.y) / area.h) * (view.v1 - view.v0);
}

function timePerPixel(): number {
	return (view.t1 - view.t0) / plot().w;
}

function valuePerPixel(): number {
	return (view.v1 - view.v0) / plot().h;
}

/** Screen offset of a tangent handle from its key, for a slope in value per unit time. */
function handleOffset(slope: number): [number, number] {
	const area = plot();
	const dx = area.w / (view.t1 - view.t0);
	const dy = -slope * (area.h / (view.v1 - view.v0));
	const length = Math.hypot(dx, dy) || 1;
	return [(dx / length) * HANDLE_LENGTH, (dy / length) * HANDLE_LENGTH];
}

/** Which tangents a key shows: only the ones that shape a cubic segment. */
function visibleHandles(index: number): Array<'arrive' | 'leave'> {
	const sides: Array<'arrive' | 'leave'> = [];
	if (index > 0 && keys[index - 1].interp === 'Cubic') {
		sides.push('arrive');
	}
	if (index < keys.length - 1 && keys[index].interp === 'Cubic') {
		sides.push('leave');
	}
	return sides;
}

function handlePosition(index: number, side: 'arrive' | 'leave'): [number, number] {
	const key = keys[index];
	const [dx, dy] = handleOffset(side === 'arrive' ? key.arrive : key.leave);
	const sign = side === 'arrive' ? -1 : 1;
	return [xOf(key.time) + sign * dx, yOf(key.value) + sign * dy];
}

function keyAt(x: number, y: number): Key | undefined {
	let best: Key | undefined;
	let bestDistance = HIT_RADIUS;
	for (const key of keys) {
		const distance = Math.hypot(xOf(key.time) - x, yOf(key.value) - y);
		if (distance <= bestDistance) {
			best = key;
			bestDistance = distance;
		}
	}
	return best;
}

function handleAt(x: number, y: number): { key: Key; side: 'arrive' | 'leave' } | undefined {
	for (let index = 0; index < keys.length; index += 1) {
		if (!selection.has(keys[index].id)) {
			continue;
		}
		for (const side of visibleHandles(index)) {
			const [hx, hy] = handlePosition(index, side);
			if (Math.hypot(hx - x, hy - y) <= HIT_RADIUS) {
				return { key: keys[index], side };
			}
		}
	}
	return undefined;
}

function roundSlope(slope: number): number {
	return Math.abs(slope) < 1e-6 ? 0 : Number(slope.toPrecision(4));
}

// ==================================================================== edits

function clone(list: readonly Key[]): Key[] {
	return list.map((key) => ({ ...key }));
}

/**
 * Sorts the result of an edit and re-derives the Auto keys it can have changed: the edited keys and
 * their neighbours, both where they were and where they are now. An Auto key's slope depends on
 * nothing but its neighbours, so every other key keeps the slope it was built with -- including a
 * hand-written key whose stored zero would come out differently if it were re-derived.
 */
function settle(before: readonly Key[], after: Key[], edited: Iterable<number>): Key[] {
	const ids = new Set(edited);
	const sorted = sortKeys(after);
	const touched = new Set<number>();
	const collect = (list: readonly Key[], includeSelf: boolean): void => {
		list.forEach((key, index) => {
			if (ids.has(key.id)) {
				if (includeSelf) {
					touched.add(key.id);
				}
				for (const neighbour of [list[index - 1], list[index + 1]]) {
					if (neighbour) {
						touched.add(neighbour.id);
					}
				}
			}
		});
	};
	collect(before, false);
	collect(sorted, true);

	const stored = sorted.map((key) => [key.arrive, key.leave]);
	rederiveAutoTangents(sorted, sorted.flatMap((key, index) => (touched.has(key.id) ? [index] : [])));
	// A derived slope is written into the source, so it is rounded to what reads well there. Only the
	// sides the derivation changed: a stored slope it left alone is someone's data.
	sorted.forEach((key, index) => {
		if (key.arrive !== stored[index][0]) {
			key.arrive = roundSlope(key.arrive);
		}
		if (key.leave !== stored[index][1]) {
			key.leave = roundSlope(key.leave);
		}
	});
	return sorted;
}

function selectedKeys(): Key[] {
	return keys.filter((key) => selection.has(key.id));
}

/** Applies `change` to every selected key, re-derives what that disturbed, and commits. */
function editSelected(change: (key: Key) => void, rederive = true): void {
	if (!editable() || selection.size === 0) {
		return;
	}
	const before = keys;
	const after = clone(keys);
	for (const key of after) {
		if (selection.has(key.id)) {
			change(key);
		}
	}
	keys = rederive ? settle(before, after, selection) : sortKeys(after);
	commit();
	refresh();
}

function setTangent(key: Key, side: 'arrive' | 'leave', slope: number): void {
	if (key.tangentMode === 'Break') {
		key[side] = slope;
	} else {
		// Dragging an Auto key's handle is how Unreal makes it User; None has no handle to drag.
		key.arrive = slope;
		key.leave = slope;
		key.tangentMode = 'User';
	}
}

function addKey(time: number, value: number): void {
	if (!editable()) {
		return;
	}
	const left = [...keys].reverse().find((key) => key.time <= time);
	const key: Key = {
		id: nextId++,
		time,
		value,
		interp: left?.interp ?? keys[0]?.interp ?? 'Cubic',
		tangentMode: 'Auto',
		arrive: 0,
		leave: 0,
	};
	const before = keys;
	keys = settle(before, [...clone(keys), key], [key.id]);
	selection = new Set([key.id]);
	commit();
	postSelection();
	refresh();
}

function addKeyFromToolbar(): void {
	const only = selectedKeys();
	let time = (view.t0 + view.t1) / 2;
	if (only.length === 1) {
		const index = keys.findIndex((key) => key.id === only[0].id);
		time = index < keys.length - 1
			? (keys[index].time + keys[index + 1].time) / 2
			: keys[index].time + (view.t1 - view.t0) * 0.1;
	}
	time = roundToResolution(time, timePerPixel());
	const value = keys.length > 0 ? roundToResolution(evaluate(keys, time), valuePerPixel()) : roundToResolution((view.v0 + view.v1) / 2, valuePerPixel());
	addKey(time, value);
}

function deleteSelected(): void {
	if (!editable() || selection.size === 0) {
		return;
	}
	const before = keys;
	const doomed = new Set(selection);
	keys = settle(before, clone(before).filter((key) => !doomed.has(key.id)), doomed);
	selection = new Set();
	commit();
	postSelection();
	refresh();
}

function applyTemplate(index: number): void {
	const template = TEMPLATES[index];
	if (!template || !editable()) {
		return;
	}
	// Keep the time range the curve already covers: a curve indexed by NormalizedAge stays 0..1, and
	// one indexed by something else keeps its own span.
	const times = keys.map((key) => key.time);
	const start = keys.length > 1 ? Math.min(...times) : 0;
	const span = keys.length > 1 && Math.max(...times) > start ? Math.max(...times) - start : 1;

	const fresh: Key[] = template.keys.map(([time, value, extra]): Key => {
		const key: Key = { id: nextId++, time: start + time * span, value, interp: 'Cubic', tangentMode: 'Auto', arrive: 0, leave: 0, ...extra };
		key.arrive /= span;
		key.leave /= span;
		// No origins: these are new keys, not the old ones moved. Borrowing an old key's place would
		// also borrow its spelling and its trailing comment, both of which described a different key.
		return key;
	});
	keys = sortKeys(fresh);
	selection = new Set();
	commit();
	postSelection();
	frame();
	refresh();
}

/** Fits the whole curve, overshoot included, with a margin. */
function frame(): void {
	if (keys.length === 0) {
		view = { t0: -0.05, t1: 1.05, v0: -0.1, v1: 1.1 };
		persist();
		return;
	}
	let t0 = Math.min(...keys.map((key) => key.time));
	let t1 = Math.max(...keys.map((key) => key.time));
	if (t1 - t0 < 1e-6) {
		t0 -= 0.5;
		t1 += 0.5;
	}
	let [v0, v1] = valueBounds(keys)!;
	if (v1 - v0 < 1e-6) {
		v0 -= 0.5;
		v1 += 0.5;
	}
	const tPad = (t1 - t0) * 0.06;
	const vPad = (v1 - v0) * 0.12;
	view = { t0: t0 - tPad, t1: t1 + tPad, v0: v0 - vPad, v1: v1 + vPad };
	persist();
}

// ==================================================================== pointer

canvas.addEventListener('contextmenu', (event) => event.preventDefault());

canvas.addEventListener('pointerdown', (event) => {
	canvas.focus();
	const { x, y } = local(event);
	canvas.setPointerCapture(event.pointerId);

	if (event.button === 1 || event.button === 2) {
		gesture = { kind: 'pan', pointer: event.pointerId, x, y, view: { ...view } };
		return;
	}
	if (event.button !== 0) {
		return;
	}

	const handle = editable() ? handleAt(x, y) : undefined;
	if (handle) {
		gesture = { kind: 'tangent', pointer: event.pointerId, keyId: handle.key.id, side: handle.side, snapshot: clone(keys) };
		return;
	}

	const additive = event.shiftKey;
	const toggle = event.ctrlKey || event.metaKey;
	const key = keyAt(x, y);
	if (key) {
		const wasSelected = selection.has(key.id);
		if (toggle) {
			if (wasSelected) {
				selection.delete(key.id);
			} else {
				selection.add(key.id);
			}
		} else if (additive) {
			selection.add(key.id);
		} else if (!wasSelected) {
			selection = new Set([key.id]);
		}
		gesture = {
			kind: 'press', pointer: event.pointerId, x, y,
			keyId: selection.has(key.id) ? key.id : undefined,
			// A plain click on one key of a selection narrows to it -- but only once it is clear the
			// press was a click and not the start of moving the whole selection.
			collapse: wasSelected && !toggle && !additive,
		};
		postSelection();
		refresh();
		return;
	}

	const base = additive || toggle ? new Set(selection) : new Set<number>();
	if (!additive && !toggle && selection.size > 0) {
		selection = new Set();
		postSelection();
	}
	gesture = { kind: 'marquee', pointer: event.pointerId, x, y, toX: x, toY: y, base };
	refresh();
});

canvas.addEventListener('pointermove', (event) => {
	const { x, y } = local(event);
	hover = { x, y };

	if (!gesture || gesture.pointer !== event.pointerId) {
		canvas.style.cursor = editable() && (handleAt(x, y) || keyAt(x, y)) ? 'pointer' : 'crosshair';
		renderReadout();
		render();
		return;
	}

	switch (gesture.kind) {
		case 'press':
			if (Math.hypot(x - gesture.x, y - gesture.y) >= DRAG_THRESHOLD && gesture.keyId !== undefined && editable()) {
				gesture = { kind: 'move', pointer: gesture.pointer, x: gesture.x, y: gesture.y, snapshot: clone(keys), moving: new Set(selection) };
				moveKeys(gesture, x, y, event.shiftKey);
			}
			break;
		case 'move':
			moveKeys(gesture, x, y, event.shiftKey);
			break;
		case 'tangent':
			dragTangent(gesture, x, y);
			break;
		case 'marquee': {
			gesture.toX = x;
			gesture.toY = y;
			const [left, right] = [Math.min(gesture.x, x), Math.max(gesture.x, x)];
			const [top, bottom] = [Math.min(gesture.y, y), Math.max(gesture.y, y)];
			selection = new Set(gesture.base);
			for (const key of keys) {
				const kx = xOf(key.time);
				const ky = yOf(key.value);
				if (kx >= left && kx <= right && ky >= top && ky <= bottom) {
					selection.add(key.id);
				}
			}
			break;
		}
		case 'pan': {
			const dt = ((x - gesture.x) / plot().w) * (gesture.view.t1 - gesture.view.t0);
			const dv = ((y - gesture.y) / plot().h) * (gesture.view.v1 - gesture.view.v0);
			view = { t0: gesture.view.t0 - dt, t1: gesture.view.t1 - dt, v0: gesture.view.v0 + dv, v1: gesture.view.v1 + dv };
			break;
		}
	}
	refresh();
});

function finishGesture(event: PointerEvent, cancelled: boolean): void {
	if (!gesture || gesture.pointer !== event.pointerId) {
		return;
	}
	const finished = gesture;
	gesture = undefined;

	switch (finished.kind) {
		case 'press':
			if (finished.collapse && finished.keyId !== undefined && selection.size > 1) {
				selection = new Set([finished.keyId]);
				postSelection();
			}
			break;
		case 'move':
		case 'tangent':
			if (cancelled) {
				keys = finished.snapshot;
			} else {
				commit();
			}
			postSelection();
			break;
		case 'marquee':
			postSelection();
			break;
		case 'pan':
			persist();
			break;
	}
	refresh();
}

canvas.addEventListener('pointerup', (event) => finishGesture(event, false));
canvas.addEventListener('pointercancel', (event) => finishGesture(event, true));
canvas.addEventListener('pointerleave', () => {
	hover = undefined;
	renderReadout();
	render();
});

canvas.addEventListener('dblclick', (event) => {
	const { x, y } = local(event);
	if (!editable() || keyAt(x, y) || handleAt(x, y)) {
		return;
	}
	const time = roundToResolution(timeAt(x), timePerPixel());
	let value = roundToResolution(valueAt(y), valuePerPixel());
	// Near the curve, the key goes *on* it, so adding a key does not by itself change the shape.
	if (keys.length > 0 && Math.abs(yOf(evaluate(keys, time)) - y) <= HIT_RADIUS) {
		value = roundToResolution(evaluate(keys, time), valuePerPixel());
	}
	addKey(time, value);
});

canvas.addEventListener('wheel', (event) => {
	event.preventDefault();
	const { x, y } = local(event);
	const factor = Math.exp(event.deltaY * 0.0015);
	const time = timeAt(x);
	const value = valueAt(y);
	// Bounded both ways: past these the ticks and the float32 values stop meaning anything.
	const nextSpans = [(view.t1 - view.t0) * factor, (view.v1 - view.v0) * factor];
	if (factor < 1 ? Math.min(...nextSpans) < 1e-5 : Math.max(...nextSpans) > 1e7) {
		return;
	}
	if (!event.altKey) {
		view.t0 = time + (view.t0 - time) * factor;
		view.t1 = time + (view.t1 - time) * factor;
	}
	if (!event.shiftKey) {
		view.v0 = value + (view.v0 - value) * factor;
		view.v1 = value + (view.v1 - value) * factor;
	}
	persist();
	render();
}, { passive: false });

function local(event: MouseEvent): { x: number; y: number } {
	const rect = canvas.getBoundingClientRect();
	return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function moveKeys(move: Extract<Gesture, { kind: 'move' }>, x: number, y: number, lockAxis: boolean): void {
	let dx = x - move.x;
	let dy = y - move.y;
	if (lockAxis) {
		if (Math.abs(dx) >= Math.abs(dy)) {
			dy = 0;
		} else {
			dx = 0;
		}
	}
	const dt = dx * timePerPixel();
	const dv = -dy * valuePerPixel();

	const after = clone(move.snapshot);
	for (const key of after) {
		if (move.moving.has(key.id)) {
			// Only an axis that moved is rounded: shift-dragging sideways must not nudge the value.
			if (dx !== 0) {
				key.time = roundToResolution(key.time + dt, timePerPixel());
			}
			if (dy !== 0) {
				key.value = roundToResolution(key.value + dv, valuePerPixel());
			}
		}
	}
	keys = settle(move.snapshot, after, move.moving);
}

function dragTangent(drag: Extract<Gesture, { kind: 'tangent' }>, x: number, y: number): void {
	const after = clone(drag.snapshot);
	const key = after.find((candidate) => candidate.id === drag.keyId);
	if (!key) {
		return;
	}
	let dx = x - xOf(key.time);
	const dy = y - yOf(key.value);
	// A handle cannot cross its key: past vertical the slope would flip sign through infinity.
	dx = drag.side === 'leave' ? Math.max(dx, 1) : Math.min(dx, -1);
	const slope = roundSlope((-dy * valuePerPixel()) / (dx * timePerPixel()));
	setTangent(key, drag.side, slope);
	keys = after;
}

// ==================================================================== keyboard and controls

window.addEventListener('keydown', (event) => {
	const target = event.target as HTMLElement | null;
	if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) {
		return;
	}
	const command = event.ctrlKey || event.metaKey;
	const key = event.key.toLowerCase();

	if (command && key === 'z') {
		vscode.postMessage({ type: event.shiftKey ? 'redo' : 'undo' });
	} else if (command && key === 'y') {
		vscode.postMessage({ type: 'redo' });
	} else if (command && key === 'a') {
		selection = new Set(keys.map((entry) => entry.id));
		postSelection();
		refresh();
	} else if (!command && (event.key === 'Delete' || event.key === 'Backspace')) {
		deleteSelected();
	} else if (!command && (key === 'f' || event.key === 'Home')) {
		frame();
		refresh();
	} else if (event.key === 'Escape') {
		if (gesture && (gesture.kind === 'move' || gesture.kind === 'tangent')) {
			keys = gesture.snapshot;
			gesture = undefined;
		} else {
			selection = new Set();
			postSelection();
		}
		refresh();
	} else {
		return;
	}
	event.preventDefault();
});

document.getElementById('toolbar')!.addEventListener('click', (event) => {
	const button = (event.target as HTMLElement).closest('button');
	if (button && !button.disabled) {
		runAction(button.dataset.action ?? '');
	}
});
document.querySelector('header')!.addEventListener('click', (event) => {
	const button = (event.target as HTMLElement).closest('button');
	if (button?.dataset.action === 'reveal') {
		vscode.postMessage({ type: 'reveal' });
	}
});

function runAction(action: string): void {
	switch (action) {
		case 'auto':
			editSelected((key) => {
				key.interp = 'Cubic';
				key.tangentMode = 'Auto';
			});
			break;
		case 'user':
			editSelected((key) => {
				key.interp = 'Cubic';
				key.tangentMode = 'User';
			});
			break;
		case 'break':
			editSelected((key) => {
				key.interp = 'Cubic';
				key.tangentMode = 'Break';
			});
			break;
		case 'linear':
			editSelected((key) => {
				key.interp = 'Linear';
			});
			break;
		case 'constant':
			editSelected((key) => {
				key.interp = 'Constant';
			});
			break;
		case 'flatten':
			editSelected((key) => {
				key.arrive = 0;
				key.leave = 0;
				if (key.tangentMode !== 'Break') {
					key.tangentMode = 'User';
				}
			}, false);
			break;
		case 'straighten':
			editSelected((key) => {
				const slope = roundSlope((key.arrive + key.leave) / 2);
				key.arrive = slope;
				key.leave = slope;
				key.tangentMode = 'User';
			}, false);
			break;
		case 'add':
			addKeyFromToolbar();
			break;
		case 'delete':
			deleteSelected();
			break;
		case 'frame':
			frame();
			refresh();
			break;
	}
}

for (const [index, template] of TEMPLATES.entries()) {
	const option = document.createElement('option');
	option.value = String(index);
	option.textContent = template.name;
	templateSelect.appendChild(option);
}
templateSelect.addEventListener('change', () => {
	const chosen = templateSelect.value;
	// Back to the placeholder: the list is a menu of actions, not a setting with a current value.
	templateSelect.selectedIndex = 0;
	if (chosen !== '') {
		applyTemplate(Number(chosen));
	}
	canvas.focus();
});

for (const [name, input] of Object.entries(fields) as Array<[keyof typeof fields, HTMLInputElement]>) {
	input.addEventListener('change', () => applyField(name, input.value));
	input.addEventListener('keydown', (event) => {
		if (event.key === 'Enter') {
			input.blur();
		} else if (event.key === 'Escape') {
			renderFields();
			input.blur();
		}
	});
}

function applyField(name: keyof typeof fields, text: string): void {
	const number = Number(text.trim());
	if (text.trim() === '' || !Number.isFinite(number)) {
		renderFields();
		return;
	}
	switch (name) {
		case 'time':
			if (selection.size === 1) {
				editSelected((key) => {
					key.time = number;
				});
			}
			break;
		case 'value':
			editSelected((key) => {
				key.value = number;
			});
			break;
		case 'arrive':
		case 'leave':
			editSelected((key) => setTangent(key, name, number), false);
			break;
	}
}

new ResizeObserver(() => render()).observe(graph);

// ==================================================================== drawing

interface Palette {
	foreground: string;
	muted: string;
	background: string;
	curve: string;
	accent: string;
	font: string;
}

function palette(): Palette {
	const style = getComputedStyle(document.body);
	const read = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
	return {
		foreground: read('--vscode-editor-foreground', '#cccccc'),
		muted: read('--vscode-descriptionForeground', '#999999'),
		background: read('--vscode-editor-background', '#1e1e1e'),
		curve: read('--vscode-charts-red', '#e5534b'),
		accent: read('--vscode-focusBorder', '#3794ff'),
		font: read('--vscode-editor-font-family', 'monospace'),
	};
}

function refresh(): void {
	renderFields();
	renderToolbar();
	renderReadout();
	render();
}

function render(): void {
	const width = canvas.clientWidth;
	const height = canvas.clientHeight;
	const ratio = window.devicePixelRatio || 1;
	if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
		canvas.width = Math.round(width * ratio);
		canvas.height = Math.round(height * ratio);
	}
	const g = context;
	g.setTransform(ratio, 0, 0, ratio, 0, 0);
	g.clearRect(0, 0, width, height);
	if (width < 20 || height < 20) {
		return;
	}

	const colors = palette();
	const area = plot();
	g.font = `10px ${colors.font}`;

	drawGrid(g, area, colors);

	g.save();
	g.beginPath();
	g.rect(area.x, area.y, area.w, area.h);
	g.clip();
	drawCurve(g, area, colors);
	drawHandles(g, colors);
	drawKeys(g, colors);
	if (gesture?.kind === 'marquee') {
		g.fillStyle = colors.accent;
		g.globalAlpha = 0.12;
		g.fillRect(Math.min(gesture.x, gesture.toX), Math.min(gesture.y, gesture.toY), Math.abs(gesture.toX - gesture.x), Math.abs(gesture.toY - gesture.y));
		g.globalAlpha = 1;
		g.strokeStyle = colors.accent;
		g.strokeRect(Math.min(gesture.x, gesture.toX) + 0.5, Math.min(gesture.y, gesture.toY) + 0.5, Math.abs(gesture.toX - gesture.x), Math.abs(gesture.toY - gesture.y));
	}
	g.restore();

	if (!state) {
		g.fillStyle = colors.muted;
		g.fillText('Loading…', area.x + 8, area.y + 16);
	}
}

/** A step of 1, 2 or 5 times a power of ten that gives about `count` divisions. */
function niceStep(range: number, count: number): number {
	const raw = range / Math.max(1, count);
	const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
	const normalised = raw / magnitude;
	return (normalised < 1.5 ? 1 : normalised < 3 ? 2 : normalised < 7 ? 5 : 10) * magnitude;
}

function tickLabel(value: number, step: number): string {
	const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
	return (Math.abs(value) < step / 1e6 ? 0 : value).toFixed(Math.min(decimals, 8));
}

function drawGrid(g: CanvasRenderingContext2D, area: ReturnType<typeof plot>, colors: Palette): void {
	g.save();
	g.lineWidth = 1;

	// Outside the keys the value is held, not interpolated; the shading says where that starts.
	if (keys.length > 0) {
		const first = Math.max(area.x, xOf(keys[0].time, area));
		const last = Math.min(area.x + area.w, xOf(keys[keys.length - 1].time, area));
		g.fillStyle = colors.foreground;
		g.globalAlpha = 0.035;
		g.fillRect(area.x, area.y, Math.max(0, first - area.x), area.h);
		g.fillRect(last, area.y, Math.max(0, area.x + area.w - last), area.h);
	}

	const timeStep = niceStep(view.t1 - view.t0, area.w / 70);
	const valueStep = niceStep(view.v1 - view.v0, area.h / 40);

	g.textBaseline = 'top';
	g.textAlign = 'center';
	// Counted in whole steps rather than accumulated, so a long axis does not drift off its labels.
	for (let step = Math.ceil(view.t0 / timeStep); step * timeStep <= view.t1; step += 1) {
		const time = step * timeStep;
		const x = Math.round(xOf(time, area)) + 0.5;
		g.strokeStyle = colors.foreground;
		g.globalAlpha = Math.abs(time) < timeStep / 1e6 ? 0.35 : 0.1;
		g.beginPath();
		g.moveTo(x, area.y);
		g.lineTo(x, area.y + area.h);
		g.stroke();
		g.globalAlpha = 1;
		g.fillStyle = colors.muted;
		g.fillText(tickLabel(time, timeStep), x, area.y + area.h + 6);
	}

	g.textBaseline = 'middle';
	g.textAlign = 'right';
	for (let step = Math.ceil(view.v0 / valueStep); step * valueStep <= view.v1; step += 1) {
		const value = step * valueStep;
		const y = Math.round(yOf(value, area)) + 0.5;
		g.strokeStyle = colors.foreground;
		g.globalAlpha = Math.abs(value) < valueStep / 1e6 ? 0.35 : 0.1;
		g.beginPath();
		g.moveTo(area.x, y);
		g.lineTo(area.x + area.w, y);
		g.stroke();
		g.globalAlpha = 1;
		g.fillStyle = colors.muted;
		g.fillText(tickLabel(value, valueStep), area.x - 6, y);
	}

	g.globalAlpha = 0.3;
	g.strokeStyle = colors.foreground;
	g.strokeRect(area.x + 0.5, area.y + 0.5, area.w - 1, area.h - 1);
	g.restore();
}

function drawCurve(g: CanvasRenderingContext2D, area: ReturnType<typeof plot>, colors: Palette): void {
	if (keys.length === 0) {
		return;
	}
	const first = keys[0];
	const last = keys[keys.length - 1];

	g.save();
	g.strokeStyle = colors.curve;
	g.lineWidth = 2;
	g.lineJoin = 'round';

	// The held value before and after the keys.
	g.globalAlpha = 0.5;
	g.setLineDash([4, 4]);
	g.beginPath();
	g.moveTo(area.x, yOf(first.value, area));
	g.lineTo(xOf(first.time, area), yOf(first.value, area));
	g.moveTo(xOf(last.time, area), yOf(last.value, area));
	g.lineTo(area.x + area.w, yOf(last.value, area));
	g.stroke();
	g.setLineDash([]);
	g.globalAlpha = 1;

	g.beginPath();
	g.moveTo(xOf(first.time, area), yOf(first.value, area));
	for (const segment of segments(keys)) {
		const [tx, ty] = [xOf(segment.to[0], area), yOf(segment.to[1], area)];
		if (segment.kind === 'cubic') {
			g.bezierCurveTo(xOf(segment.c1[0], area), yOf(segment.c1[1], area), xOf(segment.c2[0], area), yOf(segment.c2[1], area), tx, ty);
		} else if (segment.kind === 'step') {
			g.lineTo(tx, yOf(segment.from[1], area));
			g.lineTo(tx, ty);
		} else {
			g.lineTo(tx, ty);
		}
	}
	g.stroke();
	g.restore();
}

function drawHandles(g: CanvasRenderingContext2D, colors: Palette): void {
	g.save();
	g.lineWidth = 1;
	keys.forEach((key, index) => {
		if (!selection.has(key.id)) {
			return;
		}
		const kx = xOf(key.time);
		const ky = yOf(key.value);
		for (const side of visibleHandles(index)) {
			const [hx, hy] = handlePosition(index, side);
			g.strokeStyle = colors.muted;
			g.beginPath();
			g.moveTo(kx, ky);
			g.lineTo(hx, hy);
			g.stroke();
			g.fillStyle = key.tangentMode === 'Auto' ? colors.background : colors.muted;
			g.beginPath();
			g.arc(hx, hy, 3.5, 0, Math.PI * 2);
			g.fill();
			g.stroke();
		}
	});
	g.restore();
}

function drawKeys(g: CanvasRenderingContext2D, colors: Palette): void {
	g.save();
	for (const key of keys) {
		const x = xOf(key.time);
		const y = yOf(key.value);
		const selected = selection.has(key.id);
		const size = selected ? KEY_SIZE + 1 : KEY_SIZE;
		g.beginPath();
		// Diamonds for cubic keys, squares for linear and constant -- the shape says what comes next.
		if (key.interp === 'Cubic') {
			g.moveTo(x, y - size - 1);
			g.lineTo(x + size + 1, y);
			g.lineTo(x, y + size + 1);
			g.lineTo(x - size - 1, y);
			g.closePath();
		} else {
			g.rect(x - size, y - size, size * 2, size * 2);
		}
		g.fillStyle = selected ? colors.foreground : colors.curve;
		g.fill();
		g.lineWidth = selected ? 2 : 1;
		g.strokeStyle = selected ? colors.accent : colors.background;
		g.stroke();
	}
	g.restore();
}

function renderReadout(): void {
	const active = gesture;
	if (active?.kind === 'tangent') {
		const key = keys.find((candidate) => candidate.id === active.keyId);
		readout.textContent = key ? `${active.side} ${formatNumber(key[active.side])}` : '';
		return;
	}
	if (active?.kind === 'move') {
		const moving = keys.filter((key) => active.moving.has(key.id));
		readout.textContent = moving.length === 1
			? `t ${formatNumber(moving[0].time)}   v ${formatNumber(moving[0].value)}`
			: `${moving.length} keys`;
		return;
	}
	if (hover && keys.length > 0) {
		const area = plot();
		if (hover.x >= area.x && hover.x <= area.x + area.w && hover.y >= area.y && hover.y <= area.y + area.h) {
			const time = timeAt(hover.x);
			readout.textContent = `t ${time.toFixed(3)}  →  ${evaluate(keys, time).toFixed(3)}`;
			return;
		}
	}
	readout.textContent = '';
}

function renderFields(): void {
	const chosen = selectedKeys();
	const canEdit = editable() && chosen.length > 0;
	const show = (input: HTMLInputElement, values: number[], enabled: boolean): void => {
		if (document.activeElement === input) {
			return;
		}
		const same = values.length > 0 && values.every((value) => Math.fround(value) === Math.fround(values[0]));
		input.value = same ? formatNumber(values[0]) : '';
		input.placeholder = values.length > 1 && !same ? 'mixed' : '';
		input.disabled = !enabled;
	};
	show(fields.time, chosen.map((key) => key.time), canEdit && chosen.length === 1);
	show(fields.value, chosen.map((key) => key.value), canEdit);
	show(fields.arrive, chosen.map((key) => key.arrive), canEdit);
	show(fields.leave, chosen.map((key) => key.leave), canEdit);

	const status = element<HTMLSpanElement>('status');
	if (!state) {
		status.textContent = '';
		return;
	}
	const count = `${keys.length} ${keys.length === 1 ? 'key' : 'keys'}`;
	const chosenText = chosen.length > 0 ? ` · ${chosen.length} selected` : '';
	status.textContent = `${count}${chosenText} · ${state.fileName}:${state.line}${editable() ? '' : ' · read-only'}`;
}

function renderToolbar(): void {
	const chosen = selectedKeys();
	const all = (test: (key: Key) => boolean): boolean => chosen.length > 0 && chosen.every(test);
	const active: Record<string, boolean> = {
		auto: all((key) => key.interp === 'Cubic' && key.tangentMode === 'Auto'),
		user: all((key) => key.interp === 'Cubic' && key.tangentMode === 'User'),
		break: all((key) => key.interp === 'Cubic' && key.tangentMode === 'Break'),
		linear: all((key) => key.interp === 'Linear'),
		constant: all((key) => key.interp === 'Constant'),
	};
	for (const button of document.querySelectorAll<HTMLButtonElement>('#toolbar button')) {
		const action = button.dataset.action ?? '';
		const needsSelection = !['add', 'frame'].includes(action);
		button.disabled = action !== 'frame' && (!editable() || (needsSelection && chosen.length === 0));
		button.classList.toggle('active', active[action] === true);
	}
	templateSelect.disabled = !editable();
}

/** The parts of the page that change only when a new state arrives. */
function renderChrome(): void {
	if (!state) {
		return;
	}
	element<HTMLSpanElement>('name').textContent = state.name;
	element<HTMLSpanElement>('where').textContent = state.context.join(' › ');
	document.title = `Curve: ${state.name}`;

	banner.hidden = state.editable;
	if (state.editable) {
		banner.textContent = '';
	} else if (state.line > 0) {
		// The literal is there but the compiler would refuse it, so it is shown and not rewritten.
		banner.textContent = 'Read-only until fixed in the text — the compiler would reject this literal:\n'
			+ state.problems.map((problem) => `• ${problem}`).join('\n');
	} else {
		banner.textContent = state.problems.join('\n');
	}
}

vscode.postMessage({ type: 'ready' });
render();
