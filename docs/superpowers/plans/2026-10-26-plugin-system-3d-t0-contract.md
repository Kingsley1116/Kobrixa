# 3D D1/T0：Sensor Lab 最小 UI v2 候選契約

日期：2026-10-26。狀態：**local technical freeze draft，待 owner review；不是 formal D1 close、API 發布或實作 receipt。**

本文件固定可供 D2–D7 評估的單一候選設計；所有新增型別／方法都是 proposed，現有 host 不支援。只修改 D 文件，不取得 protocol、runtime、renderer、B2 worker 或 packaging write ownership。

## 1. 精確基準與證據界線

工作樹 `plugin-3d/Kobrixa` 的乾淨起點為 `e66f1f1`（merge integration `31a581054ea0159192e0b1699ed9321ea316127b`）。不追蹤同時進行的 B2 sealed-TTL writer；本契約不裁定其 retention 修補。

| 已讀基準／保留證據 | 可支持的結論 | 不能推出的結論 |
| --- | --- | --- |
| 模型 `8c8878b`、差分 `1612829`、雙語 compiler/VM `7788a44`；[D0 receipt](../evidence/2026-10-24-3d-model-parity.md) | 六組 97 tests 的歷史 scoped receipt；原生 schema/CSV/chart/cursor 與 calibration code oracle | Lab process、live public EV3 mapping、UIv2、migration 或 installed 已完成 |
| 3C producer `4c86f0a531f5cb60f7f7249b1ae8008bd43938a8`；保留 commit `66773e5`；[native/installed receipt](../evidence/2026-10-24-3c-native-installed/README.md) | 真 public product transport 77 reports；macOS installed 4/4 | 此 macOS run 的 source denial（明列 unrun）、實體 EV3、所有平台 |
| 3C producer `dbccbc2f4be23676e6ba49ca07a33e6be87718d5`；保留 commit `16da3e7`；[Linux isolation receipt](../evidence/2026-10-24-3c-linux-installed/README.md) | Linux arm64 原 product 4/4、Landlock/source denial，限定該 artifact/environment | macOS source denial、人工 GUI、Lab installed、legacy aggregate exit |
| B2 producer `89a1bbc`，oracle `9189992`；[standalone evidence](../evidence/2026-10-26-3b2-action-replay/README.md) | 已保留 action replay／recovery 組成的具名證據 | 所有 B2 producer/import/interop/load/installed gate |
| integration producer `045df65c5d295c8526bb72f7fb8a94db072abbd9`；receipt `31a5810`；[integration evidence](../evidence/2026-10-26-stage3-action-integration/README.md) | 真 action replay、278 focused tests/typecheck/static-language native 的歷史 receipt | 最新 D 的 full suite、D1 owner 確認、P160/P170/X-T1 或 Stage 3 close |

3C「尚無 actual public/installed proof」已過時；有上述具名證據。**aggregate P160/P170/X-T1 仍 open**，按[local integration ruling](2026-10-23-stage-3-local-integration-handoff.md)只能做未發布的 local assembly/design。formal D1 仍需 H-P/H-R/H-V/H-D/H-K 明確接受此契約、foundation handoff／gate disposition、共同 fixtures。此文件沒有代簽 owner、MANUAL 或出版 gate。

## 2. 直接消費的 merged types

所有路徑相對 repository，內容固定於上述 D merge：

- `packages/plugin-protocol/src/ui-{resource,types,methods,limits,validation}.ts`：resource version 在 manifest 的 `resource.version`，**不在 JSON body 加 version**。`PanelResourceV1` 是 data/fields/root/nodes；`StatusResourceV1` 沒有 actions。`UiBinding` 的七欄是 contributionId/panelInstance/kind/uiResourceGeneration/generation/hostEpoch/processEpoch，沒有 caller 可填的 owner。
- `packages/plugin-sdk-js/src/ui.ts`、`sdks/python/kobrixa/_ui.py`：ready 後 query；JS signal/5s timeout、Python async dict/result 慣例。現有 UI Result 是 V160 的 detail/code union，不能把新 detail 偷塞進舊 parser。
- `packages/plugin-runtime/src/ui-catalog.ts`：目前只接受 version 1；`apps/desktop/src/main/plugins/controller.ts` 的 core action resolver 只查 panel action，`stop` 送 `devices/motion/stop`。
- `packages/plugin-protocol/src/device-{types,methods}.ts`：reservation query/read/release、`ReservationSnapshot.reason`；`apps/desktop/src/main/device-broker/broker.ts` release 先以 plugin owner query，再 end，沒有新 movement authority admission。
- `plugins/sensor-lab/src/model/{data,chart,calibration,legacy-import,csv}.ts`、`apps/desktop/src/builtin-features/sensor-lab/{parity-fixtures,parity.test,calibration.test}.ts`：重用 pure model，不以新 serializer 或 renderer 取代 legacy oracle。
- `apps/desktop/src/main/plugins/persistence/{import-sources,import-coordinator,worker}.ts`：descriptor bytes/hash 不含 basename；WorkerSources inventory 目前讀 `formatVersion`。真正 `main/sensor-lab/store.ts` recording 與 profile envelope 用 `schemaVersion:1`。兩個不相容點均須 host-only 修補，見 §8。

