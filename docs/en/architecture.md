# Architecture and public contracts

## System shape

```text
Monaco editor + React renderer
          │ allowlisted contextBridge API
          ▼
Electron preload bridge
          │ validated Electron IPC
          ▼
Electron main process (Node.js)
          ├─ Workspace service → Resolved built-in frontend
          │                       → Typed KobrixaIR + validation
          │                       → Resolved backend → validated artifact set
          └─ Device service ────────────────────→ USB HID / Wi-Fi
```

The React renderer owns presentation state only and has no direct access to Node.js or Electron APIs. A narrow preload API uses `contextBridge` to invoke validated IPC handlers in the Electron main process. Node.js services own filesystem access, compiler execution, cancellation, device sessions, and structured errors. No compiler phase may depend on the UI.

## Repository boundaries

- `apps/desktop`: Electron main and preload processes, React renderer, Monaco integration, localization, and user workflows.
- `apps/collab`: the cloud collaboration service, a Cloudflare Worker with one Durable Object per room. Desktop editing, compilation and device use do not depend on it.
- `apps/web`: product pages, bilingual documentation, Gallery UI and its Cloudflare Worker. Desktop editing and compilation do not depend on this service.
- `packages/compiler`: build-session orchestration and diagnostic aggregation.
- `packages/ir`: versioned IR types, validation, and serialization used by language frontends and backends.
- `packages/backend-ev3`: deterministic EV3 VM lowering and `.rbf` packaging.
- `packages/collab-protocol`: the collaboration wire contract shared by the desktop app and `apps/collab` — Y.Doc layout, message and close codes, limits, and zod schemas for rooms, invites, tokens, presence, chat and device control.
- `packages/device`: transport-neutral device operations with USB and Wi-Fi implementations.
- `frontends/basic-plus`: clean-room lexer, parser, semantic analysis, and IR lowering.
- `tools/release`: archive validation, signing verification and GitHub Release draft management. `.github/workflows/release.yml` coordinates native platform builds.

Dependencies point inward toward shared contracts. The compiler and device packages must be usable by a future Node.js CLI without importing Electron desktop code.

## Desktop source layout

`apps/desktop/src` separates process boundaries first, then groups files by feature:

```text
src/
├─ main/                 # Electron startup and IPC composition
│  ├─ device/            # EV3 sessions, remote files and batch transfers
│  ├─ language/          # Diagnostics service, worker and protocol
│  ├─ window/            # Native window keyboard coordination
│  └─ workspace/         # Local projects, builds and example validation
├─ preload/              # contextBridge entry point
├─ shared/               # Cross-process API types and keyboard contracts
└─ renderer/             # React entry point and App composition
   ├─ components/       # Reusable menus, icons, dialogs and selection controls
   ├─ device/           # EV3 panels and remote file state and controls
   ├─ editor/           # Monaco, formatting and live diagnostics
   ├─ execution/        # Build/deploy/run state and version labels
   ├─ i18n/             # Shared UI copy and locale types
   ├─ keybindings/      # Command catalog, recording, search and Monaco adapter
   ├─ settings/         # Preferences, persistence, themes and settings page
   ├─ styles/           # Style entry point, workbench and shortcut styles
   ├─ workbench/        # Toolbar, welcome page, diagnostics panel and layout state
   └─ workspace/        # File tree, recovery drafts and save coordination
```

Tests live beside their modules; cross-process interaction tests stay in `apps/desktop/tests` and `tests/desktop`. Feature-specific copy stays with its feature, while shared copy belongs in `i18n`. Reusable `components` do not depend on feature modules. Import components directly from their files instead of a large UI export collection. `main/index.ts`, `main/ipc.ts` and `renderer/app.tsx` compose the features; `shared` never imports process implementations.

