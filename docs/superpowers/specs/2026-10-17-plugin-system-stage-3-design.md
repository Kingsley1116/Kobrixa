# Kobrixa 插件系統設計（第三階段總體規格）

日期：2026-10-17  
狀態：第三階段 umbrella design；依使用者十七項最終決策定稿範圍與共用契約，尚未實作或完成驗收。各子專案另走 spec → plan → 實作 → 驗收，不重新開啟已定決策。

- 上層設計：[插件系統設計](2026-10-14-plugin-system-design.md)（§5 公開 API、§6 介面與例外、§8 生命週期與設備控制、§11 階段驗收）。
- 決策依據：使用者於 2026-10-17 確認的十七項決策，全文收錄於 §2；設計前的程式碼盤點與選項比較已由這些決策收斂，不再作為待選方案。
- 前階段：[2A](2026-10-16-plugin-system-2a-build-chain-design.md)、[2B-1](2026-10-16-plugin-system-2b1-diagnostic-source-design.md)、[2B-2](2026-10-16-plugin-system-2b2-language-services-design.md)、[2C](2026-10-17-plugin-system-2c-static-languages-design.md)。本階段基底為 stage-2 的 `79a9ea6`；現行 Plugin API 為 **1.4.0**。

本文固定跨子專案的責任、版本、ownership、安全行為與完成門檻。下文標示「新增」的名稱是第三階段契約，不是對目前程式碼的描述；完整 wire fields、method signatures 與資源 schema 由所屬子規格在 T0 凍結。數值初案均指定確認者，不留無 owner 的待辦。

## 1. 目標、範圍與現況

**目標：** 建立 main process 的共用 device broker、內建 EV3 provider、跨語言 `devices` API、宣告式 UI、命令／事件、設定與資料儲存，讓三個設備功能能獨立啟停。`kobrixa.motor-test` 必須以隨 app 附送的 TS／Node 程序，全程只經公開 SDK／RPC 與宣告式資源完成表單、操作、進度、錯誤及停止流程；這是第三階段不可省略的垂直驗收。

| 範圍                 | 本階段交付                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `kobrixa.motor-test` | 公開表單、hold action、有限 motion、狀態／進度／錯誤、停止與獨立停用；完整退出 React 過渡例外。                                        |
| `kobrixa.sensor-lab` | 公開表單／圖表／表格／dialog、背景錄製、校正、歷史／比較、CSV 匯出、程式預覽／複製、status、checkpoint 與復原；完整退出例外。          |
| `kobrixa.device-ev3` | builtin in-process provider，以及公開連線／探索／監測／mode 與設備設定 UI；remote-files UI 保留子例外，但所有操作立即納入同一 broker。 |
| 核心基礎             | 通用 UI renderer、插件管理與復原、broker arbitration／authority／leases、生命週期、設定／storage、installed-app 啟動與回收。           |

**排除範圍：** remote-files UI、simulator、collaboration UI、editor、workspace、legacy settings pages、updates UI／installer 的插件化；隔離 HTML panels；第三方 device providers。這些列入 §8 的例外帳，不把 backend 經過 broker 當成 UI 遷移完成。第三方 JS／Python **consumer** 仍可在明確啟用的 development mode 使用公開 API；一般第三方安裝／發布、managed Python runtime、產生式 Python bindings、相依套件安裝器留在第四階段。

不新增通用 `services` bus、任意 React／HTML／CSS／script 注入或完整多設備 UX。第一版維持一個 active device connection；registry 的擴充性不代表已承諾多設備操作。主規格 §5 的公開服務方向保留，本階段三個功能透過具型別的 `devices`、UI、settings／storage 合作，不以私有 service 取代缺少的公開契約。

### 1.1 程式碼基線

| 已核對的來源                                                                                                                                                                                          | 現況與必須改變的邊界                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`methods.ts`](../../../packages/plugin-protocol/src/methods.ts)、[`common.ts`](../../../packages/plugin-protocol/src/common.ts)、[`limits.ts`](../../../packages/plugin-protocol/src/limits.ts)      | request 只有 `initialize`、`command/execute`、`shutdown`、`ui/showMessage`；命令只有 ID、結果為 `null`；權限只有 `ui.notifications`；訊息上限 1 MiB。尚無公開設備、面板、設定或 storage API。 |
| [`PluginContext`](../../../packages/plugin-sdk-js/src/index.ts)、Python [`CommandContext`](../../../sdks/python/kobrixa/_plugin.py)                                                                   | JS 提供命令註冊、通知及 `AbortSignal`；Python 提供 async command 與通知。現有 API 不接受表單資料，也沒有設備／UI 訂閱。                                                                       |
| [`DeviceService`](../../../apps/desktop/src/main/device/device.ts)                                                                                                                                    | 直接建立 `UsbTransport`／`WiFiTransport`，以 foreground operation 與 yielding monitor read 仲裁；`withMotorTest` 持有整段操作。它是遷移起點，不是已存在的公開 broker。                        |
| [`MotorTestService`](../../../apps/desktop/src/main/device/motor-test-service.ts)、[`MonitorService`](../../../apps/desktop/src/main/device/monitor-service.ts)                                       | motor owner 是 renderer sender ID；finite motion／helper／停止確認在 main。monitor 共用一個 clock，但 demand 尚非依插件 owner 計數。                                                          |
| [`main/index.ts`](../../../apps/desktop/src/main/index.ts)、[`main/ipc.ts`](../../../apps/desktop/src/main/ipc.ts)、[`renderer/app.tsx`](../../../apps/desktop/src/renderer/app.tsx)                  | 直接組裝 motor／Lab controller、recorder、close／update guards 與功能專屬 IPC；遷移需移除 feature 私有接線，同時保留設備與資料保護。                                                          |
| [`registry.ts`](../../../packages/plugin-runtime/src/registry.ts)、[`manager.ts`](../../../packages/plugin-runtime/src/manager.ts)、[`builtin.ts`](../../../apps/desktop/src/main/plugins/builtin.ts) | builtin source 與 builtin runtime 綁定；所有 builtin 不可停用。現有 builtin 是 `kobrixa.basic-plus` 與編譯後端 `kobrixa.ev3`，不是本階段三個功能。                                            |

第二階段 V01–V03 的人工驗收與 V04 完整 smoke 環境例外，仍依主規格追蹤；本文件不將其改記為通過，也不以舊硬體／私有 IPC 測試代替第三階段公開路徑驗收。

## 2. 決策紀錄

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

## 3. 架構與資料流

```text
可信 workbench shell／collaboration state／close・update guards
       │ authority context、panel visibility、user gesture
       ▼
core declarative UI renderer ◀── catalog／bounded state patches ──┐
       │ validated command／form revision／host context           │
       ▼                                                        │
main PluginManager／RPC router／resource lifetime registry       │
       │                     ▲                                  │
       │ MessagePort         │ public UI／commands／events       │
       ▼                     │                                  │
shipped TS processes：motor-test／sensor-lab／device-ev3 UI ────────┘
dev JS／Python consumers ── MessagePort／stdio ── 同一公開 API
       │ devices                       │ settings／storage／export
       ▼                               ▼
main core device broker             core bounded persistence
 principal・authority・leases       namespace・revision・atomic commit
 exclusivity・cancel・deadlines      checkpoint・paging・recovery
       ▲              │
legacy deployment／   │ documented builtin provider interface
remote-files／reads   ▼
（core adapter）   kobrixa.device-ev3：trusted in-process EV3 provider
                    USB／Wi-Fi・DeviceSession・finite motion/helper
                           │
                           ▼
                          EV3

core recovery／stop view ◀── retained safety faults／save failures
```

圖中的 process entry、broker 與 provider interface 是新增架構。`kobrixa.device-ev3` 的同一 builtin source 可由 host 組合 provider factory 與獨立 UI process；provider registration 由 host allowlist 決定，不由 UI process 發送註冊 RPC。其單一功能開關控制整個 source，UI process crash 與 provider disable 則按不同事件處理。

