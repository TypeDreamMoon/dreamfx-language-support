/**
 * A forgiving structural walk of a DreamFXLang file.
 *
 * "Forgiving" is the design, not a shortcut: this runs on every keystroke, on text that is wrong
 * roughly half the time it is looked at, and an outline that vanishes while you type a block is
 * worse than one that is briefly approximate. So nothing here throws, every loop is guaranteed to
 * consume a token, and an unrecognised construct is skipped rather than treated as a parse failure.
 *
 * What it produces: the navigable structure (document, emitters, stacks, sections, renderers,
 * module calls, declarations) and the handful of problems that are certain from the text alone.
 * Everything else -- does this module exist, does this input take this type, is this switch written
 * before what it gates -- is the compiler's, and is reported by `dfx`.
 */

import { LexicalDiagnostic, Scanner, SourcePosition, Token } from './scanner';

export type StructureKind =
	| 'document'
	| 'emitter'
	| 'stack'
	| 'section'
	| 'renderer'
	| 'moduleCall'
	| 'declaration';

export interface StructureNode {
	kind: StructureKind;
	/** What to show in the outline. */
	name: string;
	/** The dimmed half of the outline row: a type, an asset path, a stage header. */
	detail: string;
	/** The whole construct, for folding and for "reveal". */
	start: SourcePosition;
	end: SourcePosition;
	/** Just the name, so clicking the outline row lands on the identifier rather than the block. */
	selectionStart: SourcePosition;
	selectionEnd: SourcePosition;
	children: StructureNode[];
}

export interface DocumentModel {
	root?: StructureNode;
	diagnostics: LexicalDiagnostic[];
}

/** L1: the six fixed stacks. `OnEvent` and `Stage` declare the other two kinds. */
const STACK_KEYWORDS = new Set([
	'SystemSpawn', 'SystemUpdate',
	'EmitterSpawn', 'EmitterUpdate',
	'ParticleSpawn', 'ParticleUpdate',
]);

const SECTION_KEYWORDS = new Set(['Settings', 'Properties', 'Inputs', 'Defaults']);

/** Sections whose entries are the file's public surface, and so are worth listing individually. */
const DECLARATION_SECTIONS = new Set(['Properties', 'Inputs', 'Defaults']);

const DOCUMENT_KINDS = new Set(['System', 'Emitter', 'Module', 'DynamicInput']);

export function analyze(text: string): DocumentModel {
	return new Walker(text).run();
}

function laterOf(a: SourcePosition, b: SourcePosition): SourcePosition {
	return a.offset >= b.offset ? a : b;
}

class Walker {
	private readonly scanner: Scanner;
	private readonly extra: LexicalDiagnostic[] = [];

	constructor(text: string) {
		this.scanner = new Scanner(text);
	}

	run(): DocumentModel {
		const root = this.parseFile();
		return { root, diagnostics: [...this.scanner.diagnostics, ...this.extra] };
	}

	// ---------------------------------------------------------------- file

	private parseFile(): StructureNode | undefined {
		let root: StructureNode | undefined;

		while (this.scanner.peek().kind !== 'end') {
			const token = this.scanner.peek();

			if (token.kind === 'identifier' && DOCUMENT_KINDS.has(token.text) && this.scanner.atSymbol('(', 1)) {
				root = this.parseDocument();
				break;
			}

			if (token.kind === 'symbol' && token.text === '}') {
				this.report(token, "Unexpected '}': no block is open here.");
			}

			this.scanner.next();
		}

		// Anything after the top-level object is either a stray brace or the compiler's problem.
		while (this.scanner.peek().kind !== 'end') {
			const token = this.scanner.peek();
			if (token.kind === 'symbol' && token.text === '}') {
				this.report(token, "Unexpected '}': no block is open here.");
			}
			this.scanner.next();
		}

		return root;
	}

	private parseDocument(): StructureNode {
		const keyword = this.scanner.next();
		const header = this.readHeaderArguments();

		const node: StructureNode = {
			kind: 'document',
			name: header.get('Name') ?? keyword.text,
			detail: header.has('Name') ? keyword.text : '',
			start: keyword.start,
			end: keyword.end,
			selectionStart: keyword.start,
			selectionEnd: keyword.end,
			children: [],
		};

		if (this.scanner.atSymbol('{')) {
			node.end = this.parseBody(node.children);
		}
		return node;
	}

