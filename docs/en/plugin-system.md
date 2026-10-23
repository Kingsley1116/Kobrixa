# Plugin system (development preview)

Kobrixa's plugin system lets trusted local code add commands, editor languages and device tools without changing the core application. This page is the entry point: it explains the moving parts, how a plugin is declared and loaded, and where each capability is documented in detail. The current Plugin API is **1.5.0**.

> **Trust model.** Plugins are trusted local programs. Separate processes provide crash isolation and manifest permissions restrict calls _through Kobrixa_, but neither is an operating-system sandbox. Plugin code can still read files and use the network directly. Only load plugins from authors you trust.

## Components

| Component                                                    | Role                                                                                                                                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`packages/plugin-protocol`](../../packages/plugin-protocol) | `@kobrixa/plugin-protocol`. Zod is the authoring source for the manifest, JSON-RPC methods, limits and error codes. The committed `schema/plugin-protocol.schema.json` is the cross-language contract. |
| [`packages/plugin-runtime`](../../packages/plugin-runtime)   | `@kobrixa/plugin-runtime`. Manifest validation, the registry, command routing, process supervision, static-language catalog and device resources. It does not depend on Electron.                      |
| `apps/desktop/src/main/plugins`                              | The desktop `PluginController`: developer mode, native dialogs, Python probing, logs, the session marker, safe mode and the built-in allowlist.                                                        |
| [`packages/plugin-sdk-js`](../../packages/plugin-sdk-js)     | `@kobrixa/plugin-sdk` for JS/TS plugins: `definePlugin`, `runPlugin`, `context.commands`, `context.ui`, `context.devices`.                                                                             |
| [`sdks/python`](../../sdks/python/README.md)                 | `kobrixa-plugin-sdk` (imported as `kobrixa`) for Python 3.10+, standard library only: `Plugin`, `@plugin.command`, `ctx.ui`, `ctx.devices`.                                                            |
| [`plugins/`](../../plugins)                                  | Built-in manifests (`basic-plus`, `ev3`) and the [runnable samples](../../plugins/samples/README.md).                                                                                                  |

```text
renderer (Settings → Plugins, editor, panels)
      │ source keys, command IDs, booleans — never paths or executables
      ▼
main: PluginController ── PluginManager / registry / supervisor
      │                         │
      │ utilityProcess +        │ stdin/stdout +
      │ MessagePort             │ Content-Length frames
      ▼                         ▼
  JS/TS plugin              Python plugin          static plugin: no process
```

The host derives caller identity from the bound channel, never from a plugin ID in a message. The renderer only sends identifiers; the main process enforces developer mode, safe mode and shutdown after any dialog closes.

## Plugin kinds

| `runtime.kind` | Who can use it | Process                                            | Typical contributions                                                   |
| -------------- | -------------- | -------------------------------------------------- | ----------------------------------------------------------------------- |
| `node`         | Development    | Electron `utilityProcess`, started on demand       | Commands, device consumers, static languages, diagnostic help           |
| `python`       | Development    | User-selected local interpreter, started on demand | Commands, device consumers, static languages, diagnostic help           |
| `static`       | Development    | None — JSON data only                              | Static languages, diagnostic help                                       |
| `builtin`      | Host allowlist | Compiled into the app                              | Compiler frontends/backends, language services, the EV3 device provider |

Shipped built-ins are `kobrixa.basic-plus` (language `bp`), `kobrixa.ev3` (backend `ev3-native`) and `kobrixa.device-ev3` (device provider). Built-ins remain available in safe mode. Required built-ins cannot be disabled (`PLUGIN_E_BUILTIN_REQUIRED`).

## The manifest

Every plugin folder contains `kobrixa-plugin.json` (at most 64 KiB). Unknown top-level fields are allowed for forward compatibility; invalid known fields are errors. A minimal command plugin, taken from the [TypeScript sample](../../plugins/samples/hello-ts/kobrixa-plugin.json):

