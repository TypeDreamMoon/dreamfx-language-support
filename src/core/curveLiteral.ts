/**
 * Finding, reading and rewriting `curve { }` literals in source text.
 *
 * The reader mirrors `ParseCurveLiteral` in the compiler (`DreamFXParser.cpp`) and the spelling
 * mirrors the decompiler's curve writer, because the editor sits between the two: what it reads must
 * mean what the compiler will read, and what it writes must be what an export would have written.
 *
 * **The rewrite is minimal on purpose.** A curve is usually a few lines inside a file somebody wrote
 * by hand, with comments on the keys and columns lined up. So an edit replaces only the keys whose
 * meaning changed, deletes only the keys that were removed, and inserts new ones next to their
 * neighbours. A key whose numbers did not change keeps its text byte for byte, comment and padding
 * included; nothing is reformatted because the editor happened to touch the block.
 *
 * And it refuses rather than guesses: a literal the compiler would reject (an unknown attribute, an
 * interpolation it does not know, a tangent that is not a number) is reported, and is not rewritten.
 */

import { CurveInterp, CurveKey, CurveTangentMode, formatNumber } from './curveMath';
import { Scanner, Token } from './scanner';

export interface WrittenCurveKey extends CurveKey {
	/** From the key's time to the end of its value or `]`; the `;` is not included. */
	start: number;
	end: number;
	/** Past the `;` when one was written, otherwise equal to `end`. */
	statementEnd: number;
	/** `Interp=` exactly as written, when it was. Kept so an edit does not respell it. */
	interpWritten?: string;
	/** `Tangent=` exactly as written, when it was. */
	tangentWritten?: string;
}

export interface CurveLiteral {
	/** Offset of the `curve` keyword. */
	start: number;
	/** Past the closing `}`, or the end of the text when there is none. */
	end: number;
	/** Offset of the opening `{`. */
	open: number;
	/** Offset of the closing `}`, or -1 when the literal is unterminated. */
	close: number;
	/** One-based line of the `curve` keyword. */
	line: number;
	keys: WrittenCurveKey[];
	/** Why this literal must not be rewritten. Empty when it may be. */
	problems: string[];
	/** The input it fills, when written as `Name = curve { }`. */
	inputName?: string;
	/** The blocks and calls it sits inside, outermost first: `Sparks`, `ParticleUpdate`, `ScaleSpriteSize`... */
	context: string[];
}

export interface EditedCurveKey extends CurveKey {
	/** Index into the literal's `keys` of the key this one was, or absent for a key that is new. */
	origin?: number;
}

/** A replacement of `[start, end)` in the source, in offsets. */
export interface TextReplacement {
	start: number;
	end: number;
	text: string;
}

const INTERP_SPELLINGS: Record<string, CurveInterp> = {
	auto: 'Cubic',
	cubic: 'Cubic',
	linear: 'Linear',
	constant: 'Constant',
};

const TANGENT_SPELLINGS: Record<string, CurveTangentMode> = {
	auto: 'Auto',
	user: 'User',
	break: 'Break',
	none: 'None',
};

/** `InterpModeToEnum`: case-insensitive, and an absent or `Auto` interpolation is cubic. */
export function resolveInterp(written: string | undefined): CurveInterp | undefined {
	return written === undefined || written === '' ? 'Cubic' : INTERP_SPELLINGS[written.toLowerCase()];
}

export function resolveTangentMode(written: string): CurveTangentMode | undefined {
	return TANGENT_SPELLINGS[written.toLowerCase()];
}

// ------------------------------------------------------------------ finding

/** Every curve literal in the text, in source order. Never throws. */
export function findCurveLiterals(text: string): CurveLiteral[] {
	return new CurveFinder(text).run();
}

/** The literal whose text contains `offset`, `curve` keyword and closing brace included. */
export function curveLiteralAt(text: string, offset: number): CurveLiteral | undefined {
	return findCurveLiterals(text).find((literal) => offset >= literal.start && offset <= literal.end);
}