The language worker source lives in `main/language`; Forge emits `language-worker.cjs` beside `main.cjs`. Each desktop build uses a separate `main/workspace/build-worker.ts`, packaged as `build-worker.cjs`, for frontend, IR validation, backend and artifact commits. A shared cancellation flag is checked by the compiler even during synchronous work. Worker errors/exits produce one failed build result and release the busy gate; closing the last window requests cancellation. `styles/index.css` explicitly preserves the workbench-before-shortcuts stylesheet order.

Shared UI behavior lives in `renderer/components`: `Dialog` builds on `Modal` for accessible headings and form submission, while `DialogActions` lays out caller-owned buttons. Callers retain validation, busy state, initial focus, dismissal rules and focus restoration options. `ClosableTab` shares file/settings tab presentation, `ResizeHandle` owns pointer/keyboard resizing and listener cleanup, and `menu-keyboard` supplies navigation for action and context menus. Settings-specific `SettingField`, `SettingSelect` and `SettingToggle` stay in `renderer/settings`; they connect labels and hints without owning preference persistence.

## Multiple project sessions

`ProjectSessions` owns documents and view state by workspace ID; `EditorModels` retains Monaco models and undo history across visible editor remounts, disposing them when a project closes. Background projects retain automatic saving and recovery draft queues, while language analysis and completion serve only the active project. `ExecutionController` separates the selected project from the operation owner, preserving per-project diagnostics and build versions alongside one shared EV3 connection and deployed version.

The main process deduplicates real project roots and exposes `workspace.restoreSession`, `workspace.saveSession` and `workspace.close`. A validated, versioned `workspace-session.json` in user data is written atomically and stores input paths, entry selection, project/file order and editor positions; renderers submit only registered workspace IDs. Recovery drafts keep their existing format. The quit handshake waits for all drafts and session state to be written and keeps the window open on failure. Restart restores neither undo history nor device connections or execution commands.

## Cloud collaboration

```text
Host renderer (Collaborate tab)          Guest renderer
  │ Monaco ⇄ Y.Doc binding                  │ Monaco ⇄ Y.Doc binding
  │ CollabApi via preload/IPC               │ CollabApi via preload/IPC
  ▼                                         ▼
Host main process                        Guest main process
  │ create room · role · kick              │ join with invite code
  │ real project folder                    │ mirror in <userData>/collab/<room>/
  ▼                                         ▼
        HTTPS (room/join) + WebSocket (Yjs sync, awareness, notices)
                              │
                              ▼
          apps/collab — Cloudflare Worker (routing, HMAC tokens)
                              │
                              ▼
          CollabRoom Durable Object — one per room
          Y.Doc: files · tree · chat · control · meta
          persisted in Durable Object SQLite storage
```

- The main process creates and joins rooms over HTTPS, keeps room tokens only in process memory (no keychain access), and resolves the service origin from `KOBRIXA_COLLAB_URL` or the default `https://collab.kobrixa.com`. The Content-Security-Policy allows only that origin for collaboration traffic.
- Hosts may set an optional room password. The Durable Object checks a server-keyed, salted PBKDF2-SHA256 verifier before admitting guests and durably limits password attempts per client. Passwords are never included in shared documents, tokens or local preferences. Existing rooms remain passwordless.
- The renderer opens the room WebSocket with the token and binds Monaco models to the room's Y.Doc. Remote cursors and presence use Yjs awareness.
- `packages/collab-protocol` is the only contract between the desktop app and the service; both sides validate requests and messages with its schemas. Incompatible changes bump `COLLAB_PROTOCOL_VERSION`.
- Tokens are HMAC-SHA256-signed by the Worker with `COLLAB_SECRET`, are valid for seven days, and carry the participant's role. The Durable Object enforces roles: viewers' document updates and chat posts are rejected.
- The Durable Object enforces room limits (16 participants, 200 files, 1 MiB per file, 8 MiB total UTF-8 file content, 500 chat messages). Encoded document snapshots and individual WebSocket messages are bounded at 16 MiB. Directories do not count as files. The room's storage is deleted after seven days without connections.
- A role change replaces the renderer session with a fresh document from the server while preserving its workspace binding. This prevents dropped viewer edits or stale Yjs clock dependencies from being resent after promotion.
- Device operations stay local to each participant's main process. While a room is active, device writes are rejected unless that window holds device control; stopping a program is always allowed.
- Room state crosses the Cloudflare network. Logs must not contain source contents, chat text, passwords or tokens.

