# Actual public Sensor Lab native receipt

2026-10-26, macOS arm64. The outside-process oracle passed on native run 5.
This is a development-artifact public transport test, not source-free installed acceptance or complete Stage 3 acceptance.

The real bundled Lab process used the public SDK through composeDesktopMain, the actual shipped persistence worker and generic renderer. Only the device provider was fake. Trusted native input selected a source, synchronized a calibration draft, captured 42 and applied it, started recording, closed the panel while sampling continued, and used core status Stop. The original plugin owner/checkpoint/drain saved the final payload. Reopening history read the pinned host record, verified its hash and original model UUID, and rendered the full chart. Shutdown left zero tracked worker/listener/resource counts and exited successfully.

## Evidence

The gzip archives preserve the original bytes, including wire trace, native input observations, outside exit status and transitive source/artifact hashes. The source was dirty at build time: the identity records that truth; this is not a clean-commit receipt. Those product changes were subsequently committed as a359575, 724002a and 98b1ea3. Earlier necessary fixes are 44291e7 (derived controls) and 753a943 (fresh retirement).

`receipt.json.gz` binds the uncompressed producer SHA-256. Run the current independent oracle on the original producer:

```sh
node --input-type=module -e 'import {readFileSync} from "node:fs"; import {gunzipSync} from "node:zlib"; import {verifyLabReceipt} from "./tests/desktop/sensor-lab-public-run.mjs"; console.log(verifyLabReceipt(JSON.parse(gunzipSync(readFileSync("docs/superpowers/evidence/2026-10-26-3d-public-lab/producer.json.gz")))));'
node --test tests/desktop/sensor-lab-public-test.mjs
node tests/desktop/sensor-lab-public-run.mjs --run
```

The independent oracle has 19 passing cases, including mutations of original owner, drain, hash, final payload and model UUID. The model UUID is intentionally independent of the host record ID. Scoped harness TypeScript and ESLint also passed.

## Limits

This receipt does not close CSV/profile/compare/copy flows, the lifecycle/fault matrix, Python stdio parity, installed isolation, physical USB/Wi-Fi, accessibility, or legacy removal. It does not substitute for those gates.
