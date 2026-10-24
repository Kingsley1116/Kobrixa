# Stage 3D：Sensor Lab 與宣告式 UI v2 設計草案

日期：2026-10-24；分支：`feat/plugin-3d`。狀態：供 controller 審查的設計，非契約凍結／交付／驗收證明。

## 1. 基準與關卡

權威為 [Stage 3 umbrella](2026-10-17-plugin-system-stage-3-design.md) §§3–7、S3-08/09/12–15；沿用 [3B1](2026-10-17-plugin-system-3b1-declarative-ui-design.md) UI v1／lifecycle ports 與 [3B2](2026-10-17-plugin-system-3b2-settings-storage-design.md) storage／import／drain。本文不覆寫凍結契約。

目前 3D 僅有 `8c8878b` 的純模型及測試，沒有 shipped Lab、UIv2 或 API 1.8.0 的完成證據。3C public-only／installed proof 正在收尾；依 umbrella §6 可先寫設計、計畫與純資料 fixtures，**3C proof 及 foundation 交接完成前不得凍結／合入 UIv2 或發布 1.8.0**。本草案所有新增名稱皆為提案，須 T0 經 owner 確認、schema／fixtures 一起凍結。

純模型基準以 commit `8c8878b` 及其五組測試為準，不代表 runtime acceptance。實作順序見[計畫](../plans/2026-10-24-plugin-system-3d-sensor-lab.md)。

## 2. 架構與既有成果

`plugins/sensor-lab/src/main.ts` 為新增 TS／Node process entry；只依公開 `@kobrixa/plugin-sdk`／protocol 與 feature-owned modules。`runPlugin` 使用既有 `electronParentPortChannel`，設備走 `ctx.devices`，資料走 `ctx.storage`，畫面只由 registered JSON resources、公開 UI state／commands／events 組成。

host 負責 broker、通用 renderer、persistence、lifecycle 與 core recovery；feature 負責 recorder、校正、history、比較、CSV／程式產生。不得新增 Lab IPC、`SensorLabService` facade、任意 fs／USB／network、HTML／React 注入或自建 storage。純 mapper 由 3B2 host allowlist 編譯使用是既有匯入機制，不是 feature process 的私有服務。

直接重用，不重建以下五個 `plugins/sensor-lab/src/model/` leaves：

| 檔案               | 已有能力與接線責任                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `data.ts`          | `LIMITS`、`Recording`／`CalibrationProfile` schemaVersion 2、`SourceSnapshot`、`RecordingMonotonicOrigin`、public frame mapping、immutable snapshot、`trimPreview`／`compatible`。呼叫端仍須驗 session、capture origin。 |
| `calibration.ts`   | `validateCalibration`、`calibrate`、`calibrationCode`、`generateCalibrationCode`；逐步 float32、乘後除、null／overflow、數字展開與字串 escaping。                                                                        |
| `chart.ts`         | `reduceSeries`／`reduceCharts`、`cursorReading`、`finiteRange`；先切 runs、保留 extrema、明示 omitted runs，不能拿 reduced points 當原始資料。                                                                           |
| `legacy-import.ts` | `importLegacyRecording(bytes, expectedId)`／`importLegacyCalibration`；嚴格 8 MiB bytes／UUID／legacy envelope／version 驗證，產生候選資料。                                                                             |
| `csv.ts`           | `recordingCsv`／`csvCell`；BOM／CRLF、raw 與 calibrated、null 空欄、formula protection、public identity／gap／雙時鐘 provenance。                                                                                        |

現有 `apps/desktop/src/builtin-features/sensor-lab/{data,calibration,chart,csv,legacy-import}.test.ts` 保留；新增 integration adapter，不搬回 desktop-private 型別。測試可讀 legacy oracle，production 不可匯入它。

## 3. 行為遷移與畫面

下表舊 renderer 路徑以 `apps/desktop/src/renderer/device/` 為根，舊 main 路徑為 `apps/desktop/src/main/sensor-lab/`。