### 3.1 Core device broker

broker 在 main 擁有 session catalog、principal、operation registry、期限、租約、獨占鎖、recording reservation、read subscriptions、authority checks、stop／cancel 路徑與未解決的停止狀態。所有公開 RPC 與仍保留的 legacy adapter 都進此層；不得保留第二套能直接呼叫設備的仲裁中心。

foreground operation 先保留設備 ownership，再等待已開始的 monitor exchange 完成，最後做 fresh preflight。不得為了搶鎖任意中止 USB read。broker 不把 callback、`AbortSignal`、`DeviceSession`、本機路徑或 transport descriptor 當成公開 wire capability；公開識別碼皆由宿主解析與驗證。

core adapter 供既有 deploy／run／remote-files／battery／monitor 使用，綁定 core principal 與真實 workbench authority context，不能以「legacy」繞過續行檢查。停止使用原 operation 的 ownership，不重新排隊取得被自己占用的鎖。更新／關閉以 operation class gating，不能只靠 `main/ipc.ts` 現有 channel name 判斷插件呼叫。

使用者的 **Disconnect 是一次 host-orchestrated core action**：先阻擋該 session 的新工作，要求 motor stop/readback 與 recording end／drain／save，顯示各階段進度，完成後才斷線。停止未確認或保存失敗不能回報正常完成，core 保留 fault／retry／checkpoint 說明。插件呼叫公開 `devices/disconnect` 不取得這項跨 owner 的協調權；其他 owner 仍有 active foreground operation／recording reservation 時回 `PLUGIN_E_DEVICE_BUSY`，不得藉 API 強制中斷他人工作。

3A 的 host-only `DeviceSessionControlPort.quiesce` 為 core Disconnect 與 suspend 封鎖 session 新工作、stop/readback 並結束 reservation；`ReservationBindingPort.onEnded` 由 3B-1 coordinator 訂閱，轉交 3B-2 `PersistenceParticipant.endReservation(event, deadline)`，再以 `drain(offer, dispatch)` 收尾該 recording。一般 Lab stop recording 的 `released`、Disconnect 的 `core-disconnect`、suspend 的 `suspended` 與 provider/session loss 的 `disconnected` 都有同一路徑，不因此 retire 健康 consumer owner。Disconnect 等 device／storage disposition 均成功後才呼叫 `DeviceSessionControlPort.disconnect`；兩個 ports 只供 host 使用。

### 3.2 Builtin EV3 provider interface

3A 定義並凍結新增 `BuiltinDeviceProvider` 的 host-only interface，至少包含探索、連線／斷線、public descriptor 轉換、capability discovery、讀取／mode、finite motion、停止／readback、legacy program／file operation adapters 與 disposal。這是可信任的 in-process interface，不是第三方 provider RPC。

- provider 持有 `UsbTransport`／`WiFiTransport`、`DeviceSession`、EV3 opcode／USER_SLOT／helper image、fresh preflight 與 firmware deadlines；broker 不匯入 helper bytecode 或建立 transport。
- broker 提供不可由 consumer 偽造的 operation context，包含 cancellation、deadline、session identity、續行 authority check 與安全停止路徑。provider 每個可能改變設備的步驟須先通過它，不能只在方法入口檢查。
- provider 回傳 bounded result／progress 與可判讀的 outcome；不能以丟出例外宣稱設備沒有收到指令。non-cooperative provider 超時會隔離 session 並保留不確定狀態，main 同程序並無強制終止任意 provider 程式碼的保證。
- provider／physical-device 重複宣告須顯式衝突，不選第一個。公開 descriptor 移除 HID path、任意 native metadata 等細節；連線候選使用 host-issued ID，Wi-Fi address 以受限資料驗證。
- `kobrixa.ev3` 的 `ev3-native` 編譯目標及既有必要 builtin 政策不因設備 provider 停用而變更。

### 3.3 Public devices、commands 與 events

公開 `devices` 提供 connection／session／capability catalog、read／telemetry subscription、input modes、recording reservation、finite motion 的 prepare／start／query／stop 與狀態事件。方法的正式拼字由 3A 子規格凍結；不得直接匯出既有 `withMotorTest` 或 `window.kobrixa.device`。

motion 在送出任何設備副作用前先取得 inert operation reference。prepare 不動設備；start 消耗該 reference，stop／cancel 可在 start 回覆前作用。相同 reference 的 start 不會執行兩次；已取消 reference 留下 tombstone，延遲的 start 永遠不能使它復活。RPC timeout 後只可查詢／停止原操作，不能自動重送新的 start。

3B-1 擴充 commands 的 bounded arguments、form snapshot／revision、結果及 cancellation，保留 1.4.0 無參數命令的舊 envelope。新 envelope 只對握手支援的版本送出；command ID 不構成權限。UI action 只能呼叫同 source 已宣告的命令或明列的 core actions，不能任意路由到其他插件。core open／stop／recovery actions 不依賴 feature handler 回應。

所有訂閱都有 host-issued handle、owner、generation、sequence 與 unsubscribe。telemetry／UI patches 使用 bounded batches；可合併的顯示更新與不可丟失的 terminal／authority／stop 狀態分開。consumer 發現 sequence 缺口時讀取 snapshot，不能自行補成成功。recording 使用保留樣本或明確 gap 的資料流，不能把 chart 降採樣當成原始資料。

### 3.4 宣告式 UI host renderer

main 驗證 package JSON resource、ownership、version、總量與 component references，發布 catalog；renderer 只渲染已驗證的通用元件。宿主負責 theme、`en`／`zh-TW`、鍵盤／焦點、accessible names、表單 draft、field errors、局部 cursor 與 layout；feature 提供 bounded data、翻譯與命令，不取得 DOM／React 掛載權。

面板位置固定為右側新增的「插件工具／Plugin tools」pane（`rightPanel: "plugins"`），與既有 EV3 pane、collaboration pane 互斥。`kobrixa.motor-test`、`kobrixa.sensor-lab`、`kobrixa.device-ev3` 是其中的 sibling tabs；motor test 不再放在 monitor card。切換 pane／tab 視為 panel hide，依 §4.7 要求 motor 停止，Lab 可繼續背景錄製；3B-1 提供 shell／tabs，3C／3D／3E 分別接入各自資源並更新使用文件。

3B-1 元件包含 group、text／help、bounded text input、number／range、enum／segmented choice、boolean、action／hold action、status／alert、progress、key-value 與受限條件顯示。條件是明列的欄位比較／布林規則，不執行任意 expression。3D 加 selectable list／table、line chart、dialog／confirmation、plain／code text 與 explicit copy，並擴充 status 的 open／stop actions。

hold action 的 pointer／keyboard begin／end／cancel 與實際 panel／window visibility 由宿主追蹤，持有 expiring gesture handle；重複 keydown 不重啟，pointercancel、blur、hidden、close 均失效。插件的獨立 timer 不能製造新的 user intent。motor 的 timed／angle 雖不需持續 hold，仍受 panel／window lifetime 約束。

3B-1 另提供 main 可驗證的 panel liveness heartbeat，初案同為每 100 ms 更新、350 ms 過期，涵蓋 timed／angle 的 UI lifetime；renderer 卡住且未送出 crash／hidden 通知時仍會要求停止。heartbeat 只證明既有 UI scope 存活，不能自己建立新 gesture 或延長 firmware movement 上限；數值由 3A／3B-1 在 T0 一起確認。

### 3.5 Settings、record storage 與資料遷移

3B-2 提供 application-local typed settings，限 boolean、finite number／integer、bounded string、enum、default／range／label／help。namespace 綁定 source；schema version、value revision、reset、驗證與持久化錯誤均公開。停用保留值、撤銷 watcher；workspace overrides、secrets、sync 不在本階段。