D2 候選新增檔案固定為 `ui-v2-resource.ts`、`ui-v2-data.ts`、`ui-v2-methods.ts`（protocol），runtime `ui-data.ts`；既有 exports/validation/schema/雙 SDK 由單一 H-P 序列修改。沒有新增 storage/import public RPC。

## 3. 最小 v2 resource union

沿用 `LocalId`、`Text`、`DataSlot`、`Field`、`Condition`、`UiNodeBase` 及 v1 limits。所有 object strict、未知 key/variant 拒絕，引用須靜態解析、無循環；文字純文字，無 HTML/CSS/URL/template/formatter。

```ts
// 以下是候選型別，不是現有 export。
type DataRef = { scope: "data"; key: LocalId };
type Command = { command: Id; arguments: ArgumentBindings }; // static scalar refs
// event 的欄位名由 host 加入 arguments；不得與 static arguments 同名。
type RowCommand = Command & { rowKeyArg: LocalId; rowVersionArg: LocalId;
  datasetRevisionArg: LocalId };
type CursorCommand = Command & { timeArg: LocalId; presentationArg: LocalId;
  readings: { dataset: LocalId; series: LocalId; rawKey: LocalId; valueKey: LocalId }[] };
type DatasetDeclaration =
  | { kind: "chart"; series: { id: LocalId; label: Text }[] }
  | { kind: "table"; columns: { id: LocalId; label: Text;
      value: "string" | "number" | "boolean" }[] }
  | { kind: "list"; columns: { id: LocalId; label: Text;
      value: "string" | "number" | "boolean" }[] }
  | { kind: "code" };
type ActionV2 = UiAction
  | { kind: "core"; action: "stopRecording"; reservation: DataRef }
  | { kind: "view"; action: "openDialog" | "closeDialog"; dialogId: LocalId };
type NewNode =
  | { type: "lineChart"; label: Text; dataset: LocalId;
      cursorGroup: LocalId; onCursor: CursorCommand }
  | { type: "table"; label: Text; dataset: LocalId; onSelect?: RowCommand }
  | { type: "list"; label: Text; dataset: LocalId;
      actions: { id: LocalId; label: Text; action:
        | { kind: "command"; command: RowCommand }
        | { kind: "view"; action: "openDialog"; dialogId: LocalId } }[] }
  | { type: "code"; label: Text; dataset: LocalId; copy: Command }
  | { type: "dialog"; label: Text; children: LocalId[];
      confirm?: { label: Text; command: RowCommand; dataset: LocalId } };
type UiNodeV2 = Exclude<UiNodeV1, UiNodeBase & { type: "action" }>
  | (UiNodeBase & { type: "action"; label: Text; action: ActionV2;
      variant: "normal" | "primary" | "danger" })
  | (UiNodeBase & NewNode);
type PanelResourceV2 = Omit<PanelResourceV1, "nodes"> & {
  nodes: UiNodeV2[]; datasets: Record<LocalId, DatasetDeclaration>;
  presentationKey: LocalId;
};
type StatusResourceV2 = StatusResourceV1 & {
  actions: { id: LocalId; label: Text; action:
    | { kind: "core"; action: "openPanel"; panelId: Id }
    | { kind: "core"; action: "stopRecording"; reservation: DataRef }
  }[];
};
```

`UiNodeV1` 本身是交叉 union；實作時可用 distributive Extract/Exclude helper 或明列 union，fixture 必須證明舊 action 被替換，不能讓兩個 action schema 互相吞掉。v1 resource/parser 不改。

