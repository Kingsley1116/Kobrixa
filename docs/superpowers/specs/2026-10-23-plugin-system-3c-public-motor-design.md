# Stage 3C：公開 motor plugin 子規格（controller 已審閱；authoring 可執行，真實整合 gates 保留）

日期：2026-10-23。本文映射已核准 Stage 3 umbrella，不重設協定。設計已由 controller 依核准 umbrella 審閱；實作、測試與硬體驗收另行記錄，本文不預先宣稱通過。

## 1. 基準與完成界線

- 決策來源：[umbrella](2026-10-17-plugin-system-stage-3-design.md) §4.7、§5.4、§7–9；[3A](2026-10-17-plugin-system-3a-device-broker-design.md) motion／authority／budgets；[3B1](2026-10-17-plugin-system-3b1-declarative-ui-design.md) UI v1、commands、lifecycle、shipped launch。
- 3A 已接受且由使用者合入 `e817e59`。目前 B1 為 API 1.6／K160 實作，P160 native acceptance 尚待 controller 完成／審閱；不得將現有證據或此草稿當作 P160 通過。
- B2／API 1.7 尚未整合。3C 僅需 A＋B1：`apiVersion: "^1.6.0"`、resource v1；不新增 API、wire 欄位、錯誤碼、settings／storage 依賴。
- 交付 `plugins/motor-test/` TS／Node shipped process，完整 jog／timed／relative-angle parity。3C／3D／3E 都在完整 Stage 3 範圍；B1 完成不等於 Stage 3 完成。
- 文件與 mock-driven authoring 可先行；真實產品整合、撤除舊路徑與驗收須等 reviewed P160 gate，並處理 §8 缺口。

## 2. 實際來源與責任

| 現有來源 | 3C 使用方式 |
| --- | --- |
| `packages/plugin-sdk-js/src/{index,commands,devices,ui,events}.ts` | `definePlugin/runPlugin`、`activate/ready/deactivate`、`registerContext`、公開 devices／UI subscriptions／patch；不自行建立 transport |
| `packages/plugin-protocol/src/{device-types,device-methods,ui-resource,ui-types,ui-limits}.ts` | 使用正式 DTO／schema；不複製私有 `MotorTestState` |
| `renderer/device/motor-test-controls.tsx`、`motor-test-controller.ts`、`shared/motor-test.ts`（均在 `apps/desktop/src/`） | 歷史表單、defaults、progress、per-port drafts、release／forced stop parity 參照；feature 不匯入 |
| `apps/desktop/src/main/device-providers/ev3/motion.ts`、`main/device-broker/` | 保留 broker admission、共享鎖、preflight、有限 pulse／helper、安全停止與 journal |
| `apps/desktop/src/main/index.ts` 的 `new MotorTestService` | 目前 legacy façade 未供 motion scope、拒絕 starts；舊 smoke fixture 不能充當目前產品 native parity 證據 |
| `tests/desktop/motor-test-smoke.mjs` | 現有 inline cards／private service smoke；必須以公開產品路徑替換，其「切 pane timed 繼續」斷言須反轉並增加競態 |

安全排程全留 host／provider：100 ms host challenge cadence、350 ms panel／gesture lease、固定 operation／exchange／stop budgets、400 ms 以內有限 jog pulse、jog／angle 10 秒 movement 上限。插件不得 timer 續租、補發 pulse、延長 deadline 或直接管理 helper。host 停頓時的 firmware bounds 不等於 readback 已確認。

## 3. 使用者流程與 UI v1 映射

1. 使用者開啟右側「插件工具／Plugin tools」的 motor sibling tab（`rightPanel: "plugins"`），不是 monitor output card。冷啟動／開 panel／重啟均不自動 connect、enable provider 或 motion。
2. `ready` 讀 `devices.negotiate/list` 與 `ui.instances`，訂閱 catalog／instances／environment；初始化不等待實體連線。optional provider disabled／failed／缺 finiteMotion 能力時，panel 明確顯示 unavailable 原因及手動管理說明，core recovery 仍可見。
3. 顯示目前唯一 session 的名稱、transport、state；契約 `deviceListValueSchema.sessions.max(1)`，不假造多 session selector。以公開「使用目前連線」command 明確選取，handler 重新 list/session 驗證。沒有 session 時指引使用既有連線 UI；3E 未交付前可用 legacy core connection UI，不授予 motor `devices.connect`。
4. `devices.session({sessionId})` 取得 `sources.actuators`。UI 提供固定 A–D port choice；依 catalog 顯示各 port 狀態，command 將所選 `portId` 解析為該 session 的最新 `actuatorId`。選到 empty／unknown／initializing／error 時拒絕 start，不能由 slot index 直接組設備命令。
5. session／source revision 改變先停止原 operation、撤銷舊選取；重新顯式選取，不把舊 actuator handle 套到新來源。重連／provider 恢復只刷新可用性，絕不恢復 motion。
6. 選擇模式與參數，jog 用正向／反向兩個 `holdAction`（pointer 或 Space／Enter）；timed／angle 用 activate。hold end 使用 configured stop，cancel／明確 Stop／失權等安全撤銷要求 brake；host 可強制升級 brake。
7. panel 顯示準備階段、運轉、停止中、終態、角度、位移、elapsed、進度與 error；離開 tab／pane 就停止，重開不續作。status contribution 顯示摘要；core safety strip 的 stop／uncertainty 不依賴 feature 存活。

