# 架構與公共契約

## 系統結構

```text
Monaco 編輯器 + React renderer
          │ 白名單 contextBridge API
          ▼
Electron preload bridge
          │ 經驗證的 Electron IPC
          ▼
Electron main process（Node.js）
          ├─ 工作區服務 → 已解析的內建語言前端
          │              → 具型別 KobrixaIR + 驗證
          │              → 已解析的後端 → 經驗證的成品組
          └─ 設備服務 ───────────────────→ USB HID / Wi-Fi
```

React renderer 只管理呈現狀態，不能直接存取 Node.js 或 Electron API。範圍精簡的 preload API 透過 `contextBridge` 呼叫 Electron main process 中已驗證的 IPC handler。Node.js 服務負責檔案系統存取、編譯執行、取消、設備 session 與結構化錯誤。任何編譯階段都不得依賴 UI。

## 倉庫邊界

- `apps/desktop`：Electron main 與 preload process、React renderer、Monaco 整合、本地化與使用流程。
- `apps/collab`：雲端協作服務，由 Cloudflare Worker 與每個房間一個 Durable Object 組成。桌面編輯、編譯與設備操作不依賴此服務。
- `apps/web`：產品頁、雙語文件、素材庫介面及其 Cloudflare Worker。桌面編輯與編譯不依賴此服務。
- `packages/compiler`：建置 session 協調與診斷彙整。
- `packages/ir`：由語言前端和後端共用的版本化 IR 型別、驗證與序列化。
- `packages/backend-ev3`：確定性的 EV3 VM lowering 與 `.rbf` 封裝。
- `packages/collab-protocol`：桌面應用程式與 `apps/collab` 共用的協作通訊契約，包含 Y.Doc 結構、訊息與關閉代碼、各項上限，以及房間、邀請、權杖、在線狀態、聊天與設備控制權的 zod schema。
- `packages/device`：transport 中立的設備操作，以及 USB、Wi-Fi 實作。
- `frontends/basic-plus`：clean-room lexer、parser、語意分析與 IR lowering。
- `tools/release`：壓縮包檢查、簽章驗證與 GitHub Release 草稿管理。`.github/workflows/release.yml` 協調各平台原生建置。

相依方向朝向共享契約。編譯器和設備 package 必須能被未來 Node.js CLI 使用，而不必匯入 Electron 桌面程式碼。

## 桌面原始碼目錄

`apps/desktop/src` 先依程序邊界分層，再按功能分組：

```text
src/
├─ main/                 # Electron 啟動與 IPC 組裝
│  ├─ device/            # EV3 連線、遠端檔案與批次傳輸
│  ├─ language/          # 診斷服務、worker 與訊息協定
│  ├─ window/            # 原生視窗鍵盤協調
│  └─ workspace/         # 本機專案、編譯與範例驗證
├─ preload/              # contextBridge 入口
├─ shared/               # 跨程序 API 型別與鍵盤契約
└─ renderer/             # React 入口與 App 組裝
   ├─ components/       # 通用選單、圖示、對話框與選取元件
   ├─ device/           # EV3 面板、遠端檔案狀態與操作介面
   ├─ editor/           # Monaco、格式化與即時診斷
   ├─ execution/        # 編譯／部署／執行狀態與版本顯示
   ├─ i18n/             # 共用介面文案與語系型別
   ├─ keybindings/      # 命令目錄、錄製、搜尋與 Monaco 適配
   ├─ settings/         # 偏好設定、保存、主題與設定頁
   ├─ styles/           # 樣式入口、工作台與快捷鍵樣式
   ├─ workbench/        # 工具列、歡迎頁、診斷面板與布局狀態
   └─ workspace/        # 檔案樹、草稿與儲存協調
```

測試與對應模組放在同一目錄；跨程序操作測試留在 `apps/desktop/tests` 與 `tests/desktop`。功能內的文案留在所屬功能，共用文案才放入 `i18n`。`components` 不依賴功能模組；需要共用元件時直接匯入其檔案，不透過大型 UI 匯出集合。`main/index.ts`、`main/ipc.ts` 與 `renderer/app.tsx` 負責組裝各功能，`shared` 不匯入程序端實作。