依決策 17，通用設定頁逐欄立即驗證並 atomic CAS 保存，沒有 Apply 按鈕；boolean／enum 變更即送出，text／number 在有效輸入完成（blur／Enter）送出，單欄重設同樣立即提交。保存狀態與錯誤逐欄顯示，不因 watch 或 CAS conflict 靜默覆蓋尚未確認的輸入。

record storage 與 settings 分開：opaque record ID、schema version、compare-and-swap revision、atomic replacement、bounded staged chunks、paged list／read、delete、flush 與 quota。commit 成功前舊版本仍可讀；失敗不得半寫入或悄悄清空。跨筆資料不承諾通用 transaction。export 由使用者明確觸發，host 開啟 save dialog、持有 destination handle 並原子提交；插件不取得任意本機路徑。copy 也須由公開的使用者 action 觸發。

Lab recorder／校正／CSV 邏輯歸 feature，透過公開 telemetry／reservation／storage 工作；host 只持有通用 persistence、lifecycle drain 與 recovery record。禁止把 `sensor-lab:*` 包成另一個名稱的私有 service。既有 [`SensorLabService`](../../../apps/desktop/src/main/sensor-lab/service.ts)／[`SensorLabStore`](../../../apps/desktop/src/main/sensor-lab/store.ts) 的 checkpoint、retry、原始資料與校正 snapshot 行為須遷移。

graceful drain 允許原 generation 將已登記 recording 的 final payload 交給 host staging，再等待 commit；保存失敗時先停錄並保留 retry 狀態。若期限到而必須終止 process，core 必須說明是否仍持有可重試 payload，或只剩最後 checkpoint；不得對尚未送達 host 的記憶體資料承諾可重試。3B-2 定義 bounded staging 的保留／釋放規則，3D 驗收兩種失敗結果。

3B-2 凍結一次性 import 機制，3D／3E 分別實作 Lab records／calibrations 與 EV3 preferences 的 mapping。host 讀取舊 `userData/sensor-lab`、`device-settings.json` 及既有 renderer connection preferences；驗證、可重入 migration、成功 commit marker 與保留原檔先於切換讀取來源。schema 升降版不相容時提供明確錯誤／保留資料，不套預設值覆寫。motor 的 per-port draft 維持暫存，儲存設定不代表允許恢復 motion。

### 3.6 隨 app 發送與啟動

現有 [`launchers.ts`](../../../apps/desktop/src/main/plugins/launchers.ts) 的 Node launcher 已使用 `utilityProcess.fork`、`MessageChannelMain` 與 `kobrixa-plugin-port`；3B-1 擴充它的來源解析與 builtin launch descriptor，重用公開 JS SDK 的 `runPlugin`／`electronParentPortChannel`。**不執行 PATH 上的 `node`，不下載 runtime，也不要求一般使用者提供 Node。**

3B-1 將 builtin source trust、required／optional policy 與 execution runtime 分離。host allowlist 指定本階段三個 source 為 optional，**預設啟用；一般使用者可在插件設定逐一啟用／停用，不需 developer mode**，選擇持久保存並受 safe mode 抑制。manifest 自稱 builtin／required 不能取得信任。motor 與 Lab 使用 `node` execution；device-ev3 的 provider 由 main 註冊，UI 使用相同 shipped-process 路徑。靜態 JSON UI 不代表 `runtime.kind === static`；本階段不放寬現有 static runtime 讓它執行命令或取得設備權限。

desktop integration owner 在 provider、journal 與 settings／storage 啟動前取得 Electron `app.requestSingleInstanceLock()`；第二次啟動只通知既有 instance 還原並聚焦視窗，隨即退出，不建立第二套插件／設備／persistence runtime。3A 在 T0 定義共用 core `ProfileWriterLock` port，journal 與 3B-2 persistence 使用同一啟動結果，不新增 `flock`／`LockFileEx` 等 native file-lock addon。single-instance 是可見行為變更，3E 更新雙語文件與 second-launch smoke。

新增建置輸入位於 `plugins/motor-test/`、`plugins/sensor-lab/`、`plugins/device-ev3/`；3B-1 在子規格固定 entry filenames、Vite output 與 manifest／resource index，3C／3D／3E 依該配置交付內容。編譯後 JS、SDK dependencies、manifest 與 JSON resources 隨 Forge 產物發送，host 從 installed app 位置解析；不讀 `plugins/*` 開發目錄、不依賴 workspace symlink、`cwd` 或開發機 `node_modules`。

[`forge.config.ts`](../../../apps/desktop/forge.config.ts) 現在只列 main／build worker／language worker／preload，封裝白名單包含 `.vite` 與指定 native dependencies。3B-1 必須加入 feature build entries／resources，驗證 ASAR／unpacked 路徑及所有 runtime dependency。`node-hid` 仍只屬 EV3 provider。缺少 entry／資源時顯式 unavailable，不退回 source tree 或私有 IPC。啟動按需進行，shutdown 有界且無 orphan process；重啟只恢復被允許的功能，不重播操作。

沿用 [`PluginSupervisor`](../../../packages/plugin-runtime/src/supervisor.ts) 的有界重啟政策：5 分鐘內累積 3 次失敗後進入 crash-loop stopped，須明確處理才恢復；未達門檻也只在後續使用時啟動新 instance，不重播失敗命令。JS／Python 的合作式 teardown 是便利機制，host resource revocation 不依賴它成功。

## 4. 跨子專案共用契約

### 4.1 Principal、ownership 與 generation

沿用第二階段 `sourceKey`，不以可改名的 manifest ID 當存取控制鍵。現有 [`developmentSourceKey`](../../../packages/plugin-runtime/src/registry.ts) 為 resolved directory 的雜湊身分，格式 `dev:<16 hex>`；builtin 為 `builtin:<id>`。來源搬移／重新連結只走 host 的既有管理與 migration 流程，不能自行認領另一個 namespace。