interface Frame {
	kind: '{' | '(';
	name: string;
}

class CurveFinder {
	private readonly scanner: Scanner;
	private readonly literals: CurveLiteral[] = [];
	private readonly frames: Frame[] = [];
	/** The last three tokens consumed, most recent last. */
	private readonly recent: Token[] = [];

	constructor(private readonly text: string) {
		this.scanner = new Scanner(text);
	}

	run(): CurveLiteral[] {
		while (this.scanner.peek().kind !== 'end') {
			const token = this.scanner.peek();

			if (token.kind === 'identifier' && !token.quoted) {
				// Keywords compare the way the compiler's `FString ==` does, which is without case.
				const word = token.text.toLowerCase();

				// Raw blocks are HLSL, and HLSL is not ours to look inside: `curve {` in a shader body is
				// a struct, not a literal.
				if (word === 'hlsl' && this.scanner.atSymbol('{', 1)) {
					this.consume();
					this.scanner.readRawBlock();
					continue;
				}
				if (word === 'body' && this.scanner.atSymbol('=', 1) && this.scanner.atSymbol('{', 2)) {
					this.consume();
					this.consume();
					this.scanner.readRawBlock();
					continue;
				}
				if (word === 'curve' && this.scanner.atSymbol('{', 1) && this.atValuePosition()) {
					this.literals.push(this.readLiteral());
					continue;
				}
			}

			if (token.kind === 'symbol') {
				if (token.text === '{' || token.text === '(') {
					this.frames.push({ kind: token.text, name: this.frameName(token.text) });
				} else if (token.text === '}' || token.text === ')') {
					// Pop to the matching opener so one unbalanced bracket cannot skew everything after it.
					const opener = token.text === '}' ? '{' : '(';
					const index = this.frames.map((frame) => frame.kind).lastIndexOf(opener);
					if (index !== -1) {
						this.frames.length = index;
					}
				}
			}

			this.consume();
		}
		return this.literals;
	}

	private consume(): Token {
		const token = this.scanner.next();
		this.recent.push(token);
		if (this.recent.length > 3) {
			this.recent.shift();
		}
		return token;
	}

	private previous(back = 1): Token | undefined {
		return this.recent[this.recent.length - back];
	}

	/**
	 * `curve {` is a literal only where a value goes. An emitter or renderer can be *named* `curve`,
	 * and `Emitter curve {` is a block, not a key list.
	 */
	private atValuePosition(): boolean {
		const before = this.previous();
		return before !== undefined && before.kind === 'symbol' && ['=', '(', ','].includes(before.text);
	}

	/** `Sparks` for `Emitter Sparks {`, `ParticleUpdate` for `ParticleUpdate = {`, `A = Call` for `A = Call(`. */
	private frameName(opener: '{' | '('): string {
		const before = this.previous();
		if (!before) {
			return '';
		}
		if (before.kind === 'identifier') {
			if (opener === '(') {
				const assign = this.previous(2);
				const input = this.previous(3);
				if (assign?.kind === 'symbol' && assign.text === '=' && input?.kind === 'identifier') {
					return `${input.text} = ${before.text}`;
				}
			}
			return before.text;
		}
		if (opener === '{' && before.kind === 'symbol' && before.text === '=') {
			const name = this.previous(2);
			return name?.kind === 'identifier' ? name.text : '';
		}
		return '';
	}

	private readLiteral(): CurveLiteral {
		const keyword = this.scanner.peek();
		const before = this.previous();
		const named = this.previous(2);
		const inputName = before?.kind === 'symbol' && before.text === '=' && named?.kind === 'identifier'
			? named.text
			: undefined;

		this.consume(); // 'curve'
		const open = this.consume(); // '{'

		const literal: CurveLiteral = {
			start: keyword.start.offset,
			end: this.text.length,
			open: open.start.offset,
			close: -1,
			line: keyword.start.line,
			keys: [],
			problems: [],
			inputName,
			context: this.frames.map((frame) => frame.name).filter((name) => name.length > 0),
		};

		while (this.scanner.peek().kind !== 'end' && !this.scanner.atSymbol('}')) {
			const key = this.readKey(literal);
			if (key) {
				literal.keys.push(key);
			}
		}

		if (this.scanner.atSymbol('}')) {
			const close = this.consume();
			literal.close = close.start.offset;
			literal.end = close.end.offset;
		} else {
			literal.problems.push("The literal has no closing '}'.");
		}
		return literal;
	}

