# D9a installed Lab payload — Linux arm64, 2026-10-26

**PASS: four actual native scenarios.** This is the real production `sensor-lab/main.cjs` and byte-identical resources inside an installed-payload acceptance host, not an unmodified packaged application. The successful container exited 0.

Clean build/source commit: `e3b24ac468698deacc17bf369454d9114bfbf9f6`; packaging used `buildBuiltinPayloads(false)` in the existing Linux image, offline frozen dependency installation and package builds. The separate build receipt binds the resource index to this commit; artifact identity conservatively calls its input build unattested without this receipt. Runtime, leaf, source, renderer, worker and host hashes are recorded.

Healthy: native user input selects actual fake-provider source, edits canonical calibration draft, captures fresh 42, applies, copies generated code via original one-use actionRef/native clipboard; records through the real public SDK/router/broker/shipped worker; closes panel while recording continues; core status Stop yields original-owner final saved receipt; reopens and pinned-reads/hash-checks saved history; exports actual CSV bytes via original host action/job; disables/re-enables via management IPC and explicitly reopens without replay; clean composition/process/worker shutdown. Export destination selection is substituted, real export service and filesystem writes are used. This is not native save-dialog acceptance or full product quit-policy proof.

Negative installed scenarios (fresh profiles): absent entry, missing resource, tampered hash each remains invalid/unavailable with no feature process or fallback. Each process exits 0; assertions prohibit timeout, forced termination, monitor error or orphan.

Isolation: Docker network `none`, no external interfaces, Landlock denies checkout and dependency/source roots; mandatory in-process read probes return denied, localhost network probe is denied, PATH Node missing. Browser sandbox/context isolation on and nodeIntegration off. Outer Docker seccomp is unconfined to permit Chromium sandbox setup; no privileged mode or added capabilities. Only a fresh evidence directory is mounted. This does not claim an adversarial container escape test.

The native failures led to shared production packaging fixes f7421dc/b6de98c: preserve per-launch process.env and Node builtin imports. Actual production leaf regression tests first reproduced both bugs and now pass. Twenty-four installed oracle mutation tests pass.

MANUAL remains open: physical USB/Wi-Fi, four-channel long recordings, native save dialog, cross-platform clean installation, accessibility/locales/themes and full lifecycle/fault matrix. macOS nested sandbox failure is separately retained; do not label macOS installed PASS. Legacy removal/D9b and full Stage3 closeout remain open.

## Raw evidence

Gzip files, SHA-256 of decompressed bytes. Full local artifact: `/private/tmp/kobrixa-d9-linux-native7-e3b24ac/kobrixa-lab-installed-lQDV1X`.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| [installed.json.gz](installed.json.gz) | 53875 | `12c34c85adbf700572fd9fe22e5780dc245c42628da64bcd6c2c0c20918e5859` |
| [artifact-identity.json.gz](artifact-identity.json.gz) | 49312 | `776161cbeb2be9d0500df6fabd8326af0b6c8f991f1616eeff2f7316ee8273a2` |
| [payload-audit.json.gz](payload-audit.json.gz) | 717 | `b00a9e10c24f2ab670ee06edf206ba8a71bcd993fb65e942c6e5869a7f55838e` |
| [build-receipt.json.gz](build-receipt.json.gz) | 969 | `3fdab06ec4b42858d72417e99e26af66c0ef0db5d5b9d95f556196cebfe96c05` |
| [isolation-container.json.gz](isolation-container.json.gz) | 540 | `8a2306aa0b43e4a59e82a779d5805fc0905f4c2f13f4afad40fbbf58b4c6636d` |
| [healthy-producer.json.gz](healthy-producer.json.gz) | 2183732 | `33c8544d79ac60090b0a8e9096f0c49f04f468fbe20bc0d0dcbeedb0f3652714` |
| [healthy-process.json.gz](healthy-process.json.gz) | 192 | `a00c9cef428c7fac02be7e1e6f006edcef605e42b902e09c61108dbd67152dc1` |
| [healthy-native.log.gz](healthy-native.log.gz) | 1378 | `72dd406709969a6c70a4faad38aaafb3ada09be52f56fb8b42f08a0f488a4169` |
| [absent-producer.json.gz](absent-producer.json.gz) | 3076 | `530064aa46eb820773959796543884365ad95a0c4354eb49ef029a3472c66f18` |
| [absent-process.json.gz](absent-process.json.gz) | 174 | `28aba182eb83bbaa0e90f2a56083b3b44f8e3554be98c53f479cfba887bf7662` |
| [absent-native.log.gz](absent-native.log.gz) | 1378 | `a9a223f13c8cdc105c9bd40fa6acabd7fd778a88c53c7b1ef29f99b1d6790e7a` |
| [missing-resource-producer.json.gz](missing-resource-producer.json.gz) | 3085 | `365bef0a669ae018b5996fb6b2d46bf01c41c17ca2a9e45e262b96ce22dcaa17` |
| [missing-resource-process.json.gz](missing-resource-process.json.gz) | 174 | `424bdb3d683335250e630525655e4e238bbea989320be03ef451f2d388680252` |
| [missing-resource-native.log.gz](missing-resource-native.log.gz) | 1378 | `d4a5e700b9ed6c966fe37da35dbe9cc790a1bf32f655bfce73402a6013df6181` |
| [tampered-producer.json.gz](tampered-producer.json.gz) | 3079 | `6b87a1b3282a496918a8ed0a4ffbc9b8bf994376d7df06a0874652bb03f209b1` |
| [tampered-process.json.gz](tampered-process.json.gz) | 174 | `b662c3bd8fba06555ea34dcdc76076ae6be1c66b8074bc4d9a37a9710dc1e5cd` |
| [tampered-native.log.gz](tampered-native.log.gz) | 1378 | `fcd83df295585eab94e89e575c031f9b2dbe1ec22082e13dd514ddccd64c6d17` |
| [healthy-export.csv.gz](healthy-export.csv.gz) | 2038 | `247e0cacbe54d83965ef97c3f6e6911fe7924abf4b0fa20d5d231d0e471c6a8d` |