| 詞彙                                               | 本階段固定意義                                                                                                                                                               |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pluginId`                                         | 已驗證的顯示／宣告 namespace；不得以 request 內自稱的 ID 決定 caller。                                                                                                       |
| `sourceKey`                                        | host registry 的穩定來源身分；設定／record namespace 與 owner lookup 的根。                                                                                                  |
| `generation`                                       | manager 的 execution／service generation。沿用 reload／executable metadata change 失效語意；本階段另要求 retirement、disable、crash／restart 使舊 execution authority 失效。 |
| `staticGeneration`                                 | 既有 static contribution 的獨立世代，registration retry 亦會變更；現有 static DTO 的 `generation` 指此值，不能誤當 execution generation。                                    |
| `uiResourceGeneration`                             | 新增 UI catalog resource 世代，沿用 static resource 與 execution 分離的原則；resource replace／retry 撤銷舊 panel binding，不授予新的 execution authority。                  |
| `hostEpoch`／`processEpoch`                        | 新增 host 啟動與每次 process instance 的不透明識別；防止 restart 後數字 generation 重用。不是持久化操作能力。                                                                |
| `authorityContext`                                 | host 綁定的可信 workbench／room 狀態及其 epoch；插件只持不透明 reference，不能指定 window ID、role 或 holder。                                                               |
| `principal`                                        | host 保存的 `{sourceKey, pluginId, generation, hostEpoch, processEpoch, authorityContext}` 關聯；core adapter 使用獨立的 core principal，不能被插件冒用。                    |
| `session`／`providerGeneration`                    | provider owner、provider lifetime 與每次 connection 的 host-issued ID；reconnect 一律新 session，不能移接舊 lease。                                                          |
| `operation`／`lease`／`reservation`                | operation 是一次有結果的工作；lease 是該工作可續行的有期限權限；recording reservation 是 mode／motion 相容性占用。三者與 collaboration holder 不是同一個鎖。                 |
| `panelInstance`／`gesture`／`revision`／`sequence` | instance／gesture 表示宿主控制的 UI lifetime；revision 比較 snapshot／patch，sequence 表示 event 順序。均不取代 owner 或 generation 驗證。                                   |

資源至少綁定 source、相應 generation／epoch；device resource 再綁 provider／session，UI action 再綁 panel instance／resource generation。handle 是不透明 reference，不是可轉讓權限。任何 late reply、過期 patch、舊 stop、unsubscribe 或 storage commit 都須驗證 owner；舊 stop 不能停止新的操作，舊 generation 不能撤銷別人的訂閱。

持久化 namespace 不綁 transient generation，讓重新啟用仍可讀原值；存取與 pending write 則綁當前 principal。retirement 後僅允許 host 發給原 generation 的 bounded drain token 完成已登記資料的 final commit，不接受新 motion、任意寫入或一般 command。host ledger 的 safety fault 不隨 source 卸載消失。

### 4.2 Capability 與 permission vocabulary

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

### 4.3 錯誤碼與 outcome

目前 [`plugin-protocol/errors.ts`](../../../packages/plugin-protocol/src/errors.ts) 定義數字 `RPC_ERRORS`，[`rpc.ts`](../../../packages/plugin-protocol/src/rpc.ts) 的 failure envelope 只有 `code`／`message`；`PLUGIN_E_*` 字串清單實際位於 [`plugin-runtime/errors.ts`](../../../packages/plugin-runtime/src/errors.ts)。不得假定現有 envelope 已支援 `error.data`。

本階段新業務方法使用明確的 object result union：`{ok: true, value}` 或 `{ok: false, error: {code, message, detail?}}`；3A T0 凍結共同結果 schema，SDK 保留結構化錯誤。既有 JSON-RPC envelope 與舊命令結果保持相容。格式錯誤／未知方法仍用既有 numeric RPC errors；業務失敗、已受理操作及其終態不能只變成 transport exception。`detail` 必須 bounded、可匯出 schema，不能洩漏 native path。

| 代碼                                                                                                     | 來源／固定語意                                                                                                       |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `PLUGIN_E_MANIFEST`、`PLUGIN_E_API_VERSION`、`PLUGIN_E_RESERVED_ID`、`PLUGIN_E_PROVIDER_CONFLICT`        | 沿用既有宣告、API 不相容、保留身分與提供者衝突語意。                                                                 |
| `PLUGIN_E_DISABLED`、`PLUGIN_E_SAFE_MODE`、`PLUGIN_E_SHUTTING_DOWN`、`PLUGIN_E_BUILTIN_REQUIRED`         | 沿用生命週期拒絕；最後一項只保護 host 指定的必要 builtin，不再涵蓋全部 builtin。                                     |
| `PLUGIN_E_TIMEOUT`、`PLUGIN_E_CANCELLED`、`PLUGIN_E_CRASHED`、`PLUGIN_E_PROTOCOL`                        | 沿用逾時／取消／當機／協定錯誤；均不代表實體設備已停止。                                                             |
| `PLUGIN_E_STATE_SAVE`／`PLUGIN_E_STATE_CORRUPT`                                                          | 維持 host administration store 的既有意義，不拿來表示 feature records 儲存失敗。                                     |
| `PLUGIN_E_PERMISSION_DENIED`                                                                             | 新增，3A；缺少授予的 consumer permission，對應既有 `RPC_ERRORS.permissionDenied` 的授權分類。                        |
| `PLUGIN_E_STALE_RESOURCE`／`PLUGIN_E_RESOURCE_LIMIT`                                                     | 新增，3A；owner／generation／revision／handle 已失效，或超出共同資源數量／速率。未授權 owner 不回傳別人的資料。      |
| `PLUGIN_E_DEVICE_PROVIDER_REQUIRES_BUILTIN`                                                              | 新增，3A；非 builtin 宣告 provider，與既有 compiler／language-service 禁令同樣整個來源 invalid。                     |
| `PLUGIN_E_DEVICE_UNAVAILABLE`／`PLUGIN_E_DEVICE_CAPABILITY`                                              | 新增，3A；provider／session 不可用，或 capability／其版本不支援。                                                    |
| `PLUGIN_E_DEVICE_BUSY`／`PLUGIN_E_DEVICE_AUTHORITY`                                                      | 新增，3A；operation／reservation 衝突，或當前 authority 不允許寫入；兩者不可混為一般 timeout。                       |
| `PLUGIN_E_DEVICE_OPERATION`／`PLUGIN_E_DEVICE_STOP_UNCONFIRMED`                                          | 新增，3A；preflight／設備操作失敗，或停止無法確認。前者的 detail 保留未發送／已發送／未知 outcome，不能隱藏後者。    |
| `PLUGIN_E_UI_RESOURCE`／`PLUGIN_E_UI_VERSION`                                                            | 新增，3B-1；UI 結構／資源／限制錯誤，或不支援的 resource version。隔離該 contribution 並列問題，不默默省略關鍵元件。 |
| `PLUGIN_E_SETTINGS_SCHEMA`／`PLUGIN_E_SETTINGS_CONFLICT`／`PLUGIN_E_SETTINGS_SAVE`                       | 新增，3B-2；值／migration version 不合法、revision 衝突、持久化失敗。                                                |
| `PLUGIN_E_STORAGE_QUOTA`／`PLUGIN_E_STORAGE_CONFLICT`／`PLUGIN_E_STORAGE_IO`／`PLUGIN_E_STORAGE_VERSION` | 新增，3B-2；容量、record revision、I/O／損壞、不支援資料版本。失敗保留最後 committed data。                          |

3A 將新增共用 error code schema 放入 protocol，runtime 匯入或轉匯出，避免 JS／Python／host 三份字串分歧；既有 runtime codes 不改名。3B-1／3B-2 只在自己的版本批次加入表列 codes；3D／3E 沿用。各子規格凍結自身 `detail.reason` enum 與 numeric／business-result mapping，並交付兩個 SDK 的正反例。

operation snapshot 的狀態至少區分 preparing、running、stopping、completed、stopped、timeout、failed、unconfirmed，沿用 [`MotorTestState`](../../../apps/desktop/src/shared/motor-test.ts) 的產品意義但另建公開 schema。`stopRequested`、停止確認與動作是否完成分開；丟失回覆不能推論成功或尚未執行。

### 4.4 API 與 UI resource 版本計畫

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

### 4.5 Motion safety invariants 與仲裁

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

### 4.6 Collaboration authority

目前 [`DeviceControlGate`](../../../apps/desktop/src/main/collab/device-control.ts) 信任 workbench 的回報，`false` 限制寫入，`true`／`null`／缺值不限制；此既有窗口規則不能直接套到沒有 sender window 的 plugin process。

- host 在 plugin invocation／session 綁定可信 authority context；本機非協作狀態也須明確標記 local context。無綁定、room 建立中、未同步或失效 context 一律拒絕 consequential writes，不以缺值 default-allow。
- admission 檢查權限、enabled generation、session、authority、update／close gate 與衝突；每個 consequential step 再讀**目前**狀態。包含 helper upload／run／arm、每個 jog pulse、mode write、deploy 的每個 asset／chunk／execute、remote-files 的每次 mutation／batch entry。若底層一次 transfer 內有多個寫入，provider 須在可界定的 exchange 邊界檢查。
- 失權立即撤銷 motion／write lease，已送出的 exchange 只等有界結果，不能開始下一步；保留 partial／unknown outcome，使用不需 holder 的安全停止路徑。取消／失權不代表可回滾 brick 上已寫入的檔案。
- read／monitor／browse／download／connection management／stop 保留既有可用性，但仍驗證 owner、session、一般鎖與 disable policy。download 由 main 持有的 plan 分類，拒絕 consumer 偽造 `action: download`。連線／斷線不得暗中替換他人的 active operation。
- host／editor／viewer、grant／reclaim／release、demotion、offline／reconnect 規則沿用；不以 awareness 暫缺自動接管。3A 更新本機 gate 與 provider continuation，collaboration UI 仍在例外帳，不延後控制權驗收。

這是可信 workbench 與 host API 的 authority 邊界，不是 server 簽發的實體設備鎖。Node／Python 的獨立程序也不是 OS sandbox；manifest permissions 無法阻止可信本機程式自行使用系統 USB／network API，文件必須保留這個界線。

### 4.7 Hide／disable／crash／safe-mode 語意矩陣

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

現有 [`motor-test-smoke.mjs`](../../../tests/desktop/motor-test-smoke.mjs) 會切換 `rightPanel` 並斷言 timed motion 繼續；[英文使用文件](../../en/motor-test.md) 卻已描述關閉側欄要求停止。3C 必須改成矩陣行為的雙語文件與 smoke，增加「start 未回覆前 hide」案例，不能只刪掉舊斷言。

### 4.8 Resource budgets 與期限初案

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

## 5. 子專案切分

每個子專案規格均需列入公開契約、現況遷移、failure matrix、測試與人工證據；每份 plan 再列精確 write set、commands 與報告位置。本文不以估算週數代替完成標準。

已建立子規格：[3A：Device broker 與 EV3 provider](2026-10-17-plugin-system-3a-device-broker-design.md)、[3B-1：Declarative UI](2026-10-17-plugin-system-3b1-declarative-ui-design.md)、[3B-2：Settings 與 storage](2026-10-17-plugin-system-3b2-settings-storage-design.md)；共用決策與邊界仍以本 umbrella 為準。

### 5.1 3A：Device broker 與 EV3 provider

- **範圍：** 抽出 main arbitration／authority／lease／timeout，實作 builtin provider interface、public devices、recording reservation、共享 sampler、fault journal／quarantine；全部 legacy device consumers 改走同一仲裁，provider disable 可清理。
- **依賴：** 本文 T0、stage-2 identity 與現有 device library。先以 host fixture 綁定 context；真實 UI gesture 由 3B-1 接入，不能因此略過 broker 的驗證。
- **交付：** API 1.5.0、protocol／JSON Schema／JS／Python、fake-provider conformance、EV3 adapter、legacy operation 分類／續行檢查、控制權與 lock 測試、core recovery 資料介面。
- **驗收：** 不可由第三方註冊 provider；所有讀寫路徑共用鎖；stale／foreign handles、失權於每個 await boundary、timeout／disconnect、stop-before-arm 與 stop uncertainty 有負例。真實硬體依 §9 MANUAL 記錄；broker unit tests 不等於 3C 完成。

### 5.2 3B-1：Declarative UI、commands 與 builtin-process lifecycle

- **範圍：** UI v1 schema／catalog／renderer、commands arguments／context／result、subscriptions／patches、hold／status、optional builtin policy、shipped Node entries、resource retirement、safe mode 與管理開關。
- **依賴：** 共用 principal／error vocabulary；可與 3A 平行實作，正式契約批次接在 API 1.5.0 後。UI renderer 先用凍結的 fake device port，整合測試須換成真實 broker。
- **交付：** API 1.6.0、UI v1、兩個 SDK parity、generic renderer 與 accessibility tests、lifecycle hooks、Forge／Vite launch contract、core recovery／stop view、optional builtin enable／disable persistence。
- **驗收：** 舊 commands 相容；未知 UI version／超限／偽造 panel／gesture 被拒；pointer／keyboard／visibility 失效有界停止；故障 source 無法重建已撤銷 UI；installed fixture 不需 checkout／外部 Node，process 關閉無孤兒。

### 5.3 3B-2：Settings 與 bounded storage

- **範圍：** typed schema／通用設定 UI、namespaced values／watch／reset／migration、records／CAS／atomic commit／paging／quota、export／copy、checkpoint／drain、舊資料 import 基礎。
- **依賴：** 共同 principal；backend／schema 可與 3A／3B-1 平行，UI 與 lifecycle 整合依 3B-1，正式契約在 1.6.0 後。
- **交付：** API 1.7.0、兩個 SDK、storage fault injection／migration fixtures、host export／copy actions、drain port、EV3／Lab mapping 所需的 import mechanism。
- **驗收：** cross-source 存取拒絕、disable 後值保留／watch 解除、舊 generation 不可 commit；quota／disk-full／interrupted rename／revision race 不毀掉舊值；大 record 分頁與 chunks 不越過 1 MiB frame。

### 5.4 3C：Public-only motor plugin

- **範圍：** `plugins/motor-test/` 的 TS feature／JSON UI，完整 jog／timed／angle 表單、validation、state／progress／error／stop；移除 `MotorTestControls`／`MotorTestController` 對工作台的私有掛載與使用，safety engine 留 provider。
- **依賴：** 3A＋3B-1；不依賴 3B-2，現有 per-port drafts 無需 durable settings。可先以合約 fixtures 開發，但公開路徑 acceptance 須用正式 host。
- **交付：** 隨 app 的 Node bundle、公開 manifest／resources、private-dependency audit、public-route smoke、雙語 motor 文件／visibility 更新；不另升 API minor。
- **驗收：** 所有正常／錯誤／取消／無控制權／unconfirmed 路徑僅使用公開契約；transitive bundle 無 React、Electron API、desktop-private imports、raw transport／helper、私有 preload／IPC 或 direct fs／network／USB；停用與 crash 仍由 host 停止。是擴大 charts 前必須完成的垂直證明。

### 5.5 3D：Sensor Lab 與 charts

- **範圍：** UI v2、line charts／tables／dialog／copy、Lab feature-owned recorder／校正／history／compare／CSV／status，透過 broker reservation 與 storage 完整遷移，移除私有 main recorder singleton 依賴。
- **依賴：** 3A＋3B-1＋3B-2；3C 公開 motor proof 通過後才凍結／合入 UI v2 擴張。chart geometry／校正／migration fixtures 可先平行進行，不重新設計 UI v1。
- **交付：** API 1.8.0、UI v2 conformance、shipped Lab process、bounded data deltas／paged history、舊 records／calibrations import、checkpoint／interrupted recovery、雙語 Lab 文件。
- **驗收：** 隱藏錄製、停用 drain／save、source change 停錄、provider unavailable、unsaved retry／quota／crash 尾端風險可觀察；保存 raw data、float32 校正次序、校正 snapshot、比較 unit／source 相容、gap／extrema／shared cursor。max-size performance 不使 stop／editor 延遲失控。

### 5.6 3E：EV3 connection／monitor UI 與收尾

- **範圍：** `kobrixa.device-ev3` 公開探索／USB／Wi-Fi／連線／recovery／readings／mode／settings；拆除私有 motor／Lab composition；保留 remote-files UI adapter，核實 broker routing；完成跨功能／installed-app／人工驗收與例外帳更新。
- **依賴：** UI 基本功能依 3A＋3B-1＋3B-2，可與 3C／3D 平行；使用 table／dialog 的完成版依 3D UI v2。最終 closeout 必須等 3C／3D 及全部 foundational branches 合入。
- **交付：** 公開 device UI resources／process、EV3 settings migration、core 相鄰 build／deployment summary、例外 ledger／雙語 architecture／roadmap、criterion matrix 與 installed artifacts；不另升 API minor。
- **驗收：** 三個功能獨立啟停，停用 provider 不影響 compiler；motor／Lab 不互相匯入或依賴對方啟用；remote files／deploy／battery 無仲裁旁路；完整 scope checklist 與 MANUAL 證據符合 §9 才可宣告 Stage 3 完成。

## 6. 依賴圖與平行工作

```text
使用者決策＋本 umbrella
             │
             ▼
       T0 共用契約凍結
        ┌────┼──────────────┐
        ▼    ▼              ▼
       3A   3B-1           3B-2 backend
        │    │              │
        │    └──────────▶ 3B-2 UI／drain integration
        ├────┴──▶ 3C public motor proof
        │              │
        │              └──▶ 3D UI v2 freeze／integration
        ├── 3B-1＋3B-2 ───▶ 3D Lab
        └── 3B-1＋3B-2 ───▶ 3E device UI（v2 部分再依 3D）
                               │
              3A／3B-1／3B-2／3C／3D 全部合入
                               ▼
                         3E stage closeout
