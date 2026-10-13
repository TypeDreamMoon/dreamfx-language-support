/**
 * Turning "the text before" and "the text after" into the smallest edits that get from one to the
 * other.
 *
 * Why this exists at all: a pull comes back as a whole new buffer, but the author's text is the only
 * model (see the curve editor), and replacing the whole buffer would throw away what an editor keeps
 * per range -- the cursor, folds, the diagnostics hanging off a line, and the undo step's meaning.
 * Worse, it would make "unchanged bytes are preserved" a promise nobody could check. So the new
 * buffer is reduced to edits, and those edits are the only thing written.
 *
 * Three layers, each narrowing the last:
 *
 *  1. **Lines.** Both texts are split keeping each line's terminator, and diffed. A CRLF file's lines
 *     end in `\r\n`, so a line that did not change is equal byte for byte and is never in an edit --
 *     there is no "normalise the line endings" pass for an edit to smuggle in.
 *  2. **Runs.** A run of changed lines is one hunk. When it replaces N lines with N lines the lines
 *     are paired up, so two values changed on neighbouring lines are two edits rather than one edit
 *     spanning both.
 *  3. **Characters.** Inside each pair (or hunk) the common prefix and suffix are cut away, so a
 *     changed value is an edit of just the value: the trailing comment after it is not touched.
 *
 * Offsets are JS string indices (UTF-16 code units), which is what `TextDocument.positionAt` takes.
 * Nothing here imports `vscode`.
 */

export interface PullEdit {
	/** Start offset into the old text. */
	start: number;
	/** End offset into the old text, exclusive. Equal to `start` for a pure insertion. */
	end: number;
	newText: string;
}

/** A change made to a document after the edits were planned: what `contentChanges` reports. */
export interface DocumentChange {
	start: number;
	end: number;
	text: string;
}

/**
 * The most differences (inserted + deleted lines, not counting the unchanged ends) the line diff
 * will look for before it stops and treats the whole middle as one hunk. A pull changes a handful of
 * lines; a text that differs by thousands is not a pull, and the diff's cost grows with the square
 * of that count, so the cap is what keeps a pathological answer from freezing the extension host.
 */
const MAX_DIFFERENCES = 4000;

/**
 * The edits that turn `oldText` into `newText`, ascending and non-overlapping, so that
 * `applyTextEdits(oldText, planTextEdits(oldText, newText))` is `newText` exactly.
 */
export function planTextEdits(oldText: string, newText: string): PullEdit[] {
	if (oldText === newText) {
		return [];
	}

	const oldLines = splitLines(oldText);
	const newLines = splitLines(newText);

	// Unchanged ends first: cheap, and it is most of every pull.
	let head = 0;
	while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) {
		head += 1;
	}
	let tail = 0;
	while (
		tail < oldLines.length - head && tail < newLines.length - head
		&& oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
	) {
		tail += 1;
	}

	const oldMiddle = oldLines.slice(head, oldLines.length - tail);
	const newMiddle = newLines.slice(head, newLines.length - tail);
	const matches = diffLines(oldMiddle, newMiddle) ?? [];

	const oldStarts = lineStarts(oldLines);
	const newStarts = lineStarts(newLines);
	const edits: PullEdit[] = [];

	// Each gap between two matches is a hunk; the sentinels close the first and last.
	let oldCursor = 0;
	let newCursor = 0;
	for (const [oldIndex, newIndex] of [...matches, [oldMiddle.length, newMiddle.length] as const]) {
		if (oldIndex > oldCursor || newIndex > newCursor) {
			emitHunk(
				oldText, newText, oldStarts, newStarts,
				head + oldCursor, head + oldIndex, head + newCursor, head + newIndex, edits);
		}
		oldCursor = oldIndex + 1;
		newCursor = newIndex + 1;
	}

	return edits;
}

