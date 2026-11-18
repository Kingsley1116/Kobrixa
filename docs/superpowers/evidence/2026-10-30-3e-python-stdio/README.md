# E6 Python device consumer — actual native receipt

2026-10-30 macOS arm64. Fresh artifact `76kdQI` passed the outside runner and independent controller re-verification: exit0, no timeout, no monitor errors or surviving child processes. The exact five harness files were subsequently committed as `7d1773f`; the artifact was built at `7758cee` with uncommitted harness files. Identity retains every original source/artifact hash and Python executable identity; this is not a clean-commit build.

Two real Python SDK processes use production stdio framing/router, desktop composition, broker with a fake device provider, and shipped persistence worker. Evidence covers discovery/candidate connection/read42/input-mode query and write; exact stale-resource and missing-permission rejection; own settings CAS/conflict/reset/watch/unwatch; v2 table keys/revisions/canonical digest/readback; and a controlled in-flight read cancellation through the original request. Original request/response, owner, PID, subscription, dataset and cancellation timing must correlate. Unrelated success notes cannot satisfy the oracle.

The main fixture supplies host UI bindings directly. This does not establish native gestures, renderer migration, the EV3 product entry, installed isolation, explicit request timeout, physical hardware or all Stage3 criteria. Those remain separate gates. Original failed attempts are retained in controller temporary artifacts; review/fix reports explain their contract mistakes. No product guard was relaxed to pass this test.

56 oracle tests pass, including malformed identities, mismatched process owners, invalid generations, extra provider dispatch, false cancellation ordering and bounded process-monitor failures. The full real producer also passed five adversarial in-memory mutation rejections during correction; original evidence was never overwritten.

## Reproduce and inspect

`node tests/desktop/device-ui-stdio-run.mjs --build-only <absolute Python >=3.10> [dependency root]`, then `--run-built <fresh directory> <absolute Electron executable>`. All source/artifact identities are checked before execution and each profile is single-use. The controller used installed Python3.12 and Electron with existing dependencies; no dependency installation or hardware access.

Compressed files preserve original bytes. `inventory.json` records raw and compressed hashes; `receipt.json.gz` binds the producer, process and log hashes. `identity.json.gz` records the full source/artifact closure. Reports contain historical absolute paths solely to identify the observed environment.