```

- **規格可平行：** 3A、3B-1、3B-2 可依本文同時細化；3C 可同步列 motor parity／安全案例，3D 可列資料／圖表契約與 3B-2 migration cases，3E 可列 device UI／acceptance。各 spec 不得單獨改寫共用 vocabulary、版本或矩陣。
- **實作可平行：** T0 後，broker／EV3 extraction、UI renderer／process launcher、storage backend 使用互斥 write sets 開工；SDK／schema hotspots 依 §7 序列整合。3C 的 mock-driven feature、3D 的 pure recorder／chart geometry、3E 基本 connection UI 亦可先做。
- **真正的整合依賴：** 3C 需 3A／3B-1；3D 需三個 foundation 並以 3C 結果確認最小公開 UI 已成立；3E closeout 使用全部合入的真實 artifacts。mock 通過只代表分支測試，不構成公開 RPC、installed-app 或硬體證據。
- **版本批次序列：** 1.5.0 → 1.6.0 → 1.7.0 → 1.8.0 由共同 protocol owner 整合；不要求非 hotspot 實作等待前一整個子專案完成。若契約批次先合入，未接妥能力須顯式 unavailable，不能啟用半套 motion。

## 7. T0 契約凍結、hotspot ownership 與整合

沿用 [2C §11.1](2026-10-17-plugin-system-2c-static-languages-design.md#111-t0-契約凍結與寫入-ownership) 的模式：**T0 是短序列的 contract freeze，後續任務有互斥 write sets，最後由 integration 驗收。** owner 是後續 plan 指派的單一 writer 角色，不是允許多分支同時改同一檔的群組。

### 7.1 凍結順序

1. **3A contract owner 先凍結** principal／sourceKey／generation／epoch、capability／error vocabulary、result／event envelope、provider context、operation／reservation／stop／fault、authority 與 legacy classifications；3B-1 確認可提供所需 gesture／lifecycle port，3B-2 確認 drain token 可用。
2. **3B-1 owner 接著凍結** UI v1 resource／catalog／patch／command context、panel／gesture lifecycle、required／optional builtin policy、process launch descriptor、core recovery port 及 renderer bootstrap；不得變動 3A ownership。
3. **3B-2 owner 凍結** settings／record schema、quota／CAS／paging／staging／export、migration／drain／failure ports；與前兩者對齊 shutdown 時間線。
4. **整合 owner 發布 T0 baseline**：正式 types／signatures、exports、fixture 正反例、resource limits、每檔 owner 與 branch points。任何 scaffold 必須明列交接，不保持兩個 writer；T0 不宣稱功能已可用。
5. **3C proof 後由 3D 凍結 UI v2**，protocol owner 在 1.8.0 批次發布；3E 依該契約整合。改動已凍結契約須先更新對應 spec／fixtures，再通知依賴分支同步，不能由 merge conflict 臨時決定語意。

### 7.2 Hotspot 寫入表

以下 paths 相對 repository root；`main/`、`renderer/` 均縮寫自 `apps/desktop/src/`。各 owner 同時持有對應直接測試／mocks，其他任務可讀取但不可自行改寫。

| Hotspot                                                         | 唯一 writer／交接順序                                                                                                                                 | 整合規則                                                                                                                                                                                 |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/plugin-protocol/src/manifest.ts`                      | Stage 3 protocol integrator；接收 3A → 3B-1 → 3B-2 → 3D 的契約批次                                                                                    | provider、panels／status、settings 宣告分模組定義後集中組裝；保留 static／builtin 語意與外部 provider 先行拒絕。                                                                         |
| `packages/plugin-protocol/src/methods.ts`                       | 同一 protocol integrator                                                                                                                              | 各子專案交付自有 schema modules／fixtures，不各自改 method map；檢查 legacy command negotiation。                                                                                        |
| `packages/plugin-protocol/src/common.ts`、`limits.ts`、`rpc.ts` | 同一 protocol integrator                                                                                                                              | permissions、shared IDs／results／errors、版本只由此 writer 寫入；numeric envelope 相容性有跨版本案例。                                                                                  |
| Schema export                                                   | 同一 protocol integrator 持有 `src/json-schema.ts`、`src/index.ts`、`scripts/export-schema.mjs`、`schema/*`、`conformance/*` 及 Python bundled schema | 僅從 Zod export，不手修產物；結構 schema 可匯出，跨欄位語意用共用 validator／fixtures，不把 desktop 的 refine／transform 直接搬上 wire。                                                 |
| SDK contexts                                                    | 同一 protocol integrator 持有 JS `packages/plugin-sdk-js/src/index.ts`、Python `sdks/python/kobrixa/_plugin.py` 及公開 context 組裝／版本             | devices／UI／storage 可分配新模組，但 context、error、event／cancellation 組裝序列整合，兩個 SDK 同批驗收。                                                                              |
| `packages/plugin-runtime/src/manager.ts`                        | 3B-1 runtime owner                                                                                                                                    | 3A 提供 device resource participant，3B-2 提供 storage drain participant；透過凍結 ports 接入。`registry.ts`／`supervisor.ts` 的生命週期修改同由此 owner 協調，不由各 feature 插入分支。 |
| `main/index.ts`                                                 | Desktop integration owner，3E closeout 續接同一 ownership                                                                                             | 3A／3B-1／3B-2 提供 registration／dispose factories；只有此 owner 改 app composition、close／update／crash ordering。                                                                    |
| `main/ipc.ts`                                                   | 同一 desktop integration owner                                                                                                                        | legacy adapters、trusted sender、authority／update gates 統一接線；新 public RPC handlers 放各自模組，不擴散功能專屬 preload。                                                           |
| `renderer/app.tsx`                                              | Renderer integration owner，3E closeout 續接                                                                                                          | 3B-1 交 generic panel／status／settings host，3C／3D／3E 交 manifest／resources 與移除清單；只有此 owner 撤掉舊 controller／mount／effects。                                             |