| 現有來源／行為                                                       | 新落點與等價要求                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sensor-lab-controller.ts` initialize／observeMonitor／toggleChannel | feature controller 訂閱 public session／telemetry；channel list 最多選 4，保留 detached selection／waiting／空狀態；ready 且 fresh 才可開始。連線入口沿用 host「插件工具」的 device tab 導覽；Lab 提示使用者切換該 tab，不跨 source 呼叫 `openPanel` 或另一插件 controller。 |
| `sensor-lab-panel.tsx` name／start／stop／interval／save/error       | v1 form controls＋v2 data views；名稱上限 100，預設雙語實驗名稱；顯示錄製秒數、樣本數、實際 receipt interval、停錄原因、保存中／已保存／失敗／retry。錯誤 dismiss 不清除 core blocker。                                                                                      |
| raw/calibrated、live preview／history／comparison                    | 切換只改顯示；preview 最近 60 秒／240 frames，history 用完整 raw record；一筆主記錄＋一筆比較，按 source semantics／raw unit，相同 calibrated unit 才疊圖；不相容顯示原因。                                                                                                  |
| `sensor-lab-chart.tsx` 小圖／展開／共同 cursor                       | v2 lineChart＋dialog，最多四圖；共同時間游標、單位／圖例、無讀值、差異線型、完整 extrema；展開引用同 dataset，不複製四圖。提供鍵盤游標及等價 table。                                                                                                                         |
| panel 校正 editor                                                    | 兩點換算、擷取 A/B、目標值、unit、歸零／清零／重設、live result／Apply；錄製中及查看歷史時不可變更。Capture／Zero 在操作時重驗 `ReadSnapshot.status=fresh`、`ageMs≤2500`、session/channel；不得使用停滯舊值。                                                                |
| profiles save／apply／delete                                         | storage 的 `sensor-lab.calibration` records，按相容來源篩選，保留名稱／確認刪除／錯誤；Apply 只改未開始實驗，歷史校正 snapshot 永不改寫。                                                                                                                                    |
| history refresh／view／compare／delete                               | `sensor-lab.recording` 分頁 metadata；table/list 選擇、清除比較、回 live preview；刪除有 dialog、CAS，active／unsaved target 不可刪除；成功才移除選取。50 筆滿額拒絕新錄製，不自動淘汰。                                                                                     |
| BASIC Plus preview／copy                                             | v2 plain-text code；公開使用者 action 後 `ctx.actions.copyText`；成功才顯示 copied，失敗保留可選取文字／手動複製說明。無執行／編譯私有入口。                                                                                                                                 |
| main `service.ts` start／observe／checkpoint／stop／retrySave        | 新 recorder adapter 以 reserve/read/release＋checkpoint/drain 操作；背景錄製不綁 panel；不保留 main feature recorder singleton。                                                                                                                                             |
| main `store.ts` list/read/save/delete／profiles／flush／recover      | B2 chunks／CAS／receipt／list/read／delete／flush；正常 final 與 interrupted 顯示分開，舊檔經 frozen import mechanism 遷移。                                                                                                                                                 |
| `service.ts` exportCSVContent／controller exportRecording            | 由 raw frames 產生 CSV，再 public export；禁止匯出 chart reduction 或由 plugin 開 save dialog。                                                                                                                                                                              |
| app status／close／update／suspend                                   | v2 status「開啟／停止」＋獨立 core recovery；所有 close/update/disconnect 走既有 host coordinator，不以 feature 回覆當成已保存。                                                                                                                                             |

session改變清除live選取/preview，通道選取改變重設preview時間域；同session來源暫不可用仍顯示detached。校正是工具與產生程式的數值轉換，不改 sensor firmware；錄製開始凍結 raw source、校正與名稱。雙語提示仍說明 sampler 每次完成後等 500 ms，非保證固定 2 Hz。背景停止入口不得受一般 form busy 狀態永久封鎖。

## 4. 現行 API 對照與缺口

| 現有精確 API／型別（來源）                                                                              | 用法／限制                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DevicesClient`：`list`、`session`、`read`、`subscribe`、`inputModes.query/set`（SDK `src/devices.ts`） | 查 capability／來源、preview；Lab 校正不呼叫 set。缺 provider／capability 顯式 unavailable，不自動啟用／連線。                                                                                                   |
| `recording.reserve({sessionId,channelIds,expectedSourceRevision})` → `{reservation,firstFrame}`         | 原子 pin mode、排除 motion；以 `firstFrame.elapsedMs` 作 recording origin，保留 `sampledAt`。不可把 process performance.now 或 wall clock 相減當 session clock。                                                 |
| `recording.query/read({reservationId,afterSequence,limit})/release`                                     | read ≤64 frames，保存 `gap/nextSequence/hasMore`；序列去重、sourceRevision 核對，bounded catch-up。release 後由 host drain，不自行啟第二套 finalizer。                                                           |
| `ctx.ui.instances/state/patch/subscribe/snapshot/unsubscribe`                                           | v1 只有 scalar slots、64 KiB state/patch；缺 chart arrays／分頁 rows／dialog／code 與其 revision 契約。不可 JSON stringify 塞進 string。                                                                         |
| `ctx.commands.registerContext`、`PluginDefinition.ready/drain`                                          | ready 建 bindings／snapshot，context command 處理 validated arguments；`drain({request,signal,storage})` 專用路徑，非一般 stop command 的 abort signal。                                                         |
| `ctx.storage.beginWrite/writeChunk/sealWrite/commitWrite/writeStatus/abortWrite`                        | serialized payload 先算 bytes/hash；順序 chunks，seal 後 commit receipt 才成功，unknown 查 writeStatus 對帳，不盲目重建。                                                                                        |
| `stat/list/openRead/readChunk/closeRead/delete/flush/quota`                                             | host ID／revision 是儲存鍵；opaque payload 的 model `id` 是實驗／profile UUID，保留舊 ID，不把二者混用。以 host metadata kind 過濾、ID 做動作，payload ID 驗重複。                                               |
| `registerCheckpoint({id,expectedRevision,reservation})`、`abandonCheckpoint`                            | 已 commit 初始 record 後才登記；ack 前不可聲稱背景錄製就緒。abandon 明確接受 checkpoint-only，不能當 final。                                                                                                     |
| `ctx.actions.exportBegin/exportChunk/exportCommit/exportStatus/exportCancel`、`copyText`                | `ctx.actions.actionRef` 只在真實 command user action；`UserPersistenceActionPort.claim` 5 秒一次性 purpose binding。copy ≤64 KiB／16,384 code points；export ≤8 MiB。                                            |
| `StatusResourceV1`、`UiAction`（protocol `ui-resource.ts`）                                             | status v1 沒有 actions；core `stop` 接 motion operation，不能拿 reservation 填入。v2 必須新增 status actions 及具型別的 reservation stop。                                                                       |
| `ChannelDefinition`（protocol `device-types.ts`）                                                       | opaque typeId/modeId、output-angle 與 legacy numeric source 不同；目前 `generateCalibrationCode(public)` 明確 unavailable，跨 origin 比較也不自動相等。需下述公開 EV3 identity vocabulary 才能達 native parity。 |