```json
{
  "id": "kobrixa-samples.hello-ts",
  "version": "0.1.0",
  "apiVersion": "^1.0.0",
  "displayName": { "en": "Hello (TypeScript sample)", "zh-TW": "問候（TypeScript 範例）" },
  "runtime": { "kind": "node", "entry": "dist/index.cjs" },
  "activationEvents": ["onCommand:kobrixa-samples.hello-ts.greet"],
  "permissions": ["ui.notifications"],
  "contributes": {
    "commands": [
      { "id": "kobrixa-samples.hello-ts.greet", "title": { "en": "Say hello", "zh-TW": "打招呼" } }
    ]
  }
}
```

| Field              | Meaning                                                                                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | Namespaced plugin ID such as `acme.tools`. `kobrixa.core` is reserved (`PLUGIN_E_RESERVED_ID`); duplicate IDs are rejected.                                                                                    |
| `version`          | The plugin's own semver.                                                                                                                                                                                       |
| `apiVersion`       | A semver range (`1.2.3`, `^1.2.3` or `~1.2.3`). The host's API version must satisfy it, otherwise `PLUGIN_E_API_VERSION`. Declare the lowest version whose features you use, for example `^1.5.0` for devices. |
| `displayName`      | A single-line string, or `{ "en": …, "zh-TW"?: … }`.                                                                                                                                                           |
| `runtime`          | `{ "kind": "node" \| "python", "entry": "<relative path>" }` or `{ "kind": "static" }`. The entry is a package-relative path without `..`, hidden or absolute segments.                                        |
| `activationEvents` | `onCommand:<command-id>` entries (up to 64). Processes start only when a matching command runs.                                                                                                                |
| `permissions`      | Up to 16 of `ui.notifications`, `devices.read`, `devices.connect`, `devices.control`. Calls without the permission fail with `PLUGIN_E_PERMISSION_DENIED`.                                                     |
| `requires.devices` | 1–5 unique `{ capability, required }` entries that describe the device capabilities a consumer needs.                                                                                                          |
| `contributes`      | The contributions in the next section.                                                                                                                                                                         |

### Contributions

