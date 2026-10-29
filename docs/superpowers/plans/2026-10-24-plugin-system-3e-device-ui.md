# Stage 3E：EV3 設備 UI 實作計畫草案

日期：2026-10-24；`feat/plugin-3e`／`a31da12`；[設計](../specs/2026-10-24-plugin-system-3e-device-ui-design.md)。公開 UI 契約仍為草案；E0 舊行為基準已有部分執行結果，見文末 receipt。其餘任務尚未完成。

## 1. 依賴、owner 與封閉路徑規則

shared stage3 目前只有 3A。B2 `871e581`、C `4c86f0a`、D `f822f3c` 是唯讀參照，不借用未提交測試候選、不推定驗收。先取得 foundation、3C public-only proof、3D D1/v2 及各 owner 交接；最終 closeout 必須全部實際整合。

每次交接記 base/head SHA、前 writer 已停止、精確 paths、所消費 port/schema、fixture 與證據。H-P＝共同 protocol/JS/Python owner；H-R＝B1 runtime；H-D＝desktop/3A/B2 composition；H-V＝renderer；H-K＝packaging；F-E＝device feature。同一檔只有一位 writer，未取得 receipt 不編輯。

下表是未來 E 任務的封閉 write sets；prefix 展開後皆相對 repo root，花括號僅列有限檔名，沒有目錄萬用授權。`S`＝`apps/desktop/src`；`P`＝`S/main/plugins/persistence`；`F`＝`plugins/device-ev3`；`T`＝`S/builtin-features/device-ev3`。新增 helper 只限表列，跨功能問題先回 owner，不擴成第二套基礎設施。

| Set | Owner | 精確路徑（新增亦列入） |
| --- | --- | --- |
| W0 | controller | 本 design 與本 plan 兩檔；E0/E1 receipt 與最終 evidence index 直接記入本 plan |
| WR | H-R | `packages/plugin-runtime/src/{manager.ts,manager.test.ts,index.ts,builtin-source-port.ts,builtin-source-port.test.ts}`；新 port 僅供 source eligibility 與同步，正式名稱於 E1 固定 |
| WP | H-D/B2 | `P/{device-settings-import.ts,device-settings-import.test.ts,device-preferences-port.ts,device-preferences-port.test.ts,host-port.ts,host-port.test.ts,settings-service.ts,settings-service.test.ts,worker.ts,worker.test.ts}`；`S/main/device/{preferences.ts,preferences.test.ts}` |
| WF | F-E | `F/kobrixa-plugin.json`、`F/src/{main.ts,controller.ts,presentation.ts}`、`F/ui/panel.json`、`F/settings/preferences.json`；`T/{parity-fixtures.ts,parity.test.ts,controller.test.ts,public-transport.test.ts,private-dependency.test.ts}` |
| WI | H-D | `S/main/{index.ts,ipc.ts,ipc.test.ts}`、`S/main/plugins/{builtin.ts,builtin.test.ts}`、`S/main/device/{device.ts,device.test.ts}`、`S/preload/{index.ts,index.test.ts}`、`S/shared/{api.ts,device-preferences.ts}` |
| WV | H-V | `S/renderer/{app.tsx,execution/execution.ts,execution/execution.test.ts,device/device-panel.tsx,device/monitor-panel.tsx,device/monitor-controller.ts,device/monitor-controller.test.ts,device/monitor-workspace.tsx,settings/device-settings.ts,settings/settings.ts,settings/settings.test.ts,settings/settings-catalog.ts,settings/settings-catalog.test.ts,settings/settings-panel.tsx,settings/settings-panel.test.ts}` |
| WK | H-K | `S/main/plugins/{builtin-launch.ts,builtin-launch.test.ts,launchers.ts,launchers.test.ts}`、`apps/desktop/{vite.plugin-device.config.ts,vite.plugin.config.ts,forge.config.ts}`；`tests/desktop/{device-ui-smoke.mjs,device-ui-installed-smoke.mjs}` |
| WX | H-D/H-V 逐檔交接 | `T/{lifecycle.test.ts,import-integration.test.ts,provider-preferences.test.ts}`、`tests/desktop/fixtures/device-ui-public/{consumer.ts,consumer.py,kobrixa-plugin.json}` |
| WD | controller/docs owner | `docs/en/{architecture.md,device-support.md,plugin-devices.md,roadmap.md}`、`docs/zh-TW/{architecture.md,device-support.md,plugin-devices.md,roadmap.md}`、`docs/superpowers/specs/2026-10-17-plugin-system-stage-3-design.md`、`tests/hardware/device-ui.md`、W0 |

