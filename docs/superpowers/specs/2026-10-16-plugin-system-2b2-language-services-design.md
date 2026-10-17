# 語言服務提供者設計（第二階段 2B-2）

日期：2026-10-16  
狀態：Claude 與 Codex 討論後提出，使用者已逐段核准設計方向。主要實作已交付，第二階段驗收尚未全部完成；詳見下方實作狀態。

- 上層設計：[插件系統設計](2026-10-14-plugin-system-design.md)（§11 第二階段）
- 前一子專案：[2A 插件化編譯鏈](2026-10-16-plugin-system-2a-build-chain-design.md)、[2B-1 診斷來源契約](2026-10-16-plugin-system-2b1-diagnostic-source-design.md)

## 實作狀態（2026-10-17）

第二階段已合併至 `0ba37ba`。已交付子專案：[2A](2026-10-16-plugin-system-2a-build-chain-design.md)、[2B-1](2026-10-16-plugin-system-2b1-diagnostic-source-design.md)、[2B-2](2026-10-16-plugin-system-2b2-language-services-design.md)、[2C](2026-10-17-plugin-system-2c-static-languages-design.md)。整體狀態與必要驗收見[主規格的待驗收清單](2026-10-14-plugin-system-design.md#第二階段待驗收項目)及[收尾稽核](../../../.superpowers/sdd/stage-2-closeout/audit-report.md)。

已交付全部十二項既有動態語言能力的內建提供者路由、可信語言綁定、worker／快取失效及服務不可用狀態。Basic Plus 保留 `bp`，`kobrixa.basic-plus` 同時擁有 frontend 與 service；2C 已接手靜態語言註冊與 renderer 詞法路由。現行 API 為 1.4.0；下文 1.3.0 是語言服務加入時的版本。

保留的排除範圍與待辦：

- 第三方語言服務／外部 RPC、僅停用語言服務的開關、新語言隱式推斷仍延後。簽名提示目前只顯示一個 signature；更完整的介面留待後續，修正標題仍要求英文、繁體中文可選。
- Registry 的語意唯一性檢查與 JSON Schema／Python 的結構驗證分開；通過結構驗證不代表通過宿主語意驗證。
- 未使用的 `analyze`／`diagnostics` 相容 API、N2 專案載入錯誤合併為單列且兩種語系均顯示英文、N3 重複建立補全提供者，以及分析待完成／不完整補全結果／額外刷新成本仍列待辦。2C 沒有處理 N2；原先交給 2C 的通用 renderer 詞法假設已完成遷移。

驗證依稽核與 [2B-2 進度紀錄](../../../.superpowers/sdd/2026-10-16-plugin-system-2b2-language-services/progress.md)。既有補全效能門檻不變；已記錄的自動化結果不取代 V01 人工驗收或 V04 完整 smoke 例外。

下文保留本子專案核准時的設計基線；「實作前背景」與歷史版本範例用於解釋遷移原因，不代表目前仍未實作。原先交給後續子專案的工作，以上方交付狀態為準。

## 1. 背景、範圍與目標

**實作前背景（2026-10-16）：** 2B-1 讓每個已發布診斷都帶有宿主加註的 `source`，但語言 worker、補全 worker 與 renderer 編輯器功能仍直接使用 `@kobrixa/basic-plus`：

- [`language-worker.ts`](../../../apps/desktop/src/main/language/language-worker.ts) 直接建立 `BasicPlusProjectAnalyzer`，並以 2B-1 的相容 adapter 把分析加註為 `kobrixa.basic-plus`。
- [`completion-worker.ts`](../../../apps/desktop/src/main/language/completion-worker.ts) 直接建立 `BasicPlusCompletionAnalyzer`。
- 兩個 worker 載入專案時沒有傳入 frontend 解析器，讓載入器退回 Basic Plus。
- `BasicPlusProjectAnalysis`、`BasicPlusSymbol`、`BasicPlusCompletionIndex`、`BasicPlusQuickFix`、`BasicPlusSemanticToken` 穿過 [`language-sync.ts`](../../../apps/desktop/src/shared/language-sync.ts)、[`completion-sync.ts`](../../../apps/desktop/src/shared/completion-sync.ts)、[`quick-fixes.ts`](../../../apps/desktop/src/shared/quick-fixes.ts) 進入 renderer。
- [`editor.tsx`](../../../apps/desktop/src/renderer/editor/editor.tsx) 把所有非 JSON 檔案都當成 Basic Plus。

**目標：** 編輯器的所有動態語言功能都經由「內建插件宣告、宿主選定」的語言服務提供者路由；分析診斷依選定提供者加註來源；換提供者時舊結果一律失效；提供者不可用時明確告知使用者。Basic Plus 的演算法、編輯體驗與效能不變。

**使用者決定（2026-10-16）：**

1. 範圍包含全部現有動態功能（分析、補全、Quick Fix、semantic tokens、hover、簽名提示、定義、引用、重新命名、文件大綱、文件與範圍格式化），演算法不變。
2. 內建語言服務在第二階段維持必要；不新增只停用語言服務的開關，內建插件仍受 `PLUGIN_E_BUILTIN_REQUIRED` 保護。
3. 分析不可用時顯示狀態指示與說明；設定衝突升級為工作區橫幅；「不可用」與「分析成功但無診斷」必須可區分。

**不在範圍內：**

- 第三方（非內建）語言服務；外部程序 RPC。
- 只停用語言服務的開關。
- Monaco 語言註冊、關鍵字與 Monarch tokenizer、縮排與括號等語言設定（2C）；2B-2 期間保留編譯期內建的註冊橋接。關鍵字「補全」仍屬 2B-2。
- 新語言的自動推斷；隱式專案維持現有 `bp`／`ev3-native` 預設。

## 2. `contributes.languageServices`

插件 API 升為 **1.3.0**（protocol schema、JSON Schema、JS SDK 常數、Python SDK、conformance 同步）。

```json
"languageServices": [
  {
    "language": "bp",
    "extensions": ["bp", "bpi", "bpm"],
    "capabilities": [
      "analysis", "completion", "quickFixes", "semanticTokens",
      "hover", "signatureHelp", "definition", "references",
      "rename", "documentSymbols", "documentFormatting", "rangeFormatting"
    ]
  }
]
```

**Schema（嚴格物件，可匯出為 JSON Schema，不用 refine/transform）：**

- `language`：沿用 frontend 的語言 ID 規則。
- `extensions`：沿用 frontend `sourceExtensions` 的副檔名規則；非空、不重複。
- `capabilities`：上列 12 個值的 enum；非空、不重複。
- 陣列最多 8 筆。

**語意驗證（registry，回報 `PLUGIN_E_MANIFEST`，插件 invalid）：**

- 同插件內 `language` 不重複。
- `capabilities` 必須包含 `analysis`。
- 同一插件必須有 `language` 相同的 frontend 貢獻，且 `extensions` 與該 frontend 的 `sourceExtensions` 集合完全相同。

**只限內建：** 非內建插件只要宣告 `languageServices`（包含空陣列）即為 invalid，問題碼 **`PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN`**。內建與否以 registry 的來源判斷，與 2A 的 compiler 檢查相同。

**衝突：** frontend 衝突已由 [`markProviderConflicts`](../../../packages/plugin-runtime/src/compiler-resolution.ts) 以 `language:<id>` 判定；語言服務跟隨 frontend 擁有者，因此不另設衝突鍵。

內建 `kobrixa.basic-plus` manifest 加上上述宣告，`apiVersion` 改為 `^1.3.0`。

## 3. 實作綁定

在 `apps/desktop/src/main/workspace/` 新增 `builtin-language-services.ts`，比照 [`builtin-compilers.ts`](../../../apps/desktop/src/main/workspace/builtin-compilers.ts)：

```ts
export const BUILTIN_LANGUAGE_SERVICES: Readonly<Record<string, LanguageServiceFactory>> = {
  "kobrixa.basic-plus:bp": basicPlusLanguageService,
};
```

- 鍵為 `pluginId:language`；manifest 中沒有任何實作路徑。
- 工廠宣告自己實作的 capability 集合；啟動時檢查「宣告 ⊆ 實作」。缺工廠或宣告了未實作的 capability：該語言標記為 `unavailable`（原因 `conflict`），並記錄錯誤；插件本身狀態不變。
- worker 端以同一張表（worker 可安全匯入的版本）依綁定建立 session；renderer 端以 `BUILTIN_LANGUAGE_COMPANIONS` 取得 browser companion（§5）。

## 4. 提供者選擇

由 main process 決定，worker 不自行猜測。

1. 讀取已驗證的專案描述，取得 `manifest.language`（隱式專案沿用現有預設）。
2. 以新的 frontend-only 解析（從 [`resolveCompilerProviders`](../../../packages/plugin-runtime/src/compiler-resolution.ts) 抽出）找出唯一一個啟用中、擁有該語言 frontend 的插件。backend 缺席或 IR 版本不相容不影響編輯器分析。
3. 取用該插件 `language` 相同的 `languageServices` 宣告與工廠。
4. 只有副檔名在宣告 `extensions` 內的檔案交給該提供者；其他檔案（例如 JSON）不做語言分析。不會因副檔名相符而改選別的插件。
5. 結果：

```ts
type LanguageBinding = {
  epoch: number; // 宿主遞增，見 §6
  pluginId: string;
  sourceKey: string;
  language: string;
  extensions: string[];
  capabilities: LanguageCapability[];
  frontend: FrontendDecl; // worker 以此載入專案來源
};
type LanguageAvailability =
  | { kind: "available"; binding: LanguageBinding }
  | { kind: "unavailable"; reason: "missing" | "conflict"; language: string };
```

- `missing`：沒有啟用中的 frontend，或該 frontend 插件沒有語言服務宣告。
- `conflict`：有插件因 `language:<id>` 帶 `PLUGIN_E_PROVIDER_CONFLICT` 而 invalid（`markProviderConflicts` 會讓衝突雙方都失效，因此須先檢查這個問題碼，再判定 `missing`）、缺工廠、capability 不符。
- 單一檔案不在 `extensions` 內時，renderer 對該 model 不註冊動態功能（不視為整體不可用）。
- 不再退回 Basic Plus。worker 以綁定的 frontend 宣告載入來源，並核對專案描述的語言仍與綁定相符，不符則回 `resync`。

**來源加註：** 分析診斷以 `stampDiagnostics(diagnostics, binding.pluginId)` 加註，取代 2B-1 的相容 adapter（該 adapter 刪除）。core 載入器診斷維持 `kobrixa.core`；提供者自帶 `source` 時仍發布 core BUILD1007（2B-1 規則不變）。

## 5. 共通型別與 browser companion

跨越提供者邊界的型別一律泛化，放在 `apps/desktop/src/shared/`：

| 現有型別                   | 宿主型別                                                                       |
| -------------------------- | ------------------------------------------------------------------------------ |
| `BasicPlusProjectAnalysis` | `LanguageAnalysis`：已發布診斷、來源快照、可選的 symbols／semantic tokens 區段 |
| `BasicPlusSymbol`          | `LanguageSymbol`：不透明 ID、通用 kind、位置、提供者產生的顯示文字／簽名／文件 |
| `BasicPlusCompletionIndex` | `CompletionIndex`：候選、不透明可見性群組、scope 範圍、提供者定義的遮蔽鍵      |
| `BasicPlusQuickFix`        | `QuickFix`：ID、在地化標題、單檔文字編輯                                       |
| `BasicPlusSemanticToken`   | `SemanticToken`：range、type、modifiers；legend 由提供者實作提供               |

- hover、簽名提示、定義、引用、重新命名、文件大綱、格式化由提供者回傳通用結果（Monaco 相容的 range／文字／編輯）；宿主不理解語言語意。
- AST、相依綁定、Basic Plus 大小寫折疊、重新命名規則、Quick Fix 代碼資格與標題鍵留在提供者內。
- 保留既有的緊湊 token／occurrence 打包與差異更新，傳輸量不增加。
- **Browser companion：** 每個內建語言可有一個編譯期內建的 renderer 模組（`BUILTIN_LANGUAGE_COMPANIONS["pluginId:language"]`），負責即時補全過濾、結構性編輯偵測與格式化黏合，保留現有即時補全與收尾關鍵字縮排行為。
- **匯入規則：** 通用 renderer 與 shared 程式碼不得匯入 `@kobrixa/basic-plus`（型別亦同）；只有 Basic Plus companion 與 worker adapter 可以。以測試或 lint 規則鎖定。
- `basic-plus-quick-fixes.ts` 的 `offersBasicPlusQuickFix` 移入 Basic Plus 提供者；renderer 改以綁定的 `quickFixes` capability 決定是否詢問。

## 6. Worker 與快取失效

- 每個工作區維持兩條通道：**分析／Quick Fix worker** 與**補全 worker**（補全獨立，避免被同步分析阻塞）。兩者改為通用 worker，依綁定建立提供者 session；不為每個插件各開 worker。
- **Binding epoch：** 宿主為每次綁定發出遞增的 `epoch`，附在所有同步請求、回覆、已接受的分析、Quick Fix 請求與補全快取上。
  - 以下情況換新 epoch：綁定的 pluginId／sourceKey／generation 改變、專案語言或路由相關設定改變、worker 重啟。
  - 換 epoch 時：取消進行中工作、釋放 session、清除 Quick Fix／索引／tokens、拒收舊 epoch 的回覆、強制完整同步。
  - 一般輸入只遞增文件 revision，不換 epoch，增量快取照常。
- 保留既有行為：取消後仍依序套用文件更新、相依 context 快取、有界的分析與 fix 歷史、補全只在 refresh 時掃描磁碟、補全 50 ms／150 ms 排程。Basic Plus 的結構性失效判斷移到提供者內；幾何位移（rebase）留在通用層。
- **Quick Fix 路由：** 先在已接受的分析中找到相同的已發布診斷（`sameDiagnostic`，含 `source`），再確認 `source === binding.pluginId` 且 epoch 相符，交給該綁定的提供者；epoch 不符回 `stale`；提供者無 `quickFixes` capability 回空結果。
- 內建插件目前不可停用，但提供者「可用 ↔ 不可用」的轉換（例如專案語言改變、開發插件造成衝突）仍須實作與測試。

## 7. 不可用狀態與 UX

- 同步回覆新增 `{ kind: "unavailable"; reason; language }`，與 `result`（含空診斷）及 `resync` 區分。補全回覆同樣新增 `unavailable`。
- 不可用時：清除動態結果（診斷、tokens、補全索引、Quick Fix），保留編輯與既有詞法高亮。
- 編輯器區域顯示 `role="status"` 的語言狀態列（沿用 `file-change-banner` 的呈現方式），內容含原因與建議動作：
  - `missing`：「此專案的語言 `<id>` 沒有可用的語言服務」，動作：開啟插件設定。
  - `conflict`：升級為工作區橫幅，列出衝突的插件，動作：開啟插件設定。
- 文字中英雙語，加入既有的在地化字串表。

## 8. 錯誤處理

| 狀況                                | 處理                                                               |
| ----------------------------------- | ------------------------------------------------------------------ |
| `languageServices` schema／語意錯誤 | `PLUGIN_E_MANIFEST`，插件 invalid                                  |
| 非內建插件宣告 `languageServices`   | `PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN`，插件 invalid         |
| 缺工廠／capability 不符             | 該語言 `unavailable(conflict)`，記錄錯誤                           |
| 提供者執行例外                      | 沿用 `ok:false`＋resync；提供者自帶 `source` 時發布 core BUILD1007 |
| worker 崩潰                         | 沿用重啟邏輯，重啟後換新 epoch                                     |
| 舊 epoch 的回覆／Quick Fix 請求     | 拒收／回 `stale`                                                   |

## 9. 測試與驗收

- **第二內建語言（僅測試）：** 不同副檔名、大小寫敏感名稱、不同 token legend、與 Basic Plus 重疊的診斷代碼。以它驗證：manifest 拒絕、frontend／服務不一致、backend 缺席時仍可分析、擁有者衝突、缺工廠、來源偽造、請求進行中換提供者（舊 epoch 回覆被拒收）、同代碼不同來源的 Quick Fix 隔離。
- **Schema：** 1.3.0 的 JSON Schema 匯出、Python SDK 與 conformance 案例（含非內建宣告）。
- **防退化：** 擴充既有的 worker 歸屬／stale、結構性編輯、model 替換、連續輸入、UTF-16／BOM、semantic tokens 保留測試；增量分析與全新分析結果比對。
- **匯入規則：** 通用 renderer／shared 不匯入 `@kobrixa/basic-plus`。
- **效能：** [`completion-performance-smoke.mjs`](../../../tests/desktop/completion-performance-smoke.mjs) 門檻不變（熱補全 p95 ≤100 ms、新變數 ≤200 ms、30,000 行 ≤300 ms）；此機器若無法執行 smoke，列為人工驗收項目。
- 全套：`pnpm -r build`、`pnpm test`、`pnpm test:bytecode`、`pnpm test:python-sdk`、web 測試、prettier、eslint。

## 10. 實作切分

1. `languageServices` schema、語意驗證、`PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN`、API 1.3.0（schema／SDK／conformance）、Basic Plus manifest。
2. Frontend-only 解析、`LanguageBinding`／`LanguageAvailability`、epoch 發放。
3. 共通型別與傳輸轉換（分析、符號、補全索引、tokens、Quick Fix、編輯結果）。
4. 內建實作註冊表、Basic Plus worker adapter 與 browser companion；刪除 2B-1 相容 adapter。
5. 兩條 worker 通道的生命週期、epoch、取消與快取失效、Quick Fix 依來源與綁定路由。
6. Renderer Monaco 通用路由、全部現有功能遷移、不可用 UX、匯入規則。
7. 第二語言 fixture、競態與效能回歸、插件作者文件與架構文件更新。
