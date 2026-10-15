# 插件系統第二階段待辦：第一階段延後的問題

第一階段（分支 `feat/plugin-system-phase-1`）每個 task 都經過審查，最後也做了整體審查。審查中找到但判定不擋合併的小問題，都整理在這裡，作為第二階段的待辦清單。合併前已經修好的項目不列入。

> 2026-10-15：插件載入 1a（[計畫](2026-10-15-plugin-loading-1a-runtime-hardening.md)）已處理部分項目，並從下表移除。
> 2026-10-15：插件載入 1b（[計畫](2026-10-15-plugin-loading-1b-gui-management.md)）已處理設定頁插件面板的項目，以及「面板沒有取消正在執行的命令的按鈕」，並從下方移除。

- 設計：[插件系統設計](../specs/2026-10-14-plugin-system-design.md)
- 第一階段計畫：[第一階段實作計畫](2026-10-14-plugin-system-phase-1.md)

優先順序：

- **高**：可能讓插件或主程序卡住、資源沒有上限，或錯誤沒被攔住。第二階段開始時先處理。
- **中**：行為不一致或使用者體驗缺口，不會造成資料遺失。
- **低**：測試覆蓋、程式碼整理、文字修飾。

## 高優先

| 位置                                     | 問題                                                                                                                                                                                                    | 建議做法                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `sdks/python/kobrixa/_plugin.py`         | `_send` 沒有檢查 `write()` 的回傳值。在 `-u` 模式下 stdout 是原始的 `FileIO`，寫入不完整時協定格式會壞掉；寫入也會擋住 event loop。                                                                     | 迴圈寫到全部完成，或改用 `asyncio` 的 writer。                                                                                |
| `sdks/python/kobrixa/_plugin.py`         | 同一個 request id 重複出現時會覆蓋 `_tasks`，第一個 task 的 done callback 會刪掉第二個的紀錄，第二個請求就無法取消。                                                                                    | 收到重複 id 時回錯誤，或 done callback 只刪除屬於自己的紀錄。                                                                 |
| `packages/plugin-runtime/src/manager.ts` | 強制關閉後再 `resume()`，supervisor 可能還在自己的停止流程裡，這段時間的命令都會回 `PLUGIN_E_DISABLED`。supervisor 的 `#forced` 也不會重設。                                                            | `resume()` 等所有 supervisor 的 `stop()` 結束；`resume` 時重設 `#forced`。                                                    |
| `tests/desktop/run-plugins-smoke.mjs`    | smoke 沒有證明強制終止這條路徑（Electron 結束時本來就會關掉 utilityProcess，Python 收到 EOF 也會結束）。runner 本身也沒有逾時，如果 Electron 在 `main.cjs` 執行前就卡住，要等到 CI job 的 30 分鐘上限。 | 在主程序記錄 quit 開始和 `will-quit` 完成的時間，斷言少於 `PLUGIN_SHUTDOWN_DEADLINE_MS`；runner 約 90 秒後自己終止 Electron。 |

## 中優先

### 協定（`packages/plugin-protocol`）

- **header 檢查受分塊影響**（`framing.ts`）：`HEADER_LINE` 用的是 `[^\r]*`，整塊送進來時，header 裡的單獨 `\n` 會被接受。改成 `[^\r\n]*`，並確認 Python 端一致（Python 目前也只檢查 `\r`）。
- **同一塊資料裡的有效 frame 會被丟掉**：同一次 push 裡，framing 錯誤之前已經解出的 frame 會一起丟失。TS 和 Python 兩端都是這樣。
- **處理函式結果不合法時會把 ZodError 文字送給對方**：改成通用的 `Invalid result for <method>.`。
- **`onNotification` 處理函式拋錯，會被當成對方的協定錯誤回報**。
- **`request()` 遇到不合法參數時同步拋錯**，而不是回傳 rejected promise；grace 計時器沒有 `unref`。
- **沒有 params 的請求會被 `strictObject({})` 以 -32602 拒絕**：兩個 SDK 都一定會送 params，所以目前沒問題。要在協定文件寫明，提醒未來的 SDK 作者。

