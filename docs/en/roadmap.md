# Roadmap

## Current delivery stage

The repository is at the v1 candidate stage. Basic Plus compilation, the desktop editor, USB/Wi-Fi transports, remote file management and three-platform installer/archive packaging and automatic updates are implemented. Published download availability is determined by each GitHub Release. Physical EV3 acceptance is confirmed by the maintainer. Signing is deferred beyond 1.0.0; clean-machine installation and release-artifact checks remain required.

The candidate also includes the [Sensor Lab](sensor-lab.md), [motor testing](motor-test.md) and [cloud collaboration](collaboration.md). Candidate.14 updates collaboration rooms, local-change handling and control requests. Automated tests for these candidate features do not replace physical EV3 acceptance.

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

- Expand `.bp` compatibility cases and EV3 API coverage.
- Improve completion, formatting, performance, accessibility, localization, and recovery UX.
- Add a headless Node.js `kobrixa` CLI over the same compiler and device packages.
- Cloud collaboration (included in candidate.12): invite-code rooms for real-time co-editing, shared file trees, chat and single-holder EV3 control through the Kobrixa-operated service. See [cloud collaboration](../en/collaboration.md).

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