3B-1 同時指定 `main/plugins/builtin.ts`、`launchers.ts`、Forge／Vite config 的單一 packaging owner；3A 持有 device broker／provider 模組，3B-2 持有 persistence 模組，3C／3D／3E 持有各自 `plugins/*` feature。shared／preload DTO 只能 type-only import／re-export 正式型別，不能複製一套相近定義。

未列出的共用檔、package manifest／lockfile 與跨層測試，先由整合 owner 在 plan 指派唯一 writer。schema export 在取得前一批次後重新產生；不可把 generated JSON 的衝突以任選一側處理。每個子專案提交介面變更說明及接線 patch，由 hotspot owner 套用；分支不得以私有 fallback 維持暫時可用。

每次整合檢查 schema drift／兩個 SDK、generation invalidation 與受影響行為。最後 3E 在各 writer 停止後使用合入 artifacts 執行 cross-feature／packaged acceptance；硬體結果另列。本文撰寫不建立工作分支、不執行 merge，也不代表已啟動平行實作。

## 8. 過渡例外帳

此表逐列涵蓋主規格 §6.2。路徑縮寫仍以 `apps/desktop/src/` 為根；「提出的里程碑」是後續追蹤名稱，不宣稱已核准實作排程或第四階段自動承擔。3E closeout owner 更新完成證據與剩餘依賴；保留項由其未來子規格 owner 在立項時給出 plan／驗收，不無限延用可信身分。