H-P 的 recovery／v2／SDK/schema 變更屬原契約 owner 的 D1 批次，不在上述 E write sets；E1 須記其已審 exact diff paths/receipt，未交付即 blocked。若任務需未列檔案，先在 W0 審查增補明確路徑與 owner，不以「直接 tests」或「相關檔案」擴權。

實作須保留既有使用者工作與 sibling 未提交變更；整合分支合併依使用者確認執行。

## 2. 任務順序與退出條件

### E0：基準與完整 parity（W0；未來 fixtures 用 WF）

將 design §3 每列編為 P01–P12，建立 legacy 輸入／可觀察結果 oracle，包含 execution pending-run、USB recovery、monitor modes/age、六 prefs；記來源 commit 與 core 例外 caller。只讀既有模型，不重建 B2/C/D 已審基礎。

退出：每項指定 feature/core/contract owner；source graph 能指出 retained callers，無「移走整個 device namespace」的刪除項。初始盤點後已新增部分 legacy fixtures；實際範圍與未驗項見文末 receipt，未宣告完整新舊 parity。

### E1：跨 owner 門檻（W0；依賴 D1）

H-R 確認 source eligibility 不受 supervisor failed 影響；B2/H-D 確認無 process 的 authoritative read、import barriers、兩來源組合與 commit 通知；3A/B1 確認 recovery 公開投影／可信取消、coordinator blockers；3D D1 確認動態 list/table、mode/source semantics、共用 limits；H-K 確認 settings/v2 resource index。

Wi-Fi 跨欄更新列為 E1 必決契約：B2/H-D 在 WP 的 settings-service 的 update/reset mutation 路徑落實，H-P 與 H-V 定義公開可查的相依欄位語意及表單支援。remember=false 的 update 或 reset 必須與 lastWifiAddress="" 在同一次 revision CAS 成功／失敗；SDK 與表單一致，禁止 post-commit watcher 補寫。若需要 resource/schema 擴充，先由 D1 契約 owner 審查並交接其 exact paths，未凍結前 E3 不得直接宣稱通用單欄表單可滿足。

退出：每個 blocker 有正式 port/schema、雙 SDK fixtures、exact owner paths、交接 SHA；3C proof 未成立不凍結 v2。所有未決公開項維持「D1 dependent」，不提供假 API、JSON-string 暫解或私人 IPC。沿 1.5→1.6→1.7→1.8 批次，3E 不升 minor。

### E2：source/provider 與 preference bridge（WR→WP→WI 序列交接）

H-R 實作 host eligibility port；H-D/H-K 接 factory 的 desired source state，同一 source、單 factory、provider replacement generation；啟 UI 不註冊第二 provider。停用由既有 coordinator gate/stop/save 後撤銷，不在摘要事件直接跳過 cleanup。

B2/H-D 建正式 host namespace reader，provider connection policy 與 core skipUnchangedAssets 只消費 committed snapshot；可在 UI 從未啟動時讀取，不借 public RPC 假 principal。reader/error/gate 與 deadline 明確，safe/disabled 不做 optional I/O。

退出驗證：idle/starting/running/crashed UI 均不改健康 provider eligibility；source disable/re-enable/replacement 各恰好一份 provider；讀取失敗無 defaults fallback；headless core recovery 不自動啟動 source；必要 compiler 不受影響。

### E3：一次性偏好匯入與即時設定（WP→WI/WV 各自交接；WF settings resource）

以 B2 descriptor/resolver/worker allowlist 匯入六 prefs 與三項 renderer connection prefs；先停止對應舊 writers，不停整個 settings store 的其他設定。保留 originals；兩來源完整 snapshot 的合併與 receipts 按 E1，complete 才切換新讀寫，之後永不回落舊檔。

接 B2 通用 contributed form；有效欄位 update/reset 都 atomic CAS，field draft/error/retry 保留；remember=false 原子清除 lastWifiAddress。feature 使用 public read/watch，不直接讀本機檔。legacy fallback 僅 complete 前的可信 validated reader，不能掩蓋 corrupt/I/O。

