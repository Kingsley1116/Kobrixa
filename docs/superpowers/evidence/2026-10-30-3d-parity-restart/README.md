# Lab public parity and actual restart

Linux arm64, source-built Electron acceptance host at `f38fb2f`: both strict native runs PASS, using the actual JS plugin process, generic renderer, public router, persistence worker and a fake device provider.

- `9MWl1L`: calibration save/list/reset/apply/delete, two recordings, raw/calibrated comparison, first recording deletion and retained second recording. Complete native input, IPC and SDK transport correlate with the real results; shutdown counters and owned processes are cleared.
- `m29KHm`: actual main PIDs 286 then 762 use the same fresh profile, with normal shutdown between them. Original schema-1 recording/calibration files import, a destination is deleted, a new final record is saved, and restart reads retained data without recording or reconnecting. Original bytes, durable import/barrier evidence and record hashes remain stable; deleted imports do not reappear. Empty normal shutdown drains remain recorded and strictly checked.

The terminal storage/list cursor is absent per the protocol; explicit null or a continuation cursor fails the complete-list oracle. IPC completion is observed using timestamps and a shared monotonic event sequence. These observer/oracle corrections do not change the product or weaken checks for replay, partial writes or residual processes. Earlier failed runs remain separate and are not relabelled.

Raw logs include rejected legacy-preferences challenges and shutdown-time unsubscribe messages. All original bytes are preserved in deterministic gzip files with decompressed/compressed SHA-256 hashes. Generated bundles and the disposable profiles remain in the controller artifact directory; artifact identities retain their hashes.

This is selected D7 software parity and migration/restart evidence, not full-product packaging, physical hardware, every lifecycle/fault row, or aggregate Stage 3 completion. D8 legacy runtime removal and D9b validation of the resulting package follow separately.