	/** One `time -> value [ attributes ];`. Reports and resynchronises on anything else. */
	private readKey(literal: CurveLiteral): WrittenCurveKey | undefined {
		const first = this.scanner.peek();
		const time = this.readSignedNumber();
		if (time === undefined) {
			return this.fail(literal, `line ${first.start.line}: expected a key time, found '${first.text}' (DFX2003).`);
		}
		if (!this.scanner.atSymbol('->')) {
			return this.fail(literal, `line ${this.scanner.peek().start.line}: expected '->' after the key time (DFX2001).`);
		}
		this.consume();

		const valueToken = this.scanner.peek();
		const value = this.readSignedNumber();
		if (value === undefined) {
			return this.fail(literal, `line ${valueToken.start.line}: expected a key value, found '${valueToken.text}' (DFX2003).`);
		}

		const key: WrittenCurveKey = {
			time,
			value,
			interp: 'Cubic',
			tangentMode: 'Auto',
			arrive: 0,
			leave: 0,
			start: first.start.offset,
			end: this.previous()!.end.offset,
			statementEnd: this.previous()!.end.offset,
		};

		let hasTangent = false;
		if (this.scanner.atSymbol('[')) {
			this.consume();
			if (!this.readAttributes(literal, key, () => { hasTangent = true; })) {
				return this.fail(literal, `line ${first.start.line}: the key's attribute list could not be read.`);
			}
			key.end = this.previous()!.end.offset;
			key.statementEnd = key.end;
		}

		// TangentModeToEnum: an unnamed mode is User when a tangent was written and Auto when not.
		if (key.tangentWritten === undefined) {
			key.tangentMode = hasTangent ? 'User' : 'Auto';
		}

		if (this.scanner.atSymbol(';')) {
			key.statementEnd = this.consume().end.offset;
		} else if (!this.scanner.atSymbol('}') && this.scanner.peek().kind !== 'end') {
			// Allowed by the compiler only when the next key starts here, which it reports on its own.
			const next = this.scanner.peek();
			if (!(next.kind === 'number' || (next.kind === 'symbol' && next.text === '-'))) {
				this.fail(literal, `line ${next.start.line}: unexpected '${next.text}' after a key.`);
			}
		}
		return key;
	}

