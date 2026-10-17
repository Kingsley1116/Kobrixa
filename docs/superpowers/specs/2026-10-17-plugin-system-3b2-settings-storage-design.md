# 插件設定與 bounded record storage 設計（第三階段 3B-2）

日期：2026-10-17  
狀態：子專案設計；供 T0 凍結與後續 plan 使用，尚未實作或完成自動化／MANUAL 驗收。目標 Plugin API：**1.7.0**。

- Binding authority：[第三階段總體規格](2026-10-17-plugin-system-stage-3-design.md) §2、§3.5、§4、§5.3、§7、§9；其決策、版本順序、生命週期矩陣與 hotspot ownership 不在本規格重議。
- 上層：[插件系統主設計](2026-10-14-plugin-system-design.md)；結構參考 [2A](2026-10-16-plugin-system-2a-build-chain-design.md)、[2B-1](2026-10-16-plugin-system-2b1-diagnostic-source-design.md)、[2B-2](2026-10-16-plugin-system-2b2-language-services-design.md) 與 [2C §11](2026-10-17-plugin-system-2c-static-languages-design.md#11-實作切分)。
- 程式碼盤點以 §1.2 的 repository citations 為依據；提案與現行程式不一致時，以 umbrella 及所列實際程式碼核對為準。

本文除 §1.2 明列的現有符號及 umbrella 已固定的詞彙外，所有型別、方法、事件、port、常數及建議模組路徑均為**新增契約**，不代表現在已有這些 API。文中 `main/`、`renderer/` 路徑縮寫位於 `apps/desktop/src/`。

## 1. 範圍、現況與完成條件

### 1.1 範圍與非範圍

3B-2 交付 application-local typed settings、通用設定頁、獨立 record store、quota／CAS／分頁／staging、原子提交與復原、使用者啟動的 export／copy、lifecycle drain port，以及一次性 legacy import framework。同批交付 Zod、JSON Schema、JS／Python SDK 與共用正反例。後端可依 T0 fixtures 平行開發；正式版本在 3A 的 1.5.0、3B-1 的 1.6.0 後合入。

不交付 workspace override、secrets、sync、任意檔案系統、跨 source 存取、跨筆通用 transaction、任意查詢語言、壓縮／附件庫、一般 services bus、HTML panel 或產生式 Python bindings。舊設定頁並不全部遷移；core plugin administration 的 disabled／safe-mode 狀態不是插件設定。motor per-port drafts 維持暫存。

3D 擁有 Lab recorder、校正、CSV 編碼、charts、資料 schema 與 import mapping；3E 擁有設備設定、renderer connection preferences 的 mapping 及其使用端。3B-2 的 host 不解讀 sample、calibration、EV3 port 或重建錄製器。3B-1 擁有通用 forms、commands／action context、lifecycle、core recovery view；本文提供其所需 ports。

### 1.2 已核對的程式碼與遷移起點

| 現有來源／符號                                                                                                                                                                                                                                                          | 實際行為與本子專案的差異                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`common.ts`](../../../packages/plugin-protocol/src/common.ts)、[`methods.ts`](../../../packages/plugin-protocol/src/methods.ts)、[`limits.ts`](../../../packages/plugin-protocol/src/limits.ts)                                                                        | 現行 API 1.4.0；permission 只有 `ui.notifications`；request 為 `initialize`、`command/execute`、`shutdown`、`ui/showMessage`，沒有 settings／storage。message 1 MiB、manifest 64 KiB。                                   |
| [`rpc.ts`](../../../packages/plugin-protocol/src/rpc.ts)、[`errors.ts`](../../../packages/plugin-protocol/src/errors.ts)                                                                                                                                                | numeric RPC failure 只有 `code`／`message`，沒有 `error.data`。本案業務錯誤使用 umbrella 的 object result union。                                                                                                        |
| [`manifest.ts`](../../../packages/plugin-protocol/src/manifest.ts)、[`json-schema.ts`](../../../packages/plugin-protocol/src/json-schema.ts)                                                                                                                            | 外層 manifest／contributes 為 loose；已知新欄位須明確加入 strict schema。`buildJsonSchema` 使用可匯出的 Zod、draft-2020-12，不能把 desktop refine／transform 搬作 wire schema。                                          |
| [`PluginContext`](../../../packages/plugin-sdk-js/src/index.ts)、Python [`CommandContext`](../../../sdks/python/kobrixa/_plugin.py)                                                                                                                                     | JS 有 commands、notifications、`AbortSignal`／`deactivate`；Python 有 async commands／stdio，目前 shutdown 沒有 feature cleanup。兩者均需新增公開 persistence context。                                                  |
| [`SensorLabStore`、`atomicSensorLabWrite`](../../../apps/desktop/src/main/sensor-lab/store.ts)                                                                                                                                                                          | 記憶體 maps／dirty revision；UUID 檔名、temp＋rename、8 MiB 讀取限制。save 先更新記憶體，失敗由同程序保留 dirty payload；沒有公開 CAS、quota 或 fsync。不可直接換名字作為通用 store。                                    |
| [`SensorLabService`](../../../apps/desktop/src/main/sensor-lab/service.ts)、[`SENSOR_LAB_LIMITS`](../../../apps/desktop/src/main/sensor-lab/schema.ts)                                                                                                                  | checkpoint 5 秒、50 records、4 channels、3,600 frames；`retrySave` 依賴記憶體、`flush` 阻擋 close／update。新 host 只保證最後 committed checkpoint，feature 邏輯由 3D 移出。                                             |
| [`exportSensorCsv`](../../../apps/desktop/src/main/sensor-lab-export.ts)                                                                                                                                                                                                | 取得完整 CSV，Electron save dialog，目的地旁 temp＋rename。新的 export 必須可用 chunks，且將使用者動作及 destination 留在 host。                                                                                         |
| [`DevicePreferencesStore`、`loadDevicePreferences`](../../../apps/desktop/src/main/device/preferences.ts)                                                                                                                                                               | `device-settings.json`、序列化 persist 後才 applied；讀取逐欄驗證，失敗退預設，固定 `.tmp`。新 store 不將損壞或版本不相容當成空設定。                                                                                    |
| [`SettingsStore`、`SETTINGS_KEYS`、`WIFI_ADDRESS_KEY`](../../../apps/desktop/src/renderer/settings/settings.ts)、[`settings-state.ts`](../../../apps/desktop/src/renderer/settings/settings-state.ts)                                                                   | renderer localStorage，有 connection mode／remember address 與大量仍屬 legacy 的設定；Wi-Fi address 只有 remember 開啟才還原。import 只取得 allowlist 原值，3E 決定 mapping。                                            |
| [`SETTINGS_CATALOG`](../../../apps/desktop/src/renderer/settings/settings-catalog.ts)、[`settings-panel.tsx`](../../../apps/desktop/src/renderer/settings/settings-panel.tsx)、[`useDevicePreferences`](../../../apps/desktop/src/renderer/settings/device-settings.ts) | catalog 含函式 callbacks／私有 device preload。新 contributed settings 走純資料與 3B-1 forms，不把 callbacks 當公開 API。                                                                                                |
| [`filePluginStateStore`](../../../apps/desktop/src/main/plugins/state-store.ts)                                                                                                                                                                                         | `<userData>/plugins/state.json` 保存管理狀態，使用 temp＋rename；與新 feature values／records 物理分離，不沿用其 `PLUGIN_E_STATE_SAVE`。                                                                                 |
| [`developmentSourceKey`](../../../packages/plugin-runtime/src/registry.ts)、[`PluginManager`](../../../packages/plugin-runtime/src/manager.ts)、[`PluginSupervisor`](../../../packages/plugin-runtime/src/supervisor.ts)                                                | dev source 為 resolved directory 雜湊；execution 與 static generation 分離。manager shutdown 預設 4 秒，supervisor shutdown request 2 秒；storage drain 必須在這段之前完成。                                             |
| [`main/index.ts`](../../../apps/desktop/src/main/index.ts)                                                                                                                                                                                                              | 目前直接組裝 preferences／Lab，close／quit 呼叫 motors 與 Lab flush。目前未呼叫 `app.requestSingleInstanceLock()`；依 umbrella §2 決策 10，desktop integration owner 必須在任何持久化初始化前接入 single-instance gate。 |

### 1.3 驗收界線

3B-2 可以用 generic fixtures 驗收 API／保存／import framework，但 umbrella S3-09 的真實 EV3 settings consumer 與 Lab migration 仍依賴 3D／3E。不得以 fixture 通過宣告三個功能已完成遷移。所有下列測試為後續驗收要求；本文件撰寫只核對來源與格式。

## 2. 決策紀錄與固定 budgets

### 2.1 工程決策

| 決策                                                                          | 理由與後果                                                                                                                                   |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| namespace 由 `sourceKey` 決定；RPC 不接受 namespace／path                     | 顯示 `pluginId` 或套件改名不能取得其他來源資料；停用與重啟保留 namespace，pending access 仍綁 principal。                                    |
| 一個 settings resource、一份完整 effective values snapshot                    | 最多 128 keys 可整體驗證／CAS；省去任意 nested object、跨設定 transaction 與 coercion。                                                      |
| schemaVersion 與 value revision 分離；版本不相容停止寫入                      | default 不是資料修復；升版須明確 migrate，降版保留較新資料並報錯。                                                                           |
| records 是有 envelope 的 opaque bytes                                         | feature 管理其資料格式；host 可做 checksum、CAS、quota、copy/export，無須依賴 Lab schema。                                                   |
| chunk 使用嚴格 base64；先預約整筆 bytes                                       | JS／Python 相同 wire、可處理 UTF-8 邊界；不把 8 MiB record 塞入 1 MiB frame。                                                                |
| immutable payload＋單一 head 原子替換                                         | payload／metadata 不會出現不同 revision；舊 object 在成功確認與讀取引用解除前保留。                                                          |
| temp fsync、rename、可支援時 directory fsync；回報 durability                 | 原子可見不等於斷電耐久；不把平台不支援目錄同步悄悄說成完整保證。                                                                             |
| 消費 3A 的 `ProfileWriterLock`，由 core single-instance gate 保護 persistence | 依 umbrella §2 決策 10；由 desktop integration owner 在啟動時取得 Electron instance lock，第二次啟動聚焦既有視窗後退出，不建立另一個 store。 |
| 普通 staging 與 drain 失敗 payload 使用相同到期時計                           | 不因錯誤轉為無限 cache；core 顯示可重試到期時間，過期只能保留 checkpoint。                                                                   |
| import 是 host allowlist＋具 receipt 的逐筆 migration                         | 可重入、保留 originals、先完成 marker 再切換；不新增跨筆 transaction 或公開 legacy path access。                                             |
| 通用設定頁的 save 走可信 core action                                          | 不用插件 command 轉送 64 KiB values，保持 3B-1 arguments 16 KiB 限制，且停用程序不會破壞核心保存錯誤 UI。                                    |

### 2.2 使用者最終決策 10–15 的落點