- 每 panel ≤8 datasets；chart declarations ≤4、每個 1–2 series；table ≤8 columns；list ≤3 columns／3 actions；code ≤1。每 table/list 當前頁 ≤50 unique keys，cell null 或該 column 型別，string ≤200 Unicode scalar values。以 v1 action＋scalar page token 做 previous/next，沒有隱含 host 全量 history cache。
- 一個 cursorGroup/panel，最多一個 open dialog、不巢狀。dialog 的 children 是獨立可達子樹，不屬初始 root traversal；全 resource node count/depth 仍計入。放大 chart 引用同 dataset，不重複計 4 個 dataset／6,400 points；每 node 的 ID 唯一。
- `presentationKey` 必須是 nonnullable safe-integer number data slot，initial 0，min 0/max MAX_SAFE_INTEGER。0 為尚未發布；feature 完成一組 dataset commits 後以既有 `ui.patch` CAS 更新它。renderer 只讓 dataset.presentation 與 state 該值相同的內容互相比較；其餘顯示 updating/disabled，不混舊 cursor/table。沒有跨 dataset transaction，也不保留第二套完整可顯示 snapshots。
- row action 的 host event 是 `{dataset, revision, key}`；host 重新查當前頁，加入 key、row.version（可 null）、dataset revision 三個 scalar args。list 的 openDialog action 開啟時捕捉同 tuple；一般 openDialog（例如放大圖）沒有 row tuple，不能開帶 confirm 的 dialog。confirm 重驗仍存在且 revision/version 相同；變更即 stale，不重新選另一筆。chart event 是 `{dataset, revision, time}`，host 驗 finite time 落在資料時間域，加入 time 與 presentation。仍用 `context-v1` panel invocation，禁止 renderer 注入任意 arguments/owner/actionRef。row參數的command宣告須相容string/string|null/safe integer，cursor為finite number/safe integer；不相容在resource admission拒絕。
- cursor 由 raw `cursorReading` 得值，不能用 reduced point。`CursorCommand.readings` 最多8項，必須精確涵蓋該group的dataset/series，每組rawKey/valueKey為不同LocalId；共用group的onCursor宣告必須相同。command result.output 這16個以内欄位只接受finite number/null；host查型別，renderer以invocationId＋binding＋presentation＋query time取最新回覆，舊結果丟棄。讀值在chart旁以有label的唯讀raw/value表呈現，不把command output升格成任意renderer state。每group一個in-flight、合併最後位置、最多10次/s，無actionRef/motionScopeRef、無dataset或patch流量；仍受existing invocation bounds，Stop走control。如此4chart×2Hz commits＋2Hz presentation patch=10/s，不把10Hz cursor另塞進已滿的patch budget；history/page更新時降低live commit頻率而不提高上限。chart run boundaries、完整 extrema、omitted counts 明示。code copy command 經真 user action 取得既有 actionRef，文字先備妥；不能從 dataset commit 自動 copy。
- **最小 status 不提供 plugin command actions**：只 Open/Stop，因現有 command context.origin 是 panel/management。status 的可信 context 是 host resolved binding＋owner＋window scope，直接 core action，不偽造 panel invocation、不新增 origin/status 或 commandEnvelope v2。未來要 status plugin command 須另案；不阻擋 Lab parity。

版本：候選 API 1.8 negotiation 的 UI intersection 允許 `[1,2]`（排序唯一），commandEnvelope 仍 `[1]`。1.6/1.7 session 仍僅 `[1]`；version 2 未共同協商時 unavailable，無降級。catalog version/read DTO、雙 SDK validation 必須一併擴展，不能只把 resource parser 改成接受 2。

## 4. Typed datasets：完整 snapshot、序列化與 bounds

選擇 full replacement，**不提供 append/drop-prefix delta**；live 約 2 Hz 足夠，省去 run continuity/delta replay 的第二種契約。資料不經 scalar string tunnel、filesystem 或任意 JSON。

```ts
type Point = [series: number, run: number, time: number, value: number];
type Series = { id: LocalId; unit: string; range: [number, number];
  extrema: [[number, number], [number, number]] | null;
  fullPointCount: number; omittedPoints: number; omittedRuns: number };
type Row = { key: string; version: string | null; cells: Scalar[] };
type Header = { kind: "chart"; series: Series[] }
  | { kind: "table" } | { kind: "list" } | { kind: "code" };
type Chunk = { kind: "chart"; entries: Point[] }
  | { kind: "table"; entries: Row[] }
  | { kind: "list"; entries: Row[] }
  | { kind: "code"; entries: string[] };
```