不新增 storage／import RPC。B2 `RecordMeta.interrupted` 是 host recovery evidence，不會改 opaque payload；讀取 adapter 在顯示／匯出投影 last committed record 為 interrupted，保留原 bytes，時間採最後 frame receipt 或 start。模型 `StopReason` 不含 overflow／retired／renderer-lost：runtime 另外保留完整 public end evidence；payload reason 保守映射 interrupted，limit→limit、released 依下述原始停止原因映射、suspended→suspend、core-disconnect/disconnected→disconnected、source-changed 原樣、shutdown/update→close/update；不可把 overflow 寫成正常完成。

### 4.1 公開 EV3 identity 映射提案（T0 由 3A/H-P 確認）

現有 `main/device-providers/ev3/catalog.ts` 實際產出 provider `kobrixa.device-ev3`、`input:0..3`／`output:A..D`、`ev3:<numeric type>`、`mode:0..7`，output-angle 的 modeId=null、component=0、unit=deg。這是目前實作，尚不可單靠讀私有 catalog 當公開契約。

在 1.8 文件／conformance 批次正式固定此 provider 的 bounded vocabulary（不更動 frozen 1.5 wire shape），由 feature 新增純 `ev3-source.ts` adapter，完整驗 provider、kind、port、numeric range、mode/component/unit 後才轉換供既有 `calibrationCode`；其餘包括 battery 維持明確 unsupported。input type=1..124、port=0..3、mode/component=0..7；output只接受type7/8、A..D映0..3、null mode映legacy0且component0。未知值不得parseInt後猜測，完全比對格式再轉換。