語言 worker 原始碼位於 `main/language`，Forge 將它輸出為與 `main.cjs` 同層的 `language-worker.cjs`。每次桌面建置另使用 `main/workspace/build-worker.ts`，封裝為 `build-worker.cjs`，執行前端、IR 驗證、後端與成品提交。編譯器在同步工作期間也會檢查共享取消旗標。Worker 異常／退出只回報一次失敗並解除忙碌狀態；關閉最後一個視窗會要求取消。`styles/index.css` 明確保留工作台樣式先於快捷鍵樣式的載入順序。

共用介面行為集中在 `renderer/components`：`Dialog` 以 `Modal` 為基礎，處理無障礙標題與表單送出，`DialogActions` 負責呼叫端提供的按鈕布局。驗證、忙碌狀態、初始焦點、關閉條件與焦點還原選項仍由各功能決定。`ClosableTab` 共用檔案／設定分頁呈現，`ResizeHandle` 管理滑鼠與鍵盤縮放及事件清理，`menu-keyboard` 提供操作選單與右鍵選單的鍵盤導覽。設定專用的 `SettingField`、`SettingSelect`、`SettingToggle` 留在 `renderer/settings`，統一關聯標籤與提示，不負責偏好保存。

## 多專案工作階段

`ProjectSessions` 依專案 ID 管理文件與編輯位置，`EditorModels` 保留 Monaco model 與復原歷史；可見編輯器卸載時解除綁定，關閉專案才釋放 model。背景專案沿用自動儲存與草稿佇列，語言分析與補全僅服務目前專案。`ExecutionController` 分開目前編輯專案與作業所屬專案，將診斷及最新編譯版本歸屬原專案，並保留全域 EV3 連線與單一部署版本。

主程序以實體根目錄去重，並透過 `workspace.restoreSession`、`workspace.saveSession`、`workspace.close` 管理註冊與工作階段。`workspace-session.json` 位於使用者資料目錄，使用版本化驗證與原子寫入，保存來源路徑、入口選擇、專案／檔案順序及編輯位置；renderer 僅用已註冊 ID 提交狀態。草稿沿用原有格式。退出握手等待所有草稿與狀態寫入，失敗則保持視窗開啟；重新啟動不恢復復原歷史、設備連線或執行指令。

## 雲端協作

```text
主持人 renderer（協作分頁）               來賓 renderer
  │ Monaco ⇄ Y.Doc 綁定                     │ Monaco ⇄ Y.Doc 綁定
  │ 經 preload／IPC 呼叫 CollabApi          │ 經 preload／IPC 呼叫 CollabApi
  ▼                                         ▼
主持人 main process                       來賓 main process
  │ 建立房間・變更角色・移除參與者         │ 以邀請碼加入
  │ 真實專案資料夾                         │ 鏡像於 <userData>/collab/<room>/
  ▼                                         ▼
        HTTPS（房間／加入）+ WebSocket（Yjs 同步、awareness、通知）
                              │
                              ▼
          apps/collab — Cloudflare Worker（路由、HMAC 權杖）
                              │
                              ▼
          CollabRoom Durable Object — 每個房間一個
          Y.Doc：files・tree・chat・control・meta
          儲存在 Durable Object SQLite storage
```

- main process 透過 HTTPS 建立與加入房間、僅在程序記憶體保存房間權杖（不存取鑰匙圈），並從 `KOBRIXA_COLLAB_URL` 或預設的 `https://collab.kobrixa.com` 決定服務來源。Content-Security-Policy 只允許該來源的協作連線。
- 主持人可設定選用的房間密碼。Durable Object 在允許來賓加入前，檢查使用伺服器金鑰與隨機鹽值的 PBKDF2-SHA256 驗證值，並持久保存每個客戶端的密碼嘗試限制。密碼不會加入共享文件、權杖或本機偏好設定；既有房間保持無密碼。
- renderer 以權杖開啟房間 WebSocket，並把 Monaco model 綁定到房間的 Y.Doc；遠端游標與在線狀態使用 Yjs awareness。
- `packages/collab-protocol` 是桌面應用程式與服務之間唯一的契約，雙方都以其 schema 驗證請求與訊息。不相容的變更必須遞增 `COLLAB_PROTOCOL_VERSION`。
- 權杖由 Worker 以 `COLLAB_SECRET` 進行 HMAC-SHA256 簽署，有效期限 7 天，並帶有參與者角色。Durable Object 負責執行角色限制：拒絕檢視者的文件更新與聊天訊息。
- Durable Object 執行房間上限（16 人、200 個檔案、每檔 1 MiB、檔案 UTF-8 內容合計 8 MiB、500 則聊天訊息）。編碼後的文件快照及單一 WebSocket 訊息上限為 16 MiB；資料夾不計入檔案數量。連續 7 天沒有連線後會刪除房間儲存資料。
- 角色變更時，renderer 會建立新的 session，從伺服器載入文件並保留原工作區綁定，避免升為編輯者後重送已被拒絕的檢視者編輯或殘留的 Yjs 時序依賴。
- 設備操作維持在各參與者本機的 main process。房間啟用期間，未持有設備控制權的視窗所發出的設備寫入操作會被拒絕；停止程式則一律允許。
- 房間狀態會經過 Cloudflare 網路。記錄檔不得包含原始碼內容、聊天文字、密碼或權杖。

