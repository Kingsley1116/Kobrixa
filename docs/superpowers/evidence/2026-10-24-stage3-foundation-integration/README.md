# Stage 3 foundation integration evidence — 2026-10-24

The local feature candidate merges B2 `b80b72e` and B1 `74b12e5` in `81c8148`. The exact producer is `ef08755b7d2f8bba915190092fac9971c4c3a1da`, including explicit declarations of the already locked esbuild 0.28.2 for clean desktop tests and root acceptance runners. No shared stage/main branch was merged.

Three real Electron/process cases passed against this candidate: retirement, healthy release, and disconnect/retry. Each uses a fresh profile, real desktop composition, persistence worker and public SDK with a synthetic device provider. The disconnect case exercises failed saving, explicit retry and eventual disconnect. All three outside receipts report exit 0 and zero workers, listeners, children and cleanup errors. The controller reran `verifyRunReceipt` with the exact producer commit, bundle hash and artifact hash after native completion.

The gzip files preserve original bytes; `inventory.json` records compressed and uncompressed hashes. The renderer and handoffs remain the frozen inputs recorded in the receipts. These runs precede the new action-replay producer and explicit stop/journal recovery work. They do not establish hardware, actual OS suspension, all crash boundaries, all native dialogs, installed-product isolation or full T7/P170/X-T1 acceptance.

Before native execution: core build, desktop typecheck, scoped lint and 894 focused tests passed. Four initial invalid-settings tests expected only one of two existing rejection messages; the integrated tests now accept exactly `Settings source is not admitted` or `Stale settings binding.` while retaining invalid-schema rejection and healthy-plugin assertions. A mistyped `--references-only` invocation was rejected before process allocation; the successful reference command uses `--references`.

Commands: `PERSISTENCE_HANDOFFS=... PERSISTENCE_EVIDENCE=... node tests/desktop/plugin-persistence-run.mjs --references`, followed by the same runner with `--case=disconnect-retry`. Only one native runner ran at a time.

The focused merge review is pending. This evidence closes three scoped integration cases, not Stage 3.
