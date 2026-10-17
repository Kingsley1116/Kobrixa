# Plugin System 3B-2 — Settings and Bounded Storage Implementation Plan

**Goal:** Deliver strict typed settings, bounded immutable records, atomic publication, user export/copy, checkpoint drain, and resumable import foundations at Plugin API **1.7.0**.

**Architecture:** The protocol integrator publishes isolated B2 schemas and SDK modules only after P160. A dedicated persistence worker owns filesystem operations and incremental hashing; main owns admission, principal binding, fences, and bounded result delivery. Settings, records, import, recovery, and export share publication and quota rules. The existing runtime, desktop, renderer, packaging, and integration owners attach the factories at P170.

**Tech Stack:** TypeScript strict/noUncheckedIndexedAccess/exactOptionalPropertyTypes; repository Node 24+, Electron 44, Zod 4, draft-2020-12 JSON Schema, Vitest, Python 3.10+, pnpm. No dependency installation in T0/T1/T2.

**Binding specs:** `docs/superpowers/specs/2026-10-17-plugin-system-stage-3-design.md` and `docs/superpowers/specs/2026-10-17-plugin-system-3b2-settings-storage-design.md`; sibling ports come from the 3A and 3B-1 specs. `.superpowers/sdd/stage-3-plans/skeleton.md` controls task IDs, spelling, values, and ownership. This fragment owns 3B2-T0, 3B2-T1, and 3B2-T2. All commands below are future implementation instructions, not a claim that they ran while drafting.

## Global Constraints

- All new wire objects are strict; unknown fields are rejected. Preserve existing numeric JSON-RPC failures, initialize and `command/execute {command} → null`. New business results use the one A-owned `BusinessResult<Value, Detail>` and closed code/kind/reason registries. Do not add error.data, generic services, arbitrary HTML/React/CSS/script injection or public provider registration.
- `sourceKey` is the persistent namespace/owner root. Host-bound principal, execution generation, static generation, UI resource generation, hostEpoch/processEpoch and provider/session lifetimes are distinct. Foreign/retired handles fail stale without disclosure. A host-issued opaque reference is not transferable authority. Persistent namespace survives retirement; pending rights do not.
- Capabilities, permissions, collaboration authority, UI intent and operation leases all apply independently. Do not let manifest ID, request fields, builtin status, saved settings or cached UI state grant device writes. Reads/stop remain available according to A's original-owner safety exceptions.
- Retire/freeze admission synchronously, then run stop and drain concurrently. Keep original process channel and cleanup identity through bounded drain; cleanup has its own signal. Normal release/Disconnect/suspend/provider loss ends reservations without retiring healthy consumers; renderer loss/window destruction retires and tears down affected owners. No automatic motion, upload, run, recording, callback or mutation replay.
- Core fault/recovery views survive disabled optional features and safe mode. Safe mode is decided before optional catalog/resource/provider/process registration. Required Basic Plus/EV3 compiler policy remains. Optional-only crash/unclean exit does not add a safe-mode lock; third-party/development risk or renderer unresponsive follows the existing rule.
- One Electron single-instance gate and one `ProfileWriterLock` protect journal and persistence. Secondary exits before any writer/provider/worker/process initialization and focuses the primary. No native lock addon or second lock file.
- Preserve one broker arbitration authority and the public-only feature boundary. Remote-files UI and listed U §8 exceptions remain explicit. These plans do not migrate Lab/device preference mappings, ship the three product processes, implement UI v2, or certify 3C/3D/3E.
- Tests use actual serialized UTF-8 bytes plus declared code-point/semantic limits, with maximum and +1 cases. Do not loosen a budget to make a test pass. No claims of hard realtime, physical stop, rollback, power-loss durability, full smoke, or manual acceptance without the corresponding evidence.
- TypeScript strict/noUncheckedIndexedAccess/exactOptionalPropertyTypes; use current repository scripts and prepared dependencies. Desktop consumes package dist: rebuild protocol/runtime/SDK/device before desktop checks. No install except the shared integration owner's explicit dependency change. The architecture pass runs no implementation checks or generators.

Exact shared tables and plan-specific constraint extracts follow the task and interface inventories; they are incorporated by reference here and must be copied into the corresponding full plan.

### Shared — final user decisions, capabilities, versions, safety and lifetime

#### U §2

以下十七項**全部為最終決策**。理由與後果是後續子規格的約束。

1. **遷移設備相關三個功能。** 理由：以共用設備流程驗證插件邊界，控制本階段範圍。後果：motor 與 Lab 完整遷移；device-ev3 遷移 provider／連線／監測／設定，remote-files UI 與其餘主規格例外逐項保留。
2. **main core broker＋builtin in-process EV3 provider。** 理由：集中 authority、獨占與停止，重用既有 EV3 transport／finite-motion 實作。後果：provider interface 必須文件化並驗收；broker 不建立 raw transport；`kobrixa.ev3` compiler 與 `kobrixa.device-ev3` 生命週期分離。
3. **第三方僅開放 devices consumption，provider registration 為 builtin-only。** 理由：先驗證跨語言 consumer，限制 provider 故障面。後果：JS／Python 開發插件可使用公開 API；非 builtin 的 provider declaration 必須明確拒絕，不能因 manifest 外層 loose schema 而忽略。
4. **延後 HTML panels，只提供有上限的宣告式 charts。** 理由：現有 Lab 線圖可由公開元件涵蓋。後果：不建立 HTML host／bridge；simulator 保留例外，不以可信 React 掛載充當公開面板。
5. **motor-test 為隨 app 發送的 TS／Node process。** 理由：以實際獨立程序證明 SDK／RPC 邊界。後果：feature 不含私有 UI／設備依賴；安全排程留在 host／provider；安裝版不能依賴 checkout 或使用者安裝的 Node。
6. **宣告式 UI 分兩次交付，resource version 獨立。** 理由：先完成 motor／settings 的可用最小元件，再以 Lab 擴充。後果：3B-1 交付 forms／hold／status／progress；3D 加 charts／tables／dialog；不支援的 resource version 顯式報錯，不降級執行未知元件。
7. **受限、有 namespace／version 的 typed settings，加上獨立 bounded record storage。** 理由：設定與大量實驗資料的容量、更新及復原需求不同。後果：atomic write、revision、quota、paging、explicit export 為共用能力；telemetry 不寫入 settings。
8. **authority context 由 host 綁定，admission 與每個 consequential step 都檢查。** 理由：呼叫間與等待期間都可能失去協作控制權。後果：失權即拒絕後續寫入並停止 active motion；read／stop 保留，插件不得宣告自己的 holder／window 身分。
9. **motor 隱藏／關閉／window loss／停用／當機要求停止；Lab 隱藏繼續，停用則 drain／stop／save。** 理由：motion 需要持續可見的操作意圖，錄製則有明確背景用途。後果：採 §4.7 矩陣；safe mode 保留 core recovery／stop view；這是刻意的產品行為變更，必須更新雙語文件與 smoke。
10. **使用 Electron `app.requestSingleInstanceLock()` 維持 single instance。** 理由：以同一 host 保護 profile 寫入與設備 ownership，避免新增 native file-lock addon。後果：第二次啟動聚焦既有視窗並退出第二個 instance；journal 與 settings／storage 共用此保護，這項可見行為變更須更新文件與 smoke。
11. **三個功能置於右側「插件工具／Plugin tools」pane。** 理由：為宣告式插件面板提供一致且可切換的工作台位置。後果：`rightPanel: "plugins"` 內以 motor-test、sensor-lab、device-ev3 為 sibling tabs，與既有 EV3／collaboration panes 互斥；motor test 離開 monitor card，切換仍遵守 §4.7。
12. **使用者 Disconnect 由 host 以一次操作先停止、再斷線。** 理由：維持單一斷線動作，同時保護 motion 與尚未保存的錄製。後果：host 顯示進度，先完成 motor stop/readback、recording end/save，再斷線；插件的 `devices/disconnect` 遇其他 owner 的 active operation／reservation 仍回 busy，不能強制斷線。
13. **OS suspend 結束並保存背景 Lab 錄製，所有 motion 要求停止。** 理由：睡眠期間無法維持安全意圖與連續取樣。後果：採 §4.7 suspend 列，保留停止未確認／保存失敗狀態與 committed checkpoint；喚醒後不自動恢復 motion 或錄製。
14. **本階段 optional builtins 預設啟用，一般使用者可逐一切換。** 理由：隨 app 提供功能且保留獨立停用選擇。後果：插件設定中的開關不需 developer mode，選擇持久化；safe mode 的抑制與必要 builtin 政策仍適用。
15. **EV3 file-transfer exchange 維持 10 秒，其餘普通 exchange 為 5 秒。** 理由：保留現有經硬體驗證的檔案傳輸期限，避免較弱 Wi-Fi 下原本可完成的傳輸提早失敗。後果：§4.8 分列期限，motor exchange 仍為 2 秒；file／deploy overall deadline 與 partial／unconfirmed 語意不變。
16. **維持現有 unclean-exit safe-mode lock 規則。** 理由：optional builtins 本身不新增全域鎖定條件。後果：只有第三方／development 風險或 renderer unresponsive 才觸發此 lock；預設啟用的 optional builtin 單獨 crash／unclean exit 不觸發，程序故障由 supervisor crash-loop limits 處理，motion uncertainty 留在 core fault journal。
17. **contributed settings 逐欄立即套用，沒有 Apply 按鈕。** 理由：維持現有 EV3 連線偏好的互動。後果：每次有效欄位變更經驗證與 atomic CAS write，成功才發布新值；失敗保留該欄 draft／error／重試入口，單欄重設走相同路徑。

#### U §4.2

下表是**新增且固定的語彙**。capability 表示 provider 支援的操作契約；permission 表示 host 對 consumer 的授權；lease／authority 是每次操作的即時條件。三者缺一不能以「已安裝內建插件」替代。

| Capability／貢獻          | Consumer permission                                     | 擁有子專案與界線                                                                        |
| ------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `connection.v1`           | `devices.read` 查 catalog；`devices.connect` 連線／斷線 | 3A；只管理已驗證的候選／address，不開放 raw transport。                                 |
| `telemetry.v1`            | `devices.read`                                          | 3A；snapshot、channel definitions、bounded subscriptions，含 busy／gap／source change。 |
| `inputModes.v1`           | `devices.read` 查詢；`devices.control` 改 mode          | 3A；變更還須 collaboration authority，且不得侵犯 recording reservation。                |
| `finiteMotion.v1`         | `devices.control`                                       | 3A；jog／timed／relative-angle、query／stop；發動須 fresh authority／preflight。        |
| `recordingReservation.v1` | `devices.read`                                          | 3A；pin channel modes、排除 test motion、共享 sampler；不取得任意設備寫入權。           |
| 宣告式 panel／status      | `ui.panels`／`ui.status`                                | 3B-1；同 owner 的 catalog／instances／patches。既有 `ui.notifications` 保留。           |
| Typed settings            | `settings.read`／`settings.write`                       | 3B-2；僅自身 namespace，不能修改 host 管理的停用／安全模式狀態。                        |
| Records／export           | `storage.read`／`storage.write`／`storage.export`       | 3B-2；自身 records、quota、user-triggered export handle。                               |
| Explicit copy             | `ui.clipboard`                                          | 3B-2 定義 action 契約、3D 使用；限明確使用者動作及 bounded text。                       |

provider declaration 名稱固定為新增 `contributes.deviceProviders`，由 3A 定義 schema／allowlist；非 builtin 只要宣告該欄位，包括空陣列，即 invalid。不提供 `devices.provide` 權限，不讓 dev consumer 以 permission 升格成 provider。

consumer 所需 capability／version 及可用性須可由 manifest／握手辨識，3A 與 3B-1 在各自子規格凍結 declaration fields 與查詢結果。缺 provider、缺能力或版本不符時顯示 unavailable，不自動啟用 provider、安裝相依項目或改走私有通道；這是本階段有限的 capability 檢查，不實作第四階段的通用相依安裝／版本解決器。

remote files、deployment／program 仍有 host-only adapter contract，其讀寫分類與 consequential checks 必須在 3A 列全；本階段不宣稱已有公開 remote filesystem／build deployment API。連線 UI 的 build／deployed version 由 core 相鄰 summary 呈現，3E 不匯入 `ExecutionController` 補足它。

#### U §4.4

| 順序 | 子專案  | Host Plugin API | 契約批次                                                                                  |
| ---- | ------- | --------------- | ----------------------------------------------------------------------------------------- |
| 基底 | stage-2 | `1.4.0`         | 現行 protocol／SDK，不重用其版本發布新能力。                                              |
| 1    | 3A      | **`1.5.0`**     | devices、provider declarations、principal／operation 結果、共用錯誤與事件基礎。           |
| 2    | 3B-1    | **`1.6.0`**     | UI resource v1、commands／UI events、hold／status 與 optional builtin process lifecycle。 |
| 3    | 3B-2    | **`1.7.0`**     | settings、records／export／copy、drain 與 persistence result。                            |
| 4    | 3D      | **`1.8.0`**     | UI resource v2 的 chart／table／dialog 等增量及其公開資料契約。                           |

3C 不升版，motor manifest 最低宣告 `^1.6.0`；3D Lab 使用 `^1.8.0`；3E 組合已交付契約，完成版 device UI 使用 `^1.8.0`，不另升 minor。3B-2 或 3E 若需要表外新公開能力，先修改所屬子規格與本表、取得設計決定，再排入唯一版本批次；不能各自搶用版本。

順序約束的是**公開契約合入與發行**，不是要求所有後端程式序列開發。每次批次同步 `PLUGIN_API_VERSION`、schema `$id`、JS `API_VERSION`、Python `API_VERSION`／bundled schema、conformance 與 manifests；整合分支不降低版本。握手檢查 range 及可用能力，老 consumer 不收到未知 required fields／notifications。

UI resource declaration 固定包含 `version` 與封裝內 JSON `path`。**v1 由 3B-1、v2 由 3D 定義；v2 是完整新版本，host 同時保留 v1 支援。** resource version 與 Plugin API、package version、settings／record schema version、IR version 分開；v1 要求 API ≥ 1.6.0，v2 要求 API ≥ 1.8.0。

每個 resource version 綁定 component set、語意及限制表；未知版本回 `PLUGIN_E_UI_VERSION`，未知元件／欄位不得悄悄忽略。破壞性改變或提高既有版本的可接受上限須新 resource version；不能先以同名 v1 接受 charts。path 沿用第二階段受限 packaged JSON 規則，拒絕 absolute path、`..`、URL、symlink escape；resource retry 只換 resource generation，不續命舊 gesture／operation。

#### U §4.5

1. **host／provider 持有安全責任。** feature process 的 hang、退出、取消 callback 缺席都不能阻止 lease revocation／safe stop；程序終止與 physical stop 是不同事實。
2. **撤銷先禁止新副作用，再停止。** panel／window／authority／generation／provider 失效，立即禁止續租與 start／arm／下一個 pulse，使用原 operation 的 stop path。normal release 可遵循 brake／coast；forced stop／timeout 升級 brake，不能被晚到 coast 降級。
3. **motion 全設備獨占。** EV3 USER_SLOT／helper 可能影響全部輸出，不提供假想的 per-port 並行 lease。鎖跨越 preflight、helper 準備、arm、poll、stop/readback；foreground 完成前不讓另一個操作插入。
4. **每次 motion 有 firmware 上限。** 保留 power 1–100、方向 ±1、timed 100–5,000 ms、relative angle 1–3,600 度、jog 最長 10 秒。jog intent 100 ms 更新、350 ms 過期、pulse 最長 400 ms；angle helper 保留 fresh token、2 秒 arm、10 秒 movement watchdog、2 秒 result grace。3A 以現有程式與硬體證據確認，不能因 RPC 比較慢而自動加長。
5. **fresh preflight 不可由 UI snapshot 授權。** provider 在鎖內確認 USER_SLOT 停止、所有輸出已知且 idle、選定 motor 類型／count 可用；每次 await 後再檢查 session、取消與 authority。stop-before-start／arm 必須勝過晚到成功回覆。
6. **停止必須 readback。** 等待有界的既有 exchange，再要求 stop／brake 與確認 program／outputs；保留最多五次、間隔 100 ms 的 settling 檢查。這些間隔不是最壞停止時間，還包含 I/O timeout；UI 不承諾零延遲停止。
7. **不確定狀態由 core 保留。** 無法確認時標示 `unconfirmed`，保留 physical identity、最後 operation／原因，隔離該設備新的寫入／motion，允許讀取、停止與明確 reconciliation。fault 使用有上限的 core recovery journal 跨 app restart 保留，不能因停用／關閉 panel 被清空。
8. **永不自動重播。** crash／restart／re-enable／reconnect 不重播 motion、arm、run、upload 或錄製。新 session 不繼承舊 handle；同 physical identity 的 read-only idle confirmation 只能解除當前隔離，不能補造先前動作結果。core stop retry 必須針對確認的目前設備，不能停止不相關連線。

core journal 在首次可能發動 motion 前先提交最小 pending-operation marker，只有完成安全 disposition 才更新；journal 無法保存時拒絕新 motion。下次啟動遇到未終結 marker 先視為 unknown／unconfirmed，不能因 app 被強制終止而失去警示。3A 子規格定義 journal schema、atomic commit、physical identity reconciliation 與不保存可重播命令的規則。

| 工作類別                              | 共存／排除規則                                                                                                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| finite motion                         | 排除其他 foreground program／file／mode／motion 及 recording reservation；被動 reads yield。                                                                               |
| recording reservation                 | 一個 active recording；pin 選定 channel modes，排除 motor test 與 mode change；program／file foreground 可優先，資料記 busy／gap。                                         |
| passive monitor／battery／Lab preview | 同 session 共用 sampler，依 owner 計數；移除一個 owner 不撤銷其他 demand，不和 foreground 搶鎖。                                                                           |
| deployment／program／remote files     | 共用 foreground lock、authority 與 cancellation；多步作業逐步檢查，不以舊 IPC 取得特權。                                                                                   |
| stop／cancel／recovery                | 與 telemetry queue 分開，作用於原 ownership；不因失去 holder 而禁止，不允許 consumer 偽造另一個 owner。core 有明確的安全停止入口。                                         |
| 使用者 Disconnect                     | host 阻擋新工作並顯示進度，先完成 motor stop/readback 與 recording end/save，再斷線；插件的 `devices/disconnect` 對其他 owner 的 active operation／reservation 仍回 busy。 |

remote-files 的 prepared batch 目前跨掃描與使用者確認持鎖（[`FileBatchManager`](../../../apps/desktop/src/main/device/file-batch.ts)）。3A 將確認等待納入有限 lease；初案 120 秒未確認即 abandon，顯式操作可續租但總共不超過 10 分鐘。這是 broker 有界性的行為變更，3A 子規格確認數值並更新提示／測試；不要求本階段改寫檔案面板。in-flight transfer 可留下 partial result，取消不宣稱回滾成功。

#### U §4.7

「要求停止」一律包含撤銷 start／續租、原 operation stop 與 confirmation／uncertainty reporting，不代表立即確認停止。「drain／save」指停止接收新樣本、結束 reservation、完成已受理 bounded write，再提交 final record；成功前不可顯示已安全結束。

| 事件                   | motor                                                                                                                                                       | Sensor Lab                                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| panel hide             | 切換側欄／tab、CSS hidden 或收合時立即撤銷 gesture 並要求停止；timed／angle 同樣適用。                                                                      | 繼續背景錄製及 checkpoint，撤銷不需要的 chart preview demand；core／status 保留錄製與停止入口。                                                           |
| panel close            | 銷毀 instance 前要求停止；late start／patch 無效，core 保留未確認結果。                                                                                     | 關閉 view 不結束錄製；撤銷 panel subscription，background reservation／status 仍存在。                                                                    |
| window loss            | blur／hide／minimize／document hidden 即要求停止；window destroyed 亦撤銷所有 window-bound authority。                                                      | blur／hide／minimize 繼續錄製；window destroyed／最後視窗關閉走 drain／stop／save，不當成單純 panel close。                                               |
| OS suspend             | 撤銷 gesture／續租並要求 stop/readback；未確認結果由 core 保留，喚醒後不自動恢復 motion。                                                                   | 結束背景錄製與 reservation，bounded drain／save；OS 未留足完成時間或保存失敗時保留 interrupted／最後 committed checkpoint 與可用 retry 狀態，喚醒不續錄。 |
| second-instance launch | 第二個 instance 不啟動設備或插件，聚焦既有視窗後退出；不建立新 operation、不重播 motion，既有 window loss／停止狀態仍有效。                                 | 既有 instance 的錄製不因第二次啟動而重建或結束；第二個 instance 不建立 recorder 或寫入 profile。                                                          |
| feature disable        | 立即禁新工作、host stop，withdraw UI／commands，bounded shutdown；故障留 core。                                                                             | 禁新 recording／commands，drain／stop／save 後退出；失敗保留 core save error／checkpoint，不能以無條件成功覆蓋。                                          |
| provider disable       | 先阻擋新操作並 stop/readback，再撤銷 session／provider；無確認則 quarantine／core fault，不能假裝 idle。                                                    | 結束來源、drain／save，標示 provider unavailable；feature 本身不被一併永久停用，恢復 provider 不續錄。                                                    |
| renderer crash         | main 撤銷 gestures／window authority、要求 stop；不等待 renderer cleanup。                                                                                  | host 結束 recording reservation，健康的 feature process bounded drain／save；失聯則復原最後 checkpoint，標示 interrupted。                                |
| plugin crash           | main stop／撤銷 leases，丟棄晚到訊息；重啟不重播。device UI process crash 撤銷其 owned operations，不等同 provider 關閉。                                   | crash owner 的 reservation／subscriptions 由 host 回收；只承諾最後 committed checkpoint，重啟顯示 interrupted，不續錄。                                   |
| app shutdown           | 先擋 admission、stop/readback，再 teardown provider／process；正常 close／update 未確認時保留 blocker。forced exit 仍記 uncertainty，不宣稱 physical stop。 | 正常 close／update 等 drain／final commit；save error 阻擋正常完成並提供 retry。forced exit 僅保留已 committed checkpoint。                               |
| safe mode              | 註冊前抑制第三方與本階段 optional features，不開 panel／process／自動連線或 motion；core recovery／stop view 仍可啟動。                                     | 不啟動 recorder／background subscription，不自動還原錄製；保留 records／checkpoint 與 core recovery／export 說明。                                        |

safe mode 在還原 panel／文件前決定 catalog、provider、process 與 settings contribution 的可用性。第二階段必要 Basic Plus／EV3 compiler 政策保留；擴充的是本階段 optional builtin 的抑制與持久化停用，不把所有 builtin 改成可停用。退出 safe mode 也不自動恢復使用者已停用的 source。

依決策 16，unclean exit 只有第三方／development 風險或 renderer unresponsive 才鎖 safe mode；optional builtins 單獨載入、crash、斷電或強制結束不新增 lock。既有 CLI／persisted lock／state corruption 的抑制仍適用，core journal／checkpoint recovery 不以是否鎖定為前提。

健康 feature process 在一般停錄、Disconnect、suspend 與 provider loss 後存續，execution generation 不變；舊 reservation／motion scope 失效，Disconnect／provider loss 亦撤銷舊 session；suspend 可保留 gated session，wake 僅解除已釐清的 suspend gate，provider 恢復亦不續作。被 disable／replace 的 provider source 本身仍 teardown，其他健康 consumers 不跟著退役。renderer loss／window destroyed 則 retire 受影響 owner，bounded drain 後關閉其 process；下一次允許的明確 open／command 才以新 generation／processEpoch 啟動並建立新 panel／status bindings。safe mode／user disable 仍優先，renderer reload 不自行啟動 feature 或重播操作。

core recovery／stop view 不依賴三個 optional feature。已有可用 session／cleanup handle 時可由 broker 要求停止；provider 已撤銷、冷啟動尚未連線或設備斷線時，畫面保留「停止未確認」及復原入口，不能為了顯示成功偷偷啟用 provider／連線。正常 disable 可留下有期限的 host cleanup handle，但不能保留一般操作權。

現有 [`motor-test-smoke.mjs`](../../../tests/desktop/motor-test-smoke.mjs) 會切換 `rightPanel` 並斷言 timed motion 繼續；[英文使用文件](../../../docs/en/motor-test.md) 卻已描述關閉側欄要求停止。3C 必須改成矩陣行為的雙語文件與 smoke，增加「start 未回覆前 hide」案例，不能只刪掉舊斷言。

#### U §4.8

以下為實作前的**初始數值**。所列 owner 必須在自己的子規格以最大合法 fixture、邊界反例與效能證據確認或調整，於其 T0 凍結；調整共同上限須同步本文。resource version 發布後不可原地放寬。bytes 指序列化 UTF-8 大小；數量與 bytes 兩者均須通過，插件不得自訂較大 quota。

| 類別                     | 初案                                                                                                                                                                                                                | 確認 owner／超限行為                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 共用 wire／manifest      | 維持 1 MiB／64 KiB；commands／activation events 各 64                                                                                                                                                               | 3A／3B-1；保留現有 `PLUGIN_LIMITS`，不能靠提高 frame 上限承載完整歷史。                                                                                       |
| UI resource              | 每份 256 KiB、每 source 合計 1 MiB、host 合計 8 MiB；每份 256 nodes、depth 8、純文字單值 4,000 字元                                                                                                                 | 3B-1；註冊前拒絕超限，不截斷安全控制。                                                                                                                        |
| UI instances／patches    | 每 source 4 panels／2 status items，host 16 panels／16 status items；單 patch 64 KiB、每 panel 10 次／秒、待送 4 個 patches                                                                                         | 3B-1；合併一般更新，超限顯示問題；stop 不排在 patch queue。                                                                                                   |
| Action／event            | arguments 16 KiB；每 source 32 subscriptions、16 pending 一般 RPC；telemetry batch 64 frames／64 KiB、queue 256 KiB                                                                                                 | 3A／3B-1；解除或 gap 必須明示，不無限緩衝。                                                                                                                   |
| 安全狀態／gesture        | 8 個獨立 control-event slots／source；gesture 每 100 ms 更新、350 ms 過期；單 source 同時一個 active hold                                                                                                           | 3A／3B-1；overflow 或 renderer heartbeat 停滯撤銷 intent，core snapshot 保留 terminal 狀態。                                                                  |
| Device operation         | 一個 active connection、一個 foreground operation、一個 recording reservation；prepare reference 5 秒失效                                                                                                           | 3A；衝突回 busy，過期 reference 無副作用。                                                                                                                    |
| I/O／operation deadlines | motor exchange 2 秒，EV3 file-transfer exchange 10 秒，其餘普通 exchange 5 秒；motion overall 30 秒、stop/readback 15 秒；普通 foreground 60 秒、file／deploy 10 分鐘                                               | 3A；file-transfer 沿用現有硬體驗證值；各 deadline 獨立，超時進 cancel／stop／partial／unconfirmed，不宣稱 transport 可強制中斷；provider 細分每種 operation。 |
| File confirmation        | 120 秒 idle lease，明確續租但總共最多 10 分鐘                                                                                                                                                                       | 3A；abandon plan、釋鎖並保留 UI 可重試結果。                                                                                                                  |
| Telemetry sampler        | 有 monitor／Lab demand 時每次 poll 完成後等 500 ms，無重疊；fresh sample 2.5 秒                                                                                                                                     | 3A；沿用現況的最多約 2 Hz，而非固定硬體取樣率。                                                                                                               |
| Battery-only sampler     | 僅剩 battery demand 時，每次 read 完成後等 30 秒，無重疊                                                                                                                                                            | 3A；沿用現有 `BATTERY_POLL_MS` 的較低需求，仍使用同一 sampler；monitor／Lab demand 恢復時回到上一列 cadence，不啟動第二個 clock。                             |
| Settings                 | 每 source 128 keys、schema 64 KiB、values 64 KiB、單 string 4 KiB                                                                                                                                                   | 3B-2；型別／revision／容量不符拒絕，保留 committed values。                                                                                                   |
| Record storage           | 單 record 8 MiB、每 source 256 records／512 MiB、host 1 GiB；page 64 entries 或 256 KiB、chunk 256 KiB，先達者為界                                                                                                  | 3B-2；容量包含 staged writes 的 reservation；50 筆 Lab 最大合法 records 必須可遷移。atomic replacement 的暫存空間另行預留並檢查 disk-full。                   |
| Storage／export 工作     | 每 source 2 staged writes、1 export；staging idle 30 秒、整筆 120 秒；一般 write／flush 10 秒                                                                                                                       | 3B-2；逾時刪除未 commit staging，既有 record 不受影響；export 等待使用者選檔不占設備鎖。                                                                      |
| Lab／charts              | 4 channels、30 分鐘或 3,600 frames、50 recordings；5 秒 checkpoint；preview 60 秒／240 frames；每圖 2 series、每 series 800 display points、4 圖共 6,400 points                                                     | 3D；保留 raw samples、extrema／segments／null gaps；table 一頁 50 rows，dialog 同 panel 最多 1 個。                                                           |
| Lifecycle                | 沿用 initialize 10 秒、普通 command 30 秒；storage drain 10 秒與 device stop/readback 15 秒＋journal commit 5 秒平行，再進 manager 4 秒 shutdown（內含 request 2 秒）；`max(10,15+5)+4 = 24` 秒 cleanup，外層 25 秒 | 3A／3B-1／3B-2 共用；25 秒只是一次清理嘗試上限，不是自動 force exit。unconfirmed／save error／journal error 保留 blocker。                                    |
| Core fault journal       | 64 個 unresolved/recent entries、單筆 8 KiB；8 MiB 總容量含替換空間                                                                                                                                                 | 3A；不可淘汰 unresolved fault 來接受新 motion，滿額拒絕新風險操作並提供清理／復原說明。                                                                       |

安全 timeout、firmware watchdog、gesture expiry、RPC timeout 與 shutdown deadline 是不同 clock。3A／3B-1 T0 要列完整時間線，stop cleanup 不沿用已 abort 的一般工作 signal。健康系統每 5 秒 checkpoint；若 storage 卡住則停止錄製並顯示保存失敗，不能承諾任意 I/O 故障下最多只丟 5 秒資料。crash 只保證最後成功提交的 checkpoint。

### 3B-2 plan-specific Global Constraints

#### B2 §2.3

沿用 umbrella §4.8 的所有 3B-2 數值，不提高共用 frame 或 UI v1 上限。KiB＝1,024 bytes，MiB＝1,048,576 bytes。JSON bytes 為實際無 BOM UTF-8 序列化大小；字串的 code-point 長度與 UTF-8 bytes 分別檢查。API 1.7.0 的最大合法 fixtures 與效能門檻於本規格固定，T0／實作驗收須附實測，不能把本表視為已取得性能證據。

| 項目                       | 固定上限／處置                                                                                                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings                   | 每 source 128 keys；resource 原文 64 KiB；完整 values 陣列 64 KiB；單一 string／enum string 4 KiB。schema defaults 組成的完整 values 亦須符合 64 KiB。                                                                                              |
| Record                     | payload 8 MiB；每 source 256 筆／512 MiB；host 1 GiB。容量包含未完成與保留 staging 的**完整 reservation**，不是只算收到的 chunks。                                                                                                                  |
| Metadata                   | record label 160 code points／640 bytes；kind 64 ASCII bytes；單一 record 公開 metadata 2 KiB，head 8 KiB。metadata 另計實體 overhead，不能藏 payload。                                                                                             |
| List／read                 | list 一頁最多 64 entries 且完整 result ≤256 KiB，先到者為界；read 每次 decoded bytes ≤256 KiB。                                                                                                                                                     |
| Staging                    | 每 source 2 筆，host 16 筆；chunk decoded bytes ≤256 KiB；同一 write 一次只處理一個 chunk。                                                                                                                                                         |
| Staging deadline           | idle 30 秒、從 begin admission 起總共 120 秒；只在成功接受新 bytes 時更新 idle。seal 最後一次成功亦可更新 idle，但不重設 total。                                                                                                                    |
| 普通 persistence RPC       | read／write／commit／delete／flush 10 秒；staging 120 秒不是單次 I/O timeout。等待 queue 亦計入 10 秒。                                                                                                                                             |
| Export                     | 每 source 1 個，host 4 個；內容最多 8 MiB，使用獨立 export slot，不占每 source 2／host 16 個 staged-write slots；僅 payload bytes 計入共用 reservation；dialog 等待最多 120 秒；內容 staging 的 30／120 秒從選定目的地後才開始。                    |
| Copy                       | 單次 plain text 64 KiB、最多 16,384 code points；不得含 NUL／unpaired surrogate。                                                                                                                                                                   |
| Checkpoints／subscriptions | 每 source 2 個 checkpoint registrations；settings watchers 共用 umbrella 的每 source 32 subscriptions，不另加 32。                                                                                                                                  |
| Paging handles             | 每 source 4 個 list snapshots＋4 個 read handles；idle 30 秒、總共 120 秒。metadata cache 每 source ≤512 KiB，host ≤8 MiB；超限拒絕新 handle。                                                                                                      |
| Work／events               | 沿用每 source 16 pending 一般 RPC／256 KiB event queue；host persistence worker 最多 4 個進行中的 I/O jobs，其餘受 bounded admission。                                                                                                              |
| Drain                      | 全部 retiring sources 共用 10 秒 storage drain，之後才可進 manager 4 秒 shutdown bound，其中 shutdown request 2 秒；device safety disposition／journal 亦為整體關卡，§8.3 固定 cleanup 24 秒，外層 safety net 25 秒。不是每 source 依序各等 10 秒。 |

實體檔案 overhead、atomic replacement 額外空間、刪除後仍被 pin 的 object 另依 §6.4 計量。50 筆各 8 MiB 的合法 Lab records＝400 MiB；加 2 筆各 8 MiB staging＝416 MiB，仍低於 512 MiB。calibrations 及其他 feature records 也計入同 namespace；3D fixture 必須核對實際總量，超限不得以截斷歷史完成 import。

#### B2 §5.3

一個 record 同時只接受一個 active replacement／delete；有 receiving／sealed write 時第二個 mutation 回 `write-in-progress`。CAS 在 begin 初驗、commit publication gate 下重驗；settings 同樣重驗。新 generation 可以讀 persistent record，但不能接管舊 write。retirement 的特許只限 §8 發給原 generation 的 drain token。

chunk offset 必須等於 receivedBytes，host 以完整 short-write loop 寫入；不准 sparse／overlap。為處理 ack 遺失，只允許「緊接前一個已確認 chunk」以相同 offset、相同 bytes 重送，回相同 receivedBytes，**不延長 idle**；其他重疊回 offset-mismatch。canonical base64 拒絕 URL-safe、空白、缺／多 padding、無效尾端 bits；先檢查 encoded size≤349,528 ASCII bytes，再解碼及檢查實際 256 KiB。每筆串行，跨 write 可並行。seal 後 immutable；checksum 不合留下 failed 狀態並解除可 commit 權，不能只更改 claimed hash。

首次成功 seal 才更新 idle；重複 seal 回同一狀態，不續租。seal 後因 publication 前 I/O 失敗而可重試時，writeStatus 仍為 sealed 並帶 error；terminal failed 僅用於無法再提交的無效 payload。同 principal 的 closeRead 冪等使用 bounded tombstone policy；settings unsubscribe 依 3A `events/unsubscribe` 的 `{removed:boolean}`／tombstone 契約，過期後回 stale，不永久累積句柄。delete 的 tombstone 保存被刪除 revision；120 秒 outcome retention 內以相同 expectedRevision 重送 delete 回原 receipt，之後回 not-found，永不重建 record。

record replacement 在 publish 前舊 revision 可正常 stat/openRead；publish 後新 read 只看到新 revision。對已開 read 的 chunk 使用 pinned old bytes，不能拼出新舊混合資料。read offset 可任意在 0..byteLength，便於重取；offset==byteLength 回空 base64／eof=true，超界為 invalidParams。最大 read response 約 350 KiB 加 bounded envelope，仍低於 1 MiB；256 KiB read budget 指 decoded bytes，不與 list 的 serialized result 上限混淆。

list 首頁複製 bounded metadata snapshot，排序為 `createdAt` 降冪、同時刻依 ID ASCII 升冪。cursor 封裝 owner、generation、filter、limit、snapshot 與下一個 index；後續 params 的 kind／limit 必須與首頁一致。替換／新增／刪除不改已建立 list snapshot；列出的舊 revision 隨後 openRead 可能回 conflict／not-found，consumer 可重新 list，不能自動以新版本冒充。cursor 到期或最後一頁釋放；不以 payload pin 支撐 list。重複請求同 cursor 在存活期內回相同頁；cursor 最後使用後保留到 idle 期限，quota 滿時拒新 snapshot，不無界保存。

每個成功進入 publication 的 write 產生唯一 commitId，新 revision 亦唯一。committed／aborted／expired／terminal failed status 保留 120 秒，最多 64/source、1,024/host；滿額時先移除已到期者，否則拒新 begin，不能淘汰尚需查詢的 status。host restart 不恢復 transient write handle；consumer 以 record ID／revision／hash 對帳。SDK 不自動重播 create、commit、delete 或 settings mutation。

取消在 publish syscall 尚未 dispatch 前撤銷 mutation ticket、保留舊值；receiving temp 清理，sealed 是否暫留依 §8.3。rename dispatch 後不能保證取消，worker 必須完成或將 outcome 標為 unknown。timeout 不釋放 unresolved namespace mutation fence、不允許下一個 mutation 越過它。晚到成功只更新原 ticket／core recovery，不重新授予舊 generation。這亦適用 settings、delete、import marker 與 export。

#### B2 §6.3

每次 settings／record commit、delete tombstone、import marker 與 recovery 更新使用相同 primitive。以下以 replacement 為例：

1. 驗證 input、owner、target CAS、payload quota、temporary reservation 及可用磁碟提示；生成 ticket。空間不足不碰既有 head。
2. 同一 filesystem 建立獨占 temp（`wx`）；逐塊寫入、計算實際 length／hash，完整後 file sync，關閉 write descriptor。若是 record，這是 seal 步驟；settings 由 host 產生完整 object。
3. 將 payload 移入唯一 `objects/<new-revision>` 名稱，同步 objects directory 及來源 staging directory（支援的平台）。object 此時不可見，不能在 startup 將它自行升為 current。
4. 在 publication gate 內重查 CAS、principal／drain fence。若有舊 head，先以 temp→sync→rename→directory-sync 建立 `head.previous`；尚未確認的新 head 不得覆蓋 backup。產生新完整 head temp，file sync 後關閉。
5. **線性化點：** 對 `head.json` 做同目錄 atomic replace。任何取消／retirement 若在 dispatch 前取得 fence，步驟 5 不得開始；dispatch 後必須對帳 outcome。
6. 同步 head 的 parent directory；在支援平台成功後才發布 cache／receipt／watch。不支援 directory sync 的平台使用明示 policy（下段），仍要求 file sync 成功。保留 pinned old payload，解除不再需要的 reservations。
7. 刪除 head.previous、無引用舊 object／temp，directory-sync 清理結果。cleanup 失敗不撤銷已成立 commit；記入 temporary charge／core problem，後續 GC 重試。不能因 finally 清理失敗把 durable success 改成未提交。

file sync 使用完整 metadata sync，不以 `datasync` 替代；Node 的 `FileHandle.sync()` 是向 OS／裝置要求 flush，實際行為仍依平台及裝置而異。[Node.js filesystem 文件](https://nodejs.org/api/fs.html#filehandlesync)亦明示這個限制。實作不得將 `writeFile` resolve 當成 durable acknowledgement。

Linux／macOS 的 supported local filesystem policy 為 file sync＋父目錄 sync，新增目錄的祖先亦在首次成功回覆前同步。Windows 要求 payload／head file flush 及同 volume replacement，directory sync 若由平台 adapter 判定不支援，receipt 為 `file-sync-only`；不使用先 unlink 舊檔再 rename 的 fallback。平台支援判斷在初始化做一次並記錄，不將 ENOSPC／EIO／permission 錯誤歸類成「不支援」。export 到不提供 atomic replacement 的 destination 回 unsupported-filesystem，不改舊檔。Windows replacement 的限制依 [MoveFileExW 文件](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)及實際 adapter conformance 驗證；不得使用跨 volume copy-and-delete 冒充 atomic rename。

此版本承諾 supported filesystem 上的完整舊版或完整新版可見、process crash 復原與明確 fsync policy；不承諾任意硬體斷電、失效控制器、網路共享磁碟的物理耐久。file-sync-only 仍可正常 close，但 core「保存詳情」必須可查看保證範圍；不能把「存檔成功」翻譯成「所有平台都保證斷電無損」。測試須將 process kill 與 power-loss 模型分開。

步驟 5 前失敗為 not-committed，舊 head／data 不變。rename 已 dispatch 後的 timeout、directory-sync failure 或結果遺失為 unknown；保留新舊 object／backup、阻擋該 namespace 新 mutations，read 先對帳 head，不能先回舊 cache。確認 head／hash 完整後可重做 sync、建立 receipt 並解除 fence；不再自動 publish 第二次。若無法確認，持續 core blocker，不能將 unknown 說成「沒有保存」。

#### B2 §6.4

logical quota 在記憶體的 host ledger 序列預約，受 core `ProfileWriterLock` 保護，startup 從 validated heads 重建；快取不是唯一真相。每筆 begin 為完整 byteLength 預約，即使尚未收到 bytes。replacement 同時計舊 committed＋新 reservation；達 512 MiB 時可能須先明確刪除資料才可更新，不允許臨時越過 quota。這是保留舊版本的必要空間，UI 在開始工作前展示不足。

除 logical quota，新增 physical temporary budget：每 source 32 MiB、host 128 MiB，用於已替換／刪除但仍被 read/export pin 的 object、publication backup、清理失敗檔案。仍在 staging reservation 內的同一 bytes 不重複計這個 budget；move object 不複製 payload。begin／openRead 預約可能留下的 old revision 空間，不能讓長期 readers 造成無界 retained data。metadata（含 settings、import journal、recovery 與 tombstones）另限每 source 4 MiB、host 64 MiB；host logical records/staging 仍是 1 GiB，另有至多 128 MiB temporary＋64 MiB metadata 的實體空間，符合 umbrella 將原子替換暫存另計的要求。source 的歷史未知檔／quarantine 實體大小按 payload 或 metadata 分類計入對應額度。

available disk 檢查扣除其他已預約實體增量與 16 MiB headroom；這是 admission 提示，`statfs` 不能保證後續別的程式不寫滿磁碟。每次 write／sync／rename／mkdir 仍處理 ENOSPC／EDQUOT。發生 disk-full 立即停止該 pending commit，不刪除舊 head、checkpoint 或原始 legacy data，不用「成功的預設值」掩蓋。sealed payload 可以在剩餘 staging TTL 內重試；未完整 payload 不宣稱可保存。

GC 只刪除經 reference scan 證明無引用且不在 unresolved ticket 的物件。delete tombstone 在沒有 pins、active write、import references 或未到期 outcome receipt 後可清除；ID 永不重用，不需永久累積 tombstones。quota 滿時拒寫，不自動淘汰 user records。磁碟遭外部大量塞檔已超 budget，保留 evidence 並封鎖新增寫入，由 core 明確清理；不能為了回到限制而自動刪損壞資料。

#### B2 §8.3

以下是 owner retirement／app close 時間線。non-retirement endReservation 只使用原 10 秒 final window，不關閉健康 process，也不進 manager 4 秒 shutdown；session quiesce 的 stop/readback／journal 與 final drain 仍平行。

```text
t0        3B-1 關閉新工作；3A 撤權／停止來源；3B-2 freeze admission
t0..10s   全 sources 共用 storage drain：停止取樣、final chunks、seal、commit、flush
          3A 安全 stop/readback 並行，自己的 bound 最多 15s
至 t10    撤銷 drain token；留下 saved／retryable／checkpoint-only／uncertain
至 t15    broker stop/readback 給出 confirmed 或 retained uncertainty
至 t20    3A final fault-journal commit 最多另 5s；失敗仍是 blocker
至 t24    所有 cleanup participants 給 disposition 後，manager shutdown bound 4s
          其中 shutdown request 2s；沒有資料／設備工作的 source 可提早 teardown
至 t25    外層 safety net 1s，彙整結果；不是自動 force exit 時限
```

cleanup 上限為 `max(10,15+5)+4`＝24 秒，外層加 1 秒 safety net＝25 秒；只有 storage 工作時最多 10＋4 秒 cleanup。與 3A §8.2、3B-1 §11.5 使用同一完整 disposition 關卡，不延長 storage drain 或一般 write deadline，也不能在 journal 尚未確認時宣告 clean close。queue／worker 未回應只得出 blocker／unknown，**不是 25 秒到就自動退出**。正常 close／update 保存失敗留在 core，使用者 retry 成功後再完成，或明確 force exit。重複 close／disable 合併同一 offer，不重新獲得 10 秒。取消關閉後需要新 generation 才恢復一般插件權限，不復用舊 token。

| 資料狀態                                     | retirement／deadline／程序失效處置                                                                     | 可向使用者承諾                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| feature memory 尚未傳送                      | deadline 到即無法取得；終止 process 前 core 標記。                                                     | 只有最後 committed checkpoint；不能宣稱 retry 能找回尾端。          |
| receiving、不完整 length/hash                | owner crash／abort／idle／total expiry 後刪除；graceful drain 在原 TTL 內可補完。                      | 不能作完整 payload retry；尚健康 feature 可在期限內完成。           |
| sealed、尚未 publish                         | 可保留給原 owner drain 或 core retry，期限＝`min(lastProgress+30s,created+120s)`。                     | 在 expiresAt 前 host 持有完整、已驗證 payload；不是 committed。     |
| sealed、commit 因 disk-full／permission 失敗 | 不再取樣，保留相同 reservation／slot／CAS；core 顯示倒數、retry／export／discard。失敗重試不續租。     | 期限內有條件重試；quota／磁碟問題仍可能失敗。                       |
| publish 已 dispatch、outcome 未定            | 保留 mutation fence 與新舊檔，不能刪仍在 syscall 使用的 temp；禁止新的 publish。                       | unknown，不能承諾 rollback 或 safe close；晚到結果對帳後更新 core。 |
| final commit 已確認                          | 撤 registration、釋 reservation，按 sync policy 完成；GC 可延後。                                      | 完整 final record 已保存，不因 process 接著退出而失效。             |
| retention 到期／明確 discard                 | 先撤所有可 publish ticket；未 dispatch 的 temp 清除，剩 committed checkpoint；已 dispatch 的仍須對帳。 | 清楚轉 checkpoint-only；不能繼續顯示「重試最後內容」。              |
| host crash／force exit                       | transient staging 不承諾跨啟動 retry；下次依 §6.5 丟棄它，保留 committed head／recovery evidence。     | 只有最後確認或復原確認的 committed checkpoint，可能失去未提交尾端。 |

expiry 以 host monotonic clock，不接受 caller 時間。seal 只證明 host 完整持有 payload；不建立無期限 durable recovery record，也不把 staged payload 改分類以繞過 120 秒。core retry 不喚醒停用 plugin，重新驗原 CAS／hash／quota，使用剩餘 TTL 與獨立最多 10 秒工作期限；retry 已 dispatch 後跨 TTL 的 outcome 同樣 unknown，不能假裝已刪除成功。core export 只 pin 同一 payload 至原 TTL；不得藉 export 延長原 retry 權，新的 export 有自己的 destination job。

host process crash 使普通 mutation fence 的程序內狀態消失；下一程序須先通過同一 core single-instance gate／ProfileWriterLock 並完成 recovery，再允許新 namespace writes。worker I/O 無法強制取消時，文件不承諾立刻釋放實體檔；logical rights 已撤，stalled bytes 維持計量，core blocker 留存。正常 app close 不將仍未知的 I/O 當 clean；force exit 是明確的資料風險決定。

#### B2 §12.2

T0 固定量測環境欄位：OS／architecture、CPU／RAM、filesystem、app artifact／commit、Node/Electron、fixture bytes／records、warm/cold、30 次樣本的 p50／p95／max、main/worker RSS。不能用實測慢就單方面放寬 umbrella budgets。

| 工作負載                                                      | 通過門檻                                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 128 keys／64 KiB values，通用設定頁 16 fields                 | 本地 draft 更新 p95≤50 ms；切頁 p95≤100 ms；逐欄立即提交有 busy／error 狀態，無 Apply 按鈕，不阻塞其他欄位 input。             |
| 50×8 MiB records 的 list／256 KiB read，4 個 persistence jobs | warm metadata list p95≤200 ms；main 單段同步工作≤16 ms；peak 額外 main RSS≤32 MiB、worker RSS≤64 MiB，不常駐 400 MiB payload。 |
| 最大 8 MiB replacement／final commit                          | 在指定 local SSD fixture 下單 commit／flush≤10 秒；超時回誠實 outcome／blocker，不能無限延長。                                 |
| storage 壓力與 3A safety path 並行                            | persistence 引入的 stop dispatch 額外延遲 p95≤50 ms；不串入 device foreground queue。這不是實體 stop/readback 時間承諾。       |
| import 50 最大 records＋settings                              | streaming peak 記憶體符合上述限制；每 item 前後可恢復、每批回應進度；不設以刪資料換取完成時間的捷徑。                          |

執行受影響的 protocol／runtime／SDK／desktop tests、schema drift、Python tests、typecheck／lint／format，並接既有 plugins／settings／Sensor Lab smoke 的相容檢查。可用命令包含 `pnpm --filter @kobrixa/plugin-protocol schema`、`pnpm test:python-sdk`、`pnpm check:desktop`、`pnpm test:desktop`；新增 fault／public storage smoke 的精確入口由 plan 配給唯一測試 writer。只跑必要範圍後整合共用一次結果，不將未跑完整 smoke 寫成全通過。

#### B2 §3.2 — exact code/reason table

| Code                                     | `detail.reason` 固定 enum／用途                                                                                                                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PLUGIN_E_SETTINGS_SCHEMA`               | `invalid-resource`、`invalid-value`、`duplicate-key`、`unknown-key`、`size-limit`、`schema-changed-without-version`、`migration-required`、`downgrade`、`unsupported-format`、`corrupt`。                                                                          |
| `PLUGIN_E_SETTINGS_CONFLICT`             | `revision-mismatch`；不自動 merge 或覆寫。                                                                                                                                                                                                                         |
| `PLUGIN_E_SETTINGS_SAVE`                 | `disk-full`、`permission`、`read-only`、`io`、`sync-failed`、`publish-uncertain`、`import-pending`。                                                                                                                                                               |
| `PLUGIN_E_STORAGE_QUOTA`                 | `record-count`、`source-bytes`、`host-bytes`、`temporary-bytes`；檢查 reservation 後的數量。                                                                                                                                                                       |
| `PLUGIN_E_STORAGE_CONFLICT`              | `revision-mismatch`、`write-in-progress`、`offset-mismatch`、`sealed`、`incomplete`、`checksum-mismatch`、`flush-incomplete`、`export-not-ready`。                                                                                                                 |
| `PLUGIN_E_STORAGE_IO`                    | `not-found`、`disk-full`、`permission`、`read-only`、`io`、`sync-failed`、`publish-uncertain`、`corrupt`、`import-pending`、`input-changed`、`clipboard-unavailable`、`destination-changed`、`unsupported-filesystem`。                                            |
| `PLUGIN_E_STORAGE_VERSION`               | `unsupported-format`、`schema-mismatch`；保留原 bytes，拒絕錯版本 decode。                                                                                                                                                                                         |
| `PLUGIN_E_PERMISSION_DENIED`             | 使用 3A `PermissionErrorDetail`，`kind:"permission"`；缺 consumer permission 為 `permission`，缺真實使用者動作為 `user-action-required`。                                                                                                                          |
| `PLUGIN_E_STALE_RESOURCE`                | 使用 3A `ResourceErrorDetail`，`kind:"resource"`、`reason:"stale"`；不洩漏 foreign existence。                                                                                                                                                                     |
| `PLUGIN_E_RESOURCE_LIMIT`                | 使用同一 `ResourceErrorDetail`，`reason:"quota"\|"rate"\|"queue"`；handle／bytes 上限用 quota，RPC／callback queue 上限用 queue。`resource` 使用 3A 按版本批次擴充的 enum，其中 1.7.0 的 storage write/read/list/export/watch entries 原樣匯入，不另定字串或欄位。 |
| `PLUGIN_E_TIMEOUT`／`PLUGIN_E_CANCELLED` | 消費 3A 的共用 code／detail 契約；不得在 `PersistenceDetail` 另列 `deadline`／`cancelled`。若無適用 detail 則省略，已受理寫入的 disposition／receipt 仍留在 status 與 core recovery，不推論 rollback。                                                             |
| Lifecycle codes                          | `PLUGIN_E_DISABLED`、`PLUGIN_E_SAFE_MODE`、`PLUGIN_E_SHUTTING_DOWN` 無需 detail；若已有 publish，返回原 receipt／unknown，不將已提交寫入重新分類成未執行。                                                                                                         |


The five Review Focus lines are supplied by P12 and assembled here before Parallel Execution. T2 directly owns B2-RF1 and the engine/quota/streaming portion of B2-RF5; the named atomic-store tests below pin these obligations. B2 §10 has descriptive rows, not numbered IDs: this plan cites each row by its original failure description and cites §12.1 groups 1–8 without inventing replacements.

## Review Focus

- **B2-RF1 — T2/T4:** Head replacement was dispatched when cancellation/timeout occurs; preserve both evidence sets, fence new writes, reconcile the original receipt and never claim rollback or republish. Pin in `apps/desktop/src/main/plugins/persistence/atomic-store.test.ts` and `tests/desktop/plugin-persistence-kill.test.mjs`.
- **B2-RF2 — T3:** A mixed numeric/string enum or dotted key changes while an external revision arrives; restore exact key/type, retain dirty draft, and require explicit retry without widening v1 LocalId/choice. Pin in `apps/desktop/src/renderer/settings/contributed-settings-form.test.ts`.
- **B2-RF3 — T5/X-T1:** End/retirement races registration and a final write; no target is lost or finalized twice, no deadline extends, and only complete host-held payload is retryable until its original TTL. Pin in `apps/desktop/src/main/plugins/persistence/lifecycle.test.ts` and `tests/desktop/stage-3-foundations.test.mjs`.
- **B2-RF4 — T5:** Expired/replayed/wrong-owner action and late native dialog results attempt export/copy; no destination/clipboard mutation occurs, waiting holds no device lock, and returned errors contain no paths or values. Pin in `apps/desktop/src/main/plugins/persistence/actions.test.ts`.
- **B2-RF5 — T2/T6/T7:** Kill between import item commit and receipt/marker under 50 maximum records; repeated recovery keeps IDs/bytes/count stable and originals intact, while quota, queue, RSS and stop-dispatch latency remain bounded. Pin in `tests/desktop/plugin-persistence-import.test.mjs` and `tests/desktop/plugin-persistence-load.test.mjs`.


---

## Parallel Execution

### One shared T0, three ordered freeze steps

Execute **3A-T0 → 3B1-T0 → 3B2-T0** as one short, non-releasable cross-plan T0 on `feat/plugin-system-stage-3`. The three T0 sections are portions of the same operation, not independent freezes that each feature branch reruns. The controller records the final baseline SHA and per-file successor owners in `docs/superpowers/plans/2026-10-17-plugin-system-stage-3-contract-freeze.md` (future artifact). Each plan's preflight verifies that receipt and the contract tests; if absent, execute all three T0 portions in order before starting its tasks. No task silently acquires contracts from an unmerged sibling branch.

T0 freezes formal module-local types, host-only ports, export destinations, error/event registries by batch, schemas/semantic fixture expectations, all budgets, maximum workloads, performance measurement fields, and ownership. It provides compilable type-only scaffolds and explicitly unavailable/inert adapters only where a task needs them. No transport constructor, filesystem writer, process launch, UI registration, or motion is wired in T0. Do not publish API 1.6/1.7 schemas, methods, permissions, events, or required fields in 1.5. Future domain modules may compile internally but are absent from public runtime exports/method registration and generated schema until their batch (type-only forward exports are permitted for the unreleased contract baseline). T0 keeps the published API at 1.4.0; the unreleased baseline is not a product acceptance gate. All ordinary existing behavior remains available. Type-only host exports can be assembled by the unique runtime owner; contract tests can import unpublished modules directly.

After step 3, the controller publishes one baseline commit **F**. The user/controller cuts `feat/plugin-3a`, `feat/plugin-3b1`, and `feat/plugin-3b2` from F on `feat/plugin-system-stage-3`; record actual SHAs, never substitute a guessed SHA. Each implementation task may use an isolated worktree from its plan's recorded baseline. Tasks use only their declared write set and local mocks; read access is unrestricted. T0 relinquishes every scaffold to its successor before any parallel writer starts.

This minimizes wall-clock time because broker/provider, UI/catalog/renderer, packaging, and persistence backends begin together. It minimizes integration risk because dependent ports, first-end/drain races, and teardown timing are resolved once before branches diverge. Three separately merged full T0s would repeat shared-file changes and postpone backend work without adding a useful acceptance gate.

### Publication, branch synchronization, and merge gates

- **P150:** 3A-T1 publishes the complete 1.5.0 batch. 3A-T10 verifies it with real broker/provider/routes and the early hotspot slices below. User merges completed 3A with `--no-ff` into stage-3. B1/B2 synchronize from this integration commit, never by copying sibling generated JSON.
- **P160:** 3B1-T1, the **same protocol integrator**, receives P150 and publishes 1.6.0. 3B1-T10 verifies real 3A ports, UI v1 and installed synthetic process. User merges 3B1 with `--no-ff`; B2 synchronizes from stage-3. An explicit empty persistence participant is allowed only for fixtures/motor with no persistence or recording resources. B1's real persistence integration remains marked pending until X-T1.
- **P170:** 3B2-T8, the **same protocol integrator**, receives P160 and publishes 1.7.0 from B2-T1 modules. 3B2-T9 verifies real UI/actions/lifecycle and persistence. User merges 3B2 with `--no-ff`.
- **X-T1:** final cross-plan verification on the resulting stage-3 integration branch. This is included in the B2 plan as a separate cross-plan task; it is not a fourth implementation plan and not Stage 3 closeout.

All merges are user-executed per U §11. A plan can prepare changes and evidence; it does not merge itself. The three plans remain executable independently: each lists its required integration baseline and its own complete task/code/test steps. B2 never needs to read unpublished B1 plan text to discover a signature. Missing production adapters report unavailable, and fixture-only tests are labeled as such.

Every publication synchronizes `PLUGIN_API_VERSION`, schema `$id`, JS `API_VERSION`, Python `API_VERSION`, both generated schema copies, conformance and the batch's consumer manifests. Package versions are independent. 3C remains ^1.6.0 with no bump; 3D alone owns 1.8.0/UI v2 after the 3C proof; completed 3E UI requires ^1.8.0 and adds no minor. Do not claim 3C/3D/3E features have shipped from these foundation tests.

### Single-writer roles and early prerequisite slices

Ownership is a persistent role, not a new person per plan. A role may move its working checkout to the current plan branch after synchronizing the integration baseline; it must never edit the same file in two active worktrees. The table's serialized slices are part of the owning task, not extra counted tasks. The 3A plan must include full code/tests for its required early slices, so it does not wait for all of B1.

| Role                       | Plan/task owner and serialized execution                                                                                                                                              | Exclusive shared files                                                                                                                                                                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol integrator        | Dedicated task **3A-T1**, continued as **3B1-T1**, then **3B2-T8**                                                                                                                    | H-P below: protocol shared schema/exports/registries/conformance and both SDK contexts, including business-result/events and common SDK event adapters; AM-15 orders P150 → P160 → P170 stopped-owner handoffs. B2-T1 only supplies isolated new modules.                                                                                                                                                                                                                             |
| Runtime owner              | **3B1-T3**; slice **R150** applied in 3A-T10 before P150 acceptance, then R160 in B1, then R170 in B2-T9                                                                              | H-R: manager/registry/supervisor/errors/index and their tests. R150 installs provider own-property rejection, errors import/re-export, channel owner/generation, device participant hooks and the provider-only optional source disable/safe-mode policy; no UI wire publication. AM-14 freezes channel phases and original-peer routing; AM-13 adds required-policy fixture paths. R170 installs actual persistence through those hooks. |
| Desktop integration owner  | **3A-T8 (D150, including early B1-T5 ledger/controller) → 3B1-T5 (D160) → 3B2-T9 (D170)**                                                                                                                                                           | H-D: main composition/IPC/preload/shared bridges, controller/state/session and core action ledger, quit/update/window guards; AM-11/13 name the early slice and compatibility tests. B2 hands over factories; it never independently edits H-D.                                                                                                                                                                                                                       |
| Packaging owner            | **3B1-T4**; slice **K150** supplies the EV3 factory allowlist/provider-only source registration in 3A-T10, K160 adds generic shipped-process packaging                                | H-K. No product motor/Lab/device UI source is fabricated. Missing future feature entries remain explicitly undelivered.                                                                                                                                                                                                                                       |
| Renderer integration owner | **3B1-T8**; slice **V150** applies legacy broker/battery/file/execution bridge changes in 3A-T10, V160 mounts generic UI, V170 connects contributed settings/import/recovery in B2-T9 | H-V. App composition, settings shell and all i18n stay with this writer.                                                                                                                                                                                                                                                                                      |
| Shared integration owner   | **3A-T10 → 3B1-T10 → 3B2-T9 → X-T1**                                                                                                                                                  | H-I: package manifests, lockfile, root/CI test wiring, shared smoke harness and shared bilingual docs. Receives dependency/test needs; no other task runs install or edits these files.                                                                                                                                                                       |

D150/R150/K150/V150 are implemented against the frozen contracts on isolated branches based on the 3A baseline, merged by the user into 3A for its integration gate, then reach B1/B2 only through stage-3. Their owners do not start D160/R160/K160/V160 on the same files until P150 is synchronized. Independent B1 catalog/renderer modules and B2 backends may continue meanwhile. The 3A integration checklist explicitly requires these slices; this removes the circular dependency that would result from waiting for the entire 1.6.0 plan to attach a 1.5.0 device participant.

Hotspot direct tests/mocks follow the same owner. H-P/R/D/K/V/I are exact finite path sets listed below, not directory-wide permission. Integration may edit another task's file only after that task has stopped and the handoff receipt names that exact path. Prefer returning defects to the original owner. No blanket final-integration write grant.

### Parallel waves

- **F:** only the three ordered T0 steps. Their contract tests and fixture lists must agree before F is published.
- **W1:** A-T1..T9, B1-T2/T6/T7/T9, B2-T1..T7 can develop independently against frozen ports. A-T8 owns H-D; only the early R150/K150/V150 slices may touch H-R/K/V. All tasks own disjoint files in this wave. Runtime implementation dependencies below are read-only mock interfaces until integrated.
- **W2:** after P150, B1-T1/T3/T4/T5/T8 run their 1.6.0 slices, alongside any unfinished non-hotspot work. B2 modules remain disjoint. B1-T10 requires completed B1 tasks and real A artifacts.
- **W3:** after P160, B2-T8 publishes the batch; B2-T9 schedules R170/D170/V170/shared integration with their existing owners, then verifies actual artifacts.
- **W4:** user merges P170, all writers stop, X-T1 runs. No concurrent writer of any shared file remains.

Task dependencies distinguish **start** (F plus frozen stubs) from **acceptance** (real upstream implementations). A mock pass is branch-local only; no actual transport, installed, filesystem durability or hardware acceptance can be replaced by it.

### Exact shared-file ownership

### H-P — finite hotspot set

- E `packages/plugin-protocol/src/manifest.ts`
- E `packages/plugin-protocol/src/methods.ts`
- E `packages/plugin-protocol/src/common.ts`
- E `packages/plugin-protocol/src/limits.ts`
- E `packages/plugin-protocol/src/rpc.ts`
- E `packages/plugin-protocol/src/errors.ts`
- E `packages/plugin-protocol/src/peer.ts`
- E `packages/plugin-protocol/src/index.ts`
- E `packages/plugin-protocol/src/json-schema.ts`
- E `packages/plugin-protocol/src/manifest.test.ts`
- E `packages/plugin-protocol/src/rpc.test.ts`
- E `packages/plugin-protocol/src/peer.test.ts`
- E `packages/plugin-protocol/src/json-schema.test.ts`
- E `packages/plugin-protocol/src/conformance.test.ts`
- E `packages/plugin-protocol/src/compiler-manifest.test.ts`
- E `packages/plugin-protocol/src/diagnostic-help.test.ts`
- E `packages/plugin-protocol/src/language-services.test.ts`
- E `packages/plugin-protocol/src/static-language-contract.test.ts`
- E `packages/plugin-protocol/scripts/export-schema.mjs`
- E `packages/plugin-protocol/schema/plugin-protocol.schema.json`
- E `packages/plugin-protocol/schema/keywords.json`
- E `packages/plugin-protocol/conformance/cases.json`
- E `packages/plugin-sdk-js/src/index.ts`
- E `packages/plugin-sdk-js/src/index.test.ts`
- E `sdks/python/kobrixa/_plugin.py`
- E `sdks/python/kobrixa/_schema.py`
- E `sdks/python/kobrixa/__init__.py`
- E `sdks/python/kobrixa/plugin-protocol.schema.json`
- E `sdks/python/tests/test_plugin.py`
- E `sdks/python/tests/test_conformance.py`
- E `sdks/python/tests/test_static_languages.py`

- N `packages/plugin-protocol/src/business-result.ts`
- N `packages/plugin-protocol/src/business-result.test.ts`
- N `packages/plugin-protocol/src/events.ts`
- N `packages/plugin-protocol/src/events.test.ts`
- N `packages/plugin-sdk-js/src/events.ts`
- N `packages/plugin-sdk-js/src/events.test.ts`
- N `sdks/python/kobrixa/_events.py`
- N `sdks/python/tests/test_events.py`

AM-15: these baseline-N common modules are handed over with H-P after A-T1 stops, then after B1-T1 stops; no simultaneous common-client writer.

### H-R — finite hotspot set

- E `packages/plugin-runtime/src/manager.ts`
- E `packages/plugin-runtime/src/manager.test.ts`
- E `packages/plugin-runtime/src/registry.ts`
- E `packages/plugin-runtime/src/registry.test.ts`
- E `packages/plugin-runtime/src/supervisor.ts`
- E `packages/plugin-runtime/src/supervisor.test.ts`
- E `packages/plugin-runtime/src/errors.ts`
- N `packages/plugin-runtime/src/errors.test.ts`
- E `packages/plugin-runtime/src/index.ts`
- E `packages/plugin-runtime/src/process.ts`
- E `packages/plugin-runtime/src/process.test.ts`
- E `packages/plugin-runtime/src/manager.static-languages.test.ts`
- E `packages/plugin-runtime/src/registry.timeout.test.ts`
- E `packages/plugin-runtime/src/python.interop.test.ts`
- E `packages/plugin-runtime/src/test-process.ts`
- E `packages/plugin-runtime/src/test-python.ts`

- E `packages/plugin-runtime/src/compiler-resolution.test.ts`
- E `packages/plugin-runtime/src/language-service-conformance.test.ts`

### H-D — finite hotspot set

- E `apps/desktop/src/main/index.ts`
- N `apps/desktop/src/main/index.test.ts`
- E `apps/desktop/src/main/ipc.ts`
- N `apps/desktop/src/main/ipc.test.ts`
- E `apps/desktop/src/main/plugins/quit.ts`
- E `apps/desktop/src/main/plugins/quit.test.ts`
- E `apps/desktop/src/main/updates/service.ts`
- E `apps/desktop/src/main/updates/updates.test.ts`
- E `apps/desktop/src/main/updates/install-ipc.test.ts`
- E `apps/desktop/src/main/window/main-close.ts`
- E `apps/desktop/src/main/window/main-close.test.ts`
- E `apps/desktop/src/main/device/motor-test-ipc.test.ts`
- E `apps/desktop/src/main/device/monitor-ipc.test.ts`
- E `apps/desktop/src/main/sensor-lab/ipc.test.ts`
- E `apps/desktop/src/preload/index.ts`
- E `apps/desktop/src/preload/index.test.ts`
- E `apps/desktop/src/shared/api.ts`
- E `apps/desktop/src/shared/plugins.ts`
- N `apps/desktop/src/shared/plugin-ui.ts`
- N `apps/desktop/src/shared/plugin-ui.test.ts`
- N `apps/desktop/src/shared/plugin-persistence.ts`
- N `apps/desktop/src/shared/plugin-persistence.test.ts`

- E `apps/desktop/src/main/plugins/controller.ts`
- E `apps/desktop/src/main/plugins/controller.test.ts`
- E `apps/desktop/src/main/plugins/state-store.ts`
- E `apps/desktop/src/main/plugins/state-store.test.ts`
- E `apps/desktop/src/main/plugins/session.ts`
- E `apps/desktop/src/main/plugins/session.test.ts`
- E `apps/desktop/src/main/plugins/ipc.ts`
- E `apps/desktop/src/main/plugins/ipc.test.ts`
- N `apps/desktop/src/main/plugins/core-recovery.ts`
- N `apps/desktop/src/main/plugins/core-recovery.test.ts`
- E `apps/desktop/src/main/workspace/compiler-chain.test.ts`
- E `apps/desktop/src/main/language/language-provider.integration.test.ts`

AM-11/13: D150 owns the early controller/core-action and mandatory-policy compatibility slice; D160/D170 resume only after the prior slice stops.

### H-K — finite hotspot set

- E `apps/desktop/src/main/plugins/builtin.ts`
- E `apps/desktop/src/main/plugins/builtin.test.ts`
- E `apps/desktop/src/main/plugins/launchers.ts`
- E `apps/desktop/src/main/plugins/launchers.test.ts`
- N `apps/desktop/src/main/plugins/builtin-launch.ts`
- N `apps/desktop/src/main/plugins/builtin-launch.test.ts`
- E `apps/desktop/forge.config.ts`
- E `apps/desktop/packaging.ts`
- E `apps/desktop/src/main/packaging.test.ts`
- N `apps/desktop/vite.plugin.config.ts`
- N `apps/desktop/vite.plugin-motor.config.ts`
- N `apps/desktop/vite.plugin-lab.config.ts`
- N `apps/desktop/vite.plugin-device.config.ts`
- N `apps/desktop/vite.plugin-fixture.config.ts`
- N `apps/desktop/plugin-resource-index.ts`
- N `apps/desktop/src/main/plugin-resource-index.test.ts`
- E `apps/desktop/vite.main.config.ts`

### H-V — finite hotspot set

- E `apps/desktop/src/renderer/app.tsx`
- E `apps/desktop/src/renderer/app.test.ts`
- E `apps/desktop/src/renderer/settings/plugins-panel.tsx`
- E `apps/desktop/src/renderer/settings/plugins-panel.test.ts`
- E `apps/desktop/src/renderer/settings/plugin-recovery.tsx`
- N `apps/desktop/src/renderer/settings/plugin-recovery.test.ts`
- E `apps/desktop/src/renderer/settings/plugin-copy.ts`
- E `apps/desktop/src/renderer/settings/settings.ts`
- E `apps/desktop/src/renderer/settings/settings.test.ts`
- E `apps/desktop/src/renderer/settings/settings-catalog.ts`
- E `apps/desktop/src/renderer/settings/settings-catalog.test.ts`
- E `apps/desktop/src/renderer/settings/settings-state.ts`
- E `apps/desktop/src/renderer/settings/settings-panel.tsx`
- E `apps/desktop/src/renderer/settings/settings-panel.test.ts`
- E `apps/desktop/src/renderer/i18n/copy.ts`
- E `apps/desktop/src/renderer/i18n/copy.test.ts`
- E `apps/desktop/src/renderer/styles/index.css`
- E `apps/desktop/src/renderer/styles/workbench.css`
- E `apps/desktop/src/renderer/device/battery-status.ts`
- E `apps/desktop/src/renderer/device/battery-status.test.ts`
- E `apps/desktop/src/renderer/device/remote-files.ts`
- E `apps/desktop/src/renderer/device/remote-files.test.ts`
- E `apps/desktop/src/renderer/device/remote-files-panel.tsx`
- E `apps/desktop/src/renderer/device/remote-files-copy.ts`
- E `apps/desktop/src/renderer/execution/execution.ts`
- E `apps/desktop/src/renderer/execution/execution.test.ts`
- N `apps/desktop/src/renderer/settings/legacy-preferences-bridge.ts`
- N `apps/desktop/src/renderer/settings/legacy-preferences-bridge.test.ts`

### H-I — finite hotspot set

- E `package.json`
- E `pnpm-lock.yaml`
- E `packages/plugin-protocol/package.json`
- E `packages/plugin-runtime/package.json`
- E `packages/plugin-sdk-js/package.json`
- E `packages/device/package.json`
- E `apps/desktop/package.json`
- E `sdks/python/pyproject.toml`
- E `vitest.config.ts`
- E `.github/workflows/ci.yml`
- E `tools/ci/changes.mjs`
- E `tools/ci/changes.test.mjs`
- E `tests/desktop/preload.cjs`
- E `tests/desktop/smoke-main.mjs`
- E `tests/desktop/smoke-harness.test.mjs`
- E `tests/desktop/packaged-smoke.mjs`
- E `tests/desktop/run-smoke.mjs`
- E `tests/desktop/run-plugins-smoke.mjs`
- E `tests/desktop/plugins-smoke-main.ts`
- E `tests/desktop/plugins-gui-smoke-main.ts`
- E `tests/desktop/plugins-smoke-process.test.mjs`
- E `tests/desktop/settings-smoke.mjs`
- E `tests/desktop/collab-smoke.mjs`
- E `tests/desktop/monitor-smoke.mjs`
- E `tests/desktop/motor-test-smoke.mjs`
- E `tests/desktop/sensor-lab-smoke.mjs`
- E `tests/desktop/README.md`
- E `docs/en/architecture.md`
- E `docs/zh-TW/architecture.md`
- E `docs/en/roadmap.md`
- E `docs/zh-TW/roadmap.md`
- E `docs/en/device-support.md`
- E `docs/zh-TW/device-support.md`
- E `docs/en/installation.md`
- E `docs/zh-TW/installation.md`

- N `docs/superpowers/plans/2026-10-17-plugin-system-stage-3-contract-freeze.md`

### Task 3B2-T0: Freeze persistence, drain, filesystem and import contracts; publish F

**Files**

- Create: `packages/plugin-protocol/src/settings.ts`
- Create: `packages/plugin-protocol/src/storage.ts`
- Create: `packages/plugin-protocol/src/persistence-actions.ts`
- Create: `packages/plugin-protocol/src/persistence-validation.ts`
- Create: `packages/plugin-protocol/src/persistence-contract.test.ts`
- Create: `packages/plugin-runtime/src/persistence-participant.ts`
- Create: `packages/plugin-runtime/src/persistence-participant.test.ts`
- Create: `packages/plugin-runtime/src/settings-form-port.ts`
- Create: `apps/desktop/src/main/plugins/persistence/filesystem.ts`
- Create: `apps/desktop/src/main/plugins/persistence/engine-port.ts`
- Create: `apps/desktop/src/main/plugins/persistence/host-port.ts`
- Create: `apps/desktop/src/main/plugins/persistence/import-sources.ts`
- Create: `apps/desktop/src/main/plugins/persistence/contract.test.ts`
- Create: `packages/plugin-protocol/test-fixtures/settings-storage-v1/valid.json`
- Create: `packages/plugin-protocol/test-fixtures/settings-storage-v1/invalid.json`
- Create: `packages/plugin-protocol/test-fixtures/settings-storage-v1/maximum.json`
- Modify: `docs/superpowers/plans/2026-10-17-plugin-system-stage-3-contract-freeze.md`
- Create: `apps/desktop/src/main/plugins/persistence/record-port.ts`
- Create: `apps/desktop/src/main/plugins/persistence/actions.ts`
- Modify: `packages/plugin-protocol/src/index.ts`
- Modify: `packages/plugin-runtime/src/index.ts`
- Test: `packages/plugin-protocol/src/persistence-contract.test.ts`
- Test: `packages/plugin-runtime/src/persistence-participant.test.ts`
- Test: `apps/desktop/src/main/plugins/persistence/contract.test.ts`

- Create: `apps/desktop/src/main/plugins/persistence/worker.ts`
- Create: `apps/desktop/src/main/plugins/persistence/recovery-port.ts`
- Create: `apps/desktop/src/main/plugins/persistence/settings-service.ts`
- Create: `apps/desktop/src/renderer/settings/contributed-settings-form.tsx`
- Create: `tests/desktop/plugin-persistence-main.ts`

**Interfaces**

- Consumes: `ProfileWriterLock { readonly hostEpoch: Handle; assertHeld(): void }`, `ResourceOwner`, `Principal`, `DeviceDrainGrant`, `ReservationEnded`, `CoreActionReference`, `CoreWindowScope`, `UiOwner`, `UserPersistenceActionPort`, and A-owned `BusinessResult<Value, Detail>` / `DefinitionMap<S>`, through their defining modules and type-only barrels.
- Produces: every exact declaration in the Interfaces Summary below, with the listed module as its sole definition. In particular `freeze(owner: PersistenceOwner, reason: DrainReason, deadline: number, deviceDrain?: DeviceDrainGrant): DrainOffer`, `endReservation(event: ReservationEnded, deadline: number): DrainOffer | null`, and `PersistenceEnginePort` / `PersistenceReadPort` retain their exact signatures.

Precondition: 3A-T0 and 3B1-T0 have completed in the same unpublished checkout. This is freeze step 3, executed alone. Only H-P and H-R edit their respective existing index files. No worker, filesystem writer, optional resource reader, process, or provider is constructed. API stays 1.4.0. No implementation task starts before the receipt identifies F and all successor owners.

- [ ] **Step 1: Write the failing compile-only contract checks**

Create `packages/plugin-protocol/src/persistence-contract.test.ts`:

```ts
import { expect, expectTypeOf, it } from "vitest";
import { requestMethods, notificationMethods } from "./methods.js";
import type { SettingsSnapshot, SettingsRequestMap, Values } from "./settings.js";
import type { StorageRequestMap, DrainRequest } from "./storage.js";
import type { PersistenceActionRequestMap } from "./persistence-actions.js";
it("freezes isolated maps without advertising future methods", () => {
  expectTypeOf<SettingsSnapshot["values"]>().toEqualTypeOf<Values>();
  expectTypeOf<SettingsRequestMap["settings/read"]["params"]>().toEqualTypeOf<{schemaVersion: number}>();
  expectTypeOf<StorageRequestMap["storage/drain"]["params"]>().toEqualTypeOf<DrainRequest>();
  expectTypeOf<PersistenceActionRequestMap["ui/copyText"]["params"]>().toEqualTypeOf<{actionRef: string; text: string}>();
  expect(Object.keys(requestMethods)).not.toContain("settings/unwatch");
  expect(Object.keys(requestMethods).filter(m => m.startsWith("settings/") || m.startsWith("storage/") || m === "ui/copyText")).toEqual([]);
  expect(Object.keys(notificationMethods)).not.toContain("settings.gap");
});
```

Create `packages/plugin-runtime/src/persistence-participant.test.ts`:

```ts
import { expectTypeOf, it } from "vitest";
import type { ResourceOwner } from "@kobrixa/plugin-protocol";
import type { DeviceDrainGrant, ReservationEnded } from "./device-resources.js";
import type { DrainReason } from "@kobrixa/plugin-protocol";
import type { PersistenceOwner, PersistenceParticipant, DrainOffer } from "./persistence-participant.js";
it("passes the original grant in argument four and never accepts null", () => {
  expectTypeOf<PersistenceOwner>().toEqualTypeOf<ResourceOwner>();
  expectTypeOf<PersistenceParticipant["freeze"]>().toEqualTypeOf<(
    owner: PersistenceOwner, reason: DrainReason, deadline: number,
    deviceDrain?: DeviceDrainGrant
  ) => DrainOffer>();
  expectTypeOf<PersistenceParticipant["endReservation"]>().toEqualTypeOf<(
    event: ReservationEnded, deadline: number
  ) => DrainOffer | null>();
});
function compileOnly(p: PersistenceParticipant, owner: PersistenceOwner, grant: DeviceDrainGrant) {
  p.freeze(owner, "disable", 10_000, grant);
  p.freeze(owner, "disable", 10_000);
  // @ts-expect-error null must be omitted, never forwarded
  p.freeze(owner, "disable", 10_000, null);
}
void compileOnly;
```

Create `apps/desktop/src/main/plugins/persistence/contract.test.ts`:

```ts
import { expectTypeOf, it } from "vitest";
import type { Handle, RecordId, RecordRevision } from "@kobrixa/plugin-protocol";
import type { PersistenceOwner } from "@kobrixa/plugin-runtime";
import type { PersistenceEnginePort, PersistenceReadPort, PublicationTicket } from "./engine-port.js";
import type { PersistenceFsPort, StoreFd, StorePath } from "./filesystem.js";
it("pins byte I/O, immutable publication tickets and generation-bound read pins", () => {
  expectTypeOf<PersistenceFsPort["open"]>().toEqualTypeOf<(p: StorePath, mode: "read" | "create-exclusive") => Promise<StoreFd>>();
  expectTypeOf<PersistenceEnginePort["fence"]>().toEqualTypeOf<(owner: PersistenceOwner, deadline: number) => readonly Handle[]>();
  expectTypeOf<PersistenceEnginePort["fenceTarget"]>().toEqualTypeOf<(owner: PersistenceOwner, id: RecordId, deadline: number) => readonly Handle[]>();
  expectTypeOf<PersistenceEnginePort["reconcile"]>().toEqualTypeOf<(ticket: PublicationTicket) => ReturnType<PersistenceEnginePort["publish"]>>();
  expectTypeOf<PersistenceReadPort["open"]>().toEqualTypeOf<(owner: PersistenceOwner, id: RecordId, revision: RecordRevision) => Promise<Handle>>();
});
```

- [ ] **Step 2: Run the checks; expect missing-module/type errors**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime check
```

Expected: FAIL for missing persistence declarations. A missing dependency installation is not the intended red result. Runtime `check` includes `tsconfig.test.json`, so the `@ts-expect-error` is actually checked.

- [ ] **Step 3: Install the exact type-only scaffolds**

The following Interfaces Summary contains complete source blocks, grouped by defining module. Write each block to its stated path. These blocks are the implementation of this step, not pseudocode; all exports are type-only or ambient declarations. The protocol schema-map declarations are replaced by executable schemas in T1. Filesystem and engine declarations are retained and extended by T2; the participant/form/host/import/action/record ports transfer unchanged to their assigned successors.


`packages/plugin-protocol/src/settings.ts`:

```ts
import type { z } from "zod";
type Wire<T> = z.ZodType<T, T>;
import type { Handle } from "./device-types.js";
import type { DefinitionMap } from "./business-result.js";
import type { PersistenceFailureDetail, PersistenceResult } from "./persistence-validation.js";

// 新增概念型別；正式 Zod 及其 inferred TS types 由 protocol integrator 發布。
export type Version = number; // integer，1..2_147_483_647
export type SettingsRevision = string; // /^r_[0-9a-f]{32}$/，host 隨機產生，只能在 settings domain 比較相等
export type RecordRevision = string; // 同一格式；僅在同 source／record domain 比較相等
export type RecordId = string; // host 產生的 lowercase UUID v4，永不重用
// Handle／Counter type-only 匯入 3A 的共用型別，不在本案重新定義。
export type Sha256 = string; // /^[0-9a-f]{64}$/
export type SettingKey = string; // /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*$/，最多 64 bytes
export type Scalar = boolean | number | string;
export type Values = Array<{ key: SettingKey; value: Scalar }>;
export type Durability = "file-and-directory-sync" | "file-sync-only";
export type Receipt<R extends SettingsRevision | RecordRevision> = {
  revision: R;
  commitId: Handle;
  durability: Durability;
};

export type SettingsText = { en: string; "zh-TW"?: string };
export type CommonField = { key: SettingKey; label: SettingsText; help?: SettingsText };
export type SettingsField = CommonField &
  (
    | { type: "boolean"; default: boolean }
    | { type: "number"; default: number; minimum: number; maximum: number }
    | { type: "integer"; default: number; minimum: number; maximum: number }
    | { type: "string"; default: string; minLength: number; maxLength: number; maxBytes: number }
    | {
        type: "enum";
        default: string | number;
        options: Array<{ value: string | number; label: SettingsText }>;
      }
  );
export type SettingsResourceV1 = {
  schemaVersion: Version;
  title: SettingsText;
  fields: SettingsField[];
};

export type SettingsSnapshot = {
  schemaVersion: Version;
  revision: SettingsRevision | null; // null 只表示尚無 committed settings
  values: Values; // 完整 effective values，含 defaults，最多 64 KiB
};
export type SettingsMutation = { snapshot: SettingsSnapshot; receipt: Receipt<SettingsRevision> };

export declare const settingsRequestSchemas: {
  "settings/read": { params: Wire<{ schemaVersion: Version }>; result: Wire<PersistenceResult<SettingsSnapshot>> };
  "settings/update": { params: Wire<{ schemaVersion: Version; expectedRevision: SettingsRevision | null; changes: Values }>; result: Wire<PersistenceResult<SettingsMutation>> };
  "settings/reset": { params: Wire<{ schemaVersion: Version; expectedRevision: SettingsRevision | null; keys: SettingKey[] }>; result: Wire<PersistenceResult<SettingsMutation>> };
  "settings/watch": { params: Wire<{ schemaVersion: Version }>; result: Wire<PersistenceResult<{ subscriptionId: Handle; sequence: 0; snapshot: SettingsSnapshot }>> };
  "settings/readMigration": { params: Wire<Record<string, never>>; result: Wire<PersistenceResult<{ stored: SettingsSnapshot; declaredSchemaVersion: Version }>> };
  "settings/migrate": { params: Wire<{ fromSchemaVersion: Version; schemaVersion: Version; expectedRevision: SettingsRevision; values: Values }>; result: Wire<PersistenceResult<SettingsMutation>> };
};
export type SettingsRequestMap = DefinitionMap<typeof settingsRequestSchemas>;
```

`packages/plugin-protocol/src/persistence-validation.ts`:

```ts
import type { Handle } from "./device-types.js";
import type { BusinessResult, PermissionErrorDetail, ResourceErrorDetailFor, ResourceKindV170 } from "./business-result.js";
import type { PluginErrorCodeV170 } from "./errors.js";
import type { SettingsRevision, RecordRevision, Version, SettingKey } from "./settings.js";
export type PersistenceReason =
  | "invalid-resource"
  | "invalid-value"
  | "duplicate-key"
  | "unknown-key"
  | "size-limit"
  | "schema-changed-without-version"
  | "migration-required"
  | "downgrade"
  | "unsupported-format"
  | "corrupt"
  | "revision-mismatch"
  | "disk-full"
  | "permission"
  | "read-only"
  | "io"
  | "sync-failed"
  | "publish-uncertain"
  | "import-pending"
  | "record-count"
  | "source-bytes"
  | "host-bytes"
  | "temporary-bytes"
  | "write-in-progress"
  | "offset-mismatch"
  | "sealed"
  | "incomplete"
  | "checksum-mismatch"
  | "flush-incomplete"
  | "export-not-ready"
  | "not-found"
  | "input-changed"
  | "clipboard-unavailable"
  | "destination-changed"
  | "unsupported-filesystem"
  | "schema-mismatch";
export type PersistenceDetail = {
  kind: "persistence";
  reason: PersistenceReason; // 下表七個 settings／storage codes 的 closed reason union
  phase?: "validate" | "reserve" | "write" | "seal" | "publish" | "sync" | "recover";
  disposition?: "not-committed" | "committed" | "unknown";
  actualRevision?: SettingsRevision | RecordRevision; // 僅同 source、讀取權限具備且已知時提供
  expectedVersion?: Version;
  actualVersion?: Version;
  limit?: number;
  requested?: number;
  retryable?: boolean;
  payload?: "complete-staging" | "checkpoint-only" | "none";
  expiresAt?: number; // UTC epoch milliseconds，顯示用；host 以 monotonic clock 執行期限
  commitId?: Handle;
  keys?: SettingKey[]; // 最多 16；不含值；其餘錯誤由重新驗證取得
};
// 前兩個 branch 原樣 type-only 匯入 3A，僅組合本案會返回的 detail。
export type PersistenceFailureDetail = PermissionErrorDetail | ResourceErrorDetailFor<ResourceKindV170> | PersistenceDetail;
export type PersistenceResult<Value> = BusinessResult<Value, PersistenceFailureDetail, PluginErrorCodeV170>;
```

`packages/plugin-protocol/src/storage.ts`:

```ts
import type { z } from "zod";
type Wire<T> = z.ZodType<T, T>;
import type { Handle, Counter, ReservationSnapshot } from "./device-types.js";
import type { DefinitionMap } from "./business-result.js";
import type { RecordId, RecordRevision, Version, Sha256, Receipt, Durability } from "./settings.js";
import type { PersistenceFailureDetail, PersistenceResult } from "./persistence-validation.js";
export type RecordMeta = {
  id: RecordId;
  revision: RecordRevision;
  kind: string; // /^[a-z][a-z0-9.-]{0,63}$/，source-local filter
  schemaVersion: Version;
  label: string;
  mediaType: "application/json" | "text/plain" | "text/csv" | "application/octet-stream";
  byteLength: number;
  sha256: Sha256;
  createdAt: number; // host UTC epoch milliseconds
  updatedAt: number;
  checkpoint: "none" | "open" | "final";
  interrupted: boolean; // host recovery evidence，不改寫 opaque payload
};
export type RecordTarget =
  { mode: "create" } | { mode: "replace"; id: RecordId; expectedRevision: RecordRevision };
export type RecordWrite = {
  target: RecordTarget;
  kind: string;
  schemaVersion: Version;
  label: string;
  mediaType: RecordMeta["mediaType"];
  byteLength: number; // 0..8 MiB
  sha256: Sha256;
  checkpoint?: { handle: Handle; phase: "checkpoint" | "final" };
  drainToken?: Handle;
};
export type WriteProgress = {
  write: Handle;
  id: RecordId;
  state: "receiving" | "sealed" | "publishing" | "committed" | "aborted" | "expired" | "failed";
  receivedBytes: number;
  expiresAt: number;
  receipt?: Receipt<RecordRevision>;
  error?: { code: string; message: string; detail?: PersistenceFailureDetail };
};
export type DrainReason =
  | "disable"
  | "reload"
  | "remove"
  | "renderer-crash"
  | "window-destroyed"
  | "shutdown"
  | "update"
  | "safe-mode"
  | "reservation-ended";
export type DrainRequest = {
  token: Handle;
  reason: DrainReason;
  remainingMs: number; // 0..10_000；host monotonic deadline 才是權威
  checkpoints: Array<{
    checkpoint: Handle;
    record: RecordMeta;
    reservationEnd?: {
      reservationId: Handle;
      reason: Exclude<ReservationSnapshot["reason"], "active">;
      lastSequence: Counter;
    };
  }>;
  writes: Array<{ write: Handle; id: RecordId; state: "receiving" | "sealed" }>;
};

export declare const storageRequestSchemas: {
  "storage/beginWrite": { params: Wire<RecordWrite>; result: Wire<PersistenceResult<{write: Handle; id: RecordId; expiresAt: number}>> };
  "storage/writeChunk": { params: Wire<{write: Handle; offset: number; data: string}>; result: Wire<PersistenceResult<{receivedBytes: number; expiresAt: number}>> };
  "storage/sealWrite": { params: Wire<{write: Handle}>; result: Wire<PersistenceResult<WriteProgress>> };
  "storage/commitWrite": { params: Wire<{write: Handle; drainToken?: Handle}>; result: Wire<PersistenceResult<{record: RecordMeta; receipt: Receipt<RecordRevision>}>> };
  "storage/writeStatus": { params: Wire<{write: Handle}>; result: Wire<PersistenceResult<WriteProgress>> };
  "storage/abortWrite": { params: Wire<{write: Handle}>; result: Wire<PersistenceResult<{disposition: "aborted" | "committed" | "unknown"; receipt?: Receipt<RecordRevision>}>> };
  "storage/stat": { params: Wire<{id: RecordId}>; result: Wire<PersistenceResult<{record: RecordMeta}>> };
  "storage/list": { params: Wire<{kind?: string; limit: number; cursor?: Handle}>; result: Wire<PersistenceResult<{entries: RecordMeta[]; nextCursor?: Handle}>> };
  "storage/openRead": { params: Wire<{id: RecordId; expectedRevision: RecordRevision; schemaVersion: Version}>; result: Wire<PersistenceResult<{read: Handle; record: RecordMeta; expiresAt: number}>> };
  "storage/readChunk": { params: Wire<{read: Handle; offset: number; maxBytes: number}>; result: Wire<PersistenceResult<{offset: number; data: string; nextOffset: number; eof: boolean}>> };
  "storage/closeRead": { params: Wire<{read: Handle}>; result: Wire<PersistenceResult<Record<string, never>>> };
  "storage/delete": { params: Wire<{id: RecordId; expectedRevision: RecordRevision}>; result: Wire<PersistenceResult<{deleted: true; receipt: Receipt<RecordRevision>}>> };
  "storage/flush": { params: Wire<Record<string, never>>; result: Wire<PersistenceResult<{barrier: Handle; durability: Durability}>> };
  "storage/quota": { params: Wire<Record<string, never>>; result: Wire<PersistenceResult<{recordCount: number; reservedCreates: number; committedBytes: number; reservedBytes: number; pinnedBytes: number; temporaryBytes: number; sourceLimitBytes: 536870912; sourceLimitRecords: 256; hostAvailableBytes: number; writeSlotsAvailable: number; exportSlotsAvailable: number}>> };
  "storage/registerCheckpoint": { params: Wire<{id: RecordId; expectedRevision: RecordRevision; reservation?: Handle}>; result: Wire<PersistenceResult<{checkpoint: Handle}>> };
  "storage/abandonCheckpoint": { params: Wire<{checkpoint: Handle}>; result: Wire<PersistenceResult<{record: RecordMeta}>> };
  "storage/drain": { params: Wire<DrainRequest>; result: Wire<PersistenceResult<{status: "submitted" | "checkpoint-only"; writes: Handle[]}>> };
};
export type StorageRequestMap = DefinitionMap<typeof storageRequestSchemas>;
```

`packages/plugin-protocol/src/persistence-actions.ts`:

```ts
import type { z } from "zod";
type Wire<T> = z.ZodType<T, T>;
import type { Handle } from "./device-types.js";
import type { DefinitionMap } from "./business-result.js";
import type { Sha256, Durability } from "./settings.js";
import type { RecordMeta } from "./storage.js";
import type { PersistenceFailureDetail, PersistenceResult } from "./persistence-validation.js";

export declare const persistenceActionRequestSchemas: {
  "storage/exportBegin": { params: Wire<{actionRef: Handle; suggestedName: string; mediaType: RecordMeta["mediaType"]; byteLength: number; sha256: Sha256}>; result: Wire<PersistenceResult<{export: Handle; state: "waiting"; expiresAt: number}>> };
  "storage/exportChunk": { params: Wire<{export: Handle; offset: number; data: string}>; result: Wire<PersistenceResult<{receivedBytes: number; expiresAt: number}>> };
  "storage/exportCommit": { params: Wire<{export: Handle}>; result: Wire<PersistenceResult<{exported: true; commitId: Handle; durability: Durability}>> };
  "storage/exportStatus": { params: Wire<{export: Handle}>; result: Wire<PersistenceResult<{state: "waiting" | "receiving" | "publishing" | "completed" | "cancelled" | "expired" | "failed"; receivedBytes: number; expiresAt: number; commitId?: Handle; durability?: Durability; error?: {code: string; message: string; detail?: PersistenceFailureDetail}}>> };
  "storage/exportCancel": { params: Wire<{export: Handle}>; result: Wire<PersistenceResult<{disposition: "aborted" | "committed" | "unknown"; commitId?: Handle}>> };
  "ui/copyText": { params: Wire<{actionRef: Handle; text: string}>; result: Wire<PersistenceResult<{copied: true}>> };
};
export type PersistenceActionRequestMap = DefinitionMap<typeof persistenceActionRequestSchemas>;
```

`packages/plugin-runtime/src/persistence-participant.ts`:

```ts
import type { ResourceOwner, Handle, Counter, Timestamp, PersistenceResult, RecordId, RecordRevision, DrainReason, DrainRequest, PersistenceFailureDetail } from "@kobrixa/plugin-protocol";
import type { DeviceDrainGrant, ReservationEnded } from "./device-resources.js";
import type { CoreActionReference } from "./core-actions.js";
export type DrainReport = {
  state: "saved" | "retryable" | "checkpoint-only" | "uncertain";
  blocker: boolean;
  recovery?: Handle;
  retryAction?: Handle; // core recovery action descriptor ID，不是授權 token；不送插件
  pendingSettings: boolean;
  records: Array<{
    id: RecordId;
    committedRevision: RecordRevision | null; // 新建且尚未提交時為 null
    final: boolean;
    payload: "complete-staging" | "checkpoint-only" | "none";
    expiresAt?: number;
  }>;
  errors: Array<{ code: string; message: string; detail?: PersistenceFailureDetail }>;
};
export type PersistenceOwner = ResourceOwner; // type-only alias, not a new owner shape
// DrainReport itself has its sole definition in I-B2-8.1.
export type DrainOffer = Readonly<{
  owner: PersistenceOwner;
  reason: DrainReason;
  deadlineMonotonicMs: number;
  token: Handle;
  checkpoints: readonly DrainRequest["checkpoints"][number][];
  writes: readonly DrainRequest["writes"][number][];
  acceptedTickets: readonly Handle[];
}>;
export type DrainDispatcher = (
  owner: PersistenceOwner,
  request: DrainRequest,
  signal: AbortSignal,
) => Promise<
  PersistenceResult<
    {
      status: "submitted" | "checkpoint-only";
      writes: Handle[];
    }
  >
>;
export type PersistenceRecoverySnapshot = {
  revision: Counter;
  items: Array<{
    id: Handle;
    sourceKey: string;
    pluginId: string;
    recordId: RecordId | null;
    committedRevision: RecordRevision | null;
    state: DrainReport["state"];
    payload: "complete-staging" | "checkpoint-only" | "none";
    expiresAt?: Timestamp;
    actions: Array<{ id: Handle; kind: "retry" | "export" | "discard" }>;
  }>;
};

export interface PersistenceParticipant {
  // 同步對帳 ended／pending bindings，只封住該 recording target，不 freeze owner。
  endReservation(event: ReservationEnded, deadline: number): DrainOffer | null;
  // 同步關閉普通 admission，擷取已受理工作；可與 broker revocation 同一回合呼叫。
  freeze(
    owner: PersistenceOwner,
    reason: DrainReason,
    deadline: number,
    deviceDrain?: DeviceDrainGrant,
  ): DrainOffer;
  // 以獨立 drain request 喚醒仍健康的原 process；不延長 deadline。
  drain(offer: DrainOffer, dispatch: DrainDispatcher): Promise<DrainReport>;
  // owner 已死亡，不 dispatch；只處理 host 已持有的 ticket，保留 checkpoint。
  ownerLost(owner: PersistenceOwner): Promise<DrainReport>;
  // 接 core recovery snapshot；retry／discard 僅接受可信 UI action，不是 plugin RPC。
  recoverySnapshot(): PersistenceRecoverySnapshot;
  retry(recovery: Handle, action: CoreActionReference): Promise<DrainReport>;
  discard(recovery: Handle, action: CoreActionReference): Promise<DrainReport>;
}
```

`packages/plugin-runtime/src/settings-form-port.ts`:

```ts
import type { UiOwner, Sha256, SettingsResourceV1, SettingsSnapshot, PluginErrorCode, PersistenceFailureDetail } from "@kobrixa/plugin-protocol";
import type { CoreWindowScope } from "./core-actions.js";
export type SettingsFormBinding = {
  owner: UiOwner;
  scope: CoreWindowScope;
  resourceDigest: Sha256;
};
export interface SettingsFormPort {
  open(
    binding: SettingsFormBinding,
    resource: SettingsResourceV1,
    snapshot: SettingsSnapshot,
  ): void;
  replaceSnapshot(binding: SettingsFormBinding, snapshot: SettingsSnapshot): void;
  showFailure(
    binding: SettingsFormBinding,
    error: { code: PluginErrorCode; message: string; detail?: PersistenceFailureDetail },
  ): void;
  dispose(binding: SettingsFormBinding): void;
}
```

`apps/desktop/src/main/plugins/persistence/filesystem.ts`:

```ts
import type { Durability } from "@kobrixa/plugin-protocol";
export declare const storeRootBrand: unique symbol;
export type StoreRoot = {readonly [storeRootBrand]:true};
export declare const storePathBrand: unique symbol;
export declare const storeFdBrand: unique symbol;
export type StorePath = { readonly [storePathBrand]: true };
export type StoreFd = { readonly [storeFdBrand]: true };
export type PersistenceFaultPoint =
  | "reserve"
  | "open-temp"
  | "chunk-write"
  | "seal-sync"
  | "object-rename"
  | "object-dir-sync"
  | "backup-head"
  | "head-write"
  | "before-publish"
  | "after-publish"
  | "head-dir-sync"
  | "cache-publish"
  | "receipt-send"
  | "cleanup"
  | "import-marker";
export interface PersistenceFsPort {
  readonly durability: Durability;
  now(): number;
  open(path: StorePath, mode: "read" | "create-exclusive"): Promise<StoreFd>;
  read(fd: StoreFd, offset: number, maxBytes: number): Promise<Uint8Array>;
  write(fd: StoreFd, offset: number, bytes: Uint8Array): Promise<number>;
  sync(fd: StoreFd): Promise<void>;
  close(fd: StoreFd): Promise<void>;
  syncDirectory(path: StorePath): Promise<void>;
  atomicReplace(from: StorePath, to: StorePath): Promise<void>;
  mkdir(path: StorePath): Promise<void>;
  statfs(path: StorePath): Promise<{ availableBytes: number }>;
  unlink(path: StorePath): Promise<void>;
  fault(point: PersistenceFaultPoint): Promise<void>;
}
```

`apps/desktop/src/main/plugins/persistence/engine-port.ts`:

```ts
import type { Handle, SettingsSnapshot, SettingsRevision, RecordRevision, RecordId, Receipt, Version, Sha256, RecordMeta } from "@kobrixa/plugin-protocol";
import type { PersistenceOwner } from "@kobrixa/plugin-runtime";
export type PublicationTicket = Readonly<{
  id: Handle;
  owner: PersistenceOwner;
  deadlineMonotonicMs: number;
  metadata:
    | { kind: "settings"; schemaVersion: Version; validationDigest: Sha256 }
    | { kind: "record"; record: RecordMeta; deleted: boolean }
    | { kind: "recovery" | "import"; key: string };
  target:
    | { kind: "settings"; expectedRevision: SettingsRevision | null }
    | { kind: "record"; id: RecordId; expectedRevision: RecordRevision | null }
    | { kind: "recovery" | "import"; key: string };
}>;
export interface PersistenceEnginePort {
  reserve(ticket: PublicationTicket, byteLength: number): Promise<void>;
  append(ticket: PublicationTicket, offset: number, bytes: Uint8Array): Promise<number>;
  seal(ticket: PublicationTicket, byteLength: number, sha256: Sha256): Promise<void>;
  publish(ticket: PublicationTicket): Promise<{
    disposition: "not-committed" | "committed" | "unknown";
    receipt?: Receipt<SettingsRevision | RecordRevision>;
  }>;
  fence(owner: PersistenceOwner, deadlineMonotonicMs: number): readonly Handle[];
  fenceTarget(
    owner: PersistenceOwner,
    id: RecordId,
    deadlineMonotonicMs: number,
  ): readonly Handle[];
  reconcile(ticket: PublicationTicket): ReturnType<PersistenceEnginePort["publish"]>;
  abort(ticket: PublicationTicket): Promise<"aborted" | "committed" | "unknown">;
}

// B2-T2 engine-port.ts; immutable snapshots and byte pins do not hold device locks.
export interface PersistenceReadPort {
  settings(owner: PersistenceOwner): Promise<SettingsSnapshot | null>;
  stat(owner: PersistenceOwner, id: RecordId): Promise<RecordMeta>;
  list(
    owner: PersistenceOwner,
    input: { kind?: string; limit: number; cursor?: Handle },
  ): Promise<{ entries: RecordMeta[]; nextCursor?: Handle }>;
  open(owner: PersistenceOwner, id: RecordId, revision: RecordRevision): Promise<Handle>;
  read(owner: PersistenceOwner, pin: Handle, offset: number, maxBytes: number): Promise<Uint8Array>;
  close(owner: PersistenceOwner, pin: Handle): Promise<void>;
}
```

`apps/desktop/src/main/plugins/persistence/host-port.ts`:

```ts
import type { Permission, SettingsRequestMap, StorageRequestMap, PersistenceActionRequestMap } from "@kobrixa/plugin-protocol";
import type { Principal, PersistenceParticipant, ProfileWriterLock, ReservationBindingPort, UserPersistenceActionPort, CoreActionValidationPort } from "@kobrixa/plugin-runtime";
import type { PersistenceBackend } from "./engine-port.js";
import type { BoundSettingsService } from "@kobrixa/plugin-runtime";
import type { PersistenceRecoveryHostPort } from "./recovery-port.js";
import type { PersistenceActionAdapter } from "./actions.js";
export type PersistenceRequestMap = SettingsRequestMap & StorageRequestMap & PersistenceActionRequestMap;
export interface PersistenceHost {
  readonly participant: PersistenceParticipant;
  readonly settings: BoundSettingsService;
  readonly recovery: PersistenceRecoveryHostPort;
  request<M extends keyof PersistenceRequestMap>(
    principal: Principal,
    method: M,
    params: PersistenceRequestMap[M]["params"],
    signal: AbortSignal,
  ): Promise<PersistenceRequestMap[M]["result"]>;
  dispose(): Promise<void>;
}

export declare function createPersistenceHost(input: {
  profile: ProfileWriterLock;
  composition: PersistenceCompositionInput;
  reservations: ReservationBindingPort;
  actions: UserPersistenceActionPort;
  actionAdapter: PersistenceActionAdapter;
  coreActions: CoreActionValidationPort;
  now: () => number;
  hasPermission: (principal: Principal, permission: Permission) => boolean;
}): Promise<PersistenceHost>;
```

`apps/desktop/src/main/plugins/persistence/record-port.ts`:

```ts
import type { StorageRequestMap } from "@kobrixa/plugin-protocol";
import type { Principal } from "@kobrixa/plugin-runtime";
export interface RecordServicePort {
  request<M extends keyof StorageRequestMap>(
    principal: Principal,
    method: M,
    params: StorageRequestMap[M]["params"],
    signal: AbortSignal,
  ): Promise<StorageRequestMap[M]["result"]>;
}
```

`apps/desktop/src/main/plugins/persistence/import-sources.ts`:

```ts
import type { Handle, Sha256, Version, Values, RecordWrite } from "@kobrixa/plugin-protocol";
import type { CoreWindowScope } from "@kobrixa/plugin-runtime";
export type LegacyPreferencesSnapshot = {
  nonce: Handle;
  scope: CoreWindowScope;
  entries: Array<{ key: string; raw: string | null }>;
};
export type LegacyImportInput = {
  sourceKind: "sensor-lab" | "device-settings" | "renderer-preferences";
  bytes: Uint8Array;
  sha256: Sha256;
};
export type LegacyImportItem =
  | { kind: "settings"; schemaVersion: Version; values: Values }
  | {
      kind: "record";
      metadata: Omit<RecordWrite, "target" | "checkpoint" | "drainToken">;
      bytes: Uint8Array;
    };
export interface LegacyImportDescriptor {
  id: string;
  mappingVersion: Version;
  targetSourceKey: string;
  sourceKind: LegacyImportInput["sourceKind"];
  sourceFormatVersions: readonly Version[];
  targetSettingsSchemaVersion?: Version;
  targetRecordSchemaVersions: readonly Version[];
  rendererKeyAllowlist?: readonly string[];
  validate(input: LegacyImportInput): boolean;
  map(input: LegacyImportInput): LegacyImportItem;
}
export interface LegacyImportCoordinator {
  run(
    descriptor: LegacyImportDescriptor,
    signal: AbortSignal,
  ): Promise<{
    state: "pending" | "planned" | "copying" | "complete" | "complete-empty" | "blocked";
    completedItems: number;
    totalItems: number;
  }>;
  acceptPreferences(snapshot: LegacyPreferencesSnapshot): Promise<void>;
}
```

`apps/desktop/src/main/plugins/persistence/actions.ts`:

```ts
import type { Handle } from "@kobrixa/plugin-protocol";
export declare const exportDestinationBrand: unique symbol;
export type ExportDestination = { readonly [exportDestinationBrand]: true };
export interface PersistenceActionAdapter {
  chooseDestination(
    action: Handle,
    suggestedName: string,
    signal: AbortSignal,
  ): Promise<ExportDestination | null>;
  copyText(action: Handle, text: string): Promise<void>;
}
```

The renderer-only `SettingsDraftState` / `SettingsControlsPort` below belong to B1-T7; they are consumed, not redefined, by B2.

```ts
type SettingsDraftState = {
  baseline: SettingsSnapshot;
  draft: Values;
  busyKeys: SettingKey[];
  errors: Array<{ key: SettingKey; message: SettingsText }>;
};
// SettingsControlsPort/SettingsDraftState: B1-T7 host-ports.ts; B2-T3 consumes.
interface SettingsControlsPort {
  render(
    binding: SettingsFormBinding,
    resource: SettingsResourceV1,
    state: SettingsDraftState,
  ): void;
  onChange(
    listener: (
      binding: SettingsFormBinding,
      key: SettingKey,
      value: SettingsScalar,
      phase: "change" | "blur" | "enter" | "reset",
    ) => void,
  ): () => void;
  dispose(binding: SettingsFormBinding): void;
}
```

H-P appends these type-only exports to `packages/plugin-protocol/src/index.ts`; H-R appends the runtime block to `packages/plugin-runtime/src/index.ts`. Preserve every existing export.

```ts
export type {
  Version, SettingsRevision, RecordRevision, RecordId, Sha256, SettingKey,
  Scalar as SettingsScalar, Values, Durability, Receipt, SettingsText,
  CommonField, SettingsField, SettingsResourceV1, SettingsSnapshot,
  SettingsMutation, SettingsRequestMap,
} from "./settings.js";
export type { RecordMeta, RecordTarget, RecordWrite, WriteProgress, DrainReason, DrainRequest, StorageRequestMap } from "./storage.js";
export type { PersistenceDetail, PersistenceFailureDetail, PersistenceReason, PersistenceResult } from "./persistence-validation.js";
export type { PersistenceActionRequestMap } from "./persistence-actions.js";
```

```ts
export type {
  PersistenceOwner, DrainOffer, DrainDispatcher, DrainReport,
  PersistenceRecoverySnapshot, PersistenceParticipant,
} from "./persistence-participant.js";
export type { SettingsFormBinding, SettingsFormPort } from "./settings-form-port.js";
```


- [ ] **Step 3a: Freeze the amended composition and successor contracts**

Merge the declarations below into their named definition sites as ambient/type-only scaffolds at F, replacing earlier declarations of the same symbol rather than appending duplicates. Add explicit type imports from the defining modules for each referenced name; export the declarations from those modules, not a second registry. T2 retains its engine declarations and replaces its root/worker ambient functions in Steps 2 and 10. T3/T5/T6/T7 replace their own scaffolds after F. The shared registry changes belong to the stopped H-P owner. No adapter is instantiated in T0.

#### Frozen AM-15 — Ordered common registry handoffs and future type projections

H-P now explicitly includes protocol `business-result.ts`, `business-result.test.ts`, `events.ts`, `events.test.ts`, JS `events.ts`/test and Python `_events.py`/test. Ownership is serialized **A-T1 → B1-T1 after P150 → B2-T8 after P160**, with stop/path/SHA receipts; B2-T1 imports them read-only. Do not move or duplicate registries into common.ts. P160 adds exactly `ui-binding`, six `ui.*` kinds and the B1 error table; P170 adds exactly the five storage resource kinds (including **`storage-watch`**, never `settings-watch`), `settings.changed` and the seven B2 codes. Runtime registries/schema exports stay batch-closed.

A-T1 freezes in business-result.ts the type-only aliases `ResourceKindV160 = ResourceKindV150 | "ui-binding"`, `ResourceKindV170 = ResourceKindV160 | "storage-write" | "storage-read" | "storage-list" | "storage-export" | "storage-watch"`, and `ResourceErrorDetailFor<K extends ResourceKindV170> = Omit<ResourceErrorDetail,"resource"> & {resource:K}`. Add a defaulted third type parameter to the **same** `BusinessResult<Value,Detail,Code extends Stage3PluginErrorCode = PluginErrorCode>` definition; its failure `code` is `Code`. `Stage3PluginErrorCode` is the type-only union of existing/A/B1/B2 codes from the exact tables, defined in errors.ts, with `PluginErrorCodeV150/V160/V170` cumulative aliases. `PluginErrorCode`, `ResourceKind` and runtime validators advance only at their batch. UI/Persistence module-local result aliases use the respective explicit Code and resource projection before publication; no assertion casting a schema to the current published union.

Canonical exports: device-types.ts `handleSchema: z.ZodType<Handle>`, `counterSchema: z.ZodType<Counter>`; business-result.ts `commonFailureSchema: z.ZodType<PublishedCommonFailure>` is the strict published common failure union, where `PublishedCommonFailure = Extract<BusinessResult<never,PermissionErrorDetail|ResourceErrorDetail>,{ok:false}>`. The isolated helper has the exact signature `commonFailureSchemaFor<B extends ContractBatch>(batch:B): z.ZodType<CommonFailureFor<B>>`, where `ContractBatch = "1.5.0"|"1.6.0"|"1.7.0"`, `CodesByBatch = {"1.5.0":PluginErrorCodeV150;"1.6.0":PluginErrorCodeV160;"1.7.0":PluginErrorCodeV170}`, `ResourcesByBatch = {"1.5.0":ResourceKindV150;"1.6.0":ResourceKindV160;"1.7.0":ResourceKindV170}`, and `CommonFailureFor<B extends ContractBatch> = Extract<BusinessResult<never,PermissionErrorDetail|ResourceErrorDetailFor<ResourcesByBatch[B]>,CodesByBatch[B]>,{ok:false}>`. These are exported from business-result.ts. Each returned schema validates only that cumulative batch and exact code/detail pair; future schemas are not registered in the published exporter. `Stage3EventData` is a type-only map inferred from all domain-local data schemas; `EventKind`/published `eventEnvelopeSchema` remain batch-specific. Tests at F compile isolated B1/B2 results without assertions; at every publication reject the next batch's kinds/codes/resources and preserve numeric legacy errors. H-P owner alone assembles index/schema/SDK exports.

#### Frozen AM-18 — Trusted recovery detail, preload names and core export

D160 freezes `PluginsApi.recovery: CoreRecoveryPort` (`window.kobrixa.plugins.recovery`) in shared/plugins.ts and preload; D170 adds `PluginsApi.persistenceRecovery: PersistenceRecoveryBridge` defined in shared/plugin-persistence.ts:

```ts
interface PersistenceRecoveryBridge {
  snapshot(input: { itemId: Handle }): Promise<PersistenceResult<PersistenceRecoverySnapshot>>;
  act(input: { itemId: Handle; optionId: Handle }): Promise<PersistenceResult<PersistenceRecoverySnapshot>>;
  onOpen(listener: (input: { itemId: Handle }) => void): () => void;
  onChanged(listener: () => void): () => void;
}
interface PersistenceRecoveryHostPort {
  snapshot(): PersistenceRecoverySnapshot;
  subscribe(listener: () => void): () => void;
  export(input: { recovery: Handle; action: CoreActionReference }): Promise<PersistenceResult<{
    disposition: "not-committed" | "committed" | "unknown";
  }>>;
}
// B2-T5 host-port.ts adds readonly recovery: PersistenceRecoveryHostPort;
```

B2-T5 defines the host port in persistence/recovery-port.ts, constructs it within `createPersistenceHost`, loads durable state via AM-26 and uses AM-25 for export. D170 handles trusted `manage`: send `onOpen({itemId})` to the original validated workbench while `CoreRecoveryPort.act` still returns `CoreRecoverySnapshot`. The detail fetch maps a host item ID to its persistence recovery ID without renderer-supplied namespace. Detail option IDs are host-issued, generation/revision/scope bound; main looks up retry/export/discard, mints the matching fresh core action, calls participant.retry/discard or recovery.export, then refreshes detail. Never add export/discard to `CoreRecoveryItem.actions[].kind`. Snapshot, onOpen and option IDs confer no export authority. Native dialog registers its opaque destination via AM-25. B1-T7 generic detail consumes this bridge; V170 mounts it.

F types, P160 recovery property/manage navigation scaffold, P170 real detail/export. Tests: all optional features off, no plugin process, sealed or committed export, checkpoint-only cannot invent payload, stale option/window, action replay, unknown publication/restart, dialog cancel and original core return shape.

#### Frozen AM-23 — Single worker bootstrap and rooted backend

Use explicit backend dependency injection with no filesystem-to-backend association. B2-T2 engine-port.ts defines `PersistenceBackend` below; worker.ts exports the sole bootstrap, filesystem.ts owns root capabilities. Root/worker declarations are defined in filesystem.ts/worker.ts respectively, re-exported type-only where needed. F types; P170 production wiring by D170/K170:

```ts
interface PersistenceBackend {
  readonly engine: PersistenceEnginePort;
  readonly reads: PersistenceReadPort;
  readonly evidence: PersistenceEvidencePort; // AM-26
  readonly imports: DurableImportPort; // AM-24
  readonly output: PersistenceOutputPort; // AM-25
  readonly destinations: ExportDestinationRegistry; // AM-25
  readonly sources: LegacySourceResolver; // AM-29
  dispose(): Promise<void>;
}
declare const storeRootBrand: unique symbol;
type StoreRoot = {readonly [storeRootBrand]: true};
declare function openStoreRoot(input: {userData: string; profile: ProfileWriterLock}): Promise<StoreRoot>;
declare function startPersistenceWorker(input: {
  profile: ProfileWriterLock; root: StoreRoot; workerEntry: string;
  now: () => number;
  testControl?: (control: PersistenceFaultControl) => void;
}): Promise<{backend: PersistenceBackend; recovery: "ready" | "blocked"}>;
interface PersistenceFaultControl {
  arm(point:PersistenceFaultPoint, action:"pause"|"fail"|"kill"): void;
  reached(point:PersistenceFaultPoint): Promise<void>;
  release(point:PersistenceFaultPoint): void;
  trace(): readonly {point:PersistenceFaultPoint;time:number;ticket:Handle|null}[];
  terminate(): Promise<void>;
}
```

`workerEntry` is a trusted absolute packaged path from K170 `persistenceWorkerPath({packaged:boolean,resourcesPath:string,buildRoot:string}): string` in `apps/desktop/packaging.ts`. K170 also exports `PERSISTENCE_WORKER_ENTRY = "src/main/plugins/persistence/worker.ts"` and `withPersistenceWorkerUnpack(existing:string):string` there. The path is `resourcesPath/app.asar.unpacked/.vite/build/persistence-worker.cjs` when packaged and `buildRoot/persistence-worker.cjs` otherwise; never cwd/PATH or renderer input. Root construction validates containment/identity once and all path/fd operations revalidate at use. Only T2 namespace.ts constructs `StorePath`s; downstream services operate on backend methods, never path casts. Bounded enumeration stays inside resolver/evidence ports.

Bootstrap asserts the **same** primary lock, passes its hostEpoch and a shared held-capability word, waits for bounded ready/recovery scan, and returns only then. The optional testControl callback is supplied only by a test composition; it receives the actual worker fault controller and is absent from production preload/RPC/environment. No second lock or pre-primary worker. Unknown-format/corrupt evidence produces `blocked` with read-only recovery access; no writable fallback. On disposal drain/dispose backend then worker exit before releasing the original profile. Loss of the held word denies every worker write; uncertainty is recorded, not treated as clean completion.

T2 worker.ts exports strict internal `PersistenceWorkerRequest`/`PersistenceWorkerResponse` validators. Requests are `{version:1,id:Counter,operation:K,args:Parameters<WorkerOperations[K]>}` and responses `{version:1,id:Counter,ok:true,value:Awaited<ReturnType<WorkerOperations[K]>>}` or `{version:1,id:Counter,ok:false,error:{code:"io"|"invalid"|"stale"|"quota"|"unknown",message:string}}`. `WorkerOperations` is the closed qualified method map (`engine.reserve`, etc.) of backend engine/reads/evidence/imports/output/destinations/sources, excluding synchronous `engine.fence`, `engine.fenceTarget`, `evidence.capture` and `evidence.tickets`; lifecycle barriers remain on the main facade and registry-held opaque capabilities serialize only as validated private IDs. Boot is `{version:1,kind:"boot",hostEpoch:Handle,root:string,held:SharedArrayBuffer}`, ready is `{version:1,kind:"ready",recovery:"ready"|"blocked"}`. These are private worker transport, never plugin schema exports. No function/AbortSignal/object-brand is structured-cloned; requests use private IDs and explicit cancellation, mapper IDs resolve to worker-local allowlisted functions. Existing 32-pending/8MiB-host/1MiB-source/four-job budgets apply. Tests: no ready/no root/no held capability, forged ID, lost worker mid-publish, packaged path, one worker and idempotent shutdown.

#### Frozen AM-24 — Durable import adapter and atomic receipt tags

B2-T2 engine-port.ts defines; B2-T6 consumes in import-coordinator.ts/import-journal.ts. No change to `PublicationTicket`, `RecordWrite` or plugin methods:

```ts
type ImportTag = Readonly<{importId:string; itemKey:string; sourceSha256:Sha256}>;
type ImportPlannedItem = Readonly<{
  key:string; sourceFormat:Version; sourceSha256:Sha256; mappedSha256:Sha256; byteLength:number;
  ticket:PublicationTicket; tag:ImportTag;
}>;
type ImportPlan = Readonly<{formatVersion:1; id:string; mappingVersion:Version;
  targetSourceKey:string; items:readonly ImportPlannedItem[]}>;
type ImportItemEvidence = {key:string; state:"pending"|"committed"|"skipped"|"unknown";
  receipt:Receipt<SettingsRevision|RecordRevision>|null; skipReason:string|null};
interface DurableImportPort {
  load(owner: PersistenceOwner, id: string): Promise<{plan:ImportPlan;
    items:readonly ImportItemEvidence[]; complete:boolean}|null>;
  plan(owner: PersistenceOwner, plan: ImportPlan): Promise<void>;
  tagImport(ticket: PublicationTicket, tag: ImportTag): Promise<void>;
  importReceipts(owner: PersistenceOwner, id:string): Promise<readonly {
    tag:ImportTag; ticket:PublicationTicket; receipt:Receipt<SettingsRevision|RecordRevision>;
  }[]>;
  record(owner: PersistenceOwner, id:string, evidence:ImportItemEvidence): Promise<void>;
  reconcile(ticket: PublicationTicket): ReturnType<PersistenceEnginePort["reconcile"]>;
  complete(owner: PersistenceOwner, id:string): Promise<void>;
}
```

Plan persistence freezes target/schema/expected revision/assigned record ID/mapped digest before publication. `tagImport` is accepted only on the admitted immutable ticket after reserve and before append/seal; tag JSON ≤256 bytes and published atomically in that ticket's head. Reconcile original tickets/heads before allocating anything new. `record` durably preserves explicit per-item skips and receipts; `complete` verifies every planned item committed or explicitly skipped and atomically persists the completion marker. Plan IDs/item keys and skip reasons are bounded to 128/128/256 UTF-8 bytes respectively. All reads are bounded by 512 items, 2MiB journal/evidence and 64-item processing batches; inventory still max4096 names. Loader rejects unsupported schema/target/map changes and never interprets permission failure as absence. F types; P170 real worker-backed tests kill after head-before-receipt, after skip and before/after marker; rerun three times without duplicate IDs, changed payload or lost skip evidence. No separate import filesystem/store.

#### Frozen AM-25 — Native export destination registration and output

B2-T2 engine-port.ts owns output/registry declarations; B2-T5 actions.ts retains the `ExportDestination` brand and consumes these services. D170's existing main IPC/dialog composition owns native path selection and passes it only to the worker's registry:

```ts
interface ExportDestinationRegistry {
  register(input: {action:Handle; scope:CoreWindowScope; nativePath:string;
    deadlineMonotonicMs:number}): Promise<ExportDestination>;
  release(destination: ExportDestination): Promise<void>;
}
type ExportOutcome = {disposition:"not-committed"|"committed"|"unknown";
  commitId?:Handle; durability?:Durability};
interface PersistenceOutputPort {
  begin(id:Handle, owner:ResourceOwner, destination:ExportDestination,
    bytes:number, sha256:Sha256, deadlineMonotonicMs:number): Promise<void>;
  append(id:Handle, offset:number, bytes:Uint8Array): Promise<number>;
  commit(id:Handle): Promise<ExportOutcome>;
  reconcile(id:Handle): Promise<ExportOutcome>;
  abort(id:Handle): Promise<"aborted"|"committed"|"unknown">;
}
```

Freeze `ActionDependencies.output: PersistenceOutputPort`. `PersistenceActionAdapter.chooseDestination` stays unchanged; its closure resolves the already-claimed feature or core action to trusted scope, invokes native save dialog, then calls `register`. Registry keeps path/parent/leaf identity, same-volume temp and supported atomic replacement evidence in worker memory; only opaque references return to main, no path reaches a plugin/renderer. Core export passes its claimed `actionToken` as the dialog correlation ID, never a feature actionRef. Destination cannot change after begin; append enforces offset/hash/length, commit flushes and rechecks identity before replace, unknown outcome retains temp/identity for original-job reconciliation without automatic republish. Release only after known outcome/expiry cleanup; unknown remains evidence. F signatures; P170 tests: cancellation/late dialog/retired scope, symlink or target identity swap, existing destination untouched on unsupported FS, before/after rename kills, committed record pin/complete sealed payload streaming within budgets.

#### Frozen AM-26 — Scope-bearing barriers, quota and recovery evidence

B2-T2 engine-port.ts defines:

```ts
type PersistenceScope = {kind:"namespace"; owner:PersistenceOwner}
  | {kind:"target"; owner:PersistenceOwner; recordId:RecordId};
type PersistenceBarrier = Readonly<{id:Handle; scope:PersistenceScope; through:Counter;
  deadlineMonotonicMs:number}>;
type PersistenceBarrierEvidence = {state:"saved"|"failed"|"unknown";
  accepted:readonly Handle[]; incomplete:readonly Handle[]; unknown:readonly Handle[]};
type StoredRecovery = Readonly<{id:Handle; owner:PersistenceOwner; report:DrainReport;
  ticket:PublicationTicket|null; sealedPin:Handle|null; expiresAt:Timestamp|null}>;
interface PersistenceEvidencePort {
  capture(scope:PersistenceScope, deadlineMonotonicMs:number): PersistenceBarrier;
  flush(barrier:PersistenceBarrier): Promise<PersistenceBarrierEvidence>;
  tickets(barrier:PersistenceBarrier): readonly PublicationTicket[];
  quota(owner:PersistenceOwner): Promise<StorageRequestMap["storage/quota"]["result"]>;
  settingsDigest(owner:PersistenceOwner): Promise<{schemaVersion:Version;
    validationDigest:Sha256; revision:SettingsRevision}|null>;
  auxiliary(owner:PersistenceOwner, kind:"import"|"recovery", key:string): Promise<Uint8Array|null>;
  auxiliaryKeys(owner:PersistenceOwner, kind:"import"|"recovery", cursor?:Handle): Promise<{
    keys:readonly string[];nextCursor:Handle|null;
  }>;
  recoveryPage(cursor?:Handle): Promise<{items:readonly StoredRecovery[]; nextCursor:Handle|null}>;
  loadRecovery(id:Handle): Promise<StoredRecovery|null>;
  saveRecovery(value:StoredRecovery): Promise<void>;
  removeRecovery(id:Handle): Promise<void>;
}
```

Capture is synchronous at admission in main's ordered ticket ledger. Namespace scope includes admitted settings, records and import writes through the captured sequence; target scope includes only that record/checkpoint and cannot await unrelated settings. `flush` never returns saved with open/incomplete checkpoints or unresolved tickets. B2-T3/T4/T5 dependencies receive this exact port; public `storage/flush {}` and participant signatures stay unchanged. Recovery and auxiliary pages ≤64 items/256KiB, auxiliary keys ≤128 UTF-8 bytes and one document ≤2MiB, total obeys existing metadata quotas; saved state uses the same atomic store. Startup restores deadline/TTL evidence without extending retention, fences unknown outcomes and validates persisted payload pins. Settings digest is the committed head's digest, never the currently loaded resource's substituted value. F types; P170 tests: concurrent namespace and target barriers, settings/import captured before barrier, admission after barrier excluded, worker crash, corrupt/unknown format and restart TTL.

#### Frozen AM-27 — Explicit persistence factory composition

Replace the old required `filesystem` factory parameter with required `composition: PersistenceCompositionInput`; there is no WeakMap attachment or competing `bindPersistenceComposition` export. B2-T5 host-port.ts defines:

```ts
interface PersistenceSourcePort {
  current(owner:ResourceOwner): boolean;
  settings(input:{sourceKey:string; resourceDigest:Sha256}): Promise<{
    owner:UiOwner; resource:SettingsResourceV1; validationDigest:Sha256;
  }|null>;
  coreOwner(input:{sourceKey:string; scope:CoreWindowScope}): ResourceOwner|null;
}
interface PersistenceCompositionInput {
  backend:PersistenceBackend;
  sources:PersistenceSourcePort;
  events:CommonEventLedgerPort;
  dispatchDrain:DrainDispatcher;
  imports:LegacyImportHostPort;
}
```

D170 constructs the backend once (AM-23), sources from the admitted static catalog/registry (safe-mode gating before reads), common ledger from broker, imports via AM-29 and original-peer drain dispatcher via R170. B2-T5 constructs settings/record/action/lifecycle/recovery services directly with these dependencies and returns `PersistenceHost` with `settings: BoundSettingsService` and `recovery` (AM-18/28). Factory keeps profile/reservations/actions/actionAdapter/coreActions/now/hasPermission required. `coreOwner` is a main-only namespace binding for a catalog source, workbench and host epoch, independent of an active feature process; it cannot grant plugin execution or bypass source/catalog admission. No renderer constructs a principal. Backend is owned by the returned host after successful construction; failed construction disposes it; host disposal drains services then backend while profile is held. F contract; P170 real composition tests reject missing dependencies at construction, prove one lock/worker/ledger/listener and read/update/recovery without activating the optional plugin.

#### Frozen AM-28 — Bound settings service and explicit controls

B2-T3 runtime settings-form-port.ts defines the host/renderer boundary, settings-service.ts implements the main service, D170 owns shared/plugin-persistence.ts/preload sender binding:

```ts
interface BoundSettingsService {
  open(input:{sourceKey:string; scope:CoreWindowScope; resourceDigest:Sha256}): Promise<{
    binding:SettingsFormBinding; resource:SettingsResourceV1; snapshot:SettingsSnapshot;
  }>;
  read(binding:SettingsFormBinding): Promise<SettingsRequestMap["settings/read"]["result"]>;
  update(binding:SettingsFormBinding, params:SettingsRequestMap["settings/update"]["params"]): Promise<SettingsRequestMap["settings/update"]["result"]>;
  reset(binding:SettingsFormBinding, params:SettingsRequestMap["settings/reset"]["params"]): Promise<SettingsRequestMap["settings/reset"]["result"]>;
  watch(binding:SettingsFormBinding, changed:()=>void): () => void;
  dispose(binding:SettingsFormBinding): void;
}
interface ContributedSettingsForm extends SettingsFormPort {
  retry(binding:SettingsFormBinding, key:SettingKey): Promise<void>;
  reload(binding:SettingsFormBinding): Promise<void>;
}
interface SettingsFieldMap {
  field(key:SettingKey): LocalId;
  key(field:LocalId): SettingKey;
  option(key:SettingKey, value:SettingsScalar): LocalId;
  value(key:SettingKey, option:LocalId): SettingsScalar;
}
declare function createSettingsFieldMap(resource:SettingsResourceV1): SettingsFieldMap;
declare function createContributedSettingsForm(controls:SettingsControlsPort,
  service:BoundSettingsService): ContributedSettingsForm;
// B1-T7 renderer/plugin-ui/host-ports.ts:
declare function attachSettingsControls(controls:SettingsControlsPort, input:{
  retry:ContributedSettingsForm["retry"]; reload:ContributedSettingsForm["reload"];
  fieldMap:(resource:SettingsResourceV1)=>SettingsFieldMap;
}): () => void;
```

`settings-service.ts` additionally exports `createBoundSettingsService(input:{backend:PersistenceBackend;sources:PersistenceSourcePort;events:CommonEventLedgerPort;now:()=>number}):BoundSettingsService`; `createPersistenceHost` calls it once and routes public settings requests through the same underlying settings service. Service resolves source/digest with AM-27 and issues bindings, validates every CAS/read/watch against current catalog and main-derived scope, and coalesces watches through the common owner ledger without an active process. A single workbench form remains the maximum. D170 exposes `PluginsApi.settings` as `Omit<BoundSettingsService,"open"> & {open(input:{sourceKey:string;resourceDigest:Sha256}):ReturnType<BoundSettingsService["open"]>}`; main inserts scope, never accepts it from renderer. Dedicated typed methods only, no generic request tunnel. Preload watch binds callbacks to the validated form. V170 retains the returned form and calls `attachSettingsControls` for retry/reload plus reversible field/option mapping. Freeze helper exports in B2-T3 contributed-settings-form.tsx; local map invalid/unknown keys throw. No new change phases, no UI v1 choice widening, no Apply button. F types; P160 generic controls, P170 attachment tests: no-process initial render, stale digest, immediate per-field CAS, conflict keeps draft until explicit retry/reload, enum 1 versus "1", dotted keys, form switch disposal.

#### Frozen AM-29 — Source resolver, durable barrier and nonce issuance

B2-T2 supplies worker resolver; B2-T6 import-sources.ts defines host orchestration and challenge types, import-coordinator.ts exports its factory:

```ts
type LegacySourceItem = Readonly<{key:string; format:Version; byteLength:number; sha256:Sha256}>;
type LegacyMappedItem = Readonly<{mapped:Handle;sourceSha256:Sha256;
  mappedSha256:Sha256;byteLength:number} & (
  {kind:"settings";schemaVersion:Version} |
  {kind:"record";metadata:Omit<RecordWrite,"target"|"checkpoint"|"drainToken">}
)>;
interface LegacySourceResolver {
  register(input:{descriptorId:string;mapperId:string;sourceKind:LegacyImportInput["sourceKind"]}): Promise<void>;
  map(descriptorId:string, key:string): Promise<LegacyMappedItem>;
  appendMapped(input:{mapped:Handle;ticket:PublicationTicket;offset:number;
    maxBytes:number}): Promise<{nextOffset:number;done:boolean}>;
  releaseMapped(mapped:Handle): Promise<void>;
  inventory(descriptorId:string): Promise<{state:"present"|"absent"|"blocked";
    entries:readonly LegacySourceItem[]}>;
  read(descriptorId:string, key:string, offset:number, maxBytes:number): Promise<Uint8Array>;
}
type LegacyPreferenceChallenge = Readonly<{nonce:Handle; scope:CoreWindowScope;
  descriptorId:string; keys:readonly string[]}>;
interface LegacyWriterBarrier {
  enter(sourceKey:string, descriptorId:string): Promise<Handle>;
  restore(): Promise<readonly {sourceKey:string;descriptorId:string;barrier:Handle}[]>;
  complete(barrier:Handle): Promise<void>;
}
interface LegacyImportHostPort extends LegacyImportCoordinator {
  issuePreferences(input:{descriptorId:string;scope:CoreWindowScope}): Promise<LegacyPreferenceChallenge>;
  retirePreferences(scope:CoreWindowScope): void;
  acceptPreferencesEvidence(snapshot:LegacyPreferencesSnapshot): Promise<{
    state:"accepted"|"pending"|"reconciled";
  }>;
}
declare function createLegacyImportCoordinator(input:{backend:PersistenceBackend;
  sources:LegacySourceResolver; barrier:LegacyWriterBarrier;
  descriptors:readonly LegacyImportDescriptor[];
  currentScope:(scope:CoreWindowScope)=>boolean;
  currentSource:(sourceKey:string)=>boolean;
  importOwner:(sourceKey:string)=>PersistenceOwner;
}): LegacyImportHostPort;
interface LegacyWriterPort {
  readonly sourceKey:string;
  freezeAdmission(): void;
  settled(): Promise<void>;
}
declare function createLegacyWriterBarrier(input:{backend:PersistenceBackend;
  writers:readonly LegacyWriterPort[];importOwner:(sourceKey:string)=>PersistenceOwner;
}): LegacyWriterBarrier;
```

`acceptPreferences` remains the existing `Promise<void>` compatibility facet, resolving only after durable acceptance/reconciliation; trusted D170/V170 use `acceptPreferencesEvidence` for explicit pending status. T6 alone issues challenges from allowlisted descriptors, derives target scope from main, persists challenge/evidence/digest before marking nonce consumed, allows one in-flight challenge per scope/descriptor and rejects changed replay. On restart restore evidence and durable barrier; a fresh bootstrap may reconcile existing evidence but cannot replay an old window nonce. D170 `PluginsApi.legacyPreferences` has `challenge(descriptorId:string):Promise<LegacyPreferenceChallenge>` and `submit(snapshot:LegacyPreferencesSnapshot):ReturnType<LegacyImportHostPort["acceptPreferencesEvidence"]>`; sender scope is independently checked/replaced, no arbitrary key allowlist from renderer.

Roots and descriptors are fixed by main/worker allowlists. `register` selects only a worker-installed mapper ID and its fixed source root; it cannot install executable code or accept a path. T2 worker.ts exports `runPersistenceWorker(input:{mappers:ReadonlyMap<string,LegacyImportDescriptor>}):void`; the product entry uses only shipped allowlisted mappings (none for real Lab/device in foundations). T7's existing `tests/desktop/fixtures/plugin-persistence/kill-worker.mjs` is the test bootstrap wrapper importing T6's import-fixtures.ts synthetic mapping through its built artifact and calling the same worker runner. Test roots are supplied by its private test launch, never a production registry entry. `createLegacyImportCoordinator` uses `sources.map` in the worker; descriptor functions supplied to the host are never serialized or run on main. Map retains the mapped payload in the worker and returns only its bounded metadata/digests/opaque mapped handle. `appendMapped` transfers at most 256KiB directly into the same admitted engine ticket per call, verifies sequential offsets and the plan digest/target, and `releaseMapped` frees the pin after a known outcome; no 8MiB payload is copied into main or an IPC frame. Mapping concurrency obeys the four-job and scratch quotas; no full inventory buffering. No functions or unvalidated paths cross worker transport. inventory only reports absent for actual ENOENT, preserves permission/format failures as blocked. T6 implements `createLegacyWriterBarrier` in import-sources.ts; D170 supplies registered host writer controls, freezes their admissions synchronously and waits for their in-flight work before collection; the marker survives restart and disables old writers before they start. Challenge/raw-evidence/consumption/barrier documents use immutable engine tickets with metadata kind `import` and AM-26 auxiliary reads; bounded keys are `nonce/<nonce>` and `barrier/<descriptorId>`. A durable nonce record contains formatVersion, descriptorId, scope, allowlist, nonce, raw entries, digest and issued/consumed state; consume is atomic only after raw evidence persistence/reconciliation. `importOwner` supplies a host-issued namespace identity, independent of optional execution, never reconstructed by renderer. Restoring barriers enumerates admitted descriptors and reads these keys before invoking writer controls. Foundation supplies no live legacy product writer controls or mappings; it uses synthetic sources/barriers only; real Lab/device mapping and permanently switching those stores remains 3D/3E. F signatures, P170 tests: wrong descriptor/key/window, duplicate/oversize nonce evidence, persistence failure before consume, uncertain publish/restart, missing-versus-permission, barrier restart and original bytes unchanged.

#### Frozen AM-30 — Real persistence and cross-plan fixture

B2-T7 owns the sole test producer in `tests/desktop/plugin-persistence-main.ts`, exporting `createFoundationFixture(): Promise<FoundationFixture>`. It composes AM-21 real broker/fake provider, AM-11/14 real action/UI/runtime path, AM-23 worker/root, AM-27 host, AM-29 imports, real public JS/Python clients and fault controls. Remove the external `PERSISTENCE_COMPOSITION` dependency. X-T1 imports this producer read-only; there is no second composition or oracle pretending to be a driver.

F freezes these test-only exports in that file (implementation P170):

```ts
type FoundationCase = "contention"|"retirement"|"registration-end"|"healthy-release"|
  "disconnect-retry"|"suspend-wake"|"renderer-loss"|"sealed-ttl"|"unknown-publication"|
  "all-optional-off"|"action-replay"|"import-restart"|"storage-ui-pressure"|"compatibility"|"installed";
type CaseEvidence = {checks:Record<string,string|number|boolean|readonly string[]|readonly number[]>;
  events:Array<{kind:string;turn:number;time:number;grant?:DeviceDrainGrant|null;deadline?:number}>;
  samples:Record<string,number[]>};
interface FoundationFixture {
  composition:{profile:ProfileWriterLock;journalProfile:ProfileWriterLock;
    persistenceProfile:ProfileWriterLock;reservationListenerCount:number;workerCount:number;
    host:PersistenceHost;stage3:Stage3RuntimePorts};
  environment:{commit:string;artifact:string;artifactSha256:string;os:string;architecture:string;
    cpu:string;ramBytes:number;filesystem:string;node:string;electron:string;
    memoryMethod:string;warmCold:string};
  runCase(id:FoundationCase): Promise<CaseEvidence>;
  close(): Promise<void>;
}
```

Retain P12's 15 case assertions but import these types/constants from T7's producer, not vice versa. Measurements come from actual faults/traces/counters/artifact hashes; constant evidence is allowed only for verifier unit tests. T7 develops against F then resumes after D170/K170 have stopped for a named exact-file producer handoff (`plugin-persistence-main.ts` and `plugin-persistence-run.mjs`) before P170 acceptance. Record producer bundle hash/commit in B2 acceptance. After T7 stops, X-T1 consumes it; defects return to T7 in another stopped-owner receipt, never an implicit X-T1 write grant. P170 real run and X-T1 all 15 cases, real worker kills/reopen, SDK traffic, installed artifact and cleanup; manual/hardware rows remain pending when unrun.

#### Frozen AM-31 — SDK exports, invocation factory and fixture representation

B2-T1 keeps the existing proposal names: JS settings.ts `createSettingsClient(request: PersistenceRequest)`, storage.ts `createStorageClient(request: PersistenceRequest)`, persistence-actions.ts `createPersistenceActionsClient(request: PersistenceRequest)`. `PersistenceRequest` is the generic typed function over `SettingsRequestMap & StorageRequestMap & PersistenceActionRequestMap` with `(method,params,options:{timeoutMs:number;signal?:AbortSignal}) => Promise<result>`. Return types are exact mapped clients: `type PersistenceClientFor<K extends keyof PersistenceMaps> = { [M in K as M extends `${string}/${infer Name}` ? Name : never]: (params:PersistenceMaps[M]["params"],signal?:AbortSignal)=>Promise<PersistenceMaps[M]["result"]> }`, with `PersistenceMaps = SettingsRequestMap & StorageRequestMap & PersistenceActionRequestMap`. The three factories respectively return `PersistenceClientFor<keyof SettingsRequestMap>`, `PersistenceClientFor<keyof StorageRequestMap>` and `PersistenceClientFor<keyof PersistenceActionRequestMap>`; export methods live on the actions client. The mapped type is defined/exported by JS settings.ts and imported by the other two clients. No forwarding reimplementation in B2-T8. Python exports `create_settings_client(request)`, `create_storage_client(request)`, `create_persistence_actions_client(request)` from the matching modules; methods use snake_case, take typed params and return validated result dictionaries, with no mutation retry. Settings.ts exports `settingsResourceV1Schema: z.ZodType<SettingsResourceV1>`; persistence-validation.ts exports the already proposed `validateSettingsResource(input:unknown,rawBytes:number):SettingsResourceV1`.

H-P B1-T1 freezes the invocation factory in JS index.ts as `createInvocationContext(base: PluginContext, invocation: CommandInvocation, signal: AbortSignal): PluginContext & {readonly invocation:CommandInvocation; readonly signal:AbortSignal}` and Python `_plugin.py` as `create_invocation_context(base, invocation)`. At P170 this factory creates fresh `ctx.actions` with read-only invocation-local `actionRef` getter from `invocation.context.actionRef`; missing value remains absent. Never mutate shared base or use a global current invocation. B2-T8 adds actual low-level clients to the normal context and `{request:DrainRequest, signal:AbortSignal, storage:ReturnType<typeof createStorageClient>}` JS drain callback / `{request, storage}` Python callback; drain storage uses the original bound channel and grant-scoped request path. Use common AM-01/16 event queue for watches; unwatch sugar sends events/unsubscribe and retains `{removed:boolean}`.

All three valid/invalid/maximum fixture files use one strict outer format frozen in A-T1 device-contract.test.ts, B1-T1 ui-contract.test.ts and B2-T1 persistence-contract.test.ts:

```ts
type ContractFixtureFile = {formatVersion:1;family:"device-broker-v1"|"declarative-ui-v1"|"settings-storage-v1";
  cases:Array<{id:string;schema:string;phase:"params"|"result"|"resource"|"event";
    input:unknown;valid:boolean;expected:{numericCode:number|null;businessCode:string|null;
      reason:string|null;permission:string|null;lifetime:string|null;persistedSha256:Sha256|null}}>} ;
```

`schema` names a closed domain schema-map key validated by that family's runner, never evaluated code. `input` is bounded fixture JSON, not a new wire `unknown` field; valid true has null error fields, invalid specifies the expected numeric or business failure where applicable. Maximum files carry explicit limit and +1 cases via IDs, measured after serialization. Python/JS/Zod/exported JSON Schema consume the same structural cases; lifecycle/hash expectations require real host tests and cannot be asserted by schema alone. F format/names, P160 invocation factory, P170 facade integration/tests: overlapping invocations keep distinct actionRef, optional cancellation/drain, shared watch ACK, no duplicate client/validator and exact file format parsing.

#### Frozen AM-32 — Canonical spec paths and disk wording

Choose the skeleton's `packages/plugin-protocol/test-fixtures/device-broker-v1/{valid,invalid,maximum}.json` and `main/device-broker/fake-provider.ts`/test; no second `conformance/devices-v1` or host `fixtures/` tree. All foundation acceptance reports remain under `docs/superpowers/plans/` with the exact task-listed names; one report per gate. Record objects `<revision>.bin` contain exact opaque payload bytes, no prefix/wrapper. JSON identity/head/settings/import/recovery envelopes carry `formatVersion:1`; opaque records are versioned by their head and `RecordMeta.schemaVersion`. B2-T2 tests compare byteLength/hash byte-for-byte and reject unsupported JSON envelope versions without rewriting data. `spec-corrections.md` lists exact text/path edits for the four spec owners; this amendment does not edit specs. F records corrections, P150/P160/P170 runners use the canonical paths.

- [ ] **Step 4: Freeze the shared fixture inventory and measurement manifest**

Create the three JSON files with these complete contents. T1 executes them and expands their data deterministically; T8 receives ownership only after T1 stops. The strict outer shape is AM-31; lifecycle/hash expectations require host evidence. Keep this measurement manifest in the plan and T7 harness, outside the three fixture JSON documents:

```json
{
  "settingsKeys":128,"settingsResourceBytes":65536,"settingsValuesBytes":65536,"stringBytes":4096,
  "recordBytes":8388608,"recordsPerSource":256,"sourceBytes":536870912,"hostBytes":1073741824,
  "chunkBytes":262144,"chunkEncodedBytes":349528,"listEntries":64,"listResultBytes":262144,
  "sourceWriteSlots":2,"hostWriteSlots":16,"sourceExportSlots":1,"hostExportSlots":4,
  "temporarySourceBytes":33554432,"temporaryHostBytes":134217728,"metadataSourceBytes":4194304,"metadataHostBytes":67108864,
  "diskHeadroomBytes":16777216,"pendingRequests":32,"pendingHostBytes":8388608,"pendingSourceBytes":1048576,"ioJobs":4,
  "idleMs":30000,"totalMs":120000,"rpcMs":10000,"drainMs":10000,"cleanupMs":24000,"outerMs":25000,
  "workload":{"records":50,"recordBytes":8388608,"stagedRecords":2,"concurrentJobs":4,"samples":30},
  "measurement":["OS","architecture","CPU","RAM","filesystem","artifact","commit","Node","Electron","fixtureBytes","records","warmCold","samples","p50","p95","max","mainRSS","workerRSS","memoryMethod"],
  "thresholds":{"draftP95Ms":50,"pageP95Ms":100,"listP95Ms":200,"mainSyncMaxMs":16,"mainAdditionalRSS":33554432,"workerAdditionalRSS":67108864,"commitFlushMaxMs":10000,"extraStopDispatchP95Ms":50}
}
```

`packages/plugin-protocol/test-fixtures/settings-storage-v1/valid.json`:

```json
{
  "formatVersion": 1,
  "family": "settings-storage-v1",
  "cases": [
    {
      "id": "settings-boolean",
      "schema": "settingsResourceV1",
      "phase": "resource",
      "input": {
        "schemaVersion": 1,
        "title": {
          "en": "Settings"
        },
        "fields": [
          {
            "key": "connection.enabled",
            "label": {
              "en": "Enabled"
            },
            "type": "boolean",
            "default": true
          }
        ]
      },
      "valid": true,
      "expected": {
        "numericCode": null,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "mixed-enum",
      "schema": "settingsResourceV1",
      "phase": "resource",
      "input": {
        "schemaVersion": 1,
        "title": {
          "en": "Settings"
        },
        "fields": [
          {
            "key": "connection.mode",
            "label": {
              "en": "Mode"
            },
            "type": "enum",
            "default": 1,
            "options": [
              {
                "value": 1,
                "label": {
                  "en": "Number"
                }
              },
              {
                "value": "1",
                "label": {
                  "en": "Text"
                }
              }
            ]
          }
        ]
      },
      "valid": true,
      "expected": {
        "numericCode": null,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "read",
      "schema": "settings/read",
      "phase": "params",
      "input": {
        "schemaVersion": 1
      },
      "valid": true,
      "expected": {
        "numericCode": null,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "empty-quota",
      "schema": "storage/quota",
      "phase": "params",
      "input": {},
      "valid": true,
      "expected": {
        "numericCode": null,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    }
  ]
}
```

`packages/plugin-protocol/test-fixtures/settings-storage-v1/invalid.json`:

```json
{
  "formatVersion": 1,
  "family": "settings-storage-v1",
  "cases": [
    {
      "id": "unknown-field",
      "schema": "settings/read",
      "phase": "params",
      "input": {
        "schemaVersion": 1,
        "namespace": "foreign"
      },
      "valid": false,
      "expected": {
        "numericCode": -32602,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "bool-version",
      "schema": "settings/read",
      "phase": "params",
      "input": {
        "schemaVersion": true
      },
      "valid": false,
      "expected": {
        "numericCode": -32602,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "noncanonical-base64",
      "schema": "chunk",
      "phase": "params",
      "input": "Zh==",
      "valid": false,
      "expected": {
        "numericCode": -32602,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "dangerous-key",
      "schema": "settingsResourceV1",
      "phase": "resource",
      "input": {
        "schemaVersion": 1,
        "title": {
          "en": "Settings"
        },
        "fields": [
          {
            "key": "x.constructor",
            "label": {
              "en": "X"
            },
            "type": "boolean",
            "default": false
          }
        ]
      },
      "valid": false,
      "expected": {
        "numericCode": null,
        "businessCode": "PLUGIN_E_SETTINGS_SCHEMA",
        "reason": "invalid-resource",
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    }
  ]
}
```

`packages/plugin-protocol/test-fixtures/settings-storage-v1/maximum.json`:

```json
{
  "formatVersion": 1,
  "family": "settings-storage-v1",
  "cases": [
    {
      "id": "settings-keys-128",
      "schema": "settingsResourceV1",
      "phase": "resource",
      "input": {
        "schemaVersion": 1,
        "title": {
          "en": "Boundary"
        },
        "fields": [
          {
            "key": "k0",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k1",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k2",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k3",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k4",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k5",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k6",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k7",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k8",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k9",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k10",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k11",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k12",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k13",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k14",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k15",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k16",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k17",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k18",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k19",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k20",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k21",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k22",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k23",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k24",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k25",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k26",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k27",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k28",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k29",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k30",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k31",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k32",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k33",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k34",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k35",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k36",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k37",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k38",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k39",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k40",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k41",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k42",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k43",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k44",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k45",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k46",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k47",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k48",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k49",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k50",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k51",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k52",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k53",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k54",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k55",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k56",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k57",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k58",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k59",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k60",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k61",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k62",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k63",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k64",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k65",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k66",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k67",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k68",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k69",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k70",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k71",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k72",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k73",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k74",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k75",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k76",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k77",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k78",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k79",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k80",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k81",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k82",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k83",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k84",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k85",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k86",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k87",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k88",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k89",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k90",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k91",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k92",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k93",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k94",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k95",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k96",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k97",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k98",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k99",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k100",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k101",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k102",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k103",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k104",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k105",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k106",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k107",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k108",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k109",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k110",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k111",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k112",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k113",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k114",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k115",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k116",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k117",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k118",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k119",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k120",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k121",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k122",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k123",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k124",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k125",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k126",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k127",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          }
        ]
      },
      "valid": true,
      "expected": {
        "numericCode": null,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "settings-keys-129",
      "schema": "settingsResourceV1",
      "phase": "resource",
      "input": {
        "schemaVersion": 1,
        "title": {
          "en": "Boundary"
        },
        "fields": [
          {
            "key": "k0",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k1",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k2",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k3",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k4",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k5",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k6",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k7",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k8",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k9",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k10",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k11",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k12",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k13",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k14",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k15",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k16",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k17",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k18",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k19",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k20",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k21",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k22",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k23",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k24",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k25",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k26",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k27",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k28",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k29",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k30",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k31",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k32",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k33",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k34",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k35",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k36",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k37",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k38",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k39",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k40",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k41",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k42",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k43",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k44",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k45",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k46",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k47",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k48",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k49",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k50",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k51",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k52",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k53",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k54",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k55",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k56",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k57",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k58",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k59",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k60",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k61",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k62",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k63",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k64",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k65",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k66",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k67",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k68",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k69",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k70",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k71",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k72",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k73",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k74",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k75",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k76",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k77",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k78",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k79",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k80",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k81",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k82",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k83",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k84",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k85",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k86",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k87",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k88",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k89",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k90",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k91",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k92",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k93",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k94",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k95",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k96",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k97",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k98",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k99",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k100",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k101",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k102",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k103",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k104",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k105",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k106",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k107",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k108",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k109",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k110",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k111",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k112",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k113",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k114",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k115",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k116",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k117",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k118",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k119",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k120",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k121",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k122",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k123",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k124",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k125",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k126",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k127",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          },
          {
            "key": "k128",
            "label": {
              "en": "K"
            },
            "type": "boolean",
            "default": true
          }
        ]
      },
      "valid": false,
      "expected": {
        "numericCode": null,
        "businessCode": "PLUGIN_E_SETTINGS_SCHEMA",
        "reason": "invalid-resource",
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "record-bytes-8388608",
      "schema": "storage/beginWrite",
      "phase": "params",
      "input": {
        "target": {
          "mode": "create"
        },
        "kind": "test",
        "schemaVersion": 1,
        "label": "Boundary",
        "mediaType": "application/octet-stream",
        "byteLength": 8388608,
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
      },
      "valid": true,
      "expected": {
        "numericCode": null,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "record-bytes-8388609",
      "schema": "storage/beginWrite",
      "phase": "params",
      "input": {
        "target": {
          "mode": "create"
        },
        "kind": "test",
        "schemaVersion": 1,
        "label": "Boundary",
        "mediaType": "application/octet-stream",
        "byteLength": 8388609,
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
      },
      "valid": false,
      "expected": {
        "numericCode": -32602,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    }
  ]
}
```

- [ ] **Step 5: Build all freeze contracts and preserve the published 1.4 registry**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime check
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-sdk build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/device build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop check
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol exec vitest run src/persistence-contract.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime exec vitest run src/persistence-participant.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/persistence/contract.test.ts
```

Expected: PASS for compilation and contracts. Existing API/version/registry assertions remain 1.4.0. This does not claim a functioning persistence service. No schema generator runs in T0.

- [ ] **Step 6: Record ownership, then have the controller commit F**

Append a receipt section to `docs/superpowers/plans/2026-10-17-plugin-system-stage-3-contract-freeze.md` preserving A/B1 sections. The following script writes only that receipt, derives actual Git SHAs, and lists every T0 successor. It cannot claim unexecuted verification: run only after Step 5 succeeds.

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; python3 - <<'PYRECEIPT'
from pathlib import Path
import subprocess
p = Path("docs/superpowers/plans/2026-10-17-plugin-system-stage-3-contract-freeze.md")
head = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
assert len(head) == 40
rows = {
 "3B2-T1": ["packages/plugin-protocol/src/settings.ts", "packages/plugin-protocol/src/storage.ts", "packages/plugin-protocol/src/persistence-actions.ts", "packages/plugin-protocol/src/persistence-validation.ts", "packages/plugin-protocol/src/persistence-contract.test.ts", "packages/plugin-protocol/test-fixtures/settings-storage-v1/valid.json", "packages/plugin-protocol/test-fixtures/settings-storage-v1/invalid.json", "packages/plugin-protocol/test-fixtures/settings-storage-v1/maximum.json"],
 "3B2-T2": ["apps/desktop/src/main/plugins/persistence/filesystem.ts", "apps/desktop/src/main/plugins/persistence/engine-port.ts", "apps/desktop/src/main/plugins/persistence/contract.test.ts", "apps/desktop/src/main/plugins/persistence/worker.ts"],
 "3B2-T3": ["packages/plugin-runtime/src/settings-form-port.ts", "apps/desktop/src/main/plugins/persistence/settings-service.ts", "apps/desktop/src/renderer/settings/contributed-settings-form.tsx"],
 "3B2-T4": ["apps/desktop/src/main/plugins/persistence/record-port.ts"],
 "3B2-T5": ["packages/plugin-runtime/src/persistence-participant.ts", "packages/plugin-runtime/src/persistence-participant.test.ts", "apps/desktop/src/main/plugins/persistence/host-port.ts", "apps/desktop/src/main/plugins/persistence/actions.ts", "apps/desktop/src/main/plugins/persistence/recovery-port.ts"],
 "3B2-T6": ["apps/desktop/src/main/plugins/persistence/import-sources.ts"],
 "3B2-T7": ["tests/desktop/plugin-persistence-main.ts"],
 "H-P": ["packages/plugin-protocol/src/index.ts"],
 "H-R": ["packages/plugin-runtime/src/index.ts"],
 "H-I": [str(p)],
}
with p.open("a") as f:
 f.write("\n## B2 freeze step 3\n\nVerified pre-F parent: `" + head + "`.\n\n")
 f.write("F is the following verified contract commit; the controller records its actual SHA in the receipt-only follow-up commit before cutting worktrees. No implementation begins earlier.\n\n| Path | Successor |\n|---|---|\n")
 for owner, paths in rows.items():
  for path in paths: f.write(f"| `{path}` | {owner} |\n")
 f.write("\nT0 rights relinquished. Fixtures transfer T1 → T8 only after T1 stops. P150 → P160 → P170 publication order is unchanged. No performance, Electron, hardware, or manual result is claimed.\n")
PYRECEIPT
```

Controller runs outside sandbox:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git add \
  packages/plugin-protocol/src/settings.ts \
  packages/plugin-protocol/src/storage.ts \
  packages/plugin-protocol/src/persistence-actions.ts \
  packages/plugin-protocol/src/persistence-validation.ts \
  packages/plugin-protocol/src/persistence-contract.test.ts \
  packages/plugin-runtime/src/persistence-participant.ts \
  packages/plugin-runtime/src/persistence-participant.test.ts \
  packages/plugin-runtime/src/settings-form-port.ts \
  apps/desktop/src/main/plugins/persistence/filesystem.ts \
  apps/desktop/src/main/plugins/persistence/engine-port.ts \
  apps/desktop/src/main/plugins/persistence/host-port.ts \
  apps/desktop/src/main/plugins/persistence/import-sources.ts \
  apps/desktop/src/main/plugins/persistence/contract.test.ts \
  packages/plugin-protocol/test-fixtures/settings-storage-v1/valid.json \
  packages/plugin-protocol/test-fixtures/settings-storage-v1/invalid.json \
  packages/plugin-protocol/test-fixtures/settings-storage-v1/maximum.json \
  docs/superpowers/plans/2026-10-17-plugin-system-stage-3-contract-freeze.md \
  apps/desktop/src/main/plugins/persistence/record-port.ts \
  apps/desktop/src/main/plugins/persistence/actions.ts \
  apps/desktop/src/main/plugins/persistence/worker.ts \
  apps/desktop/src/main/plugins/persistence/recovery-port.ts \
  apps/desktop/src/main/plugins/persistence/settings-service.ts \
  apps/desktop/src/renderer/settings/contributed-settings-form.tsx \
  tests/desktop/plugin-persistence-main.ts \
  packages/plugin-protocol/src/index.ts \
  packages/plugin-runtime/src/index.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git diff --cached --check
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git commit -m "feat(plugins): freeze stage 3 persistence contracts"
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git rev-parse HEAD
```

Immediately record the printed F SHA without amending F (a commit cannot contain its own SHA). Controller runs the receipt-only follow-up outside sandbox, still on the integration branch. The script refuses to replace any existing task branch. User executes all later merges.

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; python3 - <<'PYFREEZE'
from pathlib import Path
import subprocess
run = lambda *args: subprocess.check_output(["git", *args], text=True).strip()
freeze = run("rev-parse", "HEAD")
branches = ("feat/plugin-3a", "feat/plugin-3b1", "feat/plugin-3b2")
for branch in branches:
    if subprocess.run(["git", "show-ref", "--verify", "--quiet", "refs/heads/" + branch]).returncode == 0:
        raise SystemExit("Existing branch requires controller reconciliation: " + branch)
for branch in branches:
    subprocess.run(["git", "branch", branch, freeze], check=True)
receipt = Path("docs/superpowers/plans/2026-10-17-plugin-system-stage-3-contract-freeze.md")
receipt.write_text(receipt.read_text() + "\n## Completed freeze receipt\n\nF: `" + freeze + "`\n\n" + "\n".join("- `" + b + "` cut at `" + run("rev-parse", b) + "`" for b in branches) + "\n")
PYFREEZE
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git add docs/superpowers/plans/2026-10-17-plugin-system-stage-3-contract-freeze.md
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git commit -m "docs(plugins): record stage 3 freeze commit and branch cuts"
```


## Interfaces Summary

All source blocks in T0 Step 3 above are the complete B2/C-B2 definitions. `Scalar` is module-local; only `SettingsScalar` leaves its barrel. `DrainReport` lives solely in runtime. Desktop and SDK consumers type-only import these declarations. The tables below are copied verbatim from the binding skeleton; they define exact keys, result envelopes, and failure vocabulary for T1/T8.

#### B2 §4.2 table contracts

| Method                   | Params                                                                                 | Value／權限                                                                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings/read`          | `{schemaVersion}`                                                                      | `SettingsSnapshot`；`settings.read`。沒有資料回 defaults/null；版本不合報錯。                                                                                                    |
| `settings/update`        | `{schemaVersion, expectedRevision:SettingsRevision\|null, changes:Values}`             | `SettingsMutation`；`settings.write`。changes 1–128，每鍵唯一；將 patch 套到完整 snapshot 後整體驗證／原子提交。                                                                 |
| `settings/reset`         | `{schemaVersion, expectedRevision, keys:SettingKey[]}`                                 | `SettingsMutation`；`settings.write`。keys 1–128，不接受 wildcard；全 reset 明列全部 keys，依同一 CAS 一次提交。                                                                 |
| `settings/watch`         | `{schemaVersion}`                                                                      | `{subscriptionId:Handle, sequence:0, snapshot:SettingsSnapshot}`；`settings.read`。註冊與 baseline snapshot 在同一序列位置完成。                                                 |
| `settings/readMigration` | `{}`                                                                                   | `{stored:SettingsSnapshot, declaredSchemaVersion:Version}`；`settings.read`。只回本 source 已持久化值，無資料回 `PLUGIN_E_SETTINGS_SCHEMA`／`invalid-value`，不虛構舊 snapshot。 |
| `settings/migrate`       | `{fromSchemaVersion, schemaVersion, expectedRevision:SettingsRevision, values:Values}` | `SettingsMutation`；`settings.write`。完整 replacement，所有當前 keys 恰一次，不自動補 defaults；from 與 stored 相符，且 from＜schemaVersion。                                   |

#### B2 §5.2 table contracts

| Method                | Params                                                       | Value／權限                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage/beginWrite`  | `RecordWrite`                                                | `{write:Handle,id:RecordId,expiresAt:number}`；`storage.write`。先驗 owner／schema envelope／CAS／quota，reservation 成功才建 temp。                           |
| `storage/writeChunk`  | `{write,offset:number,data:string}`                          | `{receivedBytes:number,expiresAt:number}`；`storage.write`。data 為 canonical RFC 4648 padded base64，解碼後 1..256 KiB。                                      |
| `storage/sealWrite`   | `{write}`                                                    | `WriteProgress`；`storage.write`。檢查完整 length／sha256、fsync staging，成功才 sealed；0-byte payload 直接 seal。                                            |
| `storage/commitWrite` | `{write,drainToken?:Handle}`                                 | `{record:RecordMeta,receipt:Receipt<RecordRevision>}`；`storage.write`。只能提交 sealed；成功完整替換，重複對同 write 回相同 receipt。                         |
| `storage/writeStatus` | `{write}`                                                    | `WriteProgress`；同 principal 且 `storage.write`。timeout 後先查；不可自動另建 write。                                                                         |
| `storage/abortWrite`  | `{write}`                                                    | `{disposition:"aborted" \| "committed" \| "unknown",receipt?:Receipt<RecordRevision>}`；`storage.write`。receiving／sealed 可 abort；已 publish 不回 aborted。 |
| `storage/stat`        | `{id}`                                                       | `{record:RecordMeta}`；`storage.read`，包含目前 revision；不讀完整 payload。                                                                                   |
| `storage/list`        | `{kind?:string,limit:number,cursor?:Handle}`                 | `{entries:RecordMeta[],nextCursor?:Handle}`；`storage.read`，limit 1..64。                                                                                     |
| `storage/openRead`    | `{id,expectedRevision:RecordRevision,schemaVersion:Version}` | `{read:Handle,record:RecordMeta,expiresAt:number}`；`storage.read`，pin 這一 immutable revision。                                                              |
| `storage/readChunk`   | `{read,offset:number,maxBytes:number}`                       | `{offset:number,data:string,nextOffset:number,eof:boolean}`；`storage.read`，maxBytes 1..256 KiB。                                                             |
| `storage/closeRead`   | `{read}`                                                     | `{}`；相同 live principal 重複關閉成功，foreign／stale 拒絕。                                                                                                  |
| `storage/delete`      | `{id,expectedRevision:RecordRevision}`                       | `{deleted:true,receipt:Receipt<RecordRevision>}`；`storage.write`。原子 publish tombstone，之後 stat/read 不見該 ID；既有 read pin 可完成。                    |
| `storage/flush`       | `{}`                                                         | `{barrier:Handle,durability:Durability}`；`storage.write`。§5.4 定義精確涵蓋範圍。                                                                             |
| `storage/quota`       | `{}`                                                         | §5.4 quota snapshot；`storage.read` 或 `storage.write` 任一。                                                                                                  |

#### B2 §7.2 table contracts

| Method                 | Params                                                                                                      | Value                                                                                                                                                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage/exportBegin`  | `{actionRef:Handle,suggestedName:string,mediaType:RecordMeta["mediaType"],byteLength:number,sha256:Sha256}` | `{export:Handle,state:"waiting",expiresAt:number}`。需 `storage.export`；上限 8 MiB；立即回 job，dialog 非阻塞等待。                                                                                                                                           |
| `storage/exportChunk`  | `{export:Handle,offset:number,data:string}`                                                                 | `{receivedBytes,expiresAt}`；chunk 格式／重送規則同 storage/writeChunk。                                                                                                                                                                                       |
| `storage/exportCommit` | `{export:Handle}`                                                                                           | `{exported:true,commitId:Handle,durability:Durability}`；驗完整 length/hash、sync、atomic replace。                                                                                                                                                            |
| `storage/exportStatus` | `{export:Handle}`                                                                                           | `{state:"waiting" \| "receiving" \| "publishing" \| "completed" \| "cancelled" \| "expired" \| "failed",receivedBytes:number,expiresAt:number,commitId?:Handle,durability?:Durability,error?:{code:string,message:string,detail?:PersistenceFailureDetail}}`。 |
| `storage/exportCancel` | `{export:Handle}`                                                                                           | `{disposition:"aborted" \| "committed" \| "unknown",commitId?:Handle}`，不得對已替換 destination 回 cancelled。                                                                                                                                                |

#### B2 §8.1 table contracts

| 方向／Method                             | Params                                                              | Value／效果                                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| plugin→host `storage/registerCheckpoint` | `{id:RecordId,expectedRevision:RecordRevision,reservation?:Handle}` | `{checkpoint:Handle}`；需 `storage.write`，record 必須已存在且尚未 final／interrupted，每 source 最多 2 個。registration 同步持久化 recovery evidence 成功後才 ack。 |
| plugin→host `storage/abandonCheckpoint`  | `{checkpoint:Handle}`                                               | `{record:RecordMeta}`；需 `storage.write`，無 pending write 且相關 reservation 已結束才允許；保留最後 checkpoint 並標 interrupted，不假造 final。                    |
| host→plugin `storage/drain`              | `DrainRequest`                                                      | `{status:"submitted" \| "checkpoint-only",writes:Handle[]}`；writes 最多 2，僅供 host 對帳，不構成保存成功證據。                                                     |

From B2 §4.3:

新增 settings watch payload：`{revision:SettingsRevision, schemaVersion:Version, changedKeys:SettingKey[], cause:"update"|"reset"|"migrate"|"import"}`。changedKeys 最多 128，不送 values；consumer read 取得最新完整 snapshot。schema resource 換版撤銷舊 watcher，送同一 event framework 的 resource invalidation；不是向舊 consumer 發不理解的新 keys。訂閱不跨 disable／crash／reload／safe mode，自動撤回；值保留。

From B2 §5.4:

新增 quota value：`{recordCount,reservedCreates,committedBytes,reservedBytes,pinnedBytes,temporaryBytes,sourceLimitBytes:536870912,sourceLimitRecords:256,hostAvailableBytes,writeSlotsAvailable,exportSlotsAvailable}`。所有大小為非負 safe integers。`hostAvailableBytes` 僅顯示剩餘額度，不回其他 source 明細；quota snapshot 是提示，begin 時在同一鎖內重新預約。

From B2 §7.3:

新增 `ui/copyText({actionRef:Handle,text:string}) → {copied:true}`，需 `ui.clipboard`。plain UTF-8、最多 64 KiB／16,384 code points；只寫 text，不讀 clipboard，不接受 HTML／RTF／files／image。主程序驗 actionRef 時間／同 owner／resource generation，消耗 capability 後立即執行；前置取消／失效不改 clipboard。OS write 已執行但 ack 遺失時不能 rollback 或自動重複 copy。


### Task 3B2-T1: Implement isolated persistence schemas and low-level clients

**Files**

- Modify: `packages/plugin-protocol/src/settings.ts`
- Create: `packages/plugin-protocol/src/settings.test.ts`
- Modify: `packages/plugin-protocol/src/storage.ts`
- Create: `packages/plugin-protocol/src/storage.test.ts`
- Modify: `packages/plugin-protocol/src/persistence-actions.ts`
- Create: `packages/plugin-protocol/src/persistence-actions.test.ts`
- Modify: `packages/plugin-protocol/src/persistence-validation.ts`
- Create: `packages/plugin-protocol/src/persistence-validation.test.ts`
- Modify: `packages/plugin-protocol/src/persistence-contract.test.ts`
- Create: `packages/plugin-sdk-js/src/settings.ts`
- Create: `packages/plugin-sdk-js/src/settings.test.ts`
- Create: `packages/plugin-sdk-js/src/storage.ts`
- Create: `packages/plugin-sdk-js/src/storage.test.ts`
- Create: `packages/plugin-sdk-js/src/persistence-actions.ts`
- Create: `packages/plugin-sdk-js/src/persistence-actions.test.ts`
- Create: `sdks/python/kobrixa/_settings.py`
- Create: `sdks/python/kobrixa/_storage.py`
- Create: `sdks/python/kobrixa/_persistence_actions.py`
- Create: `sdks/python/tests/test_settings.py`
- Create: `sdks/python/tests/test_storage.py`
- Create: `sdks/python/tests/test_persistence_actions.py`
- Modify: `packages/plugin-protocol/test-fixtures/settings-storage-v1/valid.json`
- Modify: `packages/plugin-protocol/test-fixtures/settings-storage-v1/invalid.json`
- Modify: `packages/plugin-protocol/test-fixtures/settings-storage-v1/maximum.json`
- Test: `packages/plugin-protocol/src/settings.test.ts`
- Test: `packages/plugin-protocol/src/storage.test.ts`
- Test: `packages/plugin-protocol/src/persistence-actions.test.ts`
- Test: `packages/plugin-protocol/src/persistence-validation.test.ts`
- Test: `packages/plugin-protocol/src/persistence-contract.test.ts`
- Test: `packages/plugin-sdk-js/src/settings.test.ts`
- Test: `packages/plugin-sdk-js/src/storage.test.ts`
- Test: `packages/plugin-sdk-js/src/persistence-actions.test.ts`
- Test: `sdks/python/tests/test_settings.py`
- Test: `sdks/python/tests/test_storage.py`
- Test: `sdks/python/tests/test_persistence_actions.py`

**Interfaces**

- Consumes: the T0 declarations `BusinessResult<Value, Detail>`, `DefinitionMap<S>`, `PermissionErrorDetail`, `ResourceErrorDetail`, `Handle`, `Counter`, `ReservationSnapshot`; C-Wire's exact six settings, seventeen storage and six action methods.
- Produces: `settingsRequestSchemas`, `storageRequestSchemas`, `persistenceActionRequestSchemas`; `SettingsRequestMap = DefinitionMap<typeof settingsRequestSchemas>`, `StorageRequestMap = DefinitionMap<typeof storageRequestSchemas>`, `PersistenceActionRequestMap = DefinitionMap<typeof persistenceActionRequestSchemas>`.
- Produces module-local helpers: `validateSettingsResource(input: unknown, rawBytes: number): SettingsResourceV1`; `validateSettingsValues(resource: SettingsResourceV1, input: unknown, complete: boolean): Values`; `checkSettingsVersion(storedVersion: number, declaredVersion: number, storedDigest: string, declaredDigest: string): void`; `settingsValidationText(resource: SettingsResourceV1): string`; `canonicalBase64Length(text: string, allowEmpty?: boolean): number`; `PersistenceRequest = <M extends keyof PersistenceMaps>(method: M, params: PersistenceMaps[M]["params"], options: { timeoutMs: number; signal?: AbortSignal }) => Promise<PersistenceMaps[M]["result"]>`.

Precondition: F, including A's type-only barrel and `DefinitionMap`, is present. W1 authoring uses isolated modules. Do not modify `methods.ts`, `manifest.ts`, public SDK contexts, Python `_plugin.py`, package indexes, generated schema, or API version. T8/H-P installs the modules and shared error/resource variants at P170. The SDK constructor takes an already validating domain request channel; it never casts a new method into the current central `RequestMethod` union.

Negative-matrix coverage: B2 §10 rows “schema 未知欄位…”, “最大 chunk＋1…”, “clipboard 無權限／超量…”, plus C-Wire code/kind/reason pairing, submitted≠saved, and the 128/129, 64 KiB, 4 KiB, 8 MiB, 256 KiB boundaries assigned by skeleton §3B2-T1. Authorization, mutation races and host effects remain service tests in T3–T7; a schema test is not evidence of those effects.

- [ ] **Step 1: Add protocol boundary and compatibility tests**

Create `packages/plugin-protocol/src/settings.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { settingsRequestSchemas, settingsResourceV1Schema,
  validateSettingsValues, settingsValidationText, checkSettingsVersion } from "./settings.js";
import { jsonBytes, validateSettingsResource } from "./persistence-validation.js";
const field = (key = "a") => ({ key, label: { en: "A" }, type: "string" as const,
  default: "", minLength: 0, maxLength: 4000, maxBytes: 4096 });
const resource = (count = 1) => ({ schemaVersion: 1, title: { en: "Test" },
  fields: Array.from({ length: count }, (_, i) => field(`k${i}`)) });
const validate = (input: unknown) => validateSettingsResource(input, jsonBytes(input));
describe("settings v1", () => {
  it("accepts 128 fields and rejects 129, duplicates, dangerous segments and unknown keys", () => {
    expect(validate(resource(128)).fields).toHaveLength(128);
    expect(() => validate(resource(129))).toThrow();
    for (const key of ["constructor", "a.prototype", "a.__proto__", "A", "a..b", "a." ])
      expect(() => validate({ ...resource(), fields: [field(key)] })).toThrow();
    expect(validate({ ...resource(), fields: [field("device.a1")] }).fields[0]?.key).toBe("device.a1");
    expect(() => validate({ ...resource(), fields: [field(), field()] })).toThrow("duplicate-key");
    expect(settingsResourceV1Schema.safeParse({ ...resource(), extra: true }).success).toBe(false);
    expect(() => validateSettingsValues(resource(), [{ key: "unknown", value: true }], true)).toThrow("unknown-key");
  });
  it("measures original resource bytes and actual serialized values, including escaping", () => {
    expect(validateSettingsResource(resource(), 65536).fields).toHaveLength(1);
    expect(() => validateSettingsResource(resource(), 65537)).toThrow("size-limit");
    const r = resource(16);
    const values = r.fields.map(f => ({ key: f.key, value: "x".repeat(4000) }));
    const overhead = jsonBytes(values) - 64000;
    const exact = r.fields.map((f, i) => ({ key: f.key,
      value: i === 0 ? "\n".repeat(65536 - (64000 + overhead)) + "x".repeat(4000 - (65536 - (64000 + overhead))) : "x".repeat(4000) }));
    expect(jsonBytes(exact)).toBe(65536);
    expect(validateSettingsValues(r, exact, true)).toHaveLength(16);
    exact[1]!.value = "\n" + exact[1]!.value.slice(1);
    expect(() => validateSettingsValues(r, exact, true)).toThrow("size-limit");
    expect(() => validateSettingsValues(resource(), [{ key: "k0", value: "😀".repeat(1024) }], true)).not.toThrow();
    expect(() => validateSettingsValues(resource(), [{ key: "k0", value: "😀".repeat(1025) }], true)).toThrow();
    expect(() => validateSettingsValues(resource(), [{ key: "k0", value: "\ud800" }], true)).toThrow();
  });
  it("uses type-aware enums and validates defaults/ranges without coercion", () => {
    const e = { key: "choice", label: { en: "Choice" }, type: "enum", default: 1,
      options: [{ value: 1, label: { en: "Number" } }, { value: "1", label: { en: "String" } }] };
    expect(validate({ ...resource(), fields: [e] }).fields).toHaveLength(1);
    expect(() => validate({ ...resource(), fields: [{ ...e, options: [e.options[0], e.options[0]] }] })).toThrow();
    for (const value of [true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(() => validate({ ...resource(), fields: [{ ...e, default: value }] })).toThrow();
    expect(() => validate({ ...resource(), fields: [{ key: "n", label: { en: "N" }, type: "number", default: 2, minimum: 0, maximum: 1 }] })).toThrow();
    expect(() => validate({ ...resource(), fields: [{ ...field(), default: "a", maxLength: 0 }] })).toThrow();
    for (const schemaVersion of [true, 0, 2147483648, 1.5, NaN])
      expect(() => validate({ ...resource(), schemaVersion })).toThrow();
  });
  it("digest text ignores presentation/order but retains validation semantics", () => {
    const a = resource(2), b = { ...a, title: { en: "Translated" }, fields: [...a.fields].reverse().map(f => ({ ...f, label: { en: "Other" } })) };
    expect(settingsValidationText(a)).toBe(settingsValidationText(b));
    b.fields[0]!.maxBytes = 1;
    expect(settingsValidationText(a)).not.toBe(settingsValidationText(b));
    expect(() => checkSettingsVersion(2, 1, "a", "a")).toThrow("downgrade");
    expect(() => checkSettingsVersion(1, 2, "a", "b")).toThrow("migration-required");
    expect(() => checkSettingsVersion(1, 1, "a", "b")).toThrow("schema-changed-without-version");
    expect(() => checkSettingsVersion(1, 1, "a", "a")).not.toThrow();
  });
  it("loads committed vectors and rejects aliases", () => {
    const load = (name: string) => JSON.parse(readFileSync(new URL(`../test-fixtures/settings-storage-v1/${name}.json`, import.meta.url), "utf8"));
    for (const r of load("valid").cases.filter((c: {schema:string}) => c.schema === "settingsResourceV1").map((c: {input:unknown}) => c.input)) expect(() => validate(r)).not.toThrow();
    for (const r of load("invalid").cases.filter((c: {schema:string}) => c.schema === "settingsResourceV1").map((c: {input:unknown}) => c.input)) expect(() => validate(r)).toThrow();
    expect(Object.keys(settingsRequestSchemas)).toEqual(["settings/read", "settings/update", "settings/reset", "settings/watch", "settings/readMigration", "settings/migrate"]);
    expect("settings/unwatch" in settingsRequestSchemas).toBe(false);
    expect(settingsRequestSchemas["settings/update"].params.safeParse({ schemaVersion: 1, expectedRevision: null, changes: [], retry: true }).success).toBe(false);
  });
});
```

Create `packages/plugin-protocol/src/storage.test.ts`:

```ts
import { expect, it } from "vitest";
import { recordWriteSchema, storageRequestSchemas } from "./storage.js";
import { canonicalBase64Length } from "./persistence-validation.js";
const h = "00000000-0000-4000-8000-000000000001";
const write = { target: { mode: "create" }, kind: "lab.samples", schemaVersion: 1,
  label: "Samples", mediaType: "application/octet-stream", byteLength: 0, sha256: "0".repeat(64) };
it("accepts zero and 8 MiB and rejects coercion/unsafe/oversized lengths", () => {
  for (const byteLength of [0, 8388608]) expect(recordWriteSchema.safeParse({ ...write, byteLength }).success).toBe(true);
  for (const byteLength of [8388609, true, "0", NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])
    expect(recordWriteSchema.safeParse({ ...write, byteLength }).success).toBe(false);
});
it("checks base64 without allocating decoded bytes", () => {
  for (const data of ["Zh==", "Zg", "Zg===", "Zg==\n", "_w==", "Zm9=", ""]) expect(() => canonicalBase64Length(data)).toThrow();
  expect(canonicalBase64Length("Zg==")).toBe(1);
  expect(canonicalBase64Length("Zm8=")).toBe(2);
  expect(canonicalBase64Length("", true)).toBe(0);
  const max = Buffer.alloc(262144).toString("base64");
  expect(max.length).toBe(349528);
  expect(storageRequestSchemas["storage/writeChunk"].params.safeParse({ write: h, offset: 0, data: max }).success).toBe(true);
  expect(storageRequestSchemas["storage/writeChunk"].params.safeParse({ write: h, offset: 0, data: Buffer.alloc(262145).toString("base64") }).success).toBe(false);
});
it("does not confuse a drain submission with a host saved report", () => {
  const schema = storageRequestSchemas["storage/drain"].result;
  expect(schema.safeParse({ ok: true, value: { status: "submitted", writes: [h] } }).success).toBe(true);
  expect(schema.safeParse({ ok: true, value: { status: "saved", writes: [] } }).success).toBe(false);
  expect(schema.safeParse({ ok: true, value: { status: "submitted", writes: [h, h, h] } }).success).toBe(false);
});
```

Create `packages/plugin-protocol/src/persistence-actions.test.ts`:

```ts
import { expect, it } from "vitest";
import { persistenceActionRequestSchemas as schemas } from "./persistence-actions.js";
const actionRef = "00000000-0000-4000-8000-000000000001";
it("bounds plain clipboard text by both code points and UTF-8 bytes", () => {
  const parse = (text: string) => schemas["ui/copyText"].params.safeParse({ actionRef, text }).success;
  expect(parse("😀".repeat(16384))).toBe(true);
  expect(parse("😀".repeat(16385))).toBe(false);
  expect(parse("a".repeat(16385))).toBe(false);
  expect(parse("\0")).toBe(false);
  expect(parse("\udfff")).toBe(false);
  expect(schemas["ui/copyText"].params.safeParse({ actionRef, text: "x", html: "x" }).success).toBe(false);
});
it("keeps destination paths and fabricated cancellation out of results", () => {
  expect(schemas["storage/exportBegin"].result.safeParse({ ok: true, value: { export: actionRef, state: "waiting", expiresAt: 1, path: "/tmp/x" } }).success).toBe(false);
  expect(schemas["storage/exportCancel"].result.safeParse({ ok: true, value: { disposition: "cancelled" } }).success).toBe(false);
});
```

Create `packages/plugin-protocol/src/persistence-validation.test.ts`:

```ts
import { expect, it } from "vitest";
import { z } from "zod";
import { persistenceResultSchema, persistenceCodeReasons, jsonBytes } from "./persistence-validation.js";
it("has closed code/kind/reason pairs, distinct from numeric JSON-RPC errors", () => {
  const schema = persistenceResultSchema(z.strictObject({ done: z.literal(true) }));
  for (const [code, reasons] of Object.entries(persistenceCodeReasons)) {
    for (const reason of reasons) expect(schema.safeParse({ ok: false, error: { code, message: "Failed", detail: { kind: "persistence", reason } } }).success).toBe(true);
    expect(schema.safeParse({ ok: false, error: { code, message: "Failed", detail: { kind: "persistence", reason: "deadline" } } }).success).toBe(false);
  }
  for (const error of [
    { code: -32602, message: "shape" },
    { code: "PLUGIN_E_STORAGE_QUOTA", message: "x", detail: { kind: "persistence", reason: "disk-full" } },
    { code: "PLUGIN_E_PERMISSION_DENIED", message: "x", detail: { kind: "persistence", reason: "permission" } },
    { code: "PLUGIN_E_TIMEOUT", message: "x", detail: { kind: "persistence", reason: "cancelled" } },
  ]) expect(schema.safeParse({ ok: false, error }).success).toBe(false);
  expect(schema.safeParse({ ok: false, error: { code: "PLUGIN_E_TIMEOUT", message: "x" } }).success).toBe(true);
  expect(schema.safeParse({ ok: false, error: { code: "PLUGIN_E_STALE_RESOURCE", message: "x", detail: { kind: "resource", reason: "stale", resource: "storage-read" } } }).success).toBe(true);
  expect(jsonBytes("😀")).toBe(6);
});
```

Replace `packages/plugin-protocol/src/persistence-contract.test.ts` with:

```ts
import { expect, expectTypeOf, it } from "vitest";
import { requestMethods, notificationMethods } from "./methods.js";
import { settingsRequestSchemas, type SettingsRequestMap } from "./settings.js";
import { storageRequestSchemas, type StorageRequestMap, type DrainRequest } from "./storage.js";
import { persistenceActionRequestSchemas, type PersistenceActionRequestMap } from "./persistence-actions.js";
it("preserves F types and isolates the unpublished method maps", () => {
  expectTypeOf<SettingsRequestMap["settings/read"]["params"]>().toEqualTypeOf<{ schemaVersion: number }>();
  expectTypeOf<StorageRequestMap["storage/drain"]["params"]>().toEqualTypeOf<DrainRequest>();
  expectTypeOf<PersistenceActionRequestMap["ui/copyText"]["params"]>().toEqualTypeOf<{ actionRef: string; text: string }>();
  expect(Object.keys(settingsRequestSchemas)).toHaveLength(6);
  expect(Object.keys(storageRequestSchemas)).toHaveLength(17);
  expect(Object.keys(persistenceActionRequestSchemas)).toHaveLength(6);
  expect(Object.keys(requestMethods)).not.toContain("settings/unwatch");
  expect(Object.keys(notificationMethods)).not.toContain("settings.gap");
  // P170 may subsequently install these exact maps. Until that one batch, none is installed.
  const installed = Object.keys(requestMethods).filter(m => m.startsWith("settings/") || m.startsWith("storage/") || m === "ui/copyText");
  expect(installed.length === 0 || installed.length === 29).toBe(true);
});
```

- [ ] **Step 2: Run the protocol tests and observe the red result**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol exec vitest run src/settings.test.ts src/storage.test.ts src/persistence-actions.test.ts src/persistence-validation.test.ts src/persistence-contract.test.ts
```

Expected: FAIL because F provides declarations, not schema values or semantic validators. Keep the type assertions in the build/test input; a missing package install does not count as the expected failure.

- [ ] **Step 3: Replace the four protocol scaffolds with complete modules**

`packages/plugin-protocol/src/persistence-validation.ts`:

```ts
import { z } from "zod";
import type { Handle } from "./device-types.js";
import type { BusinessResult, PermissionErrorDetail, ResourceErrorDetailFor, ResourceKindV170 } from "./business-result.js";
import { settingsResourceV1Schema, validateSettingsValues } from "./settings.js";
import type { SettingsResourceV1 } from "./settings.js";
import { commonFailureSchemaFor } from "./business-result.js";
import type { PluginErrorCodeV170 } from "./errors.js";
import type { SettingsRevision, RecordRevision, Version, SettingKey } from "./settings.js";
export const persistenceCodeReasons = {
  PLUGIN_E_SETTINGS_SCHEMA: ["invalid-resource", "invalid-value", "duplicate-key", "unknown-key", "size-limit", "schema-changed-without-version", "migration-required", "downgrade", "unsupported-format", "corrupt"],
  PLUGIN_E_SETTINGS_CONFLICT: ["revision-mismatch"],
  PLUGIN_E_SETTINGS_SAVE: ["disk-full", "permission", "read-only", "io", "sync-failed", "publish-uncertain", "import-pending"],
  PLUGIN_E_STORAGE_QUOTA: ["record-count", "source-bytes", "host-bytes", "temporary-bytes"],
  PLUGIN_E_STORAGE_CONFLICT: ["revision-mismatch", "write-in-progress", "offset-mismatch", "sealed", "incomplete", "checksum-mismatch", "flush-incomplete", "export-not-ready"],
  PLUGIN_E_STORAGE_IO: ["not-found", "disk-full", "permission", "read-only", "io", "sync-failed", "publish-uncertain", "corrupt", "import-pending", "input-changed", "clipboard-unavailable", "destination-changed", "unsupported-filesystem"],
  PLUGIN_E_STORAGE_VERSION: ["unsupported-format", "schema-mismatch"],
} as const;
export type PersistenceReason = (typeof persistenceCodeReasons)[keyof typeof persistenceCodeReasons][number];
export type PersistenceDetail = {
  kind: "persistence"; reason: PersistenceReason;
  phase?: "validate" | "reserve" | "write" | "seal" | "publish" | "sync" | "recover";
  disposition?: "not-committed" | "committed" | "unknown";
  actualRevision?: SettingsRevision | RecordRevision; expectedVersion?: Version; actualVersion?: Version;
  limit?: number; requested?: number; retryable?: boolean;
  payload?: "complete-staging" | "checkpoint-only" | "none"; expiresAt?: number; commitId?: Handle; keys?: SettingKey[];
};
export type PersistenceFailureDetail = PermissionErrorDetail | ResourceErrorDetailFor<ResourceKindV170> | PersistenceDetail;
export type PersistenceResult<Value> = BusinessResult<Value, PersistenceFailureDetail, PluginErrorCodeV170>;
export const jsonBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;
export const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
export const safeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const versionSchema = z.number().int().min(1).max(2147483647);
export const handleSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const revisionSchema = z.string().regex(/^r_[0-9a-f]{32}$/);
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const keySchema = z.string().max(64).regex(/^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*$/)
  .refine(value => !value.split(".").some(k => ["__proto__", "prototype", "constructor"].includes(k)));
export const durabilitySchema = z.enum(["file-and-directory-sync", "file-sync-only"]);
export const receiptSchema = z.strictObject({ revision: revisionSchema, commitId: handleSchema, durability: durabilitySchema });
export const wellFormedText = (text: string): boolean => !text.includes("\0") && [...text].every(c => {
  const n = c.codePointAt(0)!; return n < 0xd800 || n > 0xdfff;
});
export function boundedText(min: number, max: number, bytes: number, singleLine = false) {
  return z.string().refine(s => wellFormedText(s) && [...s].length >= min && [...s].length <= max && utf8Bytes(s) <= bytes && (!singleLine || !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(s)));
}
const reasons = [...new Set(Object.values(persistenceCodeReasons).flat())] as [PersistenceReason, ...PersistenceReason[]];
export const persistenceDetailSchema = z.strictObject({
  kind: z.literal("persistence"), reason: z.enum(reasons),
  phase: z.enum(["validate", "reserve", "write", "seal", "publish", "sync", "recover"]).optional(),
  disposition: z.enum(["not-committed", "committed", "unknown"]).optional(),
  actualRevision: revisionSchema.optional(), expectedVersion: versionSchema.optional(), actualVersion: versionSchema.optional(),
  limit: safeIntegerSchema.optional(), requested: safeIntegerSchema.optional(), retryable: z.boolean().optional(),
  payload: z.enum(["complete-staging", "checkpoint-only", "none"]).optional(), expiresAt: safeIntegerSchema.optional(),
  commitId: handleSchema.optional(), keys: z.array(keySchema).max(16).optional(),
}).refine(d => jsonBytes(d) <= 2048);
// These schemas validate the existing A branches verbatim; their TS definitions stay A-owned.
// The extra resource literals are isolated 1.7 candidates until H-P publishes the corresponding batch.
const permissionDetail = z.strictObject({ kind: z.literal("permission"), reason: z.enum(["permission", "user-action-required"]) });
const resourceDetail = z.strictObject({ kind: z.literal("resource"), reason: z.enum(["stale", "quota", "rate", "queue"]),
  resource: z.enum(["operation", "subscription", "candidate", "reservation", "journal", "rpc", "ui-binding", "storage-write", "storage-read", "storage-list", "storage-export", "storage-watch"]), limit: safeIntegerSchema.optional() });
const message = boundedText(0, 2000, 8000);
const lifecycle = ["PLUGIN_E_TIMEOUT", "PLUGIN_E_CANCELLED", "PLUGIN_E_DISABLED", "PLUGIN_E_SAFE_MODE", "PLUGIN_E_SHUTTING_DOWN"] as const;
const persistenceCodes = ["PLUGIN_E_SETTINGS_SCHEMA", "PLUGIN_E_SETTINGS_SAVE", "PLUGIN_E_SETTINGS_CONFLICT", "PLUGIN_E_STORAGE_QUOTA", "PLUGIN_E_STORAGE_CONFLICT", "PLUGIN_E_STORAGE_IO", "PLUGIN_E_STORAGE_VERSION"] as const;
const code = z.enum(["PLUGIN_E_PERMISSION_DENIED", "PLUGIN_E_STALE_RESOURCE", "PLUGIN_E_RESOURCE_LIMIT", ...persistenceCodes, ...lifecycle]);
export const persistenceErrorSchema = z.strictObject({ code, message,
  detail: z.union([persistenceDetailSchema, permissionDetail, resourceDetail]).optional(),
}).superRefine((e, ctx) => {
  let valid = false;
  const d = e.detail;
  if (e.code in persistenceCodeReasons) valid = d === undefined || (d.kind === "persistence" &&
    (persistenceCodeReasons[e.code as keyof typeof persistenceCodeReasons] as readonly string[]).includes(d.reason));
  else if (e.code === "PLUGIN_E_PERMISSION_DENIED") valid = d === undefined || d.kind === "permission";
  else if (e.code === "PLUGIN_E_STALE_RESOURCE") valid = d === undefined || (d.kind === "resource" && d.reason === "stale");
  else if (e.code === "PLUGIN_E_RESOURCE_LIMIT") valid = d === undefined || (d.kind === "resource" && d.reason !== "stale");
  else valid = d === undefined;
  if (!valid || (d !== undefined && jsonBytes(d) > 2048)) ctx.addIssue({ code: "custom", message: "Invalid code/detail pair" });
});
export function persistenceResultSchema<S extends z.ZodType>(value: S) {
  return z.union([
    z.strictObject({ ok: z.literal(true), value }),
    commonFailureSchemaFor("1.7.0"),
    z.strictObject({ ok: z.literal(false), error: persistenceErrorSchema }),
  ]);
}
// H-P owns BusinessResult's defaulted third Code parameter and the V170 projections.
// This inferred schema compiles against PersistenceResult without asserting a published union.
const projectedCompileCheck: z.ZodType<PersistenceResult<string>> = persistenceResultSchema(z.string());
void projectedCompileCheck;
export function validateSettingsResource(input: unknown, rawBytes: number): SettingsResourceV1 {
  if (!Number.isSafeInteger(rawBytes) || rawBytes < 0 || rawBytes > 65536) throw new PersistenceValidationError("size-limit");
  const parsed = settingsResourceV1Schema.safeParse(input);
  if (!parsed.success) throw new PersistenceValidationError("invalid-resource");
  const resource = parsed.data as SettingsResourceV1;
  if (new Set(resource.fields.map(f => f.key)).size !== resource.fields.length) throw new PersistenceValidationError("duplicate-key");
  for (const f of resource.fields) {
    if ((f.type === "number" || f.type === "integer") && f.minimum > f.maximum) throw new PersistenceValidationError("invalid-resource");
    if (f.type === "string" && f.minLength > f.maxLength) throw new PersistenceValidationError("invalid-resource");
    if (f.type === "enum" && new Set(f.options.map(o => JSON.stringify([typeof o.value, o.value]))).size !== f.options.length) throw new PersistenceValidationError("duplicate-key");
  }
  validateSettingsValues(resource, resource.fields.map(f => ({ key: f.key, value: f.default })), true);
  return resource;
}
export function canonicalBase64Length(text: string, allowEmpty = false): number {
  if (text === "" && allowEmpty) return 0;
  if (text.length === 0 || text.length > 349528 || text.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new Error("invalid-base64");
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const last = alphabet.indexOf(text[text.length - padding - 1]!);
  if ((padding === 2 && (last & 15) !== 0) || (padding === 1 && (last & 3) !== 0)) throw new Error("invalid-base64-tail-bits");
  const bytes = text.length / 4 * 3 - padding;
  if (bytes > 262144) throw new Error("size-limit");
  return bytes;
}
export const chunkSchema = (allowEmpty = false) => z.string().refine(text => {
  try { canonicalBase64Length(text, allowEmpty); return true; } catch { return false; }
});
export class PersistenceValidationError extends Error {
  constructor(readonly reason: PersistenceReason) { super(reason); }
}
```

`packages/plugin-protocol/src/settings.ts`:

```ts
import { z } from "zod";
import type { Handle } from "./device-types.js";
import type { DefinitionMap } from "./business-result.js";
import { boundedText, jsonBytes, keySchema, versionSchema, revisionSchema, receiptSchema,
  handleSchema, persistenceResultSchema, PersistenceValidationError } from "./persistence-validation.js";
export type Version = number; // integer，1..2_147_483_647
export type SettingsRevision = string; // /^r_[0-9a-f]{32}$/，host 隨機產生，只能在 settings domain 比較相等
export type RecordRevision = string; // 同一格式；僅在同 source／record domain 比較相等
export type RecordId = string; // host 產生的 lowercase UUID v4，永不重用
// Handle／Counter type-only 匯入 3A 的共用型別，不在本案重新定義。
export type Sha256 = string; // /^[0-9a-f]{64}$/
export type SettingKey = string; // /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*$/，最多 64 bytes
export type Scalar = boolean | number | string;
export type Values = Array<{ key: SettingKey; value: Scalar }>;
export type Durability = "file-and-directory-sync" | "file-sync-only";
export type Receipt<R extends SettingsRevision | RecordRevision> = {
  revision: R;
  commitId: Handle;
  durability: Durability;
};

export type SettingsText = { en: string; "zh-TW"?: string };
export type CommonField = { key: SettingKey; label: SettingsText; help?: SettingsText };
export type SettingsField = CommonField &
  (
    | { type: "boolean"; default: boolean }
    | { type: "number"; default: number; minimum: number; maximum: number }
    | { type: "integer"; default: number; minimum: number; maximum: number }
    | { type: "string"; default: string; minLength: number; maxLength: number; maxBytes: number }
    | {
        type: "enum";
        default: string | number;
        options: Array<{ value: string | number; label: SettingsText }>;
      }
  );
export type SettingsResourceV1 = {
  schemaVersion: Version;
  title: SettingsText;
  fields: SettingsField[];
};

export type SettingsSnapshot = {
  schemaVersion: Version;
  revision: SettingsRevision | null; // null 只表示尚無 committed settings
  values: Values; // 完整 effective values，含 defaults，最多 64 KiB
};
export type SettingsMutation = { snapshot: SettingsSnapshot; receipt: Receipt<SettingsRevision> };

const title = z.strictObject({ en: boundedText(1, 200, 800, true), "zh-TW": boundedText(1, 200, 800, true).optional() });
const help = z.strictObject({ en: boundedText(0, 2000, 8192), "zh-TW": boundedText(0, 2000, 8192).optional() });
const common = { key: keySchema, label: title, help: help.optional() };
const scalar = z.union([z.boolean(), z.number(), boundedText(0, 4000, 4096)]);
const optionValue = z.union([z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), boundedText(0, 4000, 4096)]);
export const settingsFieldSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...common, type: z.literal("boolean"), default: z.boolean() }),
  z.strictObject({ ...common, type: z.literal("number"), default: z.number(), minimum: z.number(), maximum: z.number() }),
  z.strictObject({ ...common, type: z.literal("integer"), default: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), minimum: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), maximum: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER) }),
  z.strictObject({ ...common, type: z.literal("string"), default: boundedText(0, 4000, 4096), minLength: z.number().int().min(0).max(4000), maxLength: z.number().int().min(0).max(4000), maxBytes: z.number().int().min(1).max(4096) }),
  z.strictObject({ ...common, type: z.literal("enum"), default: optionValue, options: z.array(z.strictObject({ value: optionValue, label: title })).min(1).max(32) }),
]);
export const valuesSchema = z.array(z.strictObject({ key: keySchema, value: scalar })).max(128)
  .refine(v => new Set(v.map(x => x.key)).size === v.length && jsonBytes(v) <= 65536);
export const settingsResourceV1Schema: z.ZodType<SettingsResourceV1> = z.strictObject({ schemaVersion: versionSchema, title, fields: z.array(settingsFieldSchema).min(1).max(128) });
export const settingsSnapshotSchema = z.strictObject({ schemaVersion: versionSchema, revision: revisionSchema.nullable(), values: valuesSchema });
export const settingsMutationSchema = z.strictObject({ snapshot: settingsSnapshotSchema, receipt: receiptSchema });
export const settingsChangedSchema = z.strictObject({ revision: revisionSchema, schemaVersion: versionSchema,
  changedKeys: z.array(keySchema).max(128), cause: z.enum(["update", "reset", "migrate", "import"]) });
const failure = (reason: ConstructorParameters<typeof PersistenceValidationError>[0]): never => { throw new PersistenceValidationError(reason); };
export function validateSettingsValues(resource: SettingsResourceV1, input: unknown, complete: boolean): Values {
  if (jsonBytes(input) > 65536) return failure("size-limit");
  const parsed = valuesSchema.safeParse(input);
  if (!parsed.success) return failure("invalid-value");
  const values = parsed.data;
  const fields = new Map(resource.fields.map(f => [f.key, f]));
  if (complete && values.length !== fields.size) return failure("invalid-value");
  for (const { key, value } of values) {
    const f = fields.get(key);
    if (!f) return failure("unknown-key");
    switch (f.type) {
      case "boolean": if (typeof value !== "boolean") return failure("invalid-value"); break;
      case "number": case "integer":
        if (typeof value !== "number" || !Number.isFinite(value) || value < f.minimum || value > f.maximum || (f.type === "integer" && !Number.isSafeInteger(value))) return failure("invalid-value");
        break;
      case "string":
        if (typeof value !== "string" || !boundedText(f.minLength, f.maxLength, f.maxBytes).safeParse(value).success) return failure("invalid-value");
        break;
      case "enum": if (!f.options.some(o => typeof o.value === typeof value && o.value === value)) return failure("invalid-value"); break;
    }
  }
  return values;
}

export function settingsValidationText(resource: SettingsResourceV1): string {
  return JSON.stringify({ schemaVersion: resource.schemaVersion, fields: [...resource.fields].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map(f => {
    const base = { key: f.key, type: f.type, default: f.default };
    if (f.type === "number" || f.type === "integer") return { ...base, minimum: f.minimum, maximum: f.maximum };
    if (f.type === "string") return { ...base, minLength: f.minLength, maxLength: f.maxLength, maxBytes: f.maxBytes };
    if (f.type === "enum") return { ...base, options: f.options.map(o => [typeof o.value, o.value]).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0) };
    return base;
  }) });
}
export function checkSettingsVersion(storedVersion: number, declaredVersion: number, storedDigest: string, declaredDigest: string): void {
  if (storedVersion > declaredVersion) failure("downgrade");
  if (storedVersion < declaredVersion) failure("migration-required");
  if (storedDigest !== declaredDigest) failure("schema-changed-without-version");
}
const request = <P extends z.ZodType, V extends z.ZodType>(params: P, value: V) => ({ params, result: persistenceResultSchema(value) });
export const settingsRequestSchemas = {
  "settings/read": request(z.strictObject({ schemaVersion: versionSchema }), settingsSnapshotSchema),
  "settings/update": request(z.strictObject({ schemaVersion: versionSchema, expectedRevision: revisionSchema.nullable(), changes: valuesSchema.min(1) }), settingsMutationSchema),
  "settings/reset": request(z.strictObject({ schemaVersion: versionSchema, expectedRevision: revisionSchema.nullable(), keys: z.array(keySchema).min(1).max(128).refine(v => new Set(v).size === v.length) }), settingsMutationSchema),
  "settings/watch": request(z.strictObject({ schemaVersion: versionSchema }), z.strictObject({ subscriptionId: handleSchema, sequence: z.literal(0), snapshot: settingsSnapshotSchema })),
  "settings/readMigration": request(z.strictObject({}) as z.ZodType<Record<string, never>, Record<string, never>>, z.strictObject({ stored: settingsSnapshotSchema, declaredSchemaVersion: versionSchema })),
  "settings/migrate": request(z.strictObject({ fromSchemaVersion: versionSchema, schemaVersion: versionSchema, expectedRevision: revisionSchema, values: valuesSchema }), settingsMutationSchema),
};
export type SettingsRequestMap = DefinitionMap<typeof settingsRequestSchemas>;
```

`packages/plugin-protocol/src/storage.ts`:

```ts
import { z } from "zod";
import type { Handle, Counter, ReservationSnapshot } from "./device-types.js";
import type { DefinitionMap } from "./business-result.js";
import type { RecordId, RecordRevision, Version, Sha256, Receipt } from "./settings.js";
import type { PersistenceFailureDetail } from "./persistence-validation.js";
import { boundedText, safeIntegerSchema as n, versionSchema as v, handleSchema as h, revisionSchema as r,
  sha256Schema, receiptSchema, durabilitySchema, chunkSchema, jsonBytes, persistenceResultSchema, persistenceErrorSchema } from "./persistence-validation.js";
export type RecordMeta = {
  id: RecordId;
  revision: RecordRevision;
  kind: string; // /^[a-z][a-z0-9.-]{0,63}$/，source-local filter
  schemaVersion: Version;
  label: string;
  mediaType: "application/json" | "text/plain" | "text/csv" | "application/octet-stream";
  byteLength: number;
  sha256: Sha256;
  createdAt: number; // host UTC epoch milliseconds
  updatedAt: number;
  checkpoint: "none" | "open" | "final";
  interrupted: boolean; // host recovery evidence，不改寫 opaque payload
};
export type RecordTarget =
  { mode: "create" } | { mode: "replace"; id: RecordId; expectedRevision: RecordRevision };
export type RecordWrite = {
  target: RecordTarget;
  kind: string;
  schemaVersion: Version;
  label: string;
  mediaType: RecordMeta["mediaType"];
  byteLength: number; // 0..8 MiB
  sha256: Sha256;
  checkpoint?: { handle: Handle; phase: "checkpoint" | "final" };
  drainToken?: Handle;
};
export type WriteProgress = {
  write: Handle;
  id: RecordId;
  state: "receiving" | "sealed" | "publishing" | "committed" | "aborted" | "expired" | "failed";
  receivedBytes: number;
  expiresAt: number;
  receipt?: Receipt<RecordRevision>;
  error?: { code: string; message: string; detail?: PersistenceFailureDetail };
};
export type DrainReason =
  | "disable"
  | "reload"
  | "remove"
  | "renderer-crash"
  | "window-destroyed"
  | "shutdown"
  | "update"
  | "safe-mode"
  | "reservation-ended";
export type DrainRequest = {
  token: Handle;
  reason: DrainReason;
  remainingMs: number; // 0..10_000；host monotonic deadline 才是權威
  checkpoints: Array<{
    checkpoint: Handle;
    record: RecordMeta;
    reservationEnd?: {
      reservationId: Handle;
      reason: Exclude<ReservationSnapshot["reason"], "active">;
      lastSequence: Counter;
    };
  }>;
  writes: Array<{ write: Handle; id: RecordId; state: "receiving" | "sealed" }>;
};

export const mediaTypeSchema = z.enum(["application/json", "text/plain", "text/csv", "application/octet-stream"]);
export const kindSchema = z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/);
const label = boundedText(0, 160, 640, true);
const metadata = { kind: kindSchema, schemaVersion: v, label, mediaType: mediaTypeSchema, byteLength: n.max(8388608), sha256: sha256Schema };
export const recordMetaSchema = z.strictObject({ id: h, revision: r, ...metadata, createdAt: n, updatedAt: n,
  checkpoint: z.enum(["none", "open", "final"]), interrupted: z.boolean() }).refine(m => jsonBytes(m) <= 2048);
export const recordWriteSchema = z.strictObject({ target: z.discriminatedUnion("mode", [z.strictObject({ mode: z.literal("create") }), z.strictObject({ mode: z.literal("replace"), id: h, expectedRevision: r })]),
  ...metadata, checkpoint: z.strictObject({ handle: h, phase: z.enum(["checkpoint", "final"]) }).optional(), drainToken: h.optional() });
export const writeProgressSchema = z.strictObject({ write: h, id: h, state: z.enum(["receiving", "sealed", "publishing", "committed", "aborted", "expired", "failed"]), receivedBytes: n.max(8388608), expiresAt: n, receipt: receiptSchema.optional(), error: persistenceErrorSchema.optional() });
export const drainRequestSchema = z.strictObject({ token: h,
  reason: z.enum(["disable", "reload", "remove", "renderer-crash", "window-destroyed", "shutdown", "update", "safe-mode", "reservation-ended"]), remainingMs: n.max(10000),
  checkpoints: z.array(z.strictObject({ checkpoint: h, record: recordMetaSchema,
    reservationEnd: z.strictObject({ reservationId: h, reason: z.enum(["released", "source-changed", "disconnected", "suspended", "core-disconnect", "retired", "renderer-lost", "limit", "overflow"]), lastSequence: n }).optional() })).max(2),
  writes: z.array(z.strictObject({ write: h, id: h, state: z.enum(["receiving", "sealed"]) })).max(2),
}) as z.ZodType<DrainRequest, DrainRequest>;
const request = <P extends z.ZodType, V extends z.ZodType>(params: P, value: V) => ({ params, result: persistenceResultSchema(value) });
const empty = z.strictObject({}) as z.ZodType<Record<string, never>, Record<string, never>>;
export const storageRequestSchemas = {
  "storage/beginWrite": request(recordWriteSchema, z.strictObject({ write: h, id: h, expiresAt: n })),
  "storage/writeChunk": request(z.strictObject({ write: h, offset: n, data: chunkSchema() }), z.strictObject({ receivedBytes: n.max(8388608), expiresAt: n })),
  "storage/sealWrite": request(z.strictObject({ write: h }), writeProgressSchema),
  "storage/commitWrite": request(z.strictObject({ write: h, drainToken: h.optional() }), z.strictObject({ record: recordMetaSchema, receipt: receiptSchema })),
  "storage/writeStatus": request(z.strictObject({ write: h }), writeProgressSchema),
  "storage/abortWrite": request(z.strictObject({ write: h }), z.strictObject({ disposition: z.enum(["aborted", "committed", "unknown"]), receipt: receiptSchema.optional() })),
  "storage/stat": request(z.strictObject({ id: h }), z.strictObject({ record: recordMetaSchema })),
  "storage/list": request(z.strictObject({ kind: kindSchema.optional(), limit: n.min(1).max(64), cursor: h.optional() }), z.strictObject({ entries: z.array(recordMetaSchema).max(64), nextCursor: h.optional() }).refine(value => jsonBytes({ ok: true, value }) <= 262144)),
  "storage/openRead": request(z.strictObject({ id: h, expectedRevision: r, schemaVersion: v }), z.strictObject({ read: h, record: recordMetaSchema, expiresAt: n })),
  "storage/readChunk": request(z.strictObject({ read: h, offset: n, maxBytes: n.min(1).max(262144) }), z.strictObject({ offset: n, data: chunkSchema(true), nextOffset: n, eof: z.boolean() })),
  "storage/closeRead": request(z.strictObject({ read: h }), empty),
  "storage/delete": request(z.strictObject({ id: h, expectedRevision: r }), z.strictObject({ deleted: z.literal(true), receipt: receiptSchema })),
  "storage/flush": request(empty, z.strictObject({ barrier: h, durability: durabilitySchema })),
  "storage/quota": request(empty, z.strictObject({ recordCount: n, reservedCreates: n, committedBytes: n, reservedBytes: n, pinnedBytes: n, temporaryBytes: n,
    sourceLimitBytes: z.literal(536870912), sourceLimitRecords: z.literal(256), hostAvailableBytes: n, writeSlotsAvailable: n, exportSlotsAvailable: n })),
  "storage/registerCheckpoint": request(z.strictObject({ id: h, expectedRevision: r, reservation: h.optional() }), z.strictObject({ checkpoint: h })),
  "storage/abandonCheckpoint": request(z.strictObject({ checkpoint: h }), z.strictObject({ record: recordMetaSchema })),
  "storage/drain": request(drainRequestSchema, z.strictObject({ status: z.enum(["submitted", "checkpoint-only"]), writes: z.array(h).max(2) })),
};
export type StorageRequestMap = DefinitionMap<typeof storageRequestSchemas>;
```

`packages/plugin-protocol/src/persistence-actions.ts`:

```ts
import { z } from "zod";
import type { DefinitionMap } from "./business-result.js";
import { mediaTypeSchema } from "./storage.js";
import { boundedText, safeIntegerSchema as n, handleSchema as h, sha256Schema, durabilitySchema, chunkSchema,
  persistenceResultSchema, persistenceErrorSchema } from "./persistence-validation.js";
const request = <P extends z.ZodType, V extends z.ZodType>(params: P, value: V) => ({ params, result: persistenceResultSchema(value) });
export const persistenceActionRequestSchemas = {
  "storage/exportBegin": request(z.strictObject({ actionRef: h, suggestedName: boundedText(1, 80, 320, true).refine(s => !/[\\/:]/.test(s) && s !== "." && s !== ".." && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)), mediaType: mediaTypeSchema, byteLength: n.max(8388608), sha256: sha256Schema }), z.strictObject({ export: h, state: z.literal("waiting"), expiresAt: n })),
  "storage/exportChunk": request(z.strictObject({ export: h, offset: n, data: chunkSchema() }), z.strictObject({ receivedBytes: n.max(8388608), expiresAt: n })),
  "storage/exportCommit": request(z.strictObject({ export: h }), z.strictObject({ exported: z.literal(true), commitId: h, durability: durabilitySchema })),
  "storage/exportStatus": request(z.strictObject({ export: h }), z.strictObject({ state: z.enum(["waiting", "receiving", "publishing", "completed", "cancelled", "expired", "failed"]), receivedBytes: n.max(8388608), expiresAt: n, commitId: h.optional(), durability: durabilitySchema.optional(), error: persistenceErrorSchema.optional() })),
  "storage/exportCancel": request(z.strictObject({ export: h }), z.strictObject({ disposition: z.enum(["aborted", "committed", "unknown"]), commitId: h.optional() })),
  "ui/copyText": request(z.strictObject({ actionRef: h, text: boundedText(0, 16384, 65536) }), z.strictObject({ copied: z.literal(true) })),
};
export type PersistenceActionRequestMap = DefinitionMap<typeof persistenceActionRequestSchemas>;
```

- [ ] **Step 4: Install shared vectors and rerun the protocol suite**

Replace `packages/plugin-protocol/test-fixtures/settings-storage-v1/valid.json`:

```json
{
  "formatVersion": 1,
  "family": "settings-storage-v1",
  "cases": [
    {
      "id": "resource-0",
      "schema": "settingsResourceV1",
      "phase": "resource",
      "input": {
        "schemaVersion": 1,
        "title": {
          "en": "Boolean"
        },
        "fields": [
          {
            "key": "device.enabled",
            "label": {
              "en": "Enabled"
            },
            "type": "boolean",
            "default": true
          }
        ]
      },
      "valid": true,
      "expected": {
        "numericCode": null,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "resource-1",
      "schema": "settingsResourceV1",
      "phase": "resource",
      "input": {
        "schemaVersion": 1,
        "title": {
          "en": "Mixed enum"
        },
        "fields": [
          {
            "key": "mode",
            "label": {
              "en": "Mode"
            },
            "type": "enum",
            "default": 1,
            "options": [
              {
                "value": 1,
                "label": {
                  "en": "Number"
                }
              },
              {
                "value": "1",
                "label": {
                  "en": "String"
                }
              }
            ]
          }
        ]
      },
      "valid": true,
      "expected": {
        "numericCode": null,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "chunk-0",
      "schema": "chunk",
      "phase": "params",
      "input": {
        "text": "Zg==",
        "bytes": 1
      },
      "valid": true,
      "expected": {
        "numericCode": null,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "chunk-1",
      "schema": "chunk",
      "phase": "params",
      "input": {
        "text": "Zm8=",
        "bytes": 2
      },
      "valid": true,
      "expected": {
        "numericCode": null,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "chunk-2",
      "schema": "chunk",
      "phase": "params",
      "input": {
        "text": "Zm9v",
        "bytes": 3
      },
      "valid": true,
      "expected": {
        "numericCode": null,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "version-0",
      "schema": "settings/read",
      "phase": "params",
      "input": {
        "schemaVersion": 1
      },
      "valid": true,
      "expected": {
        "numericCode": null,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "version-1",
      "schema": "settings/read",
      "phase": "params",
      "input": {
        "schemaVersion": 2147483647
      },
      "valid": true,
      "expected": {
        "numericCode": null,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    }
  ]
}
```

Replace `packages/plugin-protocol/test-fixtures/settings-storage-v1/invalid.json`:

```json
{
  "formatVersion": 1,
  "family": "settings-storage-v1",
  "cases": [
    {
      "id": "resource-0",
      "schema": "settingsResourceV1",
      "phase": "resource",
      "input": {
        "schemaVersion": true,
        "title": {
          "en": "Bad"
        },
        "fields": [
          {
            "key": "a",
            "label": {
              "en": "A"
            },
            "type": "boolean",
            "default": true
          }
        ]
      },
      "valid": false,
      "expected": {
        "numericCode": null,
        "businessCode": "PLUGIN_E_SETTINGS_SCHEMA",
        "reason": "invalid-resource",
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "resource-1",
      "schema": "settingsResourceV1",
      "phase": "resource",
      "input": {
        "schemaVersion": 1,
        "title": {
          "en": "Bad"
        },
        "fields": [
          {
            "key": "a.constructor",
            "label": {
              "en": "A"
            },
            "type": "boolean",
            "default": true
          }
        ]
      },
      "valid": false,
      "expected": {
        "numericCode": null,
        "businessCode": "PLUGIN_E_SETTINGS_SCHEMA",
        "reason": "invalid-resource",
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "resource-2",
      "schema": "settingsResourceV1",
      "phase": "resource",
      "input": {
        "schemaVersion": 1,
        "title": {
          "en": "Bad"
        },
        "fields": [
          {
            "key": "a",
            "label": {
              "en": "A"
            },
            "type": "number",
            "minimum": 2,
            "maximum": 1,
            "default": 1
          }
        ]
      },
      "valid": false,
      "expected": {
        "numericCode": null,
        "businessCode": "PLUGIN_E_SETTINGS_SCHEMA",
        "reason": "invalid-resource",
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "resource-3",
      "schema": "settingsResourceV1",
      "phase": "resource",
      "input": {
        "schemaVersion": 1,
        "title": {
          "en": "Bad"
        },
        "fields": [
          {
            "key": "a",
            "label": {
              "en": "A"
            },
            "type": "boolean",
            "default": true,
            "unknown": 1
          }
        ]
      },
      "valid": false,
      "expected": {
        "numericCode": null,
        "businessCode": "PLUGIN_E_SETTINGS_SCHEMA",
        "reason": "invalid-resource",
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "chunk-0",
      "schema": "chunk",
      "phase": "params",
      "input": "Zh==",
      "valid": false,
      "expected": {
        "numericCode": -32602,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "chunk-1",
      "schema": "chunk",
      "phase": "params",
      "input": "Zg",
      "valid": false,
      "expected": {
        "numericCode": -32602,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "chunk-2",
      "schema": "chunk",
      "phase": "params",
      "input": "Zg===",
      "valid": false,
      "expected": {
        "numericCode": -32602,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "chunk-3",
      "schema": "chunk",
      "phase": "params",
      "input": "Zg==\n",
      "valid": false,
      "expected": {
        "numericCode": -32602,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "chunk-4",
      "schema": "chunk",
      "phase": "params",
      "input": "_w==",
      "valid": false,
      "expected": {
        "numericCode": -32602,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "chunk-5",
      "schema": "chunk",
      "phase": "params",
      "input": "Zm9=",
      "valid": false,
      "expected": {
        "numericCode": -32602,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "version-0",
      "schema": "settings/read",
      "phase": "params",
      "input": {
        "schemaVersion": true
      },
      "valid": false,
      "expected": {
        "numericCode": -32602,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "version-1",
      "schema": "settings/read",
      "phase": "params",
      "input": {
        "schemaVersion": 0
      },
      "valid": false,
      "expected": {
        "numericCode": -32602,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "version-2",
      "schema": "settings/read",
      "phase": "params",
      "input": {
        "schemaVersion": -1
      },
      "valid": false,
      "expected": {
        "numericCode": -32602,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "version-3",
      "schema": "settings/read",
      "phase": "params",
      "input": {
        "schemaVersion": 1.5
      },
      "valid": false,
      "expected": {
        "numericCode": -32602,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "version-4",
      "schema": "settings/read",
      "phase": "params",
      "input": {
        "schemaVersion": 2147483648
      },
      "valid": false,
      "expected": {
        "numericCode": -32602,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    }
  ]
}
```

Retain the strict `maximum.json` cases from T0 Step 4. Add chunk/string/serialized-JSON maximum and +1 cases by writing their actual bounded JSON inputs in the same format; no recipes, inputIndex indirection or extra root keys. The existing byte-boundary unit tests remain mandatory. The measurement manifest stays outside these files and carries no measured results.

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol exec vitest run src/settings.test.ts src/storage.test.ts src/persistence-actions.test.ts src/persistence-validation.test.ts src/persistence-contract.test.ts
```

Expected: PASS for the isolated maps and all negative vectors. H-P still owns the generated schema and the publication compatibility gate; do not run `schema` here and accidentally publish a partial batch.

Expand `maximum.json` with actual serialized inputs using this deterministic command. It preserves the strict outer object and existing cases; output contains no expansion recipes.

```bash
python3 - <<'PYMAX'
import base64,json,pathlib
p=pathlib.Path("packages/plugin-protocol/test-fixtures/settings-storage-v1/maximum.json")
f=json.loads(p.read_text())
added=[]
def case(id,schema,phase,value,valid):
    added.append(dict(id=id,schema=schema,phase=phase,input=value,valid=valid,expected=dict(numericCode=None if valid or phase=="resource" else -32602,businessCode="PLUGIN_E_SETTINGS_SCHEMA" if not valid and phase=="resource" else None,reason="invalid-resource" if not valid and phase=="resource" else None,permission=None,lifetime=None,persistedSha256=None)))
for n in (262144,262145):case(f"chunk-bytes-{n}","chunk","params",base64.b64encode(bytes(n)).decode(),n==262144)
for n in (4096,4097):
    resource={"schemaVersion":1,"title":{"en":"String"},"fields":[{"key":"text","label":{"en":"Text"},"type":"string","default":"😀"*1024+"x"*(n-4096),"minLength":0,"maxLength":4000,"maxBytes":4096}]}
    case(f"string-bytes-{n}","settingsResourceV1","resource",resource,n==4096)
f["cases"]=[c for c in f["cases"] if c["id"] not in {x["id"] for x in added}]+added
p.write_text(json.dumps(f,ensure_ascii=False,separators=(",",":"))+"\n")
PYMAX
```

Append to `packages/plugin-protocol/src/persistence-contract.test.ts` (reuse its existing schema-map imports):

```ts
import { readFileSync } from "node:fs";
import { z } from "zod";
import { settingsResourceV1Schema } from "./settings.js";
import { chunkSchema, validateSettingsResource, jsonBytes } from "./persistence-validation.js";
const fixtureCase = z.strictObject({id:z.string(),schema:z.string(),phase:z.enum(["params","result","resource","event"]),
  input:z.unknown(),valid:z.boolean(),expected:z.strictObject({numericCode:z.number().nullable(),businessCode:z.string().nullable(),
    reason:z.string().nullable(),permission:z.string().nullable(),lifetime:z.string().nullable(),persistedSha256:z.string().regex(/^[0-9a-f]{64}$/).nullable()})});
const fixtureFile = z.strictObject({formatVersion:z.literal(1),family:z.literal("settings-storage-v1"),cases:z.array(fixtureCase)});
const schemas = {...settingsRequestSchemas,...storageRequestSchemas,...persistenceActionRequestSchemas};
for (const name of ["valid","invalid","maximum"]) it(`strict shared ${name} cases`, () => {
  const file = fixtureFile.parse(JSON.parse(readFileSync(new URL(`../test-fixtures/settings-storage-v1/${name}.json`,import.meta.url),"utf8")));
  for (const c of file.cases) {
    let success: boolean;
    if (c.schema === "settingsResourceV1" && c.phase === "resource") {
      try { validateSettingsResource(c.input,jsonBytes(c.input)); success=true; } catch { success=false; }
    } else if (c.schema === "chunk" && c.phase === "params") success=chunkSchema().safeParse(c.input).success;
    else {
      if (!Object.hasOwn(schemas,c.schema) || (c.phase !== "params" && c.phase !== "result")) throw new Error("unknown-fixture-schema");
      const schema=schemas[c.schema as keyof typeof schemas]; success=schema[c.phase].safeParse(c.input).success;
    }
    expect(success,c.id).toBe(c.valid);
    if (c.valid) expect([c.expected.numericCode,c.expected.businessCode,c.expected.reason]).toEqual([null,null,null]);
  }
  expect(fixtureFile.safeParse({...file,resources:[]}).success).toBe(false);
});
```

Run the same T1 protocol command above; expect PASS and rejection of any extra fixture root/case/expected field. H-P feeds these exact cases into exported JSON Schema and JS/Python conformance at P170; no schema-only test claims a persisted hash or lifecycle result.

- [ ] **Step 5: Add JS client tests for cancellation, errors and no automatic retry**

Create `packages/plugin-sdk-js/src/settings.test.ts`:

```ts
import { expect, it } from "vitest";
import { createSettingsClient, type PersistenceRequest } from "./settings.js";
it("forwards one update with its original revision and preserves business errors", async () => {
  const calls: unknown[] = [], signal = new AbortController().signal;
  const result = { ok: false, error: { code: "PLUGIN_E_SETTINGS_CONFLICT", message: "Conflict", detail: { kind: "persistence", reason: "revision-mismatch" } } };
  const request = (async (...args: unknown[]) => { calls.push(args); return result; }) as PersistenceRequest;
  const client = createSettingsClient(request);
  const params = { schemaVersion: 1, expectedRevision: null, changes: [{ key: "a", value: true }] };
  expect(await client.update(params, signal)).toBe(result);
  expect(calls).toEqual([["settings/update", params, { timeoutMs: 10000, signal }]]);
  expect("unwatch" in client).toBe(false);
});
it("leaves numeric transport errors untouched and never retries a mutation", async () => {
  let count = 0;
  const error = Object.assign(new Error("shape"), { code: -32602 });
  const request = (async () => { count++; throw error; }) as PersistenceRequest;
  await expect(createSettingsClient(request).reset({ schemaVersion: 1, expectedRevision: null, keys: ["a"] })).rejects.toBe(error);
  expect(count).toBe(1);
});
```

Create `packages/plugin-sdk-js/src/storage.test.ts`:

```ts
import { expect, it } from "vitest";
import { createStorageClient, acceptDrainSubmission } from "./storage.js";
import type { PersistenceRequest } from "./settings.js";
it("never begins a replacement to hide a lost commit acknowledgement", async () => {
  const methods: string[] = [];
  const request = (async (m: string) => { methods.push(m); throw new Error("timeout"); }) as PersistenceRequest;
  await expect(createStorageClient(request).commitWrite({ write: "00000000-0000-4000-8000-000000000001" })).rejects.toThrow("timeout");
  expect(methods).toEqual(["storage/commitWrite"]);
});
it("drain result carries submitted/checkpoint-only, never saved", () => {
  expect(acceptDrainSubmission({ status: "submitted", writes: [] })).toEqual({ status: "submitted", writes: [] });
  expect(() => acceptDrainSubmission({ status: "saved", writes: [] })).toThrow();
  expect(() => acceptDrainSubmission({ status: "submitted", writes: [], receipt: "fake" })).toThrow();
});
```

Create `packages/plugin-sdk-js/src/persistence-actions.test.ts`:

```ts
import { expect, it } from "vitest";
import { createPersistenceActionsClient } from "./persistence-actions.js";
import type { PersistenceRequest } from "./settings.js";
it("does not replay user actions on a lost reply", async () => {
  let count = 0;
  const request = (async () => { count++; throw new Error("lost reply"); }) as PersistenceRequest;
  await expect(createPersistenceActionsClient(request).copyText({ actionRef: "00000000-0000-4000-8000-000000000001", text: "private" })).rejects.toThrow("lost reply");
  expect(count).toBe(1);
});
```

- [ ] **Step 6: Run the new JS client tests; expect missing modules**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-sdk exec vitest run src/settings.test.ts src/storage.test.ts src/persistence-actions.test.ts
```

Expected: FAIL with the three client modules absent.

- [ ] **Step 7: Add complete low-level JS modules**

`packages/plugin-sdk-js/src/settings.ts`:

```ts
import type { SettingsRequestMap, StorageRequestMap, PersistenceActionRequestMap } from "@kobrixa/plugin-protocol";
export type PersistenceMaps = SettingsRequestMap & StorageRequestMap & PersistenceActionRequestMap;
export type PersistenceClientFor<K extends keyof PersistenceMaps> = {
  [M in K as M extends `${string}/${infer Name}` ? Name : never]:
    (params: PersistenceMaps[M]["params"], signal?: AbortSignal) => Promise<PersistenceMaps[M]["result"]>
};
export type PersistenceRequest = <M extends keyof PersistenceMaps>(method: M, params: PersistenceMaps[M]["params"], options: { timeoutMs: number; signal?: AbortSignal }) => Promise<PersistenceMaps[M]["result"]>;
export function persistenceCall<M extends keyof PersistenceMaps>(request: PersistenceRequest, method: M) {
  return (params: PersistenceMaps[M]["params"], signal?: AbortSignal): Promise<PersistenceMaps[M]["result"]> =>
    request(method, params, { timeoutMs: 10000, ...(signal === undefined ? {} : { signal }) });
}
export function createSettingsClient(request: PersistenceRequest): PersistenceClientFor<keyof SettingsRequestMap> {
  return Object.freeze({
    read: persistenceCall(request, "settings/read"), update: persistenceCall(request, "settings/update"),
    reset: persistenceCall(request, "settings/reset"), watch: persistenceCall(request, "settings/watch"),
    readMigration: persistenceCall(request, "settings/readMigration"), migrate: persistenceCall(request, "settings/migrate"),
  });
}
```

`packages/plugin-sdk-js/src/storage.ts`:

```ts
import type { Handle, StorageRequestMap } from "@kobrixa/plugin-protocol";
import { persistenceCall, type PersistenceRequest, type PersistenceClientFor } from "./settings.js";
export function createStorageClient(request: PersistenceRequest): PersistenceClientFor<keyof StorageRequestMap> {
  return Object.freeze({
    beginWrite: persistenceCall(request, "storage/beginWrite"), writeChunk: persistenceCall(request, "storage/writeChunk"),
    sealWrite: persistenceCall(request, "storage/sealWrite"), commitWrite: persistenceCall(request, "storage/commitWrite"),
    writeStatus: persistenceCall(request, "storage/writeStatus"), abortWrite: persistenceCall(request, "storage/abortWrite"),
    stat: persistenceCall(request, "storage/stat"), list: persistenceCall(request, "storage/list"),
    openRead: persistenceCall(request, "storage/openRead"), readChunk: persistenceCall(request, "storage/readChunk"),
    closeRead: persistenceCall(request, "storage/closeRead"), delete: persistenceCall(request, "storage/delete"),
    flush: persistenceCall(request, "storage/flush"), quota: persistenceCall(request, "storage/quota"),
    drain: persistenceCall(request, "storage/drain"),
    registerCheckpoint: persistenceCall(request, "storage/registerCheckpoint"), abandonCheckpoint: persistenceCall(request, "storage/abandonCheckpoint"),
  });
}
export function acceptDrainSubmission(input: unknown): { status: "submitted" | "checkpoint-only"; writes: Handle[] } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new TypeError("Invalid drain submission");
  const v = input as Record<string, unknown>;
  if (Object.keys(v).length !== 2 || (v.status !== "submitted" && v.status !== "checkpoint-only") || !Array.isArray(v.writes) || v.writes.length > 2 ||
    !v.writes.every(h => typeof h === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(h))) throw new TypeError("Invalid drain submission");
  return { status: v.status, writes: [...v.writes] as Handle[] };
}
```

`packages/plugin-sdk-js/src/persistence-actions.ts`:

```ts
import type { PersistenceActionRequestMap } from "@kobrixa/plugin-protocol";
import { persistenceCall, type PersistenceRequest, type PersistenceClientFor } from "./settings.js";
export function createPersistenceActionsClient(request: PersistenceRequest): PersistenceClientFor<keyof PersistenceActionRequestMap> {
  return Object.freeze({
    exportBegin: persistenceCall(request, "storage/exportBegin"), exportChunk: persistenceCall(request, "storage/exportChunk"),
    exportCommit: persistenceCall(request, "storage/exportCommit"), exportStatus: persistenceCall(request, "storage/exportStatus"),
    exportCancel: persistenceCall(request, "storage/exportCancel"), copyText: persistenceCall(request, "ui/copyText"),
  });
}
```

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-sdk build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-sdk exec vitest run src/settings.test.ts src/storage.test.ts src/persistence-actions.test.ts
```

Expected: PASS. Wire validation is performed by the supplied request channel, before/after sending. H-P's T8 adapter must use these domain maps plus the generated schema and semantic validators; the public context is still unchanged at this task boundary.

- [ ] **Step 8: Add Python parity and transport tests**

Create `sdks/python/tests/test_settings.py`:

```python
import json
import pathlib
import unittest
from kobrixa._settings import Settings, validate_resource, validate_values, check_version, wire_bytes
ROOT = pathlib.Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "packages/plugin-protocol/test-fixtures/settings-storage-v1"

class SettingsValidationTests(unittest.TestCase):
    def test_shared_resources(self):
        for case in json.loads((FIXTURES / "valid.json").read_text())["cases"]:
            if case["schema"] != "settingsResourceV1": continue
            resource = case["input"]
            self.assertEqual(validate_resource(resource, wire_bytes(resource)), resource)
        for case in json.loads((FIXTURES / "invalid.json").read_text())["cases"]:
            if case["schema"] != "settingsResourceV1": continue
            resource = case["input"]
            with self.assertRaises(ValueError):
                validate_resource(resource, wire_bytes(resource))

    def test_bytes_scalars_and_versions(self):
        field = {"key": "a.b", "label": {"en": "A"}, "type": "string", "default": "", "minLength": 0, "maxLength": 4000, "maxBytes": 4096}
        resource = {"schemaVersion": 1, "title": {"en": "T"}, "fields": [field]}
        validate_resource(resource, 65536)
        with self.assertRaises(ValueError): validate_resource(resource, 65537)
        validate_values(resource, [{"key": "a.b", "value": "😀" * 1024}], True)
        for value in ["😀" * 1025, "\ud800", True, float("nan")]:
            with self.assertRaises(ValueError): validate_values(resource, [{"key": "a.b", "value": value}], True)
        for count in [128, 129]:
            many = dict(resource, fields=[dict(field, key="a" + str(i)) for i in range(count)])
            if count == 128: validate_resource(many, wire_bytes(many))
            else:
                with self.assertRaises(ValueError): validate_resource(many, wire_bytes(many))
        for stored, declared, old, new in [(2, 1, "a", "a"), (1, 2, "a", "a"), (1, 1, "a", "b")]:
            with self.assertRaises(ValueError): check_version(stored, declared, old, new)
        self.assertEqual(wire_bytes("😀"), 6)
        self.assertEqual(wire_bytes("\n"), 4)

class SettingsClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_business_result_is_not_exception_or_retry(self):
        calls = []
        error = {"ok": False, "error": {"code": "PLUGIN_E_SETTINGS_CONFLICT", "message": "Conflict"}}
        async def request(method, params):
            calls.append((method, params))
            return error
        def validate(method, side, value):
            self.assertEqual(method, "settings/update")
            self.assertIn(side, ("params", "result"))
        client = Settings(request, validate)
        params = {"schemaVersion": 1, "expectedRevision": None, "changes": [{"key": "a", "value": True}]}
        self.assertIs(await client.update(params), error)
        self.assertEqual(calls, [("settings/update", params)])
        self.assertFalse(hasattr(client, "unwatch"))
```

Create `sdks/python/tests/test_storage.py`:

```python
import base64
import unittest
from kobrixa._storage import Storage, canonical_base64_length, validate_record_write, drain_submission

class StorageValidationTests(unittest.TestCase):
    def test_chunk_and_record_boundaries(self):
        for text in ["Zh==", "Zg", "Zg===", "Zg==\n", "_w==", "Zm9=", ""]:
            with self.assertRaises(ValueError): canonical_base64_length(text)
        self.assertEqual(canonical_base64_length("Zg=="), 1)
        self.assertEqual(canonical_base64_length("", True), 0)
        self.assertEqual(canonical_base64_length(base64.b64encode(bytes(262144)).decode()), 262144)
        with self.assertRaises(ValueError): canonical_base64_length(base64.b64encode(bytes(262145)).decode())
        base = {"target": {"mode": "create"}, "kind": "lab.samples", "schemaVersion": 1, "label": "Lab", "mediaType": "application/octet-stream", "byteLength": 0, "sha256": "0" * 64}
        for n in [0, 8388608]: validate_record_write(dict(base, byteLength=n))
        for n in [8388609, True, "0", float("nan"), float("inf"), -1, 0.5, 9007199254740992]:
            with self.assertRaises(ValueError): validate_record_write(dict(base, byteLength=n))
        with self.assertRaises(ValueError): drain_submission({"status": "saved", "writes": []})
        self.assertEqual(drain_submission({"status": "submitted", "writes": []})["status"], "submitted")

class StorageClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_lost_commit_is_not_replayed(self):
        calls = []
        async def request(method, params):
            calls.append(method)
            raise TimeoutError("lost reply")
        client = Storage(request, lambda *args: None)
        with self.assertRaises(TimeoutError): await client.commit_write({"write": "00000000-0000-4000-8000-000000000001"})
        self.assertEqual(calls, ["storage/commitWrite"])
```

Create `sdks/python/tests/test_persistence_actions.py`:

```python
import unittest
from kobrixa._persistence_actions import PersistenceActions, validate_copy

class ActionTests(unittest.IsolatedAsyncioTestCase):
    async def test_plain_text_and_no_replay(self):
        h = "00000000-0000-4000-8000-000000000001"
        validate_copy({"actionRef": h, "text": "😀" * 16384})
        for text in ["😀" * 16385, "a" * 16385, "\0", "\udfff"]:
            with self.assertRaises(ValueError): validate_copy({"actionRef": h, "text": text})
        count = 0
        async def request(method, params):
            nonlocal count
            count += 1
            raise TimeoutError("lost reply")
        with self.assertRaises(TimeoutError): await PersistenceActions(request, lambda *args: None).copy_text({"actionRef": h, "text": "x"})
        self.assertEqual(count, 1)
```

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm test:python-sdk
```

Expected: FAIL importing the three new modules. A runner SKIP because Python is missing remains unrun, never a passing test.

- [ ] **Step 9: Add Python clients and matching semantic validators**

`sdks/python/kobrixa/_settings.py`:

```python
from typing import Any, Awaitable, Callable
PersistenceRequest = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]
"""Isolated 1.7 helpers. _plugin.py attaches them only in the P170 batch."""
import asyncio
import json
import math
import re

MAX_SAFE = 9007199254740991
HANDLE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")
REVISION = re.compile(r"r_[0-9a-f]{32}\Z")

def wire_bytes(value):
    # Match the protocol's UTF-8 JSON byte budget, not Python ensure_ascii=True's wire spelling.
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"))

def integer(value, low=0, high=MAX_SAFE):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or int(value) != value or not low <= value <= high:
        raise ValueError("invalid-integer")
    return value

def text(value, low, high, byte_limit, single=False):
    if not isinstance(value, str) or "\0" in value or any(0xd800 <= ord(c) <= 0xdfff for c in value):
        raise ValueError("invalid-text")
    if not low <= len(value) <= high or len(value.encode("utf-8")) > byte_limit or (single and any(ord(c) < 32 or ord(c) == 127 or c in "\u2028\u2029" for c in value)):
        raise ValueError("size-limit")
    return value

def obj(value, required, optional=()):
    if not isinstance(value, dict) or not set(required) <= set(value) or set(value) - set(required) - set(optional):
        raise ValueError("invalid-object")
    return value

def key(value):
    if not isinstance(value, str) or len(value) > 64 or not re.fullmatch(r"[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*", value) or any(k in ("constructor", "prototype", "__proto__") for k in value.split(".")):
        raise ValueError("invalid-key")
    return value

def localized(value, help_text=False):
    obj(value, ["en"], ["zh-TW"])
    for v in value.values(): text(v, 0 if help_text else 1, 2000 if help_text else 200, 8192 if help_text else 800, not help_text)

def number(value, safe=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value): raise ValueError("invalid-number")
    if safe: integer(value, -MAX_SAFE, MAX_SAFE)

def enum_token(value):
    if isinstance(value, str): text(value, 0, 4000, 4096); return ("string", value)
    number(value, True)
    return ("number", value)

def validate_values(resource, values, complete):
    if wire_bytes(values) > 65536: raise ValueError("size-limit")
    if not isinstance(values, list) or len(values) > 128: raise ValueError("invalid-value")
    fields = {f["key"]: f for f in resource["fields"]}
    seen = set()
    for entry in values:
        obj(entry, ["key", "value"])
        k, v = key(entry["key"]), entry["value"]
        if k in seen: raise ValueError("duplicate-key")
        seen.add(k)
        if k not in fields: raise ValueError("unknown-key")
        f = fields[k]
        if f["type"] == "boolean":
            if not isinstance(v, bool): raise ValueError("invalid-value")
        elif f["type"] in ("number", "integer"):
            number(v, f["type"] == "integer")
            if not f["minimum"] <= v <= f["maximum"]: raise ValueError("invalid-value")
        elif f["type"] == "string": text(v, f["minLength"], f["maxLength"], f["maxBytes"])
        elif enum_token(v) not in [enum_token(o["value"]) for o in f["options"]]: raise ValueError("invalid-value")
    if complete and seen != set(fields): raise ValueError("invalid-value")
    return values

def validate_resource(resource, raw_bytes):
    integer(raw_bytes, 0, 65536)
    obj(resource, ["schemaVersion", "title", "fields"])
    integer(resource["schemaVersion"], 1, 2147483647)
    localized(resource["title"])
    if not isinstance(resource["fields"], list) or not 1 <= len(resource["fields"]) <= 128: raise ValueError("invalid-resource")
    seen = set()
    for f in resource["fields"]:
        if not isinstance(f, dict): raise ValueError("invalid-field")
        kind = f.get("type")
        extras = {"boolean": [], "number": ["minimum", "maximum"], "integer": ["minimum", "maximum"], "string": ["minLength", "maxLength", "maxBytes"], "enum": ["options"]}
        if kind not in extras: raise ValueError("invalid-type")
        obj(f, ["key", "label", "type", "default"] + extras[kind], ["help"])
        k = key(f["key"])
        if k in seen: raise ValueError("duplicate-key")
        seen.add(k)
        localized(f["label"])
        if "help" in f: localized(f["help"], True)
        if kind in ("number", "integer"):
            number(f["minimum"], kind == "integer"); number(f["maximum"], kind == "integer")
            if f["minimum"] > f["maximum"]: raise ValueError("invalid-range")
        if kind == "string":
            integer(f["minLength"], 0, 4000); integer(f["maxLength"], 0, 4000); integer(f["maxBytes"], 1, 4096)
            if f["minLength"] > f["maxLength"]: raise ValueError("invalid-range")
        if kind == "enum":
            if not isinstance(f["options"], list) or not 1 <= len(f["options"]) <= 32: raise ValueError("invalid-options")
            tokens = []
            for option in f["options"]:
                obj(option, ["value", "label"]); localized(option["label"]); tokens.append(enum_token(option["value"]))
            if len(set(tokens)) != len(tokens): raise ValueError("duplicate-key")
    validate_values(resource, [{"key": f["key"], "value": f["default"]} for f in resource["fields"]], True)
    return resource

def check_version(stored, declared, old_digest, new_digest):
    integer(stored, 1, 2147483647); integer(declared, 1, 2147483647)
    if stored > declared: raise ValueError("downgrade")
    if stored < declared: raise ValueError("migration-required")
    if old_digest != new_digest: raise ValueError("schema-changed-without-version")

class PersistenceClient:
    def __init__(self, request, validate=None):
        from ._schema import Validator
        validator = Validator.bundled()
        self._request = request
        self._validate = validate or (lambda method, phase, value: validator.validate(f"{method}.{phase}", value))

    async def _call(self, method, params):
        # P170 injects generated structural + shared semantic validation here.
        self._validate(method, "params", params)
        result = await asyncio.wait_for(self._request(method, params), timeout=10.0)
        self._validate(method, "result", result)
        return result

class Settings(PersistenceClient):
    async def read(self, params): return await self._call("settings/read", params)
    async def update(self, params): return await self._call("settings/update", params)
    async def reset(self, params): return await self._call("settings/reset", params)
    async def watch(self, params): return await self._call("settings/watch", params)
    async def read_migration(self, params): return await self._call("settings/readMigration", params)
    async def migrate(self, params): return await self._call("settings/migrate", params)

def create_settings_client(request: PersistenceRequest) -> Settings:
    return Settings(request)

```

`sdks/python/kobrixa/_storage.py`:

```python
import re
from ._settings import PersistenceRequest, PersistenceClient, integer, text, obj, HANDLE, REVISION

MEDIA_TYPES = ("application/json", "text/plain", "text/csv", "application/octet-stream")

def canonical_base64_length(value, allow_empty=False):
    if value == "" and allow_empty: return 0
    if not isinstance(value, str) or not value or len(value) > 349528 or len(value) % 4 or not re.fullmatch(r"(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?", value): raise ValueError("invalid-base64")
    padding = 2 if value.endswith("==") else 1 if value.endswith("=") else 0
    last = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".index(value[-padding - 1])
    if (padding == 2 and last & 15) or (padding == 1 and last & 3): raise ValueError("invalid-tail-bits")
    size = len(value) // 4 * 3 - padding
    integer(size, 1, 262144)
    return size

def handle(value):
    if not isinstance(value, str) or not HANDLE.fullmatch(value): raise ValueError("invalid-handle")

def validate_record_write(value):
    obj(value, ["target", "kind", "schemaVersion", "label", "mediaType", "byteLength", "sha256"], ["checkpoint", "drainToken"])
    target = value["target"]
    if not isinstance(target, dict): raise ValueError("invalid-target")
    if target.get("mode") == "create": obj(target, ["mode"])
    else:
        obj(target, ["mode", "id", "expectedRevision"])
        if target["mode"] != "replace": raise ValueError("invalid-target")
        handle(target["id"])
        if not isinstance(target["expectedRevision"], str) or not REVISION.fullmatch(target["expectedRevision"]): raise ValueError("invalid-revision")
    if not isinstance(value["kind"], str) or not re.fullmatch(r"[a-z][a-z0-9.-]{0,63}", value["kind"]): raise ValueError("invalid-kind")
    integer(value["schemaVersion"], 1, 2147483647); integer(value["byteLength"], 0, 8388608)
    text(value["label"], 0, 160, 640, True)
    if value["mediaType"] not in MEDIA_TYPES or not isinstance(value["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", value["sha256"]): raise ValueError("invalid-metadata")
    if "drainToken" in value: handle(value["drainToken"])
    if "checkpoint" in value:
        obj(value["checkpoint"], ["handle", "phase"]); handle(value["checkpoint"]["handle"])
        if value["checkpoint"]["phase"] not in ("checkpoint", "final"): raise ValueError("invalid-checkpoint")
    return value

def drain_submission(value):
    obj(value, ["status", "writes"])
    if value["status"] not in ("submitted", "checkpoint-only") or not isinstance(value["writes"], list) or len(value["writes"]) > 2: raise ValueError("invalid-drain")
    for h in value["writes"]: handle(h)
    return {"status": value["status"], "writes": list(value["writes"])}

class Storage(PersistenceClient):
    async def begin_write(self, p): validate_record_write(p); return await self._call("storage/beginWrite", p)
    async def write_chunk(self, p): canonical_base64_length(p["data"]); return await self._call("storage/writeChunk", p)
    async def seal_write(self, p): return await self._call("storage/sealWrite", p)
    async def commit_write(self, p): return await self._call("storage/commitWrite", p)
    async def write_status(self, p): return await self._call("storage/writeStatus", p)
    async def abort_write(self, p): return await self._call("storage/abortWrite", p)
    async def stat(self, p): return await self._call("storage/stat", p)
    async def list(self, p): return await self._call("storage/list", p)
    async def open_read(self, p): return await self._call("storage/openRead", p)
    async def read_chunk(self, p): return await self._call("storage/readChunk", p)
    async def close_read(self, p): return await self._call("storage/closeRead", p)
    async def delete(self, p): return await self._call("storage/delete", p)
    async def flush(self, p): return await self._call("storage/flush", p)
    async def quota(self, p): return await self._call("storage/quota", p)
    async def register_checkpoint(self, p): return await self._call("storage/registerCheckpoint", p)
    async def abandon_checkpoint(self, p): return await self._call("storage/abandonCheckpoint", p)
    async def drain(self, p): return await self._call("storage/drain", p)

def create_storage_client(request: PersistenceRequest) -> Storage:
    return Storage(request)

```

`sdks/python/kobrixa/_persistence_actions.py`:

```python
import re
from ._settings import PersistenceRequest, PersistenceClient, obj, text, integer
from ._storage import handle, canonical_base64_length, MEDIA_TYPES

def validate_copy(value):
    obj(value, ["actionRef", "text"]); handle(value["actionRef"]); text(value["text"], 0, 16384, 65536)
    return value

def validate_export(value):
    obj(value, ["actionRef", "suggestedName", "mediaType", "byteLength", "sha256"])
    handle(value["actionRef"]); text(value["suggestedName"], 1, 80, 320, True); integer(value["byteLength"], 0, 8388608)
    name = value["suggestedName"]
    if re.search(r"[\\/:]", name) or name in (".", "..") or re.match(r"(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", name): raise ValueError("invalid-name")
    if value["mediaType"] not in MEDIA_TYPES or not isinstance(value["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", value["sha256"]): raise ValueError("invalid-metadata")
    return value

class PersistenceActions(PersistenceClient):
    async def export_begin(self, p): validate_export(p); return await self._call("storage/exportBegin", p)
    async def export_chunk(self, p): canonical_base64_length(p["data"]); return await self._call("storage/exportChunk", p)
    async def export_commit(self, p): return await self._call("storage/exportCommit", p)
    async def export_status(self, p): return await self._call("storage/exportStatus", p)
    async def export_cancel(self, p): return await self._call("storage/exportCancel", p)
    async def copy_text(self, p): validate_copy(p); return await self._call("ui/copyText", p)

def create_persistence_actions_client(request: PersistenceRequest) -> PersistenceActions:
    return PersistenceActions(request)

```

- [ ] **Step 10: Verify isolated clients and hand off the modules without publishing**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-sdk build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol test
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-sdk test
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm test:python-sdk
```

Expected: PASS on the task branch, including existing initialize/legacy command tests. Do not claim Python validation of the published P170 schema yet. T8 consumes the new semantic helpers, adds generated-schema parity (including code/reason pairing) and registers all 29 methods together. The task receipt records the actual commands and exit codes; it leaves the actual 1.7 wire registry, generated schema and renderer effect tests pending their owners.

- [ ] **Step 11: Commit only this task's write set**

Controller runs outside sandbox after review; the plan writer does not execute this commit:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git add packages/plugin-protocol/src/settings.ts packages/plugin-protocol/src/settings.test.ts packages/plugin-protocol/src/storage.ts packages/plugin-protocol/src/storage.test.ts packages/plugin-protocol/src/persistence-actions.ts packages/plugin-protocol/src/persistence-actions.test.ts packages/plugin-protocol/src/persistence-validation.ts packages/plugin-protocol/src/persistence-validation.test.ts packages/plugin-protocol/src/persistence-contract.test.ts packages/plugin-sdk-js/src/settings.ts packages/plugin-sdk-js/src/settings.test.ts packages/plugin-sdk-js/src/storage.ts packages/plugin-sdk-js/src/storage.test.ts packages/plugin-sdk-js/src/persistence-actions.ts packages/plugin-sdk-js/src/persistence-actions.test.ts sdks/python/kobrixa/_settings.py sdks/python/kobrixa/_storage.py sdks/python/kobrixa/_persistence_actions.py sdks/python/tests/test_settings.py sdks/python/tests/test_storage.py sdks/python/tests/test_persistence_actions.py packages/plugin-protocol/test-fixtures/settings-storage-v1/valid.json packages/plugin-protocol/test-fixtures/settings-storage-v1/invalid.json packages/plugin-protocol/test-fixtures/settings-storage-v1/maximum.json
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git diff --cached --check
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git commit -m "feat(plugins): add isolated settings and storage protocol clients"
```

### Task 3B2-T2: Build the bounded persistence worker and recoverable publication engine

**Files**

- Modify: `apps/desktop/src/main/plugins/persistence/filesystem.ts`
- Create: `apps/desktop/src/main/plugins/persistence/filesystem.test.ts`
- Modify: `apps/desktop/src/main/plugins/persistence/engine-port.ts`
- Create: `apps/desktop/src/main/plugins/persistence/engine-port.test.ts`
- Create: `apps/desktop/src/main/plugins/persistence/namespace.ts`
- Create: `apps/desktop/src/main/plugins/persistence/namespace.test.ts`
- Create: `apps/desktop/src/main/plugins/persistence/atomic-store.ts`
- Create: `apps/desktop/src/main/plugins/persistence/atomic-store.test.ts`
- Create: `apps/desktop/src/main/plugins/persistence/quota.ts`
- Create: `apps/desktop/src/main/plugins/persistence/quota.test.ts`
- Create: `apps/desktop/src/main/plugins/persistence/recovery-scan.ts`
- Create: `apps/desktop/src/main/plugins/persistence/recovery-scan.test.ts`
- Create: `apps/desktop/src/main/plugins/persistence/worker.ts`
- Create: `apps/desktop/src/main/plugins/persistence/worker.test.ts`
- Modify: `apps/desktop/src/main/plugins/persistence/contract.test.ts`
- Test: `apps/desktop/src/main/plugins/persistence/filesystem.test.ts`
- Test: `apps/desktop/src/main/plugins/persistence/engine-port.test.ts`
- Test: `apps/desktop/src/main/plugins/persistence/namespace.test.ts`
- Test: `apps/desktop/src/main/plugins/persistence/atomic-store.test.ts`
- Test: `apps/desktop/src/main/plugins/persistence/quota.test.ts`
- Test: `apps/desktop/src/main/plugins/persistence/recovery-scan.test.ts`
- Test: `apps/desktop/src/main/plugins/persistence/worker.test.ts`
- Test: `apps/desktop/src/main/plugins/persistence/contract.test.ts`

**Interfaces**

- Consumes: `ProfileWriterLock { readonly hostEpoch: Handle; assertHeld(): void }`; exact C-B2 `PersistenceFsPort`, `PublicationTicket`, `PersistenceEnginePort`, `PersistenceReadPort`, and I-B2 receipt/revision types. No second lock is created.
- Produces: the unchanged C-B2 ports, implemented by `AtomicStore` in the worker and the main `startPersistenceWorker` facade. `createNodePersistenceFs(userData: string, profile: ProfileWriterLock, options?: FsOptions): Promise<NodePersistenceFs>` constructs the scoped filesystem in the worker.
- Produces `openStoreRoot` (filesystem.ts), `startPersistenceWorker` and `runPersistenceWorker` (worker.ts), and the explicit `PersistenceBackend` with engine/reads/evidence/imports/output/destinations/sources (engine-port.ts). AM-23–29 declarations above are the sole host contracts; no filesystem association or callback-supplied storage implementation.

Precondition: F only. Tests supply canonical owner objects and a fake held profile capability; they do not acquire Electron's lock. T1 can run concurrently: this engine imports protocol/runtime **types only**, and does not depend on new value exports. H-K supplies the actual compiled `worker.ts` URL and H-D constructs the worker only after the primary has acquired the existing lock. T9 receives these helpers as an explicit handoff; package/build/config edits stay outside T2.

Negative-matrix coverage: B2 §10 filesystem aliases, disk/sync/rename/short-write failures, quota races, cancellation before/after dispatch, retained pins, corrupt/unknown disk formats and staging expiry. **B2-RF1** is pinned by the paused-rename and lost-reply cases. **B2-RF5** is pinned by import-tag reconciliation and the streamed 50-record quota case; installed import journal/marker/resume, real RSS and concurrent safety-stop latency remain the T6/T7/X-T1 gates. No mock timing measurement closes those gates.

- [ ] **Step 1: Write filesystem and quota tests before implementation**

Create `apps/desktop/src/main/plugins/persistence/filesystem.test.ts`:

```ts
import { mkdtemp, rm, symlink, link, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createNodePersistenceFs, writeAll, classifyFsError, type StorePath } from "./filesystem.js";
const roots: string[] = [];
const profile = { hostEpoch: "00000000-0000-4000-8000-000000000001", assertHeld() {} };
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "persistence-fs-")); roots.push(root);
  return { root, fs: await createNodePersistenceFs(root, profile) };
}
it("initializes no persistence files when the original profile capability is not held", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "secondary-")); roots.push(root);
  await expect(createNodePersistenceFs(root, { hostEpoch: profile.hostEpoch, assertHeld() { throw new Error("not-primary"); } })).rejects.toThrow("not-primary");
  await expect(lstat(path.join(root, "plugins"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("rejects fabricated paths, symlinks, hardlinks and traversal", async () => {
  const { root, fs } = await setup();
  await expect(fs.open({} as StorePath, "read")).rejects.toThrow("unsafe-path");
  expect(() => fs.path("..")).toThrow("unsafe-path");
  const outside = path.join(root, "outside"); await writeFile(outside, "unchanged");
  await symlink(outside, path.join(fs.root, "alias"));
  await expect(fs.open(fs.path("alias"), "read")).rejects.toThrow("unsafe-path");
  await link(outside, path.join(fs.root, "hard"));
  await expect(fs.open(fs.path("hard"), "read")).rejects.toThrow("unsafe-path");
});
it("loops short writes, rejects zero progress and never unlinks before replace", async () => {
  const { fs } = await setup(), p = fs.path("x");
  const fd = await fs.open(p, "create-exclusive"), original = fs.write.bind(fs);
  fs.write = (f, offset, bytes) => original(f, offset, bytes.subarray(0, 2));
  await writeAll(fs, fd, 0, new Uint8Array([1, 2, 3, 4, 5])); await fs.sync(fd); await fs.close(fd);
  const read = await fs.open(p, "read"); expect([...await fs.read(read, 0, 10)]).toEqual([1, 2, 3, 4, 5]); await fs.close(read);
  fs.write = async () => 0;
  await expect(writeAll(fs, {} as never, 0, new Uint8Array([1]))).rejects.toThrow("io");
  expect(classifyFsError({ code: "EXDEV" })).toBe("unsupported-filesystem");
  expect(classifyFsError({ code: "ENOSPC" })).toBe("disk-full");
  expect(classifyFsError({ code: "EDQUOT" })).toBe("disk-full");
  expect(classifyFsError({ code: "EACCES" })).toBe("permission");
  expect(classifyFsError({ code: "EROFS" })).toBe("read-only");
});
it("directory-sync policy distinguishes explicit unsupported from EIO", async () => {
  const { fs } = await setup();
  expect(fs.durability).toBe(process.platform === "win32" ? "file-sync-only" : "file-and-directory-sync");
  fs.directorySync = async () => { throw Object.assign(new Error("disk"), { code: "EIO" }); };
  if (fs.durability === "file-and-directory-sync") await expect(fs.syncDirectory(fs.path())).rejects.toMatchObject({ code: "EIO" });
});
```

Create `apps/desktop/src/main/plugins/persistence/quota.test.ts`:

```ts
import { expect, it } from "vitest";
import { QuotaLedger, WorkQueue } from "./quota.js";
const GiB = 1073741824, MiB = 1048576;
it("reserves full payload atomically and keeps old+new during replacement", () => {
  const q = new QuotaLedger(); q.restore("s", { committed: 504 * MiB, records: 63, metadata: 0, temporary: 0 });
  q.reserve("a", "s", { bytes: 8 * MiB, create: true, metadata: 0, lane: "write" }, GiB * 4);
  expect(() => q.reserve("b", "s", { bytes: 1, create: false, metadata: 0, lane: "write" }, GiB * 4)).toThrow("source-bytes");
  expect(q.snapshot("s").reservedBytes).toBe(8 * MiB);
  q.release("a");
  q.restore("t", { committed: 512 * MiB, records: 64, metadata: 0, temporary: 0 });
  expect(() => q.reserve("c", "s", { bytes: 8 * MiB + 1, create: false, metadata: 0, lane: "write" }, GiB * 4)).toThrow();
});
it("enforces count, host, scratch, metadata, slots and physical headroom", () => {
  const full = new QuotaLedger(); full.restore("s", { committed: 0, records: 256, metadata: 0, temporary: 0 });
  expect(() => full.reserve("a", "s", { bytes: 0, create: true, metadata: 0, lane: "write" }, GiB)).toThrow("record-count");
  const q = new QuotaLedger(); q.restore("a", { committed: 512 * MiB, records: 64, metadata: 0, temporary: 0 });
  q.restore("b", { committed: 512 * MiB, records: 64, metadata: 0, temporary: 0 });
  expect(() => q.reserve("x", "c", { bytes: 1, create: true, metadata: 0, lane: "write" }, GiB * 4)).toThrow("host-bytes");
  const p = new QuotaLedger();
  p.holdTemporary("s", "old", 32 * MiB);
  p.holdTemporary("s", "old", 32 * MiB); // references, not duplicate byte charges
  expect(p.snapshot("s").temporaryBytes).toBe(32 * MiB);
  expect(() => p.holdTemporary("s", "other", 1)).toThrow("temporary-bytes");
  for (const source of ["a", "b", "c"]) p.holdTemporary(source, source, 32 * MiB);
  expect(() => p.holdTemporary("d", "d", 1)).toThrow("temporary-bytes");
  expect(() => p.reserve("m", "m", { bytes: 0, create: false, metadata: 4 * MiB + 1, lane: "metadata" }, GiB)).toThrow("metadata-limit");
  const disk = new QuotaLedger();
  expect(() => disk.reserve("d", "d", { bytes: 1, create: false, metadata: 0, lane: "write" }, 16 * MiB)).toThrow("disk-full");
  for (let i = 0; i < 16; i++) disk.reserve(`w${i}`, `s${Math.floor(i / 2)}`, { bytes: 1, create: true, metadata: 0, lane: "write" }, GiB);
  expect(() => disk.reserve("w16", "new", { bytes: 1, create: true, metadata: 0, lane: "write" }, GiB)).toThrow("queue");
});
it("limits work before invoking decoder and caps active I/O jobs at four", async () => {
  const q = new WorkQueue(() => 0), releases: Array<() => void> = [];
  let decoded = 0, active = 0, peak = 0;
  const jobs = Array.from({ length: 32 }, (_, i) => q.run(`s${i}`, 262144, 10000, async () => {
    decoded++; active++; peak = Math.max(peak, active);
    await new Promise<void>(resolve => releases.push(resolve)); active--; return i;
  }));
  await expect(q.run("extra", 1, 10000, async () => { decoded++; })).rejects.toThrow("queue");
  expect(decoded).toBe(4); expect(peak).toBe(4);
  while (q.pending) { releases.splice(0).forEach(release => release()); await new Promise(resolve => setTimeout(resolve, 0)); }
  expect(await Promise.all(jobs)).toHaveLength(32);
  const one = new WorkQueue(() => 0);
  await expect(one.run("s", 1048577, 10000, async () => {})).rejects.toThrow("queue");
});
```

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/persistence/filesystem.test.ts src/main/plugins/persistence/quota.test.ts
```

Expected: FAIL for missing executable filesystem/queue/ledger classes.

- [ ] **Step 2: Implement the scoped filesystem and serialized quota ledger**

Keep the complete T0 `StorePath`, `StoreFd`, `PersistenceFaultPoint`, `PersistenceFsPort` declarations at the start of `filesystem.ts`. Replace its type-only Durability import with the imports below and append the full implementation. The unique-symbol declarations remain ambient brands; namespace.ts alone mints StorePath capabilities; filesystem.ts holds descriptor and root capabilities.

```ts
import { createStorePath,storePathName } from "./namespace.js";
import { constants } from "node:fs";
import { open, mkdir, lstat, realpath, rename, unlink, rmdir, statfs, opendir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Durability } from "@kobrixa/plugin-protocol";
import type { ProfileWriterLock } from "@kobrixa/plugin-runtime";
export type FsOptions = { now?: () => number; fault?: (point: PersistenceFaultPoint, edge: "before" | "after") => Promise<void>; directorySyncSupported?: boolean };
export function classifyFsError(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (code === "ENOSPC" || code === "EDQUOT") return "disk-full";
  if (code === "EACCES" || code === "EPERM") return "permission";
  if (code === "EROFS") return "read-only";
  if (code === "EXDEV" || code === "ENOTSUP") return "unsupported-filesystem";
  return "io";
}
export async function writeAll(fs: PersistenceFsPort, fd: StoreFd, offset: number, bytes: Uint8Array): Promise<void> {
  let done = 0;
  while (done < bytes.byteLength) {
    const written = await fs.write(fd, offset + done, bytes.subarray(done));
    if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.byteLength - done) throw new Error("io");
    done += written;
  }
}
export class NodePersistenceFs implements PersistenceFsPort {
  readonly durability: Durability;
  private readonly descriptors = new WeakMap<StoreFd, FileHandle>();
  constructor(readonly root: string, readonly profile: ProfileWriterLock, private readonly options: FsOptions = {}) {
    // The Windows adapter policy is explicit. A Linux/macOS EIO never silently downgrades it.
    this.durability = (options.directorySyncSupported ?? process.platform !== "win32") ? "file-and-directory-sync" : "file-sync-only";
  }
  now(): number { return this.options.now?.() ?? performance.now(); }
  path(...parts: string[]): StorePath {return createStorePath(this,parts);}
  name(p:StorePath):string {return storePathName(this,p);}
  async check(p: StorePath, missingLeaf = false): Promise<void> {
    this.profile.assertHeld();
    const name = this.name(p), relative = path.relative(this.root, name);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("unsafe-path");
    const parts = relative ? relative.split(path.sep) : [];
    for (let i = 0; i <= parts.length; i++) {
      const current = path.join(this.root, ...parts.slice(0, i));
      let st;
      try { st = await lstat(current); }
      catch (e) { if (missingLeaf && i === parts.length && (e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
      if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile()) || (st.isFile() && st.nlink !== 1) || (i < parts.length && !st.isDirectory()) || await realpath(current) !== current) throw new Error("unsafe-path");
    }
  }
  async open(p: StorePath, mode: "read" | "create-exclusive"): Promise<StoreFd> {
    await this.check(p, mode === "create-exclusive");
    const name = this.name(p), nofollow = constants.O_NOFOLLOW ?? 0;
    const fd = await open(name, (mode === "read" ? constants.O_RDONLY : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL) | nofollow, 0o600);
    try {
      const a = await fd.stat(), b = await lstat(name);
      if (!a.isFile() || a.nlink !== 1 || a.dev !== b.dev || a.ino !== b.ino || b.isSymbolicLink()) throw new Error("unsafe-path");
      await this.check(p);
      const token = Object.freeze({}) as StoreFd; this.descriptors.set(token, fd); return token;
    } catch (e) { await fd.close(); throw e; }
  }
  private fd(token: StoreFd): FileHandle { const fd = this.descriptors.get(token); if (!fd) throw new Error("stale"); return fd; }
  async read(fd: StoreFd, offset: number, maxBytes: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 262144) throw new Error("invalid-range");
    this.profile.assertHeld();const identity=await this.fd(fd).stat();if(!identity.isFile() || identity.nlink!==1)throw new Error("unsafe-path");
    const buffer = Buffer.allocUnsafe(maxBytes); const { bytesRead } = await this.fd(fd).read(buffer, 0, maxBytes, offset);
    return buffer.subarray(0, bytesRead);
  }
  async write(fd: StoreFd, offset: number, bytes: Uint8Array): Promise<number> {
    this.profile.assertHeld();const identity=await this.fd(fd).stat();if(!identity.isFile() || identity.nlink!==1)throw new Error("unsafe-path");return (await this.fd(fd).write(bytes, 0, bytes.byteLength, offset)).bytesWritten;
  }
  async sync(fd: StoreFd): Promise<void> { this.profile.assertHeld(); await this.fd(fd).sync(); }
  async close(token: StoreFd): Promise<void> { const fd = this.fd(token); this.descriptors.delete(token); await fd.close(); }
  async directorySync(name: string): Promise<void> { const fd = await open(name, constants.O_RDONLY); try { await fd.sync(); } finally { await fd.close(); } }
  async syncDirectory(p: StorePath): Promise<void> { await this.check(p); if (this.durability === "file-and-directory-sync") await this.directorySync(this.name(p)); }
  async atomicReplace(from: StorePath, to: StorePath): Promise<void> {
    await this.check(from); await this.check(to, true);
    const source = await lstat(this.name(from)), parent = await lstat(path.dirname(this.name(to)));
    if (source.dev !== parent.dev) throw Object.assign(new Error("unsupported-filesystem"), { code: "EXDEV" });
    await rename(this.name(from), this.name(to)); // Never unlink/copy as a fallback.
  }
  async mkdir(p: StorePath): Promise<void> {
    await this.check(p, true); await mkdir(this.name(p), { mode: 0o700 }).catch(e => { if (e.code !== "EEXIST") throw e; });
    await this.check(p); if (!(await lstat(this.name(p))).isDirectory()) throw new Error("unsafe-path");
    if (this.durability === "file-and-directory-sync") await this.directorySync(path.dirname(this.name(p)));
  }
  async statfs(p: StorePath): Promise<{ availableBytes: number }> {
    await this.check(p); const st = await statfs(this.name(p), { bigint: true });
    return { availableBytes: Number(st.bavail * st.bsize > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : st.bavail * st.bsize) };
  }
  async unlink(p: StorePath): Promise<void> { await this.check(p); await unlink(this.name(p)); }
  async removeEmpty(p: StorePath): Promise<void> {
    if (!await this.exists(p)) return; await this.check(p); await rmdir(this.name(p));
    if (this.durability === "file-and-directory-sync") await this.directorySync(path.dirname(this.name(p)));
  }
  async fault(point: PersistenceFaultPoint): Promise<void> { await this.at(point, async () => {}); }
  async at<T>(point: PersistenceFaultPoint, work: () => Promise<T>): Promise<T> {
    await this.options.fault?.(point, "before"); const value = await work(); await this.options.fault?.(point, "after"); return value;
  }
  async exists(p: StorePath): Promise<boolean> { try { await this.check(p); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } }
  async size(p: StorePath): Promise<number> { await this.check(p); return (await lstat(this.name(p))).size; }
  async entries(p: StorePath, maximum: number): Promise<Array<{ name: string; directory: boolean; bytes: number }>> {
    await this.check(p); const dir = await opendir(this.name(p)), entries: Array<{ name: string; directory: boolean; bytes: number }> = [];
    for await (const entry of dir) {
      if (entries.length === maximum) throw new Error("scan-limit");
      const name = path.join(this.name(p), entry.name), st = await lstat(name);
      if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory()) || (st.isFile() && st.nlink !== 1) || await realpath(name) !== name) throw new Error("unsafe-path");
      entries.push({ name: entry.name, directory: st.isDirectory(), bytes: st.size });
    }
    return entries;
  }
  async bytes(p: StorePath, maximum: number): Promise<Uint8Array> {
    const fd = await this.open(p, "read");
    try {
      const size = (await this.fd(fd).stat()).size;
      if (size > maximum) throw new Error("size-limit");
      const result = new Uint8Array(size); let offset = 0;
      while (offset < size) { const b = await this.read(fd, offset, Math.min(262144, size - offset)); if (!b.length) throw new Error("corrupt"); result.set(b, offset); offset += b.length; }
      if ((await this.fd(fd).stat()).size !== size) throw new Error("input-changed");
      return result;
    } finally { await this.close(fd); }
  }
}
const roots = new WeakMap<StoreRoot, {profile:ProfileWriterLock; userData:string; root:string; dev:bigint; ino:bigint}>();
export async function openStoreRoot(input:{userData:string;profile:ProfileWriterLock}):Promise<StoreRoot> {
  input.profile.assertHeld();
  if (!path.isAbsolute(input.userData)) throw new Error("unsafe-path");
  const anchor=await realpath(input.userData);
  if (anchor !== path.resolve(input.userData)) throw new Error("unsafe-path");
  const fs=await createNodePersistenceFs(anchor,input.profile), st=await lstat(fs.root,{bigint:true});
  const token=Object.freeze({}) as StoreRoot;
  roots.set(token,{profile:input.profile,userData:anchor,root:fs.root,dev:st.dev,ino:st.ino});
  return token;
}
// Private host bootstrap helper; never a runtime/plugin/preload export.
export async function storeRootPath(root:StoreRoot,profile:ProfileWriterLock):Promise<string> {
  profile.assertHeld(); const value=roots.get(root);
  if (!value || value.profile !== profile) throw new Error("unsafe-root");
  const st=await lstat(value.root,{bigint:true});
  if (st.isSymbolicLink() || !st.isDirectory() || st.dev!==value.dev || st.ino!==value.ino || await realpath(value.root)!==value.root) throw new Error("unsafe-root");
  return value.root;
}
export async function createNodePersistenceFs(userData: string, profile: ProfileWriterLock, options: FsOptions = {}): Promise<NodePersistenceFs> {
  profile.assertHeld();
  const anchor = await realpath(userData);
  let current = anchor;
  for (const component of ["plugins", "persistence-v1"]) {
    const next = path.join(current, component);
    await mkdir(next, { mode: 0o700 }).catch(e => { if (e.code !== "EEXIST") throw e; });
    const st = await lstat(next);
    if (!st.isDirectory() || st.isSymbolicLink() || await realpath(next) !== next) throw new Error("unsafe-path");
    if (options.directorySyncSupported ?? process.platform !== "win32") { const fd = await open(current, constants.O_RDONLY); try { await fd.sync(); } finally { await fd.close(); } }
    current = next;
  }
  const fs = new NodePersistenceFs(current, profile, options);
  await fs.check(fs.path()); await fs.mkdir(fs.path("namespaces")); return fs;
}
```

Create `apps/desktop/src/main/plugins/persistence/quota.ts`:

```ts
const MiB = 1048576;
type Totals = { committed: number; records: number; metadata: number; temporary: number };
type Reservation = { source: string; bytes: number; create: boolean; metadata: number; lane: "write" | "export" | "metadata" };
export class QuotaLedger {
  private readonly committed = new Map<string, Totals>();
  private readonly reservations = new Map<string, Reservation>();
  private readonly temporary = new Map<string, { source: string; bytes: number; refs: number }>();
  restore(source: string, totals: Totals): void { this.committed.set(source, { ...totals }); }
  private total(source: string): Totals { return this.committed.get(source) ?? { committed: 0, records: 0, metadata: 0, temporary: 0 }; }
  private sum(select: (v: Totals) => number): number { return [...this.committed.values()].reduce((a, v) => a + select(v), 0); }
  snapshot(source: string) {
    const c = this.total(source), all = [...this.reservations.values()], own = all.filter(r => r.source === source);
    const pending = (rs: Reservation[]) => rs.reduce((n, r) => n + r.bytes, 0);
    const tmp = [...this.temporary.values()].filter(r => r.source === source).reduce((n, r) => n + r.bytes, 0);
    return { recordCount: c.records, reservedCreates: own.filter(r => r.create).length, committedBytes: c.committed,
      reservedBytes: pending(own), pinnedBytes: tmp, temporaryBytes: c.temporary + tmp, sourceLimitBytes: 536870912 as const,
      sourceLimitRecords: 256 as const, hostAvailableBytes: Math.max(0, 1073741824 - this.sum(c => c.committed) - pending(all)),
      writeSlotsAvailable: Math.max(0, Math.min(2 - own.filter(r => r.lane === "write").length, 16 - all.filter(r => r.lane === "write").length)),
      exportSlotsAvailable: Math.max(0, Math.min(1 - own.filter(r => r.lane === "export").length, 4 - all.filter(r => r.lane === "export").length)) };
  }
  reserve(id: string, source: string, input: Omit<Reservation, "source">, availableBytes: number): void {
    if (this.reservations.has(id)) throw new Error("write-in-progress");
    for (const n of [input.bytes, input.metadata, availableBytes]) if (!Number.isSafeInteger(n) || n < 0) throw new Error("invalid-range");
    const s = this.snapshot(source), all = [...this.reservations.values()], own = all.filter(r => r.source === source);
    if (s.recordCount + s.reservedCreates + Number(input.create) > 256) throw new Error("record-count");
    if (s.committedBytes + s.reservedBytes + input.bytes > 512 * MiB) throw new Error("source-bytes");
    if (s.hostAvailableBytes < input.bytes) throw new Error("host-bytes");
    if ((input.lane === "write" && !s.writeSlotsAvailable) || (input.lane === "export" && !s.exportSlotsAvailable)) throw new Error("queue");
    if (this.total(source).metadata + own.reduce((n, r) => n + r.metadata, 0) + input.metadata > 4 * MiB || this.sum(t => t.metadata) + all.reduce((n, r) => n + r.metadata, 0) + input.metadata > 64 * MiB) throw new Error("metadata-limit");
    if (availableBytes - all.reduce((n, r) => n + r.bytes + r.metadata, 0) - input.bytes - input.metadata < 16 * MiB) throw new Error("disk-full");
    this.reservations.set(id, { source, ...input });
  }
  commit(id: string, delta: Totals): void {
    const r = this.reservations.get(id); if (!r) throw new Error("stale");
    const t = this.total(r.source);
    this.committed.set(r.source, { committed: t.committed + delta.committed, records: t.records + delta.records,
      metadata: t.metadata + delta.metadata, temporary: t.temporary + delta.temporary });
    this.reservations.delete(id);
  }
  release(id: string): void { this.reservations.delete(id); }
  adjustMetadata(source: string, delta: number): void { const current = this.total(source); this.committed.set(source, { ...current, metadata: current.metadata + delta }); }
  holdTemporary(source: string, key: string, bytes: number): void {
    const id = JSON.stringify([source, key]), existing = this.temporary.get(id);
    if (existing) { if (existing.bytes !== bytes) throw new Error("corrupt"); existing.refs++; return; }
    if (this.snapshot(source).temporaryBytes + bytes > 32 * MiB || this.sum(t => t.temporary) + [...this.temporary.values()].reduce((n, r) => n + r.bytes, 0) + bytes > 128 * MiB) throw new Error("temporary-bytes");
    this.temporary.set(id, { source, bytes, refs: 1 });
  }
  releaseTemporary(source: string, key: string): void {
    const id = JSON.stringify([source, key]), value = this.temporary.get(id);
    if (value && --value.refs === 0) this.temporary.delete(id);
  }
  hasTemporary(source: string, key: string): boolean { return this.temporary.has(JSON.stringify([source, key])); }
}
type Job = { source: string; bytes: number; deadline: number; run: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void };
export class WorkQueue {
  private readonly queue: Job[] = []; private readonly sourceBytes = new Map<string, number>();
  private readonly sourceCount = new Map<string, number>(); private active = 0; private bytes = 0; pending = 0;
  constructor(private readonly now: () => number) {}
  run<T>(source: string, bytes: number, deadline: number, run: () => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.pending >= 32 || this.bytes + bytes > 8388608 || (this.sourceBytes.get(source) ?? 0) + bytes > 1048576 || (this.sourceCount.get(source) ?? 0) >= 16) return Promise.reject(new Error("queue"));
    this.pending++; this.bytes += bytes; this.sourceBytes.set(source, (this.sourceBytes.get(source) ?? 0) + bytes); this.sourceCount.set(source, (this.sourceCount.get(source) ?? 0) + 1);
    const result = new Promise<unknown>((resolve, reject) => this.queue.push({ source, bytes, deadline, run, resolve, reject }));
    this.pump(); return result as Promise<T>;
  }
  private pump(): void {
    while (this.active < 4 && this.queue.length) {
      const job = this.queue.shift()!; this.active++;
      const work = this.now() >= job.deadline ? Promise.reject(new Error("timeout")) : job.run();
      void work.then(job.resolve, job.reject).finally(() => {
        this.active--; this.pending--; this.bytes -= job.bytes;
        this.sourceBytes.set(job.source, (this.sourceBytes.get(job.source) ?? 0) - job.bytes);
        this.sourceCount.set(job.source, (this.sourceCount.get(job.source) ?? 0) - 1); this.pump();
      });
    }
  }
}
```

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/persistence/filesystem.test.ts src/main/plugins/persistence/quota.test.ts
```

Expected: PASS. This includes real temporary files, but no Electron, localhost or hardware.

- [ ] **Step 3: Add namespace and publication-gate tests**

Create `apps/desktop/src/main/plugins/persistence/namespace.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createNodePersistenceFs } from "./filesystem.js";
import { Namespace } from "./namespace.js";
it("uses the full source hash and verifies stored identity, not plugin ID", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "namespace-"));
  try {
    const fs = await createNodePersistenceFs(root, { hostEpoch: "00000000-0000-4000-8000-000000000001", assertHeld() {} });
    const ns = await Namespace.open(fs, "builtin:kobrixa.lab");
    expect(ns.hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await Namespace.open(fs, "builtin:kobrixa.lab")).hash).toBe(ns.hash);
    await writeFile(fs.name(ns.path("identity.json")), JSON.stringify({ formatVersion: 1, sourceKey: "foreign" }));
    await expect(Namespace.open(fs, "builtin:kobrixa.lab")).rejects.toThrow("identity-mismatch");
    await writeFile(fs.name(ns.path("identity.json")), JSON.stringify({ formatVersion: 2, sourceKey: "builtin:kobrixa.lab" }));
    await expect(Namespace.open(fs, "builtin:kobrixa.lab")).rejects.toThrow("unsupported-format");
  } finally { await rm(root, { recursive: true, force: true }); }
});
```

Create `apps/desktop/src/main/plugins/persistence/engine-port.test.ts`:

```ts
import { expect, expectTypeOf, it } from "vitest";
import { PublicationGate, ownerKey, type PersistenceEnginePort } from "./engine-port.js";
it("has one dispatch winner and a fence cannot pretend to undo it", () => {
  const gate = new PublicationGate(100), before = new PublicationGate(100);
  before.shorten(5); expect(before.dispatch(5)).toBe(false);
  expect(gate.dispatch(4)).toBe(true); gate.shorten(4);
  expect(gate.dispatched).toBe(true); expect(gate.dispatch(4)).toBe(false);
  expectTypeOf<PersistenceEnginePort["publish"]>().returns.toMatchTypeOf<Promise<{ disposition: "not-committed" | "committed" | "unknown" }>>();
});
it("owner equality includes both epochs and generation, independent of key order", () => {
  const owner = { sourceKey: "builtin:kobrixa.lab", pluginId: "kobrixa.lab", generation: 1, hostEpoch: "h", processEpoch: "p" };
  expect(ownerKey(owner)).not.toBe(ownerKey({ ...owner, generation: 2 }));
  expect(ownerKey(owner)).not.toBe(ownerKey({ ...owner, processEpoch: "other" }));
});
```

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/persistence/namespace.test.ts src/main/plugins/persistence/engine-port.test.ts
```

Expected: FAIL for missing `Namespace`, `PublicationGate` and `ownerKey`.

- [ ] **Step 4: Add internal gates, namespace paths and bounded disk envelopes**

Append to `apps/desktop/src/main/plugins/persistence/engine-port.ts`, retaining all T0 declarations byte-for-byte:

```ts
import type { PersistenceFsPort } from "./filesystem.js";
import { performance } from "node:perf_hooks";
export const ownerKey = (owner: PersistenceOwner): string => JSON.stringify([owner.sourceKey, owner.pluginId, owner.generation, owner.hostEpoch, owner.processEpoch]);
export class PublicationGate {
  readonly memory: SharedArrayBuffer; private readonly words: BigInt64Array;
  constructor(deadline: number, memory?: SharedArrayBuffer, byteOffset=0, initialize=memory===undefined) {
    this.memory = memory ?? new SharedArrayBuffer(16); this.words = new BigInt64Array(this.memory,byteOffset,2);
    if (initialize) { Atomics.store(this.words, 0, 0n); Atomics.store(this.words, 1, BigInt(Math.floor(deadline))); }
  }
  get deadline(): number { return Number(Atomics.load(this.words, 1)); }
  get dispatched(): boolean { return Atomics.load(this.words, 0) === 1n; }
  shorten(deadline: number, now = performance.now()): void {
    if (deadline <= now) Atomics.compareExchange(this.words, 0, 0n, 2n);
    const value = BigInt(Math.floor(deadline)); let old = Atomics.load(this.words, 1);
    while (value < old) { const seen = Atomics.compareExchange(this.words, 1, old, value); if (seen === old) break; old = seen; }
  }
  dispatch(now: number): boolean {
    if (now >= this.deadline) return false;
    if (Atomics.compareExchange(this.words, 0, 0n, 1n) !== 0n) return false;
    // fence() only shortens time; the atomic state transition is the authority boundary.
    return true;
  }
}
```

Create `apps/desktop/src/main/plugins/persistence/namespace.ts`:

The private disk validator imports T1's isolated persistence-validation module read-only, so it does not require premature P170 barrel publication. H-P owns any later barrel assembly.

```ts
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { RecordMeta, Receipt, RecordRevision } from "@kobrixa/plugin-protocol";
import type { PublicationTicket, ImportTag } from "./engine-port.js";
import { NodePersistenceFs, writeAll, type StorePath } from "./filesystem.js";
import { persistenceErrorSchema } from "../../../../../../packages/plugin-protocol/src/persistence-validation.js";
import path from "node:path";
const scopedPaths=new WeakMap<NodePersistenceFs,WeakMap<StorePath,string>>();
export function createStorePath(fs:NodePersistenceFs,parts:readonly string[]):StorePath {
  if(parts.some(p=>!p || p==="." || p===".." || /[\\/:\0]/.test(p)))throw new Error("unsafe-path");
  let paths=scopedPaths.get(fs);if(!paths){paths=new WeakMap();scopedPaths.set(fs,paths);}
  const token=Object.freeze({}) as StorePath;paths.set(token,path.join(fs.root,...parts));return token;
}
export function storePathName(fs:NodePersistenceFs,p:StorePath):string {const name=scopedPaths.get(fs)?.get(p);if(!name)throw new Error("unsafe-path");return name;}
const h = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const r = z.string().regex(/^r_[0-9a-f]{32}$/), hash = z.string().regex(/^[0-9a-f]{64}$/);
const n = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), v = n.min(1).max(2147483647);
const key = z.string().min(1).refine(s => Buffer.byteLength(s) <= 128 && !s.includes("\0"));
const record = z.strictObject({ id: h, revision: r, kind: z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/), schemaVersion: v,
  label: z.string().refine(s => [...s].length <= 160 && Buffer.byteLength(s) <= 640 && !/[\u0000-\u001f\u007f]/.test(s)),
  mediaType: z.enum(["application/json", "text/plain", "text/csv", "application/octet-stream"]), byteLength: n.max(8388608), sha256: hash,
  createdAt: n, updatedAt: n, checkpoint: z.enum(["none", "open", "final"]), interrupted: z.boolean() });
const metadata = z.union([z.strictObject({ kind: z.literal("settings"), schemaVersion: v, validationDigest: hash }),
  z.strictObject({ kind: z.literal("record"), record, deleted: z.boolean() }), z.strictObject({ kind: z.enum(["import", "recovery"]), key })]);
const target = z.union([z.strictObject({ kind: z.literal("settings"), expectedRevision: r.nullable() }),
  z.strictObject({ kind: z.literal("record"), id: h, expectedRevision: r.nullable() }), z.strictObject({ kind: z.enum(["import", "recovery"]), key })]);
export const importTagSchema = z.strictObject({ importId: key, itemKey: key, sourceSha256: hash }).refine(t => Buffer.byteLength(JSON.stringify(t)) <= 256);
export const persistenceOwnerSchema=z.strictObject({sourceKey:z.string().min(1).max(160),pluginId:z.string().min(1),generation:n,hostEpoch:h,processEpoch:h});
export const publicationTicketSchema=z.strictObject({id:h,owner:persistenceOwnerSchema,deadlineMonotonicMs:n,metadata,target});
export const importPlanSchema=z.strictObject({formatVersion:z.literal(1),id:key,mappingVersion:v,targetSourceKey:z.string().min(1).max(160),
  items:z.array(z.strictObject({key,sourceFormat:v,sourceSha256:hash,mappedSha256:hash,byteLength:n.max(8388608),ticket:publicationTicketSchema,tag:importTagSchema})).max(512)
}).superRefine((plan,ctx)=>{
  if (new Set(plan.items.map(i=>i.key)).size!==plan.items.length || new Set(plan.items.map(i=>i.ticket.id)).size!==plan.items.length ||
      plan.items.some(i=>i.tag.importId!==plan.id || i.tag.itemKey!==i.key || i.sourceSha256!==i.tag.sourceSha256 || i.ticket.owner.sourceKey!==plan.targetSourceKey)) ctx.addIssue({code:"custom",message:"input-changed"});
});
const receipt=z.strictObject({revision:r,commitId:h,durability:z.enum(["file-and-directory-sync","file-sync-only"])});
export const importItemEvidenceSchema=z.strictObject({key,state:z.enum(["pending","committed","skipped","unknown"]),receipt:receipt.nullable(),skipReason:z.string().refine(s=>Buffer.byteLength(s)<=256).nullable()})
  .refine(e=>e.state==="skipped"?!!e.skipReason && e.receipt===null:e.skipReason===null && (e.state!=="committed" || e.receipt!==null));
export const importDocumentSchema=z.strictObject({formatVersion:z.literal(1),plan:importPlanSchema,items:z.array(importItemEvidenceSchema).max(512),complete:z.boolean()})
  .refine(d=>d.items.length===d.plan.items.length && d.items.every((e,i)=>e.key===d.plan.items[i]?.key) && (!d.complete || d.items.every(e=>e.state==="committed" || e.state==="skipped")));
export const storedRecoverySchema=z.strictObject({id:h,owner:persistenceOwnerSchema,
  report:z.strictObject({state:z.enum(["saved","retryable","checkpoint-only","uncertain"]),blocker:z.boolean(),recovery:h.optional(),retryAction:h.optional(),pendingSettings:z.boolean(),
    records:z.array(z.strictObject({id:h,committedRevision:r.nullable(),final:z.boolean(),payload:z.enum(["complete-staging","checkpoint-only","none"]),expiresAt:n.optional()})).max(2),
    errors:z.array(persistenceErrorSchema).max(16)}),ticket:publicationTicketSchema.nullable(),sealedPin:h.nullable(),expiresAt:n.nullable()});
export const persistenceScopeSchema=z.union([z.strictObject({kind:z.literal("namespace"),owner:persistenceOwnerSchema}),z.strictObject({kind:z.literal("target"),owner:persistenceOwnerSchema,recordId:h})]);
export const persistenceBarrierSchema=z.strictObject({id:h,scope:persistenceScopeSchema,through:n,deadlineMonotonicMs:n});
const diskHeadSchema = z.strictObject({ formatVersion: z.literal(1), metadata, target, object: z.string().regex(/^r_[0-9a-f]{32}\.(?:bin|json)$/).nullable(),
  byteLength: n.max(8388608), sha256: hash, receipt: z.strictObject({ revision: r, commitId: h, durability: z.enum(["file-and-directory-sync", "file-sync-only"]) }), importTag: importTagSchema.optional() });
export type DiskHead = { formatVersion: 1; metadata: PublicationTicket["metadata"]; target: PublicationTicket["target"]; object: string | null;
  byteLength: number; sha256: string; receipt: Receipt<RecordRevision>; importTag?: ImportTag };
export function parseHead(bytes: Uint8Array): DiskHead {
  if (bytes.length > 8192) throw new Error("corrupt");
  let raw: unknown; try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("corrupt"); }
  if (typeof raw === "object" && raw !== null && "formatVersion" in raw && raw.formatVersion !== 1) throw new Error("unsupported-format");
  const parsed = diskHeadSchema.safeParse(raw); if (!parsed.success) throw new Error("corrupt");
  const head = parsed.data as DiskHead;
  if ((head.metadata.kind === "record" && head.metadata.deleted && (head.object !== null || head.byteLength !== 0)) || head.metadata.kind !== head.target.kind || (head.metadata.kind === "record" && (head.target.kind !== "record" || head.metadata.record.id !== head.target.id || head.metadata.record.revision !== head.receipt.revision || (!head.metadata.deleted && (head.metadata.record.sha256 !== head.sha256 || head.metadata.record.byteLength !== head.byteLength)))) || (head.object !== null && !head.object.startsWith(head.receipt.revision + "."))) throw new Error("corrupt");
  return head;
}
export type Location = { directory: StorePath; head: StorePath; previous: StorePath; objects: StorePath; parts: string[]; name: string };
export class Namespace {
  readonly hash: string;
  private constructor(readonly fs: NodePersistenceFs, readonly sourceKey: string) { this.hash = createHash("sha256").update(sourceKey).digest("hex"); }
  path(...parts: string[]): StorePath { return this.fs.path("namespaces", this.hash, ...parts); }
  static async open(fs: NodePersistenceFs, sourceKey: string): Promise<Namespace> {
    if (!sourceKey || sourceKey.length > 160 || sourceKey.includes("\0")) throw new Error("identity-mismatch");
    const ns = new Namespace(fs, sourceKey), identity = ns.path("identity.json");
    const exists = await fs.exists(ns.path());
    if (!exists) {
      await fs.mkdir(ns.path());
      await ns.writeNew(identity, { formatVersion: 1, sourceKey }); await fs.syncDirectory(ns.path());
    } else if (!await fs.exists(identity)) throw new Error("identity-mismatch");
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await fs.bytes(identity, 4096))) as { formatVersion?: unknown; sourceKey?: unknown };
    if (data.formatVersion !== 1) throw new Error("unsupported-format");
    if (data.sourceKey !== sourceKey || Object.keys(data).sort().join(",") !== "formatVersion,sourceKey") throw new Error("identity-mismatch");
    for (const name of ["settings", "records", "staging", "imports", "recovery", "quarantine"]) await fs.mkdir(ns.path(name));
    return ns;
  }
  async writeNew(p: StorePath, value: unknown): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(value)); const fd = await this.fs.open(p, "create-exclusive");
    try { await writeAll(this.fs, fd, 0, bytes); await this.fs.sync(fd); } finally { await this.fs.close(fd); }
  }
  async location(t: PublicationTicket["target"], create = false): Promise<Location> {
    let parts: string[], name: string;
    if (t.kind === "settings") { parts = ["settings"]; name = "head.json"; }
    else if (t.kind === "record") { h.parse(t.id); parts = ["records", t.id]; name = "head.json"; }
    else { key.parse(t.key); parts = [t.kind === "import" ? "imports" : "recovery"]; name = createHash("sha256").update(t.key).digest("hex") + ".json"; }
    if (create) { await this.fs.mkdir(this.path(...parts)); await this.fs.mkdir(this.path(...parts, "objects")); }
    return { directory: this.path(...parts), head: this.path(...parts, name), previous: this.path(...parts, name === "head.json" ? "head.previous" : name + ".previous"), objects: this.path(...parts, "objects"), parts, name };
  }
  object(location: Location, head: DiskHead): StorePath {
    if (!head.object) throw new Error("not-found"); return this.path(...location.parts, "objects", head.object);
  }
  async head(location: Location): Promise<DiskHead | null> {
    return await this.fs.exists(location.head) ? parseHead(await this.fs.bytes(location.head, 8192)) : null;
  }
  async verify(location: Location, head: DiskHead): Promise<void> {
    if (head.object === null) { if (head.metadata.kind !== "record" || !head.metadata.deleted) throw new Error("corrupt"); return; }
    const object = this.object(location, head), fd = await this.fs.open(object, "read"), digest = createHash("sha256"); let offset = 0;
    try {
      if (await this.fs.size(object) !== head.byteLength) throw new Error("corrupt");
      while (offset < head.byteLength) { const bytes = await this.fs.read(fd, offset, Math.min(262144, head.byteLength - offset)); if (!bytes.length) throw new Error("corrupt"); digest.update(bytes); offset += bytes.length; }
      if (digest.digest("hex") !== head.sha256) throw new Error("corrupt");
    } finally { await this.fs.close(fd); }
  }
  async locations(): Promise<Location[]> {
    const result: Location[] = [await this.location({ kind: "settings", expectedRevision: null })];
    for (const entry of await this.fs.entries(this.path("records"), 4096)) {
      if (!entry.directory || !h.safeParse(entry.name).success) throw new Error("corrupt");
      result.push(await this.location({ kind: "record", id: entry.name, expectedRevision: null }));
    }
    for (const kind of ["import", "recovery"] as const) {
      for (const entry of await this.fs.entries(this.path(kind === "import" ? "imports" : "recovery"), 4096)) {
        if (!entry.directory && entry.name.endsWith(".json")) {
          const head=parseHead(await this.fs.bytes(this.path(kind === "import" ? "imports" : "recovery",entry.name),8192));
          if (head.target.kind!==kind || !("key" in head.target)) throw new Error("corrupt");
          const loc=await this.location(head.target);
          if (loc.name!==entry.name) throw new Error("identity-mismatch"); result.push(loc);
        }
      }
    }
    return result;
  }
  async inventory(): Promise<Array<{ path: StorePath; relative: string; bytes: number }>> {
    const result: Array<{ path: StorePath; relative: string; bytes: number }> = []; let count = 0;
    const walk = async (parts: string[], depth: number): Promise<void> => {
      if (depth > 6) throw new Error("scan-limit");
      for (const entry of await this.fs.entries(this.path(...parts), 4096 - count)) {
        if (++count > 4096) throw new Error("scan-limit");
        const next = [...parts, entry.name];
        if (entry.directory) await walk(next, depth + 1);
        else result.push({ path: this.path(...next), relative: next.join("/"), bytes: entry.bytes });
      }
    };
    await walk([], 0); return result;
  }
  async quarantine(p: StorePath): Promise<void> {
    await this.fs.atomicReplace(p, this.path("quarantine", randomUUID() + ".evidence"));
    await this.fs.syncDirectory(this.path("quarantine"));
  }
}
export const liveRecord = (head: DiskHead | null): RecordMeta | null => head?.metadata.kind === "record" && !head.metadata.deleted ? head.metadata.record : null;
```

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/persistence/namespace.test.ts src/main/plugins/persistence/engine-port.test.ts
```

Expected: PASS. The namespace helper uses host-generated path components and returns opaque `StorePath` tokens. Neither the worker channel nor the plugin protocol returns a filesystem path.

- [ ] **Step 5: Write atomic publication, pin, expiry and import-receipt tests**

Create `apps/desktop/src/main/plugins/persistence/atomic-store.test.ts`:

```ts
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { PersistenceOwner } from "@kobrixa/plugin-runtime";
import type { PublicationTicket } from "./engine-port.js";
import { AtomicStore } from "./atomic-store.js";
import { createNodePersistenceFs, type PersistenceFaultPoint } from "./filesystem.js";
const owner: PersistenceOwner = { sourceKey: "builtin:kobrixa.lab", pluginId: "kobrixa.lab", generation: 1, hostEpoch: "00000000-0000-4000-8000-000000000001", processEpoch: "00000000-0000-4000-8000-000000000002" };
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
function ticket(bytes: Uint8Array, id: string = randomUUID(), expectedRevision: string | null = null): PublicationTicket {
  return { id: randomUUID(), owner, deadlineMonotonicMs: 120000,
    target: { kind: "record", id, expectedRevision }, metadata: { kind: "record", deleted: false,
      record: { id, revision: "r_" + randomUUID().replaceAll("-", ""), kind: "lab.samples", schemaVersion: 1, label: "Lab", mediaType: "application/octet-stream", byteLength: bytes.length, sha256: hash(bytes), createdAt: 1, updatedAt: 1, checkpoint: "none", interrupted: false } } };
}
async function setup(fault: (point: PersistenceFaultPoint) => Promise<void> = async () => {}) {
  const root = await mkdtemp(path.join(tmpdir(), "atomic-")); let now = 0;
  const fs = await createNodePersistenceFs(root, { hostEpoch: owner.hostEpoch, assertHeld() {} }, { now: () => now, fault });
  const store = new AtomicStore(fs); await store.initialize();
  return { fs, store, advance: (n: number) => { now += n; }, close: async () => { await store.dispose(); await rm(root, { recursive: true, force: true }); } };
}
async function stage(s: AtomicStore, t: PublicationTicket, bytes: Uint8Array) {
  await s.reserve(t, bytes.length);
  for (let offset = 0; offset < bytes.length; offset += 262144) await s.append(t, offset, bytes.subarray(offset, offset + 262144));
  await s.seal(t, bytes.length, hash(bytes));
}
it("B2-RF1: cancellation before dispatch wins; after dispatch stays unknown until original reconciliation", async () => {
  const env = await setup();
  try {
    const first = ticket(new Uint8Array([1])); await stage(env.store, first, new Uint8Array([1])); const old = await env.store.publish(first);
    expect(old.disposition).toBe("committed");
    const blocked = ticket(new Uint8Array([2]), first.target.kind === "record" ? first.target.id : "", old.receipt!.revision);
    await stage(env.store, blocked, new Uint8Array([2])); env.store.fenceTarget(owner, blocked.target.kind === "record" ? blocked.target.id : "", 0);
    expect((await env.store.publish(blocked)).disposition).toBe("not-committed");
    await env.store.abort(blocked);
  } finally { await env.close(); }
  let pause = false, entered!: () => void, resume!: () => void;
  const atRename = new Promise<void>(r => { entered = r; }), release = new Promise<void>(r => { resume = r; });
  const env2 = await setup();
  try {
    const replace = env2.fs.atomicReplace.bind(env2.fs);
    env2.fs.atomicReplace = async (from, to) => {
      if (pause && env2.fs.name(to).endsWith("head.json")) { entered(); await release; }
      return replace(from, to);
    };
    const t = ticket(new Uint8Array([7])); await stage(env2.store, t, new Uint8Array([7])); pause = true;
    const pending = env2.store.publish(t); await atRename;
    env2.store.fence(owner, 0);
    expect(await env2.store.abort(t)).toBe("unknown");
    expect((await env2.store.reconcile(t)).disposition).toBe("unknown");
    await expect(env2.store.reserve(ticket(new Uint8Array([8])), 1)).rejects.toThrow();
    resume(); const result = await pending;
    const reconciled = await env2.store.reconcile(t);
    expect(reconciled.receipt).toEqual(result.receipt);
    expect(reconciled.disposition).toBe("committed");
    expect((await env2.store.reconcile(t)).receipt).toEqual(reconciled.receipt);
  } finally { resume?.(); await env2.close(); }
});
it("pins old bytes, rejects gaps and altered retries, and retains a stable list snapshot", async () => {
  const env = await setup();
  try {
    const t = ticket(new Uint8Array([1, 2])); await env.store.reserve(t, 2);
    await expect(env.store.append({ ...t, owner: { ...owner, processEpoch: randomUUID() } }, 0, new Uint8Array([1]))).rejects.toThrow("stale");
    expect(env.store.quota.snapshot(owner.sourceKey).reservedBytes).toBe(2);
    expect(await env.store.append(t, 0, new Uint8Array([1]))).toBe(1);
    env.advance(1000); expect(await env.store.append(t, 0, new Uint8Array([1]))).toBe(1);
    await expect(env.store.append(t, 0, new Uint8Array([9]))).rejects.toThrow("offset-mismatch");
    await expect(env.store.append(t, 2, new Uint8Array([2]))).rejects.toThrow("offset-mismatch");
    await env.store.append(t, 1, new Uint8Array([2])); await env.store.seal(t, 2, hash(new Uint8Array([1, 2])));
    const committed = await env.store.publish(t), id = t.target.kind === "record" ? t.target.id : "";
    const pin = await env.store.open(owner, id, committed.receipt!.revision);
    const replacement = ticket(new Uint8Array([3]), id, committed.receipt!.revision);
    await stage(env.store, replacement, new Uint8Array([3])); await env.store.publish(replacement);
    expect([...await env.store.read(owner, pin, 0, 2)]).toEqual([1, 2]);
    await expect(env.store.read({ ...owner, generation: 2 }, pin, 0, 2)).rejects.toThrow("stale");
    await env.store.close(owner, pin); await env.store.close(owner, pin);
    expect((await env.store.list(owner, { limit: 64 })).entries).toHaveLength(1);
  } finally { await env.close(); }
});
it("keeps pagination immutable across a new commit and expires both read and list handles", async () => {
  const env = await setup();
  try {
    const a = ticket(new Uint8Array([1])), b = ticket(new Uint8Array([2]));
    await stage(env.store, a, new Uint8Array([1])); const receipt = await env.store.publish(a);
    await stage(env.store, b, new Uint8Array([2])); await env.store.publish(b);
    const pin = await env.store.open(owner, a.target.kind === "record" ? a.target.id : "", receipt.receipt!.revision);
    const first = await env.store.list(owner, { limit: 1 });
    const c = ticket(new Uint8Array([3])); await stage(env.store, c, new Uint8Array([3])); await env.store.publish(c);
    const second = await env.store.list(owner, { limit: 1, cursor: first.nextCursor! });
    expect(second.entries).toHaveLength(1); expect(second.nextCursor).toBeUndefined();
    expect(second.entries[0]?.id).not.toBe(first.entries[0]?.id);
    expect((await env.store.list(owner, { limit: 64 })).entries).toHaveLength(3);
    env.advance(30000);
    await expect(env.store.read(owner, pin, 0, 1)).rejects.toThrow("stale");
    await expect(env.store.list(owner, { limit: 1, cursor: first.nextCursor! })).rejects.toThrow("stale");
  } finally { await env.close(); }
});
it("does not renew the original staging lease for repeated seal/retry", async () => {
  const env = await setup();
  try {
    const t = ticket(new Uint8Array()); await stage(env.store, t, new Uint8Array());
    env.advance(30000); await expect(env.store.seal(t, 0, hash(new Uint8Array()))).rejects.toThrow("expired");
    expect((await env.store.publish(t)).disposition).toBe("not-committed");
  } finally { await env.close(); }
});
it("B2-RF5: item receipt is in the same head and is discoverable without publishing again", async () => {
  const env = await setup();
  try {
    const bytes = new Uint8Array([9]), t = ticket(bytes);
    const tag={importId:"lab-v1",itemKey:"record-0",sourceSha256:hash(bytes)};
    await env.store.planImport(owner,{formatVersion:1,id:"lab-v1",mappingVersion:1,targetSourceKey:owner.sourceKey,items:[{key:"record-0",sourceFormat:1,sourceSha256:hash(bytes),mappedSha256:hash(bytes),byteLength:1,ticket:t,tag}]});
    await env.store.reserve(t, 1); await env.store.tagImport(t, tag);
    await env.store.append(t, 0, bytes); await env.store.seal(t, 1, hash(bytes));
    const result = await env.store.publish(t), receipts = await env.store.importReceipts(owner,"lab-v1");
    expect(receipts).toHaveLength(1); expect(receipts[0]?.receipt).toEqual(result.receipt);
    expect((await env.store.importReceipts(owner,"lab-v1"))[0]?.ticket.id).toBe(receipts[0]?.ticket.id);
  } finally { await env.close(); }
});
```

Append to `apps/desktop/src/main/plugins/persistence/atomic-store.test.ts`:

```ts
it("B2-RF5: streams 50 maximum records plus two complete reservations without retaining 400 MiB", async () => {
  const env = await setup();
  try {
    const chunk = new Uint8Array(262144), digest = createHash("sha256");
    for (let i = 0; i < 32; i++) digest.update(chunk);
    const sha256 = digest.digest("hex");
    const make = (): PublicationTicket => {
      const t = ticket(new Uint8Array());
      if (t.metadata.kind !== "record") throw new Error("test-target");
      return { ...t, metadata: { ...t.metadata, record: { ...t.metadata.record, byteLength: 8388608, sha256 } } };
    };
    for (let index = 0; index < 50; index++) {
      const t = make(); await env.store.reserve(t, 8388608);
      for (let offset = 0; offset < 8388608; offset += chunk.length) await env.store.append(t, offset, chunk);
      await env.store.seal(t, 8388608, sha256);
      expect((await env.store.publish(t)).disposition).toBe("committed");
    }
    const a = make(), b = make(); await env.store.reserve(a, 8388608); await env.store.reserve(b, 8388608);
    const q = env.store.quota.snapshot(owner.sourceKey);
    expect(q.recordCount).toBe(50); expect(q.committedBytes).toBe(419430400); expect(q.reservedBytes).toBe(16777216);
    expect(q.committedBytes + q.reservedBytes).toBe(436207616); expect(q.writeSlotsAvailable).toBe(0);
    const first = await env.store.list(owner, { limit: 16 }); expect(first.entries).toHaveLength(16);
    const next = await env.store.list(owner, { limit: 16, cursor: first.nextCursor! });
    expect(await env.store.list(owner, { limit: 16, cursor: first.nextCursor! })).toEqual(next);
    await env.store.abort(a); await env.store.abort(b);
  } finally { await env.close(); }
}, 120000);

for (const point of ["reserve", "open-temp", "chunk-write", "seal-sync", "object-rename", "object-dir-sync", "backup-head", "head-write", "before-publish", "after-publish", "head-dir-sync", "cache-publish", "receipt-send", "cleanup"] as const) {
  for (const edge of ["before", "after"] as const) {
    it(`failed ${point}/${edge} never exposes a partial replacement`, async () => {
      let armed = false;
      const root = await mkdtemp(path.join(tmpdir(), "fault-matrix-"));
      const fs = await createNodePersistenceFs(root, { hostEpoch: owner.hostEpoch, assertHeld() {} }, { now: () => 0,
        fault: async (p, e) => { if (armed && p === point && e === edge) throw Object.assign(new Error("injected"), { code: "EIO" }); } });
      const store = new AtomicStore(fs); await store.initialize();
      try {
        const oldTicket = ticket(new Uint8Array([1])); await stage(store, oldTicket, new Uint8Array([1]));
        const old = await store.publish(oldTicket), id = oldTicket.target.kind === "record" ? oldTicket.target.id : "";
        const next = ticket(new Uint8Array([2]), id, old.receipt!.revision); armed = true;
        let result: Awaited<ReturnType<AtomicStore["publish"]>> | null = null;
        try { await stage(store, next, new Uint8Array([2])); result = await store.publish(next); } catch { /* Failure is the injection's expected result. */ }
        armed = false;
        if (result?.disposition === "unknown") {
          const reconciled = await store.reconcile(next); expect(reconciled.disposition).toBe("committed");
        }
        const meta = await store.stat(owner, id);
        expect([hash(new Uint8Array([1])), hash(new Uint8Array([2]))]).toContain(meta.sha256);
        if (["reserve", "open-temp", "chunk-write", "seal-sync", "object-rename", "object-dir-sync", "backup-head", "head-write", "before-publish"].includes(point)) expect(meta.revision).toBe(old.receipt!.revision);
        else expect(meta.sha256).toBe(hash(new Uint8Array([2])));
      } finally { armed = false; await store.dispose().catch(() => {}); await rm(root, { recursive: true, force: true }); }
    });
  }
}
```

Replace `apps/desktop/src/main/plugins/persistence/contract.test.ts` with the complete final contract test:

```ts
import { expect, expectTypeOf, it } from "vitest";
import type { Handle, RecordId, RecordRevision } from "@kobrixa/plugin-protocol";
import type { PersistenceOwner } from "@kobrixa/plugin-runtime";
import { type PersistenceBackend, type PersistenceEnginePort, type PersistenceReadPort, type PublicationTicket } from "./engine-port.js";
import type { PersistenceFsPort, StoreFd, StorePath } from "./filesystem.js";
import { AtomicStore } from "./atomic-store.js";
it("keeps the frozen host ports unchanged", () => {
  expectTypeOf<PersistenceFsPort["open"]>().toEqualTypeOf<(p: StorePath, mode: "read" | "create-exclusive") => Promise<StoreFd>>();
  expectTypeOf<PersistenceEnginePort["fence"]>().toEqualTypeOf<(owner: PersistenceOwner, deadline: number) => readonly Handle[]>();
  expectTypeOf<PersistenceEnginePort["fenceTarget"]>().toEqualTypeOf<(owner: PersistenceOwner, id: RecordId, deadline: number) => readonly Handle[]>();
  expectTypeOf<PersistenceEnginePort["reconcile"]>().toEqualTypeOf<(ticket: PublicationTicket) => ReturnType<PersistenceEnginePort["publish"]>>();
  expectTypeOf<PersistenceReadPort["open"]>().toEqualTypeOf<(owner: PersistenceOwner, id: RecordId, revision: RecordRevision) => Promise<Handle>>();
  expectTypeOf<AtomicStore>().toExtend<PersistenceEnginePort & PersistenceReadPort>();
});
it("passes the backend explicitly and retains each concrete port", () => {
  expectTypeOf<PersistenceBackend["imports"]["reconcile"]>().toEqualTypeOf<PersistenceEnginePort["reconcile"]>();
  expectTypeOf<PersistenceBackend["evidence"]["capture"]>().returns.toHaveProperty("scope");
});
```

The maximum-workload case uses one 256 KiB chunk; actual process RSS and SSD latency remain the T7 measurement gate.

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/persistence/atomic-store.test.ts src/main/plugins/persistence/contract.test.ts
```

Expected: FAIL because `AtomicStore` does not yet exist.

- [ ] **Step 6: Implement immutable publication and read handles**

Create `apps/desktop/src/main/plugins/persistence/atomic-store.ts`:

```ts
import { createHash, randomUUID, type Hash } from "node:crypto";
import type { Handle, RecordId, RecordRevision, RecordMeta, SettingsSnapshot } from "@kobrixa/plugin-protocol";
import type { PersistenceOwner } from "@kobrixa/plugin-runtime";
import { PublicationGate, ownerKey, type PublicationTicket, type PersistenceEnginePort, type PersistenceReadPort, type ImportTag } from "./engine-port.js";
import { NodePersistenceFs, writeAll, type StoreFd, type StorePath } from "./filesystem.js";
import { Namespace, parseHead, liveRecord, importTagSchema, type DiskHead, type Location } from "./namespace.js";
import { QuotaLedger } from "./quota.js";
import { scanNamespace, garbageCandidates } from "./recovery-scan.js";
import type { DurableImportPort, ImportPlan, ImportItemEvidence, PersistenceEvidencePort, StoredRecovery, PersistenceBarrier, PersistenceBarrierEvidence } from "./engine-port.js";
import { importDocumentSchema, importPlanSchema, importItemEvidenceSchema, storedRecoverySchema } from "./namespace.js";
type Outcome = Awaited<ReturnType<PersistenceEnginePort["publish"]>>;
type Entry = { ticket: PublicationTicket; signature: string; ns: Namespace; location: Location; old: DiskHead | null; size: number;
  fd: StoreFd | null; temp: StorePath; object: StorePath | null; gate: PublicationGate; hash: Hash; received: number; last: { offset: number; bytes: Uint8Array } | null;
  created: number; progress: number; state: "receiving" | "sealed" | "publishing" | "committed" | "unknown" | "aborted"; busy: boolean;
  head: DiskHead | null; accounted: boolean; finished: number | null; oldHeld: boolean; cleaned: boolean; tag?: ImportTag };
type Pin = { owner: string; source: string; ns: Namespace; path: StorePath; fd: StoreFd; length: number; created: number; used: number; busy: Promise<unknown> };
type Page = { owner: string; source: string; kind: string | undefined; limit: number; entries: RecordMeta[]; created: number; used: number; bytes: number; tokens: Map<number, string> };
export class AtomicStore implements PersistenceEnginePort, PersistenceReadPort {
  readonly quota = new QuotaLedger();
  private readonly namespaces = new Map<string, Promise<Namespace>>();
  private readonly blockedSources = new Map<string,string>();
  private readonly failedReserves = new Map<string, { ticket: PublicationTicket; ns: Namespace }>();
  private readonly entries = new Map<string, Entry>(); private readonly targets = new Map<string, string>();
  private readonly frozen = new Map<string, number>(); private readonly frozenTargets = new Map<string, number>();
  private readonly uncertain = new Map<string, string>(); private readonly publication = new Map<string, Promise<unknown>>();
  private readonly pins = new Map<string, Pin>(); private readonly closed = new Map<string, { owner: string; until: number }>();
  private readonly pages = new Set<Page>(); private readonly cursors = new Map<string, { page: Page; offset: number }>();
  private readonly gcHeld = new Map<string, { source: string; key: string }>();
  constructor(readonly fs: NodePersistenceFs) {}
  async initialize(): Promise<void> {
    this.fs.profile.assertHeld();
    for (const dir of await this.fs.entries(this.fs.path("namespaces"), 4096)) {
      if (!dir.directory || !/^[0-9a-f]{64}$/.test(dir.name)) throw new Error("corrupt");
      const identity = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await this.fs.bytes(this.fs.path("namespaces", dir.name, "identity.json"), 4096))) as { sourceKey?: unknown; formatVersion?: unknown };
      if (identity.formatVersion !== 1) throw new Error("unsupported-format");
      if (typeof identity.sourceKey !== "string") throw new Error("identity-mismatch");
      const ns = await this.ns(identity.sourceKey); if (ns.hash !== dir.name) throw new Error("identity-mismatch");
    }
    if(this.blockedSources.size)throw new Error("recovery-blocked");
  }
  private ns(source: string): Promise<Namespace> {
    let pending = this.namespaces.get(source);
    if (!pending) {
      pending = Namespace.open(this.fs, source).then(async ns => {
        try {
          const scanned=await scanNamespace(ns,this.fs.profile.hostEpoch);this.quota.restore(source,scanned.totals);
          if(scanned.problems.length)this.blockedSources.set(source,scanned.problems[0]!);
        }catch(e){this.blockedSources.set(source,e instanceof Error?e.message:"corrupt");}
        return ns;
      }); this.namespaces.set(source, pending);
    }
    return pending;
  }
  private targetKey(t: PublicationTicket): string { return JSON.stringify([t.owner.sourceKey, t.target.kind, t.target.kind === "record" ? t.target.id : t.target.kind === "settings" ? "settings" : t.target.key]); }
  private releaseTarget(t: PublicationTicket): void { const key = this.targetKey(t); if (this.targets.get(key) === t.id) this.targets.delete(key); }
  private admitted(t: PublicationTicket): void {
    this.fs.profile.assertHeld();
    if (t.owner.hostEpoch !== this.fs.profile.hostEpoch || this.frozen.has(ownerKey(t.owner)) || (t.target.kind === "record" && this.frozenTargets.has(JSON.stringify([ownerKey(t.owner), t.target.id])))) throw new Error("stale");
    if(this.blockedSources.has(t.owner.sourceKey))throw new Error(this.blockedSources.get(t.owner.sourceKey));
    if (this.uncertain.has(t.owner.sourceKey)) throw new Error("publish-uncertain");
  }
  private entry(t: PublicationTicket): Entry {
    const e = this.entries.get(t.id); if (!e || e.signature !== JSON.stringify(t)) throw new Error("stale");
    if (e.finished !== null && e.finished + 120000 <= this.fs.now() && (e.cleaned || e.state === "aborted")) { this.entries.delete(t.id); throw new Error("stale"); }
    return e;
  }
  private live(e: Entry): void {
    if (e.state === "aborted" || this.fs.now() >= Math.min(e.created + 120000, e.progress + 30000, e.gate.deadline)) throw new Error("expired");
  }
  private cas(t: PublicationTicket, head: DiskHead | null): void {
    if (t.target.kind === "record" || t.target.kind === "settings") {
      if ((head?.receipt.revision ?? null) !== t.target.expectedRevision) throw new Error("revision-mismatch");
    }
  }
  private async prune(): Promise<void> {
    const now = this.fs.now();
    for (const failed of this.failedReserves.values()) await this.abort(failed.ticket).catch(() => {});
    for (const [id, e] of this.entries) if (e.finished !== null && e.finished + 120000 <= now && !e.busy && (e.cleaned || e.state === "aborted")) this.entries.delete(id);
    for (const [id, pin] of this.pins) if (now >= Math.min(pin.created + 120000, pin.used + 30000)) await this.closePin(id, pin);
    for (const [id, c] of this.closed) if (c.until <= now) this.closed.delete(id);
    for (const page of this.pages) if (now >= Math.min(page.created + 120000, page.used + 30000)) {
      this.pages.delete(page); for (const token of page.tokens.values()) this.cursors.delete(token);
    }
    for (const e of this.entries.values()) if ((e.state === "receiving" || e.state === "sealed") && !e.busy && now >= Math.min(e.created + 120000, e.progress + 30000, e.gate.deadline)) await this.abort(e.ticket);
  }
  async reserve(ticket: PublicationTicket, byteLength: number, memory?: SharedArrayBuffer, byteOffset=0): Promise<void> {
    await this.prune(); this.admitted(ticket);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > (ticket.metadata.kind === "record" ? 8388608 : ticket.metadata.kind === "settings" ? 69632 : 2097152)) throw new Error("size-limit");
    if (this.entries.has(ticket.id) || this.failedReserves.has(ticket.id) || this.entries.size + this.failedReserves.size >= 1024 || [...this.entries.values()].filter(e => e.ticket.owner.sourceKey === ticket.owner.sourceKey).length >= 64) throw new Error("quota");
    if (ticket.metadata.kind !== ticket.target.kind) throw new Error("invalid-target");
    const targetKey = this.targetKey(ticket); if (ticket.target.kind !== "settings" && this.targets.has(targetKey)) throw new Error("write-in-progress");
    if (ticket.target.kind !== "settings") this.targets.set(targetKey, ticket.id);
    let held: { source: string; key: string } | null = null;
    let opened: StoreFd | null = null; let allocated: Namespace | null = null;
    try {
      const ns = await this.ns(ticket.owner.sourceKey), location = await ns.location(ticket.target, true), old = await ns.head(location);
      this.admitted(ticket); this.cas(ticket, old);
      if (old) { await ns.verify(location, old); if (old.object) { const key = this.fs.name(ns.object(location, old)); this.quota.holdTemporary(ticket.owner.sourceKey, key, old.byteLength); held = { source: ticket.owner.sourceKey, key }; } }
      await this.fs.at("reserve", async () => { this.quota.reserve(ticket.id, ticket.owner.sourceKey, { bytes: ticket.metadata.kind === "record" ? byteLength : 0, create: ticket.target.kind === "record" && old === null, metadata: 32768 + (ticket.metadata.kind === "record" ? 0 : byteLength), lane: ticket.metadata.kind === "record" ? "write" : "metadata" }, (await this.fs.statfs(ns.path())).availableBytes); });
      allocated = ns; await this.fs.mkdir(ns.path("staging", ticket.id));
      await ns.writeNew(ns.path("staging", ticket.id, "intent.json"), { formatVersion: 1, ticket, byteLength });
      const temp = ns.path("staging", ticket.id, "payload.tmp");
      await this.fs.at("open-temp", async () => { opened = await this.fs.open(temp, "create-exclusive"); });
      const fd = opened;
      const frozen = JSON.parse(JSON.stringify(ticket)) as PublicationTicket;
      this.entries.set(ticket.id, { ticket: frozen, signature: JSON.stringify(ticket), ns, location, old, size: byteLength, fd, temp, object: null,
        gate: new PublicationGate(ticket.deadlineMonotonicMs, memory, byteOffset), hash: createHash("sha256"), received: 0, last: null, created: this.fs.now(), progress: this.fs.now(), state: "receiving", busy: false, head: null, accounted: false, finished: null, oldHeld: held !== null, cleaned: false });
    } catch (e) {
      if (opened) await this.fs.close(opened).catch(() => {});
      let clean = true;
      if (allocated) for (const name of ["payload.tmp", "sealed.json", "import-tag.json", "intent.json"]) {
        const p = allocated.path("staging", ticket.id, name);
        try { if (await this.fs.exists(p)) await this.fs.unlink(p); } catch { clean = false; }
      }
      if (clean && allocated) { try { await this.fs.removeEmpty(allocated.path("staging", ticket.id)); } catch { clean = false; } }
      if (clean) { this.releaseTarget(ticket); this.quota.release(ticket.id); }
      else this.failedReserves.set(ticket.id, { ticket: structuredClone(ticket), ns: allocated! });
      if (held) this.quota.releaseTemporary(held.source, held.key); throw e;
    }
  }
  async append(ticket: PublicationTicket, offset: number, bytes: Uint8Array): Promise<number> {
    const e = this.entry(ticket); this.live(e);
    if (e.state !== "receiving" || e.busy) throw new Error("sealed");
    if (bytes.length < 1 || bytes.length > 262144) throw new Error("size-limit");
    if (e.last && offset === e.last.offset && Buffer.from(bytes).equals(Buffer.from(e.last.bytes))) return e.received;
    if (offset !== e.received || offset + bytes.length > e.size) throw new Error("offset-mismatch");
    e.busy = true;
    try {
      this.live(e);
      await this.fs.at("chunk-write", () => writeAll(this.fs, e.fd!, offset, bytes)); e.hash.update(bytes); e.received += bytes.length;
      e.last = { offset, bytes: Uint8Array.from(bytes) }; e.progress = this.fs.now(); return e.received;
    } finally { e.busy = false; }
  }
  async seal(ticket: PublicationTicket, byteLength: number, sha256: string): Promise<void> {
    const e = this.entry(ticket); this.live(e); if (e.state === "sealed") { if (byteLength !== e.size || e.hash.copy().digest("hex") !== sha256) throw new Error("checksum-mismatch"); return; }
    if (e.state !== "receiving" || e.busy) throw new Error("sealed");
    if (byteLength !== e.size || e.received !== e.size) throw new Error("incomplete");
    if (e.hash.copy().digest("hex") !== sha256) throw new Error("checksum-mismatch");
    e.busy = true;
    try {
      await this.fs.at("seal-sync", () => this.fs.sync(e.fd!)); await this.fs.close(e.fd!); e.fd = null; e.state = "sealed";
      await e.ns.writeNew(e.ns.path("staging", ticket.id, "sealed.json"), { formatVersion: 1, byteLength, sha256 });
      await this.fs.syncDirectory(e.ns.path("staging", ticket.id)); e.state = "sealed"; e.progress = this.fs.now(); e.last = null;
    } finally { e.busy = false; }
  }
  fence(owner: PersistenceOwner, deadlineMonotonicMs: number): readonly Handle[] {
    const key = ownerKey(owner), deadline = Math.min(this.frozen.get(key) ?? Infinity, deadlineMonotonicMs); this.frozen.set(key, deadline);
    const accepted: string[] = [];
    for (const e of this.entries.values()) if (ownerKey(e.ticket.owner) === key && e.finished === null) { e.gate.shorten(deadline, this.fs.now()); accepted.push(e.ticket.id); }
    return Object.freeze(accepted);
  }
  fenceTarget(owner: PersistenceOwner, id: RecordId, deadlineMonotonicMs: number): readonly Handle[] {
    const key = JSON.stringify([ownerKey(owner), id]), deadline = Math.min(this.frozenTargets.get(key) ?? Infinity, deadlineMonotonicMs); this.frozenTargets.set(key, deadline);
    const accepted: string[] = [];
    for (const e of this.entries.values()) if (ownerKey(e.ticket.owner) === ownerKey(owner) && e.ticket.target.kind === "record" && e.ticket.target.id === id && e.finished === null) { e.gate.shorten(deadline, this.fs.now()); accepted.push(e.ticket.id); }
    return Object.freeze(accepted);
  }
  async publish(ticket: PublicationTicket): Promise<Outcome> {
    const e = this.entry(ticket);
    if (e.state === "committed") return { disposition: "committed", receipt: e.head!.receipt };
    if (e.state === "unknown" || e.state === "publishing") return this.reconcile(ticket);
    const previous = this.publication.get(ticket.owner.sourceKey) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => this.publishOne(e)); this.publication.set(ticket.owner.sourceKey, run);
    return run;
  }
  private async publishOne(e: Entry): Promise<Outcome> {
    if (e.state !== "sealed") return { disposition: "not-committed" };
    try { this.live(e); } catch { return { disposition: "not-committed" }; }
    if (this.uncertain.has(e.ticket.owner.sourceKey)) return { disposition: "unknown" };
    e.busy = true;
    try {
      const { ticket: t, ns, location: loc } = e;
      const revision = t.metadata.kind === "record" ? t.metadata.record.revision : "r_" + randomUUID().replaceAll("-", "");
      const deleted = t.metadata.kind === "record" && t.metadata.deleted;
      if (!e.head) e.head = { formatVersion: 1, metadata: t.metadata, target: t.target, object: deleted ? null : `${revision}.${t.metadata.kind === "record" ? "bin" : "json"}`,
        byteLength: e.size, sha256: e.hash.copy().digest("hex"), receipt: { revision, commitId: randomUUID(), durability: this.fs.durability }, ...(e.tag ? { importTag: e.tag } : {}) };
      parseHead(Buffer.from(JSON.stringify(e.head)));
      if (!deleted && !e.object) {
        this.live(e);
        const destination = ns.object(loc, e.head);
        if (await this.fs.exists(destination)) throw new Error("revision-mismatch");
        await this.fs.at("object-rename", async () => { await this.fs.atomicReplace(e.temp, destination); e.object = destination; });
        await this.fs.at("object-dir-sync", async () => { await this.fs.syncDirectory(loc.objects); await this.fs.syncDirectory(ns.path("staging", t.id)); });
      }
      this.live(e); const current = await ns.head(loc); this.cas(t, current);
      if (current) {
        await this.fs.at("backup-head", async () => {
        const backup = ns.path(...loc.parts, `${loc.name}.${t.id}.backup`);
        if (await this.fs.exists(backup)) await this.fs.unlink(backup);
        await ns.writeNew(backup, current); await this.fs.atomicReplace(backup, loc.previous); await this.fs.syncDirectory(loc.directory); });
      }
      const headTemp = ns.path(...loc.parts, `${loc.name === "head.json" ? "head" : loc.name}.${t.id}.tmp`);
      if (await this.fs.exists(headTemp)) await this.fs.unlink(headTemp);
      await this.fs.at("head-write", () => ns.writeNew(headTemp, e.head));
      await this.fs.fault("before-publish"); this.live(e); this.cas(t, await ns.head(loc));
      if (!e.gate.dispatch(this.fs.now())) return { disposition: "not-committed" };
      e.state = "publishing"; this.uncertain.set(t.owner.sourceKey, t.id);
      if (t.metadata.kind === "import") await this.fs.at("import-marker", () => this.fs.atomicReplace(headTemp, loc.head));
      else await this.fs.atomicReplace(headTemp, loc.head);
      await this.fs.fault("after-publish"); await this.fs.at("head-dir-sync", () => this.fs.syncDirectory(loc.directory));
      await this.fs.at("cache-publish", async () => { this.confirm(e); });
      await this.cleanup(e, true).catch(() => { /* Committed receipt survives; referenced bytes keep their charge. */ });
      await this.fs.fault("receipt-send"); return { disposition: "committed", receipt: e.head.receipt };
    } catch (error) {
      if (e.gate.dispatched) { e.state = "unknown"; this.uncertain.set(e.ticket.owner.sourceKey, e.ticket.id); return { disposition: "unknown" }; }
      throw error;
    } finally { e.busy = false; }
  }
  private confirm(e: Entry): void {
    if (!e.accounted) {
      const oldRecord = liveRecord(e.old), nextRecord = liveRecord(e.head);
      const size = (h: DiskHead | null) => h ? Buffer.byteLength(JSON.stringify(h)) + (h.metadata.kind === "record" ? 0 : h.byteLength) : 0;
      this.quota.commit(e.ticket.id, { committed: (nextRecord?.byteLength ?? 0) - (oldRecord?.byteLength ?? 0), records: Number(nextRecord !== null) - Number(oldRecord !== null), metadata: size(e.head) - size(e.old) + 32768, temporary: 0 }); e.accounted = true;
    }
    e.state = "committed"; e.finished ??= this.fs.now(); this.uncertain.delete(e.ticket.owner.sourceKey); this.releaseTarget(e.ticket);
  }
  async reconcile(ticket: PublicationTicket): Promise<Outcome> {
    const e = this.entry(ticket);
    if (e.busy && e.gate.dispatched) return { disposition: "unknown" };
    if (!e.gate.dispatched) return { disposition: "not-committed" };
    try {
      const current = await e.ns.head(e.location);
      if (current && e.head && current.receipt.commitId === e.head.receipt.commitId) {
        await e.ns.verify(e.location, current); await this.fs.syncDirectory(e.location.directory); this.confirm(e);
        return { disposition: "committed", receipt: current.receipt };
      }
      if ((current?.receipt.commitId ?? null) === (e.old?.receipt.commitId ?? null)) {
        if (current) await e.ns.verify(e.location, current);
        this.uncertain.delete(e.ticket.owner.sourceKey); e.state = "sealed";
        await this.abortKnownUnpublished(e); return { disposition: "not-committed" };
      }
    } catch { /* Evidence remains fenced. Permission failures are not corruption repair. */ }
    this.uncertain.set(ticket.owner.sourceKey, ticket.id); return { disposition: "unknown" };
  }
  async abort(ticket: PublicationTicket): Promise<"aborted" | "committed" | "unknown"> {
    const failed = this.failedReserves.get(ticket.id);
    if (failed) {
      if (JSON.stringify(ticket) !== JSON.stringify(failed.ticket)) throw new Error("stale");
      for (const name of ["payload.tmp", "sealed.json", "import-tag.json", "intent.json"]) { const p = failed.ns.path("staging", ticket.id, name); if (await this.fs.exists(p)) await this.fs.unlink(p); }
      await this.fs.removeEmpty(failed.ns.path("staging", ticket.id));
      this.quota.release(ticket.id); this.releaseTarget(ticket); this.failedReserves.delete(ticket.id); return "aborted";
    }
    const e = this.entry(ticket); e.gate.shorten(this.fs.now(), this.fs.now());
    if (e.state === "committed") return "committed";
    if (e.busy) return "unknown";
    if (e.gate.dispatched && e.state !== "aborted") {
      const result = await this.reconcile(ticket); if (result.disposition === "committed") return "committed"; if (result.disposition === "unknown") return "unknown";
    }
    await this.abortKnownUnpublished(e); return "aborted";
  }
  private async abortKnownUnpublished(e: Entry): Promise<void> {
    const prior = this.publication.get(e.ticket.owner.sourceKey) ?? Promise.resolve();
    const cleanup = prior.catch(() => {}).then(() => this.removeUnpublished(e));
    this.publication.set(e.ticket.owner.sourceKey, cleanup); await cleanup;
  }
  private async removeUnpublished(e: Entry): Promise<void> {
    if (e.fd) { await this.fs.close(e.fd); e.fd = null; }
    // Release reservations only after bytes have been removed; an unlink failure keeps the slot.
    for (const p of [e.temp, e.object, e.ns.path(...e.location.parts, `${e.location.name === "head.json" ? "head" : e.location.name}.${e.ticket.id}.tmp`), e.ns.path(...e.location.parts, `${e.location.name}.${e.ticket.id}.backup`), e.ns.path("staging", e.ticket.id, "sealed.json"), e.ns.path("staging", e.ticket.id, "intent.json")]) if (p && await this.fs.exists(p)) await this.fs.unlink(p);
    const current = await e.ns.head(e.location);
    if (current?.receipt.commitId === e.old?.receipt.commitId && await this.fs.exists(e.location.previous)) {
      const backup = parseHead(await this.fs.bytes(e.location.previous, 8192));
      if (backup.receipt.commitId === current?.receipt.commitId) await this.fs.unlink(e.location.previous);
    }
    await this.fs.removeEmpty(e.ns.path("staging", e.ticket.id));
    this.quota.release(e.ticket.id); this.releaseOld(e); e.state = "aborted"; e.finished ??= this.fs.now(); this.releaseTarget(e.ticket);
  }
  private releaseOld(e: Entry): void {
    if (e.oldHeld && e.old?.object) { this.quota.releaseTemporary(e.ticket.owner.sourceKey, this.fs.name(e.ns.object(e.location, e.old))); e.oldHeld = false; }
  }
  private async cleanup(e: Entry, serialized = false): Promise<void> {
    if (!serialized) {
      const prior = this.publication.get(e.ticket.owner.sourceKey) ?? Promise.resolve();
      const cleanup = prior.catch(() => {}).then(() => this.cleanup(e, true));
      this.publication.set(e.ticket.owner.sourceKey, cleanup); await cleanup; return;
    }
    if (e.cleaned) return;
    await this.fs.at("cleanup", async () => {
    if ((await e.ns.head(e.location))?.receipt.commitId === e.head?.receipt.commitId && await this.fs.exists(e.location.previous)) await this.fs.unlink(e.location.previous);
    for (const name of ["payload.tmp", "sealed.json", "import-tag.json", "intent.json"]) { const p = e.ns.path("staging", e.ticket.id, name); if (await this.fs.exists(p)) await this.fs.unlink(p); }
    if (e.old?.object) {
      const p = e.ns.object(e.location, e.old), key = this.fs.name(p);
      if ([...this.pins.values()].some(pin => this.fs.name(pin.path) === key)) { this.gcHeld.set(key, { source: e.ticket.owner.sourceKey, key }); e.oldHeld = false; }
      else { if (await this.fs.exists(p)) await this.fs.unlink(p); this.releaseOld(e); }
    }
    await this.fs.removeEmpty(e.ns.path("staging", e.ticket.id));
    await this.fs.syncDirectory(e.location.directory);
    });
    this.quota.adjustMetadata(e.ticket.owner.sourceKey, -32768); e.cleaned = true;
  }
  private async settled(owner: PersistenceOwner): Promise<Namespace> {
    if (owner.hostEpoch !== this.fs.profile.hostEpoch) throw new Error("stale");
    await this.prune(); const id = this.uncertain.get(owner.sourceKey);
    if (id) { const e = this.entries.get(id)!; if ((await this.reconcile(e.ticket)).disposition === "unknown") throw new Error("publish-uncertain"); }
    return this.ns(owner.sourceKey);
  }
  async settings(owner: PersistenceOwner): Promise<SettingsSnapshot | null> {
    const ns = await this.settled(owner), loc = await ns.location({ kind: "settings", expectedRevision: null }), head = await ns.head(loc);
    if (!head) return null; await ns.verify(loc, head);
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await this.fs.bytes(ns.object(loc, head), 69632))) as { formatVersion: number; schemaVersion: number; validationDigest: string; values: SettingsSnapshot["values"] };
    if (body.formatVersion !== 1) throw new Error("unsupported-format");
    if (head.metadata.kind !== "settings" || body.schemaVersion !== head.metadata.schemaVersion || body.validationDigest !== head.metadata.validationDigest || Buffer.byteLength(JSON.stringify(body.values)) > 65536) throw new Error("corrupt");
    return { schemaVersion: body.schemaVersion, revision: head.receipt.revision, values: body.values };
  }
  async stat(owner: PersistenceOwner, id: RecordId): Promise<RecordMeta> {
    const ns = await this.settled(owner), loc = await ns.location({ kind: "record", id, expectedRevision: null }), head = await ns.head(loc), record = liveRecord(head);
    if (!head || !record) throw new Error("not-found"); await ns.verify(loc, head); return structuredClone(record);
  }
  async open(owner: PersistenceOwner, id: RecordId, revision: RecordRevision): Promise<Handle> {
    const ns = await this.settled(owner);
    if ([...this.pins.values()].filter(p => p.source === owner.sourceKey).length >= 4) throw new Error("quota");
    const loc = await ns.location({ kind: "record", id, expectedRevision: revision }), head = await ns.head(loc);
    if (!liveRecord(head) || !head) throw new Error("not-found"); if (head.receipt.revision !== revision) throw new Error("revision-mismatch");
    await ns.verify(loc, head); const p = ns.object(loc, head), key = this.fs.name(p); this.quota.holdTemporary(owner.sourceKey, key, head.byteLength);
    try { const fd = await this.fs.open(p, "read"), pin = randomUUID(); this.pins.set(pin, { owner: ownerKey(owner), source: owner.sourceKey, ns, path: p, fd, length: head.byteLength, created: this.fs.now(), used: this.fs.now(), busy: Promise.resolve() }); return pin; }
    catch (e) { this.quota.releaseTemporary(owner.sourceKey, key); throw e; }
  }
  async read(owner: PersistenceOwner, pin: Handle, offset: number, maxBytes: number): Promise<Uint8Array> {
    await this.prune(); const p = this.pins.get(pin); if (!p || p.owner !== ownerKey(owner)) throw new Error("stale");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > p.length || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 262144) throw new Error("invalid-range");
    const work = p.busy.catch(() => {}).then(async () => { p.used = this.fs.now(); return offset === p.length ? new Uint8Array() : this.fs.read(p.fd, offset, Math.min(maxBytes, p.length - offset)); });
    p.busy = work; return work;
  }
  private async closePin(id: string, p: Pin): Promise<void> {
    this.pins.delete(id); await p.busy.catch(() => {}); await this.fs.close(p.fd);
    const key = this.fs.name(p.path); this.quota.releaseTemporary(p.source, key);
    if (![...this.pins.values()].some(pin => this.fs.name(pin.path) === key) && this.gcHeld.has(key)) {
      try { await this.fs.unlink(p.path); this.quota.releaseTemporary(p.source, key); this.gcHeld.delete(key); } catch { /* Charge and retry evidence stay retained. */ }
    }
    if (this.closed.size < 1024 && [...this.closed.values()].filter(c => c.owner === p.owner).length < 64) this.closed.set(id, { owner: p.owner, until: this.fs.now() + 120000 });
  }
  async close(owner: PersistenceOwner, pin: Handle): Promise<void> {
    const p = this.pins.get(pin);
    if (!p) { const old = this.closed.get(pin); if (old?.owner === ownerKey(owner) && old.until > this.fs.now()) return; throw new Error("stale"); }
    if (p.owner !== ownerKey(owner)) throw new Error("stale"); await this.closePin(pin, p);
  }
  async list(owner: PersistenceOwner, input: { kind?: string; limit: number; cursor?: Handle }): Promise<{ entries: RecordMeta[]; nextCursor?: Handle }> {
    const ns = await this.settled(owner); if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 64) throw new Error("invalid-range");
    let page: Page, offset = 0;
    if (input.cursor) {
      const cursor = this.cursors.get(input.cursor); if (!cursor || cursor.page.owner !== ownerKey(owner) || cursor.page.kind !== input.kind || cursor.page.limit !== input.limit) throw new Error("stale");
      page = cursor.page; offset = cursor.offset;
    } else {
      if ([...this.pages].filter(p => p.source === owner.sourceKey).length >= 4) throw new Error("quota");
      const entries: RecordMeta[] = [];
      for (const loc of await ns.locations()) { const r = liveRecord(await ns.head(loc)); if (r && (input.kind === undefined || input.kind === r.kind)) entries.push(structuredClone(r)); }
      entries.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const bytes = Buffer.byteLength(JSON.stringify(entries));
      if ([...this.pages].filter(p => p.source === owner.sourceKey).reduce((n, p) => n + p.bytes, bytes) > 524288 || [...this.pages].reduce((n, p) => n + p.bytes, bytes) > 8388608) throw new Error("quota");
      page = { owner: ownerKey(owner), source: owner.sourceKey, kind: input.kind, limit: input.limit, entries, created: this.fs.now(), used: this.fs.now(), bytes, tokens: new Map() }; this.pages.add(page);
    }
    page.used = this.fs.now(); const entries = page.entries.slice(offset, offset + page.limit), next = offset + entries.length;
    if (next === page.entries.length) return { entries: structuredClone(entries) };
    let token = page.tokens.get(next); if (!token) { token = randomUUID(); page.tokens.set(next, token); this.cursors.set(token, { page, offset: next }); }
    const result = { entries: structuredClone(entries), nextCursor: token };
    if (Buffer.byteLength(JSON.stringify({ ok: true, value: result })) > 262144) throw new Error("size-limit"); return result;
  }
  async tagImport(ticket: PublicationTicket, tag: ImportTag): Promise<void> {
    const e = this.entry(ticket); this.live(e);
    if (e.state !== "receiving" || e.received !== 0 || e.busy || e.tag) throw new Error("sealed");
    e.busy=true;
    try {
      const parsed=importTagSchema.parse(tag);
      const saved=await this.loadImport(ticket.owner,parsed.importId);
      const item=saved?.plan.items.find(i=>i.key===parsed.itemKey);
      if (!item || JSON.stringify(item.ticket)!==JSON.stringify(ticket) || JSON.stringify(item.tag)!==JSON.stringify(parsed)) throw new Error("input-changed");
      // Persist the immutable binding before append can be admitted. The published head includes it.
      await e.ns.writeNew(e.ns.path("staging",ticket.id,"import-tag.json"),{formatVersion:1,tag:parsed});
      await this.fs.syncDirectory(e.ns.path("staging",ticket.id)); e.tag=parsed;
    } finally { e.busy=false; }
  }
  async importReceipts(owner:PersistenceOwner,id:string):ReturnType<DurableImportPort["importReceipts"]> {
    const saved=await this.loadImport(owner,id); if (!saved) return [];
    const ns=await this.ns(owner.sourceKey), receipts:Awaited<ReturnType<DurableImportPort["importReceipts"]>>[number][]=[];
    for (let offset=0;offset<saved.plan.items.length;offset+=64) {
      for (const item of saved.plan.items.slice(offset,offset+64)) {
        const loc=await ns.location(item.ticket.target), head=await ns.head(loc);
        if (!head?.importTag || JSON.stringify(head.importTag)!==JSON.stringify(item.tag)) continue;
        await ns.verify(loc,head);
        if (head.sha256!==item.mappedSha256 || head.byteLength!==item.byteLength) throw new Error("input-changed");
        receipts.push({tag:item.tag,ticket:item.ticket,receipt:head.receipt});
      }
    }
    if (Buffer.byteLength(JSON.stringify(receipts))>2097152) throw new Error("size-limit");
    return receipts;
  }
  async auxiliary(owner: PersistenceOwner, kind: "import" | "recovery", key: string): Promise<Uint8Array | null> {
    const ns = await this.settled(owner), loc = await ns.location({ kind, key }), head = await ns.head(loc);
    if (!head) return null; await ns.verify(loc, head); return this.fs.bytes(ns.object(loc, head), 2097152);
  }
  private readonly importMutations=new Map<string,Promise<unknown>>();
  private mutateImport<T>(owner:PersistenceOwner,id:string,run:()=>Promise<T>):Promise<T> {
    const key=JSON.stringify([owner.sourceKey,id]),previous=this.importMutations.get(key)??Promise.resolve();
    const result=previous.catch(()=>{}).then(run);this.importMutations.set(key,result);
    void result.finally(()=>{if(this.importMutations.get(key)===result)this.importMutations.delete(key);}).catch(()=>{});return result;
  }
  planImport(owner:PersistenceOwner,plan:ImportPlan):Promise<void>{return this.mutateImport(owner,plan.id,()=>this.planImportOne(owner,plan));}
  recordImport(owner:PersistenceOwner,id:string,evidence:ImportItemEvidence):Promise<void>{return this.mutateImport(owner,id,()=>this.recordImportOne(owner,id,evidence));}
  completeImport(owner:PersistenceOwner,id:string):Promise<void>{return this.mutateImport(owner,id,()=>this.completeImportOne(owner,id));}
  private async writeDocument(owner:PersistenceOwner,kind:"import"|"recovery",key:string,value:unknown):Promise<void> {
    const bytes=Buffer.from(JSON.stringify(value));
    if (bytes.length>2097152 || Buffer.byteLength(key)>128) throw new Error("size-limit");
    const t:PublicationTicket={id:randomUUID(),owner,deadlineMonotonicMs:this.fs.now()+10000,
      metadata:{kind,key},target:{kind,key}};
    await this.reserve(t,bytes.length);
    for (let offset=0;offset<bytes.length;offset+=262144) await this.append(t,offset,bytes.subarray(offset,offset+262144));
    await this.seal(t,bytes.length,createHash("sha256").update(bytes).digest("hex"));
    let result=await this.publish(t);
    if (result.disposition==="unknown") result=await this.reconcile(t);
    if (result.disposition!=="committed") throw new Error(result.disposition==="unknown"?"publish-uncertain":"not-committed");
  }
  async loadImport(owner:PersistenceOwner,id:string):ReturnType<DurableImportPort["load"]> {
    if (Buffer.byteLength(id)>128 || !id) throw new Error("size-limit");
    const bytes=await this.auxiliary(owner,"import",id); if (!bytes) return null;
    const raw=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
    if (raw.formatVersion!==1) throw new Error("unsupported-format");
    const saved=importDocumentSchema.parse(raw);
    if (saved.plan.id!==id || saved.plan.targetSourceKey!==owner.sourceKey) throw new Error("input-changed");
    return {plan:saved.plan,items:saved.items,complete:saved.complete};
  }
  private async planImportOne(owner:PersistenceOwner,plan:ImportPlan):Promise<void> {
    importPlanSchema.parse(plan);
    if (plan.targetSourceKey!==owner.sourceKey || plan.items.some(i=>ownerKey(i.ticket.owner)!==ownerKey(owner))) throw new Error("stale");
    const old=await this.loadImport(owner,plan.id);
    if (old) { if (JSON.stringify(old.plan)!==JSON.stringify(plan)) throw new Error("input-changed"); return; }
    await this.writeDocument(owner,"import",plan.id,{formatVersion:1,plan,items:plan.items.map(i=>({key:i.key,state:"pending",receipt:null,skipReason:null})),complete:false});
  }
  private async recordImportOne(owner:PersistenceOwner,id:string,evidence:ImportItemEvidence):Promise<void> {
    importItemEvidenceSchema.parse(evidence);
    const saved=await this.loadImport(owner,id); if (!saved) throw new Error("not-found");
    const index=saved.plan.items.findIndex(i=>i.key===evidence.key); if (index<0 || saved.complete) throw new Error("stale");
    if (evidence.state==="committed") {
      const receipt=(await this.importReceipts(owner,id)).find(r=>r.tag.itemKey===evidence.key);
      if (!receipt || JSON.stringify(receipt.receipt)!==JSON.stringify(evidence.receipt)) throw new Error("input-changed");
    }
    const prior=saved.items[index]!;
    if ((prior.state==="committed" || prior.state==="skipped") && JSON.stringify(prior)!==JSON.stringify(evidence)) throw new Error("input-changed");
    const items=[...saved.items]; items[index]=evidence;
    await this.writeDocument(owner,"import",id,{formatVersion:1,...saved,items});
  }
  async reconcileImport(ticket:PublicationTicket):ReturnType<PersistenceEnginePort["reconcile"]> {
    if (this.entries.has(ticket.id)) return this.reconcile(ticket);
    // A prior epoch's original ticket is evidence, never a fresh writable capability.
    const ns=await this.ns(ticket.owner.sourceKey);
    for (const loc of await ns.locations()) {
      const h=await ns.head(loc);
      if (h?.target.kind!=="import") continue;
      const saved=await this.loadImport({...ticket.owner,hostEpoch:this.fs.profile.hostEpoch},h.target.key);
      const item=saved?.plan.items.find(i=>i.ticket.id===ticket.id);
      if (!item) continue;
      if (JSON.stringify(item.ticket)!==JSON.stringify(ticket)) throw new Error("stale");
      const receipt=(await this.importReceipts({...ticket.owner,hostEpoch:this.fs.profile.hostEpoch},saved!.plan.id)).find(r=>r.ticket.id===ticket.id);
      if (receipt) return {disposition:"committed",receipt:receipt.receipt};
      const evidence=saved!.items.find(i=>i.key===item.key);
      if (evidence?.state==="committed" && evidence.receipt) return {disposition:"committed",receipt:evidence.receipt};
      const head=await ns.head(await ns.location(ticket.target));
      if ((ticket.target.kind==="record" || ticket.target.kind==="settings") && (head?.receipt.revision??null)===ticket.target.expectedRevision) return {disposition:"not-committed"};
      return {disposition:"unknown"};
    }
    throw new Error("stale");
  }
  private async completeImportOne(owner:PersistenceOwner,id:string):Promise<void> {
    const saved=await this.loadImport(owner,id); if (!saved) throw new Error("not-found"); if (saved.complete) return;
    const receipts=await this.importReceipts(owner,id);
    const items=saved.items.map(e=>{
      const r=receipts.find(r=>r.tag.itemKey===e.key);
      return r?{key:e.key,state:"committed" as const,receipt:r.receipt,skipReason:null}:e;
    });
    if (items.length!==saved.plan.items.length || items.some(e=>e.state!=="committed" && e.state!=="skipped")) throw new Error("incomplete");
    await this.writeDocument(owner,"import",id,{formatVersion:1,...saved,items,complete:true});
  }
  async settingsDigest(owner:PersistenceOwner):ReturnType<PersistenceEvidencePort["settingsDigest"]> {
    const ns=await this.settled(owner),loc=await ns.location({kind:"settings",expectedRevision:null}),head=await ns.head(loc);
    if (!head) return null; await ns.verify(loc,head);
    if (head.metadata.kind!=="settings") throw new Error("corrupt");
    return {schemaVersion:head.metadata.schemaVersion,validationDigest:head.metadata.validationDigest,revision:head.receipt.revision};
  }
  private readonly evidencePages=new Map<string,{signature:string;items:string[];offset:number;expires:number}>();
  async auxiliaryKeys(owner:PersistenceOwner,kind:"import"|"recovery",cursor?:Handle):ReturnType<PersistenceEvidencePort["auxiliaryKeys"]> {
    const signature=JSON.stringify([ownerKey(owner),kind]); let page;
    if (cursor) { page=this.evidencePages.get(cursor); if (!page || page.signature!==signature || page.expires<=this.fs.now()) throw new Error("stale"); }
    else {
      const ns=await this.ns(owner.sourceKey),items:string[]=[];
      for (const loc of await ns.locations()) {const h=await ns.head(loc);if (h?.target.kind===kind && "key" in h.target) items.push(h.target.key);}
      if (items.length>512 || this.evidencePages.size>=32) throw new Error("quota");
      page={signature,items:items.sort(),offset:0,expires:this.fs.now()+30000};
    }
    const keys=page.items.slice(page.offset,page.offset+64),next=page.offset+keys.length;
    if (next===page.items.length) return {keys,nextCursor:null};
    const nextCursor=randomUUID();this.evidencePages.set(nextCursor,{...page,offset:next});return {keys,nextCursor};
  }
  async saveRecovery(value:StoredRecovery):Promise<void> {
    storedRecoverySchema.parse(value);
    if (value.ticket && value.ticket.owner.sourceKey!==value.owner.sourceKey) throw new Error("stale");
    if (value.sealedPin) {
      const e=value.ticket?this.entries.get(value.ticket.id):undefined;
      if (!e || e.state!=="sealed" || e.received!==e.size) throw new Error("incomplete");
    }
    await this.writeDocument(value.owner,"recovery",value.id,{formatVersion:1,value});
  }
  async recoveryPage(cursor?:Handle):ReturnType<PersistenceEvidencePort["recoveryPage"]> {
    const all:StoredRecovery[]=[];
    for (const pending of this.namespaces.values()) {
      const ns=await pending;
      for (const loc of await ns.locations()) {
        const head=await ns.head(loc);if (head?.target.kind!=="recovery") continue;
        await ns.verify(loc,head);
        const raw=JSON.parse(Buffer.from(await this.fs.bytes(ns.object(loc,head),2097152)).toString("utf8"));
        if (raw.formatVersion!==1) throw new Error("unsupported-format");
        if (raw.removed===true) continue;
        const value=storedRecoverySchema.parse(raw.value);
        // Persisted wall deadlines are never extended on restart. A missing staging pin is checkpoint-only.
        if (value.ticket && value.ticket.owner.hostEpoch!==this.fs.profile.hostEpoch) {
          value.sealedPin=null;
          value.report={...value.report,state:"checkpoint-only",blocker:true,records:value.report.records.map(r=>({...r,payload:"checkpoint-only"}))};
        }
        all.push(value);
      }
    }
    all.sort((a,b)=>a.id.localeCompare(b.id));
    const signature="recovery",page=cursor?this.evidencePages.get(cursor):undefined;
    if (cursor && (!page || page.signature!==signature || page.expires<=this.fs.now())) throw new Error("stale");
    const offset=page?.offset??0,items:StoredRecovery[]=[];
    for (const value of all.slice(offset,offset+64)) {if (Buffer.byteLength(JSON.stringify([...items,value]))>262144) break;items.push(value);}
    const next=offset+items.length;if (next===all.length) return {items,nextCursor:null};
    if (!items.length || this.evidencePages.size>=32) throw new Error("quota");
    const nextCursor=randomUUID();this.evidencePages.set(nextCursor,{signature,items:all.map(v=>v.id),offset:next,expires:this.fs.now()+30000});
    return {items,nextCursor};
  }
  async loadRecovery(id:Handle):Promise<StoredRecovery|null> {
    let cursor:Handle|undefined;
    do {const p=await this.recoveryPage(cursor);const found=p.items.find(v=>v.id===id);if(found)return found;cursor=p.nextCursor??undefined;}while(cursor);
    return null;
  }
  async removeRecovery(id:Handle):Promise<void> {
    const old=await this.loadRecovery(id);if(!old)return;
    await this.writeDocument({...old.owner,hostEpoch:this.fs.profile.hostEpoch},"recovery",id,{formatVersion:1,removed:true,id});
  }
  async flushEvidence(barrier:PersistenceBarrier,tickets:readonly PublicationTicket[]):Promise<PersistenceBarrierEvidence> {
    const accepted=tickets.map(t=>t.id),incomplete:Handle[]=[],unknown:Handle[]=[];
    for (const t of tickets) {
      const e=this.entries.get(t.id);
      if (!e) {unknown.push(t.id);continue;}
      if (this.fs.now()>=barrier.deadlineMonotonicMs || e.state==="unknown" || e.state==="publishing") {
        if ((await this.reconcile(t)).disposition!=="committed") unknown.push(t.id);
      } else if (e.state!=="committed") incomplete.push(t.id);
    }
    const ns=await this.ns(barrier.scope.owner.sourceKey);
    for (const loc of await ns.locations()) {
      const record=liveRecord(await ns.head(loc));
      if (record?.checkpoint==="open" && (barrier.scope.kind==="namespace" || record.id===barrier.scope.recordId)) incomplete.push(record.id);
    }
    return {state:unknown.length?"unknown":incomplete.length?"failed":"saved",accepted,incomplete,unknown};
  }
  fenceTargetOrTicket(ticket:PublicationTicket):void {const e=this.entries.get(ticket.id);if(e && e.signature===JSON.stringify(ticket))e.gate.shorten(this.fs.now(),this.fs.now());}
  unresolvedTicket(id:string):boolean {const e=this.entries.get(id);return !!e && (e.state==="unknown" || e.state==="publishing" || e.busy);}
  async collect(owner: PersistenceOwner): Promise<void> {
    const ns = await this.settled(owner), protectedPaths = new Set<string>();
    for (const e of this.entries.values()) if (e.ticket.owner.sourceKey === owner.sourceKey && e.state === "committed" && !e.cleaned) await this.cleanup(e);
    for (const pin of this.pins.values()) protectedPaths.add(this.fs.name(pin.path));
    for (const e of this.entries.values()) if (e.ticket.owner.sourceKey === owner.sourceKey && e.finished === null) {
      protectedPaths.add(this.fs.name(e.temp)); if (e.object) protectedPaths.add(this.fs.name(e.object)); if (e.old?.object) protectedPaths.add(this.fs.name(ns.object(e.location, e.old)));
    }
    for (const p of await garbageCandidates(ns, protectedPaths)) await this.fs.unlink(p);
  }
  async dispose(): Promise<void> {
    for (const e of this.entries.values()) e.gate.shorten(this.fs.now(), this.fs.now());
    for (const [id, pin] of this.pins) await this.closePin(id, pin);
    for (const e of this.entries.values()) if (e.fd && !e.busy) { await this.fs.close(e.fd); e.fd = null; }
    if (this.failedReserves.size || [...this.entries.values()].some(e => e.busy || e.state === "unknown")) throw new Error("publish-uncertain");
  }
}
```

Do not run the green atomic test yet: the next TDD slice supplies its recovery dependency, rather than a permissive placeholder scanner.

- [ ] **Step 7: Write recovery tests against old/new/unknown evidence**

Create `apps/desktop/src/main/plugins/persistence/recovery-scan.test.ts`:

```ts
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createNodePersistenceFs } from "./filesystem.js";
import { Namespace, type DiskHead } from "./namespace.js";
import { scanNamespace, garbageCandidates } from "./recovery-scan.js";
it("keeps a complete new head, protects pins, and refuses unknown format without destructive repair", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "recover-"));
  try {
    const epoch = randomUUID(), fs = await createNodePersistenceFs(root, { hostEpoch: epoch, assertHeld() {} });
    const ns = await Namespace.open(fs, "builtin:kobrixa.lab"), target = { kind: "settings" as const, expectedRevision: null }, loc = await ns.location(target, true);
    const body = { formatVersion: 1, schemaVersion: 1, validationDigest: "0".repeat(64), values: [] };
    const raw = Buffer.from(JSON.stringify(body)), revision = "r_" + "1".repeat(32);
    const head: DiskHead = { formatVersion: 1, target, metadata: { kind: "settings", schemaVersion: 1, validationDigest: "0".repeat(64) }, object: revision + ".json", byteLength: raw.length, sha256: createHash("sha256").update(raw).digest("hex"), receipt: { revision, commitId: randomUUID(), durability: fs.durability } };
    await ns.writeNew(ns.object(loc, head), body); await ns.writeNew(loc.head, head); await ns.writeNew(loc.previous, head);
    expect((await scanNamespace(ns, epoch)).heads[0]?.receipt).toEqual(head.receipt);
    const orphan = ns.path("settings", "objects", "r_" + "2".repeat(32) + ".json"); await ns.writeNew(orphan, { untouched: true });
    expect((await garbageCandidates(ns, new Set([fs.name(orphan)]))).map(p => fs.name(p))).not.toContain(fs.name(orphan));
    expect((await garbageCandidates(ns, new Set())).map(p => fs.name(p))).toContain(fs.name(orphan));
    await fs.unlink(loc.head); await ns.writeNew(loc.head, { formatVersion: 1, broken: true });
    const rollback = await scanNamespace(ns, epoch);
    expect(rollback.problems).toContain("rollback-interrupted");
    expect((await ns.head(loc))?.receipt).toEqual(head.receipt);
    expect(await fs.entries(ns.path("quarantine"), 4096)).toHaveLength(1);
    await fs.unlink(loc.head); await ns.writeNew(loc.head, { ...head, formatVersion: 99 });
    await expect(scanNamespace(ns, epoch)).rejects.toThrow("unsupported-format");
    expect(JSON.parse(Buffer.from(await fs.bytes(loc.head, 8192)).toString()).formatVersion).toBe(99);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("does not treat EACCES as corruption or manufacture defaults", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "recover-permission-"));
  try {
    const fs = await createNodePersistenceFs(root, { hostEpoch: randomUUID(), assertHeld() {} });
    const ns = await Namespace.open(fs, "builtin:kobrixa.lab"), original = fs.entries.bind(fs);
    fs.entries = async (p, max) => { if (fs.name(p).endsWith("settings")) throw Object.assign(new Error("denied"), { code: "EACCES" }); return original(p, max); };
    await expect(scanNamespace(ns, fs.profile.hostEpoch)).rejects.toMatchObject({ code: "EACCES" });
    expect(await original(ns.path("quarantine"), 4096)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
```

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/persistence/recovery-scan.test.ts src/main/plugins/persistence/atomic-store.test.ts
```

Expected: FAIL for the absent scanner. Do not substitute empty recovery state to get green.

- [ ] **Step 8: Implement reference-driven recovery and GC**

Create `apps/desktop/src/main/plugins/persistence/recovery-scan.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { StorePath } from "./filesystem.js";
import { Namespace, parseHead, liveRecord, type DiskHead } from "./namespace.js";
export type NamespaceScan = { heads: DiskHead[]; problems: string[]; totals: { committed: number; records: number; metadata: number; temporary: number } };
const contentError = (e: unknown): boolean => e instanceof Error && (e.message === "corrupt" || e instanceof SyntaxError || e instanceof TypeError);
export async function scanNamespace(ns: Namespace, hostEpoch: string): Promise<NamespaceScan> {
  const fs = ns.fs; fs.profile.assertHeld();
  const result: NamespaceScan = { heads: [], problems: [], totals: { committed: 0, records: 0, metadata: 0, temporary: 0 } };
  await ns.inventory(); // Bound traversal and reject unsafe aliases before any repair.
  const payloads = new Set<string>(), retained = new Set<string>();
  for (const loc of await ns.locations()) {
    let head: DiskHead | null = null;
    try { head = await ns.head(loc); if (head) await ns.verify(loc, head); }
    catch (e) { if (!contentError(e)) throw e; head = null; result.problems.push("corrupt"); }
    if (!head && await fs.exists(loc.previous)) {
      const previous = parseHead(await fs.bytes(loc.previous, 8192)); await ns.verify(loc, previous);
      if (await fs.exists(loc.head)) await ns.quarantine(loc.head);
      const restore = ns.path(...loc.parts, `${loc.name}.${randomUUID()}.restore`);
      await ns.writeNew(restore, previous); await fs.atomicReplace(restore, loc.head); await fs.syncDirectory(loc.directory);
      head = previous; result.problems.push("rollback-interrupted");
    }
    if (!head) {
      if (await fs.exists(loc.objects) && (await fs.entries(loc.objects, 4096)).length) result.problems.push("corrupt");
      continue;
    }
    result.heads.push(head);
    const record = liveRecord(head);
    if (record) { result.totals.committed += record.byteLength; result.totals.records++; if (head.object) payloads.add(fs.name(ns.object(loc, head))); }
    if (await fs.exists(loc.previous)) {
      const previous = parseHead(await fs.bytes(loc.previous, 8192)); await ns.verify(loc, previous);
      if (previous.object && previous.object !== head.object && previous.metadata.kind === "record") retained.add(fs.name(ns.object(loc, previous)));
    }
  }
  // A completed process cannot own resumable staging in this new host epoch. Clean only the
  // recognized transient files after validating their identity; never replay their payload.
  for (const entry of await fs.entries(ns.path("staging"), 4096)) {
    if (!entry.directory || !/^[0-9a-f-]{36}$/.test(entry.name)) throw new Error("corrupt");
    const intent = ns.path("staging", entry.name, "intent.json");
    if (!await fs.exists(intent)) {
      if ((await fs.entries(ns.path("staging", entry.name), 4096)).length === 0) await fs.removeEmpty(ns.path("staging", entry.name));
      else result.problems.push("corrupt");
      continue;
    }
    const value = JSON.parse(Buffer.from(await fs.bytes(intent, 8192)).toString("utf8")) as { formatVersion?: unknown; ticket?: { owner?: { hostEpoch?: unknown; sourceKey?: unknown } } };
    if (value.formatVersion !== 1) throw new Error("unsupported-format");
    if (value.ticket?.owner?.sourceKey !== ns.sourceKey) throw new Error("identity-mismatch");
    if (value.ticket.owner.hostEpoch !== hostEpoch) {
      for (const name of ["payload.tmp", "sealed.json", "import-tag.json", "intent.json"]) {
        const p = ns.path("staging", entry.name, name);
        try { if (await fs.exists(p)) await fs.unlink(p); }
        catch (e) { result.problems.push((e as NodeJS.ErrnoException).code === "EACCES" ? "permission" : "cleanup-failed"); }
      }
      if ((await fs.entries(ns.path("staging", entry.name), 4096)).length === 0) await fs.removeEmpty(ns.path("staging", entry.name));
    }
  }
  for (const file of await ns.inventory()) {
    const name = fs.name(file.path);
    if (payloads.has(name)) continue;
    if (retained.has(name) || /(?:^|\/)objects\/r_[0-9a-f]{32}\.bin$/.test(file.relative) || file.relative.endsWith("/payload.tmp")) result.totals.temporary += file.bytes;
    else result.totals.metadata += file.bytes;
  }
  if (result.totals.committed > 536870912 || result.totals.records > 256 || result.totals.temporary > 33554432 || result.totals.metadata > 4194304) result.problems.push("quota");
  return result;
}
export async function garbageCandidates(ns: Namespace, protectedPaths: ReadonlySet<string>): Promise<StorePath[]> {
  const refs = new Set(protectedPaths), fs = ns.fs;
  for (const loc of await ns.locations()) {
    for (const p of [loc.head, loc.previous]) if (await fs.exists(p)) {
      const head = parseHead(await fs.bytes(p, 8192)); await ns.verify(loc, head);
      if (head.object) refs.add(fs.name(ns.object(loc, head)));
    }
  }
  return (await ns.inventory()).filter(file => /(?:^|\/)objects\/r_[0-9a-f]{32}\.(?:bin|json)$/.test(file.relative) && !refs.has(fs.name(file.path))).map(file => file.path);
}
```

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/persistence/filesystem.test.ts src/main/plugins/persistence/namespace.test.ts src/main/plugins/persistence/quota.test.ts src/main/plugins/persistence/engine-port.test.ts src/main/plugins/persistence/recovery-scan.test.ts src/main/plugins/persistence/atomic-store.test.ts
```

Expected: PASS. Corrupt/unknown evidence stays unavailable with a core fault; permission errors propagate unchanged. The engine does not instantiate a device provider, process supervisor, form, or optional feature mapper.

- [ ] **Step 8a: Implement native destination registration and output in filesystem.ts**

Append the following worker-local class to `filesystem.ts`. The destination brand stays in T5's actions.ts. The constructor receives the same profile and quota ledger as the store; no callback supplies an output implementation. Recheck parent/leaf identity before every consequential operation. Native paths enter only through D170's already-claimed action closure. The opaque destination is replaced by a private registry ID at the worker boundary.

```ts
import { createHash, randomUUID, type Hash } from "node:crypto";
import type { ExportDestination } from "./actions.js";
import type { ExportDestinationRegistry, PersistenceOutputPort, ExportOutcome } from "./engine-port.js";
import type { CoreWindowScope } from "@kobrixa/plugin-runtime";
import type { ResourceOwner } from "@kobrixa/plugin-protocol";
import type { QuotaLedger } from "./quota.js";
type Destination = {action:string;scope:CoreWindowScope;name:string;parent:string;parentIdentity:string;leafIdentity:string|null;deadline:number;claimed:boolean};
type OutputJob = {destination:Destination;owner:ResourceOwner;temp:string;fd:FileHandle;size:number;sha256:string;offset:number;hash:Hash;last:{offset:number;bytes:Uint8Array}|null;outcome:ExportOutcome;dispatched:boolean};
export class NativeOutput implements ExportDestinationRegistry,PersistenceOutputPort {
  private readonly destinations=new Map<ExportDestination,Destination>();
  private readonly jobs=new Map<string,OutputJob>();
  constructor(private readonly profile:ProfileWriterLock,private readonly quota:QuotaLedger,private readonly now:()=>number,private readonly fs:NodePersistenceFs) {}
  private async identity(name:string):Promise<string|null> {
    try {const s=await lstat(name,{bigint:true});if(s.isSymbolicLink() || (!s.isFile() && !s.isDirectory()) || (s.isFile() && s.nlink!==1n))throw new Error("unsafe-path");return `${s.dev}:${s.ino}`;}
    catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e;}
  }
  private async check(d:Destination,checkDeadline=true):Promise<void> {
    this.profile.assertHeld();
    if(checkDeadline && this.now()>=d.deadline)throw new Error("stale");
    if(await realpath(d.parent)!==d.parent || await this.identity(d.parent)!==d.parentIdentity || await this.identity(d.name)!==d.leafIdentity)throw new Error("destination-changed");
  }
  async register(input:Parameters<ExportDestinationRegistry["register"]>[0]):Promise<ExportDestination> {
    this.profile.assertHeld();if(!path.isAbsolute(input.nativePath) || this.now()>=input.deadlineMonotonicMs)throw new Error("stale");
    const parent=path.dirname(input.nativePath);
    if(await realpath(parent)!==parent)throw new Error("unsafe-path");
    const parentIdentity=await this.identity(parent);if(!parentIdentity)throw new Error("destination-changed");
    const token=Object.freeze({}) as ExportDestination;
    this.destinations.set(token,{action:input.action,scope:structuredClone(input.scope),name:input.nativePath,parent,parentIdentity,
      leafIdentity:await this.identity(input.nativePath),deadline:input.deadlineMonotonicMs,claimed:false});return token;
  }
  assertSettled():void {if([...this.jobs.values()].some(j=>j.outcome.disposition==="unknown"))throw new Error("publish-uncertain");}
  async release(token:ExportDestination):Promise<void> {
    const d=this.destinations.get(token);if(!d)return;
    if([...this.jobs.values()].some(j=>j.destination===d && j.outcome.disposition==="unknown"))return;
    for(const [id,j] of this.jobs)if(j.destination===d){if(j.outcome.disposition!=="committed")await this.abort(id);this.jobs.delete(id);}
    this.destinations.delete(token);
  }
  async begin(id:string,owner:ResourceOwner,destination:ExportDestination,bytes:number,sha256:string,deadline:number):Promise<void> {
    const d=this.destinations.get(destination);
    if(!d || d.scope.hostEpoch!==owner.hostEpoch || d.claimed || this.jobs.has(id) || !Number.isSafeInteger(bytes) || bytes<0 || bytes>8388608 || !/^[0-9a-f]{64}$/.test(sha256))throw new Error("stale");
    d.deadline=Math.min(d.deadline,deadline);await this.check(d);
    const disk=await statfs(d.parent,{bigint:true});
    // Node rename is the supported same-volume replacement primitive. EXDEV/ENOTSUP fail without unlink fallback.
    this.quota.reserve(id,owner.sourceKey,{bytes:0,create:false,metadata:0,lane:"export"},Number(disk.bavail*disk.bsize));
    const temp=path.join(d.parent,`.kobrixa-${randomUUID()}.tmp`);
    try {
      this.quota.holdTemporary(owner.sourceKey,temp,bytes);
      const fd=await open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|(constants.O_NOFOLLOW??0),0o600);
      this.jobs.set(id,{destination:d,owner,temp,fd,size:bytes,sha256,offset:0,hash:createHash("sha256"),last:null,outcome:{disposition:"not-committed"},dispatched:false});d.claimed=true;
    }catch(e){this.quota.releaseTemporary(owner.sourceKey,temp);this.quota.release(id);throw e;}
  }
  private job(id:string):OutputJob {const j=this.jobs.get(id);if(!j)throw new Error("stale");return j;}
  async append(id:string,offset:number,bytes:Uint8Array):Promise<number> {
    const j=this.job(id);await this.check(j.destination);
    if(j.dispatched || bytes.length<1 || bytes.length>262144)throw new Error("sealed");
    if(j.last?.offset===offset && Buffer.from(j.last.bytes).equals(Buffer.from(bytes)))return j.offset;
    if(offset!==j.offset || offset+bytes.length>j.size)throw new Error("offset-mismatch");
    let done=0;while(done<bytes.length){this.profile.assertHeld();const r=await j.fd.write(bytes,done,bytes.length-done,offset+done);if(!r.bytesWritten)throw new Error("io");done+=r.bytesWritten;}
    j.hash.update(bytes);j.offset+=bytes.length;j.last={offset,bytes:Uint8Array.from(bytes)};return j.offset;
  }
  async commit(id:string):Promise<ExportOutcome> {
    const j=this.job(id);if(j.dispatched)return this.reconcile(id);
    if(j.offset!==j.size || j.hash.copy().digest("hex")!==j.sha256)throw new Error("incomplete");
    await j.fd.sync();await this.check(j.destination);
    const source=await j.fd.stat(),atPath=await lstat(j.temp);
    if(source.dev!==atPath.dev || source.ino!==atPath.ino)throw new Error("destination-changed");
    await this.fs.fault("before-publish");await this.check(j.destination);
    j.dispatched=true;j.outcome={disposition:"unknown"};
    try {
      await rename(j.temp,j.destination.name);await this.fs.fault("after-publish");
      if(process.platform!=="win32"){const dir=await open(j.destination.parent,constants.O_RDONLY);try{await dir.sync();}finally{await dir.close();}}
      j.outcome={disposition:"committed",commitId:randomUUID(),durability:process.platform==="win32"?"file-sync-only":"file-and-directory-sync"};
      await j.fd.close();this.quota.releaseTemporary(j.owner.sourceKey,j.temp);this.quota.release(id);return j.outcome;
    }catch(e){if(["EXDEV","ENOTSUP"].includes((e as NodeJS.ErrnoException).code??"")){j.dispatched=false;j.outcome={disposition:"not-committed"};throw new Error("unsupported-filesystem");}return j.outcome;}
  }
  async reconcile(id:string):Promise<ExportOutcome> {
    const j=this.job(id);if(j.outcome.disposition!=="unknown")return j.outcome;
    try {
      this.profile.assertHeld();if(await this.identity(j.destination.parent)!==j.destination.parentIdentity)return j.outcome;
      const current=await open(j.destination.name,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
      try {
        const original=await j.fd.stat(),actual=await current.stat();
        if(original.dev!==actual.dev || original.ino!==actual.ino || actual.size!==j.size)return j.outcome;
        const digest=createHash("sha256"),buffer=Buffer.allocUnsafe(262144);let offset=0;
        while(offset<j.size){const r=await current.read(buffer,0,Math.min(buffer.length,j.size-offset),offset);if(!r.bytesRead)return j.outcome;digest.update(buffer.subarray(0,r.bytesRead));offset+=r.bytesRead;}
        if(digest.digest("hex")!==j.sha256)return j.outcome;
        await j.fd.sync();if(process.platform!=="win32"){const dir=await open(j.destination.parent,constants.O_RDONLY);try{await dir.sync();}finally{await dir.close();}}
        j.outcome={disposition:"committed",commitId:randomUUID(),durability:process.platform==="win32"?"file-sync-only":"file-and-directory-sync"};
        await j.fd.close();this.quota.releaseTemporary(j.owner.sourceKey,j.temp);this.quota.release(id);return j.outcome;
      }finally{await current.close();}
    }catch{return j.outcome;}
  }
  async abort(id:string):Promise<"aborted"|"committed"|"unknown"> {
    const j=this.job(id);if(j.dispatched)return (await this.reconcile(id)).disposition==="committed"?"committed":"unknown";
    this.profile.assertHeld();await j.fd.close();await unlink(j.temp);
    this.quota.releaseTemporary(j.owner.sourceKey,j.temp);this.quota.release(id);this.jobs.delete(id);return "aborted";
  }
}
```

- [ ] **Step 8b: Implement fixed-root source resolution in worker.ts**

Define the following class in worker.ts before the runner. It uses worker-installed `LegacyImportDescriptor` mappings and retains mapped bytes in worker scratch only. Foundation's production mapping map is empty; T7's private wrapper supplies the synthetic descriptor and test userData. No descriptor function, root string or mapper can arrive from plugin RPC. The fixed `legacy/<sourceKind>` directories below are test/future host allowlist locations, not a claim that real Lab/device legacy stores have been migrated.

```ts
class WorkerSources implements LegacySourceResolver {
  private readonly registered=new Map<string,{descriptor:LegacyImportDescriptor;fs:NodePersistenceFs}>();
  private readonly mapped=new Map<string,{bytes:Uint8Array;sourceSha256:string;mappedSha256:string;metadata:LegacyMappedItem;offset:number;ticket:string|null}>();
  constructor(private readonly root:string,private readonly store:AtomicStore,private readonly mappers:ReadonlyMap<string,LegacyImportDescriptor>) {}
  async register(input:Parameters<LegacySourceResolver["register"]>[0]):Promise<void> {
    const descriptor=this.mappers.get(input.mapperId);
    if(!descriptor || descriptor.id!==input.descriptorId || descriptor.sourceKind!==input.sourceKind)throw new Error("invalid-mapper");
    const sourceRoot=path.join(path.dirname(path.dirname(this.root)),"legacy",descriptor.sourceKind);
    this.registered.set(input.descriptorId,{descriptor,fs:new NodePersistenceFs(sourceRoot,this.store.fs.profile)});
  }
  private source(id:string){const s=this.registered.get(id);if(!s)throw new Error("stale");return s;}
  async inventory(id:string):ReturnType<LegacySourceResolver["inventory"]> {
    const {fs,descriptor}=this.source(id);
    try {
      await fs.check(fs.path());const entries=await fs.entries(fs.path(),4096),items:LegacySourceItem[]=[];
      if(entries.length>512)throw new Error("size-limit");
      for(let start=0;start<entries.length;start+=64)for(const entry of entries.slice(start,start+64)) {
        if(entry.directory || Buffer.byteLength(entry.name)>128 || entry.bytes>8388608)throw new Error("invalid-resource");
        const bytes=await fs.bytes(fs.path(entry.name),8388608),sha256=createHash("sha256").update(bytes).digest("hex");
        const raw=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)),format=raw.formatVersion;
        if(!descriptor.sourceFormatVersions.includes(format) || !descriptor.validate({sourceKind:descriptor.sourceKind,bytes,sha256}))throw new Error("unsupported-format");
        items.push({key:entry.name,format,byteLength:bytes.length,sha256});
      }
      return {state:"present",entries:items};
    }catch(e){return {state:(e as NodeJS.ErrnoException).code==="ENOENT"?"absent":"blocked",entries:[]};}
  }
  async read(id:string,key:string,offset:number,maxBytes:number):Promise<Uint8Array> {
    const {fs}=this.source(id);if(Buffer.byteLength(key)>128)throw new Error("size-limit");
    const fd=await fs.open(fs.path(key),"read");try{return await fs.read(fd,offset,maxBytes);}finally{await fs.close(fd);}
  }
  private async settingsValidationDigest(descriptor:LegacyImportDescriptor):Promise<string> {
    const owner:PersistenceOwner={sourceKey:descriptor.targetSourceKey,pluginId:descriptor.id,generation:0,hostEpoch:this.store.fs.profile.hostEpoch,processEpoch:this.store.fs.profile.hostEpoch};
    const committed=await this.store.settingsDigest(owner);
    if(committed && committed.schemaVersion===descriptor.targetSettingsSchemaVersion)return committed.validationDigest;
    // A target without a committed schema is initialized through the bound settings service
    // before import planning; mapping never invents a resource validation digest.
    throw new Error("schema-mismatch");
  }
  async map(id:string,key:string):Promise<LegacyMappedItem> {
    const {descriptor,fs}=this.source(id),bytes=await fs.bytes(fs.path(key),8388608);
    const sourceSha256=createHash("sha256").update(bytes).digest("hex");
    if(!descriptor.validate({sourceKind:descriptor.sourceKind,bytes,sha256:sourceSha256}))throw new Error("invalid-resource");
    const item=descriptor.map({sourceKind:descriptor.sourceKind,bytes,sha256:sourceSha256});
    const mappedBytes=item.kind==="record"?item.bytes:Buffer.from(JSON.stringify({formatVersion:1,schemaVersion:item.schemaVersion,values:item.values,
      validationDigest:await this.settingsValidationDigest(descriptor)}));
    if(mappedBytes.length>8388608 || this.mapped.size>=4)throw new Error("quota");
    const mapped=randomUUID(),mappedSha256=createHash("sha256").update(mappedBytes).digest("hex");
    this.store.quota.holdTemporary(descriptor.targetSourceKey,mapped,mappedBytes.length);
    const metadata:LegacyMappedItem={mapped,sourceSha256,mappedSha256,byteLength:mappedBytes.length,
      ...(item.kind==="record"?{kind:"record",metadata:item.metadata}:{kind:"settings",schemaVersion:item.schemaVersion})};
    this.mapped.set(mapped,{bytes:mappedBytes,sourceSha256,mappedSha256,metadata,offset:0,ticket:null});return metadata;
  }
  async appendMapped(input:Parameters<LegacySourceResolver["appendMapped"]>[0]):ReturnType<LegacySourceResolver["appendMapped"]> {
    const p=this.mapped.get(input.mapped);
    if(!p || input.offset!==p.offset || input.maxBytes<1 || input.maxBytes>262144 || (p.ticket!==null && p.ticket!==input.ticket.id))throw new Error("stale");
    const planKeys=await this.store.auxiliaryKeys(input.ticket.owner,"import");let cursor=planKeys.nextCursor,keys=[...planKeys.keys],matched=false;
    for(;;){for(const key of keys){const plan=await this.store.loadImport(input.ticket.owner,key);if(plan?.plan.items.some(i=>i.ticket.id===input.ticket.id && JSON.stringify(i.ticket)===JSON.stringify(input.ticket) && i.mappedSha256===p.mappedSha256 && i.sourceSha256===p.sourceSha256))matched=true;}
      if(!cursor)break;const next=await this.store.auxiliaryKeys(input.ticket.owner,"import",cursor);keys=[...next.keys];cursor=next.nextCursor;}
    if(!matched)throw new Error("input-changed");p.ticket=input.ticket.id;
    const chunk=p.bytes.subarray(p.offset,p.offset+input.maxBytes);if(chunk.length)p.offset=await this.store.append(input.ticket,p.offset,chunk);
    return {nextOffset:p.offset,done:p.offset===p.bytes.length};
  }
  async releaseMapped(mapped:string):Promise<void> {
    const p=this.mapped.get(mapped);if(!p)return;
    // Unknown publications keep their scratch evidence until original-ticket reconciliation.
    if(p.ticket && this.store.unresolvedTicket(p.ticket))throw new Error("publish-uncertain");
    for(const {descriptor} of this.registered.values())this.store.quota.releaseTemporary(descriptor.targetSourceKey,mapped);
    this.mapped.delete(mapped);
  }
}
```

Add `unresolvedTicket(id:string):boolean {const e=this.entries.get(id);return !!e && (e.state==="unknown" || e.state==="publishing" || e.busy);}` to AtomicStore. Source methods run through the same four-job worker queue. T6 resolves the settings validation digest from its admitted target resource before planning; it must reject a mapper-produced envelope whose validation digest differs from that frozen target. The synthetic settings mapper uses the exact frozen validation digest, not a digest of user values.

- [ ] **Step 9: Add worker-channel tests, then observe the red result**

Create `apps/desktop/src/main/plugins/persistence/worker.test.ts`. Bundle worker.ts as CJS with the same runner call K170 adds to the packaged entry. Fault controls are passed only by this test composition; no environment/CLI/preload selector exists.

```ts
import { createHash,randomUUID } from "node:crypto";
import { mkdtemp,rm,mkdir,readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll,beforeAll,expect,it } from "vitest";
import { startPersistenceWorker,PersistenceWorkerRequest,PersistenceWorkerResponse,type PersistenceFaultControl } from "./worker.js";
import { openStoreRoot,type PersistenceFaultPoint } from "./filesystem.js";
import type { PersistenceBackend,PublicationTicket,ImportPlan } from "./engine-port.js";
let directory:string,entry:string;
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
beforeAll(async()=>{
  directory=await mkdtemp(path.join(tmpdir(),"persistence-worker-test-"));
  await build({configFile:false,logLevel:"error",build:{target:"node24",outDir:path.join(directory,"bundle"),emptyOutDir:true,
    lib:{entry:fileURLToPath(new URL("./worker.ts",import.meta.url)),formats:["cjs"],fileName:()=>"persistence-worker.cjs"},
    rollupOptions:{external:[/^node:/],output:{footer:"exports.runPersistenceWorker({mappers:new Map()});"}},minify:false}});
  entry=path.join(directory,"bundle","persistence-worker.cjs");
},60000);
afterAll(async()=>{await rm(directory,{recursive:true,force:true});});
async function launch(userData:string){
  await mkdir(userData,{recursive:true});const profile={hostEpoch:randomUUID(),assertHeld(){}};
  const root=await openStoreRoot({userData,profile});let control:PersistenceFaultControl|undefined;
  const started=await startPersistenceWorker({profile,root,workerEntry:entry,now:()=>performance.now(),testControl:c=>{control=c;}});
  return {...started,profile,control:control!};
}
function make(owner:PublicationTicket["owner"],bytes:Uint8Array):PublicationTicket {
  const id=randomUUID();return {id:randomUUID(),owner,deadlineMonotonicMs:performance.now()+120000,
    target:{kind:"record",id,expectedRevision:null},metadata:{kind:"record",deleted:false,record:{id,revision:"r_"+randomUUID().replaceAll("-",""),kind:"test",schemaVersion:1,label:"Worker",mediaType:"application/octet-stream",byteLength:bytes.length,sha256:hash(bytes),createdAt:1,updatedAt:1,checkpoint:"none",interrupted:false}}};
}
const ownerFor=(epoch:string)=>({sourceKey:"builtin:kobrixa.lab",pluginId:"kobrixa.lab",generation:1,hostEpoch:epoch,processEpoch:randomUUID()});
async function stage(backend:PersistenceBackend,t:PublicationTicket,bytes:Uint8Array){await backend.engine.reserve(t,bytes.length);for(let n=0;n<bytes.length;n+=262144)await backend.engine.append(t,n,bytes.subarray(n,n+262144));await backend.engine.seal(t,bytes.length,hash(bytes));}
it("rejects malformed private messages and missing capabilities",async()=>{
  expect(PersistenceWorkerRequest.safeParse({version:1,id:1,operation:"engine.fence",args:[]}).success).toBe(false);
  expect(PersistenceWorkerRequest.safeParse({version:1,id:1,operation:"reads.settings",args:[{sourceKey:"forged"}]}).success).toBe(false);
  expect(PersistenceWorkerResponse.safeParse({version:1,id:1,ok:false,error:{code:"io",message:"io",path:"private"}}).success).toBe(false);
  await expect(openStoreRoot({userData:directory,profile:{hostEpoch:randomUUID(),assertHeld(){throw new Error("not-primary");}}})).rejects.toThrow("not-primary");
  await expect(startPersistenceWorker({profile:{hostEpoch:randomUUID(),assertHeld(){}},root:{} as never,workerEntry:entry,now:()=>0})).rejects.toThrow("unsafe-root");
});
it("preserves exact opaque bytes, scoped barriers and one idempotent disposal",async()=>{
  const env=await launch(path.join(directory,randomUUID())),bytes=new Uint8Array([0,255,123,0,10]),owner=ownerFor(env.profile.hostEpoch),t=make(owner,bytes);
  await stage(env.backend,t,bytes);
  const barrier=env.backend.evidence.capture({kind:"namespace",owner},performance.now()+10000);
  expect((await env.backend.evidence.flush(barrier)).state).toBe("failed");
  expect(env.backend.evidence.tickets(barrier)).toEqual([t]);
  const committed=await env.backend.engine.publish(t);expect(committed.disposition).toBe("committed");
  expect((await env.backend.evidence.flush(barrier)).state).toBe("saved");
  const id=t.target.kind==="record"?t.target.id:"",meta=await env.backend.reads.stat(owner,id);
  expect([meta.byteLength,meta.sha256]).toEqual([bytes.length,hash(bytes)]);
  const pin=await env.backend.reads.open(owner,id,meta.revision);expect(await env.backend.reads.read(owner,pin,0,256)).toEqual(bytes);await env.backend.reads.close(owner,pin);
  const late=make(owner,bytes);await env.backend.engine.reserve(late,bytes.length);
  expect(env.backend.evidence.tickets(barrier)).toEqual([t]);await env.backend.engine.abort(late);
  const one=env.backend.dispose();expect(env.backend.dispose()).toBe(one);await one;
});
const points:PersistenceFaultPoint[]=["reserve","open-temp","chunk-write","seal-sync","object-rename","object-dir-sync","backup-head","head-write","before-publish","after-publish","head-dir-sync","cache-publish","receipt-send","cleanup","import-marker"];
for(const point of points)it(`real worker kill at ${point}`,async()=>{
  const userData=path.join(directory,randomUUID()),env=await launch(userData),owner=ownerFor(env.profile.hostEpoch),bytes=Buffer.from(JSON.stringify({formatVersion:1,value:1}));
  const target={kind:"import" as const,key:"fault-matrix"};
  const ticket=():PublicationTicket=>({id:randomUUID(),owner,deadlineMonotonicMs:performance.now()+120000,target,metadata:target});
  const old=ticket();await stage(env.backend,old,bytes);await env.backend.engine.publish(old);
  env.control.arm(point,"pause");const reached=env.control.reached(point),next=ticket();
  const pending=stage(env.backend,next,bytes).then(()=>env.backend.engine.publish(next)).catch(()=>null);
  await reached;await env.control.terminate();await pending;
  for(let attempt=0;attempt<3;attempt++){
    const reopened=await launch(userData);expect(reopened.recovery).toBe("ready");
    expect(await reopened.backend.evidence.auxiliary(ownerFor(reopened.profile.hostEpoch),"import","fault-matrix")).toEqual(bytes);
    await reopened.backend.dispose();
  }
},30000);
it("kill after imported head before receipt reconciles original ticket without new IDs",async()=>{
  const userData=path.join(directory,randomUUID()),env=await launch(userData),owner=ownerFor(env.profile.hostEpoch),bytes=new Uint8Array([7,0,255]);
  const t=make(owner,bytes),tag={importId:"once",itemKey:"item",sourceSha256:hash(bytes)},skipTicket=make(owner,bytes);
  const plan:ImportPlan={formatVersion:1,id:"once",mappingVersion:1,targetSourceKey:owner.sourceKey,items:[
    {key:"item",sourceFormat:1,sourceSha256:hash(bytes),mappedSha256:hash(bytes),byteLength:bytes.length,ticket:t,tag},
    {key:"skip",sourceFormat:1,sourceSha256:hash(bytes),mappedSha256:hash(bytes),byteLength:bytes.length,ticket:skipTicket,tag:{...tag,itemKey:"skip"}},
  ]};
  await env.backend.imports.plan(owner,plan);
  await env.backend.imports.record(owner,"once",{key:"skip",state:"skipped",receipt:null,skipReason:"already-new"});
  await expect(env.backend.imports.complete(owner,"once")).rejects.toThrow();
  await env.backend.engine.reserve(t,bytes.length);await env.backend.imports.tagImport(t,tag);
  await env.backend.engine.append(t,0,bytes);await env.backend.engine.seal(t,bytes.length,hash(bytes));
  env.control.arm("after-publish","pause");const reached=env.control.reached("after-publish");const pending=env.backend.engine.publish(t).catch(()=>null);
  await reached;await env.control.terminate();await pending;
  for(let attempt=0;attempt<3;attempt++){
    const next=await launch(userData),current=ownerFor(next.profile.hostEpoch),saved=await next.backend.imports.load(current,"once");
    expect(saved?.plan).toEqual(plan);expect(saved?.items[1]?.skipReason).toBe("already-new");
    expect((await next.backend.imports.reconcile(t)).disposition).toBe("committed");
    const receipts=await next.backend.imports.importReceipts(current,"once");expect(receipts).toHaveLength(1);expect(receipts[0]?.ticket.id).toBe(t.id);
    await next.backend.imports.complete(current,"once");expect((await next.backend.imports.load(current,"once"))?.complete).toBe(true);
    expect((await next.backend.reads.list(current,{limit:64})).entries).toHaveLength(1);
    await next.backend.dispose();
  }
},30000);
```

Keep filesystem/atomic-store tests on both sides of each syscall boundary. The worker controls expose the exact frozen `arm(point, action)`, `reached`, `release`, `trace`, `terminate` API; `before-publish` and `after-publish` distinguish head dispatch. T7 reuses those controls for host kills, after-skip and before/after-completion-marker runs through its real `createFoundationFixture`. No test-only API enters production RPC or preload.

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/persistence/worker.test.ts
```

Expected: FAIL before `openStoreRoot`/`startPersistenceWorker` and worker ports are implemented, then PASS with real worker kills and three repeated reopenings. This does not substitute for installed Electron host/process tests.

- [ ] **Step 10: Implement the bounded worker transport and entry**

Keep WorkerSources from Step 8b in `worker.ts`; add these imports, private transport definitions, sole bootstrap and runner. No public method registry imports the worker protocol. A registry-held destination serializes as its private UUID; main never constructs a filesystem capability. `engine.reserve` admits into main's immutable ordered ledger before yielding. Main owns `fence`, `fenceTarget`, `evidence.capture` and `evidence.tickets`; shared gate words prevent a late worker callback from publishing across a same-turn fence.

```ts
import { Worker, MessageChannel, parentPort, workerData, isMainThread, type MessagePort } from "node:worker_threads";
import { createHash,randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { z } from "zod";
import type { ProfileWriterLock,PersistenceOwner } from "@kobrixa/plugin-runtime";
import type { LegacyImportDescriptor,LegacySourceItem,LegacyMappedItem } from "./import-sources.js";
import type { ExportDestination } from "./actions.js";
import { AtomicStore } from "./atomic-store.js";
import { NodePersistenceFs,NativeOutput,storeRootPath,type StoreRoot,type PersistenceFaultPoint } from "./filesystem.js";
import { WorkQueue } from "./quota.js";
import { PublicationGate,ownerKey,type PersistenceBackend,type PublicationTicket,type PersistenceBarrier,type PersistenceScope,type LegacySourceResolver } from "./engine-port.js";
import { publicationTicketSchema,persistenceOwnerSchema,persistenceBarrierSchema,importPlanSchema,
  importTagSchema,importItemEvidenceSchema,storedRecoverySchema } from "./namespace.js";
import type { Handle,Counter } from "@kobrixa/plugin-protocol";
export interface PersistenceFaultControl {
  arm(point:PersistenceFaultPoint,action:"pause"|"fail"|"kill"):void;
  reached(point:PersistenceFaultPoint):Promise<void>;
  release(point:PersistenceFaultPoint):void;
  trace():readonly {point:PersistenceFaultPoint;time:number;ticket:Handle|null}[];
  terminate():Promise<void>;
}
import type { FoundationDiagnostics } from "@kobrixa/plugin-runtime";
const diagnosticInstances=new WeakMap<object,FoundationDiagnostics>();
export function diagnosticsFor(instance:object):FoundationDiagnostics {const value=diagnosticInstances.get(instance);if(!value)throw new Error("unknown-instance");return value;}
type Qualified<P,Prefix extends string> = {[K in keyof P as K extends string?`${Prefix}.${K}`:never]:P[K]};
export type WorkerOperations=Qualified<Omit<PersistenceBackend["engine"],"fence"|"fenceTarget">,"engine"> &
  Qualified<PersistenceBackend["reads"],"reads"> & Qualified<Omit<PersistenceBackend["evidence"],"capture"|"tickets">,"evidence"> &
  Qualified<PersistenceBackend["imports"],"imports"> & Qualified<PersistenceBackend["output"],"output"> &
  Qualified<PersistenceBackend["destinations"],"destinations"> & Qualified<PersistenceBackend["sources"],"sources">;
type Operation=keyof WorkerOperations;
const count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),handle=z.string().uuid(),digest=z.string().regex(/^[0-9a-f]{64}$/);
const text=z.string().min(1).refine(s=>Buffer.byteLength(s)<=128),revision=z.string().regex(/^r_[0-9a-f]{32}$/);
const bytes=z.instanceof(Uint8Array).refine(b=>b.byteLength<=262144),ticket=publicationTicketSchema,owner=persistenceOwnerSchema;
const scope=z.strictObject({hostEpoch:handle,workbenchInstance:handle});
// Use CoreWindowScope's F keys verbatim; do not accept renderer-created scope.
const args={
  "engine.reserve":z.tuple([ticket,count.max(8388608)]),"engine.append":z.tuple([ticket,count,bytes]),
  "engine.seal":z.tuple([ticket,count.max(8388608),digest]),"engine.publish":z.tuple([ticket]),"engine.reconcile":z.tuple([ticket]),"engine.abort":z.tuple([ticket]),
  "reads.settings":z.tuple([owner]),"reads.stat":z.tuple([owner,handle]),
  "reads.list":z.tuple([owner,z.strictObject({kind:z.string().optional(),limit:count.min(1).max(64),cursor:handle.optional()})]),
  "reads.open":z.tuple([owner,handle,revision]),"reads.read":z.tuple([owner,handle,count,count.min(1).max(262144)]),"reads.close":z.tuple([owner,handle]),
  "evidence.flush":z.tuple([persistenceBarrierSchema]),"evidence.quota":z.tuple([owner]),"evidence.settingsDigest":z.tuple([owner]),
  "evidence.auxiliary":z.tuple([owner,z.enum(["import","recovery"]),text]),"evidence.auxiliaryKeys":z.tuple([owner,z.enum(["import","recovery"]),handle.optional()]),
  "evidence.recoveryPage":z.tuple([handle.optional()]),"evidence.loadRecovery":z.tuple([handle]),"evidence.saveRecovery":z.tuple([storedRecoverySchema]),"evidence.removeRecovery":z.tuple([handle]),
  "imports.load":z.tuple([owner,text]),"imports.plan":z.tuple([owner,importPlanSchema]),"imports.tagImport":z.tuple([ticket,importTagSchema]),
  "imports.importReceipts":z.tuple([owner,text]),"imports.record":z.tuple([owner,text,importItemEvidenceSchema]),"imports.reconcile":z.tuple([ticket]),"imports.complete":z.tuple([owner,text]),
  "output.begin":z.tuple([handle,owner,handle,count.max(8388608),digest,count]),"output.append":z.tuple([handle,count,bytes]),
  "output.commit":z.tuple([handle]),"output.reconcile":z.tuple([handle]),"output.abort":z.tuple([handle]),
  "destinations.register":z.tuple([z.strictObject({action:handle,scope,nativePath:z.string().min(1),deadlineMonotonicMs:count})]),"destinations.release":z.tuple([handle]),
  "sources.register":z.tuple([z.strictObject({descriptorId:text,mapperId:text,sourceKind:z.enum(["sensor-lab","device-settings","renderer-preferences"])})]),
  "sources.map":z.tuple([text,text]),"sources.appendMapped":z.tuple([z.strictObject({mapped:handle,ticket,offset:count,maxBytes:count.min(1).max(262144)})]),
  "sources.releaseMapped":z.tuple([handle]),"sources.inventory":z.tuple([text]),"sources.read":z.tuple([text,text,count,count.min(1).max(262144)]),
} satisfies Record<Operation,z.ZodType>;
const envelope=z.strictObject({version:z.literal(1),id:count.min(1),operation:z.enum(Object.keys(args) as [Operation,...Operation[]]),args:z.array(z.unknown())});
export const PersistenceWorkerRequest=envelope.superRefine((r,ctx)=>{if(!args[r.operation].safeParse(r.args).success)ctx.addIssue({code:"custom",message:"invalid-args"});});
export type PersistenceWorkerRequest<K extends Operation=Operation>={version:1;id:Counter;operation:K;args:Parameters<WorkerOperations[K]>};
export const PersistenceWorkerResponse=z.union([
  z.strictObject({version:z.literal(1),id:count.min(1),ok:z.literal(true),value:z.unknown()}),
  z.strictObject({version:z.literal(1),id:count.min(1),ok:z.literal(false),error:z.strictObject({code:z.enum(["io","invalid","stale","quota","unknown"]),message:z.string().max(128)})}),
]);
export type PersistenceWorkerResponse<K extends Operation=Operation>={version:1;id:Counter;ok:true;value:Awaited<ReturnType<WorkerOperations[K]>>}|{version:1;id:Counter;ok:false;error:{code:"io"|"invalid"|"stale"|"quota"|"unknown";message:string}};
const bootSchema=z.strictObject({version:z.literal(1),kind:z.literal("boot"),hostEpoch:handle,root:z.string().min(1),held:z.instanceof(SharedArrayBuffer)});
const readySchema=z.strictObject({version:z.literal(1),kind:z.literal("ready"),recovery:z.enum(["ready","blocked"])});
const matches=(scope:PersistenceScope,t:PublicationTicket)=>ownerKey(scope.owner)===ownerKey(t.owner) && (scope.kind==="namespace" || t.target.kind==="record" && t.target.id===scope.recordId);
const gateOffset=(sequence:number)=>16+16*((sequence-1)%1024);
const charge=(value:unknown):number=>value instanceof Uint8Array?value.byteLength:Array.isArray(value)?value.reduce((n,v)=>n+charge(v),0):Buffer.byteLength(JSON.stringify(value)??"null");

export async function startPersistenceWorker(input:{profile:ProfileWriterLock;root:StoreRoot;workerEntry:string;now:()=>number;testControl?:(control:PersistenceFaultControl)=>void}):Promise<{backend:PersistenceBackend;recovery:"ready"|"blocked"}> {
  input.profile.assertHeld();const root=await storeRootPath(input.root,input.profile);
  if(!path.isAbsolute(input.workerEntry))throw new Error("invalid-worker-entry");
  const held=new SharedArrayBuffer(16+1024*16);Atomics.store(new Int32Array(held),0,1);
  const channel=input.testControl?new MessageChannel():null;
  const worker=new Worker(input.workerEntry,{workerData:channel?{faultPort:channel.port2}:{},transferList:channel?[channel.port2]:[]});
  const queue=new WorkQueue(input.now),ledger=new Map<string,{ticket:PublicationTicket;gate:PublicationGate;sequence:number}>(),slots=new Set<number>();
  const retired=new Set<string>(),targets=new Set<string>(),barriers=new Map<string,{barrier:PersistenceBarrier;tickets:readonly PublicationTicket[]}>();
  const destinations=new WeakMap<ExportDestination,string>();let sequence=0,next=0,dead=false,closing:Promise<void>|null=null;
  const pending=new Map<number,{resolve:(v:unknown)=>void;reject:(e:unknown)=>void}>();
  const lost=()=>{dead=true;Atomics.store(new Int32Array(held),0,0);for(const e of ledger.values())e.gate.shorten(input.now(),input.now());for(const p of pending.values())p.reject(new Error("worker-lost"));pending.clear();};
  worker.once("error",lost);worker.once("exit",lost);
  worker.on("message",raw=>{const parsed=PersistenceWorkerResponse.safeParse(raw);if(!parsed.success)return;const r=parsed.data,p=pending.get(r.id);if(!p)return;pending.delete(r.id);if(r.ok)p.resolve(r.value);else p.reject(new Error(r.error.message));});
  if(channel){
    const trace:Array<{point:PersistenceFaultPoint;time:number;ticket:string|null}>=[],waiters=new Map<string,Array<()=>void>>();
    channel.port1.on("message",(e:{point:PersistenceFaultPoint;time:number;ticket:string|null})=>{trace.push(e);for(const resolve of waiters.get(e.point)??[])resolve();waiters.delete(e.point);});
    input.testControl!({arm(point,action){channel.port1.postMessage({kind:"arm",point,action});},reached(point){return new Promise(resolve=>{const list=waiters.get(point)??[];list.push(resolve);waiters.set(point,list);});},release(point){channel.port1.postMessage({kind:"release",point});},trace:()=>trace.slice(),async terminate(){await worker.terminate();lost();}});
  }
  const ready=await new Promise<z.infer<typeof readySchema>>((resolve,reject)=>{
    const timer=setTimeout(()=>{void worker.terminate();reject(new Error("worker-ready-timeout"));},10000);
    const onMessage=(raw:unknown)=>{const r=readySchema.safeParse(raw);if(r.success){clearTimeout(timer);worker.off("message",onMessage);resolve(r.data);}};
    worker.on("message",onMessage);worker.once("error",e=>{clearTimeout(timer);reject(e);});worker.once("exit",()=>{clearTimeout(timer);reject(new Error("worker-before-ready"));});
    worker.postMessage({version:1,kind:"boot",hostEpoch:input.profile.hostEpoch,root,held});
  });
  function send<K extends Operation>(operation:K,parameters:unknown[]):Promise<Awaited<ReturnType<WorkerOperations[K]>>> {
    input.profile.assertHeld();if(dead)return Promise.reject(new Error("worker-lost"));
    const first=parameters[0] as {owner?:PersistenceOwner;sourceKey?:string}|undefined,source=first?.owner?.sourceKey??first?.sourceKey??"core";
    let requestId:number|undefined;
    const work=queue.run(source,charge(parameters)+256,input.now()+10000,()=>new Promise<Awaited<ReturnType<WorkerOperations[K]>>>((resolve,reject)=>{
      const id=++next;requestId=id;const request=PersistenceWorkerRequest.parse({version:1,id,operation,args:parameters});pending.set(id,{resolve:resolve as (v:unknown)=>void,reject});worker.postMessage(request);
    }));
    let timer:ReturnType<typeof setTimeout>;
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{
      const t=parameters[0] as PublicationTicket|undefined;if(t?.id)ledger.get(t.id)?.gate.shorten(input.now(),input.now());
      if(requestId!==undefined)worker.postMessage({version:1,kind:"cancel",id:requestId});reject(new Error("timeout"));
    },10000);});
    return Promise.race([work,timeout]).finally(()=>clearTimeout(timer));
  }
  const engine:PersistenceBackend["engine"]={
    async reserve(t,size){
      input.profile.assertHeld();const slot=gateOffset(sequence+1);
      if(ready.recovery!=="ready" || retired.has(ownerKey(t.owner)) || t.target.kind==="record" && targets.has(JSON.stringify([ownerKey(t.owner),t.target.id])) || ledger.has(t.id) || slots.has(slot))throw new Error("stale");
      slots.add(slot);const gate=new PublicationGate(t.deadlineMonotonicMs,held,slot,true);
      ledger.set(t.id,{ticket:structuredClone(t),gate,sequence:++sequence});
      await send("engine.reserve",[t,size]);
    },
    append:(t,o,b)=>send("engine.append",[t,o,b]),seal:(t,n,h)=>send("engine.seal",[t,n,h]),
    async publish(t){try{return await send("engine.publish",[t]);}catch(e){if(ledger.get(t.id)?.gate.dispatched)return {disposition:"unknown"};throw e;}},
    reconcile:t=>send("engine.reconcile",[t]),abort:t=>send("engine.abort",[t]),
    fence(owner,deadline){retired.add(ownerKey(owner));const ids:string[]=[];for(const e of ledger.values())if(ownerKey(e.ticket.owner)===ownerKey(owner)){e.gate.shorten(deadline,input.now());ids.push(e.ticket.id);}return ids;},
    fenceTarget(owner,id,deadline){targets.add(JSON.stringify([ownerKey(owner),id]));const ids:string[]=[];for(const e of ledger.values())if(ownerKey(e.ticket.owner)===ownerKey(owner) && e.ticket.target.kind==="record" && e.ticket.target.id===id){e.gate.shorten(deadline,input.now());ids.push(e.ticket.id);}return ids;},
  };
  const backend:PersistenceBackend={engine,
    reads:{settings:o=>send("reads.settings",[o]),stat:(o,id)=>send("reads.stat",[o,id]),list:(o,p)=>send("reads.list",[o,p]),open:(o,id,r)=>send("reads.open",[o,id,r]),read:(o,p,n,m)=>send("reads.read",[o,p,n,m]),close:(o,p)=>send("reads.close",[o,p])},
    evidence:{
      capture(scope,deadline){input.profile.assertHeld();const barrier=Object.freeze({id:randomUUID(),scope:structuredClone(scope),through:sequence,deadlineMonotonicMs:deadline});barriers.set(barrier.id,{barrier,tickets:[...ledger.values()].filter(e=>e.sequence<=barrier.through && matches(scope,e.ticket)).map(e=>e.ticket)});return barrier;},
      tickets(b){const saved=barriers.get(b.id);if(!saved || JSON.stringify(saved.barrier)!==JSON.stringify(b))throw new Error("stale");return structuredClone(saved.tickets);},
      flush(b){backend.evidence.tickets(b);return send("evidence.flush",[b]);},quota:o=>send("evidence.quota",[o]),settingsDigest:o=>send("evidence.settingsDigest",[o]),
      auxiliary:(o,k,key)=>send("evidence.auxiliary",[o,k,key]),auxiliaryKeys:(o,k,c)=>send("evidence.auxiliaryKeys",[o,k,c]),recoveryPage:c=>send("evidence.recoveryPage",[c]),
      loadRecovery:id=>send("evidence.loadRecovery",[id]),saveRecovery:v=>send("evidence.saveRecovery",[v]),removeRecovery:id=>send("evidence.removeRecovery",[id]),
    },
    imports:{load:(o,id)=>send("imports.load",[o,id]),plan:(o,p)=>send("imports.plan",[o,p]),tagImport:(t,tag)=>send("imports.tagImport",[t,tag]),importReceipts:(o,id)=>send("imports.importReceipts",[o,id]),record:(o,id,e)=>send("imports.record",[o,id,e]),reconcile:t=>send("imports.reconcile",[t]),complete:(o,id)=>send("imports.complete",[o,id])},
    destinations:{async register(i){const id=await send("destinations.register",[i]) as unknown as string;const token=Object.freeze({}) as ExportDestination;destinations.set(token,id);return token;},release:d=>{const id=destinations.get(d);if(!id)throw new Error("stale");return send("destinations.release",[id]);}},
    output:{begin:(id,o,d,n,h,deadline)=>{const token=destinations.get(d);if(!token)throw new Error("stale");return send("output.begin",[id,o,token,n,h,deadline]);},append:(id,o,b)=>send("output.append",[id,o,b]),commit:id=>send("output.commit",[id]),reconcile:id=>send("output.reconcile",[id]),abort:id=>send("output.abort",[id])},
    sources:{register:i=>send("sources.register",[i]),map:(d,k)=>send("sources.map",[d,k]),appendMapped:i=>send("sources.appendMapped",[i]),releaseMapped:m=>send("sources.releaseMapped",[m]),inventory:d=>send("sources.inventory",[d]),read:(d,k,o,n)=>send("sources.read",[d,k,o,n])},
    dispose(){return closing??=new Promise<void>((resolve,reject)=>{input.profile.assertHeld();for(const e of ledger.values())e.gate.shorten(input.now(),input.now());worker.once("exit",code=>{channel?.port1.close();Atomics.store(new Int32Array(held),0,0);code===0?resolve():reject(new Error("worker-dispose-unknown"));});worker.postMessage({version:1,kind:"close"});});},
  };
  diagnosticInstances.set(backend,{snapshot:()=>({owners:0,bindings:0,subscriptions:0,queuedEvents:0,queuedBytes:0,timers:0,pendingInvocations:0,actionTokens:0,resourceReaders:0,workerJobs:queue.pending}),onEvent:()=>()=>{}});
  return {backend,recovery:ready.recovery};
}

export function runPersistenceWorker(input:{mappers:ReadonlyMap<string,LegacyImportDescriptor>}):void {
  if(!parentPort)throw new Error("worker-port-missing");const port=parentPort;
  port.once("message",async raw=>{
    const boot=bootSchema.parse(raw);if(!path.isAbsolute(boot.root) || boot.held.byteLength!==16+1024*16)throw new Error("invalid-boot");
    const profile:ProfileWriterLock={hostEpoch:boot.hostEpoch,assertHeld(){if(Atomics.load(new Int32Array(boot.held),0)!==1)throw new Error("not-primary");}};
    profile.assertHeld();const faultPort=(workerData as {faultPort?:MessagePort}).faultPort;
    const armed=new Map<PersistenceFaultPoint,"pause"|"fail"|"kill">(),paused=new Map<PersistenceFaultPoint,()=>void>();
    faultPort?.on("message",m=>{if(m.kind==="arm")armed.set(m.point,m.action);if(m.kind==="release"){paused.get(m.point)?.();paused.delete(m.point);}});
    const activeTicket=new AsyncLocalStorage<string|null>();
    const fs=new NodePersistenceFs(boot.root,profile,{fault:async(point,edge)=>{
      if(edge!=="before")return;
      faultPort?.postMessage({point,time:performance.now(),ticket:activeTicket.getStore()??null});const action=armed.get(point);if(!action)return;armed.delete(point);
      if(action==="kill")process.exit(71);if(action==="fail")throw Object.assign(new Error("injected"),{code:"EIO"});
      await new Promise<void>(resolve=>paused.set(point,resolve));
    }});
    await fs.check(fs.path());const store=new AtomicStore(fs),output=new NativeOutput(profile,store.quota,()=>performance.now(),fs),sources=new WorkerSources(boot.root,store,input.mappers);
    let recovery:"ready"|"blocked"="ready";try{await store.initialize();}catch{recovery="blocked";}
    const queue=new WorkQueue(()=>performance.now()),accepted:Array<{sequence:number;ticket:PublicationTicket}>=[],destinations=new Map<string,ExportDestination>();let seq=0,closed=false;const requests=new Map<number,z.infer<typeof PersistenceWorkerRequest>>();
    const api={
      "engine.reserve":(t:PublicationTicket,n:number)=>store.reserve(t,n,boot.held,gateOffset(accepted.find(e=>e.ticket.id===t.id)!.sequence)),"engine.append":store.append.bind(store),"engine.seal":store.seal.bind(store),"engine.publish":store.publish.bind(store),"engine.reconcile":store.reconcile.bind(store),"engine.abort":store.abort.bind(store),
      "reads.settings":store.settings.bind(store),"reads.stat":store.stat.bind(store),"reads.list":store.list.bind(store),"reads.open":store.open.bind(store),"reads.read":store.read.bind(store),"reads.close":store.close.bind(store),
      "evidence.flush":(b:PersistenceBarrier)=>store.flushEvidence(b,accepted.filter(e=>e.sequence<=b.through && matches(b.scope,e.ticket)).map(e=>e.ticket)),
      "evidence.quota":async(o:PersistenceOwner)=>({ok:true as const,value:store.quota.snapshot(o.sourceKey)}),"evidence.settingsDigest":store.settingsDigest.bind(store),"evidence.auxiliary":store.auxiliary.bind(store),"evidence.auxiliaryKeys":store.auxiliaryKeys.bind(store),"evidence.recoveryPage":store.recoveryPage.bind(store),"evidence.loadRecovery":store.loadRecovery.bind(store),"evidence.saveRecovery":store.saveRecovery.bind(store),"evidence.removeRecovery":store.removeRecovery.bind(store),
      "imports.load":store.loadImport.bind(store),"imports.plan":store.planImport.bind(store),"imports.tagImport":store.tagImport.bind(store),"imports.importReceipts":store.importReceipts.bind(store),"imports.record":store.recordImport.bind(store),"imports.reconcile":store.reconcileImport.bind(store),"imports.complete":store.completeImport.bind(store),
      "destinations.register":async(i:Parameters<NativeOutput["register"]>[0])=>{const value=await output.register(i),id=randomUUID();destinations.set(id,value);return id;},"destinations.release":async(id:string)=>{const d=destinations.get(id);if(!d)throw new Error("stale");await output.release(d);},
      "output.begin":(id:string,o:PersistenceOwner,d:string,n:number,h:string,deadline:number)=>{const token=destinations.get(d);if(!token)throw new Error("stale");return output.begin(id,o,token,n,h,deadline);},"output.append":output.append.bind(output),"output.commit":output.commit.bind(output),"output.reconcile":output.reconcile.bind(output),"output.abort":output.abort.bind(output),
      "sources.register":sources.register.bind(sources),"sources.map":sources.map.bind(sources),"sources.appendMapped":sources.appendMapped.bind(sources),"sources.releaseMapped":sources.releaseMapped.bind(sources),"sources.inventory":sources.inventory.bind(sources),"sources.read":sources.read.bind(sources),
    };
    port.on("message",raw=>{
      const cancel=z.strictObject({version:z.literal(1),kind:z.literal("cancel"),id:count.min(1)}).safeParse(raw);
      if(cancel.success){const original=requests.get(cancel.data.id);const t=original?.args[0];const parsed=publicationTicketSchema.safeParse(t);if(parsed.success)store.fenceTargetOrTicket(parsed.data);return;}
      if(z.strictObject({version:z.literal(1),kind:z.literal("close")}).safeParse(raw).success){closed=true;void (async()=>{while(queue.pending)await new Promise(r=>setTimeout(r,1));await store.dispose();for(const d of destinations.values())await output.release(d);output.assertSettled();faultPort?.close();port.close();})().catch(()=>{process.exitCode=72;faultPort?.close();port.close();});return;}
      const parsed=PersistenceWorkerRequest.safeParse(raw);if(!parsed.success || closed)return;
      const r=parsed.data;
      requests.set(r.id,r);
      if(recovery==="blocked" && !["evidence.recoveryPage","evidence.loadRecovery","evidence.auxiliary","evidence.auxiliaryKeys","imports.load","imports.importReceipts","imports.reconcile"].includes(r.operation)){port.postMessage({version:1,id:r.id,ok:false,error:{code:"io",message:"unsupported-format"}});return;}
      if(r.operation==="engine.reserve")accepted.push({sequence:++seq,ticket:publicationTicketSchema.parse(r.args[0])});
      const first=r.args[0] as {owner?:PersistenceOwner;sourceKey?:string;id?:string}|undefined;
      void queue.run(first?.owner?.sourceKey??first?.sourceKey??"core",charge(r.args)+256,performance.now()+10000,async()=>{
        profile.assertHeld();
        const fn=api[r.operation] as (...parameters:unknown[])=>Promise<unknown>;return activeTicket.run(first?.owner?first.id??null:null,()=>fn(...r.args));
      }).then(value=>port.postMessage({version:1,id:r.id,ok:true,value}),()=>port.postMessage({version:1,id:r.id,ok:false,error:{code:"io",message:"persistence-io"}})).finally(()=>requests.delete(r.id));
    });
    port.postMessage({version:1,kind:"ready",recovery});
  });
}
// K170's CJS entry footer calls exports.runPersistenceWorker({mappers:new Map()}).
// The module itself has no auto-start side effect, so T7's wrapper can call the runner once.

```

The private scope schema is exactly `{hostEpoch,workbenchInstance}` from core-actions.ts. Destination scope validation remains main-derived, and registry IDs never become transferable authority. For the test wrapper, call `runPersistenceWorker({mappers})` exactly once; it receives its private fault port through the launch and does not set a product environment flag.

Amend `PublicationGate`'s constructor to `constructor(deadline:number,memory?:SharedArrayBuffer,byteOffset=0,initialize=memory===undefined)` and construct `new BigInt64Array(this.memory,byteOffset,2)`; initialize the two words only when `initialize` is true. Amend AtomicStore.reserve's private overload to `(ticket,byteLength,memory?:SharedArrayBuffer,byteOffset=0)` and pass the offset to PublicationGate. This private overload does not change `PersistenceEnginePort.reserve`. Gates use stable, collision-rejected slots; reclaim a slot only after the original ticket is known settled and its bounded reconciliation retention ends. Do not recycle an unknown publication's slot. Assert the profile before every filesystem write and gate dispatch.

Add main request timeouts of 10 seconds using `Promise.race` around the queued promise, sending a private cancel-by-request-ID frame and shortening its gate. Keep the queue reservation until the actual operation settles; a timed-out syscall still consumes its bytes/job slot. Worker applies cancellation to the original admitted ticket, never to a reconstructed current generation. Worker response errors map only to the five frozen private codes and sanitized messages; retain original path-free reason in durable evidence. On lost worker, fence every admitted ticket and keep unknown outcomes for original-ticket reconciliation. Boot timeout terminates the child and closes both fault ports before rejecting.

- [ ] **Step 10a: Verify native destinations, opaque bytes and future result projection**

Append to `filesystem.test.ts`, reusing its `setup`, `profile` and imports; add imports for `NativeOutput`, `QuotaLedger`, `randomUUID` and `createHash`:

```ts
it("registers a native destination, rejects identity swap and preserves old bytes",async()=>{
  const {root,fs}=await setup(),quota=new QuotaLedger(),output=new NativeOutput(profile,quota,()=>0,fs);
  const destination=path.join(root,"export.bin");await writeFile(destination,new Uint8Array([9]));
  const bytes=new Uint8Array([0,255,1]),sha=createHash("sha256").update(bytes).digest("hex");
  const owner={sourceKey:"builtin:kobrixa.lab",pluginId:"kobrixa.lab",generation:1,hostEpoch:profile.hostEpoch,processEpoch:randomUUID()};
  const token=await output.register({action:randomUUID(),scope:{hostEpoch:profile.hostEpoch,workbenchInstance:randomUUID()},nativePath:destination,deadlineMonotonicMs:10000});
  const id=randomUUID();await output.begin(id,owner,token,bytes.length,sha,10000);await output.append(id,0,bytes);
  const result=await output.commit(id);expect(result.disposition).toBe("committed");
  expect((await output.reconcile(id)).commitId).toBe(result.commitId);await output.release(token);
  const next=await output.register({action:randomUUID(),scope:{hostEpoch:profile.hostEpoch,workbenchInstance:randomUUID()},nativePath:destination,deadlineMonotonicMs:10000});
  const job=randomUUID();await output.begin(job,owner,next,bytes.length,sha,10000);await output.append(job,0,bytes);
  const swapped=path.join(root,"swap.bin");await writeFile(swapped,new Uint8Array([8]));
  await rename(swapped,destination);
  await expect(output.commit(job)).rejects.toThrow("destination-changed");
  expect(await readFile(destination)).toEqual(Buffer.from([8]));await output.abort(job);await output.release(next);
});
```

Add `readFile` and `rename` to the test's existing node:fs/promises import. The identity-change case checks destination bytes after rejection; a successful case compares the full payload hash/length and receipt. In `atomic-store.test.ts`, add:

```ts
it("record objects have no version prefix and unknown head versions never rewrite bytes",async()=>{
  const env=await setup(),bytes=new Uint8Array([0,255,123,34,0,10]),t=ticket(bytes);
  try {
    await stage(env.store,t,bytes);await env.store.publish(t);
    const ns=await Namespace.open(env.fs,owner.sourceKey),loc=await ns.location(t.target),head=(await ns.head(loc))!;
    const raw=await env.fs.bytes(ns.object(loc,head),8388608);expect(raw).toEqual(bytes);expect(raw.length).toBe(bytes.length);expect(hash(raw)).toBe(hash(bytes));
    await env.fs.unlink(loc.head);await ns.writeNew(loc.head,{...head,formatVersion:99});
    await expect(ns.head(loc)).rejects.toThrow("unsupported-format");
    expect(await env.fs.bytes(ns.object(loc,head),8388608)).toEqual(bytes);
  }finally{await env.close();}
});
```

Add `Namespace` to that test's imports. Apply the authoritative B2 §6 wording from `spec-corrections.md` §4.1: record `.bin` objects are exact opaque bytes; JSON identity/head/intent/settings/import/recovery envelopes carry `formatVersion:1`. Do not edit the spec in this task. Include unknown settings/import/recovery envelope versions in `recovery-scan.test.ts`; preserve the original bytes and return blocked recovery, never empty history or rewritten defaults.

Run the complete T2 command in Step 12. Expected: PASS for destination cancellation/identity/unknown reconciliation, exact record length/hash, unsupported formats, independent namespace/target barriers, bounded pages, immutable tags and original-ticket restart reconciliation. T7 consumes `diagnosticsFor(backend)` read-only under AM-22 and records real worker-job counts; it owns the FoundationFixture producer and installed fault/measurement runs.

- [ ] **Step 11: Run the real worker and kill-point suite**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/persistence/worker.test.ts
```

Expected: PASS for the real Node worker at all 15 named fault points, both syscall sides in the filesystem/atomic suite, unchanged-or-complete head evidence, and repeated recovery without a second publication. This is a worker-loss model; full Electron host-process termination and installed packaging are still controller gates.

- [ ] **Step 12: Run the complete owned suite and type checks**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-sdk build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/device build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/persistence/filesystem.test.ts src/main/plugins/persistence/engine-port.test.ts src/main/plugins/persistence/namespace.test.ts src/main/plugins/persistence/atomic-store.test.ts src/main/plugins/persistence/quota.test.ts src/main/plugins/persistence/recovery-scan.test.ts src/main/plugins/persistence/worker.test.ts src/main/plugins/persistence/contract.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop check
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git diff --check
```

Expected: PASS for the F-based branch and all owned tests. Full desktop/lint/schema/SDK publication checks are shared integration gates in skeleton §6 and the final verification section supplied by P12. Do not rerun unrelated broad suites after unchanged results. If an unmerged shared prerequisite prevents the desktop check, record the actual error and prerequisite SHA; do not fabricate substitute production modules.

Controller runs outside sandbox for the following **later** evidence, after T7/H-K/H-D install their assigned files: actual Electron host kill/restart, package worker launch/exit, Windows same-volume replacement and junction/reparse cases, Linux/macOS directory sync policy, SSD 30-sample latency/RSS, and storage-pressure plus device safety-stop dispatch. Those gates remain pending here. Exact numerical acceptance remains the Global Constraints table: 50×8 MiB, two additional reservations, four I/O jobs, main synchronous segment ≤16 ms, extra main/worker RSS ≤32/64 MiB, warm list p95≤200 ms, commit/flush≤10 s, stop-dispatch added p95≤50 ms. Report OS/architecture, CPU/RAM/filesystem, artifact/commit, Node/Electron, actual fixture bytes/count, warm/cold, 30 samples p50/p95/max, separate main/worker RSS and measurement method.

- [ ] **Step 13: Supply the stopped-owner handoff and commit the exact T2 files**

Supply T3/T4/T5/T6 with the unchanged port definitions and the concrete helpers declared above. `settings()` consumes a payload envelope `{formatVersion:1,schemaVersion,validationDigest,values}`; record payloads stay exact opaque bytes; auxiliary import/recovery payloads are bounded JSON documents stored through the same head primitive. Import writers call `tagImport` immediately after `reserve` and before sending bytes, then recover committed item tags through `importReceipts` before deciding whether to allocate another record ID. Core services retain typed failure reports and never infer rollback from timeout.

D170 calls `openStoreRoot({userData, profile})`, then awaits `startPersistenceWorker({profile, root, workerEntry: persistenceWorkerPath({packaged, resourcesPath, buildRoot}), now})`. Pass `backend` explicitly in `composition` to `createPersistenceHost` together with admitted sources, the broker's event ledger, original-peer drain dispatcher and AM-29 import host. K170 supplies the exact packaged entry from AM-23. The same profile stays held until host services drain, backend disposes and worker exits. A blocked scan exposes read-only recovery; unknown outcomes retain evidence. There is one root capability and one worker, and no production test selector.

Controller runs outside sandbox after review; the plan writer does not execute this commit:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git add apps/desktop/src/main/plugins/persistence/filesystem.ts apps/desktop/src/main/plugins/persistence/filesystem.test.ts apps/desktop/src/main/plugins/persistence/engine-port.ts apps/desktop/src/main/plugins/persistence/engine-port.test.ts apps/desktop/src/main/plugins/persistence/namespace.ts apps/desktop/src/main/plugins/persistence/namespace.test.ts apps/desktop/src/main/plugins/persistence/atomic-store.ts apps/desktop/src/main/plugins/persistence/atomic-store.test.ts apps/desktop/src/main/plugins/persistence/quota.ts apps/desktop/src/main/plugins/persistence/quota.test.ts apps/desktop/src/main/plugins/persistence/recovery-scan.ts apps/desktop/src/main/plugins/persistence/recovery-scan.test.ts apps/desktop/src/main/plugins/persistence/worker.ts apps/desktop/src/main/plugins/persistence/worker.test.ts apps/desktop/src/main/plugins/persistence/contract.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git diff --cached --check
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git commit -m "feat(plugins): add bounded atomic persistence worker and recovery"
```

### Task 3B2-T3: Settings service and immediate per-field forms

**Files**

- Create: `apps/desktop/src/main/plugins/persistence/settings-service.ts`
- Create/Test: `apps/desktop/src/main/plugins/persistence/settings-service.test.ts`
- Create: `apps/desktop/src/renderer/settings/contributed-settings-store.ts`
- Create/Test: `apps/desktop/src/renderer/settings/contributed-settings-store.test.ts`
- Create: `apps/desktop/src/renderer/settings/contributed-settings-form.tsx`
- Create/Test: `apps/desktop/src/renderer/settings/contributed-settings-form.test.ts`
- Modify (T0 scaffold; baseline N): `packages/plugin-runtime/src/settings-form-port.ts`

**Interfaces**

Consumes `SettingsResourceV1`, `SettingsSnapshot`, `SettingsMutation`, `Values`, `SettingsRequestMap`, `Scalar as SettingsScalar`, `SettingKey` and `SettingsText` from the protocol's B2 modules; `Principal`, `PersistenceOwner`, `CoreWindowScope`, and `UiOwner` from their canonical owners. The compiled package barrels must contain the type-only exports recorded in F. Do not register 1.7 methods on the 1.5/1.6 branches.

Consumes the unchanged T2 signatures:

```ts
interface PersistenceReadPort {
  settings(owner: PersistenceOwner): Promise<SettingsSnapshot | null>;
  stat(owner: PersistenceOwner, id: RecordId): Promise<RecordMeta>;
  list(owner: PersistenceOwner, input: { kind?: string; limit: number; cursor?: Handle }):
    Promise<{ entries: RecordMeta[]; nextCursor?: Handle }>;
  open(owner: PersistenceOwner, id: RecordId, revision: RecordRevision): Promise<Handle>;
  read(owner: PersistenceOwner, pin: Handle, offset: number, maxBytes: number): Promise<Uint8Array>;
  close(owner: PersistenceOwner, pin: Handle): Promise<void>;
}
interface PersistenceEnginePort {
  reserve(ticket: PublicationTicket, byteLength: number): Promise<void>;
  append(ticket: PublicationTicket, offset: number, bytes: Uint8Array): Promise<number>;
  seal(ticket: PublicationTicket, byteLength: number, sha256: Sha256): Promise<void>;
  publish(ticket: PublicationTicket): Promise<{
    disposition: "not-committed" | "committed" | "unknown";
    receipt?: Receipt<SettingsRevision | RecordRevision>;
  }>;
  fence(owner: PersistenceOwner, deadlineMonotonicMs: number): readonly Handle[];
  fenceTarget(owner: PersistenceOwner, id: RecordId, deadlineMonotonicMs: number): readonly Handle[];
  reconcile(ticket: PublicationTicket): ReturnType<PersistenceEnginePort["publish"]>;
  abort(ticket: PublicationTicket): Promise<"aborted" | "committed" | "unknown">;
}
```

Produces the unchanged `SettingsFormBinding` and `SettingsFormPort` below, plus local service/store constructors. `SettingsControlsPort` and `SettingsDraftState` are imported from B1-T7's `renderer/plugin-ui/host-ports.ts`; do not define competing copies in runtime. Its exact consuming signature is:

```ts
interface SettingsControlsPort {
  render(binding: SettingsFormBinding, resource: SettingsResourceV1, state: SettingsDraftState): void;
  onChange(listener: (binding: SettingsFormBinding, key: SettingKey, value: SettingsScalar,
    phase: "change" | "blur" | "enter" | "reset") => void): () => void;
  dispose(binding: SettingsFormBinding): void;
}
```

Preconditions: the controller has recorded F and relinquished the seven paths. T1 validators, T2 storage, B1 controls, and the shared subscription ledger are read-only dependencies. W1 uses explicit constructor doubles; P170 acceptance replaces every double. The inspected baseline contains none of these seven files. Existing settings-panel/app/i18n, legacy settings stores, and packaged-json-resource.ts are reference inputs, not this task's write set. No Electron or installation command runs here.

AM-23–29 supply the production dependencies: use one `PersistenceBackend`, the admitted `PersistenceSourcePort`, and the broker’s `CommonEventLedgerPort`. Unit doubles below isolate algorithms; P170 must run these services over T2’s actual worker and shared 32-subscription ledger.

- [ ] **Step 1: Write the settings CAS, schema lifetime and watch tests**

Place this isolated evidence double in settings-service.test.ts, record-service.test.ts and lifecycle.test.ts (each task owns its own test helper); import `StoredRecovery` from engine-port.ts. Production always receives the complete T2 evidence port. The real-worker checks in T5 Step 10 are required separately.

```ts
import type { PersistenceEvidencePort } from "./engine-port.js";
function evidenceDouble(overrides: Partial<PersistenceEvidencePort> = {}): PersistenceEvidencePort {
  let sequence = 0;
  const recovery = new Map<string, StoredRecovery>();
  return {
    capture: (scope, deadlineMonotonicMs) => ({ id: crypto.randomUUID(), scope,
      through: sequence++, deadlineMonotonicMs }),
    flush: async () => ({ state: "saved", accepted: [], incomplete: [], unknown: [] }),
    tickets: () => [], settingsDigest: async () => null,
    quota: async () => { throw new Error("Quota not exercised by this unit."); },
    auxiliary: async () => null, auxiliaryKeys: async () => ({ keys: [], nextCursor: null }),
    recoveryPage: async () => ({ items: [...recovery.values()], nextCursor: null }),
    loadRecovery: async id => recovery.get(id) ?? null,
    saveRecovery: async value => { recovery.set(value.id, structuredClone(value)); },
    removeRecovery: async id => { recovery.delete(id); },
    ...overrides,
  };
}
```


Create `apps/desktop/src/main/plugins/persistence/settings-service.test.ts`:

```ts
import { expect, it, vi } from "vitest";
import type { SettingsResourceV1, SettingsSnapshot, ResourceOwner } from "@kobrixa/plugin-protocol";
import { createSettingsService, settingsFailure, type SettingsDependencies } from "./settings-service.js";

const owner: ResourceOwner = {
  sourceKey: "builtin:test.settings", pluginId: "test.settings", generation: 1,
  hostEpoch: "00000000-0000-4000-8000-000000000001",
  processEpoch: "00000000-0000-4000-8000-000000000002",
};
const principal = { kind: "plugin" as const, owner, authorityContext: null };
const resource: SettingsResourceV1 = {
  schemaVersion: 1, title: { en: "Settings" }, fields: [
    { key: "connection.mode", type: "enum", label: { en: "Mode" }, default: 1,
      options: [{ value: 1, label: { en: "Numeric" } }, { value: "1", label: { en: "Text" } }] },
    { key: "enabled", type: "boolean", label: { en: "Enabled" }, default: true },
  ],
};
function fixture() {
  let stored: SettingsSnapshot | null = null;
  let revision = 0;
  let live = true;
  const pending = new Map<string, { values: SettingsSnapshot["values"]; version: number }>();
  const publish = vi.fn<SettingsDependencies["engine"]["publish"]>(async (ticket) => {
    const data = pending.get(ticket.id)!;
    if (ticket.target.kind !== "settings") throw new Error("wrong target");
    if (ticket.target.expectedRevision !== (stored?.revision ?? null))
      throw new Error("revision-mismatch");
    revision++;
    const receipt = { revision: `r_${revision.toString(16).padStart(32, "0")}`,
      commitId: ticket.id, durability: "file-and-directory-sync" as const };
    stored = { schemaVersion: data.version, revision: receipt.revision, values: data.values };
    return { disposition: "committed", receipt };
  });
  const changed = vi.fn();
  const subscribe = vi.fn(() => "00000000-0000-4000-8000-000000000003");
  const deps: SettingsDependencies = {
    now: () => 0, allowed: () => live, validateResource: () => true,
    readResource: async () => ({ resource, digest: "a".repeat(64), validationDigest: "b".repeat(64) }),
    evidence: evidenceDouble({ settingsDigest: async () => stored ? { schemaVersion: stored.schemaVersion, revision: stored.revision!, validationDigest: "b".repeat(64) } : null }),
    read: { settings: async () => structuredClone(stored) },
    engine: {
      reserve: async (ticket) => {
        if (ticket.metadata.kind !== "settings") throw new Error("wrong metadata");
        pending.set(ticket.id, { values: [], version: ticket.metadata.schemaVersion });
      },
      append: async (ticket, _offset, bytes) => {
        pending.get(ticket.id)!.values = JSON.parse(new TextDecoder().decode(bytes));
        return bytes.length;
      },
      seal: async () => {}, publish,
      fence: () => [], fenceTarget: () => [], reconcile: publish,
      abort: async () => "aborted",
    },
    watch: { register: subscribe, changed, invalidate: vi.fn() },
  };
  return { deps, service: createSettingsService(deps), publish, changed, subscribe,
    setLive: (value: boolean) => { live = value; },
    setStored: (value: SettingsSnapshot | null) => { stored = value; } };
}
const signal = () => new AbortController().signal;
it("B2-12.1-1: defaults/null do not publish; simultaneous CAS commits once", async () => {
  const f = fixture();
  const initial = await f.service.request(principal, "settings/read", { schemaVersion: 1 }, signal());
  expect(initial).toMatchObject({ ok: true, value: { revision: null } });
  expect(f.publish).not.toHaveBeenCalled();
  const result = await Promise.all([false, true].map((value) => f.service.request(principal,
    "settings/update", { schemaVersion: 1, expectedRevision: null,
      changes: [{ key: "enabled", value }] }, signal())));
  expect(result.filter((x) => x.ok)).toHaveLength(1);
  expect(result.find((x) => !x.ok)).toMatchObject({ error: { code: "PLUGIN_E_SETTINGS_CONFLICT" } });
  expect(f.publish).toHaveBeenCalledOnce();
  expect(f.changed).toHaveBeenCalledOnce();
});
it("B2-12.1-1: mixed enum types, duplicates, unknown keys and invalid values", async () => {
  const f = fixture();
  for (const changes of [
    [{ key: "enabled", value: 1 }], [{ key: "unknown", value: true }],
    [{ key: "enabled", value: true }, { key: "enabled", value: false }],
    [{ key: "connection.mode", value: 2 }],
  ]) {
    expect(await f.service.request(principal, "settings/update",
      { schemaVersion: 1, expectedRevision: null, changes }, signal())).toMatchObject({ ok: false });
  }
  const result = await f.service.request(principal, "settings/update", { schemaVersion: 1,
    expectedRevision: null, changes: [{ key: "connection.mode", value: "1" }] }, signal());
  expect(result).toMatchObject({ ok: true, value: { snapshot: { values:
    [{ key: "connection.mode", value: "1" }, { key: "enabled", value: true }] } } });
});
it("B2-12.1-4: watch and commit share the namespace queue, with baseline sequence zero", async () => {
  const f = fixture();
  const watched = await f.service.request(principal, "settings/watch", { schemaVersion: 1 }, signal());
  expect(watched).toMatchObject({ ok: true, value: { sequence: 0, snapshot: { revision: null } } });
  await f.service.request(principal, "settings/update", { schemaVersion: 1,
    expectedRevision: null, changes: [{ key: "enabled", value: false }] }, signal());
  expect(f.subscribe).toHaveBeenCalledBefore(f.changed);
  expect(f.changed.mock.calls[0]![1]).not.toHaveProperty("values");
});
it("B2-10 schema: disabled catalog never reads a resource; corrupt reads are not defaults", async () => {
  const f = fixture();
  const read = vi.spyOn(f.deps, "readResource");
  f.setLive(false);
  expect(await f.service.request(principal, "settings/read", { schemaVersion: 1 }, signal()))
    .toMatchObject({ error: { code: "PLUGIN_E_DISABLED" } });
  expect(read).not.toHaveBeenCalled();
  f.setLive(true);
  f.deps.read.settings = async () => { throw settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "corrupt"); };
  const result = await f.service.request(principal, "settings/read", { schemaVersion: 1 }, signal());
  expect(result).toMatchObject({ error: { detail: { reason: "corrupt" } } });
  expect(JSON.stringify(result)).not.toContain("/private");
});
it("B2-10 unknown: reconcile the original ticket without publishing twice", async () => {
  const f = fixture();
  f.deps.engine.publish = vi.fn(async () => ({ disposition: "unknown" as const }));
  const first = await f.service.request(principal, "settings/update", { schemaVersion: 1,
    expectedRevision: null, changes: [{ key: "enabled", value: false }] }, signal());
  expect(first).toMatchObject({ error: { detail: { disposition: "unknown" } } });
  await f.service.request(principal, "settings/read", { schemaVersion: 1 }, signal());
  expect(f.deps.engine.publish).toHaveBeenCalledOnce();
  expect(f.publish).toHaveBeenCalledOnce();
});
it("B2-12.1-1: reset cannot overwrite a newer schema and migration is explicit", async () => {
  const f = fixture();
  f.setStored({ schemaVersion: 2, revision: `r_${"1".repeat(32)}`, values: [] });
  expect(await f.service.request(principal, "settings/reset", { schemaVersion: 1,
    expectedRevision: `r_${"1".repeat(32)}`, keys: ["enabled"] }, signal()))
    .toMatchObject({ error: { detail: { reason: "downgrade" } } });
  expect(f.publish).not.toHaveBeenCalled();
  f.setStored(null);
  expect(await f.service.request(principal, "settings/readMigration", {}, signal()))
    .toMatchObject({ error: { detail: { reason: "invalid-value" } } });
});
it("B2-12.1-1: validation digest drift blocks writes but display-only edits keep the digest", async () => {
  const f = fixture();
  const saved = await f.service.request(principal, "settings/update", { schemaVersion: 1,
    expectedRevision: null, changes: [{ key: "enabled", value: false }] }, signal());
  if (!saved.ok) throw new Error("save failed");
  f.deps.readResource = async () => ({ resource: { ...resource, title: { en: "New title" } },
    digest: "c".repeat(64), validationDigest: "b".repeat(64) });
  expect(await f.service.request(principal, "settings/read", { schemaVersion: 1 }, signal())).toMatchObject({ ok: true });
  f.deps.readResource = async () => ({ resource, digest: "d".repeat(64), validationDigest: "d".repeat(64) });
  expect(await f.service.request(principal, "settings/reset", { schemaVersion: 1,
    expectedRevision: saved.value.snapshot.revision, keys: ["enabled"] }, signal()))
    .toMatchObject({ error: { detail: { reason: "schema-changed-without-version" } } });
  expect(f.publish).toHaveBeenCalledOnce();
});
it("B2-12.1-4: a failed watch enqueue does not turn a committed receipt into save failure", async () => {
  const f = fixture(); f.deps.watch.changed = () => { throw new Error("queue full"); };
  expect(await f.service.request(principal, "settings/update", { schemaVersion: 1,
    expectedRevision: null, changes: [{ key: "enabled", value: false }] }, signal())).toMatchObject({ ok: true });
  expect(f.deps.watch.invalidate).toHaveBeenCalledWith(owner);
  expect(f.publish).toHaveBeenCalledOnce();
});

```

- [ ] **Step 2: Run the new tests and establish RED**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/persistence/settings-service.test.ts
```

Expected failure: missing `settings-service.js`; after a T0 stub, missing `createSettingsService`. A missing prepared dependency or package dist is setup failure, not a valid red test.

- [ ] **Step 3: Implement the settings service**

Create `apps/desktop/src/main/plugins/persistence/settings-service.ts`:

```ts
import { createHash, randomUUID } from "node:crypto";
import type {
  BusinessResult, Handle, Permission, PluginErrorCode, ResourceOwner,
  SettingsResourceV1, SettingsSnapshot, SettingsRequestMap, SettingsField,
  Values, SettingsScalar, PersistenceFailureDetail, PersistenceReason,
} from "@kobrixa/plugin-protocol";
import type { Principal } from "@kobrixa/plugin-runtime";
import type { PersistenceEnginePort, PersistenceReadPort, PersistenceEvidencePort, PublicationTicket } from "./engine-port.js";

type Failure = Extract<BusinessResult<never, PersistenceFailureDetail>, { ok: false }>;
type Change = { revision: string; schemaVersion: number; changedKeys: string[];
  cause: "update" | "reset" | "migrate" | "import" };
export type SettingsDependencies = {
  now(): number;
  allowed(principal: Principal, permission: Permission): boolean;
  readResource(owner: ResourceOwner): Promise<{
    resource: SettingsResourceV1; digest: string; validationDigest: string;
  }>;
  validateResource(resource: SettingsResourceV1): boolean;
  evidence: PersistenceEvidencePort;
  read: Pick<PersistenceReadPort, "settings">;
  engine: PersistenceEnginePort;
  watch: {
    register(owner: ResourceOwner): Handle;
    changed(owner: ResourceOwner, event: Change): void;
    invalidate(owner: ResourceOwner): void;
  };
};
export function settingsFailure(code: PluginErrorCode, reason: PersistenceReason): Failure {
  return { ok: false, error: { code, message: "Settings request could not be completed.",
    detail: { kind: "persistence", reason } } };
}
function scalarValid(field: SettingsField, value: SettingsScalar): boolean {
  switch (field.type) {
    case "boolean": return typeof value === "boolean";
    case "number": case "integer": return typeof value === "number" && Number.isFinite(value)
      && (field.type === "number" || Number.isSafeInteger(value))
      && value >= field.minimum && value <= field.maximum;
    case "enum": return field.options.some((option) => option.value === value);
    case "string": return typeof value === "string" && !/[\uD800-\uDFFF]/u.test(value)
      && [...value].length >= field.minLength && [...value].length <= field.maxLength
      && Buffer.byteLength(value) <= field.maxBytes;
  }
}
function valuesFor(resource: SettingsResourceV1, input: Values, complete: boolean): Values | Failure {
  if (input.length > 128 || new Set(input.map((x) => x.key)).size !== input.length)
    return settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "duplicate-key");
  const fields = new Map(resource.fields.map((field) => [field.key, field]));
  for (const { key, value } of input) {
    const field = fields.get(key);
    if (!field) return settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "unknown-key");
    if (!scalarValid(field, value)) return settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "invalid-value");
  }
  if (complete && input.length !== fields.size)
    return settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "invalid-value");
  const sorted = [...input].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return Buffer.byteLength(JSON.stringify(sorted)) <= 65536 ? sorted
    : settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "size-limit");
}
export function createSettingsService(deps: SettingsDependencies) {
  const tails = new Map<string, Promise<unknown>>();
  const unresolved = new Map<string, PublicationTicket>();
  type Handlers = { [M in keyof SettingsRequestMap]: (
    owner: ResourceOwner, params: SettingsRequestMap[M]["params"], signal: AbortSignal,
  ) => Promise<SettingsRequestMap[M]["result"]> };
  async function read(owner: ResourceOwner, version?: number, migration = false) {
    const loaded = await deps.readResource(owner);
    if (!deps.validateResource(loaded.resource)) throw settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "invalid-resource");
    if (version !== undefined && version !== loaded.resource.schemaVersion)
      throw settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "invalid-value");
    const ticket = unresolved.get(owner.sourceKey);
    if (ticket) {
      const result = await deps.engine.reconcile(ticket);
      if (result.disposition === "unknown") throw uncertain();
      unresolved.delete(owner.sourceKey);
    }
    let stored: SettingsSnapshot | null;
    try { stored = await deps.read.settings(owner); }
    catch (error) { throw isFailure(error) ? error : settingsFailure("PLUGIN_E_SETTINGS_SAVE", "io"); }
    if (!migration && stored) {
      if (stored.schemaVersion !== loaded.resource.schemaVersion)
        throw settingsFailure("PLUGIN_E_SETTINGS_SCHEMA",
          stored.schemaVersion > loaded.resource.schemaVersion ? "downgrade" : "migration-required");
      if ((await deps.evidence.settingsDigest(owner))?.validationDigest !== loaded.validationDigest)
        throw settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "schema-changed-without-version");
      const valid = valuesFor(loaded.resource, stored.values, true);
      if (!Array.isArray(valid)) throw settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "corrupt");
    }
    return { ...loaded, stored, snapshot: stored ?? {
      schemaVersion: loaded.resource.schemaVersion, revision: null,
      values: loaded.resource.fields.map(({ key, default: value }) => ({ key, value }))
        .sort((a, b) => a.key < b.key ? -1 : 1),
    } };
  }
  function uncertain(): Failure {
    return { ok: false, error: { code: "PLUGIN_E_SETTINGS_SAVE", message: "Save outcome requires reconciliation.",
      detail: { kind: "persistence", reason: "publish-uncertain", disposition: "unknown" } } };
  }
  async function mutate(owner: ResourceOwner, version: number, expected: string | null,
    change: Values | string[], cause: "update" | "reset" | "migrate", signal: AbortSignal,
    from?: number): Promise<SettingsRequestMap["settings/update"]["result"]> {
    const current = await read(owner, version, cause === "migrate");
    if (current.snapshot.revision !== expected)
      return settingsFailure("PLUGIN_E_SETTINGS_CONFLICT", "revision-mismatch");
    if (cause === "migrate" && (!current.stored || from !== current.stored.schemaVersion || from >= version))
      return settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "invalid-value");
    let changes: Values;
    if (cause === "reset") {
      const keys = change as string[];
      if (!keys.length || new Set(keys).size !== keys.length)
        return settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "duplicate-key");
      const defaults = new Map(current.resource.fields.map((field) => [field.key, field.default]));
      if (keys.some((key) => !defaults.has(key))) return settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "unknown-key");
      changes = keys.map((key) => ({ key, value: defaults.get(key)! }));
    } else changes = change as Values;
    const checked = valuesFor(current.resource, changes, cause === "migrate");
    if (!Array.isArray(checked)) return checked;
    if (!checked.length) return settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "invalid-value");
    const map = new Map((cause === "migrate" ? [] : current.snapshot.values).map((x) => [x.key, x.value]));
    for (const { key, value } of checked) map.set(key, value);
    const values = valuesFor(current.resource, [...map].map(([key, value]) => ({ key, value })), true);
    if (!Array.isArray(values)) return values;
    const ticket: PublicationTicket = Object.freeze({ id: randomUUID(), owner: Object.freeze({ ...owner }),
      deadlineMonotonicMs: deps.now() + 10000,
      metadata: { kind: "settings" as const, schemaVersion: version, validationDigest: current.validationDigest },
      target: { kind: "settings" as const, expectedRevision: expected } });
    const bytes = Buffer.from(JSON.stringify(values));
    const check = () => {
      if (signal.aborted) throw { ok: false, error: { code: "PLUGIN_E_CANCELLED", message: "Cancelled." } };
      if (deps.now() >= ticket.deadlineMonotonicMs) throw { ok: false, error: { code: "PLUGIN_E_TIMEOUT", message: "Timed out." } };
    };
    try {
      check(); await deps.engine.reserve(ticket, bytes.length); check();
      let offset = 0;
      while (offset < bytes.length) {
        const written = await deps.engine.append(ticket, offset, bytes.subarray(offset));
        if (written <= 0 || written > bytes.length - offset) throw new Error("short-write");
        offset += written; check();
      }
      await deps.engine.seal(ticket, bytes.length, createHash("sha256").update(bytes).digest("hex"));
      check();
      unresolved.set(owner.sourceKey, ticket);
      const result = await deps.engine.publish(ticket);
      if (result.disposition === "unknown") return uncertain();
      unresolved.delete(owner.sourceKey);
      if (result.disposition !== "committed" || !result.receipt)
        return settingsFailure("PLUGIN_E_SETTINGS_SAVE", "io");
      const snapshot: SettingsSnapshot = { schemaVersion: version, revision: result.receipt.revision, values };
      try { deps.watch.changed(owner, { revision: result.receipt.revision, schemaVersion: version,
        changedKeys: checked.map((x) => x.key), cause }); }
      catch { try { deps.watch.invalidate(owner); } catch { /* The committed receipt remains authoritative. */ } }
      return { ok: true, value: { snapshot, receipt: result.receipt } };
    } catch (error) {
      if (unresolved.has(owner.sourceKey)) return uncertain();
      await deps.engine.abort(ticket);
      if (isFailure(error)) return error;
      return settingsFailure("PLUGIN_E_SETTINGS_SAVE", "io");
    }
  }
  const handlers: Handlers = {
    "settings/read": async (owner, p) => ({ ok: true, value: (await read(owner, p.schemaVersion)).snapshot }),
    "settings/watch": async (owner, p) => {
      const state = await read(owner, p.schemaVersion);
      const subscriptionId = deps.watch.register(owner);
      return { ok: true, value: { subscriptionId, sequence: 0, snapshot: state.snapshot } };
    },
    "settings/readMigration": async (owner) => {
      const state = await read(owner, undefined, true);
      return state.stored ? { ok: true, value: { stored: state.stored,
        declaredSchemaVersion: state.resource.schemaVersion } }
        : settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "invalid-value");
    },
    "settings/update": (owner, p, s) => mutate(owner, p.schemaVersion, p.expectedRevision, p.changes, "update", s),
    "settings/reset": (owner, p, s) => mutate(owner, p.schemaVersion, p.expectedRevision, p.keys, "reset", s),
    "settings/migrate": (owner, p, s) => mutate(owner, p.schemaVersion, p.expectedRevision, p.values, "migrate", s, p.fromSchemaVersion),
  };
  return {
    request<M extends keyof SettingsRequestMap>(principal: Principal, method: M,
      params: SettingsRequestMap[M]["params"], signal: AbortSignal): Promise<SettingsRequestMap[M]["result"]> {
      const write = method === "settings/update" || method === "settings/reset" || method === "settings/migrate";
      if (principal.kind !== "plugin") return Promise.resolve({ ok: false, error: {
        code: "PLUGIN_E_PERMISSION_DENIED", message: "Source binding required.",
        detail: { kind: "permission", reason: "permission" } } });
      if (!deps.allowed(principal, write ? "settings.write" : "settings.read"))
        return Promise.resolve({ ok: false, error: { code: "PLUGIN_E_DISABLED", message: "Settings unavailable." } });
      const { owner } = principal;
      const tail = tails.get(owner.sourceKey) ?? Promise.resolve();
      const next = tail.catch(() => {}).then(async () => {
        try {
          if (!deps.allowed(principal, write ? "settings.write" : "settings.read"))
            return { ok: false as const, error: { code: "PLUGIN_E_DISABLED" as const, message: "Settings unavailable." } };
          if (signal.aborted) return { ok: false as const, error: { code: "PLUGIN_E_CANCELLED" as const, message: "Cancelled." } };
          return await handlers[method](owner, params, signal);
        }
        catch (error) { return isFailure(error) ? error : settingsFailure("PLUGIN_E_SETTINGS_SAVE", "io"); }
      });
      tails.set(owner.sourceKey, next);
      void next.finally(() => { if (tails.get(owner.sourceKey) === next) tails.delete(owner.sourceKey); });
      return next;
    },
    invalidate(owner: ResourceOwner) { deps.watch.invalidate(owner); },
  };
}
function isFailure(value: unknown): value is Failure {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === false;
}
```

The engine owns final CAS, worker I/O/hash and immutable tickets. The hash above is only over the bounded settings body (≤64 KiB); records never buffer/hash 8 MiB in main. Catalog `allowed` runs before `readResource`; D170 must provide the host registry and packaged JSON reader, never a plugin-authored path. Public permission errors are enforced again by the host router in T5; this service's unavailable gate protects disabled/safe-mode resources.

- [ ] **Step 4: Run GREEN and commit the service slice**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/persistence/settings-service.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git add apps/desktop/src/main/plugins/persistence/settings-service.ts apps/desktop/src/main/plugins/persistence/settings-service.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git commit -m "feat(plugins): serialize settings CAS and publish committed invalidations"
```

Expected: all service tests pass with constructor doubles. Commit is a future **controller runs outside sandbox** step; this plan-writing session does not commit.

- [ ] **Step 4a: Freeze the bound form boundary and use the admitted core namespace**

Add these declarations to the owned `packages/plugin-runtime/src/settings-form-port.ts`; import their referenced types from the canonical protocol/runtime modules. Re-export `ContributedSettingsForm` and `SettingsFieldMap` type-only from contributed-settings-form.tsx. No renderer principal is accepted.

```ts

export interface BoundSettingsService {
  open(input:{sourceKey:string; scope:CoreWindowScope; resourceDigest:Sha256}): Promise<{
    binding:SettingsFormBinding; resource:SettingsResourceV1; snapshot:SettingsSnapshot;
  }>;
  read(binding:SettingsFormBinding): Promise<SettingsRequestMap["settings/read"]["result"]>;
  update(binding:SettingsFormBinding, params:SettingsRequestMap["settings/update"]["params"]): Promise<SettingsRequestMap["settings/update"]["result"]>;
  reset(binding:SettingsFormBinding, params:SettingsRequestMap["settings/reset"]["params"]): Promise<SettingsRequestMap["settings/reset"]["result"]>;
  watch(binding:SettingsFormBinding, changed:()=>void): () => void;
  dispose(binding:SettingsFormBinding): void;
}
export interface ContributedSettingsForm extends SettingsFormPort {
  retry(binding:SettingsFormBinding, key:SettingKey): Promise<void>;
  reload(binding:SettingsFormBinding): Promise<void>;
}
export interface SettingsFieldMap {
  field(key:SettingKey): LocalId;
  key(field:LocalId): SettingKey;
  option(key:SettingKey, value:SettingsScalar): LocalId;
  value(key:SettingKey, option:LocalId): SettingsScalar;
}
```

`createBoundSettingsService` has this exact exported signature in settings-service.ts:

```ts
export function createBoundSettingsService(input: {
  backend: PersistenceBackend; sources: PersistenceSourcePort;
  events: CommonEventLedgerPort; now: () => number;
}): BoundSettingsService {
  const service = settingsComposition(input);
  let active: { binding: SettingsFormBinding; owner: ResourceOwner; resource: SettingsResourceV1;
    callbacks: Set<() => void>; subscription?: Handle } | undefined;
  const identity = (binding: SettingsFormBinding) => JSON.stringify([
    binding.owner.sourceKey, binding.owner.pluginId, binding.owner.uiResourceGeneration,
    binding.scope.hostEpoch, binding.scope.workbenchInstance, binding.resourceDigest,
  ]);
  async function resolve(binding: SettingsFormBinding) {
    if (!active || identity(binding) !== identity(active.binding)) throw new Error("Stale settings binding.");
    const form = active;
    const resolved = await input.sources.settings({ sourceKey: binding.owner.sourceKey, resourceDigest: binding.resourceDigest });
    const owner = input.sources.coreOwner({ sourceKey: binding.owner.sourceKey, scope: binding.scope });
    if (active !== form || !resolved || !owner || ownerKey(owner) !== ownerKey(form.owner) ||
      resolved.owner.uiResourceGeneration !== binding.owner.uiResourceGeneration ||
      resolved.owner.pluginId !== binding.owner.pluginId) throw new Error("Stale settings binding.");
    service.admit(owner, binding.resourceDigest, resolved);
    return form;
  }
  function dispose(binding: SettingsFormBinding) {
    if (!active || identity(binding) !== identity(active.binding)) return;
    if (active.subscription) input.events.unsubscribe(active.owner, active.subscription);
    active.callbacks.clear(); active = undefined;
  }
  const bound: BoundSettingsService = {
    async open({ sourceKey, scope, resourceDigest }) {
      const resolved = await input.sources.settings({ sourceKey, resourceDigest });
      const owner = input.sources.coreOwner({ sourceKey, scope });
      if (!resolved || !owner) throw new Error("Settings source is not admitted.");
      if (active) dispose(active.binding);
      const binding = { owner: resolved.owner, scope, resourceDigest };
      active = { binding, owner, resource: resolved.resource, callbacks: new Set() };
      service.admit(owner, resourceDigest, resolved);
      const result = await bound.read(binding);
      if (!result.ok) { dispose(binding); throw result.error; }
      return { binding, resource: resolved.resource, snapshot: result.value };
    },
    async read(binding) {
      const form = await resolve(binding);
      return service.requestOwner(form.owner, "settings/read", { schemaVersion: form.resource.schemaVersion },
        new AbortController().signal, async () => { await resolve(binding); });
    },
    async update(binding, params) {
      const form = await resolve(binding);
      return service.requestOwner(form.owner, "settings/update", params,
        new AbortController().signal, async () => { await resolve(binding); });
    },
    async reset(binding, params) {
      const form = await resolve(binding);
      return service.requestOwner(form.owner, "settings/reset", params,
        new AbortController().signal, async () => { await resolve(binding); });
    },
    watch(binding, changed) {
      if (!active || identity(active.binding) !== identity(binding)) throw new Error("Stale settings binding.");
      const form = active;
      if (!form.subscription) {
        const result = input.events.create(form.owner);
        if (!result.ok) throw result.error;
        form.subscription = result.value.subscriptionId;
        input.events.activate(form.owner, form.subscription);
      }
      form.callbacks.add(changed);
      const off = service.onCommitted(form.owner, () => {
        void resolve(binding).then(() => { if (active === form && form.callbacks.has(changed)) changed(); })
          .catch(() => dispose(binding));
      });
      return () => {
        off(); form.callbacks.delete(changed);
        if (!form.callbacks.size && form.subscription) {
          input.events.unsubscribe(form.owner, form.subscription); delete form.subscription;
        }
      };
    },
    dispose,
  };
  service.bind(bound);
  return bound;
}
```

Implement `settingsComposition` in that same file as a private, backend-keyed service cache. Its local `admit(owner,digest,resolved)` stores only a host-resolved catalog resource, `requestOwner` is the shared queue entry below, `onCommitted` subscribes to that instance’s commit notifications, and `bind(bound)` records its form-disposal facet. These helpers are private, never constructor dependencies. Catalog admission must populate the same resource mapping for public settings channels before routing, using the admitted static resource digest from the source registration; source settings lookups still validate it afresh. It owns one `createSettingsService` instance, one current form, subscriptions and the source/digest bindings; it does not locate a backend or install a factory. Export a module-local `settingsRequests(backend)` accessor for T5 to use the very same instance’s public request facet; reject access before construction. On host disposal delete the cache entry and close its subscriptions. Never store factories in the cache.

Refactor the existing `request` body into a private `requestOwner(owner, method, params, signal, current)` function: preserve its source-key serialization, cancellation, schema checks and errors, but await `current()` both at admission and when its queued operation runs. This callback validates the binding without manufacturing a principal; resource reads and publish continuations recheck the admitted catalog lifetime. Public `request` admits only actual plugin principals and supplies a callback that rejects when `sources.current(principal.owner)` is false; core calls it directly with the `ResourceOwner` returned by `sources.coreOwner({sourceKey,scope})`. Do not construct `{kind:"plugin"}` for a core form. Resource loading uses the admitted `sources.settings({sourceKey,resourceDigest})`, including its committed validation digest comparison through `backend.evidence.settingsDigest`; resolve before every operation, not just on open.

Implement the bound methods with this exact sequence:

1. `open` resolves `sources.settings` and `sources.coreOwner` using main’s scope, rejects absent/stale catalog or digest before a disk read, disposes the previous form, and issues `{owner:resolved.owner, scope, resourceDigest}`. Read defaults/current snapshot through `requestOwner` and return `{binding,resource,snapshot}`. No optional process activation occurs.
2. Keep the issued binding and core owner privately. Before `read/update/reset/watch`, compare every binding field, re-resolve source/digest and core owner, and reject changed scope/epoch/catalog generation. Use the same CAS handlers with the current resource schema version; return the original typed business result.
3. `watch` creates at most one common ledger subscription for that form, shares/coalesces invalidations after committed writes, activates the trusted local subscription, and returns an idempotent unsubscribe. Public watches use that same ledger with transport after-reply activation; no second subscription counter. Notify the local callback only while its binding remains current; do not route a snapshot through command arguments.
4. `dispose(binding)` closes only the matching issued form and its watch; stale disposal cannot close its replacement. Clear the retained catalog binding. Public settings requests continue using the same underlying CAS queue.

Add tests in settings-service.test.ts for no-process `open/read/update`, forged scope, stale digest after open, generation changes while a write is queued, disposal of an old form, and committed digest differing from loaded-resource digest. Assert source admission precedes `backend.reads.settings`, and that public and core writes share one CAS order. The renderer test retains its dirty draft until explicit retry/reload and checks the old binding cannot submit even though the resource-only map is reusable.

- [ ] **Step 5: Write draft, mapping and stale-binding tests before the renderer code**

Create `apps/desktop/src/renderer/settings/contributed-settings-store.test.ts`:

```ts
import { expect, it, vi } from "vitest";
import type { SettingsMutation, SettingsSnapshot } from "@kobrixa/plugin-protocol";
import { createContributedSettingsStore, type SettingsStoreTransport } from "./contributed-settings-store.js";
const initial: SettingsSnapshot = { schemaVersion: 1, revision: null,
  values: [{ key: "enabled", value: true }, { key: "name", value: "old" }] };
const receipt = (n: number, values = initial.values): SettingsMutation => ({
  snapshot: { ...initial, values, revision: `r_${n.toString().padStart(32, "0")}` },
  receipt: { revision: `r_${n.toString().padStart(32, "0")}`,
    commitId: "00000000-0000-4000-8000-000000000001", durability: "file-sync-only" },
});
it("B2-12.1-1: text waits for blur, unchanged drafts do nothing, queued fields use the last receipt", async () => {
  const sends: Array<{ key: string; expectedRevision: string | null }> = [];
  const store = createContributedSettingsStore(initial, {
    validate: () => true, read: async () => initial,
    mutate: async (input) => {
      sends.push(input);
      return { ok: true, value: receipt(sends.length,
        store.state().baseline.values.map((x) => x.key === input.key ? { ...x, value: input.value } : x)) };
    },
  });
  store.edit("name", "new", "change", false);
  expect(sends).toHaveLength(0);
  store.edit("name", "new", "blur", false);
  store.edit("enabled", false, "change", true);
  await store.idle();
  expect(sends).toEqual([
    { key: "name", value: "new", reset: false, expectedRevision: null, schemaVersion: 1 },
    { key: "enabled", value: false, reset: false, expectedRevision: receipt(1).receipt.revision, schemaVersion: 1 },
  ]);
  store.edit("enabled", false, "change", true);
  await store.idle();
  expect(sends).toHaveLength(2);
});
it("B2-RF2: an external revision keeps dirty drafts and requires explicit retry", async () => {
  const mutate = vi.fn<SettingsStoreTransport["mutate"]>(async () => ({ ok: true, value: receipt(3) }));
  const store = createContributedSettingsStore(initial, { validate: () => true, mutate, read: async () => receipt(2).snapshot });
  store.edit("name", "draft", "change", false);
  store.external(receipt(2).snapshot);
  expect(store.state().draft.find((x) => x.key === "name")!.value).toBe("draft");
  expect(store.state().errors).toHaveLength(1);
  store.edit("enabled", false, "change", true);
  await store.idle();
  expect(mutate).not.toHaveBeenCalled();
  await store.retry("name");
  expect(mutate).toHaveBeenCalledOnce();
  expect(mutate.mock.calls[0]![0]).toMatchObject({ expectedRevision: receipt(2).receipt.revision });
});
it("B2-10 unknown: pauses the queue, reads evidence, and never auto-resends", async () => {
  const read = vi.fn(async () => receipt(2).snapshot);
  const mutate = vi.fn(async () => ({ ok: false as const, error: { code: "PLUGIN_E_SETTINGS_SAVE" as const,
    message: "Unknown", detail: { kind: "persistence" as const, reason: "publish-uncertain" as const,
      disposition: "unknown" as const } } }));
  const store = createContributedSettingsStore(initial, { validate: () => true, mutate, read });
  store.edit("enabled", false, "change", true);
  store.edit("name", "next", "enter", false);
  await store.idle();
  expect(mutate).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledOnce();
  expect(store.state().draft.find((x) => x.key === "name")!.value).toBe("next");
  store.dispose();
  store.external(receipt(4).snapshot);
  expect(store.state().baseline.revision).toBe(receipt(2).receipt.revision);
});
it("B2-12.1-1: coalesces unsent drafts without changing the dispatched payload", async () => {
  let finish!: (result: { ok: true; value: SettingsMutation }) => void;
  const mutate = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockImplementation(async () => ({ ok: true, value: receipt(2) }));
  const store = createContributedSettingsStore(initial, { validate: () => true, mutate, read: async () => initial });
  store.edit("name", "one", "enter", false);
  store.edit("name", "two", "enter", false);
  store.edit("name", "three", "enter", false);
  expect(mutate.mock.calls[0]![0].value).toBe("one");
  finish({ ok: true, value: receipt(1) });
  await store.idle();
  expect(mutate).toHaveBeenCalledTimes(2);
  expect(mutate.mock.calls[1]![0].value).toBe("three");
});
it("B2-RF2: an own commit watch before the receipt does not pause queued fields", async () => {
  let resolve!: (value: { ok: true; value: SettingsMutation }) => void;
  const mutate = vi.fn<SettingsStoreTransport["mutate"]>()
    .mockImplementationOnce(() => new Promise((done) => { resolve = done; }))
    .mockResolvedValueOnce({ ok: true, value: receipt(2) });
  const store = createContributedSettingsStore(initial, { validate: () => true, mutate, read: async () => initial });
  store.edit("enabled", false, "change", true);
  store.edit("name", "next", "enter", false);
  const own = receipt(1, [{ key: "enabled", value: false }, { key: "name", value: "old" }]);
  store.external(own.snapshot);
  resolve({ ok: true, value: own }); await store.idle();
  expect(mutate).toHaveBeenCalledTimes(2);
  expect(mutate.mock.calls[1]![0].expectedRevision).toBe(own.receipt.revision);
  expect(store.state().errors).toEqual([]);
});

```

Create `apps/desktop/src/renderer/settings/contributed-settings-form.test.ts`:

```ts
import { expect, it, vi } from "vitest";
import type { SettingsResourceV1 } from "@kobrixa/plugin-protocol";
import type { SettingsFormBinding, BoundSettingsService } from "@kobrixa/plugin-runtime";
import { createSettingsFieldMap, createContributedSettingsForm } from "./contributed-settings-form.js";
const binding: SettingsFormBinding = { owner: { sourceKey: "builtin:test.settings", pluginId: "test.settings", uiResourceGeneration: 1 },
  scope: { hostEpoch: "00000000-0000-4000-8000-000000000001", workbenchInstance: "00000000-0000-4000-8000-000000000002" },
  resourceDigest: "a".repeat(64) };
const resource: SettingsResourceV1 = { schemaVersion: 1, title: { en: "Settings" }, fields: [
  { key: "connection.mode", type: "enum", label: { en: "Mode" }, default: 1,
    options: [{ value: 1, label: { en: "Number" } }, { value: "1", label: { en: "String" } }] },
] };
it("B2-RF2: dotted keys and mixed enum types round-trip; stale maps cannot submit", () => {
  const map = createSettingsFieldMap(resource);
  expect(map.field("connection.mode")).toBe("field-0");
  expect(map.key("field-0")).toBe("connection.mode");
  expect(map.option("connection.mode", 1)).toBe("option-0");
  expect(map.option("connection.mode", "1")).toBe("option-1");
  expect(map.value("connection.mode", "option-1")).toBe("1");
  expect(() => map.key("connection.mode")).toThrow();
  expect(() => map.value("connection.mode", "option-32")).toThrow();
  expect(() => map.field("unknown")).toThrow();
});
it("B2-12.1-1: 128 fields make eight 16-field pages, with one mounted host form", () => {
  const large: SettingsResourceV1 = { ...resource, fields: Array.from({ length: 128 }, (_, n) => ({
    key: `field${n}`, type: "boolean", default: false, label: { en: `Field ${n}` },
  })) };
  const map = createSettingsFieldMap(large);
  expect(map.field("field127")).toBe("field-127");
  expect(() => createSettingsFieldMap({ ...large, fields: [...large.fields, large.fields[0]!] })).toThrow();
  const render = vi.fn(), dispose = vi.fn();
  const service: BoundSettingsService = {
    open: async () => ({ binding, resource, snapshot }),
    read: async () => ({ ok: true, value: snapshot }),
    update: async () => ({ ok: false, error: { code: "PLUGIN_E_SETTINGS_CONFLICT", message: "Changed." } }),
    reset: async () => ({ ok: false, error: { code: "PLUGIN_E_SETTINGS_CONFLICT", message: "Changed." } }),
    watch: () => () => {}, dispose: vi.fn(),
  };
  const form = createContributedSettingsForm({ render, dispose, onChange: () => () => {} }, service);
  const snapshot = { schemaVersion: 1, revision: null, values: [{ key: "connection.mode", value: 1 }] };
  form.open(binding, resource, snapshot);
  form.open({ ...binding, resourceDigest: "b".repeat(64) }, resource, snapshot);
  expect(dispose).toHaveBeenCalledWith(binding);
  form.replaceSnapshot(binding, { ...snapshot, revision: `r_${"1".repeat(32)}` });
  expect(render).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(render.mock.calls)).not.toContain("Apply");
});
```

- [ ] **Step 6: Establish RED for both renderer modules**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/settings/contributed-settings-store.test.ts src/renderer/settings/contributed-settings-form.test.ts
```

Expected: missing renderer module exports. These tests use B1 control doubles; actual keyboard/focus/paint, 320 px, 125%, themes and locales are **controller runs outside sandbox** acceptance in T7/T9, not claimed by a mock render call.

- [ ] **Step 7: Implement the bounded draft queue and exact form port**

Retain the AM-28 declarations added in Step 4a and complete the T0 declarations in `packages/plugin-runtime/src/settings-form-port.ts` as follows:

```ts
import type { UiOwner, Sha256, SettingsResourceV1, SettingsSnapshot, PluginErrorCode,
  PersistenceFailureDetail } from "@kobrixa/plugin-protocol";
import type { CoreWindowScope } from "./core-actions.js";
export type SettingsFormBinding = { owner: UiOwner; scope: CoreWindowScope; resourceDigest: Sha256 };
export interface SettingsFormPort {
  open(binding: SettingsFormBinding, resource: SettingsResourceV1, snapshot: SettingsSnapshot): void;
  replaceSnapshot(binding: SettingsFormBinding, snapshot: SettingsSnapshot): void;
  showFailure(binding: SettingsFormBinding,
    error: { code: PluginErrorCode; message: string; detail?: PersistenceFailureDetail }): void;
  dispose(binding: SettingsFormBinding): void;
}
```

Create `apps/desktop/src/renderer/settings/contributed-settings-store.ts`:

```ts
import type { BusinessResult, PersistenceFailureDetail, SettingsMutation, SettingsSnapshot,
  SettingsScalar, SettingKey } from "@kobrixa/plugin-protocol";
import type { SettingsDraftState } from "../plugin-ui/host-ports.js";
export type SettingsStoreTransport = {
  validate(key: SettingKey, value: SettingsScalar): boolean;
  read(): Promise<SettingsSnapshot>;
  mutate(input: { key: SettingKey; value: SettingsScalar; reset: boolean;
    schemaVersion: number; expectedRevision: string | null }):
    Promise<BusinessResult<SettingsMutation, PersistenceFailureDetail>>;
};
export function createContributedSettingsStore(initial: SettingsSnapshot, io: SettingsStoreTransport) {
  let baseline = structuredClone(initial);
  const draft = new Map(initial.values.map((x) => [x.key, x.value]));
  const dirty = new Set<string>();
  const queued = new Map<string, { value: SettingsScalar; reset: boolean }>();
  const errors = new Map<string, string>();
  const listeners = new Set<() => void>();
  let busy: string | null = null, paused = false, disposed = false;
  let deferredWatch: SettingsSnapshot | undefined;
  let running: Promise<void> = Promise.resolve();
  const notify = () => { if (!disposed) for (const listener of listeners) listener(); };
  const error = (key: string, message: string) => { errors.set(key, message); notify(); };
  function snapshot(): SettingsDraftState {
    return { baseline: structuredClone(baseline), draft: [...draft].map(([key, value]) => ({ key, value })),
      busyKeys: busy ? [busy] : [], errors: [...errors].map(([key, en]) => ({ key, message: { en } })) };
  }
  function external(next: SettingsSnapshot) {
    if (disposed || next.schemaVersion !== baseline.schemaVersion) return;
    if (busy !== null) { deferredWatch = structuredClone(next); return; }
    if (next.revision === baseline.revision) return;
    baseline = structuredClone(next);
    for (const { key, value } of next.values) {
      if (!dirty.has(key)) draft.set(key, value);
      else errors.set(key, "Saved values changed. Reload or explicitly retry this field.");
    }
    if (dirty.size) { paused = true; queued.clear(); }
    notify();
  }
  async function pump() {
    while (!disposed && !paused && queued.size) {
      const [key, item] = queued.entries().next().value!;
      queued.delete(key); busy = key; notify();
      const revisionAtDispatch = baseline.revision;
      try {
        const result = await io.mutate({ key, ...item, schemaVersion: baseline.schemaVersion,
          expectedRevision: revisionAtDispatch });
        if (disposed) return;
        if (!result.ok) {
          paused = true; error(key, result.error.message);
          if (result.error.detail?.kind === "persistence" && result.error.detail.disposition === "unknown")
            deferredWatch = await io.read();
          continue;
        }
        if (baseline.revision !== revisionAtDispatch && baseline.revision !== result.value.receipt.revision) {
          paused = true; error(key, "Saved values changed. Explicit retry required."); continue;
        }
        baseline = structuredClone(result.value.snapshot);
        if (draft.get(key) === item.value && !queued.has(key)) { dirty.delete(key); errors.delete(key); }
        for (const entry of baseline.values) if (!dirty.has(entry.key)) draft.set(entry.key, entry.value);
      } catch {
        paused = true; error(key, "Save outcome is unavailable. Read current values before retry.");
        try { deferredWatch = await io.read(); } catch { error(key, "Current saved values are unavailable."); }
      } finally {
        busy = null;
        const observed = deferredWatch; deferredWatch = undefined;
        if (observed) external(observed);
        notify();
      }
    }
  }
  function edit(key: string, value: SettingsScalar, phase: "change" | "blur" | "enter" | "reset", immediate: boolean) {
    if (disposed || !draft.has(key)) return;
    draft.set(key, value); dirty.add(key);
    if (!io.validate(key, value) || new TextEncoder().encode(JSON.stringify([...draft].map(([k, v]) => ({ key: k, value: v })))).length > 65536) {
      queued.delete(key); error(key, "Invalid value."); return;
    }
    errors.delete(key);
    const old = baseline.values.find((x) => x.key === key)?.value;
    if (old === value && !busy && !queued.has(key) && phase !== "reset") { dirty.delete(key); notify(); return; }
    if (phase !== "change" || immediate) queued.set(key, { value, reset: phase === "reset" });
    notify();
    if (busy === null) running = pump();
  }
  return {
    state: snapshot, edit, external,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    idle: () => running,
    fail(message: string) { paused = true; for (const key of dirty) errors.set(key, message); notify(); },
    async retry(key: string) {
      if (disposed || !dirty.has(key)) return;
      try { external(await io.read()); } catch { error(key, "Current saved values are unavailable."); return; }
      const value = draft.get(key)!;
      if (!io.validate(key, value)) return;
      queued.clear(); queued.set(key, { value, reset: false }); paused = false;
      running = pump(); await running;
    },
    async reload() {
      const value = await io.read();
      if (disposed) return;
      dirty.clear(); queued.clear(); errors.clear(); paused = false;
      baseline = structuredClone(value); draft.clear();
      for (const entry of value.values) draft.set(entry.key, entry.value);
      notify();
    },
    dispose() { disposed = true; queued.clear(); listeners.clear(); },
  };
}
```

Create `apps/desktop/src/renderer/settings/contributed-settings-form.tsx`:

```tsx
import type { SettingsResourceV1, SettingsScalar, SettingKey, LocalId } from "@kobrixa/plugin-protocol";
import type { SettingsFormBinding, SettingsFormPort, BoundSettingsService, SettingsFieldMap, ContributedSettingsForm } from "@kobrixa/plugin-runtime";
import type { SettingsControlsPort } from "../plugin-ui/host-ports.js";
import { createContributedSettingsStore, type SettingsStoreTransport } from "./contributed-settings-store.js";
const identity = (binding: SettingsFormBinding) => JSON.stringify([
  binding.owner.sourceKey, binding.owner.pluginId, binding.owner.uiResourceGeneration,
  binding.scope.hostEpoch, binding.scope.workbenchInstance, binding.resourceDigest,
]);
export function createSettingsFieldMap(resource: SettingsResourceV1): SettingsFieldMap {
  if (!resource.fields.length || resource.fields.length > 128 ||
    new Set(resource.fields.map(f => f.key)).size !== resource.fields.length) throw new Error("Invalid fields.");
  const fields = structuredClone(resource.fields);
  for (const f of fields) if (f.type === "enum" && (f.options.length < 1 || f.options.length > 32 ||
    new Set(f.options.map(o => JSON.stringify([typeof o.value, o.value]))).size !== f.options.length))
    throw new Error("Invalid options.");
  const index = (key: SettingKey) => {
    const n = fields.findIndex(f => f.key === key);
    if (n < 0) throw new Error("Unknown field.");
    return n;
  };
  const ordinal = (id: LocalId, prefix: string, maximum: number) => {
    if (!new RegExp(`^${prefix}-(0|[1-9][0-9]*)$`).test(id)) throw new Error("Invalid ID.");
    const n = Number(id.slice(prefix.length + 1));
    if (n >= maximum) throw new Error("Unknown ID.");
    return n;
  };
  const options = (key: SettingKey) => {
    const f = fields[index(key)]!;
    if (f.type !== "enum") throw new Error("Not an enum.");
    return f.options;
  };
  return {
    field: key => `field-${index(key)}`,
    key: field => fields[ordinal(field, "field", fields.length)]!.key,
    option(key, value) {
      const n = options(key).findIndex(o => o.value === value);
      if (n < 0) throw new Error("Unknown option.");
      return `option-${n}`;
    },
    value: (key, option) => { const all = options(key); return all[ordinal(option, "option", all.length)]!.value; },
  };
}
export type { ContributedSettingsForm, SettingsFieldMap } from "@kobrixa/plugin-runtime";
export function createContributedSettingsForm(controls: SettingsControlsPort,
  service: BoundSettingsService): ContributedSettingsForm {
  let current: { binding: SettingsFormBinding; resource: SettingsResourceV1;
    store: ReturnType<typeof createContributedSettingsStore>; off: () => void; change: () => void } | undefined;
  function matches(binding: SettingsFormBinding) { return current && identity(current.binding) === identity(binding); }
  function close() {
    if (!current) return;
    current.off(); current.change(); current.store.dispose(); service.dispose(current.binding); controls.dispose(current.binding); current = undefined;
  }
  return {
    open(binding, resource, snapshot) {
      close(); createSettingsFieldMap(resource);
      const store = createContributedSettingsStore(snapshot, {
        validate: (key, value) => resource.fields.some(f => f.key === key &&
          (f.type !== "enum" || f.options.some(o => o.value === value))),
        async read() { const result = await service.read(binding); if (!result.ok) throw result.error; return result.value; },
        mutate: input => input.reset
          ? service.reset(binding, { schemaVersion: input.schemaVersion, expectedRevision: input.expectedRevision, keys: [input.key] })
          : service.update(binding, { schemaVersion: input.schemaVersion, expectedRevision: input.expectedRevision,
              changes: [{ key: input.key, value: input.value }] }),
      });
      const draw = () => controls.render(binding, resource, store.state());
      const offDraw = store.subscribe(draw);
      const offWatch = service.watch(binding, () => {
        void service.read(binding).then(result => { if (matches(binding) && result.ok) store.external(result.value); });
      });
      const off = () => { offDraw(); offWatch(); };
      const change = controls.onChange((incoming, key, value, phase) => {
        if (!matches(incoming)) return;
        const field = resource.fields.find((x) => x.key === key);
        if (!field) return;
        store.edit(key, phase === "reset" ? field.default : value, phase,
          field.type === "boolean" || field.type === "enum");
      });
      current = { binding: structuredClone(binding), resource, store, off, change }; draw();
    },
    replaceSnapshot(binding, snapshot) { if (matches(binding)) current!.store.external(snapshot); },
    showFailure(binding, error) { if (matches(binding)) current!.store.fail(error.message); },
    dispose(binding) { if (matches(binding)) close(); },
    async retry(binding, key) { if (matches(binding)) await current!.store.retry(key); },
    async reload(binding) { if (matches(binding)) await current!.store.reload(); },
  };
}
```

V170 uses B1-T7’s frozen attachment exactly:

```ts
const form = createContributedSettingsForm(controls, window.kobrixa.plugins.settings);
const detach = attachSettingsControls(controls, {
  retry: form.retry, reload: form.reload, fieldMap: createSettingsFieldMap,
});
```

On unmount call `detach()` and dispose the active form. B1 controls owns actual generic inputs; its callback already restores SettingKey/SettingsScalar. The map helper is the shared adapter algorithm available for the B1 implementation, never a new wire field. The returned local `retry(binding,key)`/`reload(binding)` methods are the concrete trusted detail-action handlers; V170 retains that local adapter for buttons while attaching only its unchanged SettingsFormPort facet to the catalog. They are not new wire methods. A host `SettingsControlsPort` must enforce 16 fields/page, depth≤8 and ≤128 nodes including reset/errors. Do not pass whole settings snapshots through command/invoke's 16 KiB arguments.

- [ ] **Step 8: Verify renderer GREEN, package compilation, and hand off the exact files**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/persistence/settings-service.test.ts src/renderer/settings/contributed-settings-store.test.ts src/renderer/settings/contributed-settings-form.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git diff --check
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git add packages/plugin-runtime/src/settings-form-port.ts apps/desktop/src/renderer/settings/contributed-settings-store.ts apps/desktop/src/renderer/settings/contributed-settings-store.test.ts apps/desktop/src/renderer/settings/contributed-settings-form.tsx apps/desktop/src/renderer/settings/contributed-settings-form.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git commit -m "feat(settings): preserve field drafts across CAS and catalog changes"
```

Expected: all focused tests pass. The commit is **controller runs outside sandbox**. Required real T1 semantic fixtures include 128/129 fields, 64 KiB/+1 resource and values, 4 KiB/+1 strings, forbidden dotted segments, same-version validation digest changes and corrupt evidence; the constructor-double tests above are not a substitute. T9 must connect actual controls and trusted catalog sender before accepting the form.

### Task 3B2-T4: Record handlers, chunks, pins, paging and flush

**Files**

- Create: `apps/desktop/src/main/plugins/persistence/record-service.ts`
- Create/Test: `apps/desktop/src/main/plugins/persistence/record-service.test.ts`
- Modify (T0 scaffold; baseline N): `apps/desktop/src/main/plugins/persistence/record-port.ts`
- Create/Test: `apps/desktop/src/main/plugins/persistence/record-port.test.ts`

**Interfaces**

Consumes canonical `RecordMeta`, `RecordTarget`, `RecordWrite`, `WriteProgress`, `Receipt`, `StorageRequestMap`, `Principal`, `PersistenceOwner`, and T2 `PublicationTicket`, `PersistenceEnginePort`, `PersistenceReadPort` exactly as listed in T3. Produces this unchanged host-only signature:

```ts
interface RecordServicePort {
  request<M extends keyof StorageRequestMap>(principal: Principal, method: M,
    params: StorageRequestMap[M]["params"], signal: AbortSignal): Promise<StorageRequestMap[M]["result"]>;
}
```

Checkpoint admission is delegated to T5 through constructor callbacks defined in this task's own record-port.ts. `storage/drain` is host→plugin and must never be admitted by the public plugin→host router. Record bytes are opaque; no Lab schema, arbitrary metadata, query language or transaction is introduced.

Start after F, independently of T2 implementation with the explicit doubles below. Acceptance needs T1 wire validation, actual T2 reserve/publication/pins and T5 checkpoint authority. Review focus **B2-RF1** belongs here at the handler boundary: cancellation after publish dispatch retains the original ticket, namespace fence and receipt; it never calls publish again.

- [ ] **Step 1: Write the record-port contract and boundary tests**

Create `apps/desktop/src/main/plugins/persistence/record-port.test.ts`:

```ts
import { expect, expectTypeOf, it } from "vitest";
import type { Principal } from "@kobrixa/plugin-runtime";
import type { StorageRequestMap } from "@kobrixa/plugin-protocol";
import { ownerKey, decodeChunk, PersistenceFault, type RecordServicePort } from "./record-port.js";
it("pins the frozen request signature without widening the wire map", () => {
  type Begin = RecordServicePort["request"];
  expectTypeOf<Begin>().toExtend<(<M extends keyof StorageRequestMap>(p: Principal, m: M,
    value: StorageRequestMap[M]["params"], s: AbortSignal) => Promise<StorageRequestMap[M]["result"]>)>();
});
it("B2-12.1-3: rejects noncanonical, oversized and invalid-tail base64 before append", () => {
  for (const value of ["", "YQ", "YQ===", "YQ==\n", "YR==", "_w==", "-w==", "YQ=", "é"])
    expect(() => decodeChunk(value)).toThrow();
  expect(decodeChunk(Buffer.alloc(262144, 1).toString("base64"))).toHaveLength(262144);
  expect(() => decodeChunk(Buffer.alloc(262145, 1).toString("base64"))).toThrow();
});
it("binds handles to all five owner fields and never echoes an I/O path", () => {
  const owner = { sourceKey: "builtin:test.records", pluginId: "test.records", generation: 1,
    hostEpoch: "a", processEpoch: "b" };
  for (const changed of [{ ...owner, processEpoch: "c" }, { ...owner, hostEpoch: "c" },
    { ...owner, generation: 2 }, { ...owner, sourceKey: "builtin:test.other" }])
    expect(ownerKey(changed)).not.toBe(ownerKey(owner));
  expect(JSON.stringify(new PersistenceFault("PLUGIN_E_STORAGE_IO", "io").result)).not.toContain("path");
});
```

Create `apps/desktop/src/main/plugins/persistence/record-service.test.ts`:

```ts
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { RecordMeta, RecordWrite, ResourceOwner } from "@kobrixa/plugin-protocol";
import { createRecordService } from "./record-service.js";
import { PersistenceFault, type RecordDependencies } from "./record-port.js";
const owner: ResourceOwner = { sourceKey: "builtin:test.records", pluginId: "test.records", generation: 1,
  hostEpoch: "00000000-0000-4000-8000-000000000001", processEpoch: "00000000-0000-4000-8000-000000000002" };
const p = { kind: "plugin" as const, owner, authorityContext: null };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const input = (bytes: Uint8Array): RecordWrite => ({ target: { mode: "create" }, kind: "test.data",
  schemaVersion: 1, label: "Data", mediaType: "application/octet-stream", byteLength: bytes.length, sha256: hash(bytes) });
const signal = () => new AbortController().signal;
function fixture() {
  let now = 0;
  const records = new Map<string, RecordMeta>();
  const payloads = new Map<string, Uint8Array>();
  const staging = new Map<string, Uint8Array>();
  const pins = new Map<string, Uint8Array>();
  const reserve = vi.fn<RecordDependencies["engine"]["reserve"]>(async (ticket, length) => {
    staging.set(ticket.id, new Uint8Array(length));
  });
  const append = vi.fn<RecordDependencies["engine"]["append"]>(async (ticket, offset, bytes) => {
    staging.get(ticket.id)!.set(bytes, offset); return bytes.length;
  });
  const publish = vi.fn<RecordDependencies["engine"]["publish"]>(async (ticket) => {
    if (ticket.metadata.kind !== "record") throw new Error("record required");
    const record = ticket.metadata.record;
    const receipt = { revision: record.revision, commitId: ticket.id, durability: "file-sync-only" as const };
    if (ticket.metadata.deleted) records.delete(record.id);
    else { records.set(record.id, record); payloads.set(record.revision, staging.get(ticket.id)!); }
    return { disposition: "committed", receipt };
  });
  const deps: RecordDependencies = {
    now: () => now, wall: () => 100000 + now, live: () => true, permission: () => true,
    engine: { reserve, append, seal: async (ticket, length, digest) => {
      expect(staging.get(ticket.id)!.length).toBe(length);
      if (hash(staging.get(ticket.id)!) !== digest) throw new PersistenceFault("PLUGIN_E_STORAGE_CONFLICT", "checksum-mismatch");
    }, publish, reconcile: publish, abort: async () => "aborted", fence: () => [], fenceTarget: () => [] },
    read: {
      settings: async () => null,
      stat: async (_owner, id) => { const r = records.get(id); if (!r) throw new Error("missing"); return structuredClone(r); },
      list: async (_owner, query) => {
        const offset = query.cursor ? Number(query.cursor) : 0;
        const all = [...records.values()].filter((r) => !query.kind || r.kind === query.kind);
        return { entries: all.slice(offset, offset + query.limit),
          ...(offset + query.limit < all.length ? { nextCursor: String(offset + query.limit) } : {}) };
      },
      open: async (_owner, _id, revision) => { pins.set(revision, payloads.get(revision)!); return revision; },
      read: async (_owner, pin, offset, max) => pins.get(pin)!.slice(offset, offset + max),
      close: async (_owner, pin) => { pins.delete(pin); },
    },
    evidence: evidenceDouble({ quota: async () => ({ ok: true, value: { recordCount: records.size, reservedCreates: staging.size, committedBytes: 0,
      reservedBytes: 0, pinnedBytes: 0, temporaryBytes: 0, sourceLimitBytes: 536870912,
      sourceLimitRecords: 256, hostAvailableBytes: 1073741824, writeSlotsAvailable: 2, exportSlotsAvailable: 1 } }) }),
    checkpoint: { authorize: () => "none", committed: () => {}, open: () => false,
      register: async () => ({ ok: false, error: { code: "PLUGIN_E_DISABLED", message: "Not attached" } }),
      abandon: async () => ({ ok: false, error: { code: "PLUGIN_E_DISABLED", message: "Not attached" } }) },
  };
  const service = createRecordService(deps);
  async function begin(bytes: Uint8Array) {
    const r = await service.request(p, "storage/beginWrite", input(bytes), signal());
    if (!r.ok) throw new Error(JSON.stringify(r)); return r.value;
  }
  async function complete(bytes: Uint8Array) {
    const b = await begin(bytes);
    if (bytes.length) await service.request(p, "storage/writeChunk", { write: b.write, offset: 0,
      data: Buffer.from(bytes).toString("base64") }, signal());
    await service.request(p, "storage/sealWrite", { write: b.write }, signal());
    const c = await service.request(p, "storage/commitWrite", { write: b.write }, signal());
    if (!c.ok) throw new Error(JSON.stringify(c)); return { ...b, ...c.value };
  }
  return { service, deps, begin, complete, reserve, append, publish, records, pins, advance: (ms: number) => { now += ms; } };
}
it("B2-12.1-2/3: reserves all bytes first; duplicate last chunk does not append or renew", async () => {
  const f = fixture(), bytes = Buffer.from("hello");
  const b = await f.begin(bytes);
  expect(f.reserve.mock.calls[0]![1]).toBe(5);
  const c = { write: b.write, offset: 0, data: bytes.toString("base64") };
  const first = await f.service.request(p, "storage/writeChunk", c, signal());
  f.advance(1000);
  expect(await f.service.request(p, "storage/writeChunk", c, signal())).toEqual(first);
  expect(f.append).toHaveBeenCalledOnce();
  expect(await f.service.request(p, "storage/writeChunk", { ...c, data: Buffer.from("HELLO").toString("base64") }, signal()))
    .toMatchObject({ error: { detail: { reason: "offset-mismatch" } } });
});
it("B2-12.1-2: source 2 and host 16 staged writes; a third has no reserve side effect", async () => {
  const f = fixture();
  await f.begin(new Uint8Array()); await f.begin(new Uint8Array());
  expect(await f.service.request(p, "storage/beginWrite", input(new Uint8Array()), signal()))
    .toMatchObject({ error: { code: "PLUGIN_E_RESOURCE_LIMIT" } });
  expect(f.reserve).toHaveBeenCalledTimes(2);
  for (let n = 1; n < 8; n++) {
    const other = { ...p, owner: { ...owner, sourceKey: `builtin:test.source${n}` } };
    for (let w = 0; w < 2; w++) expect(await f.service.request(other, "storage/beginWrite", input(new Uint8Array()), signal())).toMatchObject({ ok: true });
  }
  expect(await f.service.request({ ...p, owner: { ...owner, sourceKey: "builtin:test.ninth" } },
    "storage/beginWrite", input(new Uint8Array()), signal())).toMatchObject({ ok: false });
});
it("B2-RF1: double commit returns one receipt; unknown reconciles without a second publish", async () => {
  const f = fixture();
  const c = await f.complete(new Uint8Array());
  expect(await f.service.request(p, "storage/commitWrite", { write: c.write }, signal()))
    .toEqual({ ok: true, value: { record: c.record, receipt: c.receipt } });
  expect(f.publish).toHaveBeenCalledOnce();
  const b = await f.begin(new Uint8Array());
  await f.service.request(p, "storage/sealWrite", { write: b.write }, signal());
  f.deps.engine.publish = vi.fn(async () => ({ disposition: "unknown" as const }));
  expect(await f.service.request(p, "storage/commitWrite", { write: b.write }, signal()))
    .toMatchObject({ error: { detail: { disposition: "unknown" } } });
  await f.service.request(p, "storage/writeStatus", { write: b.write }, signal());
  expect(f.deps.engine.publish).toHaveBeenCalledOnce();
  expect(f.publish).toHaveBeenCalledTimes(2);
});
it("B2-10: incomplete/open-checkpoint/unknown work cannot flush", async () => {
  const f = fixture();
  await f.begin(Buffer.from("x"));
  expect(await f.service.request(p, "storage/flush", {}, signal()))
    .toMatchObject({ error: { detail: { reason: "flush-incomplete" } } });
  const g = fixture(); g.deps.checkpoint.open = () => true;
  expect(await g.service.request(p, "storage/flush", {}, signal())).toMatchObject({ ok: false });
});
it("B2-12.1-3: read pins survive delete, exact EOF and same-owner close are idempotent", async () => {
  const f = fixture(); const c = await f.complete(Buffer.from("abc"));
  const opened = await f.service.request(p, "storage/openRead", { id: c.id,
    expectedRevision: c.record.revision, schemaVersion: 1 }, signal());
  if (!opened.ok) throw new Error("read failed");
  await f.service.request(p, "storage/delete", { id: c.id, expectedRevision: c.record.revision }, signal());
  expect(await f.service.request(p, "storage/readChunk", { read: opened.value.read, offset: 0, maxBytes: 3 }, signal()))
    .toMatchObject({ ok: true, value: { data: "YWJj", eof: true } });
  expect(await f.service.request(p, "storage/readChunk", { read: opened.value.read, offset: 3, maxBytes: 3 }, signal()))
    .toMatchObject({ ok: true, value: { data: "", eof: true } });
  await f.service.request(p, "storage/closeRead", { read: opened.value.read }, signal());
  expect(await f.service.request(p, "storage/closeRead", { read: opened.value.read }, signal())).toEqual({ ok: true, value: {} });
  expect(await f.service.request({ ...p, owner: { ...owner, generation: 2 } }, "storage/closeRead",
    { read: opened.value.read }, signal())).toMatchObject({ error: { code: "PLUGIN_E_STALE_RESOURCE" } });
});
it("B2-12.1-3: idle expiry at exactly 30 seconds prevents append and preserves expired status", async () => {
  const f = fixture(); const b = await f.begin(Buffer.from("x")); f.advance(30000);
  expect(await f.service.request(p, "storage/writeChunk", { write: b.write, offset: 0, data: "eA==" }, signal())).toMatchObject({ ok: false });
  expect(f.append).not.toHaveBeenCalled();
  expect(await f.service.request(p, "storage/writeStatus", { write: b.write }, signal()))
    .toMatchObject({ ok: true, value: { state: "expired" } });
});
it("B2-12.1-3: all list pages are immutable, bounded and owner/filter/limit bound", async () => {
  const f = fixture(), committed = await f.complete(new Uint8Array());
  for (let index = 1; index < 129; index++) f.records.set(String(index), { ...committed.record, id: String(index), createdAt: 1000 - index });
  const first = await f.service.request(p, "storage/list", { limit: 64 }, signal());
  if (!first.ok || !first.value.nextCursor) throw new Error("cursor missing");
  f.records.clear();
  const second = await f.service.request(p, "storage/list", { limit: 64, cursor: first.value.nextCursor }, signal());
  if (!second.ok || !second.value.nextCursor) throw new Error("second cursor missing");
  const third = await f.service.request(p, "storage/list", { limit: 64, cursor: second.value.nextCursor }, signal());
  expect(first.value.entries).toHaveLength(64); expect(second.value.entries).toHaveLength(64);
  expect(third).toMatchObject({ ok: true, value: { entries: [{ id: "128" }] } });
  expect(Buffer.byteLength(JSON.stringify(second))).toBeLessThanOrEqual(262144);
  expect(await f.service.request(p, "storage/list", { limit: 64, cursor: first.value.nextCursor }, signal())).toEqual(second);
  for (const params of [{ limit: 63, cursor: first.value.nextCursor },
    { limit: 64, kind: "other", cursor: first.value.nextCursor }])
    expect(await f.service.request(p, "storage/list", params, signal())).toMatchObject({ error: { code: "PLUGIN_E_STALE_RESOURCE" } });
  expect(await f.service.request({ ...p, owner: { ...owner, generation: 2 } }, "storage/list",
    { limit: 64, cursor: first.value.nextCursor }, signal())).toMatchObject({ ok: false });
});
it("B2-12.1-3: four read pins and four independent list snapshots; closing frees a pin", async () => {
  const f = fixture(), committed = await f.complete(new Uint8Array());
  f.records.set("second", { ...committed.record, id: "second" });
  const handles: string[] = [];
  for (let index = 0; index < 4; index++) {
    const opened = await f.service.request(p, "storage/openRead", { id: committed.id,
      expectedRevision: committed.record.revision, schemaVersion: 1 }, signal());
    if (!opened.ok) throw new Error("pin missing"); handles.push(opened.value.read);
    expect(await f.service.request(p, "storage/list", { limit: 1 }, signal())).toMatchObject({ ok: true });
  }
  expect(await f.service.request(p, "storage/openRead", { id: committed.id,
    expectedRevision: committed.record.revision, schemaVersion: 1 }, signal())).toMatchObject({ error: { code: "PLUGIN_E_RESOURCE_LIMIT" } });
  expect(await f.service.request(p, "storage/list", { limit: 1 }, signal())).toMatchObject({ error: { code: "PLUGIN_E_RESOURCE_LIMIT" } });
  await f.service.request(p, "storage/closeRead", { read: handles[0]! }, signal());
  expect(await f.service.request(p, "storage/openRead", { id: committed.id,
    expectedRevision: committed.record.revision, schemaVersion: 1 }, signal())).toMatchObject({ ok: true });
  f.advance(30000);
  expect(await f.service.request(p, "storage/list", { limit: 1 }, signal())).toMatchObject({ ok: true });
});
it("B2-RF1: an uncertain delete retains its ticket, blocks flush and only reconciles", async () => {
  const f = fixture(), committed = await f.complete(new Uint8Array());
  const publish = f.deps.engine.publish;
  f.deps.engine.publish = vi.fn(async () => ({ disposition: "unknown" as const }));
  f.deps.engine.reconcile = vi.fn(publish);
  const params = { id: committed.id, expectedRevision: committed.record.revision };
  expect(await f.service.request(p, "storage/delete", params, signal())).toMatchObject({ error: { detail: { disposition: "unknown" } } });
  expect(await f.service.request(p, "storage/flush", {}, signal())).toMatchObject({ ok: false });
  const resolved = await f.service.request(p, "storage/delete", params, signal());
  expect(resolved).toMatchObject({ ok: true });
  expect(await f.service.request(p, "storage/delete", params, signal())).toEqual(resolved);
  expect(f.deps.engine.publish).toHaveBeenCalledOnce(); expect(f.deps.engine.reconcile).toHaveBeenCalledOnce();
});
it("B2-12.1-3: I/O during seal is not checksum mismatch; original bytes can seal again", async () => {
  const f = fixture(), begin = await f.begin(new Uint8Array());
  const seal = f.deps.engine.seal;
  f.deps.engine.seal = vi.fn().mockRejectedValueOnce(new Error("/private/path" )).mockImplementation(seal);
  const failed = await f.service.request(p, "storage/sealWrite", { write: begin.write }, signal());
  expect(failed).toMatchObject({ error: { code: "PLUGIN_E_STORAGE_IO", detail: { reason: "io" } } });
  expect(JSON.stringify(failed)).not.toContain("/private/path");
  expect(await f.service.request(p, "storage/sealWrite", { write: begin.write }, signal())).toMatchObject({ ok: true });
});
it("B2-12.1-3: progress never extends a write past its original 120-second cap", async () => {
  const f = fixture(), begin = await f.begin(Buffer.from("abcde"));
  for (let index = 0; index < 4; index++) {
    f.advance(25000);
    expect(await f.service.request(p, "storage/writeChunk", { write: begin.write,
      offset: index, data: Buffer.from("abcde"[index]!).toString("base64") }, signal())).toMatchObject({ ok: true });
  }
  f.advance(20000);
  expect(await f.service.request(p, "storage/writeChunk", { write: begin.write, offset: 4, data: "ZQ==" }, signal())).toMatchObject({ ok: false });
  expect(f.append).toHaveBeenCalledTimes(4);
});

```

- [ ] **Step 2: Run RED**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/persistence/record-port.test.ts src/main/plugins/persistence/record-service.test.ts
```

Expected: missing `createRecordService`, `decodeChunk` and `PersistenceFault` exports. Do not accept a crash from Electron imports as RED; these modules must remain Node-testable.

- [ ] **Step 3: Implement the record port, errors and bounded chunk decoder**

Replace `apps/desktop/src/main/plugins/persistence/record-port.ts`:

```ts
import { RpcError, RPC_ERRORS } from "@kobrixa/plugin-protocol";
import type { BusinessResult, PersistenceFailureDetail, PersistenceReason, PluginErrorCode,
  Permission, RecordMeta, RecordWrite, ResourceOwner, ResourceErrorDetail, StorageRequestMap } from "@kobrixa/plugin-protocol";
import type { Principal } from "@kobrixa/plugin-runtime";
import type { PersistenceEnginePort, PersistenceReadPort, PersistenceEvidencePort } from "./engine-port.js";
export interface RecordServicePort {
  request<M extends keyof StorageRequestMap>(principal: Principal, method: M,
    params: StorageRequestMap[M]["params"], signal: AbortSignal): Promise<StorageRequestMap[M]["result"]>;
}
export const ownerKey = (owner: ResourceOwner) => JSON.stringify([
  owner.sourceKey, owner.pluginId, owner.generation, owner.hostEpoch, owner.processEpoch,
]);
export class PersistenceFault extends Error {
  readonly result: Extract<BusinessResult<never, PersistenceFailureDetail>, { ok: false }>;
  constructor(code: PluginErrorCode, reason?: PersistenceReason, resource: ResourceErrorDetail["resource"] = "storage-write") {
    super("Persistence request could not be completed.");
    const detail: PersistenceFailureDetail | undefined = code === "PLUGIN_E_STALE_RESOURCE"
      ? { kind: "resource", reason: "stale", resource }
      : code === "PLUGIN_E_RESOURCE_LIMIT" ? { kind: "resource", reason: "quota", resource }
      : code === "PLUGIN_E_PERMISSION_DENIED" ? { kind: "permission", reason: "permission" }
      : reason ? { kind: "persistence", reason } : undefined;
    this.result = { ok: false, error: { code, message: this.message,
      ...(detail ? { detail } : {}) } };
  }
}
export function stale(resource: ResourceErrorDetail["resource"] = "storage-write"): never {
  throw new PersistenceFault("PLUGIN_E_STALE_RESOURCE", undefined, resource);
}
export function conflict(reason: PersistenceReason): never { throw new PersistenceFault("PLUGIN_E_STORAGE_CONFLICT", reason); }
export function limit(resource: ResourceErrorDetail["resource"] = "storage-write"): never {
  throw new PersistenceFault("PLUGIN_E_RESOURCE_LIMIT", undefined, resource);
}
export function decodeChunk(text: string): Uint8Array {
  if (!text.length || text.length > 349528 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text))
    throw new RpcError(RPC_ERRORS.invalidParams, "Invalid chunk encoding.");
  const bytes = Buffer.from(text, "base64");
  if (!bytes.length || bytes.length > 262144 || bytes.toString("base64") !== text)
    throw new RpcError(RPC_ERRORS.invalidParams, "Invalid chunk encoding.");
  return bytes;
}
type Value<M extends keyof StorageRequestMap> = Extract<StorageRequestMap[M]["result"], { ok: true }>["value"];
export type RecordDependencies = {
  now(): number;
  wall(): number;
  live(owner: ResourceOwner): boolean;
  permission(principal: Principal, permission: Permission): boolean;
  engine: PersistenceEnginePort;
  read: PersistenceReadPort;
  evidence: PersistenceEvidencePort;
  checkpoint: {
    authorize(owner: ResourceOwner, input: RecordWrite, token?: string): RecordMeta["checkpoint"];
    committed(owner: ResourceOwner, input: RecordWrite, record: RecordMeta): void;
    open(owner: ResourceOwner): boolean;
    register(owner: ResourceOwner, params: StorageRequestMap["storage/registerCheckpoint"]["params"]):
      Promise<StorageRequestMap["storage/registerCheckpoint"]["result"]>;
    abandon(owner: ResourceOwner, params: StorageRequestMap["storage/abandonCheckpoint"]["params"]):
      Promise<StorageRequestMap["storage/abandonCheckpoint"]["result"]>;
  };
};
```

The request shape validator runs before decoding; malformed fields use numeric invalidParams. `decodeChunk` additionally enforces canonical encoding before a bounded Buffer allocation. Admission reserves queue bytes before calling this helper in T5. No error includes native exception text.

Run GREEN for this implementation before starting the next slice:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/persistence/record-port.test.ts
```

Expected: the frozen signature, owner binding and canonical-base64 tests pass. These are constructor-double results; the final task commit below includes this slice.

- [ ] **Step 4: Implement ordinary record handlers over the frozen engine**

Create `apps/desktop/src/main/plugins/persistence/record-service.ts`:

```ts
import { randomUUID } from "node:crypto";
import { RpcError, RPC_ERRORS } from "@kobrixa/plugin-protocol";
import type { RecordMeta, RecordWrite, ResourceOwner, StorageRequestMap, WriteProgress,
  Receipt, RecordRevision } from "@kobrixa/plugin-protocol";
import type { Principal } from "@kobrixa/plugin-runtime";
import type { PublicationTicket } from "./engine-port.js";
import { PersistenceFault, conflict, decodeChunk, limit, ownerKey, stale,
  type RecordDependencies, type RecordServicePort } from "./record-port.js";

type Write = { owner: ResourceOwner; input: RecordWrite; ticket: PublicationTicket;
  record: RecordMeta; state: WriteProgress["state"]; received: number; created: number; progress: number;
  terminal?: number; receipt?: Receipt<RecordRevision>; last?: { offset: number; data: string; expiresAt: number };
  error?: WriteProgress["error"]; pending: Promise<unknown> };
type Read = { owner: ResourceOwner; pin: string; record: RecordMeta; created: number; progress: number; closed: boolean };
type List = { owner: ResourceOwner; kind: string | undefined; limit: number; created: number; progress: number;
  entries: RecordMeta[]; cursors: string[]; bytes: number; closed: boolean };
export function createRecordService(deps: RecordDependencies): RecordServicePort {
  const writes = new Map<string, Write>();
  const targets = new Map<string, string>();
  const reads = new Map<string, Read>();
  const lists = new Map<string, List>();
  const admitting = new Map<string, number>();
  const opening = new Map<string, number>();
  const listing = new Set<string>();
  const deleting = new Map<string, { owner: ResourceOwner; expected: string; ticket: PublicationTicket }>();
  const deleted = new Map<string, { owner: ResourceOwner; expected: string; receipt: Receipt<RecordRevision>; until: number }>();
  const targetKey = (owner: ResourceOwner, id: string) => JSON.stringify([owner.sourceKey, id]);
  const expiry = (value: { created: number; progress: number }) => Math.min(value.created + 120000, value.progress + 30000);
  const wallExpiry = (deadline: number) => Math.max(0, deps.wall() + deadline - deps.now());
  const terminal = (write: Write) => ["committed", "aborted", "expired", "failed"].includes(write.state);
  function sweep() {
    for (const [id, write] of writes) if (write.terminal !== undefined && deps.now() >= write.terminal + 120000) writes.delete(id);
    for (const [id, entry] of deleted) if (deps.now() >= entry.until) deleted.delete(id);
    for (const [id, read] of reads) if (deps.now() >= expiry(read)) {
      reads.delete(id); if (!read.closed) void deps.read.close(read.owner, read.pin).catch(() => {});
    }
    for (const [id, list] of lists) if (deps.now() >= expiry(list)) lists.delete(id);
  }
  function get(owner: ResourceOwner, id: string): Write {
    const write = writes.get(id);
    if (!write || ownerKey(write.owner) !== ownerKey(owner)) stale();
    return write;
  }
  async function gate(write: Write, signal: AbortSignal, token?: string) {
    if (write.state === "publishing" || terminal(write)) return;
    if (deps.now() >= expiry(write)) {
      const disposition = await deps.engine.abort(write.ticket);
      if (disposition === "unknown") { write.state = "publishing"; return; }
      write.state = disposition === "committed" ? "publishing" : "expired";
      if (write.state === "expired") { write.terminal = deps.now(); targets.delete(targetKey(write.owner, write.record.id)); }
      stale();
    }
    if (signal.aborted) throw new PersistenceFault("PLUGIN_E_CANCELLED");
    if (!deps.live(write.owner) && !write.input.drainToken) stale();
    deps.checkpoint.authorize(write.owner, write.input, token ?? write.input.drainToken);
  }
  function status(write: Write): WriteProgress {
    return { write: write.ticket.id, id: write.record.id, state: write.state,
      receivedBytes: write.received, expiresAt: wallExpiry(expiry(write)),
      ...(write.receipt ? { receipt: write.receipt } : {}), ...(write.error ? { error: write.error } : {}) };
  }
  function committed(write: Write, receipt: Receipt<RecordRevision>) {
    delete write.error;
    write.state = "committed"; write.receipt = receipt; write.terminal = deps.now();
    targets.delete(targetKey(write.owner, write.record.id));
    deps.checkpoint.committed(write.owner, write.input, write.record);
  }
  async function reconcile(write: Write) {
    if (write.state !== "publishing") return;
    const outcome = await deps.engine.reconcile(write.ticket);
    if (outcome.disposition === "committed" && outcome.receipt) committed(write, outcome.receipt);
    else if (outcome.disposition === "not-committed") write.state = "sealed";
  }
  function unknown(): never {
    const error = new PersistenceFault("PLUGIN_E_STORAGE_IO", "publish-uncertain");
    error.result.error.detail = { kind: "persistence", reason: "publish-uncertain", disposition: "unknown" };
    throw error;
  }
  type Handlers = { [M in keyof StorageRequestMap]: (owner: ResourceOwner,
    params: StorageRequestMap[M]["params"], signal: AbortSignal) => Promise<StorageRequestMap[M]["result"]> };
  async function begin(owner: ResourceOwner, input: RecordWrite, signal: AbortSignal) {
    for (const write of writes.values()) if (!terminal(write) && write.state !== "publishing" && deps.now() >= expiry(write)) {
      try { await gate(write, signal); } catch { /* Expired evidence stays queryable. */ }
    }
    if (!deps.live(owner) && !input.drainToken) stale();
    if (signal.aborted) throw new PersistenceFault("PLUGIN_E_CANCELLED");
    const active = [...writes.values()].filter((write) => !terminal(write));
    if (active.length + [...admitting.values()].reduce((a, b) => a + b, 0) >= 16 ||
      active.filter((write) => write.owner.sourceKey === owner.sourceKey).length + (admitting.get(owner.sourceKey) ?? 0) >= 2 ||
      writes.size >= 1024 || [...writes.values()].filter((write) => write.owner.sourceKey === owner.sourceKey).length >= 64) limit();
    const id = input.target.mode === "create" ? randomUUID() : input.target.id;
    const key = targetKey(owner, id);
    if (targets.has(key)) conflict("write-in-progress");
    const writeId = randomUUID(); targets.set(key, writeId);
    admitting.set(owner.sourceKey, (admitting.get(owner.sourceKey) ?? 0) + 1);
    let admitted = true;
    try {
      const old = input.target.mode === "replace" ? await deps.read.stat(owner, id) : null;
      if (old && input.target.mode === "replace" && old.revision !== input.target.expectedRevision) conflict("revision-mismatch");
      const checkpoint = deps.checkpoint.authorize(owner, input, input.drainToken);
      const now = deps.now();
      const record: RecordMeta = { id, revision: `r_${randomUUID().replaceAll("-", "")}`,
        kind: input.kind, schemaVersion: input.schemaVersion, label: input.label, mediaType: input.mediaType,
        byteLength: input.byteLength, sha256: input.sha256, createdAt: old?.createdAt ?? deps.wall(),
        updatedAt: deps.wall(), checkpoint, interrupted: false };
      const ticket: PublicationTicket = Object.freeze({ id: writeId, owner: Object.freeze({ ...owner }),
        deadlineMonotonicMs: now + 120000, metadata: { kind: "record" as const, record, deleted: false },
        target: { kind: "record" as const, id, expectedRevision: input.target.mode === "replace" ? input.target.expectedRevision : null } });
      const write: Write = { owner: ticket.owner, ticket, record, input: structuredClone(input),
        state: "receiving", received: 0, created: now, progress: now, pending: Promise.resolve() };
      writes.set(writeId, write);
      admitting.set(owner.sourceKey, admitting.get(owner.sourceKey)! - 1); admitted = false;
      await deps.engine.reserve(ticket, input.byteLength);
      await gate(write, signal);
      return { ok: true as const, value: { write: writeId, id, expiresAt: wallExpiry(expiry(write)) } };
    } catch (error) {
      const write = writes.get(writeId);
      if (write && write.state === "publishing") throw error;
      if (write) await deps.engine.abort(write.ticket);
      targets.delete(key); writes.delete(writeId); throw error;
    } finally { if (admitted) admitting.set(owner.sourceKey, admitting.get(owner.sourceKey)! - 1); }
  }
  const handlers: Handlers = {
    "storage/beginWrite": begin,
    "storage/writeChunk": async (owner, p, signal) => {
      const write = get(owner, p.write); await gate(write, signal);
      if (write.state !== "receiving") conflict("sealed");
      if (write.last?.offset === p.offset && write.last.data === p.data)
        return { ok: true, value: { receivedBytes: write.received, expiresAt: write.last.expiresAt } };
      if (p.offset !== write.received) conflict("offset-mismatch");
      const bytes = decodeChunk(p.data);
      if (bytes.length > write.input.byteLength - write.received) conflict("incomplete");
      let offset = 0;
      try {
        while (offset < bytes.length) {
          await gate(write, signal);
          const count = await deps.engine.append(write.ticket, write.received + offset, bytes.subarray(offset));
          if (count <= 0 || count > bytes.length - offset) throw new PersistenceFault("PLUGIN_E_STORAGE_IO", "io");
          offset += count;
        }
      } catch (error) {
        await deps.engine.abort(write.ticket);
        write.state = "aborted"; write.terminal = deps.now(); targets.delete(targetKey(owner, write.record.id));
        throw error;
      }
      write.received += bytes.length; write.progress = deps.now();
      const expiresAt = wallExpiry(expiry(write)); write.last = { offset: p.offset, data: p.data, expiresAt };
      return { ok: true, value: { receivedBytes: write.received, expiresAt } };
    },
    "storage/sealWrite": async (owner, p, signal) => {
      const write = get(owner, p.write); await gate(write, signal);
      if (write.state === "sealed" || write.state === "committed") return { ok: true, value: status(write) };
      if (write.state !== "receiving" || write.received !== write.input.byteLength) conflict("incomplete");
      try { await deps.engine.seal(write.ticket, write.received, write.input.sha256); }
      catch (error) {
        write.error = error instanceof PersistenceFault ? error.result.error
          : new PersistenceFault("PLUGIN_E_STORAGE_IO", "io").result.error;
        if (error instanceof PersistenceFault && error.result.error.detail?.kind === "persistence" &&
          error.result.error.detail.reason === "checksum-mismatch") {
          write.state = "failed"; write.terminal = deps.now(); targets.delete(targetKey(owner, write.record.id));
          await deps.engine.abort(write.ticket);
        }
        throw error;
      }
      write.state = "sealed"; delete write.error; write.progress = deps.now(); return { ok: true, value: status(write) };
    },
    "storage/commitWrite": async (owner, p, signal) => {
      const write = get(owner, p.write);
      if (write.state === "publishing") await reconcile(write);
      if (write.receipt) return { ok: true, value: { record: write.record, receipt: write.receipt } };
      if (write.state === "publishing") unknown();
      await gate(write, signal, p.drainToken);
      if (write.state !== "sealed") conflict("incomplete");
      if (write.input.drainToken !== p.drainToken) stale();
      write.state = "publishing";
      try {
        const result = await deps.engine.publish(write.ticket);
        if (result.disposition === "unknown") unknown();
        if (result.disposition === "not-committed" || !result.receipt) {
          write.state = "sealed";
          const failure = new PersistenceFault("PLUGIN_E_STORAGE_IO", "io"); write.error = failure.result.error; throw failure;
        }
        committed(write, result.receipt);
        return { ok: true, value: { record: write.record, receipt: result.receipt } };
      } catch (error) { if (write.state === "publishing") unknown(); throw error; }
    },
    "storage/writeStatus": async (owner, p, signal) => {
      const write = get(owner, p.write);
      try { await gate(write, signal); } catch { if (!terminal(write)) throw new PersistenceFault("PLUGIN_E_STALE_RESOURCE"); }
      await reconcile(write); return { ok: true, value: status(write) };
    },
    "storage/abortWrite": async (owner, p) => {
      const write = get(owner, p.write);
      if (write.receipt) return { ok: true, value: { disposition: "committed", receipt: write.receipt } };
      const disposition = await deps.engine.abort(write.ticket);
      if (disposition === "aborted") { write.state = "aborted"; write.terminal = deps.now(); targets.delete(targetKey(owner, write.record.id)); }
      else write.state = "publishing";
      return { ok: true, value: { disposition } };
    },
    "storage/stat": async (owner, p) => ({ ok: true, value: { record: await deps.read.stat(owner, p.id) } }),
    "storage/list": async (owner, p) => {
      const page = (list: List, index: number) => {
        const entries = list.entries.slice(index * list.limit, (index + 1) * list.limit);
        const nextCursor = list.cursors[index + 1];
        const value = { entries, ...(nextCursor ? { nextCursor } : {}) };
        if (entries.length > 64 || Buffer.byteLength(JSON.stringify({ ok: true, value })) > 262144) limit("storage-list");
        return structuredClone(value);
      };
      if (p.cursor) {
        const list = [...lists.values()].find((item) => item.cursors.includes(p.cursor!));
        if (!list || ownerKey(list.owner) !== ownerKey(owner) || list.kind !== p.kind || list.limit !== p.limit) stale("storage-list");
        const index = list.cursors.indexOf(p.cursor);
        list.progress = deps.now();
        if (index === list.cursors.length - 1) list.closed = true;
        return { ok: true, value: page(list, index) };
      }
      if (listing.has(owner.sourceKey) || [...lists.values()].filter((list) => !list.closed && list.owner.sourceKey === owner.sourceKey).length >= 4 ||
        lists.size >= 1024 || [...lists.values()].filter((list) => list.owner.sourceKey === owner.sourceKey).length >= 64) limit("storage-list");
      listing.add(owner.sourceKey);
      try {
        const entries: RecordMeta[] = [], seen = new Set<string>();
        let cursor: string | undefined;
        do {
          const next = await deps.read.list(owner, { ...(p.kind ? { kind: p.kind } : {}), limit: 64,
            ...(cursor ? { cursor } : {}) });
          if (next.entries.length > 64 || entries.length + next.entries.length > 256) limit("storage-list");
          entries.push(...structuredClone(next.entries));
          cursor = next.nextCursor;
          if (cursor && seen.has(cursor)) throw new PersistenceFault("PLUGIN_E_STORAGE_IO", "corrupt");
          if (cursor) seen.add(cursor);
          if (seen.size > 4) limit("storage-list");
        } while (cursor);
        entries.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const bytes = Buffer.byteLength(JSON.stringify(entries)) + Math.max(1, Math.ceil(entries.length / p.limit)) * 36;
        if ([...lists.values()].reduce((n, x) => n + x.bytes, bytes) > 8388608 ||
          [...lists.values()].filter((x) => x.owner.sourceKey === owner.sourceKey).reduce((n, x) => n + x.bytes, bytes) > 524288) limit("storage-list");
        const list: List = { owner: { ...owner }, kind: p.kind, limit: p.limit, created: deps.now(), progress: deps.now(),
          entries, bytes, closed: false, cursors: Array.from({ length: Math.max(1, Math.ceil(entries.length / p.limit)) }, () => randomUUID()) };
        for (let index = 0; index < list.cursors.length; index++) page(list, index);
        if (list.cursors.length > 1) lists.set(list.cursors[0]!, list);
        return { ok: true, value: page(list, 0) };
      } finally { listing.delete(owner.sourceKey); }
    },
    "storage/openRead": async (owner, p) => {
      const active = [...reads.values()].filter((r) => !r.closed && r.owner.sourceKey === owner.sourceKey).length;
      if (active + (opening.get(owner.sourceKey) ?? 0) >= 4 || reads.size >= 1024 ||
        [...reads.values()].filter((r) => r.owner.sourceKey === owner.sourceKey).length >= 64) limit("storage-read");
      opening.set(owner.sourceKey, (opening.get(owner.sourceKey) ?? 0) + 1);
      try {
        const record = await deps.read.stat(owner, p.id);
        if (record.revision !== p.expectedRevision) conflict("revision-mismatch");
        if (record.schemaVersion !== p.schemaVersion) throw new PersistenceFault("PLUGIN_E_STORAGE_VERSION", "schema-mismatch");
        const pin = await deps.read.open(owner, p.id, p.expectedRevision);
        const handle = randomUUID(), now = deps.now();
        reads.set(handle, { owner: { ...owner }, pin, record, created: now, progress: now, closed: false });
        return { ok: true, value: { read: handle, record, expiresAt: wallExpiry(now + 30000) } };
      } finally { opening.set(owner.sourceKey, opening.get(owner.sourceKey)! - 1); }
    },
    "storage/readChunk": async (owner, p) => {
      const read = reads.get(p.read);
      if (!read || read.closed || ownerKey(read.owner) !== ownerKey(owner)) stale("storage-read");
      if (p.offset > read.record.byteLength) throw new RpcError(RPC_ERRORS.invalidParams, "Offset exceeds record.");
      const bytes = await deps.read.read(owner, read.pin, p.offset, Math.min(p.maxBytes, read.record.byteLength - p.offset));
      read.progress = deps.now(); const nextOffset = p.offset + bytes.length;
      return { ok: true, value: { offset: p.offset, data: Buffer.from(bytes).toString("base64"), nextOffset,
        eof: nextOffset === read.record.byteLength } };
    },
    "storage/closeRead": async (owner, p) => {
      const read = reads.get(p.read); if (!read || ownerKey(read.owner) !== ownerKey(owner)) stale("storage-read");
      if (!read.closed) { await deps.read.close(owner, read.pin); read.closed = true; }
      return { ok: true, value: {} };
    },
    "storage/delete": async (owner, p, signal) => {
      const key = targetKey(owner, p.id), previous = deleted.get(key);
      if (previous && ownerKey(previous.owner) === ownerKey(owner) && previous.expected === p.expectedRevision)
        return { ok: true, value: { deleted: true, receipt: previous.receipt } };
      const pending = deleting.get(key);
      if (pending && (ownerKey(pending.owner) !== ownerKey(owner) || pending.expected !== p.expectedRevision)) stale();
      if (!pending && targets.has(key)) conflict("write-in-progress");
      if (!pending) {
        targets.set(key, "delete");
        try {
          const record = await deps.read.stat(owner, p.id);
          if (record.revision !== p.expectedRevision) conflict("revision-mismatch");
          if (signal.aborted || !deps.live(owner)) stale();
          const ticket: PublicationTicket = { id: randomUUID(), owner: { ...owner }, deadlineMonotonicMs: deps.now() + 10000,
            metadata: { kind: "record", record: { ...record, revision: `r_${randomUUID().replaceAll("-", "")}` }, deleted: true },
            target: { kind: "record", id: p.id, expectedRevision: p.expectedRevision } };
          await deps.engine.reserve(ticket, 0);
          if (signal.aborted || !deps.live(owner)) { await deps.engine.abort(ticket); stale(); }
          deleting.set(key, { owner: { ...owner }, expected: p.expectedRevision, ticket });
        } catch (error) { targets.delete(key); throw error; }
      }
      const ticket = deleting.get(key)!.ticket;
      let result: Awaited<ReturnType<RecordDependencies["engine"]["publish"]>>;
      try { result = await (pending ? deps.engine.reconcile(ticket) : deps.engine.publish(ticket)); }
      catch { unknown(); }
      if (result.disposition === "unknown") unknown();
      deleting.delete(key); targets.delete(key);
      if (result.disposition !== "committed" || !result.receipt) throw new PersistenceFault("PLUGIN_E_STORAGE_IO", "io");
      deleted.set(key, { owner: { ...owner }, expected: p.expectedRevision, receipt: result.receipt, until: deps.now() + 120000 });
      return { ok: true, value: { deleted: true, receipt: result.receipt } };
    },
    "storage/flush": async (owner, _p, signal) => {
      if (deps.checkpoint.open(owner) || [...deleting.values()].some((d) => d.owner.sourceKey === owner.sourceKey) ||
        [...writes.values()].some((w) => w.owner.sourceKey === owner.sourceKey && !terminal(w)))
        conflict("flush-incomplete");
      const barrier = deps.evidence.capture({ kind: "namespace", owner }, deps.now() + 10000);
      const evidence = await deps.evidence.flush(barrier);
      if (evidence.state !== "saved" || evidence.incomplete.length || evidence.unknown.length)
        conflict("flush-incomplete");
      return { ok: true, value: { barrier: barrier.id, durability: "file-sync-only" } };
    },
    "storage/quota": (owner) => deps.evidence.quota(owner),
    "storage/registerCheckpoint": (owner, p) => deps.checkpoint.register(owner, p),
    "storage/abandonCheckpoint": (owner, p) => deps.checkpoint.abandon(owner, p),
    "storage/drain": async () => { throw new RpcError(RPC_ERRORS.methodNotFound, "Host-only method direction."); },
  };
  return {
    async request<M extends keyof StorageRequestMap>(principal: Principal, method: M,
      params: StorageRequestMap[M]["params"], signal: AbortSignal): Promise<StorageRequestMap[M]["result"]> {
      sweep();
      if (principal.kind !== "plugin") return new PersistenceFault("PLUGIN_E_PERMISSION_DENIED").result;
      const owner = principal.owner;
      const read = ["storage/stat", "storage/list", "storage/openRead", "storage/readChunk", "storage/closeRead"].includes(method);
      const permission = read ? "storage.read" : "storage.write";
      if (!deps.permission(principal, permission) && !(method === "storage/quota" && deps.permission(principal, "storage.read")))
        return { ok: false, error: { code: "PLUGIN_E_PERMISSION_DENIED", message: "Permission required.",
          detail: { kind: "permission", reason: "permission" } } };
      const run = async () => {
        try { return await handlers[method](owner, params, signal); }
        catch (error) {
          if (error instanceof RpcError) throw error;
          return error instanceof PersistenceFault ? error.result
            : new PersistenceFault("PLUGIN_E_STORAGE_IO", "io").result;
        }
      };
      if ("write" in params && typeof params.write === "string") {
        const write = writes.get(params.write);
        if (write) {
          const next = write.pending.catch(() => {}).then(run); write.pending = next; return next;
        }
      }
      return run();
    },
  };
}
```

- [ ] **Step 5: Run GREEN and commit the record slice**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/persistence/record-port.test.ts src/main/plugins/persistence/record-service.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git diff --check
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git add apps/desktop/src/main/plugins/persistence/record-service.ts apps/desktop/src/main/plugins/persistence/record-service.test.ts apps/desktop/src/main/plugins/persistence/record-port.ts apps/desktop/src/main/plugins/persistence/record-port.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git commit -m "feat(storage): add bounded record tickets and immutable reads"
```

Expected: all record and port tests pass against doubles. Commit is **controller runs outside sandbox**. Actual 8 MiB streaming, 256 records, 512 MiB/source, 1 GiB/host, 32/128 MiB temporary budget, pinned-object GC and kill/reopen evidence belong to the real T2/T7 gate. T4 must not replace T2 with an in-memory production implementation.

### Task 3B2-T5: User export/copy, checkpoint drain and core recovery

**Files**

- Modify (T0 scaffold; baseline N): `apps/desktop/src/main/plugins/persistence/host-port.ts`
- Create/Test: `apps/desktop/src/main/plugins/persistence/host-port.test.ts`
- Modify (T0 scaffold; baseline N): `apps/desktop/src/main/plugins/persistence/actions.ts`
- Create/Test: `apps/desktop/src/main/plugins/persistence/actions.test.ts`
- Create: `apps/desktop/src/main/plugins/persistence/lifecycle.ts`
- Create/Test: `apps/desktop/src/main/plugins/persistence/lifecycle.test.ts`
- Create: `apps/desktop/src/main/plugins/persistence/recovery-port.ts`
- Create/Test: `apps/desktop/src/main/plugins/persistence/recovery-port.test.ts`
- Modify (T0 scaffold; baseline N): `packages/plugin-runtime/src/persistence-participant.ts`
- Modify/Test (T0 scaffold; baseline N): `packages/plugin-runtime/src/persistence-participant.test.ts`

**Interfaces**

Consumes `ReservationBindingPort.validate(owner: ResourceOwner, reservationId: Handle): ReservationBinding | null`, `ReservationEnded`, `DeviceDrainGrant`, `ProfileWriterLock.assertHeld(): void`, `CoreActionValidationPort`, `UserPersistenceActionPort`, T2 engine/read and T3/T4 services. It does **not** call `reservations.onEnded`; the only listener belongs to B1-T5 and must be installed before public checkpoint admission. No Electron imports occur in runtime.

Produces the exact participant, offer, report and host factory signatures in the implementation blocks below. `PersistenceOwner = ResourceOwner` is an alias, never a new identity shape. Consumes B1's exact action ports:

```ts
interface UserPersistenceActionPort {
  claim(context: { owner: ResourceOwner; actionRef: Handle }, purpose: "storage.export" | "ui.clipboard"):
    BusinessResult<{ action: Handle }, PermissionErrorDetail | ResourceErrorDetail>;
}
interface CoreActionValidationPort {
  claim(action: CoreActionReference, target: CoreActionTarget): boolean;
  isClaimed(action: CoreActionReference, target: CoreActionTarget): boolean;
  complete(action: CoreActionReference): void;
}
```

Preconditions: F includes B2 module-local schemas and all type-only exports; W1 may exercise only local constructor doubles. Production bindings are supplied by persistent D170/K170/R170 owners. AM-18/23–29 bind all adapters before P170: D170 supplies `PersistenceCompositionInput`, K170 supplies the packaged worker path, and R170 supplies the original-peer drain dispatcher. These are required production dependencies, with no factory registry or second worker.

- [ ] **Step 1: Pin the runtime types and participant delegation**

Replace `packages/plugin-runtime/src/persistence-participant.test.ts` with these canonical F assertions and the fourth-argument assertion:

```ts
import { expectTypeOf, it } from "vitest";
import type { PersistenceParticipant, DrainOffer, DrainDispatcher, DrainReport, PersistenceOwner } from "./persistence-participant.js";
import type { DeviceDrainGrant, ReservationEnded } from "./device-resources.js";
it("keeps freeze synchronous and retains its fourth grant argument", () => {
  expectTypeOf<PersistenceParticipant["freeze"]>().toEqualTypeOf<(
    owner: PersistenceOwner, reason: import("@kobrixa/plugin-protocol").DrainReason,
    deadline: number, deviceDrain?: DeviceDrainGrant,
  ) => DrainOffer>();
  expectTypeOf<PersistenceParticipant["endReservation"]>().toEqualTypeOf<(
    event: ReservationEnded, deadline: number,
  ) => DrainOffer | null>();
  expectTypeOf<PersistenceParticipant["drain"]>().toEqualTypeOf<(
    offer: DrainOffer, dispatch: DrainDispatcher,
  ) => Promise<DrainReport>>();
  expectTypeOf<PersistenceParticipant["ownerLost"]>().toEqualTypeOf<(owner: PersistenceOwner) => Promise<DrainReport>>();
});
```

Run the compile gate first. It should already pass F, because these are immutable contract assertions, not an implementation red test:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime test -- src/persistence-participant.test.ts
```

Replace `packages/plugin-runtime/src/persistence-participant.ts` with the complete canonical declarations (type-only imports, no runtime dependency on desktop):

```ts
import type { BusinessResult, Counter, DrainReason, DrainRequest, Handle,
  PersistenceFailureDetail, RecordId, RecordRevision, ResourceOwner, Timestamp } from "@kobrixa/plugin-protocol";
import type { DeviceDrainGrant, ReservationEnded } from "./device-resources.js";
import type { CoreActionReference } from "./core-actions.js";
export type PersistenceOwner = ResourceOwner;
export type DrainOffer = Readonly<{
  owner: PersistenceOwner;
  reason: DrainReason;
  deadlineMonotonicMs: number;
  token: Handle;
  checkpoints: readonly DrainRequest["checkpoints"][number][];
  writes: readonly DrainRequest["writes"][number][];
  acceptedTickets: readonly Handle[];
}>;
export type DrainDispatcher = (owner: PersistenceOwner, request: DrainRequest, signal: AbortSignal) =>
  Promise<BusinessResult<{ status: "submitted" | "checkpoint-only"; writes: Handle[] }, PersistenceFailureDetail>>;
export type DrainReport = {
  state: "saved" | "retryable" | "checkpoint-only" | "uncertain";
  blocker: boolean;
  recovery?: Handle;
  retryAction?: Handle;
  pendingSettings: boolean;
  records: Array<{ id: RecordId; committedRevision: RecordRevision | null; final: boolean;
    payload: "complete-staging" | "checkpoint-only" | "none"; expiresAt?: number }>;
  errors: Array<{ code: string; message: string; detail?: PersistenceFailureDetail }>;
};
export type PersistenceRecoverySnapshot = {
  revision: Counter;
  items: Array<{ id: Handle; sourceKey: string; pluginId: string; recordId: RecordId | null;
    committedRevision: RecordRevision | null; state: DrainReport["state"];
    payload: "complete-staging" | "checkpoint-only" | "none"; expiresAt?: Timestamp;
    actions: Array<{ id: Handle; kind: "retry" | "export" | "discard" }> }>;
};
export interface PersistenceParticipant {
  endReservation(event: ReservationEnded, deadline: number): DrainOffer | null;
  freeze(owner: PersistenceOwner, reason: DrainReason, deadline: number, deviceDrain?: DeviceDrainGrant): DrainOffer;
  drain(offer: DrainOffer, dispatch: DrainDispatcher): Promise<DrainReport>;
  ownerLost(owner: PersistenceOwner): Promise<DrainReport>;
  recoverySnapshot(): PersistenceRecoverySnapshot;
  retry(recovery: Handle, action: CoreActionReference): Promise<DrainReport>;
  discard(recovery: Handle, action: CoreActionReference): Promise<DrainReport>;
}
```

- [ ] **Step 2: Write action provenance and dialog-lifetime tests**

Create `apps/desktop/src/main/plugins/persistence/actions.test.ts`:

```ts
import { expect, it, vi } from "vitest";
import { PersistenceFault } from "./record-port.js";
import type { ResourceOwner } from "@kobrixa/plugin-protocol";
import { createPersistenceActions, type ActionDependencies, type ExportDestination } from "./actions.js";
const owner: ResourceOwner = { sourceKey: "builtin:test.actions", pluginId: "test.actions", generation: 1,
  hostEpoch: "00000000-0000-4000-8000-000000000001", processEpoch: "00000000-0000-4000-8000-000000000002" };
const p = { kind: "plugin" as const, owner, authorityContext: null };
const actionRef = "00000000-0000-4000-8000-000000000003";
function fixture() {
  let now = 0, alive = true, used = false;
  let choose!: (value: ExportDestination | null) => void;
  const copyText = vi.fn(async () => {}), begin = vi.fn(async () => {});
  const deps: ActionDependencies = {
    now: () => now, wall: () => 100000 + now, live: () => alive, permission: () => true,
    actions: { claim: (context) => {
      if (context.actionRef !== actionRef || context.owner.generation !== 1 || now >= 5000 || used)
        return { ok: false, error: { code: "PLUGIN_E_PERMISSION_DENIED", message: "User action required.",
          detail: { kind: "permission", reason: "user-action-required" } } };
      used = true; return { ok: true, value: { action: actionRef } };
    } },
    adapter: { copyText, chooseDestination: () => new Promise((resolve) => { choose = resolve; }) },
    destinations: { register: async () => { throw new Error("Native registration is exercised by the worker test."); }, release: vi.fn(async () => {}) },
    output: { begin, append: async (_id, _offset, data) => data.length,
      commit: async () => ({ disposition: "committed", commitId: actionRef, durability: "file-sync-only" }),
      reconcile: async () => ({ disposition: "unknown" }), abort: async () => "aborted" },
  };
  return { service: createPersistenceActions(deps), deps, copyText, begin,
    advance: (ms: number) => { now += ms; }, die: () => { alive = false; }, choose: (value: ExportDestination | null) => choose(value) };
}
it("B2-RF4: fabricated, expired, foreign and invocation IDs never touch clipboard", async () => {
  for (const ref of ["invocation-id", "foreign", ""]) {
    const f = fixture();
    expect(await f.service.request(p, "ui/copyText", { actionRef: ref, text: "hello" }, new AbortController().signal))
      .toMatchObject({ ok: false }); expect(f.copyText).not.toHaveBeenCalled();
  }
  const f = fixture(); f.advance(5000);
  expect(await f.service.request(p, "ui/copyText", { actionRef, text: "hello" }, new AbortController().signal)).toMatchObject({ ok: false });
  expect(f.copyText).not.toHaveBeenCalled();
});
it("B2-RF4: one action cannot copy then export; text errors never disclose values", async () => {
  const f = fixture();
  expect(await f.service.request(p, "ui/copyText", { actionRef, text: "hello" }, new AbortController().signal))
    .toEqual({ ok: true, value: { copied: true } });
  expect(await f.service.request(p, "storage/exportBegin", { actionRef, suggestedName: "data",
    mediaType: "text/plain", byteLength: 0, sha256: "a".repeat(64) }, new AbortController().signal)).toMatchObject({ ok: false });
  expect(f.copyText).toHaveBeenCalledOnce(); expect(f.begin).not.toHaveBeenCalled();
});
it("B2-12.1-8: late dialog after window loss or 120 seconds cannot start I/O", async () => {
  for (const end of ["window", "deadline"] as const) {
    const f = fixture(); const r = await f.service.request(p, "storage/exportBegin", { actionRef, suggestedName: "data",
      mediaType: "text/plain", byteLength: 0, sha256: "a".repeat(64) }, new AbortController().signal);
    expect(r).toMatchObject({ ok: true, value: { state: "waiting" } });
    if (end === "window") f.die(); else f.advance(120000);
    f.choose(Object.freeze({}) as ExportDestination);
    await Promise.resolve(); await Promise.resolve();
    expect(f.begin).not.toHaveBeenCalled();
  }
});
it("B2-12.1-8: copy checks both UTF-8 bytes and code points, NUL and surrogates", async () => {
  for (const text of ["a".repeat(16385), "😀".repeat(16385), "\0", "\ud800"]) {
    const f = fixture();
    await expect(f.service.request(p, "ui/copyText", { actionRef, text }, new AbortController().signal)).rejects.toThrow();
    expect(f.copyText).not.toHaveBeenCalled();
  }
  const f = fixture();
  expect(await f.service.request(p, "ui/copyText", { actionRef, text: "😀".repeat(16384) }, new AbortController().signal))
    .toMatchObject({ ok: true });
  const g = fixture(); g.deps.adapter.copyText = async () => { throw new Error("/private/secret text"); };
  const failed = await g.service.request(p, "ui/copyText", { actionRef, text: "secret" }, new AbortController().signal);
  expect(failed).toMatchObject({ error: { detail: { reason: "clipboard-unavailable" } } });
  expect(JSON.stringify(failed)).not.toContain("secret");
});
it("B2-RF4: 8 MiB is admitted, larger payloads and path names cause no native operation", async () => {
  const maximum = fixture();
  expect(await maximum.service.request(p, "storage/exportBegin", { actionRef, suggestedName: "data.json",
    mediaType: "application/json", byteLength: 8388608, sha256: "a".repeat(64) }, new AbortController().signal)).toMatchObject({ ok: true });
  maximum.service.retire(owner);
  for (const suggestedName of ["../data", "C:data", "NUL", ".", "..", "\\server", " "] ) {
    const f = fixture();
    await expect(f.service.request(p, "storage/exportBegin", { actionRef, suggestedName,
      mediaType: "text/plain", byteLength: 0, sha256: "a".repeat(64) }, new AbortController().signal)).rejects.toThrow();
    expect(f.begin).not.toHaveBeenCalled();
  }
  const f = fixture();
  await expect(f.service.request(p, "storage/exportBegin", { actionRef, suggestedName: "data",
    mediaType: "text/plain", byteLength: 8388609, sha256: "a".repeat(64) }, new AbortController().signal)).rejects.toThrow();
  expect(f.begin).not.toHaveBeenCalled();
});
it("B2-12.1-8: independent exports have one source slot and four host slots", async () => {
  const f = fixture(); f.deps.actions.claim = () => ({ ok: true, value: { action: actionRef } });
  const begin = { actionRef, suggestedName: "data", mediaType: "text/plain" as const, byteLength: 0, sha256: "a".repeat(64) };
  const principals = [0, 1, 2, 3].map((n) => ({ ...p, owner: { ...owner, sourceKey: `builtin:test.export${n}` } }));
  for (const principal of principals)
    expect(await f.service.request(principal, "storage/exportBegin", begin, new AbortController().signal)).toMatchObject({ ok: true });
  expect(await f.service.request(principals[0]!, "storage/exportBegin", begin, new AbortController().signal))
    .toMatchObject({ error: { code: "PLUGIN_E_RESOURCE_LIMIT" } });
  expect(await f.service.request(p, "storage/exportBegin", begin, new AbortController().signal)).toMatchObject({ ok: false });
  for (const principal of principals) f.service.retire(principal.owner);
});
it("B2-RF4: destination identity failure is sanitized and cannot replace the file", async () => {
  const f = fixture(); const replacement = vi.fn();
  f.deps.output.commit = async () => { throw new PersistenceFault("PLUGIN_E_STORAGE_IO", "destination-changed"); };
  f.deps.output.reconcile = replacement;
  const begun = await f.service.request(p, "storage/exportBegin", { actionRef, suggestedName: "data",
    mediaType: "text/plain", byteLength: 0, sha256: "a".repeat(64) }, new AbortController().signal);
  if (!begun.ok) throw new Error("begin failed");
  f.choose(Object.freeze({}) as ExportDestination);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const result = await f.service.request(p, "storage/exportCommit", { export: begun.value.export }, new AbortController().signal);
  expect(result).toMatchObject({ error: { detail: { reason: "destination-changed" } } });
  expect(JSON.stringify(result)).not.toContain("path"); expect(replacement).not.toHaveBeenCalled();
});

```

Run RED:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/persistence/actions.test.ts
```

Expected: `createPersistenceActions` missing. No native dialogs run in this suite.

- [ ] **Step 3: Implement actions with separate export slots and opaque destinations**

Replace `apps/desktop/src/main/plugins/persistence/actions.ts`:

```ts
import { randomUUID } from "node:crypto";
import { RpcError, RPC_ERRORS } from "@kobrixa/plugin-protocol";
import type { Durability, Handle, Permission, PersistenceActionRequestMap, ResourceOwner, Sha256 } from "@kobrixa/plugin-protocol";
import type { Principal, UserPersistenceActionPort } from "@kobrixa/plugin-runtime";
import { decodeChunk, ownerKey, PersistenceFault, conflict, limit, stale } from "./record-port.js";
declare const exportDestinationBrand: unique symbol;
export type ExportDestination = { readonly [exportDestinationBrand]: true };
export interface PersistenceActionAdapter {
  chooseDestination(action: Handle, suggestedName: string, signal: AbortSignal): Promise<ExportDestination | null>;
  copyText(action: Handle, text: string): Promise<void>;
}
import type { PersistenceOutputPort, ExportDestinationRegistry, ExportOutcome } from "./engine-port.js";
type Outcome = ExportOutcome;
export type ActionDependencies = {
  now(): number; wall(): number; live(owner: ResourceOwner): boolean;
  permission(principal: Principal, permission: Permission): boolean;
  actions: UserPersistenceActionPort; adapter: PersistenceActionAdapter;
  output: PersistenceOutputPort;
  destinations: ExportDestinationRegistry;
};
type Job = { id: Handle; owner: ResourceOwner; state: "waiting" | "receiving" | "publishing" | "completed" | "cancelled" | "expired" | "failed";
  created: number; progress: number; deadline: number; length: number; received: number;
  destination?: ExportDestination;
  control: AbortController; result?: Outcome; last?: { offset: number; data: string; expiresAt: number };
  error?: { code: "PLUGIN_E_STORAGE_IO"; message: string }; pending: Promise<unknown>;
  timer?: ReturnType<typeof setTimeout> };
export function createPersistenceActions(deps: ActionDependencies) {
  const jobs = new Map<string, Job>();
  async function releaseKnown(job: Job) {
    if (!job.destination || !job.result || job.result.disposition === "unknown") return;
    await deps.destinations.release(job.destination); delete job.destination;
  }
  const active = (job: Job) => ["waiting", "receiving", "publishing"].includes(job.state);
  const expires = (job: Job) => job.state === "waiting" ? job.deadline : Math.min(job.deadline, job.progress + 30000);
  const wallExpiry = (job: Job) => Math.max(0, deps.wall() + expires(job) - deps.now());
  function gate(job: Job) {
    if (!deps.live(job.owner) || deps.now() >= expires(job) || job.control.signal.aborted) {
      if (job.state !== "publishing" && job.state !== "completed") job.state = "expired";
      job.control.abort(); stale("storage-export");
    }
  }
  function arm(job: Job) {
    clearTimeout(job.timer);
    if (!active(job) || job.state === "publishing") return;
    job.timer = setTimeout(() => {
      try { gate(job); arm(job); }
      catch { void deps.output.abort(job.id).catch(() => "unknown"); }
    }, Math.max(0, expires(job) - deps.now()));
    job.timer.unref();
  }
  const get = (owner: ResourceOwner, id: string) => {
    const job = jobs.get(id); if (!job || ownerKey(job.owner) !== ownerKey(owner)) stale("storage-export"); return job;
  };
  const safeName = (name: string, media: string) => {
    if (/[\uD800-\uDFFF]/u.test(name) || !name.length || [...name].length > 80 || Buffer.byteLength(name) > 320 ||
      /[\\/:\p{Cc}]/u.test(name) || /^(\.|\.\.|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
      throw new RpcError(RPC_ERRORS.invalidParams, "Invalid suggested name.");
    const ext = media === "application/json" ? "json" : media === "text/plain" ? "txt" : media === "text/csv" ? "csv" : "bin";
    const base = name.replace(/[. ]+$/u, "").replace(/\.[^.]+$/u, "");
    if (!base.trim()) throw new RpcError(RPC_ERRORS.invalidParams, "Invalid suggested name.");
    return `${base}.${ext}`;
  };
  type Handlers = { [M in keyof PersistenceActionRequestMap]: (owner: ResourceOwner,
    p: PersistenceActionRequestMap[M]["params"], signal: AbortSignal) => Promise<PersistenceActionRequestMap[M]["result"]> };
  const handlers: Handlers = {
    "ui/copyText": async (owner, p, signal) => {
      if (/[\uD800-\uDFFF]/u.test(p.text) || p.text.includes("\0") || [...p.text].length > 16384 || Buffer.byteLength(p.text) > 65536)
        throw new RpcError(RPC_ERRORS.invalidParams, "Invalid text size or encoding.");
      if (signal.aborted || !deps.live(owner)) stale("storage-export");
      const claim = deps.actions.claim({ owner, actionRef: p.actionRef }, "ui.clipboard");
      if (!claim.ok) return claim;
      try { await deps.adapter.copyText(claim.value.action, p.text); }
      catch { throw new PersistenceFault("PLUGIN_E_STORAGE_IO", "clipboard-unavailable"); }
      return { ok: true, value: { copied: true } };
    },
    "storage/exportBegin": async (owner, p, signal) => {
      const name = safeName(p.suggestedName, p.mediaType);
      if (p.byteLength < 0 || p.byteLength > 8388608 || !Number.isSafeInteger(p.byteLength))
        throw new RpcError(RPC_ERRORS.invalidParams, "Invalid export length.");
      if (signal.aborted || !deps.live(owner)) stale("storage-export");
      for (const job of jobs.values()) if (active(job) && job.state !== "publishing") {
        try { gate(job); } catch { void deps.output.abort(job.id).catch(() => "unknown"); }
      }
      const running = [...jobs.values()].filter(active);
      if (running.length >= 4 || running.some((j) => j.owner.sourceKey === owner.sourceKey) || jobs.size >= 1024 ||
        [...jobs.values()].filter((j) => j.owner.sourceKey === owner.sourceKey).length >= 64) limit("storage-export");
      const claim = deps.actions.claim({ owner, actionRef: p.actionRef }, "storage.export");
      if (!claim.ok) return claim;
      const now = deps.now(), id = randomUUID();
      const job: Job = { id, owner: { ...owner }, state: "waiting", created: now, progress: now,
        deadline: now + 120000, length: p.byteLength, received: 0, control: new AbortController(), pending: Promise.resolve() };
      jobs.set(id, job); arm(job);
      void deps.adapter.chooseDestination(claim.value.action, name, job.control.signal).then(async (destination) => {
        if (destination) job.destination = destination;
        gate(job);
        if (!destination) { job.state = "cancelled"; clearTimeout(job.timer); return; }
        job.progress = deps.now(); // Preserve the registered destination’s original deadline.
        await deps.output.begin(id, owner, destination, p.byteLength, p.sha256, job.deadline);
        gate(job); job.state = "receiving"; arm(job);
      }).catch(async () => {
        clearTimeout(job.timer);
        if (job.state !== "expired" && job.state !== "cancelled") {
          job.state = "failed"; job.error = { code: "PLUGIN_E_STORAGE_IO", message: "Export unavailable." };
        }
        const outcome = await deps.output.abort(id).catch(() => "unknown" as const);
        if (outcome !== "unknown" && job.destination) await deps.destinations.release(job.destination);
      });
      return { ok: true, value: { export: id, state: "waiting", expiresAt: wallExpiry(job) } };
    },
    "storage/exportChunk": async (owner, p) => {
      const job = get(owner, p.export); gate(job);
      if (job.state !== "receiving") conflict("export-not-ready");
      if (job.last?.offset === p.offset && job.last.data === p.data)
        return { ok: true, value: { receivedBytes: job.received, expiresAt: job.last.expiresAt } };
      if (p.offset !== job.received) conflict("offset-mismatch");
      const bytes = decodeChunk(p.data); if (job.received + bytes.length > job.length) conflict("incomplete");
      let offset = 0;
      while (offset < bytes.length) {
        gate(job); const written = await deps.output.append(job.id, job.received + offset, bytes.subarray(offset));
        if (written <= 0 || written > bytes.length - offset) throw new PersistenceFault("PLUGIN_E_STORAGE_IO", "io");
        offset += written;
      }
      job.received += bytes.length; job.progress = deps.now(); arm(job);
      const expiresAt = wallExpiry(job); job.last = { offset: p.offset, data: p.data, expiresAt };
      return { ok: true, value: { receivedBytes: job.received, expiresAt } };
    },
    "storage/exportCommit": async (owner, p) => {
      const job = get(owner, p.export);
      if (job.state === "publishing") { job.result = await deps.output.reconcile(job.id); await releaseKnown(job); }
      else if (job.state !== "completed") {
        gate(job); if (job.state !== "receiving") conflict("export-not-ready");
        if (job.received !== job.length) conflict("incomplete");
        job.state = "publishing"; clearTimeout(job.timer);
        try { job.result = await deps.output.commit(job.id); await releaseKnown(job); }
        catch (error) {
          if (error instanceof PersistenceFault && error.result.error.detail?.kind === "persistence" &&
            ["destination-changed", "checksum-mismatch"].includes(error.result.error.detail.reason)) {
            job.state = "failed"; await deps.output.abort(job.id); throw error;
          }
          const fault = new PersistenceFault("PLUGIN_E_STORAGE_IO", "publish-uncertain");
          fault.result.error.detail = { kind: "persistence", reason: "publish-uncertain", disposition: "unknown" };
          throw fault;
        }
      }
      if (job.result?.disposition === "not-committed") {
        job.state = "receiving"; arm(job); throw new PersistenceFault("PLUGIN_E_STORAGE_IO", "io");
      }
      if (job.result?.disposition !== "committed" || !job.result.commitId || !job.result.durability) {
        const fault = new PersistenceFault("PLUGIN_E_STORAGE_IO", "publish-uncertain");
        fault.result.error.detail = { kind: "persistence", reason: "publish-uncertain", disposition: "unknown" };
        throw fault;
      }
      job.state = "completed"; clearTimeout(job.timer);
      return { ok: true, value: { exported: true, commitId: job.result.commitId, durability: job.result.durability } };
    },
    "storage/exportStatus": async (owner, p) => {
      const job = get(owner, p.export);
      if (active(job) && job.state !== "publishing") { try { gate(job); } catch { await deps.output.abort(job.id); } }
      if (job.state === "publishing") {
        job.result = await deps.output.reconcile(job.id); await releaseKnown(job);
        if (job.result.disposition === "committed") { job.state = "completed"; clearTimeout(job.timer); }
        else if (job.result.disposition === "not-committed") { job.state = "failed"; clearTimeout(job.timer); }
      }
      return { ok: true, value: { state: job.state, receivedBytes: job.received, expiresAt: wallExpiry(job),
        ...(job.result?.commitId ? { commitId: job.result.commitId } : {}),
        ...(job.result?.durability ? { durability: job.result.durability } : {}), ...(job.error ? { error: job.error } : {}) } };
    },
    "storage/exportCancel": async (owner, p) => {
      const job = get(owner, p.export); job.control.abort(); clearTimeout(job.timer);
      const disposition = job.state === "completed" ? "committed" : await deps.output.abort(job.id);
      job.state = disposition === "aborted" ? "cancelled" : disposition === "committed" ? "completed" : "publishing";
      if (disposition !== "unknown" && job.destination) {
        await deps.destinations.release(job.destination); delete job.destination;
      }
      return { ok: true, value: { disposition, ...(job.result?.commitId ? { commitId: job.result.commitId } : {}) } };
    },
  };
  return {
    async request<M extends keyof PersistenceActionRequestMap>(principal: Principal, method: M,
      params: PersistenceActionRequestMap[M]["params"], signal: AbortSignal): Promise<PersistenceActionRequestMap[M]["result"]> {
      if (principal.kind !== "plugin" || !deps.permission(principal, method === "ui/copyText" ? "ui.clipboard" : "storage.export"))
        return { ok: false, error: { code: "PLUGIN_E_PERMISSION_DENIED", message: "Permission required.", detail: { kind: "permission", reason: "permission" } } };
      for (const [id, job] of jobs) if (!active(job) && deps.now() >= job.deadline + 120000) jobs.delete(id);
      const run = async () => {
        try { return await handlers[method](principal.owner, params, signal); }
        catch (error) { if (error instanceof RpcError) throw error;
          return error instanceof PersistenceFault ? error.result : new PersistenceFault("PLUGIN_E_STORAGE_IO", "io").result; }
      };
      if ("export" in params && typeof params.export === "string") {
        const job = jobs.get(params.export);
        if (job) { const next = job.pending.catch(() => {}).then(run); job.pending = next; return next; }
      }
      return run();
    },
    retire(owner: ResourceOwner) {
      for (const job of jobs.values()) if (ownerKey(job.owner) === ownerKey(owner) && active(job)) {
        job.control.abort(); clearTimeout(job.timer);
        if (job.state !== "publishing") { job.state = "expired"; void deps.output.abort(job.id).catch(() => "unknown"); }
      }
    },
  };
}
```

- [ ] **Step 3a: Connect the registered native destination and test its identity**

D170 owns the main native-dialog closure; hand it this sequence without editing H-D: resolve the already-claimed action to its trusted scope and original deadline, invoke the native save dialog, recheck scope/cancellation/deadline after it returns, then call `backend.destinations.register({action,scope,nativePath,deadlineMonotonicMs})`. Return only the branded destination. A late result releases any registered destination before returning null. Feature export uses its claimed feature correlation; core export uses `action.actionToken`. Never put nativePath in a renderer result or worker-independent object cast.

Store the destination on each export job. All abort/expiry/dispose paths await `output.abort(id)` and release only on `aborted` or `committed`; an unknown result keeps job/identity/temp evidence. On original-job reconcile returning a known disposition, release once. A rejected begin before mutation releases registration. Do not renew the registry deadline when the dialog returns: use its original bounded action continuation deadline for begin and all chunks.

Add worker-backed cases to actions.test.ts and recovery-port.test.ts at P170, using T2 `startPersistenceWorker` with the private fault controller and a temporary output directory, not a cast destination:

| Case | Required assertion |
| --- | --- |
| Cancel or scope retirement while dialog waits | No register/begin/clipboard mutation; a late registration is released. |
| Replace target or symlink parent after register | Commit rejects changed identity; original destination bytes/hash remain unchanged. |
| Unsupported atomic replacement filesystem | No replacement or truncated destination; sanitized failure contains no native path. |
| Kill before replacement / after replacement before reply | First case is not-committed; second is unknown until original-job reconciliation. Never call begin/publish again for the same action. |
| Committed record export | Pin exact revision, stream ≤256 KiB chunks, verify destination hash and release pin/registration on known completion. |
| Complete sealed recovery export | Use validated stored sealedPin/ticket before original TTL; no process launch and no full 8-MiB main buffer. |
| Checkpoint-only with no committed bytes | No payload invention or native write; stale option/replayed core action rejected. |

The `output` callbacks are host-only worker operations: `begin` reserves the full export byte length in the shared logical quota but an independent source 1/host 4 export slot; `commit` verifies full hash, syncs and checks destination identity immediately before same-directory atomic replacement. AM-25 freezes these operations in T2 engine-port.ts; consume `backend.output` and `backend.destinations` directly. Do not implement them using a record create/delete or cast ExportDestination to StorePath. Native dialogs and actual clipboard tests are **controller runs outside sandbox**.

Run GREEN for this implementation before starting the next slice:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/persistence/actions.test.ts
```

Expected: all action provenance, size, slot and late-dialog tests pass. These are constructor-double results; the final task commit below includes this slice.

- [ ] **Step 4: Write lifecycle race tests**

Create `apps/desktop/src/main/plugins/persistence/lifecycle.test.ts`:

```ts
import { expect, it, vi } from "vitest";
import type { RecordMeta, RecordWrite, ResourceOwner } from "@kobrixa/plugin-protocol";
import type { ReservationEnded } from "@kobrixa/plugin-runtime";
import { createPersistenceLifecycle, type LifecycleDependencies } from "./lifecycle.js";
const owner: ResourceOwner = { sourceKey: "builtin:test.drain", pluginId: "test.drain", generation: 1,
  hostEpoch: "00000000-0000-4000-8000-000000000001", processEpoch: "00000000-0000-4000-8000-000000000002" };
const record: RecordMeta = { id: "00000000-0000-4000-8000-000000000003", revision: `r_${"1".repeat(32)}`,
  kind: "test.record", schemaVersion: 1, label: "Data", mediaType: "text/plain", byteLength: 0,
  sha256: "a".repeat(64), createdAt: 0, updatedAt: 0, checkpoint: "none", interrupted: false };
const reservation = "00000000-0000-4000-8000-000000000004";
const event: ReservationEnded = { owner, reservationId: reservation,
  sessionId: "00000000-0000-4000-8000-000000000005", providerGeneration: 1,
  reason: "released", lastSequence: 9, endedMonotonicMs: 100,
  drain: { owner, reservationId: reservation, lastSequence: 9, expiresMonotonicMs: 10100 } };
function fixture() {
  let now = 0, active = true, final = false;
  const targetFence = vi.fn(() => []), ownerFence = vi.fn(() => []);
  const deps: LifecycleDependencies = {
    now: () => now, wall: () => 100000 + now, live: () => true,
    reservations: { validate: () => active ? { owner, reservationId: reservation,
      sessionId: event.sessionId, providerGeneration: 1 } : null, onEnded: () => { throw new Error("second listener"); } },
    record: async () => record, persist: async () => {}, fence: ownerFence, fenceTarget: targetFence,
    pendingWrites: () => [], pendingSettings: () => false,
    settle: async () => {}, evidence: evidenceDouble(),
    reads: { stat: async () => ({ ...record, checkpoint: final ? "final" : "open" }) },
    payload: () => ({ kind: "checkpoint-only" }),
    recover: async (_owner, report) => report,
    checkpointOpen: () => false,
    recovery: { recoverySnapshot: () => ({ revision: 0, items: [] }),
      retry: async () => ({ state: "checkpoint-only", blocker: true, pendingSettings: false, records: [], errors: [] }),
      discard: async () => ({ state: "checkpoint-only", blocker: false, pendingSettings: false, records: [], errors: [] }) },
  };
  const life = createPersistenceLifecycle(deps);
  return { life, deps, targetFence, ownerFence, end: () => { active = false; now = 100; },
    setFinal: () => { final = true; }, advance: (ms: number) => { now += ms; } };
}
it("B2-RF3: registration awaiting durable evidence is included in first end and cannot ack active", async () => {
  const f = fixture(); let release!: () => void;
  f.deps.persist = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
  const registering = f.life.register(owner, { id: record.id, expectedRevision: record.revision, reservation });
  await Promise.resolve(); await Promise.resolve();
  f.end(); const offer = f.life.participant.endReservation(event, 20000);
  expect(offer?.checkpoints).toHaveLength(1);
  expect(offer?.deadlineMonotonicMs).toBe(10100);
  release();
  expect(await registering).toMatchObject({ error: { code: "PLUGIN_E_STALE_RESOURCE" } });
  expect(f.ownerFence).not.toHaveBeenCalled(); expect(f.targetFence).toHaveBeenCalledOnce();
});
it("B2-RF3: duplicate end and retirement keep token/deadline and dispatch each target once", async () => {
  const f = fixture(); await f.life.register(owner, { id: record.id, expectedRevision: record.revision, reservation });
  f.end(); const first = f.life.participant.endReservation(event, 20000)!;
  const repeated = f.life.participant.endReservation(event, 30000)!;
  const retired = f.life.participant.freeze(owner, "disable", 9000, event.drain!);
  expect(repeated.token).toBe(first.token); expect(retired.token).toBe(first.token);
  expect(retired.deadlineMonotonicMs).toBe(9000);
  const dispatch = vi.fn(async () => { f.setFinal(); return { ok: true as const,
    value: { status: "submitted" as const, writes: [] } }; });
  const [a, b] = await Promise.all([f.life.participant.drain(first, dispatch), f.life.participant.drain(retired, dispatch)]);
  expect(dispatch).toHaveBeenCalledOnce(); expect(a.state).toBe("saved"); expect(b.state).toBe("saved");
});
it("B2-12.1-6: submitted is not saved; null grant goes ownerLost without callback", async () => {
  const f = fixture(); await f.life.register(owner, { id: record.id, expectedRevision: record.revision, reservation });
  f.end(); const offer = f.life.participant.endReservation({ ...event, drain: null }, 10100)!;
  expect(offer).not.toBeNull();
  const report = await f.life.participant.ownerLost(owner);
  expect(report).toMatchObject({ state: "checkpoint-only", blocker: true });
  const g = fixture(); await g.life.register(owner, { id: record.id, expectedRevision: record.revision });
  const frozen = g.life.participant.freeze(owner, "shutdown", 10000);
  expect(await g.life.participant.drain(frozen, async () => ({ ok: true, value: { status: "submitted", writes: [] } })))
    .toMatchObject({ state: "checkpoint-only", blocker: true });
});
it("B2-12.1-6: target end preserves other ordinary work; foreign/new generation tokens fail", async () => {
  const f = fixture(); await f.life.register(owner, { id: record.id, expectedRevision: record.revision, reservation });
  f.end(); const offer = f.life.participant.endReservation(event, 10100)!;
  const write = { target: { mode: "replace" as const, id: record.id, expectedRevision: record.revision },
    kind: record.kind, schemaVersion: 1, label: "", mediaType: record.mediaType, byteLength: 0, sha256: record.sha256 };
  expect(() => f.life.authorize(owner, write)).toThrow();
  expect(f.life.authorize(owner, { ...write, target: { mode: "create" } })).toBe("none");
  expect(() => f.life.authorize({ ...owner, generation: 2 }, { ...write, drainToken: offer.token })).toThrow();
  f.advance(10000);
  expect(() => f.life.authorize(owner, { ...write, drainToken: offer.token })).toThrow();
});
it("B2-RF3: a shorter concurrent freeze rearms the already-running drain", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(); await f.life.register(owner, { id: record.id, expectedRevision: record.revision });
    const offer = f.life.participant.freeze(owner, "shutdown", 10000);
    const dispatch = vi.fn(() => new Promise<never>(() => {}));
    const draining = f.life.participant.drain(offer, dispatch);
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).toHaveBeenCalledOnce();
    f.advance(100); await vi.advanceTimersByTimeAsync(100);
    const earlier = f.life.participant.freeze(owner, "renderer-crash", 500);
    expect(earlier.token).toBe(offer.token);
    f.advance(400); await vi.advanceTimersByTimeAsync(400);
    expect(await draining).toMatchObject({ blocker: true });
    expect(dispatch).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});
it("B2-RF3: target-only scope excludes unrelated settings and final authorization cannot repeat", async () => {
  const f = fixture(); const registered = await f.life.register(owner, { id: record.id,
    expectedRevision: record.revision, reservation });
  if (!registered.ok) throw new Error("registration failed");
  f.deps.pendingSettings = () => true; f.deps.evidence.capture = vi.fn(f.deps.evidence.capture);
  f.end(); const offer = f.life.participant.endReservation(event, 10100)!;
  const write: RecordWrite = { target: { mode: "replace", id: record.id, expectedRevision: record.revision },
    kind: record.kind, schemaVersion: 1, label: "", mediaType: record.mediaType, byteLength: 0, sha256: record.sha256,
    checkpoint: { handle: registered.value.checkpoint, phase: "final" }, drainToken: offer.token };
  expect(f.life.authorize(owner, write)).toBe("final");
  f.life.committed(owner, write, { ...record, checkpoint: "final" }); f.setFinal();
  expect(() => f.life.authorize(owner, write)).toThrow();
  const report = await f.life.participant.drain(offer, async () => ({ ok: true, value: { status: "submitted", writes: [] } }));
  expect(report).toMatchObject({ state: "saved", pendingSettings: false });
  expect(f.deps.evidence.capture).toHaveBeenCalledWith({ kind: "target", owner, recordId: record.id }, 10100);
  expect(f.deps.evidence.capture).not.toHaveBeenCalledWith({ kind: "namespace", owner }, expect.anything());
});

```

Run RED:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/persistence/lifecycle.test.ts
```

Expected: missing lifecycle implementation. Do not add a second reservation listener to make the test pass.

- [ ] **Step 5: Implement synchronous fences and idempotent final drains**

Create `apps/desktop/src/main/plugins/persistence/lifecycle.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { DrainReason, DrainRequest, RecordMeta, RecordWrite, ResourceOwner, StorageRequestMap } from "@kobrixa/plugin-protocol";
import type { DeviceDrainGrant, DrainDispatcher, DrainOffer, DrainReport, PersistenceParticipant,
  ReservationBinding, ReservationBindingPort, ReservationEnded } from "@kobrixa/plugin-runtime";
import { ownerKey, PersistenceFault, conflict, stale } from "./record-port.js";
import type { PersistenceEvidencePort, PersistenceReadPort, PersistenceBarrier, PersistenceScope } from "./engine-port.js";
export type LifecycleDependencies = {
  now(): number; wall(): number; live(owner: ResourceOwner): boolean;
  reservations: ReservationBindingPort;
  record(owner: ResourceOwner, id: string): Promise<RecordMeta>;
  persist(owner: ResourceOwner, input: { checkpoint: string; record: RecordMeta; binding?: ReservationBinding;
    state: "open" | "final" | "interrupted" }): Promise<void>;
  fence(owner: ResourceOwner, deadline: number): readonly string[];
  fenceTarget(owner: ResourceOwner, id: string, deadline: number): readonly string[];
  pendingWrites(owner: ResourceOwner): DrainRequest["writes"];
  pendingSettings(owner: ResourceOwner): boolean;
  settle(tickets: readonly string[], deadline: number): Promise<void>;
  evidence: PersistenceEvidencePort;
  reads: Pick<PersistenceReadPort, "stat">;
  payload(owner: ResourceOwner, id: string): { kind: "complete-staging" | "checkpoint-only" | "none"; expiresMonotonicMs?: number };
  recover(owner: ResourceOwner, report: DrainReport): Promise<DrainReport>;
  checkpointOpen(owner: ResourceOwner, id: string): boolean;
  recovery: Pick<PersistenceParticipant, "recoverySnapshot" | "retry" | "discard">;
};
type Entry = { owner: ResourceOwner; id: string; handle: string; reservation?: string; binding?: ReservationBinding; record?: RecordMeta;
  ready: Promise<void>; ended?: ReservationEnded; final: boolean; failed: boolean };
type Group = { owner: ResourceOwner; reason: DrainReason; token: string; deadline: number;
  entries: Set<Entry>; tickets: Set<string>; sent: Set<string>; retired: boolean;
  grant?: DeviceDrainGrant; run?: Promise<DrainReport>; control: AbortController;
  rearm?: () => void; callbackAllowed: boolean; barriers: PersistenceBarrier[] };
export function createPersistenceLifecycle(deps: LifecycleDependencies) {
  const entries = new Map<string, Entry>();
  const groups = new Map<string, Group>();
  const retired = new Set<string>();
  const key = (owner: ResourceOwner, id: string) => JSON.stringify([ownerKey(owner), id]);
  const mine = (owner: ResourceOwner) => [...entries.values()].filter((entry) => ownerKey(entry.owner) === ownerKey(owner) && !entry.final);
  function group(owner: ResourceOwner, reason: DrainReason, deadline: number) {
    const identity = ownerKey(owner);
    let value = groups.get(identity);
    if (value && !value.retired && !value.run && [...value.entries].every((e) => e.final)) {
      groups.delete(identity); value = undefined;
    }
    if (!value) {
      value = { owner: Object.freeze({ ...owner }), reason, token: randomUUID(),
        deadline: Math.min(deadline, deps.now() + 10000), entries: new Set(), tickets: new Set(),
        sent: new Set(), retired: false, control: new AbortController(), callbackAllowed: true, barriers: [] };
      groups.set(identity, value);
    }
    value.deadline = Math.min(value.deadline, deadline); value.rearm?.();
    return value;
  }
  function snapshot(value: Group): DrainOffer {
    return Object.freeze({ owner: value.owner, reason: value.reason, token: value.token,
      deadlineMonotonicMs: value.deadline,
      checkpoints: Object.freeze([...value.entries].filter((e) => e.record && !e.final).map((e) => ({
        checkpoint: e.handle, record: structuredClone(e.record!), ...(e.ended ? { reservationEnd: {
          reservationId: e.ended.reservationId, reason: e.ended.reason, lastSequence: e.ended.lastSequence,
        } } : {}),
      }))),
      writes: Object.freeze(deps.pendingWrites(value.owner).filter((write) => value.retired ||
        [...value.entries].some((entry) => entry.id === write.id))), acceptedTickets: Object.freeze([...value.tickets]),
    });
  }
  async function register(owner: ResourceOwner, input: StorageRequestMap["storage/registerCheckpoint"]["params"]):
    Promise<StorageRequestMap["storage/registerCheckpoint"]["result"]> {
    if (!deps.live(owner) || retired.has(ownerKey(owner))) return new PersistenceFault("PLUGIN_E_STALE_RESOURCE").result;
    if ([...entries.values()].filter((entry) => entry.owner.sourceKey === owner.sourceKey && !entry.final).length >= 2) return new PersistenceFault("PLUGIN_E_RESOURCE_LIMIT").result;
    if (entries.has(key(owner, input.id))) return new PersistenceFault("PLUGIN_E_STORAGE_CONFLICT", "write-in-progress").result;
    const binding = input.reservation ? deps.reservations.validate(owner, input.reservation) : null;
    if (input.reservation && !binding) return new PersistenceFault("PLUGIN_E_STALE_RESOURCE").result;
    let resolve!: () => void;
    const entry: Entry = { owner: { ...owner }, id: input.id, handle: randomUUID(),
      ...(input.reservation ? { reservation: input.reservation } : {}),
      ...(binding ? { binding: structuredClone(binding) } : {}),
      ready: new Promise<void>((done) => { resolve = done; }), final: false, failed: false };
    entries.set(key(owner, input.id), entry);
    try {
      const record = await deps.record(owner, input.id); entry.record = record;
      if (record.revision !== input.expectedRevision) conflict("revision-mismatch");
      if (record.checkpoint === "final" || record.interrupted) conflict("write-in-progress");
      await deps.persist(owner, { checkpoint: entry.handle, record,
        ...(binding ? { binding: structuredClone(binding) } : {}), state: "open" });
      if (entry.ended || retired.has(ownerKey(owner)) || !deps.live(owner) ||
        (input.reservation && !deps.reservations.validate(owner, input.reservation))) stale();
      return { ok: true, value: { checkpoint: entry.handle } };
    } catch (error) {
      if (!entry.ended && !retired.has(ownerKey(owner))) { entry.failed = true; entries.delete(key(owner, input.id)); }
      return error instanceof PersistenceFault ? error.result : new PersistenceFault("PLUGIN_E_STORAGE_IO", "io").result;
    } finally { resolve(); }
  }
  function authorize(owner: ResourceOwner, input: RecordWrite, token = input.drainToken): RecordMeta["checkpoint"] {
    const value = groups.get(ownerKey(owner));
    const target = input.target.mode === "replace" ? entries.get(key(owner, input.target.id)) : undefined;
    if (token) {
      if (!value || value.token !== token || deps.now() >= value.deadline || input.target.mode !== "replace" ||
        !target || !value.entries.has(target) || target.final || !input.checkpoint ||
        input.checkpoint.handle !== target.handle || input.checkpoint.phase !== "final") stale();
      return "final";
    }
    if (retired.has(ownerKey(owner)) || !deps.live(owner) || (target && value?.entries.has(target))) stale();
    if (input.checkpoint) {
      if (!target || target.handle !== input.checkpoint.handle || target.final || target.failed) stale();
      if (input.checkpoint.phase === "final" && target.reservation && deps.reservations.validate(owner, target.reservation)) conflict("write-in-progress");
      return input.checkpoint.phase === "final" ? "final" : "open";
    }
    if (target) conflict("write-in-progress");
    return "none";
  }
  async function bounded<T>(value: Group, action: Promise<T>, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([action.catch(() => fallback), new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), Math.max(0, value.deadline - deps.now()));
    })]); } finally { clearTimeout(timer); }
  }
  async function report(value: Group): Promise<DrainReport> {
    const records: DrainReport["records"] = [];
    let uncertain = false;
    for (const entry of value.entries) {
      if (entry.failed) continue;
      let evidence: RecordMeta | undefined;
      evidence = await bounded<RecordMeta | undefined>(value, deps.reads.stat(value.owner, entry.id), undefined);
      if (!evidence) uncertain = true;
      const final = evidence?.checkpoint === "final";
      entry.final ||= final;
      const held = deps.payload(value.owner, entry.id);
      const complete = held.kind === "complete-staging" && held.expiresMonotonicMs !== undefined && deps.now() < held.expiresMonotonicMs;
      records.push({ id: entry.id, committedRevision: evidence?.revision ?? null, final,
        payload: complete ? "complete-staging" : evidence ? "checkpoint-only" : "none",
        ...(complete ? { expiresAt: deps.wall() + held.expiresMonotonicMs! - deps.now() } : {}) });
    }
    const pendingSettings = value.retired && deps.pendingSettings(value.owner);
    // Capture final grant-scoped submissions synchronously before awaiting any flush.
    const scopes: PersistenceScope[] = value.retired ? [{ kind: "namespace", owner: value.owner }]
      : [...value.entries].map(entry => ({ kind: "target", owner: value.owner, recordId: entry.id }));
    const finalBarriers = scopes.map(scope => deps.evidence.capture(scope, value.deadline));
    const outcomes = await bounded(value, Promise.all([...value.barriers, ...finalBarriers]
      .map(barrier => deps.evidence.flush(barrier))), []);
    const flushed = outcomes.length === value.barriers.length + finalBarriers.length &&
      outcomes.every(result => result.state === "saved" && !result.incomplete.length && !result.unknown.length);
    const saved = !uncertain && !pendingSettings && records.every((r) => r.final) && flushed;
    const state: DrainReport["state"] = saved ? "saved" : uncertain || pendingSettings ? "uncertain"
      : records.some((r) => r.payload === "complete-staging") ? "retryable" : "checkpoint-only";
    const result: DrainReport = { state, blocker: !saved, pendingSettings, records, errors: [] };
    return saved ? result : deps.recover(value.owner, result);
  }
  async function run(value: Group, dispatch?: DrainDispatcher) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<void>((resolve) => {
      value.rearm = () => {
        if (timedOut) return;
        clearTimeout(timer);
        timer = setTimeout(() => { timedOut = true; value.control.abort(); resolve(); }, Math.max(0, value.deadline - deps.now()));
      };
      value.rearm();
    });
    const work = async () => {
      for (;;) {
        await Promise.all([...value.entries].map((entry) => entry.ready));
        await deps.settle([...value.tickets], value.deadline);
        const pending = [...value.entries].filter((e) => !e.final && !e.failed && !value.sent.has(e.handle));
        if (!pending.length || !dispatch || !value.callbackAllowed || !deps.live(value.owner) || value.control.signal.aborted || deps.now() >= value.deadline) break;
        for (const entry of pending) value.sent.add(entry.handle);
        const request = snapshot(value);
        await dispatch(value.owner, { token: value.token, reason: value.reason,
          remainingMs: Math.max(0, Math.min(10000, value.deadline - deps.now())),
          checkpoints: request.checkpoints.filter((e) => pending.some((p) => p.handle === e.checkpoint)),
          writes: [...request.writes] }, value.control.signal).catch(() => undefined);
        // A dispatch reply is only submission evidence. report() checks committed heads and the barrier.
      }
    };
    try { await Promise.race([work().catch(() => undefined), timeout]); return await report(value); }
    finally { clearTimeout(timer); delete value.rearm; }
  }
  const unavailable = (): DrainReport => ({ state: "uncertain", blocker: true, pendingSettings: false,
    records: [], errors: [{ code: "PLUGIN_E_STORAGE_IO", message: "Drain offer unavailable." }] });
  const participant: PersistenceParticipant = {
    endReservation(event, deadline) {
      const targets = mine(event.owner).filter((entry) => entry.reservation === event.reservationId &&
        entry.binding?.sessionId === event.sessionId && entry.binding.providerGeneration === event.providerGeneration);
      if (!targets.length) return null;
      const value = group(event.owner, "reservation-ended", Math.min(deadline,
        event.endedMonotonicMs + 10000, event.drain?.expiresMonotonicMs ?? Infinity));
      if (event.drain) value.grant = event.drain;
      else value.callbackAllowed = false;
      for (const entry of targets) {
        if (!entry.ended) {
          entry.ended = event;
          const barrier = deps.evidence.capture({ kind: "target", owner: event.owner, recordId: entry.id }, value.deadline);
          value.barriers.push(barrier);
          for (const ticket of deps.evidence.tickets(barrier)) value.tickets.add(ticket.id);
          for (const ticket of deps.fenceTarget(event.owner, entry.id, value.deadline)) value.tickets.add(ticket);
        }
        value.entries.add(entry);
      }
      return snapshot(value);
    },
    freeze(owner, reason, deadline, deviceDrain) {
      if (reason === "reservation-ended") throw new Error("Target ends do not retire owners.");
      if (deviceDrain && ownerKey(deviceDrain.owner) !== ownerKey(owner)) stale();
      retired.add(ownerKey(owner));
      const value = group(owner, reason, Math.min(deadline, deviceDrain?.expiresMonotonicMs ?? Infinity));
      value.retired = true; value.reason = reason;
      if (deviceDrain) value.grant = deviceDrain;
      for (const entry of mine(owner)) value.entries.add(entry);
      for (const ticket of deps.fence(owner, value.deadline)) value.tickets.add(ticket);
      const barrier = deps.evidence.capture({ kind: "namespace", owner }, value.deadline);
      value.barriers.push(barrier);
      for (const ticket of deps.evidence.tickets(barrier)) value.tickets.add(ticket.id);
      return snapshot(value);
    },
    drain(offer, dispatch) {
      const value = groups.get(ownerKey(offer.owner));
      if (!value || value.token !== offer.token) return Promise.resolve(unavailable());
      value.deadline = Math.min(value.deadline, offer.deadlineMonotonicMs); value.rearm?.();
      if (!value.run) value.run = run(value, dispatch).finally(() => { delete value.run; });
      return value.run;
    },
    async ownerLost(owner) {
      const value = group(owner, "disable", deps.now()); retired.add(ownerKey(owner)); value.retired = true;
      for (const entry of mine(owner)) value.entries.add(entry);
      for (const ticket of deps.fence(owner, value.deadline)) value.tickets.add(ticket);
      const barrier = deps.evidence.capture({ kind: "namespace", owner }, value.deadline);
      value.barriers.push(barrier);
      for (const ticket of deps.evidence.tickets(barrier)) value.tickets.add(ticket.id);
      value.callbackAllowed = false; value.control.abort();
      if (!value.run) value.run = run(value).finally(() => { delete value.run; });
      return value.run;
    },
    recoverySnapshot: () => deps.recovery.recoverySnapshot(),
    retry: (id, action) => deps.recovery.retry(id, action),
    discard: (id, action) => deps.recovery.discard(id, action),
  };
  return { participant, register, authorize,
    open: (owner: ResourceOwner) => mine(owner).length !== 0,
    committed(owner: ResourceOwner, input: RecordWrite, record: RecordMeta) {
      if (!input.checkpoint || input.target.mode !== "replace") return;
      const entry = entries.get(key(owner, input.target.id));
      if (!entry || entry.handle !== input.checkpoint.handle) return;
      entry.record = record;
      if (record.checkpoint === "final") {
        entry.final = true;
        void deps.persist(owner, { checkpoint: entry.handle, record, state: "final" }).catch(() => {});
      }
    },
    async abandon(owner: ResourceOwner, input: { checkpoint: string }): Promise<StorageRequestMap["storage/abandonCheckpoint"]["result"]> {
      const entry = mine(owner).find((e) => e.handle === input.checkpoint);
      if (!entry || !entry.record) return new PersistenceFault("PLUGIN_E_STALE_RESOURCE").result;
      if (deps.checkpointOpen(owner, entry.id) || (entry.reservation && deps.reservations.validate(owner, entry.reservation)))
        return new PersistenceFault("PLUGIN_E_STORAGE_CONFLICT", "write-in-progress").result;
      const record = { ...entry.record, interrupted: true };
      await deps.persist(owner, { checkpoint: entry.handle, record, state: "interrupted" });
      entries.delete(key(owner, entry.id));
      return { ok: true, value: { record } };
    },
  };
}
```

The registry stores registration intent before its first await. `endReservation` sees pending intent and returns a non-null offer even while metadata/durable registration is unresolved; drain waits on the original readiness promise. It never acknowledges an ended binding as active. Only matching final heads and successful barriers permit `saved`. Target-only barriers use `PersistenceEvidencePort` with one target scope per record. Capture and ticket inspection run before the first await; namespace capture includes settings/import admissions, target capture excludes them. Final grant submissions receive a second capture within the same original deadline. An earlier incomplete barrier is re-evaluated against committed evidence, never interpreted as saved merely because a callback returned.

Run GREEN for this implementation before starting the next slice:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/persistence/lifecycle.test.ts
```

Expected: all registration, target-fence, deadline, idempotency and submitted-not-saved tests pass. These are constructor-double results; the final task commit below includes this slice.

- [ ] **Step 6: Write retained-recovery tests and implementation**

Create `apps/desktop/src/main/plugins/persistence/recovery-port.test.ts`:

```ts
import { expect, it, vi } from "vitest";
import type { DrainReport } from "@kobrixa/plugin-runtime";
import { createPersistenceRecovery } from "./recovery-port.js";
import { createFoundationFixture } from "../../../../../../../tests/desktop/plugin-persistence-main.js";
import type { PersistenceBackend, StoredRecovery } from "./engine-port.js";
function recoveryBackendDouble(): PersistenceBackend {
  const rows = new Map<string, StoredRecovery>();
  const fail = () => { throw new Error("Unexpected I/O in retention-only unit test."); };
  return {
    engine: { reserve: fail, append: fail, seal: fail, publish: fail, reconcile: fail,
      abort: fail, fence: fail, fenceTarget: fail },
    reads: { settings: fail, stat: fail, list: fail, open: fail, read: fail, close: fail },
    evidence: { capture: fail, flush: fail, tickets: fail, quota: fail, settingsDigest: fail,
      auxiliary: fail, auxiliaryKeys: fail,
      recoveryPage: async () => ({ items: [...rows.values()], nextCursor: null }),
      loadRecovery: async id => rows.get(id) ?? null,
      saveRecovery: async row => { rows.set(row.id, structuredClone(row)); },
      removeRecovery: async id => { rows.delete(id); } },
    imports: { load: fail, plan: fail, tagImport: fail, importReceipts: fail, record: fail,
      reconcile: fail, complete: fail },
    output: { begin: fail, append: fail, commit: fail, reconcile: fail, abort: fail },
    destinations: { register: fail, release: fail },
    sources: { register: fail, map: fail, appendMapped: fail, releaseMapped: fail, inventory: fail, read: fail },
    dispose: async () => {},
  };
}
const owner = { sourceKey: "builtin:test.recovery", pluginId: "test.recovery", generation: 1, hostEpoch: "h", processEpoch: "p" };
const action = { actionToken: "action", scope: { hostEpoch: "h", workbenchInstance: "window" } };
const report: DrainReport = { state: "retryable", blocker: true, pendingSettings: false,
  records: [{ id: "record", committedRevision: null, final: false, payload: "complete-staging", expiresAt: 130000 }], errors: [] };
it("B2-RF3: failed retry never extends the original 30-second retention", async () => {
  let now = 0;
  const retry = vi.fn(async () => report);
  const recovery = createPersistenceRecovery({ now: () => now, wall: () => 100000 + now,
    actions: { claim: () => true, isClaimed: () => true, complete: () => {} },
    retry, discard: async () => ({ ...report, state: "checkpoint-only", blocker: false }),
    backend: recoveryBackendDouble(), adapter: { chooseDestination: async () => null, copyText: async () => {} } });
  const saved = await recovery.retain(owner, report);
  const id = saved.recovery!;
  now = 20000; await recovery.retry(id, action);
  expect(recovery.recoverySnapshot().items[0]!.expiresAt).toBe(130000);
  now = 30000;
  expect(recovery.recoverySnapshot().items[0]).toMatchObject({ state: "checkpoint-only", payload: "none" });
  expect(recovery.recoverySnapshot().items[0]!.actions.map((x) => x.kind)).not.toContain("retry");
  await expect(recovery.retry(id, action)).rejects.toThrow();
  expect(retry).toHaveBeenCalledOnce();
});
it("B2-RF4/U16: core actions must match the item and cannot reuse feature proofs", async () => {
  const retry = vi.fn(async () => report), discard = vi.fn(async () => report);
  const recovery = createPersistenceRecovery({ now: () => 0, wall: () => 100000,
    actions: { claim: () => false, isClaimed: () => false, complete: () => {} }, retry, discard,
    backend: recoveryBackendDouble(), adapter: { chooseDestination: async () => null, copyText: async () => {} } });
  const id = (await recovery.retain(owner, report)).recovery!;
  await expect(recovery.retry(id, action)).rejects.toThrow();
  await expect(recovery.discard(id, action)).rejects.toThrow();
  expect(retry).not.toHaveBeenCalled(); expect(discard).not.toHaveBeenCalled();
});
it("P170: core recovery survives optional disable and restart", async () => {
  const fixture = await createFoundationFixture();
  try {
    const evidence = await fixture.runCase("all-optional-off");
    expect(evidence.events.length).toBeGreaterThan(0);
    expect(fixture.composition.workerCount).toBe(1);
    expect(typeof fixture.composition.host.recovery.export).toBe("function");
  } finally { await fixture.close(); }
});

```

Run RED:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/persistence/recovery-port.test.ts
```

Create `apps/desktop/src/main/plugins/persistence/recovery-port.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { ResourceOwner, Handle, PersistenceResult } from "@kobrixa/plugin-protocol";
import type { PersistenceBackend, StoredRecovery } from "./engine-port.js";
import type { PersistenceActionAdapter, ExportDestination } from "./actions.js";
import type { ExportOutcome } from "./engine-port.js";
import type { CoreActionReference, CoreActionValidationPort, DrainReport, PersistenceRecoverySnapshot } from "@kobrixa/plugin-runtime";
import { PersistenceFault, ownerKey, limit, stale } from "./record-port.js";
type Dependencies = { now(): number; wall(): number; actions: CoreActionValidationPort;
  retry(owner: ResourceOwner, report: DrainReport, deadline: number): Promise<DrainReport>;
  discard(owner: ResourceOwner, report: DrainReport): Promise<DrainReport>;
  backend: PersistenceBackend; adapter: PersistenceActionAdapter };
export interface PersistenceRecoveryHostPort {
  snapshot(): PersistenceRecoverySnapshot;
  subscribe(listener: () => void): () => void;
  export(input: { recovery: Handle; action: CoreActionReference }): Promise<PersistenceResult<{
    disposition: "not-committed" | "committed" | "unknown";
  }>>;
}
type Entry = { id: string; owner: ResourceOwner; report: DrainReport; expires: number;
  actionIds: { retry: string; export: string; discard: string } };
export function createPersistenceRecovery(deps: Dependencies) {
  const entries = new Map<string, Entry>(); let revision = 0;
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of listeners) listener(); };
  async function persist(entry: Entry) {
    const previous = await deps.backend.evidence.loadRecovery(entry.id);
    await deps.backend.evidence.saveRecovery({ id: entry.id, owner: entry.owner,
      report: entry.report, ticket: previous?.ticket ?? null, sealedPin: previous?.sealedPin ?? null,
      expiresAt: Number.isFinite(entry.expires) ? deps.wall() + entry.expires - deps.now() : null });
    changed();
  }
  function expire(entry: Entry) {
    if (deps.now() < entry.expires || entry.report.state !== "retryable") return;
    entry.report = { ...entry.report, state: "checkpoint-only", records: entry.report.records.map((record) => {
      const copy = { ...record }; delete copy.expiresAt;
      return { ...copy, payload: record.committedRevision ? "checkpoint-only" as const : "none" as const };
    }) };
    delete entry.report.retryAction;
    revision++;
  }
  function checked(id: string, action: CoreActionReference, kind: "persistence-retry" | "persistence-discard" | "persistence-export") {
    const entry = entries.get(id); if (!entry) stale(); expire(entry);
    if (!deps.actions.claim(action, { kind, recovery: id })) throw new PersistenceFault("PLUGIN_E_PERMISSION_DENIED");
    return entry;
  }
  const api = {
    async retain(owner: ResourceOwner, report: DrainReport): Promise<DrainReport> {
      const existing = [...entries.values()].find((entry) => ownerKey(entry.owner) === ownerKey(owner) &&
        entry.report.records[0]?.id === report.records[0]?.id);
      const size = Buffer.byteLength(JSON.stringify(report));
      if (report.records.length > 2 || report.errors.length > 16 || size > 8192) limit();
      const retained = [...entries.values()].filter((entry) => entry !== existing);
      if (retained.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry.report)), size) > 67108864 ||
        retained.filter((entry) => entry.owner.sourceKey === owner.sourceKey)
          .reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry.report)), size) > 4194304) limit();
      const expires = Math.min(...report.records.map((r) => r.expiresAt === undefined ? Infinity : deps.now() + Math.max(0, r.expiresAt - deps.wall())));
      const entry: Entry = existing ?? { id: randomUUID(), owner: { ...owner }, report, expires,
        actionIds: { retry: randomUUID(), export: randomUUID(), discard: randomUUID() } };
      entry.expires = Math.min(entry.expires, expires); entry.report = structuredClone(report);
      entry.report.recovery = entry.id;
      for (const record of entry.report.records) if (record.expiresAt !== undefined)
        record.expiresAt = Math.min(record.expiresAt, deps.wall() + entry.expires - deps.now());
      if (entry.report.state === "retryable") entry.report.retryAction = entry.actionIds.retry;
      entries.set(entry.id, entry); revision++;
      await persist(entry).catch(() => {
        entry.report.state = "uncertain"; entry.report.blocker = true; revision++;
      });
      return structuredClone(entry.report);
    },
    recoverySnapshot(): PersistenceRecoverySnapshot {
      for (const entry of entries.values()) expire(entry);
      return { revision, items: [...entries.values()].map((entry) => {
        const record = entry.report.records.length === 1 ? entry.report.records[0] : undefined;
        const payload = entry.report.records.some((r) => r.payload === "complete-staging") ? "complete-staging" as const
          : entry.report.records.some((r) => r.committedRevision !== null) ? "checkpoint-only" as const : "none" as const;
        return { id: entry.id, sourceKey: entry.owner.sourceKey, pluginId: entry.owner.pluginId,
          recordId: record?.id ?? null, committedRevision: record?.committedRevision ?? null,
          state: entry.report.state, payload,
          ...(entry.report.state === "retryable" && Number.isFinite(entry.expires) ? { expiresAt: deps.wall() + entry.expires - deps.now() } : {}),
          actions: [
            ...(entry.report.state === "retryable" ? [{ id: entry.actionIds.retry, kind: "retry" as const }] : []),
            ...(payload !== "none" ? [{ id: entry.actionIds.export, kind: "export" as const }] : []),
            { id: entry.actionIds.discard, kind: "discard" as const },
          ] };
      }) };
    },
    async retry(id: string, action: CoreActionReference) {
      const entry = checked(id, action, "persistence-retry");
      try {
        if (entry.report.state !== "retryable" || deps.now() >= entry.expires) stale();
        const result = await deps.retry(entry.owner, entry.report, Math.min(entry.expires, deps.now() + 10000));
        entry.report = structuredClone(result); entry.report.recovery = entry.id;
        for (const record of entry.report.records) if (record.expiresAt !== undefined)
          record.expiresAt = Math.min(record.expiresAt, deps.wall() + entry.expires - deps.now());
        expire(entry); revision++;
        await persist(entry); return structuredClone(entry.report);
      } finally { deps.actions.complete(action); }
    },
    async discard(id: string, action: CoreActionReference) {
      const entry = checked(id, action, "persistence-discard");
      try {
        const report = await deps.discard(entry.owner, entry.report);
        // Unknown dispatch remains a blocker even after a user's discard request.
        entry.report = report; revision++; await persist(entry); return structuredClone(report);
      } finally { deps.actions.complete(action); }
    },
    async restore() {
      let cursor: Handle | undefined;
      do {
        const page = await deps.backend.evidence.recoveryPage(cursor);
        for (const stored of page.items) {
          // T2 validates format, payload pins and unknown tickets before this page is returned.
          const entry: Entry = { id: stored.id, owner: stored.owner, report: structuredClone(stored.report),
            expires: stored.expiresAt === null ? Infinity : deps.now() + Math.max(0, stored.expiresAt - deps.wall()),
            actionIds: { retry: randomUUID(), export: randomUUID(), discard: randomUUID() } };
          entries.set(entry.id, entry); expire(entry);
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      revision++; changed();
    },
    async export(input: { recovery: Handle; action: CoreActionReference }): Promise<PersistenceResult<{
      disposition: "not-committed" | "committed" | "unknown";
    }>> {
      const { recovery: id, action } = input;
      const entry = checked(id, action, "persistence-export");
      const backend = deps.backend;
      let pin: Handle | undefined, closePin = false, destination: ExportDestination | null = null;
      const job = randomUUID(), control = new AbortController(), deadline = deps.now() + 120000;
      const timer = setTimeout(() => control.abort(), 120000);
      let outcome: ExportOutcome = { disposition: "not-committed" };
      let begun = false;
      try {
        const stored = await backend.evidence.loadRecovery(id);
        if (!stored) stale();
        const record = stored.report.records.find(r => r.payload === "complete-staging" || r.committedRevision !== null);
        if (!record) stale();
        let bytes: number, digest: string;
        if (record.payload === "complete-staging" && stored.sealedPin && stored.ticket?.metadata.kind === "record" &&
            stored.expiresAt !== null && deps.wall() < stored.expiresAt) {
          pin = stored.sealedPin; bytes = stored.ticket.metadata.record.byteLength; digest = stored.ticket.metadata.record.sha256;
        } else {
          if (!record.committedRevision) stale();
          const meta = await backend.reads.stat(stored.owner, record.id);
          if (meta.revision !== record.committedRevision) stale();
          pin = await backend.reads.open(stored.owner, record.id, record.committedRevision); closePin = true;
          bytes = meta.byteLength; digest = meta.sha256;
        }
        destination = await deps.adapter.chooseDestination(action.actionToken, "recovery.bin", control.signal);
        if (!destination) return { ok: true, value: outcome };
        if (control.signal.aborted || deps.now() >= deadline ||
          !deps.actions.isClaimed(action, { kind: "persistence-export", recovery: id })) stale();
        await backend.output.begin(job, stored.owner, destination, bytes, digest, deadline); begun = true;
        for (let offset = 0; offset < bytes;) {
          if (control.signal.aborted || deps.now() >= deadline ||
            !deps.actions.isClaimed(action, { kind: "persistence-export", recovery: id })) stale();
          const chunk = await backend.reads.read(stored.owner, pin!, offset, Math.min(262144, bytes - offset));
          if (!chunk.length) throw new Error("Incomplete retained payload.");
          const written = await backend.output.append(job, offset, chunk);
          if (written <= 0 || written > chunk.length) throw new Error("Invalid output progress.");
          offset += written;
        }
        outcome = await backend.output.commit(job);
        if (outcome.disposition === "unknown") outcome = await backend.output.reconcile(job);
        return { ok: true, value: { disposition: outcome.disposition } };
      } catch {
        const aborted = begun ? await backend.output.abort(job).catch(() => "unknown" as const) : "aborted";
        outcome = { disposition: aborted === "aborted" ? "not-committed" : aborted };
        return { ok: true, value: { disposition: outcome.disposition } };
      } finally {
        clearTimeout(timer);
        if (closePin && pin) await backend.reads.close(entry.owner, pin);
        // Unknown jobs retain destination identity and are reconciled using their original job ID.
        if (destination && outcome.disposition !== "unknown") await backend.destinations.release(destination);
        deps.actions.complete(action);
      }
    },
    snapshot: () => api.recoverySnapshot(),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return api;
}
```

Before acknowledging retained recovery, await `evidence.saveRecovery`; a failure produces uncertain/blocking state. Persist the original `ticket` and worker-validated `sealedPin` together with report/expiry, obtained from the record admission being retained. The local retain call receives this admitted evidence from the same record/lifecycle service; never derive a sealed pin from a UUID or from a "sealed" UI label. Preserve existing ticket/pin when updating report state. On startup await `restore()` before exposing requests, revalidate pins and reconcile unknown tickets, and expire using the stored absolute timestamp. Discard calls `evidence.removeRecovery` only after a known disposition; permission/corruption failures are not absence. Saved entries remain available independently of optional-feature execution.

D170 implements trusted `manage` by validating the core item and workbench, sending `onOpen({itemId})`, and returning the unchanged `CoreRecoverySnapshot`. It defines `PluginsApi.persistenceRecovery: PersistenceRecoveryBridge` in shared/plugin-persistence.ts with `snapshot({itemId})`, `act({itemId,optionId})`, `onOpen` and `onChanged`. The main lookup maps item/option IDs to retained recovery identity, revision, generation and scope, then mints a fresh matching CoreActionReference and invokes retry/discard/export. The renderer supplies no namespace, path, token or scope. Subscribe to the host recovery port to invalidate details, including after restart and while every optional feature is disabled. Leave `PersistenceParticipant` and `CoreRecoveryItem.actions[].kind` unchanged.

Unknown tickets are reconciled by the engine and never offered as a retry publication. Core export uses a **fresh CoreActionReference** and a separate destination; it cannot reuse a feature export handle. B1 core UI keeps its frozen action enum; `manage` opens the persistence detail view containing these retry/export/discard option IDs. No plugin RPC accepts a CoreActionReference.

Run GREEN for this implementation before starting the next slice:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/persistence/recovery-port.test.ts
```

Expected: isolated retention and fresh core authorization tests pass in W1; the optional-process/restart row passes only with T7’s actual worker producer at P170. The final task commit below includes this slice.

- [ ] **Step 7: Test explicit composition, admission budgets and worker ownership**

Create `apps/desktop/src/main/plugins/persistence/host-port.test.ts`. Consume the read-only T7 `createFoundationFixture` producer at P170; it uses the actual worker, primary profile, action ledger and host. Do not define a second production fixture or injectable service factory. Add this real composition test:

```ts
import { expect, it } from "vitest";
import { createFoundationFixture } from "../../../../../../../tests/desktop/plugin-persistence-main.js";
it("P170: one profile, worker and reservation listener bind real settings and recovery", async () => {
  const fixture = await createFoundationFixture();
  try {
    const c = fixture.composition;
    expect(c.persistenceProfile).toBe(c.profile);
    expect(c.journalProfile).toBe(c.profile);
    expect(c.workerCount).toBe(1);
    expect(c.reservationListenerCount).toBe(1);
    expect(typeof c.host.settings.open).toBe("function");
    expect(typeof c.host.recovery.export).toBe("function");
    c.profile.assertHeld();
    const off = c.host.recovery.subscribe(() => {});
    expect(c.host.recovery.snapshot()).toEqual(c.host.participant.recoverySnapshot());
    off();
    await Promise.all([c.host.dispose(), c.host.dispose()]);
    c.profile.assertHeld();
  } finally { await fixture.close(); }
});
```

Retain unit coverage for permission ordering and queue limits using backend doubles only: construct actual host services with `composition:{backend,sources,events,dispatchDrain,imports}`. For permission ordering set `hasPermission` false and spies on source reads, engine reserve and strict parameter validation; assert none runs after the permission error. For queue limits pause the backend append promise for two admitted 256-KiB chunks; the third serialized chunk exceeds the 1-MiB source queue budget before decoding and returns resource-limit. Release the two promises, await both requests, and dispose. Do not replace `services.records.request` with a fake service.

Add a table test deleting each required composition member from an untyped runtime input. Construction must reject before exposure, and an available backend is disposed once while the same lock is held. Also inject a recovery-page failure after service construction: all initialized watches/services must be closed, the backend must exit, and no extra lock/worker/listener is created. The typed constructor itself must require every member.

Run RED then GREEN after Step 8:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/persistence/host-port.test.ts
```

Expected RED: missing bound service/recovery or composition behavior. Expected GREEN at P170: actual worker and host tests pass; W1 unit-only results do not satisfy this gate.

- [ ] **Step 8: Implement the exact host factory and bounded router**

Replace `apps/desktop/src/main/plugins/persistence/host-port.ts`:

```ts
import { RpcError, RPC_ERRORS } from "@kobrixa/plugin-protocol";
import type { Permission, SettingsRequestMap, StorageRequestMap, PersistenceActionRequestMap } from "@kobrixa/plugin-protocol";
import type { Principal, ProfileWriterLock, ReservationBindingPort, UserPersistenceActionPort,
  CoreActionValidationPort, PersistenceParticipant } from "@kobrixa/plugin-runtime";
import type { PersistenceBackend } from "./engine-port.js";
import type { PersistenceActionAdapter, ExportDestination } from "./actions.js";
import type { ExportOutcome } from "./engine-port.js";
import type { RecordServicePort } from "./record-port.js";
import type { ResourceOwner, UiOwner, SettingsResourceV1, Sha256 } from "@kobrixa/plugin-protocol";
import type { CoreWindowScope, BoundSettingsService, DrainDispatcher } from "@kobrixa/plugin-runtime";
import type { CommonEventLedgerPort } from "@kobrixa/plugin-runtime";
import type { LegacyImportHostPort } from "./import-sources.js";
import type { PersistenceRecoveryHostPort } from "./recovery-port.js";
export type PersistenceRequestMap = SettingsRequestMap & StorageRequestMap & PersistenceActionRequestMap;
export interface PersistenceHost {
  readonly participant: PersistenceParticipant;
  readonly settings: BoundSettingsService;
  readonly recovery: PersistenceRecoveryHostPort;
  request<M extends keyof PersistenceRequestMap>(principal: Principal, method: M,
    params: PersistenceRequestMap[M]["params"], signal: AbortSignal): Promise<PersistenceRequestMap[M]["result"]>;
  dispose(): Promise<void>;
}
type SettingsService = { request<M extends keyof SettingsRequestMap>(principal: Principal, method: M,
  params: SettingsRequestMap[M]["params"], signal: AbortSignal): Promise<SettingsRequestMap[M]["result"]> };
type ActionService = { request<M extends keyof PersistenceActionRequestMap>(principal: Principal, method: M,
  params: PersistenceActionRequestMap[M]["params"], signal: AbortSignal): Promise<PersistenceActionRequestMap[M]["result"]> };

export interface PersistenceSourcePort {
  current(owner:ResourceOwner): boolean;
  settings(input:{sourceKey:string; resourceDigest:Sha256}): Promise<{
    owner:UiOwner; resource:SettingsResourceV1; validationDigest:Sha256;
  }|null>;
  coreOwner(input:{sourceKey:string; scope:CoreWindowScope}): ResourceOwner|null;
}
export interface PersistenceCompositionInput {
  backend:PersistenceBackend;
  sources:PersistenceSourcePort;
  events:CommonEventLedgerPort;
  dispatchDrain:DrainDispatcher;
  imports:LegacyImportHostPort;
}
export async function createPersistenceHost(input: {
  profile: ProfileWriterLock;
  composition: PersistenceCompositionInput;
  reservations: ReservationBindingPort;
  actions: UserPersistenceActionPort;
  actionAdapter: PersistenceActionAdapter;
  coreActions: CoreActionValidationPort;
  now: () => number;
  hasPermission: (principal: Principal, permission: Permission) => boolean;
}): Promise<PersistenceHost> {
  input.profile.assertHeld();
  if (!input.composition) throw new TypeError("Incomplete persistence composition.");
  const { backend, sources, events, dispatchDrain, imports } = input.composition;
  if (!backend || !sources || !events || !dispatchDrain || !imports) {
    if (backend) await backend.dispose();
    throw new TypeError("Incomplete persistence composition.");
  }
  let services!: ReturnType<typeof constructServices>;
  try {
    services = constructServices(input);
    await services.recovery.restore();
  } catch (error) {
    try { if (services) await services.dispose(); } finally { await backend.dispose(); }
    throw error;
  }
  let disposed = false, pending = 0, bytes = 0;
  let disposal: Promise<void> | undefined;
  const counts = new Map<string, { pending: number; bytes: number }>();
  const controllers = new Set<AbortController>();
  const readMethods = new Set(["settings/read", "settings/watch", "settings/readMigration", "storage/stat",
    "storage/list", "storage/openRead", "storage/readChunk", "storage/closeRead"]);
  function required(method: string): Permission {
    if (method === "ui/copyText") return "ui.clipboard";
    if (method.startsWith("storage/export")) return "storage.export";
    return method.startsWith("settings/") ? readMethods.has(method) ? "settings.read" : "settings.write"
      : readMethods.has(method) ? "storage.read" : "storage.write";
  }
  async function dispatch<M extends keyof PersistenceRequestMap>(principal: Principal, method: M,
    params: PersistenceRequestMap[M]["params"], signal: AbortSignal): Promise<PersistenceRequestMap[M]["result"]> {
    // The branch predicates are a finite method-name partition, not a generic RPC tunnel.
    if (method.startsWith("settings/")) return services.settings.request(principal,
      method as keyof SettingsRequestMap, params as SettingsRequestMap[keyof SettingsRequestMap]["params"], signal) as Promise<PersistenceRequestMap[M]["result"]>;
    if (method === "ui/copyText" || method.startsWith("storage/export")) return services.actions.request(principal,
      method as keyof PersistenceActionRequestMap, params as PersistenceActionRequestMap[keyof PersistenceActionRequestMap]["params"], signal) as Promise<PersistenceRequestMap[M]["result"]>;
    return services.records.request(principal, method as keyof StorageRequestMap,
      params as StorageRequestMap[keyof StorageRequestMap]["params"], signal) as Promise<PersistenceRequestMap[M]["result"]>;
  }
  return {
    participant: services.participant, settings: services.boundSettings, recovery: services.recovery,
    async request<M extends keyof PersistenceRequestMap>(principal: Principal, method: M,
      params: PersistenceRequestMap[M]["params"], signal: AbortSignal): Promise<PersistenceRequestMap[M]["result"]> {
      input.profile.assertHeld();
      if (method === "storage/drain") throw new RpcError(RPC_ERRORS.methodNotFound, "Host-only method direction.");
      if (disposed) return { ok: false, error: { code: "PLUGIN_E_SHUTTING_DOWN", message: "Host is closing." } };
      if (!input.hasPermission(principal, required(method)) &&
        !(method === "storage/quota" && input.hasPermission(principal, "storage.read")))
        return { ok: false, error: { code: "PLUGIN_E_PERMISSION_DENIED", message: "Permission required.",
          detail: { kind: "permission", reason: "permission" } } };
      const cleanup = method === "storage/writeStatus" || method === "storage/abortWrite" ||
        ("drainToken" in params && typeof params.drainToken === "string") ||
        method === "storage/writeChunk" || method === "storage/sealWrite";
      if (!services.live(principal) && !cleanup)
        return { ok: false, error: { code: "PLUGIN_E_STALE_RESOURCE", message: "Retired owner.",
          detail: { kind: "resource", reason: "stale", resource: "rpc" } } };
      services.validate(method, params);
      const size = Buffer.byteLength(JSON.stringify(params));
      const key = principal.kind === "plugin" ? principal.owner.sourceKey : "core";
      const source = counts.get(key) ?? { pending: 0, bytes: 0 };
      if (pending >= 32 || source.pending >= 16 || bytes + size > 8388608 || source.bytes + size > 1048576)
        return { ok: false, error: { code: "PLUGIN_E_RESOURCE_LIMIT", message: "Persistence queue full.",
          detail: { kind: "resource", reason: "queue", resource: "rpc" } } };
      counts.set(key, source); pending++; bytes += size; source.pending++; source.bytes += size;
      const control = new AbortController(); controllers.add(control);
      const cancel = () => control.abort(); signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<PersistenceRequestMap[M]["result"]>((resolve) => {
        timer = setTimeout(() => { control.abort(); resolve({ ok: false,
          error: { code: "PLUGIN_E_TIMEOUT", message: "Persistence request timed out; query its original identity." } }); }, 10000);
      });
      const operation = dispatch(principal, method, params, control.signal).finally(() => {
        clearTimeout(timer); signal.removeEventListener("abort", cancel); controllers.delete(control);
        pending--; bytes -= size; source.pending--; source.bytes -= size;
        if (!source.pending) counts.delete(key);
      });
      return Promise.race([operation, timeout]);
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      for (const controller of controllers) controller.abort();
      disposal = (async () => {
        input.profile.assertHeld();
        try { await services.dispose(); } finally { await backend.dispose(); }
        input.profile.assertHeld();
      })();
      return disposal;
    },
  };
}
```

`constructServices` is private implementation in this owned host-port.ts, not an injectable factory or registry. Implement it before the router with the following construction order and bindings. Import all contract types from their defining modules: `PersistenceBackend` from engine-port.ts, `LegacyImportHostPort` from import-sources.ts, `BoundSettingsService` from runtime settings-form-port.ts, `CommonEventLedgerPort` from runtime device-resources.ts and `PersistenceRecoveryHostPort` from recovery-port.ts.

| Construct exactly once | Required real binding |
| --- | --- |
| `createBoundSettingsService({backend,sources,events,now:input.now})` | Return as `boundSettings`; `settingsRequests(backend)` is `services.settings`, sharing the same underlying settings queue. |
| `createPersistenceRecovery` | Pass `backend`, `input.actionAdapter`, `input.coreActions`, `now:input.now`, `wall:Date.now`. Retry reconciles the original stored ticket first, publishes only complete sealed not-committed payload before original expiry, and persists the updated `StoredRecovery`. Discard aborts that same ticket, removes recovery only after known outcome and release of payload pins; unknown stays a blocker. |
| `createPersistenceLifecycle` | Pass `backend.evidence`, `backend.reads`, `backend.engine.fence/fenceTarget`, `sources.current`, `input.reservations`; checkpoint callbacks bind to the one record service after construction. `recover` calls the recovery registry’s retain operation. No `onEnded` subscription is created. |
| `createRecordService` | Pass `backend.engine`, `backend.reads`, `backend.evidence`, `sources.current`, `input.hasPermission`, clock and the preceding lifecycle’s `authorize/committed/open/register/abandon`. |
| `createPersistenceActions` | Pass `backend.output`, `backend.destinations`, `input.actions`, `input.actionAdapter`, `sources.current`, permission and clocks. |

For lifecycle registration metadata use immutable engine tickets with both target/metadata `{kind:"recovery",key:checkpoint}`, serialize `{formatVersion:1,checkpoint,record,binding,state}`, reserve→append→seal→publish, reconcile unknown on the original ticket. Read these documents using `evidence.auxiliary/auxiliaryKeys(owner,"recovery")`; never perform filesystem enumeration in main. The per-owner pending write/status projection comes from the record service’s existing admitted writes, with immutable ticket IDs resolved by `evidence.tickets(evidence.capture(scope,deadline))`. `settle` reconciles only those tickets; `pendingSettings` checks captured settings tickets; payload eligibility requires a worker-validated complete sealed pin, never merely a receiving buffer. Add module-local record-service accessors for these projections in its owned file and return them alongside its unchanged public `request` facet. Preserve the same admission ledger and original retention timestamps.

`services.live` validates actual plugin owners using sources.current; core forms use only the bound service facet. `services.validate` uses T1’s method-specific strict parameter schemas; malformed calls throw numeric invalidParams before decoding. `services.participant` delegates to the one lifecycle participant and retains `dispatchDrain` on the original-peer path; it never registers another reservation listener. `services.dispose` stops form watches/actions, freezes each admitted live owner once, drains using the supplied dispatcher, waits for in-flight requests and recovery persistence, then closes record/read/list pins. The outer factory disposes backend afterwards with the original profile lock still held, including construction failure. Do not create a worker or root here: D170 already called AM-23 once. An idempotent disposal promise must encompass both services and backend; repeated disposal awaits it rather than returning while the worker still runs.

AM-24/29 imports are the supplied `LegacyImportHostPort`, constructed by T6 over this same backend’s `imports/sources/evidence`. Do not invent a local import filesystem or recreate import orchestration in T5. Namespace flush observes its admitted tickets. D170 supplies the fixed descriptor/mapper IDs and restored legacy writer barrier before exposing requests. Foundation mappings and writer controls remain synthetic only.

- [ ] **Step 9: Run the focused GREEN gate and stage only the owned files**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-sdk build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/device build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime test -- src/persistence-participant.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/persistence/host-port.test.ts src/main/plugins/persistence/actions.test.ts src/main/plugins/persistence/lifecycle.test.ts src/main/plugins/persistence/recovery-port.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git diff --check
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git add apps/desktop/src/main/plugins/persistence/host-port.ts apps/desktop/src/main/plugins/persistence/host-port.test.ts apps/desktop/src/main/plugins/persistence/actions.ts apps/desktop/src/main/plugins/persistence/actions.test.ts apps/desktop/src/main/plugins/persistence/lifecycle.ts apps/desktop/src/main/plugins/persistence/lifecycle.test.ts apps/desktop/src/main/plugins/persistence/recovery-port.ts apps/desktop/src/main/plugins/persistence/recovery-port.test.ts packages/plugin-runtime/src/persistence-participant.ts packages/plugin-runtime/src/persistence-participant.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git commit -m "feat(persistence): bind user actions and retain bounded drain evidence"
```

Expected: focused tests pass against the explicit doubles and canonical runtime types. The commit is **controller runs outside sandbox**. The full production gate remains T9/X-T1 with real A/B1/T2 ports. Real filesystem kill/reopen, destination identity races, callback cancellation across MessagePort/stdio, installed worker construction and native dialogs cannot be inferred from these unit results.

- [ ] **Step 9a: Run the amended ports against the actual T2 worker at P170**

Add these assertions to the owned host-port.test.ts. Hand the required additive evidence keys to T7’s sole producer; T7 populates each from actual worker traces, disk hashes, catalog/ledger counters and restart state. No constant truth values or local service doubles may supply these P170 results. P10 does not edit the producer.

```ts
it.each([
  ["all-optional-off", ["p10.noProcessSettings", "p10.durableRecoveryRestored", "p10.committedExportHash", "p10.sealedExportHash"]],
  ["sealed-ttl", ["p10.originalExpiryPreserved", "p10.expiredPinRejected", "p10.checkpointOnlyNoInventedBytes"]],
  ["unknown-publication", ["p10.exportOriginalJobReconciled", "p10.noRepublish", "p10.destinationIdentityPreserved"]],
  ["action-replay", ["p10.freshCoreAction", "p10.cancelNoWrite", "p10.lateDialogReleased", "p10.identitySwapRejected"]],
  ["storage-ui-pressure", ["p10.namespaceIncludesSettingsImport", "p10.targetExcludesSettings", "p10.afterBarrierExcluded"]],
  ["import-restart", ["p10.atomicImportReceipt", "p10.barrierRestored", "p10.originalBytesUnchanged"]],
] as const)("P170 real evidence: %s", async (name, checks) => {
  const fixture = await createFoundationFixture();
  try {
    const evidence = await fixture.runCase(name);
    for (const check of checks) expect(evidence.checks[check], check).toBe(true);
    expect(fixture.composition.workerCount).toBe(1);
    expect(fixture.composition.reservationListenerCount).toBe(1);
  } finally { await fixture.close(); }
});
```

For barrier tests pause actual admitted settings/import tickets, synchronously capture namespace and target barriers before releasing the worker, then admit another ticket. Namespace flush must wait for the first two, target flush must exclude them, and the later admission cannot enter either captured sequence. Crash the worker with an unresolved ticket and assert unknown, never saved. Reopen corrupt/unknown-format recovery in blocked read-only mode, preserve original bytes, and verify original TTL after restart.

For export tests register real temporary paths through the native destination adapter, verify both pre-existing and final hashes, and inject before/after replacement failure using the private worker fault controller. Read pin, complete sealed pin and destination jobs all stay within four jobs and ≤256-KiB chunks. Unknown jobs preserve worker evidence; following restart, recovery lookup must reconcile retained publication evidence before offering a new action. Dialog cancellation and unsupported replacement leave existing bytes untouched. Native OS dialogs remain a separately recorded manual run.

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/persistence/host-port.test.ts src/main/plugins/persistence/actions.test.ts src/main/plugins/persistence/recovery-port.test.ts src/main/plugins/persistence/lifecycle.test.ts src/main/plugins/persistence/settings-service.test.ts src/main/plugins/persistence/record-service.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; node --test tests/desktop/plugin-persistence-*.test.mjs
```

Expected: all amended real-worker evidence checks pass at P170. Missing evidence is a failure; isolated W1 doubles remain development-only. Record the T7 producer bundle hash and D170/K170 stopped-owner receipts with the P170 result.

- [ ] **Step 10: Hand off acceptance cases without taking the integration write set**

The controller records exact commits and paths in the existing freeze/acceptance receipts. T7/T9/X-T1 must run actual implementations for B2 §10 and §12.1 groups 1–6 and 8; P11 owns import group 7. The mandatory cross-plan cases are:

| Coverage | Required real-path assertion |
| --- | --- |
| B2-RF1, B2 §10 rename-before/after | Cancel before dispatch aborts; cancel after dispatch returns unknown/receipt, keeps original ticket and does not republish. Check old/new heads and byte hashes. |
| B2-RF2, B2 §12.1-1 | Mixed `1`/`"1"`, dotted keys, external revision and queued edits retain exact values; real controls require explicit retry. No Apply button. |
| B2-RF3, B1 U12/U17, A-RF5 | End during durable registration, duplicate end, retire-before/end-before/final-in-flight, two targets, earliest deadline and one callback per target. Freeze receives the identical fourth grant object in the same synchronous turn. |
| B2 §12.1-6 | `released`, `core-disconnect`, `suspended`, `disconnected` target-only drain preserves healthy process generation and unrelated settings. Renderer/window loss freezes the owner and keeps the channel until disposition. Wake/re-enable never replay. |
| B2-RF4, B1 U07/U16 | Foreign/expired/replayed/invocation-substituted actionRef; consumed copy→export; old core scope and item mismatch; late dialog at 120 seconds/window loss makes no write. No native path in results. |
| B2 §10 flush/retention | Receiving/open checkpoint/unknown cannot flush; memory-only loss is checkpoint-only; complete sealed staging is retryable only until `min(lastProgress+30000,created+120000)`. Retry does not renew. |
| B2 §12.1-2/3/5 | 8 MiB/+1, 256 KiB/+1, 2/3 source and 16/17 host writes, independent 1/4 exports, fixed 64-entry/256 KiB pages, 4+4 handles, 30/120-second expiry, original pins survive delete, terminal 64/1024 admission bounds. |
| B2 §12.1-4 | Shared 32 subscription ledger, snapshot baseline/commit ordering, slow callbacks do not delay enqueue acknowledgements, shared unsubscribe true/false tombstones, sequence gaps resnapshot, no settings-specific wire alias. |
| B2-M01–M04 | **controller runs outside sandbox**: real form keyboard/focus/theme/locale/320 px/125%, disk-full UI, native export/clipboard, process kill/cold-safe-mode and all-optionals-off recovery. |

After D170/R170/V170/K170 assembly, run the skeleton §6 commands once at the controller gate:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm check:desktop
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm test:desktop
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; node --test tests/desktop/plugin-persistence-*.test.mjs
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; node --test tests/desktop/stage-3-foundations.test.mjs
```

Any Electron, localhost, installed or hardware path is **controller runs outside sandbox**. Record actual command/exit status, artifact/commit, OS/architecture/filesystem, CPU/RAM, Node/Electron, 30 samples with p50/p95/max and separate main/worker RSS. Unrun remains unrun. A fixture-only pass is not full smoke, P170 acceptance, or 3C/3D/3E closeout.

### Task 3B2-T6: Resumable one-time import framework

**Files**

Create:

- `apps/desktop/src/main/plugins/persistence/import-coordinator.ts`
- `apps/desktop/src/main/plugins/persistence/import-coordinator.test.ts`
- `apps/desktop/src/main/plugins/persistence/import-journal.ts`
- `apps/desktop/src/main/plugins/persistence/import-journal.test.ts`
- `apps/desktop/src/main/plugins/persistence/import-sources.test.ts`
- `apps/desktop/src/main/plugins/persistence/import-fixtures.ts`

Modify (baseline-new, seeded by T0; retain its frozen declarations):

- `apps/desktop/src/main/plugins/persistence/import-sources.ts`

Test:

- `apps/desktop/src/main/plugins/persistence/import-coordinator.test.ts`
- `apps/desktop/src/main/plugins/persistence/import-journal.test.ts`
- `apps/desktop/src/main/plugins/persistence/import-sources.test.ts`

Read only: F; T1–T4; `apps/desktop/src/main/sensor-lab/store.ts`, `apps/desktop/src/main/sensor-lab/schema.ts`, `apps/desktop/src/main/device/preferences.ts`, `apps/desktop/src/renderer/settings/settings.ts`. In particular, do not call `SensorLabStore.initialize()` to collect evidence: that implementation can quarantine or rewrite legacy files. Do not use `loadDevicePreferences()` for absence detection: its catch-all defaulting loses the distinction between ENOENT and EACCES.

**Interfaces**

Consumes the existing type-only imports from protocol, runtime, `engine-port.ts`, and `record-port.ts`. The public/host boundary remains exactly:

```ts
// import-sources.ts: these are the T0 declarations, not competing DTOs.
import type {
  Handle, Sha256, Version, Values, RecordWrite,
} from "@kobrixa/plugin-protocol";
import type { CoreWindowScope } from "@kobrixa/plugin-runtime";

export type LegacyPreferencesSnapshot = {
  nonce: Handle;
  scope: CoreWindowScope;
  entries: Array<{ key: string; raw: string | null }>;
};
export type LegacyImportInput = {
  sourceKind: "sensor-lab" | "device-settings" | "renderer-preferences";
  bytes: Uint8Array;
  sha256: Sha256;
};
export type LegacyImportItem =
  | { kind: "settings"; schemaVersion: Version; values: Values }
  | {
      kind: "record";
      metadata: Omit<RecordWrite, "target" | "checkpoint" | "drainToken">;
      bytes: Uint8Array;
    };
export interface LegacyImportDescriptor {
  id: string;
  mappingVersion: Version;
  targetSourceKey: string;
  sourceKind: LegacyImportInput["sourceKind"];
  sourceFormatVersions: readonly Version[];
  targetSettingsSchemaVersion?: Version;
  targetRecordSchemaVersions: readonly Version[];
  rendererKeyAllowlist?: readonly string[];
  validate(input: LegacyImportInput): boolean;
  map(input: LegacyImportInput): LegacyImportItem;
}
export interface LegacyImportCoordinator {
  run(descriptor: LegacyImportDescriptor, signal: AbortSignal): Promise<{
    state: "pending" | "planned" | "copying" | "complete" | "complete-empty" | "blocked";
    completedItems: number;
    totalItems: number;
  }>;
  acceptPreferences(snapshot: LegacyPreferencesSnapshot): Promise<void>;
}
```

The engine is consumed without changing its signature:

```ts
import type { PersistenceEnginePort, PublicationTicket } from "./engine-port.js";
import type { RecordServicePort } from "./record-port.js";
// Signature references preserve the single definitions, including their result envelopes.
type ImportPublication = PersistenceEnginePort["publish"];
type ImportReconciliation = PersistenceEnginePort["reconcile"];
type ImportRecordRequest = RecordServicePort["request"];
```

Produces `LegacyImportHostPort` through `createLegacyImportCoordinator`, durable planning/reconciliation, `createLegacyWriterBarrier`, coordinator-issued preferences challenges and a synthetic worker mapper. Import the AM-24 declarations from T2 engine-port.ts; never redeclare them or create another store.

Preconditions: start W1 only from the recorded amended F SHA. AM-24/26/29 are binding: use the single `PersistenceBackend`, its `imports`, `evidence` and `sources` ports. D170 supplies trusted scope/source admission and namespace owner callbacks. Real Lab/calibration/preference mappings remain 3D/3E.

The following declarations are frozen, not new local alternatives. AM-24 belongs to T2 `engine-port.ts`; AM-29 source/challenge/barrier types belong to T6 `import-sources.ts`, with the coordinator factory implemented in `import-coordinator.ts`:

```ts
type ImportTag = Readonly<{importId:string; itemKey:string; sourceSha256:Sha256}>;
type ImportPlannedItem = Readonly<{
  key:string; sourceFormat:Version; sourceSha256:Sha256; mappedSha256:Sha256; byteLength:number;
  ticket:PublicationTicket; tag:ImportTag;
}>;
type ImportPlan = Readonly<{formatVersion:1; id:string; mappingVersion:Version;
  targetSourceKey:string; items:readonly ImportPlannedItem[]}>;
type ImportItemEvidence = {key:string; state:"pending"|"committed"|"skipped"|"unknown";
  receipt:Receipt<SettingsRevision|RecordRevision>|null; skipReason:string|null};
interface DurableImportPort {
  load(owner: PersistenceOwner, id: string): Promise<{plan:ImportPlan;
    items:readonly ImportItemEvidence[]; complete:boolean}|null>;
  plan(owner: PersistenceOwner, plan: ImportPlan): Promise<void>;
  tagImport(ticket: PublicationTicket, tag: ImportTag): Promise<void>;
  importReceipts(owner: PersistenceOwner, id:string): Promise<readonly {
    tag:ImportTag; ticket:PublicationTicket; receipt:Receipt<SettingsRevision|RecordRevision>;
  }[]>;
  record(owner: PersistenceOwner, id:string, evidence:ImportItemEvidence): Promise<void>;
  reconcile(ticket: PublicationTicket): ReturnType<PersistenceEnginePort["reconcile"]>;
  complete(owner: PersistenceOwner, id:string): Promise<void>;
}
```

```ts
type LegacySourceItem = Readonly<{key:string; format:Version; byteLength:number; sha256:Sha256}>;
type LegacyMappedItem = Readonly<{mapped:Handle;sourceSha256:Sha256;
  mappedSha256:Sha256;byteLength:number} & (
  {kind:"settings";schemaVersion:Version} |
  {kind:"record";metadata:Omit<RecordWrite,"target"|"checkpoint"|"drainToken">}
)>;
interface LegacySourceResolver {
  register(input:{descriptorId:string;mapperId:string;sourceKind:LegacyImportInput["sourceKind"]}): Promise<void>;
  map(descriptorId:string, key:string): Promise<LegacyMappedItem>;
  appendMapped(input:{mapped:Handle;ticket:PublicationTicket;offset:number;
    maxBytes:number}): Promise<{nextOffset:number;done:boolean}>;
  releaseMapped(mapped:Handle): Promise<void>;
  inventory(descriptorId:string): Promise<{state:"present"|"absent"|"blocked";
    entries:readonly LegacySourceItem[]}>;
  read(descriptorId:string, key:string, offset:number, maxBytes:number): Promise<Uint8Array>;
}
type LegacyPreferenceChallenge = Readonly<{nonce:Handle; scope:CoreWindowScope;
  descriptorId:string; keys:readonly string[]}>;
interface LegacyWriterBarrier {
  enter(sourceKey:string, descriptorId:string): Promise<Handle>;
  restore(): Promise<readonly {sourceKey:string;descriptorId:string;barrier:Handle}[]>;
  complete(barrier:Handle): Promise<void>;
}
interface LegacyImportHostPort extends LegacyImportCoordinator {
  issuePreferences(input:{descriptorId:string;scope:CoreWindowScope}): Promise<LegacyPreferenceChallenge>;
  retirePreferences(scope:CoreWindowScope): void;
  acceptPreferencesEvidence(snapshot:LegacyPreferencesSnapshot): Promise<{
    state:"accepted"|"pending"|"reconciled";
  }>;
}
declare function createLegacyImportCoordinator(input:{backend:PersistenceBackend;
  sources:LegacySourceResolver; barrier:LegacyWriterBarrier;
  descriptors:readonly LegacyImportDescriptor[];
  currentScope:(scope:CoreWindowScope)=>boolean;
  currentSource:(sourceKey:string)=>boolean;
  importOwner:(sourceKey:string)=>PersistenceOwner;
}): LegacyImportHostPort;
interface LegacyWriterPort {
  readonly sourceKey:string;
  freezeAdmission(): void;
  settled(): Promise<void>;
}
declare function createLegacyWriterBarrier(input:{backend:PersistenceBackend;
  writers:readonly LegacyWriterPort[];importOwner:(sourceKey:string)=>PersistenceOwner;
}): LegacyWriterBarrier;
```

- [ ] **Step 1: Pin source limits, absence, and renderer evidence before implementing them**

Create `import-sources.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  assertInventory, classifySourceError, snapshotBytes,
} from "./import-sources.js";

const scope = {
  hostEpoch: "11111111-1111-4111-8111-111111111111",
  workbenchInstance: "22222222-2222-4222-8222-222222222222",
};
const nonce = "33333333-3333-4333-8333-333333333333";
const snapshot = () => ({ nonce, scope, entries: [{ key: "test.preference", raw: null }] });

describe("legacy source evidence", () => {
  it("distinguishes verified absence from permission and IO failures", () => {
    expect(classifySourceError({ code: "ENOENT" })).toBe("absent");
    for (const code of ["EACCES", "EPERM", "EIO", "EROFS", "ENOTDIR"])
      expect(classifySourceError({ code })).toBe("blocked");
    expect(classifySourceError(new Error("missing"))).toBe("blocked");
  });
  it("bounds names before filtering and rejects unsafe file evidence", () => {
    const entry = { name: "11111111-1111-4111-8111-111111111111.json",
      regular: true, contained: true, links: 1, bytes: 8 * 1024 * 1024 };
    expect(() => assertInventory(4096, [entry])).not.toThrow();
    expect(() => assertInventory(4097, [entry])).toThrow("inventory-limit");
    for (const patch of [
      { regular: false }, { contained: false }, { links: 2 },
      { bytes: 8 * 1024 * 1024 + 1 }, { name: "../escape.json" },
    ]) expect(() => assertInventory(1, [{ ...entry, ...patch }])).toThrow();
  });
  it("validates exact raw snapshot bytes without normalizing absent keys", () => {
    expect(JSON.parse(new TextDecoder().decode(snapshotBytes(snapshot(), ["test.preference"]))))
      .toEqual(snapshot());
    for (const entries of [[], [{key:"foreign",raw:null}],
      [snapshot().entries[0]!, snapshot().entries[0]!],
      [{key:"test.preference",raw:"x".repeat(65536)}]]) {
      expect(() => snapshotBytes({...snapshot(), entries}, ["test.preference"])).toThrow();
    }
    expect(() => snapshotBytes({...snapshot(), entries:Array.from({length:129}, (_,i) =>
      ({key:`k${i}`,raw:null}))}, Array.from({length:129}, (_,i) => `k${i}`)))
      .toThrow("snapshot-limit");
  });
});
```

Run red:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop test -- src/main/plugins/persistence/import-sources.test.ts
```

Expected: missing exports, not an Electron startup error. These are plain `.test.ts` tests.

- [ ] **Step 2: Implement source evidence without opening arbitrary paths**

Append the following to the frozen declarations in `import-sources.ts`. Filesystem containment and enumeration remain T2 responsibilities; these checks validate the returned facts again. The adapter must count every candidate name before applying the UUID filter. `null` is the only trusted absent-key representation; a thrown `localStorage.getItem` never becomes `null`.

```ts
export const IMPORT_LIMITS = Object.freeze({
  candidateNames: 4096,
  items: 512,
  journalBytes: 2 * 1024 * 1024,
  batch: 64,
  recordBytes: 8 * 1024 * 1024,
  preferenceBytes: 64 * 1024,
  preferenceKeys: 128,
});
const canonicalHandle = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuidFile = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
export type InventoryFact = {
  name: string; regular: boolean; contained: boolean; links: number; bytes: number;
};
export function assertInventory(candidateCount: number, entries: readonly InventoryFact[]): void {
  if (!Number.isSafeInteger(candidateCount) || candidateCount < entries.length ||
      candidateCount > IMPORT_LIMITS.candidateNames) throw new Error("inventory-limit");
  for (const file of entries) {
    if (!uuidFile.test(file.name) || !file.regular || !file.contained || file.links !== 1 ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > IMPORT_LIMITS.recordBytes)
      throw new Error("unsafe-source");
  }
}
export function classifySourceError(error: unknown): "absent" | "blocked" {
  return error !== null && typeof error === "object" && "code" in error &&
    error.code === "ENOENT" ? "absent" : "blocked";
}
export function snapshotBytes(
  snapshot: LegacyPreferencesSnapshot, allowlist: readonly string[],
): Uint8Array {
  if (Object.keys(snapshot).sort().join(",") !== "entries,nonce,scope" ||
      !canonicalHandle.test(snapshot.nonce) ||
      Object.keys(snapshot.scope).sort().join(",") !== "hostEpoch,workbenchInstance" ||
      !canonicalHandle.test(snapshot.scope.hostEpoch) || !canonicalHandle.test(snapshot.scope.workbenchInstance))
    throw new Error("snapshot-shape");
  if (allowlist.length > IMPORT_LIMITS.preferenceKeys ||
      snapshot.entries.length > IMPORT_LIMITS.preferenceKeys) throw new Error("snapshot-limit");
  const allowed = new Set(allowlist);
  if (allowed.size !== allowlist.length || snapshot.entries.length !== allowed.size)
    throw new Error("snapshot-keys");
  const seen = new Set<string>();
  for (const entry of snapshot.entries) {
    if (Object.keys(entry).sort().join(",") !== "key,raw" ||
        !allowed.has(entry.key) || seen.has(entry.key) ||
        (entry.raw !== null && typeof entry.raw !== "string")) throw new Error("snapshot-keys");
    seen.add(entry.key);
  }
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  if (bytes.byteLength > IMPORT_LIMITS.preferenceBytes) throw new Error("snapshot-limit");
  return bytes;
}
const sameScope = (a: CoreWindowScope, b: CoreWindowScope): boolean =>
  a.hostEpoch === b.hostEpoch && a.workbenchInstance === b.workbenchInstance;

```

Run the Step 1 command again. Expected: all source/snapshot tests pass, with no filesystem or renderer side effects. The D170/V170 bridge independently validates sender scope and calls `issuePreferences` / `acceptPreferencesEvidence`; Step 6 restores evidence and barriers before startup writers. Plugins cannot issue challenges.

- [ ] **Step 3: Pin the durable journal contract and immutable plan invariants**

In `import-journal.ts`, import `ImportPlan`, `ImportPlannedItem`, `ImportItemEvidence`, `DurableImportPort`, `PublicationTicket` from `engine-port.ts`. Implement strict formatVersion-1 validation before calling `backend.imports.plan` and after `load`. Reject unknown keys/format, duplicate source keys or record IDs, mismatched target/schema/tag/owner, changed mapping version on an unfinished plan and invalid receipts. Limit IDs/item keys/skip reasons to 128/128/256 UTF-8 bytes, items to 512 and encoded journal plus evidence to 2 MiB; process at most 64 metadata items per batch. The immutable ticket fixes target, schema, expected revision and assigned record ID; retain source and mapped digests separately. Settings tickets use the committed validation digest from `backend.evidence.settingsDigest`, never a substituted current-resource digest. Reject a settings target/schema mismatch before reserve.

Implement journal operations as direct calls to the one durable adapter: `load`, `plan`, `tagImport`, `importReceipts`, `record`, `reconcile`, `complete`. Completion must verify every item has a committed receipt or an explicit durable skip, including its reason. A completed plan remains terminal after user deletion; never recreate the record. An unfinished changed mapping/schema/target is blocked. The stable import ID derives from descriptor ID and target source, excluding mappingVersion. No local encoded JSON journal replaces the adapter's atomic store.

Add the following helper to `import-journal.ts` and exercise it with actual typed adapter doubles in `import-journal.test.ts`:

```ts
import type { DurableImportPort, ImportItemEvidence, ImportPlan,
  PersistenceOwner } from "./engine-port.js";
export async function finishImport(
  imports: DurableImportPort, owner: PersistenceOwner, plan: ImportPlan,
): Promise<boolean> {
  const stored = await imports.load(owner, plan.id);
  if (!stored) throw new Error("missing-import-plan");
  if (stored.complete) return true;
  const evidence = new Map<string, ImportItemEvidence>(stored.items.map(item => [item.key, item]));
  const terminal = plan.items.every(item => {
    const result = evidence.get(item.key);
    return result?.state === "committed" && result.receipt !== null ||
      result?.state === "skipped" && result.skipReason !== null && result.skipReason.length > 0;
  });
  if (!terminal) return false;
  await imports.complete(owner, plan.id);
  return true;
}
```

```ts
import { expect, it, vi } from "vitest";
import { finishImport } from "./import-journal.js";
import type { DurableImportPort, ImportPlan, PersistenceOwner } from "./engine-port.js";
function completionCases(owner: PersistenceOwner, plan: ImportPlan, imports: DurableImportPort) {
  it("does not complete unknown or pending items", async () => {
    for (const state of ["pending", "unknown"] as const) {
      vi.spyOn(imports, "load").mockResolvedValue({plan, complete:false,
        items:plan.items.map(item => ({key:item.key,state,receipt:null,skipReason:null}))});
      const complete = vi.spyOn(imports, "complete");
      expect(await finishImport(imports, owner, plan)).toBe(false);
      expect(complete).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    }
  });
  it("preserves explicit skip evidence across completion", async () => {
    for (const item of plan.items) await imports.record(owner, plan.id,
      {key:item.key,state:"skipped",receipt:null,skipReason:"trusted-user-skip"});
    expect(await finishImport(imports, owner, plan)).toBe(true);
    const restored = await imports.load(owner, plan.id);
    expect(restored?.complete).toBe(true);
    expect(restored?.items.every(item => item.state === "skipped" &&
      item.skipReason === "trusted-user-skip")).toBe(true);
  });
}
```

Invoke `completionCases` for a nonempty plan from the test's typed backend fixture. Add exact-limit/+1 cases for all bounds, unknown format, duplicate key/ID, altered target/expected revision/mapped digest, receipt-revision mismatch and forged complete evidence. The test double implements `DurableImportPort`, including persisted snapshots, rather than accepting arbitrary callbacks.

Run red, then green after implementation:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false
pnpm --filter @kobrixa/desktop test -- src/main/plugins/persistence/import-journal.test.ts
```

Expected: tests first fail on missing durable journal operations, then pass without publishing a partial or forged plan.

- [ ] **Step 4: Implement fixed-root source and durable writer admission**

Implement `createLegacyWriterBarrier` in `import-sources.ts` with the exact AM-29 signature above. `enter` synchronously calls every matching writer's `freezeAdmission()` before its first await, persists a formatVersion-1 `barrier/<descriptorId>` document through an immutable import engine ticket, and waits for `settled()` before inventory. Failure keeps admissions frozen. `restore` enumerates only admitted descriptors via bounded `auxiliaryKeys` pages and reads `auxiliary(owner,"import",key)`; restore markers and freeze admissions before D170 starts any registered legacy writer. `complete` atomically records the terminal barrier after the durable import completion marker, is idempotent, and never thaws a completed legacy writer. Unknown outcomes reconcile the original ticket before proceeding. Persist barrier identity, sourceKey, descriptorId and original ticket; never mint a replacement for an uncertain publish.

Use `backend.sources` as the coordinator resolver. `register({descriptorId,mapperId,sourceKind})` selects the same ID in the worker-installed allowlist; the descriptor ID is the mapper ID for the synthetic fixture. It cannot transmit functions, source paths or renderer-provided roots. T2 performs bounded root inventory/read and ENOENT-only absence; permission, format and alias failures are blocked. Check source admission before registration, inventory and every mapping. Renderer evidence missing remains pending, distinct from a present snapshot whose allowlisted values are all null. Inventory contains bounded metadata, not retained file payloads; process its entries in batches of 64 and reject more than 512 items/4096 names at the resolver boundary.

In `import-sources.test.ts`, cover freeze-before-first-await, in-flight writer settlement before inventory, restart marker restoration before writer start, failure/unknown publication retaining the barrier, idempotent completion, ENOENT versus EACCES/EPERM/EIO, symlink/hardlink containment, arbitrary mapper/path rejection and disabled/safe-mode zero mapper calls. Unit tests use registered synthetic writer controls only; T7 repeats the restart cases on disk.

- [ ] **Step 5: Bind the coordinator to durable plans, original tickets and worker-local mapping**

Implement `createLegacyImportCoordinator` with exactly the AM-29 input and `LegacyImportHostPort` result, not a local operations callback interface. Capture `backend.imports`, `backend.engine`, `backend.evidence` and the supplied worker resolver. Serialize runs per descriptor and nonce submissions per scope/descriptor. The factory's restoration promise runs `barrier.restore()` plus bounded import-evidence reads; every public method awaits it before admission.

For `run`, validate the descriptor against the host allowlist and current source. Load the stable import ID first; return terminal completion without remapping or recreating deleted targets. Reconcile original tickets and inspect `importReceipts(owner,id)` before allocating anything. Compare the entire original ticket, tag, target revision and source/mapped hashes; a foreign/newer head is a conflict. Repair a missing receipt with `imports.record` only from matching atomic head evidence. Unknown reconciliation durably records `state:"unknown"` and returns blocked with the barrier retained; it never republishes. Explicit per-item skips are persisted with bounded nonempty reasons and survive restart.

For a new plan, enter the barrier before source collection. Call `sources.map(descriptor.id,key)` inside the worker; validate source format, sourceSha256, mappedSha256, byteLength and destination schema. Allocate immutable tickets using main-derived `importOwner`, preallocated target IDs, expected revisions and schema/digest metadata. Persist the complete bounded `ImportPlan` before the first publication. Release mapped pins after metadata planning, then remap one item at a time and compare both digests against the plan before reserving; the worker enforces at most four jobs and scratch quotas. A changed input blocks without modifying originals.

For each pending item, reserve its original ticket, tag it before append/seal, and transfer worker-local bytes directly in at most 256 KiB pieces. Add this complete helper to `import-coordinator.ts`:

```ts
import type { ImportPlannedItem, PersistenceBackend } from "./engine-port.js";
import type { LegacyMappedItem, LegacySourceResolver } from "./import-sources.js";
async function publishMapped(
  backend: PersistenceBackend, sources: LegacySourceResolver,
  item: ImportPlannedItem, mapped: LegacyMappedItem, signal: AbortSignal,
) {
  if (mapped.sourceSha256 !== item.sourceSha256 || mapped.mappedSha256 !== item.mappedSha256 ||
      mapped.byteLength !== item.byteLength) throw new Error("input-changed");
  await backend.engine.reserve(item.ticket, item.byteLength);
  await backend.imports.tagImport(item.ticket, item.tag);
  let offset = 0;
  let done = item.byteLength === 0;
  while (!done) {
    signal.throwIfAborted();
    const next = await sources.appendMapped({mapped:mapped.mapped, ticket:item.ticket,
      offset, maxBytes:256 * 1024});
    if (next.nextOffset <= offset || next.nextOffset > item.byteLength ||
        next.nextOffset - offset > 256 * 1024 || next.done !== (next.nextOffset === item.byteLength))
      throw new Error("mapped-offset");
    offset = next.nextOffset;
    done = next.done;
  }
  await backend.engine.seal(item.ticket, item.byteLength, item.mappedSha256);
  let outcome = await backend.engine.publish(item.ticket);
  if (outcome.disposition === "unknown") outcome = await backend.imports.reconcile(item.ticket);
  if (outcome.disposition !== "unknown") await sources.releaseMapped(mapped.mapped);
  return outcome;
}
```

The caller persists committed receipt evidence before proceeding, retains unknown pins/tickets for recovery, and aborts/reconciles the original ticket on cancellation or append/seal failure before releasing a pin. Never automatically retry `publish` on an unknown outcome. Once all items are committed/skipped call `finishImport`, then `barrier.complete`. Return pending/planned/copying/complete/complete-empty/blocked with counts from durable item evidence. Do not dispatch descriptor functions on main.

- [ ] **Step 6: Persist coordinator-issued preferences challenges and restore evidence**

Implement `issuePreferences`, `retirePreferences`, `acceptPreferencesEvidence` and the `acceptPreferences` compatibility method in the same coordinator. Issue random canonical Handle nonces only for an allowlisted renderer descriptor and a current main-derived scope. Freeze its allowlist from `rendererKeyAllowlist`. At most one outstanding challenge per scope/descriptor. Before returning the challenge persist `nonce/<nonce>` using an immutable import engine ticket and AM-26 auxiliary reads. Each document includes formatVersion, descriptorId, scope, allowlist, nonce, raw entries, digest and issued/consumed state. Keep immutable ticket identity with uncertain writes; reconcile before any replacement.

Validate exact snapshot shape/nonce/window/keys/duplicates/64 KiB/128 keys before accepting. Copy raw entries before awaiting. Persist raw evidence and its digest, reconcile unknown publication, then atomically persist consumption; never consume on validation/persistence failure. An identical durable replay may return reconciled; changed replay is rejected. Return `{state:"accepted"}` after known durable acceptance, `{state:"pending"}` while publication remains unknown, `{state:"reconciled"}` after original-ticket reconciliation. `acceptPreferences():Promise<void>` resolves only after acceptance/reconciliation; it cannot treat pending as success. Retirement invalidates old window authority without deleting durable evidence. Restart restores bytes and barriers, but a fresh bootstrap cannot replay the old window nonce.

In `import-coordinator.test.ts`, use `createLegacyImportCoordinator` with a fully typed backend/resolver/barrier and real allowlisted descriptor. Assert wrong descriptor/key/window/nonce, duplicates, extra/oversize entries, concurrent submission, same versus changed replay, failed persistence before consume and unknown publication after raw evidence. Observe the durable nonce before releasing the mocked publication promise and assert it is still issued; after success load it through `evidence.auxiliary` and assert consumed plus exact original raw bytes. Restart under a new hostEpoch, reconcile existing evidence and reject the retired nonce. An absent snapshot must never create complete-empty.

- [ ] **Step 7: Supply synthetic worker mappings and run crash/restart checks**

In `import-fixtures.ts`, export this pure synthetic descriptor; it is never registered as a product migration:

```ts
import type { LegacyImportDescriptor } from "./import-sources.js";
export const syntheticImportDescriptor: LegacyImportDescriptor = {
  id:"test.synthetic-import", mappingVersion:1, targetSourceKey:"builtin:test.synthetic",
  sourceKind:"sensor-lab", sourceFormatVersions:[1], targetRecordSchemaVersions:[1],
  validate(input) { return input.sourceKind === "sensor-lab" && input.bytes.byteLength <= 8388608; },
  map(input) {
    return {kind:"record",metadata:{kind:"test.synthetic",schemaVersion:1,
      label:"Synthetic import fixture",mediaType:"application/octet-stream",
      byteLength:input.bytes.byteLength,sha256:input.sha256},bytes:input.bytes};
  },
};
```

Implement test-local typed `PersistenceBackend`/`LegacySourceResolver` doubles in the three owned test files, recording durable snapshots and atomic tagged heads separately so a crash can lose the receipt without losing the head. Test before/after plan, publish, receipt, skip and completion-marker boundaries. Reconstruct the coordinator three times from retained backend state; require identical IDs/count/bytes, preserved skips and originals, and one committed publication per item. Include target conflict, input change, source/target version mismatch, permission failure versus absent, safe mode, user deletion after completion, 4096/4097 names, 512/513 items, 2 MiB/+1 journal, 64-item batches and 50 × 8 MiB streaming with one mapped payload pinned at a time. These are unit tests; T7's real worker-kill evidence is separately mandatory.

Run scoped green:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false
pnpm --filter @kobrixa/desktop test -- src/main/plugins/persistence/import-sources.test.ts src/main/plugins/persistence/import-journal.test.ts src/main/plugins/persistence/import-coordinator.test.ts
pnpm check:desktop
```

Expected: exact frozen contracts compile, all durable adapter/barrier/nonce tests pass, and no second filesystem store, production mapping or main-thread descriptor invocation appears in the diff.

- [ ] **Step 8: Commit the durable framework after reviewing the real-engine handoff**

Do not close B2-RF5 on these unit results. The implementation commit, executed by the future task owner, is:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git diff --check
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git add apps/desktop/src/main/plugins/persistence/import-coordinator.ts apps/desktop/src/main/plugins/persistence/import-coordinator.test.ts apps/desktop/src/main/plugins/persistence/import-journal.ts apps/desktop/src/main/plugins/persistence/import-journal.test.ts apps/desktop/src/main/plugins/persistence/import-sources.ts apps/desktop/src/main/plugins/persistence/import-sources.test.ts apps/desktop/src/main/plugins/persistence/import-fixtures.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git commit -m "feat(desktop): add bounded resumable legacy import mechanism"
```

### Task 3B2-T7: Cross-layer persistence, fault/load evidence and author documentation

**Files**

Create:

- `tests/desktop/plugin-persistence-interop.test.mjs`
- `tests/desktop/plugin-persistence-harness.mjs`
- `tests/desktop/plugin-persistence-main.ts`
- `tests/desktop/plugin-persistence-kill.test.mjs`
- `tests/desktop/plugin-persistence-load.test.mjs`
- `tests/desktop/plugin-persistence-import.test.mjs`
- `tests/desktop/plugin-persistence-run.mjs`
- `tests/desktop/fixtures/plugin-persistence/consumer.ts`
- `tests/desktop/fixtures/plugin-persistence/consumer.py`
- `tests/desktop/fixtures/plugin-persistence/kobrixa-plugin.json`
- `tests/desktop/fixtures/plugin-persistence/settings.json`
- `tests/desktop/fixtures/plugin-persistence/kill-worker.mjs`
- `tests/desktop/fixtures/plugin-persistence/import-map.ts`
- `docs/en/plugin-settings-storage.md`
- `docs/zh-TW/plugin-settings-storage.md`
- `docs/superpowers/plans/2026-10-17-plugin-system-3b2-acceptance.md`

Modify: none. The acceptance ledger transfers to T9 only after this writer stops.

Test:

- `tests/desktop/plugin-persistence-interop.test.mjs`
- `tests/desktop/plugin-persistence-kill.test.mjs`
- `tests/desktop/plugin-persistence-load.test.mjs`
- `tests/desktop/plugin-persistence-import.test.mjs`

**Interfaces**

Consumes the actual public 1.7 schemas/SDKs, the sole `PersistenceHost`, the original principal/owner, and the real A/B1 composition after P170. These exact signatures are the host boundary; no fixture API becomes a product API:

```ts
import type {
  SettingsRequestMap, StorageRequestMap, PersistenceActionRequestMap,
} from "@kobrixa/plugin-protocol";
import type { Principal, PersistenceParticipant } from "@kobrixa/plugin-runtime";
type PersistenceRequestMap = SettingsRequestMap & StorageRequestMap & PersistenceActionRequestMap;
import type { PersistenceHost } from "../../apps/desktop/src/main/plugins/persistence/host-port.js";
```

Produces SDK consumers, fail-closed evidence validators, process termination support, bilingual documentation, and a manual/automated ledger. The harness distinguishes `unit`, `real-process`, and `installed` evidence. It cannot promote a `unit` report to actual acceptance.

Preconditions: W1 authors the producer against amended F. Real acceptance follows T1–T6, T8 publication and the R170/D170/V170/K170 attachments. AM-23/27/29/30 supply the constructors; T7 implements the sole producer in its own files. D170/K170 must stop and record a named return receipt for `tests/desktop/plugin-persistence-main.ts` and `tests/desktop/plugin-persistence-run.mjs` before T7 resumes final attachment. No integration-wide write grant is created. After T7 stops, X-T1 imports the producer read-only with its commit and bundle SHA-256; defects return to T7 by another exact-path stopped-owner receipt.

Import `PersistenceHost` from T5 `host-port.ts` rather than maintaining a reduced duplicate. It includes `settings`, `recovery` and `participant`. The producer exports the exact AM-30 test-only contracts:

```ts
type FoundationCase = "contention"|"retirement"|"registration-end"|"healthy-release"|
  "disconnect-retry"|"suspend-wake"|"renderer-loss"|"sealed-ttl"|"unknown-publication"|
  "all-optional-off"|"action-replay"|"import-restart"|"storage-ui-pressure"|"compatibility"|"installed";
type CaseEvidence = {checks:Record<string,string|number|boolean|readonly string[]|readonly number[]>;
  events:Array<{kind:string;turn:number;time:number;grant?:DeviceDrainGrant|null;deadline?:number}>;
  samples:Record<string,number[]>};
interface FoundationFixture {
  composition:{profile:ProfileWriterLock;journalProfile:ProfileWriterLock;
    persistenceProfile:ProfileWriterLock;reservationListenerCount:number;workerCount:number;
    host:PersistenceHost;stage3:Stage3RuntimePorts};
  environment:{commit:string;artifact:string;artifactSha256:string;os:string;architecture:string;
    cpu:string;ramBytes:number;filesystem:string;node:string;electron:string;
    memoryMethod:string;warmCold:string};
  runCase(id:FoundationCase): Promise<CaseEvidence>;
  close(): Promise<void>;
}
```
The following IDs are **local plan labels** for the 29 rows in B2 §10, in source order; the spec itself does not name those rows. They give each probe an unambiguous assertion group. Every row also requires wire outcome, disk-tree hashes, quota ledger, handle registry, core snapshot, and reopening under a different hostEpoch. Redacted evidence contains synthetic fixture hashes and metadata, never physical user paths or raw settings values.

| ID | Concrete injection and required observation |
| --- | --- |
| B2-N01 | Omit permission; use foreign ID/handle/source override. Denied/stale; foreign disk/quota unchanged. |
| B2-N02 | Extra key, duplicate key, NaN/Infinity, boolean-as-integer, byte overflow. Invalid params/schema; no temp, watch or default replacement. |
| B2-N03 | Two settings CAS updates on one revision. Exactly one commit and one SETTINGS_CONFLICT; dirty losing field retained. |
| B2-N04 | Stale record revision, replacement overlap and delete race. STORAGE_CONFLICT; pinned old read remains one revision. |
| B2-N05 | Concurrent quota admission and real second app. Limits never exceeded; secondary exits before worker/store initialization and primary focuses. |
| B2-N06 | 256 KiB+1, bad padding/tail bits, offset gap/overlap, wrong checksum, lost chunk ack retry. No sparse/duplicated append. |
| B2-N07 | Short writes, ENOSPC, EDQUOT, EROFS, EACCES. Full loop or not-committed; preserve old head and permission evidence. |
| B2-N08 | Kill/fail seal-sync and object-rename. Old head after reopen; orphan never promoted. |
| B2-N09 | Disable/cancel/deadline before head replacement. Fence wins; later generation cannot publish old data. |
| B2-N10 | Lose reply/sync after replacement dispatch. Unknown/committed; retain both objects, fence, reconcile original ticket, zero republish. |
| B2-N11 | Unsupported directory sync versus EIO. Only unsupported yields file-sync-only; EIO remains failure. |
| B2-N12 | Cleanup unlink failure with pinned old read. Commit survives, charges remain, GC cannot unlink the pinned object. |
| B2-N13 | Expired/foreign-generation read/list and mutation during paging. Stale/conflict; no duplicate or skipped snapshot entries. |
| B2-N14 | Corrupt committed head/object and unknown format. Corrupt/version failure plus preserved backup/evidence; no empty-history fallback. |
| B2-N15 | Flush with incomplete staging, open checkpoint and unresolved publication. No saved report or implicit partial commit. |
| B2-N16 | Slow callback, full event queue, sequence gap, unsubscribe twice. Enqueue before ack before callback completion; true then false. |
| B2-N17 | Crash with payload only in plugin, receiving, and sealed. Retry only complete host-held bytes; subscriptions/reservations reclaimed. |
| B2-N18 | Hanging drain and shutdown. 10-second token, manager 4 seconds including 2-second request; blocker persists after kill. |
| B2-N19 | Original 30-second idle/120-second total expiry with repeated failed retry. No renewal or late rename. |
| B2-N20 | Renderer/window loss and provider loss. Drain without renderer cleanup; healthy nonretired consumers survive; no replay. |
| B2-N21 | Core Disconnect and suspend/wake. Stop/save before disconnect; wake never renews old work; plugin cross-owner disconnect is busy. |
| B2-N22 | Cold safe mode/all three features disabled. Core reads recovery; no optional schema, mapper, process or device activation. |
| B2-N23 | Fake/expired/replayed actionRef, invocationId substitution, dialog cancel/late return. No mutation/device lock/path leak. |
| B2-N24 | Export disk-full/destination replacement/cancel around publication. Old or whole new file, honest unknown, never unlink first. |
| B2-N25 | Clipboard permission, >64 KiB or >16,384 code points, OS failure. No copied success or other clipboard formats. |
| B2-N26 | Invalid/unknown-version import or quota exhausted. Blocked, originals intact, no marker or authority switch. |
| B2-N27 | Real kill after item head and before receipt. Three recoveries; stable IDs/count/bytes, no overwrite of newer target. |
| B2-N28 | Kill around marker, nonce replay, no renderer. No false absent; completed import remains terminal after user deletion. |
| B2-N29 | Symlink/reparse/hardlink substitution. Reject outside-root/alias access; sentinel hash unchanged. |

- [ ] **Step 1: Write evidence verifier tests before implementing the real producer**

Create `plugin-persistence-interop.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readEvidence, verifyMatrix, verifyInterop } from "./plugin-persistence-harness.mjs";

test("B2 §10: every negative row has real reopened state evidence", async () => {
  const report = await readEvidence();
  verifyMatrix(report);
});
test("B2 §12.1: JS MessagePort and Python stdio use the public 1.7 router", async () => {
  verifyInterop(await readEvidence());
});
test("evidence gates reject absent and mock-only acceptance", async () => {
  await assert.rejects(readEvidence(""), /PERSISTENCE_EVIDENCE/);
  assert.throws(() => verifyMatrix({ level: "unit", cases: [] }), /real-process/);
  assert.throws(() => verifyInterop({ consumers: [] }), /two consumers/);
});
```

Create `plugin-persistence-kill.test.mjs`:

```js
import test from "node:test";
import { readEvidence, verifyKills } from "./plugin-persistence-harness.mjs";
test("B2-RF1: actual process death at every publication frontier", async () => {
  verifyKills(await readEvidence());
});
```

Create `plugin-persistence-load.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readEvidence, verifyLoad, statistics } from "./plugin-persistence-harness.mjs";
test("B2-RF5: 50 maximum records, four jobs, bounded RSS and stop dispatch", async () => {
  verifyLoad(await readEvidence());
});
test("percentiles require thirty finite samples and retain the maximum", () => {
  assert.throws(() => statistics(Array(29).fill(1)), /30 samples/);
  assert.throws(() => statistics([...Array(29).fill(1), Infinity]), /finite/);
  assert.deepEqual(statistics(Array.from({ length: 30 }, (_, i) => i + 1)),
    { count: 30, p50: 15, p95: 29, max: 30 });
});
```

Create `plugin-persistence-import.test.mjs`:

```js
import test from "node:test";
import { readEvidence, verifyImports } from "./plugin-persistence-harness.mjs";
test("B2-RF5: actual import kill/reopen repeats preserve IDs, bytes and originals", async () => {
  verifyImports(await readEvidence());
});
```

Run red:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; node --test tests/desktop/plugin-persistence-*.test.mjs
```

Expected first failure: missing harness module. After Step 2, expected failure without a real report: `PERSISTENCE_EVIDENCE is required`. This is an acceptance gate, not a test to skip when Electron is unavailable.

- [ ] **Step 2: Implement the evidence assertions with exact budgets and failure vocabulary**

Create `plugin-persistence-harness.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

export const FAULT_POINTS = Object.freeze([
  "reserve", "open-temp", "chunk-write", "seal-sync", "object-rename", "object-dir-sync",
  "backup-head", "head-write", "before-publish", "after-publish", "head-dir-sync",
  "cache-publish", "receipt-send", "cleanup", "import-marker",
]);
export const MATRIX_IDS = Object.freeze(Array.from({ length: 29 }, (_, i) =>
  `B2-N${String(i + 1).padStart(2, "0")}`));
const OUTCOMES = [
  ["PLUGIN_E_PERMISSION_DENIED", "PLUGIN_E_STALE_RESOURCE"],
  [-32602, "PLUGIN_E_SETTINGS_SCHEMA"], ["PLUGIN_E_SETTINGS_CONFLICT"],
  ["PLUGIN_E_STORAGE_CONFLICT"], ["PLUGIN_E_STORAGE_QUOTA", "secondary-exited"],
  [-32602, "PLUGIN_E_STORAGE_CONFLICT"], ["PLUGIN_E_SETTINGS_SAVE", "PLUGIN_E_STORAGE_IO"],
  ["not-committed"], [-32800, "PLUGIN_E_STALE_RESOURCE", "checkpoint-only"],
  ["unknown", "committed"], ["file-sync-only", "PLUGIN_E_STORAGE_IO"], ["committed"],
  ["PLUGIN_E_STALE_RESOURCE", "PLUGIN_E_STORAGE_CONFLICT", "snapshot"],
  ["PLUGIN_E_STORAGE_IO", "PLUGIN_E_STORAGE_VERSION"], ["PLUGIN_E_STORAGE_CONFLICT", "timeout"],
  ["resynchronized"], ["checkpoint-only", "retryable"], ["blocker"], ["checkpoint-only"],
  ["drained", "blocker"], ["drained", "blocker"], ["core-only"],
  ["PLUGIN_E_PERMISSION_DENIED", "PLUGIN_E_STALE_RESOURCE", "cancelled"],
  ["PLUGIN_E_STORAGE_IO", "unknown", "committed"],
  ["PLUGIN_E_PERMISSION_DENIED", -32602, "PLUGIN_E_STORAGE_IO"],
  ["blocked"], ["resumed"], ["pending", "complete"], ["rejected"],
];
export async function readEvidence(file = process.env.PERSISTENCE_EVIDENCE) {
  assert.ok(file, "PERSISTENCE_EVIDENCE is required; no automatic acceptance without real evidence");
  const value = JSON.parse(await readFile(file, "utf8"));
  assert.equal(value.format, 1);
  return value;
}
function hash(value) { assert.match(value, /^[0-9a-f]{64}$/); }
function identity(value) { assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); }
function reopened(item) {
  identity(item.before.hostEpoch); identity(item.after.hostEpoch);
  assert.notEqual(item.before.hostEpoch, item.after.hostEpoch);
  for (const stage of [item.before, item.after]) {
    hash(stage.diskTreeHash);
    assert.equal(stage.quota.recordCount + stage.quota.reservedCreates <= 256, true);
    assert.equal(stage.quota.committedBytes + stage.quota.reservedBytes <= 536870912, true);
    assert.equal(stage.quota.hostCommittedBytes + stage.quota.hostReservedBytes <= 1073741824, true);
    assert.equal(stage.quota.sourceStaging <= 2 && stage.quota.hostStaging <= 16, true);
    assert.equal(stage.quota.sourceExports <= 1 && stage.quota.hostExports <= 4, true);
    assert.equal(stage.quota.sourceTemporaryBytes <= 33554432, true);
    assert.equal(stage.quota.hostTemporaryBytes <= 134217728, true);
    assert.equal(stage.quota.sourceMetadataBytes <= 4194304, true);
    assert.equal(stage.quota.hostMetadataBytes <= 67108864, true);
    assert.ok(Array.isArray(stage.handles));
    assert.ok(Array.isArray(stage.core.records));
    assert.ok(Array.isArray(stage.core.errors));
  }
  for (const old of item.before.handles) assert.ok(!item.after.handles.includes(old));
}
export function verifyMatrix(report) {
  assert.equal(report.level, "real-process", "matrix evidence must be real-process");
  assert.deepEqual(report.cases.map((entry) => entry.id).sort(), MATRIX_IDS);
  for (const [index, id] of MATRIX_IDS.entries()) {
    const entry = report.cases.find((candidate) => candidate.id === id);
    assert.ok(OUTCOMES[index].includes(entry.outcome), `${id}: unexpected outcome`);
    assert.ok(entry.assertions.length > 0, `${id}: no concrete assertions`);
    for (const check of entry.assertions) {
      assert.equal(typeof check.name, "string");
      assert.deepEqual(check.actual, check.expected, `${id}: ${check.name}`);
    }
    reopened(entry);
  }
  const get = (id) => report.cases.find((entry) => entry.id === id);
  assert.equal(get("B2-N01").foreignBeforeHash, get("B2-N01").foreignAfterHash);
  assert.equal(get("B2-N02").newTemporaryFiles, 0);
  assert.equal(get("B2-N02").watchEvents, 0);
  assert.equal(get("B2-N03").successfulCommits, 1);
  assert.equal(get("B2-N03").conflictingCommits, 1);
  assert.equal(get("B2-N05").secondaryStoreInitializations, 0);
  assert.equal(get("B2-N05").secondaryWorkerInitializations, 0);
  assert.equal(get("B2-N05").primaryFocusCount, 1);
  assert.equal(get("B2-N10").republishCount, 0);
  assert.equal(get("B2-N10").reconciledCommitId, get("B2-N10").originalCommitId);
  assert.equal(get("B2-N11").unsupportedDurability, "file-sync-only");
  assert.equal(get("B2-N11").eioReason, "sync-failed");
  assert.equal(get("B2-N12").pinnedObjectDeleted, false);
  assert.deepEqual(get("B2-N16").unsubscribeRemoved, [true, false]);
  assert.ok(get("B2-N16").validatedAt <= get("B2-N16").enqueuedAt);
  assert.ok(get("B2-N16").enqueuedAt <= get("B2-N16").ackedAt);
  assert.ok(get("B2-N16").ackedAt < get("B2-N16").callbackFinishedAt);
  assert.equal(get("B2-N18").drainDeadlineMs, 10000);
  assert.equal(get("B2-N18").managerBudgetMs, 4000);
  assert.equal(get("B2-N19").originalExpiry, get("B2-N19").expiryAfterRetry);
  assert.equal(get("B2-N20").nonRetiredGenerationBefore, get("B2-N20").nonRetiredGenerationAfter);
  assert.ok(get("B2-N21").stopConfirmedAt <= get("B2-N21").disconnectAt);
  assert.ok(get("B2-N21").saveConfirmedAt <= get("B2-N21").disconnectAt);
  assert.equal(get("B2-N21").wakeReplayCount, 0);
  for (const key of ["optionalSchemaReads", "mapperCalls", "pluginLaunches", "deviceConnects"])
    assert.equal(get("B2-N22")[key], 0);
  assert.equal(get("B2-N23").destinationMutations, 0);
  assert.equal(get("B2-N23").deviceLocks, 0);
  assert.equal(get("B2-N24").unlinkBeforeReplace, false);
  assert.equal(get("B2-N25").clipboardReads, 0);
  assert.equal(get("B2-N25").otherFormatsWritten, 0);
  assert.equal(get("B2-N26").completeMarker, false);
  assert.equal(get("B2-N29").sentinelBeforeHash, get("B2-N29").sentinelAfterHash);
}
export function verifyInterop(report) {
  assert.equal(report.consumers?.length, 2, "two consumers required");
  assert.deepEqual(report.consumers.map((entry) => entry.transport).sort(), ["message-port", "stdio"]);
  const required = ["settings/read", "settings/watch", "settings/update", "storage/beginWrite",
    "storage/writeChunk", "storage/sealWrite", "storage/commitWrite", "storage/list",
    "storage/openRead", "storage/readChunk", "storage/closeRead", "storage/flush",
    "events/unsubscribe", "storage/exportBegin", "ui/copyText", "storage/drain"];
  for (const consumer of report.consumers) {
    assert.equal(consumer.apiVersion, "1.7.0");
    assert.equal(consumer.privateServiceCalls, 0);
    assert.equal(consumer.exitCode, 0);
    for (const method of required) assert.ok(consumer.methods.includes(method), method);
    assert.equal(consumer.settingsConflict, "PLUGIN_E_SETTINGS_CONFLICT");
    assert.equal(consumer.drained, "saved");
    assert.notEqual(consumer.callbackResult, "saved");
    assert.equal(consumer.recordBeforeHash, consumer.recordAfterHash);
    assert.equal(consumer.foreignOwnerAccepted, false);
  }
  for (const version of ["1.4.0", "1.5.0", "1.6.0"]) {
    const legacy = report.negotiation.find((entry) => entry.version === version);
    assert.ok(legacy);
    assert.equal(legacy.commandSucceeded, true);
    assert.deepEqual(legacy.persistenceDeliveries, []);
  }
  assert.equal(report.unregistered17DrainCallbacks, 0);
}
export function verifyKills(report) {
  assert.equal(report.level, "real-process");
  assert.deepEqual([...new Set(report.kills.map((entry) => entry.point))].sort(), [...FAULT_POINTS].sort());
  for (const entry of report.kills) {
    assert.equal(entry.pauseAcknowledged, true);
    assert.equal(entry.exitCode === 0, false);
    if (entry.termination === "worker-terminate") {
      assert.ok(Number.isSafeInteger(entry.workerId) && entry.workerId > 0);
      assert.notEqual(entry.workerId, entry.reopenedWorkerId);
      assert.ok(entry.trace.some(row => row.point === entry.point));
      assert.equal(entry.exitObserved, true);
    } else {
      assert.ok(Number.isSafeInteger(entry.pid) && entry.pid > 0);
      assert.ok(entry.signal === "SIGKILL" || entry.platformTermination === "taskkill-/T-/F");
      assert.notEqual(entry.pid, entry.reopenedPid);
    }
    reopened(entry);
    assert.ok([entry.oldHeadHash, entry.newHeadHash].includes(entry.after.headHash));
    assert.equal(entry.partialVisible, false);
    if (["after-publish", "head-dir-sync", "cache-publish", "receipt-send"].includes(entry.point)) {
      assert.equal(entry.republishCount, 0);
      assert.equal(entry.originalCommitId, entry.reconciledCommitId);
    }
  }
}
export function statistics(samples) {
  assert.equal(samples.length, 30, "30 samples required");
  assert.ok(samples.every((value) => Number.isFinite(value) && value >= 0), "finite samples required");
  const sorted = [...samples].sort((a, b) => a - b);
  return { count: 30, p50: sorted[14], p95: sorted[28], max: sorted[29] };
}
export function verifyLoad(report) {
  const load = report.load;
  for (const field of ["os", "architecture", "cpu", "ram", "filesystem", "artifact", "commit", "node", "electron"])
    assert.ok(typeof load.environment[field] === "string" && load.environment[field].length > 0, field);
  assert.equal(load.records, 50); assert.equal(load.recordBytes, 8388608);
  assert.equal(load.stagingRecords, 2); assert.equal(load.liveLogicalBytes, 436207616);
  assert.equal(load.jobs, 4); assert.equal(load.settingsKeys, 128); assert.equal(load.settingsBytes, 65536);
  assert.equal(load.visibleFields, 16); assert.equal(load.chunkBytes, 262144);
  for (const [name, limit] of [["draftMs", 50], ["pageMs", 100], ["warmListMs", 200], ["extraStopDispatchMs", 50]])
    assert.ok(statistics(load[name]).p95 <= limit, `${name}: p95 exceeded ${limit}`);
  assert.ok(statistics(load.mainSyncSegmentMs).max <= 16);
  assert.ok(statistics(load.commitMs).max <= 10000);
  assert.ok(statistics(load.flushMs).max <= 10000);
  assert.ok(load.peakMainAddedRss <= 33554432);
  assert.ok(load.peakWorkerAddedRss <= 67108864);
  assert.equal(load.rssMethod, "separate-process-baseline-and-peak");
  assert.equal(load.coldWarmSeparated, true);
  assert.ok(load.pendingJobs <= 32 && load.pendingSerializedBytes <= 8388608);
  assert.ok(load.sourcePendingSerializedBytes <= 1048576);
  assert.ok(load.sourceMetadataCacheBytes <= 524288 && load.hostMetadataCacheBytes <= 8388608);
  assert.ok(load.minimumFreeBytes >= 16777216);
  assert.equal(load.claimsPhysicalStopLatency, false);
}
export function verifyImports(report) {
  const imports = report.imports;
  assert.equal(imports.records, 50); assert.equal(imports.recordBytes, 8388608);
  assert.deepEqual(imports.points, ["before-publish", "after-publish", "before-receipt", "after-receipt",
    "before-marker", "after-marker"]);
  for (const trial of imports.trials) {
    assert.ok(imports.points.includes(trial.point));
    assert.equal(trial.actualProcessDeath, true);
    assert.ok(trial.reopens.length >= 3);
    const first = trial.reopens[0];
    for (const attempt of trial.reopens) {
      assert.equal(attempt.count, 50);
      assert.equal(attempt.bytes, 419430400);
      assert.deepEqual(attempt.ids, first.ids);
      assert.deepEqual(attempt.hashes, first.hashes);
      assert.equal(attempt.originalsHash, trial.originalsHash);
      assert.equal(attempt.completeMarker, true);
      assert.equal(attempt.republishCount, 0);
    }
  }
  assert.deepEqual([...new Set(imports.trials.map((trial) => trial.point))].sort(), [...imports.points].sort());
  assert.equal(imports.deletedRecordRecreated, false);
  assert.equal(imports.pendingRendererMarkedEmpty, false);
  assert.equal(imports.maxBatch <= 64, true);
  assert.equal(imports.maxCandidateNames <= 4096, true);
  assert.equal(imports.maxJournalItems <= 512, true);
  assert.equal(imports.maxJournalBytes <= 2097152, true);
}
```

Run the same Node command. The percentile test and mock-rejection test pass; actual acceptance deliberately remains red until there is an authentic report. Do not synthesize a passing report from the expected constants.

- [ ] **Step 3: Create executable public-SDK fixtures for settings/CAS/chunks/readback**

Create `fixtures/plugin-persistence/settings.json`:

```json
{
  "schemaVersion": 1,
  "title": { "en": "Persistence fixture", "zh-TW": "持久化測試" },
  "fields": [
    { "key": "fixture.enabled", "label": { "en": "Enabled", "zh-TW": "啟用" }, "type": "boolean", "default": false }
  ]
}
```

Create `fixtures/plugin-persistence/kobrixa-plugin.json`:

```json
{
  "id": "test.persistence",
  "version": "1.0.0",
  "apiVersion": "^1.7.0",
  "runtime": { "kind": "node", "entry": "consumer.cjs" },
  "activationEvents": ["onCommand:test.persistence.run"],
  "permissions": ["ui.notifications", "settings.read", "settings.write", "storage.read", "storage.write", "storage.export", "ui.clipboard"],
  "contributes": {
    "commands": [{ "id": "test.persistence.run", "title": { "en": "Run persistence fixture", "zh-TW": "執行持久化測試" } }],
    "settings": { "version": 1, "path": "settings.json" }
  }
}
```

Create `fixtures/plugin-persistence/consumer.ts`:

```ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { definePlugin, runPlugin } from "@kobrixa/plugin-sdk";
const value = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("fixture business failure");
  return result.value;
};
void runPlugin(definePlugin({
  activate(ctx) {
    ctx.commands.register("test.persistence.run", async () => {
      const initial = value(await ctx.settings.read({ schemaVersion: 1 }));
      const watch = value(await ctx.settings.watch({ schemaVersion: 1 }));
      const updated = value(await ctx.settings.update({ schemaVersion: 1,
        expectedRevision: initial.revision, changes: [{ key: "fixture.enabled", value: true }] }));
      const conflict = await ctx.settings.update({ schemaVersion: 1,
        expectedRevision: initial.revision, changes: [{ key: "fixture.enabled", value: false }] });
      assert.equal(conflict.ok, false);
      if (!conflict.ok) assert.equal(conflict.error.code, "PLUGIN_E_SETTINGS_CONFLICT");
      assert.notEqual(updated.snapshot.revision, initial.revision);
      const bytes = Buffer.alloc(262144, 0x61);
      const digest = createHash("sha256").update(bytes).digest("hex");
      const write = value(await ctx.storage.beginWrite({ target: { mode: "create" },
        kind: "test.fixture", schemaVersion: 1, label: "Synthetic record",
        mediaType: "application/octet-stream", byteLength: bytes.length, sha256: digest }));
      value(await ctx.storage.writeChunk({ write: write.write, offset: 0, data: bytes.toString("base64") }));
      value(await ctx.storage.sealWrite({ write: write.write }));
      const committed = value(await ctx.storage.commitWrite({ write: write.write }));
      const duplicate = value(await ctx.storage.commitWrite({ write: write.write }));
      assert.deepEqual(duplicate.receipt, committed.receipt);
      const list = value(await ctx.storage.list({ kind: "test.fixture", limit: 1 }));
      assert.equal(list.entries.length, 1);
      const read = value(await ctx.storage.openRead({ id: committed.record.id,
        expectedRevision: committed.record.revision, schemaVersion: 1 }));
      const chunk = value(await ctx.storage.readChunk({ read: read.read, offset: 0, maxBytes: 262144 }));
      assert.equal(createHash("sha256").update(Buffer.from(chunk.data, "base64")).digest("hex"), digest);
      assert.equal(chunk.eof, true);
      value(await ctx.storage.closeRead({ read: read.read }));
      value(await ctx.storage.flush({}));
      assert.equal(value(await ctx.settings.unwatch({ subscriptionId: watch.subscriptionId })).removed, true);
      assert.equal(value(await ctx.settings.unwatch({ subscriptionId: watch.subscriptionId })).removed, false);
    });
  },
  async drain({ request, storage }) {
    assert.equal(request.checkpoints.length, 0);
    value(await storage.flush({}));
    return { ok: true, value: { status: "submitted", writes: [] } };
  },
})).catch(() => { process.exitCode = 1; });
```

Create `fixtures/plugin-persistence/consumer.py`:

```python
import base64
import hashlib
from kobrixa import Plugin

plugin = Plugin()

def value(result):
    assert result["ok"] is True, "fixture business failure"
    return result["value"]

@plugin.command("test.persistence.run")
async def run(ctx):
    initial = value(await ctx.settings.read({"schemaVersion": 1}))
    watch = value(await ctx.settings.watch({"schemaVersion": 1}))
    updated = value(await ctx.settings.update({"schemaVersion": 1,
        "expectedRevision": initial["revision"], "changes": [{"key": "fixture.enabled", "value": True}]}))
    conflict = await ctx.settings.update({"schemaVersion": 1,
        "expectedRevision": initial["revision"], "changes": [{"key": "fixture.enabled", "value": False}]})
    assert conflict["ok"] is False
    assert conflict["error"]["code"] == "PLUGIN_E_SETTINGS_CONFLICT"
    assert updated["snapshot"]["revision"] != initial["revision"]
    data = b"a" * 262144
    digest = hashlib.sha256(data).hexdigest()
    write = value(await ctx.storage.begin_write({"target": {"mode": "create"}, "kind": "test.fixture",
        "schemaVersion": 1, "label": "Synthetic record", "mediaType": "application/octet-stream",
        "byteLength": len(data), "sha256": digest}))
    value(await ctx.storage.write_chunk({"write": write["write"], "offset": 0,
        "data": base64.b64encode(data).decode("ascii")}))
    value(await ctx.storage.seal_write({"write": write["write"]}))
    committed = value(await ctx.storage.commit_write({"write": write["write"]}))
    duplicate = value(await ctx.storage.commit_write({"write": write["write"]}))
    assert duplicate["receipt"] == committed["receipt"]
    records = value(await ctx.storage.list({"kind": "test.fixture", "limit": 1}))
    assert len(records["entries"]) == 1
    read = value(await ctx.storage.open_read({"id": committed["record"]["id"],
        "expectedRevision": committed["record"]["revision"], "schemaVersion": 1}))
    chunk = value(await ctx.storage.read_chunk({"read": read["read"], "offset": 0, "maxBytes": 262144}))
    assert hashlib.sha256(base64.b64decode(chunk["data"], validate=True)).hexdigest() == digest
    assert chunk["eof"] is True
    value(await ctx.storage.close_read({"read": read["read"]}))
    value(await ctx.storage.flush({}))
    assert value(await ctx.settings.unwatch({"subscriptionId": watch["subscriptionId"]}))["removed"] is True
    assert value(await ctx.settings.unwatch({"subscriptionId": watch["subscriptionId"]}))["removed"] is False

@plugin.drain
async def drain(ctx):
    assert len(ctx.request["checkpoints"]) == 0
    value(await ctx.storage.flush({}))
    return {"ok": True, "value": {"status": "submitted", "writes": []}}

plugin.run()
```

The fixtures use only public SDK objects and canonical wire keys. The drain context is the AM-31 `{request, signal, storage}` JS / `{request, storage}` Python shape. A later fixture invocation must supply a real B1 actionRef for export/copy; activation itself cannot mint one. The interop gate deliberately requires the additional action traces before it passes.

Create `fixtures/plugin-persistence/import-map.ts`:

```ts
import type { LegacyImportDescriptor } from "../../../../apps/desktop/src/main/plugins/persistence/import-sources.js";
export const syntheticImport: LegacyImportDescriptor = {
  id: "test.persistence.import", mappingVersion: 1,
  targetSourceKey: "builtin:test.persistence", sourceKind: "sensor-lab",
  sourceFormatVersions: [1], targetRecordSchemaVersions: [1],
  validate: (input) => input.sourceKind === "sensor-lab" && input.bytes.byteLength <= 8388608,
  map: (input) => ({ kind: "record", bytes: input.bytes, metadata: {
    kind: "test.synthetic", schemaVersion: 1, label: "Synthetic import",
    mediaType: "application/octet-stream", byteLength: input.bytes.byteLength, sha256: input.sha256,
  } }),
};
```

- [ ] **Step 4: Implement real child termination and bounded process transport support**

Implement `terminateAtBoundary` below in `plugin-persistence-main.ts` for actual child process exit evidence. A kill is permitted only after the real worker control acknowledges its exact paused fault point. Use `PersistenceFaultControl.terminate()` for the worker; the helper below supervises whole-app kill trials and records actual OS exit. Do not infer a worker PID from the main process.

```js
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
export async function terminateAtBoundary(child, evidence) {
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0);
  assert.equal(evidence.pid, child.pid);
  assert.equal(evidence.paused, true);
  assert.equal(typeof evidence.point, "string");
  assert.equal(child.exitCode, null);
  const exited = once(child, "exit");
  let platformTermination;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    const [code] = await once(killer, "exit");
    assert.equal(code, 0);
    platformTermination = "taskkill-/T-/F";
  } else {
    assert.equal(child.kill("SIGKILL"), true);
  }
  let timer;
  try {
    const [exitCode, signal] = await Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("killed child did not exit within 5 seconds")), 5000);
    })]);
    assert.notEqual(exitCode, 0);
    return { pid: child.pid, point: evidence.point, pauseAcknowledged: true,
      exitCode, signal, ...(platformTermination ? { platformTermination } : {}) };
  } finally { clearTimeout(timer); }
}
```

In the same `plugin-persistence-main.ts`, implement the following actual transport primitives. The producer attaches the official runtime router and immutable AM-01 channel owner before initialize, and waits through initialized → initial-binding → ready. Transport errors are fatal evidence, not a reason to retry a mutation.

```ts
import { utilityProcess, MessageChannelMain } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ContentLengthDecoder, encodeContentLength, RpcPeer, RpcError, RPC_ERRORS,
  type MessageChannelLike } from "@kobrixa/plugin-protocol";

export function launchJs(entry: string, cwd: string) {
  const child = utilityProcess.fork(entry, [], { cwd, stdio: "pipe", serviceName: "Persistence acceptance" });
  const { port1, port2 } = new MessageChannelMain();
  const channel: MessageChannelLike = {
    send: (text) => port1.postMessage(text),
    onMessage(listener) {
      const onMessage = (event: Electron.MessageEvent) => listener(typeof event.data === "string" ? event.data : "");
      port1.on("message", onMessage);
      return () => port1.off("message", onMessage);
    },
  };
  port1.start();
  const peer = new RpcPeer(channel);
  const ready = new Promise<void>((resolve, reject) => {
    let expired = false;
    const timeout = setTimeout(() => {
      expired = true; child.kill(); port1.close(); port2.close();
      reject(new Error("JS consumer spawn timeout"));
    }, 10000);
    child.once("spawn", () => {
      if (expired) { child.kill(); return; }
      clearTimeout(timeout);
      child.postMessage("kobrixa-plugin-port", [port2]);
      resolve();
    });
    child.once("exit", (code) => {
      expired = true; clearTimeout(timeout);
      reject(new Error(`JS consumer exited ${code}`));
    });
  });
  const dispose = () => { peer.close(); port1.close(); child.kill(); };
  return { child, peer, ready, dispose };
}
export function launchPython(interpreter: string, entry: string, sdkRoot: string) {
  const child: ChildProcessWithoutNullStreams = spawn(interpreter, [entry], {
    stdio: "pipe", env: { ...process.env, PYTHONPATH: sdkRoot, PYTHONUNBUFFERED: "1" },
  });
  const decoder = new ContentLengthDecoder();
  const listeners = new Set<(text: string) => void>();
  const channel: MessageChannelLike = {
    send(text) { child.stdin.write(encodeContentLength(text)); },
    onMessage(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const peer = new RpcPeer(channel);
  child.stdout.on("data", (chunk: Buffer) => {
    try { for (const text of decoder.push(chunk)) for (const listener of listeners) listener(text); }
    catch { peer.close(new RpcError(RPC_ERRORS.connectionClosed, "Invalid Python frame")); child.kill(); }
  });
  // Drain stderr without accumulating unbounded diagnostic output.
  child.stderr.on("data", () => {});
  child.once("exit", () => peer.close());
  const ready = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve); child.once("error", reject);
  });
  return { child, peer, ready, dispose() { peer.close(); child.kill(); } };
}
```

Neither this helper nor its callers may install a private `settings` test service on the peer. Only the real runtime router may handle the public requests. `launchJs` is **controller runs outside sandbox**; Python process tests also require the controller-selected interpreter, and a missing interpreter is pending/failed, never a passed parity test.

- [ ] **Step 5: Implement the real producer, all fifteen cases and its executable runner**

Implement `createFoundationFixture():Promise<FoundationFixture>` and `runPersistenceAcceptance` in `plugin-persistence-main.ts`. Keep the preceding real transport helpers; build consumers and this entry with the existing esbuild dependency. Bundle the owned `kill-worker.mjs` and the T6 synthetic descriptor into the worker test entry. The wrapper source is:

```js
import { runPersistenceWorker } from "../../../../apps/desktop/src/main/plugins/persistence/worker.ts";
import { syntheticImportDescriptor } from "../../../../apps/desktop/src/main/plugins/persistence/import-fixtures.ts";
runPersistenceWorker({mappers:new Map([[syntheticImportDescriptor.id, syntheticImportDescriptor]])});
```

The private test launch supplies fixed synthetic source roots; product launch has no real Lab/device mappings. `import-map.ts` re-exports this same synthetic descriptor, never a second mapping implementation. The production-path/installed case uses K170 `persistenceWorkerPath({packaged,resourcesPath,buildRoot})` and its actual packaged worker artifact. The import fault case uses the bundled wrapper with the same worker runner, backend and fault controller.

Construct the fixture in this order inside the no-argument factory, using local test configuration resolved from its built artifact and a fresh temporary userData directory:

1. Acquire the actual primary `ProfileWriterLock` once. Build the real journal, authority, operation gate and `createCoreActionLedger({now,current})` using D150's implementations and one validated test window scope. Pass the same lock to journal, broker and persistence. Keep monotonic deadline time separate from aligned diagnostic timestamps.
2. Call `createDesktopFoundation` with `profile, authority, journal, coreActions, now, hasPermission, requirements, connectionPolicy, operationGate` and `providerFactory(catalog)` returning `createFakeDeviceProvider({catalog,now}).provider`; retain its real `control`. The provider is test-only and goes through real broker arbitration, authority, stop and readback. Do not substitute `DeviceIntentPort`.
3. Open the root and start the worker with the exact calls below. Capture `PersistenceFaultControl` through `testControl`; fail construction if it was not delivered. Require `recovery === "ready"` for writable cases; corrupt/unknown-format cases exercise blocked read-only startup explicitly. The single backend supplies reads, imports, evidence, output, destinations and sources.
4. Construct source admission from the real installed static catalog/registry, including safe-mode gating before resource reads. Use `createLegacyWriterBarrier({backend,writers,importOwner})` then `createLegacyImportCoordinator({backend,sources:backend.sources,barrier,descriptors,currentScope,currentSource,importOwner})`. Restore barriers before starting synthetic writer controls. `importOwner` is main-issued and does not activate a feature process.
5. Call `createPersistenceHost` exactly as below using the real broker reservation port, existing B1 feature action ledger and D150 core ledger. D170 action adapter uses native save/clipboard with `backend.destinations.register({action,scope,nativePath,deadlineMonotonicMs})`, and `backend.output` performs actual writes. Dialog cancellation/identity swap trials control the test window/native destination, not a fake successful output callback.
6. Attach `host.participant` to the real R170 `Stage3RuntimePorts`, preserving device/UI members; attach the paired `Stage3HostAttachment` to the real manager and original peer drain dispatcher. Use the single B1 reservation-ended listener. Mount the real D170 settings bridge, V170 contributed form and `attachSettingsControls` retry/reload/field map. Open a real BrowserWindow and drive trusted input through the same IPC sender validation. Launch JS/Python consumers with actual typed clients. No private settings/storage responder is installed.
7. Subscribe to AM-22 `diagnosticsFor(instance)` from ui-state, ui-lifecycle, ui-bridge, state-store, host-ports and the worker. Sum only disjoint counters; capture actual apply/revoke/stop-dispatch events, clocks/uncertainty, RSS baselines/peaks and post-GC retained heap separately. Environment values come from the actual process, OS/filesystem and built artifact SHA-256. `close` drains host/backend, exits consumers/window, disposes foundation/journal and releases the original lock last, even on failure; assert zero live owned resources afterward.

The constructor fragments use only the frozen factory inputs; variables are the local instances constructed in the numbered steps:

```ts
const root = await openStoreRoot({userData, profile});
let fault: PersistenceFaultControl | undefined;
const started = await startPersistenceWorker({profile, root, workerEntry, now,
  testControl(control) { fault = control; }});
if (!fault) throw new Error("worker fault control missing");
const backend = started.backend;
const barrier = createLegacyWriterBarrier({backend, writers, importOwner});
await barrier.restore();
const imports = createLegacyImportCoordinator({backend, sources:backend.sources, barrier,
  descriptors, currentScope, currentSource, importOwner});
const host = await createPersistenceHost({profile,
  composition:{backend, sources, events:foundation.broker.events, dispatchDrain, imports},
  reservations, actions, actionAdapter, coreActions, now, hasPermission});
```

Export the case inventory next to the frozen types:

```ts
export const FOUNDATION_CASES = [
  "contention", "retirement", "registration-end", "healthy-release", "disconnect-retry",
  "suspend-wake", "renderer-loss", "sealed-ttl", "unknown-publication", "all-optional-off",
  "action-replay", "import-restart", "storage-ui-pressure", "compatibility", "installed",
] as const satisfies readonly FoundationCase[];
```

`createFoundationFixture` returns the actual shared instances in `composition`: `profile`, `journalProfile` and `persistenceProfile` reference that same lock, `reservationListenerCount` and `workerCount` come from observed live instances, `host` is the created PersistenceHost and `stage3` is the manager's attached port bundle. Copy neither hosts nor locks into alternative wrappers. Implement a closed `Record<FoundationCase,()=>Promise<CaseEvidence>>` dispatch table in the producer. Each function performs the indicated live action and derives its checks/events/samples from observed results; assertions remain in X-T1. Use no table of expected evidence or imports from X-T1.

| Case | Live execution and evidence source |
| --- | --- |
| contention | Two actual consumers contend for the same broker channel while checkpoint publication is paused; capture owner, arbitration denial, original grant and worker trace. |
| retirement | Retire source generation during pending write; record synchronous revoke, original bounded drain, stale-handle responses and cleanup counters. |
| registration-end | Pause checkpoint registration, end reservation in that interval, then release; capture one listener, original grant/deadline and durable final-save result. |
| healthy-release | Release one consumer's reservation; record no retirement/restart of the healthy consumer and continued valid traffic on its original generation. |
| disconnect-retry | Trusted core Disconnect with injected save failure, then retry through real recovery option; capture stop/readback/save/disconnect ordering and no premature Disconnect. |
| suspend-wake | Trigger real lifecycle suspend path with admitted work, then wake; record bounded stop/drain and zero replay or deadline renewal. |
| renderer-loss | Destroy the actual window mid-intent/write; capture main-driven revoke/drain and resource reclamation without renderer cleanup. |
| sealed-ttl | Seal payload, fail publication, advance the test monotonic clock across original TTL and retry; capture retained payload and unchanged expiry until cleanup. |
| unknown-publication | Pause/kill at after-publish, reopen the same root under a fresh hostEpoch; reconcile original ticket and record commit ID/hash with zero republish. |
| all-optional-off | Cold boot with every optional source disabled/safe mode; inspect core recovery and counters proving no optional resource read, mapping, launch or device connection. |
| action-replay | Two overlapping trusted invocations, wrong/expired/replayed refs and retired window; execute real export/copy attempts and record rejections and unchanged destination. |
| import-restart | Run 50 maximum synthetic records; kill around head/receipt/skip/marker boundaries; reopen three times and collect IDs/bytes/hash/skip/marker and untouched original hashes. |
| storage-ui-pressure | Four actual worker jobs, 50 maximum records, real renderer edits/pages and broker fake-provider telemetry; collect 30 cold/warm timing samples, queue quotas, RSS and stop-dispatch deltas. |
| compatibility | Execute real JS/Python 1.4/1.5/1.6 consumers and unregistered 1.7 drain case; collect negotiation/results and zero unauthorized persistence traffic. |
| installed | Launch built installed artifact without checkout/PATH fallback; hash executable/worker/resources, run SDK traffic and dispose to zero resources. |

Implement the 29 B2-N probes from the existing table in the same producer, sharing these live cases and setup, not their expected results. Before/after each fault read actual namespace quota, head/object hashes, handles and core recovery state; reopen under a different hostEpoch. Run kills at every `FAULT_POINTS` boundary using `fault.arm(point,"pause")`, start the real operation, `await fault.reached(point)`, capture `fault.trace()`, then `await fault.terminate()`. Observe worker exit and restart via `startPersistenceWorker` on the same root. Also run `arm(point,"fail")` for I/O failures and `release(point)` for controlled races. Record actual worker/process IDs and exit evidence; use `verifyKills`'s worker-terminate branch for actual worker-thread termination evidence, never fabricate SIGKILL for it. Whole-app process-kill rows retain the OS exit assertions.

Map logical import before/after-receipt to the import evidence ticket's reserve/receipt-send trace and before/after-marker to import-marker/receipt-send, distinguishing target ticket IDs; never invent fault-point enum members. Persist and recover explicit skip evidence as a separate trial. Reopened evidence comes from backend reads and the original durable tickets, not from cached pre-kill result objects.

`runPersistenceAcceptance` executes every B2-N row, both consumers, all fault points and all fifteen cases, projects actual observations into the existing `{format:1,level:"real-process",cases,consumers,negotiation,kills,load,imports}` report, adds `foundation` case results, producer bundle hash and environment, runs all five verifier functions and writes only after they pass. Keep the frozen FoundationFixture environment (`ramBytes`) intact; the legacy load report's `ram` string is derived from that measured byte value. Failure writes diagnostic evidence separately and exits nonzero, never a passed report. Constant evidence is permitted only in verifier unit tests.

Create `plugin-persistence-run.mjs` as the executable owned build/launch entry:

```js
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import electron from "electron";
import { verifyMatrix, verifyInterop, verifyKills, verifyLoad, verifyImports } from "./plugin-persistence-harness.mjs";
const output = process.env.PERSISTENCE_EVIDENCE;
assert.ok(output && path.isAbsolute(output), "PERSISTENCE_EVIDENCE must be an absolute output path");
const buildRoot = path.join(path.dirname(output), "persistence-producer");
await mkdir(buildRoot, {recursive:true});
for (const [entry, name] of [["plugin-persistence-main.ts", "main.cjs"],
  ["fixtures/plugin-persistence/consumer.ts", "consumer.cjs"],
  ["fixtures/plugin-persistence/kill-worker.mjs", "import-worker.cjs"]]) {
  await build({entryPoints:[fileURLToPath(new URL(entry, import.meta.url))],
    outfile:path.join(buildRoot,name), bundle:true, platform:"node", format:"cjs",
    external:["electron"]});
}
const child = spawn(electron, [path.join(buildRoot,"main.cjs"), "--persistence-acceptance", output],
  {stdio:"inherit", env:{...process.env}});
const [code] = await once(child, "exit");
assert.equal(code, 0, "real producer failed");
const report = JSON.parse(await readFile(output,"utf8"));
verifyMatrix(report); verifyInterop(report); verifyKills(report); verifyLoad(report); verifyImports(report);
assert.equal(Object.keys(report.foundation).length, 15);
```

The main entry imports safely for X-T1 without running acceptance: only the explicit `--persistence-acceptance` argv branch waits for Electron `app.whenReady`, calls the local `runPersistenceAcceptance`, then exits with its status. On import it only exports the producer, contracts and constants. `runPersistenceAcceptance` closes each fixture in `finally`. Retain output hashes and the reviewed build command in the ledger.

Add tests to the owned interop/kill/load/import test files that reject a missing case, constant driver, missing worker trace, duplicate diagnostics counts, absent bundle hash and leaked resources. Run the runner and then the existing four report test files. Expected: real evidence passes every existing verifier and all fifteen cases run; missing adapters or artifacts fail construction and cannot yield success. Manual hardware/OS rows remain pending when unrun.

- [ ] **Step 6: Write the complete author-facing documentation and honest acceptance ledger**

Create `docs/en/plugin-settings-storage.md` with this content:

```md
# Plugin settings and records

Plugin API 1.7.0 adds typed settings, bounded records, explicit export/copy, and cooperative drain. A settings resource declares version 1 and a packaged JSON path. Settings schemaVersion and record schemaVersion are application data versions; they are separate from Plugin API and UI resource versions.

Declare only the permissions you need: settings.read, settings.write, storage.read, storage.write, storage.export, and ui.clipboard. The host binds requests to your source and execution. IDs and handles do not authorize another source. Settings and records are not an encrypted secret store, and process isolation is not an OS sandbox.

Settings apply one field at a time. Boolean/enum changes submit immediately; text/number changes submit on blur or Enter. There is no Apply button. A successful CAS receipt publishes the value. An invalid or failed edit retains the field's draft and error. Read the current snapshot and explicitly retry after a revision conflict; do not silently overwrite another window's edit. Reset follows the same CAS path.

Settings have at most 128 keys and 64 KiB of serialized values; a string is at most 4 KiB. Settings keys may contain dots. Enum values preserve their types: numeric 1 differs from string "1". Watch delivers invalidations without values; re-read when needed. settings.unwatch calls events/unsubscribe, whose first successful removal is true and whose repeated tombstone removal is false. There is no settings/unwatch wire method.

Records are at most 8 MiB, 256 records and 512 MiB per source, with a 1 GiB host limit. Use beginWrite, ordered writeChunk calls, sealWrite, then commitWrite. Chunks contain canonical base64 and decode to at most 256 KiB. Two staging writes per source and sixteen per host reserve their full payload. Replacing a record requires its expected revision and reserves the replacement before releasing the old object. Read handles pin one revision; lists are bounded snapshots with pages of at most 64 entries. Close read handles when finished.

A commit receipt identifies a committed head. An unknown result means publication needs reconciliation; it does not mean rollback. Do not automatically repeat create, commit, delete, export, or copy. flush does not commit incomplete payloads. Staging/read/list leases expire after 30 seconds idle and 120 seconds total; retry does not renew the original total deadline.

Export and copy require a fresh single-use actionRef from a real host user action. An invocationId is not an actionRef. Activation, timers and watch callbacks do not create one. Export starts a bounded asynchronous dialog job; user cancellation is normal. The host owns the destination path, validates its identity and never returns it. Export permits one job per source and four per host, independently of staging slots. Copy writes plain text only, at most 64 KiB and 16,384 code points. The API cannot read the clipboard.

Register a checkpoint before recording. A drain callback has an independent cancellation scope and at most ten seconds. Its submitted response is not a saved receipt. Only committed final records plus a successful host flush can establish saved. A crash may preserve only the last checkpoint; retry is available only when the host holds complete payload bytes and the original retention period remains. Core recovery remains available when optional features are disabled or safe mode suppresses them.

The app permits one primary instance per profile. A second launch focuses the existing window and exits before initializing another writer. Closing the app coordinates storage drain with device stop and the fault journal. A cancelled close does not revive old handles, motion or recording. Disconnect completes stop/save before disconnecting. Suspend requests final save, but the OS may freeze I/O before it completes; wake does not resume recording automatically.

Legacy import is a host-allowlisted one-time operation. Originals are preserved. Plans, item receipts and the completion marker are durable, and restarts reuse planned destination IDs. Missing renderer evidence remains pending. Completed import does not recreate a record the user later deletes. This foundation includes synthetic import tests only; actual Sensor Lab mappings belong to stage 3D and device preference mappings to stage 3E.

JavaScript methods use camelCase names. Python methods use snake_case names but retain camelCase wire keys in their parameter dictionaries. Both return the same ok/value/error business envelopes. Transport and numeric protocol failures raise RpcError. API 1.4, 1.5 and 1.6 consumers remain compatible and do not receive persistence drain or settings events. UI resource v2 and Plugin API 1.8 belong to stage 3D.
```

Create `docs/zh-TW/plugin-settings-storage.md` with this content:

```md
# 插件設定與資料紀錄

Plugin API 1.7.0 提供型別化設定、有上限的 records、明確使用者觸發的匯出／複製，以及協作式 drain。設定宣告使用 version 1 與封裝內的 JSON path。settings 與 record 的 schemaVersion 是資料版本，和 Plugin API、UI resource version 分開。

只宣告需要的 settings.read、settings.write、storage.read、storage.write、storage.export、ui.clipboard 權限。host 將請求綁定到來源與執行世代；ID 或 handle 不能授權另一個來源。這些資料不是加密的秘密儲存區，程序隔離也不是 OS sandbox。

設定逐欄立即套用：boolean／enum 選擇後提交，文字與數字在 blur／Enter 時提交，沒有 Apply 按鈕。CAS 成功並收到 receipt 後才發布值。驗證或保存失敗會保留該欄 draft 與錯誤；revision 衝突時先讀取新 snapshot，再由使用者明確重試，不能覆蓋另一視窗的修改。單欄 Reset 走同一 CAS 路徑。

設定最多 128 keys、序列化 values 共 64 KiB，單一字串最多 4 KiB。key 可含點號；數字 1 與字串 "1" 是不同 enum 值。watch 只傳 invalidation，不傳值；需要時重新 read。settings.unwatch 包裝 events/unsubscribe，首次移除回 true，重複 tombstone 回 false，沒有 settings/unwatch wire method。

單筆 record 最多 8 MiB，每來源最多 256 筆／512 MiB，host 總上限 1 GiB。依序 beginWrite、writeChunk、sealWrite、commitWrite；chunk 是 canonical base64，解碼後最多 256 KiB。每來源最多兩個 staging、host 最多十六個，受理時預留完整 payload。replacement 需要 expected revision，先預留新資料才釋放舊 object。read handle 固定一個 revision，list 是有期限的 snapshot，每頁最多 64 筆；讀完要 close。

receipt 證明已提交的 head。unknown 表示必須對帳，不能解讀成 rollback；不要自動重送 create、commit、delete、export 或 copy。flush 不會替 caller 提交不完整 payload。staging／read／list 最多閒置 30 秒、總計 120 秒；重試不延長原本總期限。

匯出與複製需要 host 真實使用者動作產生、有效五秒且只可用一次的 actionRef。invocationId 不能替代它，activation、timer、watch callback 都不能取得它。匯出先建立非同步 dialog job，使用者取消不是保存錯誤。host 管理目的地並檢查身分，不回傳實體路徑。每來源一個／host 四個 export jobs，與 staging slots 分開。copy 只寫純文字，最多 64 KiB／16,384 code points，不能讀剪貼簿。

錄製前應 registerCheckpoint。drain callback 使用獨立取消範圍，最多十秒；submitted 不表示 saved。只有 final records 已收到 commit receipt 且 host flush 成功，才可宣稱保存完成。當機可能只留下最後 checkpoint；只有 host 已持有完整 payload 且原保留期限未到，才有 retry。停用 optional features 或進入 safe mode 後，核心 recovery 仍可使用。

同一 profile 只允許一個 primary instance。第二次啟動聚焦現有視窗後退出，不初始化另一個 writer。關閉 app 會協調 storage drain、device stop 與 fault journal；取消關閉不會復活舊 handles、motion 或錄製。Disconnect 先確認 stop／save 才斷線。suspend 會要求 final save，但 OS 可能先凍結 I/O；wake 不自動續錄。

Legacy import 是 host allowlist 管理的一次性作業。原始檔保留不變；plan、逐項 receipt 與 complete marker 持久化，重啟沿用原先配置的目標 IDs。缺 renderer evidence 時維持 pending。完成後使用者刪掉新 record，不會再次匯入。此基礎階段只含 synthetic mapper；真正 Sensor Lab 對應在 3D、device preferences 對應在 3E 驗收。

JavaScript method 使用 camelCase；Python method 使用 snake_case，但 params dict 的 wire keys 保留 camelCase。兩者保留相同 ok／value／error business envelope，transport／numeric protocol failure 才拋 RpcError。1.4、1.5、1.6 consumers 維持相容，不收到 persistence drain 或 settings events。UI v2 與 Plugin API 1.8 由 3D 發布。
```

Create `docs/superpowers/plans/2026-10-17-plugin-system-3b2-acceptance.md`:

```md
# Stage 3B-2 acceptance ledger

Status: PENDING. This document records gates, not measured results. Synthetic unit results do not close real-process, installed, filesystem, UI or hardware acceptance. T7 owns this file until its stopped-owner handoff to T9.

| Gate | Required evidence | Status |
| --- | --- | --- |
| F | Exact contract-freeze commit and receipt | Pending |
| P160 | Accepted 1.6.0 baseline | Pending |
| P170 | Protocol/JS/Python 1.7.0; equal generated schemas | Pending |
| B2-N01–N29 | Each spec §10 row with wire, tree/hash, quotas, handles, core snapshot, fresh hostEpoch | Pending |
| B2 §12.1 groups 1–8 | Settings UI/types; quota; chunks/publication; events; faults; lifecycle; import; user actions | Pending |
| B2-RF1 | Actual kill after publication dispatch, original receipt reconciliation, zero republish | Pending |
| B2-RF5 | 50×8 MiB import kill/restart at all six item/receipt/marker boundaries, three repeats | Pending |
| Public interop | Actual JS MessagePort and Python stdio, official router, no private fixture service | Pending |
| Load | Thirty samples, required environment fields, p50/p95/max, main/worker RSS separately | Pending |

| Manual gate | Required work | Status |
| --- | --- | --- |
| B2-M01 | en/zh-TW; light/dark; 320 px; 125%; keyboard; immediate field commit/conflict/retry; no Apply | MANUAL pending |
| B2-M02 | Real disk-full/read-only; retry/expiry; close blocker and recovery disposition | MANUAL pending |
| B2-M03 | Installed native save dialog/cancel/destination race and actual clipboard text | MANUAL pending |
| B2-M04 | True process kill, cold recovery, safe mode and all optional features off | MANUAL pending |
| B2-M05 | Actual 3D Lab/calibration and 3E device/preferences mappings with user originals | Deferred to 3D/3E; synthetic import cannot close |
| B2-M06 | Installed OS/architecture artifacts; no checkout or PATH Node; single-instance; JS/Python | MANUAL pending |

Every run records command, exit code, commit/artifact digest, OS, architecture, CPU, RAM, filesystem, Node/Electron versions, fixture bytes/count/limits, warm/cold state, sample count, p50/p95/max, memory measurement method and pending/unrun reason. Preserve stage-2 V01–V04 exceptions. Windows replacement/directory-sync results remain platform-specific. SIGKILL and modeled fsync frontiers do not establish hardware power-loss durability. Stop dispatch latency is not physical stop/readback latency.

Exact load gates: 128 settings keys/64 KiB, 16 visible fields; draft p95≤50 ms, page p95≤100 ms; 50×8 MiB records plus two maximum staging records = 416 MiB, four jobs; list p95≤200 ms; main synchronous segment≤16 ms; added main RSS≤32 MiB, worker RSS≤64 MiB; maximum commit/flush≤10 seconds on the named local SSD; extra stop-dispatch p95≤50 ms. Do not loosen a budget after a slow measurement.

Acceptance prerequisites: AM-24/26/29 durable imports and restored barriers, AM-23/27 real worker/host composition, and AM-30 D170/K170 return receipts plus producer commit/bundle hash. Mark rows passed only from actual retained execution evidence. This plan itself supplies no execution evidence.
```

- [ ] **Step 7: Execute actual evidence only on the completed real composition**

**Controller runs outside sandbox** for Electron, native adapters, renderer measurements, localhost if used by the existing renderer build, installed artifacts and hardware. The controller sets `PERSISTENCE_EVIDENCE` to a retained absolute report path and runs the owned producer entry; its build resolves the local composition directly. Record D170/K170 stopped-owner receipts first, then the producer commit and bundle hash before P170 acceptance and the read-only X-T1 handoff.

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-sdk build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/device build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; node tests/desktop/plugin-persistence-run.mjs
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; node --test tests/desktop/plugin-persistence-*.test.mjs
```

Expected green only after all real evidence exists and verifies. Missing composition, missing interpreter, skipped installed run or absent report is not green. Record the exact commands, exits and retained report hashes in the ledger; T9 owns final integration disposition and X-T1 closes cross-plan lifecycle behavior. After the producer build, record its actual identity with:

```bash
git rev-parse HEAD
shasum -a 256 "$(dirname "$PERSISTENCE_EVIDENCE")/persistence-producer/main.cjs" "$PERSISTENCE_EVIDENCE"
```

The receipt lists the two returned producer paths, D170/K170 stop SHAs, T7 stop SHA, bundle hash and artifact hash. X-T1 imports that same bundle read-only; any correction returns to T7 and invalidates the old evidence hash.

- [ ] **Step 8: Commit only the T7 write set and hand the ledger to T9**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git diff --check
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git add tests/desktop/plugin-persistence-interop.test.mjs tests/desktop/plugin-persistence-harness.mjs tests/desktop/plugin-persistence-main.ts tests/desktop/plugin-persistence-kill.test.mjs tests/desktop/plugin-persistence-load.test.mjs tests/desktop/plugin-persistence-import.test.mjs tests/desktop/plugin-persistence-run.mjs tests/desktop/fixtures/plugin-persistence/consumer.ts tests/desktop/fixtures/plugin-persistence/consumer.py tests/desktop/fixtures/plugin-persistence/kobrixa-plugin.json tests/desktop/fixtures/plugin-persistence/settings.json tests/desktop/fixtures/plugin-persistence/kill-worker.mjs tests/desktop/fixtures/plugin-persistence/import-map.ts docs/en/plugin-settings-storage.md docs/zh-TW/plugin-settings-storage.md docs/superpowers/plans/2026-10-17-plugin-system-3b2-acceptance.md
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git commit -m "test(plugins): add persistence interop and recovery acceptance gates"
```

### Task 3B2-T8: Assemble and publish Plugin API 1.7.0

**Files**

Modify under the exclusive H-P role (the entire allowed set is expanded here; unchanged members remain unchanged):

- `packages/plugin-protocol/src/manifest.ts`
- `packages/plugin-protocol/src/methods.ts`
- `packages/plugin-protocol/src/common.ts`
- `packages/plugin-protocol/src/limits.ts`
- `packages/plugin-protocol/src/rpc.ts`
- `packages/plugin-protocol/src/errors.ts`
- `packages/plugin-protocol/src/peer.ts`
- `packages/plugin-protocol/src/index.ts`
- `packages/plugin-protocol/src/json-schema.ts`
- `packages/plugin-protocol/src/manifest.test.ts`
- `packages/plugin-protocol/src/rpc.test.ts`
- `packages/plugin-protocol/src/peer.test.ts`
- `packages/plugin-protocol/src/json-schema.test.ts`
- `packages/plugin-protocol/src/conformance.test.ts`
- `packages/plugin-protocol/src/compiler-manifest.test.ts`
- `packages/plugin-protocol/src/diagnostic-help.test.ts`
- `packages/plugin-protocol/src/language-services.test.ts`
- `packages/plugin-protocol/src/static-language-contract.test.ts`
- `packages/plugin-protocol/scripts/export-schema.mjs`
- `packages/plugin-protocol/schema/plugin-protocol.schema.json`
- `packages/plugin-protocol/schema/keywords.json`
- `packages/plugin-protocol/conformance/cases.json`
- `packages/plugin-sdk-js/src/index.ts`
- `packages/plugin-sdk-js/src/index.test.ts`
- `sdks/python/kobrixa/_plugin.py`
- `sdks/python/kobrixa/_schema.py`
- `sdks/python/kobrixa/__init__.py`
- `sdks/python/kobrixa/plugin-protocol.schema.json`
- `sdks/python/tests/test_plugin.py`
- `sdks/python/tests/test_conformance.py`
- `sdks/python/tests/test_static_languages.py`

AM-15 also transfers these baseline-new common files after B1-T1 stops at P160, with an explicit path/SHA receipt (A-T1 → B1-T1 → B2-T8):

- `packages/plugin-protocol/src/business-result.ts`
- `packages/plugin-protocol/src/business-result.test.ts`
- `packages/plugin-protocol/src/events.ts`
- `packages/plugin-protocol/src/events.test.ts`
- `packages/plugin-sdk-js/src/events.ts`
- `packages/plugin-sdk-js/src/events.test.ts`
- `sdks/python/kobrixa/_events.py`
- `sdks/python/tests/test_events.py`

Modify after the stopped T1 owner hands over the three baseline-new files:

- `packages/plugin-protocol/test-fixtures/settings-storage-v1/valid.json`
- `packages/plugin-protocol/test-fixtures/settings-storage-v1/invalid.json`
- `packages/plugin-protocol/test-fixtures/settings-storage-v1/maximum.json`

Create: none. Do not create replacement protocol/SDK modules outside H-P.

Test:

- `packages/plugin-protocol/src/manifest.test.ts`
- `packages/plugin-protocol/src/rpc.test.ts`
- `packages/plugin-protocol/src/peer.test.ts`
- `packages/plugin-protocol/src/json-schema.test.ts`
- `packages/plugin-protocol/src/conformance.test.ts`
- `packages/plugin-protocol/src/compiler-manifest.test.ts`
- `packages/plugin-protocol/src/diagnostic-help.test.ts`
- `packages/plugin-protocol/src/language-services.test.ts`
- `packages/plugin-protocol/src/static-language-contract.test.ts`
- `packages/plugin-sdk-js/src/index.test.ts`
- `sdks/python/tests/test_plugin.py`
- `sdks/python/tests/test_conformance.py`
- `sdks/python/tests/test_static_languages.py`

**Interfaces**

Consumes the exact domain-local maps and imports their inferred types; do not redeclare their params/results:

```ts
import {
  settingsRequestSchemas, storageRequestSchemas, persistenceActionRequestSchemas,
  type SettingsRequestMap, type StorageRequestMap, type PersistenceActionRequestMap,
  type CommandInvocation, type DrainRequest, type Handle,
} from "@kobrixa/plugin-protocol";
type PersistenceRequestMap = SettingsRequestMap & StorageRequestMap & PersistenceActionRequestMap;
type DrainResult = StorageRequestMap["storage/drain"]["result"];
```

Produces central `requestMethods`/`SCHEMA_DEFINITIONS` registration, the unchanged `ParamsOf`/`ResultOf` inference, API 1.7.0, JS settings/storage/copy/actions/drain and Python counterparts. Use the exact AM-31 client signatures; the three factory return types own method typing:

```ts
import { createSettingsClient, type PersistenceRequest } from "./settings.js";
import { createStorageClient } from "./storage.js";
import { createPersistenceActionsClient } from "./persistence-actions.js";
type PersistenceSettingsClient = ReturnType<typeof createSettingsClient>;
type PersistenceStorageClient = ReturnType<typeof createStorageClient>;
type PersistenceActionsClient = ReturnType<typeof createPersistenceActionsClient>;
interface PersistenceDrainContext {
  readonly request: DrainRequest;
  readonly signal: AbortSignal;
  readonly storage: ReturnType<typeof createStorageClient>;
}
```

Preconditions: W3, P160 accepted, exclusive H-P ownership, T1 stopped and fixture handoff recorded. Do not lower the version or overwrite P150/P160 implementation with baseline 1.4 source. T1-owned protocol modules, SDK modules and Python modules remain read-only. Receive the AM-15 H-P stop/path/SHA receipt before touching common results/events/SDK event adapters. AM-31 freezes the low-level client exports and invocation factories; consume them directly. Publish only after registry, schema and SDK checks pass. No UI v2, settings.gap, `settings/unwatch`, provider permission, or speculative 1.8 publication is introduced.

- [ ] **Step 1: Add protocol assembly and legacy-shape tests first**

Append to `packages/plugin-protocol/src/rpc.test.ts` (add the four imports from `./index.js` to its existing import):

```ts
import { PLUGIN_API_VERSION, settingsRequestSchemas, storageRequestSchemas,
  persistenceActionRequestSchemas } from "./index.js";

it("publishes all and only the domain persistence methods at 1.7", () => {
  expect(PLUGIN_API_VERSION).toBe("1.7.0");
  for (const [name, schemas] of Object.entries({ ...settingsRequestSchemas,
    ...storageRequestSchemas, ...persistenceActionRequestSchemas })) {
    expect(requestMethods).toHaveProperty([name]);
    expect(requestMethods[name as keyof typeof requestMethods]).toBe(schemas);
  }
  expect(Object.hasOwn(requestMethods, "settings/unwatch")).toBe(false);
  expect(Object.hasOwn(notificationMethods, "settings.gap")).toBe(false);
});
it.each(["1.4.0", "1.5.0", "1.6.0"])("retains legacy initialize and execute at %s", (apiVersion) => {
  const initialize = { apiVersion, pluginId: "test.legacy", locale: "en", grantedPermissions: [] };
  expect(requestMethods.initialize.params.safeParse(initialize).success).toBe(true);
  expect(requestMethods["command/execute"].params.safeParse({ command: "test.legacy.run" }).success).toBe(true);
  expect(requestMethods["command/execute"].result.safeParse(null).success).toBe(true);
  expect(requestMethods["command/execute"].result.safeParse({ ok: true, value: {} }).success).toBe(false);
});
it("keeps owner fields out of persistence request params", () => {
  const params = { schemaVersion: 1 };
  expect(requestMethods["settings/read"].params.safeParse(params).success).toBe(true);
  for (const key of ["sourceKey", "pluginId", "generation", "owner", "path"])
    expect(requestMethods["settings/read"].params.safeParse({ ...params, [key]: "foreign" }).success).toBe(false);
});
```

Append to `packages/plugin-protocol/src/manifest.test.ts` (use its existing imports of `expect`, `it` and `pluginManifestSchema`):

```ts
it("makes settings a known strict packaged JSON contribution", () => {
  const base = { id: "test.settings", version: "1.0.0", apiVersion: "^1.7.0",
    runtime: { kind: "node", entry: "main.cjs" }, permissions: ["settings.read", "settings.write"] };
  expect(pluginManifestSchema.safeParse({ ...base,
    contributes: { settings: { version: 1, path: "settings/preferences.json" } } }).success).toBe(true);
  for (const settings of [
    { version: 2, path: "settings.json" }, { version: 1, path: "../settings.json" },
    { version: 1, path: "/settings.json" }, { version: 1, path: "https://invalid/settings.json" },
    { version: 1, path: "settings.json", extra: true },
  ]) expect(pluginManifestSchema.safeParse({ ...base, contributes: { settings } }).success).toBe(false);
});
```

Run red against P160 plus isolated T1:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol test -- src/rpc.test.ts src/manifest.test.ts
```

Expected: missing 1.7 exports/registrations and version mismatch. A loose manifest accepting `settings` as unknown is not a successful known-resource implementation.

- [ ] **Step 2: Assemble maps, permissions, declaration and type exports without changing old request shapes**

In `packages/plugin-protocol/src/methods.ts`, add these imports:

```ts
import { settingsRequestSchemas } from "./settings.js";
import { storageRequestSchemas } from "./storage.js";
import { persistenceActionRequestSchemas } from "./persistence-actions.js";
```

At the end of the existing P160 `requestMethods` literal, immediately before its `} as const`, add exactly:

```ts
  ...settingsRequestSchemas,
  ...storageRequestSchemas,
  ...persistenceActionRequestSchemas,
```

Extend the received common event registry under AM-15; preserve the existing events/deliver notification route. `storage/drain` belongs to the request map; it is not a notification.

In `common.ts`, extend the existing P160 permission array with these exact additional entries, retaining every prior entry:

```ts
"settings.read",
"settings.write",
"storage.read",
"storage.write",
"storage.export",
"ui.clipboard",
```

The resulting permission set must be exactly:

```ts
export const permissionSchema = z.enum([
  "ui.notifications", "devices.read", "devices.connect", "devices.control",
  "ui.panels", "ui.status", "settings.read", "settings.write",
  "storage.read", "storage.write", "storage.export", "ui.clipboard",
]);
```

In `manifest.ts`, reuse the existing packaged JSON grammar:

```ts
export const settingsResourceDeclarationSchema = z.strictObject({
  version: z.literal(1),
  path: diagnosticHelpDeclSchema.shape.path,
});
```

Add the following member to the existing known `contributes` object:

```ts
settings: settingsResourceDeclarationSchema.optional(),
```

Add `"settings"` to the existing `staticLanguageDeclarationProblems` list of forbidden executable contributions. Its complete baseline portion becomes the following; retain any P150/P160 forbidden entries after these entries:

```ts
"commands", "frontends", "backends", "languageServices", "settings",
```

Assemble these explicit public exports in `index.ts`; the B2 module-local `Scalar` is exported only as the frozen `SettingsScalar` barrel alias:

```ts
export {
  settingsRequestSchemas,
  type SettingsRequestMap, type Version, type SettingsRevision, type RecordRevision,
  type RecordId, type Sha256, type SettingKey, type Scalar as SettingsScalar,
  type Values, type Durability, type Receipt, type SettingsText, type SettingsField,
  type SettingsResourceV1, type SettingsSnapshot, type SettingsMutation,
} from "./settings.js";
export {
  storageRequestSchemas, type StorageRequestMap, type RecordMeta, type RecordTarget,
  type RecordWrite, type WriteProgress, type DrainReason, type DrainRequest,
} from "./storage.js";
export { persistenceActionRequestSchemas, type PersistenceActionRequestMap } from "./persistence-actions.js";
export type { PersistenceReason, PersistenceDetail, PersistenceFailureDetail } from "./persistence-validation.js";
```

If a T0 type-only export of these same declarations exists, replace that export with the corresponding full export rather than duplicating names. Do not duplicate `Scalar`, `Handle`, `ResourceOwner` or `BusinessResult`. Leave `json-schema.ts`'s existing method-definition comprehension intact: it automatically registers all new method params/results from the central map. Register T1's `settingsResourceV1Schema: z.ZodType<SettingsResourceV1>` from settings.ts and use `validateSettingsResource(input:unknown,rawBytes:number):SettingsResourceV1` from persistence-validation.ts; do not manufacture a second validator.

Do not set `PLUGIN_API_VERSION` yet: the first red test remains intentionally red until the registry and SDK work is complete. Run the focused manifest test; expected green. Run the method tests; all shapes pass and only publication/version gates remain red.

- [ ] **Step 3: Write JS context, cancellation, action accessor and drain gate tests**

Append to `packages/plugin-sdk-js/src/index.test.ts`, adding `createPersistenceContext`, `createInvocationContext` and type `PluginContext` to the existing SDK import:

```ts
it("preserves business errors and sends unwatch through events/unsubscribe", async () => {
  const [a, b] = createMemoryChannelPair();
  const host = new RpcPeer(a);
  const client = new RpcPeer(b);
  const denied = { ok: false as const, error: { code: "PLUGIN_E_SETTINGS_CONFLICT" as const,
    message: "Revision changed", detail: { kind: "persistence" as const, reason: "revision-mismatch" as const } } };
  const ids: string[] = [];
  host.handle("settings/update", () => denied);
  host.handle("events/unsubscribe", ({ subscriptionId }) => {
    const removed = !ids.includes(subscriptionId); ids.push(subscriptionId);
    return { ok: true, value: { removed } };
  });
  const ctx = createPersistenceContext(client);
  try {
    expect(await ctx.settings.update({ schemaVersion: 1, expectedRevision: null,
      changes: [{ key: "fixture.enabled", value: true }] })).toEqual(denied);
    const params = { subscriptionId: "11111111-1111-4111-8111-111111111111" };
    expect(await ctx.settings.unwatch(params)).toEqual({ ok: true, value: { removed: true } });
    expect(await ctx.settings.unwatch(params)).toEqual({ ok: true, value: { removed: false } });
    expect(ctx.actions.actionRef).toBeUndefined();
  } finally { host.close(); client.close(); }
});
it("isolates overlapping invocation actionRefs without changing the base", async () => {
  let base!: PluginContext;
  const {host} = connect(definePlugin({activate(ctx) {base = ctx;}}));
  const invocation = {version:1 as const,
    invocationId:"11111111-1111-4111-8111-111111111111",command:"test.action",arguments:{},
    context:{contextRef:null,origin:"management" as const,locale:"en" as const,
      trigger:{kind:"activate" as const}}};
  try {
    await host.request("initialize", {...init,apiVersion:"1.7.0"});
    const signal = new AbortController().signal;
    const first = createInvocationContext(base, {...invocation,context:{...invocation.context,
      actionRef:"22222222-2222-4222-8222-222222222222"}}, signal);
    const second = createInvocationContext(base, {...invocation,context:{...invocation.context,
      actionRef:"33333333-3333-4333-8333-333333333333"}}, signal);
    expect(first.actions.actionRef).toBe("22222222-2222-4222-8222-222222222222");
    expect(second.actions.actionRef).toBe("33333333-3333-4333-8333-333333333333");
    expect(first.actions).not.toBe(second.actions);
    expect(Object.getOwnPropertyDescriptor(first.actions,"actionRef")?.set).toBeUndefined();
    expect(createInvocationContext(base,invocation,signal).actions.actionRef).toBeUndefined();
    expect(base.actions.actionRef).toBeUndefined();
  } finally {host.close();}
});
it.each(["1.4.0", "1.5.0", "1.6.0"])("never invokes a drain callback for host %s", async (apiVersion) => {
  const drain = vi.fn(async () => ({ ok: true as const, value: { status: "submitted" as const, writes: [] } }));
  const { host } = connect(definePlugin({ activate() {}, drain }));
  try {
    await host.request("initialize", { ...init, apiVersion });
    await expect(host.request("storage/drain", { token: "11111111-1111-4111-8111-111111111111",
      reason: "shutdown", remainingMs: 10000, checkpoints: [], writes: [] })).rejects.toMatchObject({ code: -32601 });
    expect(drain).not.toHaveBeenCalled();
  } finally { host.close(); }
});
it("keeps drain cancellation separate from the ordinary command", async () => {
  let commandStarted!: () => void;
  const started = new Promise<void>((resolve) => { commandStarted = resolve; });
  let drainSignal: AbortSignal | undefined;
  const { host } = connect(definePlugin({
    activate(ctx) {
      ctx.commands.register("test.wait", ({ signal }) => new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true }); commandStarted();
      }));
    },
    drain(ctx) { drainSignal = ctx.signal;
      return { ok: true, value: { status: "checkpoint-only", writes: [] } }; },
  }));
  try {
    await host.request("initialize", { ...init, apiVersion: "1.7.0" });
    const ordinary = new AbortController();
    const command = host.request("command/execute", { command: "test.wait" }, { signal: ordinary.signal });
    const rejected = expect(command).rejects.toMatchObject({ code: -32800 });
    await started; ordinary.abort(); await rejected;
    expect(await host.request("storage/drain", { token: "11111111-1111-4111-8111-111111111111",
      reason: "shutdown", remainingMs: 10000, checkpoints: [], writes: [] }))
      .toEqual({ ok: true, value: { status: "checkpoint-only", writes: [] } });
    expect(drainSignal?.aborted).toBe(false);
  } finally { host.close(); }
});
```

Run red:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-sdk test -- src/index.test.ts
```

Expected: missing context factory/drain member. No callback registration alone authorizes the host to send drain: actual accepted checkpoint/write registration and current negotiation are still checked by R170/D170.

- [ ] **Step 4: Assemble the actual JS clients and invocation-local actions**

In SDK `index.ts`, import `createSettingsClient` and `PersistenceRequest` from `settings.ts`, `createStorageClient` from `storage.ts`, and `createPersistenceActionsClient` from `persistence-actions.ts`. Re-export their public types without editing the T1-owned modules. `PersistenceRequest` has `(method,params,options:{timeoutMs:number;signal?:AbortSignal})=>Promise<result>` over the frozen maps. Client calls accept `(params, signal?)`, not an options wrapper. Export methods live on the actions client.

Use this assembly helper in `index.ts`; it forwards only transport and reuses all T1 validators:

```ts
export function createPersistenceContext(peer: RpcPeer, signal?: AbortSignal) {
  const request: PersistenceRequest = (method, params, options) =>
    peer.request(method, params, {...options, signal:options.signal ?? signal});
  const client = createSettingsClient(request);
  const settings = Object.assign(client, {
    unwatch: (params: ParamsOf<"events/unsubscribe">, signal?: AbortSignal) =>
      peer.request("events/unsubscribe", params, {timeoutMs:10000, signal}),
  });
  const storage = createStorageClient(request);
  const actions: ReturnType<typeof createPersistenceActionsClient> & {readonly actionRef?:Handle} =
    createPersistenceActionsClient(request);
  return {settings, storage, actions, ui:{copyText:actions.copyText}};
}
export interface PersistenceDrainContext {
  readonly request: DrainRequest;
  readonly signal: AbortSignal;
  readonly storage: ReturnType<typeof createStorageClient>;
}
function supportsPersistence(version: string): boolean {
  const match = /^1\.([0-9]+)\.[0-9]+$/.exec(version);
  return match !== null && Number(match[1]) >= 7;
}
```

Extend `PluginContext.settings` with `ReturnType<typeof createPersistenceContext>["settings"]` (the factory client plus unwatch sugar), and `.storage` with its factory return type; `.actions` is `ReturnType<typeof createPersistenceActionsClient> & {readonly actionRef?:Handle}`. Merge `copyText` into the existing UI member and preserve all devices/UI/commands functionality. Add `drain?(context:PersistenceDrainContext):ResultOf<"storage/drain">|Promise<ResultOf<"storage/drain">>` to `PluginDefinition`. Normal context construction calls this helper once per bound peer.

Extend the existing P160 factory, preserving its P160 fields and signal semantics, with this body (the factory signature is frozen):

```ts
export function createInvocationContext(
  base: PluginContext, invocation: CommandInvocation, signal: AbortSignal,
): PluginContext & {readonly invocation:CommandInvocation;readonly signal:AbortSignal} {
  const actionRef = invocation.context.actionRef;
  const actions = Object.create(base.actions);
  if (actionRef !== undefined) Object.defineProperty(actions, "actionRef", {
    enumerable:true, configurable:false, get:() => actionRef,
  });
  Object.freeze(actions);
  return {...base, invocation, signal, actions};
}
```

Each invocation gets a fresh actions object and read-only accessor; the base has no actionRef. Overlapping invocations and absent refs stay isolated. Command execution must use this named factory, never a global current invocation or shared base mutation. Preserve any existing P160 invocation-bound method closures while adding these members.

Bind watches to the AM-01/16 event queue on the same peer. Extend the received JS `events.ts` / Python `_events.py` adapters to accept `settings.changed`; initial owner binding, after-reply activation, bounded enqueue before cumulative ACK and callback-after-ACK remain unchanged. Add `settings.unwatch` sugar in the common context adapter, sending `events/unsubscribe` and returning its original `{removed:boolean}` business result, without adding it to the low-level SettingsRequestMap or registering a private RPC. Watch gaps trigger the actual settings read/snapshot reconciliation through that same queue. No new event consumer is installed.

In `runPlugin`, derive `persistenceNegotiated` from initialize apiVersion while preserving its wire fields. Install the independent handler on the original peer:

```ts
peer.handle("storage/drain", async (request, {signal}) => {
  if (!persistenceNegotiated || !definition.drain)
    throw new RpcError(RPC_ERRORS.methodNotFound, "Persistence drain was not negotiated or registered.");
  const drainRequest: PersistenceRequest = (method, params, options) =>
    peer.request(method, params, {...options,signal:options.signal ?? signal});
  return definition.drain({request,signal,storage:createStorageClient(drainRequest)});
});
```

The dispatcher and host bind the grant-scoped request path to this original channel/token; no normal command cancellation retires it or grants a new channel. Callback return `submitted` is not durable saved evidence. Run Step 3 again after attaching the shared queue and context. Expected: real client validation, independent drain cancellation and overlapping action refs pass; old/unregistered peers reject drain and R170 sends none.

- [ ] **Step 5: Write Python parity tests, then attach the actual clients and drain semantics**

Append to `sdks/python/tests/test_plugin.py`:

```python
class PersistenceContextTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.output = io.BytesIO()
        self.redirect = redirect_stdout(io.TextIOWrapper(self.output, encoding="utf-8"))
        self.redirect.__enter__()
        self.addCleanup(self.redirect.__exit__, None, None, None)

    async def test_clients_preserve_wire_keys_business_errors_and_unwatch(self):
        from kobrixa._plugin import CommandContext
        plugin = Plugin()
        calls = []
        result = {"ok": False, "error": {"code": "PLUGIN_E_SETTINGS_CONFLICT",
            "message": "Revision changed", "detail": {"kind": "persistence", "reason": "revision-mismatch"}}}
        async def request(method, params, **options):
            calls.append((method, params))
            if method == "events/unsubscribe":
                return {"ok":True,"value":{"removed":True}}
            return result
        plugin._request = request
        ctx = CommandContext(plugin)
        params = {"schemaVersion": 1, "expectedRevision": None,
                  "changes": [{"key": "fixture.enabled", "value": True}]}
        self.assertEqual(await ctx.settings.update(params), result)
        self.assertEqual(calls[-1], ("settings/update", params))
        await ctx.settings.unwatch({"subscriptionId": "11111111-1111-4111-8111-111111111111"})
        self.assertEqual(calls[-1][0], "events/unsubscribe")
        self.assertFalse(hasattr(ctx.actions, "actionRef"))

    async def test_actions_copy_only_action_ref_and_never_invocation_id(self):
        from kobrixa._plugin import CommandContext, create_invocation_context
        plugin = Plugin()
        base = CommandContext(plugin)
        invocation = {"invocationId":"11111111-1111-4111-8111-111111111111", "context":{}}
        self.assertFalse(hasattr(create_invocation_context(base, invocation).actions, "actionRef"))
        invocation["context"]["actionRef"] = "22222222-2222-4222-8222-222222222222"
        first = create_invocation_context(base, invocation)
        invocation["context"]["actionRef"] = "33333333-3333-4333-8333-333333333333"
        second = create_invocation_context(base, invocation)
        self.assertEqual(first.actions.actionRef, "22222222-2222-4222-8222-222222222222")
        self.assertEqual(second.actions.actionRef, "33333333-3333-4333-8333-333333333333")
        with self.assertRaises(AttributeError):
            first.actions.actionRef = "forged"
        self.assertFalse(hasattr(base.actions, "actionRef"))

    async def test_old_host_or_missing_callback_cannot_dispatch_drain(self):
        from kobrixa import RpcError
        request = {"token": "11111111-1111-4111-8111-111111111111", "reason": "shutdown",
                   "remainingMs": 10000, "checkpoints": [], "writes": []}
        for version in ("1.4.0", "1.5.0", "1.6.0", "1.7.0"):
            plugin = Plugin()
            plugin._host_api_version = version
            with self.assertRaises(RpcError) as error:
                await plugin._dispatch("storage/drain", request)
            self.assertEqual(error.exception.code, -32601)

    async def test_drain_is_independent_of_an_ordinary_cancelled_task(self):
        import asyncio
        plugin = Plugin()
        plugin._host_api_version = "1.7.0"
        calls = []
        @plugin.drain
        async def drain(ctx):
            calls.append(ctx.request["token"])
            return {"ok": True, "value": {"status": "checkpoint-only", "writes": []}}
        ordinary = asyncio.create_task(asyncio.sleep(100))
        ordinary.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await ordinary
        request = {"token": "11111111-1111-4111-8111-111111111111", "reason": "shutdown",
                   "remainingMs": 10000, "checkpoints": [], "writes": []}
        result = await plugin._dispatch("storage/drain", request)
        self.assertEqual(result["value"]["status"], "checkpoint-only")
        self.assertEqual(calls, [request["token"]])
```

Run red:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm test:python-sdk
```

Expected: missing `settings`/`storage`/`actions`/`drain`, not a skipped Python invocation. Preserve all existing process/framing/cancellation tests.

In `_plugin.py`, import the actual T1 factories from `_settings.py`, `_storage.py`, `_persistence_actions.py`; retain snake_case methods and validated result dictionaries. Add:

```python
from copy import copy
from kobrixa._settings import create_settings_client
from kobrixa._storage import create_storage_client
from kobrixa._persistence_actions import create_persistence_actions_client

class _InvocationActions:
    def __init__(self, client, invocation):
        self._client = client
        self._action_ref = invocation.get("context", {}).get("actionRef")

    @property
    def actionRef(self):
        if self._action_ref is None:
            raise AttributeError("actionRef")
        return self._action_ref

    def __getattr__(self, name):
        return getattr(self._client, name)


def create_invocation_context(base, invocation):
    context = copy(base)
    context.invocation = invocation
    context.actions = _InvocationActions(base.actions, invocation)
    return context


class PersistenceDrainContext:
    def __init__(self, request, storage):
        self.request = request
        self.storage = storage


def _supports_persistence(version):
    parts = version.split(".")
    return len(parts) == 3 and all(part.isascii() and part.isdigit() for part in parts) and \
        int(parts[0]) == 1 and int(parts[1]) >= 7
```

During normal context construction set `settings=create_settings_client(plugin._request)`, `storage=create_storage_client(plugin._request)` and `actions=create_persistence_actions_client(plugin._request)`; attach `ui.copy_text` to that actions client's `copy_text`. Preserve base UI/device/command methods. Keep shared-queue unwatch sugar on the context adapter, with true/false removed results, not on a second forwarding client. In the command dispatcher call `create_invocation_context(base,invocation)` for every invocation, preserving the existing cancellation task. Never mutate base actions or replace invocationId with actionRef.

Add `_host_api_version="0.0.0"` and `_drain_handler=None` to Plugin initialization, set host API from initialize, and retain the exact async-only registration/dispatch:

```python
    def drain(self, handler):
        if not inspect.iscoroutinefunction(handler):
            raise TypeError("Kobrixa drain handlers must be async functions.")
        if self._drain_handler is not None:
            raise ValueError("A drain handler is already registered.")
        self._drain_handler = handler
        return handler
```

```python
        if method == "storage/drain":
            if not _supports_persistence(self._host_api_version) or self._drain_handler is None:
                raise RpcError(_METHOD_NOT_FOUND, "Persistence drain was not negotiated or registered.")
            storage = create_storage_client(self._request)
            return await self._drain_handler(PersistenceDrainContext(params, storage))
```

The Python drain context is exactly `{request, storage}` over the original bound request channel. Drain and ordinary command tasks are independent. The host enforces token/grant scope and retains original deadline; no retry is hidden by a wrapper. Extend the Python event adapter for settings on the one shared queue, validating before enqueue and acknowledging before invoking user callbacks.

Add `PersistenceDrainContext` to the existing `_plugin` import and `__all__` in `__init__.py`, preserving every P150/P160 export. No Python wire key is converted to snake_case.

In `_schema.py`, import `math` and replace `_is_number` with the complete definition:

```python
def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and \
        (isinstance(value, int) or math.isfinite(value))
```

Do not convert arbitrarily large Python ints to float; safe integer ranges remain explicit schema bounds. Keep the keyword allowlist unchanged unless actual generated schemas require a newly implemented keyword. T1 semantic tests cover duplicate keys, canonical base64, UTF-8 bytes, surrogates, mixed numeric/string enums, default/range relations and serialized-frame expansion.

Run the Python command again; expected: client/action/drain tests green after the P160 factory attachment, with existing protocol-version assertions still pending Step 8.

- [ ] **Step 6: Freeze and test the seven persistence error pairings and settings event behavior**

Append this complete table-driven test to `packages/plugin-protocol/src/rpc.test.ts`:

```ts
const persistenceReasons = {
  PLUGIN_E_SETTINGS_SCHEMA: ["invalid-resource", "invalid-value", "duplicate-key", "unknown-key", "size-limit",
    "schema-changed-without-version", "migration-required", "downgrade", "unsupported-format", "corrupt"],
  PLUGIN_E_SETTINGS_CONFLICT: ["revision-mismatch"],
  PLUGIN_E_SETTINGS_SAVE: ["disk-full", "permission", "read-only", "io", "sync-failed", "publish-uncertain", "import-pending"],
  PLUGIN_E_STORAGE_QUOTA: ["record-count", "source-bytes", "host-bytes", "temporary-bytes"],
  PLUGIN_E_STORAGE_CONFLICT: ["revision-mismatch", "write-in-progress", "offset-mismatch", "sealed", "incomplete",
    "checksum-mismatch", "flush-incomplete", "export-not-ready"],
  PLUGIN_E_STORAGE_IO: ["not-found", "disk-full", "permission", "read-only", "io", "sync-failed", "publish-uncertain",
    "corrupt", "import-pending", "input-changed", "clipboard-unavailable", "destination-changed", "unsupported-filesystem"],
  PLUGIN_E_STORAGE_VERSION: ["unsupported-format", "schema-mismatch"],
} as const;
it("enforces closed code/kind/reason pairings rather than a Cartesian union", () => {
  const schemas = [settingsRequestSchemas, storageRequestSchemas, persistenceActionRequestSchemas];
  const resultSchemas = schemas.flatMap((map) => Object.values(map).map((entry) => entry.result));
  const accepts = (value: unknown) => resultSchemas.some((schema) => schema.safeParse(value).success);
  const reasons = [...new Set(Object.values(persistenceReasons).flat()), "deadline", "cancelled", "arbitrary"];
  for (const [code, allowed] of Object.entries(persistenceReasons)) {
    for (const reason of reasons) {
      const value = { ok: false, error: { code, message: "Synthetic failure",
        detail: { kind: "persistence", reason } } };
      expect(accepts(value), `${code}/${reason}`).toBe((allowed as readonly string[]).includes(reason));
    }
    expect(accepts({ ok: false, error: { code, message: "Synthetic failure",
      detail: { kind: "permission", reason: "io" } } })).toBe(false);
  }
  expect(accepts({ ok: false, error: { code: "PLUGIN_E_PERMISSION_DENIED", message: "Denied",
    detail: { kind: "persistence", reason: "permission" } } })).toBe(false);
  expect(accepts({ ok: false, error: { code: "PLUGIN_E_STALE_RESOURCE", message: "Stale",
    detail: { kind: "persistence", reason: "not-found" } } })).toBe(false);
});
```

Append this complete test to `packages/plugin-protocol/src/json-schema.test.ts`:

```ts
it("publishes settings.changed with a closed payload and no settings.gap", () => {
  const notification = notificationMethods["events/deliver"];
  const event = { version: 1, subscriptionId: "11111111-1111-4111-8111-111111111111",
    owner: { sourceKey: "builtin:test.persistence", pluginId: "test.persistence", generation: 1,
      hostEpoch: "22222222-2222-4222-8222-222222222222", processEpoch: "33333333-3333-4333-8333-333333333333" },
    sequence: 1, delivery: "telemetry", kind: "settings.changed",
    data: { revision: "r_" + "1".repeat(32), schemaVersion: 1, changedKeys: ["fixture.enabled"], cause: "update" } };
  expect(notification.safeParse(event).success).toBe(true);
  expect(notification.safeParse({ ...event, data: { ...event.data, values: [] } }).success).toBe(false);
  expect(notification.safeParse({ ...event, kind: "settings.gap" }).success).toBe(false);
  expect(notification.safeParse({ ...event, delivery: "control" }).success).toBe(false);
  expect(notification.safeParse({ ...event, data: { ...event.data,
    changedKeys: Array.from({ length: 129 }, (_, i) => `key${i}`) } }).success).toBe(false);
});
```

Run red:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol test -- src/rpc.test.ts src/json-schema.test.ts
```

Expected red before assembly: P160 rejects `settings.changed`; after the AM-15 receipt extend `business-result.ts` and `events.ts` and their direct tests, plus the JS/Python common adapters. Expected green: all seven codes and exact code/detail pairs pass while mismatches fail. Preserve one shared event registry and queue: strict data pairing; validate → bounded enqueue → cumulative ack → user callback; no callback-await in the ack path. Add the resource kinds `storage-write`, `storage-read`, `storage-list`, `storage-export`, `storage-watch` to the same closed registry while retaining all 1.5/1.6 kinds. Those exact names are part of the publication gate.

AM-15 authorizes these common registry edits only after the recorded P160 H-P handoff. Advance the published `PluginErrorCode` and `ResourceKind` aliases to their V170 cumulative projections and register the seven exact persistence codes, five storage kinds and `settings.changed` in their original defining modules. Keep `commonFailureSchema` batch-closed and use T1's strict domain data schemas; preserve all legacy numeric errors. Never widen `EventKind` to string, accept arbitrary event data, patch generated JSON or install a second SDK notification handler. Run the common business-result/events direct tests and both SDK event suites before proceeding to the version change.

- [ ] **Step 7: Parse the frozen outer format in every language and schema runner**

Use the AM-31 `ContractFixtureFile` representation for valid, invalid and maximum files. Each is `{formatVersion:1,family:"settings-storage-v1",cases:[...]}`; preserve the existing T1 cases and append the additions below into `cases`. Reject unknown outer/case/expected keys, invalid phase, duplicate id, wrong family/version and a schema not in the closed schema map. Never evaluate schema names. Each expected object contains exactly numericCode, businessCode, reason, permission, lifetime, persistedSha256, including explicit null values. Valid cases have null error fields. Structural invalid params cases specify numericCode -32602; result validation failures are not falsely attributed to a plugin business code.

Extend protocol `conformance.test.ts` with this local strict parser for the frozen F outer representation; domain schema keys are checked against the published map. This is a fixture parser, not another product resource validator:

```ts
import { z } from "zod";
const fixtureExpectedSchema = z.strictObject({
  numericCode:z.number().int().nullable(), businessCode:z.string().nullable(),
  reason:z.string().nullable(), permission:z.string().nullable(), lifetime:z.string().nullable(),
  persistedSha256:z.string().regex(/^[0-9a-f]{64}$/).nullable(),
});
const contractFixtureFileSchema = z.strictObject({
  formatVersion:z.literal(1),
  family:z.enum(["device-broker-v1","declarative-ui-v1","settings-storage-v1"]),
  cases:z.array(z.strictObject({
    id:z.string().min(1), schema:z.string().refine(key => Object.hasOwn(SCHEMA_DEFINITIONS,key)),
    phase:z.enum(["params","result","resource","event"]), input:z.unknown(),
    valid:z.boolean(), expected:fixtureExpectedSchema,
  })).refine(cases => new Set(cases.map(entry => entry.id)).size === cases.length)
    .refine(cases => cases.every(entry => !entry.valid ||
      entry.expected.numericCode === null && entry.expected.businessCode === null && entry.expected.reason === null)),
});
```

Execute the actual input through the exported schema:

```ts
for (const family of ["valid", "invalid", "maximum"] as const) {
  const file = contractFixtureFileSchema.parse(JSON.parse(await readFile(new URL(
    `../test-fixtures/settings-storage-v1/${family}.json`, import.meta.url), "utf8")));
  expect(file.family).toBe("settings-storage-v1");
  for (const entry of file.cases) {
    it(`${family}: ${entry.id}`, () => {
      const schema = SCHEMA_DEFINITIONS[entry.schema];
      expect(schema, entry.schema).toBeDefined();
      expect(schema.safeParse(entry.input).success).toBe(entry.valid);
    });
  }
}
```

In Python `test_conformance.py`, apply the same strict key/version/family/phase/expected-field checks before iterating `document["cases"]`. Use `case["schema"]`, `case["input"]`, `case["id"]` and `case["valid"]` without translating wire keys:

```python
for family in ("valid", "invalid", "maximum"):
    document = json.loads((PROTOCOL / "test-fixtures" / "settings-storage-v1" / f"{family}.json").read_text("utf-8"))
    self.assertEqual(set(document), {"formatVersion", "family", "cases"})
    self.assertEqual(type(document["formatVersion"]), int)
    self.assertEqual(document["formatVersion"], 1)
    self.assertEqual(document["family"], "settings-storage-v1")
    ids = set()
    for case in document["cases"]:
        self.assertEqual(set(case), {"id", "schema", "phase", "input", "valid", "expected"})
        self.assertNotIn(case["id"], ids)
        ids.add(case["id"])
        self.assertIn(case["phase"], ("params", "result", "resource", "event"))
        self.assertEqual(type(case["valid"]), bool)
        self.assertEqual(set(case["expected"]), {"numericCode", "businessCode", "reason", "permission", "lifetime", "persistedSha256"})
        with self.subTest(case["id"]):
            try:
                validator.validate(case["schema"], case["input"])
                accepted = True
            except SchemaError:
                accepted = False
            self.assertEqual(accepted, case["valid"])
```

Run red with the package/Python commands from Steps 1 and 5. Expected: missing publication entries or unregistered definitions, never a silent empty subset. After assembly every case must run through JS/Zod/exported JSON Schema/Python; persisted hash/lifetime expectations require actual host tests, not schema-only assertions.

`valid.json` additions:

`valid.json` additions:

```json
{
  "formatVersion": 1,
  "family": "settings-storage-v1",
  "cases": [
    {
      "id": "p170-publication: read settings",
      "schema": "settings/read.params",
      "phase": "params",
      "input": {
        "schemaVersion": 1
      },
      "valid": true,
      "expected": {
        "numericCode": null,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "p170-publication: nullable initial revision",
      "schema": "settings/update.params",
      "phase": "params",
      "input": {
        "schemaVersion": 1,
        "expectedRevision": null,
        "changes": [
          {
            "key": "fixture.enabled",
            "value": true
          }
        ]
      },
      "valid": true,
      "expected": {
        "numericCode": null,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "p170-publication: zero byte record",
      "schema": "storage/beginWrite.params",
      "phase": "params",
      "input": {
        "target": {
          "mode": "create"
        },
        "kind": "test.fixture",
        "schemaVersion": 1,
        "label": "Empty",
        "mediaType": "application/octet-stream",
        "byteLength": 0,
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      },
      "valid": true,
      "expected": {
        "numericCode": null,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "p170-publication: drain submitted is not saved",
      "schema": "storage/drain.result",
      "phase": "result",
      "input": {
        "ok": true,
        "value": {
          "status": "submitted",
          "writes": []
        }
      },
      "valid": true,
      "expected": {
        "numericCode": null,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "p170-publication: unsubscribe tombstone",
      "schema": "events/unsubscribe.result",
      "phase": "result",
      "input": {
        "ok": true,
        "value": {
          "removed": false
        }
      },
      "valid": true,
      "expected": {
        "numericCode": null,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    }
  ]
}
```

`invalid.json` additions:

```json
{
  "formatVersion": 1,
  "family": "settings-storage-v1",
  "cases": [
    {
      "id": "p170-publication: source spoof",
      "schema": "settings/read.params",
      "phase": "params",
      "input": {
        "schemaVersion": 1,
        "sourceKey": "builtin:foreign"
      },
      "valid": false,
      "expected": {
        "numericCode": -32602,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "p170-publication: boolean is not version",
      "schema": "settings/read.params",
      "phase": "params",
      "input": {
        "schemaVersion": true
      },
      "valid": false,
      "expected": {
        "numericCode": -32602,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "p170-publication: unsafe offset",
      "schema": "storage/readChunk.params",
      "phase": "params",
      "input": {
        "read": "11111111-1111-4111-8111-111111111111",
        "offset": 9007199254740992,
        "maxBytes": 1
      },
      "valid": false,
      "expected": {
        "numericCode": -32602,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "p170-publication: invocation id is not copy params",
      "schema": "ui/copyText.params",
      "phase": "params",
      "input": {
        "invocationId": "11111111-1111-4111-8111-111111111111",
        "text": "Synthetic"
      },
      "valid": false,
      "expected": {
        "numericCode": -32602,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "p170-publication: plugin cannot report saved",
      "schema": "storage/drain.result",
      "phase": "result",
      "input": {
        "ok": true,
        "value": {
          "status": "saved",
          "writes": []
        }
      },
      "valid": false,
      "expected": {
        "numericCode": null,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "p170-publication: record over maximum",
      "schema": "storage/beginWrite.params",
      "phase": "params",
      "input": {
        "target": {
          "mode": "create"
        },
        "kind": "test.fixture",
        "schemaVersion": 1,
        "label": "Large",
        "mediaType": "application/octet-stream",
        "byteLength": 8388609,
        "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      },
      "valid": false,
      "expected": {
        "numericCode": -32602,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    }
  ]
}
```

`maximum.json` additions:

```json
{
  "formatVersion": 1,
  "family": "settings-storage-v1",
  "cases": [
    {
      "id": "p170-publication: maximum record bytes",
      "schema": "storage/beginWrite.params",
      "phase": "params",
      "input": {
        "target": {
          "mode": "create"
        },
        "kind": "test.fixture",
        "schemaVersion": 2147483647,
        "label": "Maximum",
        "mediaType": "application/octet-stream",
        "byteLength": 8388608,
        "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      },
      "valid": true,
      "expected": {
        "numericCode": null,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "p170-publication: maximum decoded read chunk",
      "schema": "storage/readChunk.params",
      "phase": "params",
      "input": {
        "read": "11111111-1111-4111-8111-111111111111",
        "offset": 0,
        "maxBytes": 262144
      },
      "valid": true,
      "expected": {
        "numericCode": null,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "p170-publication: Unicode copy",
      "schema": "ui/copyText.params",
      "phase": "params",
      "input": {
        "actionRef": "11111111-1111-4111-8111-111111111111",
        "text": "😀"
      },
      "valid": true,
      "expected": {
        "numericCode": null,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    },
    {
      "id": "p170-publication: maximum drain budget",
      "schema": "storage/drain.params",
      "phase": "params",
      "input": {
        "token": "11111111-1111-4111-8111-111111111111",
        "reason": "shutdown",
        "remainingMs": 10000,
        "checkpoints": [],
        "writes": []
      },
      "valid": true,
      "expected": {
        "numericCode": null,
        "businessCode": null,
        "reason": null,
        "permission": null,
        "lifetime": null,
        "persistedSha256": null
      }
    }
  ]
}
```

Register these files in the existing conformance runner; retain the legacy `conformance/cases.json` API ranges and existing shape without copying a competing persistence corpus. Generate actual serialized maximum/+1 input strings in the owned fixture files; no `$repeat` object is a wire input. Use this edit-time generator for the copy boundary cases:

```js
const expected = {numericCode:null,businessCode:null,reason:null,permission:null,lifetime:null,persistedSha256:null};
for (const [count,valid] of [[16384,true],[16385,false]]) {
  maximum.cases.push({id:`p170-publication: copy-codepoints-${count}`,
    schema:"ui/copyText.params",phase:"params",valid,
    input:{actionRef:"11111111-1111-4111-8111-111111111111",text:"😀".repeat(count)},
    expected:{...expected,numericCode:valid ? null : -32602}});
}
```

Also retain explicit limit/+1 IDs for 8 MiB records, 256 KiB decoded chunks, 349,528 encoded characters and 1 MiB escaping-expanded frames. T1 semantic tests must verify decoded UTF-8 bytes, canonical padding/tail bits, key uniqueness and numeric type identity; schema-only acceptance cannot establish these facts.

- [ ] **Step 8: Set the single release version, regenerate both schemas and prove deterministic output**

Only execute after the AM-15 H-P receipt, complete registry/schema/SDK checks and AM-31 client assembly are green. Set these exact values:

```ts
// packages/plugin-protocol/src/limits.ts
export const PLUGIN_API_VERSION = "1.7.0";
// packages/plugin-sdk-js/src/index.ts retains its existing alias:
export const API_VERSION = PLUGIN_API_VERSION;
```

```python
# sdks/python/kobrixa/_plugin.py
API_VERSION = "1.7.0"
```

The existing schema serializer produces exactly:

```json
{ "$id": "https://kobrixa.com/schemas/plugin-protocol/1.7.0.json", "title": "Kobrixa plugin protocol 1.7.0" }
```

Those are identity fields, not the complete schema artifact. Generate the complete artifacts with the existing exporter; do not paste or hand-merge generated schema JSON.

Update only current-host assertion values in the following existing tests to `"1.7.0"`, and their current-schema `$id` assertion to the 1.7.0 URL. Preserve every legacy consumer's initialize input, manifest range, command result, language/resource version and semantic fixture:

- `packages/plugin-protocol/src/compiler-manifest.test.ts`: `expect(PLUGIN_API_VERSION).toBe("1.7.0")`.
- `packages/plugin-protocol/src/diagnostic-help.test.ts`: its current host version assertion, if present after P160, becomes `expect(PLUGIN_API_VERSION).toBe("1.7.0")`; resource format remains 1.
- `packages/plugin-protocol/src/language-services.test.ts`: `expect(PLUGIN_API_VERSION).toBe("1.7.0")`.
- `packages/plugin-protocol/src/static-language-contract.test.ts`: `expect(PLUGIN_API_VERSION).toBe("1.7.0")`.
- `packages/plugin-protocol/src/json-schema.test.ts`: `expect(schema.$id).toBe("https://kobrixa.com/schemas/plugin-protocol/1.7.0.json")`.
- `packages/plugin-sdk-js/src/index.test.ts`: `expect(API_VERSION).toBe("1.7.0")` and current SDK initialize response assertion `apiVersion: "1.7.0"`.
- `sdks/python/tests/test_plugin.py`: the current SDK initialize response assertion becomes `self.assertEqual(reply["result"]["apiVersion"], "1.7.0")`; its host initialize input remains `"1.1.0"`.
- `sdks/python/tests/test_conformance.py`: `self.assertEqual(API_VERSION, "1.7.0")`.
- `sdks/python/tests/test_static_languages.py`: the same API assertion and `self.assertEqual(document["$id"], "https://kobrixa.com/schemas/plugin-protocol/1.7.0.json")`.

Rename test descriptions that describe the *current host* to 1.7, but leave descriptions of 1.4/1.5/1.6 compatibility cases intact. Keep `rpc.ts`, `peer.ts`, exporter script and schema keyword file unchanged unless a concrete failing compatibility test requires a correction within H-P; the isolated T1 schema implementation must not require an unimplemented Python keyword.

Run:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol schema
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; cmp packages/plugin-protocol/schema/plugin-protocol.schema.json sdks/python/kobrixa/plugin-protocol.schema.json
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; shasum -a 256 packages/plugin-protocol/schema/plugin-protocol.schema.json sdks/python/kobrixa/plugin-protocol.schema.json
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol schema
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; shasum -a 256 packages/plugin-protocol/schema/plugin-protocol.schema.json sdks/python/kobrixa/plugin-protocol.schema.json
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol test
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-sdk build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-sdk test
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm test:python-sdk
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git diff --check
```

Expected: both schema copies are byte-identical, both regeneration hashes are identical, all shared/legacy/new schema and SDK tests pass with actual Python execution. Do not use “git diff is empty” against the old 1.6 committed schema as the precommit deterministic check. The remaining desktop/runtime event negotiation and registration gates are tested at T9/X-T1, with no claim from a mocked SDK handler alone.

- [ ] **Step 9: Review exact exposure and commit the P170 publication under the sole protocol writer**

Review the final diff for precisely the six added permissions; seven new persistence codes with their closed reasons; five new storage/watch resource kinds; `settings.changed` telemetry with at most 128 changed keys and no values; all frozen methods; legacy initialize/execute compatibility; UI resource v1 retained; package versions unchanged; no private unwatch alias; no new queue/cancellation infrastructure. Confirm T1 fixtures are no longer being edited by another task. Require the recorded registry handoff and completed client assembly before publishing 1.7.0.

The future implementation commit stages the finite H-P set and the three explicitly transferred fixture paths. Unchanged allowed files are harmless in `git add`; no glob expands the ownership boundary:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git add packages/plugin-protocol/src/business-result.ts packages/plugin-protocol/src/business-result.test.ts packages/plugin-protocol/src/events.ts packages/plugin-protocol/src/events.test.ts packages/plugin-sdk-js/src/events.ts packages/plugin-sdk-js/src/events.test.ts sdks/python/kobrixa/_events.py sdks/python/tests/test_events.py packages/plugin-protocol/src/manifest.ts packages/plugin-protocol/src/methods.ts packages/plugin-protocol/src/common.ts packages/plugin-protocol/src/limits.ts packages/plugin-protocol/src/rpc.ts packages/plugin-protocol/src/errors.ts packages/plugin-protocol/src/peer.ts packages/plugin-protocol/src/index.ts packages/plugin-protocol/src/json-schema.ts packages/plugin-protocol/src/manifest.test.ts packages/plugin-protocol/src/rpc.test.ts packages/plugin-protocol/src/peer.test.ts packages/plugin-protocol/src/json-schema.test.ts packages/plugin-protocol/src/conformance.test.ts packages/plugin-protocol/src/compiler-manifest.test.ts packages/plugin-protocol/src/diagnostic-help.test.ts packages/plugin-protocol/src/language-services.test.ts packages/plugin-protocol/src/static-language-contract.test.ts packages/plugin-protocol/scripts/export-schema.mjs packages/plugin-protocol/schema/plugin-protocol.schema.json packages/plugin-protocol/schema/keywords.json packages/plugin-protocol/conformance/cases.json packages/plugin-sdk-js/src/index.ts packages/plugin-sdk-js/src/index.test.ts sdks/python/kobrixa/_plugin.py sdks/python/kobrixa/_schema.py sdks/python/kobrixa/__init__.py sdks/python/kobrixa/plugin-protocol.schema.json sdks/python/tests/test_plugin.py sdks/python/tests/test_conformance.py sdks/python/tests/test_static_languages.py packages/plugin-protocol/test-fixtures/settings-storage-v1/valid.json packages/plugin-protocol/test-fixtures/settings-storage-v1/invalid.json packages/plugin-protocol/test-fixtures/settings-storage-v1/maximum.json
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git commit -m "feat(protocol): publish settings and storage API 1.7.0"
```

Hand the actual P170 commit SHA and schema hashes to T9's controller. User merges remain `--no-ff`; do not edit the runtime/desktop/renderer/packaging hotspots from this task. The final aggregate verification commands and X-T1 receipt remain P12's sections.

### Task 3B2-T9: Attach the 1.7.0 persistence foundation and record P170

**Files**

Create (the report transfers from the stopped 3B2-T7 writer; do not overwrite its evidence):

- `docs/superpowers/plans/2026-10-17-plugin-system-3b2-acceptance.md`

Modify, exclusively by the persistent role named here:

- D170: `apps/desktop/src/main/plugins/controller.ts`
- D170/Test: `apps/desktop/src/main/plugins/controller.test.ts`
- D170: `apps/desktop/src/main/index.ts`
- D170: `apps/desktop/src/main/ipc.ts`
- D170/Test: `apps/desktop/src/main/ipc.test.ts`
- D170: `apps/desktop/src/shared/plugins.ts`
- D170: `apps/desktop/src/main/plugins/core-recovery.ts`
- D170/Test: `apps/desktop/src/main/plugins/core-recovery.test.ts`
- D170: `apps/desktop/src/shared/plugin-persistence.ts`
- D170/Test: `apps/desktop/src/shared/plugin-persistence.test.ts`
- D170: `apps/desktop/src/preload/index.ts`
- D170/Test: `apps/desktop/src/preload/index.test.ts`
- V170: `apps/desktop/src/renderer/settings/plugin-recovery.tsx`
- V170/Test: `apps/desktop/src/renderer/settings/plugin-recovery.test.ts`
- V170: `apps/desktop/src/renderer/settings/settings-panel.tsx`
- V170/Test: `apps/desktop/src/renderer/settings/settings-panel.test.ts`
- K170: `apps/desktop/forge.config.ts`
- K170: `apps/desktop/vite.main.config.ts`
- K170: `apps/desktop/packaging.ts`
- K170/Test: `apps/desktop/src/main/packaging.test.ts`
- H-I: `tests/desktop/preload.cjs`

Test (read-only regression targets):

- `apps/desktop/src/main/index.test.ts`
- `tests/desktop/smoke-harness.test.mjs`

Create, exclusively by V170:

- `apps/desktop/src/renderer/settings/legacy-preferences-bridge.ts`
- Test: `apps/desktop/src/renderer/settings/legacy-preferences-bridge.test.ts`

R170 is the existing H-R owner's attachment review and runtime verification. `PluginManagerOptions.stage3` and its lifecycle implementation already exist at P160. The desktop supplies the actual participant through that option; this task does not replace manager retirement with another implementation. A necessary runtime correction goes back to H-R with an exact-file handoff, not into the D170 patch.

All B2 backend files, B1 coordinator/action/catalog/form implementations, public protocol assembly, SDK implementations, old Lab stores and feature sources are read-only dependencies. No worker-specific Vite config is added: that path is not in H-K. K170 uses the existing `vite.main.config.ts` for both host and worker entries.

**Interfaces**

Consumes, imported from the defining modules without duplicate declarations. Also import BoundSettingsService from runtime settings-form-port.ts and PersistenceRecoveryHostPort from persistence/recovery-port.ts for the documented host facets:

```ts
import type { Permission } from "@kobrixa/plugin-protocol";
import type {
  CoreActionValidationPort,
  CoreWindowScope,
  ProfileWriterLock,
  Principal,
  ReservationBindingPort,
  SettingsFormPort,
  Stage3RuntimePorts,
  UserPersistenceActionPort,
} from "@kobrixa/plugin-runtime";
import type {
  PersistenceHost,
  PersistenceRequestMap,
} from "./persistence/host-port.js";
import type { PersistenceCompositionInput } from "./persistence/host-port.js";
import type { PersistenceActionAdapter } from "./persistence/actions.js";
import type {
  LegacyImportCoordinator,
  LegacyImportHostPort,
  LegacyPreferenceChallenge,
  LegacyPreferencesSnapshot,
} from "./persistence/import-sources.js";
```

The factory remains exactly:

```ts
declare function createPersistenceHost(input: {
  profile: ProfileWriterLock;
  composition: PersistenceCompositionInput;
  reservations: ReservationBindingPort;
  actions: UserPersistenceActionPort;
  actionAdapter: PersistenceActionAdapter;
  coreActions: CoreActionValidationPort;
  now: () => number;
  hasPermission: (principal: Principal, permission: Permission) => boolean;
}): Promise<PersistenceHost>;
```

The runtime bundle remains exactly:

```ts
interface Stage3RuntimePorts {
  device: DeviceResourceParticipant;
  persistence: PersistenceParticipant;
  ui: UiCatalogPort;
}
```

The dependent port signatures below are copied from the skeleton; their names and defining modules remain unchanged. These are documentation of imports, not declarations to paste into desktop shared code:

```ts
interface PersistenceHost {
  readonly settings: BoundSettingsService;
  readonly recovery: PersistenceRecoveryHostPort;
  readonly participant: PersistenceParticipant;
  request<M extends keyof PersistenceRequestMap>(
    principal: Principal,
    method: M,
    params: PersistenceRequestMap[M]["params"],
    signal: AbortSignal,
  ): Promise<PersistenceRequestMap[M]["result"]>;
  dispose(): Promise<void>;
}
interface PersistenceParticipant {
  // 同步對帳 ended／pending bindings，只封住該 recording target，不 freeze owner。
  endReservation(event: ReservationEnded, deadline: number): DrainOffer | null;
  // 同步關閉普通 admission，擷取已受理工作；可與 broker revocation 同一回合呼叫。
  freeze(
    owner: PersistenceOwner,
    reason: DrainReason,
    deadline: number,
    deviceDrain?: DeviceDrainGrant,
  ): DrainOffer;
  // 以獨立 drain request 喚醒仍健康的原 process；不延長 deadline。
  drain(offer: DrainOffer, dispatch: DrainDispatcher): Promise<DrainReport>;
  // owner 已死亡，不 dispatch；只處理 host 已持有的 ticket，保留 checkpoint。
  ownerLost(owner: PersistenceOwner): Promise<DrainReport>;
  // 接 core recovery snapshot；retry／discard 僅接受可信 UI action，不是 plugin RPC。
  recoverySnapshot(): PersistenceRecoverySnapshot;
  retry(recovery: Handle, action: CoreActionReference): Promise<DrainReport>;
  discard(recovery: Handle, action: CoreActionReference): Promise<DrainReport>;
}
interface SettingsFormPort {
  open(
    binding: SettingsFormBinding,
    resource: SettingsResourceV1,
    snapshot: SettingsSnapshot,
  ): void;
  replaceSnapshot(binding: SettingsFormBinding, snapshot: SettingsSnapshot): void;
  showFailure(
    binding: SettingsFormBinding,
    error: { code: PluginErrorCode; message: string; detail?: PersistenceFailureDetail },
  ): void;
  dispose(binding: SettingsFormBinding): void;
}
interface LegacyImportCoordinator {
  run(
    descriptor: LegacyImportDescriptor,
    signal: AbortSignal,
  ): Promise<{
    state: "pending" | "planned" | "copying" | "complete" | "complete-empty" | "blocked";
    completedItems: number;
    totalItems: number;
  }>;
  acceptPreferences(snapshot: LegacyPreferencesSnapshot): Promise<void>;
}
```

Produces only local attachment helpers in the files above; these are not new plugin RPCs or alterations to frozen ports:

```ts
export function composePersistence170(
  input: Parameters<typeof createPersistenceHost>[0],
  ports: Pick<Stage3RuntimePorts, "device" | "ui">,
): Promise<{ host: PersistenceHost; stage3: Stage3RuntimePorts }>;

export type { LegacyPreferenceChallenge } from "../main/plugins/persistence/import-sources.js";
export interface LegacyPreferencesApi {
  challenge(descriptorId: string): Promise<LegacyPreferenceChallenge>;
  submit(snapshot: LegacyPreferencesSnapshot): ReturnType<LegacyImportHostPort["acceptPreferencesEvidence"]>;
}

export function collectLegacyPreferences(
  challenge: LegacyPreferenceChallenge,
  storage: Pick<Storage, "getItem">,
): LegacyPreferencesSnapshot;
export function submitLegacyPreferences(
  api: LegacyPreferencesApi,
  storage: () => Pick<Storage, "getItem">,
  descriptorId: string,
): Promise<"accepted" | "pending" | "reconciled">;
```

`LegacyPreferencesSnapshot` is type-only re-exported from the B2 import module through desktop shared DTOs. `nonce` is an import challenge, never an action token. `CoreWindowScope` remains main-derived. A renderer snapshot cannot select a target source, mapping, path, schema version or import-complete marker.

**Prerequisites and handoff**

Work from the actual user-merged P160 SHA, then the reviewed 3B2-T8 publication. Do not cherry-pick generated schemas from the B2 development baseline. T1–T8 writers have stopped, and the T7 report is explicitly handed to H-I. Acquire R170, D170, V170 and K170 from their existing owners in that order of review; their files may be implemented serially here but do not gain a second writer. Record each owner's exact touched paths and commit.

AM-18 and AM-23–32 complete the frozen attachment contracts. D170/K170 finish and stop before T7 resumes its two producer files, `tests/desktop/plugin-persistence-main.ts` and `tests/desktop/plugin-persistence-run.mjs`, under a named receipt. T7 records the real producer commit/bundle hash and stops before T9 accepts P170 or X-T1 consumes it. No external composition dependency or filesystem WeakMap is permitted.

- [ ] **Step 1: Write the failing composition test before replacing the P160 empty participant.**

Append these imports and tests to `apps/desktop/src/main/plugins/controller.test.ts`. Keep the existing Electron mock, temporary-profile setup and controller tests. Import `composePersistence170` alongside `startPlugins`. The proxy throws on every unexpected domain call; it is a test adapter and cannot produce persistence success.

```ts
import type { Stage3RuntimePorts } from "@kobrixa/plugin-runtime";
import * as persistenceFactory from "./persistence/host-port.js";
import { composePersistence170 } from "./controller.js";

type PersistenceInput170 = Parameters<typeof persistenceFactory.createPersistenceHost>[0];

function unusedPort170<T extends object>(name: string): T {
  return new Proxy(Object.create(null) as T, {
    get(_target, key) {
      throw new Error(`Unexpected ${name}.${String(key)}`);
    },
  });
}

function compositionInput170() {
  const profile = {
    hostEpoch: "10000000-0000-4000-8000-000000000001",
    assertHeld: vi.fn(),
  };
  const input: PersistenceInput170 = {
    profile,
    composition: {
      backend: unusedPort170("backend"), sources: unusedPort170("sources"),
      events: unusedPort170("events"), dispatchDrain: vi.fn(), imports: unusedPort170("imports"),
    },
    reservations: unusedPort170("reservations"),
    actions: unusedPort170("actions"),
    actionAdapter: unusedPort170("actionAdapter"),
    coreActions: unusedPort170("coreActions"),
    now: () => 100,
    hasPermission: () => false,
  };
  const ports: Pick<Stage3RuntimePorts, "device" | "ui"> = {
    device: unusedPort170("device"),
    ui: unusedPort170("ui"),
  };
  return { input, ports, profile };
}

it("R170/D170 passes the same profile/reservation ports and actual participant by identity", async () => {
  const { input, ports, profile } = compositionInput170();
  const participant = unusedPort170<Stage3RuntimePorts["persistence"]>("participant");
  const host: persistenceFactory.PersistenceHost = {
    participant,
    settings: unusedPort170("settings"), recovery: unusedPort170("recovery"),
    request: () => Promise.reject(new Error("No request admitted by this test")),
    dispose: vi.fn(async () => {}),
  };
  const createHost = vi.spyOn(persistenceFactory, "createPersistenceHost").mockResolvedValue(host);
  const attached = await composePersistence170(input, ports);
  expect(createHost).toHaveBeenCalledExactlyOnceWith(input);
  expect(profile.assertHeld).toHaveBeenCalledTimes(2);
  expect(attached.host).toBe(host);
  expect(attached.stage3.persistence).toBe(participant);
  expect(attached.stage3.device).toBe(ports.device);
  expect(attached.stage3.ui).toBe(ports.ui);
  // No replacement reservation wrapper and no new onEnded subscription.
  expect(createHost.mock.calls[0]![0].reservations).toBe(input.reservations);
});

it("F20 rejects a secondary/unheld profile before creating a persistence host", async () => {
  const { input, ports, profile } = compositionInput170();
  profile.assertHeld.mockImplementation(() => { throw new Error("Profile not held"); });
  const createHost = vi.spyOn(persistenceFactory, "createPersistenceHost");
  await expect(composePersistence170(input, ports)).rejects.toThrow("Profile not held");
  expect(createHost).not.toHaveBeenCalled();
});

it("failed recovery construction never falls back to an empty participant", async () => {
  const { input, ports } = compositionInput170();
  vi.spyOn(persistenceFactory, "createPersistenceHost").mockRejectedValue(new Error("Recovery blocked"));
  await expect(composePersistence170(input, ports)).rejects.toThrow("Recovery blocked");
});

it("a profile revoked during construction disposes the new host and rejects admission", async () => {
  const { input, ports, profile } = compositionInput170();
  profile.assertHeld.mockImplementationOnce(() => {}).mockImplementation(() => {
    throw new Error("Profile lost");
  });
  const dispose = vi.fn(async () => {});
  vi.spyOn(persistenceFactory, "createPersistenceHost").mockResolvedValue({
    participant: unusedPort170("participant"),
    settings: unusedPort170("settings"), recovery: unusedPort170("recovery"),
    request: () => Promise.reject(new Error("Not admitted")),
    dispose,
  });
  await expect(composePersistence170(input, ports)).rejects.toThrow("Profile lost");
  expect(dispose).toHaveBeenCalledOnce();
});

it("startPlugins forwards the actual stage3 bundle without copying its participant", async () => {
  const { input, ports } = compositionInput170();
  const participant = unusedPort170<Stage3RuntimePorts["persistence"]>("participant");
  vi.spyOn(persistenceFactory, "createPersistenceHost").mockResolvedValue({
    participant,
    settings: unusedPort170("settings"), recovery: unusedPort170("recovery"),
    request: () => Promise.reject(new Error("Not admitted")),
    dispose: async () => {},
  });
  const attached = await composePersistence170(input, ports);
  const manager = await PluginManager.create({
    sources: [],
    store: {
      load: async () => ({ disabled: new Set<string>(), legacyDisabledIds: new Set<string>() }),
      save: async () => {},
    },
    safeMode: true,
    launcher: async () => { throw new Error("Resource-free forwarding test"); },
    locale: "en",
  });
  const createManager = vi.spyOn(PluginManager, "create").mockResolvedValue(manager);
  await start(fakeDialogs(), {
    commandLine: { developmentDirectories: [], safeMode: true },
    stage3: attached.stage3,
  });
  expect(createManager.mock.calls.at(-1)![0].stage3).toBe(attached.stage3);
});
```

Run:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop test -- src/main/plugins/controller.test.ts
```

Expected failure: missing `composePersistence170` export. The forwarding test may already pass at P160; retain it as the R170 identity regression. An unavailable prerequisite import is a blocked prerequisite, not the intended red assertion.

- [ ] **Step 2: Implement the factory attachment and preserve the existing runtime hooks.**

Add to `controller.ts`, combining with existing imports:

```ts
import type { Stage3RuntimePorts } from "@kobrixa/plugin-runtime";
import { createPersistenceHost, type PersistenceHost } from "./persistence/host-port.js";

export async function composePersistence170(
  input: Parameters<typeof createPersistenceHost>[0],
  ports: Pick<Stage3RuntimePorts, "device" | "ui">,
): Promise<{ host: PersistenceHost; stage3: Stage3RuntimePorts }> {
  input.profile.assertHeld();
  const host = await createPersistenceHost(input);
  try {
    input.profile.assertHeld();
    return {
      host,
      stage3: {
        device: ports.device,
        persistence: host.participant,
        ui: ports.ui,
      },
    };
  } catch (error) {
    await host.dispose();
    throw error;
  }
}
```

P160 already adds `stage3?: PluginManagerOptions["stage3"]` to `StartPluginsOptions`. Verify its exact forwarding expression in `PluginManager.create` is:

```ts
...(options.stage3 === undefined ? {} : { stage3: options.stage3 }),
```

If P160 lacks that expression, D170 adds it in the existing object literal; do not replace the rest of `startPlugins`, its safe-mode-before-directory-read ordering, or its session marker. This optional property is for legacy/resource-free runtime callers; the production P170 desktop call must always pass the constructed bundle.

R170 reviews that manager uses the existing B1 lifecycle path: device `retire(owner, reason)` followed synchronously by `persistence.freeze(owner, drainReason, deadline, grant)` using the identical non-null grant object. If `retire().drain` is null, omit the fourth argument instead of passing null. No `await`, spread clone or timeout reset between these calls. Device reason `crashed` does not invent a new protocol DrainReason: the already-frozen B1 mapping/ownerLost path applies. Healthy `released`/`disconnected`/`suspended`/provider endings go through `endReservation`, not owner retirement. R170 does not add device, Electron or worker construction to runtime.

Run the focused test and existing runtime lifecycle suite:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop test -- src/main/plugins/controller.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime test -- src/manager.test.ts src/ui-lifecycle.test.ts
```

Expected: the attachment tests pass; runtime's same-turn/grant-identity/retirement tests stay green. This is branch-local wiring evidence, not real disk drain evidence.

- [ ] **Step 3: Commit the reviewed R170/D170 composition slice.**

Controller implementation commands, not instructions for the plan writer to execute:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git add apps/desktop/src/main/plugins/controller.ts apps/desktop/src/main/plugins/controller.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git commit -m "feat(desktop): attach the real stage 3 persistence participant"
```

Record R170's reviewed runtime commit and `changed paths: none` when existing hooks already satisfy the tests. Do not manufacture a runtime edit to obtain a new SHA.

- [ ] **Step 4: Write failing tests for the allowlisted, one-use renderer import snapshot.**

The helper below uses the exact B2 §9.2 ceiling of 128 renderer preference entries / 64 KiB; it does not redefine the import inventory ceilings (4096 names, 512 items, 2 MiB inventory, 64-item batches). Never enumerate localStorage. Tests deliberately distinguish missing challenge, storage access failure, and an all-null snapshot.

Create `renderer/settings/legacy-preferences-bridge.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { LegacyPreferenceChallenge } from "../../shared/plugin-persistence.js";
import { collectLegacyPreferences, submitLegacyPreferences } from "./legacy-preferences-bridge.js";

const challenge: LegacyPreferenceChallenge = {
  nonce: "10000000-0000-4000-8000-000000000002",
  scope: {
    hostEpoch: "10000000-0000-4000-8000-000000000001",
    workbenchInstance: "10000000-0000-4000-8000-000000000003",
  },
  descriptorId: "synthetic.preferences",
  keys: ["fixture.layout", "fixture.number"],
};

describe("V170 legacy preference snapshot", () => {
  it("reads only the trusted allowlist, preserves raw strings/null, and never writes originals", () => {
    const storage = {
      getItem: vi.fn((key: string) => key === "fixture.layout" ? "001" : null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(),
    };
    expect(collectLegacyPreferences(challenge, storage)).toEqual({
      nonce: challenge.nonce,
      scope: challenge.scope,
      entries: [
        { key: "fixture.layout", raw: "001" },
        { key: "fixture.number", raw: null },
      ],
    });
    expect(storage.getItem.mock.calls).toEqual([["fixture.layout"], ["fixture.number"]]);
    for (const method of [storage.setItem, storage.removeItem, storage.clear, storage.key])
      expect(method).not.toHaveBeenCalled();
  });

  it("keeps rejected challenge pending without reading storage", async () => {
    const storage = vi.fn(() => ({ getItem: vi.fn(() => null) }));
    const submit = vi.fn(async () => ({ state: "accepted" as const }));
    expect(await submitLegacyPreferences({ challenge: async () => { throw new Error("Descriptor not admitted"); }, submit }, storage, "synthetic.preferences")).toBe("pending");
    expect(storage).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not submit empty data after localStorage throws", async () => {
    const submit = vi.fn(async () => ({ state: "accepted" as const }));
    expect(await submitLegacyPreferences(
      { challenge: async () => challenge, submit },
      () => { throw new Error("Access denied"); }, "synthetic.preferences",
    )).toBe("pending");
    expect(submit).not.toHaveBeenCalled();
  });

  it("requires the main durable acceptance result before reporting accepted", async () => {
    const submit = vi.fn(async () => ({ state: "pending" as "pending" | "accepted" | "reconciled" }));
    const api = { challenge: async () => challenge, submit };
    expect(await submitLegacyPreferences(api, () => ({ getItem: () => null }), "synthetic.preferences")).toBe("pending");
    submit.mockResolvedValueOnce({ state: "accepted" });
    expect(await submitLegacyPreferences(api, () => ({ getItem: () => null }), "synthetic.preferences")).toBe("accepted");
  });

  it.each([
    { ...challenge, keys: ["a", "a"] },
    { ...challenge, keys: Array.from({ length: 129 }, (_, index) => `fixture.${index}`) },
  ])("rejects invalid allowlists before reading", (invalid) => {
    const getItem = vi.fn(() => null);
    expect(() => collectLegacyPreferences(invalid, { getItem })).toThrow();
    expect(getItem).not.toHaveBeenCalled();
  });

  it("bounds UTF-8 bytes and refuses oversized snapshots", () => {
    expect(() => collectLegacyPreferences(challenge, { getItem: () => "界".repeat(22_000) })).toThrow();
  });
});
```

Append to `shared/plugin-persistence.test.ts`:

```ts
import { expect, it } from "vitest";
import { isLegacyPreferencesSnapshot } from "./plugin-persistence.js";

const snapshot170 = {
  nonce: "10000000-0000-4000-8000-000000000002",
  scope: {
    hostEpoch: "10000000-0000-4000-8000-000000000001",
    workbenchInstance: "10000000-0000-4000-8000-000000000003",
  },
  entries: [{ key: "fixture.layout", raw: null }],
};

it("accepts exactly the frozen LegacyPreferencesSnapshot shape", () => {
  expect(isLegacyPreferencesSnapshot(snapshot170)).toBe(true);
  expect(isLegacyPreferencesSnapshot({ ...snapshot170, targetSourceKey: "foreign" })).toBe(false);
  expect(isLegacyPreferencesSnapshot({ ...snapshot170, entries: [{ key: "x", raw: 1 }] })).toBe(false);
  expect(isLegacyPreferencesSnapshot({ ...snapshot170, nonce: snapshot170.nonce.toUpperCase() })).toBe(true);
  expect(isLegacyPreferencesSnapshot({ ...snapshot170, nonce: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" })).toBe(false);
  expect(isLegacyPreferencesSnapshot({ ...snapshot170, scope: { ...snapshot170.scope, windowId: 1 } })).toBe(false);
  expect(isLegacyPreferencesSnapshot({ ...snapshot170, entries: [{ key: "x", raw: null }, { key: "x", raw: "1" }] })).toBe(false);
  expect(isLegacyPreferencesSnapshot({ ...snapshot170, entries: [{ key: "x", raw: "界".repeat(22_000) }] })).toBe(false);
});
```

The all-digit test nonce is unchanged by `toUpperCase`; the separate alphabetic uppercase UUID is rejected. This pins canonical lowercase UUIDv4 rather than a loose UUID check.

Run:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop test -- src/shared/plugin-persistence.test.ts src/renderer/settings/legacy-preferences-bridge.test.ts
```

Expected failure: missing bridge exports. Keep these `.test.ts`, not `.test.tsx`, because the desktop Vitest include is `src/**/*.test.ts`.

- [ ] **Step 5: Implement the shared validator and the read-only renderer collector.**

Append to `shared/plugin-persistence.ts`; merge type-only imports/re-exports from T0, do not duplicate `LegacyPreferencesSnapshot`:

```ts
import type { CoreWindowScope } from "@kobrixa/plugin-runtime";
import type { LegacyPreferencesSnapshot, LegacyPreferenceChallenge, LegacyImportHostPort } from "../main/plugins/persistence/import-sources.js";
export type { LegacyPreferencesSnapshot } from "../main/plugins/persistence/import-sources.js";

export type { LegacyPreferenceChallenge } from "../main/plugins/persistence/import-sources.js";
export interface LegacyPreferencesApi {
  challenge(descriptorId: string): Promise<LegacyPreferenceChallenge>;
  submit(snapshot: LegacyPreferencesSnapshot): ReturnType<LegacyImportHostPort["acceptPreferencesEvidence"]>;
}

const importHandle170 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const encoder170 = new TextEncoder();

function exactObject170(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === names.length &&
    names.every((name) => Object.hasOwn(value, name));
}

export function isLegacyPreferencesSnapshot(value: unknown): value is LegacyPreferencesSnapshot {
  if (!exactObject170(value, ["nonce", "scope", "entries"])) return false;
  if (typeof value.nonce !== "string" || !importHandle170.test(value.nonce)) return false;
  if (!exactObject170(value.scope, ["hostEpoch", "workbenchInstance"])) return false;
  if (![value.scope.hostEpoch, value.scope.workbenchInstance].every(
    (item) => typeof item === "string" && importHandle170.test(item),
  )) return false;
  if (!Array.isArray(value.entries) || value.entries.length > 128) return false;
  const keys = new Set<string>();
  let codeUnits = 0;
  for (const entry of value.entries) {
    if (!exactObject170(entry, ["key", "raw"])) return false;
    if (typeof entry.key !== "string" || entry.key.length === 0 || entry.key.includes("\0")) return false;
    if (entry.raw !== null && typeof entry.raw !== "string") return false;
    if (keys.has(entry.key)) return false;
    codeUnits += entry.key.length + (typeof entry.raw === "string" ? entry.raw.length : 0);
    if (codeUnits > 64 * 1024) return false;
    keys.add(entry.key);
  }
  return encoder170.encode(JSON.stringify(value)).byteLength <= 64 * 1024;
}
```

Create the complete `renderer/settings/legacy-preferences-bridge.ts`:

```ts
import {
  isLegacyPreferencesSnapshot,
  type LegacyPreferenceChallenge,
  type LegacyPreferencesApi,
  type LegacyPreferencesSnapshot,
} from "../../shared/plugin-persistence.js";

export function collectLegacyPreferences(
  challenge: LegacyPreferenceChallenge,
  storage: Pick<Storage, "getItem">,
): LegacyPreferencesSnapshot {
  const empty: LegacyPreferencesSnapshot = {
    nonce: challenge.nonce,
    scope: { ...challenge.scope },
    entries: challenge.keys.map((key) => ({ key, raw: null })),
  };
  if (!isLegacyPreferencesSnapshot(empty)) throw new Error("Invalid import challenge");
  const snapshot: LegacyPreferencesSnapshot = {
    ...empty,
    entries: challenge.keys.map((key) => ({ key, raw: storage.getItem(key) })),
  };
  if (!isLegacyPreferencesSnapshot(snapshot)) throw new Error("Import snapshot exceeds its limit");
  return snapshot;
}

export async function submitLegacyPreferences(
  api: LegacyPreferencesApi,
  storage: () => Pick<Storage, "getItem">,
  descriptorId: string,
): Promise<"accepted" | "pending" | "reconciled"> {
  try {
    const challenge = await api.challenge(descriptorId);
    const snapshot = collectLegacyPreferences(challenge, storage());
    return (await api.submit(snapshot)).state;
  } catch {
    return "pending";
  }
}
```

Run the Step 4 command again. Expected: all tests pass, with no writes/removals of legacy keys. These helpers do not parse raw values, select mappings or mark imports complete; T6 remains authoritative.

- [ ] **Step 6: Write failing sender-bound coordinator bridge tests.**

Append to `main/ipc.test.ts`, using the existing trusted `registerIpc` sender/frame harness. The bridge receives a scope resolved from each invoke event, never a global current window. These adapter tests do not replace T7's durable worker cases.

```ts
import { legacyPreferencesFor170 } from "./plugins/controller.js";
import type { LegacyImportHostPort } from "./plugins/persistence/import-sources.js";

it("binds challenge and submission to the invoking workbench", async () => {
  const scope = { hostEpoch: "10000000-0000-4000-8000-000000000001",
    workbenchInstance: "10000000-0000-4000-8000-000000000003" };
  const challenge = { scope, descriptorId: "synthetic.preferences",
    nonce: "10000000-0000-4000-8000-000000000002", keys: ["fixture.layout"] };
  const issuePreferences = vi.fn<LegacyImportHostPort["issuePreferences"]>(async () => challenge);
  const acceptPreferencesEvidence = vi.fn<LegacyImportHostPort["acceptPreferencesEvidence"]>(async () => ({ state: "pending" }));
  const api = legacyPreferencesFor170(scope, { issuePreferences, acceptPreferencesEvidence });
  expect(await api.challenge(challenge.descriptorId)).toEqual(challenge);
  expect(issuePreferences).toHaveBeenCalledExactlyOnceWith({ descriptorId: challenge.descriptorId, scope });
  const snapshot = { nonce: challenge.nonce, scope, entries: [{ key: "fixture.layout", raw: "001" }] };
  expect(await api.submit(snapshot)).toEqual({ state: "pending" });
  acceptPreferencesEvidence.mockResolvedValueOnce({ state: "reconciled" });
  expect(await api.submit(snapshot)).toEqual({ state: "reconciled" });
  await expect(api.submit({ ...snapshot, scope: { ...scope, workbenchInstance: challenge.nonce } })).rejects.toThrow();
  expect(acceptPreferencesEvidence).toHaveBeenCalledTimes(2);
});
```

Run before implementation, expecting missing `legacyPreferencesFor170`, then rerun after Step 7:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop test -- src/main/ipc.test.ts src/preload/index.test.ts src/main/plugins/controller.test.ts
```

Add preload assertions that `api.plugins.legacyPreferences.challenge("synthetic.preferences")` forwards that descriptor only and `submit(snapshot)` returns each of accepted/pending/reconciled unchanged. Retain forged sender/subframe rejection tests in the existing IPC harness. Wrong descriptor/key/window, duplicate/oversize evidence, failed persistence before consumption, uncertain publication/restart, and fresh-window reconciliation must additionally pass `plugin-persistence-import.test.mjs` with the real backend.

- [ ] **Step 7: Delegate durable challenges to T6 and expose the exact PluginsApi facet.**

Append to `controller.ts`:

```ts
import type { CoreWindowScope } from "@kobrixa/plugin-runtime";
import type { LegacyImportHostPort } from "./persistence/import-sources.js";
import { isLegacyPreferencesSnapshot, type LegacyPreferencesApi } from "../../shared/plugin-persistence.js";

export function legacyPreferencesFor170(
  scope: CoreWindowScope,
  imports: Pick<LegacyImportHostPort, "issuePreferences" | "acceptPreferencesEvidence">,
): LegacyPreferencesApi {
  return {
    challenge: (descriptorId) => imports.issuePreferences({ descriptorId, scope }),
    submit: async (snapshot) => {
      if (!isLegacyPreferencesSnapshot(snapshot) ||
          snapshot.scope.hostEpoch !== scope.hostEpoch ||
          snapshot.scope.workbenchInstance !== scope.workbenchInstance)
        throw new Error("Invalid preference scope");
      return imports.acceptPreferencesEvidence({ ...snapshot, scope });
    },
  };
}
```

In `main/ipc.ts` register through the existing trusted sender/top-frame wrapper; `scopeFor` below is the main lifetime registry lookup supplied by D160, evaluated independently for each event:

```ts
export function registerLegacyPreferencesIpc170(
  handle: IpcHandle,
  imports: LegacyImportHostPort,
  scopeFor: (event: IpcMainInvokeEvent) => CoreWindowScope,
): void {
  handle("persistence:legacy-preferences-challenge", (event, descriptorId: string) =>
    legacyPreferencesFor170(scopeFor(event), imports).challenge(descriptorId));
  handle("persistence:legacy-preferences-submit", (event, snapshot: LegacyPreferencesSnapshot) =>
    legacyPreferencesFor170(scopeFor(event), imports).submit(snapshot));
}
```

Import the referenced types from their defining modules and the helper from controller. Add `legacyPreferences: LegacyPreferencesApi` to `PluginsApi` in `shared/plugins.ts`, not the root `KobrixaApi`. Add the following inside `plugins` in both real preload and `tests/desktop/preload.cjs`:

```ts
legacyPreferences: {
  challenge: (descriptorId) => ipcRenderer.invoke("persistence:legacy-preferences-challenge", descriptorId),
  submit: (snapshot) => ipcRenderer.invoke("persistence:legacy-preferences-submit", snapshot),
},
```

T6 owns the one in-flight challenge per scope/descriptor and durable nonce state; the bridge issues no UUID, no key allowlist and no consumption flag. On window retirement call `imports.retirePreferences(scope)`. T6 persists raw evidence/digest before atomic consumption, restores it on restart, reconciles uncertain writes without republishing and rejects changed replay. `acceptPreferences` remains the Promise<void> compatibility facet; trusted UI uses `acceptPreferencesEvidence`.

Run Step 6 and:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; node --test tests/desktop/smoke-harness.test.mjs
```

Expected: exact real/smoke preload parity and no root-level legacyPreferences property.

- [ ] **Step 8: Attach the renderer import request to the existing settings shell.**

First append this failing integration test to `settings-panel.test.ts`, retaining its jsdom environment and `beforeEach`/`afterEach` cleanup; extend its existing `render` helper to forward optional SettingsPanel props:

```ts
it("requests the host import challenge when Settings opens and preserves raw preference values", async () => {
  await act(async () => root.render(null));
  const challenge = {
    nonce: "10000000-0000-4000-8000-000000000002",
    scope: {
      hostEpoch: "10000000-0000-4000-8000-000000000001",
      workbenchInstance: "10000000-0000-4000-8000-000000000003",
    },
    descriptorId: "synthetic.preferences",
    keys: ["fixture.layout"],
  };
  const getItem = vi.spyOn(Storage.prototype, "getItem").mockReturnValue("001");
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  const api = { challenge: vi.fn(async () => challenge), submit: vi.fn(async () => ({ state: "accepted" as const })) };
  Object.assign(window.kobrixa.plugins, { legacyPreferences: api });
  try {
    await act(async () => render({ legacyDescriptorId: "synthetic.preferences" }));
    expect(api.challenge).toHaveBeenCalledExactlyOnceWith("synthetic.preferences");
    expect(api.submit).toHaveBeenCalledExactlyOnceWith({
      nonce: challenge.nonce,
      scope: challenge.scope,
      entries: [{ key: "fixture.layout", raw: "001" }],
    });
    expect(getItem).toHaveBeenCalledWith("fixture.layout");
    expect(setItem).not.toHaveBeenCalled();
  } finally {
    getItem.mockRestore();
    setItem.mockRestore();
  }
});
```

Run:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop test -- src/renderer/settings/settings-panel.test.ts
```

Expected failure: the challenge/submission callbacks were never called. Then add this import in `renderer/settings/settings-panel.tsx`:

```ts
import { submitLegacyPreferences } from "./legacy-preferences-bridge.js";
```

Inside the existing `SettingsPanel` component, after its existing hooks and before returning JSX, add the complete effect:

```ts
useEffect(() => {
  if (!active) return;
  if (legacyDescriptorId === undefined) return;
  void submitLegacyPreferences(window.kobrixa.plugins.legacyPreferences, () => window.localStorage, legacyDescriptorId);
}, [active, legacyDescriptorId]);
```

The settings shell receives `legacyDescriptorId` only from an admitted main-owned descriptor; foundations expose it only in the synthetic fixture and leave it undefined in product settings. React remount/StrictMode duplicate delivery is harmless because main admits one in-flight snapshot and consumes the nonce once after durable acceptance. A failed snapshot stays pending in T6; reopening Settings explicitly retries/reconciles the same challenge. A new renderer lifetime requires a fresh host-issued scope/nonce and a complete resnapshot. Do not auto-reset the old `SettingsStore`, delete its localStorage keys or introduce actual device/Lab mappings. This bridge attaches the generic synthetic import mechanism only.

For contributed settings, D170 exposes the exact `PluginsApi.settings` type from AM-28:

```ts
type SettingsApi170 = Omit<BoundSettingsService, "open"> & {
  open(input: { sourceKey: string; resourceDigest: Sha256 }): ReturnType<BoundSettingsService["open"]>;
};
```

Implement dedicated open/read/update/reset/watch/dispose IPC handlers, binding each to the trusted invoking scope and checking ownership of every form binding before dispatch to `host.settings`. Open inserts `scope`; renderer cannot supply it. Watch cleanup is tied to the validated binding and sender lifetime. Resolve source/digest through the admitted static catalog; `sources.coreOwner` supplies main-only namespace ownership without activating an optional process. No plugin principal is constructed by renderer.

At the existing V160 settings-controls mount retain one form instance and install the explicit controls adapter. Import `createContributedSettingsForm` and `createSettingsFieldMap` from B2-T3's `contributed-settings-form.tsx`, and `attachSettingsControls` from B1-T7's `plugin-ui/host-ports.ts`. The browser adapter below deliberately drops the host-only open scope; main independently inserts the actual sender scope:

```ts
const api = window.kobrixa.plugins.settings;
const service: BoundSettingsService = {
  ...api,
  open: ({ sourceKey, resourceDigest }) => api.open({ sourceKey, resourceDigest }),
};
const form = createContributedSettingsForm(controls, service);
const detach = attachSettingsControls(controls, {
  retry: form.retry.bind(form), reload: form.reload.bind(form),
  fieldMap: createSettingsFieldMap,
});
let disposed = false;
let binding: SettingsFormBinding | undefined;
let unwatch: (() => void) | undefined;
void api.open({ sourceKey, resourceDigest }).then((opened) => {
  if (disposed) { api.dispose(opened.binding); return; }
  binding = opened.binding;
  form.open(opened.binding, opened.resource, opened.snapshot);
  unwatch = api.watch(opened.binding, () => {
    void api.read(opened.binding).then((result) => {
      if (disposed || binding !== opened.binding) return;
      if (result.ok) form.replaceSnapshot(opened.binding, result.value);
      else form.showFailure(opened.binding, result.error);
    });
  });
});
const dispose = () => {
  disposed = true;
  unwatch?.();
  if (binding !== undefined) { form.dispose(binding); api.dispose(binding); }
  binding = undefined;
  detach();
};
```

Use this mount in the shell's existing asynchronous resource-load error boundary; an open/read transport rejection remains a visible load error with explicit reload, never defaults. Snapshot replacement uses T3's draft-preserving reconciliation; explicit reload remains exclusively the control action. Return `dispose` from the mount effect and call it on form switch/unmount, including when open is still pending. The single workbench form limit remains.

Add `legacyDescriptorId?: string` to the settings shell props and supply `"synthetic.preferences"` only in its synthetic integration test; assert `challenge` receives that exact descriptor. Before wiring, add settings-panel tests using T3's real controls adapter and the worker-backed service (not a success-returning IPC fake): no-process initial snapshot; stale digest refusal; two views CAS one winner; watch invalidation preserves loser draft; explicit retry/reload; number `1` distinct from string `"1"`; literal dotted keys; form switch/watch disposal and late read. Run the focused commands below red then green, and repeat these operations in T7's actual `storage-ui-pressure` case. No Apply button or UI v1 enum widening.

Run:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop test -- src/renderer/settings/legacy-preferences-bridge.test.ts src/renderer/settings/settings-panel.test.ts src/renderer/settings/contributed-settings-form.test.ts
```

Expected: existing settings behavior and the new bridge tests pass. B2-RF2 remains pinned by the delivered form test: literal dotted key; numeric `1` versus string `"1"` enum; stale revision while dirty; original draft survives; explicit retry; no Apply button; no v1 LocalId widening. DOM, keyboard, 16-field pagination and paint timing require the actual browser harness, **controller runs outside sandbox**.

- [ ] **Step 9: Commit the bounded renderer/main import bridge.**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git add apps/desktop/src/main/plugins/controller.ts apps/desktop/src/main/plugins/controller.test.ts apps/desktop/src/main/ipc.ts apps/desktop/src/main/ipc.test.ts apps/desktop/src/shared/plugins.ts apps/desktop/src/shared/plugin-persistence.ts apps/desktop/src/shared/plugin-persistence.test.ts apps/desktop/src/preload/index.ts apps/desktop/src/preload/index.test.ts apps/desktop/src/renderer/settings/settings-panel.tsx apps/desktop/src/renderer/settings/settings-panel.test.ts apps/desktop/src/renderer/settings/legacy-preferences-bridge.ts apps/desktop/src/renderer/settings/legacy-preferences-bridge.test.ts tests/desktop/preload.cjs
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git commit -m "feat(desktop): add bounded nonce-bound legacy preference snapshots"
```

Do not include another owner's pending form or importer changes. The coordinator remains the sole durable nonce authority.

- [ ] **Step 10: Write failing K170 worker packaging tests.**

Append to `main/packaging.test.ts`, combining imports of `readFile`, `stat` and the packaging exports with existing imports. This checks build artifact selection and rejects a checkout fallback; it does not claim the worker's AM-23 startup protocol is implemented.

```ts
import { readFile } from "node:fs/promises";
import {
  PERSISTENCE_WORKER_ENTRY,
  persistenceWorkerPath,
  withPersistenceWorkerUnpack,
} from "../../packaging.js";

it("K170 resolves the worker only within the selected development or installed artifact", () => {
  expect(PERSISTENCE_WORKER_ENTRY).toBe("src/main/plugins/persistence/worker.ts");
  expect(persistenceWorkerPath({ packaged: false, resourcesPath: "/unused", buildRoot: "/build" }))
    .toBe(path.join("/build", "persistence-worker.cjs"));
  expect(persistenceWorkerPath({ packaged: true, resourcesPath: "/installed/resources", buildRoot: "/checkout/.vite/build" }))
    .toBe(path.join("/installed/resources", "app.asar.unpacked", ".vite", "build", "persistence-worker.cjs"));
});

it("K170 preserves the previous native/source unpack glob while adding the worker", () => {
  expect(withPersistenceWorkerUnpack("**/*.node"))
    .toBe("{**/*.node,.vite/build/persistence-worker.cjs}");
  expect(withPersistenceWorkerUnpack("{**/*.node,.vite/build/fixture.cjs}"))
    .toBe("{{**/*.node,.vite/build/fixture.cjs},.vite/build/persistence-worker.cjs}");
});

it("K170 registers one worker entry and uses the existing main build config", async () => {
  const config = await readFile(new URL("../../forge.config.ts", import.meta.url), "utf8");
  expect(config.match(/entry:\s*PERSISTENCE_WORKER_ENTRY/g)).toHaveLength(1);
  expect(config).toContain('config: "vite.main.config.ts"');
  const mainConfig = await readFile(new URL("../../vite.main.config.ts", import.meta.url), "utf8");
  expect(mainConfig).toContain('"persistence-worker.cjs"');
  expect(mainConfig).toContain('"main.cjs"');
});
```

Run:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop test -- src/main/packaging.test.ts
```

Expected failure: missing worker constants/path helpers. The entry-count test is a configuration guard; only the packaged runtime test can prove the worker starts.

- [ ] **Step 11: Register the worker with Forge, preserving K160 assets.**

Append to `apps/desktop/packaging.ts` (it already imports `path`):

```ts
export const PERSISTENCE_WORKER_ENTRY = "src/main/plugins/persistence/worker.ts";

export function persistenceWorkerPath(input: {
  packaged: boolean;
  resourcesPath: string;
  buildRoot: string;
}): string {
  return input.packaged
    ? path.join(input.resourcesPath, "app.asar.unpacked", ".vite", "build", "persistence-worker.cjs")
    : path.join(input.buildRoot, "persistence-worker.cjs");
}

export function withPersistenceWorkerUnpack(existing: string): string {
  return `{${existing},.vite/build/persistence-worker.cjs}`;
}
```

Extend the existing import from `./packaging.js` in `forge.config.ts` with `PERSISTENCE_WORKER_ENTRY` and `withPersistenceWorkerUnpack`. Wrap the P160 `asar.unpack` string expression in `withPersistenceWorkerUnpack` applied to that same string; do not replace K160's existing optional-source/native unpack patterns. In the VitePlugin `build` array insert exactly one entry:

```ts
{
  entry: PERSISTENCE_WORKER_ENTRY,
  config: "vite.main.config.ts",
  target: "main",
},
```

The installed Forge plugin's `forgeConfigSelf.entry` is available in its Vite config environment and `getBuildConfig` sets `emptyOutDir: false`. Convert `vite.main.config.ts` to this complete config if P160 has no additional options; if it has K160 options, retain them and change only the callback/output selection shown here:

```ts
import { defineConfig } from "vite";

export default defineConfig(({ forgeConfigSelf }) => {
  const worker = forgeConfigSelf !== undefined &&
    "entry" in forgeConfigSelf &&
    forgeConfigSelf.entry === "src/main/plugins/persistence/worker.ts";
  return {
    build: {
      sourcemap: true,
      rollupOptions: {
        external: ["node-hid", "electron-updater"],
        output: { entryFileNames: worker ? "persistence-worker.cjs" : "main.cjs" },
      },
    },
  };
});
```

Do not activate product motor/Lab/device Forge entries. Existing license/source-map collection traverses `.vite`; the worker map is included by that existing traversal. Preserve its fail-on-missing-license behavior.

Run the packaging test again; expected pass. Then build the actual package, **controller runs outside sandbox**:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm build:desktop
```

Expected: host and worker are separate CJS artifacts, worker starts from `app.asar.unpacked` from an arbitrary working directory, no external Node/PATH/checkout fallback, one worker for the held profile, and shutdown leaves no worker process/thread. Missing worker must be an explicit startup/recovery error, never an in-process store fallback.

- [ ] **Step 12: Commit the K170 registration slice.**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git add apps/desktop/forge.config.ts apps/desktop/vite.main.config.ts apps/desktop/packaging.ts apps/desktop/src/main/packaging.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git commit -m "build(desktop): register the packaged persistence worker"
```

- [ ] **Step 13: Complete D170 startup, lifecycle and recovery acceptance at the frozen seam.**

Use the amended factory in the existing P160 main composition. Import `openStoreRoot` from `persistence/filesystem.ts`, `startPersistenceWorker` from `persistence/worker.ts`, `persistenceWorkerPath` from `packaging.ts`, the import factories from T6, and composition types from T5. All bindings below come from the existing main catalog/registry, broker, action ledger and R170 runtime attachment, not external composition injection:

```ts
profileLock.assertHeld();
const root = await openStoreRoot({ userData: app.getPath("userData"), profile: profileLock });
const workerEntry = persistenceWorkerPath({
  packaged: app.isPackaged, resourcesPath: process.resourcesPath, buildRoot: __dirname,
});
const { backend, recovery } = await startPersistenceWorker({
  profile: profileLock, root, workerEntry, now: monotonicNow,
});
const barrier = createLegacyWriterBarrier({ backend, writers: legacyWriters, importOwner });
await barrier.restore();
const imports = createLegacyImportCoordinator({
  backend, sources: backend.sources, barrier, descriptors: legacyDescriptors,
  currentScope, currentSource, importOwner,
});
const composition: PersistenceCompositionInput = {
  backend, sources: persistenceSources, events: broker.events,
  dispatchDrain: (...args) => runtimeAttachment.dispatchDrain(...args),
  imports,
};
const persistence170 = await composePersistence170({
  profile: profileLock, composition, reservations: broker.reservations,
  actions: userPersistenceActions, actionAdapter: persistenceActions,
  coreActions, now: monotonicNow, hasPermission,
}, { device: broker.resources, ui: uiCatalog });
```

The forwarding closure preserves the exact `DrainDispatcher` argument tuple. R170 supplies `PluginManager.stage3Runtime()` before admission and retains original peer/generation during bounded drain. No fresh channel or mutation replay. `persistenceSources: PersistenceSourcePort` is the D170 adapter over the admitted static catalog/registry: `current(owner)` checks current resource ownership, `settings({sourceKey,resourceDigest})` returns only the admitted `UiOwner`, validated `SettingsResourceV1` and matching validation digest, `coreOwner({sourceKey,scope})` binds the admitted source/workbench/host epoch independently of process activation. Safe-mode gating precedes all optional resource reads. Neither renderer nor manifest identity creates these owners.

`legacyWriters` and `legacyDescriptors` are empty for product foundations; only the T7 synthetic composition registers synthetic controls/mappers. Restore barriers before writer admission. The worker resolver selects allowlisted mapper IDs and fixed roots, retains mapped payload pins and appends at most 256 KiB to the admitted ticket; no functions, root paths or 8 MiB payload cross main transport. Use backend.imports atomic receipt tags and backend.evidence auxiliary/recovery reads, never a second filesystem store. Host construction owns backend disposal on failure; failures before construction dispose backend in main's startup cleanup. After successful construction only host owns backend disposal.

Ready/recovery is awaited before exposing services. When `recovery === "blocked"`, expose read-only core recovery, keep ordinary persistence mutations fenced and do not substitute writable defaults. Preserve startup error propagation, one original held lock and idempotent teardown. No StorePath casts, second lock, WeakMap or external composition loader.

Pass `persistence170.stage3` to the existing coordinator construction. Replace the baseline `startPlugins` invocation with the complete call below, retaining any additional P160 options under D170 review:

```ts
const plugins = await startPlugins({
  userData: app.getPath("userData"),
  builtins: BUILTIN_PLUGIN_SOURCES,
  commandLine: pluginSettings,
  dialogs: electronPluginDialogs(() => mainWindow, pluginLanguage),
  locale: pluginLanguage,
  stage3: persistence170.stage3,
});
```

Add `composePersistence170` to the existing controller import. Do not introduce another listener: B1's existing listener is installed once before the public request router/checkpoint admission becomes reachable. The real factory receives the same `broker.reservations` object that the coordinator listens to.

The required construction order is: Electron single-instance gate → one held profile lock → journal recovery → broker → one persistence worker and recovery scan → actual host/participant → existing coordinator/listener → runtime/source/router/settings admission → workbench. Optional features remain suppressed in safe mode; generic core recovery works without optional schemas, processes, subscriptions or mappings. Dispose host/worker only after the existing complete disposition gate; do not release the lock while an unknown write/journal ticket remains unresolved.

Required actual assertions, supplied by the domain harnesses and repeated together in X-T1:

| Case | Required observation |
| --- | --- |
| F20/U17 second instance | Focus/restore primary; zero secondary journal, worker, provider or plugin construction; primary recording uninterrupted. |
| A-F19/B2-RF3 registration race | Ending is recorded synchronously while durable checkpoint registration is pending; final target appears once after registration settles; first deadline never resets. |
| B1-U12 release | End notification invokes `endReservation`; no consumer `retire`, `freeze` or process exit; unrelated settings still commit. |
| B1-U12 disable/reload | Same-turn `retire` then `freeze`, identical grant reference; deferred dispatch; accepted tickets retained. |
| B1-U12 prior session | Core Disconnect includes pending finals from earlier ended sessions as well as `quiesce().ended`; no duplicate final; stop/save/journal blockers prevent physical disconnect. |
| B1-U17 suspend | `quiesce(sessionId, {reason:"suspended"})`; healthy owner survives; wake does not replay motion, recording, gesture, subscription or command. |
| B1-U12 renderer loss | Main revokes bindings immediately, drains with fixed deadline, tears process down; only explicit open/command gets a new generation; no old owner/action/token reuse. |
| B2 safe mode/export | `manage` opens trusted detail; fresh core action reaches retry/discard/export; feature actionRef is never minted from a core token; no native path in DTO. |
| Legacy Lab | Existing save/close/update guards still block on old recordings; a resource-free new participant cannot declare those recordings saved. |

The budget is `max(10, 15 + 5) + 4 = 24` seconds with a 25-second outer safety net. Storage drain is 10 seconds; device stop 15 seconds then journal 5 seconds; manager process bound 4 seconds including 2-second shutdown request. The safety net produces a visible blocker, not automatic force exit. Retry does not reset the first drain deadline or staging TTL (30-second idle/120-second total). Preserve the existing native close/update blockers until 3D migrates old Lab storage.

Core status retains the exact `CoreRecoveryItem.actions[].kind` enum `stop | reconcile | clear-resolved | retry-save | manage`. B2 recovery's `retry | export | discard` descriptors stay in its trusted detail view. D170 implements `PluginsApi.persistenceRecovery: PersistenceRecoveryBridge` from AM-18 in shared/plugin-persistence.ts and both preloads. Keep `plugins.recovery: CoreRecoveryPort` unchanged. A trusted `manage` action sends `onOpen({itemId})` to the validated original workbench while `CoreRecoveryPort.act` still returns `CoreRecoverySnapshot`. Mount B1-T7's generic detail via V170; subscribe/unsubscribe on its existing lifetime.

The shared bridge declaration is exactly:

```ts
interface PersistenceRecoveryBridge {
  snapshot(input: { itemId: Handle }): Promise<PersistenceResult<PersistenceRecoverySnapshot>>;
  act(input: { itemId: Handle; optionId: Handle }): Promise<PersistenceResult<PersistenceRecoverySnapshot>>;
  onOpen(listener: (input: { itemId: Handle }) => void): () => void;
  onChanged(listener: () => void): () => void;
}
```

For detail `snapshot({itemId})`, main resolves the core item to the persistence recovery ID and authorized scope; no renderer namespace is accepted. For `act({itemId,optionId})`, look up the host-issued option in the current item/revision/generation/scope, mint the matching fresh core ledger action, dispatch `host.participant.retry(recoveryId, action)`, `host.participant.discard(recoveryId, action)` or `host.recovery.export({recovery: recoveryId, action})`, and refresh the detail snapshot. Invalid/stale options fail before minting. Neither onOpen nor snapshot nor an option ID grants export authority.

In the existing `PersistenceActionAdapter.chooseDestination` closure resolve the claimed core actionToken or feature action to its scope/deadline, await the native save dialog, revalidate scope/action/deadline, and register only a noncancelled destination:

```ts
const destination = await backend.destinations.register({
  action: actionToken, scope, nativePath: selectedPath, deadlineMonotonicMs,
});
```

Only this registry receives the native path. T5 streams through backend.output with bounded offsets/hash/length, atomic replace and identity revalidation. Release the destination after a known outcome or expiry cleanup; retain unknown outcome evidence for reconciliation of the original job. Never cast a native string to ExportDestination or convert a core token to a feature actionRef.

Add core-recovery/preload tests for original act return shape and unchanged action enum, manage navigation to only the original window, stale option/replay, cancellation/late native dialog and path-free DTOs. T7 real `all-optional-off`, `action-replay` and `unknown-publication` cases must export committed or complete sealed payload with zero optional registrations/processes, reject checkpoint-only invented payload, survive unknown publication/restart, and preserve the destination on cancel. AM-26 recoveryPage/loadRecovery restore original TTL and pins; no reset on restart.

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop test -- src/main/plugins/core-recovery.test.ts src/main/ipc.test.ts src/preload/index.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; node --test tests/desktop/plugin-persistence-import.test.mjs tests/desktop/plugin-persistence-kill.test.mjs
```

Expected: first run exposes missing attachments; after wiring the actual backend preserves sender, durable evidence and destination invariants.

After the resolved attachment passes the existing startup/coordinator regressions, commit its exact main-composition path:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop test -- src/main/index.test.ts src/main/plugins/shutdown-coordinator.test.ts src/main/plugins/controller.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git add apps/desktop/src/main/index.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git commit -m "feat(desktop): compose persistence before stage 3 admission"
```

Expected: the existing single-instance, one-listener, shared-disposition and old-Lab guard tests pass. Record the AM-18/23–29 attachment paths in each persistent owner receipt and return domain defects to their stopped owner.

- [ ] **Step 14: Run the actual B2 suites and review the complete negative matrix.**

Use the package/schema/scoped commands in the verification section below. Then **controller runs outside sandbox** for Electron, browser/localhost, native dialogs, worker kill and installed checks:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; node --test tests/desktop/plugin-persistence-*.test.mjs
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; node tests/desktop/plugin-persistence-run.mjs
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm test:plugins:smoke
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm test:desktop:smoke
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm test:desktop:packaged
```

Expected acceptance requires actual factories, disk/process faults and JS MessagePort/Python stdio results. Every matrix row below needs its own assertion/case and evidence pointer; running a filename alone does not prove every row. In particular B2-RF1 must distinguish pre-dispatch cancellation from post-dispatch unknown; B2-RF4 must prove zero external writes for forged/stale/late-dialog actions; B2-RF5 must show three import reruns with stable IDs/bytes/count and unchanged originals under 50 maximum-size records.

- [ ] **Step 15: Finish the P170 acceptance report, then hand it to the controller.**

Append this section to T7's report; retain its existing actual measurements and manual rows:

```md
## P170 integration receipt

Status: NOT ACCEPTED until every required row has attached actual evidence.

| Field | Recorded value |
| --- | --- |
| F baseline commit | Read from the reviewed contract-freeze receipt |
| P150 integration commit | Actual user merge commit on feat/plugin-system-stage-3 |
| P160 integration commit | Actual user merge commit synchronized into this branch |
| 1.7.0 publication commit | Reviewed 3B2-T8 commit |
| R170 | Owner, reviewed runtime SHA, exact changed paths or none |
| D170 | Owner, commits and exact paths; same-lock/listener/participant evidence |
| V170 | Owner, commits and exact paths; real form and nonce bridge evidence |
| K170 | Owner, commits and exact paths; packaged worker evidence |
| H-I | Owner, commit and exact touched shared files |
| P170 candidate | Actual git rev-parse HEAD after these implementation commits |
| Artifact | Absolute artifact path, SHA-256, OS and architecture |
| Freeze amendments | AM-18/23–32 contract receipt and persistent owners |
| T7 producer | Source commit, built bundle path/SHA-256; stopped-owner receipt for plugin-persistence-main.ts and plugin-persistence-run.mjs |

For every executed command record command text, cwd, start/end, exit code, commit,
artifact hash, OS/architecture, CPU/RAM/filesystem and Node/Electron versions.
Record fixture bytes/records/limits, warm/cold, sample count, p50/p95/max and the
memory metric/method. Attach raw results. An omitted, skipped or blocked command
is not a pass. A fabricated or substituted participant is not actual acceptance.

B2 uses 30 samples and separate main/worker RSS. UI uses 5 seconds warmup,
60 seconds sampling and at least 3 repeats. Device load lasts 10 minutes, with
broker dispatch, transport, stop/readback and journal latencies kept separate.

U12 remains pending until X-T1 exercises the real B2 participant after the user
merges P170. This report does not close 3C, 3D, 3E, hardware or stage-2 V01–V04.
```

Replace the descriptive value cells with observed values when executing the plan; never invent SHAs or copy another platform's result. Keep B2-M01–M06 individually pending unless actually performed. B2-M05's real Lab/device mappings remain 3D/3E-owned.

After successful review, commit only the report and the exact resolved D170 attachment files actually changed. The baseline report-only commit is:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git add docs/superpowers/plans/2026-10-17-plugin-system-3b2-acceptance.md
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git commit -m "docs(plugins): record 1.7.0 foundation acceptance evidence"
```

The user performs the reviewed `--no-ff` merge to `feat/plugin-system-stage-3`. Do not merge on their behalf. Record the actual merge SHA before starting X-T1.

### Task X-T1: Verify the merged foundations with the actual persistence participant

**Files**

Create:

- `tests/desktop/stage-3-foundations.test.mjs`
- `tests/desktop/stage-3-foundations-main.ts`
- `tests/desktop/stage-3-foundations-run.mjs`
- `docs/superpowers/plans/2026-10-17-plugin-system-stage-3-foundations-verification.md`

Modify, only by H-I after all prior writers stop:

- `package.json`
- `tests/desktop/README.md`
- `docs/en/architecture.md`
- `docs/zh-TW/architecture.md`
- `docs/en/roadmap.md`
- `docs/zh-TW/roadmap.md`

Test read-only dependencies:

- `tests/desktop/device-broker-interop.test.mjs`
- `tests/desktop/device-broker-load.test.mjs`
- `tests/desktop/device-broker-boundaries.test.mjs`
- `tests/desktop/declarative-ui-interop.test.mjs`
- `tests/desktop/declarative-ui-load.test.mjs`
- `tests/desktop/builtin-process-packaging.test.mjs`
- `tests/desktop/plugin-persistence-interop.test.mjs`
- `tests/desktop/plugin-persistence-kill.test.mjs`
- `tests/desktop/plugin-persistence-load.test.mjs`
- `tests/desktop/plugin-persistence-import.test.mjs`
- `tools/ci/changes.test.mjs`

X-T1 reads T7's `plugin-persistence-main.ts` and `plugin-persistence-run.mjs`; it owns neither file. T7 resumes those exact files only after D170/K170 stop, records its producer receipt before P170 acceptance, then stops. Defects return to T7 through another named stopped-owner receipt.

**Interfaces**

Import `FoundationFixture`, `FoundationCase`, `CaseEvidence` and `createFoundationFixture` from `./plugin-persistence-main.js` (AM-30). No competing fixture interface or external composition module is defined. T7 binds the actual broker/fake provider, action/UI/runtime paths, worker/backend/host, imports and public JS/Python clients.

Produces these exact test-only exports from `stage-3-foundations-main.ts`:

```ts
export const FOUNDATION_CASES: readonly string[];
export function assertFoundationCase(id: string, evidence: CaseEvidence): void;
export function assertFoundationComposition(input: FoundationFixture["composition"]): void;
export function runFoundationCases(fixture: FoundationFixture): Promise<FoundationReceipt>;
export function runElectronAcceptance(outputFile: string): Promise<void>;
```

**Preconditions**

The user has merged P150, P160 and P170 in order onto `feat/plugin-system-stage-3`; record their actual integration SHAs. All writers have stopped. D170 has implemented AM-18/23–29; real P170 acceptance precedes X-T1. No result obtained with an empty participant can close B1-U12. A receipt-validator unit test also cannot close it.

The cross workload has two consumers and one synthetic provider. Motion and recording contend for the same session and must exclude one another. Exercise overlapping requests and alternate admitted reservations; do not demand simultaneously active motion and recording. Settings/watch/CAS and worker pressure continue while the safety lane is exercised. Keep all synthetic namespaces in an isolated temporary profile and use actual JS MessagePort and Python stdio clients from the acceptance harnesses.

- [ ] **Step 1: Write failing tests for the cross-plan assertions and evidence gate.**

Create the complete `tests/desktop/stage-3-foundations.test.mjs`. The tests below check the cross-plan oracle, including rejection of weakened or incomplete evidence. They are deliberately labelled oracle tests; they are not the actual Electron cases.

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";

const compiled = await build({
  entryPoints: [new URL("stage-3-foundations-main.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  external: ["electron"],
});
const source = compiled.outputFiles[0].text;
const { assertFoundationCase, assertFoundationComposition, FOUNDATION_CASES } =
  await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

const handle = (number) => `10000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const owner = {
  sourceKey: "dev:cross-plan-fixture", pluginId: "fixture.cross-plan", generation: 1,
  hostEpoch: handle(1), processEpoch: handle(2),
};
const grant = { owner, reservationId: handle(3), lastSequence: 9, expiresMonotonicMs: 10_100 };
const samples = (value) => Array.from({ length: 30 }, () => value);
const base = () => ({ checks: {}, events: [], samples: {} });

function validEvidence(id) {
  const evidence = base();
  const good = {
    contention: { motionWhileRecording: "busy", recordingWhileMotion: "busy", concurrentActive: 0, settingsSuccess: 1, settingsConflict: 1, dirtyDraftPreserved: true },
    "registration-end": { finalTargets: 1, finalPublications: 1, firstDeadline: 10_100, lastDeadline: 10_100, pendingRegistrationIncluded: true },
    "healthy-release": { retireCalls: 0, freezeCalls: 0, processExits: 0, generationBefore: 1, generationAfter: 1, unrelatedSettingsCommitted: true },
    "disconnect-retry": { disconnectsBeforeSaved: 0, failedSaveBlocker: true, retriesWithFreshAction: 1, finalTargets: 2, finalPublications: 2, priorSessionIncluded: true, firstDeadline: 10_100, lastDeadline: 10_100 },
    "suspend-wake": { quiesceReason: "suspended", retireCalls: 0, freezeCalls: 0, processExits: 0, replayedMotion: 0, replayedRecording: 0, replayedCommand: 0, renewedOldToken: 0 },
    "renderer-loss": { processExited: true, newGeneration: 2, previousGeneration: 1, explicitRestart: true, oldActionDenied: true, oldGestureDenied: true, oldEpochDenied: true, oldCommitDenied: true },
    "sealed-ttl": { createdAt: 0, lastProgressAt: 10_000, observedExpiry: 40_000, expiryAfterFailedRetry: 40_000, afterExpiry: "checkpoint-only", latePublishCalls: 0, unresolvedEvidenceDeleted: false },
    "unknown-publication": { disposition: "unknown", oldEvidenceRetained: true, newEvidenceRetained: true, namespaceFenced: true, secondPublicationCalls: 0, reconciledOriginalTicket: true, reconciledDisposition: "committed" },
    "all-optional-off": { optionalProcesses: 0, optionalSchemaReads: 0, mapperCalls: 0, autoConnects: 0, coreRecoveryVisible: true, coreExportSucceeded: true, featureActionRefsMinted: 0 },
    "action-replay": { forgedDestinationWrites: 0, replayedDestinationWrites: 0, expiredDestinationWrites: 0, lateDialogWrites: 0, deniedClipboardWrites: 0, deviceLocksDuringDialog: 0, leakedPathsOrValues: 0 },
    "import-restart": { recordCounts: [50, 50, 50], byteCounts: [419_430_400, 419_430_400, 419_430_400], idsStable: true, originalsUnchanged: true, deletedRecordReimported: false, missingRendererCompletedEmpty: false, markerBeforeCrashPending: true, markerAfterCrashCompleteOnce: true },
    compatibility: { apiVersions: ["1.4.0", "1.5.0", "1.6.0", "1.7.0"], schemasEqual: true, secondGenerationDrift: false, legacyExecutePreserved: true, legacyInitializePreserved: true, drainSentBelow17: 0, pythonExecuted: true, publicApi18Published: false },
    installed: { cwdOutsideCheckout: true, externalNodeUsed: false, networkRequired: false, primaryWorkers: 1, secondaryWorkers: 0, secondaryProviders: 0, secondaryPlugins: 0, primaryRecordingInterrupted: false, primaryFocused: true, childrenAfterFiveSeconds: 0 },
  };
  evidence.checks = good[id] ?? {};
  if (id === "retirement") evidence.checks = { firstDeadline: 10_100 };
  if (id === "retirement") evidence.events = [
    { kind: "retire", turn: 1, time: 100, grant },
    { kind: "freeze", turn: 1, time: 100, grant, deadline: 10_100 },
    { kind: "drain", turn: 2, time: 101, deadline: 10_100 },
    { kind: "process-exit", turn: 3, time: 103 },
  ];
  if (id === "disconnect-retry") evidence.events = [
    { kind: "quiesce", turn: 1, time: 100 },
    { kind: "stop-confirmed", turn: 2, time: 200 },
    { kind: "save-failed", turn: 2, time: 201 },
    { kind: "save-confirmed", turn: 3, time: 300 },
    { kind: "journal-confirmed", turn: 3, time: 301 },
    { kind: "disconnect", turn: 4, time: 302 },
  ];
  if (id === "storage-ui-pressure") {
    evidence.checks = {
      records: 50, recordBytes: 8 * 1024 * 1024, activeJobs: 4,
      peakPendingJobs: 32, peakQueuedHostBytes: 8 * 1024 * 1024,
      peakQueuedSourceBytes: 1024 * 1024, mainExtraRss: 32 * 1024 * 1024,
      workerExtraRss: 64 * 1024 * 1024, mainSyncMaxMs: 16,
      uiWarmupMs: 5_000, uiSampleMs: 60_000, uiRepeats: 3,
      uiHeapBytes: 64 * 1024 * 1024, cycles: 1_000,
      liveCounters: 0, residualBytes: 2 * 1024 * 1024,
      deviceWorkloadMs: 600_000,
    };
    evidence.samples = {
      stopExtraMs: samples(50), draftMs: samples(50), pageMs: samples(100),
      listMs: samples(200), commitMs: samples(10_000), uiApplyMs: samples(16),
      uiInputMs: samples(100), uiRevokeMs: samples(50),
    };
  }
  return evidence;
}

for (const id of FOUNDATION_CASES) {
  test(`cross-plan oracle accepts complete evidence: ${id}`, () => {
    assert.doesNotThrow(() => assertFoundationCase(id, validEvidence(id)));
  });
}

test("B2-RF3/U12 rejects cloned grants, a microtask gap and renewed deadline", () => {
  for (const change of [
    (events) => { events[1].grant = structuredClone(grant); },
    (events) => { events[1].turn = 2; },
    (events) => { events[2].deadline += 1; },
    (events) => { events[2].turn = 1; },
  ]) {
    const evidence = validEvidence("retirement");
    change(evidence.events);
    assert.throws(() => assertFoundationCase("retirement", evidence));
  }
});

test("A-F19/B2-RF3 rejects a lost target, duplicate final and extended original deadline", () => {
  for (const patch of [{ finalTargets: 0 }, { finalPublications: 2 }, { lastDeadline: 10_101 }]) {
    const evidence = validEvidence("registration-end");
    Object.assign(evidence.checks, patch);
    assert.throws(() => assertFoundationCase("registration-end", evidence));
  }
});

test("U12 rejects healthy consumer retirement and early disconnect", () => {
  const release = validEvidence("healthy-release");
  release.checks.freezeCalls = 1;
  assert.throws(() => assertFoundationCase("healthy-release", release));
  const disconnect = validEvidence("disconnect-retry");
  disconnect.events.unshift(disconnect.events.pop());
  assert.throws(() => assertFoundationCase("disconnect-retry", disconnect));
});

test("U12 accepts parallel save/stop completion and an already-earlier drain deadline", () => {
  const disconnect = validEvidence("disconnect-retry");
  [disconnect.events[1], disconnect.events[2]] = [disconnect.events[2], disconnect.events[1]];
  assert.doesNotThrow(() => assertFoundationCase("disconnect-retry", disconnect));
  const retired = validEvidence("retirement");
  retired.checks.firstDeadline = 9_000;
  retired.events[1].deadline = 9_000;
  retired.events[2].deadline = 9_000;
  assert.doesNotThrow(() => assertFoundationCase("retirement", retired));
});

test("B2-RF1 rejects clearing unknown evidence or a second publish", () => {
  for (const patch of [{ oldEvidenceRetained: false }, { namespaceFenced: false }, { secondPublicationCalls: 1 }]) {
    const evidence = validEvidence("unknown-publication");
    Object.assign(evidence.checks, patch);
    assert.throws(() => assertFoundationCase("unknown-publication", evidence));
  }
});

test("B2-RF4 rejects one late dialog write and feature-token substitution", () => {
  const action = validEvidence("action-replay");
  action.checks.lateDialogWrites = 1;
  assert.throws(() => assertFoundationCase("action-replay", action));
  const core = validEvidence("all-optional-off");
  core.checks.featureActionRefsMinted = 1;
  assert.throws(() => assertFoundationCase("all-optional-off", core));
});

test("B2-RF5 rejects duplicate imports and lower sample/looser performance claims", () => {
  const imported = validEvidence("import-restart");
  imported.checks.recordCounts[2] = 51;
  assert.throws(() => assertFoundationCase("import-restart", imported));
  for (const change of [
    (evidence) => { evidence.samples.stopExtraMs = samples(51); },
    (evidence) => { evidence.samples.listMs.pop(); },
    (evidence) => { evidence.checks.workerExtraRss += 1; },
    (evidence) => { evidence.checks.liveCounters = 1; },
  ]) {
    const evidence = validEvidence("storage-ui-pressure");
    change(evidence);
    assert.throws(() => assertFoundationCase("storage-ui-pressure", evidence));
  }
});

test("TTL is the minimum of original idle and total deadlines", () => {
  const evidence = validEvidence("sealed-ttl");
  evidence.checks.createdAt = 0;
  evidence.checks.lastProgressAt = 115_000;
  evidence.checks.observedExpiry = 120_000;
  evidence.checks.expiryAfterFailedRetry = 120_000;
  assert.doesNotThrow(() => assertFoundationCase("sealed-ttl", evidence));
  evidence.checks.expiryAfterFailedRetry = 145_000;
  assert.throws(() => assertFoundationCase("sealed-ttl", evidence));
});

test("F20/U12 rejects equal-looking locks, duplicate listeners, or an empty replacement", () => {
  const profile = { hostEpoch: handle(1), assertHeld() {} };
  const participant = {};
  const input = {
    profile, journalProfile: profile, persistenceProfile: profile,
    reservationListenerCount: 1, workerCount: 1,
    host: { participant }, stage3: { persistence: participant },
  };
  assert.doesNotThrow(() => assertFoundationComposition(input));
  for (const patch of [
    { journalProfile: { ...profile } },
    { persistenceProfile: { ...profile } },
    { reservationListenerCount: 2 },
    { workerCount: 2 },
    { stage3: { persistence: {} } },
  ]) assert.throws(() => assertFoundationComposition({ ...input, ...patch }));
});

test("missing case, skipped Python and future API publication cannot pass", () => {
  assert.throws(() => assertFoundationCase("missing", base()));
  assert.throws(() => assertFoundationCase("healthy-release", base()));
  for (const patch of [{ pythonExecuted: false }, { publicApi18Published: true }]) {
    const evidence = validEvidence("compatibility");
    Object.assign(evidence.checks, patch);
    assert.throws(() => assertFoundationCase("compatibility", evidence));
  }
});

test("H-I routes the oracle through both ordinary desktop and CI test commands", async () => {
  const root = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  for (const name of ["test:desktop", "test:ci"])
    assert.ok(root.scripts[name].includes("node --test tests/desktop/stage-3-foundations.test.mjs"));
});
```

Run:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; node --test tests/desktop/stage-3-foundations.test.mjs
```

Expected failure: missing `stage-3-foundations-main.ts`. After adding it, the CI routing assertion remains red until Step 5. Unit evidence in this file must never be written into an acceptance receipt.

- [ ] **Step 2: Implement the complete cross-plan oracle and actual-fixture executor.**

Create `tests/desktop/stage-3-foundations-main.ts`:

```ts
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  createFoundationFixture,
  type FoundationFixture, type FoundationCase, type CaseEvidence,
} from "./plugin-persistence-main.js";

export const FOUNDATION_CASES = [
  "contention", "retirement", "registration-end", "healthy-release", "disconnect-retry",
  "suspend-wake", "renderer-loss", "sealed-ttl", "unknown-publication", "all-optional-off",
  "action-replay", "import-restart", "storage-ui-pressure", "compatibility", "installed",
] as const satisfies readonly FoundationCase[];
type CheckValue = CaseEvidence["checks"][string];
export interface FoundationReceipt {
  format: 1;
  kind: "actual-electron";
  environment: FoundationFixture["environment"];
  cases: Array<{
    id: FoundationCase;
    evidence: CaseEvidence;
    statistics: Record<string, { count: number; p50: number; p95: number; max: number }>;
  }>;
}

function same(e: CaseEvidence, expected: Record<string, CheckValue>): void {
  for (const [key, value] of Object.entries(expected))
    assert.deepEqual(e.checks[key], value, `Unexpected ${key}`);
}
function numeric(e: CaseEvidence, key: string): number {
  const value = e.checks[key];
  assert.equal(typeof value, "number", `Missing numeric ${key}`);
  assert.ok(Number.isFinite(value));
  return value as number;
}
function bounded(e: CaseEvidence, key: string, maximum: number): void {
  const value = numeric(e, key);
  assert.ok(value >= 0 && value <= maximum, `${key}: ${value} > ${maximum}`);
}
function ordered(e: CaseEvidence, kinds: readonly string[]): void {
  let previous = -1;
  for (const kind of kinds) {
    const index = e.events.findIndex((event) => event.kind === kind);
    assert.ok(index > previous, `Missing/out-of-order ${kind}`);
    previous = index;
  }
}
function samples(e: CaseEvidence, name: string, p95Limit: number, maxLimit?: number): void {
  const values = e.samples[name];
  assert.ok(values && values.length >= 30, `${name} needs 30 actual samples`);
  assert.ok(values.every((value) => Number.isFinite(value) && value >= 0));
  const sorted = [...values].sort((a, b) => a - b);
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
  assert.ok(p95 <= p95Limit, `${name} p95 ${p95} > ${p95Limit}`);
  if (maxLimit !== undefined) assert.ok(sorted.at(-1)! <= maxLimit, `${name} max exceeds ${maxLimit}`);
}

export function assertFoundationComposition(input: FoundationFixture["composition"]): void {
  input.profile.assertHeld();
  assert.equal(input.journalProfile, input.profile, "Journal must share the same lock object");
  assert.equal(input.persistenceProfile, input.profile, "Persistence must share the same lock object");
  assert.equal(input.reservationListenerCount, 1, "Only the B1 coordinator subscribes");
  assert.equal(input.workerCount, 1, "One persistence worker for the primary profile");
  assert.equal(input.stage3.persistence, input.host.participant, "The actual host participant must be attached");
}

export function assertFoundationCase(id: string, e: CaseEvidence): void {
  assert.ok(FOUNDATION_CASES.some((value) => value === id), `Unknown case ${id}`);
  switch (id as FoundationCase) {
    case "contention":
      same(e, { motionWhileRecording: "busy", recordingWhileMotion: "busy", concurrentActive: 0, settingsSuccess: 1, settingsConflict: 1, dirtyDraftPreserved: true });
      return;
    case "retirement": {
      const index = e.events.findIndex((event) => event.kind === "retire");
      assert.ok(index >= 0);
      const retired = e.events[index]!;
      const frozen = e.events[index + 1];
      assert.equal(frozen?.kind, "freeze");
      assert.equal(frozen?.turn, retired.turn, "Retire and freeze must share a synchronous turn");
      assert.ok(retired.grant !== undefined && retired.grant !== null);
      assert.equal(frozen?.grant, retired.grant, "The grant is the original object");
      assert.ok(frozen?.deadline !== undefined && frozen.deadline <= retired.time + 10_000);
      assert.ok(frozen.deadline <= retired.grant.expiresMonotonicMs);
      assert.equal(frozen.deadline, numeric(e, "firstDeadline"), "Retirement cannot extend an earlier offer");
      const drain = e.events.find((event) => event.kind === "drain");
      assert.ok(drain && drain.turn > retired.turn, "Dispatch is deferred until fencing completes");
      assert.equal(drain.deadline, frozen?.deadline);
      ordered(e, ["retire", "freeze", "drain", "process-exit"]);
      return;
    }
    case "registration-end":
      same(e, { finalTargets: 1, finalPublications: 1, pendingRegistrationIncluded: true });
      assert.equal(numeric(e, "firstDeadline"), numeric(e, "lastDeadline"));
      return;
    case "healthy-release":
      same(e, { retireCalls: 0, freezeCalls: 0, processExits: 0, unrelatedSettingsCommitted: true });
      assert.equal(numeric(e, "generationBefore"), numeric(e, "generationAfter"));
      return;
    case "disconnect-retry":
      same(e, { disconnectsBeforeSaved: 0, failedSaveBlocker: true, retriesWithFreshAction: 1, finalTargets: 2, finalPublications: 2, priorSessionIncluded: true });
      assert.equal(numeric(e, "firstDeadline"), numeric(e, "lastDeadline"));
      ordered(e, ["quiesce", "stop-confirmed", "disconnect"]);
      ordered(e, ["quiesce", "save-failed", "save-confirmed", "disconnect"]);
      ordered(e, ["quiesce", "journal-confirmed", "disconnect"]);
      return;
    case "suspend-wake":
      same(e, { quiesceReason: "suspended", retireCalls: 0, freezeCalls: 0, processExits: 0, replayedMotion: 0, replayedRecording: 0, replayedCommand: 0, renewedOldToken: 0 });
      return;
    case "renderer-loss":
      same(e, { processExited: true, explicitRestart: true, oldActionDenied: true, oldGestureDenied: true, oldEpochDenied: true, oldCommitDenied: true });
      assert.ok(numeric(e, "newGeneration") > numeric(e, "previousGeneration"));
      return;
    case "sealed-ttl": {
      const original = Math.min(numeric(e, "lastProgressAt") + 30_000, numeric(e, "createdAt") + 120_000);
      assert.equal(numeric(e, "observedExpiry"), original);
      assert.equal(numeric(e, "expiryAfterFailedRetry"), original);
      same(e, { afterExpiry: "checkpoint-only", latePublishCalls: 0, unresolvedEvidenceDeleted: false });
      return;
    }
    case "unknown-publication":
      same(e, { disposition: "unknown", oldEvidenceRetained: true, newEvidenceRetained: true, namespaceFenced: true, secondPublicationCalls: 0, reconciledOriginalTicket: true, reconciledDisposition: "committed" });
      return;
    case "all-optional-off":
      same(e, { optionalProcesses: 0, optionalSchemaReads: 0, mapperCalls: 0, autoConnects: 0, coreRecoveryVisible: true, coreExportSucceeded: true, featureActionRefsMinted: 0 });
      return;
    case "action-replay":
      same(e, { forgedDestinationWrites: 0, replayedDestinationWrites: 0, expiredDestinationWrites: 0, lateDialogWrites: 0, deniedClipboardWrites: 0, deviceLocksDuringDialog: 0, leakedPathsOrValues: 0 });
      return;
    case "import-restart":
      same(e, { recordCounts: [50, 50, 50], byteCounts: [419_430_400, 419_430_400, 419_430_400], idsStable: true, originalsUnchanged: true, deletedRecordReimported: false, missingRendererCompletedEmpty: false, markerBeforeCrashPending: true, markerAfterCrashCompleteOnce: true });
      return;
    case "storage-ui-pressure":
      same(e, { records: 50, recordBytes: 8 * 1024 * 1024, activeJobs: 4, liveCounters: 0 });
      bounded(e, "peakPendingJobs", 32);
      bounded(e, "peakQueuedHostBytes", 8 * 1024 * 1024);
      bounded(e, "peakQueuedSourceBytes", 1024 * 1024);
      bounded(e, "mainExtraRss", 32 * 1024 * 1024);
      bounded(e, "workerExtraRss", 64 * 1024 * 1024);
      bounded(e, "mainSyncMaxMs", 16);
      bounded(e, "uiHeapBytes", 64 * 1024 * 1024);
      bounded(e, "residualBytes", 2 * 1024 * 1024);
      assert.ok(numeric(e, "cycles") >= 1_000);
      assert.ok(numeric(e, "uiWarmupMs") >= 5_000);
      assert.ok(numeric(e, "uiSampleMs") >= 60_000);
      assert.ok(numeric(e, "uiRepeats") >= 3);
      assert.ok(numeric(e, "deviceWorkloadMs") >= 600_000);
      samples(e, "stopExtraMs", 50);
      samples(e, "draftMs", 50);
      samples(e, "pageMs", 100);
      samples(e, "listMs", 200);
      samples(e, "commitMs", 10_000, 10_000);
      samples(e, "uiApplyMs", 16, 50);
      samples(e, "uiInputMs", 100);
      samples(e, "uiRevokeMs", 50, 100);
      return;
    case "compatibility":
      same(e, { apiVersions: ["1.4.0", "1.5.0", "1.6.0", "1.7.0"], schemasEqual: true, secondGenerationDrift: false, legacyExecutePreserved: true, legacyInitializePreserved: true, drainSentBelow17: 0, pythonExecuted: true, publicApi18Published: false });
      return;
    case "installed":
      same(e, { cwdOutsideCheckout: true, externalNodeUsed: false, networkRequired: false, primaryWorkers: 1, secondaryWorkers: 0, secondaryProviders: 0, secondaryPlugins: 0, primaryRecordingInterrupted: false, primaryFocused: true, childrenAfterFiveSeconds: 0 });
      return;
  }
}

export async function runFoundationCases(fixture: FoundationFixture): Promise<FoundationReceipt> {
  assertFoundationComposition(fixture.composition);
  assert.match(fixture.environment.commit, /^[0-9a-f]{40}$/);
  assert.match(fixture.environment.artifactSha256, /^[0-9a-f]{64}$/);
  for (const value of Object.values(fixture.environment))
    assert.ok(typeof value === "number" ? value > 0 : value.length > 0, "Missing environment field");
  const cases: FoundationReceipt["cases"] = [];
  for (const id of FOUNDATION_CASES) {
    const evidence = await fixture.runCase(id);
    // Object identity and synchronous-turn assertions run before JSON serialization.
    assertFoundationCase(id, evidence);
    const statistics: FoundationReceipt["cases"][number]["statistics"] = {};
    for (const [name, values] of Object.entries(evidence.samples)) {
      assert.ok(values.length > 0 && values.every((value) => Number.isFinite(value) && value >= 0));
      const sorted = [...values].sort((a, b) => a - b);
      statistics[name] = {
        count: sorted.length,
        p50: sorted[Math.ceil(sorted.length * 0.50) - 1]!,
        p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
        max: sorted.at(-1)!,
      };
    }
    cases.push({ id, evidence, statistics });
  }
  fixture.composition.profile.assertHeld();
  return { format: 1, kind: "actual-electron", environment: fixture.environment, cases };
}

export async function runElectronAcceptance(outputFile: string): Promise<void> {
  const { app } = await import("electron");
  const profile = app.commandLine.getSwitchValue("user-data-dir");
  assert.ok(profile, "Acceptance requires an isolated profile");
  app.setPath("userData", profile);
  await app.whenReady();
  const fixture = await createFoundationFixture();
  try {
    const artifactHash = createHash("sha256").update(await readFile(fixture.environment.artifact)).digest("hex");
    assert.equal(artifactHash, fixture.environment.artifactSha256);
    const receipt = await runFoundationCases(fixture);
    await fixture.close();
    await writeFile(outputFile, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    app.exit(0);
  } catch (error) {
    try { await fixture.close(); } catch { /* Keep the original acceptance failure. */ }
    console.error(error);
    app.exit(1);
  }
}

const output = process.argv.find((value) => value.startsWith("--stage3-output="))?.slice("--stage3-output=".length);
if (output) void runElectronAcceptance(output).catch(async (error: unknown) => {
  console.error(error);
  const { app } = await import("electron");
  app.exit(1);
});
```

`turn` is assigned by the instrumentation surrounding actual synchronous method calls and explicit dispatch scheduling; it is not wall-clock equality. Keep `DeviceDrainGrant` references in memory until the equality assertion runs. Do not serialize/reconstruct them before testing identity. A receipt records the result after that assertion.

The imported T7 producer supplies actual observations from faults, traces, filesystem operations, SDK traffic and AM-22 disjoint diagnostics. Constants are allowed only in the verifier unit tests in Step 1. Sum only counters owned by each module, retain cross-process clock conversion/uncertainty and post-GC heap evidence; absent diagnostics fail acceptance. Run Step 1: verifier tests pass, with script routing passing after Step 5. Actual Electron execution must independently pass all fifteen cases.

- [ ] **Step 3: Write the actual Electron launcher with isolated artifacts and no skip-to-pass.**

Create the complete `tests/desktop/stage-3-foundations-run.mjs`. Bundle the statically imported T7 producer with the executor and record producer source/commit plus bundle SHA-256 in the invocation receipt. The application profile is isolated, and failed evidence is retained.

```js
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(path.join(root, "apps/desktop/package.json"));
const electron = require("electron");
const producerSource = path.join(root, "tests/desktop/plugin-persistence-main.ts");
const producerSourceSha256 = createHash("sha256").update(await readFile(producerSource)).digest("hex");
const producerCommit = process.env.STAGE3_PRODUCER_COMMIT;
assert.match(producerCommit ?? "", /^[0-9a-f]{40}$/, "Require the reviewed T7 producer receipt commit");
const directory = await mkdtemp(path.join(tmpdir(), "kobrixa-stage3-foundations-"));
const output = path.join(directory, "receipt.json");
const main = path.join(directory, "main.cjs");
await build({
  entryPoints: [path.join(root, "tests/desktop/stage-3-foundations-main.ts")],
  outfile: main,
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
});
const producerBundleSha256 = createHash("sha256").update(await readFile(main)).digest("hex");
const startedAt = new Date().toISOString();
const child = spawn(electron, [
  main,
  `--user-data-dir=${path.join(directory, "profile")}`,
  `--stage3-output=${output}`,
], { cwd: directory, stdio: "inherit", env: process.env, detached: process.platform !== "win32" });
let timedOut = false;
const result = await new Promise((resolve, reject) => {
  // Harness wall-clock budget only; it never changes any operation/drain deadline.
  const timer = setTimeout(() => {
    timedOut = true;
    if (!child.pid) return;
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "inherit" });
      killer.once("error", reject);
    } else {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
        if (error?.code !== "ESRCH") reject(error);
      }
    }
  }, 25 * 60_000);
  child.once("error", (error) => { clearTimeout(timer); reject(error); });
  child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
});
await writeFile(path.join(directory, "invocation.json"), `${JSON.stringify({
  command: [electron, main, `--stage3-output=${output}`],
  producerCommit, producerSource, producerSourceSha256, producerBundleSha256,
  startedAt,
  endedAt: new Date().toISOString(),
  result,
  timedOut,
}, null, 2)}\n`, { flag: "wx" });
assert.equal(timedOut, false, `Harness deadline exceeded; inspect ${directory}`);
assert.equal(result.code, 0, `Stage-3 acceptance failed; inspect ${directory}`);
const receipt = JSON.parse(await readFile(output, "utf8"));
assert.equal(receipt.kind, "actual-electron");
assert.equal(receipt.cases.length, 15);
assert.equal(new Set(receipt.cases.map((row) => row.id)).size, 15);
console.log(`Stage-3 actual evidence retained at ${directory}`);
```

T7's fixture supervisor must impose bounded operation/drain/process deadlines and retain its child PID manifest. The outer launcher terminates its fixture process tree after 25 minutes and records failure; this harness limit does not extend any product deadline. The controller can also stop a hung run. No termination produces a passing receipt. A missing reviewed producer commit or imported producer fails rather than skipping. An installed acceptance bundle must still launch the actual packaged application for the `installed` case; launching the Electron harness itself is not installed-app evidence.

After the T7 producer receipt is recorded, **controller runs outside sandbox**:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; node tests/desktop/stage-3-foundations-run.mjs
```

Set `STAGE3_PRODUCER_COMMIT` to the actual reviewed T7 source commit from the P170 receipt. Compare that receipt's producer/artifact hashes before running. The launcher imports the producer at its frozen path; there is no selectable external driver. Missing Electron/Python or producer evidence is an unrun gate. The installed case verifies the actual artifact SHA-256 against `fixture.environment.artifactSha256`; source or bundle hashes cannot replace it.

- [ ] **Step 4: Apply the real scenario schedule and reject incomplete evidence.**

The T7 producer must perform the following concrete operations; these are the required bindings of the executor's 15 case IDs. Keep backend behavior in its existing owners. A missing operation hook is a stopped-owner handoff, not a reason to replace the operation with a returned constant.

| Case ID | Actual sequence and negative assertions |
| --- | --- |
| `contention` | Consumer A opens recording and durably registers checkpoint. Consumer B requests motion and gets busy with no arm. Release recording, admit motion, then deny a new recording reservation. Concurrently issue two settings updates with the same revision from two windows: exactly one commit and one conflict, dirty loser draft retained. |
| `retirement` | Pause final publication; disable the source with a real reservation. Capture `retire` return and the exact fourth argument to `freeze` synchronously. Dispatch drain only after the turn; finish stop/journal and final save before process exit. Repeat with reload/shutdown competition in B1's U12 suite. |
| `registration-end` | Pause fsync after registration admission but before durable acknowledgement; end reservation first; allow registration to settle. Verify one target and one final publication, original deadline unchanged, no lost final or renewed token. Repeat duplicate end and retirement overlap. |
| `healthy-release` | Release via the public API; observe coordinator notification and final commit; prove PID, generation, unrelated settings and another record still work. No owner freeze/retire. Repeat provider loss in the B2 lifecycle matrix without killing the healthy consumer. |
| `disconnect-retry` | End one session with a pending final, start a later session, then request core Disconnect. Fail save once. Physical disconnect count stays zero until stop, both current/prior-session finals and journal settle. Click Retry with a fresh core token inside original TTL, then explicitly retry Disconnect. |
| `suspend-wake` | Trigger the real main suspend adapter with held motion/recording in separate runs. Observe quiesce `suspended`, fixed-deadline save, healthy process survival. Wake without user input: zero motion/record/command replay and no old gesture/token renewal. OS sleep itself is manual evidence. |
| `renderer-loss` | Kill the actual renderer while a complete final is host-held. Main revokes UI/gesture, drains, terminates source process, then explicit reopen starts a fresh generation. Replay old action, gesture, host/process epoch and commit: all denied with zero external mutation. |
| `sealed-ttl` | Crash a real consumer in memory-only, receiving and sealed phases. Only sealed host-held bytes offer retry. Advance injected monotonic time at 30-second idle and 120-second total boundaries; failure/replay does not renew TTL. Preserve unresolved I/O evidence while logical retry becomes checkpoint-only. |
| `unknown-publication` | Use the worker's actual `after-publish` boundary and terminate/drop reply after syscall dispatch. Verify both evidence sets, mutation fence, no second create/publish, and reconciliation of the original ticket. Re-enable never gives old generation rights back. |
| `all-optional-off` | Cold start safe mode with all optional features disabled and committed/retryable evidence. No optional schema, mapper or process starts. Open core recovery/manage and explicitly export using the core action path, without enabling the source or minting a feature actionRef. |
| `action-replay` | Forge action, wrong source, wrong generation, expired action and replay; dismiss dialog; destroy renderer during dialog; return a late selected destination. Hash destination/clipboard observation before/after: zero denied writes, zero device lock while waiting, no path/value in errors. |
| `import-restart` | Stream 50×8 MiB records plus settings; kill after item commit before receipt and before/after complete marker. Reopen three times: identical IDs/count/bytes and original hashes. Delete a completed new record and ensure it is not reimported. Missing/replayed renderer snapshot never means empty. |
| `storage-ui-pressure` | Keep 4 worker jobs and bounded admission pressure while 10 Hz UI updates and settings input continue. Collect 30 storage samples, 3×60-second UI runs after 5-second warmups and 10-minute device workload. Measure additional stop dispatch latency separately from transport/readback and physical stop. |
| `compatibility` | Launch real 1.4/1.5/1.6/1.7 consumers with both SDK transports. Preserve legacy initialize/execute. No drain below negotiated/registered 1.7. Regenerate and compare both schemas; no 1.8/v2 publication. Python SKIP fails this gate. |
| `installed` | Start actual artifact from an unrelated cwd with checkout/external Node unavailable and network disabled. Launch second instance, focus primary without restarting its recorder, verify one primary worker. Normal close and update cleanup leave zero child PIDs after 5 seconds. Record each delivered OS/architecture separately. |

Do not count a sequence that never reaches its injected fault point. Record injection acknowledgement before terminating a process, and check its exit signal. A stop-dispatch measurement is not physical stop confirmation. The 10-minute device load and storage/UI measurements may share a run only if all workload counters and samples are captured; elapsed time alone is insufficient.

- [ ] **Step 5: Wire the assertion suite into existing scripts and run it green.**

In `package.json`, append exactly ` && node --test tests/desktop/stage-3-foundations.test.mjs` once to the current P170 `test:desktop` and `test:ci` strings. Preserve all A/B1/B2 hooks already added by H-I. Against the source baseline read for this plan, the full two values are:

```json
"test:ci": "vitest run && pnpm test:bytecode && pnpm test:release && pnpm test:static-languages && node --test tests/desktop/stage-3-foundations.test.mjs",
"test:desktop": "vitest run --project \"!web\" && pnpm test:bytecode && pnpm test:release && pnpm test:python-sdk && pnpm test:static-languages && node --test tests/desktop/stage-3-foundations.test.mjs"
```

These are object members, not a replacement package file. No dependencies change and no lockfile/install step is needed. Existing `tools/ci/changes.mjs` already classifies `tests/` and `apps/desktop/` as desktop and shared `package.json` as both; keep that classification. Read current P170 CI scripts before editing, because earlier H-I batches have also extended these strings.

Run:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; node --test tests/desktop/stage-3-foundations.test.mjs
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm test:ci-routing
```

Expected: oracle and routing tests pass. Then run the full verification section once on the merged candidate. Actual producer acceptance remains separate; the root unit suite does not fabricate or skip it.

- [ ] **Step 6: Commit the cross-plan oracle and launcher.**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git add tests/desktop/stage-3-foundations.test.mjs tests/desktop/stage-3-foundations-main.ts tests/desktop/stage-3-foundations-run.mjs package.json
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git commit -m "test(plugins): gate merged stage 3 foundation evidence"
```

- [ ] **Step 7: Update bilingual architecture/roadmap and smoke instructions without closing future stages.**

Append the following complete section to `docs/en/architecture.md` after the plugin contracts, and remove the obsolete sentence saying the `devices` API is merely planned. Preserve stage-2 acceptance and every unrelated compiler/device contract:

```md
### Stage 3 foundation contracts

The foundation batches publish device APIs at 1.5.0, declarative UI at 1.6.0,
and settings/storage at 1.7.0. Earlier compatible consumers retain their
initialize and command contracts. The desktop supplies one broker, one profile
writer lock and the real persistence participant to the shared lifecycle
coordinator. A healthy reservation ending saves its recording target without
retiring the consumer. Owner retirement fences ordinary work before deferred
drain; unresolved save or stop/journal outcomes remain visible close blockers.

Contributed settings use core controls with per-field validation, immediate CAS
writes and explicit conflict retry. Record export and clipboard access require
a fresh admitted user action. Safe mode and disabled optional features retain
core recovery; they do not restart recording or reconnect a device. The
persistence worker is packaged with the application and has no checkout or
external Node fallback. These permissions constrain host APIs and are not an
operating-system sandbox for trusted local plugin code.

Foundation verification is tracked in the
[merged foundation report](../superpowers/plans/2026-10-17-plugin-system-stage-3-foundations-verification.md).
Synthetic fixtures do not establish public motor delivery (3C), Lab migration
(3D), device-feature migration or installed/hardware closeout (3E). API 1.8.0
and full Stage 3 completion are not claimed by the foundation batches.
```

Append the corresponding complete section to `docs/zh-TW/architecture.md`, replacing its obsolete planned-devices sentence:

```md
### 第三階段基礎契約

基礎批次依序發布設備 API 1.5.0、宣告式 UI 1.6.0、設定／儲存 1.7.0。
相容的舊版使用者保留 initialize 與 command 契約。桌面程式以同一 broker、
同一 profile writer lock 和真實 persistence participant 接入共用生命週期協調器。
健康 reservation 結束時保存其錄製目標，不退役整個 consumer。Owner 退役先封住
一般請求，再延後派送 drain；未確認的保存、停止或 journal 結果持續阻擋正常關閉。

插件設定使用核心控制項、逐欄驗證、立即 CAS 保存與明確的衝突重試。Record 匯出
與剪貼簿寫入需要新的已受理使用者動作。安全模式與停用 optional features 後仍有
核心復原介面，不自動續錄或重連設備。Persistence worker 隨應用程式封裝，不回退
到 checkout 或外部 Node。這些權限限制宿主 API，並非可信任本機插件的作業系統沙箱。

驗證狀態見[整合基礎報告](../superpowers/plans/2026-10-17-plugin-system-stage-3-foundations-verification.md)。
Synthetic fixture 不代表公開馬達功能交付（3C）、Lab 遷移（3D）、設備功能遷移或
已安裝／硬體完整驗收（3E）。基礎批次不宣告 API 1.8.0 或第三階段全部完成。
```

Replace only the stage-3 roadmap bullet in `docs/en/roadmap.md` with:

```md
- Plugin system stage 3: foundation batches cover device APIs (1.5.0), declarative UI (1.6.0), and settings/storage (1.7.0). [Foundation evidence](../superpowers/plans/2026-10-17-plugin-system-stage-3-foundations-verification.md) records actual passes and pending gates. Public motor proof (3C, `^1.6.0`), Lab migration (3D, `^1.8.0`), and complete device-feature/installed/hardware acceptance (3E, `^1.8.0`) remain separate delivery work. This is not Stage 3 closeout.
```

Replace only its counterpart in `docs/zh-TW/roadmap.md` with:

```md
- 插件系統第三階段：基礎批次涵蓋設備 API（1.5.0）、宣告式 UI（1.6.0）與設定／儲存（1.7.0）。[基礎驗證報告](../superpowers/plans/2026-10-17-plugin-system-stage-3-foundations-verification.md)逐項記錄實際通過與未完成關卡。公開馬達驗證（3C，`^1.6.0`）、Lab 遷移（3D，`^1.8.0`）及完整設備功能／已安裝／硬體驗收（3E，`^1.8.0`）仍分別交付，不能以基礎批次宣告第三階段完成。
```

Append to `tests/desktop/README.md`:

```md
## Stage 3 foundations

`node --test tests/desktop/stage-3-foundations.test.mjs` validates the cross-plan
assertions and evidence gate. It does not launch the actual acceptance fixture.
Run `node tests/desktop/stage-3-foundations-run.mjs`
with STAGE3_PRODUCER_COMMIT set to the reviewed T7 receipt commit after P150, P160 and P170 have been merged.
The runner retains its profile, invocation receipt, producer source/bundle hashes and actual
case evidence. Missing producer evidence, Electron or Python is blocked acceptance, not a
passing skip. Run Electron/browser/localhost/native-dialog checks outside the
Codex sandbox; use Xvfb on headless Linux.

The fixture must use the actual broker, coordinator, worker-backed persistence
host, public JS/Python clients and renderer. Preserve grant identity before
serializing evidence. The installed case launches the actual packaged app from
an unrelated cwd, with no external Node or checkout fallback. One platform's
results do not establish another platform's acceptance. USB/Wi-Fi/hardware and
B2-M01–M06 remain individually recorded manual gates. The foundation report does
not close 3C/3D/3E or change stage-2 V01–V04 exceptions.
```

Check bilingual statements and links, then run the final `format:check`, web and diff gates below. Do not run root `format` against other owners' files.

- [ ] **Step 8: Write the final verification receipt and commit only reviewed evidence/docs.**

Create `docs/superpowers/plans/2026-10-17-plugin-system-stage-3-foundations-verification.md` with this complete starting ledger; append actual rows rather than pre-signing them:

```md
# Stage 3 foundations verification

Status: pending actual merged-candidate verification.

This report covers 3A, 3B-1 and 3B-2 foundations. It does not close Stage 3,
public motor delivery, Lab/device-feature migration, hardware acceptance or
stage-2 V01–V04.

## Integration identity

| Receipt | Evidence |
| --- | --- |
| F contract freeze | Actual receipt commit and any reviewed amendments |
| P150 user merge | Actual merge SHA |
| P160 user merge | Actual merge SHA |
| P170 user merge | Actual merge SHA |
| Candidate tested | Actual git rev-parse HEAD |
| Artifact | Path, SHA-256, OS/architecture |
| R170/D170/V170/K170/H-I | Named owner, commit, exact paths, handoff time |
| T7 producer | Source path/commit/hash, bundle path/SHA-256, stopped-owner receipt |

## Results

| Gate | Status | Command / case | Exit | Evidence / reason |
| --- | --- | --- | --- | --- |
| Protocol/runtime/SDK/device builds | pending | Package gates | unrun | No execution recorded |
| JS/Python conformance | pending | Both actual transports | unrun | Python SKIP is not pass |
| Generated schemas | pending | Regenerate twice, compare both copies | unrun | Record hashes |
| Desktop checks and regression | pending | Scoped then full gates | unrun | Preserve earlier failure details |
| Cross-plan oracle | pending | stage-3-foundations.test.mjs | unrun | Unit evidence only |
| Cross-plan actual 15 cases | pending | stage-3-foundations-run.mjs | unrun | Requires reviewed T7 producer and artifact hashes |
| B1-U12 with actual B2 | pending | retirement/registration/release/disconnect/renderer cases | unrun | Empty participant cannot close |
| B2 negative matrix | pending | All 29 source rows | unrun | Attach each concrete fault case |
| B2-RF1–RF5 | pending | Pinned test files and actual evidence | unrun | No inference from file existence |
| Installed/no orphan | pending | Each delivered OS/architecture | unrun | Actual packaged executable |
| Manual B2-M01 | pending | Settings accessibility/layout/CAS | unrun | Controller manual |
| Manual B2-M02 | pending | Real disk full/permission/TTL/close | unrun | Controller manual |
| Manual B2-M03 | pending | Native export and clipboard | unrun | Controller manual |
| Manual B2-M04 | pending | Real kill/cold safe mode/all optional off | unrun | Controller manual |
| Manual B2-M05 | deferred | Real legacy mappings | unrun | 3D/3E own product mappings |
| Manual B2-M06 | pending | Installed platform/second instance/parity | unrun | Per OS/architecture |
| Stage-2 V01–V04 | unchanged | Preserve source acceptance ledger | unrun here | No new claim |
| 3C / 3D / 3E | outside foundation closeout | Separate plans | unrun here | No 1.8.0 publication here |

Every timing row records OS/architecture, CPU/RAM, filesystem, Node/Electron,
commit/artifact, fixture bytes/records/limits, warm/cold, sample count,
p50/p95/max and memory method. Attach raw measurements; do not loosen budgets.

## Remaining blockers and resolutions

Record each unresolved contract, failed/unrun test, manual platform and its
responsible owner. Keep U12 pending until the actual participant evidence
exists. A receipt-validator pass alone changes only its own result row.
```

Fill actual commit/artifact values at execution time. The candidate SHA precedes the report commit; identify it explicitly rather than making the report self-referential. Record the final report commit separately after committing.

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git add tests/desktop/README.md docs/en/architecture.md docs/zh-TW/architecture.md docs/en/roadmap.md docs/zh-TW/roadmap.md docs/superpowers/plans/2026-10-17-plugin-system-stage-3-foundations-verification.md
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git commit -m "docs(plugins): record merged stage 3 foundation verification"
```

A controller review checks every reported pass against its raw receipt. Unrun OS/manual/hardware rows remain pending. Only actual successful real-participant cases close B1-U12. Follow-up fixes return to named stopped owners for exactly named files, then rerun affected checks; unchanged successful broad gates need not be repeated without a reason.


## Required negative-matrix closure

The following table is copied from the binding skeleton appendix. B2 §10 has no published row IDs; use its exact failure-position text as the report key, rather than inventing canonical B2 IDs. Each row is a separate required case in the T7 fault/interop/import suites. T9 records actual results; X-T1 adds the cross-plan cases above. A unit oracle or a list of expected outcomes does not replace the assigned domain tests.

| 失敗／注入位置                                                         | API／core 結果                                     | 不變量與必要 assertion                                                                                              |
| ---------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 未宣告 permission／foreign ID、handle／偽造 namespace                  | permission denied／stale，不回 foreign existence   | 目標 source 檔案與 quotas 完全不變；換 manifest ID 仍無法取得別 namespace。                                         |
| schema 未知欄位、duplicate key、NaN／Infinity、數值 coercion、超 bytes | invalidParams 或 SETTINGS_SCHEMA                   | 沒有 temp／watch event／defaults overwrite。                                                                        |
| 兩視窗相同 settings revision 更新                                      | 一個成功、一個 SETTINGS_CONFLICT                   | 至多一份新 head；失敗者 draft 保留，不能 last-write-wins。                                                          |
| record stale revision／write-in-progress／delete race                  | STORAGE_CONFLICT                                   | 舊/new receipt 可對帳；read 不混 revision。                                                                         |
| quota 在同時 begin 時競爭／第二次 app 啟動                             | QUOTA／聚焦既有視窗後退出                          | logical＋reservation 不超限；第二實例不初始化 worker／store，沒有降級並寫。                                         |
| 最大 chunk＋1、base64 無效、skip／overlap offset、錯 hash              | limit／invalidParams／CONFLICT                     | 不寫 sparse 或可 commit 的部分 payload；重送前一 chunk 不重複 append。                                              |
| write 返回短寫、ENOSPC／EDQUOT、read-only、EACCES                      | SAVE／IO、not-committed                            | short-write loop 完整或失敗，舊 head 保留；permission 不是 corruption。                                             |
| seal sync／object rename 失敗或 kill                                   | 未成功 commit                                      | 重啟使用舊 head；孤立 object 不升格。                                                                               |
| head rename 前 disable／cancel／deadline                               | cancelled／stale，或 core checkpoint-only          | fence 贏過 late callback，不能在 re-enable 後出版舊資料。                                                           |
| head rename 後失去回覆、sync 失敗                                      | unknown 或可對帳的 committed                       | 新舊 object 保留；禁止盲目再 create／commit；完整 head 對帳後解除 fence。                                           |
| directory fsync unsupported 與 EIO 分別注入                            | 前者明示 file-sync-only；後者 fault                | 不把任意 fsync error 吞掉；各平台 receipt 正確。                                                                    |
| cleanup unlink 失敗／讀取仍 pin old object                             | commit 仍成功，temporary charge 保留               | 不刪 active read；可重試 GC；新寫入因 scratch 滿可被拒。                                                            |
| read/list 到期、跨 generation、刪除／替換間分頁                        | stale／conflict／固定 list snapshot                | 無重複／跳頁源自 mutable offset；每個 read 只讀一版。                                                               |
| 已 committed head／object 損壞、unknown disk version                   | IO corrupt／VERSION；core recovery                 | 不回 empty history、不預設重設；保留 evidence／last verified backup。                                               |
| flush 前有 incomplete／open checkpoint／pending unknown                | flush-incomplete／timeout                          | 沒有「全部已保存」成功，也不替 caller commit partial payload。                                                      |
| settings watch slow callback／queue 滿／漏 sequence／重複 unsubscribe  | 合併 invalidation、read snapshot                   | 驗證＋入 queue 後 ack；首次 removed=true、重複 false；最後 state 與 terminal fault 可查。                           |
| plugin crash：memory-only／receiving／sealed 三種                      | checkpoint-only／有期限 retryable                  | host 沒有 bytes 就不能說 retry；reservation／subscriptions 均回收。                                                 |
| drain callback hang／10 秒到／2 秒 shutdown 不配合                     | token 撤銷、4 秒 process bound、core blocker       | 不延長 staging 120 秒；不因 process kill 把保存錯誤清掉。                                                           |
| sealed retention 30 秒 idle／120 秒 total 到期                         | retryable→checkpoint-only                          | 失敗 retry 不續期；expired callback 不能 rename；無 unresolved I/O 才刪 temp。                                      |
| renderer crash／最後視窗關閉／provider loss                            | 來源結束、健康 process drain                       | 不等待 renderer cleanup、不自動重連或續錄；save failure 顯示核心。                                                  |
| core Disconnect／OS suspend／wake                                      | 停止來源、final save；失敗保留 blocker／checkpoint | Disconnect 確認 stop/save 後才斷線；suspend 不保證 OS 等待，wake 不續錄／續期；plugin 跨 owner disconnect 仍 busy。 |
| safe-mode cold start／三 feature 全關                                  | core 能檢視 checkpoint／fault                      | 未讀 optional schema、未啟 mapper／process；core explicit export 仍可用。                                           |
| export 假 action／重播／過期、取消 dialog                              | permission/stale／cancelled                        | 零 destination mutation、零 device lock；無路徑回傳。                                                               |
| export temp disk-full、destination 被換、commit 前後取消               | IO／destination-changed／unknown                   | 舊 destination 保留或完整替換，沒有先 unlink；不能對已 export 回 cancelled。                                        |
| clipboard 無權限／超量／OS adapter fail                                | denied／limit／clipboard-unavailable               | 未成功不顯示 copied；不讀取剪貼簿或寫入其他格式。                                                                   |
| import input invalid／unknown version／quota 不足                      | blocked、原始 evidence 可見                        | 不標 complete、不截斷、不啟用半套資料。                                                                             |
| import item commit 後、journal receipt 前 kill                         | resume 辨識 internal receipt                       | ID、bytes、records 數不重複；已新寫資料不被 legacy 覆蓋。                                                           |
| complete marker 前後 kill／renderer nonce 重播／snapshot 缺席          | marker 前 pending、marker 後一次完成               | originals 不變；缺席不是 absent；刪掉已匯入 record 不重匯。                                                         |
| filesystem symlink／reparse／hardlink alias                            | 拒不安全路徑                                       | 不觸及 namespace 外檔案；新 store 不信任 path 字串與 PID 猜測。                                                     |

The concrete execution mapping is: permissions/schema/CAS/chunks/watch/read/flush → `plugin-persistence-interop.test.mjs`; publication/short-write/fsync/cleanup/corruption/kill/TTL → `plugin-persistence-kill.test.mjs`; quota/worker/queue/RSS/stop latency → `plugin-persistence-load.test.mjs`; import receipt/marker/source/nonce/path evidence → `plugin-persistence-import.test.mjs`. Retain direct settings-form/lifecycle/actions tests at their RF paths. Cross-case assertions and expected counts are defined in X-T1, rather than being inferred from a generic successful smoke result.

## Verification commands and receipts

These are **future implementation commands**, verified against root/package scripts and the 2C plan. Writing this plan does not execute builders, generators, runtime tests or smoke. Use the prepared dependency environment; do not install to work around a failing command. Every pnpm command below has the required prefix. Run a scoped task's owned tests first, then batch integration and final checks; reuse unchanged successful results rather than rerunning them at every gate.

### Package and schema gates (each publication)

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-sdk build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/device build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol test
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime test
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-sdk test
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/device test
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm test:python-sdk
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol schema
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; cmp packages/plugin-protocol/schema/plugin-protocol.schema.json sdks/python/kobrixa/plugin-protocol.schema.json
```

The first schema generation is an authorized H-P change, not a clean-diff test against the previous API version. After the controller records the reviewed batch, rerun the generator and require:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git diff --exit-code -- packages/plugin-protocol/schema/plugin-protocol.schema.json sdks/python/kobrixa/plugin-protocol.schema.json
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git diff --check
```

For an uncommitted batch compare a saved in-memory hash before/after the second generation instead; do not mislabel the expected version bump as drift. Assert exact API/schema IDs 1.5.0, then 1.6.0, then 1.7.0, their permissions/events/codes, and preserved initialize/legacy command fixtures. Python runner's local SKIP is unrun acceptance, never PASS; CI must provide Python 3.10+ as the existing runner requires.

### Scoped desktop and integration checks

Existing desktop Vitest includes `src/**/*.test.ts` (not `.test.tsx`). Keep the task's React tests at the named `.test.ts` paths and use the real browser harness for DOM/keyboard/paint evidence.

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop test
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm check:desktop
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm test:desktop
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm test:static-languages:boundaries
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm test:ci-routing
```

New owned cross-layer files use the existing Node test runner pattern (H-I hooks them into existing test/CI scripts at the relevant batch):

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; node --test tests/desktop/device-broker-*.test.mjs
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; node --test tests/desktop/declarative-ui-*.test.mjs tests/desktop/builtin-process-*.test.mjs
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; node --test tests/desktop/plugin-persistence-*.test.mjs
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; node --test tests/desktop/stage-3-foundations.test.mjs
```

These paths are future outputs assigned above; do not run them before the corresponding task creates them. Their `*-run.mjs` files are the owned actual-Electron entrypoints; H-I wires them into the current smoke harness. Failure in an early smoke suite does not make later suites passed; rerun the affected focused entry and record what really executed.

### Full regression and installed gates

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm -r build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm check
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm test
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm test:web
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm format:check
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm test:plugins:smoke
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm test:static-languages:smoke
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm test:desktop:smoke
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm build:desktop
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm test:desktop:packaged
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git diff --check
```

Headless Linux uses the repository CI's `xvfb-run -a` before Electron-running pnpm commands, after the same export prefix. Windows/macOS installed adapter and actual USB/Wi-Fi manual results are separately recorded. `pnpm test:desktop` includes bytecode, release, Python and static-language checks; `pnpm check` includes ESLint. Reuse those results rather than adding duplicate broad lint/test runs without changes. Never run root `format` to rewrite other owners' files.

Each report records command/exit code, commit/artifact, OS/architecture, CPU/RAM/filesystem, Node/Electron, fixture bytes/records/limits, warm/cold, sample count, p50/p95/max, memory metric/method, and manual/unrun reason. B1 measurements: 5s warmup, 60s samples, ≥3 repeats. B2: 30 samples and separate main/worker RSS. A: 10-minute bounded workload and broker/transport/readback/journal latencies separately. Preserve stage-2 V01–V04 exceptions and future 3C/3D/3E acceptance; no blanket “all passed” from mock fixtures.

Electron-running package/desktop/plugin/static-language/installed commands, browser or localhost harnesses, native dialogs, hardware and real suspend are **controller runs outside sandbox**. A build/typecheck/unit command that can run within the implementation sandbox stays there. Preserve an actual failure or unrun reason; do not install dependencies to make an unavailable environment look ready.

## Manual evidence ledger

以下結果由實作者在後續 report 逐項填證據；本設計不代簽。每項記錄 app artifact、平台／filesystem、操作步驟、觀察結果與未測限制。

| ID     | 必要人工操作                                                                                                                                                                                                           |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B2-M01 | en／zh-TW、light／dark、320 px 側欄／125% scale，鍵盤遍歷 settings controls、help／error accessible names、逐欄立即保存／重設／衝突 draft 保留；無 feature process 也可理解 core 保存錯誤。                            |
| B2-M02 | 真實磁碟滿／不可寫目錄，settings 不假成功；record 舊版可讀，retryable payload 倒數消失後正確轉 checkpoint-only；明確 retry／discard 及正常 close blocker。                                                             |
| B2-M03 | 已安裝 app 中 export save dialog：取消、替換既有檔、無權限、目的地變更、window destroyed；CSV 由 feature 產生，destination 不外洩。clipboard 實際貼上精確純文字。                                                      |
| B2-M04 | 真實 plugin／renderer kill、強制退出與 cold safe mode；最後 committed checkpoint 可查、沒有重新錄製／連線；三 optional features 全關仍有 core recovery/export。                                                        |
| B2-M05 | 複製舊 userData 與 renderer preferences，在實際升級流程 import；中途終止再啟、originals 保留、完成後不重匯；3D／3E 各提供真實 mapping 結果，不由 synthetic fixture 代替。                                              |
| B2-M06 | 每個實際交付 OS／architecture 的 packaged app、無 checkout／外部 Node：第二次啟動聚焦／還原既有視窗後退出，沒有第二個 persistence worker 或 native lock addon；JS feature 與 Python dev fixture parity；未測平台明列。 |

硬體 motion／停止確認由 3A／3C／3E MANUAL 負責；本案儲存驗收不代表設備安全驗收。umbrella 及 stage-2 V01–V04 的未完成項保持原狀。


## Final writer/controller review

- [ ] Task IDs remain `3B2-T9` and `X-T1`; P12 adds no implementation wave or owner.
- [ ] R170/D170/V170/K170 run under their persistent owners; exact H-I paths are listed.
- [ ] F → P150 → P160 → P170 uses actual receipts and user merges; no schema-side cherry-pick.
- [ ] One lock, one worker and one coordinator listener; no new B2 listener or legacy Lab save bypass.
- [ ] Retire/freeze uses the original grant in one turn; healthy release/provider/suspend does not retire the consumer.
- [ ] Pending registrations, prior-session finals, duplicate end and repeated close retain the first deadline and target identity.
- [ ] Core export stays separate from feature actionRef and the v1 status-action enum.
- [ ] AM-18/23–30 actual backend/settings/import/recovery attachments and T7 producer receipt precede P170 acceptance.
- [ ] AM-31 SDK factories/invocation-local actionRef, grant-bound drain storage and shared event ACK are exercised by actual JS/Python clients.
- [ ] AM-32/spec-corrections canonical test-fixtures paths and reports under docs/superpowers/plans are used; opaque record .bin bytes have no prefix/wrapper, JSON envelopes retain formatVersion:1.
- [ ] Recovery/import metadata use AM-24/26 atomic tickets and bounded evidence reads; restart preserves original TTL, hashes, IDs and raw evidence.
- [ ] All B2 matrix rows and RF1–RF5 link concrete tests; U12 closes only on actual composed persistence.
- [ ] 30 storage samples, separate RSS, UI 5s/60s/3 runs and device 10-minute evidence retain exact budgets.
- [ ] Manual/platform/unrun rows, stage-2 V01–V04 and 3C/3D/3E remain honest.
- [ ] No implementation tests, builds or commits were executed merely while writing this plan.