## 插件（開發預覽）

第一階段支援可信任的本機 JS／TS 與 Python 插件。第三方插件只在開發者模式載入；開發者模式預設關閉，需在「設定 → 插件」經過原生確認對話框才能開啟。面板透過原生資料夾選擇視窗連結插件資料夾、選擇 Python 直譯器、列出內建與開發插件及其載入錯誤、訊息與日誌，並提供執行與取消貢獻命令，以及重新載入、啟用、停用、解除連結開發插件的操作。詳見[可執行範例](../../plugins/samples/README.md)與 [Python SDK](../../sdks/python/README.md)。

公開 API 分成三層：JSON-RPC 2.0、Zod 定義與已提交的 JSON Schema，以及語言 SDK：

- `packages/plugin-protocol`（`@kobrixa/plugin-protocol`）以 Zod 為撰寫來源。已提交的 `schema/plugin-protocol.schema.json` 是跨語言公開契約。測試會在記憶體中重新產生 schema，與包含 Python SDK 副本在內的兩份已提交檔案比較；`conformance/cases.json` 中共用的有效／無效案例用來確認 TypeScript 與 Python 驗證器的行為一致。
- `packages/plugin-runtime`（`@kobrixa/plugin-runtime`）負責 manifest 驗證、註冊表、命令路由與程序監督，不依賴 Electron。桌面程式提供程序啟動器與持久狀態儲存。
- `packages/plugin-sdk-js`（`@kobrixa/plugin-sdk`）為 JS／TS 插件提供 `definePlugin`、`runPlugin`、帶有 `AbortSignal` 的命令處理函式，以及 `context.ui.showMessage`。
- `sdks/python`（套件名稱為 `kobrixa-plugin-sdk`，匯入名稱為 `kobrixa`）支援 Python 3.10 以上，執行時只依賴標準函式庫。SDK 以隨附的已提交 JSON Schema 驗證協定資料，通訊資料使用一般字典，不產生 Python 型別綁定。

JS／TS 插件在 Electron `utilityProcess` 子程序中執行，透過傳入的 MessagePort 交換 JSON-RPC 訊息。Python 插件使用明確指定的本機直譯器，在獨立程序中執行，透過 stdin／stdout 與 `Content-Length` 訊息邊界通訊。Python stdout 只用於協定訊息，日誌寫入 stderr。Kobrixa 不下載或管理 Python 執行環境。

桌面主程序以 `PluginController`（`apps/desktop/src/main/plugins/controller.ts`）包住 runtime 的 `PluginManager`。它負責開發者模式、原生對話框、Python 探測、日誌與訊息緩衝及 session marker，並檢查 renderer 送來的每個要求：開發者模式、安全模式與是否正在關閉都在主程序檢查，而且在對話框關閉後會再檢查一次。renderer 只傳來源 key、命令 ID、布林值、Python 候選 ID 與日誌游標，從不傳路徑或執行檔。這能防止沒經過使用者選擇就加入任意路徑或執行檔，但防不了已經被入侵的 renderer。

連結時會儲存資料夾的實際路徑（`fs.realpath`），來源 key 由它計算，所以同一個資料夾不會被連結兩次。Python 候選（`python3`、`python`、Windows 的 `py -3`、保存的選擇，或用「其他…」選的檔案）不經 shell 探測，限時 3 秒、輸出上限 4 KiB；可用的直譯器必須是 Python 3.10 以上，且能匯入 API 主版號相同的 `kobrixa` SDK。

