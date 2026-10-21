# API 1.5.0 device foundation acceptance

Status: UNVERIFIED. This is the initial implementation ledger, not an execution report.

| Gate                         | Status                        | Evidence required                                                                                                |
| ---------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| F baseline                   | unverified                    | Exact real 40-character SHA, freeze receipt and ancestor check                                                   |
| R150 / K150 / V150           | unverified                    | Three owner commits, exact touched paths, stopped-owner receipts                                                 |
| P150 schema and two SDKs     | unverified                    | Generated TS/Python schema equality, clean second generation, exact 1.5.0 registry                               |
| F01–F21 automated matrix     | unverified                    | Nonempty named assertions in all mapped owner suites, command and exit code                                      |
| Actual JS / Python transport | unverified                    | Electron MessagePort / Content-Length reports at the accepted commit                                             |
| Ten-minute maximum workload  | unverified                    | Measured occupancy, retained heap after GC, stop-dispatch p95 ≤50 ms and separate exchange/readback/journal data |
| A-RF1–A-RF4                  | unverified                    | Named owner tests, public-path reproduction and reviewed trace                                                   |
| A-RF5 / F19 fixture          | unverified                    | Reservation end during registration, original grant/deadline, healthy generation retained                        |
| A-RF5 / F19 real persistence | pending X-T1                  | Real B2 participant after P170; fixture evidence cannot close this row                                           |
| A-M01                        | unverified                    | USB/Wi-Fi physical motion bounds and readback                                                                    |
| A-M02                        | unverified                    | Release/hide/hang/kill/disable during pending start/arm                                                          |
| A-M03                        | unverified                    | Lost transport/reply, identity and reconciliation                                                                |
| A-M04                        | unverified                    | Collaboration roles and authority loss at consequential boundaries                                               |
| A-M05                        | unverified                    | Four-channel reservation, Disconnect/suspend final-read behavior; 3D save separately                             |
| A-M06                        | unverified                    | 120/600-second file confirmation, partial transfer, weak Wi-Fi                                                   |
| A-M07                        | unverified                    | Disk failure and crash/restart journal recovery                                                                  |
| A-M08                        | unverified                    | Installed native provider, no checkout/external Node, second instance and delivered OS matrix                    |
| Stage-2 V01–V04              | carried forward               | Preserve original exception status and evidence; no automatic closure                                            |
| 3C / 3D / 3E                 | outside foundation acceptance | Product motor proof / Lab migration / final closeout                                                             |

For each executed row record command, exit code, commit, artifact identity, OS/architecture, CPU/RAM/filesystem, Node/Electron, fixture bytes/records/limits, warm/cold, sample count, p50/p95/max and memory metric/GC method. For hardware also record brick/firmware, transport, timestamp, observer, action, observed physical outcome and fault/log references. Missing Python or skipped manual work remains unverified.

Safety disposition: unresolved stop, journal failure or pending legacy Lab save remains a blocker. An empty new-API persistence adapter does not certify legacy recordings saved. No automatic force quit resolves a blocker.

Publication: F → D150/R150/K150/V150 + T1–T9 → P150 → user no-ff merge to stage-3 → B1/B2 synchronize. Do not publish 1.6/1.7 in this batch. Real persistence integration is checked by X-T1 after the user has merged P150, P160 and P170.