以下逐項引用 [umbrella §2 決策 10–15](2026-10-17-plugin-system-stage-3-design.md#2-決策紀錄)，均已決定，不是 T0 待選方案。

| 決策                                             | 對 3B-2 的約束與實作落點                                                                                                                                                                                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10：單一 app instance                            | `app.requestSingleInstanceLock()` 為唯一 profile exclusivity 機制；第二次啟動聚焦既有視窗後退出。§6.1 消費 3A `ProfileWriterLock`，不新增 native file-lock addon、owner.lock 或第二實例降級模式；§12／§13 驗收並記錄此可見行為變更。                       |
| 11：插件工具側欄                                 | 三 feature 位於 `rightPanel:"plugins"` 的「插件工具 / Plugin tools」同級 tabs，與既有 EV3／collaboration pane 互斥，motor 離開 monitor card；placement 由 3B-1 擁有。§4.3 的 contributed settings 留在通用設定頁；切 tab／隱藏 Lab 仍保留背景 checkpoint。 |
| 12：一次 Disconnect 完成停／存／斷線             | core coordinator 先要求 motor stop/readback、結束 recording 並等待 save，再斷線；§8.4 提供保存進度與 blocker，失敗不顯示完成。plugin `devices/disconnect` 仍遵守 3A 的跨 owner busy，不取得 force-disconnect 權。                                          |
| 13：OS suspend 停止並保存                        | §8.4 在 suspend 結束背景錄製、bounded drain／save，並由 3A 要求 motion stop；wake 不自動續錄或重播。OS 未給足時間時只承諾最後 committed checkpoint，顯示 interrupted／save fault。                                                                         |
| 14：optional builtins 預設啟用、一般使用者可切換 | plugin management 不需 developer mode；由 3B-1 保存各 source 的 enable/disable 狀態。3B-2 的 values／records 在停用後保留，撤 watcher 並保留 core recovery；不將管理開關寫入 feature settings。                                                            |
| 15：EV3 file-transfer exchange 維持 10 秒        | 消費 3A／umbrella §4.8 的 device deadlines：file transfer 10 秒、其他普通 exchange 5 秒。§8.3 仍為 storage drain 10 秒、device stop/readback 15 秒加 journal 5 秒、cleanup 24 秒與 outer net 25 秒，不改成較短的檔案 exchange 假設。                       |

### 2.3 數量、bytes 與時間

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

## 3. 共同 wire、ownership 與錯誤

### 3.1 基本型別與驗證

新增 wire objects 均 strict，未列欄位拒絕；optional 欄位省略，除明列 `null` 外不使用 null。所有 number 必須 finite；integer、offset、count、timestamps 與 sequence 均在 JavaScript safe-integer 範圍，負值只在 number setting 的合法 range 出現。UTF-8 拒絕 unpaired surrogate；不做隱含 trim、Unicode 正規化或 number/string coercion。

```ts
// 新增概念型別；正式 Zod 及其 inferred TS types 由 protocol integrator 發布。
type Version = number; // integer，1..2_147_483_647
type SettingsRevision = string; // /^r_[0-9a-f]{32}$/，host 隨機產生，只能在 settings domain 比較相等
type RecordRevision = string; // 同一格式；僅在同 source／record domain 比較相等
type RecordId = string; // host 產生的 lowercase UUID v4，永不重用
// Handle／Counter type-only 匯入 3A 的共用型別，不在本案重新定義。
type Sha256 = string; // /^[0-9a-f]{64}$/
type SettingKey = string; // /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*$/，最多 64 bytes
type Scalar = boolean | number | string;
type Values = Array<{ key: SettingKey; value: Scalar }>;
type Durability = "file-and-directory-sync" | "file-sync-only";
type Receipt<R extends SettingsRevision | RecordRevision> = {
  revision: R;
  commitId: Handle;
  durability: Durability;
};
```

SettingsRevision／RecordRevision 不使用 3A 的 Counter；revision 表示依 domain 決定，不跨 settings、records 或 UI／device APIs 比較或排序。

keys 的 dot 是字面鍵名，不是 object traversal；每個 segment 禁止 `__proto__`、`prototype`、`constructor`。Values 使用陣列、每鍵一次，host 依 key ASCII 排序回傳；不得用 object prototype merge。空 values 只在沒有 schema 的 migration evidence 中合法；正常 schema 至少一鍵。

principal 由 router 綁 `{sourceKey, pluginId, generation, hostEpoch, processEpoch, authorityContext}`。persistent record ID 不是 capability；每次讀寫仍驗 source。handles 額外綁 current principal，list／read pins 也不能跨 generation。fresh handle 不授予 permission。foreign／unknown／expired handle 統一 `PLUGIN_E_STALE_RESOURCE`，不得回傳 foreign record 是否存在。persistent ID 在自身 namespace 查無資料回 `PLUGIN_E_STORAGE_IO` 的 `not-found`。

本機 settings／records 不要求 collaboration holder；設備設定套用到設備時仍須通過 3A authority。export／copy 額外要求可信 user action。任何方法都不能以儲存的值自動授予 connect、record 或 motion 權限。

### 3.2 結果與失敗 detail

所有新增 request 使用 umbrella 的 `{ok:true,value}`／`{ok:false,error:{code,message,detail?}}`；成功的 void 為 `{ok:true,value:{}}`。`message` 最多 2,000 code points；共用 detail 原樣消費 [3A §5.1](2026-10-17-plugin-system-3a-device-broker-design.md) 的正式 schema／上限，不另造同碼 reason。依「每批次加入自己的 kind」規則，API 1.7.0 加入 `kind:"persistence"` 的 strict `PersistenceDetail`，僅用於本批 settings／storage 專屬 codes，完整 JSON ≤2 KiB；所有 detail 均不含 native path、stack、原 payload／settings value：

```ts
type PersistenceDetail = {
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
type PersistenceFailureDetail = PermissionErrorDetail | ResourceErrorDetail | PersistenceDetail;
```

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

`PersistenceReason` 在正式 schema 中展開為各專屬 code 的 enum union，code／kind／reason 必須匹配，不能保留任意 string；共享 error detail 原樣 type-only 匯入 3A，後文 `detail` 使用上列 `PersistenceFailureDetail` union，不得將 shared codes 填入 persistence branch。普通 envelope／參數結構錯誤仍用 `RPC_ERRORS.invalidParams`（-32602），未知方法用 `methodNotFound`（-32601）；解析／frame 錯誤沿用現行 transport。通過結構驗證後的型別與 schema range 不合、quota、CAS、I/O 均回 business result，不新增 numeric error code 或擴寫 `error.data`。raw RPC 與 SDK 都不得將 timeout／cancel 當成已回滾。

### 3.3 事件與序列

settings watch 使用 [3A 的共用事件契約](2026-10-17-plugin-system-3a-device-broker-design.md) 的 `events/deliver`／`EventEnvelope<Data>`，依 event kind registry 在 API 1.7.0 批次加入 `kind:"settings.changed"`、`delivery:"telemetry"`，data 定義於 §4.3；owner 原樣使用 `ResourceOwner`，不重定 envelope。SDK 一律在 schema 驗證成功、放入 bounded local queue 後送 `events/ack`，不等待 user callback；enqueue 失敗依 3A overflow／resync 規則，不 ack 未接受的 sequence。gap 由 sequence 缺口偵測並 read snapshot；不新增 settings 專屬 gap kind，control／resync 沿同一框架。wire 只使用 `events/unsubscribe {subscriptionId}`，回 `{removed:boolean}`；首次移除 true，同 owner tombstone 內重複 false，foreign／unknown／expired tombstone 依 3A 回 stale。SDK 可提供 `settings.unwatch` sugar 並保留相同 result，不新增 wire alias 或第二套訂閱表。storage 沒有通用 change stream，使用 write status／flush／重新 list 即可。

每個 subscription 的 sequence 從 1 起；watch 回覆的 baseline 為 0。commit 後才排事件；unsubscribe／retirement 先撤 callback binding，晚到通知不能呼叫新 instance。settings invalidation 可合併成最新 revision，必須保留實際最新 sequence，consumer 發現缺口須 read snapshot。terminal save fault 留在 core recovery snapshot，不依賴可被合併的事件送達。callback 例外不能使 host 重試 mutation。

## 4. Typed settings 與通用設定 UI

### 4.1 Manifest 與 resource

新增 `contributes.settings?: {version:1,path:string}`，每 source 至多一份；path 沿用受限 packaged JSON 規則及安全讀取器，拒 absolute／URL／`..`／symlink escape，先限制原始 bytes 再 parse。`version:1` 是 resource 格式，與 `schemaVersion`、API、package、UI resource version 分開。使用本宣告或 API 的 consumer 最低要求 `^1.7.0`。

只對 enabled source 載入／發布；safe mode 在讀 optional resources 前生效。設定 schema 是資料，不需啟動 process。此批次不放寬 `runtime.kind === static`：該 variant 仍只接受已定的靜態語言／說明貢獻，宣告 settings 即 manifest invalid。node／python 或 host-allowlisted builtin 可宣告 settings，必須同時宣告 `settings.read`；`settings.write` 決定插件與一般 contributed settings UI 是否可修改。

```ts
type SettingsText = { en: string; "zh-TW"?: string };
type CommonField = { key: SettingKey; label: SettingsText; help?: SettingsText };
type SettingsField = CommonField &
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
type SettingsResourceV1 = {
  schemaVersion: Version;
  title: SettingsText;
  fields: SettingsField[];
};
```

title／label 每語系 1–200 code points、≤800 bytes；help 0–2,000 code points、≤8 KiB；純文字、無 HTML／Markdown／URL action。`en` 必填，`zh-TW` 缺漏退英文。控制字元依既有單行／多行安全規則驗證，不執行 regex、expression 或 callbacks。fields 1–128，陣列順序即呈現順序。

number range 必須 finite、minimum≤maximum，default 在區間內；integer 的 default／range 均 safe integer。v1 不提供 step/multipleOf，避免浮點容差分歧；range component 僅作 3B-1 已支援的視覺呈現，不改 number 合法集合。string 的 minLength／maxLength 為 0–4,000 code points，maxBytes 為 1–4,096，兩者均檢查，與 3B-1 單值字元限制對齊。enum 1–32 options，string 值同時受 4 KiB／4,000 code points 限制、number 必須 safe integer；允許混合 string／integer 以承接現有設備 choices，按型別與值判斷相等，`1` 與 `"1"` 不同。default 必須匹配一個 option，重複 option 拒絕。

每個 schema revision 計算兩個 digest：完整 resource digest 用來使 UI catalog 失效；validation digest 只涵蓋 keys、types、defaults、range／options 值等有效值語意，按固定排序／host serialization 計算。僅翻譯／順序變更不要求 schemaVersion；相同 schemaVersion 的 validation digest 變更回 `schema-changed-without-version`，不改寫值。首次沒有資料時從 defaults 形成 snapshot，但不先寫磁碟；第一個 mutation 以 revision `null` 建立持久值。

### 4.2 公開 methods

以下皆新增 plugin→host methods；表內回傳為 `value`，外層包 §3.2 result。`schemaVersion` 必須等於當前 declaration；所有 mutations 在同 namespace 序列化，CAS 在 publication 前再次檢查。

```ts
type SettingsSnapshot = {
  schemaVersion: Version;
  revision: SettingsRevision | null; // null 只表示尚無 committed settings
  values: Values; // 完整 effective values，含 defaults，最多 64 KiB
};
type SettingsMutation = { snapshot: SettingsSnapshot; receipt: Receipt<SettingsRevision> };
```

| Method                   | Params                                                                                 | Value／權限                                                                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings/read`          | `{schemaVersion}`                                                                      | `SettingsSnapshot`；`settings.read`。沒有資料回 defaults/null；版本不合報錯。                                                                                                    |
| `settings/update`        | `{schemaVersion, expectedRevision:SettingsRevision\|null, changes:Values}`             | `SettingsMutation`；`settings.write`。changes 1–128，每鍵唯一；將 patch 套到完整 snapshot 後整體驗證／原子提交。                                                                 |
| `settings/reset`         | `{schemaVersion, expectedRevision, keys:SettingKey[]}`                                 | `SettingsMutation`；`settings.write`。keys 1–128，不接受 wildcard；全 reset 明列全部 keys，依同一 CAS 一次提交。                                                                 |
| `settings/watch`         | `{schemaVersion}`                                                                      | `{subscriptionId:Handle, sequence:0, snapshot:SettingsSnapshot}`；`settings.read`。註冊與 baseline snapshot 在同一序列位置完成。                                                 |
| `settings/readMigration` | `{}`                                                                                   | `{stored:SettingsSnapshot, declaredSchemaVersion:Version}`；`settings.read`。只回本 source 已持久化值，無資料回 `PLUGIN_E_SETTINGS_SCHEMA`／`invalid-value`，不虛構舊 snapshot。 |
| `settings/migrate`       | `{fromSchemaVersion, schemaVersion, expectedRevision:SettingsRevision, values:Values}` | `SettingsMutation`；`settings.write`。完整 replacement，所有當前 keys 恰一次，不自動補 defaults；from 與 stored 相符，且 from＜schemaVersion。                                   |

`settings/readMigration` 在無 stored file 時回 `PLUGIN_E_SETTINGS_SCHEMA`／`invalid-value`；不適合當一般 read fallback。正常版本相符時亦可讀取，但 migrate 仍只接受嚴格升版。stored version 高於 declaration 回 `downgrade`，一般 read／write／reset 均停止；migration evidence 可供 core 說明，不能用 reset 偷偷摧毀較新版本。沒有 generic 自動 migration callback；feature 使用 readMigration→純資料 mapping→migrate。mapping 不支援該舊版本時保留資料並顯示 unavailable。

相同值的有效 update／reset 仍是一個明確 commit，產生新 revision 與 receipt，方便多視窗判斷順序；client 應在 UI 忽略完全沒變的 draft。mutations 不自動 retry；回覆遺失時 read 判斷目前 revision，重新確認修改意圖後才用新 CAS。設定保存不因 feature applied callback 失敗而 rollback；feature 必須將「已保存」及「目前設備套用失敗」分開。

### 4.3 Watch payload 與 UI 行為

新增 settings watch payload：`{revision:SettingsRevision, schemaVersion:Version, changedKeys:SettingKey[], cause:"update"|"reset"|"migrate"|"import"}`。changedKeys 最多 128，不送 values；consumer read 取得最新完整 snapshot。schema resource 換版撤銷舊 watcher，送同一 event framework 的 resource invalidation；不是向舊 consumer 發不理解的新 keys。訂閱不跨 disable／crash／reload／safe mode，自動撤回；值保留。

3B-2 提供新增 `SettingsFormPort`，3B-1 的 generic forms 實作接收已驗證 field descriptors、baseline revision、draft、per-key errors 與 busy state。其概念方法為 `open(binding, resource, snapshot)`、`replaceSnapshot(binding,snapshot)`、`showFailure(binding,error)`、`dispose(binding)`；binding 是 host catalog source／resource generation／window 組合，不接受插件自行指定。這是 host-only renderer port，不是另一套 UI resource version。

此為 3B-1 §11.4 的 host-only forms adapter，重用 boolean、number、bounded text input、choice 的呈現與 labels／help／focus／鍵盤／主題；settings descriptors 不直接當 UI v1 resource。adapter 依當前 resource digest 建立私有雙向映射：每個 key 按 fields 順序對應 `field-0` 至 `field-127` 的 `LocalId`，例如 `connection.mode` 映成 `field-0`，不把 dot 改成 dash 而產生碰撞。enum 的每個 option 按順序映成字串 `option-0` 至 `option-31`；`1` 與 `"1"` 取得不同 option ID，core submit 依 binding 的 map 還原原始 scalar 型別，不解析數字或 coercion。stale resource／binding 的 map 拒絕提交；snapshot、draft、per-key errors 在相同 map 下雙向轉換，record/settings wire 仍保留原 SettingKey／Scalar。

通用設定頁一次顯示 16 fields，最多 8 頁；一頁包括 errors/actions 在內最多 128 nodes、depth≤8，採 UI v1 的 layout budgets，仍用 settings validator 驗值；choice 1–8 options 可 segmented，9–32 使用 select。core 同時掛載一個 contributed settings form，不占 feature panel 配額。依 umbrella §2 決策 11，三個 feature tabs 由 3B-1 放在「插件工具 / Plugin tools」pane；contributed settings 在通用設定頁，切換 pane／tab 不停止 Lab 背景錄製。

輸入只修改本地 draft；按「套用」或單欄「重設」才提交，不每按鍵持久化。Save／Reset 為 core actions，使用同一 validator／namespace CAS service，授權繫結 catalog binding 與可信 sender；64 KiB changes 不經 16 KiB plugin command arguments。public plugin form 若要更新設定，可經 command 取受限 arguments 再自行呼叫 `settings/update`。

收到 watch：無 dirty draft 直接更新；有 dirty draft 保留輸入、標示外部已變更並禁用舊 CAS 套用，提供「重新載入」及在最新 baseline 上重新編輯。不得 silent last-write-wins。save 失敗保留 draft／field errors／重試入口，已 committed snapshot 不變；unknown outcome 先 read／flush，再決定重試。欄位缺權限顯示唯讀原因；停用撤貢獻與 watcher，核心 recovery 保留錯誤，重新啟用不回填過期 draft。

設定頁加入獨立「插件設定」來源列／搜尋，不重寫 legacy catalog。一般文字比對 label／help／key，沒有插件 callbacks。core recovery／plugin management 即使所有 optional features 關閉仍可用；cold safe mode 不為了顯示 settings 而讀被抑制的 resource 或啟動 process。

## 5. Bounded record storage API

### 5.1 Records、IDs 與 revisions

record ID 由 host 在 begin create 時生成，不接受 caller-selected ID／路徑／filename；abort 或 delete 後不重用。plugin 可以將 ID 放在自己的 setting／record 中作 reference，但 host 不提供 foreign-key transaction。相同 ID 在另一 source 不構成查詢權。SDK 不推導 ID 格式的業務意義。

```ts
type RecordMeta = {
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
type RecordTarget =
  { mode: "create" } | { mode: "replace"; id: RecordId; expectedRevision: RecordRevision };
type RecordWrite = {
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
type WriteProgress = {
  write: Handle;
  id: RecordId;
  state: "receiving" | "sealed" | "publishing" | "committed" | "aborted" | "expired" | "failed";
  receivedBytes: number;
  expiresAt: number;
  receipt?: Receipt<RecordRevision>;
  error?: { code: string; message: string; detail?: PersistenceFailureDetail };
};
```

error.code 使用共同 code enum。host 不解析 payload，即使 mediaType 是 JSON 也不替 feature 驗證或 canonicalize；bytes／hash 精確保留，schemaVersion 表示 feature 格式。未知 schemaVersion 可列 metadata，但讀取必須明列 consumer 支援的那個版本；3D 必須在解析後做 Lab 語意驗證。schemaVersion 變更經完整 replacement＋舊 revision CAS，不做原地修改。

`createdAt` 在 replacement 保留；updatedAt 由 host 設定，允許 wall clock 回退，不能用時間比較 CAS。`checkpoint`／`interrupted` 由 host registration／lifecycle 控制，caller 不能偽造完成。一般 create 是 `none/false`；checkpoint registration 將已有 record 視為其 recovery baseline，之後 checkpoint commit 寫 `open`、final commit 寫 `final`。已註冊而未 final 的程序／host 遺失時顯示 interrupted，payload 仍為最後 committed bytes。

### 5.2 寫入、查詢與刪除 methods

以下新增 plugin→host methods。所有 write-related RPC 使用獨立 request ID，write handle 才是整筆 identity；重送一個 RPC ID 不建立新的 commit 語意。

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

metadata 內沒有任意 user JSON，list 不含 payload。label 純文字、無控制字元、可為空；以 label 產生 export suggested name 時仍重新安全化，不能作路徑。

### 5.3 CAS、chunks、分頁與取消

一個 record 同時只接受一個 active replacement／delete；有 receiving／sealed write 時第二個 mutation 回 `write-in-progress`。CAS 在 begin 初驗、commit publication gate 下重驗；settings 同樣重驗。新 generation 可以讀 persistent record，但不能接管舊 write。retirement 的特許只限 §8 發給原 generation 的 drain token。

chunk offset 必須等於 receivedBytes，host 以完整 short-write loop 寫入；不准 sparse／overlap。為處理 ack 遺失，只允許「緊接前一個已確認 chunk」以相同 offset、相同 bytes 重送，回相同 receivedBytes，**不延長 idle**；其他重疊回 offset-mismatch。canonical base64 拒絕 URL-safe、空白、缺／多 padding、無效尾端 bits；先檢查 encoded size≤349,528 ASCII bytes，再解碼及檢查實際 256 KiB。每筆串行，跨 write 可並行。seal 後 immutable；checksum 不合留下 failed 狀態並解除可 commit 權，不能只更改 claimed hash。

首次成功 seal 才更新 idle；重複 seal 回同一狀態，不續租。seal 後因 publication 前 I/O 失敗而可重試時，writeStatus 仍為 sealed 並帶 error；terminal failed 僅用於無法再提交的無效 payload。同 principal 的 closeRead 冪等使用 bounded tombstone policy；settings unsubscribe 依 3A `events/unsubscribe` 的 `{removed:boolean}`／tombstone 契約，過期後回 stale，不永久累積句柄。delete 的 tombstone 保存被刪除 revision；120 秒 outcome retention 內以相同 expectedRevision 重送 delete 回原 receipt，之後回 not-found，永不重建 record。

record replacement 在 publish 前舊 revision 可正常 stat/openRead；publish 後新 read 只看到新 revision。對已開 read 的 chunk 使用 pinned old bytes，不能拼出新舊混合資料。read offset 可任意在 0..byteLength，便於重取；offset==byteLength 回空 base64／eof=true，超界為 invalidParams。最大 read response 約 350 KiB 加 bounded envelope，仍低於 1 MiB；256 KiB read budget 指 decoded bytes，不與 list 的 serialized result 上限混淆。

list 首頁複製 bounded metadata snapshot，排序為 `createdAt` 降冪、同時刻依 ID ASCII 升冪。cursor 封裝 owner、generation、filter、limit、snapshot 與下一個 index；後續 params 的 kind／limit 必須與首頁一致。替換／新增／刪除不改已建立 list snapshot；列出的舊 revision 隨後 openRead 可能回 conflict／not-found，consumer 可重新 list，不能自動以新版本冒充。cursor 到期或最後一頁釋放；不以 payload pin 支撐 list。重複請求同 cursor 在存活期內回相同頁；cursor 最後使用後保留到 idle 期限，quota 滿時拒新 snapshot，不無界保存。

每個成功進入 publication 的 write 產生唯一 commitId，新 revision 亦唯一。committed／aborted／expired／terminal failed status 保留 120 秒，最多 64/source、1,024/host；滿額時先移除已到期者，否則拒新 begin，不能淘汰尚需查詢的 status。host restart 不恢復 transient write handle；consumer 以 record ID／revision／hash 對帳。SDK 不自動重播 create、commit、delete 或 settings mutation。

取消在 publish syscall 尚未 dispatch 前撤銷 mutation ticket、保留舊值；receiving temp 清理，sealed 是否暫留依 §8.3。rename dispatch 後不能保證取消，worker 必須完成或將 outcome 標為 unknown。timeout 不釋放 unresolved namespace mutation fence、不允許下一個 mutation 越過它。晚到成功只更新原 ticket／core recovery，不重新授予舊 generation。這亦適用 settings、delete、import marker 與 export。

### 5.4 Flush 與 quota snapshot

`flush` 在 admission 時截取自身 namespace mutation sequence barrier，等待此前已受理的 settings update、record commit／delete 與 import publication 全部確定並完成其 sync policy。它不 seal／commit 任意 incomplete write、不接受未送達 host 的 feature memory；若 barrier 前仍有 receiving／sealed write、checkpoint registration 未 final 或 unresolved I/O，回 `flush-incomplete`，detail 說明 complete-staging／checkpoint-only。單次 10 秒包含排隊，flush 成功才可代表該 barrier 已保存；之後的新 mutation 不在此承諾內。

應先 final commit、結束 checkpoint registration，再 flush。普通 settings/read 沒有磁碟 I/O pending 不須 flush；settings mutations 的成功 receipt 已遵守相同 sync policy。flush 不把 `file-sync-only` 升級成完整斷電保證。

新增 quota value：`{recordCount,reservedCreates,committedBytes,reservedBytes,pinnedBytes,temporaryBytes,sourceLimitBytes:536870912,sourceLimitRecords:256,hostAvailableBytes,writeSlotsAvailable,exportSlotsAvailable}`。所有大小為非負 safe integers。`hostAvailableBytes` 僅顯示剩餘額度，不回其他 source 明細；quota snapshot 是提示，begin 時在同一鎖內重新預約。

record count＝live committed records＋pending create reservations；replacement 不增 record count，但新 payload 全額 reserved。bytes＝live committed payload＋全部 staging reservation，包括 export staging 及 failed-but-retained payload。delete 後釋放 logical record bytes/count，尚被 read pin／unknown commit 保留的實體 bytes 計入 temporary budget。沒有自動刪最舊 record、壓縮、截斷或以新增 checkpoint 擠掉舊 committed data。

## 6. Host/runtime、磁碟格式與 crash consistency

### 6.1 Host ports 與工作分配

新增 `PersistenceHost` 位於 `main/plugins/persistence/`，組合 namespace registry、settings validator、record engine、quota ledger、bounded worker、import coordinator 與 recovery snapshots。runtime 不匯入 Electron／fs；新增 `PersistenceParticipant` 以 §8 ports 接 3B-1 lifecycle。RPC handlers 呼叫同一 host service，core settings／recovery／import adapters 也走同一鎖／quota／commit engine。

新增 `PersistenceFsPort` 封裝受限 open/read/write、file sync、directory sync、atomic replace、statfs、unlink 與 clock／fault hooks。production 不能注入任意插件 path；測試可逐 syscall fail／delay／kill。原始 I/O 及 hash 在專用 worker 執行，main 只做 bounded admission／authority／結果發布；worker task 不持 device lock，stop path 不排在 persistence queue。

host persistence pending requests 再限 32 個／合計已序列化 queued bodies 8 MiB，單 source queued bodies 1 MiB；連同每 source 16 一般 RPC 與 2 staged writes 先達者拒絕。chunk 在 admission 前先查 encoded length，取得 queue reservation 後才 decode；不能先配置大 Buffer 再回 quota error。單 write 的短寫 loop 及 hash 只保留一個 chunk，回應後釋放 body reservation。

profile exclusivity 唯一消費 [3A §7.2／§9](2026-10-17-plugin-system-3a-device-broker-design.md) 定義的 host-only `ProfileWriterLock`，不在本案重定 signature。依 umbrella §2 決策 10，由 desktop integration owner 在任何 journal／persistence／optional feature 初始化前呼叫 `app.requestSingleInstanceLock()`；成功的 primary instance 才將同一 lock port 注入兩個持久化服務。第二次啟動通知 primary 聚焦／還原既有視窗後退出，不啟動另一個 persistence worker／cache 或降級模式。3B-2 不取得第二把鎖、不建立 owner.lock、不新增 flock／LockFileEx addon 或其 packaging dependency。primary 持有 gate 至 cleanup／worker 完成並退出；後續新 primary 先 recovery，再開放 CAS／quota admission。

主程序內 namespace mutations FIFO；全域 quota reservation 用短 critical section，同 namespace 最多一個 publication。慢讀、輸出 dialog、等待 feature、hash 不占 publication gate。publish gate 包含最後一次 owner／generation／drain admission 檢查及 worker dispatch；dispatch 後保留 ticket 至 disposition 明確。無跨筆 atomicity；flush barrier、migration marker 都不是一般 transaction。

### 6.2 新磁碟 layout

```text
<userData>/plugins/                         # 現有 host administration 根
  state.json                               # 現有管理狀態；本案不重用
  persistence-v1/                          # 新增格式根
    namespaces/<sha256(sourceKey)>/
      identity.json                        # formatVersion、sourceKey；不含 executable path
      settings/
        head.json                          # current object／revision／digest／receipt
        objects/<revision>.json            # 完整 Values、schemaVersion、validationDigest
      records/<record-id>/
        head.json                          # live pointer 或 tombstone；metadata＋receipt
        objects/<revision>.bin             # 精確 payload bytes
      staging/<write-handle>/
        intent.json                        # owner epochs、target CAS、size/hash、deadline
        payload.tmp                        # sequential chunks；不屬 committed record
        sealed.json                        # seal 成功的 bounded evidence
      imports/<import-id>.json              # intent／item receipts／complete marker
      recovery/state.json                  # checkpoint registrations／保存故障摘要
      quarantine/                          # 損壞的 head／object，保留實際 bytes
```

`sha256(sourceKey)` 為完整 64 hex；identity 必須與 registry 身分完全一致，不以資料夾名稱 alone 授權。來源移動時沿用既有 host 管理身分規則，不自動依 pluginId 合併；此案不新增 dev source relink 的跨 namespace 授權。

`identity.json`／head／objects／intent 均帶 `formatVersion:1`；未知較新格式只讀保留並回 unsupported-format。head 是 strict bounded JSON，包含 current 的 metadata、object basename、hash、receipt，delete 則 tombstone＋receipt；internal import receipt tag 可選、最多 256 bytes，不公開為可由 plugin 填寫的欄位。head 中不儲存任意 path；object 路徑從驗證過的 ID／revision 組成。

每個 publication 暫時有 `head.<ticket>.tmp`、`head.previous`；後者是上次確認 head 的完整副本，不是另一個 current。settings object 最多 64 KiB values＋4 KiB envelope。recovery state 每 source 最多 2 checkpoint entries、16 fault summaries／每筆 2 KiB；同 target 故障合併。滿額拒絕新可能產生無法追蹤資料的工作，不淘汰 unresolved entry。imports 每 source 2 MiB；其他 metadata、tombstones 與 quarantine overhead 合計上限見 §6.4。

目錄 POSIX mode 0700、檔案 0600；Windows 使用 userData 繼承的使用者 ACL。所有讀取以 descriptor 確認 regular file／大小／identity，不跟隨 symlink 或 reparse point；對新 path ancestors 做相同檢查。不是在共享可寫目錄中允許任意本機程式競爭的 sandbox；外部篡改視為 corruption，不信任檔名或 mtime 重建 revision。

### 6.3 原子提交與 fsync policy

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

### 6.4 Quota、disk-full 與實體空間

logical quota 在記憶體的 host ledger 序列預約，受 core `ProfileWriterLock` 保護，startup 從 validated heads 重建；快取不是唯一真相。每筆 begin 為完整 byteLength 預約，即使尚未收到 bytes。replacement 同時計舊 committed＋新 reservation；達 512 MiB 時可能須先明確刪除資料才可更新，不允許臨時越過 quota。這是保留舊版本的必要空間，UI 在開始工作前展示不足。

除 logical quota，新增 physical temporary budget：每 source 32 MiB、host 128 MiB，用於已替換／刪除但仍被 read/export pin 的 object、publication backup、清理失敗檔案。仍在 staging reservation 內的同一 bytes 不重複計這個 budget；move object 不複製 payload。begin／openRead 預約可能留下的 old revision 空間，不能讓長期 readers 造成無界 retained data。metadata（含 settings、import journal、recovery 與 tombstones）另限每 source 4 MiB、host 64 MiB；host logical records/staging 仍是 1 GiB，另有至多 128 MiB temporary＋64 MiB metadata 的實體空間，符合 umbrella 將原子替換暫存另計的要求。source 的歷史未知檔／quarantine 實體大小按 payload 或 metadata 分類計入對應額度。

available disk 檢查扣除其他已預約實體增量與 16 MiB headroom；這是 admission 提示，`statfs` 不能保證後續別的程式不寫滿磁碟。每次 write／sync／rename／mkdir 仍處理 ENOSPC／EDQUOT。發生 disk-full 立即停止該 pending commit，不刪除舊 head、checkpoint 或原始 legacy data，不用「成功的預設值」掩蓋。sealed payload 可以在剩餘 staging TTL 內重試；未完整 payload 不宣稱可保存。

GC 只刪除經 reference scan 證明無引用且不在 unresolved ticket 的物件。delete tombstone 在沒有 pins、active write、import references 或未到期 outcome receipt 後可清除；ID 永不重用，不需永久累積 tombstones。quota 滿時拒寫，不自動淘汰 user records。磁碟遭外部大量塞檔已超 budget，保留 evidence 並封鎖新增寫入，由 core 明確清理；不能為了回到限制而自動刪損壞資料。

### 6.5 Startup recovery

先確認 core 已取得 3A `ProfileWriterLock`，驗 format／identity／head bounds，再提供 reads／mutations。records metadata 可分批掃描；每次 object 第一次使用及所有 recovery candidates 都驗 actual length/hash，不一次把 1 GiB 讀進 memory。異常 directory／超量檔名亦有有界掃描（每 namespace 最多 4,096 entries）；超出轉 core recovery，禁止無界遍歷或假裝 empty。

| 磁碟狀態                                         | 復原規則                                                                                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 完整舊 head＋temp／孤立新 object                 | 使用舊 head；不採納 orphan。無 unresolved reference 的 temp 清理並重新計額度。                                                                            |
| 完整新 head＋舊 backup                           | 驗 payload/hash、重做所需 sync 後使用新 head；這可代表「commit 已成立但 client 沒收到」。保留先前 checkpoint 的語意，不重播 mutation。                    |
| head 缺失／破損但 head.previous 完整             | 隔離新 evidence；僅復原可驗證的 last confirmed backup，顯示 rollback／interrupted 問題。若是 create 且無 previous，回 unavailable，不能據 orphan 猜成功。 |
| payload hash／length 錯、未知格式、無可驗 backup | 隔離該 record，list／read 明確顯示錯誤或 core issue，不能把整份 history 變成空陣列；settings 不套 defaults 覆寫。                                         |
| staging 尚完整但 hostEpoch 不同                  | 所有 transient staging 失效並清理，不自動 commit；只保證 committed checkpoint。若清理失敗繼續計額度，core 不顯示可 retry。                                |
| checkpoint registration 未 final／owner 已死亡   | retained recovery snapshot 標示 interrupted；沒有重建 reservation、subscription、錄製或設備連線。                                                         |

permission／read-only／暫時 I/O 失敗不是內容損壞；不得先移到 quarantine 再當新 store。quarantine rename 本身失敗亦保留原檔並阻擋寫入。所有 repair actions 透過 core、保留原 evidence；一般 plugin `reset` 不是 corruption repair API。

## 7. 使用者啟動的 export 與 copy

### 7.1 User action port

3B-2 消費 [3B-1 §11.4](2026-10-17-plugin-system-3b1-declarative-ui-design.md#114-lifecycle-participants-與-3b-2-drain-port) 的 host-only `UserPersistenceActionPort`，原樣 type-only 匯入，不重新定義 port。host 透過其 `claim(context, purpose)` 驗證 `context.actionRef` 與原 owner／UI scope 並消耗 proof；purpose 使用該 port 的 `storage.export`／`ui.clipboard`。不接受插件傳入 window ID／`isTrusted`／自行宣稱 user gesture。

capability 從真實按鈕、鍵盤 action 或 core recovery export 產生，有效 5 秒，使用一次後消耗；計時只限開始 export／copy，dialog 的使用者等待由 §7.2 管理。不使用 motor hold 的 350 ms gesture lease 來代表檔案選擇。timer／activation／watch callback／重播 command 不取得此 capability。plugin params 的 `actionRef:Handle` 原樣傳送 3B-1 `CommandInvocation.context.actionRef`；host `claim` 查該 proof，不接受 `invocationId` 代替。`ctx.actions`（新增 SDK accessor）只轉交 actionRef；沒有 user action 的 context 沒有 reference。`invocationId` 僅用於 invocation 去重，不授權 export／copy；同一 actionRef 不可先 copy 再 export 重用。

3B-1 UI v1 的通用 action button 可啟動 export／copy，1.7.0 提供 backend action 契約；3D 才在 UI v2 加上 plain/code text 的 explicit copy 呈現。沒有把新 code/chart component 塞進 v1。權限與使用者 action 缺一拒絕；command ID／record ownership 單獨不足以打開 dialog 或改剪貼簿。

### 7.2 Export methods 與 destination lifetime

新增 export methods 的 result 同 §3；1 source 1 export 含 dialog waiting／writing／publishing，等待不占設備 lock。

| Method                 | Params                                                                                                      | Value                                                                                                                                                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage/exportBegin`  | `{actionRef:Handle,suggestedName:string,mediaType:RecordMeta["mediaType"],byteLength:number,sha256:Sha256}` | `{export:Handle,state:"waiting",expiresAt:number}`。需 `storage.export`；上限 8 MiB；立即回 job，dialog 非阻塞等待。                                                                                                                                           |
| `storage/exportChunk`  | `{export:Handle,offset:number,data:string}`                                                                 | `{receivedBytes,expiresAt}`；chunk 格式／重送規則同 storage/writeChunk。                                                                                                                                                                                       |
| `storage/exportCommit` | `{export:Handle}`                                                                                           | `{exported:true,commitId:Handle,durability:Durability}`；驗完整 length/hash、sync、atomic replace。                                                                                                                                                            |
| `storage/exportStatus` | `{export:Handle}`                                                                                           | `{state:"waiting" \| "receiving" \| "publishing" \| "completed" \| "cancelled" \| "expired" \| "failed",receivedBytes:number,expiresAt:number,commitId?:Handle,durability?:Durability,error?:{code:string,message:string,detail?:PersistenceFailureDetail}}`。 |
| `storage/exportCancel` | `{export:Handle}`                                                                                           | `{disposition:"aborted" \| "committed" \| "unknown",commitId?:Handle}`，不得對已替換 destination 回 cancelled。                                                                                                                                                |

exportBegin 先驗 5 秒 actionRef，消耗後在 core save dialog 顯示 source 與建議名稱；suggestedName 1–80 code points／≤320 bytes，只是 basename，拒 separator、drive prefix、NUL、`.`／`..`、保留系統裝置名，host 做平台安全化，extension 依 mediaType 固定為 json/txt/csv/bin。dialog 產生的真實 path 不回 plugin、renderer logs 或 error detail；SDK 只拿 export handle。標準使用者取消透過成功的 exportStatus value `state:"cancelled"` 表示，不記 save failure。

dialog 在 source 專用 job 中等待，120 秒逾時／window destroyed／retirement 即失效；若 native dialog 不能強制關閉，晚到選取結果丟棄，絕不啟動 I/O。dialog 等待不持有 record lock／payload reservation；選定後再次檢查 lifetime、slot／quota／磁碟，再建立 destination 同目錄 temp 與 30／120 秒 staging lease，job 轉 receiving。所有 export RPC 仍為 10 秒；consumer 最多每 500 ms 查 status，command handler 可在取得 job 後返回，由同 principal 的 SDK task 等待，不被普通 command 30 秒當成延長工作時間。waiting 時 chunks／commit 回 export-not-ready。action proof 在 admission 後由 job 保存，invocation 正常返回不撤 job；explicit cancel／source retirement 仍會撤銷。

host 保存 destination 及當時 file identity，commit 前重查；目的地被外部換成 symlink／different identity 回 destination-changed，重新選取，不先刪原檔。所有內容先進 temp，完整後依 §6.3 policy 替換；磁碟滿或取消在 publish 前保留舊 destination。若平台不能防止敵意同帳號程序在最後 rename 前競爭，記錄為 OS trust 邊界，不宣稱任意外部寫者 compare-and-swap；插件本身仍不能指定目的路徑。

export 使用每 source 1／host 4 個獨立 export slots，不占每 source 2／host 16 個 write slots；暫存 payload 以完整大小計入 source／host reservation，即使實體 temp 在另一個 volume；不增加 record count。失敗 cleanup 未確認時不釋放相應額度。host crash 後外部 temp 可能殘留，不能自動重播 export 或猜測任意外部路徑清理；core 僅顯示失敗提示，user-selected directory 中 bounded temp 由使用者或下次同一明確 export 處理。不得把 absolute destination 寫進 public recovery snapshot。

CSV／JSON 轉換由 feature 在公開 read chunks 後完成，或從其已持有的資料產生；host 不提供 sensor-specific CSV 方法。generic recovery export 可將最後 committed record 的原始 bytes 或尚存的 sealed payload 匯出，必須由使用者在 core 點選，同樣建立新 destination action，不能暗中續用插件失效的 export handle。

### 7.3 Copy

新增 `ui/copyText({actionRef:Handle,text:string}) → {copied:true}`，需 `ui.clipboard`。plain UTF-8、最多 64 KiB／16,384 code points；只寫 text，不讀 clipboard，不接受 HTML／RTF／files／image。主程序驗 actionRef 時間／同 owner／resource generation，消耗 capability 後立即執行；前置取消／失效不改 clipboard。OS write 已執行但 ack 遺失時不能 rollback 或自動重複 copy。

clipboard adapter 失敗回 `PLUGIN_E_STORAGE_IO`／clipboard-unavailable，UI 顯示未複製並保留可選取文本；不自行改成檔案或重試 clipboard。這個分類沿用 1.7.0 persistence action error 範圍，不新增 umbrella 未列的新 business code。文本不寫 logs／notice history／磁碟 staging。

## 8. Checkpoint、drain 與 staging retention

### 8.1 公開 checkpoint／drain 契約

新增下列 methods；checkpoint 是保存生命週期的登記，不是 host recorder。feature 自行決定何時收集／finalize payload，host 永不從 telemetry 重算未提交的資料。

| 方向／Method                             | Params                                                              | Value／效果                                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| plugin→host `storage/registerCheckpoint` | `{id:RecordId,expectedRevision:RecordRevision,reservation?:Handle}` | `{checkpoint:Handle}`；需 `storage.write`，record 必須已存在且尚未 final／interrupted，每 source 最多 2 個。registration 同步持久化 recovery evidence 成功後才 ack。 |
| plugin→host `storage/abandonCheckpoint`  | `{checkpoint:Handle}`                                               | `{record:RecordMeta}`；需 `storage.write`，無 pending write 且相關 reservation 已結束才允許；保留最後 checkpoint 並標 interrupted，不假造 final。                    |
| host→plugin `storage/drain`              | `DrainRequest`                                                      | `{status:"submitted" \| "checkpoint-only",writes:Handle[]}`；writes 最多 2，僅供 host 對帳，不構成保存成功證據。                                                     |

`reservation` 若有值，直接消費 [3A §9](2026-10-17-plugin-system-3a-device-broker-design.md) 的 host-only `ReservationBindingPort`，原樣匯入其型別；註冊以 `validate(owner, reservationId)` 驗證同 source／generation／session 的有效 recording reservation，失敗不登記或保存 binding。3D 在承諾背景錄製前須以 initial committed record 完成 binding。通用非設備背景工作可不帶 reservation，這不建立 device 權限。3B-2 透過同一 port 的 `onEnded(listener)` 消費 ended 通知，依原 owner／reservation idempotently 交給 3B-1 coordinator 結束來源及 drain，不等待保存才釋放設備。validation、持久化 registration 與 ended 到達的競態依 port 的失效規則對帳；ended 若先發生，pending binding 不得回報仍可錄製。這個 port 不在本案重定義，也不取代 `DeviceDrainGrant` 的 final-read 授權。

```ts
type DrainReason =
  | "disable"
  | "reload"
  | "remove"
  | "provider-loss"
  | "renderer-crash"
  | "window-destroyed"
  | "shutdown"
  | "update"
  | "safe-mode"
  | "suspend";
type DrainRequest = {
  token: Handle;
  reason: DrainReason;
  remainingMs: number; // 0..10_000；host monotonic deadline 才是權威
  checkpoints: Array<{ checkpoint: Handle; record: RecordMeta }>;
  writes: Array<{ write: Handle; id: RecordId; state: "receiving" | "sealed" }>;
};
type DrainReport = {
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
```

report records 最多 2、errors 最多 16、整體 8 KiB；不含 payload／paths。`saved` 要求所有已登記工作有 final receipt、所有先前受理的 settings／commit 已確定、flush barrier 成功；process 回「submitted」或 `deactivate` resolve 都不能單獨使它成立。沒有 checkpoint／pending mutation 的 idle source 可立即 saved。state≠saved 時 blocker=true，除非使用者明確 discard／接受 checkpoint-only 的資料損失；這個決定保留在 recovery evidence。retryable 才列出有期限的 retryAction 選項，實際點擊由 3B-1 建立 CoreActionReference；unknown 先對帳，不能用 retry 再 publish。此 report 是 host-only，不能經 plugin result 洩漏 core action。

drain callback 使用獨立 cancellation signal／async task，不沿用已 abort 的一般 command signal。只可對 request 中的 checkpoint target 做一次 final replacement，或完成 request 中已開始的 write；不得 create 新 record、任意改 settings、delete、export、copy 或重新取得 recording reservation。`beginWrite` 與 `commitWrite` 必須帶 token；後續 writeChunk／sealWrite 的 handle 已綁 token，逐次查其期限。payload 仍受 8 MiB、2 slots、既有 reservation／120 秒上限；drain 不提高 quota。

若 final 前有正在提交的 checkpoint，先對帳並完成它，再用其已確認 revision 做 final CAS；deadline 不重算。同 record 的舊 write lock 釋放前不能預傳另一個 replacement，第二個 slot 只能用於另一個已登記 target；沒有 bypass。feature 應在平時避免接近 drain 才傳首份大 record。

final commit 自動關閉 checkpoint registration。registration recovery entry 的清理可落後 final head；startup 以 matching final head receipt 判斷完成，不因清理失敗誤認正在錄製。反向情況禁止：不能先刪 registration 再寫 final。abandon 是明確接受只保留 checkpoint 的工作結束，不是將未知 commit 標成功。

### 8.2 提供給 3B-1／3A 的 host-only ports

新增 `PersistenceParticipant` 的內部方法如下；輸入 principal 使用 umbrella 已定的可信 identity，沒有插件自報版本。正式型別放 3B-2 自有 runtime port module，由 3B-1 manager type-only 匯入；它是唯一 persistence lifecycle interface，coordinator 直接使用它。

```ts
interface PersistenceParticipant {
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

`PersistenceOwner` type-only alias 3A 的 `ResourceOwner`，含 sourceKey、pluginId、generation、hostEpoch、processEpoch，從 principal 查同一 registry；不另產生身分。`DrainOffer` 保存 immutable owner、reason、monotonic deadline、一次 token、最多 2 checkpoints、先前 accepted ticket set；`DrainDispatcher` 只封裝向原 process 傳 `storage/drain`。`CoreActionReference`／`CoreWindowScope` 只引用 [3B-1 §13.1](2026-10-17-plugin-system-3b1-declarative-ui-design.md) 的正式型別與 scope 驗證，不在本案重定 shape 或另收 actionToken／scope 參數；普通 plugin actionRef 不能取得 core 管理權。

retirement → device／storage reason 的唯一 mapping 由 [3B-1 §11.4](2026-10-17-plugin-system-3b1-declarative-ui-design.md#114-lifecycle-participants-與-3b-2-drain-port) coordinator 表定義，包含 remove 與 suspend；本案直接消費該表，不另投影或改寫 sibling enum。`DrainReason` 是 storage wire 的正式 enum；plugin crash 走 ownerLost，不虛構 drain callback。

`PersistenceRecoverySnapshot` 為最多 16/source、64/host 的 bounded fault summaries，每筆包括 source display identity、record ID、last committed revision、DrainReport state、是否仍有完整 payload、expiresAt 及允許的 retry/export/discard actions；不含路徑／record 內容。超額拒絕新相關背景工作，保留 unresolved 問題，不與 3A safety fault journal 共用容量。view 由 3B-1 擁有；3B-2 不在 manager／renderer/app 加 feature 分支。

使用 [3A §9.2](2026-10-17-plugin-system-3a-device-broker-design.md#92-lifecycle-participant-與-drain-port) 的 `DeviceResourceParticipant`／`DeviceDrainGrant`，型別原樣引用。3B-1 coordinator 先同步呼叫 `DeviceResourceParticipant.retire(owner, deviceReason)`，將回傳的 `.drain` 傳入 `freeze(owner, storageReason, deadline, deviceDrain?)` 第四參數；`.drain === null` 時省略該參數，不 await `.settled` 才 freeze。retire 已阻擋新 samples／reservation continuation，grant 保留 3A 定義的原 owner／reservation／最後 sequence／期限。3B-2 token 將這份 grant 與已登記 record 綁定，deadline 取兩者最早。健康原 process 可在 grant 內對同 reservation query/read 最後樣本，不能 reserve 新工作；host router 驗證關聯，不要求 devices wire 自報 grant。process crash 沒有原 process 可讀 ring，只保證 checkpoint。保存不用持有 device lock。3B-1 將 broker report 與 persistence report 合併成 close/update blocker，不以其中一者 saved 覆蓋另一者 unconfirmed。

freeze 前已由 host 收到的普通 settings／record commit 可由 host-owned completion ticket 完成，該 ticket 固定 payload／target CAS，與 drain token 同享 10 秒 admission fence；原 process 不能替換其內容。未 commit 的普通 receiving／sealed writes 若不在 offer accepted set，不允許 retirement 後繼續。新 generation 在舊 ticket outcome 未定前不得寫同 namespace。

### 8.3 時間線與 retention 規則

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

### 8.4 對齊 umbrella 生命週期矩陣

panel hide／close、window blur／hide／minimize 不觸發 Lab drain，僅撤與 view 綁定的 reads／watches；background checkpoint registration 保留。window destroyed／最後視窗關閉、feature disable／remove／reload、provider loss、renderer crash、shutdown／update、OS suspend 走 coordinator mapping 的相應 drain；plugin crash 走 ownerLost，不呼叫不存在的 handler。provider 恢復／重新啟用／reconnect 不續錄。safe mode 不啟動 feature／mapper／watcher，但 core 可以顯示持久化 recovery evidence，並由使用者明確 export last checkpoint。

依 umbrella §2 決策 12，使用者的 Disconnect 是 core 的單一操作：3B-1 coordinator 顯示停止／保存進度，3A 要求 motor stop/readback 並結束 recording admission，3B-2 完成已登記 record 的 final commit／flush，兩邊 disposition 確認後才斷線。保存或 stop 未確認時保留 blocker／retry／明確 force 決策，不先顯示成功或斷線。reservation ended 通知經 `ReservationBindingPort` 接入，同一 owner 的重複通知與 retirement 合併，不再產生第二段 drain。plugin 的 `devices/disconnect` 仍由 3A 拒絕另一 owner active work 的 busy，不能呼叫 core force 路徑。

依 umbrella §2 決策 13／§4.7 suspend row，OS suspend 時停止背景錄製並走 `DrainReason:"suspend"` 的 bounded drain／save，同時由 3A 要求 motion stop；wake 不自動重建 reservation／錄製／motion。OS 不保證留足 10 秒，來不及完成時只承諾最後 committed checkpoint，保留 interrupted／save fault；resume 先對帳已 dispatch 的 I/O，不續期舊 token。正常 panel hide 與此情境分開。

依 umbrella §2 決策 14，三個 optional builtins 預設 enabled，普通使用者可在 plugin settings 各自切換，無須 developer mode。停用 values／records 保留，watcher 撤銷、core recovery 留存；重新啟用不自動續錄，也不將 enable 狀態寫入公開 feature settings。

健康系統的 Lab 5 秒 checkpoint 由 3D 排程；任何 save failure／超時應停止錄製並暴露 core fault。host 不保證在任意 I/O 故障下只丟 5 秒資料，亦不以 storage.flush 成功推論實體馬達已停止。

## 9. 一次性 legacy import framework

### 9.1 邊界與 allowlist

新增 host-only `LegacyImportCoordinator`，只支援 umbrella 指定的三類 source：`userData/sensor-lab`、`userData/device-settings.json`、可信 workbench 擷取的 renderer preferences。公開 plugin RPC 不提供 listLegacy／readPath／importFromPath；builtin 身分本身亦不授予任意路徑。legacy resolver 由 host 固定 root，input 不是插件 manifest 的可執行 migration script。

3D／3E 各交付純資料 mapping descriptor 與 pure validator／mapper module，由 host allowlist 編譯進 app。新增 `LegacyImportDescriptor` 包含 `id`（namespaced，≤128 bytes）、`mappingVersion`、`targetSourceKey`（host 綁定）、`sourceKind`、source format versions、target settings／record schema versions、renderer key allowlist（如適用）、`validate(input)`／`map(input)`。函式只在可信 host adapter 內使用，不是 wire schema、沒有 fs／devices／UI／network access；輸出仍進正式 validator／quota／CAS 引擎。

3B-2 提供 synthetic descriptor 驗證機制，不在本規格決定 Lab record fields、calibration transformation、EV3 key 名稱、預設合併或 remembered address 保留策略。3D／3E 必須使用原始 bytes／raw values 做 mapping fixtures，不能因現行 loader 已退 defaults 而丟失判斷原值是否損壞的證據。

### 9.2 輸入取得與限制

| Legacy source        | Host 取得方式／限制                                                                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sensor-lab files     | 固定 `recordings/`／`calibrations/` 下 regular JSON，UUID basename；以 fd bounded read≤8 MiB，不跟 symlink／reparse point，保留原 bytes 與 SHA-256。一次只轉換一筆，不載全部 history。                |
| device-settings.json | 固定 basename，raw JSON≤64 KiB；parser 不 coercion、不默默忽略語意錯誤，逐欄取捨由 3E mapper 定義。                                                                                                   |
| renderer preferences | host 在既有 settings bootstrap 發單次 nonce，可信 main-frame workbench 只回 allowlist 的 `{key,raw:string\|null}`，≤128 entries／64 KiB；storage getItem 例外與 absent 分開。此 bridge 不進公開 SDK。 |

renderer 回覆需匹配 window／bootstrap epoch／nonce，主程序再次過 allowlist、型別與 bytes 驗證。不得接受 plugin process 自填的 preferences；不得掃描或複製整個 localStorage。收到 snapshot 後先持久化其 digest／raw evidence 到受限 import journal，nonce 消耗；如果沒有 renderer 或尚未回覆，狀態是 pending，不是「無舊設定」。snapshot 中 null 表示該 allowlisted key 確認不存在。

core reader 在所有相關 legacy writers 停止後取得 snapshot；3D／3E 切換 adapter 在 import barrier 期間禁止雙寫。renderer 重載／來源在讀取期間改變時重新擷取整份 evidence，不能把兩個時間點拼成成功版本。safe mode／feature disabled 不執行 feature mapping，僅保留 pending／failed 概況；重新明確啟用才恢復。

### 9.3 可重入狀態機與 marker

import identity＝host allowlist 的 import ID＋mappingVersion＋target namespace；source digest 是 evidence，不是每次變更就重新 import 的觸發器。新增 journal 狀態：`pending → planned → copying → complete`，失敗進 `blocked` 並保留可恢復的前一階段。missing source 在 trusted resolver 確認不存在後可標 `complete-empty`；permission／未取得 renderer snapshot 不能當 missing。

1. **Prepare。** 取得 namespace import barrier，確認沒有使用者 mutation／active checkpoint；讀取完整 bounded inventory（最多 4,096 candidate names，超過報 limit，不忽略剩餘檔）。建立 source fingerprint、descriptor version、target schema digests 與逐項 plan。每批 64 items；journal 總共最多 512 items／2 MiB，超過停止並保留 originals。
2. **Plan durability。** 每項分配 host-generated destination ID 或 settings target、expectedRevision（首次通常 null）、source digest／mapped digest／狀態；先原子保存 planned journal，再做 destination write。public caller 仍不能選 ID；這是 host import engine 的內部 operation。
3. **Validate／copy。** mapper 驗原格式與語意，再驗 target；單筆經相同 chunk／hash／quota／CAS primitive 提交，head 同時附 internal import receipt tag。settings 用完整 Values snapshot，records 保留原資料語意但實際 mapping 由 owner 負責。原檔從不移走／覆寫。
4. **Receipt。** item commit 後原子更新 journal receipt。若在此之前 crash，重跑讀既定 destination ID／internal tag／digest，辨識已提交，不 create duplicate 或覆蓋更新過的資料。head 與 tag 是同一原子提交，不靠「label 相同」判斷。
5. **Complete marker。** 所有 required items 都有可驗 committed receipts，或使用者在 core 明確接受逐項 skip 且 journal 保存原因，才寫 complete marker、sync，之後才釋放讀取切換 barrier。complete marker 包含 input fingerprint、mapping version、target revisions／hashes、skipped／missing counts；不用跨筆 transaction。
6. **Switch。** 3D／3E consumer 從新 store 讀取，legacy adapters 停止作 authoritative reads／writes。originals 保留，本階段不做自動 retention cleanup。重啟看到 complete 不再根據舊檔仍存在而 import；之後使用者刪除新 record 也不會使舊檔復活。

copying 中的 records 可由 core 以進度／receipt 檢視，feature 不以半套來源作正式 history 或 settings；完整 marker 前保持 import-pending。單筆失敗不 rollback 已提交項，也不隱藏它們；core 顯示成功數／失敗數、originals 仍在，提供 retry、檢視證據及明確 skip。沒有使用者 skip 時，損壞資料會阻擋完成，不報「成功遷移空資料」。跨筆 transaction 不在此機制中被暗中承諾。

若 source 在 planned 後 fingerprint 改變，停止並顯示 input-changed，重新擷取／重建 plan 前保留舊 receipt；不把不同 inputs 寫入同 destination。若 destination 已存在且不是 matching import receipt，或被使用者改過，回 revision conflict；不預設以 legacy 蓋掉新資料。需要人工選擇的個別匯入衝突在 runtime core UI 解決，不是本設計留下未定 API。

### 9.4 Schema 升降版與失敗相容

store format version、settings schemaVersion、record schemaVersion、import mappingVersion 分開。更換 mappingVersion 不自動重跑已 complete 的一次性 import；後續修復需新的明確修復流程／使用者動作，不能以升版偷偷再拷貝 originals。schema upgrade 使用 settings/migrate 或 record replacement；較新資料交給舊 app 時明確 unavailable，originals／new store 都保留。

import journal format／target version 不支援、quota 不夠、磁碟滿、marker save failure 均保持 blocked，不能切回雙寫舊 store 或先標 complete。descriptor 不能放寬 host record／frame budgets；50 筆最大 Lab records 的實測 migration 須分 chunk／批次，原始 schema semantics、校正 float32 與 source/unit mapping fixtures 由 3D 提供。

## 10. 失敗矩陣與 fault injection

新增 `PersistenceFaultPoint` 測試 hook 在真正 I/O adapter 邊界注入：`reserve`、`open-temp`、`chunk-write`、`seal-sync`、`object-rename`、`object-dir-sync`、`backup-head`、`head-write`、`before-publish`、`after-publish`、`head-dir-sync`、`cache-publish`、`receipt-send`、`cleanup`、`import-marker`。每點支援 fail-on-N、短寫、pause/resume、程序 SIGKILL／平台等價終止；fake clock 只能測期限，不能取代真實 kill-and-reopen。

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

每個 injected result 同時檢查 wire outcome、disk tree／hash、quota ledger、handle registry、core snapshot，並在新 hostEpoch 重新打開。真正 publish 前後的強制退出以子程序執行，避免把 Promise rejection 當 crash 模型。模型中的 fsync frontier 測試可模擬遺失未同步內容，但不宣稱等同所有硬體斷電。

## 11. 安全、JS／Python SDK 與相容性

### 11.1 安全邊界

- host 由已驗證 channel 決定 source／principal，所有 params 不含 owner override；持久 namespace 不因 execution restart 改名，pending handles 必須失效。
- `settings.write` 不改 disabled／safe mode／developer mode／Python executable；records 不提供 path／directory traversal；不從 record payload 載入 module 或執行程式碼。
- settings labels、record label、error text 均純文字；export name 不帶任意 extension/path；copy 需要單次 action。原值／payload 不進 diagnostics／log，也不以 error.detail 反射秘密。
- source quotas、temporary budget、schema bytes、句柄數與 deadlines 都由 host 固定；manifest 無法提高。不使用 `fs.watch` 當 committed change 的來源，watch 由 commit engine 發布。
- settings 與 records 都不是 secret store，不加密也不承諾防本機同帳號程式。Node／Python process isolation 不是 OS sandbox，manifest permissions 僅限制公開 API；此信任界線與主規格一致。
- single-instance gate／filesystem adapter 屬 core；第三方 consumer 不註冊 adapter、mapper 或 provider。cold safe mode 仍能以 core recovery 讀自己管理的持久化證據，不載入插件程式。

### 11.2 SDK surface 與 parity

JS 在既有 `PluginContext` 新增 `settings`／`storage`，在 `ui` 新增 `copyText`；新增 `PluginDefinition.drain?(context)` 與 request 方向檢查。Python 在 `CommandContext` 及 plugin 可用的 host context 新增同等 objects，新增 `@plugin.drain` async handler。此 callback 在既有 shutdown 前執行，不能只套在 JS deactivate；兩者 timeout／取消與 host gate 完全相同。

| Wire                                                    | JS method                                                                        | Python method                                                                          |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| settings read／update／reset／watch；events/unsubscribe | `ctx.settings.read/update/reset/watch/unwatch`                                   | `ctx.settings.read/update/reset/watch/unwatch`                                         |
| settings migration                                      | `readMigration`、`migrate`                                                       | `read_migration`、`migrate`                                                            |
| begin/chunk/seal/commit/status/abort                    | `ctx.storage.beginWrite/writeChunk/sealWrite/commitWrite/writeStatus/abortWrite` | `ctx.storage.begin_write/write_chunk/seal_write/commit_write/write_status/abort_write` |
| stat/list/open/read/close/delete/flush/quota            | `stat/list/openRead/readChunk/closeRead/delete/flush/quota`                      | `stat/list/open_read/read_chunk/close_read/delete/flush/quota`                         |
| checkpoint                                              | `registerCheckpoint/abandonCheckpoint`                                           | `register_checkpoint/abandon_checkpoint`                                               |
| export                                                  | `exportBegin/exportChunk/exportCommit/exportStatus/exportCancel`                 | `export_begin/export_chunk/export_commit/export_status/export_cancel`                  |
| copy                                                    | `ctx.ui.copyText`                                                                | `ctx.ui.copy_text`                                                                     |

`settings.unwatch` 僅包裝 `events/unsubscribe` 並回傳 `{removed:boolean}`；沒有 `settings/unwatch` wire method。

SDK methods 使用單一 params object／dict，wire keys 都保留 camelCase；snake_case 只改 Python method 名稱。readChunk／writeChunk 的低階方法保留 base64；可另提供純本地 helper 將 JS `Uint8Array`／Python `bytes` 轉 canonical base64，但不增加 host capability 或無界 buffering。完整 record helper 必須逐 chunk、遵守 slots、在退出時關閉 read／abort 未出版 write；不得自動 retry mutation。

business result 在兩 SDK 都保留 `ok/value/error` 結構；只對 transport／numeric envelope failure 使用現有 RpcError，不把 business detail 壓成字串。JS optional `AbortSignal` 與 Python task cancellation 都送取消 request，沒有 rollback 保證；drain 有獨立 signal/task，普通 cancellation 不先關掉所需 outgoing RPC channel。

Python 目前 [`_schema.py`](../../../sdks/python/kobrixa/_schema.py) 使用 bundled JSON Schema 與限定 keyword set，沒有產生式型別。正式 schema 必須維持可匯出；`additionalProperties`、`anyOf`／`oneOf` 等結構檢查走共用 schema；distinct keys、UTF-8 bytes、base64 canonical form、range/default 跨欄位、quota／CAS 走明列的語意 validator。新增 schema keyword 若必要須由 protocol owner 同步 supported-keywords 與 Python validator，不手修 bundled schema。

JS／Python 必測 boolean≠integer、1 與 1.0 的 JSON number 相容、safe integer 邊界、-0 按 JSON number 0 處理、NaN／Infinity、emoji、unpaired surrogate、UTF-8 與 JSON escaping 後 frame 大小差異。Python 的 ASCII escaping 可能讓 wire 大於 decoded value bytes；兩 SDK 都在實際 serialization 後驗 1 MiB。合法 values 64 KiB、chunks 256 KiB 不代表可忽略 envelope limit。

### 11.3 發布與舊版相容

protocol integrator 在 1.6.0 基底加入所有本案 schema／methods／permissions／errors，一次升 `PLUGIN_API_VERSION`、JS `API_VERSION`、Python `API_VERSION` 與 schema `$id` 至 1.7.0。使用現有 [`export-schema.mjs`](../../../packages/plugin-protocol/scripts/export-schema.mjs) 從 Zod 產生 protocol 及 Python bundled schema，不手改 JSON。package version、UI v1、settings format1、storage format1 不跟著冒充 API minor。

1.4／1.5／1.6 consumer 保留原 command／initialize 形式，不收到 storage/drain 或 settings notifications；沒有 storage registration 就由 host 完成零工作 drain。1.7 consumer 宣告新 permissions／能力後才收到新方法。UI v2／Lab 的 1.8.0 由 3D 發布，不由本案搶用。unknown methods、resource version、data version 分別回正確層級錯誤，不能因 loose manifest 接受未知欄位就宣稱功能可用。

## 12. 測試計畫、conformance 與 MANUAL

### 12.1 自動化與邊界 fixtures

新增共用 fixture family `settings-storage-v1`，由 protocol integrator 持有正式 conformance；各 task 自備 unit fixtures，不跨寫別人的 mocks。每個 fixture 記錄 input、有效／無效、預期 numeric 或 business code／reason、permission、lifetime 與最終 persisted hash。至少包含：

1. 每種 setting type、mixed enum（1 與 "1" 不混淆）、dotted key↔LocalId／option ID map、stale map 拒絕、defaults／reset、128 keys 與 129 keys、schema／values 64 KiB 邊界、單字串 4 KiB 邊界、未知欄位／重複鍵、危險 key segments、非法 default／range、相同版本變更語意、upgrade／downgrade、損壞檔。
2. 0 byte／8 MiB／8 MiB＋1 records、256／257 筆、source 512 MiB／host 1 GiB 邊界，replacement double reservation、2／3 staging、16／17 host staging，另同時允許 source 1／host 4 exports 而不占 write slots、僅加 bytes reservation，scratch／metadata budget、50 最大 Lab-size synthetic records。
3. 256 KiB chunk 與＋1、base64 padding／尾端 bits、short writes、chunk ack 遺失重送、seal hash mismatch、雙 commit 相同 receipt、取消／timeout 前後 publication、delete CAS、openRead pin、固定 list snapshot／到期。
4. watch baseline 與 commit 競態、events/unsubscribe removed=true／tombstone=false、無 settings/unwatch wire alias、sequence gap、validation＋bounded enqueue 後 ack（slow callbacks 不延遲 ack）、disable／reload／crash／safe-mode 後舊 owner 回覆；core errors 不依賴事件成功送達。
5. §10 每列 failure injection，包括兩次 app 啟動時 primary 聚焦／secondary 在 store 初始化前退出、primary kill 後新 primary recovery、Windows replace conformance、file-sync-only receipt、unknown 對帳與 GC 不刪 active data。
6. drain 的所有矩陣事件、ReservationBindingPort validate／onEnded 競態與同 owner 檢查、DeviceResourceParticipant.retire().drain 原樣傳入 freeze 第四參數、停止來源先於 final、callback hang、完整 sealed／未收到尾端分別呈現、30 秒 idle／120 秒 total、10 秒 drain／4 秒 process bound、與 3A 15 秒 stop＋5 秒 journal 並行、24 秒 cleanup／25 秒 outer net、Disconnect 先 stop/save 再斷線、suspend 停存與 wake 不續錄、取消 close 後不恢復舊 handles。
7. import crash 位於每個 item commit／receipt／complete marker 的前後；重跑至少三次 records 數／ID／bytes 相同；source 改變、target conflict、missing／permission 分別處理，originals byte-for-byte 不變，renderer nonce／allowlist 負例。
8. export cancel／foreign actionRef／以 invocationId 冒充／過期／重播、native dialog 晚回覆、無 device lock、磁碟滿／destination race；copy 超量／無 action／OS fail；所有錯誤不洩漏路徑或 raw values。

JSON Schema 與兩種 SDK 必須跑相同 wire 正反例；另外啟動真實 JS MessagePort consumer 與 Python stdio consumer，經正式 router 執行 settings→watch→CAS conflict→record chunks→paging→export/copy mocked host action→drain。不可只測 TS wrapper 或讓 Python 呼叫私有 test service。1.4.0 legacy fixture、1.6.0 fixture 與1.7.0 consumer 同時跑 negotiation。

### 12.2 最大合法資料量與性能門檻

T0 固定量測環境欄位：OS／architecture、CPU／RAM、filesystem、app artifact／commit、Node/Electron、fixture bytes／records、warm/cold、30 次樣本的 p50／p95／max、main/worker RSS。不能用實測慢就單方面放寬 umbrella budgets。

| 工作負載                                                      | 通過門檻                                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 128 keys／64 KiB values，通用設定頁 16 fields                 | 本地 draft 更新 p95≤50 ms；切頁 p95≤100 ms；save 有 busy／error 狀態，不阻塞 input。                                           |
| 50×8 MiB records 的 list／256 KiB read，4 個 persistence jobs | warm metadata list p95≤200 ms；main 單段同步工作≤16 ms；peak 額外 main RSS≤32 MiB、worker RSS≤64 MiB，不常駐 400 MiB payload。 |
| 最大 8 MiB replacement／final commit                          | 在指定 local SSD fixture 下單 commit／flush≤10 秒；超時回誠實 outcome／blocker，不能無限延長。                                 |
| storage 壓力與 3A safety path 並行                            | persistence 引入的 stop dispatch 額外延遲 p95≤50 ms；不串入 device foreground queue。這不是實體 stop/readback 時間承諾。       |
| import 50 最大 records＋settings                              | streaming peak 記憶體符合上述限制；每 item 前後可恢復、每批回應進度；不設以刪資料換取完成時間的捷徑。                          |

執行受影響的 protocol／runtime／SDK／desktop tests、schema drift、Python tests、typecheck／lint／format，並接既有 plugins／settings／Sensor Lab smoke 的相容檢查。可用命令包含 `pnpm --filter @kobrixa/plugin-protocol schema`、`pnpm test:python-sdk`、`pnpm check:desktop`、`pnpm test:desktop`；新增 fault／public storage smoke 的精確入口由 plan 配給唯一測試 writer。只跑必要範圍後整合共用一次結果，不將未跑完整 smoke 寫成全通過。

### 12.3 MANUAL 驗收

以下結果由實作者在後續 report 逐項填證據；本設計不代簽。每項記錄 app artifact、平台／filesystem、操作步驟、觀察結果與未測限制。

| ID     | 必要人工操作                                                                                                                                                                                                           |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B2-M01 | en／zh-TW、light／dark、320 px 側欄／125% scale，鍵盤遍歷 settings controls、help／error accessible names、套用／重設／衝突 draft 保留；無 feature process 也可理解 core 保存錯誤。                                    |
| B2-M02 | 真實磁碟滿／不可寫目錄，settings 不假成功；record 舊版可讀，retryable payload 倒數消失後正確轉 checkpoint-only；明確 retry／discard 及正常 close blocker。                                                             |
| B2-M03 | 已安裝 app 中 export save dialog：取消、替換既有檔、無權限、目的地變更、window destroyed；CSV 由 feature 產生，destination 不外洩。clipboard 實際貼上精確純文字。                                                      |
| B2-M04 | 真實 plugin／renderer kill、強制退出與 cold safe mode；最後 committed checkpoint 可查、沒有重新錄製／連線；三 optional features 全關仍有 core recovery/export。                                                        |
| B2-M05 | 複製舊 userData 與 renderer preferences，在實際升級流程 import；中途終止再啟、originals 保留、完成後不重匯；3D／3E 各提供真實 mapping 結果，不由 synthetic fixture 代替。                                              |
| B2-M06 | 每個實際交付 OS／architecture 的 packaged app、無 checkout／外部 Node：第二次啟動聚焦／還原既有視窗後退出，沒有第二個 persistence worker 或 native lock addon；JS feature 與 Python dev fixture parity；未測平台明列。 |

硬體 motion／停止確認由 3A／3C／3E MANUAL 負責；本案儲存驗收不代表設備安全驗收。umbrella 及 stage-2 V01–V04 的未完成項保持原狀。

## 13. 現行程式遷移與文件更新

先新增通用 persistence 模組、synthetic source／兩 SDK fixture，再由唯一 integrators 接正式 registry／router／UI／lifecycle。3B-2 不為方便 fixture 把 `SensorLabService` 留成永久 host service，不讓 feature 匯入 `main/plugins/persistence` 或直接 fs。

| Owner                      | 遷移工作與順序                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 3B-2                       | 新 settings/resource reader、record engine／FS adapter、quota、user actions、import coordinator、recovery／drain ports。舊 stores 保留供 3D／3E mapping fixtures 比對。                    |
| 3B-1 runtime／UI owners    | manager retirement／supervisor shutdown 之前接 drain，保留 channel 至完成；通用 settings form、可信 user action、core failure/retry view，safe mode 在 catalog 前生效。                    |
| Desktop integration owner  | `main/index.ts` 註冊 persistence factories／worker，close/update 同時等待 broker 與 persistence；正式 IPC 只加 generic trusted adapters。3B-2 交 patch 契約，不自行改 hotspot。            |
| 3D                         | Lab mapping、feature recorder／CSV、checkpoint registration、每 5 秒 commit、final drain、interrupted recovery；完成後移除私有 Lab service/store／export IPC authoritative 路徑。          |
| 3E                         | Device preferences 與 renderer connection preference mapping、公開 settings consumer／watch，commit 後套用 provider policy；移除相應舊 private settings callbacks，保留其他 legacy pages。 |
| Renderer integration owner | 接 contributed settings host／import snapshot bridge；在 mappings 可用後移除 device-only legacy 接線，沒有兩個 authoritative stores。                                                      |

實作時新增雙語 `docs/en/plugin-settings-storage.md`／`docs/zh-TW/plugin-settings-storage.md`，包含完整方法、limits、錯誤、namespace 信任、CAS／timeout、durability、user export/copy 與 JS／Python 範例。更新雙語 architecture／roadmap、samples 與相關 settings 說明。3D 更新雙語 sensor-lab 的 background／checkpoint／migration／CSV；3E 更新 device／設定文件及 exception ledger。雙語使用說明與 smoke 同時記錄 umbrella §2 決策 10 的第二次啟動聚焦、決策 11 的 pane／tab 行為、決策 12 的 Disconnect 停／存進度、決策 13 的 suspend 停存且 wake 不續錄、決策 14 的一般使用者開關；決策 15 的 file-transfer 10 秒由 3A 設備文件負責，persistence 不另改。文件需清楚區分「有 host payload 可在期限內 retry」與「只剩 checkpoint」，不說 crash 可恢復全部記憶體資料。

## 14. 平行實作切分與 T0 freeze step 3

### 14.1 T0 序列凍結

本節是未來實作計畫的分工，不要求本次撰寫規格啟動實作或其他 agents。遵循 umbrella §7：3A 先凍結 identity/result/event／broker ports；3B-1 接著凍結 UI v1／action/lifecycle／recovery；**3B-2 第三步**凍結本文 settings schemas、methods、reason enums、quota／CAS／paging、disk format／sync policy、staging TTL、export／copy、import／drain ports、10 秒 drain／4 秒 teardown／15＋5 秒 device disposition 與 25 秒 attempt 時間線、最大 fixtures。

T0 產出為正式 types/signatures、fixture 正反例清單、每檔 ownership／handoff、branch point、core ProfileWriterLock 接線與 filesystem adapter contract、byte／deadline／performance gates。scaffold 如有，逐檔記錄並交接後停止寫入。不得把不同 sibling type 複製成近似 DTO；使用 protocol/runtime 的 type-only import／re-export。這份設計不修改 sibling spec；共同 ports／reason mapping 原樣引用各 owning spec 的正式型別，T0 不另造近似命名或改語意／limits／版本。

### 14.2 互斥 write sets

下表為 T0 後可並行工作；所有「新增」模組及其直接 unit tests／mocks 由同一 task 獨占。existing hotspots 僅由 umbrella 唯一 owner 合入。plan 再列出逐檔清單；未列共用檔、package manifests、lockfile、CI 由 umbrella §7.2 integration owner 先指派唯一 writer，不能自行跨界。`main/plugins/persistence/**`（包括 lifecycle.ts／recovery-port.ts）僅屬下列 B2-T2–T5；3B-1 的 main/plugins controllers／adapters write set 不涵蓋此 subtree。

| Task                                                  | 唯一 write set                                                                                                                                                                                                                                                                  | 交付／依賴                                                                                                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B2-T1 Protocol／SDK modules                           | 新增 `packages/plugin-protocol/src/settings.ts`、`storage.ts`、`persistence-actions.ts`、`persistence-validation.ts`；新增 JS `src/settings.ts`／`storage.ts`／`persistence-actions.ts`、Python `kobrixa/_settings.py`／`_storage.py`／`_persistence_actions.py` 及其直接 tests | 完整 schema／validators、低階 SDK clients；依 3A／3B-1 T0 envelopes。正式 shared exports／versions／conformance 交 protocol integrator。                                                      |
| B2-T2 Disk engine                                     | 新增 `main/plugins/persistence/{filesystem,namespace,atomic-store,quota,recovery-scan,worker}.ts` 及直接 tests                                                                                                                                                                  | 消費 ProfileWriterLock、layout／sync／CAS／streaming／GC／fault adapter；依 T0，先 fake principal，正式接 T1。只管 bytes／commit，不管 Lab。                                                  |
| B2-T3 Settings service／forms adapter                 | 新增 `main/plugins/persistence/settings-service.ts`、`renderer/settings/contributed-settings-store.ts`／`contributed-settings-form.tsx` 與直接 tests                                                                                                                            | schema catalog／watch、generic form adapter／draft／CAS UX；依 T1/T2 與 3B-1 forms port；不改 settings-panel.tsx／app.tsx。                                                                   |
| B2-T4 Storage handlers／actions／drain                | 新增 `main/plugins/persistence/{record-service,actions,lifecycle,recovery-port}.ts`、`packages/plugin-runtime/src/persistence-participant.ts` 及直接 tests                                                                                                                      | RPC handlers、export/copy／drain／checkpoint／core snapshot；依 T1/T2、3A reservation port、3B-1 action/lifecycle。                                                                           |
| B2-T5 Import framework                                | 新增 `main/plugins/persistence/import-{coordinator,journal,sources}.ts`、synthetic mapper fixtures 及直接 tests                                                                                                                                                                 | 一次性 import、renderer snapshot DTO／nonce；依 T1/T2；真實 mappings 交 3D/3E，不改 feature modules。                                                                                         |
| B2-T6 跨層驗收／文件                                  | 新增 `tests/desktop/plugin-persistence-*`、`tests/desktop/fixtures/plugin-persistence/**`、雙語 plugin-settings-storage 文件                                                                                                                                                    | 真實 transports、process-kill／最大 fixtures／MANUAL script；先依 T0，正式結果需 T1–T5 與 integrator 接線。其他既有 smoke／雙語共用文件交原 owner。                                           |
| Stage 3 protocol integrator                           | umbrella 指定的 manifest／methods／common／limits／rpc／error schema、schema exporter／index／schema／conformance、JS index／Python _plugin.py／bundled schema                                                                                                                  | 接 3A→3B-1→本案1.7.0→3D1.8.0；只有此 writer 修改 context、permission、版本及產物。T1 不同時擁有這些檔案。                                                                                     |
| Umbrella runtime／desktop／renderer／packaging owners | manager／registry／supervisor；main/index.ts／ipc.ts；renderer/app.tsx／settings-panel.tsx／bootstrap；builtin／launchers／Forge/Vite 及相應 direct tests                                                                                                                       | 套用本案 factories／ports；共用 package manifests／lockfile／CI 由 umbrella §7.2 的 integration owner 指派唯一 writer，packaging owner 不自動擁有 lockfile；不存在第二個 composition writer。 |
| B2-T7 Integration                                     | T1–T6 及 relevant hotspot writers 停止並交接後的必要跨層修正／驗收報告                                                                                                                                                                                                          | schema drift、兩 SDK、正式 ports、packaged adapter、bounded shutdown、migration fixtures；缺陷優先退原 owner，不以整合名義同寫檔。                                                            |

### 14.3 依賴與合入關卡

```text
3A T0 → 3B-1 T0 → B2 T0
                       ├─ T1 protocol/SDK modules ─┐
                       ├─ T2 disk engine ──────────┤
                       ├─ T3 settings/forms ───────┤
                       ├─ T4 actions/drain ────────┤→ 唯一 integrators 接線 → T7
                       ├─ T5 import framework ────┤
                       └─ T6 tests/docs ───────────┘
T7 的正式契約／機制 → 3D Lab mappings、3E EV3 mappings／最終驗收
```

T3–T6 可用已凍結 fixtures 平行開工，但真正 acceptance 不能只用 mock ports。進入 T7 前必須取得 1.6.0 基底，protocol owner 發布 1.7.0 完整 artifacts；3D 未合入前不聲稱 v2 UI 已存在。每次整合核對 generation invalidation、schema drift、JS／Python 行為與最大的合法 records；所有 required evidence 完成才記為 3B-2 已驗收。

分支依 umbrella 從 `feat/plugin-system-stage-3` 的凍結基準建立 `feat/plugin-3b2`，後續由使用者 `--no-ff` 合併；本文件不建立分支、commit 或 merge。3E closeout 仍須實際 mappings／跨功能／installed／MANUAL 證據，不能用本案完成替代。

## 15. 風險與接受的限制

| 風險／限制                                                | 緩解與證據                                                                                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| rename 已發出後取消／timeout 無法保證 rollback            | single publication ticket、unknown disposition、namespace fence、新舊 bytes 保留、receipt 對帳；每一 syscall 前後 kill fixture。    |
| 平台 fsync／atomic replacement 差異、single-instance 接線 | 明示 durability、core ProfileWriterLock 與 filesystem adapter；兩次 app 啟動及 installed OS matrix，不支援 filesystem fail closed。 |
| 512 MiB near-full namespace 無法原子換大 record           | 預約完整 staging／temporary space，開始前顯示 quota；不自動刪歷史。3D 控制錄製與 checkpoint 大小。                                  |
| 停用 process 後 UI 誤稱所有尾端可重試                     | host possession／seal evidence、明確 expiresAt、期限到改 checkpoint-only；只保證最後 committed checkpoint。                         |
| core retry 與重新啟用 generation 競爭                     | old ticket CAS／namespace fence；同 target outcome 未定前拒寫，舊 token 不可被新 process 接管。                                     |
| renderer legacy snapshot 缺席或兩套 store 同寫            | nonce／allowlist／import barrier、pending 狀態；marker 完成後才切換，原檔保留。                                                     |
| 256 筆 bounded store 被當成通用資料庫                     | 無 arbitrary metadata/query／transaction；paged metadata／chunks，feature 負責資料關聯與格式。                                      |
| 最大資料量卡住 main／安全停止                             | worker hashing／streaming、bounded jobs、stop 不排 storage queue、§12 性能證據。                                                    |
| originals／quarantine 仍占使用者磁碟                      | 本階段不自動刪 original；quota／recovery 顯示用途，清理由使用者明確決定，不以遷移成功暗示已釋放磁碟。                               |
| 本機插件繞過公開 API 直接 fs                              | 誠實維持可信本機程式的模型；OS sandbox 另立範圍。                                                                                   |

## 待使用者決定

無。