	/**
	 * `(Name="Effects/NS_Spark", Root="Game")`. Read by key rather than by position because the two
	 * arguments are order-independent and `Root` is routinely left out.
	 */
	private readHeaderArguments(): Map<string, string> {
		const values = new Map<string, string>();
		if (!this.scanner.tryConsumeSymbol('(')) {
			return values;
		}

		let depth = 1;
		while (this.scanner.peek().kind !== 'end') {
			const token = this.scanner.next();
			if (token.kind === 'symbol' && token.text === '(') {
				depth += 1;
				continue;
			}
			if (token.kind === 'symbol' && token.text === ')') {
				depth -= 1;
				if (depth === 0) {
					break;
				}
				continue;
			}
			if (token.kind === 'identifier' && this.scanner.atSymbol('=') && this.scanner.peek(1).kind === 'string') {
				this.scanner.next();
				values.set(token.text, this.scanner.next().text);
			}
		}
		return values;
	}

	// ---------------------------------------------------------------- bodies

	/**
	 * Reads a `{ ... }` body, appending whatever it recognises to `children`.
	 *
	 * One body parser for every scope rather than one per kind: which sections are legal where is a
	 * semantic rule the compiler already enforces with a specific message (DFX2013 for a system-scope
	 * stack inside an emitter, and so on). Duplicating that here would only mean two verdicts.
	 */
	private parseBody(children: StructureNode[]): SourcePosition {
		const open = this.scanner.next(); // '{'
		let end = open.end;

		for (;;) {
			const token = this.scanner.peek();

			if (token.kind === 'end') {
				this.report(open, "Unclosed '{': this block is never closed.");
				return end;
			}

			if (token.kind === 'symbol' && token.text === '}') {
				return this.scanner.next().end;
			}

			const before = token.start.offset;
			const node = this.parseMember();
			if (node) {
				children.push(node);
				end = node.end;
			}

			// Guaranteed progress: a construct the walk does not recognise must still cost a token,
			// or a single unexpected character would hang the editor.
			if (this.scanner.peek().start.offset === before && this.scanner.peek().kind !== 'end') {
				end = this.scanner.next().end;
			}
		}
	}

	private parseMember(): StructureNode | undefined {
		const token = this.scanner.peek();

		if (token.kind !== 'identifier') {
			this.skipStatement();
			return undefined;
		}

		// `Body = { ... }` is raw text: read it as characters so an HLSL brace never closes the block.
		if (token.text === 'Body' && this.scanner.atSymbol('=', 1)) {
			return this.parseRawSection();
		}

		if (SECTION_KEYWORDS.has(token.text) && this.scanner.atSymbol('=', 1)) {
			return this.parseSection();
		}

		if (STACK_KEYWORDS.has(token.text) && this.scanner.atSymbol('=', 1)) {
			return this.parseStack();
		}

		if (token.text === 'Stage') {
			return this.parseStage();
		}

		if (token.text === 'OnEvent') {
			return this.parseEventHandler();
		}

		if (token.text === 'Emitter' && this.scanner.peek(1).kind === 'identifier') {
			return this.parseEmitter();
		}

		// `SpriteRenderer Core { }` or `SpriteRenderer { }`. Matched by shape: renderer properties are
		// schema-driven (L8), so the set of type names is open and a fixed list would go stale.
		if (this.scanner.peek(1).kind === 'identifier' && this.scanner.atSymbol('{', 2)) {
			return this.parseRenderer(true);
		}
		if (this.scanner.atSymbol('{', 1)) {
			return this.parseRenderer(false);
		}

		this.skipStatement();
		return undefined;
	}

	// ---------------------------------------------------------------- members

	private parseSection(): StructureNode {
		const keyword = this.scanner.next();
		this.scanner.next(); // '='

		const node: StructureNode = {
			kind: 'section',
			name: keyword.text,
			detail: '',
			start: keyword.start,
			end: keyword.end,
			selectionStart: keyword.start,
			selectionEnd: keyword.end,
			children: [],
		};

		if (this.scanner.atSymbol('{')) {
			node.end = DECLARATION_SECTIONS.has(keyword.text)
				? this.parseDeclarationBlock(node.children)
				: this.parseOpaqueBlock();
		}
		if (node.children.length > 0) {
			node.detail = `${node.children.length}`;
		}
		return node;
	}