| 主規格例外              | 本階段處置／目前私有依賴                                                                                                                                                                               | 退出條件                                                                                                                                                    | Owner／提出的里程碑                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `kobrixa.motor-test`    | 3C 完整遷移；`renderer/device/motor-test-controls.tsx`、`motor-test-controller.ts`、私有 motor IPC 與 `app.tsx` 接線退出 feature 邊界。                                                                | 完整 form／hold／progress／error／stop／authority flow 只用 public UI／commands／devices，transitive bundle audit 與 installed proof 通過。                 | 3C，**Stage 3 motor public-only**；3E 核銷。                                    |
| `kobrixa.sensor-lab`    | 3D 完整遷移；`renderer/device/sensor-lab-panel.tsx`／chart／controller、`main/sensor-lab/service.ts`／store 的 feature 耦合移除。                                                                      | 公開 charts／status／recording reservation／settings-storage／export／copy 覆蓋現有行為，背景／drain／checkpoint／migration 驗收。                          | 3D，**Stage 3 Lab public-only**；3E 核銷。                                      |
| `kobrixa.device-ev3`    | 3A／3E 遷移 provider、連線／監測／設定；保留 `renderer/device/remote-files-panel.tsx`、`remote-files.ts` 與 `main/device/file-batch.ts`／`remote-files.ts` 的 legacy UI adapter。所有操作先接 broker。 | 連線／監測部分本階段核銷；整列需再有公開 remote filesystem／transfer plan／picker handles／selection／confirmation／partial results，移除檔案 UI 私有接線。 | 3E 追蹤，後續 **S3-Files public UI**；完成前不得將整個 device UI 例外刪除。     |
| `kobrixa.simulator`     | 保留 `renderer/simulator`；私有 preview／simulation DTO、canvas 與 `simulator:prepare`／`cancel` 路徑。                                                                                                | 隔離面板與公開 simulation／debug／source navigation 契約，資源／導航／訊息／失效測試。                                                                      | 後續 simulator owner，**Simulation panel isolation**。                          |
| `kobrixa.collaboration` | 保留 `renderer/collab` 的 `CollabStore`／session／editor binding 與私有 preload；本階段必須將 authority 接 broker。                                                                                    | 公開 room／control／status service 與 UI contract，保留伺服器權限／競態驗證；不以 authority adapter 已完成宣稱 UI 遷移。                                    | 3A 管本階段 authority，後續 collaboration owner，**Collaboration service/UI**。 |
| `kobrixa.editor`        | 保留 `renderer/editor`；Monaco、private models／documents／analysis 與 `EditorCollab`。                                                                                                                | 文件化 editor mount／document／contribution 契約，所有 editor 功能可透過它整合；stage-2 language contributions 不代替此門檻。                               | 後續 editor owner，**Editor/document host contract**。                          |
| `kobrixa.workspace`     | 保留 `renderer/workspace`；`project-tree.tsx`、workspace DTO／save／search／project controllers 及 preload。                                                                                           | 公開 tree／workspace／document／save／search API 與 lifecycle，無私有掛載。                                                                                 | 後續 workspace owner，**Workspace public API**。                                |
| `kobrixa.settings`      | 3B-2 新增公開 contributed settings，3E 遷移設備設定；`renderer/settings/settings-panel.tsx` 的舊 catalog／store 與其他 legacy pages 保留。                                                             | 各 owning feature 以公開 schema／actions 遷移；plugin management／recovery 等必要 core UI 明確列為核心，不當成可停用 feature。                              | 3B-2／3E 管增量，後續 settings owner，**Legacy settings migration**。           |
| `kobrixa.updates`       | 保留 `renderer/updates`、private `UpdateState`／`window.kobrixa.updates` 與 installer；本階段接 device／plugin drain。                                                                                 | 公開通知／面板與受控 update service，installer／close／data-loss guards 有等價驗收。                                                                        | 3E 管相容，後續 updates owner，**Update service/UI**。                          |

另列兩個不屬 §6.2 React rows 的排除項，避免被當成隱含承諾：

| 排除項                  | 處置／退出條件                                                                                                                             | 提出的里程碑                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| HTML panels             | 本階段不實作；先有獨立 host／resource-origin／CSP／navigation／network／bridge validation／teardown／recovery 設計與驗收，才開放複雜面板。 | **Isolated HTML host**，先於使用它的 simulator 遷移。                                   |
| 第三方 device providers | 本階段顯式拒絕宣告；需另定 provider RPC、capability version、physical-device conflicts、containment、native packaging 與失效停止策略。     | **External device-provider contract**；不因第四階段開放第三方 consumer 安裝而自動解除。 |

## 9. 第三階段完成檢查清單

3E 建立 criterion matrix，每項列 implementation evidence、automated evidence、MANUAL evidence、保留例外與實際 artifact／commit。以下均為**待實作驗收**，不是本文件的測試結果；任何必要項無證據都不得勾選完成。MANUAL 項未完成時只能回報「實作已交付，待驗收」。

