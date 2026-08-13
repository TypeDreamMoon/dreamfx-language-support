/**
 * What is being written at a given offset.
 *
 * Completion runs on text that is, by definition, incomplete -- half a module name, an argument list
 * with no closing paren, a block that will not be closed until three lines from now. So this does
 * not use the structural walk next door: that one reads forwards and describes a document, and a
 * document that does not parse yet has no structure to describe. This reads *backwards* from the
 * cursor over a flat token list, which needs only the text to the left to be sane.
 */

import { Scanner, Token } from './scanner';

export type EditContext =
	| { kind: 'none' }
	/** At statement position inside a stack: a module call may start here. */
	| { kind: 'stackStatement'; stack?: string }
	/** At an argument name inside a call: `GravityForce(<here>` or `..., <here>`. */
	| { kind: 'argumentName'; module: string; stack?: string; alreadyWritten: string[] }
	/** After `Input = ` inside a call. */
	| { kind: 'argumentValue'; module: string; input: string; stack?: string };

/** L1's six, plus the two stack-shaped declarations. */
const STACK_KEYWORDS = new Set([
	'SystemSpawn', 'SystemUpdate',
	'EmitterSpawn', 'EmitterUpdate',
	'ParticleSpawn', 'ParticleUpdate',
]);

/**
 * A flat token list, with `hlsl { }` and a module's `Body = { }` collapsed to one token each.
 *
 * Collapsing is not an optimisation -- it is what makes the bracket counting below correct. Those
 * two constructs are raw text the compiler never tokenises, and a `{` inside a shader body would
 * otherwise be counted as an open block and put every later cursor in the wrong scope.
 */
export function tokenizeAll(text: string): Token[] {
	const scanner = new Scanner(text);
	const tokens: Token[] = [];

	for (;;) {
		const token = scanner.peek();
		if (token.kind === 'end') {
			return tokens;
		}

		const isHlslValue = token.kind === 'identifier' && token.text === 'hlsl' && scanner.atSymbol('{', 1);
		const isModuleBody = token.kind === 'identifier' && token.text === 'Body'
			&& scanner.atSymbol('=', 1) && scanner.atSymbol('{', 2);

		if (isHlslValue || isModuleBody) {
			tokens.push(scanner.next());
			if (isModuleBody) {
				tokens.push(scanner.next()); // '='
			}
			const block = scanner.readRawBlock();
			if (!block) {
				// Unterminated: everything after the opening brace is raw text with no structure, so
				// there is nothing further to say about this document.
				return tokens;
			}
			tokens.push({ kind: 'symbol', text: '{}', start: block.start, end: block.end });
			continue;
		}

		tokens.push(scanner.next());
	}
}

export function contextAt(text: string, offset: number): EditContext {
	const tokens = tokenizeAll(text);

	// Inside an `hlsl { }` or a module's `Body = { }` there is no DreamFXLang to complete -- it is
	// HLSL, and the collapsed token below would otherwise let the cursor appear to sit in whatever
	// block encloses the raw one.
	if (tokens.some((token) => token.text === '{}' && token.start.offset < offset && offset < token.end.offset)) {
		return { kind: 'none' };
	}

	// The token being typed is not context for itself: a cursor in the middle of `Grav|` should be
	// offered module names, which means looking at what came before `Grav`.
	let cursor = tokens.length - 1;
	while (cursor >= 0 && tokens[cursor].start.offset >= offset) {
		cursor -= 1;
	}
	if (cursor >= 0 && tokens[cursor].end.offset >= offset && tokens[cursor].kind === 'identifier') {
		cursor -= 1;
	}

	const scope = findEnclosingScope(tokens, cursor);

	if (scope.kind === 'paren') {
		const module = readCallName(tokens, scope.index - 1);
		if (!module) {
			return { kind: 'none' };
		}
		const stack = findEnclosingStack(tokens, scope.index);
		return readArgumentPosition(tokens, scope.index, cursor, module, stack);
	}

	if (scope.kind === 'brace') {
		const stack = stackOfBlock(tokens, scope.index);
		return stack === undefined ? { kind: 'none' } : { kind: 'stackStatement', stack };
	}

	return { kind: 'none' };
}