	private readAttributes(literal: CurveLiteral, key: WrittenCurveKey, sawTangent: () => void): boolean {
		if (this.scanner.atSymbol(']')) {
			this.consume();
			return true;
		}

		for (;;) {
			const name = this.scanner.peek();
			if (name.kind !== 'identifier') {
				return false;
			}
			this.consume();

			if (!this.scanner.atSymbol('=')) {
				literal.problems.push(`line ${name.start.line}: attribute '${name.text}' has no value.`);
			} else {
				this.consume();
				const valueToken = this.scanner.peek();

				// Attribute names too: `FString ==` in the compiler, so `interp=` is `Interp=`.
				const attribute = name.text.toLowerCase();
				switch (attribute) {
					case 'interp':
					case 'tangent': {
						if (valueToken.kind !== 'identifier' && valueToken.kind !== 'string') {
							return false;
						}
						this.consume();
						if (attribute === 'interp') {
							const interp = resolveInterp(valueToken.text);
							if (!interp) {
								literal.problems.push(`line ${valueToken.start.line}: unknown interpolation '${valueToken.text}'. Expected Auto, Cubic, Linear or Constant (DFX4039).`);
							} else {
								key.interp = interp;
							}
							key.interpWritten = valueToken.text;
						} else {
							const mode = resolveTangentMode(valueToken.text);
							if (!mode) {
								literal.problems.push(`line ${valueToken.start.line}: unknown tangent mode '${valueToken.text}'. Expected Auto, User, Break or None (DFX4042).`);
							} else {
								key.tangentMode = mode;
							}
							key.tangentWritten = valueToken.text;
						}
						break;
					}
					case 'arrive':
					case 'leave': {
						// The compiler folds any run of signs into the literal; anything that is not a plain
						// number it silently reads as "no tangent", which this editor will not rewrite around.
						const number = this.readFoldedNumber();
						if (number === undefined) {
							literal.problems.push(`line ${valueToken.start.line}: ${name.text} must be a plain number.`);
							this.skipAttributeValue();
						} else {
							if (attribute === 'arrive') {
								key.arrive = number;
							} else {
								key.leave = number;
							}
							sawTangent();
						}
						break;
					}
					default:
						literal.problems.push(`line ${name.start.line}: unknown curve key attribute '${name.text}'. Expected Interp, Tangent, Arrive or Leave (DFX2020).`);
						this.skipAttributeValue();
				}
			}

			if (this.scanner.atSymbol(';') || this.scanner.atSymbol(',')) {
				this.consume();
				if (this.scanner.atSymbol(']')) {
					this.consume();
					return true;
				}
				continue;
			}
			if (this.scanner.atSymbol(']')) {
				this.consume();
				return true;
			}
			return false;
		}
	}

	/** `ParseSignedNumber`: at most one leading '-', then a number token. */
	private readSignedNumber(): number | undefined {
		let negate = false;
		if (this.scanner.atSymbol('-') && this.scanner.peek(1).kind === 'number') {
			this.consume();
			negate = true;
		}
		const token = this.scanner.peek();
		if (token.kind !== 'number') {
			return undefined;
		}
		this.consume();
		return Math.fround(negate ? -token.value! : token.value!);
	}

	/** `ParseUnary` with its constant folding: any run of '+'/'-' in front of one number. */
	private readFoldedNumber(): number | undefined {
		let sign = 1;
		let ahead = 0;
		while (this.scanner.atSymbol('-', ahead) || this.scanner.atSymbol('+', ahead)) {
			if (this.scanner.atSymbol('-', ahead)) {
				sign = -sign;
			}
			ahead += 1;
		}
		const token = this.scanner.peek(ahead);
		const after = this.scanner.peek(ahead + 1);
		const ends = after.kind === 'symbol' && [';', ',', ']'].includes(after.text);
		if (token.kind !== 'number' || !ends) {
			return undefined;
		}
		for (let index = 0; index <= ahead; index += 1) {
			this.consume();
		}
		return Math.fround(sign * token.value!);
	}

	private skipAttributeValue(): void {
		let depth = 0;
		while (this.scanner.peek().kind !== 'end') {
			if (depth === 0 && (this.scanner.atSymbol(';') || this.scanner.atSymbol(',') || this.scanner.atSymbol(']'))) {
				return;
			}
			if (this.scanner.atSymbol('(') || this.scanner.atSymbol('[')) {
				depth += 1;
			} else if (this.scanner.atSymbol(')')) {
				depth -= 1;
			} else if (this.scanner.atSymbol('}')) {
				return;
			}
			this.consume();
		}
	}

	/** Records the problem and skips past the next ';' -- or up to the '}' -- the way `SkipToStatementEnd` does. */
	private fail(literal: CurveLiteral, problem: string): undefined {
		literal.problems.push(problem);
		while (this.scanner.peek().kind !== 'end' && !this.scanner.atSymbol('}')) {
			if (this.consume().text === ';') {
				break;
			}
		}
		return undefined;
	}
}

// ------------------------------------------------------------------ writing

export interface KeySpelling {
	interpWritten?: string;
	tangentWritten?: string;
}

