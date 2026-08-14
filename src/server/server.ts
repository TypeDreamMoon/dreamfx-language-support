/**
 * The DreamFXLang language server.
 *
 * Scope, deliberately: everything here is lexical or structural, or a reader of the index the
 * plugin's own CLI exports. No semantic knowledge is duplicated -- see the note at the top of
 * `diagnostics.ts` for why that boundary is where it is.
 *
 * What is *not* here is as deliberate. Builds, verifies, the editor bridge and the asset commands
 * all stay on the client: they are conversations with a running Unreal Editor or with a terminal,
 * and the protocol has nothing to say about either. This process owns the language and the index,
 * and nothing else.
 */

import {
	CompletionItem,
	DidChangeConfigurationNotification,
	DidChangeWatchedFilesNotification,
	DocumentSymbol,
	Hover,
	InitializeParams,
	InitializeResult,
	ProposedFeatures,
	TextDocumentSyncKind,
	TextDocuments,
	createConnection,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

import {
	ACTIVE_DOCUMENT_NOTIFICATION,
	ActiveDocumentParams,
	INDEX_DESTINATION_REQUEST,
	INDEX_STATE_NOTIFICATION,
	IndexDestinationParams,
	IndexStateParams,
	RELOAD_INDEX_NOTIFICATION,
} from '../lspProtocol';
import { AnalysisCache } from './analysisCache';
import { completionAt, hoverAt } from './completion';
import { syntaxDiagnostics } from './diagnostics';
import { SchemaIndexCache } from './schemaIndex';
import { documentSymbols } from './symbols';
import { INDEX_FILE_NAME, toFsPath } from './workspace';

const DEBOUNCE_MS = 250;

/**
 * '.' so `User.` offers nothing surprising, '(' and ',' so an argument list keeps offering input
 * names without a retrigger, '=' so a value position offers enum entries immediately.
 */
const TRIGGER_CHARACTERS = ['(', ',', '=', ' '];

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const analyses = new AnalysisCache();

const indexes = new SchemaIndexCache(
	(message) => connection.console.log(message),
	(state: IndexStateParams) => void connection.sendNotification(INDEX_STATE_NOTIFICATION, state));

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDidChangeWatchedFilesCapability = false;

/** `dreamfx.syntaxDiagnostics`, cached until the client says it changed. */
let syntaxDiagnosticsEnabled = true;

const debounceTimers = new Map<string, NodeJS.Timeout>();
/** URIs whose diagnostics have been published at least once; a first pass is not debounced. */
const published = new Set<string>();

connection.onInitialize((params: InitializeParams): InitializeResult => {
	const capabilities = params.capabilities;
	hasConfigurationCapability = Boolean(capabilities.workspace?.configuration);
	hasWorkspaceFolderCapability = Boolean(capabilities.workspace?.workspaceFolders);
	hasDidChangeWatchedFilesCapability = Boolean(capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration);

	indexes.setWorkspaceFolders(folderPaths(params));

	return {
		capabilities: {
			// Incremental sync is what `TextDocuments` implements, and the alternative -- shipping the
			// whole buffer on every keystroke -- is the one thing that would make an out-of-process
			// language server slower than the in-process providers it replaced.
			textDocumentSync: TextDocumentSyncKind.Incremental,
			completionProvider: { triggerCharacters: TRIGGER_CHARACTERS },
			hoverProvider: true,
			documentSymbolProvider: true,
			workspace: hasWorkspaceFolderCapability
				? { workspaceFolders: { supported: true, changeNotifications: true } }
				: undefined,
		},
	};
});

connection.onInitialized(() => {
	// Every registration below is caught rather than left floating. A client that refuses one is a
	// client that gets slightly staler results, not a reason to stop serving -- but an unhandled
	// rejection would take the whole server process down with it.
	if (hasConfigurationCapability) {
		connection.client.register(DidChangeConfigurationNotification.type, undefined)
			.catch((error: unknown) => connection.console.warn(`could not watch settings: ${String(error)}`));
		void refreshSettings();
	}

	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(async () => {
			const folders = await connection.workspace.getWorkspaceFolders();
			indexes.setWorkspaceFolders((folders ?? [])
				.map((folder) => toFsPath(folder.uri))
				.filter((value): value is string => value !== undefined));
		});
	}

	if (hasDidChangeWatchedFilesCapability) {
		// The index is written by an engine run, not by the editor, so a watcher is the only way to
		// notice it landing -- and it lands minutes after the command was issued.
		connection.client.register(DidChangeWatchedFilesNotification.type, {
			watchers: [{ globPattern: `**/DFX/${INDEX_FILE_NAME}` }],
		}).catch((error: unknown) => connection.console.warn(`could not watch the index: ${String(error)}`));
	}
});