退出驗證：六個 default/enum、單欄 reset、快速連改/CAS 衝突/失敗 draft、commit unknown/reconcile、renderer snapshot nonce/stale window、完整 import／缺項／ENOENT／損壞／permission／symlink／較新版本、commit/receipt/marker 間中斷與重入；target 已有值不覆蓋、reset 後重啟不重匯，safe/disabled mapper 不執行。

### E4：公開 process 與 panel（WF；須 E1/v2 receipt）

entry 依 C 的 runPlugin/公開 transport 範式，綁 registered panel/commands；controller 只收 public data，presentation 純投影。USB/Wi-Fi discover/list/address/connect、recovery/notice/cancel、monitor/battery/program/modes 與 settings 按 P01–P12 完整接線。

v2 candidate/mode rows 用 stable ID＋dataset revision，選取時重新驗 session/source；foreground busy/fresh/error/read-only 分開。core disconnect/openRecovery 使用可信 action；開 panel、resource retry、re-enable 均不 connect/replay。hide/close 解除自身 demand，保留其他 owner 的 sampler demand。

退出驗證：P01–P12 新舊 oracle 差分；未知版本、超界、gap、慢 consumer、stale row/patch/session、失權及晚回覆不復活；真正 MessagePort JS→router→broker，不以 SDK mock 代替。缺 contract 返回 E1，不能縮範圍。

### E5：core 相鄰區與 lifecycle（WI→WV；WX）

core 保留 build/deploy/version、pending-run/cancel、remote-files；接公開 session catalog 的 host adapter，禁止將 ExecutionState/DeviceDescriptor 私有 DTO 交 process。若 pending Run 已取消或失權，連線完成不得續跑；UI open 不產生執行意圖。

接既有 quiesce→stop/readback＋onEnded/endReservation/drain→disconnect；保存／journal／stop 失敗仍阻擋正常 close/update。provider loss 結束 reservation、清 UI stale handles，但健康 consumer execution generation 存續；renderer loss 才 retire 對應 owner/process。

退出驗證：下節故障矩陣；所有 legacy deploy/files/mode/monitor/battery 共用 broker，無第二鎖；public disconnect busy 與可信 user Disconnect 分開測。retained core 路徑在全部 optional off 時仍能顯示管理／未確認故障，不為讀狀態自動連線。

### E6：封裝與公開跨語言證明（WK；WX/WF 各 owner）

共用 launcher/index 枚舉 settings v1 與 panel v2；輸出 design §6 的確切 leaf，驗 hashes、SDK bundle、main native dependency 布局。沿 C packaging，不建立第二 resource copier。

真 JS MessagePort 與 Python stdio consumer 經公開 router 測 discover/connect/read/modes/settings/reset/watch/unsubscribe、v2 rows/revisions、取消/timeout/失權/超限/停用/crash/stale；Python 不負責 native provider。全 Stage 3 parity 的 motion/recording/storage/export 仍接 C/D/B2 證據，不能因 3E 不直接使用就略過。

source-free installed：離線、無 checkout/外部 Node、實際產品 entry，完成連線模擬、monitor/settings、disable/re-enable/quit；缺 entry/resource/hash 或 native dependency 時顯示 unavailable、無 source fallback／orphan。記 build SHA、artifact hash、OS/arch、實際解析位置與 RPC trace。

### E7：有 replacement 證據才撤 legacy（WI/WV；依 E4–E6）

逐 caller 移除 device/monitor 舊 mount、已替代 settings get/set 與 renderer connection writers；motor/Lab composition 需各 owner receipt。保留 execution/remote-files 所需 IPC/preload/shared DTO 和 provider engine，不整批刪 device namespace。

退出：每個刪除符號有對應 P fixture、public trace、import restart 與 installed proof；source import graph＋bundle metadata/content＋RPC trace 三重 private-dependency audit。無雙 writer／雙 subscription 路徑；撤除後重新封裝受影響 smoke，未有證據維持 migration 未完成。

### E8：人工矩陣與 Stage 3 closeout（WD/W0）

