# Native declarative UI motion races — 2026-10-23

Command: `node tests/desktop/declarative-ui-motion-run.mjs --all`, exit 0.
48/48 native cases passed: prepare/start/arm/pulse, before/after, and hide,
authority loss, cancel, renderer freeze, renderer crash, or plugin process kill.

The run used actual `composeDesktopMain/createDesktopFoundation`, authority,
journal, SDK, child process, production preload, pane/window singleton and native
mouse input. Only the formal fake device provider was substituted. No physical
hardware was accessed. Each case retains its actual PID, wire exchanges, native
events, original operation ID, provider trace, durable disposition and ten main
UI counters. All counters returned to zero and all child PIDs were absent.
The consumer also queries through the public SDK after receiving start; the host
observer can still read the original operation after the consumer is killed.

Source identity is c25a06d with the then-uncommitted harness/formal-provider
changes subsequently committed as f66c469. Bundle hashes, dirty status and runtime
versions are recorded in the raw receipts. The portable matrix changes only the
report paths; `original-matrix.json.gz` preserves the original index verbatim.
All case JSON and native log bytes are retained verbatim using gzip;
`sha256.json` records uncompressed hashes and sizes.

The experiment found and verified fixes c91ad00 (authority revocation), d458450
(cleanup after rejected exchange), and c25a06d (terminal state while persisting).
The related complete device test directory passed 354 tests; desktop types and
scoped lint passed.

Replay receipt checks:

```sh
KOBRIXA_UI_MOTION_REPORT=docs/superpowers/evidence/2026-10-23-3b1-native-motion/matrix.json node --test tests/desktop/declarative-ui-motion.test.mjs
```

This is a production-pane test shell, not the complete App or an installed
product. `normalClose` means the actual composition cleanup and shell exit
succeeded. Queue pressure, withheld readback, lost replies, three-repeat maximum
load, independent review, physical hardware and real persistence remain separate
gates. P160 and Stage 3 are not complete.

## Common-queue and response-loss extension

`node tests/desktop/declarative-ui-motion-run.mjs --stress` exited 0 for all
three cases. `stress/` preserves the actual receipt bytes, hashes and log. The
run used dirty 15ba291 with the UI revocation fix subsequently committed as
b15ce44 and the accompanying stress harness. Eight real environment control
events fill the common ledger; actual SDK ACKs are held and delivered late.
The observed peak is seven queued ordinary controls, followed by the reserved
resync notification. Revocation precedes its delivery.

- Delayed readback: actual stop, then released readback, confirmed durable
  disposition and ordinary composition close.
- Withheld readback: unconfirmed durable fault survives killing the consumer
  and releasing the late readback. Actual composition close rejects with
  `CleanupBlocked`, `stopConfirmed:false`, `journalCommitted:true`. This case
  explicitly exits the test shell afterward; it is **not** normal-close proof.
- Lost start reply: public SDK reports its actual 5-second timeout; the consumer
  queries the original operation, without a second prepare/start. Releasing the
  original late reply/ACK does not restart motion; stop is confirmed.

All child PIDs were absent. Related regression suite: 166 passed, types/lint
passed. Replay both receipts with `KOBRIXA_UI_MOTION_REPORT=.../matrix.json` and
`KOBRIXA_UI_MOTION_STRESS_REPORT=.../stress/matrix.json` using the test above.
The 30-second slow-consumer load and maximum-load performance remain separate.