	private parseRawSection(): StructureNode {
		const keyword = this.scanner.next(); // 'Body'
		this.scanner.next(); // '='

		const node: StructureNode = {
			kind: 'section',
			name: keyword.text,
			detail: 'HLSL',
			start: keyword.start,
			end: keyword.end,
			selectionStart: keyword.start,
			selectionEnd: keyword.end,
			children: [],
		};

		const block = this.scanner.readRawBlock();
		if (block) {
			node.end = block.end;
			const lines = block.text.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0).length;
			node.detail = `HLSL, ${lines} ${lines === 1 ? 'line' : 'lines'}`;
		}
		this.scanner.tryConsumeSymbol(';');
		return node;
	}

	private parseStack(): StructureNode {
		const keyword = this.scanner.next();
		this.scanner.next(); // '='

		const node: StructureNode = {
			kind: 'stack',
			name: keyword.text,
			detail: '',
			start: keyword.start,
			end: keyword.end,
			selectionStart: keyword.start,
			selectionEnd: keyword.end,
			children: [],
		};

		if (this.scanner.atSymbol('{')) {
			node.end = this.parseStackBlock(node.children);
		}
		return node;
	}

	private parseStage(): StructureNode {
		const keyword = this.scanner.next(); // 'Stage'
		const node: StructureNode = {
			kind: 'stack',
			name: 'Stage',
			detail: '',
			start: keyword.start,
			end: keyword.end,
			selectionStart: keyword.start,
			selectionEnd: keyword.end,
			children: [],
		};

		if (this.scanner.peek().kind === 'identifier') {
			const name = this.scanner.next();
			node.name = name.text;
			node.selectionStart = name.start;
			node.selectionEnd = name.end;
			node.detail = 'Stage';
		}

		if (this.scanner.atSymbol('(')) {
			node.detail = `Stage${this.readArgumentSummary()}`;
		}

		this.scanner.tryConsumeSymbol('=');
		if (this.scanner.atSymbol('{')) {
			node.end = this.parseStackBlock(node.children);
		}
		return node;
	}

	private parseEventHandler(): StructureNode {
		const keyword = this.scanner.next(); // 'OnEvent'
		const node: StructureNode = {
			kind: 'stack',
			name: 'OnEvent',
			detail: '',
			start: keyword.start,
			end: keyword.end,
			selectionStart: keyword.start,
			selectionEnd: keyword.end,
			children: [],
		};

		if (this.scanner.atSymbol('(')) {
			node.detail = this.readArgumentSummary().trim();
		}

		this.scanner.tryConsumeSymbol('=');
		if (this.scanner.atSymbol('{')) {
			node.end = this.parseStackBlock(node.children);
		}
		return node;
	}

	private parseEmitter(): StructureNode {
		const keyword = this.scanner.next(); // 'Emitter'
		const name = this.scanner.next();

		const node: StructureNode = {
			kind: 'emitter',
			name: name.text,
			detail: '',
			start: keyword.start,
			end: name.end,
			selectionStart: name.start,
			selectionEnd: name.end,
			children: [],
		};

		// `from "..."` is copy, not inheritance (R3) -- worth showing, because the outline is then
		// telling you where the rest of this emitter actually lives.
		if (this.scanner.atIdentifier('from')) {
			this.scanner.next();
			if (this.scanner.peek().kind === 'string') {
				node.detail = `from "${this.scanner.next().text}"`;
			}
		}

		if (this.scanner.atSymbol('{')) {
			node.end = this.parseBody(node.children);
		}
		return node;
	}

	private parseRenderer(named: boolean): StructureNode {
		const type = this.scanner.next();
		const name = named ? this.scanner.next() : undefined;

		const node: StructureNode = {
			kind: 'renderer',
			name: name ? name.text : type.text,
			detail: name ? type.text : '',
			start: type.start,
			end: (name ?? type).end,
			selectionStart: (name ?? type).start,
			selectionEnd: (name ?? type).end,
			children: [],
		};

		if (this.scanner.atSymbol('{')) {
			node.end = this.parseOpaqueBlock();
		}
		return node;
	}

	// ---------------------------------------------------------------- blocks

	/** A stack block: module calls become outline entries, folded assignments do not. */
	private parseStackBlock(children: StructureNode[]): SourcePosition {
		const open = this.scanner.next(); // '{'
		let end = open.end;

		for (;;) {
			const token = this.scanner.peek();

			if (token.kind === 'end') {
				this.report(open, "Unclosed '{': this block is never closed.");
				return end;
			}
			if (token.kind === 'symbol' && token.text === '}') {
				return this.scanner.next().end;
			}

			const before = token.start.offset;
			const call = this.parseModuleCall();
			if (call) {
				children.push(call);
				end = call.end;
			} else {
				this.skipStatement();
			}

			if (this.scanner.peek().start.offset === before && this.scanner.peek().kind !== 'end') {
				end = this.scanner.next().end;
			}
		}
	}

	/**
	 * A module call, if that is what starts here.
	 *
	 * L2 has exactly two statement forms, and the other one -- an assignment -- is deliberately not
	 * an outline entry: consecutive assignments fold into a single Set Parameters module, so an
	 * assignment is not a thing you navigate to, it is a line inside one.
	 */
	private parseModuleCall(): StructureNode | undefined {
		const first = this.scanner.peek();
		if (first.kind !== 'identifier') {
			return undefined;
		}

		// Decided entirely by lookahead: nothing is consumed until this is known to be a call,
		// because the alternative -- an assignment -- has to be left intact for skipStatement.
		let index = 0;
		let disabled = false;
		if (first.text === 'disabled' && !first.quoted && this.scanner.peek(1).kind === 'identifier') {
			disabled = true;
			index = 1;
		}

		// A partial path such as Spawn/Initialization/V2/InitializeParticle, written when the short
		// name is ambiguous (L4). The short name is the last segment and the one worth listing.
		let last = index;
		while (this.scanner.peek(last).kind === 'identifier'
			&& this.scanner.atSymbol('/', last + 1)
			&& this.scanner.peek(last + 2).kind === 'identifier') {
			last += 2;
		}

		let after = last + 1;
		let version = '';
		if (this.scanner.atSymbol('@', after) && this.scanner.peek(after + 1).kind === 'number') {
			version = `@${this.scanner.peek(after + 1).text}`;
			after += 2;
		}

		if (!this.scanner.atSymbol('(', after)) {
			return undefined;
		}

		const start = first.start;
		let nameToken = first;
		for (let step = 0; step <= last; step += 1) {
			nameToken = this.scanner.next();
		}
		for (let step = last + 1; step < after; step += 1) {
			this.scanner.next();
		}

		const args = this.countArguments();
		const argumentCount = args.count;

		let detail = disabled ? 'disabled' : '';
		if (version) {
			detail = detail ? `${detail} ${version}` : version;
		}

		// `as <name>` pins the function call node's name, which is what `Output.<node>.<value>` links
		// resolve against -- so when it is written, it is the identity of this call.
		let end = args.end;
		if (this.scanner.atIdentifier('as') && this.scanner.peek(1).kind === 'identifier') {
			this.scanner.next();
			const alias = this.scanner.next();
			detail = detail ? `${detail} as ${alias.text}` : `as ${alias.text}`;
			end = alias.end;
		}
		if (this.scanner.atSymbol(';')) {
			end = this.scanner.next().end;
		}

		if (argumentCount > 0) {
			detail = detail
				? `${detail} · ${argumentCount} ${argumentCount === 1 ? 'input' : 'inputs'}`
				: `${argumentCount} ${argumentCount === 1 ? 'input' : 'inputs'}`;
		}

		return {
			kind: 'moduleCall',
			name: nameToken.text,
			detail,
			start,
			end,
			selectionStart: nameToken.start,
			selectionEnd: nameToken.end,
			children: [],
		};
	}

	/**
	 * Consumes a balanced `( ... )` and reports how many top-level arguments it held.
	 *
	 * Counting rather than recording: a module call's arguments are named (DFX2008) and can nest to
	 * any depth through dynamic inputs, so listing them would bury the stack they belong to.
	 */
	private countArguments(): { count: number; end: SourcePosition } {
		if (!this.scanner.atSymbol('(')) {
			return { count: 0, end: this.scanner.peek().start };
		}
		let end = this.scanner.next().end;

		let depth = 1;
		let count = 0;
		let sawContent = false;

		for (;;) {
			const token = this.scanner.peek();
			if (token.kind === 'end') {
				return { count: count + (sawContent ? 1 : 0), end };
			}

			if (token.kind === 'identifier' && token.text === 'hlsl' && this.scanner.atSymbol('{', 1)) {
				this.scanner.next();
				const block = this.scanner.readRawBlock();
				if (block) {
					end = block.end;
				}
				sawContent = true;
				continue;
			}

			end = this.scanner.next().end;
			if (token.kind === 'symbol') {
				if (token.text === '(' || token.text === '[' || token.text === '{') {
					depth += 1;
					sawContent = true;
					continue;
				}
				if (token.text === ')' || token.text === ']' || token.text === '}') {
					depth -= 1;
					if (depth === 0) {
						return { count: count + (sawContent ? 1 : 0), end };
					}
					continue;
				}
				if (token.text === ',' && depth === 1) {
					count += 1;
					sawContent = false;
					continue;
				}
			}
			sawContent = true;
		}
	}

	/** The same balanced read, kept as text for a stage or event-handler header. */
	private readArgumentSummary(): string {
		if (!this.scanner.atSymbol('(')) {
			return '';
		}
		const parts: string[] = [];
		this.scanner.next();
		let depth = 1;
		for (;;) {
			const token = this.scanner.peek();
			if (token.kind === 'end') {
				break;
			}
			this.scanner.next();
			if (token.kind === 'symbol' && (token.text === '(' || token.text === '[')) {
				depth += 1;
			} else if (token.kind === 'symbol' && (token.text === ')' || token.text === ']')) {
				depth -= 1;
				if (depth === 0) {
					break;
				}
			}
			if (depth === 1 && token.kind === 'identifier' && this.scanner.atSymbol('=')) {
				parts.push(token.text);
			}
		}
		return parts.length > 0 ? ` (${parts.join(', ')})` : '';
	}

	/** A `Properties` / `Inputs` / `Defaults` block: one outline entry per declaration. */
	private parseDeclarationBlock(children: StructureNode[]): SourcePosition {
		const open = this.scanner.next(); // '{'
		let end = open.end;

		for (;;) {
			const token = this.scanner.peek();

			if (token.kind === 'end') {
				this.report(open, "Unclosed '{': this block is never closed.");
				return end;
			}
			if (token.kind === 'symbol' && token.text === '}') {
				return this.scanner.next().end;
			}

			const before = token.start.offset;
			const declaration = this.parseDeclaration();
			if (declaration) {
				children.push(declaration);
				end = declaration.end;
			}

			if (this.scanner.peek().start.offset === before && this.scanner.peek().kind !== 'end') {
				end = this.scanner.next().end;
			}
		}
	}

	/**
	 * `<Type> <Name> [= value] [ attrs ] ;`
	 *
	 * The name is taken as the trailing dotted chain rather than "the second token", because a type
	 * can be several tokens (`DI<SkeletalMesh>`) and a Defaults entry's target is namespace-qualified
	 * (`Vector Particles.Home`).
	 */
	private parseDeclaration(): StructureNode | undefined {
		if (this.skipRegionMarker()) {
			return undefined;
		}

		const head: Token[] = [];
		while (this.scanner.peek().kind !== 'end') {
			const token = this.scanner.peek();
			if (token.kind === 'symbol' && (token.text === '=' || token.text === '[' || token.text === ';' || token.text === '}')) {
				break;
			}
			head.push(this.scanner.next());
		}

		if (head.length === 0) {
			this.skipStatement();
			return undefined;
		}

		let nameIndex = head.length - 1;
		while (nameIndex >= 2 && head[nameIndex - 1].kind === 'symbol' && head[nameIndex - 1].text === '.') {
			nameIndex -= 2;
		}
		const nameToken = head[nameIndex];
		if (nameToken.kind !== 'identifier') {
			this.skipStatement();
			return undefined;
		}

		const name = head.slice(nameIndex).map((token) => (token.quoted ? `\`${token.text}\`` : token.text)).join('');
		const type = head.slice(0, nameIndex).map((token) => (token.quoted ? `\`${token.text}\`` : token.text)).join('');

		// A declaration with no terminator -- the line you are in the middle of typing -- leaves
		// skipStatement sitting on the enclosing '}', which is *behind* the name. An outline entry
		// whose range does not contain its own selection is rejected outright by VSCode, so the two
		// are reconciled here rather than at every call site.
		const end = laterOf(this.skipStatement(), head[head.length - 1].end);

		return {
			kind: 'declaration',
			name,
			detail: type,
			start: head[0].start,
			end,
			selectionStart: nameToken.start,
			selectionEnd: head[head.length - 1].end,
			children: [],
		};
	}

	/** A block whose contents are not outline material -- consumed whole, braces balanced. */
	private parseOpaqueBlock(): SourcePosition {
		const open = this.scanner.next(); // '{'
		let depth = 1;
		let end = open.end;

		for (;;) {
			const token = this.scanner.peek();
			if (token.kind === 'end') {
				this.report(open, "Unclosed '{': this block is never closed.");
				return end;
			}

			if (token.kind === 'identifier' && token.text === 'hlsl' && this.scanner.atSymbol('{', 1)) {
				this.scanner.next();
				const block = this.scanner.readRawBlock();
				if (block) {
					end = block.end;
				}
				continue;
			}

			end = this.scanner.next().end;
			if (token.kind === 'symbol' && token.text === '{') {
				depth += 1;
			} else if (token.kind === 'symbol' && token.text === '}') {
				depth -= 1;
				if (depth === 0) {
					return end;
				}
			}
		}
	}

	/**
	 * Consumes one statement: up to the `;` that ends it, with brackets balanced and `hlsl { }` read
	 * raw. Stops *before* a `}` that would close the enclosing block, so a missing semicolon costs
	 * one statement rather than the rest of the file.
	 */
	private skipStatement(): SourcePosition {
		const region = this.skipRegionMarker();
		if (region) {
			return region;
		}

		let depth = 0;
		let end = this.scanner.peek().start;

		for (;;) {
			const token = this.scanner.peek();
			if (token.kind === 'end') {
				return end;
			}

			if (token.kind === 'identifier' && token.text === 'hlsl' && this.scanner.atSymbol('{', 1)) {
				this.scanner.next();
				const block = this.scanner.readRawBlock();
				if (block) {
					end = block.end;
				}
				continue;
			}

			if (token.kind === 'symbol' && token.text === '}' && depth === 0) {
				return end;
			}

			end = this.scanner.next().end;

			if (token.kind === 'symbol') {
				if (token.text === '(' || token.text === '[' || token.text === '{') {
					depth += 1;
				} else if (token.text === ')' || token.text === ']' || token.text === '}') {
					depth = Math.max(0, depth - 1);
				} else if (token.text === ';' && depth === 0) {
					return end;
				}
			}
		}
	}

	// ---------------------------------------------------------------- helpers

	/**
	 * `#Region "name"` and `#EndRegion` are whole statements with no terminator.
	 *
	 * Without this the statement skipper runs past the marker looking for a `;` and swallows the
	 * module call that follows it -- which is how the outline of a stack came to lose whatever
	 * happened to be written under its first region header. L5: the marker is a comment, and it
	 * reaches nothing.
	 */
	private skipRegionMarker(): SourcePosition | undefined {
		if (!this.scanner.atSymbol('#')) {
			return undefined;
		}
		const next = this.scanner.peek(1);
		if (next.kind !== 'identifier' || (next.text !== 'Region' && next.text !== 'EndRegion')) {
			return undefined;
		}

		this.scanner.next(); // '#'
		let end = this.scanner.next().end; // Region | EndRegion
		if (this.scanner.peek().kind === 'string') {
			end = this.scanner.next().end;
		}
		return end;
	}

	private report(token: Token, message: string): void {
		this.extra.push({
			severity: 'error',
			message,
			start: token.start,
			end: token.end,
		});
	}
}
