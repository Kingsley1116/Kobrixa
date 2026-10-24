# Stage 3D：Sensor Lab 實作計畫草案

日期：2026-10-24；工作分支 `feat/plugin-3d`；[設計](../specs/2026-10-24-plugin-system-3d-sensor-lab-design.md)。本計畫安排後續實作與驗收；每個關卡以實際版本及證據判定。

## 1. 基準、依賴與執行原則

- authoritative [umbrella](../specs/2026-10-17-plugin-system-stage-3-design.md) §6 允許平行設計與純模型；3C public-only／installed proof 完成後才可最終凍結UIv2／發布API1.8.0。
- 已有 `8c8878b` 純模型五檔及 `apps/desktop/src/builtin-features/sensor-lab/` 五組測試直接沿用，不重寫。review report PASS只屬此slice；Lab process/UIv2仍未交付。
- foundation 3A／3B1／3B2需有實際baseline、owner receipts、正式ports；不從未驗收sibling branch取得隱含API。3C證據尚未完成不勾任何gate。
- 每任務先確認write set與前owner停止，保留baseline SHA／交接receipt；單一writer序列編輯hotspots。可將沒有重疊 write set 的工作平行執行。
- 每task交付實際diff、targeted驗證結果與限制；不以spec中的候選API當成目前可呼叫能力。以下驗證均須在對應實作完成後執行。

## 2. Hotspot責任與序列

| Owner                         | 唯一write set／責任                                                                                                                                                      | 交接順序                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| H-P protocol integrator       | `packages/plugin-protocol/` methods/manifest/common/limits/ui modules、schema/export/conformance；`packages/plugin-sdk-js/`、`sdks/python/` contexts/版本/bundled schema | 已有1.5→1.6→1.7 receipts→D1凍結→D2增量→D9的1.8發布檢查；不由feature writer改SDK。               |
| H-R runtime owner             | `packages/plugin-runtime/src/{manager,registry,supervisor,index}.ts`、ui catalog/state/subscriptions/lifecycle/host ports及直接tests                                     | foundation stopped receipt→D3；H-P types先定義，H-R統一exports；D7整合必要修正先重新領path。    |
| H-V renderer owner            | `apps/desktop/src/renderer/plugin-ui/`、`renderer/app.tsx`、對應styles/tests、必要shared renderer DTO                                                                    | D4 genericv2→D7接線→D8移除舊mount，3E延續ownership。                                            |
| H-D desktop integration owner | `apps/desktop/src/main/{index,ipc}.ts`、public router/composition、preload/shared bridge、`main/plugins/persistence/` host adapters/worker allowlist                     | D6匯入→D7 lifecycle/route→D8刪feature IPC；既有B2 worker/coordinator內容由原owner交接後才編輯。 |
| H-K packaging owner           | `main/plugins/{builtin,launchers}.ts`、`apps/desktop/{forge.config,vite.plugin*.config}.ts`、resource index/copy helper與tests                                           | D7接payload→D9 source-free installed proof；不得與3C/3E同改Forge/allowlist。                    |
| F-Lab feature writer          | `plugins/sensor-lab/`新entry/adapters/resources與`apps/desktop/src/builtin-features/sensor-lab/`新增tests                                                                | D0 fixtures→D5 process→D7整合；不改shared hotspots，不重建approved model。                      |

每次receipt列path清單、舊owner已停止、新owner、base/head SHA、所消費契約、檢查結果；不以merge conflict決定語意。最終合併由使用者執行，feature commits 不加 coauthor trailer。

## 3. 任務與write sets

### D0：基線與parity清單（可在3C等待期間準備）

讀取既有panel/controller/chart、main service/store/schema/csv與直接tests；以設計§3行為表逐列建立fixture ID，記錄目前branch/base、純模型review範圍。先不改API/version/manifest/legacy mount。

未來write set：`apps/desktop/src/builtin-features/sensor-lab/parity-fixtures.ts`、`parity.test.ts`（新增）；既有五個model leaves及tests只讀，除非另有可重現缺陷與審查。

