# API 1.5.0 device foundation acceptance

Status: IN REVIEW (2026-10-21). Automated evidence below has been executed; this is not a P150 publication or merge approval. Native Codex took over after the Claude review quota ended. Independent T9 corrections are in progress; physical/manual and installed-app acceptance remains open.

| Gate                         | Status                                                         | Evidence required                                                                                                |
| ---------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| F baseline                   | verified                                                       | Exact real 40-character SHA, freeze receipt and ancestor check                                                   |
| R150 / K150 / V150           | reviewed; receipt below                                        | Three owner commits, exact touched paths, stopped-owner receipts                                                 |
| P150 schema and two SDKs     | schema/SDK tests pass                                          | Generated TS/Python schema equality, clean second generation, exact 1.5.0 registry                               |
| F01–F21 automated matrix     | passes; F09 attribution correction pending                     | Nonempty named assertions in all mapped owner suites, command and exit code                                      |
| Actual JS / Python transport | host transport passes; positive SDK receipt correction pending | Electron MessagePort / Content-Length reports at the accepted commit                                             |
| Ten-minute maximum workload  | PASS at clean 892bdb6                                          | Measured occupancy, retained heap after GC, stop-dispatch p95 ≤50 ms and separate exchange/readback/journal data |
| A-RF1–A-RF4                  | owner tests pass; physical acceptance open                     | Named owner tests, public-path reproduction and reviewed trace                                                   |
| A-RF5 / F19 fixture          | fixture tests pass                                             | Reservation end during registration, original grant/deadline, healthy generation retained                        |
| A-RF5 / F19 real persistence | pending X-T1                                                   | Real B2 participant after P170; fixture evidence cannot close this row                                           |
| A-M01                        | unverified                                                     | USB/Wi-Fi physical motion bounds and readback                                                                    |
| A-M02                        | unverified                                                     | Release/hide/hang/kill/disable during pending start/arm                                                          |
| A-M03                        | unverified                                                     | Lost transport/reply, identity and reconciliation                                                                |
| A-M04                        | unverified                                                     | Collaboration roles and authority loss at consequential boundaries                                               |
| A-M05                        | unverified                                                     | Four-channel reservation, Disconnect/suspend final-read behavior; 3D save separately                             |
| A-M06                        | unverified                                                     | 120/600-second file confirmation, partial transfer, weak Wi-Fi                                                   |
| A-M07                        | unverified                                                     | Disk failure and crash/restart journal recovery                                                                  |
| A-M08                        | unverified                                                     | Installed native provider, no checkout/external Node, second instance and delivered OS matrix                    |
| Stage-2 V01–V04              | carried forward                                                | Preserve original exception status and evidence; no automatic closure                                            |
| 3C / 3D / 3E                 | outside foundation acceptance                                  | Product motor proof / Lab migration / final closeout                                                             |

For each executed row record command, exit code, commit, artifact identity, OS/architecture, CPU/RAM/filesystem, Node/Electron, fixture bytes/records/limits, warm/cold, sample count, p50/p95/max and memory metric/GC method. For hardware also record brick/firmware, transport, timestamp, observer, action, observed physical outcome and fault/log references. Missing Python or skipped manual work remains unverified.

Safety disposition: unresolved stop, journal failure or pending legacy Lab save remains a blocker. An empty new-API persistence adapter does not certify legacy recordings saved. No automatic force quit resolves a blocker.

Publication: F → D150/R150/K150/V150 + T1–T9 → P150 → user no-ff merge to stage-3 → B1/B2 synchronize. Do not publish 1.6/1.7 in this batch. Real persistence integration is checked by X-T1 after the user has merged P150, P160 and P170.

## Executed evidence — 2026-10-21

Baseline F is `828918770d4911e59bbe65f179d1c8de6dbcc2cf`; it is an ancestor of the tested A branch. The shared stage branch remains `6abbdf266047f64b2928f427b3499bedc6fae5a2` (plans). No shared-line merge or history rewrite was performed.

Serialized owner receipts: R150 `b2f3a1b` + `766e1e7`; K150 `57b53b3`; D150 `2f5fcc4` + `1b3014d` + `b31b9dc`; V150 `8cf43e9` + `5d8ff6e`. D150 fix2 and V150 fix passed independent Codex review. H-P initially published 1.5.0 at `48d9d7f` with fixes `8a3c8d1` and `892bdb6`; the last replaces the rejected early-readiness approach in `9da2a07`. Readiness opens only after successful initialize-response publication. API 1.6/1.7 is not published by this branch.