/** Applies edits from `planTextEdits`. For the editor host's tests and for previews. */
export function applyTextEdits(text: string, edits: readonly PullEdit[]): string {
	let result = '';
	let cursor = 0;
	for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
		result += text.slice(cursor, edit.start) + edit.newText;
		cursor = edit.end;
	}
	return result + text.slice(cursor);
}

/**
 * Gives `text` the line endings of `reference`, when `reference` uses one kind throughout.
 *
 * The editor splices bytes into what it was sent and so keeps the line endings it was given -- but
 * a build that normalised them would turn every line into a change, and the author would be asked to
 * approve a rewrite of the whole file for a one-value pull. A reference with mixed endings has no
 * single answer, so the text is left exactly as received.
 */
export function matchLineEndings(reference: string, text: string): string {
	const hasCrlf = reference.includes('\r\n');
	const hasBareLf = /(^|[^\r])\n/.test(reference);
	if (hasCrlf && !hasBareLf) {
		return text.replace(/\r?\n/g, '\r\n');
	}
	if (!hasCrlf && hasBareLf) {
		return text.replace(/\r\n/g, '\n');
	}
	return text;
}

/**
 * Re-expresses edits planned against a text in terms of that text after later changes -- or returns
 * undefined when a later change touches what an edit would replace.
 *
 * This is for the one window where it matters: the apply request takes a moment, the author can type
 * during it, and by then the editor has already recorded the asset's values as pulled. Dropping the
 * edits would lose them; applying them at their old offsets would corrupt the text. Edits and
 * changes that do not overlap commute, so the former can be moved past the latter; ones that do
 * overlap cannot, and are refused rather than guessed.
 *
 * `batches` are in the order they happened. Changes inside one batch are all expressed in the text
 * as it was before that batch, which is how `onDidChangeTextDocument` reports them.
 */
export function rebaseEdits(edits: readonly PullEdit[], batches: readonly (readonly DocumentChange[])[]): PullEdit[] | undefined {
	let current = edits.map((edit) => ({ ...edit }));

	for (const batch of batches) {
		const moved: PullEdit[] = [];
		for (const edit of current) {
			let shift = 0;
			for (const change of batch) {
				const insertionAtSamePoint = edit.start === edit.end && change.start === change.end && edit.start === change.start;
				if (edit.end <= change.start && !insertionAtSamePoint) {
					continue;
				}
				if (edit.start >= change.end && !insertionAtSamePoint) {
					shift += change.text.length - (change.end - change.start);
					continue;
				}
				return undefined;
			}
			moved.push({ start: edit.start + shift, end: edit.end + shift, newText: edit.newText });
		}
		current = moved;
	}

	return current;
}

// ---------------------------------------------------------------- lines

/** Lines with their terminators, so that joining them gives the text back byte for byte. */
function splitLines(text: string): string[] {
	const lines: string[] = [];
	let start = 0;
	for (let index = 0; index < text.length; index += 1) {
		if (text.charCodeAt(index) === 10) {
			lines.push(text.slice(start, index + 1));
			start = index + 1;
		}
	}
	if (start < text.length) {
		lines.push(text.slice(start));
	}
	return lines;
}

/** Offset of each line, plus one entry for the end of the text, so a range of lines is [starts[i], starts[j]). */
function lineStarts(lines: readonly string[]): number[] {
	const starts: number[] = [];
	let offset = 0;
	for (const line of lines) {
		starts.push(offset);
		offset += line.length;
	}
	starts.push(offset);
	return starts;
}

