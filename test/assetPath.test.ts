import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readDocumentHeader } from '../src/core/assetPath';

test('a plugin root mounts under the plugin name', () => {
	// Checked against this project's own content: every Root="Plugin.DreamFX" source resolves to a
	// /DreamFX/... package that exists on disk.
	const header = readDocumentHeader('System(Name="Samples/NS_ToonHitSpark", Root="Plugin.DreamFX")\n{\n}\n');
	assert.equal(header?.kind, 'System');
	assert.equal(header?.packagePath, '/DreamFX/Samples/NS_ToonHitSpark');
	assert.equal(header?.objectPath, '/DreamFX/Samples/NS_ToonHitSpark.NS_ToonHitSpark');
	assert.equal(header?.producesAsset, true);
});

test('Game and a missing Root are the same thing', () => {
	assert.equal(readDocumentHeader('System(Name="FX/NS_A", Root="Game") {}')?.packagePath, '/Game/FX/NS_A');
	assert.equal(readDocumentHeader('System(Name="FX/NS_A") {}')?.packagePath, '/Game/FX/NS_A');
	assert.equal(readDocumentHeader('System(Name="FX/NS_A", Root="") {}')?.packagePath, '/Game/FX/NS_A');
});

test('the arguments are read by name, not by position', () => {
	// Root routinely comes first, or is left out entirely.
	const header = readDocumentHeader('Module(Root="Plugin.DreamFX", Name="Modules/Moon/ToonSpin") {}');
	assert.equal(header?.objectPath, '/DreamFX/Modules/Moon/ToonSpin.ToonSpin');
});

test('a .dfe names no asset of its own', () => {
	// It is copied into whichever system references it (R3), so "open the asset" has nothing to open.
	const header = readDocumentHeader('Emitter(Name="Emitters/E_Flash", Root="Plugin.DreamFX") {}');
	assert.equal(header?.producesAsset, false);
});

test('a header mentioned in a comment is not the header', () => {
	// The reason this walks tokens instead of matching a regex.
	const text = [
		'// Build it with System(Name="wrong") if you like.',
		'/* Emitter(Name="alsoWrong") */',
		'System(Name="Samples/NS_Right", Root="Plugin.DreamFX")',
		'{',
		'}',
	].join('\n');
	assert.equal(readDocumentHeader(text)?.packagePath, '/DreamFX/Samples/NS_Right');
});

test('a file with no header yields nothing rather than a guess', () => {
	assert.equal(readDocumentHeader('// just a comment\n'), undefined);
	assert.equal(readDocumentHeader('System(Root="Game") {}'), undefined);
	assert.equal(readDocumentHeader(''), undefined);
});

test('a leading slash in Name does not double up', () => {
	assert.equal(readDocumentHeader('System(Name="/FX/NS_A", Root="Game") {}')?.packagePath, '/Game/FX/NS_A');
});