## Plugins (development preview)

The development preview supports trusted local JS/TS, Python, and static-only JSON plugins. Third-party plugins load only in developer mode, which is off by default and turned on in Settings → Plugins after a native confirmation dialog. The panel links plugin folders through a native folder picker, chooses the Python interpreter, lists built-in and development plugins with their load errors, messages and logs, runs and cancels contributed commands, and reloads, enables, disables or unlinks development plugins. See the [runnable samples](../../plugins/samples/README.md) and [Python SDK](../../sdks/python/README.md).

The public API has three layers: JSON-RPC 2.0, Zod definitions and committed JSON Schema, and language SDKs:

- `packages/plugin-protocol` (`@kobrixa/plugin-protocol`) uses Zod as the authoring source. The committed `schema/plugin-protocol.schema.json` is the cross-language public contract. Tests regenerate the schema in memory and compare it with both committed copies, including the Python SDK's copy; shared valid/invalid cases in `conformance/cases.json` check that the TypeScript and Python validators agree.
- `packages/plugin-runtime` (`@kobrixa/plugin-runtime`) owns manifest validation, the registry, command routing and process supervision without depending on Electron. The desktop supplies launchers and persistent state storage.
- `packages/plugin-sdk-js` (`@kobrixa/plugin-sdk`) provides `definePlugin`, `runPlugin`, command handlers with an `AbortSignal`, and `context.ui.showMessage` for JS/TS plugins.
- `sdks/python` (`kobrixa-plugin-sdk`, imported as `kobrixa`) supports Python 3.10 or newer with only standard-library runtime dependencies. It validates protocol data against the bundled committed JSON Schema and uses ordinary dictionaries for wire data, without generated Python type bindings.

JS/TS plugins run in Electron `utilityProcess` children and exchange JSON-RPC messages through a transferred MessagePort. Python plugins run in a separate, explicitly selected local interpreter and use stdin/stdout with `Content-Length` framing. Python stdout is reserved for protocol messages; logs go to stderr. Kobrixa does not download or manage a Python runtime.

The desktop main process wraps the runtime's `PluginManager` in a `PluginController` (`apps/desktop/src/main/plugins/controller.ts`). It owns developer mode, the native dialogs, Python probing, log and message buffers and the session marker, and it checks every request from the renderer: developer mode, safe mode and whether Kobrixa is shutting down are enforced in the main process, after any dialog closes. The renderer sends only source keys, command IDs, booleans, Python candidate IDs and log cursors — never a path or an executable. This prevents adding an arbitrary path or executable without the user's choice; it does not protect against a compromised renderer.

Linking stores the folder's real path (`fs.realpath`), and the source key is derived from it, so the same folder cannot be linked twice. Python candidates (`python3`, `python`, `py -3` on Windows, the saved choice, or one picked with **Other…**) are probed without a shell, with a 3-second limit and 4 KiB of output; a usable interpreter is Python 3.10 or newer with an importable `kobrixa` SDK of the same major API version.

Python stderr and JS/TS stdout/stderr are kept in main-process memory for the panel's log viewer (256 KiB per plugin, 4 MiB in total, oldest lines dropped first, control characters removed, cleared on unlink), and are also written to the main process's terminal/console with each line prefixed `[plugin <id>] `. UTF-8 output is decoded across chunks, and a final partial line is flushed on exit. The Python SDK redirects `print()` to stderr as soon as `Plugin()` is constructed, including before `run()`; logs written before construction must explicitly use stderr.

