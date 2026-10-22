# API 1.6.0 declarative UI acceptance ledger

Status: implementation in progress; P160 is not accepted or published. The initial gate checklist below remains open except for the scoped observations recorded at the end. Publication P160 is conditional on the completed T10 checks and the explicit pending-real-persistence exception below. The controller records actual F/P150/P160 SHAs, command log paths and artifact hashes after execution; no symbolic milestone is represented as a commit hash.

| Gate                                        | Initial status           | Evidence required                                                                                             |
| ------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| F, P150 ancestry and stopped-owner handoffs | not-run                  | Contract-freeze receipt, actual git SHAs, H-P/H-R/H-K/H-D/H-V/H-I handoffs                                    |
| U01 controls/settings adapter               | not-run                  | All 14 nodes, native input/focus, per-field adapter behavior; real persistence pending P170                   |
| U02 malformed resources                     | not-run                  | Actual loader negatives and code/detail assertions                                                            |
| U03 limits/capacity                         | not-run                  | Exact/max+1 UTF-8/code-point results, 16/16 and 8 MiB artifact                                                |
| U04 catalog/resource races                  | not-run                  | Revocation before stale replies, generation separation                                                        |
| U05 patch/backpressure                      | not-run                  | Atomic reject, retained draft/focus, bounded queues, terminal/control                                         |
| U06 compatibility                           | not-run                  | Actual saved 1.4.0 JS/Python provenance and transcripts; new SDK old envelope                                 |
| U07 commands/actions                        | not-run                  | Form/context/arg rejection, duplicate once, cancellation/timeout/no replay                                    |
| U08 events                                  | not-run                  | Shared quotas, enqueue-before-ack, future ack/gap/unsubscribe/no alias                                        |
| U09 trusted intent                          | not-run                  | 100/350 ms deterministic tests and native timing; no stale renewal                                            |
| U10 actual broker integration               | not-run                  | Formal A fake provider + actual broker + actual UI bridge, paused awaits                                      |
| U11 policy/safe mode                        | not-run                  | Required/optional toggles, restart, markers, zero optional cold-safe launch                                   |
| U12 drain-close                             | pending-real-persistence | Port fixtures may pass; actual persistence cannot pass before P170 and X-T1                                   |
| U13 crash-loop/no orphan                    | not-run                  | Three failures/300000 ms, reset/lazy/no replay/late spawn, actual PIDs                                        |
| U14 installed fixture                       | not-run                  | Shared builder, hash/unpack, isolated offline/no-checkout/no-PATH-Node run                                    |
| U15 renderer/a11y                           | not-run                  | Real components, en/zh-TW light/dark, 320 px/125%, remount and tabs                                           |
| U16 core actions                            | not-run                  | Trusted sender/identity rejection; resource-free Disconnect order; real save pending X-T1                     |
| U17 startup/suspend                         | not-run                  | Secondary zero side effects/focus, healthy generation retention, no wake replay; real checkpoint pending X-T1 |
| Performance                                 | not-run                  | 5 s warmup, 60 s, >=3 repeats, raw trace/heap and threshold checker                                           |
| Legacy/static language/web regressions      | not-run                  | Full prescribed verification outputs                                                                          |
| Production packaged smoke                   | not-run                  | Unmodified product bundle smoke, separate from synthetic fixture                                              |
| Delivered OS/architecture clean install     | not-run                  | OS-enforced offline/no checkout/no workspace node_modules; ordinary quit                                      |
| Real USB/Wi-Fi EV3                          | pending-3C               | Hardware, firmware, required stop vs observed stop; no synthetic sign-off                                     |
| Actual Lab save/suspend/Disconnect          | pending-3D               | Real recordings, failure/retry/checkpoint behavior after X-T1                                                 |
| Three delivered product payloads            | pending-3C-3D-3E         | Motor then Lab then device entries; no empty replacements                                                     |
| Stage-2 V01–V04                             | unchanged                | Preserve the existing exceptions and their original evidence                                                  |

## Pending-real-persistence contract

U12 is owned for final closure by X-T1 in the B2 plan, after actual P170 attachment. At P160 the explicit empty PersistenceParticipant is allowed only for resource-free cases. It cannot save a recording, return invented storage success, or retire the legacy Lab store/close protection. Record port-fixture result separately from actual result; the latter stays false/pending-real-persistence.

