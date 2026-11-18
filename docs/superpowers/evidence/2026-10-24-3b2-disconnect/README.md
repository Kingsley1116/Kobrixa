# B2 native Disconnect/Retry evidence — 2026-10-24

Producer: `ad1ec80bd4039a8b2febd92a239b34327da7882d`. One fresh Electron process/profile exercises real composeDesktopMain, persistence worker, public SDK consumer, lifecycle coordinator, and trusted host recovery adapter with a synthetic device provider. This scoped case uses host calls, not a native mouse click or physical hardware. It does not complete T7 or Stage 3.

The original and current device sessions belong to the same execution owner. The first final-save attempt fails at the injected worker boundary. Recovery retries the original final within the original grant deadline, reconciles the original ticket without republishing, and saves both session targets before the actual explicit disconnect. Evidence correlates worker admissions, checkpoints, record metadata, grant/deadline observations, publication, flush, save, stop/readback/journal and disconnect. The raw trace retains repeated real quiesce and per-target failed reports; the summary selects the first milestone of each kind. Old-grant denials and the healthy owner remain observed.

The outside runner validated the result, exited normally (0), and observed zero workers, listeners, children and cleanup errors. The product cleanup fix releases an exited, settled owner after recovery is saved while preserving its durable saved receipts and retaining unresolved owners. Independent scoped code review found no issues in `6c8841e..457cc19` and `457cc19..ad1ec80`; it did not rerun tests or independently confirm native completion from the build-only log. Native completion is established by the outside receipt, not by that review or the log.

`native-receipt.json.gz` preserves the outside result; `candidate.json.gz` preserves the inside candidate. The configuration and renderer artifact receipt preserve inputs. `inventory.json` records original and compressed SHA-256 hashes. No binary or user profile is committed. The renderer was the frozen sI7bH2 artifact; the run used its recorded handoff revisions, not later B1 changes. Earlier failed candidates remain separate and were not relabeled.

Command:

```sh
PERSISTENCE_HANDOFFS=... PERSISTENCE_EVIDENCE=... node tests/desktop/plugin-persistence-run.mjs --case=disconnect-retry
```

Environment: macOS 24.6.0 arm64, Apple M4/APFS, Electron 44.7.0, Node 24.21.0. Bundle SHA-256: `3120734a4c4a4e112b1790dc6d14886c437dc2da1d382126bfe33173a82c2e6a`; main artifact SHA-256: `1db6b654c6192759683691e18ec91808b657306be99d567be7f30d2de9573926`.

Physical hardware, manual UI acceptance, the remaining live producers, complete failure matrix, SDK parity, import/export/load/installed, aggregate P170/X-T1 and other platforms remain open.
