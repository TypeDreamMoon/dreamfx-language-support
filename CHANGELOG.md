# Changelog

## 0.2.0

Phase W3: completion and hover, from the project's real module set.

### Index

- `DreamFXLang: Rebuild Module Index` runs `dfx index`, which exports every module and dynamic input
  the search paths expose — name, path, category, description, declared stacks and **input
  signature** — into `DFX/.dfx-index.json`. Measured on this project: 571 modules, 8.1s.
- The index is read from disk and never derived here. Every `dfx` call boots the Unreal Editor, so
  nothing that runs while you type may ask it anything.
- A status bar item shows how many modules are loaded and when the index was generated; clicking it
  rebuilds.

### Completion

- At statement position in a stack: the modules that stack accepts, with their descriptions.
- Inside a call: that module's real input names, typed, with static switches sorted first — on a
  module source order *is* write order, so an input that only exists once a switch is set has to be
  written after it.
- After `Input = `: the input's enum entries when it has them, the five parameter namespaces, and
  every dynamic input valid in the stack.
- Names already written are dropped from the offer.
- Works through a dynamic input chain of any depth, through a partial path, through `@version` and
  through `disabled`.
- Offers nothing inside `hlsl { }` or a module's `Body = { }` — that is HLSL, not DreamFXLang.

### Hover

- Over a module call: description, the stacks it declares, and its full signature.
- Over an input name: its type, description, enum entries, and whether it takes an expression.
- Over an ambiguous short name: every asset it matches, because the compiler refuses rather than
  picking one (DFX3002).

### The boundary holds

This offers; the build decides. The index is a snapshot and can be stale, so nothing here filters on
it aggressively and nothing reports an error from it. A module with no recorded stacks is offered
everywhere rather than nowhere: an empty list means the export could not read the usage bitmask, and
hiding a module because the *cache* is thin would be the editor inventing a restriction the language
does not have.

### Found while building it

- **`dfx schema /Niagara/Modules/Masks/ConeMask` crashes the commandlet**, and always has. That
  module's graph makes the engine's own `UNiagaraGraph::ReferencesStaticVariable` recurse without
  bound; the stack overflow ends the process. It is stock engine content, so any project hits it. The
  index walk now records the module it is about to probe and quarantines whatever was still recorded
  when the next run starts, and `dfx.ps1` re-runs until the walk completes — 2 attempts, 47s here.

## 0.1.0

First release. Covers phases W0–W2 of the plan: a language you can read, write and check without
leaving the editor.

### Language

- TextMate grammar for `.dfs`, `.dfe` and `.dfm`, registered under the language id `dreamfxlang` —
  the id the plugin already writes into `DFX/DreamFX.code-workspace`.
- `hlsl { }` and a module's `Body = { }` are handed to the HLSL grammar, with nested braces counted
  so a body's own `if` block does not close it.
- Comments, brackets, auto-closing, indentation, and `#Region` / `#EndRegion` folding markers.
- A word pattern that treats `User.TintA` and `` `Ring/DiscDistributionMode` `` as single words.

### Navigation

- Outline, breadcrumbs and go-to-symbol: document → emitters → stacks, sections and renderers →
  module calls and declarations.
- A module call shows its input count, and `disabled`, `@version` and `as <name>` as detail.
- A `Stage` or `OnEvent` header is summarised by the arguments it configures.
- An emitter pulled in with `from` shows where it came from.

### Diagnostics

- Live syntax errors from a port of the compiler's own lexer, reported with its own codes —
  `DFX1001` unterminated string, `DFX1002` unterminated block comment, `DFX1003` unexpected
  character, `DFX1004` unterminated raw block, `DFX1005` unterminated back-quoted name — plus
  unclosed and unmatched braces. Each code links to the plugin's diagnostic docs.
- Nothing semantic is judged here; see the README for why.
- `verify` / `lint` / `build` contributed as tasks and commands, with a `$dreamfx` problem matcher
  that reads the CLI's output in all four shapes it appears in and puts every `DFXnnnn` into the
  Problems panel.
- `build` warns before it runs, because it writes packages and a running editor writing the same
  packages means the later save silently wins.

### Authoring

- 26 snippets covering documents, stacks, event handlers, simulation stages, renderers, curve and
  HLSL literals, bindings, and the modifier forms.
- `DreamFXLang: New Source File` creates a `.dfs` / `.dfe` / `.dfm` from a template. The templates
  follow the plugin's own corpus samples, and all four were built for real (`dfx build -NoSave`,
  five sources counting a system that pulls the emitter in with `from`) rather than assumed:
  5 built, 0 failed, 0 errors, 0 warnings.

### Known limits

- Completion, hover and verify-on-save need a schema index the CLI cannot yet export; they are the
  next phase.
- There is no connection to a running Unreal Editor yet, so `build` from here always pays an engine
  boot.
- The grammar counts braces textually inside a raw block, so a `{` inside an HLSL string or comment
  can end the highlighted region early. The compiler is not fooled by this; only the colours are.

### Found while verifying

Building the templates for real turned up two defects in the plugin, both since fixed there:

- A `//` comment inside a **DynamicInput**'s `Body` failed the build. The compiler reduces that body
  to one expression by stripping a leading `return`, and a comment in front of it defeated the test,
  so the `return` survived into `Out_X = (float)( return ... );`. A **Module** body is emitted
  verbatim and never wrapped, so the same comment there was always fine. The reduction now strips
  comments first. The templates and snippets keep their commentary outside the block regardless — a
  template should not require the newest plugin to build — and a test holds that line.
- `dfx.ps1` kept only output lines carrying a `LogDreamFX` prefix, which the second and later lines
  of a multi-line `UE_LOG` do not have. Every multi-line diagnostic therefore reached the terminal
  truncated to its first line: `DFX6006`, whose entire value is the translator's own error text,
  arrived ending in a bare colon. The driver now groups output into records before filtering.