X-T1 imports `createFoundationFixture(): Promise<FoundationFixture>` read-only from B2-T7's `tests/desktop/plugin-persistence-main.ts`; no external composition adapter or second producer is permitted. T7 composes the real broker/fake provider, action/UI/runtime, rooted worker, persistence host, imports and public JS/Python clients. It resumes only after D170/K170 stop and hand over the exact `plugin-persistence-main.ts` and `plugin-persistence-run.mjs` paths, records producer commit/bundle hash at P170, then stops before X-T1. Defects return to T7 through another stopped-owner receipt. X-T1 must repeat healthy release, core Disconnect, suspend and provider loss through the sole onEnded→endReservation path without retiring/freezing healthy consumers. It must exercise late checkpoint registration, repeated end plus retirement, same-turn retire→freeze with the exact grant, first deadline/deduplicated final handler, renderer/window loss then bounded drain and teardown, owner death without callback, fresh generation only on explicit open, actual final CAS/commit/flush, stalled publication, disk-full/sync failure, retry TTL and checkpoint-only recovery. Disconnect waits for stop/readback, journal and real save; neither side's success overrides the other's blocker. Preserve 10-second drain, 15-second stop plus 5-second journal, 4-second manager, 24-second cleanup and 25-second non-forcing safety net.

## Evidence record format

Each run records command, exit code, commit, artifact SHA-256, OS/architecture, CPU, RAM, filesystem, Node/Electron/Python, fixture bytes/records/limits, locale/theme, cold/warm, sample count, p50/p95/max, retained-memory measurement and GC method, and raw log/trace/heap references. Manual rows additionally record tester/date/device/firmware and precise observed behavior. Unrun/failed/skipped rows include the actual reason and owner; do not use blanket all-passed wording.

Report separately: pure helper/auditor tests; actual SDK transport with protocol fixture host; actual main/preload/renderer; actual broker/fake provider; synthetic packaged host; production package; clean installation; real persistence; hardware. A receipt validator passing means its inputs met the checks, not that it performed the experiment.

## Controller observations — 2026-10-23 (partial)

P160 and Stage 3 remain incomplete. No blanket sign-off is implied by these scoped observations.

- P150 is already user-merged into stage-3 at a31da129c8f508b0b1d2a798beab6e1c3d00ec52. B1 includes A; shared branch ownership remains with the user.
- Actual main/preload/renderer baseline: clean a8cd10f, two JS consumers, real native input, two live statuses and late-listener replay, 1,000 API panel cycles, normal close and no remaining PIDs. CJK diagnostic mode excludes emoji display.
- Renderer cleanup: 1,000 actual React mounts/unmounts, 1,005 observed instances; registered renderer counters all zero after disposal. Renderer-isolate retained heap +671,464 bytes after three GC samples, below 2 MiB. This is not main-process memory or maximum-load acceptance.
- U06: preserved API 1.4 JavaScript and Python SDKs and current SDKs with legacy manifests execute unchanged legacy protocol. Both old-SDK UI declarations reject at the exact handshake boundary with no fallback. See raw source/executable hashes and wire transcripts in the browser evidence.
- Installed fixture: real release builder/resolver/launcher, empty PATH/no NODE_PATH/arbitrary working directory, missing/corrupt leaf rejected before launch, no remaining child. OS-enforced offline/check-out denial and other delivered OS/architecture gates remain unrun.
- Main close currently logs recovery-snapshot unavailability during teardown. Normal close succeeds, but that observation still needs assessment.
- Independent D160/V160/K160fix review remains pending because the closed review agents reached their quota. Author checks are not an independent PASS.
- Native 48-case motion/broker races passed through the actual host, SDK, production pane and formal fake provider. Original operation identity, no post-revocation effects, required confirmed stop/readback, durable disposition, ten final main UI counters at zero and no orphan PIDs are retained in the [native motion evidence](../evidence/2026-10-23-3b1-native-motion/README.md). Pressure/withheld-readback/lost-reply cases remain open, so U10 is partial.
- Complete maximum-load three-repeat performance, main retained memory, full regression/packaged smoke and manual/physical gates remain open. U12 remains pending-real-persistence for P170/X-T1.

Evidence: [browser/renderer/compatibility](../evidence/2026-10-23-3b1-browser-diagnostics/README.md), [transport and installed fixture](../evidence/2026-10-23-3b1-transport-installed/README.md).