同一 adapter 產生比較／profile compatibility key，對已驗 EV3 public 與 legacy 使用 kind、port、type、mode、component、raw unit；不以名稱或 UUID 相等判斷。不改寫原 public snapshot 或偽造 channelId。若 3A 不接受 vocabulary 公開化，須回 T0 設計具版本的 semantic descriptor；不得將 live EV3 永久 code-unavailable 當 parity 完成。這是契約 owner 審查事項，不是要求使用者重選功能。

## 5. UIv2 候選契約與有界性

新增 `PanelResourceV2`／`StatusResourceV2` 與獨立 validators；manifest Lab API `^1.8.0`、resource version 2。v1 validators、`UI_LIMITS_V1`、既有 wire 行為保持不變；未知 version→`PLUGIN_E_UI_VERSION`，未知 component／非法 references→`PLUGIN_E_UI_RESOURCE`，整筆拒絕，不略過 Stop。

新增元件只用既有 Text／LocalId／command 白名單：`lineChart`、`table`、`list`、`dialog`、`code`；不接受 HTML、CSS、URL、script、formatter callback 或任意模板。靜態 schema 宣告 dataset ID／型別、columns／series／labels／actions，動態資料仍由 registered binding 到 host 驗證。

| v2 提案        | 資料／動作語意與限額                                                                                                                                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| lineChart      | 時間／值／run break、series ID、unit、完整資料 range/extrema、reduction metadata；4 charts×2 series×800 points＝6,400。cursor group 最多 1/panel，輸入時間經 command 回 feature，從 raw data 用 `cursorReading` 求值；不把 reduced 最近點冒充原值。                  |
| table／list    | 一個可見資料頁各最多 50 rows/items；table ≤8 columns，list ≤3 actions/item；row key 穩定且唯一，cell 只 scalar/plain text、≤200 code points。payload byte cap 優先，較小頁也要有 next/previous。選取傳 row ID＋dataset revision，禁止攜帶整筆資料。                  |
| dialog         | 每 panel 最多 1 個 open，禁止巢狀；resource 內靜態宣告內容／confirm/cancel，引用既有 chart dataset；刪除確認含 host record ID/revision，stale confirm 拒絕。Escape 關閉、focus trap／還原，關閉放大圖不停止錄製。                                                    |
| code           | 唯讀 plain text，≤16,384 code points 且≤64 KiB，固定可選取字型；有 label／copy command，無執行／語法 script；code payload 分塊走 v2 dataset，不放寬 v1 4,000 字元 Text。                                                                                             |
| status actions | 最多 2 個：`openPanel` 與新增 v2 `stopRecording`，後者綁同 owner reservation reference，由通用 host action 驗 epoch／owner 後 release，接既有 endReservation/drain；失權仍可停止。status instance 也提供可信 command context，但不以 motion scope 冒用 reservation。 |

### 5.1 資料傳送（待 T0 固定正式名稱）

提案新增 `ui/dataBegin`、`ui/dataChunk`、`ui/dataCommit`、`ui/dataAbort`、`ui/dataRead`，SDK 為 `ctx.ui.data.*`；是 registered UI 資料平面，非 filesystem／storage bus。所有 request 必含已驗 binding（owner、execution/resource generation、instance）與宣告 dataset ID；begin 含 baseRevision、目標 revision、型別、bytes／hash。每次完整替換單一 dataset，chart 可用有界 append/drop-prefix delta，但結果須通過完整限額及 run continuity 驗證。

chunk 含 host transfer handle／offset／bounded typed entries，單 request 含 envelope ≤64 KiB；commit 原子發布 revision／小型 invalidation event，失敗維持舊 snapshot。`dataRead` 依 revision／cursor 分頁 ≤64 KiB；沒有跨資料集 transaction 保證，feature 用 presentation revision 關聯 charts、cursor/table，未齊時顯示 updating，禁止混搭值。offset／hash／duplicate key／NaN／Infinity／stale revision／跨 owner 一律拒絕。