Advanced launch options apply to one session only and are never saved:

| Switch                          | Effect                                                                                                                                                                                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--plugin-dev-dir=<folders>`    | Loads each named folder's `kobrixa-plugin.json` for this session, without turning on developer mode. Use `:` between folders on macOS/Linux and `;` on Windows. Relative paths resolve from the launch working directory; absolute paths are recommended. |
| `--plugin-python=<interpreter>` | Uses this local Python executable for this session instead of the saved choice. Install the SDK in this interpreter's environment.                                                                                                                        |
| `--safe-mode`                   | Disables all development plugins for this session before contributions are registered or processes are launched. Built-in plugins remain enabled. **Restore plugins** cannot end it.                                                                      |

`<userData>/plugins/state.json` (schema version 2) stores developer mode, the linked folders, the chosen Python interpreter, the source keys of plugins kept disabled after restart, and the safe-mode lock. A file that cannot be read keeps third-party plugins off instead of being overwritten.

`<userData>/plugins/session.json` records whether a third-party plugin process ran, whether `thirdPartyStaticContributions` was delivered, and whether the window stopped responding; it is written synchronously and removed on a normal quit. If it is still present at the next start and any risk flag is set, Kobrixa writes a safe-mode lock: third-party plugins stay paused and the app shows a banner until the user selects **Restore plugins**. A hung window keeps the marker even after a normal quit. Development plugins cannot be enabled, linked or reloaded during safe mode; they can still be disabled or unlinked.

The phase 1 methods are:

| Method            | Contract                                                                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize`      | Host request carrying API version, host-assigned plugin ID, locale and granted permissions; the plugin returns its API version and SDK identity.               |
| `command/execute` | Host request naming a contributed command; successful execution returns `null`. Plugins start on demand when a command is executed.                            |
| `shutdown`        | Host request for graceful shutdown; success returns `null`.                                                                                                    |
| `exit`            | Host notification requesting process exit after shutdown.                                                                                                      |
| `ui/showMessage`  | Plugin request with severity (`info`, `warning` or `error`) and message; requires `ui.notifications` and returns `null`. Messages appear in the Plugins panel. |
| `$/cancelRequest` | Notification identifying the request to cancel. JS/TS handlers receive an aborted signal; Python handlers receive asyncio task cancellation.                   |

The host derives caller identity from the bound channel, never from a plugin ID supplied by a message. Requests have timeouts; a plugin that does not finish within the cancellation grace period is terminated. A crash rejects pending commands without replaying them. A later explicit command can start the plugin again, but three process failures within five minutes stop further starts until the plugin is disabled and enabled again. Disabling a plugin unregisters its commands and stops its process.

These are **trusted local plugins**. Separate processes provide crash isolation; manifest permissions only restrict calls through Kobrixa and are **not an operating-system sandbox**. Plugin code can still access files and the network directly.

Plugin API **1.4.0** supports static languages, compiler frontend/backend declarations and `contributes.diagnosticHelp`; compatible 1.3.x manifests remain accepted. `kobrixa.basic-plus` provides language `bp`; the separate built-in `kobrixa.ev3` provides target `ev3-native`. Both declare IR version `{ min: 1, max: 1 }` and remain available in safe mode. Built-in plugins retain the phase 1 disable restrictions. Valid API 1.0, 1.1 and 1.2 plugins remain compatible, but external plugins declaring `frontends` or `backends` are invalid (`PLUGIN_E_FRONTEND_REQUIRES_BUILTIN` / `PLUGIN_E_BACKEND_REQUIRES_BUILTIN`). This release has no external compiler RPC.

The host resolves one enabled, valid provider for each language and target. Every conflicting provider is rejected with `PLUGIN_E_PROVIDER_CONFLICT`; no provider wins by load order. Recomputing a provider set excludes disabled providers and clears obsolete conflicts. The selected IR version is the maximum of the overlapping ranges. Missing/conflicting providers report `BUILD1001` before a worker starts; incompatible IR ranges report `BUILD1002`.

