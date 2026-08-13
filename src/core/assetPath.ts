/**
 * Which asset a source file builds.
 *
 * Every DreamFXLang file opens with the same header -- `System(Name="...", Root="...")` -- and those
 * two arguments are the whole mapping. `Root` is `Game`, empty (the same thing), or
 * `Plugin.<PluginName>`; `Name` is the path under that root's content directory. So a `Game` root is
 * mounted at `/Game/` and a plugin root at `/<PluginName>/`.
 *
 * Verified against this project's own content rather than taken from the docs alone: every
 * `Root="Plugin.DreamFX"` source resolves to a `/DreamFX/...` package that exists on disk.
 */

import { Scanner } from './scanner';

export interface DocumentHeader {
	/** `System`, `Emitter`, `Module` or `DynamicInput`. */
	kind: string;
	/** The `Name=` argument, e.g. `Samples/NS_Spark`. */
	name: string;
	/** The `Root=` argument as written, e.g. `Plugin.DreamFX`. Empty means Game. */
	root: string;
	/** `/DreamFX/Samples/NS_Spark`. */
	packagePath: string;
	/**
	 * `/DreamFX/Samples/NS_Spark.NS_Spark`.
	 *
	 * The doubled leaf is not redundancy: a soft object path addresses an object inside a package,
	 * and a package path alone resolves to the package rather than the asset in it.
	 */
	objectPath: string;
	/**
	 * Whether this kind of document produces an asset at all.
	 *
	 * A `.dfe` does not -- it is copied into whichever system references it (R3) -- so "open the
	 * asset" has nothing to open, and saying that is better than a failed load.
	 */
	producesAsset: boolean;
}

const DOCUMENT_KINDS = new Set(['System', 'Emitter', 'Module', 'DynamicInput']);

export function readDocumentHeader(text: string): DocumentHeader | undefined {
	const scanner = new Scanner(text);

	// Find the header: the first document keyword followed by '('. Comments and stray text before it
	// are skipped by the scanner itself, which is why this is not a regex -- a `//` line mentioning
	// `System(` would otherwise match.
	for (;;) {
		const token = scanner.peek();
		if (token.kind === 'end') {
			return undefined;
		}
		if (token.kind === 'identifier' && DOCUMENT_KINDS.has(token.text) && scanner.atSymbol('(', 1)) {
			break;
		}
		scanner.next();
	}

	const kind = scanner.next().text;
	scanner.next(); // '('

	// One token consumed per iteration, unconditionally, so the loop always progresses and the
	// separating commas need no case of their own. An earlier version consumed the key and then
	// consumed again on the non-match path, which ate the following argument's name -- `Root` went
	// missing whenever it was not first, and everything after it shifted by one.
	const values = new Map<string, string>();
	while (scanner.peek().kind !== 'end' && !scanner.atSymbol(')')) {
		const token = scanner.next();
		if (token.kind !== 'identifier' || !scanner.atSymbol('=')) {
			continue;
		}
		scanner.next(); // '='
		if (scanner.peek().kind === 'string') {
			values.set(token.text, scanner.next().text);
		}
	}

	const name = (values.get('Name') ?? '').replace(/^\/+/, '');
	if (!name) {
		return undefined;
	}

	const root = values.get('Root') ?? '';
	const mount = root === '' || root === 'Game' ? 'Game' : root.replace(/^Plugin\./, '');
	const packagePath = `/${mount}/${name}`;
	const leaf = name.slice(name.lastIndexOf('/') + 1);

	return {
		kind,
		name,
		root,
		packagePath,
		objectPath: `${packagePath}.${leaf}`,
		producesAsset: kind !== 'Emitter',
	};
}
