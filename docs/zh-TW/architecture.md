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
          ├─ 工作區服務 → 語言前端（v1 為 .bp）
          │              → 具型別 KobrixaIR + 驗證
          │              → EV3 後端 → .rbf 成品
          └─ 設備服務 ───────────────────→ USB HID / Wi-Fi
```

React renderer 只管理呈現狀態，不能直接存取 Node.js 或 Electron API。範圍精簡的 preload API 透過 `contextBridge` 呼叫 Electron main process 中已驗證的 IPC handler。Node.js 服務負責檔案系統存取、編譯執行、取消、設備 session 與結構化錯誤。任何編譯階段都不得依賴 UI。

## 倉庫邊界

- `apps/desktop`：Electron main 與 preload process、React renderer、Monaco 整合、本地化與使用流程。
- `apps/web`：產品頁、雙語文件、素材庫介面及其 Cloudflare Worker。桌面編輯與編譯不依賴此服務。
- `packages/compiler`：建置 session 協調與診斷彙整。
- `packages/ir`：由語言前端和後端共用的版本化 IR 型別、驗證與序列化。
- `packages/backend-ev3`：確定性的 EV3 VM lowering 與 `.rbf` 封裝。
- `packages/device`：transport 中立的設備操作，以及 USB、Wi-Fi 實作。
- `frontends/basic-plus`：clean-room lexer、parser、語意分析與 IR lowering。
- `tools/release`：壓縮包檢查、簽章驗證與 GitHub Release 草稿管理。`.github/workflows/release.yml` 協調各平台原生建置。

相依方向朝向共享契約。編譯器和設備 package 必須能被未來 Node.js CLI 使用，而不必匯入 Electron 桌面程式碼。

## 專案 manifest

每個專案使用 `kobrixa.json`。為了向前相容，允許未知欄位；已知欄位無效時則回報錯誤。

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
- `language`：v1 接受 `bp`；規劃值為 `python`、`typescript`、`cpp`。
- `entry`：專案相對來源路徑，解析後必須位於專案根目錄內。
- `target`：v1 只接受 `ev3-native`。
- `assets`：專案相對檔案或 glob；解析後路徑必須位於專案根目錄內。
- `outputDir`：專案相對目錄；不得等於或包含來源根目錄。

## 編譯器契約

前端契約定義於 [`packages/compiler/src/contracts.ts`](https://github.com/Kingsley1116/Kobrixa/blob/main/packages/compiler/src/contracts.ts)，目前只有 `bp` 已有實作：

```ts
interface LanguageFrontend {
  id: "bp" | "python" | "typescript" | "cpp";
  compile(input: SourceProject, signal: AbortSignal): Promise<FrontendResult>;
}

interface FrontendResult {
  ir?: KobrixaIR;
  diagnostics: Diagnostic[];
}
```

`KobrixaIR` 具版本與型別，包含宣告、基本與聚合型別、函式、控制流程區塊、EV3 API 呼叫、素材引用和來源範圍。前端不得注入原始後端 bytecode。後端 lowering 前必須執行 IR 驗證，拒絕無效控制流程、未解析符號、不支援型別和無效 EV3 操作。

公共建置結果為：

```ts
interface CompileResult {
  runtimeDirectory?: string;
  success: boolean;
  diagnostics: Diagnostic[];
  artifacts: BuildArtifact[];
}

interface Diagnostic {
  code: string;
  severity: "error" | "warning" | "info";
  file: string;
  range: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  message: string;
}

interface BuildArtifact {
  kind: "rbf" | "ir" | "listing" | "asset";
  path: string;
  sha256: string;
  remotePath?: string;
}
```

公共結果的行、列從 1 起算。只有在沒有 error 診斷，且有效 `rbf` 已原子提交時，`success` 才為 true。失敗或取消後必須移除暫存輸出。

`runtimeDirectory` 記錄入口來源的 `Folder` 目的地。素材成品的 `remotePath` 為專案相對路徑，部署時保留程式預期的素材位置。每個輸出檔透過同一檔案系統內的 rename 提交；整組輸出檔並非單一交易。

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

Electron Forge 將 renderer、main 與 preload 入口封裝至 `app.asar`，原生 `.node` 檔保留於解包目錄。封裝 hook 加入目標平台的 `node-hid` 預編譯檔、專案 `LICENSE` 與含版本資訊的 `THIRD-PARTY-NOTICES.txt`，並保留 Electron／Chromium 與 HIDAPI 授權檔。

一般 CI 與本機封裝不需要憑證。Tag 發布先驗證 commit 與套件版本，將 macOS／Windows 簽章開關快照記錄於草稿，通過共通檢查與桌面測試後才執行簽章。macOS 對 `com.kobrixa.ide` 使用 Developer ID、Hardened Runtime 與公證；Windows 將保留一天的暫存產物送往 SignPath，只接受 `kobrixa.exe` 的變更。

啟用簽章後，失敗會中止該平台。壓縮前與解壓後都驗證應用程式，包括簽章、檔案內容、執行權限、符號連結與原生模組，再產生 SHA-256。最終草稿包含三個壓縮包與三個校驗碼檔，等待維護者手動公開。憑證管理、核准與重跑規則見[程式碼簽章政策](../zh-TW/code-signing.md)。

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
