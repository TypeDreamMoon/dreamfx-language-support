/**
 * Messages between the curve editor webview and the extension that hosts it.
 *
 * The text is the only model. The webview never holds a curve the document does not: it draws what
 * the host last read out of the source, and every change it makes travels back as a complete key
 * list for the host to write *into* the source -- after which the host reads the source again and
 * sends that. So a panel can never disagree with the file for longer than one round trip, and an
 * edit made in the text while the panel is open simply arrives as the next state.
 *
 * Type-only imports, so neither bundle pulls in the other's code.
 */

import type { EditedCurveKey } from './core/curveLiteral';
import type { CurveKey } from './core/curveMath';

export interface CurveEditorState {
	type: 'state';
	/** Which literal this is. Changes when the panel is pointed at a different one. */
	target: number;
	/** The document version the keys were read from; an edit must name it to be applied. */
	version: number;
	/** `edit` when this state is the result of the webview's own edit. */
	cause: 'open' | 'edit' | 'external';
	editable: boolean;
	/** Why it is not editable, when it is not. */
	problems: string[];
	/** The input the literal fills, or `curve` when it is not written as `Name = curve { }`. */
	name: string;
	context: string[];
	fileName: string;
	/** One-based line of the `curve` keyword. */
	line: number;
	/** In source order: a key's index here is its `origin` in an edit. */
	keys: CurveKey[];
}

/** The text cursor moved onto these keys. */
export interface CurveEditorFocus {
	type: 'focus';
	target: number;
	origins: number[];
}

export type ToCurveEditor = CurveEditorState | CurveEditorFocus;

export type FromCurveEditor =
	| { type: 'ready' }
	| { type: 'edit'; target: number; version: number; keys: EditedCurveKey[] }
	| { type: 'select'; target: number; origins: number[] }
	| { type: 'undo' }
	| { type: 'redo' }
	| { type: 'reveal' };
