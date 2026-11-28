# macOS source-denied Lab acceptance: blocked

2026-10-26, macOS arm64. Candidate product Lab was built by production buildBuiltinPayloads and copied from its ASAR-unpacked leaf. The acceptance host is a test host with actual composeDesktopMain/worker/preload/generic renderer; it is not the unmodified installed application.

Native attempt 4 established the narrow Chromium UNIX singleton socket exception after attempts 1–3 failed before the primary lock. It then failed when Electron subprocesses attempted to initialize their own sandbox inside Seatbelt. The main process exited with SIGTRAP; no producer completed and no survivor remained. **No installed PASS.** Archives are raw failed output and process accounting, not success evidence.

The runner retains source/network/Node denial probes, does not allow an unisolated fallback, and does not disable Chromium sandboxing. Linux Landlock in a networkless namespace is the next execution path, following the existing 3C approach. The copied runtime and product artifact are hashed independently. Full packaged application startup, actual OS export-dialog interaction, other platforms and physical/manual checks remain separate gates.

The installed oracle has 24 passing synthetic/unit adversarial cases; these do not establish native acceptance.
