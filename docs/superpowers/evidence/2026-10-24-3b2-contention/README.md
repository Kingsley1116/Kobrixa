# B2 native contention evidence — 2026-10-24

Producer: `114a290e9c1504083cfbd35dd98af6b8a1d63811`. One fresh Electron process/profile, real composeDesktopMain, persistence worker, two builtin consumer subprocesses, and two native settings windows. Device provider is synthetic; no hardware was touched. This is one scoped T7 case, **not** the complete foundation or stage-3 gate.

The outside runner returned exit 0 and validated `contention`: recording/motion admission conflicts in both directions, durable checkpoint/final-save ticket correlation, exactly one settings CAS success and one conflict, retained losing draft, and confirmed motion stop while the original settings publication was paused. Cleanup reports zero workers/listeners/children and no errors; outside process exit is 0 with no signal.

`native-receipt.json.gz` retains actual worker/publication, native trusted-input, original settings-window authority, timestamps, and outside process/descendant evidence. `candidate.json.gz` retains the inside process candidate separately. `renderer-artifact.json.gz` identifies the real settings mount bundle. `native-config.json.gz` records the run paths; these absolute paths describe the original execution and need not exist on another machine. `inventory.json` hashes compressed and original bytes. No binary payloads or user profile contents are committed.

Command (handoff and output paths were controller-local):

```sh
PERSISTENCE_HANDOFFS=... PERSISTENCE_EVIDENCE=... node tests/desktop/plugin-persistence-run.mjs --case=contention
```

Native environment: macOS 24.6.0 arm64 / Apple M4 / APFS, Electron 44.7.0, Node 24.21.0. No storage/UI load performance measurement is claimed. Suspend-wake and the other missing live producers, SDK compatibility, installed/source-denial, imports, aggregate P170/X-T1, hardware and cross-platform/manual acceptance remain open. New untracked suspend authoring files existed during this run but were not imported or included in its built producer; the receipt retains actual artifact and bundle hashes.