Python 的 stderr 與 JS／TS 的 stdout／stderr 會保存在主程序記憶體，供面板的日誌檢視使用（每個插件 256 KiB、合計 4 MiB，先丟最舊的行，移除控制字元，解除連結時清除），同時寫到主程序的終端機／主控台，每行加上 `[plugin <id>] ` 前綴。UTF-8 輸出會跨資料區塊解碼，結束時也會輸出最後未換行的內容。Python SDK 在建立 `Plugin()` 時便將 `print()` 導向 stderr，涵蓋呼叫 `run()` 之前的輸出；建立實例之前的日誌須明確寫入 stderr。

進階啟動參數只對本次執行有效，從不保存：

| 開關                            | 效果                                                                                                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--plugin-dev-dir=<folders>`    | 本次執行載入每個指定資料夾的 `kobrixa-plugin.json`，不需要開啟開發者模式。macOS／Linux 以 `:` 分隔資料夾，Windows 使用 `;`。相對路徑以啟動時的工作目錄為基準；建議使用絕對路徑。 |
| `--plugin-python=<interpreter>` | 本次執行改用這個本機 Python 執行檔，不使用保存的選擇。請將 SDK 安裝到此直譯器的環境中。                                                                                          |
| `--safe-mode`                   | 在註冊貢獻或啟動程序之前，停用本次執行的所有開發插件。內建插件保持啟用。「恢復插件」無法解除。                                                                                   |

`<userData>/plugins/state.json`（schema 第 2 版）保存開發者模式、連結的資料夾、選擇的 Python 直譯器、重新啟動後也保持停用的插件來源 key，以及安全模式鎖。檔案無法讀取時，第三方插件保持關閉，不會覆寫該檔案。

`<userData>/plugins/session.json` 記錄是否有第三方插件程序執行過、視窗是否停止回應；它以同步方式寫入，正常結束時刪除。下次啟動時若檔案仍在且任一旗標成立，Kobrixa 會寫入安全模式鎖：第三方插件保持暫停，並顯示提示橫幅，直到使用者按「恢復插件」。視窗卡住過的話，即使之後正常結束也會保留 marker。安全模式中無法啟用、連結或重新載入開發插件，但仍可停用或解除連結。

第一階段的方法如下：

| 方法              | 契約                                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `initialize`      | 宿主請求，傳入 API 版本、宿主指定的插件 ID、語系與已授予權限；插件回傳其 API 版本及 SDK 識別資訊。                            |
| `command/execute` | 宿主請求，指定已貢獻的命令；執行成功回傳 `null`。插件在執行命令時按需啟動。                                                   |
| `shutdown`        | 宿主請求，要求正常關閉；成功回傳 `null`。                                                                                     |
| `exit`            | 宿主通知，要求在關閉後結束程序。                                                                                              |
| `ui/showMessage`  | 插件請求，傳入嚴重程度（`info`、`warning` 或 `error`）及訊息；需要 `ui.notifications` 權限，回傳 `null`。訊息顯示於插件面板。 |
| `$/cancelRequest` | 通知，指定要取消的請求。JS／TS 處理函式收到已取消的 signal；Python 處理函式收到 asyncio 工作取消。                            |

宿主以綁定的通道判定呼叫者身分，不採信訊息自行提供的插件 ID。請求有逾時限制；插件若未在取消寬限期內結束請求，程序會被終止。當機會拒絕尚未完成的命令，不會重播。後續明確執行命令時可以重新啟動插件，但五分鐘內發生三次程序失敗，就會停止後續啟動，直到將插件停用後再啟用。停用插件會解除命令註冊並停止其程序。

這些是**可信任的本機插件**。獨立程序提供當機隔離；manifest 權限僅限制透過 Kobrixa 的呼叫，**不是作業系統沙箱**。插件程式仍可直接存取檔案與網路。

插件 API **1.3.0** 支援編譯前端、後端與 `contributes.diagnosticHelp` 宣告。`kobrixa.basic-plus` 提供語言 `bp`，獨立的內建插件 `kobrixa.ev3` 提供目標 `ev3-native`；兩者都宣告 IR `{ min: 1, max: 1 }`，安全模式下仍保留，並沿用第一階段的內建停用限制。有效的 API 1.0、1.1、1.2 插件仍相容，但外部插件宣告 `frontends` 或 `backends` 時，整個插件無效（`PLUGIN_E_FRONTEND_REQUIRES_BUILTIN`／`PLUGIN_E_BACKEND_REQUIRES_BUILTIN`）。本版沒有外部編譯 RPC。

宿主為每個語言／目標解析唯一、有效且已啟用的提供者。衝突的提供者全部以 `PLUGIN_E_PROVIDER_CONFLICT` 失效，不依載入順序取首筆；重新檢查提供者集合時排除停用者，清除已消失的衝突。IR 版本選前後端範圍交集的最大值。找不到提供者或發生衝突時，在開 worker 前回 `BUILD1001`；IR 不相容回 `BUILD1002`。

前端宣告入口與來源副檔名；後端宣告成品 slot、kind、mediaType、副檔名、role 與 required，實際只回傳 slot／bytes。宿主保留 `ir`、`asset` slot，並負責產生資源成品。可部署後端必須宣告唯一、必填且非空的 `deploy-main`。每個插件最多 8 個前端、8 個後端，每個後端最多 16 個成品宣告；ID 格式為 `/^[a-z][a-z0-9-]{0,31}$/`，副檔名為 `/^[a-z0-9]{1,16}$/`。提交的 JSON Schema 驗證結構，宿主另外檢查副檔名子集、IR 閉區間、slot 唯一性與主檔關聯。

插件 API **1.3.0** 新增 `contributes.languageServices`。只有內建插件可宣告，空陣列也受限制；開發插件會收到 `PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN`。宣告必須包含 `analysis`，由同插件的 frontend 擁有該語言，且副檔名集合必須與該 frontend 的 `sourceExtensions` 完全相同。每插件最多八筆服務。有效的 API 1.0、1.1、1.2 插件仍相容。

main 依通過驗證的專案語言選取啟用中的 frontend 擁有者，backend 缺席或 IR 不相容不影響編輯器分析。以 `pluginId:language` 選取編譯期內建 worker factory 與 browser companion；每工作區保留獨立的分析／Quick Fix 和補全 worker。所有訊息及已接受結果都帶宿主發放的 binding epoch；提供者 generation、路由設定或任一 worker 重啟都讓兩條通道失效並要求完整同步，一般輸入只改文件 revision。

worker 保留原生語意狀態，只發布通用符號、緊湊 tokens／occurrences、補全可見性群組與編輯結果；診斷來源由宿主加註。Basic Plus 的即時補全過濾、結構性編輯偵測與格式化留在 browser companion，通用 renderer／shared 不匯入 Basic Plus。缺少服務顯示語言狀態列，設定衝突顯示列出插件的工作區橫幅，兩者皆可前往插件設定。內建插件仍不可停用；靜態語言貢獻留待 2C，沒有第三方語言服務 RPC。

宿主負責加註 `Diagnostic.source`，診斷說明只在同一來源內查詢。`devices` API 仍規劃於第三階段。詳見[插件設計](../superpowers/specs/2026-10-14-plugin-system-design.md)。

### 語言服務驗收

從儲存庫根目錄執行 `pnpm test:desktop:smoke`。runner 會呼叫 `checkCompletionPerformance`，並涵蓋 language-features、indentation、highlighting；單獨載入效能模組不算執行測試。門檻維持 **熱補全 p95 ≤100 ms、新變數 ≤200 ms、30,000 行 ≤300 ms**。本機無法啟動 Electron 時，記錄實際錯誤，效能及 UI 驗收保留為未完成，待可執行的機器驗證。

中英文各執行一次人工驗收：

- [ ] missing 與 conflict 顯示不同說明；衝突列出插件，兩者的動作皆可開啟插件設定；available 且診斷為空時不顯示不可用列。
- [ ] 狀態切換保留文件內容、JSON 格式化與 Basic Plus 詞法高亮；恢復後不必輸入就重新分析。
- [ ] **分析尚在進行時**，確認補全候選及函式內外的區域作用域可見性，並確認此時 API 呼叫仍有簽名提示。
- [ ] 逐項驗證 Basic Plus 補全（含收尾關鍵字縮排）、Quick Fix、semantic tokens、hover、簽名提示、定義、引用、重新命名、大綱／breadcrumbs、文件與範圍格式化。
- [ ] 執行完整 Electron smoke，確認上述三個補全延遲門檻；單元／整合測試通過不代表效能驗收完成。

## 專案 manifest

專案可使用 `kobrixa.json`；沒有 manifest 的專案預設為 `bp`／`ev3-native`。為了向前相容，允許未知欄位；已知欄位無效時則回報錯誤。

```json
{
  "schemaVersion": 1,
  "name": "line-follower",
  "language": "bp",
  "entry": "src/main.bp",
  "target": "ev3-native",
  "assets": ["assets/**/*"],
  "outputDir": "build"
}
```

契約：

- `schemaVersion`：正整數；v1 只接受 `1`。
- `name`：非空的專案名稱與預設 EV3 程式名稱。
- `language`：經驗證的 ID，由已啟用的前端提供者解析。
- `entry`：專案相對來源路徑，解析後必須位於專案根目錄內。
- `target`：經驗證的 ID，由已啟用的後端提供者解析。
- `assets`：專案相對檔案或 glob；解析後路徑必須位於專案根目錄內。每個模式最多 4,096 個字元，左大括號或左括號合計最多 64 個，右側括號亦最多 64 個（包括已跳脫或引號內的字元）。所有資產模式合計最多可展開成 256 個模式；此限制不影響萬用字元可比對的檔案數量。超出限制時會在檔案探索前回報 manifest 診斷，不會只選取部分資產；一般選項與數字範圍仍受支援。
- `outputDir`：依字面解讀的專案相對目錄，並非 glob 模式；不得等於或包含來源根目錄。

## 編譯器契約

前端契約定義於 [`packages/compiler/src/contracts.ts`](https://github.com/Kingsley1116/Kobrixa/blob/main/packages/compiler/src/contracts.ts)，目前只有 `bp` 已有實作：

```ts
interface LanguageFrontend {
  id: string;
  compile(input: SourceProject, signal: AbortSignal): Promise<FrontendResult>;
}