header/entries 是按 kind 配對的 discriminated union，不能獨立任選。chart series IDs/order 必須等於宣告，unit ≤32 code points；range finite 且 low≤high；extrema 是 full raw 最小/最大之 time/value（空 series 為 null），須在 range 內。time ≥0 finite、series index 在宣告內；run 為 nonnegative safe integer，依 series/run/time 排序，同 run time 非遞減；run change 絕不連線。每 series ≤800 points，panel 合計 ≤6,400；fullPointCount ≤3,600，omittedPoints = fullPointCount − transmitted count，omittedRuns ≤3,600。這些 metadata 必須來自 pure reducer，不可藉省略數量宣稱所有 raw points 都畫出。

row.key 是非空 ≤128 code points 字串，不解釋為 path；version null 或非空 ≤128；key unique，cells 長度精確等於宣告。history/profile row.key 用 host record ID，version 用 host revision；cursor table 可用穩定通道 key/null。code 每 entry 是 ≤1,024 code points 非空片段，合併後 ≤16,384 code points 且原文字 UTF-8 ≤65,536 bytes；沒有分割 surrogate。空 code 用零 entries。所有新文字拒 unpaired surrogate/NUL，拒危險 object keys；所有 numbers finite，counter 為 safe integer。

**唯一 digest/byte 定義**：dataset bytes 為 UTF-8 的 compact JSON `[header,entries]`，無 BOM/空白/newline。物件鍵順序固定為上述型別書寫順序，points 是 tuple、rows 是 key/version/cells；字串照 ECMAScript JSON.stringify escaping（Unicode 原字元、不做 normalization；control/quote/backslash escape），number 用 ECMAScript shortest round-trip JSON number，-0 正規化成 0。SDK helper 正規化重建物件後算 bytes/SHA-256；host 依 typed 值重建相同 bytes。Python **不能直接用預設 json.dumps**（空白、ensure_ascii、1.0/exponent 不同），D2 需同一數值規則與跨語言 byte vectors。最大 long-double、subnormal、-0、臺/emoji、引號/控制字元各有 golden hash；未完成不能稱雙 SDK conformance。

| 計量 | 候選 hard cap／規則 |
| --- | --- |
| dataset / panel committed | 各 ≤524,288 canonical bytes；panel 8 個合計同 cap |
| source / host committed | ≤2,097,152 / 8,388,608 bytes |
| receiving | 每 panel 1；每 source 合計 ≤524,288；host ≤2,097,152；begin 先 reserve 宣告 bytes |
| header / entry | canonical header ≤16,384 bytes；單 entry ≤8,192 bytes（code entry 另有 1,024 cp） |
| chunk / read page | ≤256 entries 且 typed chunk/result ≤49,152 bytes；complete JSON-RPC frame ≤65,536 bytes；RPC id 限既有協議合法值且 envelope 也實測 |
| transfer TTL | created+10,000ms、last accepted progress+5,000ms 先到；重送、read、commit failure 不續期 |
| rate / queue | patch+commit 共用每 panel 10/s、4 pending；沿用 event 64KiB/queue256KiB/source32 subscriptions；control 8 slots/16KiB 獨立 |
| old/final receipt retention | transfer terminal receipt 每 panel ≤4、至 created+30s；只保存 digest/revision/result，不留整個 payload |

begin 必須按新 snapshot 全額預留 receiving，且驗「所有現存 committed 加上該 dataset 新舊差額」不超 committed cap；commit 再查一遍。host 只保留一份 committed、一道 staging，commit 轉移 ownership，禁止永久第三份 parsed/canonical cache；JS object heap/RSS 不等於 bytes，D4 另測。read 不建立歷史 revision pin：revision 改變即 stale，client 丟棄部分讀取重新開始。renderer 每 binding 至多一份 committed 加一份有界 assembling，dialog 共用 store；其 bytes 亦需驗、close 清空。

## 5. RPC、SDK 與狀態機

共用 `B = {binding: UiBinding; dataset: LocalId}`。host 用原 channel principal＋完整 binding 查 current owner/resource；不得以 supplied dataset/transfer UUID 授權。所有方法僅 ready、共同協商 v2、已註冊且存在的 panel binding；不建立面板。status 不可使用 data plane。