// ---------------------------------------------------------------- scopes

type Scope = { kind: 'paren' | 'brace'; index: number } | { kind: 'file' };

/**
 * The innermost bracket the cursor sits inside.
 *
 * Both depths are tracked in one pass and the *nearer* unclosed opener wins, because that is what
 * "innermost" means: an argument list inside a stack block is a paren inside a brace, and the paren
 * is found first walking back.
 */
function findEnclosingScope(tokens: Token[], from: number): Scope {
	let parenDepth = 0;
	let braceDepth = 0;

	for (let index = from; index >= 0; index -= 1) {
		const token = tokens[index];
		if (token.kind !== 'symbol') {
			continue;
		}

		switch (token.text) {
			case ')':
				parenDepth += 1;
				break;
			case '(':
				if (parenDepth === 0) {
					return { kind: 'paren', index };
				}
				parenDepth -= 1;
				break;
			case '}':
				braceDepth += 1;
				break;
			case '{':
				if (braceDepth === 0) {
					return { kind: 'brace', index };
				}
				braceDepth -= 1;
				break;
			default:
				break;
		}
	}

	return { kind: 'file' };
}

/**
 * The module name written immediately before a `(`.
 *
 * Handles the partial-path form (`Spawn/Initialization/V2/InitializeParticle`) and the `@version`
 * pin, because both are things a real source writes in front of an argument list.
 */
function readCallName(tokens: Token[], from: number): string | undefined {
	let index = from;

	// `Name@1.2(` -- step back over the pin first.
	if (index >= 1 && tokens[index].kind === 'number' && isSymbol(tokens[index - 1], '@')) {
		index -= 2;
	}

	if (index < 0 || tokens[index].kind !== 'identifier') {
		return undefined;
	}

	const segments = [tokens[index].text];
	index -= 1;
	while (index >= 1 && isSymbol(tokens[index], '/') && tokens[index - 1].kind === 'identifier') {
		segments.unshift(tokens[index - 1].text);
		index -= 2;
	}

	return segments.join('/');
}

/**
 * The stack keyword that opened the block a `(` sits inside, if it is a stack at all.
 *
 * Loops outward rather than stepping out once, because a dynamic input chain nests argument lists to
 * any depth: `ScaleSpriteSize(UniformScaleFactor = FloatFromCurve(CurveIndex = <here>))` is two
 * parens deep, and one hop would land on the outer paren and conclude there is no stack.
 */
function findEnclosingStack(tokens: Token[], from: number): string | undefined {
	let index = from - 1;

	for (;;) {
		const scope = findEnclosingScope(tokens, index);
		if (scope.kind === 'file') {
			return undefined;
		}
		if (scope.kind === 'brace') {
			return stackOfBlock(tokens, scope.index);
		}
		index = scope.index - 1;
	}
}

/**
 * Which stack a `{` opens, or undefined when the block is not a stack.
 *
 * `Stage` and `OnEvent` both declare particle-scope stacks -- a stage runs after ParticleUpdate and
 * an event handler runs on particles -- so both are answered as ParticleUpdate. That is a statement
 * about which modules are offerable, not about how the compiler classifies them.
 */
function stackOfBlock(tokens: Token[], braceIndex: number): string | undefined {
	let index = braceIndex - 1;

	if (index >= 0 && isSymbol(tokens[index], '=')) {
		index -= 1;
	}

	// `Stage Name(...) =` / `OnEvent(...) =`: step back over the header's parens.
	if (index >= 0 && isSymbol(tokens[index], ')')) {
		let depth = 0;
		while (index >= 0) {
			const token = tokens[index];
			if (isSymbol(token, ')')) {
				depth += 1;
			} else if (isSymbol(token, '(')) {
				depth -= 1;
				if (depth === 0) {
					index -= 1;
					break;
				}
			}
			index -= 1;
		}
	}

	// `Stage Settle =` -- the stage's own name sits between the keyword and the block.
	if (index >= 1 && tokens[index].kind === 'identifier' && tokens[index - 1].kind === 'identifier'
		&& tokens[index - 1].text === 'Stage') {
		index -= 1;
	}

	if (index < 0 || tokens[index].kind !== 'identifier') {
		return undefined;
	}

	const keyword = tokens[index].text;
	if (STACK_KEYWORDS.has(keyword)) {
		return keyword;
	}
	if (keyword === 'Stage' || keyword === 'OnEvent') {
		return 'ParticleUpdate';
	}
	return undefined;
}

