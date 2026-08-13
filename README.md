# DreamFXLang Language Support

[![version](https://img.shields.io/badge/version-0.3.0-blue)](CHANGELOG.md)
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
| **Snippets** | 26 skeletons: documents, stacks, `OnEvent`, `Stage`, renderers, `curve { }`, `hlsl { }`, `Bind`, `disabled`, `as`, `@version`, `#Region` |
| **New file** | `DreamFXLang: New Source File` — pick a kind, name the asset, get a file that builds |
| **Tasks and Problems** | `verify` / `lint` / `build`, as commands or tasks, with every `DFXnnnn` landing in the Problems panel as a clickable entry |
| **Verify on save** | Opt-in (`dreamfx.verifyOnSave`): saving a source runs `dfx verify` and puts the result in Problems, one engine at a time. See [below](#verify-on-save) for why it is off by default |

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

## Verify on save

Turn on `dreamfx.verifyOnSave` and saving a source runs `dfx verify` against it, putting the result
straight into Problems — no terminal, no task panel. It reads only; no packages are written. Saving
the same file repeatedly queues it once, and a save arriving while a check is running joins the same
queue rather than starting a second engine.

**It is off by default because it is expensive, not because it is unfinished.** Measured here, one
file takes **13 seconds**, essentially all of it engine boot — the check itself is a fraction of a
second. That is fine for a deliberate pass over a file and much too slow to sit behind every save
while iterating, and nothing in this extension can move it: the floor is the boot.

`DreamFXLang: Verify Current File (quietly, into Problems)` runs the same thing on demand.

## Not yet

| | Status |
| --- | --- |
| Two-way bridge to a running Unreal Editor (single-asset rebuild, open asset, decompile from VSCode) | planned — and it is what makes verify-on-save affordable, because the engine is already loaded |

## Install

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
| `DreamFXLang: Rebuild Module Index` | Re-export the module index that completion reads. **Reads only** |
| `DreamFXLang: Verify Current File` | Check the file against its asset. **Reads only** |
| `DreamFXLang: Lint Current File` | Style and consistency warnings. **Reads only** |
| `DreamFXLang: Build Current File` | Generate the asset. **Writes packages** — see below |

`verify` and `build` are also contributed as tasks, so `tasks.json` can bind them to a key or run
them as the default build task:

```json
{ "type": "dreamfx", "command": "verify", "scope": "all" }
```

### Build writes packages, so it asks first

If the Unreal Editor has the project open, both it and `dfx` save the same packages, and the one
that saves second silently wins. That is why `build` is never automatic, never on save, and shows a
modal warning by default. `verify` and `lint` write nothing and are safe at any time.

Answering *"Run anyway"* is a real answer: an editor being open is not the same as that editor
having *this* project open, which is why the CLI itself warns rather than refuses. Turn the prompt
off with `dreamfx.confirmBuild` once that distinction stops mattering to you.

Note also that every `dfx` invocation boots the engine, which takes tens of seconds. Nothing here is
triggered by typing.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `dreamfx.dfxScriptPath` | `""` | Path to `.skill/dfx.ps1`. Empty means: search upward from the file, then the workspace |
| `dreamfx.powershellPath` | `"pwsh"` | Use `powershell` for Windows PowerShell 5.1 |
| `dreamfx.syntaxDiagnostics` | `true` | Live lexical problems while typing |
| `dreamfx.confirmBuild` | `true` | Ask before a command that writes packages |
| `dreamfx.verifyOnSave` | `false` | Verify a source when it is saved. Reads only; ~13s per save |

## Development

```bash
npm install
npm run compile
npm test
```

`F5` launches an Extension Development Host. The language core under `src/core/` imports nothing
from `vscode` — that is the seam a language server or another IDE would reuse, so it stays clean.

The test suite runs without VSCode and without an engine. To sweep a real source tree as well:

```bash
DREAMFX_CORPUS_DIR=/path/to/YourProject npm test
```

## Links

- [DreamFX plugin](https://github.com/TypeDreamMoon/DreamFX) — the language, the compiler and the CLI
- [Language reference](https://github.com/TypeDreamMoon/DreamFX/tree/main/Docs/language)
- [Diagnostic codes](https://github.com/TypeDreamMoon/DreamFX/tree/main/Docs/diagnostics)

MIT © TypeDreamMoon
