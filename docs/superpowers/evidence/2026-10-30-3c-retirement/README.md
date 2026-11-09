# Motor legacy retirement verification

The private motor renderer/controller/service and five IPC endpoints were removed in `f518960`; broker/provider motion, trusted core Stop, journal, authority/close/update/suspend handling, monitor/battery and Lab migration barriers remain. The provider motor helper remains in use. No history was rewritten.

- Controller full desktop regression at `f518960`: **4,046 passed / 22 skipped**, 317 files passed / one skipped. Skips are not acceptance.
- Linux arm64, actual public plugin native run `/evidence/kobrixa-motor-native-NpKI1y`: **77/77 passed**, zero failures and no remaining owned PIDs. The image checkout was `f518960`, with the original production sources, fake device provider and fresh case profiles. These receipts do not establish physical motor stop.
- Complete production packaging at `81fee0c` succeeded. The official pinned Electron distribution was downloaded during build after an offline cache miss; execution remains network-isolated. A code audit of 103 application JavaScript files in the resulting ASAR found none of the five removed private IPC routes. The ASAR SHA-256 is in `product-audit.json.gz`.

The source-free full-product installed rerun at `81fee0c` failed during primary startup: the persistence worker exited before ready (`worker-before-ready`). Its first healthy case could not reach the application UI, so no installed acceptance is claimed. The original failure log and receipt are retained; a narrow diagnostic investigation is ongoing. Subsequent Lab route cleanup has its own targeted tests; the full desktop result above is not relabelled as that later commit. Manual/platform/hardware and Stage3 aggregate gates remain open.

Original JSON/log bytes are gzip-compressed without editing. `files.json` records raw byte lengths and both raw/gzip SHA-256. Native scenario inputs, original reports, logs, matrix and source/bundle identities are retained.
