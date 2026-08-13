/**
 * The editor-agnostic half of the extension.
 *
 * Nothing in here imports `vscode`. That is the whole point: the language knowledge -- how a file
 * tokenises, what structure it has, what a new one should look like -- is the part that would
 * otherwise have to be written a second time for an LSP server or another IDE, which is exactly how
 * DreamShader ended up with two implementations of its language support.
 */

export * from './assetPath';
export * from './bridgeProtocol';
export * from './context';
export * from './diagnosticLine';
export * from './scanner';
export * from './schemaIndex';
export * from './structure';
export * from './templates';
export * from './workQueue';