每 panel 同時最多 8 datasets（4 charts、table、history list、profiles list、code），committed 合計≤512 KiB，source≤2 MiB，host≤8 MiB；每 panel 僅 1 個 receiving transfer、≤512 KiB，source≤512 KiB、host≤2 MiB，idle 5 秒／total 10 秒。所有數量與序列化 bytes 雙重限制；最大 point count 不代表任意長數字／文字都可塞滿 byte cap。超限必須回錯，不能默默裁掉 extrema／row。

UI resource 仍每份256 KiB／256 nodes／depth8，source1 MiB／host8 MiB；一般 scalar state／patch 維持64 KiB、10 Hz、4 pending。dataset commits 同享每 panel10 Hz／4待送 admission，event仍64 KiB／256 KiB queue、32 subscriptions/source；不把整個 dataset塞 event。frame仍1 MiB。傳輸暫存計量與committed分開，沒有隱藏倍增 cache。

Lab 以約2 Hz更新 live charts，cursor至多10 Hz且合併到最後位置；terminal／Stop 走獨立control slots，不等待 dataset queue。gap／drop觸發新 revision snapshot；hide後停止preview與chart更新、丟棄 view transfers，錄製與status保留；重開由raw model重建有界快照。任何 dataset transfer 不能啟動未註冊面板或復活舊binding。

### 5.2 數值與呈現

每條線先依null、非ok、segment、explicit gap、倒退時間、>2秒斷點切run，再減點；保留全資料extrema/range，超多孤立runs明示omitted count且不跨缺口連線。table/cursor/CSV皆用raw；comparison時間域涵蓋兩份記錄，最多兩條series。

`en`／`zh-TW`完整文字、明暗主題用host tokens；320px sidebar／125% scale可操作、表格必要時水平捲動且有標題；圖表用線型和文字區分，不只顏色。鍵盤可選通道、調cursor、開關dialog、確認刪除及copy，status/錯誤用適當live region，telemetry不每frame朗讀；focus不因patch重建。native對照包含校正form draft／validation，不把feature的Apply誤改成settings Apply（contributed settings仍逐欄立即CAS）。

## 6. Recorder／persistence 時序

1. 明確Start：確認沒有active／未解決unsaved recording、history<50、quota可用、fresh session／sourceRevision、1..4合法通道與校正。`reserve`成功後以firstFrame建立immutable來源、calibration、recording origin；firstSequence只收一次。
2. 建立初始schemaVersion2 record，B2 create的host ID與payload UUID分離保存；commit receipt→`registerCheckpoint`綁reservation→ack後才顯示recording。任一步失敗release並保留已commit記錄／error，處理register期間end race，不留無checkpoint背景工作。
3. 單一feature消費迴圈用reservation read／事件喚醒，非第二個硬體sampler；每批≤64，去重至nextSequence，bounded raw≤3600／30分鐘先到者停止；另設單調30分鐘deadline，即使一直沒有新frame也會release，不能只靠frame觸發限時。origin固定firstFrame.elapsedMs，frame保留sessionElapsedMs並計算差值；late start跨session30分鐘仍正確。program/busy/read-error為gap，確認source變更才停，不把partial/error當拔除。feature 在因時間／筆數限制呼叫 release 之前，先為該原始 reservation 固定 `limit` 停止原因與單調時間，drain 仍讀取同一份停止原因。若 host 終態為 `released` 且此原始原因在 end 之前已記錄，payload reason 為 `limit`；沒有該原因時 `released` 為 `manual`。host 的 source-changed／disconnected／suspended／overflow 等非 released 終態優先，保留完整 host evidence；不能用後來的 timer 覆寫已完成原因。程序遺失後只依 durable checkpoint 與 host interrupted 證據，不猜測未保存原因。
4. 每5秒最多一筆checkpoint write，以上次confirmed revision CAS；不重疊排隊完整record。save error／timeout停取樣並release，交drain；非健康I/O不承諾最多丟5秒。history／calibrations同namespace：record≤8 MiB、256筆／512 MiB、host1 GiB、2 staging slots／chunk decoded≤256 KiB，50×8MiB＋16MiB staging＝416MiB，另檢查profiles／metadata／atomic replacement空間。
5. Stop只發release。唯一host `ReservationBindingPort.onEnded`→`PersistenceParticipant.endReservation(event,deadline)`→`drain(offer,dispatch)`；drain callback依grant可讀到固定lastSequence，先對帳in-flight checkpoint，再以request token、最新revision final replacement／flush。SDK callback回submitted只代表提交，不代表saved。
6. 健康owner手動Stop／Disconnect／suspend／provider loss後仍存續；終態／gap／末筆只處理一次。新recording需新明確Start，reconnect／wake／re-enable不續錄。