| RPC | params（都包含 B） | success value |
| --- | --- | --- |
| `ui/dataBegin` | `{baseRevision: Counter, presentation: Counter, header: Header, entryCount: Counter, byteLength: Counter, sha256: Sha256}` | `{transfer: Handle, nextOffset: 0, remainingMs: number}` |
| `ui/dataChunk` | `{transfer: Handle, offset: Counter, chunk: Chunk}` | `{nextOffset: Counter, remainingMs: number}` |
| `ui/dataCommit` | `{transfer: Handle}` | `{revision: Counter, presentation: Counter, byteLength: Counter, sha256: Sha256}` |
| `ui/dataAbort` | `{transfer: Handle}` | `{aborted: boolean}` |
| `ui/dataRead` | `{revision: Counter, offset: Counter, limit: number}` | `{revision: Counter, presentation: Counter, header: Header, chunk: Chunk, nextOffset: Counter, done: boolean, byteLength: Counter, sha256: Sha256}` |

offset/count 是 **entry index，不是 byte offset**；read offset不可大於entryCount，否則offset錯誤；limit 1..256，byte budget 可提早截頁但至少回一 entry（EOF 可空）。每頁重複 header，保守 49,152 bytes 整 result 上限，遇 budget 邊界減 entries。entry/header caps 確保能前進。空 dataset 的 read 是 offset0/done true/空 entries。

初始 metadata revision0 表示 absent，不可 read；begin 只能 baseRevision 等當前（absent=0），presentation 必須 >目前 visible presentation；同一 presentation 可更新不同 datasets。成功 commit 由 host revision+1，非 caller 指定；counter 耗盡拒絕並要求新 binding。先完整驗 schema/count/digest/bytes/quotas/current binding/CAS，才 atomic swap，失敗不變舊 dataset。duplicate keys／非法 schema／hash不符使 transfer aborted；錯 offset 不接受、不前進。只允許「最後一個已接收 chunk 的同 offset/相同 typed canonical bytes」重送回原 nextOffset，不續 TTL；其他重疊 offset 拒絕。commit 已完成可在 bounded receipt retention 內回同結果，不產生新 revision；回覆遺失超過 retention 用 metadata/read 對帳，不盲重送 begin。

abort 同 owner retained transfer：receiving→aborted true；已 abort→false；已 commit→false（不撤銷 snapshot）。unknown/expired/cross-owner 一律 stale，不洩是否存在。panel hide 撤 receiving/preview demand，但保留有界 committed；close、resource replacement、process/host epoch retirement 清除全部；重開新 instance，revision 從0開始。舊 signal/late worker result 不能修改新 instance。

新增同時 negotiated 的 `ui/dataSnapshot`，params `{binding}`，value `{datasets: {dataset,revision,presentation,byteLength,sha256}[]}`（≤8，無 payload；absent dataset省略，caller按revision0處理）；用於 ready/reopen/gap/unknown commit。新增 UI subscribe topic `data`、`ui.data` event `{binding,dataset,revision,presentation}`。訂閱 initial/snapshot DTO 增加同 metadata，僅 v2 session；event loss 按既有 common-event gap→snapshot，不創第二事件 bus。renderer host bridge 提供相同 current binding read/snapshot 語意，不開 plugin 的其他資料 namespace。

JS 新 `ctx.ui.data` 的明確形狀：

```ts
interface UiDataClient {
  begin(params: DataBeginParams, signal?: AbortSignal): Promise<DataResult<DataBeginValue>>;
  chunk(params: DataChunkParams, signal?: AbortSignal): Promise<DataResult<DataChunkValue>>;
  commit(params: DataCommitParams, signal?: AbortSignal): Promise<DataResult<DataCommitValue>>;
  abort(params: DataAbortParams, signal?: AbortSignal): Promise<DataResult<{aborted:boolean}>>;
  read(params: DataReadParams, signal?: AbortSignal): Promise<DataResult<DataReadValue>>;
  snapshot(binding: UiBinding, signal?: AbortSignal): Promise<DataResult<DataSnapshotValue>>;
}
```

上述 Params/Value 逐一對應表列 B+欄位；snapshot 型別同前段。所有 call timeout5s、check ready；SDK 不自動重試、隱藏 cache 或另選 baseRevision。Python `ctx.ui.data`：`async begin(params)`, `chunk(params)`, `commit(params)`, `abort(params)`, `read(params)`, `snapshot(binding)`；TypedDict/return Result 同 wire camelCase，task cancellation 走既有 RPC cancel，timeout 同5s。cancel request 不等於 abort transfer，caller finally 明確 abort，斷線由 host retirement/TTL 回收。

`DataResult<T>` 是新的 `BusinessResult<T, UiDataDetail | PermissionErrorDetail, PluginErrorCodeV170>` alias（現有 code 名可重用，但新 detail 是 v2 only）：

