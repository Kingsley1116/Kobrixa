# Local Stage3 integration handoff — 2026-10-23

This is a controller implementation-order ruling, not P160/P170 publication or a shared-branch merge approval. The user requested completion of all Stage3. Source integration and unpublished tests may continue locally while aggregate publication/manual/future-product gates remain open. No gate is marked passed by this ruling.

Reviewed B1 source `44df3b40bfafd6bef3b58320a995ad2d9fc76e23` was merged without conflicts into local `feat/plugin-3b2` at `5efb9c16902826a7e0f079714c9c732e0abfdf29` from B2 `3a7a239cef03933215f44d361bbc10a582b70951`. Shared stage3 remains user-owned at a31da12. B1 changes through 44df3b4 have independent scoped reviews, including latest SpecPASS/QualityPASS and 104 relevant passing tests; resource/native receipts retain their narrower scope. B2 T1–T6 and T7 authoring remain preserved.

The P160-before-T8 precondition is amended only for unpublished local assembly/testing. H-P B1-T1 is stopped; no B1 protocol/SDK writer is running. Exclusive H-P now transfers the following common paths to B2-T8, plus the complete T8 allowed set in the approved plan. T1 domain modules and prior schemas are consumed, not replaced by baseline1.4 copies. Destination must preserve P150/P160 contracts while assembling1.7. Source version1.6 remains in the B1 branch. Genuine P170 publication still requires completed owner review, schema/SDK/conformance gates and the original acceptance record. R170/D170/V170/K170 remain separate downstream tasks.

Stop/transfer recorded at 2026-10-22T22:10:59.855378+00:00. No active writer shares these paths. Hashes are destination source bytes immediately after the merge, before T8 edits:

| Path | SHA-256 |
| --- | --- |
| `packages/plugin-protocol/src/manifest.ts` | `261daa998c097bf078f22dd791fb1a37c0bd33cd4ed84425090a08362df09765` |
| `packages/plugin-protocol/src/methods.ts` | `b2bf8f55d2676b0abced3bf7ceb2a305801543ce880f0ac4bb9554925d2fe6d8` |
| `packages/plugin-protocol/src/common.ts` | `1d97f78d73890f124c063854a0a3321ab978e4795348d053cc0857794a47c66f` |
| `packages/plugin-protocol/src/limits.ts` | `7d4b5ce93076ad3d44f25f344266a4d5897cb04962d682ef6cf69fa8c1ea1d53` |
| `packages/plugin-protocol/src/rpc.ts` | `4a6eb9fcad2ae5db2e2a607b558d76d23d36fa93ace197381658f397ec138e61` |
| `packages/plugin-protocol/src/errors.ts` | `07fd98bf2950647b6e675bea100d6e39244edbb5bb1012d23281d60a489c5311` |
| `packages/plugin-protocol/src/peer.ts` | `a0fce8717a6c6da23ec85cf349662ab3f4834a1c6e97b858267a42504fe3ef46` |
| `packages/plugin-protocol/src/index.ts` | `53122c41222ea4c4e0ce5bc88834accbb82b283c24bf8401c2eb0f85dfd5b748` |
| `packages/plugin-protocol/src/json-schema.ts` | `085a6a5c1cd0d07d76103ee86e4863b0c13858b93f4d693a073c597244411d4f` |
| `packages/plugin-protocol/src/business-result.ts` | `219dd2fdab2d69d8772678a68c23ddd000e32adeaa8fe90e0fcd4fe100a76942` |
| `packages/plugin-protocol/src/business-result.test.ts` | `b280d64bde318891b87752bc9e7e740795d0c19e7f952cd1ec225006fdb35fff` |
| `packages/plugin-protocol/src/events.ts` | `72a02d7794164549d3b8a53484956ff1eaf83bdcdb35c6d24f6a05481a635170` |
| `packages/plugin-protocol/src/events.test.ts` | `d53f92772dde609fdc5c5efd5991219db8201b93c2a6357a0f46348da8bbc7fb` |
| `packages/plugin-sdk-js/src/index.ts` | `82c6ba9a3b35f91be9675dbbe4e1a014d5518cc7f99dfbfcecfe61d923f7384c` |
| `packages/plugin-sdk-js/src/index.test.ts` | `1f1071fb51215b57aa6b784d788126ca0c1203798246769ea46a1125fb0b11e2` |
| `packages/plugin-sdk-js/src/events.ts` | `7814a71ea001c9b0acb67b39e8bdd7a782584391bf7eac733f0657051adb4fd2` |
| `packages/plugin-sdk-js/src/events.test.ts` | `41f98319d67221435cbdf8283931fad80d10103fb6ed9fbc09bdee8f332324fc` |
| `sdks/python/kobrixa/_plugin.py` | `b128d4644020e38f1401abf40a05ad3675ee6dc5eadaa90408060d2c506db944` |
| `sdks/python/kobrixa/_schema.py` | `7fb4064d553a01bf46fb083a1173aed706a6634243d16b9ff5081b78abd00a03` |
| `sdks/python/kobrixa/__init__.py` | `071efb4439e020543db115d4a667b7a033899d2e5a1060f3a5291c32be9c2730` |
| `sdks/python/kobrixa/_events.py` | `3b79dc39688e47c7043118344345c163a22123c43d8fd6fd71f78d84b94f3e9f` |
| `sdks/python/tests/test_events.py` | `cae03658ac5a9b4abf2c86b0b30cdec025a274266130b3b20ee9aa95d228ec01` |

Outstanding P160 gates include aggregate U01–U17 evidence mapping, full regression/build/package receipts, known platform glyph issue, legacy aggregate smoke adaptation and manual/physical/clean-install gates. U12 and actual save/disconnect/checkpoint recovery remain X-T1 after real P170 attachment. Future product payload acceptance belongs to3C/3D/3E. Local source integration must not turn any pending field into a successful observation. Legacy Lab persistence and close protection remain intact.