| 事件                                                                             | 結果                                                                                                                     |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| panel hide/close、window blur/hide/minimize                                      | 撤view subscriptions／preview，background reservation/checkpoint繼續，status可Open/Stop。                                |
| source change／limit／overflow／provider loss／OS suspend                        | endReservation；保存reason/evidence、停止來源，健康process不retire；wake不延長舊deadline。                               |
| feature disable/remove/reload、renderer crash、window destroyed、shutdown/update | host freeze／device retirement grant→bounded drain→process teardown；next explicit open/command才新generation/bindings。 |
| plugin crash／force exit                                                         | host ownerLost／回收reservation；僅保證最後committed checkpoint，顯示interrupted；不呼叫失聯handler。                    |
| safe mode                                                                        | optional contributions/process/mapper不啟動；core recovery保留資料與故障，不為恢復畫面偷偷連線。                         |

storage drain共10秒；device stop15秒＋journal5秒並行，manager4秒，外層25秒；不是期限到自動force exit。close/update save error仍block。core Disconnect先quiesce、stop/readback＋end/save，成功後disconnect；plugin `devices.disconnect`沒有跨owner協調權。

B2 `DrainReport`四態直接呈現：saved需final receipt及flush；retryable僅host持sealed完整payload，TTL=min(lastProgress+30s,created+120s)，core可retry/export/discard且不續租；checkpoint-only沒有可救尾端，memory／receiving不能冒充retry；uncertain先reconcile，禁止第二次publish。retention到期及host restart只保留committed證據，core retry不啟動被停用Lab。普通healthy保存重試與retired fenced target區分，後者只能core recovery action，不由Lab普通CAS繞過。

## 7. 匯入、匯出與重啟

新增host adapter `main/plugins/persistence/sensor-lab-import.ts`，實作既有 `LegacyImportDescriptor`，使用`import-sources.ts`／`import-coordinator.ts`／`LegacyWriterBarrier`；純mapping呼叫現有model，不發新RPC。sourceKind=`sensor-lab`、targetSourceKey=`builtin:kobrixa.sensor-lab`、mappingVersion=1、來源format1、target record schema2；分辨recordings與calibrations envelope，host resolver核對UUID basename與payload ID後傳expectedId，不接受plugin提供path。

現行descriptor `validate/map`只接bytes/sha256，沒有basename參數：身份核對必須在既有resolver的item key邊界完成，再交pure mapper；若現有adapter缺此核對，由B2 owner在host-only seam補上，不擴公開API、不以payload自稱ID代替檔名證據。

固定root下regular JSON、拒symlink/reparse、8MiB前置byte檢查；逐筆處理、保留originals/digest。先停所有legacy writers／取得import barrier；planned journal先落盤、host分配target IDs、target CAS含import receipt，commit→receipt→complete marker後才切新history讀取。crash於commit/receipt間依tag對帳，重跑不重複；刪除已匯入record後不復活舊檔。未完成／corrupt／quota／permission／source-changed均blocked，不以defaults或空資料報成功、不雙寫或回退legacy。舊loader會將壞檔移入corrupt，新匯入遵B2保留originals並顯示issues；既有corrupt目錄保留且不擅自回填。較新schema拒絕並保留資料。B2 inventory4096／journal512項2MiB、批64仍生效；50筆最大record需實際遷移證據。