```ts
type UiDataDetail = { kind: "ui-data"; reason:
  "schema" | "reference" | "revision" | "offset" | "checksum" |
  "expired" | "stale" | "quota" | "rate" | "queue" | "version" };
```

固定映射：malformed request/非finite/未知欄位→RPC invalidParams；合法結構但 dataset/header/row 引用或內容錯→PLUGIN_E_UI_RESOURCE/schema或reference；bytes/hash不符→同code/checksum；CAS→PLUGIN_E_STALE_RESOURCE/revision；unknown/wrong-owner/revoked→同code/stale，caller 自己過期 handle 可用 expired；out-of-order offset→PLUGIN_E_UI_RESOURCE/offset；quota/rate/queue→PLUGIN_E_RESOURCE_LIMIT/同reason；未協商→PLUGIN_E_UI_VERSION/version；欠 ui.panels→PLUGIN_E_PERMISSION_DENIED/既有 permission detail。錯誤無 path/資料值，不使用 persistence-specific conflict/quota code。D2 需擴展 method result/event/schema registry 與雙 SDK，不修改 v1 result parser 讓舊 session 接受新 detail。

## 6. Status Stop：同 owner reservation，不是 motion

`stopRecording.reservation` 只引用該 status/panel 的 nullable UUID string data slot（maxLength36）；null disabled。status 最多兩 actions：Open 與 Stop，不受 panel visibility/form busy/data queue/一般 command queue 阻塞；狀態更新受既有 status16KiB scalar cap，但停止 dispatch 使用獨立 control slot。

真 click/keyboard→generic host resolver：驗 current window、七欄 binding、registered v2 node/action、original runtime owner，再從 **host state** 讀 reservation UUID。使用該原始 plugin principal 呼叫既有 `devices/recording/release`；broker 的 owner query 必須通過。不是 core principal borrowing，不建立 motionScopeRef、operationId、DeviceIntent 或新的 stop RPC。UI stale/foreign owner 拒絕；已 ended 的同 owner reservation 回既有終態，不再發第二 onEnded。holding/viewer 變動不能擋 same-owner safety release；失效 window/retired owner 交現有 lifecycle 清理，不能用舊 status 復活 owner。

成功表示 reservation release/ending accepted，**不是 saved**。唯一既有 `ReservationBindingPort.onEnded`→persistence endReservation/drain→durable report 決定保存狀態。關 panel 不關 status；status owner retirement 才撤 binding。model timer 自動 limit 仍從 feature release，不透過 fake status click。v1 core motion stop 與其他插件完全不變。

## 7. Public EV3 vocabulary 與 record identity

候選正式公開 provider ID `kobrixa.device-ev3` 的以下語意，不改 `ChannelDefinition` wire shape。證據來源是 merged `main/device-providers/ev3/catalog.ts`，**尚待 3A/H-P 採納公開承諾**；feature 不可 import 該私有檔案。

| public tuple | pure adapter 輸出給 legacy code generator |
| --- | --- |
| kind=input，portId 精確 `input:0`..`input:3`，typeId `ev3:N` canonical decimal N=1..124，modeId `mode:0`..`mode:7`，component0..7 | kind=input、port0..3、type=N、mode0..7、channel=component、unit 原樣 |
| kind=output-angle，portId `output:A`..`output:D`，typeId `ev3:7`或`ev3:8`，modeId=null，component0，unit=deg | kind=output、port0..3、type7/8、mode0、channel0、unit=deg |
| 其他 provider、battery、非 canonical 數字、null input mode、未知 type/port | explicit unsupported；不 parseInt 猜測、不接私有 catalog |

即時 Capture/Zero 還需 ready、same session/sourceRevision、fresh snapshot age≤2500ms；靜態保存資料 compatibility 不要求 sensor 現在 online。canonical semantic key 為 JSON tuple `["ev3",kind,port,type,mode,component,rawUnit]`；已驗 public 與 legacy 使用同 key，calibrated comparison 另驗 calibrated unit。這是顯示／profile/code compatibility，**不是授權或硬體身份證據**：RPC 仍只用原 opaque channelId/session/sourceRevision，不從 key 合成 ID；不改原 SourceSnapshot。保留現有 generic `compatible` 保守行為，新增 feature adapter 包裝 EV3 cross-origin 特例，未驗 provider 不相等。native code 由純轉換後既有 generator 產生，延續 D0 nonzero component、motor zero、不 reset count、float32、雙語 VM fixtures。