驗證：同一raw輸入對舊native與新model的source/calibration/frame/CSV/cursor輸出；合理差異明列（gap/extrema修正、public provenance），不可用新實作自比。生成程式經既有compiler/EV3 VM fixture比較，不僅比字串。

### D1：T0技術審查與依賴receipt（阻擋D2正式凍結）

取得3C真public transport／installed proof與3A/B1/B2正式交接，核對不是synthetic UI fixture的成功。H-P/H-R/H-V/H-D/H-K各確認設計§4–5缺口、quota及實際型別。

write set：只本design/plan及具名T0 receipt；此時不升版。凍結候選v2 resource union、dataset begin/chunk/commit/read、status stopRecording/context、錯誤reason、SDK簽名、最大合法/反例fixtures、EV3公開identity vocabulary。

必須解決：v1 scalar無array；status無action且core stop只接motion；model ID≠host record ID；public EV3 code/cross-origin mapping；import descriptor不帶basename；模型stopReason與public reservation reason不相等。前三項不能用任意JSON字串／偽operation／私有service暫時繞過。

完成條件：owner確認候選合約可表達每列parity、基於最大fixture確認limits；3C未交付時只保留草案，D1不記closed。

### D2：公開UIv2、雙SDK與conformance（H-P）

write set：新增`packages/plugin-protocol/src/ui-v2-{resource,data,methods}.ts`及tests；更新既有`ui-methods.ts`/validation/methods/manifest/exports/schema、JS UI client、Python UI client與bundled schema、`test-fixtures/declarative-ui-v2/`。最終檔名以D1receipt固定，不能平行另造同義API。

實作：v1 union保持；v2 chart/table/list/dialog/code/status action；dataset binding/revision/chunks/TTL/bytes/count；API1.8 negotiation及UI version rejection。正式公開EV3 vocabulary與conformance，不讓feature匯入provider catalog。

驗證：共同valid/invalid/maximum fixtures跨Zod、JSON Schema、JS、Python；未知version/component/field、NaN/nonfinite、proto key、stale/cross-owner、UTF-8與code points、每項limit−1/limit/limit+1。1.6 motor與1.7 storage不退化，沒有未聲明UIv2 fallback。

### D3：generic runtime資料與status動作（H-R）

write set：新增runtime `ui-data.ts`及tests；既有ui-catalog/state/subscriptions/commands/lifecycle/host ports、必要manager/exports直接tests。

實作：registered dataset admission、atomic revision、1 receiving transfer/panel、commit/readpaging、TTL/revocation、queue/control分離；通用stopRecording驗同owner reservation，交broker release→唯一onEnded listener，禁止manager Lab特判。

驗證：替換resource／panelclose／retire／processEpoch改變的late replies、double commit、offset/hash錯誤、cancel／expiry、慢consumer/gap重新snapshot、host/source總量。stop不等chart queue，不接受把reservation當motion；status hidden/closed view仍可工作。

### D4：generic renderer與可及性（H-V）

write set：`renderer/plugin-ui/`新增chart/table/list/dialog/code/data-store元件及tests，更新components/panel-host/status-host/state-store/styles；暫不刪舊Lab。

實作：4圖共享cursor、raw-value table、單dialog放大/確認、純文字code；dataset snapshot與presentation revision對齊；focus不因patch遺失；en/zh-TW／明暗／320px／125% layout。

驗證：keyboard cursor、tab/focus trap/Escape/restore、row stale confirmation、screen-reader labels/live region、顏色以外辨識、dialog引用dataset不倍增cache。以4×2×800、50rows、背景錄製負載量測renderer apply與input/cursor/Stop latency；預算見design§9，保存raw samples而非只平均值。

### D5：Lab process與public adapters（F-Lab）

write set：新增`plugins/sensor-lab/src/{main,controller,recorder,persistence,presentation,ev3-source}.ts`、manifest、`ui/{panel,status}.json`；新增feature adapter tests。五個approved models重用，adapter不能依desktop-private型別。

實作順序：