/**
 * One key, spelled the way the decompiler spells it -- except that an attribute the author wrote is
 * kept in the author's spelling, and one they left out stays out while it still means the same thing.
 * (`Tangent=Auto` alone is the exception: see below.)
 *
 * The tangent rules are the reader's inference run backwards: numbers alone mean `User`, nothing
 * means `Auto`, so `Tangent=` is written only when leaving it out would read back as a different
 * mode -- `Break`, `None`, and an `Auto` key that carries a stored slope.
 */
export function formatKey(key: CurveKey, spelling: KeySpelling = {}): string {
	const attributes: string[] = [];

	if (spelling.interpWritten !== undefined) {
		attributes.push(`Interp=${resolveInterp(spelling.interpWritten) === key.interp ? spelling.interpWritten : key.interp}`);
	} else if (key.interp !== 'Cubic') {
		attributes.push(`Interp=${key.interp}`);
	}

	const keptTangentSpelling = spelling.tangentWritten !== undefined
		&& resolveTangentMode(spelling.tangentWritten) === key.tangentMode
		? spelling.tangentWritten
		: undefined;
	const hasSlope = Math.fround(key.arrive) !== 0 || Math.fround(key.leave) !== 0;

	let writeNumbers = true;
	let tangentName: string | undefined = keptTangentSpelling;
	switch (key.tangentMode) {
		case 'Auto':
			// The one word that is never the author's to keep: `Tangent=Auto` with no numbers says what
			// leaving it out already says, and it only ever got there beside a slope that is now gone.
			writeNumbers = hasSlope;
			tangentName = hasSlope ? tangentName ?? 'Auto' : undefined;
			break;
		case 'User':
			break;
		case 'Break':
		case 'None':
			tangentName ??= key.tangentMode;
			break;
	}

	if (tangentName !== undefined) {
		attributes.push(`Tangent=${tangentName}`);
	}
	if (writeNumbers) {
		attributes.push(`Arrive=${formatNumber(key.arrive)}`, `Leave=${formatNumber(key.leave)}`);
	}

	const head = `${formatNumber(key.time)} -> ${formatNumber(key.value)}`;
	return attributes.length > 0 ? `${head} [ ${attributes.join('; ')} ]` : head;
}

/** True when two keys build the same curve key, whatever their spelling. */
export function sameKey(a: CurveKey, b: CurveKey): boolean {
	const same = (x: number, y: number): boolean => Math.fround(x) === Math.fround(y);
	return same(a.time, b.time) && same(a.value, b.value)
		&& a.interp === b.interp && a.tangentMode === b.tangentMode
		&& same(a.arrive, b.arrive) && same(a.leave, b.leave);
}

/**
 * The replacements that turn `literal` into a literal with exactly `next`, in that order.
 *
 * `next` should already be sorted by time; it is written in the order given. Each surviving key is
 * written into a surviving key's place in source order -- so when nothing was reordered every key
 * stays where it was, comments and all -- and a new key goes in right after whatever precedes it in
 * `next`, on its own line when the literal is laid out one key per line and inline when it is not.
 *
 * Throws when the literal is not safe to rewrite; callers check `problems` first.
 */