Frontend declarations supply entry and source extensions. Backend declarations supply artifact slots, kinds, media types, extensions, roles and required flags; the backend returns only slot/bytes. The host owns `ir` and `asset` slots and produces resource artifacts. A deployable backend must declare exactly one required, non-empty `deploy-main`. Compiler contributions are limited to 8 frontends and 8 backends per plugin and 16 artifact declarations per backend. IDs use `/^[a-z][a-z0-9-]{0,31}$/`; extensions use `/^[a-z0-9]{1,16}$/`. The committed JSON Schema describes structural validation; the host additionally validates extension subsets, IR ranges, unique slots and the main-artifact relationship.

Plugin API **1.3.0** adds `contributes.languageServices`. Only built-in plugins may declare it, including an empty array; development plugins receive `PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN`. The declaration must include `analysis`, match a frontend owned by the same plugin, and use exactly that frontend's source extensions. A plugin may declare at most eight services. Valid API 1.0, 1.1 and 1.2 plugins remain compatible.

The main process selects the enabled frontend owner for the validated project's language, independently of backend availability and IR compatibility. Its `pluginId:language` key selects a compiled-in worker factory and browser companion. Each workspace has independent analysis/Quick Fix and completion workers. All messages and accepted results carry a host-issued binding epoch; provider generation, routing changes or either worker restarting invalidates both channels and requires a full sync. Ordinary typing changes document revisions only.

Workers retain native semantic state and publish provider-neutral symbols, packed tokens and occurrences, completion visibility groups, and editor results. The host stamps diagnostic sources. Basic Plus completion filtering, structural edit checks and formatting live in its browser companion; generic renderer and shared modules do not import Basic Plus. Missing services show a language status row; configuration conflicts show a workspace banner naming the plugins. Both link to plugin settings. Built-in plugins remain required. Static languages use strict version-1 tokenizer/configuration JSON and the shared protocol validator. Runtime publishes an atomic revisioned catalog; one renderer store and registrar manage all live document and review models. Builtin raw JSON is bundled into main, not fetched from the repository. Catalog revisions are separate from service epochs. The static risk marker is synchronously persisted before third-party delivery and remains sticky until clean exit; write failure blocks that delivery. No static-only process or handshake is started. See [Static language plugins](plugin-static-languages.md) for authoring, conflict resolution, bounded resource accounting and recovery. External language-service RPC is not implemented.

The host assigns `Diagnostic.source`, and diagnostic help is scoped to that source. The `devices` API remains planned for phase 3. See the [plugin design](../superpowers/specs/2026-10-14-plugin-system-design.md).

### Language-service acceptance

Run `pnpm test:desktop:smoke` from the repository root. Its runner calls `checkCompletionPerformance` alongside language-features, indentation and highlighting checks; loading the performance module alone does not run the checks. Keep the thresholds unchanged: **warm completion p95 ≤100 ms, new variable ≤200 ms, 30,000 lines ≤300 ms**. If Electron cannot run locally, record the actual error and leave performance and UI acceptance pending for a machine that can run it.

Manual acceptance in both English and Traditional Chinese:

- [ ] Distinguish missing services from conflicts; list conflicting plugins and open plugin settings from each status action. An available service with no diagnostics shows no unavailable row.
- [ ] Confirm status changes preserve document contents, JSON formatting and Basic Plus lexical highlighting; recovery starts analysis without typing.
- [ ] Verify completion candidates and local scope visibility inside and outside functions **while analysis is pending**, and check API-call signature help during that pending period.
- [ ] Exercise Basic Plus completion (including closing-keyword indentation), Quick Fix, semantic tokens, hover, signature help, definition, references, rename, outline/breadcrumbs, and document/range formatting.
- [ ] Run the full Electron smoke and verify all three completion latency limits above; unit/integration passes do not establish performance acceptance.