更新雙語 device/architecture/roadmap、Plugin tools、Disconnect、suspend、一般使用者 switches、second launch 與 core recovery 說明。Stage 3 criterion matrix 逐列填實際 artifact/commit，不抄 sibling PASS，也不將 stage2 V01–V04 改成完成。remote-files 等例外只核銷確已替代部分。

## 3. 故障與人工驗收矩陣

以下全部待執行；未來命令以整合基準 package scripts 為準：targeted unit/integration→公開 transport→產品 package/installed smoke→MANUAL。每步保留實際命令、exit code、log/artifact hash；本次不安裝依賴、不跑測試/native。

| 情境 | 自動化注入與必要判定 | MANUAL |
| --- | --- | --- |
| all-off／逐一開關 | 三個 optional 獨立持久；compiler/core 管理正常，無 provider/process/import 自啟 | 一般模式不需 developer mode |
| second instance | 第二程序只聚焦退出，無 profile 寫入／第二 provider | 既有錄製不重建，視窗 blur 安全行為 |
| UI crash／renderer freeze/crash | provider eligibility 分離；owner retirement、晚訊息拒絕、main safety 不等 cleanup | 故障提示、恢復入口、無操作重播 |
| provider loss／USB 拔除／Wi-Fi timeout | 新工作 gate、end/save、健康 consumer 存續、session cache 清除 | 真 EV3 重連/retry-limit/cancel/notice |
| settings/import/disk-full | 原檔保留、CAS/reset/failed draft、unknown 對帳、barrier 重入 | 匯入/重試說明與值等價 |
| Disconnect／close/update／suspend | stop/save/journal failure 均 block；期限不當成功，wake 不續作 | motor 停止觀察、Lab 最後 committed 資料 |
| safe/cold/headless recovery | optional-only crash 不鎖；renderer/第三方風險遵原 lock；無 optional I/O/autolaunch | 無 session 保留 unconfirmed，明確復原 |
| authority／遠端合作 | host/editor/viewer、失權於 await、unsynced、跨 owner 偽造、read/stop 保留 | grant/reclaim/offline；guest 不取得遠端 USB |
| hardware／monitor 仲裁 | fake provider modes/pin/program/files gaps/battery-null/freshness | USB/Wi-Fi 四通道、電量/電壓/program/modes、最大錄製與 motor 互斥 |
| installed/native/resources | source-free、missing/hash/unsupported version/native load fail、無 fallback/orphan | 各實交 OS/arch；en/zh-TW、明暗、320px、125%、鍵盤/focus/讀屏 |

## 4. S3-01–16 證據索引（2026-10-30 更新，未結案）

下表連結已提交的原始證據；每份 receipt 的來源 commit、dirty 狀態、環境、替代邊界及未驗項仍有效。舊 commit 的通過結果不自動等於最終整合 artifact 通過。I＝implementation；A＝automated；M＝MANUAL。沒有把既有 stage2 人工項改成完成。

