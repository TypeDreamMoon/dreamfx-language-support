/**
 * Completion and hover, from the exported index.
 *
 * The one rule that shapes all of it: **this offers, the build decides.** The index is a snapshot,
 * it can be stale, and a module the compiler resolves through search paths may not be in it. So
 * nothing here filters aggressively, nothing reports an error, and a module with no recorded stacks
 * is offered everywhere rather than nowhere. An editor that hid a valid module because its own cache
 * was thin would be lying about the language.
 */

import {
	CompletionItem,
	CompletionItemKind,
	Hover,
	InsertTextFormat,
	MarkupContent,
	MarkupKind,
	Position,
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { EditContext, IndexedInput, IndexedModule, ModuleIndex, contextAt, targetAt } from '../core';

/** The five parameter namespaces a value position accepts. */
const NAMESPACES = ['User', 'Particles', 'Emitter', 'System', 'Engine'];

export function completionAt(index: ModuleIndex, document: TextDocument, position: Position): CompletionItem[] {
	const context = contextAt(document.getText(), document.offsetAt(position));
	switch (context.kind) {
		case 'stackStatement':
			return completeModules(index, context);
		case 'argumentName':
			return completeInputNames(index, context);
		case 'argumentValue':
			return completeValues(index, context);
		default:
			return [];
	}
}

function completeModules(index: ModuleIndex, context: EditContext & { kind: 'stackStatement' }): CompletionItem[] {
	return index.forStack(context.stack, 'module').map((module) => ({
		label: module.name,
		kind: CompletionItemKind.Function,
		detail: module.category || module.path,
		documentation: describeModule(module),
		// The cursor lands between the parens, which is where the next thing to write goes.
		insertText: `${module.name}($0);`,
		insertTextFormat: InsertTextFormat.Snippet,
	}));
}

function completeInputNames(index: ModuleIndex, context: EditContext & { kind: 'argumentName' }): CompletionItem[] {
	const module = index.resolveUnique(context.module);

	// An index built by the editor bridge carries no signatures, because probing them can crash
	// the editor. Saying so beats an empty list: silence here is indistinguishable from "this
	// module takes no inputs", and the author would go looking for the wrong problem.
	if (!index.hasSignatures) {
		return [{
			// VSCode's `Issue` kind has no LSP counterpart -- the protocol's enum stops at
			// TypeParameter -- so this settles for the neutral one rather than borrowing an icon
			// that would claim the notice is a language construct.
			label: 'Input names need a full index',
			kind: CompletionItemKind.Text,
			detail: 'run DreamFXLang: Rebuild Module Index',
			documentation: markdown(
				'This index was written by the running Unreal Editor, which lists modules but does not probe their input signatures — probing can crash the editor, so it is a `dfx index` job.\n\nRun **DreamFXLang: Rebuild Module Index** to get argument completion back.'),
			// A bare `''` would be dropped by the client's falsy check and the *label* inserted
			// instead, which is the one outcome this notice must not have. An empty snippet says the
			// same thing in a form that survives the wire.
			insertText: '$0',
			insertTextFormat: InsertTextFormat.Snippet,
			sortText: '￿',
		}];
	}

	if (!module?.inputs) {
		return [];
	}

	const written = new Set(context.alreadyWritten.map((name) => name.toLowerCase()));

	return module.inputs
		.filter((input) => !written.has(input.name.replace(/\s/g, '').toLowerCase()))
		.map((input) => ({
			label: displayName(input),
			kind: CompletionItemKind.Property,
			// Static switches sort first because on a module source order *is* write order: an
			// input that only exists once a switch is set has to be written after it, so offering
			// the switches first is offering them in the order they have to be written.
			detail: input.staticSwitch ? `${input.type} · static switch` : input.type,
			documentation: describeInput(input),
			insertText: `${displayName(input)} = $0`,
			insertTextFormat: InsertTextFormat.Snippet,
			sortText: input.staticSwitch ? `0${input.name}` : `1${input.name}`,
		}));
}

function completeValues(index: ModuleIndex, context: EditContext & { kind: 'argumentValue' }): CompletionItem[] {
	const items: CompletionItem[] = [];
	const module = index.resolveUnique(context.module);
	const input = module ? index.findInput(module, context.input) : undefined;

	for (const entry of input?.enum ?? []) {
		items.push({
			label: entry,
			kind: CompletionItemKind.EnumMember,
			detail: input?.type,
			sortText: `0${entry}`,
		});
	}

	for (const namespace of NAMESPACES) {
		items.push({
			label: `${namespace}.`,
			kind: CompletionItemKind.Module,
			detail: 'parameter namespace',
			sortText: `1${namespace}`,
			// A link binds the parameter directly, with no conversion step anywhere in it.
			documentation: markdown(
				'A linked parameter. The two types have to match exactly — a link has no conversion step, which is the one case an explicit cast cannot fix (DFX4027).'),
		});
	}

	// A value may also be a dynamic input, nested to any depth.
	for (const dynamicInput of index.forStack(context.stack, 'dynamicInput')) {
		items.push({
			label: dynamicInput.name,
			kind: CompletionItemKind.Function,
			detail: dynamicInput.category || 'dynamic input',
			documentation: describeModule(dynamicInput),
			insertText: `${dynamicInput.name}($0)`,
			insertTextFormat: InsertTextFormat.Snippet,
			sortText: `2${dynamicInput.name}`,
		});
	}

	return items;
}

export function hoverAt(index: ModuleIndex, document: TextDocument, position: Position): Hover | undefined {
	const target = targetAt(document.getText(), document.offsetAt(position));
	if (!target) {
		return undefined;
	}

	if (target.kind === 'module') {
		const matches = index.resolve(target.name);
		if (matches.length === 0) {
			return undefined;
		}
		if (matches.length > 1) {
			// The compiler refuses an ambiguous short name rather than picking one, because
			// picking would make the build depend on asset registry ordering. Say the same thing.
			return {
				contents: markdown(
					`**${target.name}** matches ${matches.length} assets:\n\n`
					+ matches.map((module) => `- \`${module.path}\``).join('\n')
					+ '\n\nWrite a longer path to choose one (DFX3002).'),
			};
		}
		return { contents: describeModule(matches[0], /*full=*/true) };
	}

	const module = index.resolveUnique(target.module);
	const input = module ? index.findInput(module, target.name) : undefined;
	return input ? { contents: describeInput(input, /*full=*/true) } : undefined;
}

// ---------------------------------------------------------------- rendering

function markdown(value: string): MarkupContent {
	return { kind: MarkupKind.Markdown, value };
}

function displayName(input: IndexedInput): string {
	return input.name;
}

function describeModule(module: IndexedModule, full = false): MarkupContent {
	const lines: string[] = [];

	if (full) {
		lines.push(`**${module.name}** — ${module.kind === 'dynamicInput' ? 'dynamic input' : 'module'}`);
	}
	if (module.description) {
		lines.push(module.description);
	}
	if (module.stacks.length > 0) {
		lines.push(`_Stacks:_ ${module.stacks.join(', ')}`);
	}
	if (module.inputs) {
		lines.push(`_${module.inputs.length} input${module.inputs.length === 1 ? '' : 's'}_`);
		if (full && module.inputs.length > 0) {
			lines.push(['```', ...module.inputs.map(renderSignatureLine), '```'].join('\n'));
		}
	} else if (module.inputsUnavailable) {
		// Not the same as "no inputs", and presenting it as such would be an editor inventing a fact.
		lines.push(`_Inputs unavailable:_ ${module.inputsUnavailable}`);
	}
	if (full) {
		lines.push(`\`${module.path}\``);
	}

	return markdown(lines.join('\n\n'));
}

function renderSignatureLine(input: IndexedInput): string {
	const flags = [input.staticSwitch ? 'static switch' : '', input.expressions ? 'hlsl ok' : '']
		.filter(Boolean)
		.join(', ');
	return `${input.name.padEnd(32)} ${input.type}${flags ? `   [${flags}]` : ''}`;
}

function describeInput(input: IndexedInput, full = false): MarkupContent {
	const lines: string[] = [];

	if (full) {
		lines.push(`**${input.name}** — \`${input.type}\``);
	}
	if (input.description) {
		lines.push(input.description);
	}
	if (input.staticSwitch) {
		lines.push('_A static switch: a compile-time constant that gates other inputs. On a module, source order is write order, so it has to be written **before** whatever it gates._');
	}
	if (input.enum && input.enum.length > 0) {
		lines.push(`_Values:_ ${input.enum.map((entry) => `\`${entry}\``).join(', ')}`);
	}
	if (input.expressions) {
		lines.push('_Accepts an inline expression or an `hlsl { }` block._');
	}

	return markdown(lines.join('\n\n'));
}
