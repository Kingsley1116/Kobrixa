# API 1.5.0 device foundation acceptance

Status: REVIEW FIXES CLOSED; AUTOMATED FOUNDATION EVIDENCE RECORDED (2026-10-22). Independent Codex review closed the four integration findings and both residual identity/wake cases at `8b1f4d7`, with no remaining findings in that scoped review. This is a feature-branch integration candidate, not blanket acceptance or shared-line merge approval. The general desktop smoke and packaged static-language gate remain failed as documented below; physical/manual, installed-app and future real persistence acceptance remain open.

| Gate                         | Status                                          | Evidence required                                                                                                |
| ---------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| F baseline                   | verified                                        | Exact real 40-character SHA, freeze receipt and ancestor check                                                   |
| R150 / K150 / V150           | reviewed; receipt below                         | Three owner commits, exact touched paths, stopped-owner receipts                                                 |
| P150 schema and two SDKs     | schema/SDK tests pass                           | Generated TS/Python schema equality, clean second generation, exact 1.5.0 registry                               |
| F01–F21 automated matrix     | PASS including corrected F09 fault attribution  | Nonempty named assertions in all mapped owner suites, command and exit code                                      |
| Actual JS / Python transport | PASS at clean 8b1f4d7 including SDK receipt/ACK | Electron MessagePort / Content-Length reports at the accepted commit                                             |
| Ten-minute maximum workload  | PASS at clean 8b1f4d7                           | Measured occupancy, retained heap after GC, stop-dispatch p95 ≤50 ms and separate exchange/readback/journal data |
| A-RF1–A-RF4                  | owner tests pass; physical acceptance open      | Named owner tests, public-path reproduction and reviewed trace                                                   |
| A-RF5 / F19 fixture          | fixture tests pass                              | Reservation end during registration, original grant/deadline, healthy generation retained                        |
| A-RF5 / F19 real persistence | pending X-T1                                    | Real B2 participant after P170; fixture evidence cannot close this row                                           |
| A-M01                        | unverified                                      | USB/Wi-Fi physical motion bounds and readback                                                                    |
| A-M02                        | unverified                                      | Release/hide/hang/kill/disable during pending start/arm                                                          |
| A-M03                        | unverified                                      | Lost transport/reply, identity and reconciliation                                                                |
| A-M04                        | unverified                                      | Collaboration roles and authority loss at consequential boundaries                                               |
| A-M05                        | unverified                                      | Four-channel reservation, Disconnect/suspend final-read behavior; 3D save separately                             |
| A-M06                        | unverified                                      | 120/600-second file confirmation, partial transfer, weak Wi-Fi                                                   |
| A-M07                        | unverified                                      | Disk failure and crash/restart journal recovery                                                                  |
| A-M08                        | unverified                                      | Installed native provider, no checkout/external Node, second instance and delivered OS matrix                    |
| Stage-2 V01–V04              | carried forward                                 | Preserve original exception status and evidence; no automatic closure                                            |
| 3C / 3D / 3E                 | outside foundation acceptance                   | Product motor proof / Lab migration / final closeout                                                             |

For each executed row record command, exit code, commit, artifact identity, OS/architecture, CPU/RAM/filesystem, Node/Electron, fixture bytes/records/limits, warm/cold, sample count, p50/p95/max and memory metric/GC method. For hardware also record brick/firmware, transport, timestamp, observer, action, observed physical outcome and fault/log references. Missing Python or skipped manual work remains unverified.

Safety disposition: unresolved stop, journal failure or pending legacy Lab save remains a blocker. An empty new-API persistence adapter does not certify legacy recordings saved. No automatic force quit resolves a blocker.

Publication: F → D150/R150/K150/V150 + T1–T9 → P150 → user no-ff merge to stage-3 → B1/B2 synchronize. Do not publish 1.6/1.7 in this batch. Real persistence integration is checked by X-T1 after the user has merged P150, P160 and P170.

## Final correction and measured evidence — 2026-10-22

Tested implementation: `8b1f4d785b0164aa2f4527c625168422a600a660`; baseline F remains an ancestor. The subsequent acceptance commit only stores this evidence. No stage/main merge, history rewrite or API 1.6/1.7 publication occurred.