recording/profile 有三組不同 identity：

1. `RecordMeta.id/revision`：host opaque storage鍵、CAS/delete/export/openRead/checkpoint 使用；list row.key/version 亦用它。
2. payload `Recording.id/CalibrationProfile.id`：feature UUID／legacy UUID；新錄製明確 Start 時只生成一次，initial/create receipt 前後不換；import 保留。不得把 host ID寫回 payload ID。
3. provenance session/channel/sourceRevision + recordingOrigin：來源及單調時間域，不是 storage ID。

adapter 保留 `{recordId, revision, modelId}`；每次 load 驗 kind/schema/payload，重複 modelId 在同 kind 發現歧義即 block選取/覆寫，不能把兩 host records 靜默合併。durable checkpoint 使用 host ID/latest confirmed revision；unknown write 先 reconcile，同 modelId 不重 create。host `interrupted` 只作讀取/CSV顯示投影，不覆寫原 bytes，terminal time 用最後 frame receipt 或 start，不能用重啟時間。

## 8. Import basename／實際格式：host-only必要修正

D6 應建兩個 allowlisted descriptors（候選 ID `kobrixa.sensor-lab.recordings-import`、`kobrixa.sensor-lab.calibrations-import`），sourceKind=sensor-lab、mappingVersion1、source format1、target schema2、targetSourceKey=`builtin:kobrixa.sensor-lab`。roots 分別是 legacy store 的 `recordings/`、`calibrations/`，由 desktop 固定，不由 plugin 傳入。

現有 `WorkerSources.inventory` 預設 `raw.formatVersion` **不適用**。候選在 descriptor 加 host-only `fileFormat: "format-version" | "sensor-lab-recording-v1" | "sensor-lab-profile-v1"`（file descriptors 明確填；renderer preferences維持既有分支）；inventory 按 allowlisted tag 讀真正 root.schemaVersion、檢驗相應 envelope，禁止用 `formatVersion ?? schemaVersion` 的寬鬆猜測。

`LegacyImportInput` 加 host-only optional `file: {basename: string}`；file descriptor validate/map 均必須收到 WorkerSources inventory/map 當次經 containment/no-symlink read 的 key，sensor-lab descriptor 缺 file 即拒絕。baseline item key 就是單檔 basename，不能把 payload.id 當 expectedId，也不能以 closure 暫存「上一筆 filename」。只接受單一 UUID basename `.json`、不含 separator，UUID 語法與既有 pure mapper 一致、大小寫精確比對 `${payload.id}.json === basename`。每次 re-read 重驗 basename/hash/byteLength；recording bytes 直接 `importLegacyRecording(bytes, stem)`，profile 使用真 `{schemaVersion:1,profile}` envelope 呼叫 `importLegacyCalibration(bytes, stem)`。

這是尚未實作的 B2/H-D seam 變更，需原 owner handoff，不新增 public path/import RPC、不改 source bytes 或包一層假 formatVersion。保留 existing original bytes/hash/journal tags、planned→commit receipt→complete、source changed blocked。兩 descriptor 共用 legacy writer barrier：兩者都 complete/complete-empty 才切換 Lab readers；任一 blocked 不允許半套新history/profile或 legacy雙寫。source absence、permission、corrupt、malformed UTF-8、較新schema、symlink、filename mismatch 必須分清；原檔保留。50×8MiB 是 migration load case，不以 T0 byte算術替代 worker/restart證據。

## 9. Stop reason：完整 host evidence 不丟失

public `ReservationSnapshot.reason` 與 model `StopReason` 不同；另外保留原 reservation snapshot、end monotonic timestamp、drain reason，不能在 schema2 payload 塞未宣告 keys。

| host reason | payload／projection reason |
| --- | --- |
| active | 無 terminal reason，不能 final |
| released | manual；僅該 reservation release 前已鎖定 feature deadline/count原因才為 limit |
| limit | limit |
| source-changed | source-changed |
| disconnected / core-disconnect | disconnected |
| suspended | suspend |
| overflow / renderer-lost | interrupted |
| retired | 預設 interrupted；同 owner 本次 host drain 明確 shutdown/update 時才分別 close/update |

shutdown/update 是 **drain lifecycle reason，不是 reservation enum**。其他非released終態優先於 feature limit，renderer-lost/overflow 不因一般 shutdown 訊號改成正常close。30分鐘 timer與3,600 frames上限都在 release 前按原 reservation 固定；舊 timer 不可改新 recording；沒有新 frame仍按單調deadline停止。程序崩潰後只採 durable checkpoint/host interrupted證據，不能猜未保存的 limit。所有 final 仍讀到固定 lastSequence、去重 firstSequence，再由唯一 drain 協調 checkpoint CAS，不另設 feature finalizer。