| Criterion | 已有證據 | 尚待完成／保留例外 |
| --- | --- | --- |
| S3-01：版本／雙 SDK | [E 整合與完整 desktop 回歸](../evidence/2026-10-30-3e-integration/README.md)；已實作 API 1.8 | 最終版本／schema／SDK conformance 彙整，不能用 desktop 回歸代替 |
| S3-02：公開雙 transport | [D Python stdio](../evidence/2026-10-26-3d-python-stdio/README.md)、[D 公開 Lab](../evidence/2026-10-26-3d-public-lab/README.md) | E JS／Python native 修正重跑中；取消、timeout、故障矩陣仍須各自證明 |
| S3-03：公開-only feature | [C native／產品封裝](../evidence/2026-10-24-3c-native-installed/README.md) | C/D/E legacy exit 的 source／bundle／trace 最終三重 audit |
| S3-04：motor 垂直路徑 | [C 77 native cases](../evidence/2026-10-24-3c-native-installed/README.md) | 最終整合重建；硬體 M 不由 fake provider 代簽 |
| S3-05：共用 broker | [foundation retirement／release／disconnect](../evidence/2026-10-24-stage3-foundation-integration/README.md)、[E core session 整合](../evidence/2026-10-30-3e-integration/README.md) | 真實設備仲裁及剩餘 fault rows；保留 core adapters |
| S3-06：authority | [48 native motion races](../evidence/2026-10-23-3b1-native-motion/README.md)、[disabled-source core authority](../evidence/2026-10-26-stage3-disabled-core/README.md) | 合作 UI 持權轉移／offline 人工驗證；collaboration UI 保留例外 |
| S3-07：有界 UI／events | [B1 最大負載](../evidence/2026-10-23-3b1-ui-load/README.md)、[SDK backpressure](../evidence/2026-10-23-3b1-sdk-backpressure/README.md) | D v2 圖表／資料集最大負載及最終 artifact 延遲／RSS；B1 數據不代簽 v2 |
| S3-08：Lab | [公開 Lab native](../evidence/2026-10-26-3d-public-lab/README.md)、[Linux installed Lab](../evidence/2026-10-26-3d-installed-linux/README.md) | D7 完整 parity、D8 legacy exit、D9b 重建及人工驗證 |
| S3-09：settings／storage | [sealed TTL](../evidence/2026-10-26-3b2-sealed-ttl/README.md)、[E 九欄 migration 整合](../evidence/2026-10-30-3e-integration/README.md) | B2 N01–29/P170 彙整、E native migration restart；原檔保留 |
| S3-10：lifecycle／開關 | [all optional off 冷啟動](../evidence/2026-10-26-3b2-all-optional-off/README.md)、[renderer loss／explicit restart](../evidence/2026-10-26-3b2-renderer-loss/README.md) | §4.7 全列索引、second-instance／cold-safe 最終整合與一般使用者 UI |
| S3-11：stop／save／quit | [suspend/wake coordinator](../evidence/2026-10-24-3b2-suspend/README.md)、[action replay 整合](../evidence/2026-10-26-stage3-action-integration/README.md) | 真 OS suspend、產品 quit/update／save-failure 完整矩陣；timeout 不當完成 |
| S3-12：source-free installed | [C Linux 產品](../evidence/2026-10-24-3c-linux-installed/README.md)、[D Linux payload](../evidence/2026-10-26-3d-installed-linux/README.md) | E installed；C/D 最終移除 legacy 後重建。D receipt 是 acceptance host，不能寫成完整 app |
| S3-13：motor 硬體 | C/3A 自動注入只作輔助 | USB／Wi-Fi motion／stop／kill／拔線實體觀察待驗 |
| S3-14：Lab／monitor 硬體 | D/E fake provider 與軟體回歸 | 四通道、長錄、CSV、remote-files、合作及真設備互斥待驗 |
| S3-15：平台／可及性 | 已有 Linux arm64 receipts；[Mac installed 隔離阻塞](../evidence/2026-10-26-3d-installed-mac-blocked/README.md) | 實交 OS/arch、雙語／明暗／320px／125%／鍵盤／讀屏；未測不能外推 |
| S3-16：文件／例外帳 | [E 雙語文件與證據界線](../evidence/2026-10-30-3e-integration/README.md) | legacy caller 最終清單、各 owner 收尾及手動驗收結果；Stage3 保持未結案 |

順序為 E0→E1→E2/E3（paths 序列）→E4→E5→E6→E7→E8；D1 blocker 未解可停在 fixtures，不削減完成目標。最後只在所有必要 I/A/M 有真實證據時提出 closeout；本計畫不宣告 Stage 3 完成，也不授權整合分支或 main 合併。

## 5. E0 部分執行 receipt（2026-10-24）

來源基準 `590fd93`；測試提交 `3b05b86`。新增 [P01–P12 fixtures](../../../apps/desktop/src/builtin-features/device-ev3/parity-fixtures.ts) 與 [legacy 行為測試](../../../apps/desktop/src/builtin-features/device-ev3/parity.test.ts)，直接執行本分支的 ExecutionController、MonitorController、BatteryStatus、DevicePreferencesStore 與 SettingsStore。傳輸邊界受控，預期結果使用獨立 literal，未以新功能實作自比。

獨立複查 PASS；同一 scoped Vitest 命令由實作者與審查者執行，均為 **35 passed / 12 skipped**。12 個 skip 是各 parity 列明列的後續驗證，未算成功。Controller ESLint 通過；未執行完整 desktop typecheck、native 或 installed 測試。使用 sibling 現有 Vitest/Zod 套件及暫存 config，所有 legacy product imports 指向本工作樹；沒有安裝依賴。

