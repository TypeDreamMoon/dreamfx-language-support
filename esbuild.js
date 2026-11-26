/**
 * Three bundles: the extension the editor loads, the server it spawns, and the curve editor's page.
 *
 * Bundling rather than shipping `node_modules` is not a size micro-optimisation -- it is the
 * difference between a .vsix that stayed roughly the size it was and one that grew by the whole
 * language-server stack and its transitive tree. The sources were already compiled by `tsc` for the
 * tests; this exists because those two consumers want different output, not because the build
 * needed a second opinion about the types.
 *
 * `vscode` is external for the client because the editor injects it at load time and it exists on
 * no disk. It is deliberately *not* external for the server: the server must never import it, and a
 * failed resolve here is a louder way to find that out than a broken extension host.
 */

const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const shared = {
	bundle: true,
	format: 'cjs',
	platform: 'node',
	// VSCode 1.147 -- the engine floor in package.json, raised for node:sqlite -- ships Node 24.
	target: 'node22',
	sourcemap: !production,
	sourcesContent: false,
	minify: production,
	logLevel: 'info',
};

const builds = [
	// `node:sqlite` belongs to the host's runtime (the DreamSource databases are read with it) and is
	// required lazily, so a runtime without it falls back to the old JSON; bundling could not supply it.
	{ ...shared, entryPoints: ['src/extension.ts'], outfile: 'out/client.js', external: ['vscode', 'node:sqlite'] },
	{ ...shared, entryPoints: ['src/server/server.ts'], outfile: 'out/server.js', external: ['node:sqlite'] },
	// The curve editor's page runs in the webview, which is a browser: no Node, no `vscode` module,
	// one script loaded by a <script> tag. Electron's Chromium is far past ES2022.
	{ ...shared, entryPoints: ['src/webview/curveEditor.ts'], outfile: 'out/curveEditor.js', platform: 'browser', format: 'iife', target: 'es2022' },
];

async function main() {
	if (!watch) {
		await Promise.all(builds.map((options) => esbuild.build(options)));
		return;
	}

	const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
	await Promise.all(contexts.map((context) => context.watch()));
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
