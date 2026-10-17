# Static language plugins

Plugin API 1.4.0 lets trusted local development plugins provide syntax coloring and editor configuration from JSON. A static language does not add a compiler, project inference, or a language service. Basic Plus remains the only shipped source frontend; third-party `frontends`, `backends`, and `languageServices` remain prohibited, including empty declarations. Existing compatible 1.x plugins continue to load.

## A complete static-only plugin

Place these three files in one folder. This example is the shared `acme.toy` acceptance fixture. There is no executable entry, SDK initialization, registration RPC, or plugin process.

`kobrixa-plugin.json`:

```json
{
  "id": "acme.toy",
  "version": "1.0.0",
  "apiVersion": "^1.4.0",
  "displayName": "Toy static language",
  "runtime": { "kind": "static" },
  "contributes": {
    "languages": [
      {
        "id": "toy",
        "extensions": ["toy"],
        "aliases": ["Toy"],
        "tokenizer": { "version": 1, "path": "language/tokenizer.json" },
        "configuration": { "version": 1, "path": "language/configuration.json" }
      }
    ]
  }
}
```

`language/tokenizer.json`:

```json
{
  "ignoreCase": false,
  "defaultToken": "invalid",
  "states": [
    {
      "name": "root",
      "rules": [
        { "regex": { "pattern": "[ \\t]+", "flags": "" }, "action": { "token": "white" } },
        {
          "regex": { "pattern": "[A-Za-z_][A-Za-z0-9_]*", "flags": "" },
          "action": { "token": "identifier" }
        },
        { "regex": { "pattern": "[0-9]+", "flags": "" }, "action": { "token": "number" } }
      ]
    }
  ]
}
```

`language/configuration.json`:

```json
{}
```

The resource declarations carry `version: 1`; the JSON resource bodies do not repeat it. Both resources are required. An empty configuration selects Monaco defaults; inline configuration is not supported. Resource paths are package-relative `.json` paths, at most 600 characters and seven directory segments, with no URLs, absolute paths, backslashes or `..` segments. Each path directory segment and file stem is limited to 64 characters (`[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}`); the `.json` suffix is additional. A symlink cannot escape the linked folder. The manifest reader enforces this boundary too: a symlinked `kobrixa-plugin.json` that resolves outside the plugin folder is rejected, including for development plugins.

`runtime: {"kind":"static"}` accepts only `kind`. It cannot declare `entry`, `activationEvents`, `permissions`, commands, frontends, backends or language services, even as empty arrays. It needs a nonempty language contribution or valid `diagnosticHelp`. A resource error rejects its language without retroactively invalidating the static runtime. Node/Python plugins may also contribute these resources; reading their grammars does not start their processes.

## Load, reload and recover

Use Settings → Plugins to enable developer mode after the native trust confirmation, then link the folder. Alternatively launch the application with `--plugin-dev-dir=/absolute/path/to/toy`; multiple folders use `:` on macOS/Linux and `;` on Windows. Changes take effect after Reload. Enable/Disable applies to the whole plugin and persists by source identity. A static-only plugin can be enabled without a PID.

Only load grammars from authors you trust. JSON is data, but its regular expressions run in the editor and can block the renderer. Validation is not a ReDoS proof, a sandbox, or an interruptible worker. The 5,000 ms source I/O deadline and initial IPC wait do not interrupt synchronous regex execution. The 10,000 UTF-16-code-unit line threshold skips lexical tokenization at length ≥10,000; it does not bound indentation, on-enter or word-pattern input and does not make short patterns safe.

The host synchronously persists `thirdPartyStaticContributions` before delivering a third-party catalog, even for a plugin with no process. The bit stays set for the session after disable. A failed write prevents third-party delivery with `PLUGIN_E_STATE_SAVE`; builtin and plain-text editing remain available. Old markers without this field mean false. An unclean exit after delivery enters safe mode on the next launch; a renderer-unresponsive reason takes priority. Normal quit clears the marker unless a renderer hang must be remembered.

If the window hangs, quit it and restart, using `--safe-mode` if needed. Safe mode skips third-party folders and keeps Basic Plus and builtin services. The next launch exposes recovery settings independently of the hung renderer. Restore plugins is an explicit user action; it does not re-enable individually disabled sources, and it cannot end a CLI `--safe-mode` session. Do not rely on a button in an already blocked renderer to stop a regex.

## Resource format v1

Objects are strict: unlisted fields are rejected. State/list/rule/case arrays retain order. The `root` state is required; names use `^[a-z][a-z0-9_]{0,31}$`. State names `pop`, `popall`, `push`, list names `default`, `eos`, and map keys `__proto__`, `constructor`, `prototype` are reserved.

Tokenizer rules contain either `{regex, action}` or a local `include: "@state"`. Includes must exist, be acyclic, and fit the expansion limits, including unreachable states. Actions contain a literal `token` with optional `next` and `bracket`, or an ordered `cases` array whose branches use `@list`, `@eos`, and a final single `@default`. Nested cases and arbitrary guards are forbidden. Transitions accept an existing `@state`, `@pop`, or `@popall`; legal transition cycles are distinct from forbidden include cycles. `@brackets` requires a non-empty tokenizer bracket table and cannot also override `bracket`.

