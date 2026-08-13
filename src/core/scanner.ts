/**
 * A tokenizer for DreamFXLang, ported from the compiler's own lexer
 * (`Source/DreamFX/Private/Parser/DreamFXLexer.cpp`).
 *
 * Ported rather than invented, and deliberately narrow: everything in here is a *lexical* fact
 * about the text, which is the one layer where a second implementation cannot drift from the
 * compiler into disagreeing with it. Semantics -- does this module exist, does this input take
 * this type -- live in the C++ and are reported by `dfx`; reimplementing them here would create a
 * second source of truth, and the way that failure shows up is "the editor says it is fine and the
 * build says it is not", which is the worst of the available outcomes.
 *
 * No editor types are imported here on purpose: this module is the seam a future LSP server or
 * another IDE integration reuses.
 */

export interface SourcePosition {
	/** Zero-based character offset, for slicing. */
	offset: number;
	/** One-based, matching every DFXnnnn message. */
	line: number;
	/** One-based. */
	column: number;
}

export type TokenKind = 'identifier' | 'number' | 'string' | 'symbol' | 'end';

export interface Token {
	kind: TokenKind;
	/** For a string this is the *decoded* value; for everything else the exact spelling. */
	text: string;
	start: SourcePosition;
	end: SourcePosition;
	/** Number payload; only meaningful when kind === 'number'. */
	value?: number;
	/** L7 uses the distinction between `24` and `24.0`. */
	isInteger?: boolean;
	/** True when an identifier arrived back-quoted, which is how a name that is not an identifier is written. */
	quoted?: boolean;
}

export interface LexicalDiagnostic {
	/** The compiler's own code, or undefined for a purely structural observation it words differently. */
	code?: string;
	severity: 'error' | 'warning';
	message: string;
	start: SourcePosition;
	end: SourcePosition;
}

const TWO_CHAR_SYMBOLS = ['->', '+=', '-=', '*=', '/=', '==', '!=', '<=', '>=', '&&', '||', '::'];
const SINGLE_CHAR_SYMBOLS = new Set('{}()[]=;,.+-*/<>:#@?!&|%'.split(''));