CSV先算完整內容bytes/hash；>8MiB明確不可匯出整份，預設提供使用者選時間區間分段CSV，每段保留完整欄位／raw rows、標註區間且各次新action，不截斷／改host限額。host dialog取消不算成功、不占device lock；等待≤120秒，選定後staging30/120秒。code先備妥再讓使用者copy，actionRef過期請重新點擊，timer／ready／replay不能mint。公開copy失敗保留文字，不直接用navigator.clipboard旁路。

## 8. Installed payload、ownership 與退出

manifest：`kobrixa.sensor-lab`、runtime `{kind:"node",entry:"main.cjs"}`，最小permissions為devices.read、ui.panels/status/clipboard、storage.read/write/export；不申請devices.control、任意設定或network。view drafts暫存，profiles/records走storage；如需新增持久UI偏好另經settings schema審查，不以telemetry寫settings。

沿用`apps/desktop/vite.plugin-lab.config.ts`→`vite.plugin.config.ts`；新增`plugins/sensor-lab/kobrixa-plugin.json`、`ui/panel.json`、`ui/status.json`。installed leaf `sensor-lab/`含main.cjs、manifest、原bytes resources及`resource-index.json`，SDK打入bundle；index≤32files／16KiB、bundle≤16MiB，hash/path containment均驗。missing/hash mismatch顯式unavailable，無source tree／cwd／workspace symlink／外部Node fallback。

host allowlist設定optional、預設enabled、一般使用者可持久開關；safe mode抑制，不影響必要compiler。optional-only crash不新增safe-mode lock，仍保留core fault/checkpoint與既有supervisor crash-loop政策。

唯一hotspot writer依序交接：H-P protocol/schema/JS/Python；H-R manager/registry/supervisor與runtime ports；H-V renderer generic host及app.tsx；H-D main/index.ts、ipc.ts及lifecycle/persistence composition；H-K builtin/launchers、Vite/Forge及installed resources。每次記錄前owner stopped、精確paths、baseline SHA、receipt；本文件不宣稱取得任何鎖。

legacy `sensor-lab-panel/controller/chart`、`main/sensor-lab/service/store`及feature IPC/preload/shared DTO只在public transport、資料遷移／重啟、native parity與installed proof具體通過後由H-V/H-D撤除。先保留為oracle、執行時一次只有一個writer；不能長留雙錄製路徑。必要MANUAL未完成仍列待驗收，不核銷umbrella例外帳／Stage3 gate。

## 9. 驗收證據與預設決策

自動化：既有pure tests＋native baseline差分（float32、compiler/VM輸出、chart/cursor/null/segment、profile/CSV）；UIv1不變／v2未知版本、bytes/count/depth/queue/data transfer越界、cross-owner/stale epoch；真MessagePort JS與stdio Python經公開router，不只SDK mock；reservation／checkpoint/end race、drain兩類失敗、disk-full/unknown/CAS/forced restart、50筆migration及source-free installed provenance。

最大合法4×2×800圖、50rows、背景3600frames與輸入同時負載：沿用B1 renderer apply p95≤16ms/max≤50ms、key-to-paint p95≤100ms；另要求Stop dispatch p95≤100ms（非實體stop）、cursor結果p95≤100ms。60秒steady load後cache/queue不超上述cap；記錄平台、artifact、raw測量、heap/RSS，不能只測平均或提高quota。T0以最大合法fixture核對預算，變動共同限額須同步umbrella，未取得數據不宣稱性能通過。

MANUAL：USB/Wi-Fi真EV3四通道、mode/source變化、program/files foreground gaps、motor互斥、失權/拔線/休眠、校正/最大錄製/CSV；乾淨無checkout/Node安裝機逐OS/arch；en/zh-TW、明暗、320px/125%、鍵盤/讀屏/focus/dialog。mock／VM不證明硬體時序，package自動化不代簽所有安裝平台。

採直接預設：保留50筆不自動刪、draft不持久、unsupported非EV3程式明示不可用、CSV超限明確分段、未知資料保留並block。沒有不可避免的產品決策待使用者選擇；UIv2命名／限額、EV3 vocabulary與owner receipts留controller技術審查，未審查不視為凍結。