interface FrontendResult {
  ir?: KobrixaIR;
  diagnostics: Diagnostic[];
}
```

`KobrixaIR` 具版本與型別，包含宣告、基本與聚合型別、函式、控制流程區塊、EV3 API 呼叫、素材引用和來源範圍。前端不得注入原始後端 bytecode。後端 lowering 前必須執行 IR 驗證，拒絕無效控制流程、未解析符號、不支援型別和無效 EV3 操作。

EV3 後端預設優化原生輸出：省略跳到下一個區塊的跳躍、簡化布林常值分支、採用最短的有效相對跳躍編碼，並在 IR 指令之間重用暫存記憶體。此外，會在遞迴展開前移除從程式入口或可達執行緒啟動點無法到達的函式，將相鄰的純量暫存運算直接寫入相同型別的區域目標，並讓型別相同、生命週期不重疊的 IR 暫存變數共用空間。重用前必須證明唯一的純運算定義在所有路徑上都先於讀取；陣列、具名區域變數、參數、函式／API 輸出及作為輸出引數的值仍保有獨立空間。同一 IR 指令的輸入與輸出不會共用可重用的槽位。

裁剪前會對所有來源函式執行 lowering 診斷，因此未使用函式中的錯誤仍會回報。全域宣告與執行期支援儲存空間的配置及初始化規則維持不變。陣列清理需要的值會保留到函式結束，背景執行緒迴圈讓出 CPU 的指令也會保留。可使用 `new EV3Backend({ optimize: false })` 關閉全部優化，以便診斷與比較。直接呼叫子函式的工具可使用 `retainFunctions: ["helper"]` 保留額外函式及其呼叫／執行緒相依關係，同時維持優化啟用；名稱不分大小寫，兩種模式都會對未知名稱回報錯誤。兩種模式皆不修改輸入 IR；`.ir.json` 成品描述前端輸出，`.lst` 則只記錄實際產生的函式與支援物件、目前的物件 ID 及區域記憶體大小。函式裁剪後的物件 ID 可能改變。

公共建置結果為：

```ts
interface CompileResult {
  buildId: string;
  target: string;
  deploy?: "ev3";
  runtimeDirectory?: string;
  success: boolean;
  diagnostics: Diagnostic[];
  artifacts: BuildArtifact[];
}