- `pnpm test:desktop` at `892bdb6`: exit 0; 3,471 Vitest tests passed, 9 existing skips; bytecode 164, release 34, Python SDK 38, static-language Node 39, and device-broker Node 8 passed. The prior five gated real broker-factory tests are now mandatory; all seven factory tests passed.
- Protocol/runtime/SDK/device builds, schema generation twice, TS/Python schema comparison, unchanged generated files, exact API 1.5 registry checks, `pnpm check:desktop`, and `pnpm check`: exit 0. The full check required normal host access for Wrangler's local generated type work.
- `pnpm test:web`: frontend/IR 116 passed; worker initially 14/15 with a local `ECONNRESET` while sending an oversized request. An isolated unchanged `pnpm --filter @kobrixa/web test:worker` rerun passed 15/15. The first command's failure is retained, not relabelled as a clean pass.
- `pnpm -r build`: desktop packaging fails at missing root-hoisted `node-addon-api`. Compilation reached desktop staging successfully; this does not certify a packaged artifact. No dependency installation or local symlink workaround was applied.
- `pnpm format:check`: 40 inherited warnings remain in files unchanged since F. Only the 46 A-modified files were formatted in `e737e58`; emitted JavaScript ASTs were identical before/after. Root formatting is not claimed green.
- Existing plugin Electron smoke passed after its old quit callback wiring was corrected. A real immediate-cleanup quit failure was reproduced separately and retained as an Electron regression: it failed before `b4f778a`, then passed after scheduling the final quit on the next event-loop turn. Existing forced shutdown remained approximately 3 seconds, below the unchanged strict bound; 46 quit/lifecycle/core-recovery tests, scoped lint and standalone smoke typecheck passed. Independent Codex review of `b4f778a`: Spec/Quality PASS, no findings.
- Static-language Electron acceptance passed browser/lifecycle/conflict/safe-mode/recovery/marker-failure phases, including actual hostile tokenization termination and recovery, after the shared fixture declared its required builtin policy. Expected rejected IPC/schema probes remain in the log; Monaco logged model-disposal warnings. This is not a hardware/packaged-app claim.
- General desktop Electron smoke: exit 1. File/history and external-file phases passed, then the legacy monitor fixture failed with `this.devices.watch is not a function`. Its fixture still supplies pre-broker monitor polling, Lab acquire/release, and motor-run dependencies; it must migrate to the new broker interfaces with the D160 UI handoff. This is a concrete test-integration failure, not an environment-only exception or a passing UI gate. Installed OS matrix, physical USB/Wi-Fi and X-T1 with real B2 persistence remain unverified.

### Maximum synthetic workload

[Raw measured report, artifact hashes and metadata annotation](../evidence/2026-10-21-3a-device-broker.json) records `node tests/desktop/device-broker-run.mjs --load`, exit 0, on macOS arm64 / Apple M4 / 16 GiB / Node 24.21.0 / Electron 44.7.0. The clean captured source was `892bdb6be05036b718733df810a07ef459089870`. The child sampled HEAD again at completion and recorded formatting commit `e737e58` in its nested environment field; the outer source identity and prebuilt artifact hashes are authoritative. The original evidence is preserved without rewriting this mismatch.

After 5 seconds of warmup, the workload ran 600,250 ms: 8 synthetic providers, 32 candidates each, the 64-candidate global bound, 38 channels / 4 actuators, 32 subscriptions and rejection of the 33rd, 64 journal entries. Measured peak queue was 262,134 bytes of 262,144; 18,137 overflow frames were observed with responsive 1-second batched ACKs. These are explicit-pressure observations, not only total traffic counters.

| Measurement                             |  Samples |  p50 ms |  p95 ms | Maximum ms |
| --------------------------------------- | -------: | ------: | ------: | ---------: |
| Request to actual guarded stop dispatch |    1,105 |  0.3043 |  0.6605 |     4.9123 |
| Transport                               | last 256 |  5.1695 |  9.8742 |    17.8429 |
| Readback                                | last 256 | 11.0707 | 11.9576 |    31.1951 |
| In-memory journal                       | last 256 |  0.2313 |  0.4147 |     0.6244 |

Eleven forced-GC retained-heap samples passed the specified bounded-growth guard; the last was 10,112,048 bytes. The separate synchronous-stall child entered its marker, was killed and verified absent. The load uses memory RPC and an in-memory journal, separately from actual JS Electron MessagePort/Python Content-Length transport; it does not measure durable disk latency, physical stop distance, native memory or firmware. The old transport report proves host publication/retirement but awaits stronger positive SDK-receipt assertions; no ten-minute rerun is needed solely to correct metadata or formatting.

### Integration cautions

The read-only three-way merge preview into B1 found two conflicts in `packages/plugin-sdk-js/src/index.ts`. Preserve B1's `ContextCommands` and `pluginContext` UI surface together with A's `RequestContext.afterReply` device-readiness gate. Preserve P160/API 1.6 and regenerate schemas from the merged source. Do not choose one entire side of SDK/schema files. B2 had no textual conflict at the audited committed heads; that is not semantic integration acceptance.
