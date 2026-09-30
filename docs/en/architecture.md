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
          ├─ Workspace service → Language frontend (.bp in v1)
          │                       → Typed KobrixaIR + validation
          │                       → EV3 backend → .rbf artifact
          └─ Device service ────────────────────→ USB HID / Wi-Fi
```

The React renderer owns presentation state only and has no direct access to Node.js or Electron APIs. A narrow preload API uses `contextBridge` to invoke validated IPC handlers in the Electron main process. Node.js services own filesystem access, compiler execution, cancellation, device sessions, and structured errors. No compiler phase may depend on the UI.

## Repository boundaries

- `apps/desktop`: Electron main and preload processes, React renderer, Monaco integration, localization, and user workflows.
- `apps/web`: product pages, bilingual documentation, Gallery UI and its Cloudflare Worker. Desktop editing and compilation do not depend on this service.
- `packages/compiler`: build-session orchestration and diagnostic aggregation.
- `packages/ir`: versioned IR types, validation, and serialization used by language frontends and backends.
- `packages/backend-ev3`: deterministic EV3 VM lowering and `.rbf` packaging.
- `packages/device`: transport-neutral device operations with USB and Wi-Fi implementations.
- `frontends/basic-plus`: clean-room lexer, parser, semantic analysis, and IR lowering.
- `tools/release`: archive validation, signing verification and GitHub Release draft management. `.github/workflows/release.yml` coordinates native platform builds.

Dependencies point inward toward shared contracts. The compiler and device packages must be usable by a future Node.js CLI without importing Electron desktop code.

## Project manifest

Each project uses `kobrixa.json`. Unknown fields are allowed for forward compatibility; invalid known fields are errors.

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
- `language`: v1 accepts `bp`; planned values are `python`, `typescript`, and `cpp`.
- `entry`: project-relative source path that must remain inside the project root.
- `target`: v1 accepts only `ev3-native`.
- `assets`: project-relative files or glob patterns; resolved paths must stay inside the project root.
- `outputDir`: project-relative directory; it must not equal or contain the source root.

## Compiler contracts

The frontend contract is defined in [`packages/compiler/src/contracts.ts`](https://github.com/Kingsley1116/Kobrixa/blob/main/packages/compiler/src/contracts.ts). Only `bp` currently has an implementation:

```ts
interface LanguageFrontend {
  id: "bp" | "python" | "typescript" | "cpp";
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
  runtimeDirectory?: string;
  success: boolean;
  diagnostics: Diagnostic[];
  artifacts: BuildArtifact[];
}

interface Diagnostic {
  code: string;
  severity: "error" | "warning" | "info";
  file: string;
  range: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  message: string;
}

interface BuildArtifact {
  kind: "rbf" | "ir" | "listing" | "asset";
  path: string;
  sha256: string;
  remotePath?: string;
}
```

Line and column numbers are one-based in public results. `success` is true only when no error diagnostic exists and a valid `rbf` artifact was committed atomically. Temporary output is removed after failure or cancellation.

`runtimeDirectory` records the entry source's `Folder` destination. Asset artifacts carry a project-relative `remotePath` so deployment preserves the paths expected by the program. Each output file is committed through a same-filesystem rename; this is not a transaction across the complete set of output files.

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

Electron Forge bundles the renderer and main/preload entry points into `app.asar`, with native `.node` files unpacked. The packaging hook includes the target platform's `node-hid` prebuilds, the project `LICENSE` and versioned `THIRD-PARTY-NOTICES.txt`. Electron/Chromium and HIDAPI license files remain in the distribution.

Ordinary CI and local packaging do not require credentials. Tag releases validate the commit and package versions, freeze the macOS/Windows signing switches in the draft, and require common checks and desktop tests before signing. macOS uses Developer ID, Hardened Runtime and notarization for `com.kobrixa.ide`; Windows sends a one-day temporary artifact to SignPath and accepts changes only to `kobrixa.exe`.

Enabled signing fails closed. Applications are verified before archiving and after extraction, including signatures, file contents, executable permissions, symlinks and native modules. Only then are SHA-256 files generated. The final draft contains three archives and three checksum files, and remains unpublished until a maintainer publishes it. Credential handling, approval and retry behavior are defined in the [code signing policy](../en/code-signing.md).

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
