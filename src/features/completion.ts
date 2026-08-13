/**
 * Completion and hover, from the exported index.
 *
 * The one rule that shapes all of it: **this offers, the build decides.** The index is a snapshot,
 * it can be stale, and a module the compiler resolves through search paths may not be in it. So
 * nothing here filters aggressively, nothing reports an error, and a module with no recorded stacks
 * is offered everywhere rather than nowhere. An editor that hid a valid module because its own cache
 * was thin would be lying about the language.
 */

import * as vscode from 'vscode';

import { EditContext, IndexedInput, IndexedModule, ModuleIndex, contextAt, targetAt } from '../core';
import { SchemaIndexCache } from './indexCache';

/** The five parameter namespaces a value position accepts. */
const NAMESPACES = ['User', 'Particles', 'Emitter', 'System', 'Engine'];

export class DreamFXCompletionProvider implements vscode.CompletionItemProvider {
	constructor(private readonly cache: SchemaIndexCache) {}

	provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
	): vscode.CompletionItem[] {
		const index = this.cache.index;
		if (!index) {
			return [];
		}

		const context = contextAt(document.getText(), document.offsetAt(position));
		switch (context.kind) {
			case 'stackStatement':
				return this.completeModules(index, context);
			case 'argumentName':
				return this.completeInputNames(index, context);
			case 'argumentValue':
				return this.completeValues(index, context);
			default:
				return [];
		}
	}

	private completeModules(index: ModuleIndex, context: EditContext & { kind: 'stackStatement' }): vscode.CompletionItem[] {
		return index.forStack(context.stack, 'module').map((module) => {
			const item = new vscode.CompletionItem(module.name, vscode.CompletionItemKind.Function);
			item.detail = module.category || module.path;
			item.documentation = describeModule(module);
			// The cursor lands between the parens, which is where the next thing to write goes.
			item.insertText = new vscode.SnippetString(`${module.name}($0);`);
			return item;
		});
	}

	private completeInputNames(index: ModuleIndex, context: EditContext & { kind: 'argumentName' }): vscode.CompletionItem[] {
		const module = index.resolveUnique(context.module);

		// An index built by the editor bridge carries no signatures, because probing them can crash
		// the editor. Saying so beats an empty list: silence here is indistinguishable from "this
		// module takes no inputs", and the author would go looking for the wrong problem.
		if (!index.hasSignatures) {
			const hint = new vscode.CompletionItem(
				'Input names need a full index', vscode.CompletionItemKind.Issue);
			hint.detail = 'run DreamFXLang: Rebuild Module Index';
			hint.documentation = new vscode.MarkdownString(
				'This index was written by the running Unreal Editor, which lists modules but does not probe their input signatures — probing can crash the editor, so it is a `dfx index` job.\n\nRun **DreamFXLang: Rebuild Module Index** to get argument completion back.');
			hint.insertText = '';
			hint.sortText = '￿';
			return [hint];
		}

		if (!module?.inputs) {
			return [];
		}

		const written = new Set(context.alreadyWritten.map((name) => name.toLowerCase()));

		return module.inputs
			.filter((input) => !written.has(input.name.replace(/\s/g, '').toLowerCase()))
			.map((input) => {
				const item = new vscode.CompletionItem(
					displayName(input), vscode.CompletionItemKind.Property);
				item.detail = input.type;
				item.documentation = describeInput(input);
				item.insertText = new vscode.SnippetString(`${displayName(input)} = $0`);

				// Static switches sort first because on a module source order *is* write order: an
				// input that only exists once a switch is set has to be written after it, so offering
				// the switches first is offering them in the order they have to be written.
				item.sortText = input.staticSwitch ? `0${input.name}` : `1${input.name}`;
				if (input.staticSwitch) {
					item.detail = `${input.type} · static switch`;
				}
				return item;
			});
	}

	private completeValues(index: ModuleIndex, context: EditContext & { kind: 'argumentValue' }): vscode.CompletionItem[] {
		const items: vscode.CompletionItem[] = [];
		const module = index.resolveUnique(context.module);
		const input = module ? index.findInput(module, context.input) : undefined;

		for (const entry of input?.enum ?? []) {
			const item = new vscode.CompletionItem(entry, vscode.CompletionItemKind.EnumMember);
			item.detail = input?.type;
			item.sortText = `0${entry}`;
			items.push(item);
		}

		for (const namespace of NAMESPACES) {
			const item = new vscode.CompletionItem(`${namespace}.`, vscode.CompletionItemKind.Module);
			item.detail = 'parameter namespace';
			item.sortText = `1${namespace}`;
			// A link binds the parameter directly, with no conversion step anywhere in it.
			item.documentation = new vscode.MarkdownString(
				'A linked parameter. The two types have to match exactly — a link has no conversion step, which is the one case an explicit cast cannot fix (DFX4027).');
			items.push(item);
		}

		// A value may also be a dynamic input, nested to any depth.
		for (const dynamicInput of index.forStack(context.stack, 'dynamicInput')) {
			const item = new vscode.CompletionItem(dynamicInput.name, vscode.CompletionItemKind.Function);
			item.detail = dynamicInput.category || 'dynamic input';
			item.documentation = describeModule(dynamicInput);
			item.insertText = new vscode.SnippetString(`${dynamicInput.name}($0)`);
			item.sortText = `2${dynamicInput.name}`;
			items.push(item);
		}

		return items;
	}
}

export class DreamFXHoverProvider implements vscode.HoverProvider {
	constructor(private readonly cache: SchemaIndexCache) {}

	provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
		const index = this.cache.index;
		if (!index) {
			return undefined;
		}

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
				const text = new vscode.MarkdownString(
					`**${target.name}** matches ${matches.length} assets:\n\n`
					+ matches.map((module) => `- \`${module.path}\``).join('\n')
					+ '\n\nWrite a longer path to choose one (DFX3002).');
				return new vscode.Hover(text);
			}
			return new vscode.Hover(describeModule(matches[0], /*full=*/true));
		}

		const module = index.resolveUnique(target.module);
		const input = module ? index.findInput(module, target.name) : undefined;
		return input ? new vscode.Hover(describeInput(input, /*full=*/true)) : undefined;
	}
}

// ---------------------------------------------------------------- rendering

function displayName(input: IndexedInput): string {
	return input.name;
}

function describeModule(module: IndexedModule, full = false): vscode.MarkdownString {
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

	return new vscode.MarkdownString(lines.join('\n\n'));
}

function renderSignatureLine(input: IndexedInput): string {
	const flags = [input.staticSwitch ? 'static switch' : '', input.expressions ? 'hlsl ok' : '']
		.filter(Boolean)
		.join(', ');
	return `${input.name.padEnd(32)} ${input.type}${flags ? `   [${flags}]` : ''}`;
}

function describeInput(input: IndexedInput, full = false): vscode.MarkdownString {
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

	return new vscode.MarkdownString(lines.join('\n\n'));
}