覆蓋 pending-run 取消、重連晚回覆、monitor modes/session/busy/unknown 與 timestamp 保留、六偏好 defaults/options、保存失敗後重試及 Wi-Fi 正規化。尚缺 DOM discovery/render、實際 2.5 秒 freshness UI、main broker/coordinator、公開 transport/v2、import/CAS、installed/hardware。此 receipt 不凍結 D1/E1、不宣告新的 device feature 已交付或 Stage 3 完成。


## 6. E2/E3 host integration amendment (2026-10-30)

Implementation remains in progress. The controller owns these additional private composition paths: `apps/desktop/src/main/plugins/persistence/device-settings-migration.ts`, `device-settings-migration.test.ts`, and `device-settings-host.ts`, plus the existing `engine-port.ts`, `import-sources.ts`, `import-coordinator.ts`, `worker.ts`, and `device-settings-import-worker.test.ts`. The additions join the existing durable coordinator, original writer barriers, metadata-only host namespace, and authoritative settings reader; they do not add a public RPC or alternative store.

Actual manager enable/disable does not necessarily advance execution generation. Re-admission therefore forwards the already-validated host namespace's monotonically increasing `uiResourceGeneration` as private `admissionRevision` to the combined-source resolver. A replacement process identity at the same execution generation requires a strictly newer admission revision. A cached resolver rejects missing/lower revisions and equal-revision owner substitution. Other namespaces, host epochs, original nonce/digest, settings contract and original tickets remain fenced; ordinary renderer imports do not gain this option. This is host metadata admission, not plugin-supplied authority, and is not included in durable settings metadata or public schema.

The host gate keeps one coordinator for its lifetime so unresolved original publication pins are retained. A consumed immutable renderer capture or original durable plan can resume headlessly. A fresh profile without a renderer capture stays pending; it cannot manufacture empty localStorage. Renderer startup must freeze the three legacy keys before requesting the existing challenge, and every replacement window must retain that rule. This production startup attachment is still required; the tested private gate does not prove it by itself.

After a settings receipt notification, cached policy becomes unavailable synchronously until the authoritative refresh succeeds. Last committed evidence is display-only during failure; new optional I/O cannot use it as a fallback. Source withdrawal invalidates cached readiness without reading optional resources. Original restoration may retain its admitted namespace identity for reconciliation while current-source and settings-authority checks continue to block new publication.

Local prerequisite commit `f37d098` contains the original two-source import with one pristine nine-field CAS. Controller independently ran its 23 actual-worker cases. Current additional host/readmission tests are separate uncommitted work pending independent review and actual desktop composition wiring. No complete E2/E3, native, installed or Stage 3 claim is made here.


## 7. Desktop composition and renderer capture handoff (2026-10-30)

Additional exact controller-owned composition paths are `apps/desktop/src/main/plugins/controller.ts`, `controller.test.ts`, and `apps/desktop/src/main/device-broker/lifecycle-coordinator.ts`. The renderer capture owner writes only `apps/desktop/src/renderer/settings/legacy-preferences-bridge.ts` and its `.test.ts`. These extend WI/WV for the existing V170 challenge channel; they introduce no public RPC.

`f1b3763` records the independently reviewed host migration gate, authoritative reader, and private same-generation re-admission. The reviewer ran 328 tests across ten persistence files. The optional `legacyDeviceWriter` composition input binds the actual persistence worker/source metadata, host policy notification and fixed-descriptor challenge routing. A nonce is routed only after it was issued by that gate, and window retirement removes its route. Disposal removes the host observer. Absent opt-in retains the prior product composition until the replacement feature and installed evidence are ready.

The per-window `createDevicePreferencesMigration` adapter synchronously freezes the three existing connection preference writers, validates the exact trusted allowlist, and retains the first complete raw snapshot across explicit retries. It neither fabricates empty data on I/O failure nor equates capture acceptance with main migration readiness. Other settings remain writable. Controller source review and independent execution of its 41 renderer/SettingsStore tests accompany this handoff.

Actual desktop composition tests cover pristine combined migration, policy unavailable before acceptance, headless metadata reading without feature activation, replay, disable/re-enable, retired challenge rejection, and startup with a disabled source. Full controller regression execution is recorded separately. Main index and renderer startup mounts have not been switched: E4–E6 replacement proof and the later legacy exit remain required. Recovery SDK cross-review found queued-callback retirement and host subscription cleanup defects; those are being fixed separately, and the earlier green existing suites are not a recovery acceptance sign-off.


