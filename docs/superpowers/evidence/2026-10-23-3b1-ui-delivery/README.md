# UI event delivery and regression evidence

Source correction: `867fc52`; pending hold test correction: `22176bf`.

The runtime already emitted `ui.state` as telemetry but both public event schemas accepted control only. The common public RPC channel therefore rejected a real state event. The corrected schemas retain strict kind/data/delivery pairing: state telemetry; visibility/revoked and remaining UI kinds control. A runtime producer test originally failed (five passed, one failed), then all 23 focused runtime/state tests passed. The JavaScript public UiClient test now exercises both environment control and state telemetry through actual in-memory RpcPeer channels; its bounded enqueue ACK and callback failure checks remain.

Protocol suite: 542 passed. JS SDK: 33 passed. Python SDK: 52 passed, including six new shared positive/negative UI delivery cases. Exported TS and Python schema copies were generated from source. Type build, scoped lint and diff whitespace checks passed.

The two previous desktop hold fixture failures were corrected by explicitly retaining the pending begin reply, asserting synchronous cancel, then allowing settlement before the next gesture. No product admission check was weakened. Focused lifecycle/intent tests: 26 passed; desktop typecheck passed.

Full `pnpm test:desktop` at 867fc52 exited 0: 344 Vitest files passed / one historical file skipped; 4,025 passed / nine historical tests skipped. Downstream bytecode164, release35, Python52, static-language40 and device-broker13 passed. Declarative helpers: eight passed / twelve actual-receipt tests skipped without environment inputs. Those skips are not acceptance.

Separate earlier c59ab80 checks: direct release desktop builder (existing installed toolchain, no install/bootstrap) exited0; plugin Electron smoke exited0 with 16 helper tests plus actual JS/Python startup, crash isolation, exit/forced-shutdown and GUI recovery. These are scoped source receipts, not production motor/clean-machine/physical acceptance. All raw outputs and their exact hashes are listed in manifest.json.