UI v1 不支援動態 choice options 或 patch field draft；不用新能力補洞：

- 一個 panel，以 `port` enum 切換四個固定表單群組，各 port 六欄（power／seconds／degrees／direction／brake／mode），共 25 fields；每欄只由一個 input node 引用。session selection 是 command＋data summary，不增加動態 enum。
- hidden port／不適用模式的 fields 不參與 start validation；使用既有 visible／enabled／requiredWhen 與 action form snapshot。所有 fields／nodes／條件／UTF-8 bytes 實際交 validator，須落在 32 fields、256 nodes、64 data slots、16 KiB form 等 v1 budgets 內。
- per-port draft 留在 host renderer 的同一 panel binding；切 port／切模式不以 `ui.patch` 重設輸入。close／reopen 的舊功能 parity 另見 §8；不宣稱插件能讀每次 keystroke。
- 使用 `number/range/choice/boolean`、`status/alert/progress/keyValue`；動態文案用 bounded data text，en／zh-TW 完整。status tone 是靜態 schema，採固定中性 tone＋明確狀態文字；錯誤警示在 panel／core，無須改 schema。

## 4. 表單與結果 parity

| 項目 | frozen 契約與行為 |
| --- | --- |
| defaults（每 port） | power 20、seconds 1、degrees 90、direction +1、brake true、jog |
| power／direction／brake | 整數 1–100、`1/-1`、boolean；jog 方向取實際 hold 按鈕 |
| timed | seconds finite 0.1–5，轉 `Math.round(seconds * 1000)` 為整數 100–5000 ms；不發多餘 degrees |
| angle | 整數 1–3600；公開 mode 為 `relative-angle`，不發 durationMs |
| validation | 空白／null 阻擋 start；range／格式錯誤有 field message；非作用模式欄位不阻擋。host 初驗＋handler 快照重驗；Stop／release 不受 invalid form 阻擋 |
| admission | 最新 session／actuator ready、finiteMotion、context authority、host motion scope；busy／recording／program／stale／unsupported 原因依公開結果呈現，不先改設備狀態解鎖 |
| progress | timed＝elapsed/duration；angle＝abs(displacement)/degrees；jog＝elapsed/10000；clamp 0–1，null 讀值顯示無讀值，不冒充 0° |
| 結果 | 保留 preparing/running/stopping/completed/stopped/timeout/failed/unconfirmed，另顯示 stage；`movement`、`dispatch`、`stopRequested`、`stopConfirmation` 分開呈現 |

`timeout` 或 RPC exception 不能推導已停止；只有 broker snapshot 的 confirmation 才能宣稱停止已確認。`brakeRequired` 優先於表單 coast。`PLUGIN_E_DEVICE_BUSY/AUTHORITY/UNAVAILABLE/OPERATION/STOP_UNCONFIRMED` 與原 detail 原樣分類，另有 UI／transport failure 文案，不創造新 codes。

## 5. 公開操作狀態機