### 插件宿主（`packages/plugin-runtime`）

- **`ExitSignal` 沒有攔 listener 的錯誤**，升級終止用的計時器也沒有 `unref`。
- **registry**：
  - 因命令衝突而判定無效的插件，不會保留它的 id；
  - 無效紀錄存的是未解析的目錄路徑；
  - 大小限制的訊息寫死成「64 KiB」；
  - 先 stat 再讀檔之間有競態；
  - entry 可能解析到一個目錄。

### JS SDK（`packages/plugin-sdk-js`）

- **`SDK_VERSION` 是 `0.1.0`，但 package.json 是 `1.0.1-beta.1`**（計畫本身就這樣寫）：選定一個做為唯一來源。
- **收到 `exit` 時沒有先 `shutdown`**，仍然以 0 結束，也不會執行 `deactivate`。依 LSP 慣例應該以 1 結束。
- **`initialize` 收到兩次時會再 activate 一次**，接著因為重複註冊命令而出錯。
- **沒有監聽 MessagePort 的 `close`**：主程序丟掉 port 但沒終止程序時，插件會一直活著。
- **`port.start()` 在掛上 listener 之前就呼叫**：目前因為 Electron 用 macrotask 傳遞訊息所以安全，改成在第一次 `onMessage` 時才 `start()` 比較明確。
- **範例插件的 `void runPlugin(...)`**：沒有 parentPort 時會變成 unhandled rejection，改成明確的 `exit(1)`。

### Python SDK（`sdks/python`）

- **不支援的 schema 關鍵字**：它拋出的 `SchemaError` 跟「值不合法」是同一個型別，而且只在走到的分支才檢查。改用獨立的例外型別，或在初始化時先把整份 schema 掃過一遍。
- **結束碼不對**：
  - frame 讀到一半就遇到 EOF 時，靜默以 0 結束；
  - framing 錯誤也以 0 結束；
  - 兩種都應該以非零結束。
- **`Plugin()` 建立兩次時，協定訊息會被送到 stderr**：第二次會把已經導向 stderr 的 stdout 當成協定輸出。改用 `sys.__stdout__.buffer`。
- **未知的通知方法會以「invalid message」記到 stderr**：TS peer 是安靜忽略，兩邊應該一致。

### 桌面端（`apps/desktop`）

- **`--plugin-python` 的相對路徑不會依 cwd 解析**：直接改成解析會讓 PATH 上的 `python3` 失效，只對含路徑分隔符號的值解析，或在文件說明。
- **`PluginManager.create` 在開視窗之前 await**：
  - 讀開發目錄會拖慢啟動；
  - 一旦 reject，就沒有視窗，也看不到錯誤。
- **`registerPluginIpc` 回傳的 disposer 被 `index.ts` 的 module wrapper 丟掉**。
- **`BuildService` 預設的 `frontendFor` 不管語言都回 `kobrixa.basic-plus`**：加註解說明這只供舊程式和測試使用。
- **`quit.ts`**：`plugins.shutdown()` 如果同步拋錯，程式會無法退出。真正的實作不會這樣，但可以用 `Promise.resolve().then(...)` 包起來更保險。
- **轉送到 console 的插件輸出沒有清理**：行內的 `\r` 或 ANSI 控制碼可以蓋掉 `[plugin <id>]` 前綴。
- **utilityProcess 在 exit 之後才到的輸出不會出現在 console**：Python 那邊最多會等 100 ms 讓輸出串流結束。
- **剛好在 16 KiB 邊界遇到 `\r\n` 時會多一行空行**；以 `\r` 結尾的截斷片段會保留那個 `\r`。

## 低優先：測試與整理

- **協定測試**：
  - manifest 只測了 python runtime，缺版本、apiVersion、activation 格式、陣列上限的反例；
  - rpc 測試偏少；
  - framing 缺自訂 `maxBytes`、剛好 1 MiB、多 frame、body 被切開等情況；
  - peer 缺 -32602、重複 id、`close()` 中止處理函式、寬限期後才到的回應。