export function planCurveEdit(source: string, literal: CurveLiteral, next: readonly EditedCurveKey[]): TextReplacement[] {
	if (literal.problems.length > 0 || literal.close < 0) {
		throw new Error('this curve literal cannot be rewritten');
	}

	const old = literal.keys;
	const survivors = next.filter((key) => key.origin !== undefined);
	const origins = survivors.map((key) => key.origin!);
	if (new Set(origins).size !== origins.length || origins.some((origin) => !(origin >= 0 && origin < old.length))) {
		throw new Error('edited keys name an origin that is not in the literal');
	}

	const eol = source.includes('\r\n') ? '\r\n' : '\n';
	const multiline = /[\r\n]/.test(source.slice(literal.open, literal.close));
	const indent = keyIndent(source, literal);
	const slots = [...origins].sort((a, b) => a - b).map((origin) => old[origin]);
	const edits: TextReplacement[] = [];

	// An inline literal losing every key it had is rewritten whole -- deleting each key and its
	// separating space one by one leaves the spaces in the wrong places -- unless something other
	// than keys lives between the braces, which a whole rewrite would lose.
	if (!multiline && survivors.length === 0 && old.length > 0 && onlyKeysBetween(source, literal)) {
		const body = next.map((key) => `${formatKey(key)};`).join(' ');
		return [{ start: literal.open + 1, end: literal.close, text: body ? ` ${body} ` : ' ' }];
	}

	// Surviving keys, into surviving places.
	survivors.forEach((key, index) => {
		const slot = slots[index];
		if (!sameKey(slot, key)) {
			edits.push({ start: slot.start, end: slot.end, text: formatKey(key, old[key.origin!]) });
		}
	});

	// Removed keys.
	const kept = new Set(origins);
	old.forEach((key, index) => {
		if (!kept.has(index)) {
			edits.push(deletion(source, key, literal));
		}
	});

	// New keys, grouped by what they follow.
	let anchor = -1;
	let group: EditedCurveKey[] = [];
	const flush = (): void => {
		if (group.length > 0) {
			edits.push(insertion(source, literal, anchor >= 0 ? slots[anchor] : undefined, slots[0], group, eol, indent, multiline));
			group = [];
		}
	};
	let survivorIndex = 0;
	for (const key of next) {
		if (key.origin === undefined) {
			group.push(key);
		} else {
			flush();
			anchor = survivorIndex;
			survivorIndex += 1;
		}
	}
	flush();

	return coalesce(edits);
}

/** Applies replacements produced by `planCurveEdit` to a string. For tests and for previews. */
export function applyReplacements(source: string, edits: readonly TextReplacement[]): string {
	let result = source;
	for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
		result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
	}
	return result;
}

/** True when the braces hold keys, semicolons and whitespace, and nothing else. */
function onlyKeysBetween(source: string, literal: CurveLiteral): boolean {
	let cursor = literal.open + 1;
	let rest = '';
	for (const key of literal.keys) {
		rest += source.slice(cursor, key.start);
		cursor = key.statementEnd;
	}
	rest += source.slice(cursor, literal.close);
	return /^[\s;]*$/.test(rest);
}

function lineStartOf(source: string, offset: number): number {
	let index = offset;
	while (index > 0 && source[index - 1] !== '\n' && source[index - 1] !== '\r') {
		index -= 1;
	}
	return index;
}

function lineEndOf(source: string, offset: number): number {
	let index = offset;
	while (index < source.length && source[index] !== '\n' && source[index] !== '\r') {
		index += 1;
	}
	return index;
}

function pastLineBreak(source: string, offset: number): number {
	if (source[offset] === '\r' && source[offset + 1] === '\n') {
		return offset + 2;
	}
	return offset < source.length ? offset + 1 : offset;
}

function leadingWhitespace(source: string, lineStart: number): string {
	return /^[ \t]*/.exec(source.slice(lineStart))![0];
}

/** Whether a key is the first thing on its line. */
function opensLine(source: string, offset: number): boolean {
	return source.slice(lineStartOf(source, offset), offset).trim() === '';
}

/** The indentation a new key line gets: the first key's, else one level inside the closing brace. */
function keyIndent(source: string, literal: CurveLiteral): string {
	const first = literal.keys[0];
	if (first && opensLine(source, first.start)) {
		return leadingWhitespace(source, lineStartOf(source, first.start));
	}
	const braceIndent = leadingWhitespace(source, lineStartOf(source, literal.close));
	return braceIndent + (braceIndent.includes('\t') ? '\t' : '    ');
}

/** True when nothing but a trailing `//` comment follows on the rest of the line. */
function restIsTrailing(rest: string): boolean {
	const trimmed = rest.trim();
	return trimmed === '' || trimmed.startsWith('//');
}