## Project manifest

Projects can use `kobrixa.json`; projects without a manifest default to `bp` / `ev3-native`. Unknown fields are allowed for forward compatibility; invalid known fields are errors.

```json
{
  "schemaVersion": 1,
  "name": "line-follower",
  "language": "bp",
  "entry": "src/main.bp",
  "target": "ev3-native",
  "assets": ["assets/**/*"],
  "outputDir": "build"
}
```

Contract:

- `schemaVersion`: positive integer; v1 accepts only `1`.
- `name`: non-empty project and default EV3 program name.
- `language`: validated ID resolved by an enabled frontend provider.
- `entry`: project-relative source path that must remain inside the project root.
- `target`: validated ID resolved by an enabled backend provider.
- `assets`: project-relative files or glob patterns; resolved paths must stay inside the project root. Each pattern is limited to 4,096 characters, 64 opening braces or parentheses and 64 closing ones (including escaped or quoted characters). All asset patterns together may expand to at most 256 patterns; this does not limit how many files a wildcard matches. Oversized inputs produce a manifest diagnostic before file discovery, rather than selecting a partial asset set. Ordinary alternatives and numeric ranges remain supported.
- `outputDir`: literal project-relative directory, not a glob pattern; it must not equal or contain the source root.

## Compiler contracts