- **協定實作細節**：
  - `localizedText` 用 `looseObject`，多出的語系 key 不會被檢查；
  - `grantedPermissions` 的 `.max(16)` 和 sdk name/version 的 64 字元限制沒放進 `PLUGIN_LIMITS`，而且允許重複；
  - 「Message exceeds 1 MiB.」沒有反映自訂的 `maxBytes`；
  - 很小的分塊會讓每次 push 都複製整個 buffer，變成 O(n²)；
  - 可攜性測試只擋 `\d\w\s\b`，沒擋 `\p{}` 和具名群組；
  - 匯出腳本從 `dist/` 產生，drift 測試卻用 `src/`。
- **插件宿主測試**：
  - 64 KiB 大小測試即使拿掉大小檢查也會通過；
  - Windows 的 `skipIf` 範圍太大；
  - 沒測兩個啟用插件或命令衝突；
  - 連續兩次 `kill()` 抓不到計時器重設的 bug；
  - 沒有 `afterEach` 清理子程序；
  - 缺 `restartWindowMs` 滑動視窗、`onStateChange`、`PLUGIN_E_PROTOCOL`、停用時有命令正在執行、`onEvent` 取消訂閱、安全模式下的 `frontendFor`、`store.load()` reject 等測試；
  - 儲存失敗的測試沒有斷言狀態和事件。
- **JS SDK 測試**：
  - 取消的測試只斷言 `rejects.toBeDefined()`，應該斷言 `-32800`；
  - 缺 activate 拋錯、沒有 parentPort 或 `ports[0]`、重複註冊、協定錯誤時 `exit(1)` 的測試。
- **Python 測試**：
  - `test_exits_on_exit_notification_and_on_stdin_eof` 名稱跟內容不符；
  - `acme.behaviors.crash` fixture 沒被用到。
- **桌面端測試**：
  - 狀態檔缺 schema 不合法和上限測試；
  - quit 缺「安全網逾時後放行」和 `timeoutMs` 下限的測試；
  - 缺 `plugins:state` 註冊與 disposer 的測試；
  - 缺未知的非空 frontend id 的測試。
- **smoke**：
  - Python 的正常關閉沒有單獨驗證；
  - 找不到 Python 時 temp 目錄會殘留，應先檢查再 `mkdtemp`；
  - Chromium 和插件狀態共用同一個 user-data 目錄；
  - 當機隔離之後只重新呼叫 hello-ts。
- **重複程式碼**：
  - 找 Python 的邏輯有三份（`test-python.ts`、`run-python-tests.mjs`、`run-plugins-smoke.mjs`，最後一份沒有探測逾時）；
  - `test-process.ts`、`test-python.ts` 放在 `src` 裡，會被編進發佈的 `dist`，應移到不參與 build 的 `test/`。
- **環境**：根目錄的 `vitest.config.ts` 每次執行都會出現「ESM syntax loaded as CommonJS」警告（第一階段之前就有）。
- **文件用詞**：
  - `sdks/python/README.md` 寫「Its entry point is:」，但範例跟 `main.py` 不完全相同；
  - 可以說明 `--plugin-dev-dir` 為什麼要用絕對路徑；
  - `tests/desktop/README.md` 那句 screenshot-retention 說明讀起來突兀；
  - 可以標出請求逾時的預設值（initialize 10 秒、命令 30 秒、取消寬限 5 秒）。

## 第二階段範圍，第一階段刻意不做

以下是整體審查時判定超出第一階段範圍的行為，在這裡記下，供第二階段規劃參考：

- `activationEvents` 目前只做驗證，沒有用來決定何時 activate（任何貢獻的命令都會啟動插件）。
- SDK 在 `initialize` 時不檢查主程序的 `apiVersion`。
- 關閉時不會處理插件自己再產生的孫程序（目前沒有程序樹管理）。
- 沙箱、ReDoS 與 tokenizer 限制：第一階段是可信任插件的模型。
- 語言分析與補全仍直接使用 Basic Plus（設計 §11 的第二階段項目）。
- 一般化成品契約、`Diagnostic.source`、靜態語言貢獻（第二階段）與 `devices` API（第三階段）。
