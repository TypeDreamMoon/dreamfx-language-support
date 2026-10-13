# DreamFXLang Language Support

[![version](https://img.shields.io/github/package-json/v/TypeDreamMoon/dreamfx-language-support?color=blue)](CHANGELOG.md)
[![vscode](https://img.shields.io/badge/VS%20Code-%5E1.85-007ACC)](https://code.visualstudio.com/)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Editor support for [DreamFX](https://github.com/TypeDreamMoon/DreamFX) — the text language that
builds Unreal Niagara systems from `.dfs`, `.dfe` and `.dfm` sources.

English | [简体中文](README.zh-CN.md)

---

## What it does

| | |
| --- | --- |
| **Highlighting** | Full TextMate grammar for `.dfs` / `.dfe` / `.dfm`, with `hlsl { }` and a module's `Body = { }` handed to the HLSL grammar |
| **Outline** | Document → emitters → stacks, sections, renderers → module calls and declarations, in the Outline view, breadcrumbs and `Ctrl+Shift+O` |
| **Folding** | Braces, plus `#Region` / `#EndRegion` |
| **Live syntax errors** | Unterminated string, block comment, back-quoted name or raw block, an unexpected character, an unclosed block — reported with the compiler's own DFX1xxx codes, linked to its docs |
| **Completion** | Module names filtered by the stack you are in, then that module's **real input names**, then its enum entries — all from the project's actual module set, not a baked-in table |
| **Hover** | A module's description, stacks and full signature; an input's type, enum entries and whether it takes an expression |
| **Curve editor** | An **Edit curve** lens on every `curve { }`: drag keys and tangents in a graph beside the text, and the source is rewritten as you go. See [below](#the-curve-editor) |
| **Snippets** | 26 skeletons: documents, stacks, `OnEvent`, `Stage`, renderers, `curve { }`, `hlsl { }`, `Bind`, `disabled`, `as`, `@version`, `#Region` |
| **New file** | `DreamFXLang: New Source File` — pick a kind, name the asset, get a file that builds |
| **Tasks and Problems** | `verify` / `lint` / `build`, as commands or tasks, with every `DFXnnnn` landing in the Problems panel as a clickable entry |
| **Verify on save** | Opt-in (`dreamfx.verifyOnSave`): saving a source runs `verify` and puts the result in Problems, one engine at a time |
| **Editor bridge** | With the Unreal Editor open, `verify` and `build` are handed to it instead of booting a second engine — **half a second instead of thirteen**. Plus open the asset a file builds, re-export it, or adopt it. See [below](#the-editor-bridge) |
| **Pull from the asset** | Tweak a value in the Niagara editor, then **Pull Values from Asset** writes it back into the `.dfs` — as a few small edits you review in a diff first, comments and layout untouched. See [below](#pull-values-from-the-asset) |

## What it deliberately does not do

**It never decides whether your source is valid.** The compiler does that, in C++, with 143
diagnostic codes that carry a line and a column. Re-deriving any of that in TypeScript would create
a second source of truth on the same question, and two sources of truth drift. The way that drift
shows up is *"the editor says it is fine and the build says it is not"* — worse than no editor
feedback at all.

So the extension reports only what is certain from the characters — the compiler's own `DFX1xxx`
lexical family, ported from its own lexer — and everything else arrives from `dfx` through the
problem matcher, wearing the same codes it would in a terminal.

Measured, not asserted: across the 40 files of the compiler's negative corpus — every one of which
fails to build — this extension reports exactly zero problems, because all 40 fail *semantically*.
Across 73 real sources, including decompiled mirrors of third-party content, it reports zero as
well, and recognises the structure of every one.

## The module index

Completion and hover read `DFX/.dfx-index.json`, which the plugin exports:

```bash
pwsh -File .skill/dfx.ps1 index
```

or **`DreamFXLang: Rebuild Module Index`** from the command palette. On this project that is 571
modules in about 8 seconds of work behind a ~13-second engine boot, and it is a command rather than
something automatic because nothing triggered by typing may cost that.

Why a file and not a baked-in table: DreamFX resolves modules from the asset registry at runtime.
Enable NiagaraFluids and a family of modules appears; open a different project and the whole set
changes. A table written into this extension would be wrong on the first day.

The index records the engine path and the enabled plugin list, because those are what invalidate it.
Nothing compares them yet — that needs a live editor to compare against — so the status bar shows
when the index was generated and rebuilding is one click.

## The curve editor

Every `curve { }` literal gets an **Edit curve** lens. It opens a graph beside the text, after
Unreal's own curve editor: drag keys, drag tangent handles, box-select, double-click to add a key,
`Delete` to remove one, switch keys between Auto / User / Break / Linear / Constant, flatten or
straighten tangents, or start over from a template. Right- or middle-drag pans, the wheel zooms
(`Shift` for time only, `Alt` for value only), `F` frames the whole curve. The same editor is on the
context menu and in the palette as **Edit Curve Under Cursor**, and moving the cursor into another
literal points the open editor at it.

**The text stays the only model.** Every change is written into the source as an ordinary edit —
one undo step in the file's own history, `Ctrl+Z` in the panel included — and the panel redraws from
what the file then says. Typing in the text while the panel is open simply redraws it.

**Edits are minimal.** Only the keys whose numbers changed are rewritten; a removed key takes its
line and its trailing comment, a new key goes on its own line between its neighbours, and an inline
`curve { 0.0 -> 1.0; 1.0 -> 0.0; }` stays inline. Numbers are spelled exactly as the exporter spells
them (`FormatFloatLossless`), attributes in the order it writes them, and an attribute you wrote is
kept in your spelling.

**What it draws is what the build makes.** The curve is evaluated with `FRichCurve`'s own rules —
interpolation from the left key, the one-third Bézier, held values outside the keys — and from the
**stored** tangents. That matters for one case: a key written without `Arrive`/`Leave` stores a zero
slope and is built with it, so the editor draws it flat rather than pretending the engine will smooth
it. When you *edit* near an `Auto` key, the editor re-derives its slope the way Unreal's editor does
and writes it into the source (`Tangent=Auto; Arrive=…`) — but only for the keys the edit touched
and their neighbours, so a key nobody went near keeps exactly the slope it was built with.

**It refuses rather than guesses.** A literal the compiler would reject — an unknown interpolation
(DFX4039) or tangent mode (DFX4042), an unknown attribute (DFX2020), a tangent that is not a plain
number — is shown read-only with the reason, and never rewritten.

Checked against real sources: the 748 curve literals (1,889 keys) in a project's decompiled content
all read, re-spell to the same keys, and produce no edit when opened and left alone.

## Pull values from the asset

The text builds the asset, but nothing stops you tuning the asset in the Niagara editor and then
wanting those numbers back in the text. **DreamFXLang: Pull Values from Asset (needs the editor)** (palette, the editor
title bar, and the explorer's context menu on a `.dfs`) reads what the asset stores and writes
the differences into the file.

1. It sends the editor your **buffer** — saved or not — and gets back what the text would be with
   the asset's values spliced in.
2. If nothing differs you get a one-line summary: what was compared, and everything it saw but left
   alone (below).
3. Otherwise a **diff opens** — your text against the pulled text — and a prompt offers
   **Apply N edits** or **Cancel**. Nothing has been written, and the editor has not recorded
   anything, until you answer.
4. **Apply** edits the buffer. It is one undo step; `Ctrl+Z` takes the whole pull back.

**The text stays the only model, and the edits are minimal.** The new text is reduced to the
smallest edits that produce it — changed lines are paired, then the shared start and end of each
line are cut away — so a changed value is an edit of just the value. The comment after it, the
alignment, and every untouched line (CRLF files included) are never replaced.

**It does not save.** Saving a source builds it in the editor, and that build would regenerate the
asset from the text — which is the thing a pull exists to avoid. Review the edits, then save when
you mean to.

**What it leaves alone is reported, not hidden.** The diagnostics land in Problems with their
file and line: `DFX7106` the asset stores a value the text does not declare, `DFX7109` a stack
that cannot be addressed, `DFX7111` a value that cannot be written as a literal, `DFX7115` the
text is newer than the asset (so the asset's old value does not overwrite your newer one),
`DFX7116` what would change, and `DFX7114` whether a baseline was used. The editor remembers what
the asset held at the last pull, so a second pull only writes what moved since; a preview never
moves that memory — only **Apply** does.

**Structure is opt-in.** With `dreamfx.pull.structuralEdits` off (the default) only literal
values are written; stacks, modules or lines that exist on one side only are counted and reported
(`DFX7113`) but not applied. Turn it on to have them added or removed too (`DFX7112`) — the diff
shows exactly which lines.

**It needs the running editor**, because only the editor can read the asset and only the bridge can
carry your unsaved buffer to it. With no editor, a file with no unsaved changes can fall back to
`dfx pull -Apply` on the command line, which boots the engine and writes the file on disk. An editor
running an older plugin answers that it does not know how to pull; update the plugin.

## Verify on save

Turn on `dreamfx.verifyOnSave` and saving a source runs `dfx verify` against it, putting the result
straight into Problems — no terminal, no task panel. It reads only; no packages are written. Saving
the same file repeatedly queues it once, and a save arriving while a check is running joins the same
queue rather than starting a second engine.

**Off by default, because what it costs depends on whether the editor is open.** Through the CLI a
single file takes about **13 seconds**, essentially all of it engine boot. Through a running editor
it is under **half a second** — so if you keep the editor open, turn this on.

`DreamFXLang: Verify Current File (quietly, into Problems)` runs the same thing on demand.

## The editor bridge

When the Unreal Editor has the project open, `verify` and `build` are handed to it rather than
booting a second engine. Measured against a live editor:

| | bridge | CLI |
| --- | --- | --- |
| ping | 113 ms | — |
| verify, clean file | **324 ms** | 13,000 ms |
| verify, two errors | **539 ms** | 13,000 ms |
| build, one system | **1,255 ms** | 13,000 ms + build |

**Routing is not a preference.** `dfx build` writes packages and so does a running editor; when both
save the same package the later save silently wins and the earlier work is gone with no error
anywhere. With an editor up the bridge is not the faster route, it is the only correct one — which
is why the write-conflict warning appears on the CLI route and not on this one.

It works through files in `<Project>/Saved/DreamFX/Bridge/`, so there is no port to pick and no
firewall prompt, and it needs the plugin's `FBridgeService`. Without it nothing changes: no
`status.json` means no editor, and every command takes the CLI route it always did.

The status bar shows which route the next command will take. **Editor Bridge Status** pings it.

### Limits, stated

- **Signatures are not probed over the bridge.** Probing walks module graphs, and one piece of
  engine content recurses until the process dies of a stack overflow — survivable for a supervised
  CLI run, fatal for your editor. `Rebuild Module Index` with the editor open gets you the module
  list; run `dfx index` for the input signatures, and completion says so rather than offering an
  empty argument list.
- **One editor per project.** Two would race for the same requests. Two editors on one project is
  already an unsupported state, so this is stated rather than defended against.
- **A request written while no editor was listening is discarded, not queued.** By the time one
  starts, whoever sent it has timed out and moved on — and executing a stale `build` at startup
  would write packages nobody asked for.

## Install

From the Visual Studio Marketplace: search for **DreamFXLang Language Support**, or

```bash
code --install-extension typedreammoon.dreamfxlang-language-support
```

Every release is published there and attached to its GitHub Release as a `.vsix`.

From a release: download the `.vsix` and run

```bash
./install-vscode-extension.ps1
```

From source:

```bash
npm install && npm run package
```

## Use

The plugin can generate a workspace for you — **Tools → DreamFX → Open Workspace** in the Unreal
Editor writes `DFX/DreamFX.code-workspace` with the project and every plugin's source root as
folders, and the file associations already pointing at this extension.

Commands (`Ctrl+Shift+P`):

| Command | |
| --- | --- |
| `DreamFXLang: New Source File` | Create a `.dfs` / `.dfe` / `.dfm` from a template |
| `DreamFXLang: Edit Curve Under Cursor` | Open the curve editor on the `curve { }` under the cursor (also a lens on each literal) |
| `DreamFXLang: Rebuild Module Index` | Re-export the module index that completion reads. **Reads only** |
| `DreamFXLang: Verify Current File` | Check the file against its asset. **Reads only** |
| `DreamFXLang: Lint Current File` | Style and consistency warnings. **Reads only** |
| `DreamFXLang: Build Current File` | Generate the asset. **Writes packages** — see below |
| `DreamFXLang: Open the Asset This File Builds` | Opens it in the editor. Needs the bridge |
| `DreamFXLang: Re-export This Asset to Source` | Decompile it again. Needs the bridge |
| `DreamFXLang: Adopt This Asset` | Make the text the source of truth. Needs the bridge |
| `DreamFXLang: Pull Values from Asset (needs the editor)` | Write values changed in the Niagara editor back into the `.dfs`, via a diff. Needs the bridge; **does not save** |
| `DreamFXLang: Editor Bridge Status` | Which route commands take, and a ping |

`verify` and `build` are also contributed as tasks, so `tasks.json` can bind them to a key or run
them as the default build task:

```json
{ "type": "dreamfx", "command": "verify", "scope": "all" }
```

### Build writes packages, so the CLI route asks first

If the Unreal Editor has the project open, both it and `dfx` save the same packages, and the one
that saves second silently wins. That is why a CLI `build` is never automatic, never on save, and
shows a modal warning by default. `verify` and `lint` write nothing and are safe at any time.

The bridge route does not ask, because there is no second writer to ask about: the editor is doing
the saving itself.

Answering *"Run anyway"* on the CLI route is a real answer — an editor being open is not the same
as that editor having *this* project open, which is why the CLI itself warns rather than refuses.
Turn the prompt off with `dreamfx.confirmBuild` once that distinction stops mattering to you.

Note also that a CLI invocation boots the engine, around 13 seconds. Nothing here is triggered by
typing.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `dreamfx.dfxScriptPath` | `""` | Path to `.skill/dfx.ps1`. Empty means: search upward from the file, then the workspace |
| `dreamfx.powershellPath` | `"pwsh"` | Use `powershell` for Windows PowerShell 5.1 |
| `dreamfx.syntaxDiagnostics` | `true` | Live lexical problems while typing |
| `dreamfx.curveCodeLens` | `true` | The **Edit curve** lens above each `curve { }` literal |
| `dreamfx.confirmBuild` | `true` | Ask before a command that writes packages |
| `dreamfx.verifyOnSave` | `false` | Verify a source when it is saved. Reads only; ~13s per save |
| `dreamfx.pull.structuralEdits` | `false` | Let **Pull Values from Asset** also add and remove whole lines (stacks, modules), not just change literal values |

## Development

```bash
npm install
npm run build
npm test
```

The extension is two processes. `src/server/` is a standard LSP server — completion, hover, the
outline and the lexical diagnostics, plus the `.dfx-index.json` it reads them from. `src/extension.ts`
is the client: builds, verifies, asset actions and the editor bridge, none of which the protocol has
anything to say about. The language core under `src/core/` imports nothing from `vscode` and nothing
from the protocol either, which is what let the server be lifted out of the providers unchanged.

`npm run build` is `tsc` for the types and the tests, then esbuild for the three bundles the
editor actually loads (`out/client.js`, `out/server.js`, and the curve editor's page `out/curveEditor.js`). `F5` launches an Extension Development Host; to
put breakpoints in the server as well, run the **Extension + Server** compound, which attaches a
second debugger to port 6019.

The test suite runs without VSCode and without an engine — including `serverProtocol.test.ts`, which
spawns the built server over stdio and holds a real LSP conversation with it. To sweep a real source
tree as well — point it at a project or at the plugin itself, and it checks both directions: nothing
flagged on a source the compiler accepts, and nothing but DFX1xxx claimed on one it rejects:

```bash
DREAMFX_CORPUS_DIR=/path/to/Plugins/DreamFX npm test
```

## Links

- [DreamFX plugin](https://github.com/TypeDreamMoon/DreamFX) — the language, the compiler and the CLI
- [Language reference](https://github.com/TypeDreamMoon/DreamFX/tree/main/Docs/language)
- [Diagnostic codes](https://github.com/TypeDreamMoon/DreamFX/tree/main/Docs/diagnostics)

MIT © TypeDreamMoon