/** ASCII-only, matching `FChar::IsAlpha`. A full-width bracket pasted from an IME is therefore DFX1003, which is the point. */
function isIdentifierStart(character: string): boolean {
	return (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') || character === '_';
}

function isDigit(character: string): boolean {
	return character >= '0' && character <= '9';
}

function isIdentifierBody(character: string): boolean {
	return isIdentifierStart(character) || isDigit(character);
}

function isWhitespace(character: string): boolean {
	return /\s/.test(character);
}

export class Scanner {
	private position = 0;
	private line = 1;
	private column = 1;
	private queue: Token[] = [];

	readonly diagnostics: LexicalDiagnostic[] = [];

	constructor(private readonly source: string) {}

	get location(): SourcePosition {
		return { offset: this.position, line: this.line, column: this.column };
	}

	peek(ahead = 0): Token {
		this.fill(ahead + 1);
		return this.queue[Math.min(ahead, this.queue.length - 1)];
	}

	next(): Token {
		this.fill(1);
		if (this.queue[0].kind === 'end') {
			return this.queue[0];
		}
		return this.queue.shift()!;
	}

	/** True when the next token is exactly this punctuation. */
	atSymbol(text: string, ahead = 0): boolean {
		const token = this.peek(ahead);
		return token.kind === 'symbol' && token.text === text;
	}

	/** True when the next token is exactly this identifier. Case-sensitive, as the compiler is. */
	atIdentifier(text: string, ahead = 0): boolean {
		const token = this.peek(ahead);
		return token.kind === 'identifier' && !token.quoted && token.text === text;
	}

	tryConsumeSymbol(text: string): boolean {
		if (this.atSymbol(text)) {
			this.next();
			return true;
		}
		return false;
	}

	/**
	 * Consumes a brace-balanced block starting at the pending `{` and returns its interior verbatim.
	 *
	 * The scanner is rewound to the recorded offset of that `{` and everything from there is read as
	 * characters, not tokens -- which is the only way `hlsl { }` and a module's `Body = { }` can hold
	 * text the DSL grammar would otherwise choke on. Strings and comments are skipped for the purpose
	 * of counting, so a body containing `// }` still balances.
	 */
	readRawBlock(): { text: string; start: SourcePosition; end: SourcePosition } | undefined {
		const open = this.peek();
		if (open.kind !== 'symbol' || open.text !== '{') {
			return undefined;
		}

		this.position = open.start.offset;
		this.line = open.start.line;
		this.column = open.start.column;
		this.queue = [];

		const start = { ...open.start };
		this.advance(); // past '{'
		const bodyStart = this.position;
		let depth = 1;

		while (!this.atEnd()) {
			const character = this.current();

			if (character === '/' && this.lookahead(1) === '/') {
				while (!this.atEnd() && this.current() !== '\n' && this.current() !== '\r') {
					this.advance();
				}
				continue;
			}

			if (character === '/' && this.lookahead(1) === '*') {
				this.advance();
				this.advance();
				while (!this.atEnd() && !(this.current() === '*' && this.lookahead(1) === '/')) {
					this.advance();
				}
				if (!this.atEnd()) {
					this.advance();
					this.advance();
				}
				continue;
			}

			if (character === '"') {
				this.advance();
				while (!this.atEnd() && this.current() !== '"') {
					if (this.current() === '\\') {
						this.advance();
					}
					this.advance();
				}
				if (!this.atEnd()) {
					this.advance();
				}
				continue;
			}

			if (character === '{') {
				depth += 1;
				this.advance();
				continue;
			}

			if (character === '}') {
				depth -= 1;
				if (depth === 0) {
					const text = this.source.slice(bodyStart, this.position);
					this.advance(); // past the closing '}'
					return { text, start, end: this.location };
				}
				this.advance();
				continue;
			}

			this.advance();
		}

		this.error('DFX1004', start, this.location, "Unterminated raw block: missing '}'.");
		return undefined;
	}

	// ---------------------------------------------------------------- internals

	private fill(count: number): void {
		while (this.queue.length < count) {
			const token = this.lexToken();
			const wasEnd = token.kind === 'end';
			this.queue.push(token);
			if (wasEnd) {
				break;
			}
		}
	}

	private atEnd(): boolean {
		return this.position >= this.source.length;
	}

	private current(): string {
		return this.position < this.source.length ? this.source[this.position] : '\0';
	}

	private lookahead(ahead: number): string {
		const index = this.position + ahead;
		return index < this.source.length ? this.source[index] : '\0';
	}

	private advance(): void {
		if (this.atEnd()) {
			return;
		}

		// A bare \r, a bare \n and the \r\n pair are each exactly one line break, so columns stay
		// right on a file with mixed endings -- and a column reported one off is a diagnostic that
		// points at the wrong character.
		const character = this.source[this.position];
		if (character === '\r') {
			if (this.lookahead(1) === '\n') {
				this.position += 1;
			}
			this.position += 1;
			this.line += 1;
			this.column = 1;
			return;
		}
		if (character === '\n') {
			this.position += 1;
			this.line += 1;
			this.column = 1;
			return;
		}

		this.position += 1;
		this.column += 1;
	}

	private error(code: string | undefined, start: SourcePosition, end: SourcePosition, message: string): void {
		this.diagnostics.push({ code, severity: 'error', message, start, end });
	}

	private skipTriviaAndComments(): void {
		while (!this.atEnd()) {
			const character = this.current();

			if (isWhitespace(character)) {
				this.advance();
				continue;
			}

			if (character === '/' && this.lookahead(1) === '/') {
				while (!this.atEnd() && this.current() !== '\n' && this.current() !== '\r') {
					this.advance();
				}
				continue;
			}

			if (character === '/' && this.lookahead(1) === '*') {
				const start = this.location;
				this.advance();
				this.advance();
				let closed = false;
				while (!this.atEnd()) {
					if (this.current() === '*' && this.lookahead(1) === '/') {
						this.advance();
						this.advance();
						closed = true;
						break;
					}
					this.advance();
				}
				if (!closed) {
					this.error('DFX1002', start, this.location, 'Unterminated block comment.');
				}
				continue;
			}

			break;
		}
	}

	private lexToken(): Token {
		this.skipTriviaAndComments();

		const start = this.location;

		if (this.atEnd()) {
			return { kind: 'end', text: '', start, end: start };
		}

		const character = this.current();

		if (isIdentifierStart(character)) {
			const begin = this.position;
			while (!this.atEnd() && isIdentifierBody(this.current())) {
				this.advance();
			}
			return { kind: 'identifier', text: this.source.slice(begin, this.position), start, end: this.location };
		}

		if (character === '`') {
			this.advance();
			const begin = this.position;
			while (!this.atEnd() && this.current() !== '`' && this.current() !== '\n' && this.current() !== '\r') {
				this.advance();
			}

			if (this.atEnd() || this.current() !== '`') {
				const text = this.source.slice(begin, this.position);
				this.error('DFX1005', start, this.location,
					'Unterminated back-quoted name. A `name` must close on the same line.');
				return { kind: 'identifier', text, start, end: this.location, quoted: true };
			}

			const text = this.source.slice(begin, this.position);
			this.advance(); // closing back-quote
			if (text.length === 0) {
				this.error('DFX1005', start, this.location, 'An empty back-quoted name is not a name.');
			}
			return { kind: 'identifier', text, start, end: this.location, quoted: true };
		}

		// A number never starts with '-': unary minus is an operator, so `A-1` does not silently lex
		// as `A` followed by the literal `-1` and lose the subtraction.
		if (isDigit(character) || (character === '.' && isDigit(this.lookahead(1)))) {
			const begin = this.position;
			let seenDot = false;
			let seenExponent = false;

			while (!this.atEnd()) {
				const digit = this.current();
				if (isDigit(digit)) {
					this.advance();
				} else if (digit === '.' && !seenDot && !seenExponent) {
					seenDot = true;
					this.advance();
				} else if ((digit === 'e' || digit === 'E') && !seenExponent
					&& (isDigit(this.lookahead(1))
						|| ((this.lookahead(1) === '+' || this.lookahead(1) === '-') && isDigit(this.lookahead(2))))) {
					seenExponent = true;
					this.advance();
					if (this.current() === '+' || this.current() === '-') {
						this.advance();
					}
				} else {
					break;
				}
			}

			// A trailing 'f' is tolerated so pasted HLSL constants need no editing, but it makes the
			// literal a float whether or not a decimal point was written.
			let floatSuffix = false;
			if (!this.atEnd() && (this.current() === 'f' || this.current() === 'F') && !isIdentifierBody(this.lookahead(1))) {
				floatSuffix = true;
				this.advance();
			}

			const digits = this.source.slice(begin, this.position - (floatSuffix ? 1 : 0));
			return {
				kind: 'number',
				text: digits,
				value: Number.parseFloat(digits),
				isInteger: !seenDot && !seenExponent && !floatSuffix,
				start,
				end: this.location,
			};
		}

		if (character === '"') {
			this.advance();
			let text = '';
			let closed = false;
			while (!this.atEnd()) {
				const stringCharacter = this.current();
				if (stringCharacter === '\\') {
					this.advance();
					if (this.atEnd()) {
						break;
					}
					const escaped = this.current();
					text += escaped === 'n' ? '\n' : escaped === 'r' ? '\r' : escaped === 't' ? '\t' : escaped;
					this.advance();
					continue;
				}
				if (stringCharacter === '"') {
					this.advance();
					closed = true;
					break;
				}
				if (stringCharacter === '\n' || stringCharacter === '\r') {
					break;
				}
				text += stringCharacter;
				this.advance();
			}

			if (!closed) {
				this.error('DFX1001', start, this.location, 'Unterminated string literal.');
			}
			return { kind: 'string', text, start, end: this.location };
		}

		for (const symbol of TWO_CHAR_SYMBOLS) {
			if (character === symbol[0] && this.lookahead(1) === symbol[1]) {
				this.advance();
				this.advance();
				return { kind: 'symbol', text: symbol, start, end: this.location };
			}
		}

		if (SINGLE_CHAR_SYMBOLS.has(character)) {
			this.advance();
			return { kind: 'symbol', text: character, start, end: this.location };
		}

		const codePoint = character.codePointAt(0) ?? 0;
		this.advance();
		this.error('DFX1003', start, this.location,
			`Unexpected character '${character}' (U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}).`);
		return this.lexToken();
	}
}
