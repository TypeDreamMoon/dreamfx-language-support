import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Scanner } from '../src/core/scanner';
import { analyze } from '../src/core/structure';
import { TEMPLATE_CHOICES, TemplateKind, assetNameFromRelativePath, renderTemplate } from '../src/core/templates';

/** Pulls out a `Body = { ... }` exactly as the compiler does: as raw characters. */
function bodyOf(kind: TemplateKind): string {
	const scanner = new Scanner(renderTemplate({ kind, name: 'X', root: 'Game' }));
	for (;;) {
		const token = scanner.next();
		if (token.kind === 'end') {
			assert.fail(`${kind} has no Body block`);
		}
		if (token.kind === 'identifier' && token.text === 'Body') {
			scanner.tryConsumeSymbol('=');
			const block = scanner.readRawBlock();
			if (!block) {
				assert.fail(`${kind}'s Body block is unterminated`);
			}
			return block.text;
		}
	}
}

test('every template scans clean and declares the header it promised', () => {
	for (const choice of TEMPLATE_CHOICES) {
		const text = renderTemplate({ kind: choice.kind, name: `Samples/${choice.namePrefix}Fixture`, root: 'Game' });
		const model = analyze(text);

		assert.deepEqual(model.diagnostics, [], `${choice.label} does not scan clean`);
		assert.ok(model.root, `${choice.label} has no top-level object`);
		assert.equal(model.root!.name, `Samples/${choice.namePrefix}Fixture`);
		assert.ok(text.startsWith(`${choice.keyword}(`), `${choice.label} must open with ${choice.keyword}(`);
	}
});

test('the kind agrees with the extension it is written to (DFX2021)', () => {
	const byExtension: Record<string, string[]> = {};
	for (const choice of TEMPLATE_CHOICES) {
		(byExtension[choice.extension] ??= []).push(choice.keyword);
	}

	assert.deepEqual(byExtension['.dfs'], ['System']);
	assert.deepEqual(byExtension['.dfe'], ['Emitter']);
	assert.deepEqual(byExtension['.dfm'], ['Module', 'DynamicInput']);
});

test('a module template holds statements and a dynamic input template holds one expression', () => {
	// DFX3037: a dynamic input's body is wrapped as Output = (Type)( <body> ), so a statement before
	// the return produces invalid HLSL rather than an error naming the real problem.
	const module = renderTemplate({ kind: 'module', name: 'M', root: 'Game' });
	const dynamicInput = renderTemplate({ kind: 'dynamicInput', name: 'DI', root: 'Game' });

	assert.match(module, /Usage\s+= ParticleUpdate;/);
	assert.match(dynamicInput, /Usage\s+= DynamicInput;/);
	assert.match(dynamicInput, /Output\s+= float;/, 'a DynamicInput must declare Output (DFX3031)');
	assert.equal((dynamicInput.match(/return /g) ?? []).length, 1);
});

test('a DynamicInput body holds the expression and nothing else', () => {
	// Measured, not guessed: a `//` comment inside this body fails the build. The translator writes
	// the body into `Output = (Type)( <body> );`, and the comment swallows the closing paren -- which
	// surfaces as an empty DFX6006 ("Niagara could not compile the body of ...:" with nothing after
	// the colon), naming neither the line nor the reason. A Module body is emitted verbatim and is
	// not wrapped, so the same comment there is fine and is asserted to still be allowed.
	const body = bodyOf('dynamicInput');
	assert.ok(!body.includes('//'), `a comment in a DynamicInput body breaks the build:\n${body}`);
	assert.ok(!body.includes('/*'), `a comment in a DynamicInput body breaks the build:\n${body}`);
	assert.equal(body.split(';').filter((part) => part.trim().length > 0).length, 1,
		'one expression only (DFX3037)');

	assert.ok(bodyOf('module').includes('//'), 'a module body is emitted verbatim, so it may be commented');
});

test('a source path becomes the asset name the header wants', () => {
	assert.equal(assetNameFromRelativePath('Samples\\NS_Spark.dfs'), 'Samples/NS_Spark');
	assert.equal(assetNameFromRelativePath('/Emitters/E_Flash.dfe'), 'Emitters/E_Flash');
	assert.equal(assetNameFromRelativePath('Modules/M_Spin.DFM'), 'Modules/M_Spin');
});