- `activate` 只註冊 namespaced context-v1 commands；`ready` 建 subscriptions／取得 snapshots；`deactivate` 取消 observation、unsubscribe、盡力 stop，不作安全唯一來源。
- session selection／refresh commands 不啟動設備。start 必須來自 live panel invocation，具 host 給的 `contextRef`、`motionScopeRef`、binding；jog begin 額外帶原 `gestureRef`，不可自行產生這些 handle。
- 每次真實動作重新驗證快照，`motion.prepare` → 記住回傳 operationId → 訂閱／query 原 operation → 最多一次 `motion.start`。一個 active operation；重複 begin／activate 不建立第二個 prepare。
- 每個 await 後重驗本地取消／binding／selection generation；這只是防止 stale feature state，不能代替 broker 的 consequential authority checks。
- stop／hide 發生於 prepare 未回覆時：先標記 cancelled；host 已撤 scope。late prepare 只可對原 ID stop/query，不能接著 start。start pending 時同樣先 stop 原 ID；晚回覆不得把 stopping 改回 running。
- start 回覆遺失／timeout：保留原 ID、公開 query 同一 operation，必要時 brake stop；不重送 start、不重新 prepare、不換新 ID「試一次」。prepare 回覆遺失沒有可查 ID時保留未知結果、依 host scope 撤銷與 core fault 對帳，不重試 motion。
- motion subscription 以 operationId／revision 隔離；overflow／sequence gap 用既有 snapshot/query 恢復，永遠不重播 motion。UI stale revision 只重讀／重新計算 presentation patch。
- 觀察／presentation bounded、合併 progress，低於 10 patches/s／instance；terminal／stop／authority 走既有 control lane。單一訂閱／查詢工作可取消，終態、close、disable 時回收，無無限 retry queue。

## 6. lifecycle 必驗矩陣

| 事件 | 產品行為與安全責任 |
| --- | --- |
| hold release | 原 gesture 結束，configured stop；cancel／pointer-cancel／form-change／action disabled 改 brake，不需等待 begin handler 返回 |
| hide／收合／切 sibling tab／切其他 pane／CSS hidden | 所有模式撤 scope／續租並 stop/readback，含 start 未回覆；恢復可見不恢復原動作 |
| panel close | 銷毀 binding 前 stop；late patches／commands 無效，core 保留 uncertainty；草稿獨立於 operation（§8） |
| blur／window hide／minimize／document hidden／destroyed | host 撤權＋stop，不靠 React cleanup；destroyed／renderer loss 依 umbrella retire owner |
| authority loss／viewer／未同步／offline | 拒絕新 motion；已受理於每個 await boundary 擋下一寫入並要求停止；允許 query／stop，不能只測 disabled button |
| motor disable／plugin kill | host 先阻擋 admission、stop、withdraw UI／commands、bounded shutdown；重啟新 generation，不 replay |
| provider disable／拔線／失聯 | 新操作 unavailable，host cleanup／readback；未確認 quarantine／core fault。motor 不被永久連帶停用，provider 恢復不連線／續作 |
| suspend／resume | suspend 要求 stop；未確認保留 core。wake 先對帳，不延長原期限、不自動續作 |
| app close／update／force exit | 先撤權再 bounded stop；正常 close 未確認保留 blocker，force exit 留 journal uncertainty，不宣稱實體已停 |
| safe mode／全部 optional disabled | 啟動前抑制 feature／provider／panel restore；core management／recovery／stop view 保留，無自動 connect／enable |
| second instance | 聚焦既有視窗後退出，不生 process／operation、不重播；既有撤權狀態仍有效 |

motor／Lab／device provider 三個一般使用者開關各自獨立且持久保存，不需 developer mode；必要 compiler 政策不變。optional-only crash 不新增 safe-mode lock；renderer unresponsive／第三方風險遵循既有鎖定規則。健康 process 在一般 hide／suspend／provider loss 可存續；renderer loss 後須明確 open 才啟動新 generation。

## 7. Shipped artifact 與私有路徑退出