### Early settings-write race correction

The independent actual-worker composition review reproduced an ordinary contributed-form update creating a target revision before the original migration. That correctly blocked pristine import, but stranded host readiness. The private `PersistenceSourcePort.settingsWriteAllowed(sourceKey)` callback now gates ordinary update/reset/migrate centrally through the shared settings service, including bound forms and public requests. Metadata, read/watch and the original import publication remain usable; unrelated sources keep their existing behavior. Owner/permission/resource/CAS checks remain required.

A second controller regression reproduced withdrawal in the microtask between the async continuation and actual publish. The synchronous mutation fence now also runs next to consequential reserve/append/publish, without another await. Tests demonstrate both initial denial without reserve and abort rather than publication after withdrawal. Related settings suites: **128 passing tests**; the actual desktop composition file: **210 passing tests**, with types/lint passing. These software checks do not constitute the pending product-mount, native or installed acceptance.


### E4–E6 product integration ownership amendment (2026-10-30)

The controller owns the existing delivered-build table in `apps/desktop/packaging.ts` and its direct `apps/desktop/src/main/packaging.test.ts`, alongside WI builtin assembly. H-V may edit `apps/desktop/src/renderer/settings/settings-state.ts` and its direct `settings-state.test.ts` to attach the reviewed per-window capture helper. These are explicit additions to WK/WV; the shared Forge table remains the sole build registration mechanism. H-D owns index.ts and device/device.ts plus its direct test for the authoritative core reader. WF stays with the feature writer.

Assembly and migration attachment are a coordinated cutover: a device settings contribution must not reach ordinary writes without the main migration gate. Intermediate feature-branch commits are not accepted product migration. Legacy UI implementations/fixtures remain until replacement transport, import restart, and installed evidence; inactive or redirected old controls must never write frozen settings.

Recovery SDK/protocol/broker fixes committed `3190749`; independent review found no remaining actionable findings, 986 JS/protocol +143 Python and455 broker/host tests pass. Exact four JS/two Python retirement regressions were independently rerun. The migration write fence committed `2034502`, including a post-await synchronous admission check (128 settings tests). Actual composition committed `73142dd` (210 controller tests), independently reviewed. Local feature integration `b7eb8ba` consumes D `2ad68c2`; 99 atomic-store/original-import worker tests pass after merge. No hardware, installed-product migration, legacy removal, or Stage3 closeout is claimed.


### E5 retained core session adoption amendment (2026-10-30)

Product cutover review identified an actual missing adapter: public plugin connection bypasses DeviceService.connectWith, while ExecutionController currently accepts connected state only from its own promise. H-D/H-V owns the bounded correction in `apps/desktop/src/main/device-broker/{broker.ts,broker.test.ts,legacy-device.ts,legacy-device.test.ts}`, `apps/desktop/src/renderer/execution/{execution.ts,execution.test.ts}`, and `apps/desktop/src/shared/api.ts` only for a necessary typed host event. `main/device/{device.ts,device.test.ts}` may be adjusted only if this adapter requires it. Snapshot observation is read-only and must not create authority or native work; existing core deploy/files/monitor descriptor lookup must see the same broker session. Pending-run may continue only while its original intent/workspace/authority is current; cancelled intent, recovery, old sessions, and a duplicate promise callback must not run it.

Controller additionally owns `apps/desktop/src/renderer/device/device-panel.test.ts` for retained pending-run cancellation and neutral capture-notice DOM coverage. The old implementations remain for comparison; neither this amendment nor the partial tests authorize legacy removal. Recovery notification compatibility was restored in `9027984` with18legacy/87broker tests and an independent bounded review. Renderer cutover currently has66focused passes, full renderer import typecheck/lint pass; real EV3 entry bundle/resource validation joins assembler evidence (47passes/1existing skip). These are not native installed acceptance.


### P08 nullable observation slot ruling (2026-10-30)

