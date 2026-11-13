# Motor public native and installed evidence

Source `4c86f0a531f5cb60f7f7249b1ae8008bd43938a8`, macOS arm64, 2026-10-24. The original reports are compressed without editing; `files.json` records both uncompressed and gzip SHA-256. Absolute paths inside raw reports identify the retained execution environment, not repository dependencies.

`node tests/desktop/motor-test-public-run.mjs --all` exited 0: 77 selected cases, 77 validated reports, zero failures. `native/` retains every case, including pending prepare/start/arm/pulse cancellation, source/window/process failures, deliberate renderer freeze, core stop, keyboard hold, draft retention and layout. The original matrix, harness/bundle identities, dependency metadata, cleanup observations and command log are retained. Devices are fake providers; this does not establish physical stop on EV3 hardware.

`node tools/release/build-desktop.mjs` then rebuilt the original product. `node tests/desktop/builtin-process-installed.mjs` exited 0; receipt checks passed 4/4. The copied original ASAR, executable, preload and renderer exercised healthy launch, restart, missing resource and tampered resource. All four product processes exited normally with no remaining child PIDs or forced cleanup. Empty PATH, removed NODE_PATH, unrelated cwd and unchanged original payload/archive checks passed.

**Source-access denial remains unrun in this successful installed run.** `isolated` is false and `sourceRootDenial` is `unrun`; it must not be described as the full source-free gate. The separate prior Seatbelt attempt failed. On this host even nesting two `(version 1)(allow default)` sandbox-exec invocations around `/usr/bin/true` returns exit 71, `sandbox_apply: Operation not permitted`. Chromium sandboxing was not disabled to bypass this environment limitation. A compatible isolated environment or clean-machine acceptance is still required.

These receipts do not close P160/U12, B2/X-T1, legacy removal, physical USB/Wi-Fi, other-platform, or remaining manual acceptance. They do not mark Stage 3 complete. Older failed receipts remain separate and were not relabelled.
