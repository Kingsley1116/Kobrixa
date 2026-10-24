# B2 native suspend/wake evidence — 2026-10-24

Producer: `34355e04227e4e13a63d7a95410e6b0fb7c1f33f`. The outside runner validated one fresh Electron process/profile using real composeDesktopMain, persistence worker, public SDK consumer, and a synthetic device provider. No physical hardware or OS sleep was used. This is one scoped T7 lifecycle case, not the complete foundation or stage-3 gate.

The real lifecycle coordinator completed stop/readback/journal and recording final save; resume retained the original process/owner. Continuous observation found no motion, recording or legacy-command replay during the bounded wake interval (at least 425 ms). The original motion/gesture authorizations were denied within their lease; the original storage grant was retried against the current final revision before its original expiry, receiving exact stale-resource denial with no new engine admission and no record change. This is an observable grant-revocation check, not a measurement of a private internal deadline.

The outside runner exited normally and validated process/descendant cleanup. Native receipts preserve raw trace, checkpoint/grant/record/report correlation, outside process evidence, and bundle/artifact hashes. The independent scoped review passed and reran 34 pure tests. Earlier failed runs remain separate; they were not relabeled.

`native-receipt.json.gz` is the outside-validated result; `candidate.json.gz` is the inside candidate. Configuration and renderer artifact receipts identify the original run inputs. Absolute paths describe the execution machine. `inventory.json` hashes both compressed and original bytes. No application binary or user profile content is committed. Untracked disconnect producer files existed but were not imported into this run.

Command:

```sh
PERSISTENCE_HANDOFFS=... PERSISTENCE_EVIDENCE=... node tests/desktop/plugin-persistence-run.mjs --case=suspend-wake
```

Environment: macOS 24.6.0 arm64, Apple M4/APFS, Electron 44.7.0, Node 24.21.0. Actual OS sleep/wake, physical hardware, other live producers, full persistence matrix, SDK compatibility, load/import/installed, aggregate P170/X-T1, and cross-platform/manual acceptance remain open.