function emitHunk(
	oldText: string,
	newText: string,
	oldStarts: readonly number[],
	newStarts: readonly number[],
	oldFrom: number,
	oldTo: number,
	newFrom: number,
	newTo: number,
	into: PullEdit[],
): void {
	const count = oldTo - oldFrom;
	if (count === newTo - newFrom && count > 1) {
		// N lines for N lines: pair them, so each line gets its own minimal edit.
		for (let offset = 0; offset < count; offset += 1) {
			pushTrimmed(
				oldText, newText,
				oldStarts[oldFrom + offset], oldStarts[oldFrom + offset + 1],
				newStarts[newFrom + offset], newStarts[newFrom + offset + 1],
				into);
		}
		return;
	}
	pushTrimmed(oldText, newText, oldStarts[oldFrom], oldStarts[oldTo], newStarts[newFrom], newStarts[newTo], into);
}

/** One edit for old[oldFrom, oldTo) -> new[newFrom, newTo), with the shared ends cut away. */
function pushTrimmed(
	oldText: string,
	newText: string,
	oldFrom: number,
	oldTo: number,
	newFrom: number,
	newTo: number,
	into: PullEdit[],
): void {
	const oldLength = oldTo - oldFrom;
	const newLength = newTo - newFrom;
	const room = Math.min(oldLength, newLength);

	let prefix = 0;
	while (prefix < room && oldText.charCodeAt(oldFrom + prefix) === newText.charCodeAt(newFrom + prefix)) {
		prefix += 1;
	}
	// Never cut between the two halves of a surrogate pair: an edit starting there would not be
	// representable as a position in the document.
	if (prefix > 0 && isHighSurrogate(oldText.charCodeAt(oldFrom + prefix - 1))) {
		prefix -= 1;
	}

	let suffix = 0;
	while (
		suffix < room - prefix
		&& oldText.charCodeAt(oldTo - 1 - suffix) === newText.charCodeAt(newTo - 1 - suffix)
	) {
		suffix += 1;
	}
	if (suffix > 0 && isLowSurrogate(oldText.charCodeAt(oldTo - suffix))) {
		suffix -= 1;
	}

	const start = oldFrom + prefix;
	const end = oldTo - suffix;
	const replacement = newText.slice(newFrom + prefix, newTo - suffix);
	if (start === end && replacement.length === 0) {
		return;
	}
	into.push({ start, end, newText: replacement });
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

// ---------------------------------------------------------------- diff

/**
 * The matched line pairs `[oldIndex, newIndex]` of a shortest edit script (Myers, O(ND)), in order.
 * Undefined when the texts differ by more than `MAX_DIFFERENCES`, in which case the caller treats
 * the whole range as one hunk -- a worse edit, never a wrong one.
 */
function diffLines(a: readonly string[], b: readonly string[]): Array<readonly [number, number]> | undefined {
	const n = a.length;
	const m = b.length;
	if (n === 0 || m === 0) {
		return [];
	}

	const max = Math.min(n + m, MAX_DIFFERENCES);
	const offset = max + 1;
	const v = new Int32Array(2 * max + 3);
	// trace[d] is v as it stood before round d, restricted to the diagonals round d can read.
	const trace: Int32Array[] = [];

	let found = -1;
	for (let d = 0; d <= max && found < 0; d += 1) {
		trace.push(v.slice(offset - d - 1, offset + d + 2));
		for (let k = -d; k <= d; k += 2) {
			let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
				? v[offset + k + 1]
				: v[offset + k - 1] + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x += 1;
				y += 1;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) {
				found = d;
				break;
			}
		}
	}
	if (found < 0) {
		return undefined;
	}

	const matches: Array<readonly [number, number]> = [];
	let x = n;
	let y = m;
	for (let d = found; d >= 0; d -= 1) {
		const before = trace[d];
		const at = (k: number): number => before[k + d + 1];
		const k = x - y;
		let previousX: number;
		let previousY: number;
		if (d === 0) {
			previousX = 0;
			previousY = 0;
		} else {
			const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
			previousX = at(previousK);
			previousY = previousX - previousK;
		}
		while (x > previousX && y > previousY) {
			x -= 1;
			y -= 1;
			matches.push([x, y]);
		}
		x = previousX;
		y = previousY;
	}

	return matches.reverse();
}