interface Diagnostic {
  code: string;
  helpKey?: string;
  severity: "error" | "warning" | "info";
  file: string;
  range: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  message: string;
}

interface BuildArtifact {
  slot: string;
  kind: string;
  role: "deploy-main" | "deploy-asset" | "aux";
  mediaType: string;
  path: string;
  sha256: string;
  byteLength: number;
  remotePath?: string;
}
```

公共結果的行、列從 1 起算。成功建置必須沒有 error 診斷、包含全部 required 成品；若可部署，還須有唯一且非空的主檔。成功但不可部署仍是建置成功，執行／上傳按鈕會說明原因。失敗或取消的成品清單一律為空。未宣告、重複、缺少必要成品、路徑不安全、名稱碰撞或超過上限，皆回 `BUILD1003`。

BuildSession 與模擬共用 `compileToMemory`：執行前端、檢查實際 IR 版本與 IR 有效性、執行後端、驗證成品，過程不寫輸出。模擬仍要求後端成功，保留最多 4 個入口、64 個資源／1 MiB 的限制，使用來源及資源快照；是否能模擬依實際 IR 與模擬器支援判斷，不增加後端模擬能力宣告。

建置上限為後端成品 64 個、含資源成品 1024 個、單一成品 64 MiB、總量 256 MiB、檔名 128 UTF-8 bytes、相對路徑 512 UTF-8 bytes。名稱先做 Unicode NFC 正規化再轉小寫檢查碰撞，`.kobrixa*` 為保留名稱；資源不得越界或經過符號連結。讀寫時累計大小，hash 取自 staging 的實際內容。

輸出仍位於 `outputDir/<名稱>.<extension>` 與 `outputDir/assets/<相對路徑>`，既有 `<名稱>.rbf`、`<名稱>.ir.json`、`<名稱>.lst` 位置不變。宿主在 `.kobrixa-<buildId>.tmp` 完成全部 staging 驗證後，才依 aux → deploy-asset → deploy-main 替換最終檔案。第一次 rename 前取消回 `BUILD0001`；開始 rename 後完成整段提交。I/O 失敗回 `BUILD9000`、成品清單為空，磁碟可能留下新舊混合的檔案；這不是多檔案原子交易。

同一程序依 `realpath(outputDir)` FIFO 排隊。提交期間以 `wx` 建立 `.kobrixa-build.lock`，內容為 `{ pid, startedAt }`。pid 不存在，或內容無法解析且檔案超過 60 秒，才回收殘留鎖；活鎖每 100 ms 輪詢，最多 5 秒後回 `BUILD1004`。釋放時比對所有權，只刪自己的鎖。不同電腦共用網路磁碟時，pid 判斷不保證正確。殘留鎖回收採「比對內容後 unlink」，並非原子操作：兩個程序同時回收同一殘留鎖時，極端排程下可能刪到另一程序剛建立的新鎖；2A 接受此限制。

部署要求設備支援的 `deploy`（目前為 `ev3`），否則回 `BUILD1005`。先把全部待部署檔案讀進記憶體並驗 SHA-256，再開始任何上傳；檔案遺失或變更回 `BUILD1006`。資源依 remotePath 排序、主檔最後，傳送的就是驗過的同一批 bytes。Folder／runtimeDirectory、設備鎖與略過未變資源的行為保留；設備傳輸本身仍非原子操作。

可在瀏覽器使用的 `@kobrixa/compiler/diagnostic-help` 子路徑提供繁體中文及英文共用診斷目錄，原有 compiler 入口保持不變。同一代碼有不同原因時，由產生處設定可選的 `helpKey`；缺少或未知的分類使用該代碼的通用解說，未知代碼保留原始訊息。測試會核對 production 代碼與目錄，並驗證範例及文件連結。

Quick Fix 請求包含工作區、已接受的分析 session／revision／version、檔案、診斷及取消識別碼。語言 worker 依 parser token 與區塊資訊產生插入候選，在記憶體副本重新解析後，按分析版本快取通過驗證的候選。查詢上限為 1,000,000 個 UTF-16 code unit，每次最多解析該檔兩次，不在 renderer 執行完整專案分析。取消會設定共享旗標，不影響其他查詢或已接受的分析。套用前會重新檢查目標 model 版本、來源快照與磁碟衝突，再以單一復原步驟沿用文件、草稿與儲存流程；rename 仍檢查全專案來源檔。文件開啟 IPC 只接受目錄選項，由 main process 組合官方網址。

`runtimeDirectory` 記錄入口來源的 `Folder` 目的地。素材成品的 `remotePath` 為專案相對路徑，部署時保留程式預期的素材位置。

## 設備契約

以下核心生命週期方法節錄自 [`packages/device/src/contracts.ts`](https://github.com/Kingsley1116/Kobrixa/blob/main/packages/device/src/contracts.ts)：

```ts
interface DeviceTransport {
  discover(signal: AbortSignal): Promise<DeviceDescriptor[]>;
  connect(target: DeviceDescriptor, signal: AbortSignal): Promise<DeviceSession>;
}