- [ ] **S3-01／公開契約一致。** 1.5.0 → 1.8.0 的 Zod、JSON Schema、JS／TS、Python、版本／permissions／errors／cancellation／events 一致；schema drift 與共用正反例通過，舊 1.4.0 命令仍可用，不支援 API／UI versions 明確拒絕。
- [ ] **S3-02／JS 與 Python consumer parity。** 使用真正 MessagePort JS 與 stdio Python 開發插件，從 UI commands 執行 discover／read／finite motion／stop、settings、storage／export、subscriptions／unsubscribe；正常、取消、timeout、失權、超限、停用／crash 與 stale generation 結果一致。模擬 provider 可覆蓋自動化，不能省略 Python 只測 TS wrapper。
- [ ] **S3-03／motor private-dependency audit。** 以 source import graph、transitive bundler metadata／產出內容與實際 RPC trace 三者核對，只允許公開 SDK／protocol、feature-owned pure utilities／resources。拒絕 React／Electron API、`apps/desktop/src/**`、私有 controller／DTO、`@kobrixa/device`／helper／compiler backend、`window.kobrixa`／功能專屬 IPC、direct fs／USB／network。SDK 合法的 `process.parentPort` transport 不算 feature 私有 Electron API；不得以 facade、dynamic import、bundle external 或字串 channel 隱藏依賴。
- [ ] **S3-04／motor 公開端到端。** 完整模式／欄位驗證、pointer／keyboard hold、progress／angle／displacement、normal release／brake、error／timeout／unconfirmed／no-authority 全程經公開 router；pending start 時 stop／hide、重複 start、失權於 helper arm 前與每個 jog pulse、late reply 不復活。重新啟用／重啟／reconnect 不重播。
- [ ] **S3-05／broker、provider 與 locks。** fake-provider conformance、非 builtin provider declaration（含空陣列）拒絕、duplicate provider／physical identity、provider disable／disconnect／replacement、cross-owner／generation handles 均有測試；legacy deploy／files／mode／battery／monitor 與 public consumers 無第二套鎖。recording 與 motor 排除、mode pin、reads yield、stop 不死鎖均以實際入口驗證；使用者 Disconnect 的 stop/readback／end/save／disconnect 順序與進度，以及插件 API 對其他 owner 回 busy，分別驗收。
- [ ] **S3-06／collaboration。** host／editor／viewer、request／grant／decline／reclaim／release、demotion／offline／reconnect 與 room 未同步測試；admission 後每個 consequential await 邊界失權都不開始下一次寫入，motion 要求 stop；read／download／stop 保留，偽造 holder／window／owner／download plan 失敗。不能只驗按鈕 disabled。
- [ ] **S3-07／UI 與事件上限。** 未知 component／version、超 bytes／nodes／depth／queue、stale patch／resource generation、subscription leak、slow consumer／event gap 有案例；terminal／stop 狀態不因 telemetry 合併消失，renderer freeze 仍由 main intent expiry 撤銷。最大合法 charts／records 下記錄延遲與記憶體，通過各子規格 T0 固定的 budget。
- [ ] **S3-08／Lab 完整遷移。** 公開 channels／calibration／raw-calibrated display／history／delete／compare／CSV／code-copy／status，隱藏／關閉 view 繼續錄製、一般 stop recording／Disconnect／suspend／provider loss 經 endReservation 收尾且健康 process 存續；停用／renderer crash drain 後 process teardown，明確再開啟才建新 bindings。浮點運算順序、null gaps、segments、extrema、cursor／unit／source 相容及 checkpoints 有 parity fixtures；不保留 private recorder service。
- [ ] **S3-09／設定與資料完整性。** EV3 有真實 public settings consumer，逐欄立即驗證／atomic CAS／field error，無 Apply 按鈕；舊 preferences／Lab history／calibrations 一次性遷移成功且可重入，保留 originals；跨 namespace／revision race／stale commit／quota／disk-full／損壞／強制退出／save retry／分頁／explicit export 全覆蓋。crash 復原只聲稱最後 committed checkpoint。
- [ ] **S3-10／lifecycle 與 safe mode。** §4.7 每一列均有 automated failure-injection，包含 OS suspend 後不自動恢復與 second-instance launch 只聚焦既有視窗；三個 optional features 預設啟用、無 developer mode 也可獨立切換並持久保存，stage-2 必要 compiler 不受影響。驗收 optional-only unclean exit 不鎖 safe mode，第三方／development 風險或 renderer unresponsive 則鎖；core journal／checkpoint 在兩種結果都可見。cold safe mode 在載入 executable／data-only contributions、provider、還原 panel／文件之前生效；全部 optional 關閉仍有 core 管理／recovery／stop-uncertainty view，無自動連線／錄製／motion。
- [ ] **S3-11／close／update／無孤兒。** pending command／motion／read／checkpoint／settings commit 時停用、shutdown、update preparation，均先撤權再 bounded drain／stop，不能提前顯示安全；確認 stop 與已 commit 資料才完成正常 close，force exit 有可復原 fault／checkpoint，沒有 orphan process／lease／subscription。
- [ ] **S3-12／installed-app 自動化。** Forge 產物含各 feature entry／SDK／manifest／UI resources；以不依賴 source tree 的位置、離線及無外部 Node 的環境啟動，完成公開 feature smoke、disable／re-enable、quit。缺檔只報錯、不找 checkout；provider native dependency 布局驗證通過。
- [ ] **S3-13／MANUAL：硬體 motion。** 人工分別以 USB／Wi-Fi 驗收 jog／timed／angle、負載／停止確認、hold release、hide／close／window loss、失權／disable／kill、拔線／失聯與重連；記錄設備／firmware／平台／app artifact／觀察結果。以[現有硬體清單](../../../tests/hardware/motor-test.md)補充 public-route 案例，明確區分要求停止與實際觀察停止，軟體 mock 不可代簽。
- [ ] **S3-14／MANUAL：硬體監測與仲裁。** 實體 EV3 驗證四 channel、mode changes、recording／motor 排除、program／file foreground gaps、斷線／source change 停錄、CSV／校正與最大錄製；含合作持權轉移與 remote-files 共用 broker。記錄部分傳輸／停止未確認情況，不把重連當成恢復原操作。
- [ ] **S3-15／MANUAL：安裝與復原 UI。** 在未掛載 checkout、未提供使用者 Node 的乾淨機器，逐一驗收本階段實際交付的 OS／architecture 安裝產物；`en`／`zh-TW`、明暗主題、320 px 側欄、125% scale、鍵盤／focus／dialog／charts、optional switches、optional-only crash 不鎖 safe mode，以及 renderer unresponsive／第三方風險後的 cold safe mode 與 core recovery。未測平台逐項標記，不能以開發機 bundle 或 stage-2 V03 取代。
- [ ] **S3-16／文件與例外結案。** 雙語 architecture、motor／Lab／device 文件、roadmap、samples、visibility／second-launch smoke 與 §8 ledger 更新，涵蓋插件工具 pane、單一 Disconnect、suspend 與一般使用者開關的行為變更；motor／Lab 退出例外，device-ev3 只核銷完成部分。主規格仍保留的 stage-2 V01–V04 與本階段人工項分開記錄；完整 smoke 的略過／失敗不能記成全套通過。

## 10. 風險與緩解

| 風險                                                                       | 緩解／必備證據                                                                                                                                                  |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| process／renderer hang 後 motion 繼續，或 stop-before-start 被晚到回覆覆蓋 | host gesture expiry、inert reference／tombstone、firmware finite limits、原 ownership stop；於 start／upload／run／arm／pulse／readback 注入取消／失權／crash。 |
| RPC timeout 被理解為未執行，重試造成第二次 movement                        | operation identity／outcome／query 保留；禁止 replay，lost-response 案例確認最多一次發動。                                                                      |
| provider 同程序故障拖垮 main，或斷線無法 brake                             | 保留 firmware watchdog，provider deadlines／readback／quarantine、core journal；清楚標示 in-process containment 與實體停止的限制，硬體 MANUAL 驗收。            |
| public 與 legacy 有兩套鎖／authority，失權後 batch 繼續                    | 所有 consumer 經同 broker；分類每個 mutation，provider 每個 consequential step 查目前 authority；完整 batch／deployment／fake-download 測試。                   |
| 靜態 catalog retry／process restart 混用 generation                        | 分離 execution／resource／session epochs，全部 callbacks 驗 owner／generation；resource retry 不授予 motion 權，stale cleanup 不碰新資源。                      |
| 停用移除唯一 stop／save-error UI                                           | core retained fault／recovery view、bounded cleanup handles／drain token，全部 optional 關閉仍可查看並處理；不靠 feature 的 deactivate 才撤銷權限。             |
| 每次 sample 序列化完整 history、chart 卡住輸入／hold                       | 單 sampler、bounded batches／paged history、局部 renderer state、chart reduction 與 gap accounting；最大資料量下測 stop、cursor、editor response。              |
| Lab crash／quota／migration 造成假成功或資料遺失                           | atomic record commit、checkpoint／CAS、migration marker／originals、disk-full injection；crash 僅恢復已 committed 部分，正常 disable／close 保存失敗保持可見。  |
| UI 元件為了趕移植變成 feature-specific callbacks                           | generic schema／公開 actions，3C public-only proof 作為 v2 擴張門檻；bundle／RPC audit 拒絕私有 facade。                                                        |
| 並行分支修改同一 protocol／manager，版本／回收順序漂移                     | T0、唯一 hotspot writer、版本批次、共用 fixtures、明確 integration dependencies；不以 merge 解決設計差異。                                                      |
| 開發環境成功，安裝版缺 SDK／entry／native dependency                       | Forge whitelist／build outputs 與 installed path 驗證，乾淨離線機器、無 checkout／外部 Node 的自動化＋MANUAL；失敗不得 source fallback。                        |
| 延後範圍被當作完成，或 process isolation 被當作 OS sandbox                 | 逐列 exception ledger、獨立人工證據、保留 trust 說明；外部 provider 與 HTML 必須另立規格，不透過這次 consumer API 默許。                                        |

## 11. 分支與合併規則

整合分支為 **`feat/plugin-system-stage-3`**，從 stage-2 的 **`79a9ea6`** 建立。本文在設計分支 `feat/plugin-3-design` 撰寫並提交，由使用者合入整合分支；設計分支不取代整合分支。

每個子專案從 `feat/plugin-system-stage-3` 的相應 T0／契約基準分出，建議名稱為 `feat/plugin-3a`、`feat/plugin-3b1`、`feat/plugin-3b2`、`feat/plugin-3c`、`feat/plugin-3d`、`feat/plugin-3e`。plan 記錄實際 branch point 與 hotspot writer；依賴契約合入後同步整合分支，不私自從尚未驗收的 sibling branch 取得隱含 API。

各子專案完成 spec／plan／實作／驗收報告後，以 **`--no-ff` 合回 `feat/plugin-system-stage-3`**，保留子專案邊界。**所有 merges 由使用者執行。** 協作者準備可審查的變更與證據，不代替人類合併。

**stage-2 → main 是使用者另行決定的事項**，與第三階段分支建立、設計定稿或驗收互不隱含授權。Stage 3 closeout 也不代表自動合併 main 或開放正式第三方發布。