| `contributes.*`    | Since API | Available to   | Details                                                                                                                                   |
| ------------------ | --------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `commands`         | 1.0       | node / python  | Up to 64. Each ID must start with the plugin ID followed by `.` (`PLUGIN_E_COMMAND_NAMESPACE`). See [Commands](#commands-and-lifecycle).  |
| `diagnosticHelp`   | 1.2       | all            | One `{ "version": 1, "path": "…json" }` resource. See [samples: diagnostic help](../../plugins/samples/README.md#author-diagnostic-help). |
| `languages`        | 1.4       | all            | Static Monarch-style tokenizer and editor configuration JSON. See [Static language plugins](plugin-static-languages.md).                  |
| `frontends`        | 1.1       | built-in only  | Compiler frontends. Otherwise `PLUGIN_E_FRONTEND_REQUIRES_BUILTIN`. See [compiler contracts](architecture.md#compiler-contracts).         |
| `backends`         | 1.1       | built-in only  | Compiler backends and artifact slots. Otherwise `PLUGIN_E_BACKEND_REQUIRES_BUILTIN`.                                                      |
| `languageServices` | 1.3       | built-in only  | Analysis/completion/… services bound to a same-owner frontend. Otherwise `PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN`.                    |
| `deviceProviders`  | 1.5       | host allowlist | Only `kobrixa.device-ev3`. Otherwise `PLUGIN_E_DEVICE_PROVIDER_REQUIRES_BUILTIN`.                                                         |

Built-in-only fields are rejected **even as an empty array or `null`**; declaring one makes the whole development plugin invalid. Structural JSON Schema validation is shared by TypeScript and Python; the host registry applies further semantic checks (uniqueness, ownership, extension-set equality, trusted source), so passing the schema alone does not guarantee the host accepts a manifest.

## Commands and lifecycle

JS/TS ([sample](../../plugins/samples/hello-ts/src/index.ts)):

```ts
import { definePlugin, runPlugin } from "@kobrixa/plugin-sdk";

void runPlugin(
  definePlugin({
    activate(context) {
      context.commands.register("kobrixa-samples.hello-ts.greet", () =>
        context.ui.showMessage(context.locale === "zh-TW" ? "你好" : "Hello"),
      );
    },
  }),
);
```

Python ([sample](../../plugins/samples/hello-python/main.py)):

```python
from kobrixa import Plugin

plugin = Plugin()


@plugin.command("kobrixa-samples.hello-python.greet")
async def greet(ctx):
    await ctx.ui.show_message("你好" if ctx.locale == "zh-TW" else "Hello")


if __name__ == "__main__":
    plugin.run()
```

The wire protocol is JSON-RPC 2.0:

| Method              | Direction     | Purpose                                                                                                 |
| ------------------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `initialize`        | host → plugin | API version, host-assigned plugin ID, locale (`en`/`zh-TW`), granted permissions; returns SDK identity. |
| `command/execute`   | host → plugin | Runs a contributed command; success returns `null`. Commands take no arguments.                         |
| `$/cancelRequest`   | host → plugin | Cancels a running command (JS `AbortSignal`, Python task `cancel()`).                                   |
| `shutdown` / `exit` | host → plugin | Orderly stop.                                                                                           |
| `ui/showMessage`    | plugin → host | `info` / `warning` / `error` message shown in Settings → Plugins; requires `ui.notifications`.          |
| `devices/*`         | plugin → host | The device broker API (API 1.5); see [Device plugins](plugin-devices.md).                               |
| `events/deliver`    | host → plugin | Subscription events, such as device samples.                                                            |

Lifecycle rules that every plugin should expect:

- A process starts when one of its commands runs, not at application start. Static plugins never start a process.
- Cancellation has a five-second grace period; a plugin that does not stop is terminated.
- A crash rejects pending requests and **never replays** them. Three process failures within five minutes stop further starts until the plugin is disabled and enabled again (`PLUGIN_E_CRASH_LOOP`).
- Disable unregisters the plugin's contributions and stops its process. Reload re-reads the folder and restarts the plugin.
- Python stdout carries protocol frames only; write logs to stderr. Constructing `Plugin()` redirects `print()` to stderr. Logs are kept in memory (256 KiB per plugin, 4 MiB total) and mirrored to the terminal as `[plugin <id>] …`.

## Developing and loading a plugin

1. Prepare the toolchain and SDKs as in the [samples README](../../plugins/samples/README.md#prepare-the-samples). JS/TS plugins are bundled to the file named by `runtime.entry`; Python plugins need the SDK installed in the interpreter Kobrixa will launch.
2. Open **Settings → Plugins**, select **Turn on developer mode** and confirm the native dialog.
3. Select **Link folder…** and pick the plugin folder. Kobrixa previews the ID, runtime and manifest problems before linking.
4. For Python, choose an interpreter under **Python interpreter**; each candidate shows whether the SDK is installed.
5. Run a command, then use **Reload**, **Show log**, **Disable/Enable** and **Unlink** while iterating.

For one session you can skip the panel with launch options (not saved):

```sh
pnpm dev -- --plugin-dev-dir="$PWD/path/to/plugin" --plugin-python="$(command -v python3)"
```

Separate multiple folders with `:` on macOS/Linux and `;` on Windows. `--safe-mode` keeps all third-party plugins off for the session.

## State, safe mode and recovery

- `<userData>/plugins/state.json` stores developer mode, linked folders, the Python choice, sources kept disabled after restart and the safe-mode lock. An unreadable file keeps third-party plugins off rather than being overwritten (`PLUGIN_E_STATE_CORRUPT`); a failed write reports `PLUGIN_E_STATE_SAVE`.
- `<userData>/plugins/session.json` is written synchronously while a third-party process runs or third-party static contributions are delivered, and removed on normal quit. If it survives an unclean exit, or the window stopped responding, the next start pauses all third-party plugins and shows a banner.
- In safe mode, built-ins (Basic Plus, EV3 compiler and device recovery) stay available; development plugins can be disabled or unlinked but not enabled, linked or reloaded (`PLUGIN_E_SAFE_MODE`). **Restore plugins** ends a lock-induced safe mode; it cannot end a `--safe-mode` session.

Details: [architecture: plugins](architecture.md#plugins-development-preview) and [samples: recovery](../../plugins/samples/README.md#recovery).

## Common error codes

| Code                                                        | Typical cause                                                                            |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `PLUGIN_E_MANIFEST`                                         | Invalid manifest, static-runtime semantics or same-owner extension mismatch.             |
| `PLUGIN_E_API_VERSION`                                      | The host's API version does not satisfy `apiVersion`.                                    |
| `PLUGIN_E_*_REQUIRES_BUILTIN`                               | A development plugin declared a built-in-only contribution.                              |
| `PLUGIN_E_ENTRY` / `PLUGIN_E_LAUNCH`                        | The entry file is missing or the process could not start.                                |
| `PLUGIN_E_PYTHON_UNUSABLE`                                  | The selected interpreter is not Python 3.10+ or cannot run.                              |
| `PLUGIN_E_HANDSHAKE` / `PLUGIN_E_PROTOCOL`                  | `initialize` failed or a message broke the protocol (for example stray stdout).          |
| `PLUGIN_E_COMMAND_NAMESPACE` / `PLUGIN_E_DUPLICATE_COMMAND` | A command ID is outside the plugin namespace or registered twice.                        |
| `PLUGIN_E_PERMISSION_DENIED`                                | The call needs a permission the manifest did not request.                                |
| `PLUGIN_E_CANCELLED` / `PLUGIN_E_TIMEOUT`                   | The request was cancelled or exceeded its deadline.                                      |
| `PLUGIN_E_CRASHED` / `PLUGIN_E_CRASH_LOOP`                  | The process exited; repeated failures blocked further starts.                            |
| `PLUGIN_E_DEVELOPER_MODE` / `PLUGIN_E_SAFE_MODE`            | The action needs developer mode, or is blocked in safe mode.                             |
| `PLUGIN_E_STATIC_LANGUAGE*`                                 | See [Static language plugins](plugin-static-languages.md#ownership-fallback-and-errors). |
| `PLUGIN_E_DEVICE_*`                                         | Device business results; see [Device plugins](plugin-devices.md).                        |

The authoritative list is in [`packages/plugin-runtime/src/errors.ts`](../../packages/plugin-runtime/src/errors.ts) and [`packages/plugin-protocol/src/business-result.ts`](../../packages/plugin-protocol/src/business-result.ts).

## API versions

| Version | Adds                                                                                                |
| ------- | --------------------------------------------------------------------------------------------------- |
| 1.0     | Manifest, commands, `ui.notifications`, JS and Python SDKs.                                         |
| 1.1     | Built-in compiler `frontends` / `backends` and artifact contracts.                                  |
| 1.2     | Host-stamped `Diagnostic.source` and `contributes.diagnosticHelp`.                                  |
| 1.3     | Built-in `languageServices`.                                                                        |
| 1.4     | `runtime.kind: "static"` and static `languages`.                                                    |
| 1.5     | Device broker: `devices.*` permissions, `requires.devices`, `devices/*` RPC, built-in EV3 provider. |

Compatible 1.x manifests keep loading. Planned next: declarative UI panels (1.6) and typed settings and bounded record storage (1.7), followed by migrating Motor test and Sensor Lab onto the public API. Until then these APIs are unavailable to plugins. The design record is in [`docs/superpowers/specs`](../superpowers/specs/2026-10-14-plugin-system-design.md), with stage 3 in the [stage 3 design](../superpowers/specs/2026-10-17-plugin-system-stage-3-design.md).

## Testing

```sh
pnpm test                 # protocol, runtime and SDK unit tests
pnpm test:python-sdk      # Python SDK schema, framing and protocol tests
pnpm test:plugins:smoke   # real Electron with both samples, crash isolation and quit cleanup
pnpm test:static-languages  # static-language contract and boundary checks
pnpm test:device-broker   # device broker conformance
```

Python runners look for `KOBRIXA_TEST_PYTHON`, then `python3` and `python`. See [Plugin smoke](../../tests/desktop/README.md#plugin-smoke).

## Related documents

- [Plugin samples](../../plugins/samples/README.md) — step-by-step TypeScript and Python walkthrough, diagnostic help.
- [Python SDK](../../sdks/python/README.md) — install, API and cancellation.
- [Static language plugins](plugin-static-languages.md) — grammar format, limits, ownership.
- [Device plugins](plugin-devices.md) — permissions, motion safety, subscriptions, timeouts.
- [Architecture: plugins](architecture.md#plugins-development-preview) — host internals and compiler contracts.