interface DeviceSession {
  readonly descriptor: DeviceDescriptor;
  readonly connected: boolean;
  disconnect(): Promise<void>;
  upload(remotePath: string, data: Uint8Array, signal: AbortSignal): Promise<void>;
  run(remotePath: string, signal: AbortSignal): Promise<void>;
  stop(programName?: string, signal?: AbortSignal): Promise<void>;
  delete(remotePath: string, signal: AbortSignal): Promise<void>;
}
```

同一 session 同時只能有一個變更狀態的操作。Disconnect 必須具冪等性。每個操作都有有限逾時，並回傳結構化分類：`permission`、`not-found`、`connection`、`timeout`、`protocol`、`transfer`、`device`、`cancelled` 或 `internal`。UI 文字在設備層之外本地化。

同一 session 另提供 `list`、`download`、`uploadStream`、`createDirectory` 與 `rename`，用於遠端檔案管理。串流傳輸回報進度；桌面 main process 協調批次操作預覽、覆寫確認與 session 獨占存取。

## 桌面封裝與發布

Electron Forge 將 renderer、main 與 preload 入口封裝至 `app.asar`，原生 `.node` 檔保留於解包目錄。封裝 hook 加入目標平台的 `node-hid` 預編譯檔、專案 `LICENSE` 與含版本資訊的 `THIRD-PARTY-NOTICES.txt`。聲明涵蓋打包 source map 引用的所有套件及複製的執行期相依套件；任一套件缺少授權檔時封裝失敗。Electron 的 `LICENSE.electron.txt` 與 `LICENSES.chromium.html` 位於執行檔旁（macOS 為 `Kobrixa.app/Contents/Resources`），HIDAPI 授權檔保留在 `node-hid` 內。

一般 CI 與本機封裝不需要憑證。Tag 發布先驗證 commit 與套件版本，將 macOS／Windows 簽章開關快照記錄於草稿，通過共通檢查與桌面測試後才執行簽章。macOS 對 `com.kobrixa.ide` 使用 Developer ID、Hardened Runtime 與公證；Windows 將保留一天的暫存產物送往 SignPath，只接受 `kobrixa.exe` 的變更。

啟用簽章後，失敗會中止該平台。壓縮前與解壓後都驗證應用程式，包括簽章、檔案內容、執行權限、符號連結與原生模組，再產生 SHA-256。最終草稿包含 Windows NSIS／ZIP、Linux AppImage／tar.gz、macOS DMG、更新資訊與單一 SHA256SUMS.txt（已簽章 macOS 另有更新 ZIP），等待維護者手動公開。憑證管理、核准與重跑規則見[程式碼簽章政策](../zh-TW/code-signing.md)。

## 狀態與安全規則

- 每次建置建立新的 session；編譯器狀態不得為全域狀態。
- 路徑正規化後必須限制在專案根目錄，使用者核准的匯入／匯出位置除外。
- 只有通過驗證並以原子 rename 完成後，才可取代既有成功成品。
- 設備寫入需要有效 session 與明確使用者操作。
- Log 預設不記錄原始碼內容與個人路徑。
- 正式環境的視窗只載入封裝在應用程式內的本地內容。Renderer sandbox 與 `contextIsolation` 必須保持啟用，`nodeIntegration` 必須保持停用。
- Preload bridge 只能透過 `contextBridge` 暴露文件化、用途單一的方法，不得暴露原始 `ipcRenderer` 或 Node.js primitive。
- Main process 在每個具特權的檔案系統、編譯器或設備操作前，必須驗證 IPC sender 與 payload。

這些邊界遵循 Electron 的[安全建議](https://www.electronjs.org/docs/latest/tutorial/security)。
