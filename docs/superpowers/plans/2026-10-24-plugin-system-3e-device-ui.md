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

## 4. S3-01–16 證據索引（全部待補）

每列 evidence 最終填 committed repo-relative artifact link＋實際 commit/build hash；沒有證據保持待驗，不能只貼忽略目錄或絕對工作樹路徑。I＝implementation；A＝automated；M＝MANUAL。下列是應取得內容，不代表存在。

| Criterion | I／責任 | A | M | Evidence／保留例外 |
| --- | --- | --- | --- | --- |
| S3-01 | H-P 1.5–1.8、E1 | schema/SDK/版本 drift、1.4 舊 command | 不取代自動契約 | 待填 owner receipts＋conformance；D1 未定不得 closed |
| S3-02 | B2/C/D＋E6 雙 consumer | 真 MessagePort/stdio，全成功/失敗/取消路徑 | 硬體另列 | 待填雙語 transport traces；不只 TS wrapper |
| S3-03 | C public-only | source/bundle/trace audit | 無替代證據 | 待填 C artifact；3E 另附 E7 audit |
| S3-04 | C motor | hold/start/stop/hide/late/失權 | S3-13 | 待填 C public E2E，未借 3E monitor 代簽 |
| S3-05 | 3A/B1/B2＋E2/E5 | provider/locks/Disconnect 順序、busy | 實體仲裁 | 待填 broker/coordinator trace；保留 core adapters |
| S3-06 | 3A authority＋E5 | admission/續行失權與偽造 | 合作持權轉移 | 待填 authority cases；collaboration UI 仍例外 |
| S3-07 | B1/D v2＋E4 | versions/limits/gap/stale、最大負載延遲/RSS | 可操作性 | 待填 D1 budgets 與 raw metrics，不提高 limits 過關 |
| S3-08 | D Lab 全遷移 | models/recorder/drain/history/CSV/restart | S3-14 | 待填 D evidence；approved pure model 不等全套 |
| S3-09 | B2/D＋E3 | 六 prefs/import/CAS/reset/disk-full/records | 匯入與 recovery | 待填 receipts/checkpoints，原檔保留 |
| S3-10 | B1＋E2/E5 | §4.7 每列、all-off/second instance/cold safe | switches/recovery | 待填生命周期矩陣；必要 compiler 保留 |
| S3-11 | B1/B2＋E5 | close/update/save/stop failures、無 orphan | force-exit 復原 | 待填 fault/receipt/drain trace，不將 timeout 當完成 |
| S3-12 | H-K＋E6/E7 | 三 feature source-free 產品 payload/native 布局 | S3-15 | 待填各 artifact hash/OS/arch/installed paths |
| S3-13 | C/3A | failure injection 輔助 | 真 USB/Wi-Fi motion/stop/kill/拔線 | 待填硬體/firmware/platform/觀察；mock 不代簽 |
| S3-14 | D/3A＋E4/E5 | monitor/modes/recording/foreground fixtures | 四通道/長錄/CSV/remote-files/合作 | 待填硬體記錄；重連非恢復原操作 |
| S3-15 | H-K/H-V＋E8 | installed smoke、renderer/resource failures | 各 OS/arch、雙語主題/scale/focus/cold safe | 待填平台表；未測逐項列出 |
| S3-16 | E8 與各 feature owner | 文件/例外/caller 對照 | 未完人工項明列 | 待填雙語文件與 ledger diff；remote-files 等保留、stage2 分帳 |

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
