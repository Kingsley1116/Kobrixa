# Roadmap

## Current delivery stage

Basic Plus compilation, the desktop editor, USB/Wi-Fi transports, remote file management and three-platform installer/archive packaging and automatic updates are implemented. Published download availability is determined by each GitHub Release. Physical EV3 acceptance is confirmed by the maintainer. Signing is deferred beyond 1.0.0; clean-machine installation and release-artifact checks remain required.

Kobrixa also includes the [Sensor Lab](sensor-lab.md), [motor testing](motor-test.md) and [cloud collaboration](collaboration.md). Automated tests for these features do not replace physical EV3 acceptance.

## Phase 0 — foundation in place

- Electron, React, TypeScript and Monaco run in a pinned Node.js/pnpm workspace.
- Compiler, IR, backend and device packages use shared versioned contracts.
- CI selects website or desktop checks from the Git diff; desktop packaging targets Windows x64, macOS arm64 and Linux x64.
- Product documentation and tutorials are available in English and Traditional Chinese.

Continue reviewing dependency licenses, brand/asset provenance and bilingual links before public releases. Automated builds do not establish trademark rights or replace those reviews.

## v1 — release acceptance

The implemented path is `.bp` → validated `KobrixaIR` → native `.rbf`, with Monaco editing, projects, bilingual offline diagnostic explanations, user-selected Quick Fix with Undo, asset deployment and remote file operations. The online [diagnostic index](/docs/diagnostics?lang=en) shares explanations with the IDE; Quick Fix offers only unambiguous syntax corrections. The remaining rollout order is:

1. Review the exact source, history, assets and clean-machine installation results, then verify the Release draft, installers, archives, update metadata and checksums.
2. Publish 1.0.0 with macOS, Windows and Linux explicitly unsigned. Physical EV3 acceptance was confirmed by the maintainer on 2026-10-12; the simulator is excluded from official releases.
3. Add signing in a later release when credentials and approvals are ready. Until then, unsigned macOS builds use manual download updates.

Exit: every criterion in the [product specification](../en/product.md) and [device specification](../en/device-support.md) passes, and each published signing claim has verified evidence. Follow the [signing policy](../en/code-signing.md); enabling a mode must never silently fall back to an unsigned artifact.

## v1.x — hardening

- Plugin system phase 1 (development preview): protocol, JS/TS and Python SDKs, command and notification API, settings panel, and the Basic Plus frontend registered as a built-in plugin. Third-party plugins load only in development mode. See the [plugin design](../superpowers/specs/2026-10-14-plugin-system-design.md).
- Plugin system stage 2 (implemented; acceptance pending): built-in frontend/backend selection, generic `artifacts[]`, diagnostic source/help, built-in language services and API 1.4.0 static languages. See [architecture and contracts](architecture.md) and [static language plugins](plugin-static-languages.md). External compiler and language-service RPC remain future work.
- Plugin system stage 3 (future): public panel/settings/device APIs and migration of built-in features, including motor testing through public APIs.
- Plugin system stage 4 (future): formal plugin packaging, managed runtimes, generated Python bindings, dependency resolution/version rollback and general third-party release after acceptance.
- Expand `.bp` compatibility cases and EV3 API coverage.
- Improve completion, formatting, performance, accessibility, localization, and recovery UX.
- Add a headless Node.js `kobrixa` CLI over the same compiler and device packages.
- Cloud collaboration (included): invite-code rooms for real-time co-editing, shared file trees, chat and single-holder EV3 control through the Kobrixa-operated service. See [cloud collaboration](../en/collaboration.md).

### Plugin stage 2 acceptance

Implementation is delivered; stage-2 acceptance is not yet complete. The [master specification](../superpowers/specs/2026-10-14-plugin-system-design.md) records acceptance results and remaining gates. V01–V03 manual acceptance remains pending; V04 remains a recorded environmental exception:

- **S09:** isolated hostile-tokenization acceptance passed outside the sandbox on 2026-10-17 on macOS arm64 (Darwin 24.6.0), using `tests/desktop/static-languages-stress.mjs` and the `hostile-tokenization` / `recover-hostile` phases in `tests/desktop/static-languages-run.mjs` (`pnpm test:static-languages:smoke`). The [stress log, lines 112–114](../../.superpowers/sdd/stage-2-closeout/stress-smoke.log#L112-L114), records parent-enforced termination about 5 s after the renderer entered the regex (`code: null`, `signal: SIGKILL`), recovery with reason `unclean-exit`, the hostile plugin individually disabled and still unregistered after Restore, working builtin Basic Plus tokenization, and 6.1 s of added wall time. The `unresponsive` event was not observed within the 5 s window and is optional by design. This acceptance and the resource limits do not prove arbitrary rules safe or provide complete ReDoS protection. Other platforms remain unverified.
- **V01:** manual application acceptance in both locales and themes, covering Basic Plus behavior, visible/hidden/split/review editors, static-plugin lifecycle and recovery controls, long-line save/reopen/Undo, conflicts and language-service isolation.
- **V02:** manual acceptance of an actual blocked renderer, next-launch recovery UI and persistent individual disables. Simulating the unresponsive hook does not satisfy this gate.
- **V03:** manual installed-app acceptance on a fresh machine/container without the repository mounted, including themes, static-plugin lifecycle and recovery.
- **V04:** retain the recorded environmental exception: full desktop smoke stops at the pre-existing `tests/desktop/monitor-smoke.mjs:332` timeout (`visibilityState === "hidden"`), also reproduced on pre-2C base `247db48`. Record checks skipped by that failure separately or obtain a complete run in a suitable desktop session; the full suite is not recorded as passing.

Exit: compiler and device APIs are stable enough for independent CLI and desktop release cycles.

## v2 — Python frontend

- Add Python parsing, semantic mapping, EV3 profile documentation, completion, and diagnostics.
- Compile supported Python semantics through `KobrixaIR` to `.rbf` without embedding CPython.

## v3 — TypeScript frontend

- Add TypeScript parsing and type-aware lowering.
- Document supported runtime semantics and explicitly reject browser, Node.js, and dynamic-code features in user programs.

## v4 — C++ frontend

- Treat C++ source support as a user-facing language frontend, separate from Kobrixa's Node.js and TypeScript implementation stack.
- Define a freestanding C++ EV3 profile and supported standard-library surface.
- Lower supported constructs through `KobrixaIR`; report unsupported runtime features at compile time.

## Long-term exploration

- Bluetooth transport
- Blockly-style editor that targets the same IR
- Classroom deployment and device-fleet tools
- Additional LEGO-compatible hubs through separate backends

Long-term items are research directions, not commitments. Each requires a written proposal, security review, cross-platform acceptance criteria, and an update to both documentation languages before implementation.
