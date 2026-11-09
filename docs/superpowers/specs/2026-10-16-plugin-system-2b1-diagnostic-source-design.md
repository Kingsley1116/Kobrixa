# 診斷來源契約與插件診斷說明設計（第二階段 2B-1）

日期：2026-10-16  
狀態：Claude 與 Codex 討論後提出，使用者已逐段核准設計方向。主要實作已交付，第二階段驗收尚未全部完成；詳見下方實作狀態。

- 上層設計：[插件系統設計](2026-10-14-plugin-system-design.md)（§5.1.1、§5.1.2、§11 第二階段）
- 前一子專案：[2A 插件化編譯鏈](2026-10-16-plugin-system-2a-build-chain-design.md)

## 實作狀態（2026-10-17）

第二階段已合併至 `0ba37ba`。已交付子專案：[2A](2026-10-16-plugin-system-2a-build-chain-design.md)、[2B-1](2026-10-16-plugin-system-2b1-diagnostic-source-design.md)、[2B-2](2026-10-16-plugin-system-2b2-language-services-design.md)、[2C](2026-10-17-plugin-system-2c-static-languages-design.md)。整體狀態與必要驗收見[主規格的待驗收清單](2026-10-14-plugin-system-design.md#第二階段待驗收項目)及[收尾稽核](../../../.superpowers/sdd/stage-2-closeout/audit-report.md)。

已交付宿主加註的診斷來源、發布型別與驗證、來源隔離的說明目錄／UI／Quick Fix 身分比對，以及受限的雙語純文字說明、範例與 HTTPS 連結；內建代碼、helpKey 與官方網址保留。函式庫 `Diagnostic.source` 可省略，`PublishedDiagnostic.source` 必填，桌面建置結果使用 `PublishedCompileResult`。現行 API 為 1.4.0；下文 1.2.0 是本能力加入時的版本。

保留的排除範圍與待辦：

- 外部診斷產生者、HTML／圖片等說明資源、第三方說明發布到官網仍排除。無 entrypoint 的純靜態說明插件已由 2C 完成；語言 worker 的暫時 Basic Plus adapter 已由 2B-2 的提供者路由取代。
- 發布檢查重複及雙重檢查說明、真實建置／混合來源測試的斷言強度、命令 ownership 順序與重複／無效 builtin 的 registry 邊界測試，保留為有限的清理與覆蓋率待辦，不代表目前來源隔離失效。
- 說明 URL／控制字元、邊界測試、revision／讀取效率、Reload 的連結索引、analyzer-error 測試結構與原規格的「世代號」用語仍待整理；samples README 已補明超出說明資源上限同樣回報 `PLUGIN_E_DIAGNOSTIC_HELP`。

驗證依稽核與 [2B-1 進度紀錄](../../../.superpowers/sdd/2026-10-16-plugin-system-2b1-diagnostic-source/progress.md)，不將後續已修正的發布型別、偽造來源與目錄失效問題重新列為阻擋項目。

下文保留本子專案核准時的設計基線；「實作前背景」與歷史版本範例用於解釋遷移原因，不代表目前仍未實作。原先交給後續子專案的工作，以上方交付狀態為準。

## 1. 背景、範圍與目標

第二階段的 2B 再拆成兩個子專案，各自走 spec → plan → 實作，分支從 `feat/plugin-system-stage-2` 分出、完成後以 `--no-ff` 合回：

| 子專案   | 內容                                                                                          |
| -------- | --------------------------------------------------------------------------------------------- |
| **2B-1** | **本文件：診斷 `source` 契約、`contributes.diagnosticHelp`、說明查詢與 Quick Fix 的來源比對** |
| 2B-2     | 語言分析／補全／Quick Fix 提供者（只限內建的 `contributes.languageServices`）                 |

2B-2 依賴本文件建立的診斷身分做路由與快取失效，因此 2B-1 先做。

**實作前背景（2026-10-16）：** 當時需要解決的問題如下：

- 共享 [`Diagnostic`](../../../packages/compiler/src/contracts.ts) 沒有 `source`；建置、模擬、語言分析發布的診斷都無法分辨提供者。
- 說明查詢 [`getDiagnosticHelp(code, helpKey)`](../../../packages/compiler/src/diagnostic-help.ts) 只以代碼為鍵；renderer 的 `diagnostic-details.tsx`、`diagnostic-presentation.ts` 直接查內建目錄。
- [`quickFixRequestSchema`](../../../apps/desktop/src/main/language/quick-fix-request.ts) 寫死 `BP|MAN|IR|EV3|BUILD` 代碼格式；[`sameDiagnostic`](../../../apps/desktop/src/shared/quick-fixes.ts) 不比較來源；`QUICK_FIX_CODES` 是 Basic Plus 專屬清單卻放在共用模組。
- 插件無法註冊自己的診斷說明。

**目標：** 所有經宿主發布的診斷都帶有宿主加註、不可偽造的 `source`；說明以 `(source, code, helpKey)` 查詢且不跨來源退回；任何合法插件可用封裝 JSON 資源註冊純文字說明與 HTTPS 連結。既有代碼、helpKey、官方說明網址、bytecode 與網站路由保持不變。

**不在範圍內：**

- 語言分析／補全／Quick Fix 的提供者插件化（2B-2）；2B-1 的語言 worker 仍直接使用 Basic Plus，只由明確的相容 adapter 加註來源。
- 外部插件產生診斷（第二階段的前後端仍只限內建）；因此第三方說明在本階段只能由測試注入的診斷觸發。
- 說明中的圖片、HTML 或其他封裝資源；只有靜態貢獻、沒有 entrypoint 的插件（2C）。
- 第三方說明上傳或發布到官網。

## 2. `source` 型別

```ts
// packages/compiler/src/contracts.ts
interface Diagnostic {
  /* 既有欄位不變 */
  source?: string; // 獨立使用的編譯函式庫可不帶
}
type PublishedDiagnostic = Omit<Diagnostic, "source"> & { source: string };
const CORE_DIAGNOSTIC_SOURCE = "kobrixa.core";
```

- 經宿主發布的路徑一律使用 `PublishedDiagnostic`：`PublishedCompileResult`（桌面 API 中的 `CompileResult` 別名）、模擬準備結果、語言分析 patch（`language-sync.ts`）、建置與語言的 IPC wire schema。zod schema 要求 `source` 為合法插件 ID 或 `kobrixa.core`。
- producer（前端／後端 adapter、語言分析器）回傳的診斷若自帶 `source`，視為契約違反：宿主丟棄該批結果，改發布一筆 `kobrixa.core` 的 **BUILD1007**（說明見 §8）。不默默移除欄位。
- 型別驗證不等於身分驗證；身分只來自宿主持有的可信上下文（§3）。

## 3. 加註點

來源一律取自 2A 的 `CompilerSnapshot` 中由 registry 決定的 `pluginId`，或宿主自己的保留身分；絕不依診斷碼推測。

| 階段                                                               | source                                       |
| ------------------------------------------------------------------ | -------------------------------------------- |
| 前端編譯結果                                                       | `snapshot.frontend.pluginId`                 |
| IR 版本檢查、`validateIR`                                          | `kobrixa.core`                               |
| 後端結果                                                           | `snapshot.backend.pluginId`                  |
| 專案載入（MAN）、提供者解析、取消、成品提交（BUILD）、模擬 SIM1001 | `kobrixa.core`                               |
| 語言 worker 的分析診斷                                             | 相容 adapter 標 `kobrixa.basic-plus`（見下） |
| 語言 worker 的專案載入診斷                                         | `kobrixa.core`                               |

- [`compile-memory.ts`](../../../packages/compiler/src/compile-memory.ts) 是前端 → IR → 後端的唯一彙整點：新增參數 `sources: { frontend: string; backend: string }`，每次 `push` 前加註。`build-session.ts`、`prepare-simulation.ts` 及 desktop 的 build worker 只保留來源，不整批覆寫。
- 語言 worker 的相容 adapter 是一個具名函式（例如 `stampBuiltinBasicPlusAnalysis`），只用於 2B-1 期間，2B-2 改為依提供者加註；它是唯一允許把無來源的舊資料補成內建來源的地方。

**保留身分：**

- registry 無條件拒絕 manifest `id` 為 `kobrixa.core` 的插件（`PLUGIN_E_RESERVED_ID`）。
- 開發插件與內建插件同 ID 時，內建插件必須勝出、開發插件標為 `PLUGIN_E_DUPLICATE_ID`；以測試固定這個順序。

## 4. `contributes.diagnosticHelp`

```ts
// packages/plugin-protocol/src/manifest.ts
contributes.diagnosticHelp?: { version: 1; path: string }; // 插件根目錄下的相對路徑，以 .json 結尾
```

- 任何合法插件都可宣告；不改變「非內建插件必須有 entry」的既有規則。
- 內建插件的 manifest 不宣告此欄位，內建說明走 §6 的擁有者對照。
- 插件 API 升到 **1.2.0**（新增欄位，向下相容）；JSON Schema、JS 與 Python SDK、conformance 案例同步。

**資源格式**（新 schema `packages/plugin-protocol/src/diagnostic-help.ts`）：

```ts
type HelpText = { en: string; "zh-TW"?: string };
interface PluginDiagnosticHelpFile {
  entries: Array<{
    code: string; // /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/
    helpKey?: string; // /^[a-z0-9-]{1,100}$/
    title: HelpText;
    cause: HelpText;
    steps: { en: string[]; "zh-TW"?: string[] };
    example?: { before: string; after: string }; // 純文字，等寬顯示
    links?: Array<{ url: string; label: HelpText }>; // 只接受 https:
  }>;
}
```

- 嚴格 schema：未知欄位、`source`、HTML 欄位一律拒絕。字串以純文字呈現，不解析 Markdown 或 HTML。
- 繁體中文缺漏時退回英文。
- 同一插件內 `(code, helpKey)` 不得重複（無 helpKey 視為一個值）。

**上限**（`DIAGNOSTIC_HELP_LIMITS`，v1，常數有版本）：

| 項目                       | 上限      |
| -------------------------- | --------- |
| 單一資源檔大小             | 1 MiB     |
| 每插件條目數               | 512       |
| 單筆條目 JSON 序列化大小   | 16 KiB    |
| 每語系步驟數               | 16        |
| 每筆連結數                 | 4         |
| URL 長度                   | 2048 字元 |
| title／單一步驟字串長度    | 500 字元  |
| cause／example 單欄長度    | 4000 字元 |
| 全部插件說明合計（記憶體） | 8 MiB     |

## 5. 資源載入與生命週期

新增 `packages/plugin-runtime/src/diagnostic-help.ts`：

- 開發插件的說明檔在 `readSource` 讀取來源時，以有大小上限的方式讀取，並納入同一次 `readSource` 的逾時範圍；只有插件解析為 `enabled` 時才發布到說明目錄。不需要也不會啟動插件程序。安全模式或未讀取的插件不載入。
- 載入步驟：`realpath` 解析路徑 → 確認位於插件根目錄內（同 entry 的越界判斷）→ `stat` 確認為一般檔案 → 最多讀取大小上限加 1 byte，拒絕超量資料並去除 BOM → JSON 解析 → schema 與上限驗證。符號連結逃逸、目錄、超量、格式錯誤都拒絕。
- 失敗時插件**仍為啟用**，只是不註冊說明，並在插件問題清單加上 `PLUGIN_E_DIAGNOSTIC_HELP`，訊息指出哪個檔案與哪項限制失敗。合計上限超出時，依 `sourceKey` 字典序載入，第一個使合計超限的插件失敗，之後的插件照常檢查。
- 註冊表以 source（插件 ID）分組。停用、重新載入、移除或安全模式切換時，原子地移除或替換該插件的目錄，並在已啟用插件的相關資料變更時遞增 `diagnosticHelpRevision`。

**傳遞到 renderer：** main 透過 preload 的 `plugins.diagnosticHelp()` IPC 提供已驗證的條目（依 source 分組），並在插件 state 事件附上 `diagnosticHelpRevision`。此 revision 涵蓋每個已啟用插件的 `sourceKey`、`id`、`generation`、`displayName` 與是否有已載入的說明，包含沒有說明條目的插件，讓名稱變更也能使快取失效。renderer 收到新 revision 時重新查詢並整份替換，忽略較舊的回覆。

## 6. 說明查詢與內建擁有者

**內建擁有者對照**（`packages/compiler/src/diagnostic-help.ts`，維持 browser-safe）：

- `CATALOG_OWNERS` 以代碼前綴規則宣告目錄所有權：`kobrixa.basic-plus` 擁有 BP 條目、`kobrixa.ev3` 擁有 EV3 條目、`kobrixa.core` 擁有 MAN、IR、BUILD 條目，透過 `builtinHelpOwners(code)` 對外提供查詢。以測試保證每筆條目（含 variants）至少屬於一個 owner；這些規則只決定說明目錄的所有權，不在 runtime 依代碼推測診斷的 `source`。
- 明確的 `SHARED_BUILTIN_HELP` 例外表優先於前綴規則：`EV32031` 同時由 Basic Plus 前端（`frontends/basic-plus/src/lower.ts`）與 EV3 後端發出，歸屬 `kobrixa.basic-plus` 與 `kobrixa.ev3`。`builtinHelpOwners()` 會回傳兩個 owner；共有清單不以前綴推導。
- 新增 `getBuiltinDiagnosticHelp(source, code, helpKey?)`：只在條目屬於該 source 時回傳。
- 既有的 `getDiagnosticHelp(code, helpKey)`、`diagnosticDocumentationUrl`、`DIAGNOSTIC_HELP` 等匯出不變，網站照舊使用；網站路由與網址都不改。

**統一查詢**（新增 `apps/desktop/src/shared/diagnostic-help.ts`）：

```ts
resolveDiagnosticHelp(source, code, helpKey?, pluginCatalog) =
  isBuiltinSource(source)
    ? getBuiltinDiagnosticHelp(source, code, helpKey)
    : pluginCatalog[source]?.get(code, helpKey) ?? pluginCatalog[source]?.get(code);
```

- 內建來源只有 `kobrixa.core`、`kobrixa.basic-plus`、`kobrixa.ev3`，且必須是 registry 中 `source: "builtin"` 的插件。
- 不跨來源退回：第三方回報 `BP1015` 查不到 Basic Plus 的說明。查不到說明時保留原始診斷訊息。

## 7. 消費端

**桌面 UI：**

- `diagnostic-details.tsx`、`diagnostic-presentation.ts` 改用 `resolveDiagnosticHelp`。
- Monaco marker 的 `source` 填入提供插件的顯示名稱（`kobrixa.core` 顯示為「Kobrixa」）；診斷去重與相等比較的鍵加入 `source`。
- 第三方條目在說明面板標示提供插件；「開啟文件」只出現在內建條目，第三方條目改列出自己的 HTTPS 連結。

**文件與連結開啟：**

- `DocumentationRequest` 加上 `source`；[`documentation.ts`](../../../apps/desktop/src/main/window/documentation.ts) 只對內建 source 產生官方網址與 `related` 連結，沿用既有網址格式。
- 第三方連結：renderer 只送 `(source, code, helpKey?, linkIndex)`；main 從已註冊條目取 URL，以 `new URL()` 解析並確認 `protocol === "https:"` 後交給 `shell.openExternal`。renderer 永遠不提供 URL。

**Quick Fix（最小調整，提供者路由在 2B-2）：**

- `QuickFixRequest.diagnostic` 加入 `source`；`quickFixRequestSchema` 改用通用的 code（同 §4 格式）與 source 格式，不再寫死前綴。
- `sameDiagnostic` 加入 `source` 比較；worker 先找到相等的已發布診斷，只有其 `source === "kobrixa.basic-plus"` 時才呼叫 `getBasicPlusQuickFixes`。
- `QUICK_FIX_CODES` 移入 Basic Plus 專屬模組（例如 `frontends/basic-plus` 或桌面端的 Basic Plus adapter），共用模組不再列出特定語言代碼。
- 偽造 `source` 的請求比對不到已發布診斷，回傳 `stale`。

**網站：** `apps/web` 不改程式；新增測試鎖定所有內建條目的官方網址與目前相同。

**協作：** 現有協作 wire 不傳診斷，不需要變更。

## 8. 錯誤碼

| 代碼                       | 意義                                          | source         |
| -------------------------- | --------------------------------------------- | -------------- |
| BUILD1007                  | 提供者回傳的診斷自帶 `source`，違反契約       | `kobrixa.core` |
| `PLUGIN_E_RESERVED_ID`     | 插件 ID 使用保留身分（`kobrixa.core`）        | 插件問題       |
| `PLUGIN_E_DIAGNOSTIC_HELP` | 診斷說明資源無法讀取、越界或不符 schema／上限 | 插件問題       |

BUILD1007 在 [`diagnostic-help.ts`](../../../packages/compiler/src/diagnostic-help.ts) 補上英文與繁體中文說明，歸屬 `kobrixa.core`，沿用既有官方網址格式。

## 9. 測試與驗收

- **來源加註：** 混合來源建置（MAN、BP、IR、EV3、BUILD）每筆診斷的 `source` 正確；模擬的 SIM1001 為 core；語言分析診斷為 `kobrixa.basic-plus`、載入診斷為 core；彙整後不被覆寫。
- **偽造與保留：** 前端、後端或分析器自帶 `source` 時回 BUILD1007；`kobrixa.core` 插件被拒；開發插件冒用內建 ID 時內建勝出；缺少 `source` 的發布資料被 wire schema 拒絕。
- **隔離：** 用測試註冊的假來源與 Basic Plus 使用相同 `code`／`helpKey`，說明、去重、marker 與 Quick Fix 都不串用；第三方 `BP1015` 不顯示 Basic Plus 說明，也不觸發 Quick Fix。
- **查詢：** 精確 helpKey 命中、同 source 退回無 helpKey 條目、查不到時保留原始訊息；`builtinHelpOwners()` 涵蓋所有內建條目；只有共有例外表中的條目有多個 owner；Basic Plus 前端發出的 `EV32031` 仍顯示說明。
- **資源載入：** 越界路徑、符號連結逃逸、目錄、超過每項上限（含剛好到上限的正例）、重複鍵、未知欄位、`http:` 與 `javascript:` 連結都被拒並回 `PLUGIN_E_DIAGNOSTIC_HELP`，插件仍啟用；停用、重新載入與安全模式會移除或替換目錄並遞增世代號。
- **連結開啟：** renderer 送出越界 `linkIndex` 或不存在的 source 時拒絕；只對 https 呼叫 `openExternal`。
- **相容：** 既有代碼、helpKey、官方網址（含網站測試）、bytecode、`pnpm test:bytecode`、schema drift、JSON Schema 與兩個 SDK 的 conformance、打包後 worker 測試全部通過。

## 10. 實作切分

依序分成可獨立審查的 task，每個都附測試：

1. `Diagnostic.source`、`PublishedDiagnostic`、`kobrixa.core`、BUILD1007 與 `compile-memory` 加註；build session、build worker、模擬保留來源，wire schema 要求 `source`。
2. registry 保留 ID、內建優先的重複 ID 測試。
3. `diagnosticHelp` manifest 欄位、資源 schema 與 `DIAGNOSTIC_HELP_LIMITS`、API 1.2.0、JSON Schema 與兩個 SDK 同步。
4. 資源載入器、以 source 分組的說明註冊表、世代號與生命週期。
5. `CATALOG_OWNERS`、`SHARED_BUILTIN_HELP`、`builtinHelpOwners`、`getBuiltinDiagnosticHelp`、`resolveDiagnosticHelp` 與網站網址鎖定測試。
6. 語言 worker 相容 adapter 加註、`language-sync` 與 analysis transport 帶 `source`、Quick Fix 請求與 `sameDiagnostic` 納入來源、`QUICK_FIX_CODES` 移入 Basic Plus。
7. preload 說明快照與事件、說明面板與 marker、文件與第三方連結開啟。
