/**
 * Two bundles: the extension the editor loads, and the server it spawns.
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
	// VSCode 1.85 -- the engine floor in package.json -- ships Node 18.
	target: 'node18',
	sourcemap: !production,
	sourcesContent: false,
	minify: production,
	logLevel: 'info',
};

const builds = [
	{ ...shared, entryPoints: ['src/extension.ts'], outfile: 'out/client.js', external: ['vscode'] },
	{ ...shared, entryPoints: ['src/server/server.ts'], outfile: 'out/server.js' },
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
