/**
 * Reading one line of `dfx` output.
 *
 * The same diagnostics reach VSCode two ways -- through the task system's problem matcher, and
 * through the verify runner, which spawns `dfx` itself and cannot use a matcher because a matcher
 * needs a task terminal. Two readers, therefore, and exactly one pattern: the string below is the
 * one contributed as `$dreamfx` in package.json, and a test asserts the two have not drifted.
 *
 * The pattern deliberately matches only the *structure* around a diagnostic. Message text is a mix
 * of English and Chinese -- the same DFX5021 exists in both -- so anything that read the message
 * would work until someone changed a sentence.
 */

export const DIAGNOSTIC_PATTERN =
	'^(?:.*?LogDreamFX:\\s*(?:Error|Warning|Display|Verbose|Log):\\s*)?(\\S[^()]*?)\\((\\d+),(\\d+)\\):\\s+(error|warning|info)\\s+(DFX\\d+):\\s+(.*)$';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface ParsedDiagnostic {
	/** As printed: absolute for a build, sometimes just a leaf name. Resolved by the caller. */
	file: string;
	/** One-based, as every DFXnnnn message is. */
	line: number;
	column: number;
	severity: DiagnosticSeverity;
	code: string;
	message: string;
}

const PATTERN = new RegExp(DIAGNOSTIC_PATTERN);

export function parseDiagnosticLine(line: string): ParsedDiagnostic | undefined {
	// The engine's ANSI colouring survives a raw pipe, unlike a task terminal where VSCode strips it.
	const match = PATTERN.exec(stripAnsi(line));
	if (!match) {
		return undefined;
	}

	return {
		file: match[1],
		line: Number.parseInt(match[2], 10),
		column: Number.parseInt(match[3], 10),
		severity: match[4] as DiagnosticSeverity,
		code: match[5],
		message: match[6].trimEnd(),
	};
}

// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI, '');
}

/**
 * Splits a chunk of process output into whole lines, keeping the unterminated tail for next time.
 *
 * A spawned process delivers bytes, not lines, and a diagnostic split across two chunks would
 * otherwise be two lines that each match nothing.
 */
export class LineSplitter {
	private pending = '';

	push(chunk: string): string[] {
		this.pending += chunk;
		const lines = this.pending.split(/\r?\n/);
		this.pending = lines.pop() ?? '';
		return lines;
	}

	/** Whatever is left when the stream ends. */
	flush(): string[] {
		const rest = this.pending;
		this.pending = '';
		return rest.length > 0 ? [rest] : [];
	}
}