- Final integration corrections `4a03d74` and `8b1f4d7` reconcile clean/later recovery wake, broker admission and EV3 catalog identity, and retire native-loss state before reconnect. Independent scoped Codex re-review of `a21f079..8b1f4d7`: **Spec PASS / Quality PASS, 0 Critical / 0 Important / 0 Minor**. The original two residual probes passed against the real broker/EV3/coordinator composition with controlled native IO/journal seams; they do not establish physical or installed-app acceptance.
- `pnpm test:desktop` at 8b1f4d7: the retained log records **3,509 Vitest PASS / 9 historical skips**, followed by **164 bytecode / 34 release / 38 Python / 39 static-language / 13 device Node passes**. The combined command's final exit object was lost when the user interrupted the session; these are logged suite results, not an invented observed overall exit code. The earlier two formatting-sensitive source-assertion failures were corrected separately in `a21f079` without changing their guard requirements.
- `pnpm check:desktop` at 8b1f4d7: observed **exit 0**, including dependent type checks and ESLint. The fix implementer also recorded 190 focused passes, including 15 new cases; unchanged broad gates were not repeated solely for receipt updates.
- `node tests/desktop/device-broker-run.mjs --load`: observed **exit 0** at clean 8b1f4d7. [Raw transport/load report, hashes and environment](../evidence/2026-10-22-3a-device-broker.json) preserves the actual measured arrays and artifact identities. Both outer source identity and nested load environment agree with the fixed commit. Actual JS Electron MessagePort/Python Content-Length checks retain negotiation, SDK callback/ACK, withheld-event and retired-owner assertions. The separate synchronous-stall child entered its marker and was killed, with absence checked.

After the unchanged 5-second warmup, maximum synthetic workload ran **600,374 ms**. The queue peaked at **262,139/262,144 bytes** with **18,210 overflow frames** under responsive batched ACK pressure. All 11 forced-GC heap samples satisfied the specified bounded-growth guard. The workload uses the same 8 providers, 32 candidates each/64 global, 38 channels, 4 actuators, 32 subscriptions and 64 journal entries.

| Measurement  | Samples |  p50 ms |  p95 ms | Maximum ms |
| ------------ | ------: | ------: | ------: | ---------: |
| stopDispatch |    1100 |  0.3245 |  0.6911 |     1.0313 |
| transport    |     256 |  7.1850 | 10.8267 |    19.6299 |
| readback     |     256 | 11.2415 | 12.6073 |    14.0680 |
| journal      |     256 |  0.2803 |  0.3936 |     0.4536 |

Stop dispatch is measured at the guarded dispatch boundary, not physical motor stop. Transport/readback and in-memory journal are separate observations; durable disk latency, firmware, native memory and installed OS behavior are not inferred. The interrupted load at 4a03d74 remains incomplete and is superseded by this successful fixed-commit run, not relabelled as passed.

### Remaining integration and acceptance work

The general smoke still requires the D160 fixture migration from obsolete monitor/Lab/motor dependencies. The packaged smoke still exposes the pre-existing 2C workspace text-file admission policy gap. Their failed outcomes and later unreached phases remain recorded in the historical evidence below. No assertion was skipped to close either gate. A-M01–A-M08, X-T1 with real B2 persistence, stage-2 V01–V04 and future 3C/3D/3E remain open.

Stopped-owner handoffs retain their exact historical commits below. Follow-up D150/broker/provider corrections are `4a03d74` and `8b1f4d7`; source-assertion correction is `a21f079`. No concurrent writer owns these A slices. This receipt does not authorize a new H-D/H-R/H-K/H-V writer before the user-approved P150 stage synchronization. B1 must preserve P160/API 1.6 and combine both SDK index.ts changes during that synchronization.

## Historical executed evidence — 2026-10-21

Baseline F is `828918770d4911e59bbe65f179d1c8de6dbcc2cf`; it is an ancestor of the tested A branch. The shared stage branch remains `6abbdf266047f64b2928f427b3499bedc6fae5a2` (plans). No shared-line merge or history rewrite was performed.