The frontend contract is defined in [`packages/compiler/src/contracts.ts`](https://github.com/Kingsley1116/Kobrixa/blob/main/packages/compiler/src/contracts.ts). Only `bp` currently has an implementation:

```ts
interface LanguageFrontend {
  id: string;
  compile(input: SourceProject, signal: AbortSignal): Promise<FrontendResult>;
}

interface FrontendResult {
  ir?: KobrixaIR;
  diagnostics: Diagnostic[];
}
```

`KobrixaIR` is versioned and typed. It carries declarations, primitive and aggregate types, functions, control-flow blocks, EV3 API calls, resource references, and source spans. Frontends must not inject raw backend bytecode. IR validation runs before backend lowering and rejects invalid control flow, unresolved symbols, unsupported types, and invalid EV3 operations.

The EV3 backend optimizes native output by default: it omits jumps to the next block, simplifies literal boolean branches, uses the shortest valid relative-jump encoding, and reuses scratch memory between IR instructions. It also removes functions unreachable from the program entry or a reachable thread start before expanding recursion, forwards adjacent scalar temporary results to local destinations of the same type, and shares storage between same-type IR temporaries with non-overlapping lifetimes. Storage reuse requires a single pure definition that precedes every read on every path; arrays, named locals, parameters, call/API outputs, and values passed as output arguments keep independent slots. Input and output operands of one IR instruction never share a reusable slot.

All source functions are lowered for diagnostics before pruning, so errors in unused functions are still reported. Global declarations and runtime support storage retain their layout and initialization. Values needed for array cleanup remain live through the function epilogue, and background-thread loop yields are preserved. `new EV3Backend({ optimize: false })` disables all optimizations for diagnostic comparisons. Tools that invoke subcalls directly can use `retainFunctions: ["helper"]` to keep additional functions and their call/thread dependencies without disabling optimization; names are case-insensitive and unknown names are errors in either mode. Both modes leave the input IR unchanged; the `.ir.json` artifact describes frontend output, while `.lst` records only emitted functions and support objects, their current object IDs, and local-memory sizes. Object IDs may change when functions are pruned.

The public build result is:

```ts
interface CompileResult {
  buildId: string;
  target: string;
  deploy?: "ev3";
  runtimeDirectory?: string;
  success: boolean;
  diagnostics: Diagnostic[];
  artifacts: BuildArtifact[];
}

interface Diagnostic {
  code: string;
  helpKey?: string;
  severity: "error" | "warning" | "info";
  file: string;
  range: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  message: string;
}

interface BuildArtifact {
  slot: string;
  kind: string;
  role: "deploy-main" | "deploy-asset" | "aux";
  mediaType: string;
  path: string;
  sha256: string;
  byteLength: number;
  remotePath?: string;
}
```

Line and column numbers are one-based. A successful build has no error diagnostics, contains every required artifact and, when deployable, exactly one non-empty main. A successful non-deployable build remains successful; Run and Upload explain why it cannot deploy. Failed or cancelled results contain no artifacts. `BUILD1003` reports undeclared, duplicate, missing, unsafe, colliding or oversized artifacts.

`compileToMemory` is shared by BuildSession and simulation. It runs the frontend, checks the actual IR version and IR validity, runs the backend and validates artifacts without writing outputs. Simulation still requires backend success and supports at most 4 entries and 64 resource files totaling 1 MiB; it uses captured sources/resources and the simulator's actual IR support, not a backend simulation capability.

Build limits are 64 backend artifacts, 1024 artifacts including resources, 64 MiB per artifact, 256 MiB total, 128 UTF-8 bytes per filename and 512 UTF-8 bytes per relative path. Names are checked after Unicode NFC normalization and lowercasing; `.kobrixa*` names are reserved. Resource traversal and symbolic links are rejected. Sizes are accumulated while reading/writing and hashes come from the actual staging contents.

Outputs remain at `outputDir/<name>.<extension>` and `outputDir/assets/<relative-path>`, including the existing `<name>.rbf`, `<name>.ir.json` and `<name>.lst` paths. The host validates all staging files under `.kobrixa-<buildId>.tmp` before replacing final files in aux → deploy-asset → deploy-main order. Cancellation before the first rename reports `BUILD0001`; once renaming starts the sequence finishes. An I/O failure reports `BUILD9000` with an empty artifact list; the disk may contain mixed generations. This is not a multi-file atomic transaction.

Within one process, builds use FIFO queues keyed by `realpath(outputDir)`. During commit, `.kobrixa-build.lock` is opened with `wx` and contains `{ pid, startedAt }`. A nonexistent PID, or malformed contents older than 60 seconds, can be reclaimed. A live lock is polled every 100 ms for at most 5 seconds, then `BUILD1004` is returned. Release compares ownership and removes only the caller's lock. PID checks do not guarantee correctness between different computers sharing a network disk. Stale-lock reclamation compares contents and then unlinks the file, which is not atomic: if two processes reclaim the same stale lock concurrently, rare scheduling can let one delete the other's newly created lock; 2A accepts this limitation.

Deployment requires a supported `deploy` capability (`ev3` today), otherwise `BUILD1005`. Every selected file is read into memory and checked against its SHA-256 before any upload; missing or changed files report `BUILD1006`. Resources are sorted by remotePath and uploaded before the main, using those same verified bytes. Folder/runtimeDirectory, the device lock and skipping unchanged resources are preserved. Device transfers themselves are not atomic.

The browser-safe `@kobrixa/compiler/diagnostic-help` subpath contains the shared English and Traditional Chinese diagnostic catalog; the original compiler entrypoint is unchanged. Producers set optional `helpKey` values when one code has distinct causes. Consumers fall back to the code's general entry for missing or unknown keys and retain the raw message for unknown codes. Tests compare production codes with the catalog and validate the examples and documentation links.

Quick Fix requests carry the workspace, accepted analysis session/revision/version, file, diagnostic and a cancellation ID. The language worker derives insertion candidates from parser tokens and block metadata, reparses an in-memory copy, and caches validated candidates per analysis version. Queries are bounded to 1,000,000 UTF-16 code units and at most two parses of that file; they never run full project analysis in the renderer. Cancellation marks a shared flag without cancelling another query or invalidating accepted analysis. Edits recheck the target model version, source snapshot and disk conflicts before one undo group is applied through the normal document/draft/save path. Rename continues to validate all project source files. A dedicated documentation IPC accepts catalog selectors only; the main process constructs official URLs.

`runtimeDirectory` records the entry source's `Folder` destination. Asset artifacts carry a project-relative `remotePath` so deployment preserves the paths expected by the program.

## Device contract

The core lifecycle methods below are an excerpt from [`packages/device/src/contracts.ts`](https://github.com/Kingsley1116/Kobrixa/blob/main/packages/device/src/contracts.ts):

```ts
interface DeviceTransport {
  discover(signal: AbortSignal): Promise<DeviceDescriptor[]>;
  connect(target: DeviceDescriptor, signal: AbortSignal): Promise<DeviceSession>;
}

interface DeviceSession {
  readonly descriptor: DeviceDescriptor;
  readonly connected: boolean;
  disconnect(): Promise<void>;
  upload(remotePath: string, data: Uint8Array, signal: AbortSignal): Promise<void>;
  run(remotePath: string, signal: AbortSignal): Promise<void>;
  stop(programName?: string, signal?: AbortSignal): Promise<void>;
  delete(remotePath: string, signal: AbortSignal): Promise<void>;
}
```

Only one operation may mutate a session at a time. Disconnect is idempotent. Every operation has a bounded timeout and returns a structured category: `permission`, `not-found`, `connection`, `timeout`, `protocol`, `transfer`, `device`, `cancelled`, or `internal`. UI text is localized outside the device layer.

The same session also exposes `list`, `download`, `uploadStream`, `createDirectory` and `rename` for remote file management. Streaming transfers report progress; the desktop main process coordinates batch previews, overwrite confirmations and exclusive session access.

## Desktop packaging and release

Electron Forge bundles the renderer and main/preload entry points into `app.asar`, with native `.node` files unpacked. The packaging hook includes the target platform's `node-hid` prebuilds, the project `LICENSE` and versioned `THIRD-PARTY-NOTICES.txt`. The notices list every package referenced by the bundled source maps plus the copied runtime dependencies; packaging fails when a package has no license file. Electron's `LICENSE.electron.txt` and `LICENSES.chromium.html` sit beside the executable (in `Kobrixa.app/Contents/Resources` on macOS), and HIDAPI license files remain under `node-hid`.

Ordinary CI and local packaging do not require credentials. Tag releases validate the commit and package versions, freeze the macOS/Windows signing switches in the draft, and require common checks and desktop tests before signing. macOS uses Developer ID, Hardened Runtime and notarization for `com.kobrixa.ide`; Windows sends a one-day temporary artifact to SignPath and accepts changes only to `kobrixa.exe`.

Enabled signing fails closed. Applications are verified before archiving and after extraction, including signatures, file contents, executable permissions, symlinks and native modules. Only then are SHA-256 files generated. The final draft contains Windows NSIS/ZIP, Linux AppImage/tar.gz, macOS DMG, update metadata and one SHA256SUMS.txt (plus an update ZIP for signed macOS), and remains unpublished until a maintainer publishes it. Credential handling, approval and retry behavior are defined in the [code signing policy](../en/code-signing.md).

## State and safety rules

- Each build receives a new session; compiler state is never global.
- Paths are canonicalized and confined to the project root except for user-approved import/export locations.
- Existing successful artifacts are replaced only by atomic rename after validation.
- Device writes require an active session and explicit user action.
- Logs exclude source contents and personal paths by default.
- Production windows load packaged local content only. Renderer sandboxing and `contextIsolation` remain enabled, and `nodeIntegration` remains disabled.
- The preload bridge exposes only documented, task-specific methods through `contextBridge`; it never exposes raw `ipcRenderer` or Node.js primitives.
- The main process validates the IPC sender and payload before every privileged filesystem, compiler, or device operation.

These boundaries follow Electron's [security recommendations](https://www.electronjs.org/docs/latest/tutorial/security).
