/**
 * The slice of `node:sqlite` this extension uses. The repository's @types/node predates the module,
 * and the module is loaded lazily anyway: a runtime without it reads the old JSON files.
 */
declare module 'node:sqlite' {
	interface DatabaseSyncOptions {
		open?: boolean;
		readOnly?: boolean;
		timeout?: number;
	}
	interface StatementSync {
		all(...parameters: unknown[]): unknown[];
		get(...parameters: unknown[]): unknown;
		run(...parameters: unknown[]): unknown;
	}
	class DatabaseSync {
		constructor(path: string, options?: DatabaseSyncOptions);
		exec(sql: string): void;
		prepare(sql: string): StatementSync;
		close(): void;
	}
}
