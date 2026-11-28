# 宣告式插件 UI v1

此為 API 1.6.0（P160）待發布實作的預覽文件，完整驗收尚未完成。

API 1.6.0 提供純資料的 panel／status。插件是受信任的本機程式；utility process 提供程序隔離，不是 OS 安全沙箱。UI resource 不接受 HTML、JavaScript、CSS、SVG、URL、webview 或遠端內容，控制項由 host 統一繪製。

manifest 使用 `apiVersion: "^1.6.0"`，按需要宣告 `ui.panels`／`ui.status`；version 1 JSON 與 bundle 一起交付。contribution ID 以 manifest ID 加句點開頭，panel 的 location 固定為 right。status v1 只有 text、tone、data 與可選 visibility。static runtime 不可宣告 panel／status，空陣列也不例外。

完整可執行範例在 `tests/desktop/fixtures/declarative-ui`，包含 manifest、JS／Python consumer 與全部 14 種元件：group、text、help、textInput、number、range、choice、boolean、action、holdAction、status、alert、progress、keyValue。每個 field 恰由一個 input node 使用；除 root 外每個 node 恰有一個 parent，全部可達，不可循環。Text 必須有 en，zh-TW 可省略；文字不解析 markup。LocalId 格式為 `^[a-z][a-z0-9-]{0,31}$`。

每份 resource 最多 256 nodes、depth 8、256 KiB 實際 UTF-8 bytes；每 source 最多 1 MiB、host 最多 8 MiB。每 source 最多四個 panel 宣告與兩個 status，host 最多 16 panels／16 status。Unicode code points 與 bytes 分別驗證；請先序列化計算 bytes。超限整份拒絕，不截斷安全提示或控制項。

panel action 引用的 command 宣告 `invocation: "context-v1"` 及有限 scalar arguments schema。JS 使用 commands.registerContext，Python 使用 @plugin.context_command，直接回傳 `{output:{},fieldErrors:[]}`，由 SDK 驗證並封裝 business result；handler 不應自行包上 ok／value。舊 commands.register／@plugin.command 保持 command/execute 與 null result。initialize 原有四欄不變，host 另外協商版本、建立 bindings，再送 ui/ready；三者共用十秒期限。activation 只註冊 callback，不等待需要 ready 的呼叫；初始查詢放在 ready。

ui.instances／ui.state／ui.patch 只操作同 process 的 live bindings。patch 以精確 baseRevision 原子更新已宣告 data，不更動樹、標籤、commands 或輸入中的 draft。每 panel 最多每秒十次，renderer queue 最多四筆／64 KiB。stale 或事件 gap 後先讀 snapshot，由作者決定下一步，不自動重送 mutation。subscription 有界、callback 串行，驗證並成功進有界 queue 後才 ack。events/unsubscribe 首次 removed=true、重送 false；後續 settings watchers 也沿用此唯一 wire method。

context、binding、motion reference、invocationId、actionRef 都由 host 建立，同名 arguments 不會取得權限。invocationId 僅供去重；actionRef 是五秒內一次性的真實使用者動作。1.7.0 才提供 persistence export／copy，不可把 invocationId 當授權。management command 沒有 panel binding／motion scope；timer、ready、heartbeat 不會產生 user action。

hold 由可信 renderer／main bridge 管理，以 100 ms challenge 與 350 ms expiry 限制存活。插件沒有續租 API。release、cancel、lost capture、欄位／模式改變、hide、tab／sidebar 切換、collapse、blur／minimize 都撤銷 view intent；晚到 start／reply 不得復活。要求停止不代表實際停止已確認，core recovery 保留 uncertainty。v1 UI 不提供錄製產品；未來 Lab 隱藏視圖繼續背景工作，由 3D 與正式 persistence 定義 checkpoint。

uiResourceGeneration 與 execution generation／processEpoch、hostEpoch 分離。resource 替換或退休立即撤舊 bindings／gestures。process 只在後續明確操作時 lazy restart，不重播 commands／motion；五分鐘三次失敗後須 reload 或 disable→enable 重設。required builtin 不可停用。已交付 optional builtin 預設 enabled，一般模式即可獨立開關並保存選擇，無須 developer mode。僅 optional 的非正常退出不自行鎖 safe mode；第三方／development 風險與 renderer unresponsive 才鎖。cold safe mode 不啟動 optional process／provider，core management／recovery 仍可使用。

Plugin tools 是同級 tabs，與其他右側 panes 互斥；真正 motor 移出 monitor card 屬於 3C。通用插件設定重用 host 控制項：boolean／choice change 立即套用，text／number 有效輸入在 blur／Enter 提交，reset 只保存該欄，沒有 Apply 按鈕。invalid draft／save error 保留可見；外部 revision 衝突須重新載入或明確 retry。正式 settings／storage 在 1.7.0 交付，僅完成 v1 controls adapter 不代表保存已驗收。

安裝版 layout 固定為 `app.asar.unpacked/.vite/build/plugins/<slug>/main.cjs`、kobrixa-plugin.json、resource-index.json 與宣告的 JSON。SDK／protocol 相依編入 entry，以 Electron utilityProcess／MessagePort 執行，不使用 PATH Node、runtime download、checkout 或 workspace node_modules fallback。index 路徑排序、最多 32 files／16 KiB，記 SHA-256／bytes，entry 最多 16 MiB。hash 用於缺件／損壞驗證，不是數位簽章。3C motor、3D Lab、3E device 依序交付產品；synthetic fixture 不代表三份產品已上線。

desktop 只有一個 profile writer；第二次啟動還原／聚焦第一個視窗，不新增工作台、provider 或 plugin runtime。正常關閉先取得 stop/readback／journal 與 storage disposition，再關閉程序：storage 十秒與 stop 十五秒加 journal 五秒平行，之後 manager 四秒；24 秒 cleanup、25 秒 safety net 不代表自動 force exit。保存／停止未知保留 core blocker。健康 consumer 在 release、Disconnect、suspend、provider loss 後存續；renderer／window destroyed 才 retirement。wake 不自動續 motion／錄製。Lab save／retry／checkpoint 的正式驗收留到 X-T1 與 3D。

Node helpers、真 UI smoke、synthetic installed 與 production packaged smoke 分開記錄，報 artifact／平台、命令 exit、raw traces 與未完成項。兩主題／兩語系、320 px／125%、screen reader、真 USB／Wi-Fi 與乾淨安裝環境由 controller 驗收。Python SKIP、mock ports 或 stage-2 V01–V04 例外都不能改記為整合通過。