- 固定輸入：`plugins/motor-test/src/main.ts`、`kobrixa-plugin.json`、`panel.json`、`status.json`；panel ID `kobrixa.motor-test.panel`、status ID `kobrixa.motor-test.status`，resource declaration `{version:1,path}`。
- manifest：id `kobrixa.motor-test`，Node entry `main.cjs`，API `^1.6.0`，permissions 僅 `devices.read/devices.control/ui.panels/ui.status`；`requires.devices` 列 required `finiteMotion.v1`；`onPanel:kobrixa.motor-test.panel` lazy activation；commands 為本插件 context-v1。缺能力呈現 unavailable，不能阻擋一般管理／core recovery。
- 依現有 `vite.plugin-motor.config.ts` → `vite.plugin.config.ts`（target node24／CJS／inline bundle）；SDK／protocol 由既有 public aliases 打包。`plugin-resource-index.ts` 生成帶 bytes／SHA-256 的 index，檢查 declared JSON，禁止引用 checkout。
- K160 現況 `apps/desktop/packaging.ts:DELIVERED_BUILTIN_PROCESS_BUILDS` 為空；integration owner 登記 motor leaf，Forge 與 `tools/release/desktop-packaging.mjs` 共用該表。產品交付後 fixture 模式與 motor identity 衝突會拒絕，需將 installed acceptance 改用真實產品，不能假稱現有 fixture 就是 motor。
- dev leaf `.vite/build/plugins/motor-test/`；installed leaf `<resources>/app.asar.unpacked/.vite/build/plugins/motor-test/`，含 `main.cjs`、manifest、兩 JSON、`resource-index.json`。沿 `builtin-launch.ts` 驗完整 immutable leaf，再由 `launchers.ts` 的 Electron utilityProcess／MessagePort 啟動；不需使用者 Node、cwd／workspace symlink／node_modules fallback。
- optional builtin registration 接 `main/plugins/builtin.ts`／現有 launch descriptor；panel/status 接現有 `renderer/plugin-ui/{panel-host,status-host,bootstrap}.tsx/ts`，不新增 motor React renderer 或 feature callback adapter。
- public-only audit：source import graph＋transitive bundle metadata／內容＋實際 RPC trace 三者一致。只許 public SDK／protocol 和 feature pure modules；拒絕 React、Electron feature API、desktop source、私有 DTO／IPC、`window.kobrixa`、device／backend／helper、direct fs／USB／network，包含 dynamic import／external／字串藏通道。SDK 自身 parentPort transport 例外由既有契約允許。
- 真實 replacement 通過後，由 renderer integration owner 撤 `MotorTestControls`／`MotorTestController` 在 `monitor-panel.tsx`／`app.tsx` 的 mount、effects、drain/busy feature adapters；main owner 撤 legacy start/keepalive/state/stop IPC、preload/shared API 與舊 service composition 的 feature 接線。逐一查 callers，保留 core stop、Disconnect／shutdown coordination、broker locks、provider motion engine／image 等安全依賴；不得按檔名整批刪除。

## 8. 真正阻擋完整 parity 的缺口：C-G1（B1 owner amendment 已核准，實作與驗證中）

來源精確定位：`motor-test-controller.ts:getSettings/saveSettings` 的 Map 由 controller 持有，`MotorTestControls` 的 effect 將每次修改存入，收合／重開仍保留各 port 設定；但 `renderer/plugin-ui/bootstrap.ts:RendererSession.close` retire state 並刪 record，`packages/plugin-runtime/src/ui-state.ts:open` 從 `field.initial` 建新 form。B1 §6／`ui/patch` 明定只能改 data，公開 `ui.form` 亦只給 accepted action 快照，不能保存／回填尚未提交的 raw draft。

固定四群組可保留同一 binding 內 per-port drafts，無法證明 close／reopen 完整舊行為。此缺口阻擋「完整 parity／移除 legacy」簽核，不阻擋 pure feature／resources authoring。不能以私有 setForm、假 storage API、改 resource initial、每 keystroke command 或縮減成只記最後一次 start 參數解決。

最小 owning amendment：由 **B1 generic renderer／UI state owner** 在 B1 §6 補上 workbench 內、同 resource generation／digest 的 bounded volatile draft retention（含未提交／invalid raw、選取與四 port fields），close/reopen 只還原 UI draft；絕不還原 binding／scope／gesture／operation／authority。沿既有 contribution／field／byte admission，替換／retirement／renderer teardown／safe mode 清除；不得新增 wire、API minor、error code 或 feature adapter。controller 已固定 cache key 包含 sourceKey/pluginId/id、hostEpoch、uiResourceGeneration、resourceDigest，且禁止跨 execution generation/processEpoch 還原。容量為最多 16 筆，每筆 draft+raw 的 UTF-8 序列化最多 32,768 bytes、總量最多 524,288 bytes，採 deterministic LRU；超限整筆不保留，清除規則如上。實作與獨立驗證由 B1 owner 持有；未完成前不得宣稱 parity 通過。

未找到需要新增 motion RPC／UI v2 的其他 blocker。P160 是外部整合 gate，B2 persistence 尚未整合是已知 Stage 3 後續事項，兩者不應誤寫為本插件新協定需求。

## 9. 驗收與交付聲明

具體 write sets／tests 見 [plan](../plans/2026-10-23-plugin-system-3c-public-motor.md)。必要證據包含實際 SDK／RPC compose、真實 generic renderer、shipped installed product、公開依賴 audit、motor-smoke replacement 及 §6 failure injection，不能用 units／mock-only 給 native PASS。

人工實體 EV3 gate **尚未執行**：USB／Wi-Fi 各自驗 jog／timed／angle、負載、release／hide／close／blur、持權轉移、disable／kill、拔線／失聯／重連與停止確認；記設備／firmware／平台／artifact hash，分別記「要求停止」與「實際觀察停止」。人工安裝／locale／theme／320 px／125%／keyboard gates 同樣保留未驗收。3E 最後核銷 S3-03/04、相關 S3-06/10–13/15/16，不能由此文件勾選。