1. `runPlugin`／ready／commands.registerContext／UI bindings；catalog/session/telemetry preview、channel選取/校正/form/error。
2. `reserve`的firstFrame建立session origin→initial committed record→registerCheckpoint ack；單consumer read≤64，處理gap/duplicate/source revision。
3. 5秒single-flight checkpoint、50history/8MiB/quota預檢、限時/限量release；release 前固定原始 reservation 的自動停止原因，drain 遵 design§6 的 host 終態優先規則；background與view demand分離。
4. `PluginDefinition.drain`以獨立signal/grant讀到lastSequence，對帳in-flight checkpoint後token final CAS；回submitted不當saved。處理host ID/payload UUID與interrupted投影。
5. history/profile list/read/delete/CAS、raw/calibrated／comparison、native EV3 code mapping與plain-text copy、raw CSV export與超8MiB顯式時間分段。
6. statusOpen／stopRecording、保存錯誤導向core recovery；provider/wake/re-enable不重播。最小permissions，不請devices.control或任意fs權限。

驗證：沒有新 frame 時的30分鐘deadline仍以limit保存、source loss競速不被limit覆寫、舊timer不改新reservation；origin跨session30分鐘、firstSequence去重、receipt/elapsed各自保留；fresh≤2500ms擷取/歸零；float32 snapshot不可變；public/legacy相容key與未知provider不可猜測；actionRef新鮮/單用/purpose，copy/export失敗不顯示成功。

### D6：B2 legacy mapping與切換barrier（H-D＋F-Lab順序交接）

write set：新增`main/plugins/persistence/sensor-lab-import.ts`及tests；既有`import-sources.ts`、resolver／worker allowlist與composition僅H-D在B2 owner receipt後改；純model mapper只讀。不得加public importFromPath。

註冊既有`LegacyImportDescriptor`、sourceKind sensor-lab、schema1→2、mappingVersion1；resolver UUID basename核對再呼叫bytes/expectedId mapper。停止legacy writers、planned journal→target receipt→complete marker→切換，原檔不動。

驗證：records與calibration實際envelope、50×8MiB plus profiles/quota、malformed UTF-8/version/key/float/cardinality/size、symlink、permission≠missing；commit後receipt前kill、marker失敗、source/destination變動、re-entry／downgrade、刪新record後restart不再import；safe mode/disabled不執行mapper。未complete禁止半套history與雙寫。

### D7：真公開transport、lifecycle與packaging接線

依序領取H-R→H-D→H-V→H-K各自paths；F-Lab只修feature。H-D接既有router／persistence participant／core recovery與onEnded，不加第二listener；H-V掛registered Lab；H-K沿用vite.plugin-lab/shared config、builtin launch/manifest/index輸出。

write sets：表§2所列shared paths及其直接tests；新增`tests/desktop/fixtures/sensor-lab-public/`與public transport harness。依path交接，不能一個task默認取得全部hotspots。

驗證必須用實際JS MessagePort shipped process→router→broker fake provider／B2 worker→generic renderer；Python stdio consumer跑同公開UIv2、reservation/storage/export/copy反例，不能只測wrapper。trace記錄method/owner/epoch，不洩資料；fixture證明拒跨owner、stale token與未授權方法。

生命周期矩陣：hide/close/minimize繼續；normal release／Disconnect／suspend／provider loss僅endReservation；renderer loss/window destroyed/disable退休drain後teardown；plugin kill只checkpoint；冷safe mode無process/mapper；明確open建立新bindings、不replay。

故障：final完整sealed payload後disk-full→retryable/TTL不續期；只memory/receiving→checkpoint-only；publish unknown→reconcile不double publish；expiry→checkpoint-only；10秒drain與24/25秒外層、normalclose blocker/force exit證據；末筆lastSequence與重複end不雙final。真正process restart驗證durable head，不用in-memory reset代替。

### D8：native parity後撤legacy（H-V／H-D分批）

前置：D5–D7 native行為差分、資料migration/restart及D9 source-free installed自動proof均有receipt；沒有proof不刪oracle或宣稱退出例外。