function deletion(source: string, key: WrittenCurveKey, literal: CurveLiteral): TextReplacement {
	const lineStart = lineStartOf(source, key.start);
	const lineEnd = lineEndOf(source, key.statementEnd);
	const before = source.slice(lineStart, key.start);
	const after = source.slice(key.statementEnd, lineEnd);

	// Alone on its line: the line goes, with any comment that was describing the key.
	if (before.trim() === '' && restIsTrailing(after) && lineEnd < literal.close) {
		return { start: lineStart, end: pastLineBreak(source, lineEnd), text: '' };
	}

	// Sharing a line: take the statement and the space on whichever side keeps the rest tidy.
	let end = key.statementEnd;
	while (end < lineEnd && (source[end] === ' ' || source[end] === '\t')) {
		end += 1;
	}
	if (end < lineEnd && end > key.statementEnd && !source.startsWith('//', end) && source[end] !== '}') {
		return { start: key.start, end, text: '' };
	}
	let start = key.start;
	while (start > lineStart && (source[start - 1] === ' ' || source[start - 1] === '\t')) {
		start -= 1;
	}
	return { start, end: key.statementEnd, text: '' };
}

function insertion(
	source: string,
	literal: CurveLiteral,
	after: WrittenCurveKey | undefined,
	firstSlot: WrittenCurveKey | undefined,
	keys: readonly EditedCurveKey[],
	eol: string,
	indent: string,
	multiline: boolean,
): TextReplacement {
	const spelled = keys.map((key) => `${formatKey(key)};`);

	if (after) {
		const lineEnd = lineEndOf(source, after.statementEnd);
		const rest = source.slice(after.statementEnd, lineEnd);
		if (multiline && restIsTrailing(rest)) {
			return { start: lineEnd, end: lineEnd, text: spelled.map((text) => eol + indent + text).join('') };
		}
		if (multiline && rest.trim() === '}') {
			return { start: after.statementEnd, end: after.statementEnd, text: spelled.map((text) => eol + indent + text).join('') };
		}
		return { start: after.statementEnd, end: after.statementEnd, text: spelled.map((text) => ` ${text}`).join('') };
	}

	if (firstSlot) {
		if (multiline && opensLine(source, firstSlot.start)) {
			const lineStart = lineStartOf(source, firstSlot.start);
			return { start: lineStart, end: lineStart, text: spelled.map((text) => indent + text + eol).join('') };
		}
		return { start: firstSlot.start, end: firstSlot.start, text: spelled.map((text) => `${text} `).join('') };
	}

	// Nothing survives to stand next to: the keys go just before the closing brace.
	if (multiline) {
		const braceLine = lineStartOf(source, literal.close);
		if (opensLine(source, literal.close)) {
			return { start: braceLine, end: braceLine, text: spelled.map((text) => indent + text + eol).join('') };
		}
		const braceIndent = leadingWhitespace(source, braceLine);
		return { start: literal.close, end: literal.close, text: spelled.map((text) => eol + indent + text).join('') + eol + braceIndent };
	}
	const pad = /\s/.test(source[literal.close - 1] ?? '') ? '' : ' ';
	return { start: literal.close, end: literal.close, text: pad + spelled.map((text) => `${text} `).join('') };
}

/**
 * Sorted, with touching edits merged. An insertion at the exact offset where a deletion starts is
 * legal in principle and order-dependent in practice, so it is never handed to the editor that way.
 */
function coalesce(edits: TextReplacement[]): TextReplacement[] {
	const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
	const result: TextReplacement[] = [];
	for (const edit of sorted) {
		const last = result[result.length - 1];
		if (last && edit.start < last.end) {
			// Two neighbouring deletions may both claim the space between them; that much overlap is
			// harmless. Anything else overlapping is a bug in the planner, and is not guessed past.
			if (last.text !== '' || edit.text !== '') {
				throw new Error('overlapping curve edits');
			}
			last.end = Math.max(last.end, edit.end);
			continue;
		}
		if (last && edit.start === last.end) {
			last.text += edit.text;
			last.end = edit.end;
			continue;
		}
		result.push({ ...edit });
	}
	return result;
}
