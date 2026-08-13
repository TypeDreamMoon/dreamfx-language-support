/**
 * The project's module index: what `dfx index` exports, and how to ask it things.
 *
 * Why a file and not a query: every `dfx` invocation boots the Unreal Editor, which is tens of
 * seconds. Nothing that runs while someone is typing may do that, so the index is produced once, in
 * one boot, and read from disk thereafter.
 *
 * Why it is exported at all, rather than baked into this extension: DreamFX resolves modules from
 * the asset registry at runtime. Enable NiagaraFluids and a family of modules appears; open a
 * different project and the whole set changes; a module can carry versions. A table written into
 * this package would be wrong on the first day and wrong differently on every day after.
 */

export interface IndexedInput {
	name: string;
	type: string;
	/** A compile-time constant. Source order is write order, so it must precede whatever it gates. */
	staticSwitch?: boolean;
	/** Whether this input accepts an `hlsl { }` block or an inline expression. */
	expressions?: boolean;
	category?: string;
	description?: string;
	/** Entries spelled the way a source file writes them. Absent when the type is not an enum. */
	enum?: string[];
}

export interface IndexedModule {
	name: string;
	path: string;
	kind: 'module' | 'dynamicInput';
	/** The stacks the module declares it belongs in, from its usage bitmask. */
	stacks: string[];
	category?: string;
	description?: string;
	/** Which stack the signature below was read in. Absent for a dynamic input. */
	probedIn?: string;
	inputs?: IndexedInput[];
	/** Set instead of `inputs` when the probe could not run, with the reason. */
	inputsUnavailable?: string;
}

export interface SchemaIndex {
	version: number;
	generatedUtc: string;
	project?: string;
	/** Part of the fingerprint: a different engine is a different module set. */
	engine?: string;
	/** Part of the fingerprint: enabling a content plugin adds a family of modules. */
	plugins?: string[];
	searchPaths?: string[];
	/**
	 * Whether the signatures were probed at all.
	 *
	 * False for an index the editor bridge produced: probing walks the module graphs, and one piece of
	 * engine content recurses without bound until the process dies of a stack overflow -- survivable
	 * for a supervised CLI run, fatal for somebody's editor. Absent on an index written before this
	 * existed, which was always a probed one, so undefined reads as true.
	 *
	 * It matters because "no inputs" and "not looked at" are the same shape in the file otherwise, and
	 * offering an empty argument list as if it were the answer is worse than saying nothing.
	 */
	inputsProbed?: boolean;
	modules: IndexedModule[];
}

/** The version this extension knows how to read. A newer file is refused rather than half-understood. */
export const SUPPORTED_INDEX_VERSION = 1;

export class ModuleIndex {
	private readonly byLowerName = new Map<string, IndexedModule[]>();

	constructor(readonly source: SchemaIndex) {
		for (const module of source.modules) {
			const key = module.name.toLowerCase();
			const bucket = this.byLowerName.get(key);
			if (bucket) {
				bucket.push(module);
			} else {
				this.byLowerName.set(key, [module]);
			}
		}
	}

	get modules(): readonly IndexedModule[] {
		return this.source.modules;
	}

	/**
	 * Whether this index can answer "what inputs does this module take?".
	 *
	 * Module-name completion works either way -- that comes from the stack lists, which cost nothing
	 * to collect. Argument-name completion does not, and the difference has to be visible rather than
	 * presenting as a module that happens to take no inputs.
	 */
	get hasSignatures(): boolean {
		return this.source.inputsProbed !== false;
	}

	/**
	 * Every module a written name could mean.
	 *
	 * Plural because a short name matching more than one asset is a real state the compiler reports
	 * rather than resolves (it would otherwise depend on asset registry ordering), and an editor that
	 * silently picked one would be describing a different module than the build uses.
	 */
	resolve(written: string): IndexedModule[] {
		const bare = lastPathSegment(written);
		const exact = this.byLowerName.get(bare.toLowerCase()) ?? [];

		if (written === bare) {
			return exact;
		}
		// A partial path such as `Update/Forces/GravityForce` selects among the same-named assets.
		const suffix = `/${written.replace(/^\/+/, '').toLowerCase()}`;
		const narrowed = exact.filter((module) => module.path.toLowerCase().endsWith(suffix));
		return narrowed.length > 0 ? narrowed : exact;
	}

	/** The one module a name means, or undefined when it is unknown or ambiguous. */
	resolveUnique(written: string): IndexedModule | undefined {
		const matches = this.resolve(written);
		return matches.length === 1 ? matches[0] : undefined;
	}

	/**
	 * The modules offerable in a stack.
	 *
	 * A module with no declared stacks is offered everywhere rather than nowhere: an empty list means
	 * the export could not read the bitmask, and hiding a module because the *index* is thin would be
	 * an editor inventing a restriction the compiler does not have.
	 */
	forStack(stack: string | undefined, kind: 'module' | 'dynamicInput'): IndexedModule[] {
		return this.source.modules.filter((module) => {
			if (module.kind !== kind) {
				return false;
			}
			if (!stack || module.stacks.length === 0) {
				return true;
			}
			return module.stacks.includes(stack);
		});
	}

	/** An input of a module, by the identifier a source file writes. */
	findInput(module: IndexedModule, written: string): IndexedInput | undefined {
		const wanted = normalizeInputIdentifier(written);
		return module.inputs?.find((input) => normalizeInputIdentifier(input.name) === wanted);
	}
}

/**
 * The compiler's own input-name normalisation: lowercase, spaces and underscores removed.
 *
 * Niagara input names contain spaces (`Loop Duration`), which no DSL identifier can. Both sides are
 * normalised so an author writes `LoopDuration` and still addresses the real input -- so an editor
 * comparing names any other way would disagree with the build about which input was meant.
 */
export function normalizeInputIdentifier(name: string): string {
	return name.replace(/[\s_]/g, '').toLowerCase();
}

function lastPathSegment(written: string): string {
	const index = written.lastIndexOf('/');
	return index === -1 ? written : written.slice(index + 1);
}

/** Parses and version-checks an exported index. Returns a reason string when it cannot be used. */
export function parseSchemaIndex(text: string): { index: ModuleIndex } | { error: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { error: `the index file is not valid JSON (${String(error)})` };
	}

	const candidate = parsed as Partial<SchemaIndex>;
	if (typeof candidate?.version !== 'number') {
		return { error: 'the index file has no version' };
	}
	if (candidate.version > SUPPORTED_INDEX_VERSION) {
		return {
			error: `the index was written by a newer plugin (version ${candidate.version}, this extension reads ${SUPPORTED_INDEX_VERSION})`,
		};
	}
	if (!Array.isArray(candidate.modules)) {
		return { error: 'the index file has no modules array' };
	}

	return { index: new ModuleIndex(candidate as SchemaIndex) };
}