connection.onDidChangeWatchedFiles(() => indexes.invalidateAll());

connection.onDidChangeConfiguration(() => {
	void refreshSettings().then(() => refreshAllDiagnostics());
});

// ------------------------------------------------------------- language features

connection.onCompletion((params): CompletionItem[] => {
	const document = documents.get(params.textDocument.uri);
	const index = document ? indexes.indexFor(toFsPath(document.uri)) : undefined;
	return document && index ? completionAt(index, document, params.position) : [];
});

connection.onHover((params): Hover | undefined => {
	const document = documents.get(params.textDocument.uri);
	const index = document ? indexes.indexFor(toFsPath(document.uri)) : undefined;
	return document && index ? hoverAt(index, document, params.position) : undefined;
});

connection.onDocumentSymbol((params): DocumentSymbol[] => {
	const document = documents.get(params.textDocument.uri);
	return document ? documentSymbols(document, analyses.get(document)) : [];
});

// ------------------------------------------------------------- custom messages

connection.onRequest(INDEX_DESTINATION_REQUEST, (params: IndexDestinationParams): string | null => {
	return indexes.destinationFor(params.activeUri ? toFsPath(params.activeUri) : undefined) ?? null;
});

connection.onNotification(RELOAD_INDEX_NOTIFICATION, () => indexes.invalidateAll());

connection.onNotification(ACTIVE_DOCUMENT_NOTIFICATION, (params: ActiveDocumentParams) => {
	const state = indexes.describe(params.uri ? toFsPath(params.uri) : undefined);
	void connection.sendNotification(INDEX_STATE_NOTIFICATION, state);
});

// ------------------------------------------------------------- diagnostics

documents.onDidChangeContent((event) => {
	schedule(event.document, published.has(event.document.uri) ? DEBOUNCE_MS : 0);
});

documents.onDidClose((event) => {
	const timer = debounceTimers.get(event.document.uri);
	if (timer) {
		clearTimeout(timer);
		debounceTimers.delete(event.document.uri);
	}
	published.delete(event.document.uri);
	analyses.forget(event.document.uri);
	void connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

function schedule(document: TextDocument, delay: number): void {
	const existing = debounceTimers.get(document.uri);
	if (existing) {
		clearTimeout(existing);
	}

	if (delay === 0) {
		debounceTimers.delete(document.uri);
		validate(document);
		return;
	}

	debounceTimers.set(document.uri, setTimeout(() => {
		debounceTimers.delete(document.uri);
		validate(document);
	}, delay));
}

function validate(document: TextDocument): void {
	published.add(document.uri);
	const diagnostics = syntaxDiagnosticsEnabled ? syntaxDiagnostics(document, analyses.get(document)) : [];
	void connection.sendDiagnostics({ uri: document.uri, diagnostics });
}

function refreshAllDiagnostics(): void {
	for (const document of documents.all()) {
		schedule(document, 0);
	}
}

async function refreshSettings(): Promise<void> {
	if (!hasConfigurationCapability) {
		return;
	}

	const settings = await connection.workspace.getConfiguration('dreamfx');
	syntaxDiagnosticsEnabled = settings?.syntaxDiagnostics !== false;
}

// ------------------------------------------------------------- boot

function folderPaths(params: InitializeParams): string[] {
	const folders = params.workspaceFolders ?? [];
	return folders
		.map((folder) => toFsPath(folder.uri))
		.filter((value): value is string => value !== undefined);
}

documents.listen(connection);
connection.listen();