// ---------------------------------------------------------------- argument lists

function readArgumentPosition(
	tokens: Token[],
	openParen: number,
	cursor: number,
	module: string,
	stack: string | undefined,
): EditContext {
	const alreadyWritten: string[] = [];
	let depth = 0;
	let separator = openParen;

	// Forward over the argument list to the cursor: collect the names already given, and remember
	// where the current argument began.
	for (let index = openParen + 1; index <= cursor; index += 1) {
		const token = tokens[index];
		if (token.kind !== 'symbol') {
			continue;
		}
		if (token.text === '(' || token.text === '[' || token.text === '{') {
			depth += 1;
		} else if (token.text === ')' || token.text === ']' || token.text === '}') {
			depth -= 1;
		} else if (token.text === ',' && depth === 0) {
			separator = index;
		} else if (token.text === '=' && depth === 0) {
			const name = tokens[index - 1];
			if (index - 1 > separator && name?.kind === 'identifier') {
				alreadyWritten.push(name.text);
			}
		}
	}

	// Is there a top-level `=` after the separator that starts this argument? If so the cursor is
	// writing a value; if not, it is still writing the name.
	let assignment = -1;
	depth = 0;
	for (let index = separator + 1; index <= cursor; index += 1) {
		const token = tokens[index];
		if (token.kind !== 'symbol') {
			continue;
		}
		if (token.text === '(' || token.text === '[' || token.text === '{') {
			depth += 1;
		} else if (token.text === ')' || token.text === ']' || token.text === '}') {
			depth -= 1;
		} else if (token.text === '=' && depth === 0) {
			assignment = index;
		}
	}

	if (assignment === -1) {
		return { kind: 'argumentName', module, stack, alreadyWritten };
	}

	const name = tokens[assignment - 1];
	if (!name || name.kind !== 'identifier') {
		return { kind: 'none' };
	}
	return { kind: 'argumentValue', module, input: name.text, stack };
}

function isSymbol(token: Token | undefined, text: string): boolean {
	return token?.kind === 'symbol' && token.text === text;
}

// ---------------------------------------------------------------- hover

export type HoverTarget =
	| { kind: 'module'; name: string; stack?: string }
	| { kind: 'input'; module: string; name: string; stack?: string };

/**
 * What the identifier *under* the cursor is, as opposed to what is being typed before it.
 *
 * Hover and completion ask different questions and cannot share an answer: completion wants the
 * context to the left of an incomplete word, hover wants the meaning of a complete one.
 */
export function targetAt(text: string, offset: number): HoverTarget | undefined {
	const tokens = tokenizeAll(text);

	const index = tokens.findIndex(
		(token) => token.kind === 'identifier' && token.start.offset <= offset && offset < token.end.offset);
	if (index === -1) {
		return undefined;
	}

	// Walk to the end of a partial path, so hovering any segment of
	// `Spawn/Initialization/V2/InitializeParticle` describes the module it names.
	let last = index;
	while (isSymbol(tokens[last + 1], '/') && tokens[last + 2]?.kind === 'identifier') {
		last += 2;
	}

	let after = last + 1;
	if (isSymbol(tokens[after], '@') && tokens[after + 1]?.kind === 'number') {
		after += 2;
	}

	if (isSymbol(tokens[after], '(')) {
		const name = readCallName(tokens, last);
		return name ? { kind: 'module', name, stack: findEnclosingStack(tokens, after) } : undefined;
	}

	// `Input = ...` inside an argument list.
	if (isSymbol(tokens[index + 1], '=')) {
		const scope = findEnclosingScope(tokens, index - 1);
		if (scope.kind === 'paren') {
			const module = readCallName(tokens, scope.index - 1);
			if (module) {
				return {
					kind: 'input',
					module,
					name: tokens[index].text,
					stack: findEnclosingStack(tokens, scope.index),
				};
			}
		}
	}

	return undefined;
}
