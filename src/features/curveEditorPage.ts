/**
 * The curve editor's page: markup and styles, with no editor types so the tests can read it.
 *
 * Everything that changes is filled in by `webview/curveEditor.ts`; the structure is here so the page
 * is laid out before the script has run, and so a test can check that every element the script
 * looks up by id, and every action a button names, exists on both sides.
 */

export interface CurveEditorPageOptions {
	/** `webview.cspSource`. */
	cspSource: string;
	nonce: string;
	/** The bundled script, already converted with `asWebviewUri`. */
	scriptUri: string;
}

export function curveEditorHtml(options: CurveEditorPageOptions): string {
	const { cspSource, nonce, scriptUri } = options;
	const csp = `default-src 'none'; img-src ${cspSource} data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Curve</title>
<style nonce="${nonce}">${CURVE_EDITOR_CSS}</style>
</head>
<body>
${CURVE_EDITOR_BODY}
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

export const CURVE_EDITOR_BODY = `
<header>
	<div class="title"><span id="name">curve</span><span id="where"></span></div>
	<button class="link" data-action="reveal" title="Show this curve in the source">Go to source</button>
</header>
<div id="toolbar" role="toolbar">
	<div class="group" title="Tangent mode of the selected keys">
		<button data-action="auto" title="Cubic, tangents re-derived from the neighbouring keys">Auto</button>
		<button data-action="user" title="Cubic, one tangent through the key">User</button>
		<button data-action="break" title="Cubic, separate arrive and leave tangents">Break</button>
	</div>
	<div class="group" title="Interpolation of the segment after each selected key">
		<button data-action="linear">Linear</button>
		<button data-action="constant">Constant</button>
	</div>
	<div class="group">
		<button data-action="flatten" title="Set the selected keys' tangents to zero">Flatten</button>
		<button data-action="straighten" title="Make the arrive and leave tangents one line">Straighten</button>
	</div>
	<div class="group">
		<button data-action="add" title="Add a key on the curve (or double-click the graph)">+ Key</button>
		<button data-action="delete" title="Delete the selected keys (Delete)">Delete</button>
	</div>
	<div class="group">
		<button data-action="frame" title="Fit the whole curve in view (F)">Frame</button>
		<select id="template" title="Replace the keys with a preset shape">
			<option value="">Templates…</option>
		</select>
	</div>
</div>
<div id="banner" hidden></div>
<div id="graph"><canvas id="canvas" tabindex="0" aria-label="Curve graph"></canvas><div id="readout"></div></div>
<footer>
	<label>Time <input id="time" type="text" spellcheck="false"></label>
	<label>Value <input id="value" type="text" spellcheck="false"></label>
	<label>Arrive <input id="arrive" type="text" spellcheck="false"></label>
	<label>Leave <input id="leave" type="text" spellcheck="false"></label>
	<span id="status"></span>
</footer>
`;

export const CURVE_EDITOR_CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
	margin: 0; padding: 8px 12px 10px;
	display: flex; flex-direction: column; gap: 6px;
	background: var(--vscode-editor-background);
	color: var(--vscode-foreground);
	font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
	overflow: hidden;
}
header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; min-width: 0; }
.title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#name { font-weight: 600; margin-right: 8px; }
#where { color: var(--vscode-descriptionForeground); }
button {
	font: inherit; color: var(--vscode-button-secondaryForeground);
	background: var(--vscode-button-secondaryBackground);
	border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px;
	padding: 2px 8px; cursor: pointer; white-space: nowrap;
}
button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
button:disabled { opacity: 0.45; cursor: default; }
button.active { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
button:focus-visible, select:focus-visible, input:focus-visible, canvas:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
button.link { background: none; border: none; color: var(--vscode-textLink-foreground); padding: 0; }
button.link:hover { text-decoration: underline; background: none; }
#toolbar { display: flex; flex-wrap: wrap; gap: 6px 12px; }
.group { display: flex; gap: 2px; }
select, input {
	font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background);
	border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent)); border-radius: 2px;
}
select { padding: 1px 4px; }
#banner {
	padding: 6px 8px; border-radius: 2px; white-space: pre-line;
	background: var(--vscode-inputValidation-warningBackground);
	border: 1px solid var(--vscode-inputValidation-warningBorder);
}
#graph { position: relative; flex: 1 1 auto; min-height: 160px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; outline: none; touch-action: none; }
#readout {
	position: absolute; right: 8px; top: 6px; pointer-events: none;
	font-family: var(--vscode-editor-font-family); font-size: 11px; color: var(--vscode-descriptionForeground);
}
footer { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
footer label { display: flex; align-items: center; gap: 4px; color: var(--vscode-descriptionForeground); }
footer input { width: 84px; padding: 2px 4px; font-family: var(--vscode-editor-font-family); }
footer input:disabled { opacity: 0.5; }
#status { margin-left: auto; color: var(--vscode-descriptionForeground); }
`;
