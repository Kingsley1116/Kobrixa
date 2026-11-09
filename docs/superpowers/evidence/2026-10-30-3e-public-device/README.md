# E6 public device — actual Electron receipt

2026-10-30 macOS arm64. Controller run4 `YEbaPE` exited0 and its outside oracle passed; the controller independently re-ran the verifier and hashed every recorded source/artifact and producer. The harness files were subsequently committed as `4a9db5c`; artifact identity records its original commit and uncommitted harness inputs, not a clean-commit build. Product form-sync correction is `3ed573b`.

The actual EV3 feature entry runs in a separate Electron utility process through the production launcher/MessageChannel, original SDK/router/broker, shipped persistence worker, original preload, generic panel and contributed-settings renderer. Only the provider is fake. Original six-field device-settings.json and three localStorage byte strings (including a whitespace-bearing address) pass through real frozen-writer/nonce/combined migration. Opening and reopening do not discover/connect. Five distinct trusted native actions correlate to their exact host invocation, row identity and successful device operation: discover, connect, refresh/read, query modes and set mode. Settings CAS/reset publish authoritative values; hide removes all original active device subscriptions. Main PluginController disable/re-enable retires the original process and re-admits settings without automatic operation replay. Composition/worker/bridge counters are zero at shutdown.

The migration/source and panel bindings are real; the visible shell is an acceptance host, not the complete workbench. Disable/re-enable uses the actual main lifecycle API, not a management UI click. One USB candidate, one numeric ready input, same-mode set, one setting and one bounded re-enable interval do not prove every parity/fault row. No physical hardware, source-free installed package, explicit timeout, multiwindow/restart migration, all accessibility cases or complete Stage3 claim.

37 oracle tests pass. Independent review found early settings writes before freeze and insufficient click correlation; corrections preserve strict product validation. Native2 exposed an actual feature bug: identical generic form synchronization cleared candidate/mode rows before invocation. Nine regressions plus original40 passed after correction. Other failed attempts exposed harness navigation and unsubscribe-contract mistakes; the reports retain these distinctions. Failed attempts are not counted as passes.

## Raw evidence

Gzip archives preserve exact bytes. `inventory.json` records raw/compressed hashes. `receipt.json.gz` binds producer and artifact/source identities. Reports include historical absolute paths only as execution-environment identifiers.

To reproduce, run `KOBRIXA_E6_DEPS=<existing dependencies root> node tests/desktop/device-ui-public-run.mjs --build-only`, then `--run-built <fresh directory>`. Without the override the checkout's own dependencies are used. Every run requires a new profile; failed or successful consumed artifacts are not reused.