Adopt the reviewed existing-channel representation rather than a new wire shape: an actually observed EV3 input with zero values publishes exactly one component-0 logical observation slot, preserving its actual port/type/mode/name/state. Component0 identifies an observation slot, not an assertion that a numeric sample exists. Its sample is null, never zero; a port absent from the provider reading remains absent. Nonempty component numbering and the38channel cap remain unchanged. Same-metadata null→numeric slot0 may retain identity; metadata changes/disappearance follow the existing broker revision/stale rules.

Ready+null may be recorded as an explicit gap under the existing nullable recording contract; it is not a calibration/preview measurement. Non-ready ports remain nonreservable, and query/set mode may not dispatch for non-ready metadata. Native mode preflight/type/switchability and authority remain required. This is a bounded semantic clarification for the existing unpublished Stage3 contract, not a new field or version.

Controller write set: `main/device-providers/ev3/{catalog.ts,catalog.test.ts,provider.ts,broker-integration.test.ts}` under desktop src, plus this plan, 3E design and 3A design semantic note. No protocol schema/SDK change. Feature WF owner owns its consumer tests separately; existing Lab null handling will be exercised as regression, not represented as new hardware proof.


### E6 native-public producer ownership (2026-10-30)

H-K/controller may add exactly `tests/desktop/device-ui-public-{run.mjs,main.ts,renderer.tsx,test.mjs}` for the actual production device feature entry, generic renderer/preload/host composition, real process transport, and an independently checked receipt. Existing public/installed helpers may be imported read-only; no parallel launcher, source fallback or pretend passing receipt is permitted. The native producer uses a synthetic provider, so its evidence cannot establish physical EV3 or packaged source-free acceptance. Python stdio and installed producers remain separate required E6 steps. An owner must stop writing and hand off precise paths before execution/review.

The bilingual manual procedure is `tests/hardware/device-ui.md`; every H01–H14 result currently remains NOT RUN. Historical v1 hardware acceptance does not close Stage3 migration acceptance.


### E6 Python producer and current integration receipt (2026-10-30)

The second bounded acceptance writer owns exactly `tests/desktop/device-ui-stdio-{run.mjs,main.ts,test.mjs}` and `tests/desktop/fixtures/device-ui-public/{consumer.py,kobrixa-plugin.json}`. This is a clearly named synthetic Python consumer, not the production EV3 feature or a builtin impersonation. It must use actual Python SDK stdio, host routing and persistence with its own contributed settings/UI namespace. It may generate declared fixture resources in the temporary artifact. Its provider remains synthetic and results cannot establish hardware or source-free production acceptance. Existing Lab stdio/public helpers are read-only references.

P08 committed `5b29c47`, independently reviewed without actionable findings; public feature `03e6d49` has40independently rerun tests with real MessageChannel. Coordinated product adoption/migration/assembler committed `dfae915` after independent scoped source reviews, controller852tests/36files, full main/renderer import typechecks, and47assembler/packaging passes with1existing skip. These receipts supersede earlier statements that these mounts are not yet switched, but do not close E4fullparity, E6native/installed, E7legacyexit, E8manual or Stage3.


Checkpoint source/hash/review/test evidence for `dfae915` is archived under [`docs/superpowers/evidence/2026-10-30-3e-integration`](../evidence/2026-10-30-3e-integration/README.md). This exact evidence directory is controller-owned documentation. It records all852integrated tests passing (superseding the earlier75/76P08 interim result),40feature tests,47assembly passes/1existing skip and main/renderer typechecks. Native, installed, hardware, full parity and final closeout remain unclaimed.

### E6 installed harness ownership amendment (2026-10-30)

After public JS `4a9db5c` and Python `7d1773f` native receipts, the installed writer owns exactly two new files `tests/desktop/device-ui-installed-{run,test}.mjs`; existing `tests/desktop/sensor-lab-installed-{run,artifacts,test}.mjs` for bounded reusable runtime/isolation/index helpers; and `tests/desktop/device-ui-public-{main.ts,run.mjs,test.mjs}` for explicit installed scenario, supplied production leaf and non-instrumented PID observation. The existing renderer, Landlock helper, production launcher and packaging remain read-only. Preserve Lab default behavior and regressions; no duplicated product compiler/copier, copied feature controller or weakened isolation. Actual production leaf bytes must be unchanged. Controller executes native/Linux runs and records exact build/source/artifact identities. This expands only test ownership, not completion or product scope.
