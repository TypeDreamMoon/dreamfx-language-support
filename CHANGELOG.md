# Changelog

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

A `//` comment inside a **DynamicInput**'s `Body` fails the build. The translator writes the body
into `Output = (Type)( <body> );`, so the comment swallows the closing paren; it surfaces as an
empty `DFX6006` — *"Niagara could not compile the body of ...:"* with nothing after the colon —
which names neither the line nor the reason. The same comment in a **Module** body is fine, because
a module's body is emitted verbatim and is never wrapped. Both the template and the snippet keep
their commentary outside the block, and a test asserts they continue to.
