# Native SDK callback backpressure receipt

Observed on macOS arm64, 2026-10-23. Production baseline `89b3446360d589b4a982f243630f227fe929f300`, with only the subsequently committed native observer/consumer changes. Receipt correctly records `dirty: true`; exact emitted artifact hashes are retained. This is not a clean-commit or physical-device claim.

Command: `node tests/desktop/declarative-ui-motion-run.mjs --backpressure` (exit 0). The actual Electron workbench, production `composeDesktopMain`/preload/renderer, real JS SDK callback and formal Fake provider participated. The SDK callback awaited 31,002 ms. Actual SDK acknowledgements were held while host environment production continued for 30,005.336 ms (577 productions, 586 queue samples). Common queue maximum: seven events, 2,539 bytes. Overflow revoked motion before notification; the original operation remained queryable and its stop/readback was confirmed and durably retained. Final ten host counters were zero, normal close succeeded, and the actual five-second PID follow-up found no child.

Overflow resynchronization cancels subscriptions. The 577 attempted productions are not 577 delivered/retained events; boundedness includes that fail-closed behavior. This scenario is separate from the retained slow-renderer and maximum-load receipts. No measured throughput beyond this scenario is claimed.

`report.json.gz`, `electron.log.gz` and `matrix.json.gz` preserve the original bytes; `files.json` hashes the uncompressed files. The original matrix discriminator is erroneously an array (observer-only metadata); the runner now emits `ui-sdk-backpressure`. Validation uses the original individual report, not a rewritten receipt:

```sh
KOBRIXA_UI_BACKPRESSURE_REPORT=docs/superpowers/evidence/2026-10-23-3b1-sdk-backpressure/report.json.gz node --test --test-name-pattern='actual slow SDK callback' tests/desktop/declarative-ui-motion.test.mjs
```

The receipt test passed with zero skipped cases. Current renderer/main regressions, whole-stage acceptance, real persistence and hardware/manual gates remain separately tracked.