H-V write set：`renderer/device/sensor-lab-{panel,controller,chart}`及直接tests、`renderer/app.tsx`相關mount/effects；移植有價值fixtures後才刪。
H-D write set：`main/sensor-lab/{service,store,schema,csv}`及feature IPC/preload/shared DTO／main composition直接tests；逐檔確認無其他consumer再刪，保留所需pure test oracle資料，不保留runtime旁路。

驗證：source import graph＋transitive bundle metadata/內容＋public RPC trace三重audit；feature不可有React/Electron/private DTO/@kobrixa/device/direct fs/network/USB/dynamic facade。全repo只針對Lab symbols搜尋殘留，確認無雙writer。native既有start/stop/calibration/history/compare/export/code/copy/expand/retry/error逐列有新案例。

### D9：installed proof、發布與人工驗收（分兩次）

D9a在D7後、D8前：H-K建立候選artifact，檢查sensor-lab/main.cjs、manifest、UI raw bytes/index/hash與SDK dependency；source-free位置離線、無PATH Node、無checkout/symlink啟動、錄製/stop/save/export/copy、disable/re-enable/quit、無orphan。缺entry/resource/hash損壞必須unavailable，不能fallback。

保存artifact hash、build commit、OS/arch、installed resolved paths、index/hashes、bundle audit與RPC trace，證明測的是產品payload不是fixture或開發fallback。這是3D證據，不借3C artifact替代。

D9b在D8後：重新封裝最終artifact、檢查移除legacy後同一public smoke；H-P序列核對API1.8、schema $id、JS/Python version/manifests一致，只有依賴/契約/自動證據齊全才標發布gate。保留人工未驗事項，不以發布等同Stage3完成。

MANUAL另記：USB/Wi-Fi實體四通道、最大錄製、mode/source變更、motor互斥、program/files gaps、失權、拔線、suspend/wake、CSV與校正；乾淨安裝各OS/arch；en/zh-TW明暗、320px/125%、鍵盤/讀屏/dialog/focus及core recovery。VM與fakeprovider不能代簽，未測平台逐項列待驗。

### D10：文件與交接

未來write set：`docs/{en,zh-TW}/sensor-lab.md`、對應architecture/roadmap、既有umbrella例外帳的Lab列與3D具名acceptance報告（先由controller固定路徑）。

更新背景錄製、single Disconnect、suspend、optional預設開關、保存風險/最後checkpoint、公開資料格式/limits與source-free運行說明。報告逐criterion記implementation、automated、MANUAL、artifact/commit、未決故障；全部必要證據齊全才申請核銷Lab例外。3E接手Stage3 closeout，不關閉stage2人工項。

## 4. 可自動證明與不可代簽界線

| 證據族                   | 自動化必須證明                                                                     | 仍需MANUAL                                  |
| ------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------- |
| UI契約／資源             | unknown version拒絕、每項count/bytes邊界、queue/TTL、v1相容、實際renderer性能      | 實際讀屏/雙語主題可用性、安裝機scale/focus  |
| public-only              | 真MessagePort/stdio、source/bundle/trace三證、missingpayload failclosed            | 乾淨OS/arch安裝體驗                         |
| recording／native parity | legacy差分、generatedprogram VM、實際B2worker/reservation/drain/restart            | 真sensor/motor時序、USB/Wi-Fi與實體停止觀察 |
| 資料                     | CAS/quota/diskfull/unknown、migration receipts/barrier、checkpoint-only與TTL retry | 實機中斷與恢復說明是否清楚、硬體長錄        |

## 5. 完成定義與審查預設

task序列：D0→等待依賴並D1→D2→D3/D4（互斥 paths）→D5/D6→D7→D9a→D8→D9b→D10。失敗回所屬owner修正並重跑相關檢查，不以重複無關全套測試代替定位。

controller需確認技術契約和owner receipts，沒有必須重開的產品決策。預設不自動刪history、不持久draft、超限CSV明確分段、未知資料block保留、只對正式EV3 vocabulary提供原生程式／跨origin比較。未取得3C或MANUAL證據時，交付狀態只能寫「草案／實作待驗收」，不能寫gates closed。