## 10. Byte fixtures 與 D2/D4 驗收矩陣

本次只執行 standalone Node 記憶體算術，沒有 product/native tests。以下固定 recipe 使用上述 canonical key順序；bytes=`Buffer.byteLength(JSON.stringify([header,entries]),"utf8")`。

- Chart header：2 series，id s0/s1、unit deg、range[-100,100]、extrema[[0,-100],[1500,100]]、fullPointCount3600、omittedPoints2800、omittedRuns0。entries i=0..1599：`[floor(i/800),0,(i%800)*500,i%2?100:-100]`。單 chart **27,853 bytes**；4 charts=111,412，正好6,400 points。這是合成的最大點數 fixture；extrema時間/值落在對應points，full raw需另附3,600點且相同extrema，並非native trace。
- Table：50 rows，key `row-0`..`row-49`，version `00000000-0000-4000-8000-000000000001`，8 cells各 `臺`.repeat(200)：**245,010 bytes**。每 row最大4,899 bytes（兩位 row index），不能一個64KiB message送整頁。
- List 同 rows，3 cells：**94,259 bytes**；history/profile各一份。
- Code：header `{kind:"code"}`、16 entries各 `界`.repeat(1024)：**49,219 bytes**，原文字49,152 bytes/16,384 cp；需要多chunk（單entry3,074 bytes）。ASCII與4-byte Unicode、quote/control escapes另測雙cap，不可只算原文字。
- 以上8 datasets 合計 **594,159 >524,288**，必須 quota reject，不可宣稱「各count合法所以合計合法」。byte-aware pagination 應減 table頁；50-row普通 cell=`value`、兩list同替換的完整8-dataset fixture為 **177,659 bytes**，保留4×2×800及50 rows，是可容納的 max-count fixture。最大字串頁與最大圖各自boundary fixture，不承諾所有局部最大同時成立。
- 舊式一次送1,600 chart entries 的示例 JSON-RPC envelope28,037 bytes雖小於64KiB，仍因 **256 entries cap** 不合法；正確拆7 chunks。此反例防止只驗byte不驗count。

D2 要把上列 recipe 落成 shared TS/Python/schema fixtures，補 canonical SHA golden vectors及所有 limit−1/limit/limit+1，不以本文件數字取代實作測試。必須有 exact524,288-byte合法整體、524,289拒絕；49,152/49,153 page；1,024/1,025 code entry；8/9 datasets、800/801 points、50/51 rows、duplicate keys、stale base、offset replay、checksum、timeout、cross-owner/process/resource generation、doublecommit、hidden/closed late result、status同owner/foreign/已ended/失權。schema/reference錯誤保持舊snapshot，control不可被dataset queue餓死。

D4 在背景3,600frames／4×2×800、table50rows與cursor同時跑60s，實測apply p95≤16ms/max≤50ms、key/cursor/Stop dispatch p95≤100ms、queue/bytes/RSS；停止dispatch不是實體停止/保存完成。此處沒有性能通過宣稱。

## 11. 未決 owner 確認與正式完成條件

選項已收斂：full snapshot；typed entries＋canonical digest；status僅core Open/Stop；不更動command envelope；EV3 semantic adapter；兩個host-only imports；reason保守映射。無需使用者重選功能。

仍須實際決定／證明：

1. H-P/H-R/H-V 接受 canonical number/雙SDK vectors、dataSnapshot/event增量與byte/heap雙重budget；shared fixture/renderer性能尚未實作驗收。
2. 3A/H-P正式承諾EV3 vocabulary（若拒絕，回T0提出versioned semantic descriptor，不能永久關掉live EV3 code而稱parity完成）。
3. H-D/B2接受 fileFormat/basename host-only seam及兩descriptor切換barrier，等當前writer停止交接；sealed TTL修補另案。
4. 各owner精確path/stopped/base-head/驗證receipt及foundation aggregate gate disposition。3C retained proofs可消費，但不代替本D artifact，也不把P160/P170/X-T1記closed。

正式 D1 close 需上述具名 acceptance；D2 API1.8發布、D7公開transport、D9a/b Lab source-free installed、D8 legacy removal、MANUAL仍是後續獨立 gates。本次產物只是一份可實作、可反駁的 local technical freeze draft。