Serialized owner receipts: R150 `b2f3a1b` + `766e1e7`; K150 `57b53b3`; D150 `2f5fcc4` + `1b3014d` + `b31b9dc`; V150 `8cf43e9` + `5d8ff6e`. D150 fix2 and V150 fix passed independent Codex review. H-P initially published 1.5.0 at `48d9d7f` with fixes `8a3c8d1` and `892bdb6`; the last replaces the rejected early-readiness approach in `9da2a07`. Readiness opens only after successful initialize-response publication. API 1.6/1.7 is not published by this branch.

- `pnpm test:desktop` at `892bdb6`: exit 0; 3,471 Vitest tests passed, 9 existing skips; bytecode 164, release 34, Python SDK 38, static-language Node 39, and device-broker Node 8 passed. The prior five gated real broker-factory tests are now mandatory; all seven factory tests passed.
- Protocol/runtime/SDK/device builds, schema generation twice, TS/Python schema comparison, unchanged generated files, exact API 1.5 registry checks, `pnpm check:desktop`, and `pnpm check`: exit 0. The full check required normal host access for Wrangler's local generated type work.
- `pnpm test:web`: frontend/IR 116 passed; worker initially 14/15 with a local `ECONNRESET` while sending an oversized request. An isolated unchanged `pnpm --filter @kobrixa/web test:worker` rerun passed 15/15. The first command's failure is retained, not relabelled as a clean pass.
- `pnpm -r build` initially failed at missing root-hoisted `node-addon-api`. The repository requests hoisted dependencies, but this worktree's existing installation records isolated layout. The three missing root packages (`node-addon-api` 8.9.2, `node-hid` 3.4.0, `pkg-prebuilds` 1.1.0) were copied from their existing installed `.pnpm` directories into ignored `node_modules`; no dependency/version/lockfile/source change or package installation was made. `node tools/release/build-desktop.mjs` then passed at `90a2b39`, producing a macOS arm64 Electron 44.7.0 application with local ad-hoc signing, no notarization and `publish: never`. This verifies that build command, not a clean rerun of the original recursive command or the delivered OS matrix.
- `pnpm test:desktop:packaged`: exit 1. The initial smoke selector incorrectly expected `data-mode-id` on Monaco's inner view; `693b62d` corrects it to the actual host. The rerun passes builtin Basic Plus catalog/mode, required-plugin refusal and session-marker assertions, then fails selecting `sample.toy`. Production `workspace/workspace.ts` still admits only `.bp/.bpi/.bpm/.json`, excluding `.toy/.xyz`; that file is byte-identical to baseline F (SHA-256 `0353363c9f23258be52a4cc298ad6013e0b1862350db243f8cf6527a3e23ae91`). This pre-existing 2C file-admission gap needs a coherent workspace/search/collaboration policy follow-up; no assertion was skipped and the packaged gate is not green. Later draft/build/update/relaunch phases were not reached.
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

Eleven forced-GC retained-heap samples passed the specified bounded-growth guard; the last was 10,112,048 bytes. The separate synchronous-stall child entered its marker, was killed and verified absent. The load uses memory RPC and an in-memory journal, separately from actual JS Electron MessagePort/Python Content-Length transport; it does not measure durable disk latency, physical stop distance, native memory or firmware. The historical load report proves its original host workload. [Strengthened real transport evidence](../evidence/2026-10-21-3a-transport.json) passed separately at clean `90a2b399761fc6af667988667eec4bd2e30f5fe4`: 28 fresh JS/Python child launches, 12 negotiation rows, 18 channel rows, 28 retired-owner checks, positive SDK callback receipts and correlated ACKs, and deliberately withheld-event failures. Its parent/child artifact identity is consistent. The four T9 findings (SDK receipt, portable Node/Vitest invocation, captured identity, F09 attribution) passed independent Codex re-review with no remaining findings. No Windows execution is claimed. No ten-minute rerun was performed solely for metadata or formatting.

### Integration cautions

The read-only three-way merge preview into B1 found two conflicts in `packages/plugin-sdk-js/src/index.ts`. Preserve B1's `ContextCommands` and `pluginContext` UI surface together with A's `RequestContext.afterReply` device-readiness gate. Preserve P160/API 1.6 and regenerate schemas from the merged source. Do not choose one entire side of SDK/schema files. B2 had no textual conflict at the audited committed heads; that is not semantic integration acceptance.