Every regex has `pattern` and explicit `flags`, exactly `""` or `"i"`. Every tokenizer regex must match `ignoreCase ? "i" : ""`; configuration regex flags are independent. Patterns are ECMAScript regex sources. Write literal `@`, `@@`, `@name`, and `$` normally; the adapter protects them from Monarch macro interpretation. `$S`/`$s` followed by a digit is rejected even when escaped. Backreferences, lookbehind, unsupported syntax, and tokenizer rules that cannot be proven to consume at least one code unit are rejected. Lookahead is supported. Configuration anchors may consume zero characters through the same purpose-aware validator.

Functions, imports, modules, callbacks, remote resources, external includes, custom macros, capture-action arrays, tuple shortcuts, dynamic substitutions, `@push`, `@rematch`, `goBack`, `switchTo`, `nextEmbedded`, `log`, `unicode`, `includeLF` and custom `start` are not part of v1. Strings are never evaluated as JavaScript.

Configuration may contain comments, brackets, auto-closing pairs with `notIn`, surrounding pairs, indentation regexes, on-enter rules, and a word pattern. On-enter indentation actions are `none`, `indent`, `indentOutdent`, or `outdent`. The full field contract and the strict public schemas `static-language-tokenizer-v1` and `static-language-configuration-v1` are described in the [approved design, sections 2–4](../superpowers/specs/2026-10-17-plugin-system-2c-static-languages-design.md). Zod, exported draft-2020-12 JSON Schema, and SDK conformance share the format; Python does not use its regex engine to validate ECMAScript patterns.

## Fixed limits

`STATIC_LANGUAGE_FORMAT_VERSION = 1` binds these immutable `STATIC_LANGUAGE_LIMITS_V1` values. Authors cannot raise them; incompatible format/limit changes require a new version. String lengths count decoded Unicode code points except the editor line threshold, which counts UTF-16 code units. Resource bytes count original UTF-8 including BOM; repeated references are charged repeatedly.

| Limit                                               |                               Value |
| --------------------------------------------------- | ----------------------------------: |
| Pattern / adapter-compiled pattern                  |           2,048 / 4,096 code points |
| Raw rules / regexes per language                    |                       1,024 / 1,024 |
| States / keyword lists                              |                             64 / 32 |
| Words per language / characters per word            |                          4,096 / 64 |
| Cases per rule / on-enter rules                     |                             32 / 32 |
| Resource file / language / plugin                   | 524,288 / 786,432 / 1,048,576 bytes |
| All active resources                                |                     8,388,608 bytes |
| Expanded rules per language / total                 |                      8,192 / 65,536 |
| Include depth                                       |                            16 edges |
| Languages per plugin / active total                 |                             8 / 128 |
| Registered plugin language ids per renderer session |     256; the 257th requires restart |
| Lexical line threshold                              |            10,000 UTF-16 code units |

Extensions are 1–16 distinct values of 1–16 lowercase alphanumeric characters without a dot. Language ids use `^[a-z][a-z0-9-]{0,31}$`. Aliases are 1–8 distinct single-line strings of 1–80 code points; the first is the label, or the id if omitted. Token/postfix lengths are at most 80. Pair/comment atoms are 1–16; each pair table is at most 32; `notIn` has at most three distinct values. On-enter `appendText` is at most 256 code points and `removeText` an integer 0–256. Controls in strings are rejected; textual regex escapes can match controls. All states and all configuration regex fields count toward limits.

## Ownership, fallback and errors

Extension matching is case-insensitive on the last filename segment. Routing is core → applicable selected binding's same-owner static language → unique global extension → plain text. All installed Monaco core language ids in `CORE_STATIC_LANGUAGE_IDS` (including `json`, `plaintext`, `python`, `css` and `yaml`) are reserved. Only `.json` is a reserved extension. A selected binding never borrows another owner's grammar when its own is missing. Without an applicable binding, two distinct languages sharing an extension make that global mapping ambiguous; no load-order winner exists. Other extensions and both language registrations survive. Duplicate purely static ids exclude every claimant. Aliases never choose ownership. A frontend reserves its logical id even if its grammar fails; matching frontend/service/static extension sets must be equal.

Disable, removal or failed reload updates existing visible, hidden and review models to plain text without losing text, undo, drafts, cursor or view state. Re-enable restores eligible open files. Lexical revision is separate from service epoch; grammar failures do not make a healthy analysis service unavailable. Plain-text fallback clears semantic coloring. Basic Plus uses Monaco id `bp` and token postfix `.basic-plus`, with unchanged keywords, comments, pairs, indentation and themes. Builtins cannot be disabled (`PLUGIN_E_BUILTIN_REQUIRED`).

| Problem                                 | Meaning                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `PLUGIN_E_MANIFEST`                     | Invalid declaration, static runtime semantics, or same-owner extension mismatch          |
| `PLUGIN_E_STATIC_LANGUAGE`              | Resource, format, regex, include, I/O or budget failure; only that language is rejected  |
| `PLUGIN_E_STATIC_LANGUAGE_CONFLICT`     | Ownership/id conflict or ambiguous/reserved extension; details identify all participants |
| `PLUGIN_E_STATIC_LANGUAGE_REGISTRATION` | Renderer validation, adapter, Monaco or session-id-limit failure                         |

The Plugins panel shows the plugin id, `detail.languageId`, relative `resourcePath`, applicable `fieldPath`, and limit `allowed`/`actual` or conflicting sources. Reload or explicit enable retries a quarantined generation; repeated catalog notifications do not. These are lexical capabilities only: no marketplace, theme contributions, file-association UI, glob/filename/first-line matching, or third-party language-service RPC is introduced.
