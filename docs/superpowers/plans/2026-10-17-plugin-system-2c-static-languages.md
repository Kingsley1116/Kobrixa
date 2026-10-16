# Plugin System 2C — Static Language Contributions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add validated, versioned static language contributions for builtins and trusted development plugins, preserving Basic Plus editing behavior and restoring plain text safely when a contribution becomes unavailable.

**Architecture:** Protocol owns the declarative resource format and pure validation; runtime reads eligible resources, resolves ownership, and publishes an atomic revisioned catalog. Desktop main supplies trusted IPC and recovery persistence, while one renderer store and registrar reconcile every live model through a shared lexical resolver. T0 freezes compilable interfaces and fixtures, T1–T7 implement disjoint write sets in parallel, and T8 merges and verifies the complete system.

**Tech Stack:** TypeScript with `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`; Node.js 24; Electron 44; Zod 4 with draft-2020-12 JSON Schema; React 19; `monaco-editor@0.57.0`; Vitest; pnpm; Python SDK conformance tests.

**Spec:** [`docs/superpowers/specs/2026-10-17-plugin-system-2c-static-languages-design.md`](../../../../docs/superpowers/specs/2026-10-17-plugin-system-2c-static-languages-design.md), all sections, especially §11. This approved spec is the binding authority; each executor reads it together with this plan. Format: [`.superpowers/sdd/2c-design/plan-format.md`](../plan-format.md).

## Global Constraints

The following contractual text, values, tables, user decisions, and non-goals are copied verbatim from the approved spec. Every task inherits them.

`PLUGIN_API_VERSION` 升為 **`1.4.0`**。protocol、公開 JSON Schema 的 `$id`、JS SDK 匯出、Python SDK 常數／schema 與 conformance fixtures 必須同步。既有符合 host API range 的 1.x 插件繼續載入；使用本能力的插件宣告 `apiVersion: "^1.4.0"`，避免舊 host 忽略新欄位。無須新增 tokenizer registration RPC。

`runtime` 仍為必填，新增嚴格 variant **`runtime: {kind:"static"}`**：

- 只接受 `kind`，不接受 `entry` 或未知 runtime 欄位。
- 不得宣告 `activationEvents`、`permissions`、`contributes.commands`、`frontends`、`backends`、`languageServices`，即使值是空陣列亦不合法。
- 至少有一項非空 `languages` 或有效的 `diagnosticHelp` 宣告；空 `languages` 陣列不算有效貢獻。資源讀取失敗依 §5 隔離，不反過來將已合法的 runtime 宣告判為空插件。
- 永遠不進 launcher、activation、supervisor 啟動或 handshake。設定頁應呈現靜態貢獻的啟用狀態，不以沒有 PID 判定不可用。

`node`／`python` 插件也可同時提供靜態語言；讀取、驗證與註冊這些資料不觸發其程序。builtin 保留 `{kind:"builtin"}`，身分由 host source 決定，第三方不能以 manifest 自稱 builtin。既有 runtime variants 的相容行為不變；更新 `PluginSummary.runtime`、runtime narrowing 與 manager 程序建立條件。

第三方 compiler 禁令仍適用。來源限制先於 static runtime 語意檢查；任何非 builtin source 宣告 `languageServices`（包含空陣列）仍回報 `PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN` 並使插件 invalid，不得因新增 static runtime 放寬或以一般 manifest 錯誤取代此規則。

在 `packages/plugin-protocol/src/static-language-limits.ts` 匯出不可變的 `STATIC_LANGUAGE_LIMITS_V1` 與 `STATIC_LANGUAGE_FORMAT_VERSION = 1`。下列數值為正式 v1 契約，不能交由插件覆寫或在發布後無聲更改。

| 常數                        |             精確值 | 計量與範圍                                                                                                                   |
| --------------------------- | -----------------: | ---------------------------------------------------------------------------------------------------------------------------- |
| `patternLength`             |              2,048 | 原始解碼 pattern 的 code points，最少 1。                                                                                    |
| `compiledPatternLength`     |              4,096 | adapter escape／anchoring 後 source 的 code points。                                                                         |
| `rulesPerLanguage`          |              1,024 | 全部 states 的原始 rule entries 合計；每個 include entry 也算 1。                                                            |
| `regexesPerLanguage`        |              1,024 | tokenizer、最多 4 個 indentation 欄位、onEnter 全部 regex 欄位及 wordPattern 合計；重複內容仍逐次計數。                      |
| `statesPerLanguage`         |                 64 | 包含未被引用的 states。                                                                                                      |
| `resourceFileBytes`         | 524,288（512 KiB） | 每份原始 UTF-8 resource，含 BOM。                                                                                            |
| `resourceBytesPerLanguage`  | 786,432（768 KiB） | tokenizer 與 configuration 原始 bytes 合計。                                                                                 |
| `resourceBytesPerPlugin`    | 1,048,576（1 MiB） | 該插件所有 language resource 引用合計；重複 path 依每次引用計入。                                                            |
| `resourceBytesTotal`        | 8,388,608（8 MiB） | 全部啟用且納入 catalog 的靜態語言資源；與 diagnostic-help 預算分開。                                                         |
| `expandedRulesPerLanguage`  |              8,192 | 每個 state 完整 include 展開後的 rules 再合計；重複 include 不去重。                                                         |
| `expandedRulesTotal`        |             65,536 | 全部啟用且納入 catalog 的語言展開後總量。                                                                                    |
| `includeDepth`              |                 16 | 最長 include 路徑的 edges 數；不是 state 數。                                                                                |
| `regexFlags`                |        `""`、`"i"` | tokenizer 另須與 `ignoreCase` 一致。                                                                                         |
| `listsPerLanguage`          |                 32 | Keyword lists 數。                                                                                                           |
| `wordsPerLanguage`          |              4,096 | 全部 lists 的 words 合計，每字最多 64 code points。                                                                          |
| `casesPerRule`              |                 32 | 每條 cases action 的分支數。                                                                                                 |
| `onEnterRules`              |                 32 | 每個 configuration 的 onEnter rules 數。                                                                                     |
| `languagesPerPlugin`        |                  8 | 每插件 declarations 數。                                                                                                     |
| `languagesTotal`            |                128 | 活動 catalog 的獨立 language ids；reload 同 id 不增加。                                                                      |
| `sessionLanguageIds`        |                256 | 本 renderer session 曾對插件貢獻呼叫 `languages.register()` 的不同 Monaco language ids，包含已撤銷的 shell；不是 plugin 數。 |
| `maxTokenizationLineLength` |         **10,000** | Monaco `line.length`，以 UTF-16 code units 計量；長度 **≥ 10,000** 跳過該行詞法 tokenization，保留文字編輯。                 |

§2、§3 的其他結構上限同樣屬 v1：extensions 1–16 筆／每筆 1–16 字元、aliases 1–8 筆／每筆 1–80 code points、names 最長 32、token/postfix 最長 80、word 最長 64、pair/comment atom 1–16、各配對表最多 32、`notIn` 最多 3、`appendText`／`removeText` 最多 256，以及 resource path 最長 600／最多 7 層目錄。JSON Schema、Zod 與 Python 的字串長度語意必須一致；不能以 JavaScript `.length` 誤算非 BMP 字元。

Include graph 使用三色 DFS 檢查 missing reference、cycle 與所有 states，錯誤列出循環路徑。先 memoize 展開數，以飽和加法在 `limit + 1` 停止，通過才 materialize；不得先配置巨大 arrays 再計數。DAG 最長路徑要獨立計算，不能因 visited cache 漏掉較深的第二條路徑。`next` 只查 state 引用，不當作 include edge。

主 editor、diff original/modified 及所有建立／更新 options 入口必須顯式設定 `maxTokenizationLineLength: 10000`，放在其他 options spread 之後，確保無法被提高。以真實 Monaco 的最終 configuration 與 `tokenize`／`tokenizeEncoded` 驗證 `>=` 邊界，不能只檢查 props 中有數字。

這個閾值不限制 indentation／onEnter／wordPattern 的輸入，也不能阻止短 pattern 對短輸入的災難性回溯。一般 Monaco worker 不代表自訂 Monarch 已離開 UI thread，同執行緒的 timer／Promise timeout 不能中斷同步 regex；可信插件與下一次啟動的復原機制仍是必要前提。

**Flags：** 每個 regex 必填 `flags`，只接受 `""` 或 `"i"`；拒絕重複 flags 及 `g/y/d/m/s/u/v` 等其他值。tokenizer 每條 regex 的 flags **必須恰等於 `ignoreCase ? "i" : ""`**，混用即拒絕。configuration 每條 regex 可獨立選 `""` 或 `"i"`，adapter 以 `new RegExp(pattern, flags)` 建立。

此規則對應目前鎖定的 `monaco-editor@0.57.0`：Monarch 取 RegExp 的 `.source` 後，以 language-level flags 重建 regex，不能讓作者指定的 flags 靜默失效。升級 Monaco 必須重跑 adapter conformance。

**Macro 與 escaping：** wire `pattern` 是一般 ECMAScript regex source，不具有 Monarch macro 或 state interpolation 語意。tokenizer adapter 必須將每個 literal `@` 轉成 `@@`，由 Monarch 還原；不得把未轉換的 source 直接交給 macro expander。必測 `@`、`@@`、`@name`、反斜線後的 `@` 與 literal `$`，確保 wire 語意不變。configuration 不經 Monarch，不做這項 `@` doubling。

共用 validator 拒絕 source 中會觸發 `$S`／`$s` 加數字的形式（以 `/\$[Ss][0-9]/` 偵測），包括前方有反斜線、企圖表達 literal `$S1` 的 escaped 形式；反斜線不能用來豁免。action/state 名稱也不能使用 substitution。必須檢查原始及 adapter escape／anchoring 後的 pattern，不能以轉換繞過長度或語法規則。

**零寬規則：** tokenizer rule 的最低消耗長度必須至少 **1**。共用 validator 以 regex 語法 AST 保守計算：斷言消耗為 0、串接相加、alternation 取最小值、量詞採最低重複次數；無法證明最低消耗至少 1 即拒絕。拒絕 backreference、lookbehind 與不支援的 AST 構造；保留 Basic Plus 使用的 lookahead。不得透過執行 `.test()` 或掃描範例字串猜測是否可能零寬。

configuration regex 共用相同語法、flags、大小與 AST validator，但以明確用途參數允許零寬 match（例如縮排的 `^`）。這不是另一套較寬鬆的驗證入口，也不是 ReDoS 證明。

| 狀況                                                                                             | 問題碼與處置                                                                                    |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Manifest 結構、重複 language id、static runtime 語意、同 owner frontend/service extension 不一致 | `PLUGIN_E_MANIFEST`；插件 invalid。                                                             |
| API range、冒充 builtin、第三方 compiler/service                                                 | 沿用既有對應錯誤；第三方 service 必須保留 `PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN`。        |
| Resource 缺失、越界、讀取失敗、resource deadline、大小、schema、regex、引用、include 或總預算    | `PLUGIN_E_STATIC_LANGUAGE`；只拒絕該 language，插件其他有效貢獻仍可用。                         |
| 核心保留 id/extension、frontend ownership、重複 static id、extension ambiguous                   | `PLUGIN_E_STATIC_LANGUAGE_CONFLICT`；依 §6 排除該 language 或該 mapping，不使整個插件 invalid。 |
| Renderer DTO／adapter／Monaco 註冊失敗、session language id 上限                                 | `PLUGIN_E_STATIC_LANGUAGE_REGISTRATION`；隔離該 sourceKey／generation／language。               |
| 嘗試停用 builtin                                                                                 | `PLUGIN_E_BUILTIN_REQUIRED`；維持 2B-2 行為。                                                   |

三個新增靜態語言問題碼均必填 `detail.languageId`；resource 問題填 `resourcePath`／適用的 `fieldPath`，limit 問題填 `limit`、`allowed`、`actual`，衝突列出全部參與插件來源；核心保留衝突另在 message 與 catalog 的 `kind`／`key` 辨識。循環 include 的 `fieldPath` 指向入口、message 包含循環路徑。host 填入 ownership，message 必須含 plugin id，不能借用 compiler 的 `providerKey: language:*`，以免誤判成 service conflict。例如：

```text
acme.toy / toy / language/tokenizer.json / states[2].rules[4].regex.pattern:
STATIC_LANGUAGE_LIMITS_V1.patternLength exceeded (actual 2049, allowed 2048).
```

1. **核心保留：** `plaintext`、`json` 及核心實際安裝的其他 Monaco ids 由顯式核心清單保留；`.json` mapping 也保留。插件占用核心 id 時拒絕其 language；只碰到保留 extension 時拒絕該 mapping，保留該 language 的其他有效 mapping，回報衝突。alias 不參與 ownership。
2. **Frontend owner 保留 logical language id：** 只有同 `pluginId`／`sourceKey` 可提供該 id 的 static contribution；其資源失敗不解除 frontend 的保留。第三方 `id:"bp"` 不能覆寫 builtin grammar，也不能因此讓原有 compiler plugin invalid；只拒絕越權的靜態宣告。
3. **純靜態 id：** 沒有 frontend owner 時，多個 enabled 插件宣告同 id，所有該 id 貢獻均不註冊並回報完整衝突。不得按載入順序、版本號或 builtin 身分選一方；停用其中一方後重算，剩餘唯一來源可恢復。
4. **Extension：** 不同有效 static ids 宣告同 extension，global mapping 為 ambiguous，回報所有來源；只撤銷該 extension mapping，其他 extensions 及語言註冊仍可用。不得依載入順序暗選 winner。
5. **Selected binding：** 已選定且 extensions 支援該檔案的 `LanguageBinding`，只能取同 `pluginId`、`sourceKey`、`language` 的 static contribution。這可消除 extension 歧義；該 owner 的 static 不可用時直接 `plaintext`，不能改取另一插件的 grammar。

Id 衝突對完整 eligible 宣告集合判定，extension 衝突對完整有效 static candidate 集合判定；不能迭代排除 A 後意外讓原本與 A 衝突的 B 成為 winner。停用、reload、資源可用性改變時重算整份結果。

解析次序固定為：**核心 route → 適用的 selected binding 同 owner static route（失敗直接 plaintext）→ 唯一 global extension route → plaintext**。沒有適用 binding，包括專案 service unavailable 時，仍可使用無衝突的 global lexical route，保留 2B-2「分析不可用但仍可詞法上色」的行為。

例如 A 提供 `toy-a/.toy`，B 提供 `toy-b/.toy`：沒有 selected binding 的文件／review 使用 `plaintext` 並回報 extension conflict；已明確選定 A 的專案可使用 A grammar。主 editor、狀態標籤、diff／review 必須使用同一 resolver；review 有專案上下文時傳入同一 binding。

移除 `LanguageCompanion.monacoLanguage` 欄位與其全部讀取；companion 不再提供 lexical id。`language-features.ts`、semantic-token selector 從目前 `ModelLanguageRoute` 取得實際 Monaco id，仍檢查 workspace、model URI、binding sourceKey 與 binding epoch。

static failure 不改寫 `LanguageAvailability`，也不重啟有效的 analysis worker。`plaintext` fallback 必須撤銷該 model 的 semantic coloring 並清除舊 tokens；其他動態功能僅能在原 binding／model guard 通過後提供。如需使用 plaintext selector，每個 callback 都必須做相同 guard，不能讓相鄰無關的純文字文件收到該 service 的功能。

**使用者決定（2026-10-17）：**

1. 第二階段允許可信 development 第三方插件提供靜態語言；`languageServices` 維持 builtin-only。
2. Language configuration 只接受有版本的 JSON resource，不接受 inline configuration。
3. Basic Plus 的 Monaco language id 改為 `bp`，與 frontend/service 相同；`tokenPostfix: ".basic-plus"` 保留，主題不變。
4. 不同靜態語言宣告同一 extension 時，global mapping 為 ambiguous，回報衝突並退回 `plaintext`；適用的 project `LanguageBinding` 可使用同 owner 的 static language 消歧義。沒有隱式優先序，也不新增 file-association UI。
5. 內建語言服務與 Basic Plus 維持必要且不可停用，沿用 `PLUGIN_E_BUILTIN_REQUIRED`；safe mode 只停用第三方。

**不在範圍內：**

- 完整 ReDoS 防護；本設計不保證 ReDoS-proof。
- 不可信 grammar sandbox、可終止 tokenizer worker 或替代 regex 引擎。
- 第三方 `languageServices`、language-service RPC、跨插件 grammar/service pairing。
- File-association UI、glob、完整 filename、first-line 偵測、複合副檔名或 dialect 配對。
- Theme contributions；現有 Kobrixa 主題仍由宿主初始化。
- Marketplace、下載安裝、新語言的隱式專案推斷，或 Basic Plus 演算法變更。

Additional cross-task obligations from §§5–10:

- Resource I/O has one **5,000 ms** deadline per source, including metadata; metadata/source failure and per-language resource failure retain their distinct error handling. Resource accounting uses original UTF-8 bytes including BOM, counts duplicate path references separately, and precedes unbounded allocation.
- Builtin raw JSON is bundled with Vite `?raw`; no renderer file reads, repository-directory assumptions, parse/stringify byte accounting, or custom loaders. The same resource validator applies to builtin and development inputs.
- Bootstrap waits at most **5,000 ms** for initial IPC; subscription precedes fetch, and stale replies cannot outrun the highest observed target revision. The barrier precedes restoration and every document model entry point; timeout/failure allows plain-text restoration and later reconciliation.
- `thirdPartyStaticContributions: boolean` defaults to false for old markers. It must be synchronously persisted before any third-party catalog delivery, remains sticky through the session, and write failure prevents delivery with `PLUGIN_E_STATE_SAVE`. Renderer-unresponsive recovery takes precedence over unclean exit.
- Registration failure reports use `plugins:report-language-registration-failure`, the five reasons `dto-version`, `validation`, `adapter`, `monaco`, `session-language-ids`, and at most **2,048 code points** of text detail. Main verifies trusted sender, current revision, full ownership, and duplicate/stale reports; retry is only on reload or explicit enable.
- `languages.register({id})` returns void and is called once per distinct contributed id per renderer session. No aliases/extensions go into Monaco registration; provider/configuration disposables control availability. The 257th distinct id fails; re-enable reuses its existing shell.
- Lexical catalog revision and binding epoch stay separate. Revocation updates existing models with `setModelLanguage()`, preserves editing state, removes dynamic attachments before disposing providers, and clears semantic coloring on plain-text fallback.
- Basic Plus keeps its nine root rules, case-insensitive keyword ordering, `.basic-plus` token postfix, comments/pairs, and the two existing indentation patterns. No `wordPattern` or `onEnterRules` is introduced. Theme initialization is independent of language availability; generic renderer code has no Basic Plus extension inference.
- N1 belongs to T7: smoke preload exposes `windowChrome` only on Windows. N2 belongs to T5 only if its static-unavailable UI work touches that same status-row region; otherwise T8 records why N2 remains out of scope.
- Completion thresholds remain hot completion **p95 ≤100 ms**, new variable **≤200 ms**, and **30,000 lines ≤300 ms**. Real Monaco, packaged, recovery, and Electron results must be identified separately from mocks; unrun acceptance is recorded, never inferred from a passing unit test.

Environment rules:

- Prefix pnpm with `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false;`.
- Desktop consumes the packages' `dist/`, so rebuild `@kobrixa/plugin-protocol` and `@kobrixa/plugin-runtime` after changing them.
- Never run `pnpm install` except T1 when adding a dependency.
- The Codex sandbox cannot commit; the controller commits.

## Review Focus

- **RF1 — T3/T7:** A static-only plugin is enabled after startup and marker persistence fails: no third-party grammar reaches the renderer, builtin editing survives, and the next launch retains the correct recovery reason. Pin `refuses post-startup static catalog delivery when marker persistence fails` in `apps/desktop/src/main/plugins/controller.test.ts` and recovery smoke.
- **RF2 — T4/T5:** A disable or new extension conflict arrives while an older catalog fetch and a hidden/diff model creation are in flight: all affected models immediately lose the old route, stale replies cannot restore it, and text/undo survive. Pin `revokes hidden and newly created diff models before a stale catalog resolves` in `apps/desktop/src/renderer/editor/static-language-registration.test.ts` and `apps/desktop/src/renderer/workspace/file-review-dialog.test.ts`.
- **RF3 — T2:** A frontend owner's grammar fails while another plugin claims its language id or shared extension: reservation survives, selected binding falls directly to plain text, and ordering never selects a foreign grammar. Pin `retains frontend reservation after resource failure in either source order` in `packages/plugin-runtime/src/static-languages.test.ts`.
- **RF4 — T1/T4:** Non-BMP aliases and escaped regex text cross structural, semantic, and Monaco boundaries: code-point limits and UTF-16 line limits stay distinct, literal `@` stays literal, and escaped `$S1` is rejected. Pin `counts decoded code points and preserves literal macro characters` in `packages/plugin-protocol/src/static-languages.test.ts` and `apps/desktop/src/renderer/editor/static-language-adapter.test.ts`.
- **RF5 — T4/T5/T6:** Repeated reload failures, the 256/257 id boundary, and an old session restored after rename: shells are counted once, failed generations never auto-retry, models preserve undo and regain only their current valid language, and themes still initialize. Pin `restores renamed drafts across failed generations without registering a shell twice` in `apps/desktop/src/renderer/editor/static-language-registration.test.ts` and `apps/desktop/src/renderer/editor/static-language-migration.test.ts`.

---

## Parallel Execution

T0 runs alone first and the controller commits it. T1–T7 then run in parallel, each in its own git worktree branched from that exact T0 commit. No parallel task writes outside its write set, including tests, mocks, fixtures, generated artifacts, dependency files, or convenience cleanup. Read access is unrestricted.

The table below reproduces §11.1 with desktop abbreviations expanded to full repository-relative paths. The two ownership additions are stated immediately after the table; they are necessary for this concrete scaffold and do not change the design contract.

| 任務 | 唯一可寫檔案集                                                                                                                                                                                                                                                                                                                                                                                                                                 | 交付／依賴                                                                                                                                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T0 契約凍結**                  | 本 2C spec；contract fixture／必要最小 scaffold（逐檔記錄，完成即交接下列 owner）                                                                                                                                                                                                                                                                                                                                                              | 確認本文決策、函式簽章、exports 與 mock ownership；不保留與後續任務同時寫入的權限。                                                                                                                                        |
| **T1 Protocol、validator、SDK**  | `packages/plugin-protocol/**`、`packages/plugin-sdk-js/**`、`sdks/python/**`、`pnpm-lock.yaml`                                                                                                                                                                                                                                                                                                                                                 | API 1.4.0、static runtime、schema／limits、browser-safe AST validator、SDK／conformance。需新增 regex parser 時由 T1 修改 protocol package 與 lockfile；不改 builtin manifest。其他任務的依賴需求交 T1 統一更新 lockfile。 |
| **T2 Runtime**                   | `packages/plugin-runtime/**`                                                                                                                                                                                                                                                                                                                                                                                                                   | 分階段 registry、bounded reader、builtin resource source type、catalog／revision／ownership／conflicts、manager lifecycle、錯誤與 tests；自備 fixture，不寫產品 builtin 資源。依 T0 介面可先開發，整合依 T1。              |
| **T3 Desktop main／IPC／復原**   | `apps/desktop/src/main/plugins/**`，**排除 `apps/desktop/src/main/plugins/builtin.ts`／`apps/desktop/src/main/plugins/builtin.test.ts`**；`apps/desktop/src/main/index.ts` 及其直接測試；`apps/desktop/src/preload/index.ts` 及其直接測試；`apps/desktop/src/shared/plugins.ts`、新增 `apps/desktop/src/shared/static-languages.ts` 及直接測試；新增唯一 ownership：`apps/desktop/src/main/workspace/compiler-chain.test.ts`、`apps/desktop/src/main/language/language-provider.integration.test.ts` | Catalog/report IPC、可信 sender、session marker、safe-mode 順序、preload/shared API 與 mocks。先 mock T2 manager；不改 `tests/desktop/preload.cjs`。                                                                       |
| **T4 Renderer 靜態基礎**         | 新增 `apps/desktop/src/renderer/editor/static-language-store.ts`、`apps/desktop/src/renderer/editor/static-language-registration.ts`、`apps/desktop/src/renderer/editor/static-language-adapter.ts`、`apps/desktop/src/renderer/editor/static-language-routing.ts` 與四者各自 `.test.ts`                                                                                                                                                                                                                                                                           | Store、adapter、disposables、純 lexical resolver、model tracking。依 T0 介面與 mock API 開發；整合依 T1 validator／T3 IPC。不改 `apps/desktop/src/renderer/editor/editor.tsx`／`apps/desktop/src/renderer/app.tsx` 或 migration tests。                                               |
| **T5 Renderer 整合／UI**         | `apps/desktop/src/renderer/app.tsx` 及其測試；既有 `apps/desktop/src/renderer/editor/{editor.tsx,language-routing.ts,language-companion.ts,language-features.ts,semantic-tokens.ts,editor-models.ts}` 及各自既有測試；`apps/desktop/src/renderer/workspace/file-review-dialog.tsx` 及測試；`apps/desktop/src/renderer/settings/{plugin-copy.ts,plugins-panel.tsx}` 及測試；`apps/desktop/src/renderer/i18n/**`；N2 若觸及則 `apps/desktop/src/renderer/editor/language-status.tsx`／`apps/desktop/src/renderer/editor/language-status.test.ts`；新增 `apps/desktop/src/renderer/editor/model-language-route.ts`、`apps/desktop/src/renderer/editor/static-language-bootstrap.ts` 及各自直接 `.test.ts` | Bootstrap、所有 consumer／selectors／labels、長行設定、model 路由、UI fixtures；依 T4 API 與 T6 theme 函式。不改 companion 實作或 main；N2 僅按 §9.3 納入。                                                                |
| **T6 Basic Plus 資源／主題拆分** | `plugins/basic-plus/**`；`apps/desktop/src/main/plugins/builtin.ts`／`apps/desktop/src/main/plugins/builtin.test.ts`；`apps/desktop/src/renderer/editor/companions/basic-plus/{registration.ts,companion.ts}`；新增 `apps/desktop/src/renderer/editor/companions/basic-plus/theme.ts`、`apps/desktop/src/renderer/editor/editor-theme.ts`、`apps/desktop/src/renderer/editor/static-language-migration.test.ts`，以及 theme 模組直接測試                                                                                                                          | JSON 資源、raw bundling、移除舊 registration／companion lexical id、theme bridge、parity。依 T0 fixture 製作，經 T1 validator 驗證，依 T2 source type 整合，向 T5 交付 theme 初始化函式。                                  |
| **T7 跨層驗收／作者文件**        | 新增 `tests/desktop/static-languages-*`、`tests/desktop/fixtures/static-languages/**`；`tests/desktop/preload.cjs`、`tests/desktop/smoke-main.mjs`、`tests/desktop/smoke-harness.test.mjs`；需擴充的 `tests/desktop/*plugins*smoke*`、`tests/desktop/packaged-smoke.mjs`、`tests/desktop/highlighting-smoke.mjs`、`tests/desktop/indentation-smoke.mjs`、`tests/desktop/language-features-smoke.mjs`、`tests/desktop/completion-performance-smoke.mjs`；`docs/en/plugin*`、`docs/zh-TW/plugin*`、兩語系 `docs/en/language-support.md`／`docs/zh-TW/language-support.md`／`docs/en/architecture.md`／`docs/zh-TW/architecture.md` | Static-only integration、safe mode／recovery／packaging、作者資料格式與信任說明、N1 guard。先依契約寫 fixtures，正式端到端驗收依 T3/T5/T6；不改其他任務的 unit tests 或正式 spec。                                         |
| **T8 整合**                      | 根 `package.json`、CI scripts／workflow 的檢查接線；T1–T7 停止寫入並交接後才接手必要跨層修正                                                                                                                                                                                                                                                                                                                                                   | 串接 exports／測試入口、完整驗收、hardcoding/import 掃描、封裝確認；優先把缺陷退回原 owner。進入最終整合前不得與仍在執行的任務同寫檔案。                                                                                   |

Ownership adjustments to §11.1, reflected in the table above:

1. **T3** additionally owns `apps/desktop/src/main/workspace/compiler-chain.test.ts` and `apps/desktop/src/main/language/language-provider.integration.test.ts`. Their existing builtin `PluginSource` fixtures need the now-required `resources: {}` field to type-check. T0 makes only that mechanical edit; neither file acquires a second writer.
2. **T5** additionally owns `apps/desktop/src/renderer/editor/model-language-route.ts`, `apps/desktop/src/renderer/editor/static-language-bootstrap.ts`, and their direct tests. The former freezes the migrated model-route shape without replacing current editor behavior during T0; the latter keeps the app/bootstrap contract with T5, as §11 requires.

All shared fixtures live under `packages/plugin-protocol/test-fixtures/static-languages/`, hence T1 owns them after T0. T2/T3/T4/T5/T6/T7 may read them or copy them into their own owned fixtures, but may not edit that shared directory. Requests for any additional shared-file ownership go to the controller before editing.

Every task's own verification must pass against the T0 stubs and mocks alone, without another parallel task's real implementation. T2 mocks the pure validator when testing runtime orchestration; T3 mocks the manager port; T4 mocks protocol validation and the preload API while testing its own adapter/store/registrar; T5 mocks T4 and T6; T6 uses the frozen resource fixtures and tests local parity with mocked validation; T7 verifies harness/fixture construction with contractual IPC/UI mocks. T1 owns real validator conformance. Mock success is only the branch-local gate: T6 validation against the real validator and T7 actual IPC/UI/packaged acceptance run after all branches merge in T8.

After T1–T7 stop writing and their own verification passes, the controller merges all seven branches back. Because their write sets are disjoint, these merges are conflict-free. T8 then integrates the exports, runtime behavior, UI, schema/SDK parity, actual end-to-end acceptance, and the root scripts/CI wiring. Semantic integration failures remain possible despite conflict-free textual merges; return them to their owner or wait for an explicit hand-off before T8 edits the affected files.

Controller-only worktree setup after the T0 commit, from the repository root:

```bash
T0_COMMIT=$(git rev-parse HEAD)
for task in t1 t2 t3 t4 t5 t6 t7; do
  git worktree add -b "feat/plugin-2c-$task" "../plugin-2c-$task" "$T0_COMMIT"
done
```

Expected: seven distinct worktrees, each initially at the identical T0 commit. No dependency installation occurs in this command. Reuse the prepared workspace dependency environment; any new dependency and lockfile mutation belongs only to T1.

Controller-only merge after all seven tasks have stopped writing:

```bash
git switch feat/plugin-2c-static-languages
for task in t1 t2 t3 t4 t5 t6 t7; do
  git merge --no-ff "feat/plugin-2c-$task" -m "merge: plugin 2c $task"
done
```

Expected: seven successful merges with no content conflicts. Only then start T8.

### Task 0: Contract freeze

**Files:**

- Create: `packages/plugin-protocol/src/static-language-limits.ts`
- Create: `packages/plugin-protocol/src/static-languages.ts`
- Create: `packages/plugin-runtime/src/static-languages.ts`
- Create: `apps/desktop/src/shared/static-languages.ts`
- Create: `apps/desktop/src/renderer/editor/static-language-routing.ts`
- Create: `apps/desktop/src/renderer/editor/static-language-store.ts`
- Create: `apps/desktop/src/renderer/editor/static-language-adapter.ts`
- Create: `apps/desktop/src/renderer/editor/static-language-registration.ts`
- Create: `apps/desktop/src/renderer/editor/model-language-route.ts`
- Create: `apps/desktop/src/renderer/editor/static-language-bootstrap.ts`
- Create: `apps/desktop/src/renderer/editor/editor-theme.ts`
- Create: `packages/plugin-protocol/test-fixtures/static-languages/minimal/tokenizer.json`
- Create: `packages/plugin-protocol/test-fixtures/static-languages/minimal/configuration.json`
- Create: `packages/plugin-protocol/test-fixtures/static-languages/basic-plus/tokenizer.json`
- Create: `packages/plugin-protocol/test-fixtures/static-languages/basic-plus/configuration.json`
- Create: `packages/plugin-protocol/test-fixtures/static-languages/toy/kobrixa-plugin.json`
- Create: `packages/plugin-protocol/test-fixtures/static-languages/toy/language/tokenizer.json`
- Create: `packages/plugin-protocol/test-fixtures/static-languages/toy/language/configuration.json`
- Create: `packages/plugin-protocol/src/static-language-contract.test.ts`
- Create: `packages/plugin-runtime/src/static-language-contract.test.ts`
- Create: `apps/desktop/src/shared/static-languages.test.ts`
- Modify: `packages/plugin-protocol/src/manifest.ts:17-162`
- Modify: `packages/plugin-protocol/src/limits.ts:1-1`
- Modify: `packages/plugin-protocol/src/index.ts:12-12`
- Modify: `packages/plugin-runtime/src/errors.ts:1-43`
- Modify: `packages/plugin-runtime/src/registry.ts:24-176`
- Modify: `packages/plugin-runtime/src/manager.ts:1-599`
- Modify: `packages/plugin-runtime/src/index.ts:8-8`
- Modify: `packages/plugin-runtime/src/language-service-conformance.test.ts:20-20`
- Modify: `packages/plugin-runtime/src/manager.test.ts:49-136`
- Modify: `packages/plugin-runtime/src/registry.test.ts:32-414`
- Modify: `packages/plugin-runtime/src/compiler-resolution.test.ts:22-252`
- Modify: `apps/desktop/src/main/plugins/builtin.ts:7-8`
- Modify: `apps/desktop/src/main/workspace/compiler-chain.test.ts:23-23`
- Modify: `apps/desktop/src/main/language/language-provider.integration.test.ts:47-85`
- Modify: `apps/desktop/src/shared/plugins.ts:1-92`
- Modify: `apps/desktop/src/preload/index.ts:59-59`
- Modify: `apps/desktop/src/main/plugins/ipc.ts:1-43`
- Modify: `apps/desktop/src/main/plugins/session.ts:10-68`
- Modify: `apps/desktop/src/main/plugins/session.test.ts:23-23`
- Modify: `apps/desktop/src/main/plugins/controller.test.ts:612-612`
- Modify: `apps/desktop/src/renderer/settings/plugins-panel.test.ts:29-84`
- Test: `packages/plugin-protocol/src/static-language-contract.test.ts`
- Test: `packages/plugin-runtime/src/static-language-contract.test.ts`
- Test: `apps/desktop/src/shared/static-languages.test.ts`
- Test: `apps/desktop/src/main/plugins/session.test.ts`

**Interfaces:**

- Consumes: existing `compilerIdSchema`, `extensionSchema`, `diagnosticHelpDeclSchema.shape.path`, `PluginManifest`, `PluginSource`, `PluginManager`, `PluginsSnapshot`, `PluginsApi`, `PluginEvent`, `SessionMarkerFile`, `LanguageBinding`, `LanguageCompanion`, and Monaco's `editor.ITextModel` / `languages.IMonarchLanguage` / `languages.LanguageConfiguration` / `IDisposable`. None are assumed to exist under a new name.
- Produces (T1): `StaticRuntime`, `StaticLanguageResourceDecl`, `StaticLanguageDecl`, the complete v1 resource types, frozen limits/version, and `validateStaticLanguageResources(input: ValidateStaticLanguageResourcesInput): StaticLanguageValidationResult` plus `staticLanguageDeclarationProblems(manifest: PluginManifest): string[]`.
- Produces (T2/T3): `StaticLanguagesCatalog`, `StaticLanguageOwner`, `ValidatedStaticLanguage`, `StaticLanguageProblemDetail`, required snapshot owner/revision fields, required builtin `resources`, `PluginManager.staticLanguages(): StaticLanguagesCatalog`, `get staticLanguagesRevision(): number`, the typed report input/result, and their Promise-based preload methods.
- Produces (T4/T5/T6): `StaticLanguageStore`, `StaticLanguageRegistrar`, `MonacoStaticLanguageApi`, `resolveLexicalLanguage(input: ResolveLexicalLanguageInput): LexicalLanguageRoute`, migrated `ModelLanguageRoute`, `bootstrapStaticLanguages(input: StaticLanguageBootstrapInput): Promise<StaticLanguageBootstrapResult>`, and `initializeEditorThemes(api: EditorThemeApi): void`.
- Produces (all): seven JSON fixture files at the exact paths in Step 7 and the Interfaces Summary. The Basic Plus files preserve authored regex `.source` and `.flags`, keyword contents, rule/case order, and configuration omissions from the current repository.

This task freezes contracts, not production static-language behavior. The pure validator and adapter deliberately throw `new Error("not implemented")`; the manager/store/registrar/bootstrap return empty or unavailable results. The report IPC cannot quarantine anything, and `markThirdPartyStaticContributions()` throws until T3 can guarantee persistence. None of the new renderer factories is wired into `app.tsx` in T0. Existing language behavior remains until T5/T6 migrate it. The API constant becomes 1.4.0 here; schema generation, SDK parity, old version-assertion updates, resource-schema construction, and behavioral conformance belong to T1. T0 is not a releasable intermediate state and does not claim those suites pass.

The resource TypeScript shapes below are frozen contracts. T1 must derive their final equivalents from exportable strict Zod schemas without changing these shapes; their semantic validator cannot accept data merely because it satisfies a TypeScript type. Runtime-wide byte/id/expanded-rule budgets remain T2's responsibility, using the counts returned by that validator.

- [ ] **Step 1: Write the failing contract tests**

Create `packages/plugin-protocol/src/static-language-contract.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import { expect, expectTypeOf, it } from "vitest";
import {
  PLUGIN_API_VERSION,
  STATIC_LANGUAGE_FORMAT_VERSION,
  STATIC_LANGUAGE_LIMITS_V1,
  pluginManifestSchema,
  validateStaticLanguageResources,
  type PluginManifest,
  type StaticRuntime,
  type StaticLanguageDecl,
  type ValidateStaticLanguageResourcesInput,
  type StaticLanguageValidationResult,
} from "./index.js";

it("freezes the public types, strict static variant and immutable v1 limits", async () => {
  expect(PLUGIN_API_VERSION).toBe("1.4.0");
  expect(STATIC_LANGUAGE_FORMAT_VERSION).toBe(1);
  expect(STATIC_LANGUAGE_LIMITS_V1).toEqual({
    patternLength: 2048,
    compiledPatternLength: 4096,
    rulesPerLanguage: 1024,
    regexesPerLanguage: 1024,
    statesPerLanguage: 64,
    resourceFileBytes: 524288,
    resourceBytesPerLanguage: 786432,
    resourceBytesPerPlugin: 1048576,
    resourceBytesTotal: 8388608,
    expandedRulesPerLanguage: 8192,
    expandedRulesTotal: 65536,
    includeDepth: 16,
    regexFlags: ["", "i"],
    listsPerLanguage: 32,
    wordsPerLanguage: 4096,
    casesPerRule: 32,
    onEnterRules: 32,
    languagesPerPlugin: 8,
    languagesTotal: 128,
    sessionLanguageIds: 256,
    maxTokenizationLineLength: 10000,
  });
  expect(Object.isFrozen(STATIC_LANGUAGE_LIMITS_V1)).toBe(true);
  expect(Object.isFrozen(STATIC_LANGUAGE_LIMITS_V1.regexFlags)).toBe(true);
  expectTypeOf<StaticRuntime>().toEqualTypeOf<{ kind: "static" }>();
  expectTypeOf<NonNullable<PluginManifest["contributes"]>["languages"]>().toEqualTypeOf<
    StaticLanguageDecl[] | undefined
  >();
  expectTypeOf(validateStaticLanguageResources).toEqualTypeOf<
    (input: ValidateStaticLanguageResourcesInput) => StaticLanguageValidationResult
  >();
  const fixture: unknown = JSON.parse(
    await readFile(
      new URL("../test-fixtures/static-languages/toy/kobrixa-plugin.json", import.meta.url),
      "utf8",
    ),
  );
  const manifest = pluginManifestSchema.parse(fixture);
  expect(manifest.runtime).toEqual({ kind: "static" });
  expect(manifest.contributes?.languages?.[0]?.id).toBe("toy");
  expect(
    pluginManifestSchema.safeParse({
      ...manifest,
      runtime: { kind: "static", entry: "main.js" },
    }).success,
  ).toBe(false);
});
```

Create `packages/plugin-runtime/src/static-language-contract.test.ts`:

```ts
import { expect, expectTypeOf, it, vi } from "vitest";
import {
  PluginManager,
  emptyStaticLanguagesCatalog,
  type PluginProblem,
  type PluginSource,
  type PluginsSnapshot,
  type StaticLanguagesCatalog,
  type StaticLanguageOwner,
  type ReportLanguageRegistrationFailureInput,
  type ReportLanguageRegistrationFailureResult,
} from "./index.js";

it("provides detached empty catalogs and mandatory owner snapshot fields without launching", async () => {
  expectTypeOf<PluginManager["staticLanguages"]>().toEqualTypeOf<() => StaticLanguagesCatalog>();
  expectTypeOf<PluginManager["staticLanguagesRevision"]>().toEqualTypeOf<number>();
  expectTypeOf<PluginsSnapshot["staticLanguageOwners"]>().toEqualTypeOf<StaticLanguageOwner[]>();
  expectTypeOf<PluginManager["reportLanguageRegistrationFailure"]>().toEqualTypeOf<
    (input: ReportLanguageRegistrationFailureInput) => ReportLanguageRegistrationFailureResult
  >();
  const source: PluginSource = { kind: "builtin", manifest: {}, resources: {} };
  expect(source.resources).toEqual({});
  const problem: PluginProblem = {
    code: "PLUGIN_E_STATIC_LANGUAGE_REGISTRATION",
    message: "acme.toy could not register toy.",
    detail: { languageId: "toy", allowed: 256, actual: 257 },
  };
  expect(problem.detail?.languageId).toBe("toy");
  const launcher = vi.fn();
  const manager = await PluginManager.create({
    sources: [],
    safeMode: false,
    locale: "en",
    launcher,
    store: {
      load: async () => ({ disabled: new Set<string>(), legacyDisabledIds: new Set<string>() }),
      save: async () => {},
    },
  });
  expect(manager.staticLanguages()).toEqual(
    emptyStaticLanguagesCatalog(manager.staticLanguagesRevision),
  );
  expect(manager.state().staticLanguagesRevision).toBe(manager.staticLanguagesRevision);
  expect(manager.state().staticLanguageOwners).toEqual([]);
  const first = manager.staticLanguages();
  first.extensionRoutes.toy = "toy";
  expect(manager.staticLanguages().extensionRoutes).toEqual({});
  expect(launcher).not.toHaveBeenCalled();
  await manager.shutdown();
});
```

Create `apps/desktop/src/shared/static-languages.test.ts`:

```ts
import { expect, expectTypeOf, it } from "vitest";
import type { PluginsApi, PluginEvent } from "./plugins.js";
import type {
  StaticLanguagesCatalog,
  ReportLanguageRegistrationFailureInput,
  ReportLanguageRegistrationFailureResult,
} from "./static-languages.js";
import type { SessionMarker, SessionMarkerFile } from "../main/plugins/session.js";
import type {
  StaticLanguageStore,
  StaticLanguageStoreApi,
  createStaticLanguageStore,
} from "../renderer/editor/static-language-store.js";
import type {
  StaticLanguageRegistrar,
  CreateStaticLanguageRegistrarInput,
  createStaticLanguageRegistrar,
} from "../renderer/editor/static-language-registration.js";
import type {
  LexicalLanguageRoute,
  ResolveLexicalLanguageInput,
  resolveLexicalLanguage,
} from "../renderer/editor/static-language-routing.js";
import type {
  StaticLanguageBootstrapInput,
  StaticLanguageBootstrapResult,
  bootstrapStaticLanguages,
} from "../renderer/editor/static-language-bootstrap.js";
import type { EditorThemeApi, initializeEditorThemes } from "../renderer/editor/editor-theme.js";
import type { ModelLanguageRoute } from "../renderer/editor/model-language-route.js";

it("uses the same DTO and exact signatures across preload, bootstrap and renderer", () => {
  expectTypeOf<PluginsApi["staticLanguages"]>().toEqualTypeOf<
    () => Promise<StaticLanguagesCatalog>
  >();
  expectTypeOf<PluginsApi["reportLanguageRegistrationFailure"]>().toEqualTypeOf<
    (
      input: ReportLanguageRegistrationFailureInput,
    ) => Promise<ReportLanguageRegistrationFailureResult>
  >();
  expectTypeOf<
    Extract<PluginEvent, { type: "state" }>["state"]["staticLanguagesRevision"]
  >().toEqualTypeOf<number>();
  expectTypeOf<SessionMarker["thirdPartyStaticContributions"]>().toEqualTypeOf<boolean>();
  expectTypeOf<SessionMarkerFile["markThirdPartyStaticContributions"]>().toEqualTypeOf<
    () => void
  >();
  expectTypeOf<typeof createStaticLanguageStore>().toEqualTypeOf<
    (api: StaticLanguageStoreApi) => StaticLanguageStore
  >();
  expectTypeOf<typeof createStaticLanguageRegistrar>().toEqualTypeOf<
    (input: CreateStaticLanguageRegistrarInput) => StaticLanguageRegistrar
  >();
  expectTypeOf<typeof resolveLexicalLanguage>().toEqualTypeOf<
    (input: ResolveLexicalLanguageInput) => LexicalLanguageRoute
  >();
  expectTypeOf<typeof bootstrapStaticLanguages>().toEqualTypeOf<
    (input: StaticLanguageBootstrapInput) => Promise<StaticLanguageBootstrapResult>
  >();
  expectTypeOf<typeof initializeEditorThemes>().toEqualTypeOf<(api: EditorThemeApi) => void>();
  expectTypeOf<ModelLanguageRoute>().toExtend<LexicalLanguageRoute>();
  expect(true).toBe(true);
});
```

These tests pin the public contract and the empty-host case, so they remain valid after implementation replaces the stubs. The desktop test imports renderer signatures with `import type`, which prevents a contract test from evaluating Monaco or a renderer module in Node.

- [ ] **Step 2: Run the contract test and confirm the missing-export failure**

Run:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol exec vitest run src/static-language-contract.test.ts
```

Expected: FAIL because `STATIC_LANGUAGE_FORMAT_VERSION` / `STATIC_LANGUAGE_LIMITS_V1` and the new contract exports do not exist yet; no plugin code runs. Do not run the three-package build until all scaffold and required fixture compatibility edits below are written.

- [ ] **Step 3: Write the protocol contract and fail-closed validator stubs**

Create `packages/plugin-protocol/src/static-language-limits.ts`:

```ts
export const STATIC_LANGUAGE_FORMAT_VERSION = 1 as const;
export const STATIC_LANGUAGE_LIMITS_V1 = Object.freeze({
  patternLength: 2048,
  compiledPatternLength: 4096,
  rulesPerLanguage: 1024,
  regexesPerLanguage: 1024,
  statesPerLanguage: 64,
  resourceFileBytes: 524288,
  resourceBytesPerLanguage: 786432,
  resourceBytesPerPlugin: 1048576,
  resourceBytesTotal: 8388608,
  expandedRulesPerLanguage: 8192,
  expandedRulesTotal: 65536,
  includeDepth: 16,
  regexFlags: Object.freeze(["", "i"] as const),
  listsPerLanguage: 32,
  wordsPerLanguage: 4096,
  casesPerRule: 32,
  onEnterRules: 32,
  languagesPerPlugin: 8,
  languagesTotal: 128,
  sessionLanguageIds: 256,
  maxTokenizationLineLength: 10000,
} as const);
```

Create `packages/plugin-protocol/src/static-languages.ts`:

```ts
export type RegexData = { pattern: string; flags: "" | "i" };
export type Pair = { open: string; close: string };
export type TokenAction = {
  token: string;
  next?: string;
  bracket?: "@open" | "@close";
};
export type Action = TokenAction | { cases: { when: string; action: TokenAction }[] };
export type Rule = { regex: RegexData; action: Action } | { include: string };
export type StaticLanguageTokenizerV1 = {
  ignoreCase: boolean;
  defaultToken?: string;
  tokenPostfix?: string;
  lists?: { name: string; words: string[] }[];
  brackets?: (Pair & { token: string })[];
  states: { name: string; rules: Rule[] }[];
};
export type StaticLanguageConfigurationV1 = {
  comments?: { lineComment?: string; blockComment?: Pair };
  brackets?: Pair[];
  autoClosingPairs?: (Pair & { notIn?: ("string" | "comment" | "regex")[] })[];
  surroundingPairs?: Pair[];
  indentationRules?: {
    increaseIndentPattern: RegexData;
    decreaseIndentPattern: RegexData;
    indentNextLinePattern?: RegexData;
    unIndentedLinePattern?: RegexData;
  };
  onEnterRules?: {
    beforeText: RegexData;
    afterText?: RegexData;
    previousLineText?: RegexData;
    action: {
      indentAction: "none" | "indent" | "indentOutdent" | "outdent";
      appendText?: string;
      removeText?: number;
    };
  }[];
  wordPattern?: RegexData;
};
export type StaticLanguageResourceBytes = { tokenizer: number; configuration: number };
export type StaticLanguageResourceProblemDetail = {
  languageId: string;
  resourcePath?: string;
  fieldPath?: string;
  limit?: string;
  allowed?: number | readonly string[];
  actual?: number | string;
};
export type StaticLanguageValidationProblem = {
  message: string;
  detail: StaticLanguageResourceProblemDetail;
};
export type ValidateStaticLanguageResourcesInput = {
  languageId: string;
  formatVersion: number;
  limitsVersion: number;
  tokenizer: unknown;
  configuration: unknown;
  /** Original UTF-8 byte counts, including any BOM; never stringify-derived. */
  resourceBytes: StaticLanguageResourceBytes;
  /** Main supplies relative manifest paths. Renderer DTOs omit them. */
  resourcePaths?: { tokenizer: string; configuration: string };
};
export type StaticLanguageValidationResult =
  | {
      ok: true;
      tokenizer: StaticLanguageTokenizerV1;
      configuration: StaticLanguageConfigurationV1;
      resourceBytes: StaticLanguageResourceBytes;
      expandedRules: number;
      rules: number;
      regexes: number;
    }
  | { ok: false; problems: StaticLanguageValidationProblem[] };

/** T0 contract stub. T1 supplies strict schemas and the pure AST/reference validator. */
export function validateStaticLanguageResources(
  input: ValidateStaticLanguageResourcesInput,
): StaticLanguageValidationResult {
  void input;
  throw new Error("not implemented");
}
```

Apply this exact patch from the repository root:

```diff
--- a/packages/plugin-protocol/src/manifest.ts
+++ b/packages/plugin-protocol/src/manifest.ts
@@ -14,7 +14,10 @@
   .min(1)
   .max(512)
   .regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/);
+export const staticRuntimeSchema = z.strictObject({ kind: z.literal("static") });
+export type StaticRuntime = z.infer<typeof staticRuntimeSchema>;
 const runtimeSchema = z.discriminatedUnion("kind", [
+  staticRuntimeSchema,
   z.looseObject({ kind: z.literal("builtin") }),
   z.looseObject({ kind: z.literal("node"), entry: relativePath }),
   z.looseObject({ kind: z.literal("python"), entry: relativePath }),
@@ -69,6 +72,25 @@
 });
 export type LanguageServiceDecl = z.infer<typeof languageServiceDeclSchema>;
 
+export const staticLanguageResourceDeclSchema = z.strictObject({
+  version: z.literal(1),
+  path: diagnosticHelpDeclSchema.shape.path,
+});
+export type StaticLanguageResourceDecl = z.infer<typeof staticLanguageResourceDeclSchema>;
+export const staticLanguageDeclSchema = z.strictObject({
+  id: compilerIdSchema,
+  extensions: z.array(extensionSchema).min(1).max(16),
+  // Unicode regex quantifiers count code points; no Zod UTF-16 length check here.
+  aliases: z
+    .array(z.string().regex(/^[^\p{Cc}\u2028\u2029]{1,80}$/u))
+    .min(1)
+    .max(8)
+    .optional(),
+  tokenizer: staticLanguageResourceDeclSchema,
+  configuration: staticLanguageResourceDeclSchema,
+});
+export type StaticLanguageDecl = z.infer<typeof staticLanguageDeclSchema>;
+
 export type FrontendDecl = z.infer<typeof frontendDeclSchema>;
 export type BackendDecl = z.infer<typeof backendDeclSchema>;
 export type ArtifactDecl = z.infer<typeof artifactDeclSchema>;
@@ -103,6 +125,7 @@
       backends: z.array(backendDeclSchema).max(8).optional(),
       diagnosticHelp: diagnosticHelpDeclSchema.optional(),
       languageServices: z.array(languageServiceDeclSchema).max(8).optional(),
+      languages: z.array(staticLanguageDeclSchema).max(8).optional(),
     })
     .optional(),
 });
@@ -159,3 +182,9 @@
   }
   return problems;
 }
+
+/** Called only after source restrictions; T1 supplies cross-field/static-runtime semantics. */
+export function staticLanguageDeclarationProblems(manifest: PluginManifest): string[] {
+  void manifest;
+  throw new Error("not implemented");
+}
--- a/packages/plugin-protocol/src/limits.ts
+++ b/packages/plugin-protocol/src/limits.ts
@@ -1,4 +1,4 @@
-export const PLUGIN_API_VERSION = "1.3.0";
+export const PLUGIN_API_VERSION = "1.4.0";
 export const PLUGIN_LIMITS = {
   messageBytes: 1024 * 1024,
   headerBytes: 1024,
--- a/packages/plugin-protocol/src/index.ts
+++ b/packages/plugin-protocol/src/index.ts
@@ -9,3 +9,5 @@
 export * from "./json-schema.js";
 export * from "./peer.js";
 export * from "./memory-channel.js";
+export * from "./static-language-limits.js";
+export * from "./static-languages.js";
```

`PluginManifest` continues to be inferred from `pluginManifestSchema`: `runtime` includes the strict static branch, and `contributes.languages` is `StaticLanguageDecl[] | undefined`. Existing node/python/builtin variants retain their loose-object behavior. T1 supplies uniqueness, static-runtime prohibited-field/nonempty-contribution rules, same-owner extension-set checks, strict resource schemas, AST/reference checks, and public schema/SDK parity. T2 must apply source restrictions before calling the declaration semantic function, preserving `PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN` even for an empty third-party service array.

- [ ] **Step 4: Write runtime catalog, errors, source, manager and compatible source fixtures**

Create `packages/plugin-runtime/src/static-languages.ts`:

```ts
import type {
  StaticLanguageConfigurationV1,
  StaticLanguageResourceBytes,
  StaticLanguageResourceProblemDetail,
  StaticLanguageTokenizerV1,
} from "@kobrixa/plugin-protocol";

export type StaticLanguageSourceIdentity = {
  pluginId: string;
  sourceKey: string;
  languageId: string;
};
export type StaticLanguageProblemDetail = StaticLanguageResourceProblemDetail & {
  conflictingSources?: StaticLanguageSourceIdentity[];
};
export type StaticLanguageOwner = StaticLanguageSourceIdentity & {
  generation: number;
  extensions: string[];
};
export type ValidatedStaticLanguage = {
  sourceKey: string;
  pluginId: string;
  generation: number;
  id: string;
  extensions: string[];
  aliases: string[];
  resourceDigest: string;
  tokenizer: StaticLanguageTokenizerV1;
  configuration: StaticLanguageConfigurationV1;
  resourceBytes: StaticLanguageResourceBytes;
  expandedRules: number;
};
export type StaticLanguageConflict = {
  kind: "reserved-id" | "reserved-extension" | "frontend-owner" | "id" | "extension";
  key: string;
  sources: StaticLanguageSourceIdentity[];
};
export type StaticLanguagesCatalog = {
  formatVersion: 1;
  limitsVersion: 1;
  revision: number;
  languages: ValidatedStaticLanguage[];
  extensionRoutes: Record<string, string | null>;
  conflicts: StaticLanguageConflict[];
};
export type StaticLanguageRegistrationFailureReason =
  "dto-version" | "validation" | "adapter" | "monaco" | "session-language-ids";
export type ReportLanguageRegistrationFailureInput = {
  sourceKey: string;
  generation: number;
  languageId: string;
  revision: number;
  reason: StaticLanguageRegistrationFailureReason;
  /** At most 2,048 Unicode code points; no physical paths. */
  detail: string;
};
export type ReportLanguageRegistrationFailureResult = {
  accepted: boolean;
  revision: number;
};

export function emptyStaticLanguagesCatalog(revision = 0): StaticLanguagesCatalog {
  return {
    formatVersion: 1,
    limitsVersion: 1,
    revision,
    languages: [],
    extensionRoutes: {},
    conflicts: [],
  };
}
```

Apply this exact patch from the repository root:

```diff
--- a/packages/plugin-runtime/src/errors.ts
+++ b/packages/plugin-runtime/src/errors.ts
@@ -1,8 +1,13 @@
+import type { StaticLanguageProblemDetail } from "./static-languages.js";
+
 export const PLUGIN_ERROR_CODES = [
   "PLUGIN_E_MANIFEST",
   "PLUGIN_E_API_VERSION",
   "PLUGIN_E_RESERVED_ID",
   "PLUGIN_E_DIAGNOSTIC_HELP",
+  "PLUGIN_E_STATIC_LANGUAGE",
+  "PLUGIN_E_STATIC_LANGUAGE_CONFLICT",
+  "PLUGIN_E_STATIC_LANGUAGE_REGISTRATION",
   "PLUGIN_E_DUPLICATE_ID",
   "PLUGIN_E_COMMAND_NAMESPACE",
   "PLUGIN_E_DUPLICATE_COMMAND",
@@ -40,6 +45,7 @@
 export interface PluginProblem {
   code: PluginErrorCode;
   message: string;
+  detail?: StaticLanguageProblemDetail;
   providerKey?: `language:${string}` | `target:${string}`;
 }
 export class PluginError extends Error {
--- a/packages/plugin-runtime/src/registry.ts
+++ b/packages/plugin-runtime/src/registry.ts
@@ -21,7 +21,8 @@
 /** Bound on reading one development folder, so a hung disk cannot block startup or recovery. */
 export const SOURCE_READ_TIMEOUT_MS = 5_000;
 export type PluginSource =
-  { kind: "builtin"; manifest: unknown } | { kind: "development"; directory: string };
+  | { kind: "builtin"; manifest: unknown; resources: Readonly<Record<string, string>> }
+  | { kind: "development"; directory: string };
 export type DevelopmentSource = Extract<PluginSource, { kind: "development" }>;
 /** `builtin:<manifest id>` or `dev:` plus 16 hex digits; safe to accept from the renderer. */
 export const sourceKeySchema = z
@@ -173,7 +174,8 @@
   }
   const plugin = { ...checkManifest(value, "development", fallback), directory: root };
   const runtime = plugin.manifest?.runtime;
-  if (plugin.problems.length || !runtime || runtime.kind === "builtin") return plugin;
+  if (plugin.problems.length || !runtime || runtime.kind === "builtin" || runtime.kind === "static")
+    return plugin;
   try {
     const entry = await realpath(path.resolve(root, runtime.entry));
     const relative = path.relative(root, entry);
--- a/packages/plugin-runtime/src/manager.ts
+++ b/packages/plugin-runtime/src/manager.ts
@@ -1,3 +1,10 @@
+import {
+  emptyStaticLanguagesCatalog,
+  type StaticLanguageOwner,
+  type StaticLanguagesCatalog,
+  type ReportLanguageRegistrationFailureInput,
+  type ReportLanguageRegistrationFailureResult,
+} from "./static-languages.js";
 import path from "node:path";
 import {
   DIAGNOSTIC_HELP_LIMITS,
@@ -60,7 +67,7 @@
   source: "builtin" | "development";
   directory?: string;
   version?: string;
-  runtime?: "builtin" | "node" | "python";
+  runtime?: "builtin" | "node" | "python" | "static";
   displayName?: LocalizedText;
   status: "enabled" | "disabled" | "invalid" | "failed";
   disabledBy?: "user" | "safe-mode";
@@ -73,6 +80,8 @@
   revision: number;
   /** Revision of the currently published diagnostic help catalog. */
   diagnosticHelpRevision: number;
+  staticLanguagesRevision: number;
+  staticLanguageOwners: StaticLanguageOwner[];
   safeMode: boolean;
   developmentMode: boolean;
   /** The settings file was corrupt or unreadable; cleared by the next successful save. */
@@ -209,11 +218,28 @@
     return {
       revision: this.#revision,
       diagnosticHelpRevision: this.#help.revision,
+      staticLanguagesRevision: this.staticLanguagesRevision,
+      staticLanguageOwners: [],
       safeMode: this.#safeMode,
       developmentMode: this.#entries.some((entry) => entry.read.source === "development"),
       ...(this.#stateProblem ? { stateProblem: this.#stateProblem } : {}),
       plugins: this.#entries.map((entry) => this.#summary(entry)),
     };
+  }
+
+  get staticLanguagesRevision(): number {
+    return 0;
+  }
+
+  staticLanguages(): StaticLanguagesCatalog {
+    return emptyStaticLanguagesCatalog(this.staticLanguagesRevision);
+  }
+
+  reportLanguageRegistrationFailure(
+    input: ReportLanguageRegistrationFailureInput,
+  ): ReportLanguageRegistrationFailureResult {
+    void input;
+    return { accepted: false, revision: this.staticLanguagesRevision };
   }
 
   diagnosticHelp(): DiagnosticHelpCatalog {
@@ -596,7 +622,13 @@
   #register(entry: Entry): void {
     const { plugin } = entry;
     const manifest = plugin.manifest;
-    if (!manifest || manifest.runtime.kind === "builtin" || !plugin.entry || !plugin.directory)
+    if (
+      !manifest ||
+      manifest.runtime.kind === "builtin" ||
+      manifest.runtime.kind === "static" ||
+      !plugin.entry ||
+      !plugin.directory
+    )
       return;
     const { sourceKey } = plugin;
     const generation = entry.generation;
--- a/packages/plugin-runtime/src/index.ts
+++ b/packages/plugin-runtime/src/index.ts
@@ -5,3 +5,4 @@
 export * from "./process.js";
 export * from "./supervisor.js";
 export * from "./manager.js";
+export * from "./static-languages.js";
```

`PluginProblem.detail` is optional for existing problem codes. T2 must populate `detail.languageId` for all three new codes and fill the resource/field/limit/conflict members required by §5.3; neither a generic compiler `providerKey` nor a plugin-authored owner is a substitute. The report result's `accepted: false` means a well-formed stale/duplicate/noncurrent report has no effect; malformed or unauthorized IPC is rejected by T3. T0's handler always returns that no-effect result.

The required `resources` field belongs to the host-only builtin source, not `manifest.runtime`. Apply the following mechanical additions to existing builtin providers and fixtures; the empty map is correct for sources that declare no static resources. T6 replaces Basic Plus's empty map with `?raw` resources in its own worktree.

Apply this exact patch from the repository root:

```diff
--- a/packages/plugin-runtime/src/language-service-conformance.test.ts
+++ b/packages/plugin-runtime/src/language-service-conformance.test.ts
@@ -17,7 +17,7 @@
     await writeFile(path.join(root, "main.js"), "");
     const read = await readSource(
       item.registry!.source === "builtin"
-        ? { kind: "builtin", manifest: item.value }
+        ? { kind: "builtin", resources: {}, manifest: item.value }
         : { kind: "development", directory: root },
       { safeMode: false },
     );
--- a/packages/plugin-runtime/src/manager.test.ts
+++ b/packages/plugin-runtime/src/manager.test.ts
@@ -46,6 +46,7 @@
 }
 const builtin = {
   kind: "builtin" as const,
+  resources: {},
   manifest: {
     id: "kobrixa.basic-plus",
     version: "1.0.0",
@@ -65,6 +66,7 @@
 };
 const builtinBackend = {
   kind: "builtin" as const,
+  resources: {},
   manifest: {
     id: "test.back",
     version: "1.0.0",
@@ -133,7 +135,7 @@
         ],
       },
     };
-    const manager = await create([{ kind: "builtin", manifest }]);
+    const manager = await create([{ kind: "builtin", resources: {}, manifest }]);
     try {
       expect(await manager.setEnabled("builtin:kobrixa.basic-plus", false)).toMatchObject({
         ok: false,
--- a/packages/plugin-runtime/src/registry.test.ts
+++ b/packages/plugin-runtime/src/registry.test.ts
@@ -29,6 +29,7 @@
 }
 const builtin = {
   kind: "builtin" as const,
+  resources: {},
   manifest: {
     id: "kobrixa.basic-plus",
     version: "1.0.0",
@@ -71,6 +72,7 @@
       readSource(
         {
           kind: "builtin",
+          resources: {},
           manifest: {
             id: "test.language",
             version: "1.0.0",
@@ -307,6 +309,7 @@
       readSource(
         {
           kind: "builtin",
+          resources: {},
           manifest: manifest({ runtime: { kind: "builtin" }, activationEvents: [], contributes }),
         },
         { safeMode: false },
@@ -409,8 +412,8 @@
     expect(results[1]!.problems[0]!.code).toBe("PLUGIN_E_DUPLICATE_ID");
   });
   it("throws on an invalid built-in manifest", async () => {
-    await expect(loadPlugins([{ kind: "builtin", manifest: { id: "x" } }], none)).rejects.toThrow(
-      /built-in/i,
-    );
+    await expect(
+      loadPlugins([{ kind: "builtin", resources: {}, manifest: { id: "x" } }], none),
+    ).rejects.toThrow(/built-in/i);
   });
 });
--- a/packages/plugin-runtime/src/compiler-resolution.test.ts
+++ b/packages/plugin-runtime/src/compiler-resolution.test.ts
@@ -19,6 +19,7 @@
 const back = { target: "test-vm", ir: { min: 2, max: 4 }, capabilities: {}, artifacts: [] };
 const source = (id: string, contributes: unknown): PluginSource => ({
   kind: "builtin",
+  resources: {},
   manifest: {
     id,
     version: "1.0.0",
@@ -249,6 +250,7 @@
   const item = await readSource(
     {
       kind: "builtin",
+      resources: {},
       manifest: {
         id: "test.old",
         version: "1.0.0",
--- a/apps/desktop/src/main/plugins/builtin.ts
+++ b/apps/desktop/src/main/plugins/builtin.ts
@@ -4,6 +4,6 @@
 
 /** Built-in manifests are bundled and validated by the same registry as development plugins. */
 export const BUILTIN_PLUGIN_SOURCES: readonly PluginSource[] = [
-  { kind: "builtin", manifest: basicPlus },
-  { kind: "builtin", manifest: ev3 },
+  { kind: "builtin", resources: {}, manifest: basicPlus },
+  { kind: "builtin", resources: {}, manifest: ev3 },
 ];
--- a/apps/desktop/src/main/workspace/compiler-chain.test.ts
+++ b/apps/desktop/src/main/workspace/compiler-chain.test.ts
@@ -20,6 +20,7 @@
   let service: BuildService | undefined;
   const source = (id: string, contributes: unknown) => ({
     kind: "builtin" as const,
+    resources: {},
     manifest: {
       id,
       version: "1.0.0",
--- a/apps/desktop/src/main/language/language-provider.integration.test.ts
+++ b/apps/desktop/src/main/language/language-provider.integration.test.ts
@@ -44,7 +44,9 @@
 it("rejects a second-language service whose extensions differ from its frontend", async () => {
   const manifest = structuredClone(SECOND_MANIFEST);
   manifest.contributes!.languageServices![0]!.extensions = ["csx"];
-  await expect(readSource({ kind: "builtin", manifest }, { safeMode: false })).rejects.toThrow(
+  await expect(
+    readSource({ kind: "builtin", resources: {}, manifest }, { safeMode: false }),
+  ).rejects.toThrow(
     "Language services require one matching frontend with the same source extensions.",
   );
 });
@@ -53,7 +55,7 @@
   const other = { ...structuredClone(SECOND_MANIFEST), id: "test.other-case" };
   const reads = await Promise.all(
     [SECOND_MANIFEST, other].map((manifest) =>
-      readSource({ kind: "builtin", manifest }, { safeMode: false }),
+      readSource({ kind: "builtin", resources: {}, manifest }, { safeMode: false }),
     ),
   );
   expect(reads.every((read) => read.problems.length === 0)).toBe(true);
@@ -82,7 +84,7 @@
 
 it("isolates case-sensitive symbols, legends and overlapping diagnostic codes", async () => {
   const read = await readSource(
-    { kind: "builtin", manifest: SECOND_MANIFEST },
+    { kind: "builtin", resources: {}, manifest: SECOND_MANIFEST },
     { safeMode: false },
   );
   const plugins = resolvePlugins([read], { safeMode: false, disabled: new Set() });
```

- [ ] **Step 5: Write shared/preload contracts, empty IPC stubs and marker shape**

Create `apps/desktop/src/shared/static-languages.ts`:

```ts
export type {
  RegexData,
  Pair,
  TokenAction,
  Action,
  Rule,
  StaticLanguageTokenizerV1,
  StaticLanguageConfigurationV1,
  StaticLanguageResourceBytes,
  StaticLanguageResourceProblemDetail,
  StaticLanguageValidationProblem,
  ValidateStaticLanguageResourcesInput,
  StaticLanguageValidationResult,
} from "@kobrixa/plugin-protocol";
export type {
  StaticLanguageSourceIdentity,
  StaticLanguageProblemDetail,
  StaticLanguageOwner,
  ValidatedStaticLanguage,
  StaticLanguageConflict,
  StaticLanguagesCatalog,
  StaticLanguageRegistrationFailureReason,
  ReportLanguageRegistrationFailureInput,
  ReportLanguageRegistrationFailureResult,
} from "@kobrixa/plugin-runtime";
```

Apply this exact patch from the repository root:

```diff
--- a/apps/desktop/src/shared/plugins.ts
+++ b/apps/desktop/src/shared/plugins.ts
@@ -1,3 +1,17 @@
+import type {
+  StaticLanguagesCatalog,
+  ReportLanguageRegistrationFailureInput,
+  ReportLanguageRegistrationFailureResult,
+} from "./static-languages.js";
+export type {
+  StaticLanguageOwner,
+  StaticLanguageProblemDetail,
+  ValidatedStaticLanguage,
+  StaticLanguageConflict,
+  StaticLanguagesCatalog,
+  ReportLanguageRegistrationFailureInput,
+  ReportLanguageRegistrationFailureResult,
+} from "./static-languages.js";
 import type { PluginHelpCatalogView } from "./diagnostic-help.js";
 import type {
   PluginActionResult,
@@ -89,6 +103,10 @@
 export interface PluginsApi {
   state(): Promise<PluginsView>;
   diagnosticHelp(): Promise<PluginHelpCatalogView>;
+  staticLanguages(): Promise<StaticLanguagesCatalog>;
+  reportLanguageRegistrationFailure(
+    input: ReportLanguageRegistrationFailureInput,
+  ): Promise<ReportLanguageRegistrationFailureResult>;
   notices(): Promise<StoredNotice[]>;
   execute(commandId: string): Promise<PluginCommandResult>;
   cancel(sourceKey: string): Promise<void>;
--- a/apps/desktop/src/preload/index.ts
+++ b/apps/desktop/src/preload/index.ts
@@ -56,6 +56,9 @@
   plugins: {
     state: () => ipcRenderer.invoke("plugins:state"),
     diagnosticHelp: () => ipcRenderer.invoke("plugins:diagnosticHelp"),
+    staticLanguages: () => ipcRenderer.invoke("plugins:static-languages"),
+    reportLanguageRegistrationFailure: (input) =>
+      ipcRenderer.invoke("plugins:report-language-registration-failure", input),
     notices: () => ipcRenderer.invoke("plugins:notices"),
     execute: (commandId) => ipcRenderer.invoke("plugins:execute", commandId),
     cancel: (sourceKey) => ipcRenderer.invoke("plugins:cancel", sourceKey),
--- a/apps/desktop/src/main/plugins/ipc.ts
+++ b/apps/desktop/src/main/plugins/ipc.ts
@@ -1,3 +1,4 @@
+import { emptyStaticLanguagesCatalog } from "@kobrixa/plugin-runtime";
 import { z } from "zod";
 import { namespacedIdSchema } from "@kobrixa/plugin-protocol";
 import { sourceKeySchema } from "@kobrixa/plugin-runtime";
@@ -40,6 +41,14 @@
   const key = (value: unknown) => sourceKeySchema.parse(value);
   handle("plugins:state", () => plugins.state());
   handle("plugins:diagnosticHelp", () => plugins.diagnosticHelp());
+  // T0 endpoints cannot publish resources or quarantine any source.
+  handle("plugins:static-languages", () =>
+    emptyStaticLanguagesCatalog(plugins.state().staticLanguagesRevision),
+  );
+  handle("plugins:report-language-registration-failure", () => ({
+    accepted: false,
+    revision: plugins.state().staticLanguagesRevision,
+  }));
   handle("plugins:notices", () => plugins.notices());
   handle("plugins:execute", (_event, commandId: unknown) =>
     plugins.execute(namespacedIdSchema.parse(commandId)),
--- a/apps/desktop/src/main/plugins/session.ts
+++ b/apps/desktop/src/main/plugins/session.ts
@@ -7,6 +7,7 @@
 const markerSchema = z.strictObject({
   startedAt: z.iso.datetime(),
   thirdPartyRunning: z.boolean(),
+  thirdPartyStaticContributions: z.boolean().default(false),
   rendererUnresponsive: z.boolean(),
 });
 export type SessionMarker = z.infer<typeof markerSchema>;
@@ -34,12 +35,19 @@
     this.#marker = {
       startedAt: this.now().toISOString(),
       thirdPartyRunning: false,
+      thirdPartyStaticContributions: false,
       rendererUnresponsive: false,
     };
     this.#write();
     if (previous?.rendererUnresponsive) return "renderer-unresponsive";
-    if (previous?.thirdPartyRunning) return "unclean-exit";
+    if (previous?.thirdPartyRunning || previous?.thirdPartyStaticContributions)
+      return "unclean-exit";
     return undefined;
+  }
+
+  /** T3 must persist true synchronously or throw before catalog delivery. */
+  markThirdPartyStaticContributions(): void {
+    throw new Error("not implemented");
   }
 
   /** `rendererUnresponsive` is sticky for the rest of the session. */
@@ -65,7 +73,13 @@
     const marker = this.#marker;
     if (!marker || this.#finished) return;
     this.#finished = true;
-    this.#marker = { ...marker, thirdPartyRunning: false };
+    this.#marker = {
+      ...marker,
+      thirdPartyRunning: false,
+      thirdPartyStaticContributions: marker.rendererUnresponsive
+        ? marker.thirdPartyStaticContributions
+        : false,
+    };
     this.#write();
     if (marker.rendererUnresponsive) return;
     try {
--- a/apps/desktop/src/main/plugins/session.test.ts
+++ b/apps/desktop/src/main/plugins/session.test.ts
@@ -20,6 +20,7 @@
   expect(await onDisk()).toEqual({
     startedAt: "2026-10-15T00:00:00.000Z",
     thirdPartyRunning: false,
+    thirdPartyStaticContributions: false,
     rendererUnresponsive: false,
   });
   session.update({ thirdPartyRunning: true });
--- a/apps/desktop/src/main/plugins/controller.test.ts
+++ b/apps/desktop/src/main/plugins/controller.test.ts
@@ -609,6 +609,8 @@
   const snapshot: PluginsSnapshot = {
     revision: 4,
     diagnosticHelpRevision: 2,
+    staticLanguagesRevision: 0,
+    staticLanguageOwners: [],
     safeMode: false,
     developmentMode: true,
     plugins: [
--- a/apps/desktop/src/renderer/settings/plugins-panel.test.ts
+++ b/apps/desktop/src/renderer/settings/plugins-panel.test.ts
@@ -26,6 +26,8 @@
 const snapshot: PluginsView = {
   revision: 1,
   diagnosticHelpRevision: 0,
+  staticLanguagesRevision: 0,
+  staticLanguageOwners: [],
   safeMode: false,
   developmentMode: true,
   developer: { enabled: true, commandLine: false, linkedCount: 1 },
@@ -81,6 +83,17 @@
       ],
     },
   })),
+  staticLanguages: vi.fn<PluginsApi["staticLanguages"]>(async () => ({
+    formatVersion: 1,
+    limitsVersion: 1,
+    revision: 0,
+    languages: [],
+    extensionRoutes: {},
+    conflicts: [],
+  })),
+  reportLanguageRegistrationFailure: vi.fn<PluginsApi["reportLanguageRegistrationFailure"]>(
+    async () => ({ accepted: false, revision: 0 }),
+  ),
   notices: vi.fn<PluginsApi["notices"]>(async () => []),
   diagnosticHelp: vi.fn<PluginsApi["diagnosticHelp"]>(async () => ({ revision: 0, plugins: {} })),
   cancel: vi.fn<PluginsApi["cancel"]>(async () => {}),
```

The existing `plugins:event` channel and `PluginEvent = PluginsViewEvent` union remain authoritative: `{ type: "state", state: PluginsView }` now carries required `staticLanguagesRevision: number` and `staticLanguageOwners: StaticLanguageOwner[]` through `PluginsView extends PluginsSnapshot`; notice events stay unchanged. There is no second catalog event format or duplicate DTO definition. T3 replaces the two empty handlers with controller-backed methods, performs structural/sender/ownership checks, and persists the marker before any third-party delivery (including event-visible owner metadata). T0 does not add these methods to `PluginController` or `PluginManagerPort`; T3 uses the already-frozen manager signatures when extending those local ports and their local mocks.

The marker field is real, required output, with `.default(false)` only at the old-file read boundary. `markThirdPartyStaticContributions(): void` is the frozen checked-write entry point: T3 replaces its throwing body with sticky synchronous persistence, propagates write failure as `PLUGIN_E_STATE_SAVE`, and prevents delivery. A normal process-running update must not clear the static risk bit. The clean-exit edit preserves the risk when the renderer was unresponsive.

- [ ] **Step 6: Write renderer store, adapter, registrar, route, bootstrap and theme interfaces**

Create `apps/desktop/src/renderer/editor/static-language-routing.ts`:

```ts
import type { LanguageBinding } from "../../shared/language-services.js";
import type { StaticLanguageOwner, StaticLanguagesCatalog } from "../../shared/static-languages.js";

export type StaticRouteOwner = Pick<
  StaticLanguageOwner,
  "pluginId" | "sourceKey" | "generation" | "languageId"
>;
export interface LexicalLanguageRoute {
  monacoLanguage: string;
  displayName: string;
  kind: "core" | "static" | "plaintext";
  catalogRevision: number;
  staticOwner?: StaticRouteOwner;
}
export interface ResolveLexicalLanguageInput {
  file: string;
  binding?: LanguageBinding;
  catalog: StaticLanguagesCatalog;
  /** Only fully installed, non-quarantined owners may supply a route. */
  activeOwners: readonly StaticLanguageOwner[];
  /** Lowercase last extensions without dots; host-owned, e.g. { json: "json" }. */
  coreExtensionRoutes: Readonly<Record<string, string>>;
}

/** T0 deliberately exposes no plugin routes. T4 supplies the ordered resolver. */
export function resolveLexicalLanguage(input: ResolveLexicalLanguageInput): LexicalLanguageRoute {
  return {
    monacoLanguage: "plaintext",
    displayName: "Plain Text",
    kind: "plaintext",
    catalogRevision: input.catalog.revision,
  };
}
```

Create `apps/desktop/src/renderer/editor/static-language-store.ts`:

```ts
import type { PluginsApi } from "../../shared/plugins.js";
import type { StaticLanguageOwner, StaticLanguagesCatalog } from "../../shared/static-languages.js";

export interface StaticLanguageStoreSnapshot {
  phase: "loading" | "ready" | "failed";
  /** Highest observed catalog target; distinct from accepted catalog.revision. */
  targetRevision: number;
  /** Complete owner metadata for targetRevision, including ambiguous extensions. */
  owners: readonly StaticLanguageOwner[];
  catalog: StaticLanguagesCatalog;
  error?: string;
}
export interface StaticLanguageStore {
  getSnapshot(): StaticLanguageStoreSnapshot;
  subscribe(listener: () => void): () => void;
  /** Settles when the first consistent catalog arrives or the initial fetch fails. */
  ready(): Promise<void>;
  refresh(): Promise<void>;
  dispose(): void;
}
export type StaticLanguageStoreApi = Pick<PluginsApi, "state" | "staticLanguages" | "onEvent">;

/** T0 empty snapshot; no subscription or IPC side effects. */
export function createStaticLanguageStore(api: StaticLanguageStoreApi): StaticLanguageStore {
  void api;
  const snapshot: StaticLanguageStoreSnapshot = {
    phase: "failed",
    targetRevision: 0,
    owners: [],
    catalog: {
      formatVersion: 1,
      limitsVersion: 1,
      revision: 0,
      languages: [],
      extensionRoutes: {},
      conflicts: [],
    },
    error: "not implemented",
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    ready: () => Promise.resolve(),
    refresh: () => Promise.resolve(),
    dispose() {},
  };
}
```

Create `apps/desktop/src/renderer/editor/static-language-adapter.ts`:

```ts
import type { languages } from "monaco-editor";
import type { ValidatedStaticLanguage } from "../../shared/static-languages.js";

export interface MonacoStaticLanguageDefinition {
  tokenizer: languages.IMonarchLanguage;
  configuration: languages.LanguageConfiguration;
}
/** T4 validates the DTO and translates only allowlisted fields. */
export function adaptStaticLanguage(
  language: ValidatedStaticLanguage,
): MonacoStaticLanguageDefinition {
  void language;
  throw new Error("not implemented");
}
```

Create `apps/desktop/src/renderer/editor/static-language-registration.ts`:

```ts
import type { editor, languages, IDisposable } from "monaco-editor";
import type { LanguageBinding } from "../../shared/language-services.js";
import type { PluginsApi } from "../../shared/plugins.js";
import type { StaticLanguageOwner } from "../../shared/static-languages.js";
import type { LexicalLanguageRoute } from "./static-language-routing.js";
import type { StaticLanguageStore, StaticLanguageStoreSnapshot } from "./static-language-store.js";

export interface MonacoStaticLanguageApi {
  languages: {
    register(language: { id: string }): void;
    setMonarchTokensProvider(id: string, tokenizer: languages.IMonarchLanguage): IDisposable;
    setLanguageConfiguration(
      id: string,
      configuration: languages.LanguageConfiguration,
    ): IDisposable;
  };
  editor: {
    getModels(): editor.ITextModel[];
    onDidCreateModel(listener: (model: editor.ITextModel) => void): IDisposable;
    onWillDisposeModel(listener: (model: editor.ITextModel) => void): IDisposable;
    setModelLanguage(model: editor.ITextModel, languageId: string): void;
  };
}
export interface StaticModelContext {
  file: string;
  workspaceId?: string;
  binding?: LanguageBinding;
}
export interface StaticModelRouteHooks {
  /** Detach dynamic providers and clear semantic coloring before provider disposal. */
  beforeChange(previous: LexicalLanguageRoute | undefined, next: LexicalLanguageRoute): void;
  afterChange(route: LexicalLanguageRoute): void;
}
export interface StaticLanguageRegistrar {
  /** Consumes owner revocations immediately, even if catalog.revision is still older. */
  reconcile(snapshot: StaticLanguageStoreSnapshot): void;
  /** Idempotent tracking; disposal releases context/hooks, never destroys the model. */
  trackModel(
    model: editor.ITextModel,
    context: () => StaticModelContext,
    hooks?: StaticModelRouteHooks,
  ): IDisposable;
  refreshModels(): void;
  resolve(context: StaticModelContext): LexicalLanguageRoute;
  getRoute(model: editor.ITextModel): LexicalLanguageRoute | undefined;
  getActiveOwners(): readonly StaticLanguageOwner[];
  subscribe(listener: () => void): () => void;
  dispose(): void;
}
export interface CreateStaticLanguageRegistrarInput {
  monaco: MonacoStaticLanguageApi;
  store: StaticLanguageStore;
  api: Pick<PluginsApi, "reportLanguageRegistrationFailure">;
  coreExtensionRoutes: Readonly<Record<string, string>>;
}
/** One per window. T0 installs no providers and does not touch models. */
export function createStaticLanguageRegistrar(
  input: CreateStaticLanguageRegistrarInput,
): StaticLanguageRegistrar {
  const emptyRoute = (): LexicalLanguageRoute => ({
    monacoLanguage: "plaintext",
    displayName: "Plain Text",
    kind: "plaintext",
    catalogRevision: input.store.getSnapshot().targetRevision,
  });
  return {
    reconcile() {},
    trackModel: () => ({ dispose() {} }),
    refreshModels() {},
    resolve: emptyRoute,
    getRoute: () => undefined,
    getActiveOwners: () => [],
    subscribe: () => () => {},
    dispose() {},
  };
}
```

Create `apps/desktop/src/renderer/editor/model-language-route.ts`:

```ts
import type { LanguageBinding } from "../../shared/language-services.js";
import type { LanguageCompanion } from "./language-companion.js";
import type { LexicalLanguageRoute } from "./static-language-routing.js";

/** T5 makes language-routing.ts re-export this type when migrating its existing consumers. */
export interface ModelLanguageRoute extends LexicalLanguageRoute {
  binding?: LanguageBinding;
  companion?: LanguageCompanion;
}
/** Identity retained by replaceModelRoute; lexical revision never replaces binding epoch. */
export interface AttachedModelLanguageRoute<T> {
  model: T;
  file: string;
  workspaceId: string | undefined;
  route: ModelLanguageRoute;
  dispose(): void;
}
```

Create `apps/desktop/src/renderer/editor/static-language-bootstrap.ts`:

```ts
import type { StaticLanguageRegistrar } from "./static-language-registration.js";
import type { StaticLanguageStore } from "./static-language-store.js";

export interface StaticLanguageBootstrapInput {
  store: StaticLanguageStore;
  registrar: StaticLanguageRegistrar;
  /** Defaults to 5,000; test clocks may shorten it, production cannot raise it. */
  timeoutMs?: number;
}
export type StaticLanguageBootstrapResult =
  | { kind: "ready"; revision: number }
  | { kind: "plaintext"; reason: "ipc" | "timeout"; message: string };

/** app.tsx shares this barrier with every entry point that can create document models. */
export function bootstrapStaticLanguages(
  input: StaticLanguageBootstrapInput,
): Promise<StaticLanguageBootstrapResult> {
  void input;
  return Promise.resolve({ kind: "plaintext", reason: "ipc", message: "not implemented" });
}
```

Create `apps/desktop/src/renderer/editor/editor-theme.ts`:

```ts
import type { editor } from "monaco-editor";

export interface EditorThemeApi {
  defineTheme(name: string, data: editor.IStandaloneThemeData): void;
}
/** T6 defines kobrixa-light and kobrixa-dark independently of grammar availability. */
export function initializeEditorThemes(api: EditorThemeApi): void {
  void api;
}
```

The final `resolveLexicalLanguage()` is pure: core extension route first; applicable binding only to the same plugin/source/language; then a unique own-property global extension route; otherwise plain text. Both catalog ownership and `activeOwners` must match before returning `kind: "static"`. `staticOwner` carries generation, and `catalogRevision` is always present, including fallback. `displayName` is the first alias/id for static languages; T5 localizes core JSON/Plain Text according to `kind` and id rather than persisting a label or inferring Basic Plus.

T4's registrar owns window-wide `getModels()`/create/dispose subscriptions, registers each id once, and tracks models even before an editor supplies project context. `trackModel()` enriches that tracking with current file/workspace/binding getters and dynamic detach/reattach hooks; releasing its handle does not destroy a hidden or diff model. `refreshModels()` handles rename, workspace/binding changes, and reopen. `reconcile()` immediately processes owner metadata even when `catalog.revision < targetRevision`; only fully validated/installed owners can become active. Provider installation uses an explicit allowlist conversion, never arbitrary object spread into Monaco.

T5 replaces the legacy `ModelLanguageRoute` declaration in `language-routing.ts` with a type re-export from `model-language-route.ts` while migrating its callers in the same task. It composes `binding`/`companion` under the original workspace, URI, owner and epoch guards; lexical fallback alone does not mark the service unavailable. `AttachedModelLanguageRoute<T>.route` retains the lexical id, owner/source/generation and catalog revision so the replacement comparison cannot accidentally use only file and binding epoch. The old routing implementation is intentionally not called by the new stub resolver.

T5 owns the bootstrap implementation and its window lifetime. It creates/reuses one store and registrar, calls `initializeEditorThemes(monaco.editor)` independently of grammar, awaits `bootstrapStaticLanguages({ store, registrar })` before `workspace.restoreSession()`, and applies the same promise to other model-creation entry points. Its implementation bounds only IPC waiting at 5,000 ms, releases to empty plugin routes on failure, and permits later reconciliation. StrictMode effect replay must not create a second manager or dispose a still-live one. Every editor/diff options construction or update keeps `maxTokenizationLineLength: 10000` after spreads.

- [ ] **Step 7: Write the complete shared JSON fixtures**

All seven files are UTF-8 with a trailing LF and no BOM. Test-specific BOM/invalid/over-budget cases are derived copies in the test owner's write set. Raw byte expectations must read the files rather than hardcode JSON-stringification sizes. These are resources and a plugin manifest, not Monaco objects; regex flags are explicit and resource JSON bodies do not repeat `version`.

Create `packages/plugin-protocol/test-fixtures/static-languages/minimal/tokenizer.json`:

```json
{
  "ignoreCase": false,
  "states": [
    {
      "name": "root",
      "rules": [
        {
          "regex": {
            "pattern": ".",
            "flags": ""
          },
          "action": {
            "token": "identifier"
          }
        }
      ]
    }
  ]
}
```

Create `packages/plugin-protocol/test-fixtures/static-languages/minimal/configuration.json`:

```json
{}
```

Create `packages/plugin-protocol/test-fixtures/static-languages/basic-plus/tokenizer.json`:

```json
{
  "ignoreCase": true,
  "tokenPostfix": ".basic-plus",
  "defaultToken": "invalid",
  "lists": [
    {
      "name": "keywords",
      "words": [
        "And",
        "Break",
        "Continue",
        "Dim",
        "Else",
        "ElseIf",
        "EndFor",
        "EndFunction",
        "EndIf",
        "EndModule",
        "EndRegion",
        "EndSub",
        "EndWhile",
        "False",
        "For",
        "Folder",
        "Function",
        "Goto",
        "If",
        "Include",
        "Import",
        "In",
        "Module",
        "Not",
        "Number",
        "Or",
        "Out",
        "Private",
        "Property",
        "Region",
        "Return",
        "Step",
        "String",
        "Sub",
        "Then",
        "To",
        "True",
        "While"
      ]
    },
    {
      "name": "control",
      "words": [
        "If",
        "Then",
        "Else",
        "ElseIf",
        "EndIf",
        "For",
        "To",
        "Step",
        "EndFor",
        "While",
        "EndWhile",
        "Break",
        "Continue",
        "Return",
        "Goto"
      ]
    },
    {
      "name": "types",
      "words": ["Number", "String"]
    },
    {
      "name": "booleans",
      "words": ["True", "False"]
    },
    {
      "name": "word_operators",
      "words": ["And", "Or", "Not"]
    }
  ],
  "states": [
    {
      "name": "root",
      "rules": [
        {
          "regex": {
            "pattern": "[ \\t\\r]+",
            "flags": "i"
          },
          "action": {
            "token": "white"
          }
        },
        {
          "regex": {
            "pattern": "'[^\\r\\n]*",
            "flags": "i"
          },
          "action": {
            "token": "comment"
          }
        },
        {
          "regex": {
            "pattern": "\"(?:[^\"\\r\\n]|\"\")*\"(?!\")",
            "flags": "i"
          },
          "action": {
            "token": "string"
          }
        },
        {
          "regex": {
            "pattern": "\"[^\\r\\n]*$",
            "flags": "i"
          },
          "action": {
            "token": "string.invalid"
          }
        },
        {
          "regex": {
            "pattern": "[A-Za-z_][\\w.]*",
            "flags": "i"
          },
          "action": {
            "cases": [
              {
                "when": "@types",
                "action": {
                  "token": "type"
                }
              },
              {
                "when": "@booleans",
                "action": {
                  "token": "constant.language"
                }
              },
              {
                "when": "@word_operators",
                "action": {
                  "token": "operator.word"
                }
              },
              {
                "when": "@control",
                "action": {
                  "token": "keyword.control"
                }
              },
              {
                "when": "@keywords",
                "action": {
                  "token": "keyword"
                }
              },
              {
                "when": "@default",
                "action": {
                  "token": "identifier"
                }
              }
            ]
          }
        },
        {
          "regex": {
            "pattern": "(?:\\d+\\.\\d*|\\.\\d+|\\d+)",
            "flags": "i"
          },
          "action": {
            "token": "number"
          }
        },
        {
          "regex": {
            "pattern": "!=|<=|>=|<>|\\+=|-=|\\*=|\\/=|\\+\\+|--|[=<>+\\-*/%]",
            "flags": "i"
          },
          "action": {
            "token": "operator"
          }
        },
        {
          "regex": {
            "pattern": "@",
            "flags": "i"
          },
          "action": {
            "token": "operator"
          }
        },
        {
          "regex": {
            "pattern": "[()[\\],.:]",
            "flags": "i"
          },
          "action": {
            "token": "delimiter"
          }
        }
      ]
    }
  ]
}
```

Create `packages/plugin-protocol/test-fixtures/static-languages/basic-plus/configuration.json`:

```json
{
  "comments": {
    "lineComment": "'"
  },
  "brackets": [
    {
      "open": "(",
      "close": ")"
    },
    {
      "open": "[",
      "close": "]"
    }
  ],
  "autoClosingPairs": [
    {
      "open": "(",
      "close": ")"
    },
    {
      "open": "[",
      "close": "]"
    },
    {
      "open": "\"",
      "close": "\"",
      "notIn": ["string", "comment"]
    }
  ],
  "surroundingPairs": [
    {
      "open": "(",
      "close": ")"
    },
    {
      "open": "[",
      "close": "]"
    },
    {
      "open": "\"",
      "close": "\""
    }
  ],
  "indentationRules": {
    "increaseIndentPattern": {
      "pattern": "^[\\t ]*(?:If|ElseIf|Else|While|For|Sub|Function|Module)(?![A-Za-z0-9_.])",
      "flags": "i"
    },
    "decreaseIndentPattern": {
      "pattern": "^[\\t ]*(?:ElseIf|Else|EndIf|EndWhile|EndFor|EndSub|EndFunction|EndModule)(?![A-Za-z0-9_.])",
      "flags": "i"
    }
  }
}
```

Create `packages/plugin-protocol/test-fixtures/static-languages/toy/kobrixa-plugin.json`:

```json
{
  "id": "acme.toy",
  "version": "1.0.0",
  "apiVersion": "^1.4.0",
  "displayName": "Toy static language",
  "runtime": {
    "kind": "static"
  },
  "contributes": {
    "languages": [
      {
        "id": "toy",
        "extensions": ["toy"],
        "aliases": ["Toy"],
        "tokenizer": {
          "version": 1,
          "path": "language/tokenizer.json"
        },
        "configuration": {
          "version": 1,
          "path": "language/configuration.json"
        }
      }
    ]
  }
}
```

Create `packages/plugin-protocol/test-fixtures/static-languages/toy/language/tokenizer.json`:

```json
{
  "ignoreCase": false,
  "defaultToken": "invalid",
  "states": [
    {
      "name": "root",
      "rules": [
        {
          "regex": {
            "pattern": "[ \\t]+",
            "flags": ""
          },
          "action": {
            "token": "white"
          }
        },
        {
          "regex": {
            "pattern": "[A-Za-z_][A-Za-z0-9_]*",
            "flags": ""
          },
          "action": {
            "token": "identifier"
          }
        },
        {
          "regex": {
            "pattern": "[0-9]+",
            "flags": ""
          },
          "action": {
            "token": "number"
          }
        }
      ]
    }
  ]
}
```

Create `packages/plugin-protocol/test-fixtures/static-languages/toy/language/configuration.json`:

```json
{}
```

The Basic Plus fixture was transcribed from `apps/desktop/src/renderer/editor/companions/basic-plus/registration.ts`, `frontends/basic-plus/src/language.ts`, and `frontends/basic-plus/src/indentation.ts`. Its root contains exactly nine rules. Cases remain types → booleans → word_operators → control → keywords → default; only the wire list name changes from `wordOperators`. There are no new `wordPattern` or `onEnterRules`. T6 uses these fixtures to author `plugins/basic-plus/language/tokenizer.json` and `plugins/basic-plus/language/configuration.json`, and owns parity tests against the original keyword/indentation exports and real Monaco token classes. T2/T7 copy `toy/` into a temporary development directory, deriving `sourceKey` with the existing `developmentSourceKey(directory)`; the fixture never supplies a host identity.

- [ ] **Step 8: Build both package dist outputs, check desktop, and run the contract tests**

Run exactly from the repository root:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol build && pnpm --filter @kobrixa/plugin-runtime build && pnpm --filter @kobrixa/desktop check
```

Expected: clean exit 0 for both TypeScript builds and the desktop typecheck, including all new strict interfaces and existing mocks. No install command is needed.

Then run:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol exec vitest run src/static-language-contract.test.ts && pnpm --filter @kobrixa/plugin-runtime exec vitest run src/static-language-contract.test.ts && pnpm --filter @kobrixa/desktop exec vitest run src/shared/static-languages.test.ts src/main/plugins/session.test.ts
```

Expected: protocol 1 test passes, runtime 1 test passes, desktop 8 tests across 2 files pass. These are T0 contract checks; they do not claim completed resource validation, IPC acceptance, Monaco integration, or API/schema/SDK parity.

- [ ] **Step 9: Have the controller commit the verified contract freeze**

The sandbox cannot write git metadata. The controller runs these commands after the checks above, before creating any T1–T7 worktree:

```bash
git add \
  packages/plugin-protocol/src/static-language-limits.ts \
  packages/plugin-protocol/src/static-languages.ts \
  packages/plugin-runtime/src/static-languages.ts \
  apps/desktop/src/shared/static-languages.ts \
  apps/desktop/src/renderer/editor/static-language-routing.ts \
  apps/desktop/src/renderer/editor/static-language-store.ts \
  apps/desktop/src/renderer/editor/static-language-adapter.ts \
  apps/desktop/src/renderer/editor/static-language-registration.ts \
  apps/desktop/src/renderer/editor/model-language-route.ts \
  apps/desktop/src/renderer/editor/static-language-bootstrap.ts \
  apps/desktop/src/renderer/editor/editor-theme.ts \
  packages/plugin-protocol/test-fixtures/static-languages/minimal/tokenizer.json \
  packages/plugin-protocol/test-fixtures/static-languages/minimal/configuration.json \
  packages/plugin-protocol/test-fixtures/static-languages/basic-plus/tokenizer.json \
  packages/plugin-protocol/test-fixtures/static-languages/basic-plus/configuration.json \
  packages/plugin-protocol/test-fixtures/static-languages/toy/kobrixa-plugin.json \
  packages/plugin-protocol/test-fixtures/static-languages/toy/language/tokenizer.json \
  packages/plugin-protocol/test-fixtures/static-languages/toy/language/configuration.json \
  packages/plugin-protocol/src/static-language-contract.test.ts \
  packages/plugin-runtime/src/static-language-contract.test.ts \
  apps/desktop/src/shared/static-languages.test.ts \
  packages/plugin-protocol/src/manifest.ts \
  packages/plugin-protocol/src/limits.ts \
  packages/plugin-protocol/src/index.ts \
  packages/plugin-runtime/src/errors.ts \
  packages/plugin-runtime/src/registry.ts \
  packages/plugin-runtime/src/manager.ts \
  packages/plugin-runtime/src/index.ts \
  packages/plugin-runtime/src/language-service-conformance.test.ts \
  packages/plugin-runtime/src/manager.test.ts \
  packages/plugin-runtime/src/registry.test.ts \
  packages/plugin-runtime/src/compiler-resolution.test.ts \
  apps/desktop/src/main/plugins/builtin.ts \
  apps/desktop/src/main/workspace/compiler-chain.test.ts \
  apps/desktop/src/main/language/language-provider.integration.test.ts \
  apps/desktop/src/shared/plugins.ts \
  apps/desktop/src/preload/index.ts \
  apps/desktop/src/main/plugins/ipc.ts \
  apps/desktop/src/main/plugins/session.ts \
  apps/desktop/src/main/plugins/session.test.ts \
  apps/desktop/src/main/plugins/controller.test.ts \
  apps/desktop/src/renderer/settings/plugins-panel.test.ts
git diff --cached --check
git commit -m "feat: freeze plugin 2c static language contracts"
git rev-parse HEAD
```

Expected: no whitespace errors; one T0 commit containing exactly the files listed above. Record the printed SHA as the branch point for all seven parallel tasks. No T0 worker retains write ownership after this commit.

**Ownership hand-off:** Every created file and every compatibility edit is listed below. “Create” means the file did not exist before T0. All entries lie inside the adjusted write sets above; shared fixtures stay read-only to all tasks except T1.

| File | T0 action | Owner after T0 |
| --- | --- | --- |
| `packages/plugin-protocol/src/static-language-limits.ts` | Create | T1 |
| `packages/plugin-protocol/src/static-languages.ts` | Create | T1 |
| `packages/plugin-runtime/src/static-languages.ts` | Create | T2 |
| `apps/desktop/src/shared/static-languages.ts` | Create | T3 |
| `apps/desktop/src/renderer/editor/static-language-routing.ts` | Create | T4 |
| `apps/desktop/src/renderer/editor/static-language-store.ts` | Create | T4 |
| `apps/desktop/src/renderer/editor/static-language-adapter.ts` | Create | T4 |
| `apps/desktop/src/renderer/editor/static-language-registration.ts` | Create | T4 |
| `apps/desktop/src/renderer/editor/model-language-route.ts` | Create | T5 |
| `apps/desktop/src/renderer/editor/static-language-bootstrap.ts` | Create | T5 |
| `apps/desktop/src/renderer/editor/editor-theme.ts` | Create | T6 |
| `packages/plugin-protocol/test-fixtures/static-languages/minimal/tokenizer.json` | Create | T1 |
| `packages/plugin-protocol/test-fixtures/static-languages/minimal/configuration.json` | Create | T1 |
| `packages/plugin-protocol/test-fixtures/static-languages/basic-plus/tokenizer.json` | Create | T1 |
| `packages/plugin-protocol/test-fixtures/static-languages/basic-plus/configuration.json` | Create | T1 |
| `packages/plugin-protocol/test-fixtures/static-languages/toy/kobrixa-plugin.json` | Create | T1 |
| `packages/plugin-protocol/test-fixtures/static-languages/toy/language/tokenizer.json` | Create | T1 |
| `packages/plugin-protocol/test-fixtures/static-languages/toy/language/configuration.json` | Create | T1 |
| `packages/plugin-protocol/src/static-language-contract.test.ts` | Create | T1 |
| `packages/plugin-runtime/src/static-language-contract.test.ts` | Create | T2 |
| `apps/desktop/src/shared/static-languages.test.ts` | Create | T3 |
| `packages/plugin-protocol/src/manifest.ts` | Modify | T1 |
| `packages/plugin-protocol/src/limits.ts` | Modify | T1 |
| `packages/plugin-protocol/src/index.ts` | Modify | T1 |
| `packages/plugin-runtime/src/errors.ts` | Modify | T2 |
| `packages/plugin-runtime/src/registry.ts` | Modify | T2 |
| `packages/plugin-runtime/src/manager.ts` | Modify | T2 |
| `packages/plugin-runtime/src/index.ts` | Modify | T2 |
| `packages/plugin-runtime/src/language-service-conformance.test.ts` | Modify | T2 |
| `packages/plugin-runtime/src/manager.test.ts` | Modify | T2 |
| `packages/plugin-runtime/src/registry.test.ts` | Modify | T2 |
| `packages/plugin-runtime/src/compiler-resolution.test.ts` | Modify | T2 |
| `apps/desktop/src/main/plugins/builtin.ts` | Modify | T6 |
| `apps/desktop/src/main/workspace/compiler-chain.test.ts` | Modify | T3 |
| `apps/desktop/src/main/language/language-provider.integration.test.ts` | Modify | T3 |
| `apps/desktop/src/shared/plugins.ts` | Modify | T3 |
| `apps/desktop/src/preload/index.ts` | Modify | T3 |
| `apps/desktop/src/main/plugins/ipc.ts` | Modify | T3 |
| `apps/desktop/src/main/plugins/session.ts` | Modify | T3 |
| `apps/desktop/src/main/plugins/session.test.ts` | Modify | T3 |
| `apps/desktop/src/main/plugins/controller.test.ts` | Modify | T3 |
| `apps/desktop/src/renderer/settings/plugins-panel.test.ts` | Modify | T5 |

## Interfaces Summary

This is the frozen cross-task surface. All paths below are full repository-relative paths. Named input/output types have complete definitions in the corresponding T0 files; no consumer invents a second DTO. Only type imports from runtime are allowed in desktop shared/renderer code.

| Owner / file | Exact public names and signatures |
| --- | --- |
| T1 — `packages/plugin-protocol/src/manifest.ts` | `staticRuntimeSchema`; `StaticRuntime = { kind: "static" }`; `staticLanguageResourceDeclSchema`; `StaticLanguageResourceDecl = { version: 1; path: string }`; `staticLanguageDeclSchema`; `StaticLanguageDecl = { id: string; extensions: string[]; aliases?: string[]; tokenizer: StaticLanguageResourceDecl; configuration: StaticLanguageResourceDecl }`; `PluginManifest.runtime` includes static and `PluginManifest.contributes?.languages?: StaticLanguageDecl[]`; `staticLanguageDeclarationProblems(manifest: PluginManifest): string[]`. |
| T1 — `packages/plugin-protocol/src/static-language-limits.ts` | `STATIC_LANGUAGE_FORMAT_VERSION: 1`; immutable `STATIC_LANGUAGE_LIMITS_V1` with every exact §4 number and readonly `regexFlags: readonly ["", "i"]`; no author overrides. |
| T1 — `packages/plugin-protocol/src/static-languages.ts` | `RegexData`, `Pair`, `TokenAction`, `Action`, `Rule`, `StaticLanguageTokenizerV1`, `StaticLanguageConfigurationV1`, `StaticLanguageResourceBytes`, `StaticLanguageResourceProblemDetail`, `StaticLanguageValidationProblem`, `ValidateStaticLanguageResourcesInput`, `StaticLanguageValidationResult`; `validateStaticLanguageResources(input: ValidateStaticLanguageResourcesInput): StaticLanguageValidationResult`. Input carries numeric format/limits versions, unknown parsed resources, original byte counts, and optional relative manifest paths; success contains typed resources, byte counts, expanded-rule/raw-rule/regex counts; failure contains `{ message, detail }[]`. |
| T1 — `packages/plugin-protocol/src/index.ts` | Re-exports the manifest, limits and static-resource modules through `@kobrixa/plugin-protocol`. `packages/plugin-protocol/src/limits.ts` exports `PLUGIN_API_VERSION = "1.4.0"`. |
| T2 — `packages/plugin-runtime/src/static-languages.ts` | `StaticLanguageSourceIdentity = { pluginId: string; sourceKey: string; languageId: string }`; `StaticLanguageOwner` adds `generation: number; extensions: string[]`; `ValidatedStaticLanguage` carries `sourceKey`, `pluginId`, `generation`, `id`, `extensions`, normalized `aliases`, `resourceDigest`, typed `tokenizer`/`configuration`, original `resourceBytes`, and `expandedRules`. |
| T2 — `packages/plugin-runtime/src/static-languages.ts` | `StaticLanguageConflict = { kind: "reserved-id" \| "reserved-extension" \| "frontend-owner" \| "id" \| "extension"; key: string; sources: StaticLanguageSourceIdentity[] }`; `StaticLanguagesCatalog = { formatVersion: 1; limitsVersion: 1; revision: number; languages: ValidatedStaticLanguage[]; extensionRoutes: Record<string, string \| null>; conflicts: StaticLanguageConflict[] }`; `emptyStaticLanguagesCatalog(revision?: number): StaticLanguagesCatalog`. Missing extension key means no mapping, null means ambiguous; lookup uses own properties. |
| T2 — `packages/plugin-runtime/src/errors.ts` and `packages/plugin-runtime/src/static-languages.ts` | `PluginProblem.detail?: StaticLanguageProblemDetail`, where `StaticLanguageProblemDetail = StaticLanguageResourceProblemDetail & { conflictingSources?: StaticLanguageSourceIdentity[] }`; new codes are `PLUGIN_E_STATIC_LANGUAGE`, `PLUGIN_E_STATIC_LANGUAGE_CONFLICT`, `PLUGIN_E_STATIC_LANGUAGE_REGISTRATION`; all new-code instances require `detail.languageId` at construction. |
| T2 — `packages/plugin-runtime/src/registry.ts` | `PluginSource = { kind: "builtin"; manifest: unknown; resources: Readonly<Record<string, string>> } \| { kind: "development"; directory: string }`. Required raw resource map; exact relative keys; empty map for a builtin with no resource declarations. |
| T2 — `packages/plugin-runtime/src/manager.ts` | `PluginManager.staticLanguages(): StaticLanguagesCatalog`; `get staticLanguagesRevision(): number`; `reportLanguageRegistrationFailure(input: ReportLanguageRegistrationFailureInput): ReportLanguageRegistrationFailureResult`; required `PluginsSnapshot.staticLanguagesRevision: number` and `PluginsSnapshot.staticLanguageOwners: StaticLanguageOwner[]`; `PluginSummary.runtime` includes `"static"`. State events carry the complete owners list even for extension-ambiguous languages. |
| T2 — `packages/plugin-runtime/src/static-languages.ts` and `packages/plugin-runtime/src/index.ts` | `ReportLanguageRegistrationFailureInput = { sourceKey: string; generation: number; languageId: string; revision: number; reason: StaticLanguageRegistrationFailureReason; detail: string }`; reasons are `"dto-version" \| "validation" \| "adapter" \| "monaco" \| "session-language-ids"`; `ReportLanguageRegistrationFailureResult = { accepted: boolean; revision: number }`. Runtime index re-exports this module through `@kobrixa/plugin-runtime`. |
| T3 — `apps/desktop/src/shared/static-languages.ts` | Type-only re-exports of the protocol resource/validator types and runtime owner/catalog/problem/report types. No runtime values, loaders or duplicate DTOs. |
| T3 — `apps/desktop/src/shared/plugins.ts` and `apps/desktop/src/preload/index.ts` | `PluginsApi.staticLanguages(): Promise<StaticLanguagesCatalog>` over `plugins:static-languages`; `PluginsApi.reportLanguageRegistrationFailure(input: ReportLanguageRegistrationFailureInput): Promise<ReportLanguageRegistrationFailureResult>` over `plugins:report-language-registration-failure`; existing `onEvent(listener: (event: PluginEvent) => void): () => void` over `plugins:event`, with `PluginEvent = { type: "state"; state: PluginsView } \| { type: "notice"; notice: StoredNotice }`. |
| T3 — `apps/desktop/src/main/plugins/ipc.ts` | Both T0 handlers use existing trusted `IpcHandle` registration. They return only an empty catalog / `{ accepted: false, revision }`; T3 supplies controller delivery and report validation. |
| T3 — `apps/desktop/src/main/plugins/session.ts` | `SessionMarker.thirdPartyStaticContributions: boolean`; old-file input defaults to false, new session starts false; `SessionMarkerFile.markThirdPartyStaticContributions(): void` must synchronously write sticky true or throw before delivery. |
| T4 — `apps/desktop/src/renderer/editor/static-language-store.ts` | `StaticLanguageStoreSnapshot = { phase: "loading" \| "ready" \| "failed"; targetRevision: number; owners: readonly StaticLanguageOwner[]; catalog: StaticLanguagesCatalog; error?: string }`; `StaticLanguageStoreApi = Pick<PluginsApi, "state" \| "staticLanguages" \| "onEvent">`; `createStaticLanguageStore(api: StaticLanguageStoreApi): StaticLanguageStore`. Store methods: `getSnapshot(): StaticLanguageStoreSnapshot`, `subscribe(listener: () => void): () => void`, `ready(): Promise<void>`, `refresh(): Promise<void>`, `dispose(): void`. |
| T4 — `apps/desktop/src/renderer/editor/static-language-adapter.ts` | `MonacoStaticLanguageDefinition = { tokenizer: languages.IMonarchLanguage; configuration: languages.LanguageConfiguration }`; `adaptStaticLanguage(language: ValidatedStaticLanguage): MonacoStaticLanguageDefinition`. |
| T4 — `apps/desktop/src/renderer/editor/static-language-routing.ts` | `StaticRouteOwner = Pick<StaticLanguageOwner, "pluginId" \| "sourceKey" \| "generation" \| "languageId">`; `LexicalLanguageRoute = { monacoLanguage: string; displayName: string; kind: "core" \| "static" \| "plaintext"; catalogRevision: number; staticOwner?: StaticRouteOwner }`; `ResolveLexicalLanguageInput = { file: string; binding?: LanguageBinding; catalog: StaticLanguagesCatalog; activeOwners: readonly StaticLanguageOwner[]; coreExtensionRoutes: Readonly<Record<string, string>> }`; `resolveLexicalLanguage(input: ResolveLexicalLanguageInput): LexicalLanguageRoute`. |
| T4 — `apps/desktop/src/renderer/editor/static-language-registration.ts` | `createStaticLanguageRegistrar(input: CreateStaticLanguageRegistrarInput): StaticLanguageRegistrar`, where input has `monaco: MonacoStaticLanguageApi`, `store: StaticLanguageStore`, `api: Pick<PluginsApi, "reportLanguageRegistrationFailure">`, and `coreExtensionRoutes: Readonly<Record<string, string>>`. |
| T4 — `apps/desktop/src/renderer/editor/static-language-registration.ts` | `MonacoStaticLanguageApi.languages.register(language: { id: string }): void`; `setMonarchTokensProvider(id: string, tokenizer: languages.IMonarchLanguage): IDisposable`; `setLanguageConfiguration(id: string, configuration: languages.LanguageConfiguration): IDisposable`; `.editor.getModels(): editor.ITextModel[]`; `onDidCreateModel(listener: (model: editor.ITextModel) => void): IDisposable`; `onWillDisposeModel(listener: (model: editor.ITextModel) => void): IDisposable`; `setModelLanguage(model: editor.ITextModel, languageId: string): void`. |
| T4 — `apps/desktop/src/renderer/editor/static-language-registration.ts` | `StaticModelContext = { file: string; workspaceId?: string; binding?: LanguageBinding }`; `StaticModelRouteHooks.beforeChange(previous: LexicalLanguageRoute \| undefined, next: LexicalLanguageRoute): void`, `.afterChange(route: LexicalLanguageRoute): void`; registrar methods `reconcile(snapshot: StaticLanguageStoreSnapshot): void`, `trackModel(model: editor.ITextModel, context: () => StaticModelContext, hooks?: StaticModelRouteHooks): IDisposable`, `refreshModels(): void`, `resolve(context: StaticModelContext): LexicalLanguageRoute`, `getRoute(model: editor.ITextModel): LexicalLanguageRoute \| undefined`, `getActiveOwners(): readonly StaticLanguageOwner[]`, `subscribe(listener: () => void): () => void`, `dispose(): void`. |
| T5 — `apps/desktop/src/renderer/editor/model-language-route.ts` | `ModelLanguageRoute extends LexicalLanguageRoute` with `binding?: LanguageBinding; companion?: LanguageCompanion`; `AttachedModelLanguageRoute<T> = { model: T; file: string; workspaceId: string \| undefined; route: ModelLanguageRoute; dispose(): void }`. T5 makes existing `language-routing.ts` re-export this type and migrates all route comparisons/consumers under its write set. |
| T5 — `apps/desktop/src/renderer/editor/static-language-bootstrap.ts` | `StaticLanguageBootstrapInput = { store: StaticLanguageStore; registrar: StaticLanguageRegistrar; timeoutMs?: number }`; `StaticLanguageBootstrapResult = { kind: "ready"; revision: number } \| { kind: "plaintext"; reason: "ipc" \| "timeout"; message: string }`; `bootstrapStaticLanguages(input: StaticLanguageBootstrapInput): Promise<StaticLanguageBootstrapResult>`. Default timeout 5,000 ms; T5 wires the single barrier into `app.tsx` and every document model entry point. |
| T6 — `apps/desktop/src/renderer/editor/editor-theme.ts` | `EditorThemeApi.defineTheme(name: string, data: editor.IStandaloneThemeData): void`; `initializeEditorThemes(api: EditorThemeApi): void`. Call with `monaco.editor`; theme setup never registers a grammar. |

Fixture paths, all owned by T1 after T0 and readable by every parallel task:

| Exact path | Contract |
| --- | --- |
| `packages/plugin-protocol/test-fixtures/static-languages/minimal/tokenizer.json` | One case-sensitive root regex `.` consuming at least one UTF-16 code unit, identifier token; valid minimal grammar. |
| `packages/plugin-protocol/test-fixtures/static-languages/minimal/configuration.json` | `{}`; Monaco default configuration is valid. |
| `packages/plugin-protocol/test-fixtures/static-languages/basic-plus/tokenizer.json` | All nine original rules, full keyword lists, original cases order, every regex flag `i`, `.basic-plus` token postfix. |
| `packages/plugin-protocol/test-fixtures/static-languages/basic-plus/configuration.json` | Original comment, bracket/closing/surrounding pairs and the two unchanged indentation regex sources/flags; no wordPattern/onEnterRules. |
| `packages/plugin-protocol/test-fixtures/static-languages/toy/kobrixa-plugin.json` | `acme.toy`, API `^1.4.0`, strict static runtime, `toy` language/extension, relative version-1 resource declarations, no executable entry. |
| `packages/plugin-protocol/test-fixtures/static-languages/toy/language/tokenizer.json` | Case-sensitive whitespace/identifier/number rules for a third-party static-only plugin. |
| `packages/plugin-protocol/test-fixtures/static-languages/toy/language/configuration.json` | `{}`; fixture root can be copied directly to a development plugin directory. |

Contract test paths are `packages/plugin-protocol/src/static-language-contract.test.ts` (T1), `packages/plugin-runtime/src/static-language-contract.test.ts` (T2), and `apps/desktop/src/shared/static-languages.test.ts` (T3). They verify the frozen surface independently of production implementations. The five Review Focus lines are mandatory test assignments for their named later tasks; those tasks add the named behavioral tests in their own TDD steps, not in another owner's worktree.
### Task 1: Protocol、純 validator 與 SDK 1.4.0

**Files:**

- Modify: `packages/plugin-protocol/src/manifest.ts:17`（T0 `staticRuntimeSchema`）、`:70`（T0 static declarations）、`:161` 之後的 T0 `staticLanguageDeclarationProblems`。
- Modify: T0 `packages/plugin-protocol/src/static-languages.ts`（以 schema 推導 resource types，替換 validator stub）。
- Create: `packages/plugin-protocol/src/static-language-schemas.ts`、`packages/plugin-protocol/src/static-language-regex.ts`、`packages/plugin-protocol/src/static-language-graph.ts`。
- Create/Test: `packages/plugin-protocol/src/static-language-manifest.test.ts`、`packages/plugin-protocol/src/static-language-schemas.test.ts`、`packages/plugin-protocol/src/static-language-regex.test.ts`、`packages/plugin-protocol/src/static-language-graph.test.ts`、`packages/plugin-protocol/src/static-languages.test.ts`。
- Modify: `packages/plugin-protocol/package.json:18`、`pnpm-lock.yaml`（只新增 protocol 的直接 parser dependency；版本使用 lockfile 已有的 `@eslint-community/regexpp@4.12.2`）。
- Modify: `packages/plugin-protocol/src/json-schema.ts:8`、`packages/plugin-protocol/src/json-schema.test.ts:27`、`packages/plugin-protocol/src/conformance.test.ts:38`、`packages/plugin-protocol/conformance/cases.json`。
- Modify: `packages/plugin-protocol/src/compiler-manifest.test.ts:31`、`packages/plugin-protocol/src/diagnostic-help.test.ts:22`、`packages/plugin-protocol/src/language-services.test.ts:23`（目前 host version 斷言）。
- Modify/generated: `packages/plugin-protocol/schema/plugin-protocol.schema.json`、`sdks/python/kobrixa/plugin-protocol.schema.json`（只由現有 `scripts/export-schema.mjs` 產生）。
- Modify: `packages/plugin-sdk-js/src/index.test.ts:20`、`sdks/python/kobrixa/_plugin.py:13`、`sdks/python/tests/test_plugin.py:100`、`sdks/python/tests/test_conformance.py:23`。
- Create/Test: `sdks/python/tests/test_static_languages.py`。

上述是本 task 的完整實際 write list，全部位於 §11.1 的 `packages/plugin-protocol/**`、`packages/plugin-sdk-js/**`、`sdks/python/**`、`pnpm-lock.yaml`。T0 的 `static-language-limits.ts`、`limits.ts`、`index.ts`、`static-language-contract.test.ts` 與七份 shared fixtures 原樣保留；T1 接手 ownership 不代表必須修改。行號是撰寫 plan 時的 2B-2 基線，套用 T0 後以同名 symbol 為 anchor。

**Interfaces:**

- Consumes: T0 `StaticRuntime`、`StaticLanguageResourceDecl`、`StaticLanguageDecl`、`PluginManifest`；`STATIC_LANGUAGE_FORMAT_VERSION = 1`、不可變的 `STATIC_LANGUAGE_LIMITS_V1`；`compilerIdSchema`、`extensionSchema`、`diagnosticHelpDeclSchema`、`SCHEMA_DEFINITIONS`、`serializeJsonSchema(): string`。
- Consumes: T0 `ValidateStaticLanguageResourcesInput = { languageId: string; formatVersion: number; limitsVersion: number; tokenizer: unknown; configuration: unknown; resourceBytes: { tokenizer: number; configuration: number }; resourcePaths?: { tokenizer: string; configuration: string } }`。
- Produces: 原名原簽章 `staticLanguageDeclarationProblems(manifest: PluginManifest): string[]`；只做來源無關語意，T2 在 source restrictions 之後呼叫。
- Produces: 原名原簽章 `validateStaticLanguageResources(input: ValidateStaticLanguageResourcesInput): StaticLanguageValidationResult`。成功仍為 `{ ok: true; tokenizer; configuration; resourceBytes; expandedRules: number; rules: number; regexes: number }`；失敗仍為 `{ ok: false; problems: { message: string; detail: StaticLanguageResourceProblemDetail }[] }`。不展開 DTO、不加入 plugin/source identity、不使用 Node／Monaco。
- Produces: T0 的 `RegexData`、`Pair`、`TokenAction`、`Action`、`Rule`、`StaticLanguageTokenizerV1`、`StaticLanguageConfigurationV1`，改從 strict Zod schemas 推導，保留欄位與 union shapes。新增 public `staticLanguageTokenizerV1Schema`、`staticLanguageConfigurationV1Schema`，經既有 `index.ts → static-languages.ts` 匯出；公開 `$defs` 名稱恰為 `static-language-tokenizer-v1`、`static-language-configuration-v1`。
- Produces: API/schema/SDK 版本 `1.4.0`；JS SDK 既有 `API_VERSION = PLUGIN_API_VERSION` 不另加常數；Python 繼續只驗證結構，不以 Python regex engine 解釋作者的 ECMAScript source。

本 task 從 controller 的 T0 commit 開始，與 T2–T7 在不同 worktree 平行。使用 T0 的 `test-fixtures/static-languages/{minimal,basic-plus,toy}`，不讀產品 Basic Plus manifest 來斷言 1.4、不需要 runtime 或 desktop 的新實作。下列每個 subsection 都有自己的 controller commit；Codex 只交付 diff，不執行 git mutations。規格依據為 §§2–5、§7.1、§10、§11.1。

#### 1.1 Manifest 的 static 語意與可攜字串限制

- [ ] **Step 1: 寫失敗測試**

建立 `packages/plugin-protocol/src/static-language-manifest.test.ts`：

```ts
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  pluginManifestSchema,
  staticLanguageDeclarationProblems,
  staticLanguageDeclSchema,
} from "./index.js";

const fixture: unknown = JSON.parse(
  await readFile(
    new URL("../test-fixtures/static-languages/toy/kobrixa-plugin.json", import.meta.url),
    "utf8",
  ),
);
const toy = pluginManifestSchema.parse(fixture);
const language = toy.contributes!.languages![0]!;
const check = (value: unknown) =>
  staticLanguageDeclarationProblems(pluginManifestSchema.parse(value));

it("accepts static languages, diagnostic-help-only and executable mixed contributions", () => {
  expect(check(toy)).toEqual([]);
  expect(
    check({ ...toy, contributes: { diagnosticHelp: { version: 1, path: "help.json" } } }),
  ).toEqual([]);
  for (const kind of ["node", "python"])
    expect(check({ ...toy, runtime: { kind, entry: "main.js", future: true } })).toEqual([]);
  expect(
    check({ ...toy, future: true, contributes: { ...toy.contributes, future: true } }),
  ).toEqual([]);
});

it("rejects every prohibited static field even when it is an empty array", () => {
  for (const key of ["activationEvents", "permissions"])
    expect(check({ ...toy, [key]: [] })).not.toEqual([]);
  for (const key of ["commands", "frontends", "backends", "languageServices"])
    expect(check({ ...toy, contributes: { ...toy.contributes, [key]: [] } })).not.toEqual([]);
  for (const contributes of [undefined, {}, { languages: [] }])
    expect(check({ ...toy, contributes })).not.toEqual([]);
  for (const runtime of [
    undefined,
    { kind: "static", entry: "main.js" },
    { kind: "static", future: true },
  ])
    expect(pluginManifestSchema.safeParse({ ...toy, runtime }).success).toBe(false);
});

it("keeps uniqueness and same-owner extension equality in semantic validation", () => {
  for (const languages of [
    [language, language],
    [{ ...language, extensions: ["toy", "toy"] }],
    [{ ...language, aliases: ["Toy", "Toy"] }],
  ])
    expect(check({ ...toy, contributes: { languages } })).not.toEqual([]);
  const frontend = {
    language: "toy",
    entryExtensions: ["toy"],
    sourceExtensions: ["inc", "toy"],
    ir: { min: 1, max: 1 },
  };
  const service = { language: "toy", extensions: ["toy", "inc"], capabilities: ["analysis"] };
  const value = {
    ...toy,
    runtime: { kind: "builtin" },
    contributes: {
      languages: [{ ...language, extensions: ["toy", "inc"] }],
      frontends: [frontend],
      languageServices: [service],
    },
  };
  expect(check(value)).toEqual([]);
  for (const field of ["frontends", "languageServices"] as const) {
    const contributes =
      field === "frontends"
        ? { ...value.contributes, frontends: [{ ...frontend, sourceExtensions: ["toy"] }] }
        : { ...value.contributes, languageServices: [{ ...service, extensions: ["toy"] }] };
    expect(check({ ...value, contributes })).not.toEqual([]);
  }
  expect(check({ ...value, contributes: { frontends: [frontend] } })).toEqual([]);
});

it("boundary manifest collections and text", () => {
  for (const count of [0, 1, 7, 8, 9]) {
    const value = {
      ...toy,
      contributes: {
        languages: Array.from({ length: count }, (_, i) => ({ ...language, id: `l${i}` })),
      },
    };
    expect(pluginManifestSchema.safeParse(value).success).toBe(count <= 8);
    if (count <= 8) expect(check(value).length === 0).toBe(count > 0);
    const aliases = Array.from({ length: count }, (_, i) => `Alias ${i}`);
    expect(staticLanguageDeclSchema.safeParse({ ...language, aliases }).success).toBe(
      count >= 1 && count <= 8,
    );
    if (count >= 1 && count <= 8)
      expect(check({ ...toy, contributes: { languages: [{ ...language, aliases }] } })).toEqual([]);
  }
  const { aliases: omittedAliases, ...withoutAliases } = language;
  void omittedAliases;
  expect(staticLanguageDeclSchema.safeParse(withoutAliases).success).toBe(true);
  for (const count of [0, 1, 79, 80, 81])
    expect(
      staticLanguageDeclSchema.safeParse({ ...language, aliases: ["😀".repeat(count)] }).success,
    ).toBe(count >= 1 && count <= 80);
  for (const count of [0, 1, 15, 16, 17]) {
    const extensions = Array.from({ length: count }, (_, i) => `e${i}`);
    expect(staticLanguageDeclSchema.safeParse({ ...language, extensions }).success).toBe(
      count >= 1 && count <= 16,
    );
    if (count >= 1 && count <= 16)
      expect(check({ ...toy, contributes: { languages: [{ ...language, extensions }] } })).toEqual(
        [],
      );
    expect(
      staticLanguageDeclSchema.safeParse({ ...language, extensions: ["a".repeat(count)] }).success,
    ).toBe(count >= 1 && count <= 16);
  }
  for (const count of [0, 1, 31, 32, 33])
    expect(staticLanguageDeclSchema.safeParse({ ...language, id: "a".repeat(count) }).success).toBe(
      count >= 1 && count <= 32,
    );
  for (const aliases of [["a\n"], ["a\u0085"], ["a\u2028"]])
    expect(staticLanguageDeclSchema.safeParse({ ...language, aliases }).success).toBe(false);
  for (const extensions of [[".toy"], ["TOY"]])
    expect(staticLanguageDeclSchema.safeParse({ ...language, extensions }).success).toBe(false);
});

it("boundary resource path grammar and versions", () => {
  for (const field of ["tokenizer", "configuration"] as const) {
    const accepts = (path: string) =>
      staticLanguageDeclSchema.safeParse({
        ...language,
        [field]: { version: 1, path },
      }).success;
    for (const count of [0, 1, 6, 7, 8])
      expect(accepts("a/".repeat(count) + "b.json")).toBe(count <= 7);
    for (const count of [0, 1, 63, 64, 65]) {
      expect(accepts("a".repeat(count) + "/b.json")).toBe(count >= 1 && count <= 64);
      expect(accepts("a".repeat(count) + ".json")).toBe(count >= 1 && count <= 64);
    }
    // Grammar maximum: seven 64-character directories + '/' + 64-character stem + '.json'.
    for (const count of [63, 64, 65]) {
      const path = ("a".repeat(64) + "/").repeat(7) + "b".repeat(count) + ".json";
      expect(path.length).toBe(460 + count);
      expect(accepts(path)).toBe(count <= 64); // 523/524 accepted; 525 rejected.
    }
    // The nominal 600-character cap is dominated by the 524-character grammar maximum.
    for (const count of [599, 600, 601])
      expect(accepts("a".repeat(count - 5) + ".json")).toBe(false);
    for (const path of [
      "",
      "../a.json",
      "/a.json",
      "a/../b.json",
      "a\\b.json",
      "https://a/b.json",
      "a.js",
    ])
      expect(accepts(path)).toBe(false);
    for (const version of [0, 1, 2])
      expect(
        staticLanguageDeclSchema.safeParse({ ...language, [field]: { version, path: "a.json" } })
          .success,
      ).toBe(version === 1);
  }
  for (const tokenizer of [
    { version: 2, path: "a.json" },
    { version: 1, path: "a.json", extra: 1 },
  ])
    expect(staticLanguageDeclSchema.safeParse({ ...language, tokenizer }).success).toBe(false);
  expect(staticLanguageDeclSchema.safeParse({ ...language, configuration: {} }).success).toBe(
    false,
  );
  expect(staticLanguageDeclSchema.safeParse({ ...language, extra: true }).success).toBe(false);
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol exec vitest run src/static-language-manifest.test.ts`

Expected: FAIL，T0 `staticLanguageDeclarationProblems()` 拋出 `not implemented`。

- [ ] **Step 3: 實作 portable text helper 與 manifest semantics**

建立 `static-language-schemas.ts`，此處先放共用文字 helper；1.2 接續追加 resource schemas。此 checkout 的 Zod 4.6.5 `min/max` 已使用 code points，測試仍釘住非 BMP 邊界。使用明確 C0/C1 範圍取代 T0 的 `\p{Cc}`；尾端 assertion 防止 JavaScript `$` 接受最後一個換行。

```ts
import { z } from "zod";

// eslint-disable-next-line no-control-regex -- wire text rejects all C0/C1 controls.
const TEXT = /^[^\u0000-\u001f\u007f-\u009f]*$(?![\r\n\u2028\u2029])/u;
// eslint-disable-next-line no-control-regex -- aliases also reject Unicode line separators.
const SINGLE_LINE_TEXT = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]*$(?![\r\n\u2028\u2029])/u;

export function staticLanguageText(minimum: number, maximum: number, singleLine = false) {
  return z
    .string()
    .min(minimum)
    .max(maximum)
    .regex(singleLine ? SINGLE_LINE_TEXT : TEXT);
}
```

在 `manifest.ts` 新增 import，以下完整區塊替換 T0 的兩個 declaration schemas（保留相鄰的同名 type exports）；不變更既有 runtime variants 的 loose 行為。resource path 繼續重用 diagnostic-help grammar，不能為了造出 600 字元的正例而放寬它：

```ts
import { staticLanguageText } from "./static-language-schemas.js";
```

```ts
export const staticLanguageResourceDeclSchema = z.strictObject({
  version: z.literal(1),
  path: diagnosticHelpDeclSchema.shape.path,
});
export const staticLanguageDeclSchema = z.strictObject({
  id: compilerIdSchema,
  extensions: z.array(extensionSchema).min(1).max(16),
  aliases: z
    .array(staticLanguageText(1, 80, true))
    .min(1)
    .max(8)
    .optional(),
  tokenizer: staticLanguageResourceDeclSchema,
  configuration: staticLanguageResourceDeclSchema,
});
```

替換 T0 的 `staticLanguageDeclarationProblems` stub：

```ts
export function staticLanguageDeclarationProblems(manifest: PluginManifest): string[] {
  const problems: string[] = [];
  const contributes = manifest.contributes;
  const languages = contributes?.languages ?? [];
  if (manifest.runtime.kind === "static") {
    for (const key of ["activationEvents", "permissions"] as const)
      if (Object.hasOwn(manifest, key)) problems.push(`Static runtime must not declare ${key}.`);
    for (const key of ["commands", "frontends", "backends", "languageServices"] as const)
      if (contributes && Object.hasOwn(contributes, key))
        problems.push(`Static runtime must not declare contributes.${key}.`);
    if (languages.length === 0 && !contributes?.diagnosticHelp)
      problems.push("Static runtime requires languages or diagnosticHelp.");
  }
  const ids = new Set<string>();
  const equal = (a: readonly string[], b: readonly string[]) => {
    const left = new Set(a);
    const right = new Set(b);
    return left.size === right.size && [...left].every((value) => right.has(value));
  };
  for (const language of languages) {
    if (ids.has(language.id)) problems.push(`Static language id ${language.id} is duplicated.`);
    ids.add(language.id);
    for (const [field, values] of [
      ["extensions", language.extensions],
      ["aliases", language.aliases ?? []],
    ] as const)
      if (new Set(values).size !== values.length)
        problems.push(`Static language ${language.id} ${field} must be unique.`);
    for (const frontend of contributes?.frontends ?? [])
      if (
        frontend.language === language.id &&
        !equal(language.extensions, frontend.sourceExtensions)
      )
        problems.push(
          `Static language ${language.id} extensions must match frontend sourceExtensions.`,
        );
    for (const service of contributes?.languageServices ?? [])
      if (service.language === language.id && !equal(language.extensions, service.extensions))
        problems.push(
          `Static language ${language.id} extensions must match language service extensions.`,
        );
  }
  return problems;
}
```

- [ ] **Step 4: 執行確認通過**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol exec vitest run src/static-language-contract.test.ts src/static-language-manifest.test.ts`

Expected: PASS。此測試不聲稱證明第三方 `languageServices` 問題碼優先序；該呼叫順序屬 T2。

- [ ] **Step 5: Controller commit**

```bash
git add packages/plugin-protocol/src/manifest.ts packages/plugin-protocol/src/static-language-schemas.ts packages/plugin-protocol/src/static-language-manifest.test.ts
git commit -m "feat(plugin-protocol): validate static language declarations"
```

#### 1.2 Strict resource schemas 與凍結型別

- [ ] **Step 1: 寫失敗測試**

建立 `static-language-schemas.test.ts`：

```ts
import { expect, it } from "vitest";
import {
  staticLanguageTokenizerV1Schema as tokenizer,
  staticLanguageConfigurationV1Schema as configuration,
} from "./static-languages.js";

const rule = { regex: { pattern: ".", flags: "" }, action: { token: "identifier" } };
const grammar = { ignoreCase: false, states: [{ name: "root", rules: [rule] }] };

it("exports strict, ordered resource shapes with no executable Monarch shortcuts", () => {
  expect(tokenizer.parse(grammar)).toEqual(grammar);
  expect(configuration.parse({})).toEqual({});
  for (const value of [
    { ...grammar, start: "other" },
    { ...grammar, unicode: true },
    { ...grammar, version: 1 },
    { ...grammar, states: [{ name: "root", rules: [[".", "identifier"]] }] },
    { ...grammar, states: [{ name: "root", rules: [{ ...rule, extra: 1 }] }] },
    {
      ...grammar,
      states: [{ name: "root", rules: [{ ...rule, action: { token: "x", goBack: 1 } }] }],
    },
    { ...grammar, states: [{ name: "root", rules: [{ ...rule, action: [{ token: "x" }] }] }] },
    {
      ...grammar,
      states: [
        {
          name: "root",
          rules: [{ ...rule, action: { cases: [{ when: "@default", action: { cases: [] } }] } }],
        },
      ],
    },
  ])
    expect(tokenizer.safeParse(value).success).toBe(false);
  for (const flags of [undefined, "g", "y", "d", "m", "s", "u", "v", "ii", "ig"])
    expect(configuration.safeParse({ wordPattern: { pattern: "x", flags } }).success).toBe(false);
  for (const value of [
    { extra: true },
    { comments: { extra: true } },
    { brackets: [{ open: "(", close: ")", extra: true }] },
    { onEnterRules: [{ beforeText: { pattern: "^", flags: "" }, action: { indentAction: 1 } }] },
  ])
    expect(configuration.safeParse(value).success).toBe(false);
});

it("bounds code points, tables, rules, states, words, cases and Enter actions", () => {
  for (const count of [16, 17])
    expect(configuration.safeParse({ comments: { lineComment: "😀".repeat(count) } }).success).toBe(
      count === 16,
    );
  for (const count of [256, 257])
    expect(
      configuration.safeParse({
        onEnterRules: [
          {
            beforeText: { pattern: "^", flags: "" },
            action: { indentAction: "indent", appendText: "😀".repeat(count), removeText: count },
          },
        ],
      }).success,
    ).toBe(count === 256);
  for (const removeText of [-1, 0.5, 257])
    expect(
      configuration.safeParse({
        onEnterRules: [
          { beforeText: { pattern: "^", flags: "" }, action: { indentAction: "none", removeText } },
        ],
      }).success,
    ).toBe(false);
  for (const [count, ok] of [
    [32, true],
    [33, false],
  ] as const)
    expect(
      configuration.safeParse({ brackets: Array(count).fill({ open: "(", close: ")" }) }).success,
    ).toBe(ok);
  for (const [count, ok] of [
    [64, true],
    [65, false],
  ] as const)
    expect(
      tokenizer.safeParse({ ...grammar, states: Array(count).fill(grammar.states[0]) }).success,
    ).toBe(ok);
  for (const pattern of ["", "x".repeat(2049), "\t", "\u0085"])
    expect(configuration.safeParse({ wordPattern: { pattern, flags: "" } }).success).toBe(false);
  expect(configuration.safeParse({ wordPattern: { pattern: "\\t", flags: "i" } }).success).toBe(
    true,
  );
  expect(
    tokenizer.safeParse({ ...grammar, lists: [{ name: "words", words: ["😀".repeat(64)] }] })
      .success,
  ).toBe(true);
  expect(
    tokenizer.safeParse({ ...grammar, lists: [{ name: "words", words: ["😀".repeat(65)] }] })
      .success,
  ).toBe(false);
  for (const token of ["@rematch", "$1", "A", "x".repeat(81)])
    expect(tokenizer.safeParse({ ...grammar, defaultToken: token }).success).toBe(false);
});

it("pins every remaining structural collection boundary at limit and limit plus one", () => {
  const enter = { beforeText: { pattern: "^", flags: "" }, action: { indentAction: "none" } };
  for (const count of [32, 33]) {
    expect(
      tokenizer.safeParse({
        ...grammar,
        lists: Array.from({ length: count }, (_, i) => ({ name: `l${i}`, words: [] })),
      }).success,
    ).toBe(count === 32);
    expect(
      tokenizer.safeParse({
        ...grammar,
        brackets: Array(count).fill({ open: "(", close: ")", token: "" }),
      }).success,
    ).toBe(count === 32);
    expect(configuration.safeParse({ onEnterRules: Array(count).fill(enter) }).success).toBe(
      count === 32,
    );
    for (const key of ["autoClosingPairs", "surroundingPairs"])
      expect(
        configuration.safeParse({ [key]: Array(count).fill({ open: "(", close: ")" }) }).success,
      ).toBe(count === 32);
    expect(
      tokenizer.safeParse({
        ...grammar,
        states: [
          {
            name: "root",
            rules: [
              {
                ...rule,
                action: { cases: Array(count).fill({ when: "@default", action: { token: "" } }) },
              },
            ],
          },
        ],
      }).success,
    ).toBe(count === 32);
  }
  for (const count of [1024, 1025])
    expect(
      tokenizer.safeParse({
        ...grammar,
        states: [{ name: "root", rules: Array(count).fill(rule) }],
      }).success,
    ).toBe(count === 1024);
  for (const count of [4096, 4097])
    expect(
      tokenizer.safeParse({
        ...grammar,
        lists: [{ name: "words", words: Array(count).fill("word") }],
      }).success,
    ).toBe(count === 4096);
  for (const count of [32, 33])
    expect(
      tokenizer.safeParse({ ...grammar, states: [{ name: "a".repeat(count), rules: [] }] }).success,
    ).toBe(count === 32);
  for (const count of [80, 81]) {
    expect(tokenizer.safeParse({ ...grammar, defaultToken: "a".repeat(count) }).success).toBe(
      count === 80,
    );
    expect(
      tokenizer.safeParse({ ...grammar, tokenPostfix: "." + "a".repeat(count - 1) }).success,
    ).toBe(count === 80);
  }
  for (const notIn of [
    ["string", "comment", "regex"],
    ["string", "comment", "regex", "string"],
  ])
    expect(
      configuration.safeParse({ autoClosingPairs: [{ open: "(", close: ")", notIn }] }).success,
    ).toBe(notIn.length === 3);
  expect(tokenizer.safeParse({ ...grammar, states: [] }).success).toBe(false);
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol exec vitest run src/static-language-schemas.test.ts`

Expected: FAIL，resource schema exports 尚未存在。

- [ ] **Step 3: 實作完整 schemas 並替換手寫 resource types**

在 `static-language-schemas.ts` 加入 import，再接續 1.1 的 helper 追加以下完整定義：

```ts
import { STATIC_LANGUAGE_LIMITS_V1 as L } from "./static-language-limits.js";

// ASCII grammars exclude controls themselves. One regex per string avoids
// emitting allOf, which the existing Python schema keyword set does not use.
const name = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9_]{0,31}$(?![\r\n\u2028\u2029])/);
const reference = z
  .string()
  .min(2)
  .max(33)
  .regex(/^@[a-z][a-z0-9_]{0,31}$(?![\r\n\u2028\u2029])/);
const literalToken = z
  .string()
  .min(0)
  .max(80)
  .regex(/^(?:[a-z][a-z0-9_.-]*)?$(?![\r\n\u2028\u2029])/);
export const regexDataSchema = z.strictObject({
  pattern: staticLanguageText(1, L.patternLength),
  flags: z.enum(L.regexFlags),
});
export const pairSchema = z.strictObject({
  open: staticLanguageText(1, 16),
  close: staticLanguageText(1, 16),
});
export const tokenActionSchema = z.strictObject({
  token: z.union([literalToken, z.literal("@brackets")]),
  next: reference.optional(),
  bracket: z.enum(["@open", "@close"]).optional(),
});
export const actionSchema = z.union([
  tokenActionSchema,
  z.strictObject({
    cases: z
      .array(
        z.strictObject({
          when: reference,
          action: tokenActionSchema,
        }),
      )
      .min(1)
      .max(L.casesPerRule),
  }),
]);
export const ruleSchema = z.union([
  z.strictObject({ regex: regexDataSchema, action: actionSchema }),
  z.strictObject({ include: reference }),
]);
export const staticLanguageTokenizerV1Schema = z.strictObject({
  ignoreCase: z.boolean(),
  defaultToken: literalToken.optional(),
  tokenPostfix: z
    .string()
    .min(2)
    .max(80)
    .regex(/^\.[a-z][a-z0-9_.-]*$(?![\r\n\u2028\u2029])/)
    .optional(),
  lists: z
    .array(
      z.strictObject({
        name,
        words: z.array(staticLanguageText(1, 64)).max(L.wordsPerLanguage),
      }),
    )
    .max(L.listsPerLanguage)
    .optional(),
  brackets: z
    .array(pairSchema.extend({ token: literalToken }))
    .max(32)
    .optional(),
  states: z
    .array(
      z.strictObject({
        name,
        rules: z.array(ruleSchema).max(L.rulesPerLanguage),
      }),
    )
    .min(1)
    .max(L.statesPerLanguage),
});
export const staticLanguageConfigurationV1Schema = z.strictObject({
  comments: z
    .strictObject({
      lineComment: staticLanguageText(1, 16).optional(),
      blockComment: pairSchema.optional(),
    })
    .optional(),
  brackets: z.array(pairSchema).max(32).optional(),
  autoClosingPairs: z
    .array(
      pairSchema.extend({
        notIn: z
          .array(z.enum(["string", "comment", "regex"]))
          .max(3)
          .optional(),
      }),
    )
    .max(32)
    .optional(),
  surroundingPairs: z.array(pairSchema).max(32).optional(),
  indentationRules: z
    .strictObject({
      increaseIndentPattern: regexDataSchema,
      decreaseIndentPattern: regexDataSchema,
      indentNextLinePattern: regexDataSchema.optional(),
      unIndentedLinePattern: regexDataSchema.optional(),
    })
    .optional(),
  onEnterRules: z
    .array(
      z.strictObject({
        beforeText: regexDataSchema,
        afterText: regexDataSchema.optional(),
        previousLineText: regexDataSchema.optional(),
        action: z.strictObject({
          indentAction: z.enum(["none", "indent", "indentOutdent", "outdent"]),
          appendText: staticLanguageText(0, 256).optional(),
          removeText: z.number().int().min(0).max(256).optional(),
        }),
      }),
    )
    .max(L.onEnterRules)
    .optional(),
  wordPattern: regexDataSchema.optional(),
});

export type RegexData = z.infer<typeof regexDataSchema>;
export type Pair = z.infer<typeof pairSchema>;
export type TokenAction = z.infer<typeof tokenActionSchema>;
export type Action = z.infer<typeof actionSchema>;
export type Rule = z.infer<typeof ruleSchema>;
export type StaticLanguageTokenizerV1 = z.infer<typeof staticLanguageTokenizerV1Schema>;
export type StaticLanguageConfigurationV1 = z.infer<typeof staticLanguageConfigurationV1Schema>;
```

在 T0 `static-languages.ts`，只將從 `export type RegexData` 到 `StaticLanguageConfigurationV1` 的手寫 types 換成以下 imports/re-exports；`StaticLanguageResourceBytes` 起的所有凍結輸入／結果／detail types 保留，validator stub 留到 1.5 替換：

```ts
import type {
  StaticLanguageTokenizerV1,
  StaticLanguageConfigurationV1,
} from "./static-language-schemas.js";
export {
  staticLanguageTokenizerV1Schema,
  staticLanguageConfigurationV1Schema,
} from "./static-language-schemas.js";
export type {
  RegexData,
  Pair,
  TokenAction,
  Action,
  Rule,
  StaticLanguageTokenizerV1,
  StaticLanguageConfigurationV1,
} from "./static-language-schemas.js";
```

- [ ] **Step 4: 執行確認通過**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol exec vitest run src/static-language-contract.test.ts src/static-language-manifest.test.ts src/static-language-schemas.test.ts`

Expected: PASS；空 configuration 合法，所有 nested objects strict。schema 不做 refine/transform，唯一性／references／合計仍交給 1.5。

- [ ] **Step 5: Controller commit**

```bash
git add packages/plugin-protocol/src/static-language-schemas.ts packages/plugin-protocol/src/static-languages.ts packages/plugin-protocol/src/static-language-schemas.test.ts
git commit -m "feat(plugin-protocol): define strict static language resource schemas"
```

#### 1.3 Browser-safe regex AST 與 adapter source 預算

- [ ] **Step 1: 寫失敗測試**

建立 `static-language-regex.test.ts`。這裡測 validator 的語法／消耗契約，不在本 worktree 執行 Monaco 或對惡劣 pattern 做 matching：

```ts
import { expect, it, vi } from "vitest";
import { checkStaticRegex } from "./static-language-regex.js";

const tokenizer = (pattern: string) => checkStaticRegex({ pattern, flags: "" }, "tokenizer", false);

it("proves consumption through alternatives, groups, assertions and minimum repetitions", () => {
  for (const pattern of [
    ".",
    "a+",
    "(?:a|bc)",
    "(?:a?b)",
    "a{1,3}",
    "(?=a)a",
    "(?!b)a",
    "^[A-Za-z]+",
    "[0-9]",
    "\\t",
    '"(?:[^"\\\\]|\\\\.)*"',
  ])
    expect(tokenizer(pattern), pattern).toBeUndefined();
  for (const pattern of [
    "^",
    "$",
    "\\b",
    "a*",
    "a?",
    "a{0,3}",
    "(?:a|)",
    "(?=a)",
    "(?:a?)(?:b*)",
    "(?:x|(?=y))",
  ])
    expect(tokenizer(pattern)?.message, pattern).toContain("consume");
  expect(checkStaticRegex({ pattern: "^", flags: "i" }, "configuration", false)).toBeUndefined();
});

it("rejects unsupported constructs even inside an assertion or zero-repeat group", () => {
  for (const pattern of [
    "(",
    "[z-a]",
    "(a)\\1",
    "(?<n>a)\\k<n>",
    "(?<=x)a",
    "(?<!x)a",
    "(?=(a)\\1)a",
    "(?:(a)\\1){0}a",
    "(?i:a)",
  ])
    expect(tokenizer(pattern), pattern).toBeDefined();
  expect(checkStaticRegex({ pattern: "(?<=x)", flags: "" }, "configuration", false)).toBeDefined();
});

it("boundary raw and compiled regex sources", () => {
  for (const pattern of ["@", "@@", "@name", "\\@", "\\$"])
    expect(tokenizer(pattern), pattern).toBeUndefined();
  for (const pattern of ["$S1", "$s2", "\\$S1", "\\$s2"])
    expect(tokenizer(pattern)?.message).toContain("substitution");
  expect(tokenizer("")).toMatchObject({ actual: 0 });
  for (const count of [1, 2047, 2048]) expect(tokenizer("a".repeat(count))).toBeUndefined();
  for (const count of [4095, 4096, 4097]) {
    const pattern = "@".repeat(2045) + "a".repeat(count - 4095);
    expect([...`^(?:${pattern.replaceAll("@", "@@")})`]).toHaveLength(count);
    expect(tokenizer(pattern) === undefined).toBe(count <= 4096);
    // Configuration normalization expands each literal U+2028 to six source characters.
    const configuration = "\u2028".repeat(682) + "a".repeat(count - 4092);
    expect([...new RegExp(configuration).source]).toHaveLength(count);
    expect(
      checkStaticRegex({ pattern: configuration, flags: "" }, "configuration", false) === undefined,
    ).toBe(count <= 4096);
  }
  expect(tokenizer("a".repeat(2049))).toMatchObject({
    limit: "STATIC_LANGUAGE_LIMITS_V1.patternLength",
    allowed: 2048,
    actual: 2049,
  });
  expect(tokenizer("@".repeat(2045) + "a")).toBeUndefined();
  expect(tokenizer("@".repeat(2046))).toMatchObject({
    limit: "STATIC_LANGUAGE_LIMITS_V1.compiledPatternLength",
    allowed: 4096,
    actual: 4097,
  });
  expect(tokenizer("😀".repeat(2048))).toBeUndefined();
  expect(tokenizer("\u2028".repeat(683))).toMatchObject({
    limit: "STATIC_LANGUAGE_LIMITS_V1.compiledPatternLength",
  });
});

it("enforces tokenizer flags but permits independent configuration flags", () => {
  expect(checkStaticRegex({ pattern: "x", flags: "i" }, "tokenizer", false)).toMatchObject({
    field: "flags",
    allowed: [""],
    actual: "i",
  });
  expect(checkStaticRegex({ pattern: "x", flags: "" }, "tokenizer", true)).toMatchObject({
    field: "flags",
    allowed: ["i"],
    actual: "",
  });
  expect(checkStaticRegex({ pattern: "x", flags: "i" }, "configuration", false)).toBeUndefined();
});

it("does not execute author patterns while checking syntax and minimum consumption", () => {
  const pattern = "(a+)+$";
  const original = RegExp.prototype.exec;
  const executed = vi.fn();
  const spy = vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (
    this: RegExp,
    text: string,
  ) {
    if (this.source === pattern || this.source === `^(?:${pattern})`) executed();
    return original.call(this, text);
  });
  try {
    expect(tokenizer(pattern)).toBeUndefined();
    expect(executed).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol exec vitest run src/static-language-regex.test.ts`

Expected: FAIL，`static-language-regex.js` 尚未存在。

- [ ] **Step 3: 加入唯一 dependency 並實作 AST 分析**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol add --save-exact @eslint-community/regexpp@4.12.2`

此為 T1 唯一 dependency mutation：檢查 diff 只增加 protocol `dependencies` 與 lockfile 對應 importer。4.12.2 已在基線 lockfile；不升級 Zod、Monaco 或其他 workspace dependencies。Parser API 已核對安裝檔 `index.d.ts` 與上游 [4.12.2 parser source](https://raw.githubusercontent.com/eslint-community/regexpp/v4.12.2/src/parser.ts)，AST node kinds 已核對 [同版本 AST source](https://raw.githubusercontent.com/eslint-community/regexpp/v4.12.2/src/ast.ts)。

建立 `static-language-regex.ts`：

```ts
import { RegExpParser, type AST } from "@eslint-community/regexpp";
import { STATIC_LANGUAGE_LIMITS_V1 as L } from "./static-language-limits.js";
import type { RegexData } from "./static-language-schemas.js";

export type StaticRegexProblem = {
  field: "pattern" | "flags";
  message: string;
  limit?: string;
  allowed?: number | readonly string[];
  actual?: number | string;
};
const parser = new RegExpParser({ ecmaVersion: 2022 });

// Saturating at one preserves exactly the proof this validator needs.
// Every child is visited, including lookahead bodies and zero-repeat operands.
function minimum(node: AST.Node): number {
  switch (node.type) {
    case "Pattern":
    case "CapturingGroup":
      return Math.min(...node.alternatives.map(minimum));
    case "Group":
      if (node.modifiers) throw new Error("Inline modifiers are unsupported.");
      return Math.min(...node.alternatives.map(minimum));
    case "Alternative":
      return Math.min(
        1,
        node.elements.map(minimum).reduce((sum, value) => sum + value, 0),
      );
    case "Quantifier": {
      const child = minimum(node.element);
      return node.min > 0 ? child : 0;
    }
    case "Assertion":
      if (node.kind === "lookbehind") throw new Error("Lookbehind is unsupported.");
      if (node.kind === "lookahead") node.alternatives.forEach(minimum);
      return 0;
    case "Character":
      return 1;
    case "CharacterSet":
      if (node.kind === "property") throw new Error("Unicode property sets are unsupported.");
      return 1;
    case "CharacterClass":
      if (node.unicodeSets) throw new Error("Unicode sets are unsupported.");
      node.elements.forEach(minimum);
      return 1;
    case "CharacterClassRange":
      minimum(node.min);
      minimum(node.max);
      return 1;
    case "Backreference":
      throw new Error("Backreferences are unsupported.");
    default:
      throw new Error(`Unsupported regex AST node: ${node.type}.`);
  }
}

export function checkStaticRegex(
  regex: RegexData,
  usage: "tokenizer" | "configuration",
  ignoreCase: boolean,
): StaticRegexProblem | undefined {
  const size = (source: string, limit: "patternLength" | "compiledPatternLength") => {
    const actual = [...source].length;
    if (actual < 1 || actual > L[limit])
      return {
        field: "pattern" as const,
        message: `STATIC_LANGUAGE_LIMITS_V1.${limit} exceeded or empty source.`,
        limit: `STATIC_LANGUAGE_LIMITS_V1.${limit}`,
        allowed: L[limit],
        actual,
      };
    return undefined;
  };
  const rawSize = size(regex.pattern, "patternLength");
  if (rawSize) return rawSize;
  const allowed = usage === "tokenizer" ? [ignoreCase ? "i" : ""] : [...L.regexFlags];
  if (!allowed.includes(regex.flags))
    return {
      field: "flags",
      message: "Regex flags do not match the declared usage.",
      limit: "STATIC_LANGUAGE_LIMITS_V1.regexFlags",
      allowed,
      actual: regex.flags,
    };
  if (/\$[Ss][0-9]/.test(regex.pattern))
    return {
      field: "pattern",
      message: "State substitution is forbidden, including escaped forms.",
    };
  try {
    const raw = parser.parsePattern(regex.pattern, 0, regex.pattern.length, false);
    const consumed = minimum(raw);
    if (usage === "tokenizer" && consumed < 1)
      return {
        field: "pattern",
        message: "Tokenizer regex must provably consume at least one unit.",
      };
    // Native compilation is syntax/source normalization only; never test/exec author regexes.
    const normalized = new RegExp(regex.pattern, regex.flags).source;
    const escaped = usage === "tokenizer" ? normalized.replace(/@/g, "@@") : normalized;
    // Monaco 0.57.0 Rule.setRegex strips one leading ^ before wrapping.
    const compiled =
      usage === "tokenizer"
        ? `^(?:${escaped.startsWith("^") ? escaped.slice(1) : escaped})`
        : escaped;
    const compiledSize = size(compiled, "compiledPatternLength");
    if (compiledSize) return compiledSize;
    if (/\$[Ss][0-9]/.test(compiled))
      return { field: "pattern", message: "State substitution is forbidden after normalization." };
    minimum(parser.parsePattern(compiled, 0, compiled.length, false));
  } catch (error) {
    return { field: "pattern", message: error instanceof Error ? error.message : "Invalid regex." };
  }
  return undefined;
}
```

`@` doubling 與 anchoring 後的長度以傳入 Monarch 的 source 保守計量；configuration 不做 doubling。T4 仍負責真正 adapter 與 literal matching parity。此 validator 不是 ReDoS 證明，也不加入 timer／Promise timeout。

- [ ] **Step 4: 執行確認通過**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol exec vitest run src/static-language-regex.test.ts`

Expected: PASS，沒有 pattern matching 壓力測試，無 Node/Monaco imports。

- [ ] **Step 5: Controller commit**

```bash
git add packages/plugin-protocol/package.json pnpm-lock.yaml packages/plugin-protocol/src/static-language-regex.ts packages/plugin-protocol/src/static-language-regex.test.ts
git commit -m "feat(plugin-protocol): validate static regex syntax and consumption"
```

#### 1.4 Include graph 的 references、深度與飽和計數

- [ ] **Step 1: 寫失敗測試**

建立 `static-language-graph.test.ts`：

```ts
import { expect, it } from "vitest";
import { inspectStaticLanguageGraph } from "./static-language-graph.js";
import type { Rule, StaticLanguageTokenizerV1 } from "./static-languages.js";

const leaf: Rule = { regex: { pattern: ".", flags: "" }, action: { token: "" } };
const grammar = (states: StaticLanguageTokenizerV1["states"]): StaticLanguageTokenizerV1 => ({
  ignoreCase: false,
  states,
});
const chain = (edges: number) =>
  grammar(
    Array.from({ length: edges + 1 }, (_, i) => ({
      name: i === 0 ? "root" : `s${i}`,
      rules: i < edges ? [{ include: `@s${i + 1}` }] : [leaf],
    })),
  );

it("checks missing references and direct, indirect and unreachable cycles", () => {
  expect(
    inspectStaticLanguageGraph(grammar([{ name: "root", rules: [{ include: "@missing" }] }])),
  ).toMatchObject({ ok: false, fieldPath: "states[0].rules[0].include" });
  for (const states of [
    [{ name: "root", rules: [{ include: "@root" }] }],
    [
      { name: "root", rules: [{ include: "@a" }] },
      { name: "a", rules: [{ include: "@root" }] },
    ],
    [
      { name: "root", rules: [leaf] },
      { name: "a", rules: [{ include: "@b" }] },
      { name: "b", rules: [{ include: "@a" }] },
    ],
  ]) {
    const result = inspectStaticLanguageGraph(grammar(states));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toMatch(/root -> root|root -> a -> root|a -> b -> a/);
  }
});

it("boundary include depth independently of DFS visitation order", () => {
  for (const edges of [0, 1, 15, 16])
    expect(inspectStaticLanguageGraph(chain(edges))).toEqual({
      ok: true,
      expandedRules: edges + 1,
    });
  expect(inspectStaticLanguageGraph(chain(17))).toMatchObject({
    ok: false,
    limit: "STATIC_LANGUAGE_LIMITS_V1.includeDepth",
    allowed: 16,
    actual: 17,
  });
  const value = chain(17);
  value.states[0]!.rules.unshift({ include: "@s17" });
  // The short edge visits the shared leaf first; the longer path must still fail.
  expect(inspectStaticLanguageGraph(value)).toMatchObject({ ok: false, actual: 17 });
  value.states.reverse();
  expect(inspectStaticLanguageGraph(value)).toMatchObject({ ok: false, actual: 17 });
});

it("boundary expanded rules with bounded raw entries", () => {
  for (const total of [0, 1, 8191, 8192, 8193]) {
    const states: StaticLanguageTokenizerV1["states"] =
      total < 2
        ? [{ name: "root", rules: Array.from({ length: total }, () => leaf) }]
        : [
            { name: "root", rules: Array.from({ length: 128 }, () => leaf) },
            ...Array.from({ length: 62 }, (_, i) => ({
              name: `s${i}`,
              rules: [{ include: "@root" }],
            })),
            { name: "tail", rules: Array.from({ length: total - 8064 }, () => leaf) },
          ];
    const result = inspectStaticLanguageGraph(grammar(states));
    if (total <= 8192) expect(result).toEqual({ ok: true, expandedRules: total });
    else expect(result).toMatchObject({ ok: false, actual: 8193 });
  }
});

it("counts repeated includes for every state before any materialization", () => {
  const rules: Rule[] = Array.from({ length: 128 }, () => leaf);
  const states = Array.from({ length: 64 }, (_, i) => ({
    name: i === 0 ? "root" : `s${i}`,
    rules: i === 0 ? rules : [{ include: "@root" }],
  }));
  expect(inspectStaticLanguageGraph(grammar(states))).toEqual({ ok: true, expandedRules: 8192 });
  states[1]!.rules.push(leaf);
  expect(inspectStaticLanguageGraph(grammar(states))).toMatchObject({
    ok: false,
    limit: "STATIC_LANGUAGE_LIMITS_V1.expandedRulesPerLanguage",
    actual: 8193,
  });
  const exponential = chain(16);
  for (const state of exponential.states.slice(0, -1)) state.rules.push(...state.rules);
  expect(inspectStaticLanguageGraph(exponential)).toMatchObject({ ok: false, actual: 8193 });
});

it("does not mistake legal next transitions for include edges", () => {
  expect(
    inspectStaticLanguageGraph(
      grammar([
        {
          name: "root",
          rules: [{ regex: { pattern: ".", flags: "" }, action: { token: "", next: "@a" } }],
        },
        {
          name: "a",
          rules: [{ regex: { pattern: ".", flags: "" }, action: { token: "", next: "@root" } }],
        },
      ]),
    ),
  ).toEqual({ ok: true, expandedRules: 2 });
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol exec vitest run src/static-language-graph.test.ts`

Expected: FAIL，graph module 尚未存在。

- [ ] **Step 3: 實作 graph inspection；不建立 expanded rule arrays**

建立 `static-language-graph.ts`：

```ts
import { STATIC_LANGUAGE_LIMITS_V1 as L } from "./static-language-limits.js";
import type { StaticLanguageTokenizerV1 } from "./static-language-schemas.js";

type GraphFailure = {
  ok: false;
  message: string;
  fieldPath: string;
  limit?: string;
  allowed?: number;
  actual?: number;
};
type GraphResult = { ok: true; expandedRules: number } | GraphFailure;

export function inspectStaticLanguageGraph(tokenizer: StaticLanguageTokenizerV1): GraphResult {
  const states = new Map(tokenizer.states.map((state, index) => [state.name, { state, index }]));
  const colors = new Map<string, "gray" | "black">();
  const order: string[] = [];
  const stack: string[] = [];
  const enteringEdges: string[] = [];
  const visit = (name: string): GraphFailure | undefined => {
    if (colors.get(name) === "black") return undefined;
    colors.set(name, "gray");
    stack.push(name);
    const { state, index } = states.get(name)!;
    for (const [ruleIndex, rule] of state.rules.entries()) {
      if (!("include" in rule)) continue;
      const target = rule.include.slice(1);
      const fieldPath = `states[${index}].rules[${ruleIndex}].include`;
      if (!states.has(target))
        return {
          ok: false,
          fieldPath,
          message: `Missing include state ${target}.`,
        };
      if (colors.get(target) === "gray")
        return {
          ok: false,
          fieldPath: enteringEdges[stack.indexOf(target)] ?? fieldPath,
          message: `Include cycle: ${[...stack.slice(stack.indexOf(target)), target].join(" -> ")}.`,
        };
      enteringEdges.push(fieldPath);
      const problem = visit(target);
      enteringEdges.pop();
      if (problem) return problem;
    }
    stack.pop();
    colors.set(name, "black");
    order.push(name);
    return undefined;
  };
  for (const name of states.keys()) {
    const problem = visit(name);
    if (problem) return problem;
  }
  // Postorder dynamic programming computes the longest suffix for every state.
  // A later, deeper incoming path cannot be hidden by the DFS black cache.
  const depth = new Map<string, number>();
  const count = new Map<string, number>();
  const saturatedAdd = (a: number, b: number) => Math.min(L.expandedRulesPerLanguage + 1, a + b);
  let expandedRules = 0;
  for (const name of order) {
    const { state, index } = states.get(name)!;
    let longest = 0;
    let expanded = 0;
    for (const [ruleIndex, rule] of state.rules.entries()) {
      if ("include" in rule) {
        const target = rule.include.slice(1);
        longest = Math.max(longest, 1 + depth.get(target)!);
        expanded = saturatedAdd(expanded, count.get(target)!);
        if (longest > L.includeDepth)
          return {
            ok: false,
            fieldPath: `states[${index}].rules[${ruleIndex}].include`,
            message: "Include depth exceeds the v1 edge limit.",
            limit: "STATIC_LANGUAGE_LIMITS_V1.includeDepth",
            allowed: L.includeDepth,
            actual: longest,
          };
      } else expanded = saturatedAdd(expanded, 1);
    }
    depth.set(name, longest);
    count.set(name, expanded);
    expandedRules = saturatedAdd(expandedRules, expanded);
  }
  if (expandedRules > L.expandedRulesPerLanguage)
    return {
      ok: false,
      fieldPath: "states",
      message: "Expanded rule budget exceeded.",
      limit: "STATIC_LANGUAGE_LIMITS_V1.expandedRulesPerLanguage",
      allowed: L.expandedRulesPerLanguage,
      actual: expandedRules,
    };
  return { ok: true, expandedRules };
}
```

Schema 與 duplicate/reserved names 檢查先於 graph helper，見 1.5。DFS 只走 include；expanded count 合計所有 states，重複 include 不去重。達 `8193` 後數字飽和，仍完成必要的 depth 計算，不配置任何 expanded rules。

- [ ] **Step 4: 執行確認通過**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol exec vitest run src/static-language-graph.test.ts`

Expected: PASS，16 edges／8192 expanded rules 接受，17／8193 拒絕。

- [ ] **Step 5: Controller commit**

```bash
git add packages/plugin-protocol/src/static-language-graph.ts packages/plugin-protocol/src/static-language-graph.test.ts
git commit -m "feat(plugin-protocol): bound static language include graphs"
```

#### 1.5 共用 validator、structured problems 與完整資源 conformance

- [ ] **Step 1: 寫 public entry point 的失敗測試**

建立 `packages/plugin-protocol/src/static-languages.test.ts`：

```ts
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import {
  staticLanguageDeclSchema,
  validateStaticLanguageResources,
  type Rule,
  type StaticLanguageTokenizerV1,
  type StaticLanguageConfigurationV1,
  type ValidateStaticLanguageResourcesInput,
} from "./index.js";
import * as regex from "./static-language-regex.js";

const leaf: Rule = { regex: { pattern: ".", flags: "" }, action: { token: "identifier" } };
const grammar = (): StaticLanguageTokenizerV1 => ({
  ignoreCase: false,
  states: [{ name: "root", rules: [structuredClone(leaf)] }],
});
const input = (
  tokenizer: unknown = grammar(),
  configuration: unknown = {},
): ValidateStaticLanguageResourcesInput => ({
  languageId: "toy",
  formatVersion: 1,
  limitsVersion: 1,
  tokenizer,
  configuration,
  resourceBytes: { tokenizer: 100, configuration: 2 },
  resourcePaths: {
    tokenizer: "language/tokenizer.json",
    configuration: "language/configuration.json",
  },
});
const validate = (tokenizer: unknown = grammar(), configuration: unknown = {}) =>
  validateStaticLanguageResources(input(tokenizer, configuration));
function failure(value: ValidateStaticLanguageResourcesInput) {
  const result = validateStaticLanguageResources(value);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected validation failure.");
  expect(result.problems.length).toBeGreaterThan(0);
  expect(result.problems[0]!.detail.languageId).toBe("toy");
  return result.problems[0]!;
}

it.each(["minimal", "basic-plus", "toy/language"])(
  "validates the frozen %s fixture",
  async (folder) => {
    const read = (name: string) =>
      readFile(
        new URL(`../test-fixtures/static-languages/${folder}/${name}.json`, import.meta.url),
      );
    const [tokenizer, configuration] = await Promise.all([
      read("tokenizer"),
      read("configuration"),
    ]);
    const result = validateStaticLanguageResources({
      ...input(JSON.parse(tokenizer.toString("utf8")), JSON.parse(configuration.toString("utf8"))),
      resourceBytes: { tokenizer: tokenizer.byteLength, configuration: configuration.byteLength },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resourceBytes).toEqual({
        tokenizer: tokenizer.byteLength,
        configuration: configuration.byteLength,
      });
      expect(result.rules).toBe(folder === "basic-plus" ? 9 : folder === "minimal" ? 1 : 3);
      expect(result.expandedRules).toBe(result.rules);
      expect(result.regexes).toBe(result.rules + (folder === "basic-plus" ? 2 : 0));
    }
  },
);

it("rejects invalid versions, original byte counts and exact byte budget overflow", () => {
  for (const field of ["formatVersion", "limitsVersion"]) failure({ ...input(), [field]: 2 });
  for (const bytes of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    failure({ ...input(), resourceBytes: { tokenizer: bytes, configuration: 2 } });
  expect(
    validateStaticLanguageResources({
      ...input(),
      resourceBytes: { tokenizer: 524288, configuration: 262144 },
    }).ok,
  ).toBe(true);
  expect(
    failure({ ...input(), resourceBytes: { tokenizer: 524289, configuration: 2 } }).detail,
  ).toMatchObject({
    resourcePath: "language/tokenizer.json",
    limit: "STATIC_LANGUAGE_LIMITS_V1.resourceFileBytes",
    allowed: 524288,
    actual: 524289,
  });
  expect(
    failure({ ...input(), resourceBytes: { tokenizer: 524288, configuration: 262145 } }).detail,
  ).toMatchObject({
    limit: "STATIC_LANGUAGE_LIMITS_V1.resourceBytesPerLanguage",
    allowed: 786432,
    actual: 786433,
  });
});

it("counts decoded code points and preserves literal macro characters", () => {
  const declaration = {
    id: "toy",
    extensions: ["toy"],
    aliases: ["😀".repeat(80)],
    tokenizer: { version: 1, path: "language/tokenizer.json" },
    configuration: { version: 1, path: "language/configuration.json" },
  };
  expect(staticLanguageDeclSchema.safeParse(declaration).success).toBe(true);
  expect(
    staticLanguageDeclSchema.safeParse({ ...declaration, aliases: ["😀".repeat(81)] }).success,
  ).toBe(false);
  for (const pattern of ["@", "@@", "@name", "\\@", "\\$", "😀".repeat(2048)]) {
    const tokenizer = grammar();
    tokenizer.states[0]!.rules = [{ regex: { pattern, flags: "" }, action: { token: "" } }];
    const result = validate(tokenizer);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tokenizer.states[0]!.rules).toEqual(tokenizer.states[0]!.rules);
  }
  for (const pattern of ["$S1", "$s1", "\\$S1", "\\$s1"])
    expect(
      failure(
        input({
          ...grammar(),
          states: [
            { name: "root", rules: [{ regex: { pattern, flags: "" }, action: { token: "" } }] },
          ],
        }),
      ).detail,
    ).toMatchObject({
      resourcePath: "language/tokenizer.json",
      fieldPath: "states[0].rules[0].regex.pattern",
    });
});

it("rejects duplicate/reserved names, missing root and all invalid action references", () => {
  for (const name of ["pop", "popall", "push", "constructor", "prototype", "__proto__"])
    expect(validate({ ...grammar(), states: [...grammar().states, { name, rules: [] }] }).ok).toBe(
      false,
    );
  expect(validate({ ...grammar(), states: [{ name: "other", rules: [] }] }).ok).toBe(false);
  expect(validate({ ...grammar(), states: [...grammar().states, ...grammar().states] }).ok).toBe(
    false,
  );
  for (const name of ["default", "eos", "constructor", "prototype", "__proto__"])
    expect(validate({ ...grammar(), lists: [{ name, words: [] }] }).ok).toBe(false);
  expect(
    validate({
      ...grammar(),
      lists: [
        { name: "words", words: [] },
        { name: "words", words: [] },
      ],
    }).ok,
  ).toBe(false);
  for (const next of ["@missing", "@push", "@root.child", "$1", "@$S2"])
    expect(
      validate({
        ...grammar(),
        states: [
          {
            name: "root",
            rules: [{ regex: { pattern: ".", flags: "" }, action: { token: "", next } }],
          },
        ],
      }).ok,
    ).toBe(false);
  for (const next of ["@root", "@pop", "@popall"])
    expect(
      validate({
        ...grammar(),
        states: [
          {
            name: "root",
            rules: [{ regex: { pattern: ".", flags: "" }, action: { token: "", next } }],
          },
        ],
      }).ok,
    ).toBe(true);
  for (const cases of [
    [],
    ["@words"],
    ["@default", "@eos"],
    ["@eos", "@eos", "@default"],
    ["@missing", "@default"],
    ["~x", "@default"],
  ])
    expect(
      validate({
        ...grammar(),
        states: [
          {
            name: "root",
            rules: [
              {
                regex: { pattern: ".", flags: "" },
                action: { cases: cases.map((when) => ({ when, action: { token: "" } })) },
              },
            ],
          },
        ],
      }).ok,
    ).toBe(false);
});

it("checks keyword folding, ordered cases, brackets and notIn without mutating resources", () => {
  const tokenizer = grammar();
  tokenizer.lists = [{ name: "words", words: ["If", "if"] }];
  tokenizer.states[0]!.rules = [
    {
      regex: { pattern: ".", flags: "" },
      action: {
        cases: [
          { when: "@words", action: { token: "keyword" } },
          { when: "@eos", action: { token: "" } },
          { when: "@default", action: { token: "identifier" } },
        ],
      },
    },
  ];
  expect(validate(tokenizer).ok).toBe(true);
  tokenizer.ignoreCase = true;
  expect(validate(tokenizer).ok).toBe(false);
  tokenizer.lists[0]!.words = ["if"];
  (tokenizer.states[0]!.rules[0] as Extract<Rule, { regex: unknown }>).regex.flags = "i";
  tokenizer.lists.push({ name: "second", words: ["IF"] });
  const before = structuredClone(tokenizer);
  expect(validate(tokenizer).ok).toBe(true);
  expect(tokenizer).toEqual(before);
  const brackets = grammar();
  brackets.states[0]!.rules = [
    { regex: { pattern: ".", flags: "" }, action: { token: "@brackets" } },
  ];
  expect(validate(brackets).ok).toBe(false);
  brackets.brackets = [{ open: "(", close: ")", token: "delimiter" }];
  expect(validate(brackets).ok).toBe(true);
  brackets.states[0]!.rules = [
    { regex: { pattern: ".", flags: "" }, action: { token: "@brackets", bracket: "@open" } },
  ];
  expect(validate(brackets).ok).toBe(false);
  expect(
    validate(grammar(), {
      autoClosingPairs: [{ open: '"', close: '"', notIn: ["string", "string"] }],
    }).ok,
  ).toBe(false);
});

it("counts raw rules, all regex occurrences and words before AST parsing", () => {
  const tokenizer = grammar();
  tokenizer.states[0]!.rules = Array.from({ length: 1020 }, () => leaf);
  const data = { pattern: "^", flags: "" as const };
  const configuration: StaticLanguageConfigurationV1 = {
    indentationRules: {
      increaseIndentPattern: data,
      decreaseIndentPattern: data,
      indentNextLinePattern: data,
      unIndentedLinePattern: data,
    },
  };
  const accepted = validate(tokenizer, configuration);
  expect(accepted).toMatchObject({ ok: true, rules: 1020, regexes: 1024 });
  const ast = vi.spyOn(regex, "checkStaticRegex");
  try {
    expect(failure(input(tokenizer, { ...configuration, wordPattern: data })).detail).toMatchObject(
      { limit: "STATIC_LANGUAGE_LIMITS_V1.regexesPerLanguage", actual: 1025 },
    );
    expect(ast).not.toHaveBeenCalled();
    const tooManyRules = grammar();
    tooManyRules.states.push({
      name: "second",
      rules: Array.from({ length: 1024 }, () => ({ include: "@root" })),
    });
    expect(failure(input(tooManyRules)).detail).toMatchObject({
      limit: "STATIC_LANGUAGE_LIMITS_V1.rulesPerLanguage",
      actual: 1025,
    });
    expect(ast).not.toHaveBeenCalled();
    const words = Array.from({ length: 4096 }, (_, i) => `w${i}`);
    const tooManyWords = {
      ...grammar(),
      lists: [
        { name: "a", words },
        { name: "b", words: ["last"] },
      ],
    };
    expect(failure(input(tooManyWords)).detail).toMatchObject({
      limit: "STATIC_LANGUAGE_LIMITS_V1.wordsPerLanguage",
      actual: 4097,
    });
    expect(ast).not.toHaveBeenCalled();
    expect(validate({ ...grammar(), lists: [{ name: "a", words }] }).ok).toBe(true);
  } finally {
    ast.mockRestore();
  }
  expect(
    validate(grammar(), {
      ...configuration,
      wordPattern: data,
      onEnterRules: [
        {
          beforeText: data,
          afterText: data,
          previousLineText: data,
          action: { indentAction: "none" },
        },
      ],
    }),
  ).toMatchObject({ ok: true, regexes: 9 });
});

it("boundary semantic totals and byte counters", () => {
  for (const count of [0, 1, 1023, 1024, 1025]) {
    const rules = Array.from({ length: count }, () => leaf);
    const value = {
      ...grammar(),
      states: [
        { name: "root", rules: rules.slice(0, 512) },
        { name: "unused", rules: rules.slice(512) },
      ],
    };
    const result = validate(value);
    expect(result.ok).toBe(count <= 1024);
    if (result.ok)
      expect(result).toMatchObject({ rules: count, regexes: count, expandedRules: count });
    // Configuration supplies the last occurrence without exceeding the raw-rule cap.
    const regexOnly = {
      ...grammar(),
      states: [{ name: "root", rules: rules.slice(0, Math.max(0, count - 1)) }],
    };
    const regexResult = validate(
      regexOnly,
      count === 0 ? {} : { wordPattern: { pattern: "^", flags: "" } },
    );
    expect(regexResult.ok).toBe(count <= 1024);
    if (regexResult.ok) expect(regexResult.regexes).toBe(count);
    else
      expect(regexResult.problems[0]!.detail).toMatchObject({
        limit: "STATIC_LANGUAGE_LIMITS_V1.regexesPerLanguage",
        actual: 1025,
      });
  }
  for (const count of [0, 1, 4095, 4096, 4097]) {
    const words = Array.from({ length: count }, (_, i) => `w${i}`);
    expect(
      validate({
        ...grammar(),
        lists: [
          { name: "a", words: words.slice(0, 2048) },
          { name: "b", words: words.slice(2048) },
        ],
      }).ok,
    ).toBe(count <= 4096);
  }
  for (const count of [0, 1, 31, 32, 33]) {
    const names = Array.from({ length: Math.max(0, count - 1) }, (_, i) => `l${i}`);
    const value = {
      ...grammar(),
      lists: names.map((name) => ({ name, words: [name] })),
      states: [
        {
          name: "root",
          rules: [
            {
              regex: { pattern: ".", flags: "" },
              action: {
                cases: (count === 0 ? [] : [...names.map((name) => `@${name}`), "@default"]).map(
                  (when) => ({ when, action: { token: "" } }),
                ),
              },
            },
          ],
        },
      ],
    };
    expect(validate(value).ok).toBe(count >= 1 && count <= 32);
  }
  for (const field of ["tokenizer", "configuration"] as const)
    for (const count of [0, 1, 524287, 524288, 524289]) {
      const value = input();
      value.resourceBytes[field] = count;
      expect(validateStaticLanguageResources(value).ok).toBe(count <= 524288);
    }
  for (const count of [786431, 786432, 786433])
    expect(
      validateStaticLanguageResources({
        ...input(),
        resourceBytes: {
          tokenizer: 524288,
          configuration: count - 524288,
        },
      }).ok,
    ).toBe(count <= 786432);
  // Zero is a legal nonnegative counter at this pure API; empty bytes are not valid JSON at the reader.
  expect(
    validateStaticLanguageResources({
      ...input(),
      resourceBytes: { tokenizer: 0, configuration: 0 },
    }).ok,
  ).toBe(true);
  for (const field of ["formatVersion", "limitsVersion"] as const)
    for (const version of [0, 1, 2])
      expect(validateStaticLanguageResources({ ...input(), [field]: version }).ok).toBe(
        version === 1,
      );
});

it("returns precise structural, flags and graph problems and retains unexpanded includes", () => {
  expect(
    failure(input(grammar(), { wordPattern: { pattern: "x".repeat(2049), flags: "" } })).detail,
  ).toMatchObject({
    resourcePath: "language/configuration.json",
    fieldPath: "wordPattern.pattern",
    limit: "STATIC_LANGUAGE_LIMITS_V1.patternLength",
    allowed: 2048,
    actual: 2049,
  });
  expect(
    failure(input(grammar(), { wordPattern: { pattern: "x", flags: "g" } })).detail,
  ).toMatchObject({ fieldPath: "wordPattern.flags", allowed: ["", "i"], actual: "g" });
  const tokenizer = grammar();
  tokenizer.states.push({ name: "unused", rules: [{ include: "@unused" }] });
  const cycle = failure(input(tokenizer));
  expect(cycle.detail.fieldPath).toBe("states[1].rules[0].include");
  expect(cycle.message).toContain("unused -> unused");
  tokenizer.states[1]!.rules = [{ include: "@root" }, { include: "@root" }];
  const result = validate(tokenizer);
  expect(result).toMatchObject({ ok: true, rules: 3, regexes: 1, expandedRules: 3 });
  if (result.ok) expect(result.tokenizer).toEqual(tokenizer);
  const noPaths = input({ ...grammar(), extra: true });
  delete noPaths.resourcePaths;
  expect(failure(noPaths).detail).not.toHaveProperty("resourcePath");
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol exec vitest run src/static-languages.test.ts`

Expected: FAIL，T0 public validator 還是 `not implemented`。

- [ ] **Step 3: 串接結構、合計、references、graph 與 regex**

在 `static-languages.ts` 保留 1.2 re-exports 及所有 T0 DTO types，將頂端 type-only schema import 擴充為下列 imports，再以下列完整函式取代 stub。helper 都在本檔，不新增跨 task 依賴：

```ts
import type { z } from "zod";
import { compilerIdSchema } from "./manifest.js";
import {
  STATIC_LANGUAGE_FORMAT_VERSION,
  STATIC_LANGUAGE_LIMITS_V1 as L,
} from "./static-language-limits.js";
import { inspectStaticLanguageGraph } from "./static-language-graph.js";
import { checkStaticRegex } from "./static-language-regex.js";
import {
  staticLanguageTokenizerV1Schema,
  staticLanguageConfigurationV1Schema,
  type RegexData,
  type TokenAction,
  type StaticLanguageTokenizerV1,
  type StaticLanguageConfigurationV1,
} from "./static-language-schemas.js";

type Resource = "tokenizer" | "configuration";
type Detail = Omit<StaticLanguageResourceProblemDetail, "languageId" | "resourcePath">;
const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);
const pathText = (path: readonly PropertyKey[]) =>
  path.reduce<string>(
    (text, part) =>
      typeof part === "number" ? `${text}[${part}]` : `${text}${text ? "." : ""}${String(part)}`,
    "",
  );

export function validateStaticLanguageResources(
  input: ValidateStaticLanguageResourcesInput,
): StaticLanguageValidationResult {
  const fail = (
    resource: Resource,
    message: string,
    detail: Detail = {},
  ): StaticLanguageValidationResult => {
    const resourcePath = input.resourcePaths?.[resource];
    return {
      ok: false,
      problems: [
        {
          message: `${input.languageId} / ${resourcePath ?? resource} / ${detail.fieldPath ?? "$"}: ${message}`,
          detail: {
            languageId: input.languageId,
            ...(resourcePath === undefined ? {} : { resourcePath }),
            ...detail,
          },
        },
      ],
    };
  };
  const limit = (resource: Resource, name: keyof typeof L, actual: number, fieldPath: string) =>
    fail(resource, `STATIC_LANGUAGE_LIMITS_V1.${name} exceeded.`, {
      fieldPath,
      limit: `STATIC_LANGUAGE_LIMITS_V1.${name}`,
      allowed: L[name],
      actual,
    });
  if (!compilerIdSchema.safeParse(input.languageId).success)
    return fail("tokenizer", "Invalid language id.", { fieldPath: "languageId" });
  for (const field of ["formatVersion", "limitsVersion"] as const)
    if (input[field] !== STATIC_LANGUAGE_FORMAT_VERSION)
      return fail("tokenizer", "Unsupported static language version.", {
        fieldPath: field,
        allowed: STATIC_LANGUAGE_FORMAT_VERSION,
        actual: input[field],
      });
  for (const resource of ["tokenizer", "configuration"] as const) {
    const bytes = input.resourceBytes[resource];
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      return fail(resource, "Original byte count must be a nonnegative safe integer.", {
        fieldPath: `resourceBytes.${resource}`,
      });
    if (bytes > L.resourceFileBytes)
      return limit(resource, "resourceFileBytes", bytes, `resourceBytes.${resource}`);
  }
  const totalBytes = input.resourceBytes.tokenizer + input.resourceBytes.configuration;
  if (totalBytes > L.resourceBytesPerLanguage)
    return limit("tokenizer", "resourceBytesPerLanguage", totalBytes, "resourceBytes");

  const structuralFailure = (
    resource: Resource,
    error: z.ZodError,
  ): StaticLanguageValidationResult => {
    let issue = error.issues[0]!;
    while (issue.code === "invalid_union" && issue.errors[0]?.[0]) issue = issue.errors[0][0];
    const fieldPath = pathText(issue.path);
    let value: unknown = input[resource];
    for (const key of issue.path) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) {
        value = undefined;
        break;
      }
      value = (value as Record<PropertyKey, unknown>)[key];
    }
    const names: Record<string, keyof typeof L> = {
      pattern: "patternLength",
      states: "statesPerLanguage",
      rules: "rulesPerLanguage",
      lists: "listsPerLanguage",
      words: "wordsPerLanguage",
      cases: "casesPerRule",
      onEnterRules: "onEnterRules",
    };
    const key = String(issue.path.at(-1));
    const name = Object.hasOwn(names, key) ? names[key] : undefined;
    if (issue.code === "too_big" || issue.code === "too_small") {
      const allowed = Number(issue.code === "too_big" ? issue.maximum : issue.minimum);
      const actual =
        typeof value === "string"
          ? [...value].length
          : Array.isArray(value)
            ? value.length
            : typeof value === "number"
              ? value
              : 0;
      return fail(resource, issue.message, {
        fieldPath,
        limit: name ? `STATIC_LANGUAGE_LIMITS_V1.${name}` : `static-language-v1.${fieldPath}`,
        allowed,
        actual,
      });
    }
    if (key === "flags" && typeof value === "string")
      return fail(resource, issue.message, {
        fieldPath,
        limit: "STATIC_LANGUAGE_LIMITS_V1.regexFlags",
        allowed: L.regexFlags,
        actual: value,
      });
    return fail(resource, issue.message, { fieldPath });
  };
  const parsedTokenizer = staticLanguageTokenizerV1Schema.safeParse(input.tokenizer);
  if (!parsedTokenizer.success) return structuralFailure("tokenizer", parsedTokenizer.error);
  const parsedConfiguration = staticLanguageConfigurationV1Schema.safeParse(input.configuration);
  if (!parsedConfiguration.success)
    return structuralFailure("configuration", parsedConfiguration.error);
  const tokenizer = parsedTokenizer.data;
  const configuration = parsedConfiguration.data;
  const rules = tokenizer.states.reduce((total, state) => total + state.rules.length, 0);
  if (rules > L.rulesPerLanguage) return limit("tokenizer", "rulesPerLanguage", rules, "states");
  const words = (tokenizer.lists ?? []).reduce((total, list) => total + list.words.length, 0);
  if (words > L.wordsPerLanguage) return limit("tokenizer", "wordsPerLanguage", words, "lists");

  const regexes: { data: RegexData; resource: Resource; fieldPath: string }[] = [];
  for (const [i, state] of tokenizer.states.entries())
    for (const [j, rule] of state.rules.entries())
      if ("regex" in rule)
        regexes.push({
          data: rule.regex,
          resource: "tokenizer",
          fieldPath: `states[${i}].rules[${j}].regex`,
        });
  for (const [key, data] of Object.entries(configuration.indentationRules ?? {}))
    if (data)
      regexes.push({ data, resource: "configuration", fieldPath: `indentationRules.${key}` });
  for (const [i, rule] of (configuration.onEnterRules ?? []).entries())
    for (const key of ["beforeText", "afterText", "previousLineText"] as const)
      if (rule[key])
        regexes.push({
          data: rule[key],
          resource: "configuration",
          fieldPath: `onEnterRules[${i}].${key}`,
        });
  if (configuration.wordPattern)
    regexes.push({
      data: configuration.wordPattern,
      resource: "configuration",
      fieldPath: "wordPattern",
    });
  if (regexes.length > L.regexesPerLanguage)
    return limit("tokenizer", "regexesPerLanguage", regexes.length, "regexes");

  const states = new Set<string>();
  for (const [i, state] of tokenizer.states.entries()) {
    if (
      states.has(state.name) ||
      forbiddenKeys.has(state.name) ||
      ["pop", "popall", "push"].includes(state.name)
    )
      return fail("tokenizer", `Duplicate or reserved state ${state.name}.`, {
        fieldPath: `states[${i}].name`,
      });
    states.add(state.name);
  }
  if (!states.has("root"))
    return fail("tokenizer", "A root state is required.", { fieldPath: "states" });
  const lists = new Set<string>();
  for (const [i, list] of (tokenizer.lists ?? []).entries()) {
    if (
      lists.has(list.name) ||
      forbiddenKeys.has(list.name) ||
      ["default", "eos"].includes(list.name)
    )
      return fail("tokenizer", `Duplicate or reserved list ${list.name}.`, {
        fieldPath: `lists[${i}].name`,
      });
    lists.add(list.name);
    const seen = new Set<string>();
    for (const [j, word] of list.words.entries()) {
      const key = tokenizer.ignoreCase ? word.toLowerCase() : word;
      if (seen.has(key))
        return fail("tokenizer", "Duplicate keyword after case folding.", {
          fieldPath: `lists[${i}].words[${j}]`,
        });
      seen.add(key);
    }
  }
  const actionProblem = (
    action: TokenAction,
    fieldPath: string,
  ): StaticLanguageValidationResult | undefined => {
    if (
      action.next &&
      !["@pop", "@popall"].includes(action.next) &&
      !states.has(action.next.slice(1))
    )
      return fail("tokenizer", `Missing or unsupported next state ${action.next}.`, {
        fieldPath: `${fieldPath}.next`,
      });
    if (
      action.token === "@brackets" &&
      (!tokenizer.brackets?.length || action.bracket !== undefined)
    )
      return fail(
        "tokenizer",
        "@brackets requires a nonempty bracket table and no bracket override.",
        { fieldPath: `${fieldPath}.token` },
      );
    return undefined;
  };
  for (const [i, state] of tokenizer.states.entries()) {
    for (const [j, rule] of state.rules.entries()) {
      if (!("regex" in rule)) continue;
      const path = `states[${i}].rules[${j}].action`;
      if ("cases" in rule.action) {
        const seen = new Set<string>();
        const cases = rule.action.cases;
        if (cases.at(-1)?.when !== "@default")
          return fail("tokenizer", "The last case must be @default.", {
            fieldPath: `${path}.cases`,
          });
        for (const [k, branch] of cases.entries()) {
          const branchPath = `${path}.cases[${k}]`;
          if (seen.has(branch.when) || (branch.when === "@default" && k !== cases.length - 1))
            return fail("tokenizer", "Cases must be unique with exactly one final @default.", {
              fieldPath: `${branchPath}.when`,
            });
          seen.add(branch.when);
          if (!["@default", "@eos"].includes(branch.when) && !lists.has(branch.when.slice(1)))
            return fail("tokenizer", `Missing case list ${branch.when}.`, {
              fieldPath: `${branchPath}.when`,
            });
          const problem = actionProblem(branch.action, `${branchPath}.action`);
          if (problem) return problem;
        }
      } else {
        const problem = actionProblem(rule.action, path);
        if (problem) return problem;
      }
    }
  }
  for (const [i, pair] of (configuration.autoClosingPairs ?? []).entries())
    if (pair.notIn && new Set(pair.notIn).size !== pair.notIn.length)
      return fail("configuration", "notIn entries must be unique.", {
        fieldPath: `autoClosingPairs[${i}].notIn`,
      });
  const graph = inspectStaticLanguageGraph(tokenizer);
  if (!graph.ok) {
    return fail("tokenizer", graph.message, {
      fieldPath: graph.fieldPath,
      ...(graph.limit === undefined
        ? {}
        : {
            limit: graph.limit,
            allowed: graph.allowed!,
            actual: graph.actual!,
          }),
    });
  }
  for (const entry of regexes) {
    const problem = checkStaticRegex(entry.data, entry.resource, tokenizer.ignoreCase);
    if (problem) {
      const { field, message, ...detail } = problem;
      return fail(entry.resource, message, { ...detail, fieldPath: `${entry.fieldPath}.${field}` });
    }
  }
  return {
    ok: true,
    tokenizer,
    configuration,
    resourceBytes: { ...input.resourceBytes },
    rules,
    regexes: regexes.length,
    expandedRules: graph.expandedRules,
  };
}
```

第一次錯誤立即回傳一筆 structured problem，避免大量重複 diagnostics；host 再加 plugin id／source ownership 與 `PLUGIN_E_STATIC_LANGUAGE`。`resourceBytes` 僅使用呼叫者的原始讀檔計量，不能 stringify 推算。plugin/global/session budgets 不在此函式決定；T2/T4 使用凍結 limits 和這裡的精確 counts。

- [ ] **Step 4: 執行確認通過並 build protocol**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol exec vitest run src/static-language-contract.test.ts src/static-language-manifest.test.ts src/static-language-schemas.test.ts src/static-language-regex.test.ts src/static-language-graph.test.ts src/static-languages.test.ts && pnpm --filter @kobrixa/plugin-protocol build`

Expected: PASS。build 讓 desktop 可讀取新的 `dist/`；此命令不執行 desktop、runtime 或 T6 的新產品資源。若 T0 fixture 本身不符合本 binding spec，先回報 controller，不偷偷替換 Basic Plus 規則以讓測試過關。

- [ ] **Step 5: Controller commit**

```bash
git add packages/plugin-protocol/src/static-languages.ts packages/plugin-protocol/src/static-languages.test.ts
git commit -m "feat(plugin-protocol): validate complete static language resources"
```

#### 1.6 JSON Schema、JS/Python SDK 與 shared conformance 1.4.0

- [ ] **Step 1: 寫 schema／Python 失敗測試，更新目前版本斷言**

在既有 `json-schema.test.ts` 的 `describe("published JSON Schema")` 內追加：

```ts
it("publishes strict v1 tokenizer/configuration definitions and code-point limits", () => {
  const schema = JSON.parse(serializeJsonSchema());
  for (const name of ["static-language-tokenizer-v1", "static-language-configuration-v1"])
    expect(schema.$defs[name].additionalProperties).toBe(false);
  const languages = schema.$defs.manifest.properties.contributes.properties.languages;
  expect(languages.maxItems).toBe(8);
  expect(languages.items.additionalProperties).toBe(false);
  expect(languages.items.properties.aliases.items.maxLength).toBe(80);
  expect(languages.items.properties.aliases).toMatchObject({ minItems: 1, maxItems: 8 });
  expect(languages.items.properties.extensions).toMatchObject({ minItems: 1, maxItems: 16 });
  expect(languages.items.properties.tokenizer.properties.path.maxLength).toBe(600);
  expect(languages.items.properties.tokenizer.additionalProperties).toBe(false);
  expect(languages.items.properties.configuration.properties.version.const).toBe(1);
  expect(
    schema.$defs["static-language-configuration-v1"].properties.wordPattern.properties.pattern
      .maxLength,
  ).toBe(2048);
  expect(serializeJsonSchema()).not.toContain("\\p{");
});
```

從 repository root 執行下列精確替換。只改「目前 host/SDK 回應」斷言；保留舊 manifest `^1.0.0`／`^1.1.0`／`^1.2.0`／`^1.3.0` compatibility fixtures：

```bash
python3 - <<'PY'
from pathlib import Path
paths = [
    "packages/plugin-protocol/src/compiler-manifest.test.ts",
    "packages/plugin-protocol/src/diagnostic-help.test.ts",
    "packages/plugin-protocol/src/language-services.test.ts",
    "packages/plugin-protocol/src/json-schema.test.ts",
    "packages/plugin-sdk-js/src/index.test.ts",
    "sdks/python/tests/test_plugin.py",
    "sdks/python/tests/test_conformance.py",
]
for name in paths:
    path = Path(name)
    text = path.read_text()
    text = text.replace('"1.3.0"', '"1.4.0"')
    text = text.replace('/1.3.0.json', '/1.4.0.json')
    text = text.replace('API 1.3', 'API 1.4')
    text = text.replace('publishes the 1.3.0 schema', 'publishes the 1.4.0 schema')
    text = text.replace('api_is_1_3', 'api_is_1_4')
    path.write_text(text)
PY
```

在 `conformance.test.ts` 的既有 `cases` 讀取之後追加以下 inventory test（使用既有 `Case`，不新增 public interface）。每一個數值產生獨立的 shared case，既有 `it.each(cases)` 與 Python `test_shared_cases` 都會執行它：

```ts
it("boundary structural inventory is complete", () => {
  const bounds: [string, number, number][] = [
    ["languages", 0, 8],
    ["id", 1, 32],
    ["extensions", 1, 16],
    ["extensionText", 1, 16],
    ["aliases", 1, 8],
    ["aliasText", 1, 80],
    ["pathDepth", 0, 7],
    ["directorySegment", 1, 64],
    ["fileStem", 1, 64],
    ["pathLength", 6, 524],
    ["resourceVersion", 1, 1],
    ["states", 1, 64],
    ["stateName", 1, 32],
    ["listName", 1, 32],
    ["include", 2, 33],
    ["next", 2, 33],
    ["when", 2, 33],
    ["defaultToken", 0, 80],
    ["actionToken", 0, 80],
    ["bracketToken", 0, 80],
    ["tokenPostfix", 2, 80],
    ["lists", 0, 32],
    ["words", 0, 4096],
    ["wordText", 1, 64],
    ["rules", 0, 1024],
    ["cases", 1, 32],
    ["tokenizerBrackets", 0, 32],
    ["configurationBrackets", 0, 32],
    ["autoClosingPairs", 0, 32],
    ["surroundingPairs", 0, 32],
    ["pairOpen", 1, 16],
    ["pairClose", 1, 16],
    ["lineComment", 1, 16],
    ["notIn", 0, 3],
    ["onEnterRules", 0, 32],
    ["appendText", 0, 256],
    ["removeText", 0, 256],
    ["tokenizerPattern", 1, 2048],
    ["configurationPattern", 1, 2048],
  ];
  const expected = bounds.flatMap(([id, minimum, maximum]) =>
    [
      ...new Set([
        0,
        Math.max(0, minimum - 1),
        minimum,
        Math.max(1, minimum),
        maximum - 1,
        maximum,
        maximum + 1,
      ]),
    ].map((sample) => ({
      name: `static v1: boundary ${id} ${sample}`,
      valid: sample >= minimum && sample <= maximum,
    })),
  );
  expect(
    cases
      .filter(({ name }) => name.startsWith("static v1: boundary "))
      .map(({ name, valid }) => ({ name, valid }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  ).toEqual(expected.sort((a, b) => a.name.localeCompare(b.name)));
});
```

建立 `sdks/python/tests/test_static_languages.py`：

```python
import copy
import json
import unittest
from importlib import resources
from pathlib import Path
from kobrixa._plugin import API_VERSION
from kobrixa._schema import SchemaError, Validator

FIXTURES = Path(__file__).resolve().parents[3] / "packages" / "plugin-protocol" / "test-fixtures" / "static-languages"


class StaticLanguagesTest(unittest.TestCase):
    def setUp(self):
        self.validator = Validator.bundled()
        self.manifest = json.loads((FIXTURES / "toy" / "kobrixa-plugin.json").read_text("utf-8"))

    def test_api_and_schema_identity(self):
        self.assertEqual(API_VERSION, "1.4.0")
        document = json.loads(resources.files("kobrixa").joinpath("plugin-protocol.schema.json").read_text("utf-8"))
        self.assertEqual(document["$id"], "https://kobrixa.com/schemas/plugin-protocol/1.4.0.json")
        for name in ("static-language-tokenizer-v1", "static-language-configuration-v1"):
            self.assertTrue(self.validator.has(name))
            self.assertIs(document["$defs"][name]["additionalProperties"], False)

    def test_frozen_resources_and_static_manifest(self):
        self.validator.validate("manifest", self.manifest)
        for folder in ("minimal", "basic-plus", "toy/language"):
            for kind in ("tokenizer", "configuration"):
                with self.subTest(folder=folder, kind=kind):
                    data = json.loads((FIXTURES / folder / f"{kind}.json").read_text("utf-8"))
                    self.validator.validate(f"static-language-{kind}-v1", data)
        for runtime in ({"kind": "static", "entry": "main.py"}, {"kind": "static", "future": True}):
            value = copy.deepcopy(self.manifest)
            value["runtime"] = runtime
            with self.assertRaises(SchemaError):
                self.validator.validate("manifest", value)

    def test_alias_and_pattern_lengths_use_decoded_code_points(self):
        for length in (80, 81):
            value = copy.deepcopy(self.manifest)
            value["contributes"]["languages"][0]["aliases"] = ["😀" * length]
            if length == 80:
                self.validator.validate("manifest", value)
            else:
                with self.assertRaises(SchemaError):
                    self.validator.validate("manifest", value)
        for length in (2048, 2049):
            value = {"wordPattern": {"pattern": "😀" * length, "flags": ""}}
            if length == 2048:
                self.validator.validate("static-language-configuration-v1", value)
            else:
                with self.assertRaises(SchemaError):
                    self.validator.validate("static-language-configuration-v1", value)

    def test_ecmascript_pattern_remains_data_for_python(self):
        # Structural acceptance is not ECMAScript semantic acceptance. The host
        # rejects backreferences/zero-width tokenizer patterns after parsing.
        for source in (r"(?<word>a)\k<word>", "(", "^", r"\$S1", "@name"):
            self.validator.validate("static-language-configuration-v1", {
                "wordPattern": {"pattern": source, "flags": "i"}})
        for source in ("\t", "\u0085"):
            with self.assertRaises(SchemaError):
                self.validator.validate("static-language-configuration-v1", {
                    "wordPattern": {"pattern": source, "flags": ""}})
```

- [ ] **Step 2: 執行確認失敗**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol exec vitest run src/json-schema.test.ts src/conformance.test.ts`

Expected: FAIL，boundary inventory 尚未產生，缺兩個 `$defs`，committed schemas 仍為 1.3.0。

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm test:python-sdk`

Expected: FAIL，Python API/schema 尚未更新；若沒有 Python，runner 的 local SKIP 不能當成 PASS。

- [ ] **Step 3: 接上 schema definitions、凍結 fixture 與 shared cases**

`json-schema.ts:8` 的 `SCHEMA_DEFINITIONS` 前新增 import，再於既有 `"diagnostic-help"` 後加入兩項。保留 `unrepresentable: "throw"`、draft-2020-12 與無 `$ref` 的現有 export pipeline：

```ts
import {
  staticLanguageTokenizerV1Schema,
  staticLanguageConfigurationV1Schema,
} from "./static-languages.js";
```

```ts
"static-language-tokenizer-v1": staticLanguageTokenizerV1Schema,
"static-language-configuration-v1": staticLanguageConfigurationV1Schema,
```

`conformance.test.ts` 既有 `expand()` 與 `it.each(cases)` 保留。在既有 index import 加入 `staticLanguageDeclarationProblems`、`validateStaticLanguageResources`；`Case` 加上 `staticSemantic?: boolean`。追加來源無關的語意檢查：

```ts
it.each(cases.filter((item) => item.staticSemantic !== undefined))(
  "$name (static declaration semantics)",
  ({ value, staticSemantic }) => {
    const manifest = pluginManifestSchema.parse(expand(value));
    expect(staticLanguageDeclarationProblems(manifest).length === 0).toBe(staticSemantic);
  },
);
```

將目前最後一個 `it("declares every Basic Plus language capability with its frontend in API 1.3", ...)` **完整替換**為下面測試。這取消 T1 對 T6 product manifest 更新時間的依賴；保留全部 capability 檢查和舊 API range 結構相容性，fixture 路徑使用 T0 原名：

```ts
it("keeps legacy service declarations compatible and validates frozen Basic Plus resources", async () => {
  const manifest = pluginManifestSchema.parse({
    id: "kobrixa.basic-plus",
    version: "1.0.0",
    apiVersion: "^1.3.0",
    runtime: { kind: "builtin" },
    contributes: {
      frontends: [
        {
          language: "bp",
          entryExtensions: ["bp"],
          sourceExtensions: ["bp", "bpi", "bpm"],
          ir: { min: 1, max: 1 },
        },
      ],
      languageServices: [
        {
          language: "bp",
          extensions: ["bp", "bpi", "bpm"],
          capabilities: [...LANGUAGE_CAPABILITIES],
        },
      ],
    },
  });
  expect(languageServiceDeclarationProblems(manifest)).toEqual([]);
  expect(manifest.contributes?.languageServices?.[0]?.capabilities).toEqual([
    ...LANGUAGE_CAPABILITIES,
  ]);
  const read = (name: string) =>
    readFile(new URL(`../test-fixtures/static-languages/basic-plus/${name}.json`, import.meta.url));
  const [tokenizer, configuration] = await Promise.all([read("tokenizer"), read("configuration")]);
  expect(
    validateStaticLanguageResources({
      languageId: "bp",
      formatVersion: 1,
      limitsVersion: 1,
      tokenizer: JSON.parse(tokenizer.toString("utf8")),
      configuration: JSON.parse(configuration.toString("utf8")),
      resourceBytes: { tokenizer: tokenizer.byteLength, configuration: configuration.byteLength },
    }),
  ).toMatchObject({ ok: true, rules: 9, regexes: 11, expandedRules: 9 });
});
```

用下列完整、可重跑的 script 追加 shared JSON cases。它只寫已列入 write set 的 `conformance/cases.json`；舊 `registry` fixtures 原樣保留，Python 只讀 `valid`，不解釋 `staticSemantic`：

```bash
node --input-type=module <<'JS'
import { readFile, writeFile } from "node:fs/promises";
const path = "packages/plugin-protocol/conformance/cases.json";
const prefix = "static v1: ";
const cases = JSON.parse(await readFile(path, "utf8")).filter((item) => !item.name.startsWith(prefix));
const fixture = JSON.parse(await readFile("packages/plugin-protocol/test-fixtures/static-languages/toy/kobrixa-plugin.json", "utf8"));
const language = fixture.contributes.languages[0];
const rule = { regex: { pattern: ".", flags: "" }, action: { token: "" } };
const tokenizer = { ignoreCase: false, states: [{ name: "root", rules: [rule] }] };
function add(name, definition, valid, value, staticSemantic) {
  cases.push({ name: prefix + name, definition, valid, value,
    ...(staticSemantic === undefined ? {} : { staticSemantic }) });
}
add("static-only manifest", "manifest", true, fixture, true);
add("strict runtime", "manifest", false, { ...fixture, runtime: { kind: "static", entry: "main.js" } });
add("missing runtime", "manifest", false, Object.fromEntries(Object.entries(fixture).filter(([key]) => key !== "runtime")));
add("empty static", "manifest", true, { ...fixture, contributes: { languages: [] } }, false);
add("help-only static", "manifest", true, { ...fixture, contributes: { diagnosticHelp: { version: 1, path: "help.json" } } }, true);
for (const key of ["activationEvents", "permissions"])
  add(`static ${key} forbidden`, "manifest", true, { ...fixture, [key]: [] }, false);
for (const key of ["commands", "frontends", "backends", "languageServices"])
  add(`static contributes.${key} forbidden`, "manifest", true, { ...fixture, contributes: { ...fixture.contributes, [key]: [] } }, false);
for (const kind of ["node", "python"])
  add(`${kind} with static resources`, "manifest", true, { ...fixture, runtime: { kind, entry: "main.js" } }, true);
add("duplicate language id", "manifest", true, { ...fixture, contributes: { languages: [language, language] } }, false);
add("duplicate extension", "manifest", true, { ...fixture, contributes: { languages: [{ ...language, extensions: ["toy", "toy"] }] } }, false);
for (const count of [80, 81])
  add(`alias ${count} code points`, "manifest", count === 80, { ...fixture, contributes: { languages: [
    { ...language, aliases: [{ $repeat: "😀", count }] },
  ] } });
for (const value of ["x\n", "x\u0085", "x\u2028"])
  add(`alias control ${JSON.stringify(value)}`, "manifest", false, { ...fixture, contributes: { languages: [{ ...language, aliases: [value] }] } });
for (const path of ["../a.json", "/a.json", "a\\b.json", "https://x/a.json"])
  add(`resource path ${path}`, "manifest", false, { ...fixture, contributes: { languages: [{ ...language, tokenizer: { version: 1, path } }] } });
add("minimal tokenizer", "static-language-tokenizer-v1", true, tokenizer);
add("empty configuration", "static-language-configuration-v1", true, {});
add("unknown tokenizer field", "static-language-tokenizer-v1", false, { ...tokenizer, start: "root" });
add("unknown nested field", "static-language-configuration-v1", false, { comments: { lineComment: "'", extra: true } });
add("tuple shortcut", "static-language-tokenizer-v1", false, { ...tokenizer, states: [{ name: "root", rules: [[".", "identifier"]] }] });
add("recursive cases", "static-language-tokenizer-v1", false, { ...tokenizer, states: [{ name: "root", rules: [{ ...rule,
  action: { cases: [{ when: "@default", action: { cases: [] } }] },
}] }] });
for (const flags of ["", "i", "g", "y", "d", "m", "s", "u", "v", "ii"])
  add(`regex flags ${flags}`, "static-language-configuration-v1", ["", "i"].includes(flags), { wordPattern: { pattern: "x", flags } });
for (const count of [2048, 2049])
  add(`pattern ${count} code points`, "static-language-configuration-v1", count === 2048,
    { wordPattern: { pattern: { $repeat: "😀", count }, flags: "" } });
for (const pattern of ["(?<word>a)\\k<word>", "(", "^", "\\$S1", "@name"])
  add(`ECMAScript semantics are host-only ${pattern}`, "static-language-configuration-v1", true, { wordPattern: { pattern, flags: "" } });
for (const count of [16, 17])
  add(`pair ${count} code points`, "static-language-configuration-v1", count === 16,
    { brackets: [{ open: { $repeat: "😀", count }, close: ")" }] });
// Shared structural boundary corpus: Zod and the exported-schema Python validator
// consume identical values. Semantic constraints (uniqueness/root/references/totals)
// have separate public-validator tests; schema-valid does not promise host admission.
const manifestWith = (value) => ({ ...fixture, contributes: { languages: [value] } });
const ruleWith = (value) => ({ ...tokenizer, states: [{ name: "root", rules: [value] }] });
const enter = { beforeText: { pattern: "^", flags: "" }, action: { indentAction: "none" } };
const pair = { open: "(", close: ")" };
const repeat = (count, make) => Array.from({ length: count }, (_, i) => make(i));
function boundary(id, minimum, maximum, definition, make) {
  const samples = [...new Set([0, Math.max(0, minimum - 1), minimum, Math.max(1, minimum), maximum - 1, maximum, maximum + 1])];
  for (const sample of samples)
    add(`boundary ${id} ${sample}`, definition, sample >= minimum && sample <= maximum, make(sample));
}
const decl = (id, min, max, make) => boundary(id, min, max, "manifest", (n) => manifestWith({ ...language, ...make(n) }));
const tok = (id, min, max, make) => boundary(id, min, max, "static-language-tokenizer-v1", make);
const config = (id, min, max, make) => boundary(id, min, max, "static-language-configuration-v1", make);
boundary("languages", 0, 8, "manifest", (n) => ({ ...fixture, contributes: {
  languages: repeat(n, (i) => ({ ...language, id: `l${i}` })),
} }));
decl("id", 1, 32, (n) => ({ id: "a".repeat(n) }));
decl("extensions", 1, 16, (n) => ({ extensions: repeat(n, (i) => `e${i}`) }));
decl("extensionText", 1, 16, (n) => ({ extensions: ["a".repeat(n)] }));
decl("aliases", 1, 8, (n) => ({ aliases: repeat(n, (i) => `Alias ${i}`) }));
decl("aliasText", 1, 80, (n) => ({ aliases: ["😀".repeat(n)] }));
const resource = (path) => ({ tokenizer: { version: 1, path }, configuration: { version: 1, path } });
decl("pathDepth", 0, 7, (n) => resource("a/".repeat(n) + "b.json"));
decl("directorySegment", 1, 64, (n) => resource("a".repeat(n) + "/b.json"));
decl("fileStem", 1, 64, (n) => resource("a".repeat(n) + ".json"));
decl("pathLength", 6, 524, (n) => resource(n >= 523
  ? ("a".repeat(64) + "/").repeat(7) + "b".repeat(n - 460) + ".json"
  : n >= 5 ? "a".repeat(n - 5) + ".json" : "a".repeat(n)));
decl("resourceVersion", 1, 1, (n) => ({ tokenizer: { version: n, path: "a.json" }, configuration: { version: n, path: "a.json" } }));
for (const n of [599, 600, 601])
  add(`grammar dominated path cap ${n}`, "manifest", false, manifestWith({ ...language, ...resource("a".repeat(n - 5) + ".json") }));
tok("states", 1, 64, (n) => ({ ...tokenizer, states: repeat(n, (i) => ({ name: i === 0 ? "root" : `s${i}`, rules: [] })) }));
tok("stateName", 1, 32, (n) => ({ ...tokenizer, states: [{ name: "a".repeat(n), rules: [] }] }));
tok("listName", 1, 32, (n) => ({ ...tokenizer, lists: [{ name: "a".repeat(n), words: [] }] }));
const ref = (n) => n === 0 ? "" : "@" + "a".repeat(n - 1);
tok("include", 2, 33, (n) => ruleWith({ include: ref(n) }));
tok("next", 2, 33, (n) => ruleWith({ ...rule, action: { token: "", next: ref(n) } }));
tok("when", 2, 33, (n) => ruleWith({ ...rule, action: { cases: [{ when: ref(n), action: { token: "" } }] } }));
tok("defaultToken", 0, 80, (n) => ({ ...tokenizer, defaultToken: "a".repeat(n) }));
tok("actionToken", 0, 80, (n) => ruleWith({ ...rule, action: { token: "a".repeat(n) } }));
tok("bracketToken", 0, 80, (n) => ({ ...tokenizer, brackets: [{ ...pair, token: "a".repeat(n) }] }));
tok("tokenPostfix", 2, 80, (n) => ({ ...tokenizer, tokenPostfix: n === 0 ? "" : "." + "a".repeat(n - 1) }));
tok("lists", 0, 32, (n) => ({ ...tokenizer, lists: repeat(n, (i) => ({ name: `l${i}`, words: [] })) }));
tok("words", 0, 4096, (n) => ({ ...tokenizer, lists: [{ name: "words", words: repeat(n, (i) => `w${i}`) }] }));
tok("wordText", 1, 64, (n) => ({ ...tokenizer, lists: [{ name: "words", words: ["😀".repeat(n)] }] }));
tok("rules", 0, 1024, (n) => ({ ...tokenizer, states: [{ name: "root", rules: repeat(n, () => rule) }] }));
tok("cases", 1, 32, (n) => ruleWith({ ...rule, action: { cases: repeat(n, (i) => ({
  when: i === n - 1 ? "@default" : `@l${i}`, action: { token: "" },
})) } }));
tok("tokenizerBrackets", 0, 32, (n) => ({ ...tokenizer, brackets: repeat(n, () => ({ ...pair, token: "" })) }));
for (const [id, key] of [["configurationBrackets", "brackets"], ["autoClosingPairs", "autoClosingPairs"], ["surroundingPairs", "surroundingPairs"]])
  config(id, 0, 32, (n) => ({ [key]: repeat(n, () => pair) }));
config("pairOpen", 1, 16, (n) => ({ brackets: [{ open: "😀".repeat(n), close: ")" }] }));
config("pairClose", 1, 16, (n) => ({ brackets: [{ open: "(", close: "😀".repeat(n) }] }));
config("lineComment", 1, 16, (n) => ({ comments: { lineComment: "😀".repeat(n) } }));
config("notIn", 0, 3, (n) => ({ autoClosingPairs: [{ ...pair, notIn: ["string", "comment", "regex", "string"].slice(0, n) }] }));
config("onEnterRules", 0, 32, (n) => ({ onEnterRules: repeat(n, () => enter) }));
config("appendText", 0, 256, (n) => ({ onEnterRules: [{ ...enter, action: { indentAction: "none", appendText: "😀".repeat(n) } }] }));
config("removeText", 0, 256, (n) => ({ onEnterRules: [{ ...enter, action: { indentAction: "none", removeText: n } }] }));
for (const n of [-1, 0.5])
  add(`removeText invalid ${n}`, "static-language-configuration-v1", false, { onEnterRules: [{ ...enter, action: { indentAction: "none", removeText: n } }] });
tok("tokenizerPattern", 1, 2048, (n) => ruleWith({ ...rule, regex: { pattern: "😀".repeat(n), flags: "" } }));
config("configurationPattern", 1, 2048, (n) => ({ wordPattern: { pattern: "😀".repeat(n), flags: "" } }));
await writeFile(path, JSON.stringify(cases, null, 2) + "\n");
JS
```

在 `sdks/python/kobrixa/_plugin.py:13` 將常數改成：

```python
API_VERSION = "1.4.0"
```

T0 已將 protocol `PLUGIN_API_VERSION` 設為 `1.4.0`；JS SDK 的既有 `API_VERSION = PLUGIN_API_VERSION` 和 initialize 回覆會自動跟進，不修改 `SDK_VERSION`。`sdks/python/kobrixa/_schema.py` 已用 `len(str)`，且只將 **schema 的** pattern 編譯；不新增 ECMAScript validator。

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol schema && pnpm --filter @kobrixa/plugin-protocol build && pnpm --filter @kobrixa/plugin-sdk build`

Expected: 產生兩份完全相同的 1.4.0 JSON Schema，沒有不可匯出 refine/transform、沒有新增 schema keywords、沒有 tokenizer RPC。build 更新 desktop/SDK 所消費的 protocol `dist/`。

- [ ] **Step 4: 執行確認通過**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol test && pnpm --filter @kobrixa/plugin-sdk test && pnpm test:python-sdk`

Expected: PASS，包含全部既有 protocol/framing/RPC、JS handshake 與 Python SDK tests。Python 與 Zod 對相同 structural cases 結果一致；只有 TS pure validator 判斷 ECMAScript AST／references／graph 語意。

- [ ] **Step 5: 格式、ESLint、typecheck 與交付 gate**

在 repository root 執行（只格式化本 task 已列出的檔案）：

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false
task1_ts=(
  packages/plugin-protocol/src/manifest.ts
  packages/plugin-protocol/src/static-language-schemas.ts
  packages/plugin-protocol/src/static-language-regex.ts
  packages/plugin-protocol/src/static-language-graph.ts
  packages/plugin-protocol/src/static-languages.ts
  packages/plugin-protocol/src/static-language-manifest.test.ts
  packages/plugin-protocol/src/static-language-schemas.test.ts
  packages/plugin-protocol/src/static-language-regex.test.ts
  packages/plugin-protocol/src/static-language-graph.test.ts
  packages/plugin-protocol/src/static-languages.test.ts
  packages/plugin-protocol/src/json-schema.ts
  packages/plugin-protocol/src/json-schema.test.ts
  packages/plugin-protocol/src/conformance.test.ts
  packages/plugin-protocol/src/compiler-manifest.test.ts
  packages/plugin-protocol/src/diagnostic-help.test.ts
  packages/plugin-protocol/src/language-services.test.ts
  packages/plugin-sdk-js/src/index.test.ts
)
task1_format=("${task1_ts[@]}" packages/plugin-protocol/package.json packages/plugin-protocol/conformance/cases.json)
pnpm exec prettier --write "${task1_format[@]}"
pnpm exec prettier --check "${task1_format[@]}"
pnpm exec eslint "${task1_ts[@]}"
pnpm --filter @kobrixa/plugin-protocol check
pnpm --filter @kobrixa/plugin-sdk check
pnpm --filter @kobrixa/plugin-protocol build
pnpm --filter @kobrixa/plugin-sdk build
git diff --check
git diff --name-only
```

Expected: 全部退出碼 0；變更只在本節 Files 清單。JSON Schema 和 lockfile 已由 repository `.prettierignore` 明確排除，不手改 generated schema 的格式；schema equality tests 驗證兩份 bytes。ESLint 只針對其支援的 TS files；Python files 由 `pnpm test:python-sdk` 驗證，不把 Prettier/ESLint 當作 Python linter。若 formatter 修改 code，重跑 Step 4 一次後交付。

可直接檢查 browser-safe 模組依賴（無需 T4 或 desktop）：

```bash
rg -n 'node:|monaco-editor|@kobrixa/plugin-runtime|\bBuffer\b|\bprocess\b' packages/plugin-protocol/src/static-language-schemas.ts packages/plugin-protocol/src/static-language-regex.ts packages/plugin-protocol/src/static-language-graph.ts packages/plugin-protocol/src/static-languages.ts
```

Expected: 無 matches（`rg` 退出碼 1 是此檢查成功）。parser 是無 Node dependency 的 ESM；真正 renderer bundle 與 Monaco conformance 留 T8。不要為了本 task 跑根 `pnpm -r build` 或修改 runtime/desktop 使其跟進。

- [ ] **Step 6: Controller commit**

controller 在測試紀錄與 diff review 後執行；此 commit 也包含 Step 5 對前面 subsections 的純格式修正：

```bash
git add packages/plugin-protocol/src/manifest.ts packages/plugin-protocol/src/static-language-schemas.ts packages/plugin-protocol/src/static-language-regex.ts packages/plugin-protocol/src/static-language-graph.ts packages/plugin-protocol/src/static-languages.ts packages/plugin-protocol/src/static-language-manifest.test.ts packages/plugin-protocol/src/static-language-schemas.test.ts packages/plugin-protocol/src/static-language-regex.test.ts packages/plugin-protocol/src/static-language-graph.test.ts packages/plugin-protocol/src/static-languages.test.ts packages/plugin-protocol/src/json-schema.ts packages/plugin-protocol/src/json-schema.test.ts packages/plugin-protocol/src/conformance.test.ts packages/plugin-protocol/src/compiler-manifest.test.ts packages/plugin-protocol/src/diagnostic-help.test.ts packages/plugin-protocol/src/language-services.test.ts packages/plugin-protocol/conformance/cases.json packages/plugin-protocol/schema/plugin-protocol.schema.json packages/plugin-sdk-js/src/index.test.ts sdks/python/kobrixa/_plugin.py sdks/python/kobrixa/plugin-protocol.schema.json sdks/python/tests/test_plugin.py sdks/python/tests/test_conformance.py sdks/python/tests/test_static_languages.py
git commit -m "feat(plugin-protocol): publish static language schema and SDK API 1.4"
```

**Deferred to T8**

- T2 與真 validator 的 registry 順序、`PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN` 優先序、API range host 載入相容、static-only 零 spawn／activation／handshake、resource I/O/BOM/deadline 與 plugin/global budgets。
- T4 的真 Monaco adapter：literal `@`／`@@`／`@name`／反斜線／`$`、lookahead、case-insensitive keywords、escaped strings；實際 source normalization/anchoring 的 4096 邊界，及 9999／10000／10001 UTF-16 line gate。此處只證明純資料／AST validator。
- T6 產品 Basic Plus JSON 與 manifest 的真 validator 驗證、舊／新 token parity、formatter indentation/keywords parity、raw packaged resource 路徑。T1 僅驗證 T0 凍結 fixture。
- T3/T5/T7 真 IPC、renderer bundle、生命週期／復原／packaged acceptance，以及整合後的全 workspace build/check/test 與 lockfile frozen-install gate。

**Contract gaps**

- T0 未命名公開 resource schema 的 TypeScript exports。本 task 在自己的 protocol write set 定義並 re-export `staticLanguageTokenizerV1Schema`、`staticLanguageConfigurationV1Schema`；`$defs` 使用 spec 已指定的 `static-language-tokenizer-v1`、`static-language-configuration-v1`。不更動任何 T0 validator/type/fixture 名稱。
- T0 alias scaffold 使用 Python `re` 不支援的 `\p{Cc}`。1.1 以等價 C0/C1 ranges 加上 Unicode line-separator 排除與 code-point bounds 完成同一 `staticLanguageDeclSchema`，無 schema keyword 或 Python engine 擴充需求。
### Task 2: Runtime static-language loading, ownership, catalog and lifecycle

**Files:**

- Create: `packages/plugin-runtime/src/packaged-json-resource.ts`
- Create: `packages/plugin-runtime/src/packaged-json-resource.test.ts`
- Create: `packages/plugin-runtime/src/static-language-catalog.ts`
- Create: `packages/plugin-runtime/src/static-languages.test.ts`
- Create: `packages/plugin-runtime/src/manager.static-languages.test.ts`
- Create: `packages/plugin-runtime/src/test-static-languages.ts`
- Modify: `packages/plugin-runtime/src/registry.ts:37-51,62-200,202-250` — `ReadPlugin`, `semanticProblems`, `checkManifest`, `readDevelopmentPlugin`, `readSource`.
- Modify: `packages/plugin-runtime/src/diagnostic-help.ts:24-75` — preserve its public reader and test injection, add the post-open regular-file check.
- Modify: `packages/plugin-runtime/src/manager.ts:105-122,163-206,261-398,493-569,639-670` — `Entry`, creation, lifecycle transactions, reconciliation and summaries; replace T0's catalog/report stubs.
- Modify: `packages/plugin-runtime/src/static-languages.ts` — T0-owned types stay exact; add the explicit host core-id list.
- Modify: `packages/plugin-runtime/src/manager.test.ts:609-628` — corrupt-store recovery expectations.
- Test, retain unchanged: `packages/plugin-runtime/src/static-language-contract.test.ts` (created by T0), `packages/plugin-runtime/src/registry.test.ts`, `packages/plugin-runtime/src/registry.timeout.test.ts`, `packages/plugin-runtime/src/diagnostic-help.test.ts`, `packages/plugin-runtime/src/compiler-resolution.test.ts`, `packages/plugin-runtime/src/language-service-conformance.test.ts`.

These are the exact implementation files within §11.1's `packages/plugin-runtime/**` write set. T0 already adds the error codes/detail type, required builtin `resources`, index re-export, static runtime narrowing and existing test-fixture compatibility edits; do not redo those edits. Line numbers above refer to the inspected pre-T0 source; use the named functions after T0 shifts them. Do not edit protocol fixtures, product Basic Plus resources, desktop, package manifests or the lockfile.

**Interfaces:**

- Consumes T0: `staticLanguageDeclarationProblems(manifest: PluginManifest): string[]`; `validateStaticLanguageResources(input: ValidateStaticLanguageResourcesInput): StaticLanguageValidationResult`; `STATIC_LANGUAGE_FORMAT_VERSION = 1`; immutable `STATIC_LANGUAGE_LIMITS_V1`. Resource input carries `languageId`, `formatVersion`, `limitsVersion`, unknown parsed `tokenizer`/`configuration`, original `resourceBytes`, and relative `resourcePaths`. Successful validation supplies typed resources, `resourceBytes`, `expandedRules`, `rules`, `regexes`; failure supplies `{ message, detail }[]`.
- Consumes existing runtime: `developmentSourceKey(directory)`, `resolvePlugins(read, { disabled, safeMode })`, `convertLegacy`, `PluginSupervisor`, `readDiagnosticHelp`, `#enqueue`, `#retire`, `#save` and `#saveBestEffort`. Keep compiler conflicts and service resolution separate from lexical problems.
- Produces exactly T0: `PluginSource`'s builtin `{ kind: "builtin"; manifest: unknown; resources: Readonly<Record<string, string>> }`; `PluginSummary.runtime` including `"static"`; `PluginManager.staticLanguages(): StaticLanguagesCatalog`; `get staticLanguagesRevision(): number`; `reportLanguageRegistrationFailure(input: ReportLanguageRegistrationFailureInput): ReportLanguageRegistrationFailureResult`; required `PluginsSnapshot.staticLanguagesRevision` and complete `staticLanguageOwners: StaticLanguageOwner[]`.
- Retains exactly T0's `StaticLanguageSourceIdentity`, `StaticLanguageOwner`, `ValidatedStaticLanguage`, `StaticLanguageConflict`, `StaticLanguageProblemDetail`, `StaticLanguagesCatalog`, `emptyStaticLanguagesCatalog`, and report input/result/reasons. `extensionRoutes` absence means unmapped; `null` means ambiguous. All three new problem codes carry host-created `detail.languageId`; they never carry a compiler `providerKey`.
- Task-local additions, defined below: `SourceReadBudget`, `PackagedJson`, `PackagedResourceError`, `readPackagedJson`, `readBuiltinJson`; `ReadPlugin.resourceBudget?: SourceReadBudget`; private `Entry.staticGeneration` (published under the frozen DTO name `generation`, independent of service/process generation); `StaticCatalogEntry`, `StaticCatalogBuild`, `buildStaticLanguageCatalog`, `projectStaticLanguageCatalog`, `staticLanguageKey`; exported immutable `CORE_STATIC_LANGUAGE_IDS` in T0's runtime static-language module. These additions stay entirely in T2's write set. T3/T6 use the frozen public manager/source contracts, not these implementation helpers.

Run this task in its own worktree from the controller's exact T0 commit. Tests mock **both** new T1 semantic functions; the structural T0 manifest schema and all old protocol functions remain real. The mock accepts only the frozen resource fixtures used by orchestration tests and is not evidence of regex safety or schema conformance. Each subsection has a controller-only commit; the Codex worker does not run `git add` or `git commit`.

#### 2.1 Bound source I/O and separate metadata from resources

- [ ] **Step 1: Add the reader tests and the shared, runtime-owned test fixtures**

Create `packages/plugin-runtime/src/test-static-languages.ts`:

```ts
import { readFileSync } from "node:fs";
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  PluginManifest,
  StaticLanguageTokenizerV1,
  StaticLanguageConfigurationV1,
  ValidateStaticLanguageResourcesInput,
  StaticLanguageValidationResult,
} from "@kobrixa/plugin-protocol";
import type { PluginSource } from "./registry.js";

export const toyRoot = new URL(
  "../../plugin-protocol/test-fixtures/static-languages/toy/",
  import.meta.url,
);
export const toyManifest = JSON.parse(
  readFileSync(new URL("kobrixa-plugin.json", toyRoot), "utf8"),
) as PluginManifest;
export const tokenizerText = readFileSync(new URL("language/tokenizer.json", toyRoot), "utf8");
export const configurationText = readFileSync(
  new URL("language/configuration.json", toyRoot),
  "utf8",
);
export const tokenizer = JSON.parse(tokenizerText) as StaticLanguageTokenizerV1;
export const configuration = JSON.parse(configurationText) as StaticLanguageConfigurationV1;

// Deliberately a fixture double, not a second resource validator.
export function acceptFixture(
  input: ValidateStaticLanguageResourcesInput,
): StaticLanguageValidationResult {
  return {
    ok: true,
    tokenizer: input.tokenizer as StaticLanguageTokenizerV1,
    configuration: input.configuration as StaticLanguageConfigurationV1,
    resourceBytes: input.resourceBytes,
    expandedRules: 3,
    rules: 3,
    regexes: 3,
  };
}

export function builtinToy(
  pluginId = "test.toy",
  languageId = "toy",
  extensions = ["toy"],
): Extract<PluginSource, { kind: "builtin" }> {
  const manifest = structuredClone(toyManifest);
  manifest.id = pluginId;
  manifest.runtime = { kind: "builtin" };
  manifest.contributes!.languages![0] = {
    ...manifest.contributes!.languages![0]!,
    id: languageId,
    extensions,
  };
  return {
    kind: "builtin",
    manifest,
    resources: {
      "language/tokenizer.json": tokenizerText,
      "language/configuration.json": configurationText,
    },
  };
}

export async function developmentToy(root: string, name = "toy") {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await cp(toyRoot, directory, { recursive: true });
  return { kind: "development" as const, directory };
}

export async function writeManifest(directory: string, manifest: PluginManifest): Promise<void> {
  await writeFile(path.join(directory, "kobrixa-plugin.json"), JSON.stringify(manifest));
}
```

Create `packages/plugin-runtime/src/packaged-json-resource.test.ts`:

```ts
import { appendFile, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { STATIC_LANGUAGE_LIMITS_V1 as L } from "@kobrixa/plugin-protocol";
import { readBuiltinJson, readPackagedJson, SourceReadBudget } from "./packaged-json-resource.js";

let root: string;
let directory: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-static-reader-"));
  directory = path.join(root, "plugin");
  await mkdir(directory);
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});
const read = (name: string) =>
  readPackagedJson(directory, name, L.resourceFileBytes, new SourceReadBudget());

it("counts the original UTF-8 bytes including BOM for both providers", async () => {
  const raw = '\uFEFF{"label":"😀"}';
  await writeFile(path.join(directory, "ok.json"), raw);
  const disk = await read("ok.json");
  const bundled = readBuiltinJson({ "ok.json": raw }, "ok.json", L.resourceFileBytes);
  expect(disk).toEqual(bundled);
  expect(disk.bytes).toBe(Buffer.byteLength(raw));
  expect(disk.value).toEqual({ label: "😀" });
});

it("accepts exactly 512 KiB and rejects one byte more, including growth after stat", async () => {
  const raw = "{}" + " ".repeat(L.resourceFileBytes - 2);
  await writeFile(path.join(directory, "max.json"), raw);
  expect((await read("max.json")).bytes).toBe(L.resourceFileBytes);
  await appendFile(path.join(directory, "max.json"), " ");
  await expect(read("max.json")).rejects.toMatchObject({
    limit: "resourceFileBytes",
    allowed: L.resourceFileBytes,
    actual: L.resourceFileBytes + 1,
  });
  await writeFile(path.join(directory, "grow.json"), "{}");
  await expect(
    readPackagedJson(directory, "grow.json", L.resourceFileBytes, new SourceReadBudget(), {
      stat: async (file) => {
        const result = await stat(file);
        await appendFile(file, " ".repeat(L.resourceFileBytes));
        return result;
      },
    }),
  ).rejects.toMatchObject({ limit: "resourceFileBytes" });
});

it("rejects traversal, absolute paths, URLs, escaping links, directories and malformed bytes", async () => {
  await writeFile(path.join(root, "outside.json"), "{}");
  await symlink(path.join(root, "outside.json"), path.join(directory, "escape.json"));
  await mkdir(path.join(directory, "dir.json"));
  await writeFile(path.join(directory, "bad.json"), "{");
  await writeFile(path.join(directory, "utf8.json"), Buffer.from([0xc3, 0x28]));
  for (const name of [
    "../outside.json",
    path.join(root, "outside.json"),
    "https://x/a.json",
    "a\\b.json",
    "escape.json",
    "dir.json",
    "missing.json",
    "bad.json",
    "utf8.json",
  ])
    await expect(read(name)).rejects.toThrow();
  expect(() => readBuiltinJson(Object.create({ "x.json": "{}" }), "x.json", 10)).toThrow();
});

it("charges metadata and every resource once, pauses between jobs and permanently rejects late work", async () => {
  vi.useFakeTimers();
  const budget = new SourceReadBudget(5000, () => Date.now());
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  // Construction/global orchestration waits consume none of this source's allowance.
  await vi.advanceTimersByTimeAsync(6000);
  const metadata = budget.run(() => budget.run(() => delay(2000)));
  await vi.advanceTimersByTimeAsync(2000);
  await metadata;
  await vi.advanceTimersByTimeAsync(6000);
  const tokenizer = budget.run(() => delay(2000));
  await vi.advanceTimersByTimeAsync(2000);
  await tokenizer;
  await vi.advanceTimersByTimeAsync(6000);
  let finish!: (value: number) => void;
  const configuration = budget.run(() => new Promise<number>((resolve) => { finish = resolve; }));
  const rejected = expect(configuration).rejects.toThrow("deadline");
  await vi.advanceTimersByTimeAsync(999);
  expect(() => budget.check()).not.toThrow();
  await vi.advanceTimersByTimeAsync(1);
  await rejected; // Only 1,000 ms remained; neither resource got a fresh 5,000 ms.
  finish(123);
  const nextResource = vi.fn(async () => 456);
  await expect(budget.run(nextResource)).rejects.toThrow("deadline");
  expect(nextResource).not.toHaveBeenCalled();
});

it("charges failed I/O against the same remaining source allowance", async () => {
  vi.useFakeTimers();
  const budget = new SourceReadBudget(5000, () => Date.now());
  const failed = budget.run(() => new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error("unreadable")), 4000);
  }));
  const rejected = expect(failed).rejects.toThrow("unreadable");
  await vi.advanceTimersByTimeAsync(4000);
  await rejected;
  await vi.advanceTimersByTimeAsync(10000);
  const next = budget.run(() => new Promise<void>(() => {}));
  const expired = expect(next).rejects.toThrow("deadline");
  await vi.advanceTimersByTimeAsync(1000);
  await expired;
});

```

- [ ] **Step 2: Run the reader tests, expect FAIL**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime exec vitest run src/packaged-json-resource.test.ts`

Expected: FAIL resolving `./packaged-json-resource.js`. This is a runtime test; no T1 implementation is needed.

- [ ] **Step 3: Implement the bounded reader and metadata-only registry**

Create `packages/plugin-runtime/src/packaged-json-resource.ts`:

```ts
import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";

export class SourceReadBudget {
  #remainingMs: number;
  #startedAt: number | undefined;
  #expired = false;
  constructor(timeoutMs = 5000, private readonly now: () => number = () => performance.now()) {
    this.#remainingMs = timeoutMs;
  }
  check(): void {
    const elapsed = this.#startedAt === undefined ? 0 : this.now() - this.#startedAt;
    if (this.#expired || elapsed >= this.#remainingMs) {
      this.#expired = true;
      throw new Error("Source I/O deadline exceeded.");
    }
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.check();
    // Metadata wraps the packaged reader. Nested calls share the outer timer and
    // elapsed interval; they neither double-charge elapsed time nor reset the allowance.
    if (this.#startedAt !== undefined) {
      const value = await work();
      this.check();
      return value;
    }
    this.#startedAt = this.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          this.#expired = true;
          reject(new Error("Source I/O deadline exceeded."));
        }, this.#remainingMs);
      });
      const pending = Promise.resolve().then(work).then((value) => {
        this.check();
        return value;
      });
      return await Promise.race([pending, timeout]);
    } finally {
      this.#remainingMs = Math.max(0, this.#remainingMs - (this.now() - this.#startedAt));
      this.#startedAt = undefined;
      clearTimeout(timer);
    }
  }
}

export class PackagedResourceError extends Error {
  constructor(
    message: string,
    readonly limit?: "resourceFileBytes",
    readonly allowed?: number,
    readonly actual?: number,
  ) {
    super(message);
  }
}
export type PackagedJson = { value: unknown; bytes: number; digest: string };
const resourcePath =
  /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\/){0,7}[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\.json$/;
function checkPath(file: string): void {
  if (file.length > 600 || !resourcePath.test(file)) throw new Error("Invalid packaged JSON path.");
}
function decode(bytes: Uint8Array): PackagedJson {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  return {
    value: JSON.parse(text) as unknown,
    bytes: bytes.byteLength,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
}
export function readBuiltinJson(
  resources: Readonly<Record<string, string>>,
  file: string,
  limit: number,
): PackagedJson {
  checkPath(file);
  if (!Object.hasOwn(resources, file)) throw new Error("Missing bundled resource.");
  const raw = resources[file]!;
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > limit)
    throw new PackagedResourceError(
      "Resource file exceeds byte limit.",
      "resourceFileBytes",
      limit,
      bytes,
    );
  return decode(Buffer.from(raw, "utf8"));
}

export async function readPackagedJson(
  root: string,
  file: string,
  limit: number,
  budget: SourceReadBudget,
  deps: { stat: (file: string) => Promise<{ isFile(): boolean }> } = { stat },
): Promise<PackagedJson> {
  checkPath(file);
  return budget.run(async () => {
    const base = await realpath(root);
    budget.check();
    const target = await realpath(path.resolve(base, file));
    budget.check();
    const relative = path.relative(base, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("Resource resolves outside the plugin folder.");
    if (!(await deps.stat(target)).isFile()) throw new Error("Resource is not a regular file.");
    budget.check();
    const handle = await open(target, "r");
    try {
      // The finally also closes an open() that completes after the caller's deadline.
      budget.check();
      if (!(await handle.stat()).isFile())
        throw new Error("Opened resource is not a regular file.");
      budget.check();
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        budget.check();
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > limit)
        throw new PackagedResourceError(
          "Resource file exceeds byte limit.",
          "resourceFileBytes",
          limit,
          length,
        );
      return decode(buffer.subarray(0, length));
    } finally {
      await handle.close();
    }
  });
}
```

In `diagnostic-help.ts`, immediately inside the existing `try` following `const handle = await open(file, "r")`, insert this check. Keep its `deps.stat`, bounded read, byte accounting, schema/semantic validation and public error messages:

```ts
if (!(await handle.stat()).isFile()) return fail(decl.path, "is not a regular file.");
```

In `registry.ts`, replace the fs import with `import { realpath } from "node:fs/promises";`, remove the value import of `readDiagnosticHelp` (retain `LoadedDiagnosticHelp` as a type-only import), and add:

```ts
import { staticLanguageDeclarationProblems } from "@kobrixa/plugin-protocol";
import { readPackagedJson, SourceReadBudget } from "./packaged-json-resource.js";
```

`SourceReadBudget` charges the union of active `run()` intervals against one 5,000 ms allowance. It starts paused, uses a monotonic clock (injectable in reader tests), pauses on completion/error, and stays permanently expired after timeout. Nested metadata/reader calls share the outer interval. Never overlap independent operations on the same source budget. Global metadata joins, legacy/settings persistence, process retirement, ownership resolution and waits behind other sources' resource jobs occur outside `run()` and consume none of that source's allowance. Late completions still call `check()` before decoding/publishing and close their handles. This is I/O accounting, not a timeout capable of interrupting synchronous work.

Add this internal field to `ReadPlugin`; neither summaries nor catalog DTOs spread `ReadPlugin` into IPC:

```ts
/** One metadata/resource attempt; never serialized or supplied by a plugin. */
resourceBudget?: SourceReadBudget;
```

At the beginning of `checkManifest`, before `pluginManifestSchema.safeParse(value)`, add the source-priority guard. The existing parsed source restrictions remain for backwards-compatible errors; this guard prevents malformed static declarations from hiding a third-party service violation:

```ts
if (source !== "builtin" && value && typeof value === "object" && "contributes" in value) {
  const contributes = value.contributes;
  if (
    contributes &&
    typeof contributes === "object" &&
    Object.hasOwn(contributes, "languageServices")
  )
    return {
      id: fallbackId,
      source,
      problems: [
        problem(
          "PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN",
          "Language services can only be contributed by built-in plugins in this version.",
        ),
      ],
    };
}
```

At the end of `semanticProblems`, before `return problems`, add the new semantic call only after source restrictions have succeeded. Old manifests without this capability do not call T0's throwing stub:

```ts
const sourceRejected = problems.some((item) =>
  [
    "PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN",
    "PLUGIN_E_FRONTEND_REQUIRES_BUILTIN",
    "PLUGIN_E_BACKEND_REQUIRES_BUILTIN",
    "PLUGIN_E_RUNTIME_NOT_ALLOWED",
  ].includes(item.code),
);
if (
  !sourceRejected &&
  (manifest.runtime.kind === "static" || manifest.contributes?.languages !== undefined)
)
  problems.push(
    ...staticLanguageDeclarationProblems(manifest).map((message) =>
      problem("PLUGIN_E_MANIFEST", `${manifest.id}: ${message}`),
    ),
  );
```

Replace `readDevelopmentPlugin` and `readSource` with these complete functions. Keep `resolvePlugins` and `loadPlugins` unchanged: they now resolve metadata only; the manager owns resource assembly after persisted disables, legacy conversion and compiler conflicts. Diagnostic-help-only static plugins reach the later resource phase without requiring an entrypoint.

```ts
async function readDevelopmentPlugin(
  directory: string,
  budget: SourceReadBudget,
): Promise<SourceRead> {
  const fallback = path.basename(directory);
  const invalid = (message: string, code: PluginErrorCode = "PLUGIN_E_MANIFEST"): SourceRead => ({
    id: fallback,
    source: "development",
    directory,
    problems: [problem(code, message)],
  });
  let root: string;
  let value: unknown;
  try {
    root = await realpath(directory);
    budget.check();
    value = (await readPackagedJson(root, MANIFEST_FILE, PLUGIN_LIMITS.manifestBytes, budget))
      .value;
  } catch (error) {
    return invalid(`Cannot read ${MANIFEST_FILE}: ${messageOf(error)}`);
  }
  const plugin = { ...checkManifest(value, "development", fallback), directory: root };
  const runtime = plugin.manifest?.runtime;
  if (plugin.problems.length || !runtime || runtime.kind === "builtin" || runtime.kind === "static")
    return plugin;
  try {
    const entry = await realpath(path.resolve(root, runtime.entry));
    budget.check();
    const relative = path.relative(root, entry);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      return {
        ...plugin,
        problems: [
          problem("PLUGIN_E_ENTRY", `${runtime.entry} resolves outside the plugin folder.`),
        ],
      };
    return { ...plugin, entry };
  } catch {
    return {
      ...plugin,
      problems: [problem("PLUGIN_E_ENTRY", `Entry file ${runtime.entry} was not found.`)],
    };
  }
}

export async function readSource(
  source: PluginSource,
  options: { safeMode: boolean; timeoutMs?: number },
): Promise<ReadPlugin> {
  const resourceBudget = new SourceReadBudget(options.timeoutMs ?? SOURCE_READ_TIMEOUT_MS);
  if (source.kind === "builtin") {
    const plugin = await resourceBudget.run(async () =>
      checkManifest(source.manifest, "builtin", "builtin"),
    );
    if (plugin.problems.length)
      throw new Error(
        `Invalid built-in plugin manifest: ${plugin.problems.map((item) => item.message).join("; ")}`,
      );
    return { ...plugin, sourceKey: `builtin:${plugin.id}`, resourceBudget };
  }
  const directory = path.resolve(source.directory);
  const placeholder = {
    sourceKey: developmentSourceKey(directory),
    id: path.basename(directory),
    source: "development" as const,
    directory,
  };
  if (options.safeMode) return { ...placeholder, problems: [], unread: true };
  try {
    const read = await resourceBudget.run(() => readDevelopmentPlugin(directory, resourceBudget));
    return { ...read, sourceKey: placeholder.sourceKey, resourceBudget };
  } catch {
    return {
      ...placeholder,
      problems: [
        problem(
          "PLUGIN_E_SOURCE_TIMEOUT",
          `Reading ${MANIFEST_FILE} did not finish within ${options.timeoutMs ?? SOURCE_READ_TIMEOUT_MS} ms.`,
        ),
      ],
    };
  }
}
```

- [ ] **Step 4: Run reader/registry regressions, expect PASS**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime exec vitest run src/packaged-json-resource.test.ts src/diagnostic-help.test.ts src/registry.test.ts src/registry.timeout.test.ts src/compiler-resolution.test.ts src/language-service-conformance.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --write packages/plugin-runtime/src/packaged-json-resource.ts packages/plugin-runtime/src/packaged-json-resource.test.ts packages/plugin-runtime/src/test-static-languages.ts packages/plugin-runtime/src/registry.ts packages/plugin-runtime/src/diagnostic-help.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec eslint packages/plugin-runtime/src/packaged-json-resource.ts packages/plugin-runtime/src/packaged-json-resource.test.ts packages/plugin-runtime/src/test-static-languages.ts packages/plugin-runtime/src/registry.ts packages/plugin-runtime/src/diagnostic-help.ts
```

Expected: PASS. The manager's existing help tests are restored in 2.3 when its resource phase is connected; do not claim the whole package passes at this intermediate commit. The shared, cumulative source allowance bounds I/O waiting; it cannot interrupt synchronous regex work and is not an OS sandbox.

- [ ] **Step 5: Commit (controller only)**

```bash
git add packages/plugin-runtime/src/packaged-json-resource.ts packages/plugin-runtime/src/packaged-json-resource.test.ts packages/plugin-runtime/src/test-static-languages.ts packages/plugin-runtime/src/registry.ts packages/plugin-runtime/src/diagnostic-help.ts
git commit -m "refactor(plugin-runtime): separate metadata and bound packaged JSON reads"
```

#### 2.2 Assemble the complete ownership graph and bounded catalog

- [ ] **Step 1: Write orchestration tests against the frozen T1 double**

Create `packages/plugin-runtime/src/static-languages.test.ts`:

```ts
import { expect, it, vi } from "vitest";
import {
  STATIC_LANGUAGE_LIMITS_V1 as L,
  staticLanguageDeclarationProblems,
  validateStaticLanguageResources,
  type PluginManifest,
} from "@kobrixa/plugin-protocol";
import { readSource, resolvePlugins, type PluginSource } from "./registry.js";
import { buildStaticLanguageCatalog } from "./static-language-catalog.js";
import { acceptFixture, builtinToy } from "./test-static-languages.js";

vi.mock("@kobrixa/plugin-protocol", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kobrixa/plugin-protocol")>()),
  staticLanguageDeclarationProblems: vi.fn(() => []),
  validateStaticLanguageResources: vi.fn((input) => acceptFixture(input)),
}));

async function build(sources: PluginSource[], disabled = new Set<string>()) {
  const reads = await Promise.all(sources.map((source) => readSource(source, { safeMode: false })));
  const resolved = resolvePlugins(reads, { disabled, safeMode: false });
  return buildStaticLanguageCatalog(
    sources.map((source, i) => ({ source, plugin: resolved[i]!, generation: 0 })),
    new Set(),
  );
}

it("retains frontend reservation after resource failure in either source order", async () => {
  const owner = builtinToy("test.owner", "bp", ["bp"]);
  const manifest = owner.manifest as PluginManifest;
  manifest.contributes!.frontends = [
    {
      language: "bp",
      entryExtensions: ["bp"],
      sourceExtensions: ["bp"],
      ir: { min: 1, max: 1 },
    },
  ];
  manifest.contributes!.languageServices = [
    { language: "bp", extensions: ["bp"], capabilities: ["analysis"] },
  ];
  owner.resources = {};
  const impostor = builtinToy("test.impostor", "bp", ["bp"]);
  const other = builtinToy("test.other", "other", ["bp"]);
  for (const order of [
    [owner, impostor, other],
    [other, impostor, owner],
  ]) {
    const result = await build(order);
    expect(result.catalog.languages.map((language) => language.id)).toEqual(["other"]);
    expect(result.catalog.conflicts).toContainEqual({
      kind: "frontend-owner",
      key: "bp",
      sources: [
        { pluginId: "test.impostor", sourceKey: "builtin:test.impostor", languageId: "bp" },
        { pluginId: "test.owner", sourceKey: "builtin:test.owner", languageId: "bp" },
      ],
    });
    expect(result.problems.get("builtin:test.owner")).toContainEqual(
      expect.objectContaining({
        code: "PLUGIN_E_STATIC_LANGUAGE",
        detail: expect.objectContaining({ languageId: "bp" }),
      }),
    );
    // The foreign /bp global route is retained, but there is no static record matching
    // the selected owner. T4/T8 prove its applicable binding therefore falls to plaintext.
    expect(result.catalog.languages.some((language) => language.pluginId === "test.owner")).toBe(
      false,
    );
  }
});

it("resolves id conflicts from declarations, even when one resource is missing", async () => {
  const a = builtinToy("test.a");
  const b = builtinToy("test.b");
  b.resources = {};
  for (const order of [
    [a, b],
    [b, a],
  ]) {
    const result = await build(order);
    expect(result.catalog.languages).toEqual([]);
    expect(result.catalog.conflicts).toEqual([
      {
        kind: "id",
        key: "toy",
        sources: [
          { pluginId: "test.a", sourceKey: "builtin:test.a", languageId: "toy" },
          { pluginId: "test.b", sourceKey: "builtin:test.b", languageId: "toy" },
        ],
      },
    ]);
  }
});

it("keeps both owners and unique routes when extensions are ambiguous", async () => {
  const a = builtinToy("test.a", "toy-a", ["toy", "ta"]);
  const b = builtinToy("test.b", "toy-b", ["toy", "tb"]);
  const first = await build([a, b]);
  const reversed = await build([b, a]);
  expect(reversed.catalog).toEqual(first.catalog);
  expect(first.catalog.languages).toHaveLength(2);
  expect(first.catalog.extensionRoutes).toEqual({ toy: null, ta: "toy-a", tb: "toy-b" });
  expect(first.catalog.conflicts[0]?.sources).toHaveLength(2);
});

it("reserves installed core ids and only removes the reserved json extension", async () => {
  const result = await build([
    builtinToy("test.json", "json"),
    builtinToy("test.plain", "plaintext"),
    builtinToy("test.js", "javascript"),
    builtinToy("test.good", "toy", ["json", "toy"]),
  ]);
  expect(result.catalog.languages.map((language) => language.id)).toEqual(["toy"]);
  expect(result.catalog.extensionRoutes).toEqual({ toy: "toy" });
  expect(result.catalog.conflicts.map(({ kind, key }) => [kind, key])).toEqual([
    ["reserved-extension", "json"],
    ["reserved-id", "javascript"],
    ["reserved-id", "json"],
    ["reserved-id", "plaintext"],
  ]);
});

it("uses exact raw keys, stable byte digests, and host identity", async () => {
  const source = builtinToy();
  const first = await build([source]);
  const language = first.catalog.languages[0]!;
  expect(language).toMatchObject({
    pluginId: "test.toy",
    sourceKey: "builtin:test.toy",
    generation: 0,
    aliases: ["Toy"],
  });
  expect(language).not.toHaveProperty("directory");
  expect(language.resourceBytes.tokenizer).toBe(
    Buffer.byteLength(source.resources["language/tokenizer.json"]!),
  );
  source.resources = {
    ...source.resources,
    "language/tokenizer.json": source.resources["language/tokenizer.json"]! + " ",
  };
  expect((await build([source])).catalog.languages[0]!.resourceDigest).not.toBe(
    language.resourceDigest,
  );
  source.resources = { "unreferenced.json": "{}" };
  expect((await build([source])).catalog.languages).toEqual([]);
});

it("preserves validator field/limit detail and contains resource failures", async () => {
  vi.mocked(validateStaticLanguageResources).mockReturnValueOnce({
    ok: false,
    problems: [
      {
        message: "Include cycle: root -> child -> root.",
        detail: {
          languageId: "toy",
          resourcePath: "language/tokenizer.json",
          fieldPath: "states[0].rules[0].include",
        },
      },
    ],
  });
  const result = await build([builtinToy()]);
  expect(result.problems.get("builtin:test.toy")?.[0]).toMatchObject({
    code: "PLUGIN_E_STATIC_LANGUAGE",
    message: expect.stringContaining("test.toy"),
    detail: {
      languageId: "toy",
      resourcePath: "language/tokenizer.json",
      fieldPath: "states[0].rules[0].include",
    },
  });
  expect(result.catalog.languages).toEqual([]);
  expect(vi.mocked(staticLanguageDeclarationProblems)).toHaveBeenCalled();
});

it("counts repeated resource references, rejects an over-budget language and continues", async () => {
  const source = builtinToy();
  const manifest = source.manifest as PluginManifest;
  const declaration = manifest.contributes!.languages![0]!;
  manifest.contributes!.languages = ["a", "b", "c"].map((id) => ({
    ...declaration,
    id,
    extensions: [id],
  }));
  source.resources = {
    "language/tokenizer.json": JSON.stringify({}) + " ".repeat(L.resourceFileBytes - 2),
    "language/configuration.json": "{}",
  };
  const result = await build([source]);
  expect(result.catalog.languages.map((language) => language.id)).toEqual(["a"]);
  expect(result.problems.get("builtin:test.toy")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        detail: expect.objectContaining({
          languageId: "b",
          limit: "STATIC_LANGUAGE_LIMITS_V1.resourceBytesPerPlugin",
          allowed: L.resourceBytesPerPlugin,
          actual: (L.resourceFileBytes + 2) * 2,
        }),
      }),
    ]),
  );
});

it("enforces the exact per-language, global byte, id and expanded-rule boundaries", async () => {
  const padded = (bytes: number) => "{}" + " ".repeat(bytes - 2);
  const pair = builtinToy();
  pair.resources = {
    "language/tokenizer.json": padded(L.resourceFileBytes),
    "language/configuration.json": padded(L.resourceBytesPerLanguage - L.resourceFileBytes),
  };
  expect((await build([pair])).catalog.languages).toHaveLength(1);
  pair.resources = {
    ...pair.resources,
    "language/configuration.json": pair.resources["language/configuration.json"]! + " ",
  };
  expect((await build([pair])).problems.get("builtin:test.toy")?.[0]?.detail).toMatchObject({
    limit: "STATIC_LANGUAGE_LIMITS_V1.resourceBytesPerLanguage",
    allowed: L.resourceBytesPerLanguage,
    actual: L.resourceBytesPerLanguage + 1,
  });
  const sources = Array.from({ length: 17 }, (_, i) => {
    const source = builtinToy(`test.p${String(i).padStart(3, "0")}`, `lang${i}`, [`x${i}`]);
    source.resources = {
      "language/tokenizer.json": padded(L.resourceFileBytes - 2),
      "language/configuration.json": "{}",
    };
    return source;
  });
  const bytes = await build(sources.reverse());
  expect(bytes.catalog.languages).toHaveLength(16);
  expect(bytes.problems.get("builtin:test.p016")?.[0]?.detail).toMatchObject({
    limit: "STATIC_LANGUAGE_LIMITS_V1.resourceBytesTotal",
  });
  const ids = await build(
    Array.from({ length: 129 }, (_, i) =>
      builtinToy(`test.i${String(i).padStart(3, "0")}`, `lang${i}`, [`x${i}`]),
    ),
  );
  expect(ids.catalog.languages).toHaveLength(128);
  expect(ids.problems.get("builtin:test.i128")?.[0]?.detail?.limit).toBe(
    "STATIC_LANGUAGE_LIMITS_V1.languagesTotal",
  );
  vi.mocked(validateStaticLanguageResources).mockImplementation((input) => ({
    ...acceptFixture(input),
    ok: true,
    tokenizer: input.tokenizer as typeof import("./test-static-languages.js").tokenizer,
    configuration: {},
    resourceBytes: input.resourceBytes,
    rules: 3,
    regexes: 3,
    expandedRules: L.expandedRulesPerLanguage,
  }));
  const rules = await build(
    Array.from({ length: 9 }, (_, i) => builtinToy(`test.r${i}`, `lang${i}`, [`x${i}`])),
  );
  expect(rules.catalog.languages).toHaveLength(8);
  expect(rules.problems.get("builtin:test.r8")?.[0]?.detail?.limit).toBe(
    "STATIC_LANGUAGE_LIMITS_V1.expandedRulesTotal",
  );
  vi.mocked(validateStaticLanguageResources).mockImplementation(acceptFixture);
});
```

- [ ] **Step 2: Run the catalog tests, expect FAIL**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime exec vitest run src/static-languages.test.ts`

Expected: FAIL resolving `./static-language-catalog.js`. The required RF3 test name is exact; selected-binding/model behavior is explicitly deferred to T8.

- [ ] **Step 3: Implement complete-set ownership and streaming resource admission**

Append to T0's `packages/plugin-runtime/src/static-languages.ts`. This explicit list was read from the locked Monaco 0.57.0 `esm/vs/index.js` imports and their `register.js` files; `editor.tsx` and `monaco-services.ts` import the full `monaco-editor` entry. Reserve the actual installed ids, including ids with dots that cannot themselves pass the plugin id schema. Only `json` is a core extension route in this task; do not adopt Monaco's other implicit filename associations.

```ts
export const CORE_STATIC_LANGUAGE_IDS: readonly string[] = Object.freeze([
  "abap",
  "aes",
  "apex",
  "azcli",
  "bat",
  "bicep",
  "c",
  "cameligo",
  "clojure",
  "coffeescript",
  "cpp",
  "csharp",
  "csp",
  "css",
  "cypher",
  "dart",
  "dockerfile",
  "ecl",
  "elixir",
  "flow9",
  "freemarker2",
  "freemarker2.tag-angle.interpolation-bracket",
  "freemarker2.tag-angle.interpolation-dollar",
  "freemarker2.tag-auto.interpolation-bracket",
  "freemarker2.tag-auto.interpolation-dollar",
  "freemarker2.tag-bracket.interpolation-bracket",
  "freemarker2.tag-bracket.interpolation-dollar",
  "fsharp",
  "go",
  "graphql",
  "handlebars",
  "hcl",
  "html",
  "ini",
  "java",
  "javascript",
  "json",
  "julia",
  "kotlin",
  "less",
  "lexon",
  "liquid",
  "lua",
  "m3",
  "markdown",
  "mdx",
  "mips",
  "msdax",
  "mysql",
  "objective-c",
  "pascal",
  "pascaligo",
  "perl",
  "pgsql",
  "php",
  "pla",
  "plaintext",
  "postiats",
  "powerquery",
  "powershell",
  "proto",
  "pug",
  "python",
  "qsharp",
  "r",
  "razor",
  "redis",
  "redshift",
  "restructuredtext",
  "ruby",
  "rust",
  "sb",
  "scala",
  "scheme",
  "scss",
  "shell",
  "sol",
  "sparql",
  "sql",
  "st",
  "swift",
  "systemverilog",
  "tcl",
  "twig",
  "typescript",
  "typespec",
  "vb",
  "verilog",
  "wgsl",
  "xml",
  "yaml",
]);
```

Create `packages/plugin-runtime/src/static-language-catalog.ts`:

```ts
import { createHash } from "node:crypto";
import {
  STATIC_LANGUAGE_FORMAT_VERSION,
  STATIC_LANGUAGE_LIMITS_V1 as L,
  validateStaticLanguageResources,
  type StaticLanguageDecl,
} from "@kobrixa/plugin-protocol";
import type { PluginProblem } from "./errors.js";
import type { PluginSource, RegisteredPlugin } from "./registry.js";
import {
  PackagedResourceError,
  readBuiltinJson,
  readPackagedJson,
} from "./packaged-json-resource.js";
import {
  CORE_STATIC_LANGUAGE_IDS,
  emptyStaticLanguagesCatalog,
  type StaticLanguageConflict,
  type StaticLanguageSourceIdentity,
  type StaticLanguagesCatalog,
  type ValidatedStaticLanguage,
} from "./static-languages.js";

export type StaticCatalogEntry = {
  source: PluginSource;
  plugin: RegisteredPlugin;
  generation: number;
};
type Candidate = StaticLanguageSourceIdentity & { generation: number; extensions: string[] };
type Job = { entry: StaticCatalogEntry; declaration: StaticLanguageDecl };
export type StaticCatalogBuild = {
  catalog: StaticLanguagesCatalog;
  problems: Map<string, PluginProblem[]>;
  resourceProblems: Map<string, PluginProblem[]>;
  idConflicts: StaticLanguageConflict[];
  valid: Candidate[];
  enabledKey: string;
};
export const staticLanguageKey = (sourceKey: string, generation: number, languageId: string) =>
  JSON.stringify([sourceKey, generation, languageId]);
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const identity = (job: Job): StaticLanguageSourceIdentity => ({
  pluginId: job.entry.plugin.id,
  sourceKey: job.entry.plugin.sourceKey,
  languageId: job.declaration.id,
});
const uniqueSources = (sources: StaticLanguageSourceIdentity[]) =>
  [...new Map(sources.map((source) => [JSON.stringify(source), source])).values()].sort(
    (a, b) => order(a.sourceKey, b.sourceKey) || order(a.languageId, b.languageId),
  );
function addProblem(
  problems: Map<string, PluginProblem[]>,
  sourceKey: string,
  value: PluginProblem,
): void {
  const list = problems.get(sourceKey) ?? [];
  list.push(value);
  problems.set(sourceKey, list);
}
function limitProblem(job: Job, key: keyof typeof L, actual: number): PluginProblem {
  const allowed = L[key];
  if (typeof allowed !== "number") throw new Error("Expected a numeric static language limit.");
  return {
    code: "PLUGIN_E_STATIC_LANGUAGE",
    message: `${job.entry.plugin.id} / ${job.declaration.id}: STATIC_LANGUAGE_LIMITS_V1.${key} exceeded (actual ${actual}, allowed ${allowed}).`,
    detail: {
      languageId: job.declaration.id,
      resourcePath: job.declaration.tokenizer.path,
      limit: `STATIC_LANGUAGE_LIMITS_V1.${key}`,
      allowed,
      actual,
    },
  };
}

// Projection is synchronous so a renderer report can revoke immediately while an I/O pass is pending.
export function projectStaticLanguageCatalog(
  build: StaticCatalogBuild,
  keep: (sourceKey: string, generation: number) => boolean = () => true,
  quarantined: ReadonlyMap<string, PluginProblem> = new Map(),
): StaticCatalogBuild {
  const usable = (sourceKey: string, generation: number, id: string) =>
    keep(sourceKey, generation) && !quarantined.has(staticLanguageKey(sourceKey, generation, id));
  const valid = build.valid.filter((item) =>
    usable(item.sourceKey, item.generation, item.languageId),
  );
  const languages = build.catalog.languages.filter((item) =>
    usable(item.sourceKey, item.generation, item.id),
  );
  const conflicts = [...build.idConflicts];
  const extensions = new Map<string, Candidate[]>();
  for (const candidate of valid)
    for (const extension of candidate.extensions) {
      const group = extensions.get(extension) ?? [];
      group.push(candidate);
      extensions.set(extension, group);
    }
  const admitted = new Set(languages.map((language) => language.id));
  const routes: [string, string | null][] = [];
  for (const [extension, group] of [...extensions].sort(([a], [b]) => order(a, b))) {
    const sources = uniqueSources(
      group.map(({ pluginId, sourceKey, languageId }) => ({ pluginId, sourceKey, languageId })),
    );
    if (extension === "json")
      conflicts.push({ kind: "reserved-extension", key: extension, sources });
    else if (sources.length > 1) {
      conflicts.push({ kind: "extension", key: extension, sources });
      routes.push([extension, null]);
    } else if (admitted.has(sources[0]!.languageId))
      routes.push([extension, sources[0]!.languageId]);
  }
  conflicts.sort((a, b) => order(a.kind, b.kind) || order(a.key, b.key));
  const problems = new Map<string, PluginProblem[]>(
    [...build.resourceProblems].map(([key, items]) => [key, [...items]]),
  );
  for (const conflict of conflicts)
    for (const source of conflict.sources)
      addProblem(problems, source.sourceKey, {
        code: "PLUGIN_E_STATIC_LANGUAGE_CONFLICT",
        message: `${source.pluginId} / ${source.languageId}: ${conflict.kind} conflict for ${conflict.key}.`,
        detail: { languageId: source.languageId, conflictingSources: conflict.sources },
      });
  for (const [key, problem] of quarantined) {
    const [sourceKey, generation] = JSON.parse(key) as [string, number, string];
    if (keep(sourceKey, generation)) addProblem(problems, sourceKey, problem);
  }
  return {
    ...build,
    problems,
    catalog: {
      ...build.catalog,
      languages,
      extensionRoutes: Object.fromEntries(routes),
      conflicts,
    },
  };
}

export async function buildStaticLanguageCatalog(
  entries: readonly StaticCatalogEntry[],
  quarantined: ReadonlySet<string>,
  current: () => boolean = () => true,
): Promise<StaticCatalogBuild> {
  const enabled = entries
    .filter(({ plugin }) => plugin.status === "enabled")
    .sort((a, b) => order(a.plugin.sourceKey, b.plugin.sourceKey));
  const jobs: Job[] = [];
  const frontends = new Map<string, StaticLanguageSourceIdentity>();
  const ids = new Map<string, Job[]>();
  for (const entry of enabled) {
    for (const frontend of entry.plugin.manifest?.contributes?.frontends ?? [])
      frontends.set(frontend.language, {
        pluginId: entry.plugin.id,
        sourceKey: entry.plugin.sourceKey,
        languageId: frontend.language,
      });
    for (const declaration of [...(entry.plugin.manifest?.contributes?.languages ?? [])].sort(
      (a, b) => order(a.id, b.id),
    )) {
      const job = { entry, declaration };
      jobs.push(job);
      const group = ids.get(declaration.id) ?? [];
      group.push(job);
      ids.set(declaration.id, group);
    }
  }
  const blocked = new Set<Job>();
  const idConflicts: StaticLanguageConflict[] = [];
  for (const [id, group] of ids) {
    const owner = frontends.get(id);
    if (CORE_STATIC_LANGUAGE_IDS.includes(id)) {
      group.forEach((job) => blocked.add(job));
      idConflicts.push({
        kind: "reserved-id",
        key: id,
        sources: uniqueSources(group.map(identity)),
      });
    } else if (owner) {
      const foreign = group.filter(
        (job) =>
          job.entry.plugin.sourceKey !== owner.sourceKey || job.entry.plugin.id !== owner.pluginId,
      );
      foreign.forEach((job) => blocked.add(job));
      if (foreign.length)
        idConflicts.push({
          kind: "frontend-owner",
          key: id,
          sources: uniqueSources([owner, ...foreign.map(identity)]),
        });
    } else if (group.length > 1) {
      group.forEach((job) => blocked.add(job));
      idConflicts.push({ kind: "id", key: id, sources: uniqueSources(group.map(identity)) });
    }
  }
  const resourceProblems = new Map<string, PluginProblem[]>();
  const languages: ValidatedStaticLanguage[] = [];
  const valid: Candidate[] = [];
  const pluginBytes = new Map<string, number>();
  let totalBytes = 0;
  let totalRules = 0;
  // One in-flight resource job: no Promise.all over raw resources. Each read resumes
  // only its source's remaining allowance; every other source's budget is paused.
  // Rejected payloads leave this iteration; only admitted payloads remain retained.
  for (const job of jobs) {
    if (!current()) throw new Error("Superseded static language operation.");
    const { entry, declaration: decl } = job;
    const { plugin, generation, source } = entry;
    if (
      blocked.has(job) ||
      quarantined.has(staticLanguageKey(plugin.sourceKey, generation, decl.id))
    )
      continue;
    let resourcePath = decl.tokenizer.path;
    try {
      const budget = plugin.resourceBudget;
      if (!budget) throw new Error("No current source read budget.");
      const read = (file: string) => budget.run(async () => {
        if (source.kind === "builtin")
          return readBuiltinJson(source.resources, file, L.resourceFileBytes);
        return readPackagedJson(plugin.directory!, file, L.resourceFileBytes, budget);
      });
      const tokenizer = await read(decl.tokenizer.path);
      resourcePath = decl.configuration.path;
      const configuration = await read(decl.configuration.path);
      if (!current()) throw new Error("Superseded static language operation.");
      budget.check();
      const bytes = tokenizer.bytes + configuration.bytes;
      if (bytes > L.resourceBytesPerLanguage) {
        addProblem(
          resourceProblems,
          plugin.sourceKey,
          limitProblem(job, "resourceBytesPerLanguage", bytes),
        );
        continue;
      }
      const validation = validateStaticLanguageResources({
        languageId: decl.id,
        formatVersion: STATIC_LANGUAGE_FORMAT_VERSION,
        limitsVersion: 1,
        tokenizer: tokenizer.value,
        configuration: configuration.value,
        resourceBytes: { tokenizer: tokenizer.bytes, configuration: configuration.bytes },
        resourcePaths: { tokenizer: decl.tokenizer.path, configuration: decl.configuration.path },
      });
      if (!validation.ok) {
        for (const problem of validation.problems)
          addProblem(resourceProblems, plugin.sourceKey, {
            code: "PLUGIN_E_STATIC_LANGUAGE",
            message: `${plugin.id} / ${decl.id}: ${problem.message}`,
            detail: { ...problem.detail, languageId: decl.id },
          });
        continue;
      }
      valid.push({ ...identity(job), generation, extensions: [...decl.extensions] });
      const nextPluginBytes = (pluginBytes.get(plugin.sourceKey) ?? 0) + bytes;
      const checks: [keyof typeof L, number][] = [
        ["resourceBytesPerPlugin", nextPluginBytes],
        ["resourceBytesTotal", totalBytes + bytes],
        ["languagesTotal", languages.length + 1],
        ["expandedRulesTotal", totalRules + validation.expandedRules],
      ];
      const exceeded = checks.find(
        ([key, actual]) => typeof L[key] === "number" && actual > (L[key] as number),
      );
      if (exceeded) {
        addProblem(resourceProblems, plugin.sourceKey, limitProblem(job, exceeded[0], exceeded[1]));
        continue;
      }
      pluginBytes.set(plugin.sourceKey, nextPluginBytes);
      totalBytes += bytes;
      totalRules += validation.expandedRules;
      languages.push({
        pluginId: plugin.id,
        sourceKey: plugin.sourceKey,
        generation,
        id: decl.id,
        extensions: [...decl.extensions],
        aliases: [...(decl.aliases ?? [])],
        resourceDigest: createHash("sha256")
          .update(`${tokenizer.digest}:${configuration.digest}`)
          .digest("hex"),
        tokenizer: validation.tokenizer,
        configuration: validation.configuration,
        resourceBytes: { tokenizer: tokenizer.bytes, configuration: configuration.bytes },
        expandedRules: validation.expandedRules,
      });
    } catch (error) {
      if (!current()) throw error;
      const detail: NonNullable<PluginProblem["detail"]> = { languageId: decl.id, resourcePath };
      if (error instanceof PackagedResourceError && error.limit !== undefined) {
        detail.limit = `STATIC_LANGUAGE_LIMITS_V1.${error.limit}`;
        if (error.allowed !== undefined) detail.allowed = error.allowed;
        if (error.actual !== undefined) detail.actual = error.actual;
      }
      // Do not forward filesystem exceptions: their messages can contain physical paths.
      const reason =
        error instanceof Error && error.message.includes("deadline")
          ? "source resource deadline exceeded"
          : "invalid or unreadable packaged JSON resource";
      addProblem(resourceProblems, plugin.sourceKey, {
        code: "PLUGIN_E_STATIC_LANGUAGE",
        message: `${plugin.id} / ${decl.id} / ${resourcePath}: ${reason}.`,
        detail,
      });
    }
  }
  return projectStaticLanguageCatalog({
    catalog: { ...emptyStaticLanguagesCatalog(), languages },
    problems: new Map(),
    resourceProblems,
    valid,
    idConflicts,
    enabledKey: JSON.stringify(
      enabled.map(({ plugin, generation }) => [plugin.sourceKey, plugin.id, generation]),
    ),
  });
}
```

The thin `valid` records retain complete extension-conflict evidence even when a valid candidate loses a budget allocation; a budget rejection cannot silently make the other claimant a winner. No rejected raw JSON or expanded rule array remains in the build. Original path references are charged per language, including repeated paths. Budget allocation is `(sourceKey, languageId)` order and never resolves an id/extension conflict. Include expansion, AST analysis, per-language rule counts and semantic structure remain the T1 validator's responsibility.

- [ ] **Step 4: Run catalog tests, expect PASS; format and lint**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime exec vitest run src/static-languages.test.ts src/packaged-json-resource.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --write packages/plugin-runtime/src/static-languages.ts packages/plugin-runtime/src/static-language-catalog.ts packages/plugin-runtime/src/static-languages.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec eslint packages/plugin-runtime/src/static-languages.ts packages/plugin-runtime/src/static-language-catalog.ts packages/plugin-runtime/src/static-languages.test.ts
```

Expected: PASS with T0 plus the explicit fixture doubles. No Monaco import, document tokenization, regex `.test()` sampling, product fixture or T1 branch is involved.

- [ ] **Step 5: Commit (controller only)**

```bash
git add packages/plugin-runtime/src/static-languages.ts packages/plugin-runtime/src/static-language-catalog.ts packages/plugin-runtime/src/static-languages.test.ts
git commit -m "feat(plugin-runtime): build bounded static language catalogs with complete ownership"
```

#### 2.3 Publish atomic revisions, preserve process independence and quarantine reports

- [ ] **Step 1: Add manager tests with real filesystem fixtures and mocked T1 semantics**

Create `packages/plugin-runtime/src/manager.static-languages.test.ts`:

```ts
import { mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  staticLanguageDeclarationProblems,
  validateStaticLanguageResources,
  type PluginManifest,
} from "@kobrixa/plugin-protocol";
import { PluginManager, type PluginManagerOptions, type PluginStateStore } from "./manager.js";
import { developmentSourceKey, readSource } from "./registry.js";
import {
  acceptFixture,
  builtinToy,
  developmentToy,
  toyManifest,
  writeManifest,
} from "./test-static-languages.js";
import { memoryPlugin } from "./test-process.js";

vi.mock("@kobrixa/plugin-protocol", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kobrixa/plugin-protocol")>()),
  staticLanguageDeclarationProblems: vi.fn(() => []),
  validateStaticLanguageResources: vi.fn((input) => acceptFixture(input)),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), realpath: vi.fn(actual.realpath) };
});
// Wrap the real metadata reader only to observe when healthy sources finish;
// filesystem I/O, SourceReadBudget and both manager orchestration paths remain real.
vi.mock("./registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./registry.js")>();
  return { ...actual, readSource: vi.fn(actual.readSource) };
});

let root: string;
const managers: PluginManager[] = [];
const launcher = vi.fn();
const store = (disabled: string[] = [], legacy: string[] = []): PluginStateStore => ({
  load: async () => ({ disabled: new Set(disabled), legacyDisabledIds: new Set(legacy) }),
  save: vi.fn(async () => {}),
});
async function create(
  sources: PluginManagerOptions["sources"],
  overrides: Partial<PluginManagerOptions> = {},
) {
  const manager = await PluginManager.create({
    sources,
    store: store(),
    safeMode: false,
    locale: "en",
    launcher,
    ...overrides,
  });
  managers.push(manager);
  return manager;
}
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-static-manager-"));
  vi.clearAllMocks();
  vi.mocked(staticLanguageDeclarationProblems).mockReturnValue([]);
  vi.mocked(validateStaticLanguageResources).mockImplementation(acceptFixture);
});
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  await rm(root, { recursive: true, force: true });
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

for (const phase of ["startup", "refresh"] as const)
  for (const stage of ["metadata", "resource"] as const)
    it.each([false, true])(`isolates slow ${stage} during ${phase} in either source order (reverse: %s)`, async (reverse) => {
      // Pick the slow development source by sorted sourceKey so its resources
      // precede the healthy development source in the deterministic resource queue.
      const folders = await Promise.all([developmentToy(root, "a"), developmentToy(root, "b")]);
      folders.sort((a, b) => developmentSourceKey(a.directory).localeCompare(developmentSourceKey(b.directory)));
      const slow = folders[0]!;
      const healthy = folders[1]!;
      const slowKey = developmentSourceKey(slow.directory);
      const healthyKey = developmentSourceKey(healthy.directory);
      const slowManifest = structuredClone(toyManifest);
      slowManifest.id = "acme.slow";
      const declaration = slowManifest.contributes!.languages![0]!;
      slowManifest.contributes!.languages = ["a-ready", "b-slow", "c-unread"].map((id) => ({
        ...declaration, id, extensions: [id.replaceAll("-", "")],
        configuration: { version: 1, path: id === "b-slow" ? "slow.json" : declaration.configuration.path },
      }));
      await writeManifest(slow.directory, slowManifest);
      await writeFile(path.join(slow.directory, "slow.json"), "{}");
      const healthyManifest = structuredClone(toyManifest);
      healthyManifest.id = "acme.healthy";
      healthyManifest.contributes!.languages![0]!.id = "healthy-dev";
      healthyManifest.contributes!.languages![0]!.extensions = ["healthydev"];
      await writeManifest(healthy.directory, healthyManifest);
      const bundled = builtinToy("test.healthy", "healthy-builtin", ["healthybuiltin"]);
      const sources = reverse ? [healthy, bundled, slow] : [slow, bundled, healthy];
      const blockedPath = path.join(await realpath(slow.directory), stage === "metadata" ? "kobrixa-plugin.json" : "slow.json");
      let manager = phase === "refresh" ? await create(sources) : undefined;
      const actualOpen = vi.mocked(open).getMockImplementation()!;
      const actualReadSource = vi.mocked(readSource).getMockImplementation()!;
      const held = deferred();
      const entered = deferred();
      const healthyMetadata = deferred();
      const lateClosed = deferred();
      const completed = new Set<string>();
      let blocked = false;
      let elapsed = 0;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
      vi.mocked(readSource).mockImplementation(async (...args) => {
        const read = await actualReadSource(...args);
        if (read.sourceKey === healthyKey || read.sourceKey === "builtin:test.healthy") {
          completed.add(read.sourceKey);
          if (completed.size === 2) healthyMetadata.resolve();
        }
        return read;
      });
      vi.mocked(open).mockImplementation(async (...args) => {
        const handle = await actualOpen(...args);
        if (!blocked && String(args[0]) === blockedPath) {
          blocked = true;
          const close = handle.close.bind(handle);
          handle.close = async () => { await close(); lateClosed.resolve(); };
          entered.resolve();
          await held.promise;
        }
        return handle;
      });
      const operation = manager
        ? manager.setEnabled(healthyKey, true)
        : create(sources).then((created) => { manager = created; });
      let settled = false;
      void operation.then(() => { settled = true; });
      try {
        await Promise.all([entered.promise, healthyMetadata.promise]);
        elapsed += 4999;
        await vi.advanceTimersByTimeAsync(4999);
        expect(settled).toBe(false);
        elapsed += 1;
        await vi.advanceTimersByTimeAsync(1);
        await operation;
        const catalog = manager!.staticLanguages();
        expect(catalog.languages.map((item) => item.id).sort()).toEqual(
          stage === "metadata"
            ? ["healthy-builtin", "healthy-dev"]
            : ["a-ready", "healthy-builtin", "healthy-dev"],
        );
        const rows = manager!.state().plugins;
        for (const key of [healthyKey, "builtin:test.healthy"]) {
          expect(rows.find((row) => row.sourceKey === key)).toMatchObject({ status: "enabled", problems: [] });
        }
        const failed = rows.find((row) => row.sourceKey === slowKey)!;
        if (stage === "metadata") {
          expect(failed.status).toBe("invalid");
          expect(failed.problems.map((item) => item.code)).toEqual(["PLUGIN_E_SOURCE_TIMEOUT"]);
        } else {
          expect(failed.status).toBe("enabled");
          expect(failed.problems.map((item) => [item.code, item.detail?.languageId])).toEqual([
            ["PLUGIN_E_STATIC_LANGUAGE", "b-slow"],
            ["PLUGIN_E_STATIC_LANGUAGE", "c-unread"],
          ]);
          expect(failed.problems.every((item) => item.message.includes("deadline"))).toBe(true);
        }
        const snapshot = manager!.state();
        const validations = vi.mocked(validateStaticLanguageResources).mock.calls.length;
        held.resolve();
        await lateClosed.promise;
        await Promise.resolve();
        expect(manager!.staticLanguages()).toEqual(catalog);
        expect(manager!.state()).toEqual(snapshot);
        expect(validateStaticLanguageResources).toHaveBeenCalledTimes(validations);
        expect(launcher).not.toHaveBeenCalled();
      } finally {
        held.resolve();
        await operation;
        if (blocked) await lateClosed.promise;
        vi.mocked(open).mockImplementation(actualOpen);
        vi.mocked(readSource).mockImplementation(actualReadSource);
        clock.mockRestore();
        vi.useRealTimers();
      }
    });

it("loads static, node and python lexical contributions without launch or handshake", async () => {
  for (const kind of ["static", "node", "python"] as const) {
    const source = await developmentToy(root, kind);
    const manifest = structuredClone(toyManifest);
    if (kind !== "static") {
      manifest.runtime = { kind, entry: "main.js" };
      await writeFile(path.join(source.directory, "main.js"), "");
    }
    await writeManifest(source.directory, manifest);
    const manager = await create([source]);
    expect(manager.staticLanguages().languages).toHaveLength(1);
    expect(manager.state().plugins[0]).toMatchObject({
      runtime: kind,
      status: "enabled",
      running: false,
    });
    expect(manager.active).toBe(false);
  }
  expect(launcher).not.toHaveBeenCalled();
});

it("loads diagnosticHelp-only static runtime without an entrypoint", async () => {
  const source = await developmentToy(root);
  const manifest = structuredClone(toyManifest);
  manifest.contributes = { diagnosticHelp: { version: 1, path: "help.json" } };
  await writeManifest(source.directory, manifest);
  await writeFile(
    path.join(source.directory, "help.json"),
    JSON.stringify({
      entries: [
        {
          code: "TOY001",
          title: { en: "Help" },
          cause: { en: "Cause" },
          steps: { en: ["Retry"] },
        },
      ],
    }),
  );
  const manager = await create([source]);
  expect(manager.diagnosticHelp().plugins[0]?.entries[0]?.code).toBe("TOY001");
  expect(manager.staticLanguages().languages).toEqual([]);
  expect(manager.state().plugins[0]?.status).toBe("enabled");
  expect(launcher).not.toHaveBeenCalled();
});

it("checks source restrictions before static declaration semantics, including empty services", async () => {
  const source = await developmentToy(root);
  for (const languageServices of [
    [],
    [{ language: "toy", extensions: ["toy"], capabilities: ["analysis"] }],
  ]) {
    await writeFile(
      path.join(source.directory, "kobrixa-plugin.json"),
      JSON.stringify({
        ...toyManifest,
        runtime: { kind: "static", entry: "illegal.js" },
        contributes: { ...toyManifest.contributes, languageServices },
      }),
    );
    const read = await readSource(source, { safeMode: false });
    expect(read.problems.map((problem) => problem.code)).toEqual([
      "PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN",
    ]);
  }
  expect(staticLanguageDeclarationProblems).not.toHaveBeenCalled();
  await writeManifest(source.directory, toyManifest);
  vi.mocked(staticLanguageDeclarationProblems).mockReturnValueOnce([
    "Duplicate static language id.",
  ]);
  expect((await readSource(source, { safeMode: false })).problems[0]?.code).toBe(
    "PLUGIN_E_MANIFEST",
  );
});

it("reads settings first and reads no grammar for persisted or legacy-disabled sources", async () => {
  const source = await developmentToy(root);
  const key = developmentSourceKey(source.directory);
  for (const persisted of [store([key]), store([], ["acme.toy"])]) {
    vi.mocked(open).mockClear();
    vi.mocked(validateStaticLanguageResources).mockClear();
    const manager = await create([source], { store: persisted });
    expect(manager.state().plugins[0]?.status).toBe("disabled");
    expect(manager.staticLanguages().languages).toEqual([]);
    expect(
      vi
        .mocked(open)
        .mock.calls.some(([file]) => String(file).includes(`${path.sep}language${path.sep}`)),
    ).toBe(false);
    expect(validateStaticLanguageResources).not.toHaveBeenCalled();
  }
});

it("never touches third-party folders in safe mode or after corrupt settings", async () => {
  const source = await developmentToy(root);
  for (const options of [
    { safeMode: true },
    {
      store: {
        ...store(),
        load: async () => ({
          disabled: new Set<string>(),
          legacyDisabledIds: new Set<string>(),
          problem: "corrupt",
        }),
      },
    },
  ]) {
    vi.mocked(realpath).mockClear();
    const manager = await create([builtinToy(), source], options);
    expect(realpath).not.toHaveBeenCalled();
    expect(manager.state().safeMode).toBe(true);
    expect(manager.staticLanguages().languages.map((language) => language.pluginId)).toEqual([
      "test.toy",
    ]);
    expect(await manager.setEnabled(developmentSourceKey(source.directory), true)).toMatchObject({
      ok: false,
      code: "PLUGIN_E_SAFE_MODE",
    });
  }
});

it("atomically publishes detached catalogs and complete owners through disable, enable and removal", async () => {
  const a = await developmentToy(root, "a");
  const b = await developmentToy(root, "b");
  const second = structuredClone(toyManifest);
  second.id = "acme.second";
  second.contributes!.languages![0]!.id = "second";
  await writeManifest(b.directory, second);
  const manager = await create([a, b]);
  const first = manager.staticLanguages();
  expect(first.extensionRoutes.toy).toBeNull();
  expect(manager.state().staticLanguageOwners).toHaveLength(2);
  const key = developmentSourceKey(b.directory);
  const events: ReturnType<PluginManager["state"]>[] = [];
  manager.onEvent((event) => {
    if (event.type === "state") events.push(event.state);
  });
  await manager.setEnabled(key, false);
  expect(manager.staticLanguages().extensionRoutes.toy).toBe("toy");
  expect(manager.staticLanguagesRevision).toBeGreaterThan(first.revision);
  expect(events.at(-1)?.staticLanguageOwners.map((owner) => owner.languageId)).toEqual(["toy"]);
  await manager.setEnabled(key, true);
  expect(manager.staticLanguages().extensionRoutes.toy).toBeNull();
  first.languages[0]!.extensions.push("bad");
  manager.state().staticLanguageOwners[0]!.extensions.push("bad");
  expect(
    manager.staticLanguages().languages.some((language) => language.extensions.includes("bad")),
  ).toBe(false);
  await manager.removeSource(key);
  expect(manager.staticLanguages().extensionRoutes.toy).toBe("toy");
});

it("revokes before reload I/O and never restores old resources after a failed reload", async () => {
  const source = await developmentToy(root);
  const manager = await create([source]);
  const key = developmentSourceKey(source.directory);
  const first = manager.staticLanguages();
  const revisions: number[] = [];
  manager.onEvent((event) => {
    if (event.type === "state" && event.state.staticLanguageOwners.length === 0)
      revisions.push(event.state.staticLanguagesRevision);
  });
  await writeFile(path.join(source.directory, "language/configuration.json"), "{");
  await manager.reloadSource(key);
  expect(revisions.some((revision) => revision > first.revision)).toBe(true);
  expect(manager.staticLanguages().languages).toEqual([]);
  expect(manager.state().plugins[0]).toMatchObject({ status: "enabled", running: false });
  expect(manager.state().plugins[0]?.problems).toContainEqual(
    expect.objectContaining({
      code: "PLUGIN_E_STATIC_LANGUAGE",
      detail: { languageId: "toy", resourcePath: "language/configuration.json" },
    }),
  );
  await writeFile(path.join(source.directory, "language/configuration.json"), "{}");
  await manager.reloadSource(key);
  expect(manager.staticLanguages().languages[0]!.generation).toBeGreaterThan(
    first.languages[0]!.generation,
  );
});

it.each([false, true])("uses a fresh generation for explicit retry after failure (disable first: %s)", async (disableFirst) => {
  const source = await developmentToy(root);
  const manager = await create([source]);
  const language = manager.staticLanguages().languages[0]!;
  const report = {
    sourceKey: language.sourceKey,
    generation: language.generation,
    languageId: language.id,
    revision: manager.staticLanguagesRevision,
    reason: "monaco" as const,
    detail: "Provider rejected fixture.",
  };
  for (const bad of [
    { ...report, revision: report.revision - 1 },
    { ...report, generation: report.generation + 1 },
    { ...report, sourceKey: "builtin:forged" },
    { ...report, languageId: "foreign" },
  ])
    expect(manager.reportLanguageRegistrationFailure(bad).accepted).toBe(false);
  // Runtime-local consumer double for T4's permanent per-generation quarantine.
  // Real registrar/Monaco integration remains T8-owned.
  const identity = (item: typeof language) => JSON.stringify([
    item.pluginId, item.sourceKey, item.generation, item.id,
  ]);
  const quarantined = new Set([identity(language)]);
  const register = vi.fn();
  const offer = (item: typeof language) => {
    if (quarantined.has(identity(item))) return false;
    register(item);
    return true;
  };
  expect(manager.reportLanguageRegistrationFailure(report).accepted).toBe(true);
  const isolated = manager.staticLanguagesRevision;
  expect(manager.staticLanguages().languages).toEqual([]);
  expect(
    manager.reportLanguageRegistrationFailure({ ...report, revision: isolated }).accepted,
  ).toBe(false);
  expect(offer(language)).toBe(false);
  await Promise.resolve();
  expect(manager.staticLanguagesRevision).toBe(isolated);
  expect(register).not.toHaveBeenCalled();
  const other = await developmentToy(root, "other");
  const manifest = structuredClone(toyManifest);
  manifest.id = "acme.other";
  manifest.contributes!.languages![0]!.id = "other";
  manifest.contributes!.languages![0]!.extensions = ["other"];
  await writeManifest(other.directory, manifest);
  await manager.addSource(other);
  expect(manager.staticLanguages().languages.map((item) => item.id)).toEqual(["other"]);
  expect(
    manager.state().plugins.find((item) => item.sourceKey === language.sourceKey)?.problems,
  ).toContainEqual(
    expect.objectContaining({
      code: "PLUGIN_E_STATIC_LANGUAGE_REGISTRATION",
      detail: { languageId: "toy" },
    }),
  );
  if (disableFirst) {
    expect(await manager.setEnabled(language.sourceKey, false)).toMatchObject({ ok: true });
    expect(manager.state().plugins.find((item) => item.sourceKey === language.sourceKey)?.status).toBe("disabled");
  }
  expect(await manager.setEnabled(language.sourceKey, true)).toMatchObject({ ok: true });
  const recovered = manager.staticLanguages().languages.find((item) => item.id === language.id)!;
  expect(recovered.generation).toBeGreaterThan(language.generation);
  expect(manager.state().staticLanguageOwners).toContainEqual(expect.objectContaining({
    sourceKey: language.sourceKey, languageId: language.id, generation: recovered.generation,
  }));
  expect(offer(recovered)).toBe(true);
  expect(register).toHaveBeenCalledTimes(1);
  // Reject the old identity even if the reporter supplies the latest revision.
  expect(manager.reportLanguageRegistrationFailure({
    ...report, revision: manager.staticLanguagesRevision,
  }).accepted).toBe(false);
  expect(
    manager
      .staticLanguages()
      .languages.map((item) => item.id)
      .sort(),
  ).toEqual(["other", "toy"]);
  expect(manager.reportLanguageRegistrationFailure(report).accepted).toBe(false);
  const revision = manager.staticLanguagesRevision;
  await manager.setEnabled(language.sourceKey, true);
  expect(manager.staticLanguagesRevision).toBe(revision);
  expect(manager.staticLanguages().languages.find((item) => item.id === language.id)?.generation).toBe(recovered.generation);
});

it("keeps frontend services valid when static registration fails and builtins remain required", async () => {
  const source = builtinToy("test.owner", "toy", ["toy"]);
  const manifest = source.manifest as PluginManifest;
  manifest.contributes!.frontends = [
    {
      language: "toy",
      entryExtensions: ["toy"],
      sourceExtensions: ["toy"],
      ir: { min: 1, max: 1 },
    },
  ];
  manifest.contributes!.languageServices = [
    { language: "toy", extensions: ["toy"], capabilities: ["analysis"] },
  ];
  const manager = await create([source]);
  const before = manager.resolveLanguageService("toy");
  expect(before).toMatchObject({ ok: true });
  const language = manager.staticLanguages().languages[0]!;
  manager.reportLanguageRegistrationFailure({
    sourceKey: language.sourceKey,
    generation: language.generation,
    languageId: "toy",
    revision: manager.staticLanguagesRevision,
    reason: "session-language-ids",
    detail: "Restart window.",
  });
  expect(manager.resolveLanguageService("toy")).toEqual(before);
  expect(manager.state().plugins[0]?.problems[0]?.detail).toMatchObject({
    languageId: "toy",
    limit: "STATIC_LANGUAGE_LIMITS_V1.sessionLanguageIds",
    allowed: 256,
    actual: 257,
  });
  expect(await manager.setEnabled(language.sourceKey, false)).toMatchObject({
    ok: false,
    code: "PLUGIN_E_BUILTIN_REQUIRED",
  });
  expect(await manager.setEnabled(language.sourceKey, true)).toMatchObject({ ok: true });
  expect(manager.staticLanguages().languages[0]!.generation).toBeGreaterThan(language.generation);
  // Equality includes the original service epoch; lexical recovery cannot restart analysis.
  expect(manager.resolveLanguageService("toy")).toEqual(before);
  expect(launcher).not.toHaveBeenCalled();
});

it("preserves disabled state and quarantine when the enable save fails", async () => {
  const source = await developmentToy(root);
  const persisted = store();
  const manager = await create([source], { store: persisted });
  const language = manager.staticLanguages().languages[0]!;
  expect(manager.reportLanguageRegistrationFailure({
    sourceKey: language.sourceKey,
    generation: language.generation,
    languageId: language.id,
    revision: manager.staticLanguagesRevision,
    reason: "monaco",
    detail: "Rejected fixture.",
  }).accepted).toBe(true);
  // A failed disable save still takes effect in this session.
  vi.mocked(persisted.save).mockRejectedValueOnce(new Error("disk full"));
  expect(await manager.setEnabled(language.sourceKey, false)).toMatchObject({ ok: true, persisted: false });
  const disabled = manager.state();
  const catalog = manager.staticLanguages();
  vi.mocked(persisted.save).mockRejectedValueOnce(new Error("disk full"));
  expect(await manager.setEnabled(language.sourceKey, true)).toMatchObject({ ok: false, code: "PLUGIN_E_STATE_SAVE" });
  expect(manager.state()).toEqual(disabled);
  expect(manager.staticLanguages()).toEqual(catalog);
  expect(await manager.setEnabled(language.sourceKey, true)).toMatchObject({ ok: true });
  // Only successful recovery publishes a replacement identity; no extra generation is needed.
  expect(manager.staticLanguages().languages[0]!.generation).toBe(language.generation + 1);
});

it("reload after a registration failure always publishes a fresh generation", async () => {
  const source = await developmentToy(root);
  const manager = await create([source]);
  const language = manager.staticLanguages().languages[0]!;
  const report = {
    sourceKey: language.sourceKey, generation: language.generation, languageId: language.id,
    revision: manager.staticLanguagesRevision, reason: "adapter" as const, detail: "Rejected fixture.",
  };
  expect(manager.reportLanguageRegistrationFailure(report).accepted).toBe(true);
  expect(await manager.reloadSource(language.sourceKey)).toMatchObject({ ok: true });
  const recovered = manager.staticLanguages().languages[0]!;
  expect(recovered.generation).toBeGreaterThan(language.generation);
  expect(manager.reportLanguageRegistrationFailure({ ...report, revision: manager.staticLanguagesRevision }).accepted).toBe(false);
  expect(manager.reportLanguageRegistrationFailure({
    ...report, generation: recovered.generation, revision: manager.staticLanguagesRevision,
  }).accepted).toBe(true);
});

it("keeps static resources on a process crash and withdraws them on an actual disable", async () => {
  const source = await developmentToy(root);
  const manifest = structuredClone(toyManifest);
  manifest.runtime = { kind: "node", entry: "main.js" };
  manifest.contributes!.commands = [{ id: "acme.toy.run", title: "Run" }];
  await writeManifest(source.directory, manifest);
  await writeFile(path.join(source.directory, "main.js"), "");
  const crashing = vi.fn(
    async () =>
      memoryPlugin((peer, { exit }) => {
        peer.handle("initialize", () => ({
          apiVersion: "1.4.0",
          sdk: { name: "fixture", version: "1" },
        }));
        peer.handle("command/execute", () => {
          exit(1);
          return null;
        });
      }).process,
  );
  const manager = await create([source], { launcher: crashing, supervisor: { restartLimit: 1 } });
  const before = manager.staticLanguages();
  await manager.executeCommand("acme.toy.run");
  await vi.waitFor(() => expect(manager.state().plugins[0]?.status).toBe("failed"));
  expect(manager.staticLanguages()).toEqual(before);
  await manager.setEnabled(developmentSourceKey(source.directory), false);
  expect(manager.staticLanguages().languages).toEqual([]);
});
```

Update the **existing** `manager.test.ts` test `fails closed on a corrupt state store and recovers after a successful save` at lines 609–628. After the assertion that plugin statuses are `["enabled", "disabled"]`, replace its remaining assertions with the exact following assertions. This is the `manager.test.ts:609-628` modification listed in Files; all other existing tests remain unchanged:

```ts
expect(manager.state().safeMode).toBe(true);
expect(await manager.setEnabled(keyOf(hello), true)).toMatchObject({
  ok: false,
  code: "PLUGIN_E_SAFE_MODE",
});
expect(await manager.leaveSafeMode()).toMatchObject({ ok: true });
// Corruption conservatively disabled every development source; leaving safe mode does not undo that choice.
expect(manager.state().plugins[1]?.status).toBe("disabled");
expect(await manager.setEnabled(keyOf(hello), true)).toMatchObject({ ok: true });
expect(manager.state().stateProblem).toBeUndefined();
expect(savedDisabled(store).at(-1)).toEqual([]);
```

- [ ] **Step 2: Run manager tests, expect FAIL**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime exec vitest run src/manager.static-languages.test.ts src/manager.test.ts`

Expected: FAIL because T0's manager returns an empty catalog and `accepted: false`, corruption is not yet made an early safe-mode decision, and the help resource phase was removed from metadata in 2.1. Against the unrepaired recipe, the explicit-retry tests fail `recovered.generation > language.generation` in both enable branches; the isolation matrix loses healthy languages after slow metadata or resources. The matrix exercises startup and refresh with real source reads plus an injected clock and held file handles, not a mock catalog.

- [ ] **Step 3: Wire resource transactions into the existing manager**

Add these imports to `manager.ts`, retaining T0's type imports, existing supervisor/registry imports and `emptyStaticLanguagesCatalog`:

```ts
import { STATIC_LANGUAGE_LIMITS_V1 } from "@kobrixa/plugin-protocol";
import { readDiagnosticHelp } from "./diagnostic-help.js";
import {
  buildStaticLanguageCatalog,
  projectStaticLanguageCatalog,
  staticLanguageKey,
  type StaticCatalogBuild,
} from "./static-language-catalog.js";
```

Add this function after the existing `readOptions`. Metadata refreshes are once per source per lifecycle transaction. A fresh transaction gets one new cumulative source I/O allowance covering its metadata and all resource work. Reuse its paused budget through the metadata join and the serial resource/help queues; never construct a budget per resource. Process notifications and registration reports never trigger filesystem reads. Changes limited to lexical declarations, display labels or resource bytes do not retire an otherwise unchanged service/process provider.

```ts
function executionKey(read: ReadPlugin): string {
  const manifest = read.manifest;
  return JSON.stringify([
    read.id,
    read.entry,
    manifest?.runtime,
    manifest?.permissions,
    manifest?.activationEvents,
    manifest?.contributes?.commands,
    manifest?.contributes?.frontends,
    manifest?.contributes?.backends,
    manifest?.contributes?.languageServices,
  ]);
}
```

Add `staticGeneration` to `Entry` at `manager.ts:105-111`. Keep the existing `generation` for `resolveLanguageService` (`manager.ts:231-238`), help revisions (`531-567`) and supervisor callbacks (`596-636`); lexical retries must not invalidate those consumers:

```ts
interface Entry {
  readonly source: PluginSource;
  read: ReadPlugin;
  plugin: RegisteredPlugin;
  /** Execution/service generation; increases on reload or executable metadata change. */
  generation: number;
  /** Published as the frozen static DTO's generation; also increases on registration retry. */
  staticGeneration: number;
}
```

Replace the constructor's entry mapping at `manager.ts:193-198` with:

```ts
this.#entries = sources.map(({ source, read }) => ({
  source,
  read,
  plugin: unresolved(read),
  generation: 0,
  staticGeneration: 0,
}));
```

Add these fields to `PluginManager` after `#revision`:

```ts
#staticOperation = 0;
#staticCatalog = emptyStaticLanguagesCatalog();
#staticKey = "";
#staticBuild: StaticCatalogBuild = {
  catalog: emptyStaticLanguagesCatalog(), problems: new Map(), resourceProblems: new Map(),
  idConflicts: [], valid: [], enabledKey: "[]",
};
readonly #registrationFailures = new Map<string, PluginProblem>();
```

In `create`, immediately after loading/catching the store, define:

```ts
const safeMode = options.safeMode || stored.problem !== undefined;
```

Replace the existing metadata join at `manager.ts:170-172` with this code. Each `readSource` ends its active budget interval before resolving, so waiting for another source here cannot charge an already-completed source:

```ts
const reads = await Promise.all(
  options.sources.map((source) => readSource(source, readOptions(options, safeMode))),
);
```

Pass `{ ...options, safeMode }` to `new PluginManager` instead of `options`. Keep the existing `convertLegacy` operation before any resource read; after the existing `if (converted) await manager.#saveBestEffort()`, add:

```ts
await manager.#apply("cancelled", false);
```

Remove `this.#reconcile()` from the constructor. Its existing corrupt-store branch still records `PLUGIN_E_STATE_CORRUPT` and adds every development sourceKey to `#disabled`; constructor `#safeMode` now receives the early fail-closed value. The constructor creates entries, and the awaited first transaction publishes their resources before `create()` resolves.

Replace T0's `staticLanguageOwners: []` in `state()` with:

```ts
staticLanguageOwners: this.#staticCatalog.languages.map((language): StaticLanguageOwner => ({
  sourceKey: language.sourceKey, pluginId: language.pluginId, generation: language.generation,
  languageId: language.id, extensions: [...language.extensions],
})),
```

Replace all three T0 catalog/report stubs with these complete methods:

```ts
get staticLanguagesRevision(): number { return this.#staticCatalog.revision; }

staticLanguages(): StaticLanguagesCatalog { return structuredClone(this.#staticCatalog); }

reportLanguageRegistrationFailure(
  input: ReportLanguageRegistrationFailureInput,
): ReportLanguageRegistrationFailureResult {
  const ignored = () => ({ accepted: false, revision: this.staticLanguagesRevision });
  if (this.#shutdown || input.revision !== this.staticLanguagesRevision) return ignored();
  if (!["dto-version", "validation", "adapter", "monaco", "session-language-ids"].includes(input.reason)
    || typeof input.detail !== "string" || [...input.detail].length > 2048) return ignored();
  const language = this.#staticCatalog.languages.find((item) =>
    item.sourceKey === input.sourceKey && item.generation === input.generation && item.id === input.languageId,
  );
  if (!language) return ignored();
  const key = staticLanguageKey(language.sourceKey, language.generation, language.id);
  if (this.#registrationFailures.has(key)) return ignored();
  this.#registrationFailures.set(key, {
    code: "PLUGIN_E_STATIC_LANGUAGE_REGISTRATION",
    message: `${language.pluginId} / ${language.id}: renderer registration failed (${input.reason}): ${input.detail}`,
    detail: {
      languageId: language.id,
      ...(input.reason === "session-language-ids" ? {
        limit: "STATIC_LANGUAGE_LIMITS_V1.sessionLanguageIds",
        allowed: STATIC_LANGUAGE_LIMITS_V1.sessionLanguageIds,
        actual: STATIC_LANGUAGE_LIMITS_V1.sessionLanguageIds + 1,
      } : {}),
    },
  });
  // Invalidate pending work before synchronous revocation. A stale I/O pass cannot undo isolation.
  this.#staticOperation += 1;
  this.#publishStatic(this.#staticBuild);
  this.#emitState();
  return { accepted: true, revision: this.staticLanguagesRevision };
}

#clearRegistrationFailures(sourceKey: string): void {
  for (const key of this.#registrationFailures.keys())
    if ((JSON.parse(key) as [string, number, string])[0] === sourceKey)
      this.#registrationFailures.delete(key);
}

#retryStaticRegistration(entry: Entry): void {
  const sourceKey = entry.read.sourceKey;
  const failed = [...this.#registrationFailures.keys()].some((key) =>
    (JSON.parse(key) as [string, number, string])[0] === sourceKey,
  );
  if (!failed) return; // An unchanged, successful explicit enable remains a no-op.
  // R1: replace the renderer's quarantined identity before offering any resources again.
  // Do not advance execution/service generation or detach an existing supervisor.
  entry.staticGeneration += 1;
  this.#clearRegistrationFailures(sourceKey);
}

#publishStatic(build: StaticCatalogBuild): void {
  const keep = (sourceKey: string, generation: number) => this.#entries.some((entry) =>
    entry.plugin.status === "enabled" && entry.plugin.sourceKey === sourceKey && entry.staticGeneration === generation,
  );
  const projected = projectStaticLanguageCatalog(build, keep, this.#registrationFailures);
  const key = JSON.stringify([
    this.#entries.filter((entry) => entry.plugin.status === "enabled")
      .map((entry) => [entry.read.sourceKey, entry.staticGeneration]).sort(),
    projected.catalog.languages.map((language) => [
      language.sourceKey, language.pluginId, language.generation, language.id,
      language.aliases, language.extensions, language.resourceDigest, language.resourceBytes, language.expandedRules,
    ]),
    projected.catalog.extensionRoutes, projected.catalog.conflicts,
    [...projected.problems].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
  ]);
  this.#staticBuild = projected;
  if (key === this.#staticKey) return;
  this.#staticKey = key;
  this.#staticCatalog = { ...projected.catalog, revision: this.#staticCatalog.revision + 1 };
}

#revokeStaticSource(sourceKey: string): void {
  this.#staticOperation += 1;
  this.#staticBuild = {
    ...this.#staticBuild,
    catalog: { ...this.#staticBuild.catalog, languages: this.#staticBuild.catalog.languages.filter((language) => language.sourceKey !== sourceKey) },
    valid: this.#staticBuild.valid.filter((language) => language.sourceKey !== sourceKey),
  };
  this.#publishStatic(this.#staticBuild);
  this.#emitState();
}
```

In `#summary`, immediately after `...plugin.problems`, merge static problems **only for enabled plugin metadata**; process `failed` is a presentation state and must not withdraw static data:

```ts
...(plugin.status === "enabled" ? structuredClone(this.#staticBuild.problems.get(plugin.sourceKey) ?? []) : []),
```

Replace `#apply` with this full transaction. It uses one resource queue, serial mutation through existing `#enqueue`, source generations and an operation token. Resources/ownership/problems/revision are committed together. A report during I/O supersedes that pass and starts a fresh metadata/resource attempt with the quarantine retained; it never automatically retries the failed contribution.

```ts
async #apply(reason: StopReason, refreshMetadata = true): Promise<void> {
  if (this.#closed()) return;
  const operation = ++this.#staticOperation;
  const current = () => !this.#shutdown && operation === this.#staticOperation;
  const retired = this.#reconcile();
  this.#publishStatic(this.#staticBuild);
  this.#emitState();
  await this.#retire(retired, reason);
  if (!current()) {
    if (!this.#shutdown) await this.#apply(reason);
    return;
  }
  if (refreshMetadata) {
    const entries = [...this.#entries];
    // Completed sources are paused while this join waits for slow metadata.
    // Their same remaining budgets are resumed by the resource/help readers below.
    const reads = await Promise.all(entries.map((entry) => readSource(entry.source, readOptions(this.options, this.#safeMode))));
    if (!current()) {
      if (!this.#shutdown) await this.#apply(reason);
      return;
    }
    const replaced: PluginSupervisor[] = [];
    entries.forEach((entry, i) => {
      const read = reads[i]!;
      if (entry.read.manifest && executionKey(entry.read) !== executionKey(read)) {
        const previousGeneration = entry.staticGeneration;
        entry.generation += 1;
        entry.staticGeneration += 1;
        // An unrelated lifecycle transaction may observe new executable metadata.
        // Carry existing isolation forward; only explicit enable/reload clears it.
        for (const [key, problem] of [...this.#registrationFailures]) {
          const [sourceKey, generation, languageId] = JSON.parse(key) as [string, number, string];
          if (sourceKey === entry.read.sourceKey && generation === previousGeneration) {
            this.#registrationFailures.delete(key);
            this.#registrationFailures.set(staticLanguageKey(sourceKey, entry.staticGeneration, languageId), problem);
          }
        }
        const supervisor = this.#supervisors.get(entry.read.sourceKey);
        if (supervisor) {
          this.#supervisors.delete(entry.read.sourceKey);
          replaced.push(supervisor);
        }
      }
      entry.read = read;
    });
    if (convertLegacy(reads, this.#disabled, this.#legacy)) await this.#saveBestEffort();
    replaced.push(...this.#reconcile());
    this.#publishStatic(this.#staticBuild);
    this.#emitState();
    await this.#retire(replaced, reason);
  }
  if (!current()) {
    if (!this.#shutdown) await this.#apply(reason);
    return;
  }
  let build: StaticCatalogBuild;
  try {
    build = await buildStaticLanguageCatalog(
      this.#entries.map((entry) => ({ source: entry.source, plugin: entry.plugin, generation: entry.staticGeneration })),
      new Set(this.#registrationFailures.keys()), current,
    );
  } catch (error) {
    if (current()) throw error;
    if (!this.#shutdown) await this.#apply(reason);
    return;
  }
  // Help resumes the same source-local allowance after both queues; neither queue's
  // unrelated waits consume it. Help bytes retain their independent byte budget.
  for (const entry of [...this.#entries].sort((a, b) => a.read.sourceKey < b.read.sourceKey ? -1 : a.read.sourceKey > b.read.sourceKey ? 1 : 0)) {
    if (!current()) break;
    const decl = entry.read.manifest?.contributes?.diagnosticHelp;
    if (entry.plugin.status !== "enabled" || entry.source.kind !== "development" || !decl) continue;
    try {
      const budget = entry.read.resourceBudget;
      if (!budget) throw new Error("No current source read budget.");
      const help = await budget.run(() => readDiagnosticHelp(entry.read.directory!, decl));
      if (!current()) break;
      if (help.ok) entry.read.diagnosticHelp = help.help;
      else entry.read.helpProblem = help.problem;
    } catch {
      if (!current()) break;
      entry.read.helpProblem = { code: "PLUGIN_E_DIAGNOSTIC_HELP", message: `${entry.read.id} / ${decl.path}: source resource deadline exceeded.` };
    }
  }
  if (!current()) {
    if (!this.#shutdown) await this.#apply(reason);
    return;
  }
  // Refresh RegisteredPlugin's help fields without registering or starting processes.
  this.#entries.forEach((entry) => {
    delete entry.plugin.diagnosticHelp;
    delete entry.plugin.helpProblem;
    if (entry.read.diagnosticHelp) entry.plugin.diagnosticHelp = entry.read.diagnosticHelp;
    if (entry.read.helpProblem) entry.plugin.helpProblem = entry.read.helpProblem;
  });
  this.#rebuildHelp();
  this.#publishStatic(build);
  this.#emitState();
}
```

Replace `#setEnabled`, `#addSource`, `#reloadSource`, and `#leaveSafeMode` with the following full methods. Existing public wrappers, `#removeSource`, persistence helpers, `#refuseChange` and compiler/service resolvers remain. `#removeSource` already calls `#apply`, which revokes the removed source before resource work and recomputes ownership. An explicit enable of an already-enabled plugin is a resource retry; a builtin still cannot be disabled, removed or reloaded. Both explicit-enable branches call `#retryStaticRegistration` after any required save succeeds. A retained failure (including one retained across disable) advances only `staticGeneration` before clearing quarantine; ordinary unchanged enables preserve revision stability. Reload always advances both generations. Retrying builtin lexical registration leaves its service generation, binding epoch, help revision and supervisor callbacks unchanged. These are private fields; the frozen catalog/owner/report field remains named `generation`.

```ts
async #setEnabled(sourceKey: string, enabled: boolean): Promise<PluginActionResult> {
  const closed = this.#closed();
  if (closed) return closed;
  const entry = this.#entryOf(sourceKey);
  if (!entry || entry.plugin.status === "invalid")
    return failure("PLUGIN_E_UNKNOWN_PLUGIN", `No valid plugin has the source ${sourceKey}.`);
  if (entry.read.source === "builtin" && !enabled)
    return failure("PLUGIN_E_BUILTIN_REQUIRED", `${entry.plugin.id} is part of Kobrixa and cannot be disabled in this version.`);
  if (enabled && this.#safeMode && entry.source.kind === "development")
    return failure("PLUGIN_E_SAFE_MODE", "Restore plugins first, or restart without --safe-mode.");
  if (this.#disabled.has(sourceKey) !== enabled) {
    if (!enabled) return { ok: true, state: this.state() };
    this.#retryStaticRegistration(entry);
    await this.#apply("cancelled");
    return this.#closed() ?? { ok: true, state: this.state() };
  }
  const next = new Set(this.#disabled);
  if (enabled) next.delete(sourceKey); else next.add(sourceKey);
  let persisted = true;
  try { await this.#save(next); }
  catch (error) {
    if (enabled) return failure("PLUGIN_E_STATE_SAVE", messageOf(error));
    persisted = false;
  }
  this.#disabled = next;
  // A failed enable save returns above without changing generation or quarantine.
  if (enabled) this.#retryStaticRegistration(entry);
  await this.#apply("disabled");
  return this.#closed() ?? { ok: true, state: this.state(), ...(persisted ? {} : { persisted: false as const }) };
}

async #addSource(source: DevelopmentSource): Promise<PluginActionResult> {
  const closed = this.#closed();
  if (closed) return closed;
  const sourceKey = developmentSourceKey(source.directory);
  if (this.#entryOf(sourceKey))
    return failure("PLUGIN_E_SOURCE_EXISTS", `${path.resolve(source.directory)} is already loaded.`);
  // A placeholder involves no I/O. #apply reads metadata once and then eligible resources.
  const read = await readSource(source, { safeMode: true });
  this.#entries.push({ source, read, plugin: unresolved(read), generation: 0, staticGeneration: 0 });
  await this.#apply("cancelled");
  return this.#closed() ?? { ok: true, state: this.state() };
}

async #reloadSource(sourceKey: string): Promise<PluginActionResult> {
  const refused = this.#refuseChange(sourceKey, "reloaded");
  if (refused) return refused;
  if (this.#safeMode) return failure("PLUGIN_E_SAFE_MODE", "Restore plugins first, or restart without --safe-mode.");
  const entry = this.#entryOf(sourceKey)!;
  // Withdraw before waiting for a process or filesystem. Failed reloads cannot keep old rules.
  this.#revokeStaticSource(sourceKey);
  this.#clearRegistrationFailures(sourceKey);
  // Prevent #apply's initial reconciliation from recreating old commands before metadata returns.
  entry.read = { ...entry.read, unread: true };
  const supervisor = this.#supervisors.get(sourceKey);
  if (supervisor) {
    this.#supervisors.delete(sourceKey);
    for (const [command, owner] of this.#commands) if (owner === sourceKey) this.#commands.delete(command);
    this.#emitState();
    await this.#retire([supervisor], "cancelled");
  }
  entry.generation += 1;
  entry.staticGeneration += 1;
  const closed = this.#closed();
  if (closed) return closed;
  await this.#apply("cancelled");
  return this.#closed() ?? { ok: true, state: this.state() };
}

async #leaveSafeMode(): Promise<PluginActionResult> {
  const closed = this.#closed();
  if (closed) return closed;
  if (!this.#safeMode) return { ok: true, state: this.state() };
  this.#safeMode = false;
  await this.#apply("disabled");
  return this.#closed() ?? { ok: true, state: this.state() };
}
```

At the start of `shutdown`, before its existing `this.#shutdown ??= ...`, add:

```ts
this.#staticOperation += 1;
```

Keep T0's `#register` guard excluding both `builtin` and `static`; no static supervisor, activation or handshake is constructed. The current `PluginSupervisor` crash-loop policy sets only the process state to `failed`, not registry `disabled`, so lexical resources survive that state. A real user/policy disable changes registry eligibility and revokes them. Do not infer static availability from `active` or `running`.

- [ ] **Step 4: Run manager regressions, build runtime, format and lint**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime exec vitest run src/manager.static-languages.test.ts src/manager.test.ts src/static-language-contract.test.ts src/static-languages.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --write packages/plugin-runtime/src/manager.ts packages/plugin-runtime/src/manager.test.ts packages/plugin-runtime/src/manager.static-languages.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec eslint packages/plugin-runtime/src/manager.ts packages/plugin-runtime/src/manager.test.ts packages/plugin-runtime/src/manager.static-languages.test.ts
```

Expected: PASS, including both explicit-enable recovery branches, failed-save isolation, reload generation, unchanged service epoch, all eight slow-source isolation cases, and existing diagnostic-help budgets/recovery, shutdown/resume, command cancellation and compiler/service tests. The runtime build consumes the protocol dist produced by T0; do not rebuild/write T1's package from this task. Runtime's own build is mandatory because desktop consumes its `dist/`.

- [ ] **Step 5: Commit (controller only)**

```bash
git add packages/plugin-runtime/src/manager.ts packages/plugin-runtime/src/manager.test.ts packages/plugin-runtime/src/manager.static-languages.test.ts
git commit -m "feat(plugin-runtime): publish static catalogs and quarantine failed registrations"
```

#### 2.4 Pin late completion, budget continuation and revision regressions

- [ ] **Step 1: Add the remaining race and accounting regression tests**

Append these tests to `static-languages.test.ts`; add `SourceReadBudget` from `./packaged-json-resource.js` to its imports:

```ts
it("accepts exactly the plugin byte budget, charges shared paths twice and continues after overflow", async () => {
  const source = builtinToy();
  const manifest = source.manifest as PluginManifest;
  const declaration = manifest.contributes!.languages![0]!;
  manifest.contributes!.languages = ["a", "b", "c"].map((id) => ({
    ...declaration,
    id,
    extensions: [id],
  }));
  source.resources = {
    "language/tokenizer.json": "{}" + " ".repeat(L.resourceFileBytes - 4),
    "language/configuration.json": "{}",
  };
  const exact = await build([source]);
  expect(exact.catalog.languages.map((language) => language.id)).toEqual(["a", "b"]);
  expect(
    exact.catalog.languages.reduce(
      (sum, language) =>
        sum + language.resourceBytes.tokenizer + language.resourceBytes.configuration,
      0,
    ),
  ).toBe(L.resourceBytesPerPlugin);
  source.resources = {
    "language/tokenizer.json": "{}" + " ".repeat(400000 - 2),
    "language/configuration.json": "{}" + " ".repeat(200000 - 2),
    "small.json": "{}",
  };
  manifest.contributes!.languages![2] = {
    ...manifest.contributes!.languages![2]!,
    tokenizer: { version: 1, path: "small.json" },
    configuration: { version: 1, path: "small.json" },
  };
  expect((await build([source])).catalog.languages.map((language) => language.id)).toEqual([
    "a",
    "c",
  ]);
});

it("retains extension ambiguity even when a complete valid candidate loses the id budget", async () => {
  const sources = Array.from({ length: 129 }, (_, i) =>
    builtinToy(
      `test.i${String(i).padStart(3, "0")}`,
      `lang${i}`,
      i === 0 || i === 128 ? ["shared"] : [`x${i}`],
    ),
  );
  const result = await build(sources.reverse());
  expect(result.catalog.languages).toHaveLength(128);
  expect(result.catalog.extensionRoutes.shared).toBeNull();
  expect(
    result.catalog.conflicts.find((conflict) => conflict.key === "shared")?.sources,
  ).toHaveLength(2);
});

it("reports an expired resource deadline per language without invalidating valid metadata", async () => {
  const source = builtinToy();
  const read = await readSource(source, { safeMode: false });
  read.resourceBudget = new SourceReadBudget(-1);
  const [plugin] = resolvePlugins([read], { disabled: new Set(), safeMode: false });
  vi.mocked(validateStaticLanguageResources).mockClear();
  const result = await buildStaticLanguageCatalog(
    [{ source, plugin: plugin!, generation: 0 }],
    new Set(),
  );
  expect(plugin!.status).toBe("enabled");
  expect(result.catalog.languages).toEqual([]);
  expect(result.problems.get(plugin!.sourceKey)?.[0]).toMatchObject({
    code: "PLUGIN_E_STATIC_LANGUAGE",
    message: expect.stringContaining("deadline"),
    detail: { languageId: "toy", resourcePath: "language/tokenizer.json" },
  });
  expect(validateStaticLanguageResources).not.toHaveBeenCalled();
});

it("reads no grammar for plugins invalidated by compiler conflicts", async () => {
  const sources = [builtinToy("test.a", "a"), builtinToy("test.b", "b")];
  for (const source of sources) {
    const manifest = source.manifest as PluginManifest;
    manifest.contributes!.frontends = [
      {
        language: "shared",
        entryExtensions: ["shared"],
        sourceExtensions: ["shared"],
        ir: { min: 1, max: 1 },
      },
    ];
  }
  vi.mocked(validateStaticLanguageResources).mockClear();
  const result = await build(sources);
  expect(result.catalog.languages).toEqual([]);
  expect(validateStaticLanguageResources).not.toHaveBeenCalled();
});
```

Append these tests to `manager.static-languages.test.ts`:

```ts
it("keeps the help revision stable through an unchanged lexical retry", async () => {
  const source = await developmentToy(root);
  const manifest = structuredClone(toyManifest);
  manifest.contributes!.diagnosticHelp = { version: 1, path: "help.json" };
  await writeManifest(source.directory, manifest);
  await writeFile(
    path.join(source.directory, "help.json"),
    JSON.stringify({
      entries: [
        {
          code: "TOY001",
          title: { en: "Help" },
          cause: { en: "Cause" },
          steps: { en: ["Retry"] },
        },
      ],
    }),
  );
  const manager = await create([source]);
  const help = manager.diagnosticHelp();
  const staticRevision = manager.staticLanguagesRevision;
  await manager.setEnabled(developmentSourceKey(source.directory), true);
  expect(manager.diagnosticHelp()).toEqual(help);
  expect(manager.staticLanguagesRevision).toBe(staticRevision);
});

it("changes only lexical revision for alias, extension or raw digest changes", async () => {
  const source = builtinToy();
  const manifest = source.manifest as PluginManifest;
  manifest.contributes!.frontends = [
    {
      language: "toy",
      entryExtensions: ["toy"],
      sourceExtensions: ["toy"],
      ir: { min: 1, max: 1 },
    },
  ];
  manifest.contributes!.languageServices = [
    { language: "toy", extensions: ["toy"], capabilities: ["analysis"] },
  ];
  const manager = await create([source]);
  const binding = manager.resolveLanguageService("toy");
  const key = "builtin:test.toy";
  const first = manager.staticLanguagesRevision;
  manifest.contributes!.languages![0]!.aliases = ["Renamed toy"];
  source.resources = {
    ...source.resources,
    "language/tokenizer.json": source.resources["language/tokenizer.json"]! + " ",
  };
  await manager.setEnabled(key, true);
  expect(manager.staticLanguagesRevision).toBeGreaterThan(first);
  expect(manager.resolveLanguageService("toy")).toEqual(binding);
  const after = manager.staticLanguagesRevision;
  await manager.setEnabled(key, true);
  expect(manager.staticLanguagesRevision).toBe(after);
  // A static-only owner's extension can change independently of any service.
  const lexical = await developmentToy(root);
  const staticManifest = structuredClone(toyManifest);
  staticManifest.id = "acme.lexical";
  staticManifest.contributes!.languages![0]!.id = "lexical";
  await writeManifest(lexical.directory, staticManifest);
  await manager.addSource(lexical);
  const previous = manager.staticLanguagesRevision;
  staticManifest.contributes!.languages![0]!.extensions = ["new"];
  await writeManifest(lexical.directory, staticManifest);
  await manager.setEnabled(developmentSourceKey(lexical.directory), true);
  expect(manager.staticLanguagesRevision).toBeGreaterThan(previous);
  expect(manager.staticLanguages().extensionRoutes.new).toBe("lexical");
  expect(manager.resolveLanguageService("toy")).toEqual(binding);
});

it("drops a late resource open after the source deadline and closes its handle", async () => {
  const source = await developmentToy(root);
  const manager = await create([source], { sourceReadTimeoutMs: 200 });
  const actualOpen = vi.mocked(open).getMockImplementation()!;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const requested = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let closed = false;
  let blocked = false;
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actualOpen(...args);
    if (!blocked && String(args[0]).endsWith(`${path.sep}language${path.sep}tokenizer.json`)) {
      blocked = true;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        closed = true;
      };
      entered();
      await held;
    }
    return handle;
  });
  try {
    const reloading = manager.reloadSource(developmentSourceKey(source.directory));
    await requested;
    await reloading;
    expect(manager.staticLanguages().languages).toEqual([]);
    expect(manager.state().plugins[0]?.status).toBe("enabled");
    const revision = manager.staticLanguagesRevision;
    const validations = vi.mocked(validateStaticLanguageResources).mock.calls.length;
    release();
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(manager.staticLanguagesRevision).toBe(revision);
    expect(validateStaticLanguageResources).toHaveBeenCalledTimes(validations);
  } finally {
    release();
    vi.mocked(open).mockImplementation(actualOpen);
  }
});

it("cannot overwrite a report accepted while another catalog pass is awaiting I/O", async () => {
  const source = await developmentToy(root);
  const manager = await create([source]);
  const extra = await developmentToy(root, "extra");
  const manifest = structuredClone(toyManifest);
  manifest.id = "acme.extra";
  manifest.contributes!.languages![0]!.id = "extra";
  manifest.contributes!.languages![0]!.extensions = ["extra"];
  await writeManifest(extra.directory, manifest);
  const actualOpen = vi.mocked(open).getMockImplementation()!;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const requested = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let blocked = false;
  vi.mocked(open).mockImplementation(async (...args) => {
    if (!blocked && String(args[0]) === path.join(extra.directory, "language/tokenizer.json")) {
      blocked = true;
      entered();
      await held;
    }
    return actualOpen(...args);
  });
  try {
    const adding = manager.addSource(extra);
    await requested;
    const language = manager.staticLanguages().languages.find((item) => item.id === "toy")!;
    expect(
      manager.reportLanguageRegistrationFailure({
        sourceKey: language.sourceKey,
        generation: language.generation,
        languageId: language.id,
        revision: manager.staticLanguagesRevision,
        reason: "adapter",
        detail: "Rejected fixture.",
      }).accepted,
    ).toBe(true);
    release();
    await adding;
    expect(manager.staticLanguages().languages.map((item) => item.id)).toEqual(["extra"]);
    expect(manager.state().staticLanguageOwners.map((item) => item.languageId)).toEqual(["extra"]);
  } finally {
    release();
    vi.mocked(open).mockImplementation(actualOpen);
  }
});
```

- [ ] **Step 2: Run the new unchanged-input revision regression, expect FAIL**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime exec vitest run src/manager.static-languages.test.ts -t 'keeps the help revision stable through an unchanged lexical retry'`

Expected: FAIL because the fresh metadata temporarily omits `diagnosticHelp`, causing `#reconcile` to publish an empty help catalog and then restore it with a higher revision. The resource pipeline must preserve the unchanged help revision; do not weaken this assertion.

- [ ] **Step 3: Preserve unchanged help until its replacement commits**

The failing test pins existing diagnostic-help revision stability while the static resource pipeline refreshes metadata. In `#apply`, before `entry.read = read` inside `entries.forEach`, preserve help for unchanged metadata until the new eligible resource attempt commits. Insert this exact block immediately before that assignment:

```ts
if (
  executionKey(entry.read) === executionKey(read) &&
  JSON.stringify(entry.read.manifest?.contributes?.diagnosticHelp) ===
    JSON.stringify(read.manifest?.contributes?.diagnosticHelp)
) {
  if (entry.read.diagnosticHelp) read.diagnosticHelp = entry.read.diagnosticHelp;
  if (entry.read.helpProblem) read.helpProblem = entry.read.helpProblem;
}
```

In the help-reading loop, after obtaining `help` and checking `current()` but before assigning `entry.read.diagnosticHelp` or `entry.read.helpProblem`, insert:

```ts
delete entry.read.diagnosticHelp;
delete entry.read.helpProblem;
```

In that loop's `catch`, after its `if (!current()) break`, insert:

```ts
delete entry.read.diagnosticHelp;
```

This retains the existing help catalog until a complete replacement or definite failure is available, without changing static budgets or clearing registration quarantine. Static publication remains a single `#publishStatic(build)` after its resource pass. The other added tests exercise code already written in 2.1–2.3 and must pass without production changes; if they expose a defect, fix only this task's listed implementation files.

- [ ] **Step 4: Run all task-local tests, build the consumed package, and check every changed file**

All commands run from the worktree root. T0's built protocol dist is a prerequisite supplied by the controller. These commands never regenerate T1 schemas, install dependencies or run another task's implementation.

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime test
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --write packages/plugin-runtime/src/packaged-json-resource.ts packages/plugin-runtime/src/packaged-json-resource.test.ts packages/plugin-runtime/src/test-static-languages.ts packages/plugin-runtime/src/registry.ts packages/plugin-runtime/src/diagnostic-help.ts packages/plugin-runtime/src/static-languages.ts packages/plugin-runtime/src/static-language-catalog.ts packages/plugin-runtime/src/static-languages.test.ts packages/plugin-runtime/src/manager.ts packages/plugin-runtime/src/manager.test.ts packages/plugin-runtime/src/manager.static-languages.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --check packages/plugin-runtime/src/packaged-json-resource.ts packages/plugin-runtime/src/packaged-json-resource.test.ts packages/plugin-runtime/src/test-static-languages.ts packages/plugin-runtime/src/registry.ts packages/plugin-runtime/src/diagnostic-help.ts packages/plugin-runtime/src/static-languages.ts packages/plugin-runtime/src/static-language-catalog.ts packages/plugin-runtime/src/static-languages.test.ts packages/plugin-runtime/src/manager.ts packages/plugin-runtime/src/manager.test.ts packages/plugin-runtime/src/manager.static-languages.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec eslint packages/plugin-runtime/src/packaged-json-resource.ts packages/plugin-runtime/src/packaged-json-resource.test.ts packages/plugin-runtime/src/test-static-languages.ts packages/plugin-runtime/src/registry.ts packages/plugin-runtime/src/diagnostic-help.ts packages/plugin-runtime/src/static-languages.ts packages/plugin-runtime/src/static-language-catalog.ts packages/plugin-runtime/src/static-languages.test.ts packages/plugin-runtime/src/manager.ts packages/plugin-runtime/src/manager.test.ts packages/plugin-runtime/src/manager.static-languages.test.ts
git diff --check
git diff --name-only
```

Expected: PASS for runtime tests, build, formatting, lint and whitespace checks. Changed tracked paths must all begin `packages/plugin-runtime/`. Record Python-interoperability skips/environment failures truthfully; a missing interpreter is not a passing interoperability check. Do not claim desktop, real T1 validation or packaged acceptance from these results.

- [ ] **Step 5: Commit (controller only)**

```bash
git add packages/plugin-runtime/src/static-languages.test.ts packages/plugin-runtime/src/manager.static-languages.test.ts packages/plugin-runtime/src/manager.ts
git commit -m "test(plugin-runtime): pin static catalog races deadlines and budget boundaries"
```

**Deferred to T8**

- Replace the T1 fixture doubles at the integration boundary with real declaration/resource validators; run shared valid/invalid conformance, schema/regex/include/Unicode limits and builtin/development parity. Keep orchestration unit doubles explicit rather than silently changing their purpose.
- RF3's actual selected `LanguageBinding` must fall directly to `plaintext` when its frontend owner's grammar fails, even if a foreign language has a unique global mapping. Verify the same rule for ambiguous extensions, editor, hidden models and both diff sides with T4/T5.
- Run real T3 trusted-sender/report validation, bounded/path-free detail validation and session-marker-before-delivery checks, including post-startup enable and persistence failure. Runtime identity/revision checks do not replace the IPC trust boundary.
- Verify the explicit `CORE_STATIC_LANGUAGE_IDS` list against the runtime Monaco registrations before plugin registration, and align T4/T5 core extension routing with the installed core set. The locked package entry currently registers the full list recorded above; a Monaco import/build change requires updating this list and rerunning the check.
- Integrate T6's raw `?raw` Basic Plus resources with the required builtin source map, run real validator and token/indentation/theme parity, and verify packaged startup without repository files.
- Run desktop typecheck/build and full language-service regression to prove lexical-only revisions do not restart workers or alter binding epochs, plus real Electron recovery, enable/disable/reload, performance and packaged smoke. T2's passing runtime suite is not a substitute.

**Contract gaps**

- T0 does not freeze an explicit installed core-id list. T2 defines and exports `CORE_STATIC_LANGUAGE_IDS` in its own `packages/plugin-runtime/src/static-languages.ts`, from the inspected Monaco 0.57.0 entry point. T8 must check actual renderer registrations and its core routes; no renderer file is assigned to T2.
- T0 freezes the public source/manager DTOs but not internal two-phase I/O, budget, catalog assembly or projection interfaces. This task defines `SourceReadBudget`, `PackagedJson`, `PackagedResourceError`, `readPackagedJson`, `readBuiltinJson`, `ReadPlugin.resourceBudget`, `StaticCatalogEntry`, `StaticCatalogBuild`, `buildStaticLanguageCatalog`, `projectStaticLanguageCatalog`, and `staticLanguageKey` entirely inside `packages/plugin-runtime/**`. None changes a frozen T3/T6 consumer signature.
### Task 3: Desktop main, catalog IPC and static-language recovery

**Files:**

- Modify: `apps/desktop/src/main/plugins/session.ts:1-101` — T0's marker scaffold and checked persistence; retain `quitOnSignals` and `watchRendererHealth`.
- Modify/Test: `apps/desktop/src/main/plugins/session.test.ts:1-112` — use existing `root`, `marker()` and `onDisk()` helpers.
- Modify: `apps/desktop/src/main/plugins/controller.ts:65-101,112-141,415-419,531-561,606-685` — ports, delivery gate, report ownership and startup ordering.
- Modify/Test: `apps/desktop/src/main/plugins/controller.test.ts:1-98,595-718` — extend the existing fake-manager `setup()`; add recovery tests in that describe block.
- Modify: `apps/desktop/src/main/plugins/ipc.ts:1-43` — replace T0's empty handlers using the existing trusted `IpcHandle`.
- Modify/Test: `apps/desktop/src/main/plugins/ipc.test.ts:1-126` — extend the existing `setup()` and exact channel list; test the real trusted wrapper with mocked Electron.
- Modify: `apps/desktop/src/main/plugins/dialogs.ts:24-61` — English and Traditional Chinese developer/link trust copy for static rules.
- Modify/Test: `apps/desktop/src/main/plugins/dialogs.test.ts:1-72` — reuse the existing Electron dialog mocks.
- Create/Test: `apps/desktop/src/preload/index.test.ts` — test T0's real preload methods and event unsubscribe with mocked Electron.
- Verify, no additional edit: `apps/desktop/src/shared/static-languages.ts`, `apps/desktop/src/shared/plugins.ts`, `apps/desktop/src/shared/static-languages.test.ts`, `apps/desktop/src/preload/index.ts` — T0 already supplies the exact type-only bridge, Promise APIs and working preload forwards.
- Verify, no additional edit: `apps/desktop/src/main/index.ts:171-182,352-371` — retain `await startPlugins(...)`, the trusted module registration and renderer-health hook.
- Verify, no additional edit: `apps/desktop/src/main/workspace/compiler-chain.test.ts:21-31` and `apps/desktop/src/main/language/language-provider.integration.test.ts:47-85` — T0 already adds required builtin `resources: {}`; these two files were explicitly handed to T3, but need no further behavior changes.

Line numbers above identify the inspected pre-T0 baseline; use the named symbols as anchors after T0 inserts its scaffold. All edits below stay inside §11.1's T3 write set. Do not edit `main/plugins/builtin.ts`, `builtin.test.ts`, runtime/protocol source or shared fixtures, renderer code, `tests/desktop/preload.cjs`, root scripts or other workers' tests.

**Interfaces:**

- Consumes: T0's `PluginManager.staticLanguages(): StaticLanguagesCatalog`, `get staticLanguagesRevision(): number`, `reportLanguageRegistrationFailure(input: ReportLanguageRegistrationFailureInput): ReportLanguageRegistrationFailureResult`, `state(): PluginsSnapshot`, and existing `onEvent`, `active`, enable/reload/safe-mode methods. `PluginsSnapshot.staticLanguagesRevision` and `.staticLanguageOwners` are required, including owners with ambiguous extensions. Catalog revision is never used as a language-service binding epoch.
- Consumes: `StaticLanguagesCatalog`, `StaticLanguageOwner`, `ValidatedStaticLanguage`, `ReportLanguageRegistrationFailureInput`, `ReportLanguageRegistrationFailureResult`, `PluginProblem` and `PluginError` from T0; `sourceKeySchema`, `compilerIdSchema`, `IpcHandle`, `filePluginStateStore`, `developmentSourceKey`, `messageOf` and the existing controller test helpers. Read the frozen minimal JSON fixtures at `packages/plugin-protocol/test-fixtures/static-languages/minimal/{tokenizer,configuration}.json`; do not validate them through T1's throwing stub.
- Produces: `PluginController.staticLanguages(): StaticLanguagesCatalog` and `PluginController.reportLanguageRegistrationFailure(input: ReportLanguageRegistrationFailureInput): ReportLanguageRegistrationFailureResult`, with matching additions to local `PluginManagerPort` and `PluginIpcTarget` picks. These are the same signatures as T0's manager, not another DTO or report format.
- Produces: controller-backed `plugins:static-languages` and `plugins:report-language-registration-failure`; the existing `plugins:event` state event remains the only revision/owner event. T0's `PluginsApi.staticLanguages(): Promise<StaticLanguagesCatalog>` and `.reportLanguageRegistrationFailure(input): Promise<ReportLanguageRegistrationFailureResult>` remain unchanged.
- Produces: T0's `SessionMarkerFile.markThirdPartyStaticContributions(): void` with synchronous checked persistence; local `get previousThirdPartyStaticContributions(): boolean` records the marker read at `begin()` so startup cannot discard an exposed static-language risk after the last source was removed. This local addition is recorded under Contract gaps.

Run from a separate T3 worktree at the controller's T0 commit. New orchestration tests use the local fake manager only. Old node/python controller regressions may still use the existing T0 manager because they do not ask its static-language stub to load anything. No branch-local test requires T1 validation, T2 catalog implementation, T4 registration or T6 product resources. The controller makes every commit below; the Codex worker only prepares changes and reports verification.

#### 3.1 Persist the static recovery bit before acknowledging it

- [ ] **Step 1: Write the failing marker tests**

Append to `session.test.ts`, retaining T0's added `thirdPartyStaticContributions: false` expectation and the existing process/hang tests:

```ts
it("persists static risk synchronously and keeps it when no process is running", async () => {
  const session = marker();
  session.begin();
  session.markThirdPartyStaticContributions();
  expect(await onDisk()).toMatchObject({
    thirdPartyRunning: false,
    thirdPartyStaticContributions: true,
  });
  session.update({ thirdPartyRunning: true });
  session.update({ thirdPartyRunning: false });
  expect((await onDisk()).thirdPartyStaticContributions).toBe(true);
  const restarted = marker();
  expect(restarted.begin()).toBe("unclean-exit");
  expect(restarted.previousThirdPartyStaticContributions).toBe(true);
  expect((await onDisk()).thirdPartyStaticContributions).toBe(false);
});

it("reads old markers without the static field", async () => {
  await mkdir(path.join(root, "plugins"), { recursive: true });
  await writeFile(
    path.join(root, "plugins/session.json"),
    JSON.stringify({
      startedAt: "2026-10-15T00:00:00.000Z",
      thirdPartyRunning: false,
      rendererUnresponsive: false,
    }),
  );
  const session = marker();
  expect(session.begin()).toBeUndefined();
  expect(session.previousThirdPartyStaticContributions).toBe(false);
  expect((await onDisk()).thirdPartyStaticContributions).toBe(false);
});

it("keeps static risk and the higher-priority hang reason through finish", async () => {
  const session = marker();
  session.begin();
  session.markThirdPartyStaticContributions();
  session.update({ rendererUnresponsive: true });
  session.finish();
  expect(await onDisk()).toMatchObject({
    thirdPartyRunning: false,
    thirdPartyStaticContributions: true,
    rendererUnresponsive: true,
  });
  expect(marker().begin()).toBe("renderer-unresponsive");
});

it("removes static risk on a clean exit and refuses writes outside a live session", async () => {
  const session = marker();
  expect(() => session.markThirdPartyStaticContributions()).toThrow("PLUGIN_E_STATE_SAVE");
  session.begin();
  session.markThirdPartyStaticContributions();
  session.finish();
  await expect(readFile(session.file)).rejects.toMatchObject({ code: "ENOENT" });
  expect(() => session.markThirdPartyStaticContributions()).toThrow("PLUGIN_E_STATE_SAVE");
  expect(marker().begin()).toBeUndefined();
});

it("throws on a failed checked write and retries instead of caching an unwritten true", async () => {
  const session = marker();
  session.begin();
  // A directory at the destination makes the atomic rename fail on every platform.
  await rm(session.file);
  await mkdir(session.file);
  expect(() => session.markThirdPartyStaticContributions()).toThrow("PLUGIN_E_STATE_SAVE");
  expect(() => session.markThirdPartyStaticContributions()).toThrow("PLUGIN_E_STATE_SAVE");
  await rm(session.file, { recursive: true });
  session.markThirdPartyStaticContributions();
  expect((await onDisk()).thirdPartyStaticContributions).toBe(true);
  expect(marker().begin()).toBe("unclean-exit");
});
```

- [ ] **Step 2: Run and expect FAIL**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/session.test.ts
```

Expected: FAIL at T0's throwing `markThirdPartyStaticContributions()` stub. The two builds refresh the `dist/` exports desktop consumes; they do not change package source or require another task's implementation.

- [ ] **Step 3: Implement the checked marker write**

In `session.ts`, add the value import below. Replace only the `SessionMarkerFile` class with the complete class below; retain T0's schema, including `.default(false)` at the old-file read boundary, and retain the existing signal/health helpers after the class.

```ts
import { PluginError } from "@kobrixa/plugin-runtime";

export class SessionMarkerFile {
  readonly file: string;
  #marker: SessionMarker | undefined;
  #finished = false;
  #previousThirdPartyStaticContributions = false;

  constructor(
    userData: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.file = path.join(userData, "plugins", "session.json");
  }

  get previousThirdPartyStaticContributions(): boolean {
    return this.#previousThirdPartyStaticContributions;
  }

  begin(): SafeModeLock["reason"] | undefined {
    const previous = this.#read();
    this.#previousThirdPartyStaticContributions = previous?.thirdPartyStaticContributions ?? false;
    this.#finished = false;
    this.#marker = {
      startedAt: this.now().toISOString(),
      thirdPartyRunning: false,
      thirdPartyStaticContributions: false,
      rendererUnresponsive: false,
    };
    this.#write();
    if (previous?.rendererUnresponsive) return "renderer-unresponsive";
    if (previous?.thirdPartyRunning || previous?.thirdPartyStaticContributions)
      return "unclean-exit";
    return undefined;
  }

  markThirdPartyStaticContributions(): void {
    const marker = this.#marker;
    if (!marker || this.#finished)
      throw new PluginError(
        "PLUGIN_E_STATE_SAVE",
        "PLUGIN_E_STATE_SAVE: No live plugin recovery session.",
      );
    if (marker.thirdPartyStaticContributions) return;
    const next = { ...marker, thirdPartyStaticContributions: true };
    try {
      this.#persist(next);
    } catch {
      throw new PluginError(
        "PLUGIN_E_STATE_SAVE",
        "PLUGIN_E_STATE_SAVE: Could not save the static-language recovery marker.",
      );
    }
    // Only a completed synchronous write can acknowledge risk as recorded.
    this.#marker = next;
  }

  update(patch: { thirdPartyRunning?: boolean; rendererUnresponsive?: true }): void {
    const marker = this.#marker;
    if (!marker || this.#finished) return;
    const next = {
      ...marker,
      ...patch,
      rendererUnresponsive: marker.rendererUnresponsive || patch.rendererUnresponsive === true,
    };
    if (
      next.thirdPartyRunning === marker.thirdPartyRunning &&
      next.rendererUnresponsive === marker.rendererUnresponsive
    )
      return;
    this.#marker = next;
    this.#write();
  }

  finish(): void {
    const marker = this.#marker;
    if (!marker || this.#finished) return;
    this.#finished = true;
    this.#marker = {
      ...marker,
      thirdPartyRunning: false,
      thirdPartyStaticContributions: marker.rendererUnresponsive
        ? marker.thirdPartyStaticContributions
        : false,
    };
    this.#write();
    if (marker.rendererUnresponsive) return;
    try {
      rmSync(this.file, { force: true });
    } catch {
      // A failed removal leaves the clean marker when its preceding write succeeded.
    }
  }

  #read(): SessionMarker | undefined {
    try {
      return markerSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
    } catch {
      return undefined;
    }
  }

  #write(): void {
    if (!this.#marker) return;
    try {
      this.#persist(this.#marker);
    } catch {
      // Existing process/health updates remain best effort. Static delivery uses the
      // checked entry point above and cannot be authorized by this swallowing wrapper.
    }
  }

  #persist(marker: SessionMarker): void {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(temporary, JSON.stringify(marker), { mode: 0o600 });
      renameSync(temporary, this.file);
    } catch (error) {
      try {
        rmSync(temporary, { force: true });
      } catch {
        // Preserve the original write failure.
      }
      throw error;
    }
  }
}
```

- [ ] **Step 4: Run and expect PASS**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/session.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --write apps/desktop/src/main/plugins/session.ts apps/desktop/src/main/plugins/session.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec eslint apps/desktop/src/main/plugins/session.ts apps/desktop/src/main/plugins/session.test.ts
```

Expected: PASS, including old markers, process-only recovery, sticky static risk, real failed rename and clean/unresponsive exits.

- [ ] **Step 5: Controller commit**

```bash
git add apps/desktop/src/main/plugins/session.ts apps/desktop/src/main/plugins/session.test.ts
git commit -m "feat(desktop): persist static language recovery risk before delivery"
```

#### 3.2 Gate catalog and owner delivery, and verify report ownership

- [ ] **Step 1: Write failing controller tests using the existing fake manager**

In `controller.test.ts`, add these imports, merging runtime names into its existing import:

```ts
import { readFileSync } from "node:fs";
import {
  emptyStaticLanguagesCatalog,
  type StaticLanguagesCatalog,
  type ValidatedStaticLanguage,
  type ReportLanguageRegistrationFailureInput,
} from "@kobrixa/plugin-runtime";
```

Inside `describe("PluginController with a fake manager")`, after the existing `snapshot`, add these fixture helpers. These consume T0's exact resource files, preserve their original byte counts and deliberately do not call the validator stub. A digest here is only a manager-mock identity, not a claimed runtime digest calculation.

```ts
const fixtureText = (name: "tokenizer" | "configuration") =>
  readFileSync(
    new URL(
      `../../../../../packages/plugin-protocol/test-fixtures/static-languages/minimal/${name}.json`,
      import.meta.url,
    ),
    "utf8",
  );
const tokenizerText = fixtureText("tokenizer");
const configurationText = fixtureText("configuration");
const language = (id: string, pluginId: string, sourceKey: string): ValidatedStaticLanguage => ({
  id,
  pluginId,
  sourceKey,
  generation: 1,
  extensions: [id],
  aliases: [],
  resourceDigest: "mock-resource-digest",
  tokenizer: JSON.parse(tokenizerText),
  configuration: JSON.parse(configurationText),
  resourceBytes: {
    tokenizer: Buffer.byteLength(tokenizerText, "utf8"),
    configuration: Buffer.byteLength(configurationText, "utf8"),
  },
  expandedRules: 1,
});
const toy = language("toy", "acme.toy", key);
const bp = language("bp", builtin.id, builtin.sourceKey);
const catalog = (
  revision = 1,
  languages: ValidatedStaticLanguage[] = [bp, toy],
): StaticLanguagesCatalog => ({
  formatVersion: 1,
  limitsVersion: 1,
  revision,
  languages,
  extensionRoutes: Object.fromEntries(
    languages.flatMap((item) => item.extensions.map((extension) => [extension, item.id])),
  ),
  conflicts: [],
});
const owners = (value: StaticLanguagesCatalog): PluginsSnapshot["staticLanguageOwners"] =>
  value.languages.map(({ id, pluginId, sourceKey, generation, extensions }) => ({
    languageId: id,
    pluginId,
    sourceKey,
    generation,
    extensions: [...extensions],
  }));
const staticSnapshot = (value: StaticLanguagesCatalog): PluginsSnapshot => ({
  ...snapshot,
  staticLanguagesRevision: value.revision,
  staticLanguageOwners: owners(value),
  plugins: [
    builtin,
    {
      sourceKey: key,
      id: "acme.toy",
      source: "development",
      runtime: "static",
      status: "enabled",
      running: false,
      problems: [],
      commands: [],
    },
  ],
});
const report = (revision = 1): ReportLanguageRegistrationFailureInput => ({
  sourceKey: key,
  generation: 1,
  languageId: "toy",
  revision,
  reason: "monaco",
  detail: "The language configuration could not be installed.",
});
```

Extend the existing `setup(options)` type with `catalog?: StaticLanguagesCatalog`. Immediately after `let currentSnapshot = options.snapshot ?? snapshot;`, add:

```ts
let currentCatalog =
  options.catalog ?? emptyStaticLanguagesCatalog(currentSnapshot.staticLanguagesRevision);
const publishCatalog = (
  value: StaticLanguagesCatalog,
  plugins: PluginsSnapshot["plugins"] = currentSnapshot.plugins,
) => {
  currentCatalog = value;
  currentSnapshot = {
    ...currentSnapshot,
    plugins,
    revision: currentSnapshot.revision + 1,
    staticLanguagesRevision: value.revision,
    staticLanguageOwners: owners(value),
  };
  listener({ type: "state", state: currentSnapshot });
};
```

Add these members to the existing fake `manager` object, preserving its other members:

```ts
get staticLanguagesRevision() {
  return currentCatalog.revision;
},
staticLanguages: vi.fn(() => structuredClone(currentCatalog)),
reportLanguageRegistrationFailure: vi.fn<PluginManagerPort["reportLanguageRegistrationFailure"]>(
  () => ({ accepted: false, revision: currentCatalog.revision }),
),
setEnabled: vi.fn<PluginManagerPort["setEnabled"]>(async () => ({
  ok: true,
  state: currentSnapshot,
})),
reloadSource: vi.fn<PluginManagerPort["reloadSource"]>(async () => ({
  ok: true,
  state: currentSnapshot,
})),
```

Replace the local `marker` declaration and include `publishCatalog` in the returned object:

```ts
const marker = {
  update: vi.fn(),
  finish: vi.fn(),
  markThirdPartyStaticContributions: vi.fn(),
};
```

Add these tests in that same describe block, so they use its actual `setup`, `snapshot`, `builtin` and `key`:

```ts
it.each(["fetch", "state", "event"] as const)(
  "persists risk before the first third-party %s delivery without a process",
  (entry) => {
    const value = catalog();
    const { controller, manager, marker, publishCatalog } = setup({
      catalog: value,
      snapshot: staticSnapshot(value),
    });
    const order: string[] = [];
    marker.markThirdPartyStaticContributions.mockImplementation(() => order.push("persist"));
    controller.onEvent((event) => {
      if (event.type === "state") {
        order.push("deliver");
        expect(event.state.staticLanguageOwners).toEqual(owners(value));
      }
    });
    if (entry === "fetch") {
      expect(controller.staticLanguages()).toEqual(value);
      order.push("deliver");
    } else if (entry === "state") {
      expect(controller.state().staticLanguageOwners).toEqual(owners(value));
      order.push("deliver");
    } else publishCatalog(value);
    expect(order).toEqual(["persist", "deliver"]);
    expect(manager.active).toBe(false);
    controller.staticLanguages();
    controller.state();
    expect(marker.markThirdPartyStaticContributions).toHaveBeenCalledOnce();
  },
);

it("refuses post-startup static catalog delivery when marker persistence fails", async () => {
  const initial = catalog(1, [bp]);
  const { controller, manager, marker, publishCatalog } = setup({
    catalog: initial,
    snapshot: staticSnapshot(initial),
  });
  expect(controller.staticLanguages().languages).toEqual([bp]);
  expect(marker.markThirdPartyStaticContributions).not.toHaveBeenCalled();
  marker.markThirdPartyStaticContributions.mockImplementation(() => {
    throw new PluginError("PLUGIN_E_STATE_SAVE", "Marker storage is unavailable.");
  });
  const events: PluginsViewEvent[] = [];
  controller.onEvent((event) => events.push(event));
  manager.setEnabled.mockImplementation(async () => {
    publishCatalog(catalog(2));
    return { ok: true, state: manager.state() };
  });
  expect(await controller.setEnabled(key, true)).toMatchObject({
    ok: true,
    state: { stateProblem: { code: "PLUGIN_E_STATE_SAVE" } },
  });
  expect(controller.staticLanguages()).toMatchObject({
    revision: 2,
    languages: [bp],
    extensionRoutes: { bp: "bp" },
  });
  const state = controller.state();
  expect(state.staticLanguageOwners).toEqual(owners(catalog(2, [bp])));
  expect(state.plugins.find((item) => item.id === "acme.toy")?.problems).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: "PLUGIN_E_STATE_SAVE" })]),
  );
  expect(() => controller.reportLanguageRegistrationFailure(report(2))).toThrow("owner");
  expect(manager.reportLanguageRegistrationFailure).not.toHaveBeenCalled();
  for (const event of events)
    if (event.type === "state")
      expect(event.state.staticLanguageOwners.every((owner) => owner.sourceKey !== key)).toBe(true);
  // A delivery failure is latched for this session: the same revision never changes
  // from a builtin-only DTO to a third-party DTO on a later poll.
  marker.markThirdPartyStaticContributions.mockImplementation(() => {});
  publishCatalog(catalog(3));
  expect(controller.staticLanguages().languages).toEqual([bp]);
  expect(marker.markThirdPartyStaticContributions).toHaveBeenCalledOnce();
  expect(manager.resolveLanguageService).not.toHaveBeenCalled();
});

it("protects first-fetch failure and later reload delivery with the same gate", async () => {
  const value = catalog();
  const failed = setup({ catalog: value, snapshot: staticSnapshot(value) });
  failed.marker.markThirdPartyStaticContributions.mockImplementation(() => {
    throw new Error("read-only storage");
  });
  expect(failed.controller.staticLanguages().languages).toEqual([bp]);
  expect(failed.controller.state().stateProblem?.code).toBe("PLUGIN_E_STATE_SAVE");

  const initial = catalog(1, [bp]);
  const next = setup({ catalog: initial, snapshot: staticSnapshot(initial) });
  next.manager.reloadSource.mockImplementation(async () => {
    next.publishCatalog(catalog(2));
    return { ok: true, state: next.manager.state() };
  });
  expect(await next.controller.reload(key)).toMatchObject({ ok: true });
  expect(next.marker.markThirdPartyStaticContributions).toHaveBeenCalledOnce();
  expect(next.controller.staticLanguages().languages).toEqual([bp, toy]);
});

it("retains builtin routes, ambiguity and static-only status without PID checks", () => {
  const value = catalog();
  value.languages[0] = { ...bp, extensions: ["bp", "shared"] };
  value.languages[1] = { ...toy, extensions: ["toy", "shared"] };
  value.extensionRoutes.shared = null;
  value.conflicts = [
    {
      kind: "extension",
      key: "shared",
      sources: owners(value).map(({ pluginId, sourceKey, languageId }) => ({
        pluginId,
        sourceKey,
        languageId,
      })),
    },
  ];
  const { controller, marker } = setup({
    catalog: value,
    snapshot: staticSnapshot(value),
  });
  expect(controller.staticLanguages()).toEqual(value);
  expect(controller.state().plugins.find((item) => item.id === "acme.toy")).toMatchObject({
    runtime: "static",
    status: "enabled",
    running: false,
  });
  expect(marker.markThirdPartyStaticContributions).toHaveBeenCalledOnce();
});

it("does not expose third-party owners in safe mode even from an overpermissive mock", () => {
  const value = catalog();
  const { controller, manager, marker } = setup({
    catalog: value,
    snapshot: { ...staticSnapshot(value), safeMode: true },
  });
  expect(controller.staticLanguages().languages).toEqual([bp]);
  expect(controller.state().staticLanguageOwners).toEqual(owners(catalog(1, [bp])));
  expect(() => controller.reportLanguageRegistrationFailure(report())).toThrow("owner");
  expect(manager.reportLanguageRegistrationFailure).not.toHaveBeenCalled();
  expect(marker.markThirdPartyStaticContributions).not.toHaveBeenCalled();
});

it("retains hang detection after an exposed static source is removed", () => {
  const value = catalog();
  const { controller, marker, emit, publishCatalog } = setup({
    catalog: value,
    snapshot: staticSnapshot(value),
  });
  controller.staticLanguages();
  publishCatalog(catalog(2, [bp]));
  emit({ type: "state", state: { ...staticSnapshot(catalog(2, [bp])), plugins: [builtin] } });
  controller.markRendererUnresponsive();
  expect(marker.update).toHaveBeenLastCalledWith({ rendererUnresponsive: true });
});

it("rejects forged current ownership and ignores stale or duplicate registration reports", () => {
  const value = catalog();
  const { controller, manager, publishCatalog } = setup({
    catalog: value,
    snapshot: staticSnapshot(value),
  });
  for (const forged of [
    { ...report(), sourceKey: "dev:ffffffffffffffff" },
    { ...report(), languageId: "bp" },
    { ...report(), generation: 2 },
  ])
    expect(() => controller.reportLanguageRegistrationFailure(forged)).toThrow("owner");
  expect(manager.reportLanguageRegistrationFailure).not.toHaveBeenCalled();
  expect(controller.reportLanguageRegistrationFailure(report(0))).toEqual({
    accepted: false,
    revision: 1,
  });
  expect(controller.reportLanguageRegistrationFailure(report(2))).toEqual({
    accepted: false,
    revision: 1,
  });
  manager.reportLanguageRegistrationFailure.mockImplementation(() => {
    publishCatalog(catalog(2, [bp]));
    return { accepted: true, revision: 2 };
  });
  expect(controller.reportLanguageRegistrationFailure(report())).toEqual({
    accepted: true,
    revision: 2,
  });
  expect(manager.reportLanguageRegistrationFailure).toHaveBeenCalledExactlyOnceWith(report());
  expect(controller.reportLanguageRegistrationFailure(report())).toEqual({
    accepted: false,
    revision: 2,
  });
  expect(manager.reportLanguageRegistrationFailure).toHaveBeenCalledOnce();
  expect(controller.staticLanguages().languages).toEqual([bp]);
});

it.each(["node", "python"] as const)(
  "accepts one registration failure for a current static owner after its %s process crashes",
  (runtime) => {
    const value = catalog();
    const initial = staticSnapshot(value);
    initial.plugins[1] = { ...initial.plugins[1]!, runtime, running: true };
    const { controller, manager, emit, publishCatalog } = setup({
      catalog: value,
      snapshot: initial,
    });
    manager.active = true;
    expect(controller.staticLanguages()).toEqual(value);
    const crashProblem: PluginsSnapshot["plugins"][number]["problems"][number] = {
      code: "PLUGIN_E_CRASHED",
      message: "acme.toy: plugin process exited unexpectedly.",
    };
    manager.active = false;
    emit({
      type: "state",
      state: {
        ...initial,
        revision: initial.revision + 1,
        plugins: initial.plugins.map((plugin) =>
          plugin.sourceKey === key
            ? { ...plugin, status: "failed", running: false, problems: [crashProblem] }
            : plugin,
        ),
      },
    });
    expect(controller.state().plugins.find((plugin) => plugin.sourceKey === key)).toMatchObject({
      runtime,
      status: "failed",
      running: false,
    });
    expect(controller.state().staticLanguageOwners).toEqual(owners(value));
    expect(controller.staticLanguages()).toEqual(value);

    const events: PluginsViewEvent[] = [];
    controller.onEvent((event) => events.push(event));
    const registrationProblem: PluginsSnapshot["plugins"][number]["problems"][number] = {
      code: "PLUGIN_E_STATIC_LANGUAGE_REGISTRATION",
      message: `acme.toy / toy: renderer registration failed (monaco): ${report().detail}`,
      detail: { languageId: "toy" },
    };
    // Simulate T2's single host transaction: quarantine this contribution, append
    // its structured problem, advance the revision and publish complete owners.
    manager.reportLanguageRegistrationFailure.mockImplementation(() => {
      publishCatalog(
        catalog(2, [bp]),
        manager.state().plugins.map((plugin) =>
          plugin.sourceKey === key
            ? { ...plugin, problems: [...plugin.problems, registrationProblem] }
            : plugin,
        ),
      );
      return { accepted: true, revision: 2 };
    });
    expect(controller.reportLanguageRegistrationFailure(report())).toEqual({
      accepted: true,
      revision: 2,
    });
    expect(manager.reportLanguageRegistrationFailure).toHaveBeenCalledExactlyOnceWith(report());
    expect(controller.staticLanguages()).toEqual(catalog(2, [bp]));
    expect(controller.state().staticLanguagesRevision).toBe(2);
    expect(controller.state().staticLanguageOwners).toEqual(owners(catalog(2, [bp])));
    expect(controller.state().plugins.find((plugin) => plugin.sourceKey === key)).toMatchObject({
      status: "failed",
      running: false,
      problems: [crashProblem, registrationProblem],
    });
    expect(events).toEqual([{ type: "state", state: controller.state() }]);
    // Exact duplicates and older revisions are ignored. Rewriting the revision
    // cannot authorize an owner that the host has already quarantined.
    for (const stale of [report(), report(0)])
      expect(controller.reportLanguageRegistrationFailure(stale)).toEqual({
        accepted: false,
        revision: 2,
      });
    expect(() => controller.reportLanguageRegistrationFailure(report(2))).toThrow("owner");
    publishCatalog(catalog(3, [bp]));
    expect(controller.staticLanguages()).toEqual(catalog(3, [bp]));
    expect(() => controller.reportLanguageRegistrationFailure(report(3))).toThrow("owner");
    expect(manager.reportLanguageRegistrationFailure).toHaveBeenCalledOnce();
    expect(manager.setEnabled).not.toHaveBeenCalled();
    expect(manager.reloadSource).not.toHaveBeenCalled();
  },
);

it.each(["disabled", "invalid"] as const)(
  "rejects reports from a %s plugin even if a mock retains its catalog and owner",
  (status) => {
    const value = catalog();
    const inactive = staticSnapshot(value);
    inactive.plugins[1] = { ...inactive.plugins[1]!, status };
    const { controller, manager } = setup({ catalog: value, snapshot: inactive });
    expect(() => controller.reportLanguageRegistrationFailure(report())).toThrow("owner");
    expect(manager.reportLanguageRegistrationFailure).not.toHaveBeenCalled();
  },
);

it.each(["catalog", "owner", "plugin"] as const)(
  "rejects a failed-process report after its %s identity is withdrawn",
  (withdrawn) => {
    const value = catalog();
    const inactive = staticSnapshot(value);
    inactive.plugins[1] = { ...inactive.plugins[1]!, runtime: "node", status: "failed" };
    if (withdrawn === "owner") inactive.staticLanguageOwners = owners(catalog(1, [bp]));
    if (withdrawn === "plugin") inactive.plugins = [builtin];
    const { controller, manager } = setup({
      catalog: withdrawn === "catalog" ? catalog(1, [bp]) : value,
      snapshot: inactive,
    });
    expect(() => controller.reportLanguageRegistrationFailure(report())).toThrow("owner");
    expect(manager.reportLanguageRegistrationFailure).not.toHaveBeenCalled();
  },
);

it.each(["owner", "plugin"] as const)(
  "does not borrow another %s identity from a matching source and language",
  (mismatch) => {
    const value = catalog();
    const inconsistent = staticSnapshot(value);
    if (mismatch === "owner")
      inconsistent.staticLanguageOwners[1] = {
        ...inconsistent.staticLanguageOwners[1]!,
        pluginId: "acme.forged",
      };
    else inconsistent.plugins[1] = { ...inconsistent.plugins[1]!, id: "acme.forged" };
    const { controller, manager } = setup({ catalog: value, snapshot: inconsistent });
    expect(() => controller.reportLanguageRegistrationFailure(report())).toThrow("owner");
    expect(manager.reportLanguageRegistrationFailure).not.toHaveBeenCalled();
  },
);
```

- [ ] **Step 2: Run and expect FAIL**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/controller.test.ts -t 'PluginController with a fake manager'
```

Expected: FAIL because the controller has no static catalog/report methods and publishes owner metadata without the checked marker. If starting from the earlier enabled-only report recipe, both process-crash regressions fail at the accepted-report assertion with the current-owner error. No real static resource load is involved.

- [ ] **Step 3: Implement the controller boundary**

In `controller.ts`, add `PluginError` and `type PluginProblem` to the existing runtime import, and add this type-only shared import:

```ts
import type {
  StaticLanguagesCatalog,
  ReportLanguageRegistrationFailureInput,
  ReportLanguageRegistrationFailureResult,
} from "../../shared/static-languages.js";
```

Add `"staticLanguages" | "staticLanguagesRevision" | "reportLanguageRegistrationFailure"` to the `PluginManagerPort` pick. Replace the dependency's marker member with:

```ts
marker: Pick<SessionMarkerFile, "update" | "finish" | "markThirdPartyStaticContributions">;
```

Add these two fields beside `#helpCatalog`:

```ts
#staticRiskRecorded = false;
#staticSaveProblem: PluginProblem | undefined;
```

Insert the following methods after `state()` and before `diagnosticHelp()`:

```ts
staticLanguages(): StaticLanguagesCatalog {
  const snapshot = this.deps.manager.state();
  const permitted = this.#permitThirdPartyStatic(snapshot);
  const catalog = this.deps.manager.staticLanguages();
  if (catalog.revision !== snapshot.staticLanguagesRevision)
    throw new Error("Static language catalog and owner snapshot revisions differ.");
  if (permitted) return catalog;
  const builtinKeys = new Set(
    snapshot.plugins.filter((plugin) => plugin.source === "builtin").map((plugin) => plugin.sourceKey),
  );
  const languages = catalog.languages.filter((language) => builtinKeys.has(language.sourceKey));
  const ids = new Set(languages.map((language) => language.id));
  const extensions = new Set(languages.flatMap((language) => language.extensions));
  return {
    ...catalog,
    languages,
    // A former ambiguous route remains null; filtering never elects a new winner.
    extensionRoutes: Object.fromEntries(
      Object.entries(catalog.extensionRoutes).filter(([extension, id]) =>
        id === null ? extensions.has(extension) : ids.has(id),
      ),
    ),
    conflicts: catalog.conflicts.filter((conflict) =>
      conflict.sources.every((source) => builtinKeys.has(source.sourceKey)),
    ),
  };
}

reportLanguageRegistrationFailure(
  input: ReportLanguageRegistrationFailureInput,
): ReportLanguageRegistrationFailureResult {
  const catalog = this.staticLanguages();
  if (input.revision !== catalog.revision)
    return { accepted: false, revision: catalog.revision };
  const snapshot = this.deps.manager.state();
  const owner = snapshot.staticLanguageOwners.find((candidate) =>
    candidate.sourceKey === input.sourceKey &&
    candidate.languageId === input.languageId &&
    candidate.generation === input.generation,
  );
  const language = catalog.languages.find((candidate) =>
    candidate.sourceKey === input.sourceKey &&
    candidate.id === input.languageId &&
    candidate.generation === input.generation,
  );
  const plugin = snapshot.plugins.find((candidate) => candidate.sourceKey === input.sourceKey);
  // Process failure (packages/plugin-runtime/src/manager.ts:649) preserves static
  // eligibility while the delivered catalog and complete owner identity remain
  // current. running/manager.active do not authorize or withdraw contributions.
  if (!owner || !language || !plugin ||
      (plugin.status !== "enabled" && plugin.status !== "failed") ||
      owner.pluginId !== language.pluginId || plugin.id !== owner.pluginId)
    throw new PluginError(
      "PLUGIN_E_MANIFEST",
      "Registration report does not match a current static language owner.",
    );
  // T2 owns atomic quarantine, host-authored structured problems, revision changes
  // and retry only after reload/explicit enable. Never call reload in response here.
  return this.deps.manager.reportLanguageRegistrationFailure(input);
}

#permitThirdPartyStatic(snapshot: PluginsSnapshot): boolean {
  if (snapshot.safeMode) return false;
  if (this.#staticSaveProblem) return false;
  const thirdParty = snapshot.staticLanguageOwners.some((owner) =>
    !snapshot.plugins.some((plugin) =>
      plugin.sourceKey === owner.sourceKey &&
      plugin.id === owner.pluginId &&
      plugin.source === "builtin",
    ),
  );
  if (!thirdParty || this.#staticRiskRecorded) return true;
  try {
    this.deps.marker.markThirdPartyStaticContributions();
    this.#staticRiskRecorded = true;
    return true;
  } catch {
    this.#staticSaveProblem = {
      code: "PLUGIN_E_STATE_SAVE",
      message:
        "Third-party static languages were withheld because the recovery marker could not be saved. Restart Kobrixa after restoring writable settings storage.",
    };
    return false;
  }
}
```

At the beginning of `#view(snapshot)`, before reading `settings`, insert this block. Keeping the gate inside `#view` covers initial `state()`, every manager event, action-result state and controller-generated events; a fetch-only gate would miss the owner metadata channel.

```ts
const permitted = this.#permitThirdPartyStatic(snapshot);
if (!permitted) {
  const builtinKeys = new Set(
    snapshot.plugins
      .filter((plugin) => plugin.source === "builtin")
      .map((plugin) => plugin.sourceKey),
  );
  const problem = this.#staticSaveProblem;
  snapshot = {
    ...snapshot,
    staticLanguageOwners: snapshot.staticLanguageOwners.filter((owner) =>
      builtinKeys.has(owner.sourceKey),
    ),
    ...(problem && !snapshot.stateProblem ? { stateProblem: problem } : {}),
    plugins: snapshot.plugins.map((plugin) =>
      problem && plugin.source === "development"
        ? { ...plugin, problems: [...plugin.problems, problem] }
        : plugin,
    ),
  };
}
```

Replace `markRendererUnresponsive()` at its existing anchor:

```ts
markRendererUnresponsive(): void {
  if (
    !this.#staticRiskRecorded &&
    !this.deps.manager.state().plugins.some((plugin) => plugin.source === "development")
  )
    return;
  this.deps.marker.update({ rendererUnresponsive: true });
}
```

The marker failure latch is controller-local and lasts until restart; it does not disable a builtin, mutate compiler/service availability, manufacture a runtime catalog revision, or retry a failed contribution on polling. Its message exposes `PLUGIN_E_STATE_SAVE` through the existing plugin problem UI. Keeping a filtered DTO stable for a given runtime revision avoids same-revision recovery races. Normal disable/re-enable and successful reload still use T2's revisions and current catalog.

- [ ] **Step 4: Run and expect PASS**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/controller.test.ts src/main/plugins/session.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --write apps/desktop/src/main/plugins/controller.ts apps/desktop/src/main/plugins/controller.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec eslint apps/desktop/src/main/plugins/controller.ts apps/desktop/src/main/plugins/controller.test.ts
```

Expected: PASS, including current node/python owners whose process status is `"failed"`, one forwarded report, the resulting catalog/owner withdrawal, structured problem and revision/event delivery, and stale/duplicate suppression without automatic enable/reload. Disabled, invalid, withdrawn, safe-mode-hidden and mismatched identities remain rejected. The fake manager simulates T2's atomic quarantine/problem transaction; these tests prove controller authorization, forwarding and publication, not runtime quarantine construction. T2's real lifecycle and structured error construction are verified after merge.

- [ ] **Step 5: Controller commit**

```bash
git add apps/desktop/src/main/plugins/controller.ts apps/desktop/src/main/plugins/controller.test.ts
git commit -m "feat(desktop): gate static catalog delivery and authorize registration reports"
```

#### 3.3 Validate IPC payloads and preserve the frozen preload bridge

- [ ] **Step 1: Write the failing IPC tests and preload regression tests**

In `ipc.test.ts`, extend the existing runtime imports and add these imports and Electron mock. The real `registerIpc` wrapper is read-only to T3; testing it from a plugin-owned test does not transfer its ownership.

```ts
import { emptyStaticLanguagesCatalog } from "@kobrixa/plugin-runtime";
import type { ReportLanguageRegistrationFailureInput } from "../../shared/static-languages.js";
import { registerIpc } from "../ipc.js";

const electronHandlers = vi.hoisted(
  () => new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
);
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, action: (event: unknown, ...args: unknown[]) => unknown) =>
      electronHandlers.set(channel, action),
  },
}));
```

Add these methods to the existing `setup()` fake `plugins`, immediately after `diagnosticHelp`:

```ts
staticLanguages: vi.fn(() => emptyStaticLanguagesCatalog(7)),
reportLanguageRegistrationFailure: vi.fn<PluginIpcTarget["reportLanguageRegistrationFailure"]>(
  () => ({ accepted: false, revision: 7 }),
),
```

Add the two channel strings to the existing exact sorted channel expectation, without replacing its other channels:

```ts
"plugins:static-languages",
"plugins:report-language-registration-failure",
```

Append these tests to `ipc.test.ts`:

```ts
const registrationFailure = (): ReportLanguageRegistrationFailureInput => ({
  sourceKey: key,
  generation: 2,
  languageId: "toy",
  revision: 7,
  reason: "adapter",
  detail: "The validated language could not be adapted.",
});

it("forwards the current static catalog and all five allowed report reasons", () => {
  const { plugins, call } = setup();
  expect(call("plugins:static-languages")).toEqual(emptyStaticLanguagesCatalog(7));
  expect(plugins.staticLanguages).toHaveBeenCalledOnce();
  for (const reason of [
    "dto-version",
    "validation",
    "adapter",
    "monaco",
    "session-language-ids",
  ] as const) {
    const input = { ...registrationFailure(), reason };
    expect(call("plugins:report-language-registration-failure", input)).toEqual({
      accepted: false,
      revision: 7,
    });
    expect(plugins.reportLanguageRegistrationFailure).toHaveBeenLastCalledWith(input);
  }
});

it("rejects malformed reports, physical paths and extra fields before the controller", () => {
  const { plugins, call } = setup();
  for (const input of [
    null,
    [],
    { ...registrationFailure(), sourceKey: "dev:../../etc" },
    { ...registrationFailure(), sourceKey: "/tmp/plugin" },
    { ...registrationFailure(), languageId: "TOY" },
    { ...registrationFailure(), generation: -1 },
    { ...registrationFailure(), generation: 1.5 },
    { ...registrationFailure(), generation: Number.MAX_SAFE_INTEGER + 1 },
    { ...registrationFailure(), revision: -1 },
    { ...registrationFailure(), revision: Infinity },
    { ...registrationFailure(), reason: "reload" },
    { ...registrationFailure(), detail: { message: "bad" } },
    { ...registrationFailure(), detail: "a".repeat(2049) },
    { ...registrationFailure(), detail: "😀".repeat(2049) },
    { ...registrationFailure(), detail: "/Users/me/plugin/language.json" },
    { ...registrationFailure(), detail: "Failed at C:\\plugins\\language.json" },
    { ...registrationFailure(), detail: "Failed at \\\\server\\plugin\\language.json" },
    { ...registrationFailure(), detail: "Failed at file:///tmp/language.json" },
    { ...registrationFailure(), resourcePath: "/tmp/language.json" },
    { ...registrationFailure(), pluginId: "acme.forged" },
  ])
    expect(() => call("plugins:report-language-registration-failure", input)).toThrow();
  expect(plugins.reportLanguageRegistrationFailure).not.toHaveBeenCalled();
});

it("counts report detail in decoded code points and accepts the exact boundary", () => {
  const { plugins, call } = setup();
  for (const detail of ["", "a".repeat(2048), "😀".repeat(2048)]) {
    const input = { ...registrationFailure(), detail };
    call("plugins:report-language-registration-failure", input);
    expect(plugins.reportLanguageRegistrationFailure).toHaveBeenLastCalledWith(input);
  }
});

it("uses the real trusted-sender wrapper for catalog and registration-report channels", () => {
  const { plugins } = setup();
  electronHandlers.clear();
  const renderer = { id: 4, mainFrame: {} };
  let available = true;
  registerIpc(
    () => (available ? (renderer as never) : undefined),
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { run: (_channel: string, work: () => unknown) => work() } as never,
    () => {},
    () => {},
    undefined,
    [(handle) => registerPluginIpc(handle, plugins, () => {})],
  );
  const trusted = { sender: renderer, senderFrame: renderer.mainFrame };
  for (const channel of [
    "plugins:static-languages",
    "plugins:report-language-registration-failure",
  ]) {
    const handler = electronHandlers.get(channel)!;
    for (const event of [
      { ...trusted, sender: { id: 99 } },
      { ...trusted, senderFrame: {} },
    ])
      expect(() => handler(event, registrationFailure())).toThrow("untrusted");
    available = false;
    expect(() => handler(trusted, registrationFailure())).toThrow("untrusted");
    available = true;
  }
  expect(plugins.staticLanguages).not.toHaveBeenCalled();
  expect(plugins.reportLanguageRegistrationFailure).not.toHaveBeenCalled();
  expect(electronHandlers.get("plugins:static-languages")!(trusted)).toEqual(
    emptyStaticLanguagesCatalog(7),
  );
  electronHandlers.get("plugins:report-language-registration-failure")!(
    trusted,
    registrationFailure(),
  );
  expect(plugins.reportLanguageRegistrationFailure).toHaveBeenCalledExactlyOnceWith(
    registrationFailure(),
  );
});
```

Create `apps/desktop/src/preload/index.test.ts` with this complete file. T0 already implements the preload forwarding, so these are bridge regressions; the paired IPC behavior above is the red gate for this subsection.

```ts
import { beforeEach, expect, it, vi } from "vitest";
import type { KobrixaApi } from "../shared/api.js";
import type { PluginEvent } from "../shared/plugins.js";
import type {
  ReportLanguageRegistrationFailureInput,
  StaticLanguagesCatalog,
} from "../shared/static-languages.js";

const electron = vi.hoisted(() => ({
  expose: vi.fn<(name: string, api: KobrixaApi) => void>(),
  invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(async () => undefined),
  on: vi.fn(),
  removeListener: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener,
  },
}));
let api: KobrixaApi;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  await import("./index.js");
  expect(electron.expose).toHaveBeenCalledOnce();
  expect(electron.expose.mock.calls[0]![0]).toBe("kobrixa");
  api = electron.expose.mock.calls[0]![1];
});

it("returns the catalog promise through the frozen channel without transforming its DTO", async () => {
  const value: StaticLanguagesCatalog = {
    formatVersion: 1,
    limitsVersion: 1,
    revision: 9,
    languages: [],
    extensionRoutes: { toy: null },
    conflicts: [],
  };
  electron.invoke.mockResolvedValueOnce(value);
  await expect(api.plugins.staticLanguages()).resolves.toBe(value);
  expect(electron.invoke).toHaveBeenCalledExactlyOnceWith("plugins:static-languages");
});

it("forwards the exact report and returns its accepted/revision result", async () => {
  const input: ReportLanguageRegistrationFailureInput = {
    sourceKey: "dev:0123456789abcdef",
    generation: 3,
    languageId: "toy",
    revision: 9,
    reason: "validation",
    detail: "The language failed defensive validation.",
  };
  electron.invoke.mockResolvedValueOnce({ accepted: true, revision: 10 });
  await expect(api.plugins.reportLanguageRegistrationFailure(input)).resolves.toEqual({
    accepted: true,
    revision: 10,
  });
  expect(electron.invoke).toHaveBeenCalledExactlyOnceWith(
    "plugins:report-language-registration-failure",
    input,
  );
});

it("keeps the state revision and full owners on plugins:event and unsubscribes exactly once", () => {
  const listener = vi.fn<(event: PluginEvent) => void>();
  const off = api.plugins.onEvent(listener);
  expect(electron.on).toHaveBeenCalledOnce();
  const [channel, handler] = electron.on.mock.calls[0]!;
  expect(channel).toBe("plugins:event");
  const event: PluginEvent = {
    type: "state",
    state: {
      revision: 4,
      diagnosticHelpRevision: 0,
      staticLanguagesRevision: 9,
      staticLanguageOwners: [
        {
          pluginId: "acme.toy",
          sourceKey: "dev:0123456789abcdef",
          generation: 3,
          languageId: "toy",
          extensions: ["toy", "shared"],
        },
      ],
      safeMode: false,
      developmentMode: true,
      plugins: [],
      developer: { enabled: true, commandLine: true, linkedCount: 0 },
      origins: {},
      python: { pendingReload: [] },
      inflight: [],
    },
  };
  handler({}, event);
  expect(listener).toHaveBeenCalledExactlyOnceWith(event);
  off();
  expect(electron.removeListener).toHaveBeenCalledExactlyOnceWith("plugins:event", handler);
});

it("preserves IPC rejection so renderer bootstrap can choose its plaintext fallback", async () => {
  electron.invoke.mockRejectedValueOnce(new Error("IPC unavailable"));
  await expect(api.plugins.staticLanguages()).rejects.toThrow("IPC unavailable");
});
```

- [ ] **Step 2: Run and expect FAIL**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/ipc.test.ts src/preload/index.test.ts src/shared/static-languages.test.ts
```

Expected: FAIL because T0's IPC catalog/report handlers bypass the controller and do not reject malformed reports. Preload and shared signature tests should already pass from T0.

- [ ] **Step 3: Replace the empty IPC handlers with strict validation and controller calls**

In `ipc.ts`, remove T0's value import of `emptyStaticLanguagesCatalog`; extend the protocol import to `compilerIdSchema, namespacedIdSchema`; add this type-only import:

```ts
import type { ReportLanguageRegistrationFailureInput } from "../../shared/static-languages.js";
```

Add `"staticLanguages" | "reportLanguageRegistrationFailure"` to `PluginIpcTarget`. After the existing `cursorSchema`, add this complete local parser. This is an IPC boundary schema, not a public resource schema; its code-point and path checks do not need JSON Schema export. The renderer must send a bounded, path-free diagnostic, not an unfiltered stack trace.

```ts
const reportCounterSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const registrationFailureSchema: z.ZodType<ReportLanguageRegistrationFailureInput> = z.strictObject(
  {
    sourceKey: sourceKeySchema,
    generation: reportCounterSchema,
    languageId: compilerIdSchema,
    revision: reportCounterSchema,
    reason: z.enum(["dto-version", "validation", "adapter", "monaco", "session-language-ids"]),
    detail: z
      .string()
      .max(4096)
      .refine((value) => Array.from(value).length <= 2048, "Detail exceeds 2,048 code points.")
      .refine(
        (value) => !/(?:^|[\s"'(=])(?:\/[^\s]|[a-z]:[\\/]|\\\\|file:\/\/)/iu.test(value),
        "Registration detail must not contain a physical path.",
      ),
  },
);
```

Replace only T0's two stub registrations with:

```ts
handle("plugins:static-languages", () => plugins.staticLanguages());
handle("plugins:report-language-registration-failure", (_event, input: unknown) =>
  plugins.reportLanguageRegistrationFailure(registrationFailureSchema.parse(input)),
);
```

Leave the actual `preload/index.ts` methods and shared type-only modules from T0 unchanged. Do not introduce `ipcMain.handle` in this feature module: `main/index.ts` already passes `registerIpc`'s trusted wrapper to `registerPluginIpc`, and the test above exercises that exact wrapper rather than reproducing its checks. No second event channel, renderer path input, dynamic import of runtime in shared code or altered report result is needed.

- [ ] **Step 4: Run and expect PASS**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/ipc.test.ts src/preload/index.test.ts src/shared/static-languages.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --write apps/desktop/src/main/plugins/ipc.ts apps/desktop/src/main/plugins/ipc.test.ts apps/desktop/src/preload/index.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec eslint apps/desktop/src/main/plugins/ipc.ts apps/desktop/src/main/plugins/ipc.test.ts apps/desktop/src/preload/index.test.ts
```

Expected: PASS for current/ambiguous catalog serialization, all allowed reasons, malformed input, exact code-point bounds, trusted frame/sender rejection, existing channel regressions, Promise propagation and unsubscribe behavior.

- [ ] **Step 5: Controller commit**

```bash
git add apps/desktop/src/main/plugins/ipc.ts apps/desktop/src/main/plugins/ipc.test.ts apps/desktop/src/preload/index.test.ts
git commit -m "feat(desktop): wire trusted static language catalog and report IPC"
```

#### 3.4 Decide recovery and safe mode before any development-folder access

- [ ] **Step 1: Write failing startup-order and persisted-disable tests**

In `controller.test.ts`, add `PluginManager`, `type PluginManagerOptions` and `type PluginPersistedState` to the existing runtime import. Inside the fake-manager describe block, add this helper and the tests below. They run the real `startPlugins`, file settings store and marker, but intercept `PluginManager.create` before it could read resources or launch anything. Do not replace the existing node/python regression tests.

```ts
function captureStartup(manager: ReturnType<typeof setup>["manager"]) {
  const creates: PluginManagerOptions[] = [];
  const persisted: (PluginPersistedState & { problem?: string })[] = [];
  vi.spyOn(PluginManager, "create").mockImplementation(async (options) => {
    creates.push(options);
    persisted.push(await options.store.load());
    return manager as unknown as PluginManager;
  });
  return { creates, persisted };
}

it.each(["cli", "lock", "corrupt", "static-crash", "hang"] as const)(
  "decides %s safe mode before resolving any development folder",
  async (condition) => {
    const directory = path.join(root, "must-not-be-read");
    const sourceKey = developmentSourceKey(directory);
    const document: PluginStateDocument = {
      schemaVersion: 2,
      developerMode: true,
      sources: [{ directory }],
      disabled: [sourceKey],
      legacyDisabledIds: ["acme.old"],
      ...(condition === "lock"
        ? {
            safeModeLock: {
              since: "2026-10-15T00:00:00.000Z",
              reason: "unclean-exit" as const,
            },
          }
        : {}),
    };
    await mkdir(path.join(userData, "plugins"), { recursive: true });
    await writeFile(
      path.join(userData, "plugins/state.json"),
      condition === "corrupt" ? "{broken" : JSON.stringify(document),
    );
    if (condition === "static-crash" || condition === "hang")
      await writeFile(
        path.join(userData, "plugins/session.json"),
        JSON.stringify({
          startedAt: "2026-10-15T00:00:00.000Z",
          thirdPartyRunning: false,
          thirdPartyStaticContributions: true,
          rendererUnresponsive: condition === "hang",
        }),
      );
    const { manager } = setup({ snapshot: { ...snapshot, safeMode: true } });
    const captured = captureStartup(manager);
    const resolve = vi.fn(async () => {
      throw new Error("Safe mode must not touch a development directory.");
    });
    const launcher = vi.fn();
    const controller = await start(fakeDialogs(), {
      commandLine: { developmentDirectories: [directory], safeMode: condition === "cli" },
      realpath: resolve,
      launcher: () => launcher,
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(launcher).not.toHaveBeenCalled();
    expect(captured.creates).toHaveLength(1);
    expect(captured.creates[0]!.safeMode).toBe(true);
    // The runtime receives inert source descriptors for the recovery UI. T2 owns
    // proving that safeMode prevents manifest and resource reads of those descriptors.
    expect(captured.creates[0]!.sources).toEqual([{ kind: "development", directory }]);
    if (condition === "corrupt") expect(captured.persisted[0]!.problem).toBeDefined();
    else {
      expect([...captured.persisted[0]!.disabled]).toEqual([sourceKey]);
      expect([...captured.persisted[0]!.legacyDisabledIds]).toEqual(["acme.old"]);
    }
    if (condition === "static-crash" || condition === "hang") {
      const reason = condition === "hang" ? "renderer-unresponsive" : "unclean-exit";
      expect(controller.state().safeModeLock?.reason).toBe(reason);
      expect((await saved()).safeModeLock.reason).toBe(reason);
    }
  },
);

it("retains static crash recovery after the last development source was removed", async () => {
  await mkdir(path.join(userData, "plugins"), { recursive: true });
  await writeFile(
    path.join(userData, "plugins/session.json"),
    JSON.stringify({
      startedAt: "2026-10-15T00:00:00.000Z",
      thirdPartyRunning: false,
      thirdPartyStaticContributions: true,
      rendererUnresponsive: false,
    }),
  );
  const { manager } = setup({ snapshot: { ...snapshot, safeMode: true, plugins: [] } });
  const captured = captureStartup(manager);
  const controller = await start();
  expect(captured.creates[0]!.safeMode).toBe(true);
  expect(captured.creates[0]!.sources).toEqual([]);
  expect(controller.state().safeModeLock?.reason).toBe("unclean-exit");
  expect((await saved()).safeModeLock.reason).toBe("unclean-exit");
});

it("gives a renderer hang priority over an older unclean-exit lock", async () => {
  const directory = path.join(root, "static-source");
  const document: PluginStateDocument = {
    schemaVersion: 2,
    developerMode: true,
    sources: [{ directory }],
    disabled: [],
    legacyDisabledIds: [],
    safeModeLock: { since: "2026-10-14T00:00:00.000Z", reason: "unclean-exit" },
  };
  await mkdir(path.join(userData, "plugins"), { recursive: true });
  await writeFile(path.join(userData, "plugins/state.json"), JSON.stringify(document));
  await writeFile(
    path.join(userData, "plugins/session.json"),
    JSON.stringify({
      startedAt: "2026-10-15T00:00:00.000Z",
      thirdPartyRunning: false,
      thirdPartyStaticContributions: true,
      rendererUnresponsive: true,
    }),
  );
  const { manager } = setup({ snapshot: { ...snapshot, safeMode: true } });
  captureStartup(manager);
  const controller = await start();
  expect(controller.state().safeModeLock?.reason).toBe("renderer-unresponsive");
  expect((await saved()).safeModeLock.reason).toBe("renderer-unresponsive");
});

it("preserves individual disables when the user explicitly leaves recovery mode", async () => {
  const directory = path.join(root, "disabled-static-source");
  const sourceKey = developmentSourceKey(directory);
  const document: PluginStateDocument = {
    schemaVersion: 2,
    developerMode: true,
    sources: [{ directory }],
    disabled: [sourceKey],
    legacyDisabledIds: ["acme.old"],
    safeModeLock: { since: "2026-10-15T00:00:00.000Z", reason: "unclean-exit" },
  };
  await mkdir(path.join(userData, "plugins"), { recursive: true });
  await writeFile(path.join(userData, "plugins/state.json"), JSON.stringify(document));
  const { manager } = setup({ snapshot: { ...snapshot, safeMode: true } });
  captureStartup(manager);
  const controller = await start();
  expect(manager.leaveSafeMode).not.toHaveBeenCalled();
  expect(await controller.clearSafeModeLock()).toMatchObject({ ok: true });
  expect(manager.leaveSafeMode).toHaveBeenCalledOnce();
  expect(await saved()).toMatchObject({
    disabled: [sourceKey],
    legacyDisabledIds: ["acme.old"],
  });
  expect((await saved()).safeModeLock).toBeUndefined();
});

it("still canonicalizes command-line folders outside safe mode after loading disables", async () => {
  const directory = path.join(root, "spelling");
  const canonical = path.join(root, "canonical");
  const sourceKey = developmentSourceKey(canonical);
  await mkdir(path.join(userData, "plugins"), { recursive: true });
  await writeFile(
    path.join(userData, "plugins/state.json"),
    JSON.stringify({
      schemaVersion: 2,
      developerMode: false,
      sources: [],
      disabled: [sourceKey],
      legacyDisabledIds: [],
    }),
  );
  const { manager } = setup();
  const captured = captureStartup(manager);
  const resolve = vi.fn(async () => canonical);
  await start(fakeDialogs(), {
    commandLine: { developmentDirectories: [directory], safeMode: false },
    realpath: resolve,
  });
  expect(resolve).toHaveBeenCalledExactlyOnceWith(directory);
  expect(captured.creates[0]!.safeMode).toBe(false);
  expect(captured.creates[0]!.sources).toEqual([{ kind: "development", directory: canonical }]);
  expect([...captured.persisted[0]!.disabled]).toEqual([sourceKey]);
});
```

- [ ] **Step 2: Run and expect FAIL**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/controller.test.ts -t 'PluginController with a fake manager'
```

Expected: FAIL because current startup calls `realpath` before its safe-mode decision, omits corrupt settings from the explicit `safeMode` argument, discards static risk when no current source exists, and does not upgrade an older lock to the hang reason. Persisted-disable preservation is an existing regression that should remain green.

- [ ] **Step 3: Reorder startup without changing the main/renderer barrier contract**

In `startPlugins`, keep the settings load and `const unclean = marker.begin()` lines. Replace the block from `const resolve = ...` through the old `const safeMode = ...` (baseline lines 617–642) with the complete block below. Retain everything starting at `const logs = new PluginLogs()`; its manager creation still receives `directories`, `safeMode`, the already loaded settings and the existing hooks.

```ts
const resolve = options.realpath ?? ((directory: string) => realpath(directory));
const document = settings.settings();
const requestedDirectories = options.commandLine.developmentDirectories.map((directory) =>
  path.resolve(directory),
);
const developer = document.developerMode || requestedDirectories.length > 0;
const hasDevelopmentSources =
  developer && (document.sources.length > 0 || requestedDirectories.length > 0);
const relevantUnclean =
  hasDevelopmentSources || marker.previousThirdPartyStaticContributions ? unclean : undefined;
const lock = document.safeModeLock;
if (
  relevantUnclean &&
  (!lock || (relevantUnclean === "renderer-unresponsive" && lock.reason !== relevantUnclean))
)
  await settings
    .update((current) => ({
      ...current,
      safeModeLock: { since: now().toISOString(), reason: relevantUnclean },
    }))
    .catch(() => undefined);
const safeMode =
  options.commandLine.safeMode ||
  loaded.problem !== undefined ||
  relevantUnclean !== undefined ||
  settings.settings().safeModeLock !== undefined;
// path.resolve is lexical only. Safe mode must not even realpath a development folder.
const sessionDirectories = safeMode
  ? requestedDirectories
  : await Promise.all(
      requestedDirectories.map((directory) => resolve(directory).catch(() => directory)),
    );
const directories = developer
  ? uniqueDirectories([
      ...document.sources.map((source) => source.directory),
      ...sessionDirectories,
    ])
  : [];
```

`main/index.ts` already awaits `startPlugins()` before creating dependent services and registering the plugin IPC module; leave that await and the renderer-health/quit hooks in place. Renderer restoration and the 5,000 ms bootstrap barrier belong to T5. Safe mode passes inert development source descriptors for the settings UI; the manager contract, tested for real by T2/T8, skips their folders entirely. The controller never reads grammar files or compiles document regexes.

- [ ] **Step 4: Run startup and recovery verification and expect PASS**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/controller.test.ts src/main/plugins/session.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --write apps/desktop/src/main/plugins/controller.ts apps/desktop/src/main/plugins/controller.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec eslint apps/desktop/src/main/plugins/controller.ts apps/desktop/src/main/plugins/controller.test.ts
```

Expected: PASS for early safe-mode decisions, static-only restart recovery, hang-priority locks, canonicalization outside safe mode and retained individual disables. Existing node/python and developer-mode regressions also pass.

- [ ] **Step 5: Controller commit**

```bash
git add apps/desktop/src/main/plugins/controller.ts apps/desktop/src/main/plugins/controller.test.ts
git commit -m "fix(desktop): decide plugin recovery before accessing development folders"
```

#### 3.5 Explain static-language trust in the native entry points

- [ ] **Step 1: Write failing bilingual dialog tests**

Append to `dialogs.test.ts`, using its existing `showMessageBox` mock and reset hook:

```ts
it.each(["en", "zh-TW"] as const)(
  "explains static-language editor blocking without a plugin process in %s",
  async (locale) => {
    showMessageBox.mockResolvedValue({ response: 0 });
    const dialogs = electronPluginDialogs(() => undefined, locale);
    expect(await dialogs.confirmDeveloperMode()).toBe(true);
    expect(
      await dialogs.confirmLink({
        name: "Toy",
        id: "acme.toy",
        runtime: "static",
        directory: "/p/toy",
        problems: [],
      }),
    ).toBe(true);
    const required =
      locale === "en"
        ? ["Static language rules", "block the editor", "without a plugin process"]
        : ["靜態語言規則", "編輯器無回應", "沒有插件程序"];
    for (const [options] of showMessageBox.mock.calls)
      for (const text of required) expect(options.detail).toContain(text);
    const developer = showMessageBox.mock.calls[0]![0];
    expect(developer.defaultId).toBe(1);
    expect(developer.cancelId).toBe(1);
    const link = showMessageBox.mock.calls[1]![0];
    expect(link.detail).toContain("static");
    expect(link.detail).toContain("acme.toy");
  },
);
```

- [ ] **Step 2: Run and expect FAIL**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/dialogs.test.ts
```

Expected: FAIL because the current copy describes executable plugin programs only.

- [ ] **Step 3: Update the four existing copy properties**

In `dialogs.ts`, replace only these `copy.en` properties; retain all other strings and dialog behavior:

```ts
developerDetail:
  "Developer mode runs plugin code with your permissions on this computer. It is not a sandbox. Static language rules can block the editor even without a plugin process. Link only folders you trust.",
trust:
  "Link only plugins you trust. Plugin code runs with your permissions on this computer. Static language rules can block the editor even without a plugin process.",
```

Replace only the matching `copy["zh-TW"]` properties:

```ts
developerDetail:
  "開發者模式會以你的權限，在這部電腦上執行插件程式碼。這不是沙箱。靜態語言規則即使沒有插件程序，也可能讓編輯器無回應。請只連結你信任的資料夾。",
trust:
  "請只連結你信任的插件。插件程式碼會以你的權限在這部電腦上執行。靜態語言規則即使沒有插件程序，也可能讓編輯器無回應。",
```

The existing developer/link confirmation remains the entry point; this does not add a new confirmation flow. Author documentation and the `--plugin-dev-dir` trust explanation in documentation stay with T7.

- [ ] **Step 4: Run the complete T3 branch-local verification and expect PASS**

Run from the repository root. The first two builds are required because desktop imports package `dist/`; these are T0 contracts on this branch. The targeted test list includes existing settings, process cleanup, dialogs and launcher regressions without running T6-owned `builtin.test.ts` or other workers' unfinished tests.

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/controller.test.ts src/main/plugins/session.test.ts src/main/plugins/ipc.test.ts src/main/plugins/state-store.test.ts src/main/plugins/options.test.ts src/main/plugins/dialogs.test.ts src/main/plugins/launchers.test.ts src/main/plugins/logs.test.ts src/main/plugins/python.test.ts src/main/plugins/quit.test.ts src/preload/index.test.ts src/shared/static-languages.test.ts src/main/workspace/compiler-chain.test.ts src/main/language/language-provider.integration.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop check
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --write apps/desktop/src/main/plugins/session.ts apps/desktop/src/main/plugins/session.test.ts apps/desktop/src/main/plugins/controller.ts apps/desktop/src/main/plugins/controller.test.ts apps/desktop/src/main/plugins/ipc.ts apps/desktop/src/main/plugins/ipc.test.ts apps/desktop/src/main/plugins/dialogs.ts apps/desktop/src/main/plugins/dialogs.test.ts apps/desktop/src/preload/index.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --check apps/desktop/src/main/plugins/session.ts apps/desktop/src/main/plugins/session.test.ts apps/desktop/src/main/plugins/controller.ts apps/desktop/src/main/plugins/controller.test.ts apps/desktop/src/main/plugins/ipc.ts apps/desktop/src/main/plugins/ipc.test.ts apps/desktop/src/main/plugins/dialogs.ts apps/desktop/src/main/plugins/dialogs.test.ts apps/desktop/src/preload/index.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec eslint apps/desktop/src/main/plugins/session.ts apps/desktop/src/main/plugins/session.test.ts apps/desktop/src/main/plugins/controller.ts apps/desktop/src/main/plugins/controller.test.ts apps/desktop/src/main/plugins/ipc.ts apps/desktop/src/main/plugins/ipc.test.ts apps/desktop/src/main/plugins/dialogs.ts apps/desktop/src/main/plugins/dialogs.test.ts apps/desktop/src/preload/index.test.ts
git diff --check
```

Expected: all listed checks PASS using T0 plus this task. Shared contract tests must keep type-only imports so they do not evaluate T4/T5/T6 stubs. The two reassigned compiler/service tests use their T0 `resources: {}` compatibility edits; they do not claim static-language integration. Do not run broad Prettier writes, install dependencies, update generated schemas or fix another task's files. Report any baseline or environment failure precisely to the controller rather than adding an undeclared write.

- [ ] **Step 5: Controller commit**

```bash
git add apps/desktop/src/main/plugins/dialogs.ts apps/desktop/src/main/plugins/dialogs.test.ts
git commit -m "docs(desktop): explain static language risks in plugin dialogs"
```

**Deferred to T8**

- Real T2 manager integration: eligible/disabled/safe-mode resource reads, static-only and mixed node/python zero-launch behavior, atomic revision/owner catalog updates, host-authored structured registration problems, duplicate suppression and quarantine reset only on reload/explicit enable. Retain the P1 crash-then-report regression through the real controller/manager: a process-failed current owner accepts exactly one report, withdraws that contribution, exposes `PLUGIN_E_STATIC_LANGUAGE_REGISTRATION` with `detail.languageId`, advances the static revision and rejects stale/duplicate reports. T3's fake manager cannot establish these runtime behaviors.
- Actual Electron catalog/report IPC with T4/T5: subscribe-before-fetch, stale replies, immediate owner revocation, all-model reconciliation, renderer bootstrap timeout/plaintext restoration, no analysis-worker restart from a lexical revision, and registration report text generated by real adapter/Monaco failures.
- T6/T7 builtin raw-resource packaging, required Basic Plus behavior, no-repository packaged launches, static-only enable/disable/restart, post-startup marker-write failure smoke, and next-launch recovery after a real renderer hang. Unit tests do not claim OS power-loss durability or that synchronous regex can be interrupted.
- Full workspace checks, desktop bundle/packaging and the existing completion/highlighting/indentation/recovery acceptance run after all writers hand off. Main's existing await is preserved; T5 owns the renderer restoration barrier and T7 owns the smoke preload/N1 guard.

**Contract gaps**

- T0's `begin(): SafeModeLock["reason"] | undefined` loses whether an unclean exit involved an exposed static contribution. T3 defines `SessionMarkerFile.previousThirdPartyStaticContributions: boolean` as a read-only getter in its own `session.ts` and consumes it only in its own `startPlugins`; this keeps recovery sticky after the final source is removed while preserving the existing process-only/no-source behavior. No other task needs a new import or signature.
- T0 does not define marker-failure recovery within a still-running session. T3 resolves it locally with a session-long delivery-failure latch: publish a consistent builtin-only projection at the manager's unchanged revision, expose `PLUGIN_E_STATE_SAVE`, and require restart after storage is repaired. This avoids changing catalog contents under one revision and leaves all frozen DTOs and cross-task APIs unchanged.
### Task 4: Renderer static-language store, adapter, resolver, and registration lifecycle

**Files:**

- Modify (T0-created): `apps/desktop/src/renderer/editor/static-language-routing.ts` — replace the `resolveLexicalLanguage` stub; retain T0's public types.
- Modify (T0-created): `apps/desktop/src/renderer/editor/static-language-adapter.ts` — replace the `adaptStaticLanguage` stub.
- Modify (T0-created): `apps/desktop/src/renderer/editor/static-language-store.ts` — replace the `createStaticLanguageStore` stub.
- Modify (T0-created): `apps/desktop/src/renderer/editor/static-language-registration.ts` — replace the `createStaticLanguageRegistrar` stub; retain T0's public types.
- Create/test: `apps/desktop/src/renderer/editor/static-language-routing.test.ts`.
- Create/test: `apps/desktop/src/renderer/editor/static-language-adapter.test.ts`.
- Create/test: `apps/desktop/src/renderer/editor/static-language-store.test.ts`.
- Create/test: `apps/desktop/src/renderer/editor/static-language-registration.test.ts`.

These eight paths are the entire write set. Start in the controller-created T4 worktree at the T0 commit. The four production files do not exist in the pre-T0 checkout inspected while drafting this plan; their precise replacement anchors are T0 Step 6's named stub functions, not invented current line numbers. Read-only baseline anchors are `apps/desktop/src/shared/language-services.ts:33` (`supportsFile`), `apps/desktop/src/renderer/editor/language-status-store.ts:6` (subscription/stale-result precedent), `apps/desktop/src/renderer/editor/language-routing.ts:14` (old resolver, owned by T5), and `apps/desktop/src/renderer/editor/companions/basic-plus/registration.ts:5` (old Monarch definition, owned by T6). Do not edit them.

**Interfaces:**

- Consumes: `LanguageBinding`, `supportsFile(binding: LanguageBinding, file: string): boolean` from `../../shared/language-services.js`; `PluginsApi`, `PluginEvent`, `PluginsView` from `../../shared/plugins.js`; T0's type-only `StaticLanguageOwner`, `ValidatedStaticLanguage`, `StaticLanguagesCatalog`, `ReportLanguageRegistrationFailureInput`, and `ReportLanguageRegistrationFailureResult` from `../../shared/static-languages.js`.
- Consumes: `STATIC_LANGUAGE_FORMAT_VERSION`, `STATIC_LANGUAGE_LIMITS_V1`, `validateStaticLanguageResources(input: ValidateStaticLanguageResourcesInput): StaticLanguageValidationResult` from `@kobrixa/plugin-protocol`. Pass the host's original `resourceBytes`; never stringify resources to reconstruct byte counts. A successful validation result supplies typed `tokenizer`, `configuration`, `resourceBytes`, `expandedRules`, `rules`, and `regexes`.
- Consumes: `StaticLanguageStoreApi = Pick<PluginsApi, "state" | "staticLanguages" | "onEvent">`; state events are exactly `{ type: "state", state: PluginsView }` with `staticLanguagesRevision` and the complete `staticLanguageOwners`. Notice events do not trigger catalog work.
- Produces: `resolveLexicalLanguage(input: ResolveLexicalLanguageInput): LexicalLanguageRoute`, `StaticRouteOwner`, and the unchanged T0 route/input types. Resolution order is core → applicable selected binding's same owner → unique global extension → plaintext. An applicable binding with unavailable static resources stops at plaintext.
- Produces: `adaptStaticLanguage(language: ValidatedStaticLanguage): MonacoStaticLanguageDefinition`, whose fields are `tokenizer: languages.IMonarchLanguage` and `configuration: languages.LanguageConfiguration`.
- Produces: `createStaticLanguageStore(api: StaticLanguageStoreApi): StaticLanguageStore`; `getSnapshot(): StaticLanguageStoreSnapshot`, `subscribe(listener: () => void): () => void`, `ready(): Promise<void>`, `refresh(): Promise<void>`, `dispose(): void`. Snapshot fields remain `phase`, `targetRevision`, `owners`, `catalog`, and optional `error` exactly as frozen by T0.
- Produces: `createStaticLanguageRegistrar(input: CreateStaticLanguageRegistrarInput): StaticLanguageRegistrar`, consuming T0's `MonacoStaticLanguageApi`, store, report API, and `coreExtensionRoutes`. Methods remain `reconcile(snapshot): void`, `trackModel(model, context, hooks?): IDisposable`, `refreshModels(): void`, `resolve(context): LexicalLanguageRoute`, `getRoute(model): LexicalLanguageRoute | undefined`, `getActiveOwners(): readonly StaticLanguageOwner[]`, `subscribe(listener): () => void`, and `dispose(): void`. Context/hook types remain `StaticModelContext` and `StaticModelRouteHooks`; `beforeChange(previous, next)` is the synchronous detach/semantic-clear boundary, and `afterChange(route)` is the reattachment boundary.
- Produces (T4-local addition): `StaticLanguageAdapterError` in `static-language-adapter.ts`, carrying `reason: "validation" | "adapter"`. This distinguishes the two frozen report reasons without parsing exception text; it adds no IPC shape or dependency on another task.

The factory pair is window-scoped. T5 owns construction outside React render, bootstrap, model-context wiring, and disposal on window shutdown. Individual editors release tracking leases, never dispose the shared manager. T4 tests mock only the protocol validator and preload port; their own resolver/store/adapter/registrar are real. No test imports another parallel task's implementation. Resource fixtures are read from T0's exact paths and never edited.

#### 4.1 Ordered lexical routing

- [ ] **Step 1: Write the failing resolver tests**

Create `apps/desktop/src/renderer/editor/static-language-routing.test.ts`:

```ts
import { expect, it } from "vitest";
import type { LanguageBinding } from "../../shared/language-services.js";
import type {
  StaticLanguageOwner,
  StaticLanguagesCatalog,
  ValidatedStaticLanguage,
} from "../../shared/static-languages.js";
import { resolveLexicalLanguage } from "./static-language-routing.js";

function language(id: string, extensions = ["toy"]): ValidatedStaticLanguage {
  return {
    id,
    extensions,
    pluginId: `acme.${id}`,
    sourceKey: `development:${id}`,
    generation: 1,
    aliases: [`Language ${id}`],
    resourceDigest: `digest:${id}`,
    tokenizer: { ignoreCase: false, states: [{ name: "root", rules: [] }] },
    configuration: {},
    resourceBytes: { tokenizer: 64, configuration: 3 },
    expandedRules: 0,
  };
}
const a = language("toy-a", ["toy", "a"]);
const b = language("toy-b", ["toy", "b"]);
const owner = (value: ValidatedStaticLanguage): StaticLanguageOwner => ({
  pluginId: value.pluginId,
  sourceKey: value.sourceKey,
  generation: value.generation,
  languageId: value.id,
  extensions: value.extensions,
});
const binding: LanguageBinding = {
  pluginId: a.pluginId,
  sourceKey: a.sourceKey,
  language: a.id,
  epoch: 19,
  extensions: a.extensions,
  capabilities: ["analysis"],
  frontend: {
    language: a.id,
    entryExtensions: ["a"],
    sourceExtensions: a.extensions,
    ir: { min: 1, max: 1 },
  },
};
const catalog: StaticLanguagesCatalog = {
  formatVersion: 1,
  limitsVersion: 1,
  revision: 7,
  languages: [a, b],
  extensionRoutes: { toy: null, a: a.id, b: b.id },
  conflicts: [],
};
const input = {
  file: "main.toy",
  catalog,
  activeOwners: [owner(a), owner(b)],
  coreExtensionRoutes: { json: "json" },
};

it("keeps core routes first and uses only the final case-insensitive extension", () => {
  expect(
    resolveLexicalLanguage({ ...input, file: "C:\\project.toy\\MAIN.JSON", binding }),
  ).toMatchObject({ monacoLanguage: "json", displayName: "JSON", kind: "core" });
  for (const file of ["README", "main.a.txt", "folder.a/README", "main."]) {
    expect(resolveLexicalLanguage({ ...input, file }).monacoLanguage).toBe("plaintext");
  }
  expect(resolveLexicalLanguage({ ...input, file: "中文.A" })).toMatchObject({
    monacoLanguage: "toy-a",
    displayName: "Language toy-a",
    catalogRevision: 7,
    staticOwner: {
      pluginId: a.pluginId,
      sourceKey: a.sourceKey,
      generation: a.generation,
      languageId: a.id,
    },
  });
});

it("uses an applicable selected owner to disambiguate without crossing owners", () => {
  expect(resolveLexicalLanguage(input).monacoLanguage).toBe("plaintext");
  expect(resolveLexicalLanguage({ ...input, binding }).monacoLanguage).toBe("toy-a");
  expect(
    resolveLexicalLanguage({ ...input, binding, activeOwners: [owner(b)] }).monacoLanguage,
  ).toBe("plaintext");
  expect(
    resolveLexicalLanguage({ ...input, binding: { ...binding, sourceKey: "other" } })
      .monacoLanguage,
  ).toBe("plaintext");
  expect(resolveLexicalLanguage({ ...input, binding, file: "main.b" }).monacoLanguage).toBe(
    "toy-b",
  );
  expect(
    resolveLexicalLanguage({
      ...input,
      file: "main.a",
      activeOwners: [{ ...owner(a), generation: 2 }],
    }).monacoLanguage,
  ).toBe("plaintext");
});

it("does not infer Basic Plus or read inherited route keys", () => {
  const inherited = Object.create({ toy: "toy-a" }) as Record<string, string | null>;
  expect(
    resolveLexicalLanguage({ ...input, catalog: { ...catalog, extensionRoutes: inherited } })
      .monacoLanguage,
  ).toBe("plaintext");
  const core = Object.create({ toy: "json" }) as Record<string, string>;
  expect(resolveLexicalLanguage({ ...input, coreExtensionRoutes: core }).monacoLanguage).toBe(
    "plaintext",
  );
  expect(resolveLexicalLanguage({ ...input, file: "main.bp" }).monacoLanguage).toBe("plaintext");
  expect(
    resolveLexicalLanguage({
      ...input,
      file: "main.a",
      catalog: {
        ...catalog,
        languages: [{ ...a, aliases: [] }, b],
      },
    }).displayName,
  ).toBe("toy-a");
});
```

- [ ] **Step 2: Run the failing tests**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/static-language-routing.test.ts`

Expected: FAIL because T0 returns plaintext for JSON and every plugin language.

- [ ] **Step 3: Implement the ordered resolver**

Keep T0's type declarations. Change its `LanguageBinding` import to the following value/type import and replace the stub with this complete implementation:

```ts
import { supportsFile, type LanguageBinding } from "../../shared/language-services.js";

export function resolveLexicalLanguage(input: ResolveLexicalLanguageInput): LexicalLanguageRoute {
  const { catalog, binding, activeOwners, coreExtensionRoutes } = input;
  const name = input.file.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  const extension = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  const plain = (): LexicalLanguageRoute => ({
    monacoLanguage: "plaintext",
    displayName: "Plain Text",
    kind: "plaintext",
    catalogRevision: catalog.revision,
  });
  if (Object.hasOwn(coreExtensionRoutes, extension)) {
    const id = coreExtensionRoutes[extension];
    if (id)
      return {
        monacoLanguage: id,
        displayName: id === "json" ? "JSON" : id,
        kind: "core",
        catalogRevision: catalog.revision,
      };
  }
  const applicable = binding && supportsFile(binding, input.file);
  const globalId = Object.hasOwn(catalog.extensionRoutes, extension)
    ? catalog.extensionRoutes[extension]
    : undefined;
  const language = catalog.languages.find(
    (candidate) =>
      candidate.extensions.includes(extension) &&
      (applicable
        ? candidate.id === binding.language &&
          candidate.pluginId === binding.pluginId &&
          candidate.sourceKey === binding.sourceKey
        : candidate.id === globalId) &&
      activeOwners.some(
        (owner) =>
          owner.languageId === candidate.id &&
          owner.pluginId === candidate.pluginId &&
          owner.sourceKey === candidate.sourceKey &&
          owner.generation === candidate.generation &&
          owner.extensions.includes(extension),
      ),
  );
  if (!language) return plain();
  return {
    monacoLanguage: language.id,
    displayName: language.aliases[0] ?? language.id,
    kind: "static",
    catalogRevision: catalog.revision,
    staticOwner: {
      pluginId: language.pluginId,
      sourceKey: language.sourceKey,
      generation: language.generation,
      languageId: language.id,
    },
  };
}
```

- [ ] **Step 4: Verify and format**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/static-language-routing.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --write apps/desktop/src/renderer/editor/static-language-routing.ts apps/desktop/src/renderer/editor/static-language-routing.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec eslint apps/desktop/src/renderer/editor/static-language-routing.ts apps/desktop/src/renderer/editor/static-language-routing.test.ts
```

Expected: PASS; no builtin-specific extension fallback and no dependency on a real catalog producer.

- [ ] **Step 5: Controller commit**

The controller runs this after reviewing the diff; the Codex worker does not commit:

```bash
git add apps/desktop/src/renderer/editor/static-language-routing.ts apps/desktop/src/renderer/editor/static-language-routing.test.ts
git commit -m "feat(desktop): resolve static lexical routes by active ownership"
```

#### 4.2 Validated, allowlisted Monarch and configuration adaptation

- [ ] **Step 1: Write the failing adapter tests**

Create `apps/desktop/src/renderer/editor/static-language-adapter.test.ts`. The mocked validator is a controlled port response, not a replacement implementation of T1's validator. The pinned Monarch compiler used below is the actual installed 0.57.0 compiler; full editor tokenization remains T8 acceptance.

```ts
import { readFileSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import type * as PluginProtocol from "@kobrixa/plugin-protocol";
import type { languages } from "monaco-editor";
import { validateStaticLanguageResources } from "@kobrixa/plugin-protocol";
import type { ValidatedStaticLanguage } from "../../shared/static-languages.js";
import { adaptStaticLanguage, StaticLanguageAdapterError } from "./static-language-adapter.js";

vi.mock("@kobrixa/plugin-protocol", async (original) => ({
  ...(await original<typeof PluginProtocol>()),
  validateStaticLanguageResources: vi.fn(),
}));
vi.mock("monaco-editor", () => ({
  languages: { IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 } },
}));
const validate = vi.mocked(validateStaticLanguageResources);
function fixture(name = "minimal"): ValidatedStaticLanguage {
  const root = new URL(
    `../../../../../packages/plugin-protocol/test-fixtures/static-languages/${name}/`,
    import.meta.url,
  );
  const tokenizer = readFileSync(new URL("tokenizer.json", root));
  const configuration = readFileSync(new URL("configuration.json", root));
  return {
    id: name === "basic-plus" ? "bp" : "toy",
    pluginId: "acme.toy",
    sourceKey: "development:toy",
    generation: 1,
    extensions: ["toy"],
    aliases: [],
    resourceDigest: "fixture",
    tokenizer: JSON.parse(tokenizer.toString()),
    configuration: JSON.parse(configuration.toString()),
    resourceBytes: { tokenizer: tokenizer.byteLength, configuration: configuration.byteLength },
    expandedRules: name === "basic-plus" ? 9 : 1,
  };
}
function accept(value: ValidatedStaticLanguage): void {
  validate.mockReturnValue({
    ok: true,
    tokenizer: value.tokenizer,
    configuration: value.configuration,
    resourceBytes: value.resourceBytes,
    expandedRules: value.expandedRules,
    rules: value.expandedRules,
    regexes: value.expandedRules,
  });
}
beforeEach(() => validate.mockReset());

it("checks original bytes and recomputed expansion counts before adapting", () => {
  const value = fixture();
  accept(value);
  const result = adaptStaticLanguage(value);
  expect(validate).toHaveBeenCalledWith({
    languageId: "toy",
    formatVersion: 1,
    limitsVersion: 1,
    tokenizer: value.tokenizer,
    configuration: value.configuration,
    resourceBytes: value.resourceBytes,
  });
  expect(result.configuration).toEqual({});
  expect(result.tokenizer).toMatchObject({ start: "root", defaultToken: "", tokenPostfix: ".toy" });
  expect(() => adaptStaticLanguage({ ...value, expandedRules: 2 })).toThrow(
    StaticLanguageAdapterError,
  );
  validate.mockReturnValue({
    ok: false,
    problems: [
      { message: "invalid resource", detail: { languageId: "toy", fieldPath: "states[0]" } },
    ],
  });
  expect(() => adaptStaticLanguage(value)).toThrow("invalid resource");
});

it("counts decoded code points and preserves literal macro characters", async () => {
  const value = fixture();
  value.aliases = ["😀".repeat(80)];
  const sources = ["@", "@@", "@name", String.raw`\@`, String.raw`\$`];
  value.tokenizer.states[0]!.rules = sources.map((pattern) => ({
    regex: { pattern, flags: "" },
    action: { token: "identifier" },
  }));
  value.expandedRules = sources.length;
  accept(value);
  const definition = adaptStaticLanguage(value);
  const compilerPath = "monaco-editor/editor/standalone/common/monarch/monarchCompile.js";
  const compiler = (await import(compilerPath)) as {
    compile(
      id: string,
      input: languages.IMonarchLanguage,
    ): {
      tokenizer: Record<string, { regex: RegExp }[]>;
    };
  };
  const compiled = compiler.compile("toy", definition.tokenizer);
  for (const [index, pattern] of sources.entries()) {
    const expected = new RegExp(`^(?:${pattern})`);
    for (const sample of ["@", "@@", "@name", "\\@", "$", "name"]) {
      expect(compiled.tokenizer.root![index]!.regex.exec(sample)?.[0]).toBe(
        expected.exec(sample)?.[0],
      );
    }
  }
  // T1 owns the AST/code-point check. Assert its rejection propagates unchanged.
  for (const pattern of [String.raw`\$S1`, "$s2"]) {
    const bad = fixture();
    bad.tokenizer.states[0]!.rules = [{ regex: { pattern, flags: "" }, action: { token: "x" } }];
    validate.mockReturnValue({
      ok: false,
      problems: [{ message: "state substitution forbidden", detail: { languageId: "toy" } }],
    });
    expect(() => adaptStaticLanguage(bad)).toThrow("state substitution forbidden");
  }
});

it("preserves Basic Plus rule order, flags, postfix, and namespaced list cases", async () => {
  const value = fixture("basic-plus");
  accept(value);
  const result = adaptStaticLanguage(value);
  expect(result.tokenizer.tokenPostfix).toBe(".basic-plus");
  expect(result.tokenizer.ignoreCase).toBe(true);
  expect(result.tokenizer.tokenizer.root).toHaveLength(9);
  const identifier = result.tokenizer.tokenizer.root![4] as languages.IExpandedMonarchLanguageRule;
  const action = identifier.action as languages.IExpandedMonarchLanguageAction;
  expect(Object.keys(action.cases!)).toEqual([
    "@list_types",
    "@list_booleans",
    "@list_word_operators",
    "@list_control",
    "@list_keywords",
    "@default",
  ]);
  expect(result.configuration).not.toHaveProperty("wordPattern");
  expect(result.configuration).not.toHaveProperty("onEnterRules");
  expect(result.configuration.indentationRules!.increaseIndentPattern.flags).toBe("i");
  const compilerPath = "monaco-editor/editor/standalone/common/monarch/monarchCompile.js";
  const compiler = (await import(compilerPath)) as {
    compile(
      id: string,
      input: languages.IMonarchLanguage,
    ): {
      tokenizer: Record<string, { regex: RegExp }[]>;
    };
  };
  const compiled = compiler.compile("bp", result.tokenizer);
  expect(compiled.tokenizer.root).toHaveLength(9);
  expect(compiled.tokenizer.root![2]!.regex.exec('"a""b"')?.[0]).toBe('"a""b"');
  expect(compiled.tokenizer.root![4]!.regex.exec("lcd.clear")?.[0]).toBe("lcd.clear");
});

it("copies only allowed configuration fields and maps all four indent actions", () => {
  const value = fixture();
  value.configuration = {
    comments: { lineComment: "//", blockComment: { open: "/*", close: "*/" } },
    brackets: [{ open: "(", close: ")" }],
    autoClosingPairs: [{ open: '"', close: '"', notIn: ["string", "comment"] }],
    surroundingPairs: [{ open: "[", close: "]" }],
    indentationRules: {
      increaseIndentPattern: { pattern: "^@", flags: "i" },
      decreaseIndentPattern: { pattern: "^", flags: "" },
      indentNextLinePattern: { pattern: "x", flags: "i" },
      unIndentedLinePattern: { pattern: "^$", flags: "" },
    },
    wordPattern: { pattern: "@name", flags: "" },
    onEnterRules: (["none", "indent", "indentOutdent", "outdent"] as const).map((indentAction) => ({
      beforeText: { pattern: "^", flags: "" },
      afterText: { pattern: "@", flags: "i" },
      previousLineText: { pattern: "x", flags: "" },
      action: { indentAction, appendText: "", removeText: 0 },
    })),
  };
  Object.assign(value.configuration, { folding: { offSide: true } });
  accept(value);
  const result = adaptStaticLanguage(value).configuration;
  expect(result.comments!.blockComment).toEqual(["/*", "*/"]);
  expect(result.brackets).toEqual([["(", ")"]]);
  expect(result.wordPattern!.source).toBe("@name");
  expect(result.indentationRules!.increaseIndentPattern.source).toBe("^@");
  expect(result.onEnterRules!.map((rule) => rule.action.indentAction)).toEqual([0, 1, 2, 3]);
  expect(result.onEnterRules![0]!.action).toEqual({
    indentAction: 0,
    appendText: "",
    removeText: 0,
  });
  expect(result).not.toHaveProperty("folding");
  expect(result.autoClosingPairs![0]!.notIn).not.toBe(
    value.configuration.autoClosingPairs![0]!.notIn,
  );
});

it("retains includes and explicit state transitions without expanding arrays", () => {
  const value = fixture();
  value.tokenizer.states = [
    {
      name: "other",
      rules: [{ regex: { pattern: "x", flags: "" }, action: { token: "x", next: "@root" } }],
    },
    { name: "root", rules: [{ include: "@other" }] },
  ];
  value.expandedRules = 2;
  accept(value);
  const result = adaptStaticLanguage(value).tokenizer;
  expect(result.start).toBe("root");
  expect(result.tokenizer.root).toEqual([{ include: "@other" }]);
  expect(Object.keys(result.tokenizer)).toEqual(["other", "root"]);
  expect(Object.hasOwn(result.tokenizer, "root")).toBe(true);
});
```

- [ ] **Step 2: Run the failing adapter tests**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/static-language-adapter.test.ts`

Expected: FAIL because T0 has no `StaticLanguageAdapterError` and `adaptStaticLanguage` throws its stub error.

- [ ] **Step 3: Replace the adapter file with the implementation**

```ts
import { languages } from "monaco-editor";
import {
  STATIC_LANGUAGE_FORMAT_VERSION,
  validateStaticLanguageResources,
  type Action,
  type Pair,
  type RegexData,
  type TokenAction,
} from "@kobrixa/plugin-protocol";
import type { ValidatedStaticLanguage } from "../../shared/static-languages.js";

export interface MonacoStaticLanguageDefinition {
  tokenizer: languages.IMonarchLanguage;
  configuration: languages.LanguageConfiguration;
}
export class StaticLanguageAdapterError extends Error {
  constructor(
    readonly reason: "validation" | "adapter",
    message: string,
  ) {
    super(message);
    this.name = "StaticLanguageAdapterError";
  }
}
const pair = (value: Pair): languages.CharacterPair => [value.open, value.close];
const regex = (value: RegexData): RegExp => new RegExp(value.pattern, value.flags);
function token(value: TokenAction): languages.IExpandedMonarchLanguageAction {
  const result: languages.IExpandedMonarchLanguageAction = { token: value.token };
  if (value.next !== undefined) result.next = value.next;
  if (value.bracket !== undefined) result.bracket = value.bracket;
  return result;
}
function action(value: Action): languages.IMonarchLanguageAction {
  if ("token" in value) return token(value);
  const cases: Record<string, languages.IMonarchLanguageAction> = {};
  for (const branch of value.cases) {
    const key =
      branch.when === "@default" || branch.when === "@eos"
        ? branch.when
        : `@list_${branch.when.slice(1)}`;
    cases[key] = token(branch.action);
  }
  return { cases };
}

export function adaptStaticLanguage(
  language: ValidatedStaticLanguage,
): MonacoStaticLanguageDefinition {
  const validated = validateStaticLanguageResources({
    languageId: language.id,
    formatVersion: STATIC_LANGUAGE_FORMAT_VERSION,
    limitsVersion: STATIC_LANGUAGE_FORMAT_VERSION,
    tokenizer: language.tokenizer,
    configuration: language.configuration,
    resourceBytes: language.resourceBytes,
  });
  if (!validated.ok)
    throw new StaticLanguageAdapterError(
      "validation",
      validated.problems.map((problem) => problem.message).join("; "),
    );
  if (
    validated.expandedRules !== language.expandedRules ||
    validated.resourceBytes.tokenizer !== language.resourceBytes.tokenizer ||
    validated.resourceBytes.configuration !== language.resourceBytes.configuration
  ) {
    throw new StaticLanguageAdapterError("validation", "Resource accounting mismatch");
  }
  try {
    const source = validated.tokenizer;
    const tokenizer: languages.IMonarchLanguage = {
      start: "root",
      ignoreCase: source.ignoreCase,
      defaultToken: source.defaultToken ?? "",
      tokenPostfix: source.tokenPostfix ?? `.${language.id}`,
      tokenizer: {},
    };
    for (const list of source.lists ?? []) tokenizer[`list_${list.name}`] = [...list.words];
    if (source.brackets)
      tokenizer.brackets = source.brackets.map((value) => ({
        open: value.open,
        close: value.close,
        token: value.token,
      }));
    for (const state of source.states) {
      tokenizer.tokenizer[state.name] = state.rules.map((rule) => {
        if ("include" in rule) return { include: rule.include };
        return {
          regex: new RegExp(rule.regex.pattern.replaceAll("@", "@@"), rule.regex.flags),
          action: action(rule.action),
        };
      });
    }
    const sourceConfig = validated.configuration;
    const configuration: languages.LanguageConfiguration = {};
    if (sourceConfig.comments) {
      configuration.comments = {};
      if (sourceConfig.comments.lineComment !== undefined)
        configuration.comments.lineComment = sourceConfig.comments.lineComment;
      if (sourceConfig.comments.blockComment)
        configuration.comments.blockComment = pair(sourceConfig.comments.blockComment);
    }
    if (sourceConfig.brackets) configuration.brackets = sourceConfig.brackets.map(pair);
    if (sourceConfig.autoClosingPairs)
      configuration.autoClosingPairs = sourceConfig.autoClosingPairs.map((value) => ({
        open: value.open,
        close: value.close,
        ...(value.notIn ? { notIn: [...value.notIn] } : {}),
      }));
    if (sourceConfig.surroundingPairs)
      configuration.surroundingPairs = sourceConfig.surroundingPairs.map((value) => ({
        open: value.open,
        close: value.close,
      }));
    if (sourceConfig.indentationRules) {
      const rules = sourceConfig.indentationRules;
      configuration.indentationRules = {
        increaseIndentPattern: regex(rules.increaseIndentPattern),
        decreaseIndentPattern: regex(rules.decreaseIndentPattern),
      };
      if (rules.indentNextLinePattern)
        configuration.indentationRules.indentNextLinePattern = regex(rules.indentNextLinePattern);
      if (rules.unIndentedLinePattern)
        configuration.indentationRules.unIndentedLinePattern = regex(rules.unIndentedLinePattern);
    }
    if (sourceConfig.wordPattern) configuration.wordPattern = regex(sourceConfig.wordPattern);
    const indentActions = {
      none: languages.IndentAction.None,
      indent: languages.IndentAction.Indent,
      indentOutdent: languages.IndentAction.IndentOutdent,
      outdent: languages.IndentAction.Outdent,
    } as const;
    if (sourceConfig.onEnterRules)
      configuration.onEnterRules = sourceConfig.onEnterRules.map((rule) => {
        const result: languages.OnEnterRule = {
          beforeText: regex(rule.beforeText),
          action: { indentAction: indentActions[rule.action.indentAction] },
        };
        if (rule.afterText) result.afterText = regex(rule.afterText);
        if (rule.previousLineText) result.previousLineText = regex(rule.previousLineText);
        if (rule.action.appendText !== undefined) result.action.appendText = rule.action.appendText;
        if (rule.action.removeText !== undefined) result.action.removeText = rule.action.removeText;
        return result;
      });
    return { tokenizer, configuration };
  } catch {
    throw new StaticLanguageAdapterError("adapter", "Could not construct Monaco language objects");
  }
}
```

`start: "root"` is host-generated: wire `start` remains forbidden. Preserve includes because T1 has already counted and bounded the entire expansion; the renderer verifies that count before allowing Monaco to expand it. Do not execute document regexes during resource validation. Configuration regexes retain literal `@` and their individual flags. The adapter constructs every object from allowed fields, including cases and prefixed list keys; it never spreads a resource object. Monaco 0.57.0 calls `.hasOwnProperty()` on tokenizer/case maps, so these two freshly constructed maps deliberately use ordinary objects. T1 rejects reserved/prototype names before insertion; all T4 route-map lookups use `Object.hasOwn`. Do not replace those Monaco-facing maps with null-prototype objects.

- [ ] **Step 4: Verify and format**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/static-language-adapter.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --write apps/desktop/src/renderer/editor/static-language-adapter.ts apps/desktop/src/renderer/editor/static-language-adapter.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec eslint apps/desktop/src/renderer/editor/static-language-adapter.ts apps/desktop/src/renderer/editor/static-language-adapter.test.ts
```

Expected: PASS, including literal-macro parity against the installed Monarch compiler with a mocked validation port. This does not certify the resource validator or actual editor tokenization.

- [ ] **Step 5: Controller commit**

```bash
git add apps/desktop/src/renderer/editor/static-language-adapter.ts apps/desktop/src/renderer/editor/static-language-adapter.test.ts
git commit -m "feat(desktop): adapt validated static resources to Monaco"
```

#### 4.3 Highest-revision store and defensive catalog envelope

- [ ] **Step 1: Write the failing store tests**

Create `apps/desktop/src/renderer/editor/static-language-store.test.ts`:

```ts
import { expect, it, vi } from "vitest";
import type { PluginEvent, PluginsView } from "../../shared/plugins.js";
import type {
  StaticLanguagesCatalog,
  ValidatedStaticLanguage,
} from "../../shared/static-languages.js";
import { createStaticLanguageStore } from "./static-language-store.js";
import { resolveLexicalLanguage } from "./static-language-routing.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const language: ValidatedStaticLanguage = {
  id: "toy",
  pluginId: "acme.toy",
  sourceKey: "development:toy",
  generation: 1,
  extensions: ["toy"],
  aliases: ["Toy"],
  resourceDigest: "one",
  tokenizer: { ignoreCase: false, states: [{ name: "root", rules: [] }] },
  configuration: {},
  resourceBytes: { tokenizer: 64, configuration: 3 },
  expandedRules: 0,
};
function catalog(revision: number, languages = [language]): StaticLanguagesCatalog {
  return {
    revision,
    formatVersion: 1,
    limitsVersion: 1,
    languages,
    extensionRoutes: languages.length ? { toy: "toy" } : {},
    conflicts: [],
  };
}
// Fixed outputs at the T2/T3 boundary; do not reimplement their admission/filter logic.
// T2's 129 valid candidates leave 128 DTOs and both conflict sources. T3's marker
// failure leaves only builtin DTOs and removes the cross-source conflict detail.
function authoritativeCatalog(
  kind: "budget-loser" | "marker-filtered",
  revision: number,
): StaticLanguagesCatalog {
  const languages = Array.from({ length: kind === "budget-loser" ? 128 : 2 }, (_, index) => ({
    ...language,
    id: `lang${index}`,
    pluginId: `test.i${String(index).padStart(3, "0")}`,
    sourceKey: `builtin:test.i${String(index).padStart(3, "0")}`,
    extensions: [index === 0 ? "shared" : `x${index}`],
  }));
  return {
    ...catalog(revision, languages),
    extensionRoutes: {
      ...Object.fromEntries(languages.slice(1).map((value) => [value.extensions[0]!, value.id])),
      shared: null,
    },
    conflicts:
      kind === "budget-loser"
        ? [
            {
              kind: "extension",
              key: "shared",
              sources: [
                { pluginId: "test.i000", sourceKey: "builtin:test.i000", languageId: "lang0" },
                { pluginId: "test.i128", sourceKey: "builtin:test.i128", languageId: "lang128" },
              ],
            },
          ]
        : [],
  };
}
function state(value: StaticLanguagesCatalog): PluginsView {
  return {
    revision: value.revision,
    diagnosticHelpRevision: 0,
    staticLanguagesRevision: value.revision,
    staticLanguageOwners: value.languages.map((item) => ({
      pluginId: item.pluginId,
      sourceKey: item.sourceKey,
      generation: item.generation,
      languageId: item.id,
      extensions: item.extensions,
    })),
    safeMode: false,
    developmentMode: true,
    plugins: [],
    developer: { enabled: true, commandLine: false, linkedCount: 0 },
    origins: {},
    python: { pendingReload: [] },
    inflight: [],
  };
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function setup() {
  const order: string[] = [];
  const events = new Set<(event: PluginEvent) => void>();
  const firstState = deferred<PluginsView>();
  const replies: ReturnType<typeof deferred<StaticLanguagesCatalog>>[] = [];
  const api = {
    onEvent(listener: (event: PluginEvent) => void) {
      order.push("subscribe");
      events.add(listener);
      return () => {
        events.delete(listener);
      };
    },
    state: vi.fn(() => {
      order.push("state");
      return firstState.promise;
    }),
    staticLanguages: vi.fn(() => {
      const reply = deferred<StaticLanguagesCatalog>();
      replies.push(reply);
      order.push("catalog");
      return reply.promise;
    }),
  };
  const store = createStaticLanguageStore(api);
  return {
    store,
    api,
    order,
    events,
    replies,
    firstState,
    emit(value: PluginsView) {
      for (const listener of events) listener({ type: "state", state: value });
    },
  };
}

it("subscribes before fetching and never accepts a catalog below the highest target", async () => {
  const h = setup();
  expect(h.order.slice(0, 2)).toEqual(["subscribe", "state"]);
  h.firstState.resolve(state(catalog(1)));
  await flush();
  h.emit(state(catalog(2, [])));
  expect(h.store.getSnapshot()).toMatchObject({ targetRevision: 2, owners: [] });
  h.replies[1]!.resolve(catalog(2, []));
  await h.store.ready();
  h.replies[0]!.resolve(catalog(1));
  await flush();
  expect(h.store.getSnapshot()).toMatchObject({
    phase: "ready",
    targetRevision: 2,
    catalog: { revision: 2, languages: [] },
  });
  h.store.dispose();
});

it("publishes revocation metadata synchronously even when the new fetch fails", async () => {
  const h = setup();
  h.firstState.resolve(state(catalog(1)));
  await flush();
  h.replies[0]!.resolve(catalog(1));
  await h.store.ready();
  const listener = vi.fn();
  const off = h.store.subscribe(listener);
  h.emit(state(catalog(2, [])));
  expect(h.store.getSnapshot().owners).toEqual([]);
  expect(listener).toHaveBeenCalledOnce();
  h.replies[1]!.reject(new Error("unavailable"));
  await flush();
  expect(h.store.getSnapshot()).toMatchObject({ phase: "failed", targetRevision: 2, owners: [] });
  off();
  h.store.dispose();
});

it("clears malformed owner metadata and recovers only with a consistent catalog", async () => {
  const h = setup();
  h.firstState.resolve(state(catalog(1)));
  await flush();
  h.replies[0]!.resolve(catalog(1));
  await h.store.ready();
  h.emit({ ...state(catalog(2)), staticLanguageOwners: null } as unknown as PluginsView);
  expect(h.store.getSnapshot()).toMatchObject({
    phase: "failed",
    targetRevision: 2,
    owners: [],
    catalog: { languages: [], extensionRoutes: {} },
  });
  h.replies[1]!.resolve(catalog(2));
  await flush();
  expect(h.store.getSnapshot().phase).toBe("ready");
  h.emit(state(catalog(3, [])));
  h.replies[2]!.resolve(catalog(3));
  await flush();
  expect(h.store.getSnapshot()).toMatchObject({
    phase: "failed",
    owners: [],
    catalog: { languages: [] },
  });
  h.store.dispose();
});

it("settles initial failure, supports manual refresh, and ignores disposed completions", async () => {
  const h = setup();
  h.firstState.reject(new Error("offline"));
  await h.store.ready();
  expect(h.store.getSnapshot().phase).toBe("failed");
  h.api.state.mockResolvedValue(state(catalog(4)));
  const refresh = h.store.refresh();
  await flush();
  h.replies[0]!.resolve(catalog(4));
  await refresh;
  expect(h.store.getSnapshot().phase).toBe("ready");
  h.emit(state(catalog(5, [])));
  const before = h.store.getSnapshot();
  h.store.dispose();
  h.store.dispose();
  h.replies[1]!.resolve(catalog(5, []));
  await flush();
  expect(h.store.getSnapshot()).toBe(before);
  expect(h.events.size).toBe(0);
});

it("passes numeric unsupported versions to the registrar but rejects invalid route identities", async () => {
  const h = setup();
  h.firstState.resolve(state(catalog(1)));
  await flush();
  h.replies[0]!.resolve({ ...catalog(1), formatVersion: 2 } as unknown as StaticLanguagesCatalog);
  await h.store.ready();
  expect(h.store.getSnapshot().catalog.formatVersion).toBe(2);
  h.emit(state(catalog(2)));
  h.replies[1]!.resolve({ ...catalog(2), extensionRoutes: { toy: "foreign" } });
  await flush();
  expect(h.store.getSnapshot()).toMatchObject({
    phase: "failed",
    owners: [],
    catalog: { languages: [] },
  });
  h.store.dispose();
});

it.each(["budget-loser", "marker-filtered"] as const)(
  "accepts the %s catalog without electing its sole delivered claimant",
  async (kind) => {
    const h = setup();
    const value = authoritativeCatalog(kind, 1);
    expect(value.languages).toHaveLength(kind === "budget-loser" ? 128 : 2);
    expect(value.languages.filter((item) => item.extensions.includes("shared"))).toHaveLength(1);
    expect(value.conflicts).toHaveLength(kind === "budget-loser" ? 1 : 0);
    h.firstState.resolve(state(value));
    await flush();
    h.replies[0]!.resolve(value);
    await h.store.ready();
    const snapshot = h.store.getSnapshot();
    expect(snapshot.phase).toBe("ready");
    expect(snapshot.catalog).toEqual(value);
    expect(snapshot.owners).toEqual(state(value).staticLanguageOwners);
    const route = (file: string) =>
      resolveLexicalLanguage({
        file,
        catalog: snapshot.catalog,
        activeOwners: snapshot.owners,
        coreExtensionRoutes: { json: "json" },
      });
    expect(route("main.shared").monacoLanguage).toBe("plaintext");
    expect(route("main.x1").monacoLanguage).toBe("lang1");
    expect(route("main.json").monacoLanguage).toBe("json");
    h.store.dispose();
  },
);

it("accepts a conservative null route even with no delivered claimant or conflict detail", async () => {
  const h = setup();
  const value = { ...catalog(1, []), extensionRoutes: { shared: null } };
  h.firstState.resolve(state(value));
  await flush();
  h.replies[0]!.resolve(value);
  await h.store.ready();
  expect(h.store.getSnapshot()).toMatchObject({ phase: "ready", catalog: value });
  h.store.dispose();
});

it.each(["missing-id", "wrong-extension", "multiple-claimants", "resource-budget"] as const)(
  "still rejects %s alongside an authoritative null route",
  async (kind) => {
    const h = setup();
    const value = catalog(1);
    value.extensionRoutes = { shared: null, toy: "toy" };
    if (kind === "missing-id") value.extensionRoutes.toy = "absent";
    if (kind === "wrong-extension") value.extensionRoutes = { shared: null, absent: "toy" };
    if (kind === "multiple-claimants")
      value.languages = [language, { ...language, id: "other", sourceKey: "development:other" }];
    if (kind === "resource-budget")
      value.languages = [
        {
          ...language,
          // Both files fit 512 KiB, but their sum exceeds the 768 KiB language budget.
          resourceBytes: { tokenizer: 524288, configuration: 524288 },
        },
      ];
    h.firstState.resolve(state(value));
    await flush();
    h.replies[0]!.resolve(value);
    await h.store.ready();
    expect(h.store.getSnapshot()).toMatchObject({
      phase: "failed",
      owners: [],
      catalog: { languages: [], extensionRoutes: {} },
    });
    h.store.dispose();
  },
);

it("measures non-BMP display aliases in code points at the envelope boundary", async () => {
  const h = setup();
  const valid = catalog(1, [{ ...language, aliases: ["😀".repeat(80)] }]);
  h.firstState.resolve(state(valid));
  await flush();
  h.replies[0]!.resolve(valid);
  await h.store.ready();
  expect(h.store.getSnapshot().catalog.languages[0]!.aliases[0]!.length).toBe(160);
  const invalid = catalog(2, [{ ...language, aliases: ["😀".repeat(81)] }]);
  h.emit(state(invalid));
  h.replies[1]!.resolve(invalid);
  await flush();
  expect(h.store.getSnapshot()).toMatchObject({
    phase: "failed",
    owners: [],
    catalog: { languages: [] },
  });
  h.store.dispose();
});

it("ignores an initial state reply that arrives after a newer event and catalog", async () => {
  const h = setup();
  h.emit(state(catalog(2, [])));
  h.replies[0]!.resolve(catalog(2, []));
  await h.store.ready();
  h.firstState.resolve(state(catalog(1)));
  await flush();
  h.replies[1]!.resolve(catalog(1));
  await flush();
  expect(h.store.getSnapshot()).toMatchObject({
    phase: "ready",
    targetRevision: 2,
    catalog: { revision: 2, languages: [] },
  });
  h.store.dispose();
});
```

- [ ] **Step 2: Run the failing store tests**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/static-language-store.test.ts`

Expected: FAIL because T0 neither subscribes nor fetches and always returns its failed empty snapshot. Against the pre-P3 recipe, the two producer-shaped catalogs and the zero-claimant null route incorrectly fail the whole catalog instead of becoming ready.

- [ ] **Step 3: Implement envelope checks and the monotonic store**

Retain T0's imports and `StaticLanguageStoreSnapshot`, `StaticLanguageStore`, and `StaticLanguageStoreApi` declarations. Add these imports and module-private helpers, then replace `createStaticLanguageStore` with the implementation below. These schemas validate only the catalog envelope; resource semantics remain exclusively in the shared validator invoked by the adapter.

```ts
import { z } from "zod";
import { STATIC_LANGUAGE_LIMITS_V1 } from "@kobrixa/plugin-protocol";
import type {
  StaticLanguageTokenizerV1,
  StaticLanguageConfigurationV1,
} from "@kobrixa/plugin-protocol";

const limits = STATIC_LANGUAGE_LIMITS_V1;
const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const idSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const extensionsSchema = z
  .array(z.string().regex(/^[a-z0-9]{1,16}$/))
  .min(1)
  .max(16)
  .refine((values) => new Set(values).size === values.length);
const identityShape = {
  pluginId: z.string().min(1),
  sourceKey: z.string().min(1),
  generation: revisionSchema,
};
const ownerSchema = z.object({
  ...identityShape,
  languageId: idSchema,
  extensions: extensionsSchema,
});
const ownersSchema = z
  .array(ownerSchema)
  .max(limits.languagesTotal)
  .refine((values) => new Set(values.map((value) => value.languageId)).size === values.length);
const metadataSchema = z.object({
  staticLanguagesRevision: revisionSchema,
  staticLanguageOwners: ownersSchema,
});
const languageSchema = z.object({
  ...identityShape,
  id: idSchema,
  extensions: extensionsSchema,
  aliases: z
    .array(z.string().regex(/^[^\p{Cc}\u2028\u2029]{1,80}$/u))
    .max(8)
    .refine((values) => new Set(values).size === values.length),
  resourceDigest: z.string().min(1),
  // Unknown resource contents are deliberately left for the pure shared validator.
  tokenizer: z.custom<StaticLanguageTokenizerV1>((value) => value !== undefined),
  configuration: z.custom<StaticLanguageConfigurationV1>((value) => value !== undefined),
  resourceBytes: z.object({
    tokenizer: z.number().int().nonnegative().max(limits.resourceFileBytes),
    configuration: z.number().int().nonnegative().max(limits.resourceFileBytes),
  }),
  expandedRules: z.number().int().nonnegative().max(limits.expandedRulesPerLanguage),
});
const catalogSchema = z.object({
  // Preserve unsupported numeric versions long enough to report each identifiable owner.
  formatVersion: revisionSchema,
  limitsVersion: revisionSchema,
  revision: revisionSchema,
  languages: z.array(languageSchema).max(limits.languagesTotal),
  extensionRoutes: z.record(z.string().regex(/^[a-z0-9]{1,16}$/), idSchema.nullable()),
  conflicts: z.array(
    z.object({
      kind: z.enum(["reserved-id", "reserved-extension", "frontend-owner", "id", "extension"]),
      key: z.string(),
      sources: z.array(
        z.object({ pluginId: z.string(), sourceKey: z.string(), languageId: idSchema }),
      ),
    }),
  ),
});
function emptyCatalog(revision: number): StaticLanguagesCatalog {
  return {
    formatVersion: 1,
    limitsVersion: 1,
    revision,
    languages: [],
    extensionRoutes: {},
    conflicts: [],
  };
}
function catalogOwners(catalog: StaticLanguagesCatalog): StaticLanguageOwner[] {
  return catalog.languages.map((value) => ({
    pluginId: value.pluginId,
    sourceKey: value.sourceKey,
    generation: value.generation,
    languageId: value.id,
    extensions: [...value.extensions],
  }));
}
function ownerSignature(owners: readonly StaticLanguageOwner[]): string {
  return JSON.stringify(
    owners
      .map((value) => [
        value.pluginId,
        value.sourceKey,
        value.generation,
        value.languageId,
        [...value.extensions].sort(),
      ])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
}
function parseCatalog(value: unknown): StaticLanguagesCatalog {
  const parsed = catalogSchema.parse(value);
  if (new Set(parsed.languages.map((language) => language.id)).size !== parsed.languages.length)
    throw new Error("Duplicate catalog language id");
  let bytes = 0;
  let expanded = 0;
  const pluginBytes = new Map<string, number>();
  for (const language of parsed.languages) {
    const size = language.resourceBytes.tokenizer + language.resourceBytes.configuration;
    bytes += size;
    expanded += language.expandedRules;
    const total = (pluginBytes.get(language.sourceKey) ?? 0) + size;
    pluginBytes.set(language.sourceKey, total);
    if (size > limits.resourceBytesPerLanguage || total > limits.resourceBytesPerPlugin)
      throw new Error("Catalog resource budget exceeded");
  }
  if (bytes > limits.resourceBytesTotal || expanded > limits.expandedRulesTotal)
    throw new Error("Catalog total budget exceeded");
  for (const [extension, id] of Object.entries(parsed.extensionRoutes)) {
    // Null is the host's authoritative ambiguity decision over all valid candidates.
    // Admission budgets or marker filtering can omit claimants and conflict details.
    if (id === null) continue;
    const candidates = parsed.languages.filter((language) =>
      language.extensions.includes(extension),
    );
    if (candidates.length !== 1 || candidates[0]!.id !== id)
      throw new Error("Invalid extension route identity");
  }
  // Numeric unsupported versions are quarantined by the registrar, never installed.
  return parsed as StaticLanguagesCatalog;
}

export function createStaticLanguageStore(api: StaticLanguageStoreApi): StaticLanguageStore {
  let snapshot: StaticLanguageStoreSnapshot = {
    phase: "loading",
    targetRevision: 0,
    owners: [],
    catalog: emptyCatalog(0),
  };
  let disposed = false;
  let request = 0;
  let haveMetadata = false;
  let settled = false;
  let settle!: () => void;
  const first = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const listeners = new Set<() => void>();
  const publish = (next: StaticLanguageStoreSnapshot) => {
    if (disposed) return;
    snapshot = next;
    for (const listener of listeners) listener();
    if (!settled && next.phase !== "loading") {
      settled = true;
      settle();
    }
  };
  const fail = (message: string, clear: boolean) => {
    if (clear) haveMetadata = false;
    publish({
      phase: "failed",
      targetRevision: snapshot.targetRevision,
      owners: clear ? [] : snapshot.owners,
      catalog: clear ? emptyCatalog(snapshot.targetRevision) : snapshot.catalog,
      error: message,
    });
  };
  const observe = (value: unknown): boolean => {
    if (disposed) return false;
    const revision = z.object({ staticLanguagesRevision: revisionSchema }).safeParse(value);
    if (revision.success && revision.data.staticLanguagesRevision < snapshot.targetRevision)
      return false;
    const parsed = metadataSchema.safeParse(value);
    if (!parsed.success) {
      if (revision.success)
        snapshot = { ...snapshot, targetRevision: revision.data.staticLanguagesRevision };
      fail("Invalid static language owner metadata", true);
      return true;
    }
    const next = parsed.data;
    if (next.staticLanguagesRevision === snapshot.targetRevision && haveMetadata) {
      if (ownerSignature(next.staticLanguageOwners) !== ownerSignature(snapshot.owners)) {
        fail("Owner metadata changed without a catalog revision", true);
        return true;
      }
      return false;
    }
    haveMetadata = true;
    publish({
      phase: "loading",
      targetRevision: next.staticLanguagesRevision,
      owners: next.staticLanguageOwners,
      catalog: snapshot.catalog,
    });
    return true;
  };
  const fetchCatalog = async (ticket: number): Promise<void> => {
    try {
      const raw = await api.staticLanguages();
      if (disposed) return;
      const revision = z.object({ revision: revisionSchema }).safeParse(raw);
      if (revision.success && revision.data.revision < snapshot.targetRevision) {
        if (ticket === request) fail("Catalog response is older than current ownership", false);
        return;
      }
      let catalog: StaticLanguagesCatalog;
      try {
        catalog = parseCatalog(raw);
      } catch {
        if (ticket === request) fail("Invalid static language catalog", true);
        return;
      }
      const owners = catalogOwners(catalog);
      if (
        catalog.revision === snapshot.targetRevision &&
        haveMetadata &&
        ownerSignature(owners) !== ownerSignature(snapshot.owners)
      ) {
        fail("Catalog and owner metadata disagree", true);
        return;
      }
      haveMetadata = true;
      publish({ phase: "ready", targetRevision: catalog.revision, owners, catalog });
    } catch {
      if (!disposed && ticket === request) fail("Could not load static languages", false);
    }
  };
  const refresh = async (): Promise<void> => {
    if (disposed) return;
    const ticket = ++request;
    try {
      observe(await api.state());
    } catch {
      if (!disposed && ticket === request) fail("Could not load plugin state", true);
      return;
    }
    if (!disposed) await fetchCatalog(ticket);
  };
  // Subscribe before state(), including the first request.
  const off = api.onEvent((event) => {
    if (!disposed && event.type === "state" && observe(event.state)) void fetchCatalog(++request);
  });
  void refresh();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ready: () => first,
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      request++;
      off();
      listeners.clear();
      settle();
    },
  };
}
```

`phase: "failed"` alone does not revive anything: owner revocations have already been published. A transport failure can retain an unaffected installed owner while T5's initial bootstrap still falls back if there has never been a ready catalog. Structural metadata/catalog failures clear all plugin routes immediately. Unsupported numeric format/limits versions reach the registrar only for failure reporting; they never reach adaptation. The store does not import runtime values, read plugin files, start processes, retry in a revision feedback loop, or impose its own regex timeout.

- [ ] **Step 4: Verify and format**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/static-language-store.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --write apps/desktop/src/renderer/editor/static-language-store.ts apps/desktop/src/renderer/editor/static-language-store.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec eslint apps/desktop/src/renderer/editor/static-language-store.ts apps/desktop/src/renderer/editor/static-language-store.test.ts
```

Expected: PASS against a mock preload API and T0's type/constant exports, including T2-shaped budget-loser and T3-shaped marker-filtered catalogs. Conservative null routes require neither delivered claimants nor conflict details; concrete route identity, owner consistency, and resource budgets remain enforced. These fixtures verify consumption, without claiming to execute T2 or T3 runtime behavior.

- [ ] **Step 5: Controller commit**

```bash
git add apps/desktop/src/renderer/editor/static-language-store.ts apps/desktop/src/renderer/editor/static-language-store.test.ts
git commit -m "feat(desktop): reconcile static catalogs by highest observed revision"
```

#### 4.4 Atomic installation, session shells, and every live model

- [ ] **Step 1: Write the failing lifecycle tests**

Create `apps/desktop/src/renderer/editor/static-language-registration.test.ts`. The minimal resource fixture and all mocks live inside this test's allowed path. The test harness exposes only the frozen Monaco/preload/store ports; it never imports a real plugin manager, controller, bootstrap, or Basic Plus companion.

```ts
import { readFileSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import type * as PluginProtocol from "@kobrixa/plugin-protocol";
import type { editor } from "monaco-editor";
import {
  validateStaticLanguageResources,
  type StaticLanguageTokenizerV1,
  type StaticLanguageConfigurationV1,
  type StaticLanguageValidationResult,
} from "@kobrixa/plugin-protocol";
import type { PluginEvent, PluginsView } from "../../shared/plugins.js";
import type { LanguageBinding } from "../../shared/language-services.js";
import type {
  StaticLanguageOwner,
  StaticLanguagesCatalog,
  ValidatedStaticLanguage,
  ReportLanguageRegistrationFailureInput,
} from "../../shared/static-languages.js";
import {
  createStaticLanguageStore,
  type StaticLanguageStore,
  type StaticLanguageStoreSnapshot,
} from "./static-language-store.js";
import {
  createStaticLanguageRegistrar,
  type MonacoStaticLanguageApi,
  type StaticModelContext,
} from "./static-language-registration.js";

vi.mock("@kobrixa/plugin-protocol", async (original) => ({
  ...(await original<typeof PluginProtocol>()),
  validateStaticLanguageResources: vi.fn(),
}));
vi.mock("monaco-editor", () => ({
  languages: { IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 } },
}));
const validate = vi.mocked(validateStaticLanguageResources);
beforeEach(() => {
  validate.mockReset();
  validate.mockImplementation((input): StaticLanguageValidationResult => ({
    ok: true,
    tokenizer: input.tokenizer as StaticLanguageTokenizerV1,
    configuration: input.configuration as StaticLanguageConfigurationV1,
    resourceBytes: input.resourceBytes,
    expandedRules: 1,
    rules: 1,
    regexes: 1,
  }));
});
function language(id = "toy", generation = 1, extensions = ["toy"]): ValidatedStaticLanguage {
  const root = new URL(
    "../../../../../packages/plugin-protocol/test-fixtures/static-languages/minimal/",
    import.meta.url,
  );
  const tokenizer = readFileSync(new URL("tokenizer.json", root));
  const configuration = readFileSync(new URL("configuration.json", root));
  return {
    id,
    generation,
    extensions,
    pluginId: `acme.${id}`,
    sourceKey: `development:${id}`,
    aliases: ["Toy 😀"],
    resourceDigest: `${id}:${generation}`,
    tokenizer: JSON.parse(tokenizer.toString()),
    configuration: JSON.parse(configuration.toString()),
    resourceBytes: { tokenizer: tokenizer.byteLength, configuration: configuration.byteLength },
    expandedRules: 1,
  };
}
const owner = (value: ValidatedStaticLanguage): StaticLanguageOwner => ({
  pluginId: value.pluginId,
  sourceKey: value.sourceKey,
  generation: value.generation,
  languageId: value.id,
  extensions: value.extensions,
});
function catalog(revision: number, languages: ValidatedStaticLanguage[]): StaticLanguagesCatalog {
  const routes: Record<string, string | null> = Object.create(null);
  for (const item of languages)
    for (const extension of item.extensions)
      routes[extension] = Object.hasOwn(routes, extension) ? null : item.id;
  return {
    formatVersion: 1,
    limitsVersion: 1,
    revision,
    languages,
    extensionRoutes: routes,
    conflicts: [],
  };
}
// The same producer-shaped DTOs as the store tests, using real minimal resources.
// Hidden candidates are not installed and are not required in owner metadata.
function authoritativeCatalog(
  kind: "budget-loser" | "marker-filtered",
  revision: number,
): StaticLanguagesCatalog {
  const languages = Array.from({ length: kind === "budget-loser" ? 128 : 2 }, (_, index) => ({
    ...language(`lang${index}`, 1, [index === 0 ? "shared" : `x${index}`]),
    pluginId: `test.i${String(index).padStart(3, "0")}`,
    sourceKey: `builtin:test.i${String(index).padStart(3, "0")}`,
  }));
  return {
    ...catalog(revision, languages),
    extensionRoutes: {
      ...Object.fromEntries(languages.slice(1).map((value) => [value.extensions[0]!, value.id])),
      shared: null,
    },
    conflicts:
      kind === "budget-loser"
        ? [
            {
              kind: "extension",
              key: "shared",
              sources: [
                { pluginId: "test.i000", sourceKey: "builtin:test.i000", languageId: "lang0" },
                { pluginId: "test.i128", sourceKey: "builtin:test.i128", languageId: "lang128" },
              ],
            },
          ]
        : [],
  };
}
const ready = (value: StaticLanguagesCatalog): StaticLanguageStoreSnapshot => ({
  phase: "ready",
  targetRevision: value.revision,
  owners: value.languages.map(owner),
  catalog: value,
});
const bindingFor = (value: ValidatedStaticLanguage): LanguageBinding => ({
  pluginId: value.pluginId,
  sourceKey: value.sourceKey,
  language: value.id,
  epoch: 11,
  extensions: value.extensions,
  capabilities: ["analysis", "semanticTokens"],
  frontend: {
    language: value.id,
    entryExtensions: [value.extensions[0]!],
    sourceExtensions: value.extensions,
    ir: { min: 1, max: 1 },
  },
});
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function state(value: StaticLanguagesCatalog): PluginsView {
  return {
    revision: value.revision,
    diagnosticHelpRevision: 0,
    staticLanguagesRevision: value.revision,
    staticLanguageOwners: value.languages.map(owner),
    safeMode: false,
    developmentMode: true,
    plugins: [],
    developer: { enabled: true, commandLine: false, linkedCount: 0 },
    origins: {},
    python: { pendingReload: [] },
    inflight: [],
  };
}
function harness(initial = ready(catalog(0, [])), externalStore?: StaticLanguageStore) {
  let snapshot = initial;
  const subscriptions = new Set<() => void>();
  const localStore: StaticLanguageStore = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      subscriptions.add(listener);
      return () => {
        subscriptions.delete(listener);
      };
    },
    ready: async () => {},
    refresh: async () => {},
    dispose() {},
  };
  const store = externalStore ?? localStore;
  const created = new Set<(model: editor.ITextModel) => void>();
  const removing = new Set<(model: editor.ITextModel) => void>();
  const models = new Set<editor.ITextModel>();
  const values = new Map<
    editor.ITextModel,
    { language: string; text: string; undo: string[]; disposed: boolean }
  >();
  const log: string[] = [];
  const tokenDisposals: ReturnType<typeof vi.fn>[] = [];
  const configurationDisposals: ReturnType<typeof vi.fn>[] = [];
  const register = vi.fn((_value: { id: string }): void => {});
  const tokens = vi.fn(() => {
    const dispose = vi.fn(() => {
      log.push("dispose:tokens");
    });
    tokenDisposals.push(dispose);
    return { dispose };
  });
  const configuration = vi.fn(() => {
    const dispose = vi.fn(() => {
      log.push("dispose:configuration");
    });
    configurationDisposals.push(dispose);
    return { dispose };
  });
  const setModelLanguage = vi.fn((model: editor.ITextModel, id: string) => {
    log.push(`language:${id}`);
    values.get(model)!.language = id;
  });
  const monaco: MonacoStaticLanguageApi = {
    languages: {
      register,
      setMonarchTokensProvider: tokens,
      setLanguageConfiguration: configuration,
    },
    editor: {
      getModels: () => [...models],
      setModelLanguage,
      onDidCreateModel(listener) {
        created.add(listener);
        return {
          dispose() {
            created.delete(listener);
          },
        };
      },
      onWillDisposeModel(listener) {
        removing.add(listener);
        return {
          dispose() {
            removing.delete(listener);
          },
        };
      },
    },
  };
  const report = vi.fn(async (_input: ReportLanguageRegistrationFailureInput) => ({
    accepted: true,
    revision: 99,
  }));
  const input = {
    monaco,
    store,
    api: { reportLanguageRegistrationFailure: report },
    coreExtensionRoutes: { json: "json" },
  };
  const registrar = createStaticLanguageRegistrar(input);
  return {
    registrar,
    input,
    register,
    tokens,
    configuration,
    report,
    log,
    tokenDisposals,
    configurationDisposals,
    values,
    setModelLanguage,
    created,
    removing,
    subscriptions,
    publish(next: StaticLanguageStoreSnapshot) {
      snapshot = next;
      for (const callback of subscriptions) callback();
    },
    model(file = "/hidden.toy") {
      const value = {
        language: "plaintext",
        text: "unsaved 😀",
        undo: ["first", "second"],
        disposed: false,
      };
      const model = {
        uri: { path: file, fsPath: file, toString: () => `file://${file}` },
        isDisposed: () => value.disposed,
        getLanguageId: () => value.language,
      } as unknown as editor.ITextModel;
      models.add(model);
      values.set(model, value);
      for (const callback of created) callback(model);
      return model;
    },
    remove(model: editor.ITextModel) {
      for (const callback of removing) callback(model);
      values.get(model)!.disposed = true;
      models.delete(model);
    },
  };
}

it("installs atomically, reuses a shell, and does not register aliases or extensions", () => {
  const value = language();
  const h = harness();
  const model = h.model();
  h.publish(ready(catalog(1, [value])));
  expect(h.register.mock.calls).toEqual([[{ id: "toy" }]]);
  expect(h.values.get(model)!.language).toBe("toy");
  h.publish(ready(catalog(1, [value])));
  expect(h.tokens).toHaveBeenCalledOnce();
  h.publish(ready(catalog(2, [])));
  expect(h.values.get(model)!.language).toBe("plaintext");
  expect(h.tokenDisposals[0]).toHaveBeenCalledOnce();
  expect(h.configurationDisposals[0]).toHaveBeenCalledOnce();
  h.publish(ready(catalog(3, [value])));
  expect(h.register).toHaveBeenCalledOnce();
  expect(h.tokens).toHaveBeenCalledTimes(2);
  expect(h.values.get(model)!.language).toBe("toy");
  h.registrar.dispose();
});

it("rolls back a partial install and quarantines the generation across revisions", async () => {
  const h = harness();
  const model = h.model();
  h.configuration.mockImplementationOnce(() => {
    throw new Error("Monaco failure");
  });
  h.report.mockRejectedValueOnce(new Error("report IPC unavailable"));
  h.publish(ready(catalog(1, [language()])));
  expect(h.tokenDisposals[0]).toHaveBeenCalledOnce();
  expect(h.registrar.getActiveOwners()).toEqual([]);
  expect(h.values.get(model)!.language).toBe("plaintext");
  expect(h.report).toHaveBeenCalledWith(
    expect.objectContaining({
      sourceKey: "development:toy",
      generation: 1,
      languageId: "toy",
      revision: 1,
      reason: "monaco",
    }),
  );
  h.publish(ready(catalog(2, [language()])));
  expect(h.tokens).toHaveBeenCalledOnce();
  expect(h.report).toHaveBeenCalledOnce();
  h.publish(ready(catalog(3, [language("toy", 2)])));
  expect(h.register).toHaveBeenCalledOnce();
  expect(h.values.get(model)!.language).toBe("toy");
  await flush();
  h.registrar.dispose();
});

it.each(["dto-version", "validation", "adapter"] as const)(
  "reports %s without exposing a route",
  (reason) => {
    const h = harness();
    const value = language();
    const dto = catalog(1, [value]);
    if (reason === "dto-version") Object.assign(dto, { limitsVersion: 2 });
    if (reason === "validation")
      validate.mockReturnValueOnce({
        ok: false,
        problems: [{ message: "😀".repeat(3000), detail: { languageId: "toy" } }],
      });
    if (reason === "adapter")
      value.tokenizer.states[0]!.rules = [
        { regex: { pattern: "[", flags: "" }, action: { token: "identifier" } },
      ];
    h.publish(ready(dto));
    expect(h.report.mock.calls[0]![0].reason).toBe(reason);
    expect(Array.from(h.report.mock.calls[0]![0].detail).length).toBeLessThanOrEqual(2048);
    expect(h.registrar.getActiveOwners()).toEqual([]);
    expect(h.register).not.toHaveBeenCalled();
    h.registrar.dispose();
  },
);

it("keeps provisional ambiguity from complete owner metadata, including uninstalled owners", () => {
  const a = language("toy-a", 1, ["toy", "a"]);
  const b = language("toy-b", 1, ["toy", "b"]);
  const old = catalog(1, [a]);
  const h = harness(ready(old));
  const global = h.model();
  const bound = h.model("/bound.toy");
  h.registrar.trackModel(bound, () => ({ file: "/bound.toy", binding: bindingFor(a) }));
  h.publish({ phase: "loading", targetRevision: 2, owners: [owner(a), owner(b)], catalog: old });
  expect(h.values.get(global)!.language).toBe("plaintext");
  expect(h.values.get(bound)!.language).toBe("toy-a");
  expect(h.registrar.resolve({ file: "main.a" }).monacoLanguage).toBe("toy-a");
  expect(h.registrar.resolve({ file: "main.b", binding: bindingFor(b) }).monacoLanguage).toBe(
    "plaintext",
  );
  expect(h.tokenDisposals[0]).not.toHaveBeenCalled();
  h.publish({
    phase: "failed",
    targetRevision: 2,
    owners: [owner(a), owner(b)],
    catalog: old,
    error: "offline",
  });
  expect(h.values.get(global)!.language).toBe("plaintext");
  // A later metadata-only update cannot undo ambiguity learned while a fetch was pending.
  h.publish({ phase: "loading", targetRevision: 3, owners: [owner(a)], catalog: old });
  expect(h.values.get(global)!.language).toBe("plaintext");
  expect(h.values.get(bound)!.language).toBe("toy-a");
  expect(h.registrar.resolve({ file: "main.a" }).monacoLanguage).toBe("toy-a");
  h.publish(ready(catalog(3, [a])));
  expect(h.values.get(global)!.language).toBe("toy-a");
  h.registrar.dispose();
});

it.each(["budget-loser", "marker-filtered"] as const)(
  "preserves %s ambiguity through pending, failed, and completed catalog fetches",
  async (kind) => {
    const first = authoritativeCatalog(kind, 1);
    let advertised = first;
    const replies = Array.from({ length: 4 }, () => deferred<StaticLanguagesCatalog>());
    let index = 0;
    let emit!: (event: PluginEvent) => void;
    const store = createStaticLanguageStore({
      state: async () => state(advertised),
      staticLanguages: () => replies[index++]!.promise,
      onEvent(listener) {
        emit = listener;
        return () => {};
      },
    });
    const h = harness(undefined, store);
    const global = h.model("/global.shared");
    const unrelated = h.model("/unrelated.x1");
    const bound = h.model("/bound.shared");
    const selected = first.languages[0]!;
    h.registrar.trackModel(bound, () => ({
      file: "/bound.shared",
      binding: bindingFor(selected),
    }));
    const expectRoutes = () => {
      expect(h.values.get(global)!.language).toBe("plaintext");
      expect(h.values.get(unrelated)!.language).toBe("lang1");
      expect(h.values.get(bound)!.language).toBe("lang0");
      expect(h.registrar.resolve({ file: "/core.json" }).monacoLanguage).toBe("json");
      expect(h.report).not.toHaveBeenCalled();
      for (const dispose of [...h.tokenDisposals, ...h.configurationDisposals])
        expect(dispose).not.toHaveBeenCalled();
    };
    await flush();
    replies[0]!.resolve(first);
    await store.ready();
    expect(store.getSnapshot().phase).toBe("ready");
    expect(h.registrar.getActiveOwners()).toHaveLength(first.languages.length);
    expectRoutes();

    // Only one admitted owner claims shared, but the host's null is still authoritative.
    advertised = authoritativeCatalog(kind, 2);
    emit({ type: "state", state: state(advertised) });
    expect(store.getSnapshot()).toMatchObject({
      phase: "loading",
      targetRevision: 2,
      catalog: { revision: 1 },
    });
    expectRoutes();
    replies[1]!.reject(new Error("latest catalog unavailable"));
    await flush();
    expect(store.getSnapshot().phase).toBe("failed");
    expectRoutes();
    const refresh = store.refresh();
    await flush();
    replies[2]!.resolve(advertised);
    await refresh;
    expect(store.getSnapshot()).toMatchObject({ phase: "ready", targetRevision: 2 });
    expectRoutes();
    expect(
      h.setModelLanguage.mock.calls.some(([model, id]) => model === global && id !== "plaintext"),
    ).toBe(false);

    // The host later resolves the conflict. Metadata alone cannot authorize a winner;
    // only the matching complete catalog may restore the global route.
    advertised = catalog(3, first.languages);
    emit({ type: "state", state: state(advertised) });
    const newlyCreated = h.model("/new.shared");
    expect(h.values.get(newlyCreated)!.language).toBe("plaintext");
    expectRoutes();
    replies[3]!.resolve(advertised);
    await flush();
    expect(store.getSnapshot()).toMatchObject({ phase: "ready", targetRevision: 3 });
    expect(h.values.get(global)!.language).toBe("lang0");
    expect(h.values.get(newlyCreated)!.language).toBe("lang0");
    expect(h.values.get(unrelated)!.language).toBe("lang1");
    expect(h.register).toHaveBeenCalledTimes(first.languages.length);
    expect(h.tokens).toHaveBeenCalledTimes(first.languages.length);
    expect(h.report).not.toHaveBeenCalled();
    h.registrar.dispose();
    store.dispose();
  },
);

it("does not promote the survivor when a conflicting owner disappears before the catalog", () => {
  const a = language("toy-a", 1, ["shared", "a"]);
  const b = language("toy-b", 1, ["shared", "b"]);
  const safe = language("unrelated", 1, ["safe"]);
  const first = catalog(1, [a, b, safe]);
  const h = harness(ready(first));
  const global = h.model("/global.shared");
  const unrelated = h.model("/unrelated.safe");
  h.publish({
    phase: "loading",
    targetRevision: 2,
    owners: [owner(a), owner(safe)],
    catalog: first,
  });
  expect(h.values.get(global)!.language).toBe("plaintext");
  expect(h.values.get(unrelated)!.language).toBe("unrelated");
  expect(h.registrar.resolve({ file: "/main.shared", binding: bindingFor(a) }).monacoLanguage).toBe(
    "toy-a",
  );
  expect(h.registrar.resolve({ file: "/main.shared", binding: bindingFor(b) }).monacoLanguage).toBe(
    "plaintext",
  );
  expect(h.tokenDisposals[1]).toHaveBeenCalledOnce();
  expect(h.tokenDisposals[0]).not.toHaveBeenCalled();
  h.publish(ready(catalog(2, [a, safe])));
  expect(h.values.get(global)!.language).toBe("toy-a");
  expect(h.values.get(unrelated)!.language).toBe("unrelated");
  h.registrar.dispose();
});

it("revokes hidden and newly created diff models before a stale catalog resolves", async () => {
  const first = catalog(1, [language()]);
  const replies = [
    deferred<StaticLanguagesCatalog>(),
    deferred<StaticLanguagesCatalog>(),
    deferred<StaticLanguagesCatalog>(),
  ];
  let emit!: (event: PluginEvent) => void;
  let index = 0;
  const store = createStaticLanguageStore({
    state: async () => state(first),
    staticLanguages: () => replies[index++]!.promise,
    onEvent(listener) {
      emit = listener;
      return () => {};
    },
  });
  const h = harness(undefined, store);
  const hidden = h.model("/hidden.toy");
  const original = h.model("/original.toy");
  const values = [hidden, original].map((model) => h.values.get(model)!);
  const undo = values.map((value) => value.undo);
  for (const model of [hidden, original])
    h.registrar.trackModel(model, () => ({ file: model.uri.path }), {
      beforeChange() {
        h.log.push("detach");
      },
      afterChange() {},
    });
  await flush();
  replies[0]!.resolve(first);
  await store.ready();
  const stale = store.refresh();
  await flush();
  h.log.length = 0;
  emit({ type: "state", state: state(catalog(2, [])) });
  const modified = h.model("/modified.toy");
  expect([hidden, original, modified].map((model) => h.values.get(model)!.language)).toEqual([
    "plaintext",
    "plaintext",
    "plaintext",
  ]);
  expect(h.log.indexOf("detach")).toBeLessThan(h.log.indexOf("dispose:tokens"));
  replies[1]!.resolve(first);
  await stale;
  replies[2]!.reject(new Error("latest fetch failed"));
  await flush();
  expect(h.registrar.getActiveOwners()).toEqual([]);
  expect(values.map((value) => value.text)).toEqual(["unsaved 😀", "unsaved 😀"]);
  values.forEach((value, i) => expect(value.undo).toBe(undo[i]));
  expect(h.register).toHaveBeenCalledOnce();
  h.registrar.dispose();
  store.dispose();
});

it("restores renamed drafts across failed generations without registering a shell twice", () => {
  const h = harness(ready(catalog(1, [language()])));
  const model = h.model();
  const value = h.values.get(model)!;
  const undo = value.undo;
  let context: StaticModelContext = { file: "/old.toy", workspaceId: "one" };
  const after = vi.fn();
  h.registrar.trackModel(model, () => context, { beforeChange() {}, afterChange: after });
  context = { file: "/renamed.json", workspaceId: "one" };
  h.registrar.refreshModels();
  expect(value.language).toBe("json");
  h.configuration.mockImplementationOnce(() => {
    throw new Error("bad reload");
  });
  h.publish(ready(catalog(2, [language("toy", 2)])));
  context = { file: "/renamed.toy", workspaceId: "two" };
  h.registrar.refreshModels();
  expect(value.language).toBe("plaintext");
  h.publish(ready(catalog(3, [language("toy", 2)])));
  expect(h.tokens).toHaveBeenCalledTimes(2);
  h.publish(ready(catalog(4, [language("toy", 3)])));
  expect(value.language).toBe("toy");
  expect(value.text).toBe("unsaved 😀");
  expect(value.undo).toBe(undo);
  expect(h.register).toHaveBeenCalledOnce();
  expect(after.mock.calls.at(-1)![0]).toMatchObject({
    catalogRevision: 4,
    staticOwner: { generation: 3 },
  });
  h.registrar.dispose();
});

it("allows id 256, refuses id 257, and retains the shell count after revocation", () => {
  const h = harness();
  for (let index = 1; index <= 257; index++)
    h.publish(ready(catalog(index, [language(`toy-${index}`)])));
  expect(h.register).toHaveBeenCalledTimes(256);
  expect(h.report.mock.calls.at(-1)![0]).toMatchObject({
    languageId: "toy-257",
    reason: "session-language-ids",
  });
  h.publish(ready(catalog(258, [language("toy-1", 2)])));
  expect(h.registrar.resolve({ file: "main.toy" }).monacoLanguage).toBe("toy-1");
  expect(h.register).toHaveBeenCalledTimes(256);
  h.registrar.dispose();
});

it("releases tracking leases safely and preserves shell history across manager recreation", () => {
  const h = harness(ready(catalog(1, [language()])));
  const model = h.model();
  const context = () => ({ file: "/main.toy" });
  const hooks = { beforeChange: vi.fn(), afterChange: vi.fn() };
  const first = h.registrar.trackModel(model, context, hooks);
  const second = h.registrar.trackModel(model, context, hooks);
  const attached = hooks.afterChange.mock.calls.length;
  first.dispose();
  expect(hooks.afterChange.mock.calls.length).toBe(attached);
  h.publish(ready(catalog(2, [])));
  expect(hooks.beforeChange).toHaveBeenCalled();
  second.dispose();
  second.dispose();
  h.remove(model);
  expect(h.registrar.getRoute(model)).toBeUndefined();
  h.registrar.dispose();
  h.registrar.dispose();
  expect(h.created.size).toBe(0);
  expect(h.removing.size).toBe(0);
  expect(h.subscriptions.size).toBe(0);
  h.publish(ready(catalog(3, [language()])));
  const existing = h.model("/already-live.toy");
  const replacement = createStaticLanguageRegistrar(h.input);
  expect(h.register).toHaveBeenCalledOnce();
  expect(h.values.get(existing)!.language).toBe("toy");
  replacement.dispose();
});

it("updates aliases and extension metadata without reinstalling unchanged resources", () => {
  const initial = language();
  const h = harness(ready(catalog(1, [initial])));
  const model = h.model();
  const binding = bindingFor(initial);
  const context = { file: "/main.toy", binding };
  h.registrar.trackModel(model, () => context);
  h.publish(ready(catalog(2, [{ ...initial, aliases: ["Renamed 😀"] }])));
  expect(h.registrar.getRoute(model)).toMatchObject({
    displayName: "Renamed 😀",
    catalogRevision: 2,
  });
  expect(binding.epoch).toBe(11);
  expect(h.tokens).toHaveBeenCalledOnce();
  h.publish({
    phase: "loading",
    targetRevision: 3,
    owners: [{ ...owner(initial), extensions: ["new"] }],
    catalog: catalog(2, [initial]),
  });
  expect(h.values.get(model)!.language).toBe("plaintext");
  expect(h.registrar.resolve({ file: "/main.new" }).monacoLanguage).toBe("plaintext");
  const changed = { ...initial, extensions: ["new"] };
  expect(
    h.registrar.resolve({ file: "/main.new", binding: bindingFor(changed) }).monacoLanguage,
  ).toBe("toy");
  expect(h.tokenDisposals[0]).not.toHaveBeenCalled();
  h.publish(ready(catalog(3, [changed])));
  expect(h.registrar.resolve({ file: "/main.new" }).monacoLanguage).toBe("toy");
  expect(h.tokens).toHaveBeenCalledOnce();
  h.registrar.dispose();
});
```

- [ ] **Step 2: Run the failing lifecycle tests**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/static-language-registration.test.ts`

Expected: FAIL because T0 installs nothing, tracks no models, and emits no registration failure reports. With the P3 store fix but the old registrar recipe, pending budget-loser/marker-filtered snapshots and removal of a conflicting owner wrongly promote the remaining claimant; the new extension also becomes global before catalog authorization. The real store and adapter from 4.2–4.3 are available in this same worktree; T1 validation remains mocked.

- [ ] **Step 3: Implement registration and tracking in the T0 module**

Keep every T0 public interface unchanged. Add the following imports (merge with existing imports to avoid duplicate declarations), module-private types/helpers, and replacement factory. The extra helper names are local implementation details, not cross-task APIs.

```ts
import {
  STATIC_LANGUAGE_FORMAT_VERSION,
  STATIC_LANGUAGE_LIMITS_V1,
} from "@kobrixa/plugin-protocol";
import type {
  ValidatedStaticLanguage,
  StaticLanguagesCatalog,
  ReportLanguageRegistrationFailureInput,
} from "../../shared/static-languages.js";
import { adaptStaticLanguage, StaticLanguageAdapterError } from "./static-language-adapter.js";
import { resolveLexicalLanguage } from "./static-language-routing.js";

interface InstalledLanguage {
  language: ValidatedStaticLanguage;
  tokens: IDisposable;
  configuration: IDisposable;
}
interface TrackingLease {
  context: () => StaticModelContext;
  hooks: StaticModelRouteHooks | undefined;
  references: number;
}
interface TrackedModel {
  model: editor.ITextModel;
  leases: TrackingLease[];
  route: LexicalLanguageRoute | undefined;
  hooks: StaticModelRouteHooks | undefined;
  contextKey: string;
}
interface SessionHistory {
  ids: Set<string>;
  quarantined: Set<string>;
}
// Monaco's language registry outlives a registrar instance, including effect replay.
const sessions = new WeakMap<MonacoStaticLanguageApi["languages"], SessionHistory>();
const identity = (value: {
  pluginId: string;
  sourceKey: string;
  generation: number;
  languageId: string;
}): string => JSON.stringify([value.pluginId, value.sourceKey, value.generation, value.languageId]);
const languageIdentity = (value: ValidatedStaticLanguage): string =>
  identity({
    pluginId: value.pluginId,
    sourceKey: value.sourceKey,
    generation: value.generation,
    languageId: value.id,
  });
function release(value: IDisposable | undefined): void {
  try {
    value?.dispose();
  } catch {
    /* Continue disposing the other half and all models. */
  }
}
function sameRoute(a: LexicalLanguageRoute | undefined, b: LexicalLanguageRoute): boolean {
  return (
    a?.monacoLanguage === b.monacoLanguage &&
    a.kind === b.kind &&
    a.displayName === b.displayName &&
    a.catalogRevision === b.catalogRevision &&
    (a.staticOwner ? identity(a.staticOwner) : "") ===
      (b.staticOwner ? identity(b.staticOwner) : "")
  );
}

export function createStaticLanguageRegistrar(
  input: CreateStaticLanguageRegistrarInput,
): StaticLanguageRegistrar {
  const { monaco, store, api, coreExtensionRoutes } = input;
  let session = sessions.get(monaco.languages);
  if (!session) {
    session = { ids: new Set(), quarantined: new Set() };
    sessions.set(monaco.languages, session);
  }
  const history = session;
  const active = new Map<string, InstalledLanguage>();
  const models = new Map<editor.ITextModel, TrackedModel>();
  const listeners = new Set<() => void>();
  const coreIds = new Set(["plaintext", "json", ...Object.values(coreExtensionRoutes)]);
  // Metadata-discovered conflicts cannot be cleared by another partial snapshot.
  // Only a complete catalog for the current target resets these provisional decisions.
  const pendingAmbiguities = new Set<string>();
  let current = store.getSnapshot();
  let highestRevision = -1;
  let disposed = false;
  const getActiveOwners = (): StaticLanguageOwner[] =>
    current.owners.filter((owner) => {
      const installed = active.get(owner.languageId);
      return installed !== undefined && languageIdentity(installed.language) === identity(owner);
    });
  const routingCatalog = (): StaticLanguagesCatalog => {
    // Owner metadata can revoke a route or reveal ambiguity, but cannot prove global
    // uniqueness: budget-losing/marker-filtered claimants may not be delivered.
    // Pending/failed fetches retain only previously authorized concrete routes to the
    // same sole announced owner. Known nulls and previously absent mappings stay plain.
    const routes: Record<string, string | null> = Object.create(null);
    for (const [extension, id] of Object.entries(current.catalog.extensionRoutes)) {
      if (id === null || pendingAmbiguities.has(extension)) {
        routes[extension] = null;
        continue;
      }
      // Count all announced owners here, including those not yet installed.
      const announced = current.owners.filter((owner) => owner.extensions.includes(extension));
      const previous = current.catalog.languages.find((language) => language.id === id);
      routes[extension] =
        announced.length === 1 &&
        previous !== undefined &&
        previous.extensions.includes(extension) &&
        languageIdentity(previous) === identity(announced[0]!)
          ? id
          : null;
    }
    const owners = getActiveOwners();
    const languages = owners.map((owner) => ({
      ...active.get(owner.languageId)!.language,
      extensions: [...owner.extensions],
    }));
    return {
      formatVersion: 1,
      limitsVersion: 1,
      revision: current.targetRevision,
      languages,
      extensionRoutes:
        current.phase === "ready" && current.catalog.revision === current.targetRevision
          ? current.catalog.extensionRoutes
          : routes,
      conflicts: current.catalog.conflicts,
    };
  };
  const resolve = (context: StaticModelContext): LexicalLanguageRoute =>
    resolveLexicalLanguage({
      file: context.file,
      ...(context.binding ? { binding: context.binding } : {}),
      catalog: routingCatalog(),
      activeOwners: getActiveOwners(),
      coreExtensionRoutes,
    });
  const apply = (tracked: TrackedModel): void => {
    if (tracked.model.isDisposed()) return;
    const lease = tracked.leases.at(-1);
    const context = lease?.context() ?? {
      file: tracked.model.uri.fsPath || tracked.model.uri.path,
    };
    const next = resolve(context);
    const key = JSON.stringify([
      context.file,
      context.workspaceId,
      context.binding?.pluginId,
      context.binding?.sourceKey,
      context.binding?.language,
      context.binding?.epoch,
    ]);
    const hooks = lease?.hooks;
    if (sameRoute(tracked.route, next) && tracked.contextKey === key && tracked.hooks === hooks)
      return;
    // The old hook owns its dynamic attachments, even when the new lease has none.
    tracked.hooks?.beforeChange(tracked.route, next);
    if (!tracked.hooks && hooks) hooks.beforeChange(tracked.route, next);
    if (tracked.model.getLanguageId() !== next.monacoLanguage)
      monaco.editor.setModelLanguage(tracked.model, next.monacoLanguage);
    tracked.route = next;
    tracked.contextKey = key;
    tracked.hooks = hooks;
    hooks?.afterChange(next);
  };
  const refreshModels = (): void => {
    for (const tracked of models.values()) apply(tracked);
  };
  const ensure = (model: editor.ITextModel): TrackedModel => {
    let tracked = models.get(model);
    if (!tracked) {
      tracked = { model, leases: [], route: undefined, hooks: undefined, contextKey: "" };
      models.set(model, tracked);
      apply(tracked);
    }
    return tracked;
  };
  const fail = (
    language: ValidatedStaticLanguage,
    reason: ReportLanguageRegistrationFailureInput["reason"],
    message: string,
  ): void => {
    const key = languageIdentity(language);
    if (history.quarantined.has(key)) return;
    history.quarantined.add(key);
    const detail = Array.from(`${language.pluginId} / ${language.id}: ${message}`)
      .slice(0, 2048)
      .join("");
    // Reporting failure never makes the local failed contribution eligible again.
    try {
      void api
        .reportLanguageRegistrationFailure({
          sourceKey: language.sourceKey,
          generation: language.generation,
          languageId: language.id,
          revision: current.catalog.revision,
          reason,
          detail,
        })
        .catch(() => {});
    } catch {
      /* A synchronous bridge failure is also locally quarantined. */
    }
  };
  const install = (language: ValidatedStaticLanguage): void => {
    if (history.quarantined.has(languageIdentity(language))) return;
    if (
      current.catalog.formatVersion !== STATIC_LANGUAGE_FORMAT_VERSION ||
      current.catalog.limitsVersion !== STATIC_LANGUAGE_FORMAT_VERSION
    ) {
      fail(language, "dto-version", "Unsupported static language format or limits version");
      return;
    }
    if (coreIds.has(language.id)) {
      fail(language, "validation", "Language id is reserved by the host");
      return;
    }
    let definition: ReturnType<typeof adaptStaticLanguage>;
    try {
      definition = adaptStaticLanguage(language);
    } catch (error) {
      fail(
        language,
        error instanceof StaticLanguageAdapterError ? error.reason : "validation",
        error instanceof StaticLanguageAdapterError ? error.message : "Resource validation failed",
      );
      return;
    }
    if (
      !history.ids.has(language.id) &&
      history.ids.size >= STATIC_LANGUAGE_LIMITS_V1.sessionLanguageIds
    ) {
      fail(
        language,
        "session-language-ids",
        "Renderer language id limit reached; restart the window to load more languages",
      );
      return;
    }
    let tokens: IDisposable | undefined;
    let configuration: IDisposable | undefined;
    try {
      if (!history.ids.has(language.id)) {
        // Count calls, including a register() that throws after creating its shell.
        history.ids.add(language.id);
        monaco.languages.register({ id: language.id });
      }
      tokens = monaco.languages.setMonarchTokensProvider(language.id, definition.tokenizer);
      configuration = monaco.languages.setLanguageConfiguration(
        language.id,
        definition.configuration,
      );
      active.set(language.id, { language, tokens, configuration });
    } catch {
      release(tokens);
      release(configuration);
      fail(language, "monaco", "Monaco could not install the tokenizer and configuration");
    }
  };
  const reconcile = (snapshot: StaticLanguageStoreSnapshot): void => {
    if (disposed || snapshot.targetRevision < highestRevision) return;
    highestRevision = snapshot.targetRevision;
    current = snapshot;
    const complete =
      snapshot.phase === "ready" && snapshot.catalog.revision === snapshot.targetRevision;
    if (complete) pendingAmbiguities.clear();
    else {
      const seen = new Set<string>();
      for (const owner of snapshot.owners)
        for (const extension of owner.extensions) {
          if (seen.has(extension)) pendingAmbiguities.add(extension);
          seen.add(extension);
        }
    }
    const versionsMatch =
      snapshot.catalog.formatVersion === STATIC_LANGUAGE_FORMAT_VERSION &&
      snapshot.catalog.limitsVersion === STATIC_LANGUAGE_FORMAT_VERSION;
    const removed: InstalledLanguage[] = [];
    for (const [id, installed] of active) {
      const key = languageIdentity(installed.language);
      const owner = snapshot.owners.find((candidate) => identity(candidate) === key);
      const candidate = snapshot.catalog.languages.find((value) => languageIdentity(value) === key);
      if (
        !owner ||
        (complete &&
          (!versionsMatch ||
            !candidate ||
            candidate.resourceDigest !== installed.language.resourceDigest))
      ) {
        active.delete(id);
        removed.push(installed);
      } else if (complete && candidate) installed.language = candidate;
    }
    // Withdraw eligibility, detach/clear and reroute ALL models, then dispose providers.
    refreshModels();
    for (const installed of removed) {
      release(installed.tokens);
      release(installed.configuration);
    }
    if (complete) {
      for (const language of snapshot.catalog.languages) {
        if (
          !active.has(language.id) &&
          snapshot.owners.some((owner) => identity(owner) === languageIdentity(language))
        )
          install(language);
      }
    }
    refreshModels();
    for (const listener of listeners) listener();
  };
  // Subscribe to model creation before enumerating, covering the creation/enumeration gap.
  const created = monaco.editor.onDidCreateModel((model) => {
    if (!disposed) ensure(model);
  });
  const removing = monaco.editor.onWillDisposeModel((model) => {
    const tracked = models.get(model);
    if (tracked) {
      tracked.hooks?.beforeChange(tracked.route, {
        monacoLanguage: "plaintext",
        displayName: "Plain Text",
        kind: "plaintext",
        catalogRevision: current.targetRevision,
      });
      models.delete(model);
    }
  });
  for (const model of monaco.editor.getModels()) if (!model.isDisposed()) ensure(model);
  const off = store.subscribe(() => reconcile(store.getSnapshot()));
  reconcile(store.getSnapshot());
  return {
    reconcile,
    trackModel(model, context, hooks) {
      if (disposed || model.isDisposed()) return { dispose() {} };
      const tracked = ensure(model);
      let lease = tracked.leases.find(
        (value) => value.context === context && value.hooks === hooks,
      );
      if (lease) lease.references++;
      else {
        lease = { context, hooks, references: 1 };
        tracked.leases.push(lease);
        apply(tracked);
      }
      const acquired = lease;
      let released = false;
      return {
        dispose() {
          if (released) return;
          released = true;
          if (--acquired.references > 0 || disposed || !models.has(model)) return;
          tracked.leases = tracked.leases.filter((value) => value !== acquired);
          apply(tracked);
        },
      };
    },
    refreshModels() {
      if (!disposed) refreshModels();
    },
    resolve,
    getRoute: (model) => models.get(model)?.route,
    getActiveOwners,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      off();
      release(created);
      release(removing);
      const installed = [...active.values()];
      active.clear();
      refreshModels();
      for (const value of installed) {
        release(value.tokens);
        release(value.configuration);
      }
      models.clear();
      listeners.clear();
      disposed = true;
    },
  };
}
```

Models are never destroyed, recreated, assigned text, or given new undo stacks. The fallback path uses `setModelLanguage`; model-owned editing/view state survives. T5's `beforeChange` performs the actual dynamic-provider detach and semantic-token clear before provider disposal. The mock tests establish ordering and model identity; actual Monaco undo/selection/view-state and semantic coloring are T8 checks.

While a catalog is pending or its fetch has failed, a null global route stays ambiguous even if only one delivered owner remains. Ambiguity learned from pending owner metadata also survives subsequent partial snapshots until a complete current catalog arrives. Previously absent mappings wait for that catalog; unchanged, previously authorized concrete routes can remain usable. Selected bindings still resolve only to their matching installed owner. A current complete catalog can replace null with a concrete route after the host resolves the conflict; no permanent ambiguity cache or new frozen interface is needed.

The session history is keyed by the stable `monaco.languages` object, not an editor or a registrar instance. A duplicate `trackModel` lease is reference-counted, and closing a visible editor leaves the underlying live model automatically tracked. An absent model context uses the model URI until T5 supplies the real file/workspace/binding; review models must acquire their context lease before presentation. Process running/PID status is deliberately absent from eligibility. Reload failure drops the old generation before attempting the new one.

- [ ] **Step 4: Run the lifecycle tests to PASS**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/static-language-registration.test.ts`

Expected: PASS for RF2/RF5, each of the five failure reasons, partial rollback, P3's budget-loser/marker-filtered/pending ambiguity cases, unaffected routes and selected bindings, host-authorized conflict recovery, shell limits, lease replay, and local quarantine even when reporting fails. This does not claim main-side stale/forged report rejection; T3/T8 own that boundary.

- [ ] **Step 5: Verify the entire T4 write set**

The controller must have built and provisioned T0's protocol/runtime dist outputs before handing over the T4 worktree, because desktop consumes them. The first two commands below belong to that controller preparation in the T0 checkout, outside T4's write phase; T4 changes neither package and must not generate artifacts in another owner's directory. Run the remaining commands from the T4 worktree root. Do not install dependencies or run a whole-repository formatter.

```bash
# Controller preparation in the T0 checkout, before T4 starts.
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime build
# T4 worktree verification; only the eight owned files are writable.
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/static-language-routing.test.ts src/renderer/editor/static-language-adapter.test.ts src/renderer/editor/static-language-store.test.ts src/renderer/editor/static-language-registration.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop check
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --write apps/desktop/src/renderer/editor/static-language-routing.ts apps/desktop/src/renderer/editor/static-language-routing.test.ts apps/desktop/src/renderer/editor/static-language-adapter.ts apps/desktop/src/renderer/editor/static-language-adapter.test.ts apps/desktop/src/renderer/editor/static-language-store.ts apps/desktop/src/renderer/editor/static-language-store.test.ts apps/desktop/src/renderer/editor/static-language-registration.ts apps/desktop/src/renderer/editor/static-language-registration.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --check apps/desktop/src/renderer/editor/static-language-routing.ts apps/desktop/src/renderer/editor/static-language-routing.test.ts apps/desktop/src/renderer/editor/static-language-adapter.ts apps/desktop/src/renderer/editor/static-language-adapter.test.ts apps/desktop/src/renderer/editor/static-language-store.ts apps/desktop/src/renderer/editor/static-language-store.test.ts apps/desktop/src/renderer/editor/static-language-registration.ts apps/desktop/src/renderer/editor/static-language-registration.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec eslint apps/desktop/src/renderer/editor/static-language-routing.ts apps/desktop/src/renderer/editor/static-language-routing.test.ts apps/desktop/src/renderer/editor/static-language-adapter.ts apps/desktop/src/renderer/editor/static-language-adapter.test.ts apps/desktop/src/renderer/editor/static-language-store.ts apps/desktop/src/renderer/editor/static-language-store.test.ts apps/desktop/src/renderer/editor/static-language-registration.ts apps/desktop/src/renderer/editor/static-language-registration.test.ts
git diff --check
git status --short
```

Expected: both package builds, all four test files, desktop typecheck, Prettier, ESLint, and whitespace checks pass from T0 plus T4 alone. `git status --short` must list only the eight owned paths. T0's unimplemented protocol validator remains mocked in adapter/registrar unit tests. No full desktop suite depending on another parallel task is a branch-local gate.

- [ ] **Step 6: Controller commit**

```bash
git add apps/desktop/src/renderer/editor/static-language-registration.ts apps/desktop/src/renderer/editor/static-language-registration.test.ts
git commit -m "feat(desktop): reconcile static registrations and live model routes"
```

**Deferred to T8**

- Replace the validation mock with T1's real schema/AST validator for resource conformance, transformed-pattern limits, includes, flags, non-BMP aliases, and escaped `$S1` rejection. The local tests already establish port inputs, rejection propagation, and real Monarch macro compilation; they do not prove T1 semantics.
- Connect T2 catalogs and T3 trusted IPC/report quarantine. Exercise source removal, enable/reload, process crash versus whole-plugin isolation, stale/duplicate/forged reports, and successful recovery after explicit enable.
- Integrate T5's single bootstrap barrier and singleton lifetime, real dynamic hooks, semantic-token clearing, all normal/hidden/diff/review model entry points, rename/workspace changes, and UI display names. Confirm route revision does not become binding epoch or restart analysis workers.
- Run real Monaco/Electron editing assertions for preserved text, undo, drafts, cursor, selection, view state, original/modified diff models, StrictMode replay, and the 9,999/10,000/10,001 UTF-16 limits that T5 applies. No regex stress test belongs on this unit-test thread.
- Integrate T6's Basic Plus resources/themes and migration parity, plus T7 packaged/no-source-tree and recovery acceptance. Keep the existing completion performance thresholds from part0.

**Contract gaps**

- T0 does not define a typed adapter failure discriminator. This task defines `StaticLanguageAdapterError` with `reason: "validation" | "adapter"` inside `static-language-adapter.ts`, consumed only by its sibling registrar; every T0 signature and the five IPC reasons remain unchanged.
- T0 has no renderer-visible explicit-enable attempt token. This task defines session quarantine locally by `(pluginId, sourceKey, generation, languageId)` and never clears it merely because a new revision or temporary catalog removal arrives. T2/T8 must ensure an explicit enable after failure publishes a fresh `generation` (as reload does), or freeze an additional retry signal before integration; otherwise an enable of the same generation is indistinguishable from the forbidden report/revision retry loop. Do not invent a new IPC field or modify T2/T3 files in this task.
### Task 5: Renderer 整合／UI

**Files:**

- Modify: `apps/desktop/src/renderer/app.tsx:548-620,689-710,1767-1818,3774-3887,4408-4494` — window bootstrap、project entry barrier、editor/review context、footer label。
- Create/Test: `apps/desktop/src/renderer/app.test.ts`。
- Modify: `apps/desktop/src/renderer/editor/static-language-bootstrap.ts` — T0 scaffold；不得另建 bootstrap 模組。
- Create/Test: `apps/desktop/src/renderer/editor/static-language-bootstrap.test.ts`。
- Modify: `apps/desktop/src/renderer/editor/model-language-route.ts` — T0 的兩個介面保持原名／形狀；增加本任務私有組合所需 helpers。
- Create/Test: `apps/desktop/src/renderer/editor/model-language-route.test.ts`。
- Modify: `apps/desktop/src/renderer/editor/language-routing.ts:1-58`。
- Test: `apps/desktop/src/renderer/editor/language-routing.test.ts`。
- Modify: `apps/desktop/src/renderer/editor/editor-models.ts:5-53`。
- Modify: `apps/desktop/src/renderer/editor/editor.tsx:1-50,89-98,141-143,188-335,456-470,492-720,792-856`。
- Test: `apps/desktop/src/renderer/editor/editor.test.ts`。
- Modify: `apps/desktop/src/renderer/editor/language-companion.ts:5-30`。
- Modify: `apps/desktop/src/renderer/editor/language-features.ts:29-52,85-100,137-149,233-238`。
- Test: `apps/desktop/src/renderer/editor/language-features.test.ts`。
- Modify: `apps/desktop/src/renderer/editor/semantic-tokens.ts:75-79,99-101,157-164`。
- Test: `apps/desktop/src/renderer/editor/semantic-tokens.test.ts`。
- Modify: `apps/desktop/src/renderer/workspace/file-review-dialog.tsx:73-192,195-235,292-340`。
- Test: `apps/desktop/src/renderer/workspace/file-review-dialog.test.ts`。
- Modify: `apps/desktop/src/renderer/settings/plugin-copy.ts:5-27,73-96,138-220`。
- Modify: `apps/desktop/src/renderer/settings/plugins-panel.tsx:144-171`。
- Test: `apps/desktop/src/renderer/settings/plugins-panel.test.ts`（保留 T0 新增的 snapshot／IPC mocks）。
- Modify: `apps/desktop/src/renderer/i18n/copy.ts:3-9,189-194`。

行號是 T0 前現況 anchors；T0 scaffold 檔依 export 名稱定位。**本 task 不寫** T4 的四個模組／測試、T6 companion implementation／theme、`split-editor.tsx`、`editor-options.ts`、`editor-format.ts`、`completion-session.test.ts`、main、shared 或 shared fixtures。`language-status.tsx`／`language-status.test.ts` 不改：首次 bootstrap 失敗採獨立 app banner，沒有碰 loader status row 的呈現區域，因此 N2 仍停放。

**Interfaces:**

- Consumes (T4): `createStaticLanguageStore(api: StaticLanguageStoreApi): StaticLanguageStore`；`getSnapshot(): StaticLanguageStoreSnapshot`、`subscribe(listener: () => void): () => void`、`ready(): Promise<void>`、`refresh(): Promise<void>`、`dispose(): void`。Snapshot 完整形狀為 `{ phase: "loading" | "ready" | "failed"; targetRevision: number; owners: readonly StaticLanguageOwner[]; catalog: StaticLanguagesCatalog; error?: string }`。
- Consumes (T4): `createStaticLanguageRegistrar(input: CreateStaticLanguageRegistrarInput): StaticLanguageRegistrar`；input 是 `{ monaco: MonacoStaticLanguageApi; store: StaticLanguageStore; api: Pick<PluginsApi, "reportLanguageRegistrationFailure">; coreExtensionRoutes: Readonly<Record<string, string>> }`。使用 `reconcile(snapshot)`、`trackModel(model, context, hooks?)`、`refreshModels()`、`resolve(context)`、`getRoute(model)`、`subscribe(listener)`、`dispose()`；context 是 `{ file: string; workspaceId?: string; binding?: LanguageBinding }`；hooks 是 `beforeChange(previous: LexicalLanguageRoute | undefined, next: LexicalLanguageRoute): void`／`afterChange(route: LexicalLanguageRoute): void`。
- Consumes (T4): `resolveLexicalLanguage(input: ResolveLexicalLanguageInput): LexicalLanguageRoute`；input 為 `{ file; binding?; catalog; activeOwners; coreExtensionRoutes }`。`LexicalLanguageRoute = { monacoLanguage: string; displayName: string; kind: "core" | "static" | "plaintext"; catalogRevision: number; staticOwner?: StaticRouteOwner }`；owner 帶 `pluginId/sourceKey/generation/languageId`。只呼叫 resolver，不重寫 ownership 演算法。
- Consumes (T3): `window.kobrixa.plugins` 的 T0 `PluginsApi`，包括 `state()`、`staticLanguages()`、`onEvent()`、`reportLanguageRegistrationFailure()`；使用 `../../shared/static-languages.js` 的 type-only exports，不從 runtime 匯入執行碼。
- Consumes (T6): `initializeEditorThemes(api: EditorThemeApi): void`，以 `monaco.editor` 呼叫；不等 grammar 成功才初始化。
- Consumes (T0 fixture, read-only): `packages/plugin-protocol/test-fixtures/static-languages/toy/kobrixa-plugin.json`。T5 的 mock route 以該 fixture 的 `acme.toy`／`toy` 為第三方例子，Basic Plus regression fixture 使用 `bp`；不替 shared fixtures 換名。Tokenizer/configuration conversion 屬 T4，本 task 不製造另一份 shared grammar fixture。
- Produces (T0 unchanged): `ModelLanguageRoute extends LexicalLanguageRoute { binding?: LanguageBinding; companion?: LanguageCompanion }`；`AttachedModelLanguageRoute<T> = { model: T; file: string; workspaceId: string | undefined; route: ModelLanguageRoute; dispose(): void }`。
- Produces (T0 unchanged): `bootstrapStaticLanguages(input: StaticLanguageBootstrapInput): Promise<StaticLanguageBootstrapResult>`；input 為 `{ store: StaticLanguageStore; registrar: StaticLanguageRegistrar; timeoutMs?: number }`；result 為 `{ kind: "ready"; revision: number } | { kind: "plaintext"; reason: "ipc" | "timeout"; message: string }`。
- Produces (local to T5, defined below): `windowStaticLanguages(): WindowStaticLanguages`、`useStaticLanguages(): { runtime: WindowStaticLanguages; snapshot: WindowStaticLanguageSnapshot }`、`sameBinding(a: LanguageBinding | undefined, b: LanguageBinding | undefined): boolean`、`sameModelLanguageRoute(a: ModelLanguageRoute, b: ModelLanguageRoute): boolean`、`modelLanguageSelector(model: editor.ITextModel, route: ModelLanguageRoute): { language: string; scheme: string; pattern: string }`、`routeLanguage(file: string, status: LanguageStatus | undefined, companions?: Readonly<Record<string, LanguageCompanion>>, lexical?: LexicalLanguageRoute): ModelLanguageRoute`、`replaceModelRoute<T>(previous: AttachedModelLanguageRoute<T> | undefined, model: T, file: string, workspaceId: string | undefined, route: ModelLanguageRoute, attach: (model: T, route: ModelLanguageRoute) => { dispose(): void }): AttachedModelLanguageRoute<T>`。這些是 T0 未列出的 T5 內部 helpers，檔案都在本 write set，列於 Contract gaps。

本 task 從 **T0 commit** 開獨立 worktree；所有 branch-local tests mock T4/T6。下列預期 FAIL/PASS 都是未來實作步驟，不是本文件撰寫時已跑過的結果。每小節完成後由 controller commit，Codex 不執行 git commit。

#### 5.1 Window bootstrap、IPC deadline 與 StrictMode lifetime

- [ ] **Step 1: 加上會失敗的 bootstrap 測試**

建立 `static-language-bootstrap.test.ts`。測試完整使用 T0 ports，不載 T4 adapter／validator。以下 helper 也供此檔後續 tests 使用：

```ts
import { afterEach, expect, it, vi } from "vitest";
import type { StaticLanguageStore, StaticLanguageStoreSnapshot } from "./static-language-store.js";
import type { StaticLanguageRegistrar } from "./static-language-registration.js";
import { bootstrapStaticLanguages } from "./static-language-bootstrap.js";

vi.mock("monaco-editor", () => ({ editor: {} }));
vi.mock("./editor-theme.js", () => ({ initializeEditorThemes: vi.fn() }));
vi.mock("./static-language-store.js", () => ({ createStaticLanguageStore: vi.fn() }));
vi.mock("./static-language-registration.js", () => ({ createStaticLanguageRegistrar: vi.fn() }));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function ports() {
  const pending = deferred();
  let snapshot: StaticLanguageStoreSnapshot = {
    phase: "loading",
    targetRevision: 7,
    owners: [],
    catalog: {
      formatVersion: 1,
      limitsVersion: 1,
      revision: 6,
      languages: [],
      extensionRoutes: {},
      conflicts: [],
    },
  };
  const store: StaticLanguageStore = {
    getSnapshot: () => snapshot,
    ready: () => pending.promise,
    subscribe: () => () => {},
    refresh: async () => {},
    dispose: vi.fn(),
  };
  const registrar: StaticLanguageRegistrar = {
    reconcile: vi.fn(),
    trackModel: () => ({ dispose() {} }),
    refreshModels: vi.fn(),
    resolve: () => ({
      kind: "plaintext",
      monacoLanguage: "plaintext",
      displayName: "Plain Text",
      catalogRevision: 7,
    }),
    getRoute: () => undefined,
    getActiveOwners: () => [],
    subscribe: () => () => {},
    dispose: vi.fn(),
  };
  return {
    store,
    registrar,
    pending,
    set: (next: StaticLanguageStoreSnapshot) => {
      snapshot = next;
    },
  };
}
afterEach(() => vi.useRealTimers());

it("does not release document restoration before a consistent catalog is installed", async () => {
  const p = ports();
  const restore = vi.fn();
  const result = bootstrapStaticLanguages(p).then((value) => {
    restore();
    return value;
  });
  await Promise.resolve();
  expect(restore).not.toHaveBeenCalled();
  const snapshot = {
    ...p.store.getSnapshot(),
    phase: "ready" as const,
    catalog: { ...p.store.getSnapshot().catalog, revision: 7 },
  };
  p.set(snapshot);
  p.pending.resolve();
  expect(await result).toEqual({ kind: "ready", revision: 7 });
  expect(p.registrar.reconcile).toHaveBeenCalledWith(snapshot);
  expect(restore).toHaveBeenCalledOnce();
});

it("releases empty plugin routes at 5000 ms without treating the timer as a regex interrupter", async () => {
  vi.useFakeTimers();
  const p = ports();
  const settled = vi.fn();
  const promise = bootstrapStaticLanguages({ ...p, timeoutMs: 60000 }).then(settled);
  await vi.advanceTimersByTimeAsync(4999);
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await promise;
  expect(settled).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "plaintext", reason: "timeout" }),
  );
  expect(p.registrar.reconcile).toHaveBeenCalledWith(
    expect.objectContaining({
      phase: "failed",
      targetRevision: 7,
      owners: [],
      catalog: expect.objectContaining({ revision: 7, languages: [], extensionRoutes: {} }),
    }),
  );
  expect(p.store.dispose).not.toHaveBeenCalled();
  expect(p.registrar.dispose).not.toHaveBeenCalled();
  p.pending.reject(new Error("late IPC failure"));
  await Promise.resolve();
});

it.each(["reject", "failed", "inconsistent"] as const)(
  "fails open for editing after %s IPC",
  async (mode) => {
    const p = ports();
    const result = bootstrapStaticLanguages(p);
    if (mode === "reject") p.pending.reject(new Error("IPC disconnected"));
    else {
      p.set({
        ...p.store.getSnapshot(),
        phase: mode === "failed" ? "failed" : "ready",
        error: "Catalog unavailable",
      });
      p.pending.resolve();
    }
    expect(await result).toMatchObject({ kind: "plaintext", reason: "ipc" });
    expect(p.registrar.reconcile).toHaveBeenLastCalledWith(expect.objectContaining({ owners: [] }));
  },
);
```

- [ ] **Step 2: 執行並確認 FAIL**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/static-language-bootstrap.test.ts`

Expected: FAIL；T0 stub 立即返回 `not implemented`，不等待、不 reconcile，也沒有 5 秒界線。

- [ ] **Step 3: 實作 bounded bootstrap 與唯一 window owner**

在 T0 `static-language-bootstrap.ts` 保留原三個 exported contract，替換 function body，加入以下 imports/helper。`setTimeout` 只包 IPC promise，沒有包住同步 regex 執行的安全宣稱。

```ts
import * as monaco from "monaco-editor";
import { useSyncExternalStore } from "react";
import { initializeEditorThemes } from "./editor-theme.js";
import {
  createStaticLanguageStore,
  type StaticLanguageStoreSnapshot,
} from "./static-language-store.js";
import { createStaticLanguageRegistrar } from "./static-language-registration.js";

function emptySnapshot(store: StaticLanguageStore, message: string): StaticLanguageStoreSnapshot {
  const revision = store.getSnapshot().targetRevision;
  return {
    phase: "failed",
    targetRevision: revision,
    owners: [],
    error: message,
    catalog: {
      formatVersion: 1,
      limitsVersion: 1,
      revision,
      languages: [],
      extensionRoutes: {},
      conflicts: [],
    },
  };
}

export async function bootstrapStaticLanguages({
  store,
  registrar,
  timeoutMs = 5000,
}: StaticLanguageBootstrapInput): Promise<StaticLanguageBootstrapResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = Math.min(5000, Math.max(0, Number.isFinite(timeoutMs) ? timeoutMs : 5000));
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), wait);
  });
  const ipc = Promise.resolve()
    .then(() => store.ready())
    .then(
      () => "ready" as const,
      () => "ipc" as const,
    );
  const outcome = await Promise.race([ipc, timeout]);
  clearTimeout(timer);
  const snapshot = store.getSnapshot();
  if (
    outcome === "ready" &&
    snapshot.phase === "ready" &&
    snapshot.catalog.revision >= snapshot.targetRevision
  ) {
    registrar.reconcile(snapshot);
    return { kind: "ready", revision: snapshot.catalog.revision };
  }
  const reason = outcome === "timeout" ? "timeout" : "ipc";
  const message =
    reason === "timeout"
      ? "Static language loading exceeded 5000 ms."
      : (snapshot.error ?? "Static language catalog is unavailable.");
  registrar.reconcile(emptySnapshot(store, message));
  return { kind: "plaintext", reason, message };
}

export interface WindowStaticLanguageSnapshot {
  settled: boolean;
  revision: number;
  result?: StaticLanguageBootstrapResult;
}
export interface WindowStaticLanguages {
  store: StaticLanguageStore;
  registrar: StaticLanguageRegistrar;
  ready: Promise<StaticLanguageBootstrapResult>;
  getSnapshot(): WindowStaticLanguageSnapshot;
  subscribe(listener: () => void): () => void;
}
let windowOwner: WindowStaticLanguages | undefined;

export function windowStaticLanguages(): WindowStaticLanguages {
  if (windowOwner) return windowOwner;
  initializeEditorThemes(monaco.editor);
  const store = createStaticLanguageStore(window.kobrixa.plugins);
  const registrar = createStaticLanguageRegistrar({
    monaco,
    store,
    api: window.kobrixa.plugins,
    coreExtensionRoutes: { json: "json" },
  });
  const listeners = new Set<() => void>();
  let snapshot: WindowStaticLanguageSnapshot = { settled: false, revision: 0 };
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const off = registrar.subscribe(() => {
    const state = store.getSnapshot();
    const recovered =
      snapshot.settled && state.phase === "ready" && state.catalog.revision >= state.targetRevision;
    snapshot = {
      ...snapshot,
      revision: snapshot.revision + 1,
      ...(recovered
        ? { result: { kind: "ready" as const, revision: state.catalog.revision } }
        : {}),
    };
    notify();
  });
  const ready = bootstrapStaticLanguages({ store, registrar }).then((result) => {
    snapshot = { settled: true, result, revision: snapshot.revision + 1 };
    notify();
    return result;
  });
  windowOwner = {
    store,
    registrar,
    ready,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  window.addEventListener(
    "pagehide",
    () => {
      off();
      registrar.dispose();
      store.dispose();
      listeners.clear();
      windowOwner = undefined;
    },
    { once: true },
  );
  return windowOwner;
}

export function useStaticLanguages() {
  const runtime = windowStaticLanguages();
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  return { runtime, snapshot };
}
```

T4 registrar 本身負責 store subscription／後續 reconcile；本 helper 不新增第二份 store，也不在 React effect cleanup dispose window owner。`pagehide` 才是本 Electron renderer 的終點；reload 重新計算 session ids。Theme 只初始化一次，即使 bootstrap 失敗仍可使用。

- [ ] **Step 4: 加 singleton／late recovery 的獨立 mock 測試，確認 PASS**

同一 test 檔加入以下 import 與測試；`vi.stubGlobal("window", ...)` 不需要 jsdom。此 test 的 registrar event 是 mock，不冒充 stale revision 的真實實作驗收。

```ts
import { createStaticLanguageStore } from "./static-language-store.js";
import { createStaticLanguageRegistrar } from "./static-language-registration.js";
import { initializeEditorThemes } from "./editor-theme.js";
import { windowStaticLanguages } from "./static-language-bootstrap.js";

it("reuses the window owner across effect replay and accepts later recovery", async () => {
  const p = ports();
  let unload!: () => void;
  let changed!: () => void;
  p.registrar.subscribe = (listener) => {
    changed = listener;
    return vi.fn();
  };
  vi.mocked(createStaticLanguageStore).mockReturnValue(p.store);
  vi.mocked(createStaticLanguageRegistrar).mockReturnValue(p.registrar);
  vi.stubGlobal("window", {
    kobrixa: { plugins: {} },
    addEventListener: (_event: string, listener: () => void) => {
      unload = listener;
    },
  });
  try {
    const first = windowStaticLanguages();
    const callback = vi.fn();
    first.subscribe(callback)(); // React cleanup only releases this listener.
    const second = windowStaticLanguages();
    const off = second.subscribe(callback);
    expect(second).toBe(first);
    expect(initializeEditorThemes).toHaveBeenCalledOnce();
    expect(createStaticLanguageRegistrar).toHaveBeenCalledOnce();
    p.pending.reject(new Error("disconnected"));
    expect(await second.ready).toMatchObject({ kind: "plaintext" });
    p.set({
      ...p.store.getSnapshot(),
      phase: "ready",
      targetRevision: 8,
      catalog: { ...p.store.getSnapshot().catalog, revision: 8 },
    });
    changed();
    expect(second.getSnapshot()).toMatchObject({
      settled: true,
      result: { kind: "ready", revision: 8 },
    });
    expect(p.registrar.dispose).not.toHaveBeenCalled();
    off();
  } finally {
    unload();
    vi.unstubAllGlobals();
  }
  expect(p.registrar.dispose).toHaveBeenCalledOnce();
  expect(p.store.dispose).toHaveBeenCalledOnce();
});
```

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/static-language-bootstrap.test.ts`

Expected: PASS；沒有未處理的 late rejection，也不把 timeout 後的 store dispose 掉。

- [ ] **Step 5: Commit（controller 執行）**

```bash
git add apps/desktop/src/renderer/editor/static-language-bootstrap.ts apps/desktop/src/renderer/editor/static-language-bootstrap.test.ts
git commit -m "feat(editor): gate document startup on one static language bootstrap"
```

#### 5.2 以 lexical route 組合動態 binding，保留 model identity

- [ ] **Step 1: 替換 routing 測試，增加同 epoch 的 lexical 更新測試**

`language-routing.test.ts` 保留現有 `status` fixture（`epoch: 1`、builtin `bp`）。刪除舊兩個 `it`，換成以下；在 imports 加 `ModelLanguageRoute`／`LexicalLanguageRoute`。測試把 T4 resolve 結果當輸入，沒有使用 T4 真實 stub 的解析行為。

```ts
import type { ModelLanguageRoute } from "./model-language-route.js";
import type { LexicalLanguageRoute } from "./static-language-routing.js";
const lexical: LexicalLanguageRoute = {
  kind: "static",
  monacoLanguage: "bp",
  displayName: "Basic Plus",
  catalogRevision: 1,
  staticOwner: {
    pluginId: "kobrixa.basic-plus",
    sourceKey: "builtin:kobrixa.basic-plus",
    generation: 1,
    languageId: "bp",
  },
};
const plain: LexicalLanguageRoute = {
  kind: "plaintext",
  monacoLanguage: "plaintext",
  displayName: "Plain Text",
  catalogRevision: 2,
};
it("uses the resolver id and retains valid services when only lexical registration fails", () => {
  expect(routeLanguage("中文.BP", status, {}, lexical)).toMatchObject({
    monacoLanguage: "bp",
    binding: { epoch: 1 },
  });
  expect(routeLanguage("main.bp", status, {}, plain)).toMatchObject({
    monacoLanguage: "plaintext",
    binding: { epoch: 1 },
  });
  expect(routeLanguage("readme.txt", status, {}, plain).binding).toBeUndefined();
  expect(
    routeLanguage(
      "kobrixa.json",
      status,
      {},
      { ...plain, kind: "core", monacoLanguage: "json", displayName: "JSON" },
    ).binding,
  ).toBeUndefined();
  expect(
    routeLanguage(
      "main.bp",
      {
        epoch: 2,
        conflicts: [],
        availability: {
          kind: "unavailable",
          reason: "missing",
          language: "bp",
        },
      },
      {},
      lexical,
    ),
  ).toEqual(lexical);
});
it("replaces catalog, owner, rename and workspace attachments without replacing the model", () => {
  const model = { text: "LCD.Clear()", undo: ["previous"] };
  const dispose = vi.fn();
  const attach = vi.fn(() => ({ dispose }));
  const first = routeLanguage("main.bp", status, {}, lexical);
  let attached = replaceModelRoute(undefined, model, "main.bp", "w1", first, attach);
  expect(replaceModelRoute(attached, model, "main.bp", "w1", { ...first }, attach)).toBe(attached);
  const changes: ModelLanguageRoute[] = [
    { ...first, catalogRevision: 2 },
    { ...first, catalogRevision: 3, staticOwner: { ...lexical.staticOwner!, generation: 2 } },
    { ...plain, binding: first.binding! },
  ];
  for (const route of changes)
    attached = replaceModelRoute(attached, model, "main.bp", "w1", route, attach);
  attached = replaceModelRoute(attached, model, "renamed.bp", "w1", first, attach);
  attached = replaceModelRoute(attached, model, "renamed.bp", "w2", first, attach);
  expect(attach).toHaveBeenCalledTimes(6);
  expect(dispose).toHaveBeenCalledTimes(5);
  expect(model).toEqual({ text: "LCD.Clear()", undo: ["previous"] });
  attached.dispose();
  attached.dispose();
  expect(dispose).toHaveBeenCalledTimes(6);
});
```

- [ ] **Step 2: 執行並確認 FAIL**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/language-routing.test.ts`

Expected: FAIL；目前 resolver 硬編碼 `basic-plus`，且 replacement 只比 epoch。

- [ ] **Step 3: 保留 T0 型別並實作完整 route comparison**

在 `model-language-route.ts` 的 T0 interfaces 後加以下 helpers。比較 primitive ownership，不用把 catalog revision 當 epoch，也不比較整個 companion JSON。

```ts
export function sameBinding(
  a: LanguageBinding | undefined,
  b: LanguageBinding | undefined,
): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.epoch === b.epoch &&
      a.pluginId === b.pluginId &&
      a.sourceKey === b.sourceKey &&
      a.language === b.language)
  );
}
export function sameModelLanguageRoute(a: ModelLanguageRoute, b: ModelLanguageRoute): boolean {
  return (
    a.monacoLanguage === b.monacoLanguage &&
    a.kind === b.kind &&
    a.displayName === b.displayName &&
    a.catalogRevision === b.catalogRevision &&
    a.staticOwner?.pluginId === b.staticOwner?.pluginId &&
    a.staticOwner?.sourceKey === b.staticOwner?.sourceKey &&
    a.staticOwner?.generation === b.staticOwner?.generation &&
    a.staticOwner?.languageId === b.staticOwner?.languageId &&
    sameBinding(a.binding, b.binding) &&
    a.companion === b.companion
  );
}
```

同檔加 `import type { editor } from "monaco-editor";` 和以下 selector helper。每個 model 的 URI 使用 host 發放的唯一數字 path prefix（5.4 實作），避免多份同語言 semantic／formatting providers 互相搶 model；不可只有 language/scheme 而依賴 callback 回傳空結果。

```ts
export function modelLanguageSelector(model: editor.ITextModel, route: ModelLanguageRoute) {
  const prefix = model.uri.path.split("/")[1];
  if (!prefix || !/^model-[0-9]+$/.test(prefix)) throw new Error("Expected a host-owned model URI");
  return { language: route.monacoLanguage, scheme: "kobrixa", pattern: `/${prefix}/**` };
}
```

完整替換 `language-routing.ts`。舊 `routeLanguage(file, status, companions?)` 的呼叫仍有效（`editor-format.ts` 使用這個入口，只取 binding／companion）；真正顯示／model consumers 必傳 T4 registrar 的 lexical route。無 catalog 的 fallback 也呼叫同一個 T4 resolver，禁止另一份副檔名規則。

```ts
import { bindingKey, supportsFile, type LanguageStatus } from "../../shared/language-services.js";
import type { LanguageCompanion } from "./language-companion.js";
import { BUILTIN_LANGUAGE_COMPANIONS } from "./builtin-language-companions.js";
import { resolveLexicalLanguage, type LexicalLanguageRoute } from "./static-language-routing.js";
import {
  sameModelLanguageRoute,
  type AttachedModelLanguageRoute,
  type ModelLanguageRoute,
} from "./model-language-route.js";
export type { ModelLanguageRoute } from "./model-language-route.js";

export function routeLanguage(
  file: string,
  status: LanguageStatus | undefined,
  companions: Readonly<Record<string, LanguageCompanion>> = BUILTIN_LANGUAGE_COMPANIONS,
  lexical?: LexicalLanguageRoute,
): ModelLanguageRoute {
  const binding =
    status?.availability.kind === "available" && supportsFile(status.availability.binding, file)
      ? status.availability.binding
      : undefined;
  const route =
    lexical ??
    resolveLexicalLanguage({
      file,
      ...(binding ? { binding } : {}),
      activeOwners: [],
      coreExtensionRoutes: { json: "json" },
      catalog: {
        formatVersion: 1,
        limitsVersion: 1,
        revision: 0,
        languages: [],
        extensionRoutes: {},
        conflicts: [],
      },
    });
  if (route.kind === "core" || !binding) return route;
  const key = bindingKey(binding);
  const companion = Object.hasOwn(companions, key) ? companions[key] : undefined;
  return { ...route, binding, ...(companion ? { companion } : {}) };
}

export function replaceModelRoute<T>(
  previous: AttachedModelLanguageRoute<T> | undefined,
  model: T,
  file: string,
  workspaceId: string | undefined,
  route: ModelLanguageRoute,
  attach: (model: T, route: ModelLanguageRoute) => { dispose(): void },
): AttachedModelLanguageRoute<T> {
  if (
    previous?.model === model &&
    previous.file === file &&
    previous.workspaceId === workspaceId &&
    sameModelLanguageRoute(previous.route, route)
  )
    return previous;
  previous?.dispose();
  const handle = route.binding ? attach(model, route) : undefined;
  let disposed = false;
  return {
    model,
    file,
    workspaceId,
    route,
    dispose() {
      if (disposed) return;
      disposed = true;
      handle?.dispose();
    },
  };
}
```

- [ ] **Step 4: 在 retained model owner 保存 context，而非在 editor unmount 丟掉它**

在 `editor-models.ts` 加以下 imports、fields 和 methods；既有 `capture`／`format`／locations 不變。`trackLanguage()` 的 handle 壽命和 model 一致；editor unmount 只移除 hooks。這讓 inactive project 的 model 仍保有選定 owner，而非突然改走 global extension route。

```ts
import type { LanguageStatus } from "../../shared/language-services.js";
import type { StaticLanguageRegistrar, StaticModelContext, StaticModelRouteHooks } from "./static-language-registration.js";

// Inside EditorModels:
private registrar: StaticLanguageRegistrar | undefined;
private workspaceId: string | undefined;
private status: LanguageStatus | undefined;
private readonly languageTracks = new Map<editor.ITextModel, { dispose(): void }>();
private readonly languageHooks = new Map<editor.ITextModel, StaticModelRouteHooks>();
configureLanguages(registrar: StaticLanguageRegistrar, workspaceId: string | undefined, status: LanguageStatus | undefined): void {
  this.registrar = registrar;
  this.workspaceId = workspaceId;
  this.status = status;
  registrar.refreshModels();
}
languageContext(model: editor.ITextModel): StaticModelContext {
  const file = [...this.models].find(([, value]) => value === model)?.[0] ?? model.uri.path;
  const binding = this.status?.availability.kind === "available" ? this.status.availability.binding : undefined;
  return { file, ...(this.workspaceId ? { workspaceId: this.workspaceId } : {}), ...(binding ? { binding } : {}) };
}
trackLanguage(model: editor.ITextModel, hooks: StaticModelRouteHooks): void {
  this.languageHooks.set(model, hooks);
  if (!this.languageTracks.has(model) && this.registrar) {
    this.languageTracks.set(model, this.registrar.trackModel(model, () => this.languageContext(model), {
      beforeChange: (previous, next) => this.languageHooks.get(model)?.beforeChange(previous, next),
      afterChange: (route) => this.languageHooks.get(model)?.afterChange(route),
    }));
  }
}
releaseLanguageHooks(): void { this.languageHooks.clear(); }
forgetLanguage(model: editor.ITextModel): void {
  this.languageHooks.delete(model);
  this.languageTracks.get(model)?.dispose();
  this.languageTracks.delete(model);
}
```

在既有 `dispose()` 的 `for` 改為以下（不改動 `remap()` 的 location 邏輯）：

```ts
for (const model of this.models.values()) {
  this.forgetLanguage(model);
  model.dispose();
}
```

建立 `model-language-route.test.ts`，測試 owned retention helper；沒有真的呼叫 T4 工廠：

```ts
import { expect, it, vi } from "vitest";
import type { editor } from "monaco-editor";
import { EditorModels } from "./editor-models.js";
import type {
  StaticLanguageRegistrar,
  StaticModelContext,
  StaticModelRouteHooks,
} from "./static-language-registration.js";

it("keeps a hidden model context through rename and releases it only when the model closes", () => {
  const model = { uri: { path: "/old.toy" }, dispose: vi.fn() } as unknown as editor.ITextModel;
  let context!: () => StaticModelContext;
  let hooks!: StaticModelRouteHooks;
  const release = vi.fn();
  const registrar = {
    refreshModels: vi.fn(),
    trackModel: vi.fn(
      (
        _m: editor.ITextModel,
        getter: () => StaticModelContext,
        suppliedHooks?: StaticModelRouteHooks,
      ) => {
        context = getter;
        hooks = suppliedHooks!;
        return { dispose: release };
      },
    ),
  } as unknown as StaticLanguageRegistrar;
  const models = new EditorModels();
  models.models.set("old.toy", model);
  models.configureLanguages(registrar, "workspace-a", undefined);
  const beforeChange = vi.fn();
  models.trackLanguage(model, { beforeChange, afterChange() {} });
  models.trackLanguage(model, { beforeChange, afterChange() {} });
  expect(registrar.trackModel).toHaveBeenCalledOnce();
  models.releaseLanguageHooks();
  models.models.delete("old.toy");
  models.models.set("new.txt", model);
  expect(context()).toEqual({ file: "new.txt", workspaceId: "workspace-a" });
  hooks.beforeChange(undefined, {
    kind: "plaintext",
    monacoLanguage: "plaintext",
    displayName: "Plain Text",
    catalogRevision: 2,
  });
  expect(beforeChange).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
  models.dispose();
  expect(release).toHaveBeenCalledOnce();
  expect(model.dispose).toHaveBeenCalledOnce();
});
```

這個 test 先加入、執行一次確認缺 `configureLanguages` 而 FAIL，再加入上述 EditorModels implementation。

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/language-routing.test.ts src/renderer/editor/model-language-route.test.ts`

Expected: PASS；模型／文字／undo 不重建，context getter 讀取 rename 後的檔名。

- [ ] **Step 5: Commit（controller 執行）**

```bash
git add apps/desktop/src/renderer/editor/model-language-route.ts apps/desktop/src/renderer/editor/model-language-route.test.ts apps/desktop/src/renderer/editor/language-routing.ts apps/desktop/src/renderer/editor/language-routing.test.ts apps/desktop/src/renderer/editor/editor-models.ts
git commit -m "refactor(editor): compose lexical routes with guarded service bindings"
```

#### 5.3 Dynamic selectors 從 model route 取得 id；plaintext 不洩漏服務

- [ ] **Step 1: 擴充既有 feature／semantic tests，先測 FAIL**

`language-features.test.ts` 的 `model()` fixture 新增 `getLanguageId: () => "bp"`。以下 type-only import 放在檔頭，`const route`／`const routes` 放在 `setup()` 的 `const features = new LanguageFeatures({` 前。將 `route: (model) => routes.get(model)` 加到 host，並在 `ensureModel` 建立新 model 後呼叫 `routes.set(models.get(file)!, route)`。在 setup return object 加 `routes, route`。這是測試的 route mock，不讀 T4 implementation：

```ts
import type { ModelLanguageRoute } from "./model-language-route.js";

const route = {
  monacoLanguage: "bp",
  kind: "static" as const,
  displayName: "Basic Plus",
  catalogRevision: 1,
  staticOwner: {
    pluginId: binding.pluginId,
    sourceKey: binding.sourceKey,
    generation: 1,
    languageId: "bp",
  },
  binding,
  companion: basicPlusCompanion,
};
const routes = new Map<editor.ITextModel, ModelLanguageRoute>(
  [...models.values()].map((model) => [model, route]),
);
```

加入完整 test（復用現有 `token`、`setup`、`model`）：

```ts
it("keeps services on the selected plaintext model and rejects an adjacent model or stale owner", async () => {
  const s = setup({ "main.bp": "value = 1" });
  vi.spyOn(s.main, "getLanguageId").mockReturnValue("plaintext");
  const fallback = {
    ...s.route,
    kind: "plaintext" as const,
    monacoLanguage: "plaintext",
    displayName: "Plain Text",
    catalogRevision: 2,
  };
  delete (fallback as { staticOwner?: unknown }).staticOwner;
  s.routes.set(s.main, fallback);
  const complete = vi.spyOn(basicPlusCompanion, "completions").mockReturnValue({ suggestions: [] });
  try {
    await s.features.completions(s.main, s.position(1, 2), token);
    expect(complete).toHaveBeenCalledOnce();
    complete.mockClear();
    const neighbor = model("main.bp", "value = 1");
    vi.spyOn(neighbor, "getLanguageId").mockReturnValue("plaintext");
    expect(await s.features.completions(neighbor, s.position(1, 2), token)).toEqual({
      suggestions: [],
    });
    s.routes.set(s.main, {
      ...fallback,
      binding: { ...s.snapshot.binding, sourceKey: "builtin:other" },
    });
    expect(await s.features.completions(s.main, s.position(1, 2), token)).toEqual({
      suggestions: [],
    });
    s.routes.set(s.main, { ...fallback, binding: { ...s.snapshot.binding, epoch: 99 } });
    expect(await s.features.signature(s.main, s.position(1, 2), token)).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
  } finally {
    complete.mockRestore();
    s.features.dispose();
  }
});
```

`semantic-tokens.test.ts` 加以下 test；fixture／既有 tests 中單純代表 Monaco id 的 `"basic-plus"` 改為 `"bp"`（不改 companion import paths／plugin id）。

```ts
it("drops painted and pending tokens immediately when its route is revoked", async () => {
  let current = true;
  const provider = new LanguageSemanticTokens(semanticLegend, "bp", 1, () => current);
  const source = model("name = 1");
  const changed = vi.fn();
  provider.onDidChange(changed);
  provider.bind(source.model, "main.bp");
  provider.update({ "main.bp": [token] }, undefined, undefined, 1);
  expect(await read(provider, source.model)).toHaveLength(5);
  source.edit();
  const pending = expect(read(provider, source.model)).rejects.toThrow("busy");
  current = false;
  provider.unbind(source.model);
  await pending;
  expect(await read(provider, source.model)).toHaveLength(0);
  expect(changed).toHaveBeenCalledTimes(2);
  provider.dispose();
});
```

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/language-features.test.ts src/renderer/editor/semantic-tokens.test.ts`

Expected: FAIL；目前 completion 只檢查 filename extension，sourceKey 不比對；semantic unbind 沒有發出清除通知。

- [ ] **Step 2: 實作 route guards，保留原 cancellation／snapshot 檢查**

刪除 `language-companion.ts` 的 `monacoLanguage: string;`，其他方法不改。T6 同時移除自己 companion object 的欄位；T5 不寫該檔。**注意**：T0 的舊 companion object 與 `completion-session.test.ts` 在全 desktop type check 會出現 excess-property error，處置見 Contract gaps；不能為了掩蓋錯誤加 index signature 或保留 deprecated lexical 欄位。

`language-features.ts` 加 imports 與 FeatureHost 成員：

```ts
import { sameBinding, modelLanguageSelector, type ModelLanguageRoute } from "./model-language-route.js";

// Inside FeatureHost:
route(model: monaco.editor.ITextModel): ModelLanguageRoute | undefined;
```

完整替換 `routed()`；`current()` 的第一個條件加入 `!this.routed(model)`，在 `snapshot.epoch !== binding.epoch` 之後加入 `!sameBinding(snapshot.binding, binding)`。既有 ready/query 的前後檢查與 document version／cancellation 邏輯全保留：

```ts
private routed(model: monaco.editor.ITextModel, capability?: LanguageCapability): boolean {
  const binding = this.host.binding();
  const file = this.host.fileFor(model);
  const route = this.host.route(model);
  return !this.disposed && !model.isDisposed() && !!binding && !!file && !!route &&
    route.kind !== "core" && route.monacoLanguage === model.getLanguageId() &&
    sameBinding(route.binding, binding) && supportsFile(binding, file) &&
    (!capability || binding.capabilities.includes(capability));
}
```

`register` 使用以下精確 patch；後面原有 10 個 capability registrations 保留。所有 callback 已經經過 `routed()` 或 `ready()`；Quick Fix 的 public `quickFixes()` 經 `current()` 同樣受控，document/range formatting 也保留原 `routed` 檢查。

```diff
-  register(): void {
+  register(route: ModelLanguageRoute, model: monaco.editor.ITextModel): void {
     const binding = this.host.binding(),
       companion = this.host.companion();
-    if (!binding || !companion) return;
-    const selector = { language: companion.monacoLanguage, scheme: "kobrixa" };
+    if (!binding || !companion || !sameBinding(route.binding, binding)) return;
+    const selector = modelLanguageSelector(model, route);
```

`semantic-tokens.ts` constructor 增加第四個參數，`provideDocumentSemanticTokens` 的 empty-result guard 加 `!this.isCurrentRoute(model)`；完整替換 unbind：

```ts
constructor(
  private readonly legend: SemanticLegend,
  private readonly languageId: string,
  private readonly epoch: number,
  private readonly isCurrentRoute: (model: editor.ITextModel) => boolean = () => true,
) {}

// In provideDocumentSemanticTokens, after the cancellation guard:
const state = this.models.get(model);
if (!state || !this.isCurrentRoute(model) || model.getLanguageId() !== this.languageId)
  return { data: new Uint32Array() };

unbind(model: editor.ITextModel): void {
  const state = this.models.get(model);
  if (!state) return;
  state.subscription.dispose();
  for (const request of state.requests) request.reject(busy());
  this.models.delete(model);
  this.fire();
}
```

第三個 `epoch` 仍是 service epoch。`isCurrentRoute` 是 supplementary callback；不要改 tokenize encoding／BOM／ordinary typing retain-tokens 行為。

- [ ] **Step 3: 執行並確認 PASS**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/language-features.test.ts src/renderer/editor/semantic-tokens.test.ts`

Expected: PASS；既有 hover/signature/definition/references/rename/Quick Fix/BOM regression 一起跑。這兩份 tests 沒有依賴 T4/T6 新實作。

- [ ] **Step 4: Commit（controller 執行）**

```bash
git add apps/desktop/src/renderer/editor/language-companion.ts apps/desktop/src/renderer/editor/language-features.ts apps/desktop/src/renderer/editor/language-features.test.ts apps/desktop/src/renderer/editor/semantic-tokens.ts apps/desktop/src/renderer/editor/semantic-tokens.test.ts
git commit -m "fix(editor): guard dynamic providers by the current model language route"
```

#### 5.4 主 editor 的 barrier、tracking、route attachments 與長行 options

- [ ] **Step 1: 在現有 editor harness 注入 T4 mock，先加入 failing tests**

`editor.test.ts` 的 hoisted `mocks.model` 補 `uri: { scheme: "kobrixa", path: "/model-1/main.bp", toString: () => "kobrixa:/model-1/main.bp" }`，預設 `getLanguageId` 改 `bp`。沿用現有 `available()`、`props`、`root`、`mocks`、`createRef`，`props` 加 `workspaceId: "workspace-a"`。新增以下 type-only imports、mock 和 controls；不呼叫 T4 真實 registrar。

```ts
import type { LexicalLanguageRoute } from "./static-language-routing.js";
import type {
  StaticLanguageRegistrar,
  StaticModelContext,
  StaticModelRouteHooks,
} from "./static-language-registration.js";
const lexicalMock = vi.hoisted(() => ({
  revision: 1,
  enabled: true,
  settled: true,
  listeners: new Set<() => void>(),
  tracks: new Map<object, { context: () => StaticModelContext; hooks?: StaticModelRouteHooks }>(),
}));
function mockedRoute(context: StaticModelContext): LexicalLanguageRoute {
  if (context.file.endsWith(".json"))
    return {
      kind: "core",
      monacoLanguage: "json",
      displayName: "JSON",
      catalogRevision: lexicalMock.revision,
    };
  if (lexicalMock.enabled && /\.(bp|bpi|bpm)$/i.test(context.file))
    return {
      kind: "static",
      monacoLanguage: "bp",
      displayName: "Basic Plus",
      catalogRevision: lexicalMock.revision,
      staticOwner: {
        pluginId: "kobrixa.basic-plus",
        sourceKey: "builtin:kobrixa.basic-plus",
        generation: lexicalMock.revision,
        languageId: "bp",
      },
    };
  return {
    kind: "plaintext",
    monacoLanguage: "plaintext",
    displayName: "Plain Text",
    catalogRevision: lexicalMock.revision,
  };
}
const testRegistrar = {
  resolve: mockedRoute,
  trackModel: (
    model: monaco.editor.ITextModel,
    context: () => StaticModelContext,
    hooks?: StaticModelRouteHooks,
  ) => {
    lexicalMock.tracks.set(model, { context, ...(hooks ? { hooks } : {}) });
    return {
      dispose: () => {
        lexicalMock.tracks.delete(model);
      },
    };
  },
  refreshModels: () => {
    for (const [object, { context, hooks }] of lexicalMock.tracks) {
      const model = object as monaco.editor.ITextModel;
      const next = mockedRoute(context());
      if (model.getLanguageId() === next.monacoLanguage) continue;
      hooks?.beforeChange(undefined, next);
      monaco.editor.setModelLanguage(model, next.monacoLanguage);
      hooks?.afterChange(next);
    }
  },
} as unknown as StaticLanguageRegistrar;
vi.mock("./static-language-bootstrap.js", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useStaticLanguages: () => {
      const settled = useSyncExternalStore(
        (listener) => {
          lexicalMock.listeners.add(listener);
          return () => {
            lexicalMock.listeners.delete(listener);
          };
        },
        () => lexicalMock.settled,
      );
      return { runtime: { registrar: testRegistrar }, snapshot: { settled } };
    },
  };
});
```

現有 `beforeEach` 加 `lexicalMock.tracks.clear(); lexicalMock.enabled = true; lexicalMock.revision = 1; lexicalMock.settled = true;`。此檔任何舊的 `monacoLanguage: "basic-plus"` expectation 改為 `bp`；不是 production filename inference。加入：

```ts
it("creates no model before bootstrap and clamps every standalone options write", async () => {
  lexicalMock.settled = false;
  await act(() => root.render(createElement(Editor, props)));
  expect(monaco.editor.createModel).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
  await act(() => {
    lexicalMock.settled = true;
    for (const listener of lexicalMock.listeners) listener();
  });
  expect(monaco.editor.createModel).toHaveBeenCalledOnce();
  expect(mocks.create).toHaveBeenCalledWith(
    expect.any(HTMLElement),
    expect.objectContaining({ maxTokenizationLineLength: 10000 }),
  );
  await act(() =>
    root.render(createElement(Editor, { ...props, fontSize: 20, ariaLabel: "Updated" })),
  );
  for (const [options] of mocks.instance.updateOptions.mock.calls)
    expect(options).toMatchObject({ maxTokenizationLineLength: 10000 });
});

it("revokes lexical coloring without resetting analysis or the document and recovers without typing", async () => {
  const configure = vi.spyOn(props.analysisSession, "configure");
  await act(() => root.render(createElement(Editor, props)));
  const old = [...mocks.registrations];
  const writes = mocks.model.setValue.mock.calls.length;
  await act(() => {
    lexicalMock.enabled = false;
    lexicalMock.revision++;
    testRegistrar.refreshModels();
  });
  expect(mocks.model.getLanguageId()).toBe("plaintext");
  for (const handle of old) expect(handle.dispose).toHaveBeenCalledOnce();
  expect(monaco.languages.registerDocumentSemanticTokensProvider).toHaveBeenCalledTimes(1);
  expect(monaco.languages.registerHoverProvider).toHaveBeenLastCalledWith(
    { language: "plaintext", scheme: "kobrixa", pattern: "/model-1/**" },
    expect.any(Object),
  );
  expect(mocks.model.setValue).toHaveBeenCalledTimes(writes);
  expect(mocks.model.dispose).not.toHaveBeenCalled();
  expect(configure).not.toHaveBeenCalled();
  await act(() => {
    lexicalMock.enabled = true;
    lexicalMock.revision++;
    testRegistrar.refreshModels();
  });
  expect(mocks.model.getLanguageId()).toBe("bp");
  expect(monaco.languages.registerDocumentSemanticTokensProvider).toHaveBeenCalledTimes(2);
  expect(mocks.model.setValue).toHaveBeenCalledTimes(writes);
  configure.mockRestore();
});
```

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/editor.test.ts`

Expected: FAIL；現有 editor 立即建模、不用 registrar、無長行 options。

- [ ] **Step 2: 接上 barrier，刪除舊 Basic Plus registration bridge**

`editor.tsx` 刪除 `registerBasicPlusLanguage` import、`let registered`／`registerLanguage` 整段、舊 `languageFor` 函式及 mount effect 的 `registerLanguage()` 呼叫。刪除 `BUILTIN_LANGUAGE_COMPANIONS`／`bindingKey` imports（動態組合改交 `routeLanguage`）。加入以下 imports：

```ts
import { useStaticLanguages } from "./static-language-bootstrap.js";
import {
  sameBinding,
  modelLanguageSelector,
  type ModelLanguageRoute,
} from "./model-language-route.js";
```

`EditorProps` 加 `workspaceId?: string`，舊 forwardRef export 改名 `const ReadyEditor = forwardRef<EditorHandle, EditorProps>(function ReadyEditor(`；destructure 及 `currentProps` 的初始／更新物件都加 `workspaceId`。在其 function body 最前加入 `const { runtime: staticLanguages } = useStaticLanguages();`。在檔尾新增唯一公開 wrapper：

```tsx
export const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(props, ref) {
  const { snapshot } = useStaticLanguages();
  return snapshot.settled ? (
    <ReadyEditor {...props} ref={ref} />
  ) : (
    <div className="editor" role="status">
      {props.locale === "zh-TW" ? "正在載入語言…" : "Loading languages…"}
    </div>
  );
});
```

把舊 `features`／`semanticTokens` refs 改為 model maps；`modelRoutes` ref 保持既有 `ReturnType<typeof replaceModelRoute<...>>` 寫法：

```ts
const semanticTokens = useRef(new Map<monaco.editor.ITextModel, LanguageSemanticTokens>());
const features = useRef(new Map<monaco.editor.ITextModel, LanguageFeatures>());
```

- [ ] **Step 3: 完整替換 bindModelRoute 並連接 per-model dynamic attachments**

在既有 `fileFor()` 後、`ensureModel()` 前放以下完整實作，取代舊 `bindModelRoute`。`ensureModel` 是後方既有 closure，可供 FeatureHost callbacks 在使用時呼叫：

```ts
const detachModelRoute = (model: monaco.editor.ITextModel) => {
  modelRoutes.current.get(model)?.dispose();
  modelRoutes.current.delete(model);
};
const bindModelRoute = (model: monaco.editor.ITextModel, file: string) => {
  const status = currentProps.current.status;
  const context = ownedModels.languageContext(model);
  const route = routeLanguage(file, status, undefined, staticLanguages.registrar.resolve(context));
  ownedModels.trackLanguage(model, {
    beforeChange: () => detachModelRoute(model),
    afterChange: () => {
      const currentFile = fileFor(model);
      if (currentFile) bindModelRoute(model, currentFile);
    },
  });
  const attached = replaceModelRoute(
    modelRoutes.current.get(model),
    model,
    file,
    currentProps.current.workspaceId,
    route,
    (_target, selected: ModelLanguageRoute) => {
      const { binding, companion } = selected;
      if (!binding || !companion) return { dispose() {} };
      const uri = model.uri.toString();
      const workspaceId = currentProps.current.workspaceId;
      const currentRoute = (candidate: monaco.editor.ITextModel) => {
        if (
          candidate !== model ||
          candidate.uri.toString() !== uri ||
          fileFor(candidate) !== file ||
          currentProps.current.workspaceId !== workspaceId
        )
          return undefined;
        return modelRoutes.current.get(candidate)?.route;
      };
      const currentBinding = () => {
        const availability = currentProps.current.status?.availability;
        return availability?.kind === "available" && sameBinding(availability.binding, binding)
          ? availability.binding
          : undefined;
      };
      const tokens =
        selected.kind !== "plaintext" && binding.capabilities.includes("semanticTokens")
          ? new LanguageSemanticTokens(
              companion.legend,
              selected.monacoLanguage,
              binding.epoch,
              (candidate) => currentRoute(candidate) === selected && !!currentBinding(),
            )
          : undefined;
      const semanticRegistration = tokens
        ? monaco.languages.registerDocumentSemanticTokensProvider(
            modelLanguageSelector(model, selected),
            tokens,
          )
        : undefined;
      if (tokens) {
        semanticTokens.current.set(model, tokens);
        tokens.bind(model, file);
      }
      const languageFeatures = new LanguageFeatures({
        binding: currentBinding,
        companion: () => companion,
        route: currentRoute,
        query: (snapshot, query, signal) => currentProps.current.query(snapshot, query, signal),
        locale: () => currentProps.current.locale,
        quickFixes: (snapshot, diagnostic, signal) =>
          currentProps.current.onQuickFixes?.(snapshot, diagnostic, signal) ??
          Promise.resolve({ kind: "stale", epoch: binding.epoch }),
        fileFor: (candidate) => (candidate === model ? fileFor(candidate) : undefined),
        ensureModel,
        completionSymbols: (candidate, position) => {
          const name = fileFor(candidate);
          const symbols = name && completionSession?.symbols(name, position);
          if (!symbols) completionSession?.request();
          return symbols || undefined;
        },
        isCurrent: (candidate, name, snapshot) =>
          analysisSession.getCurrent() === snapshot &&
          modelSnapshots.isCurrent(candidate, name, snapshot),
        refreshCompletions: (candidate, position) =>
          suggestions.current?.refresh(candidate, position),
        canEdit: () => !currentProps.current.readOnly && !editor.current?.getRawOptions().readOnly,
      });
      features.current.set(model, languageFeatures);
      languageFeatures.register(selected, model);
      completionSession?.bind(file, model);
      const snapshot = analysisSession.getCurrent();
      languageFeatures.update(snapshot);
      if (snapshot?.epoch === binding.epoch)
        tokens?.update(
          snapshot.analysis.tokensByFile,
          snapshot.analysis.index.sources,
          modelSnapshots.versions(snapshot),
          snapshot.epoch,
        );
      return {
        dispose() {
          tokens?.unbind(model); // Fire empty tokens before unregister/disposal.
          semanticRegistration?.dispose();
          tokens?.dispose();
          semanticTokens.current.delete(model);
          languageFeatures.unbind(model);
          languageFeatures.dispose();
          features.current.delete(model);
          completionSession?.unbind(file, model);
        },
      };
    },
  );
  modelRoutes.current.set(model, attached);
};
```

修正 5.2 `EditorModels.trackLanguage()` 中首次 tracking 的 reentrancy：T4 可在 `trackModel` 當下同步呼叫 `afterChange`，必須先放 sentinel 再呼叫 registrar。用以下內容替換該 `if` body：

```ts
this.languageTracks.set(model, { dispose() {} });
try {
  const handle = this.registrar.trackModel(model, () => this.languageContext(model), {
    beforeChange: (previous, next) => this.languageHooks.get(model)?.beforeChange(previous, next),
    afterChange: (route) => this.languageHooks.get(model)?.afterChange(route),
  });
  this.languageTracks.set(model, handle);
} catch (error) {
  this.languageTracks.delete(model);
  throw error;
}
```

為了避免同步 `afterChange` 在 outer `bindModelRoute` 尚未儲存 attached route 時又 attach 一次，把 `ownedModels.trackLanguage(...)` block **放在** `modelRoutes.current.set(model, attached);` **之後**；上方展示的 block 不保留原位置副本。它會讀到已存在的 attachment，`replaceModelRoute` 的相等判斷避免重複 provider。

將原 `modelUri()` 完整替換為以下。只有 in-memory URI 的 host prefix 改變，實體檔名仍由 `models` map／`fileFor` 提供；draft、view state、diagnostics 與 workspace API 不保存這個 URI。保留 filename suffix，Peek 仍能顯示檔名，rename 不重新建模：

```ts
function modelUri(file: string): monaco.Uri {
  return monaco.Uri.from({ scheme: "kobrixa", path: `/model-${++modelSequence}/${file}` });
}
```

`ensureModel` 的 createModel 語言 argument 換成以下，保留既有 buffer/modelSnapshots 綁定：

```ts
staticLanguages.registrar.resolve({
  file,
  ...(currentProps.current.workspaceId ? { workspaceId: currentProps.current.workspaceId } : {}),
  ...(currentProps.current.status?.availability.kind === "available"
    ? { binding: currentProps.current.status.availability.binding }
    : {}),
}).monacoLanguage;
```

`disposeModel()` 在 `model.dispose()` 前加 `ownedModels.forgetLanguage(model);`。mount effect 一開始先 `ownedModels.configureLanguages(staticLanguages.registrar, workspaceId, currentProps.current.status);`。cleanup 的 models loop 仍先 dispose/delete `modelRoutes`，其後加 `ownedModels.releaseLanguageHooks();`；retained models 不 dispose，T4 context tracking 繼續生效。

移除原本以 `companion.monacoLanguage` 建立單一 features/tokens 的 **整個 effect**（原 653–720），換成：

```ts
useEffect(() => {
  ownedModels.configureLanguages(staticLanguages.registrar, workspaceId, status);
  for (const [file, model] of models.current) bindModelRoute(model, file);
  const off = completionSession?.subscribe(() => {
    const snapshot = analysisSession.getCurrent();
    if (snapshot) completionSession.enrich(snapshot.analysis.index.symbols);
    for (const feature of features.current.values()) feature.refreshCompletion();
  });
  return () => {
    off?.();
  };
}, [status?.epoch, workspaceId, analysisSession, completionSession]);
```

既有 ref 呼叫逐一替換成以下完整 expressions，不改動其周圍 editing／collab 邏輯：

```ts
// Every old features.current?.update(undefined):
for (const feature of features.current.values()) feature.update(undefined);
// Existing EditorHandle.quickFixes return:
return features.current.get(model)?.quickFixes(model, diagnostic, undefined, signal) ?? [];
// Existing analysis callback, result branch:
for (const tokens of semanticTokens.current.values())
  tokens.update(
    snapshot.analysis.tokensByFile,
    snapshot.analysis.index.sources,
    modelSnapshots.versions(snapshot),
    snapshot.epoch,
  );
// Existing reset branch:
for (const tokens of semanticTokens.current.values())
  tokens.update(undefined, undefined, undefined, currentProps.current.status?.epoch ?? 0);
// Existing failure branch:
for (const tokens of semanticTokens.current.values()) tokens.fail();
// Existing analysis callback's final features update:
for (const feature of features.current.values()) feature.update(snapshot);
```

把 `else if (event === "reset")` 和 `else if (event === "failure")` 包成 braces，避免 for/else 歧義。`remapFiles` 迴圈在 maps／view states 更新後呼叫 `staticLanguages.registrar.refreshModels()`；再對每個 `[file, model]` 呼叫 `bindModelRoute(model, file)`，即使 Monaco id 未變也更新 attachment 的 file。不要把 route 寫入 persistent draft。

- [ ] **Step 4: 所有 owned standalone options writes 強制 10000，再跑 PASS**

`monaco.editor.create` options 的最後一個 property（在 options spread 和 `overviewRulerBorder` 之後）新增：

```ts
maxTokenizationLineLength: 10000,
```

替換兩個 standalone `updateOptions` 呼叫：

```ts
editor.current?.updateOptions({
  ...resolveEditorOptions(editorOptions, fontSize, wordWrap, reducedMotion),
  maxTokenizationLineLength: 10000,
});
editor.current?.updateOptions({ ariaLabel, readOnly, maxTokenizationLineLength: 10000 });
```

`model.updateOptions({ tabSize, indentSize, insertSpaces })` 是 `ITextModel` 的 indentation options，不接受 editor tokenization option；不要塞不存在的 property。長行門檻由擁有該 model 的 editor configuration 控制。

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/editor.test.ts src/renderer/editor/language-routing.test.ts src/renderer/editor/model-language-route.test.ts src/renderer/editor/language-features.test.ts src/renderer/editor/semantic-tokens.test.ts`

Expected: PASS。既有 11 個 capability registration 測試在單 model 下仍成立；grammar revoke 時只新增 10 個非 semantic providers，未知／JSON model 不 attach service；marker presentation 仍由原 diagnostics effect 維護。這只證明 options 傳遞，真實 9,999／10,000／10,001 邊界列至 T8。

- [ ] **Step 5: Commit（controller 執行）**

```bash
git add apps/desktop/src/renderer/editor/editor.tsx apps/desktop/src/renderer/editor/editor.test.ts apps/desktop/src/renderer/editor/editor-models.ts
git commit -m "feat(editor): reconcile retained models and guarded providers on lexical changes"
```

#### 5.5 Diff／review 共用 route、binding context 與 barrier

- [ ] **Step 1: 擴充 FileDiff mock 並加入 RF2 test**

`file-review-dialog.test.ts` 在原 imports 加 `FileDiff`、T0 `StaticModelContext`／`StaticLanguageRegistrar`／`LexicalLanguageRoute` type imports。把 hoisted `models` 的元素型別與 `createModel` 換成以下，保留既有 editor mocks：

```ts
const models: Array<{
  language: string; value: string;
  getLanguageId(): string; getValue(): string;
  setValue: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>;
}> = [];
// In the returned mocks object:
createModel: vi.fn((_value: string, language: string) => {
  const model = {
    language, value: "", getLanguageId() { return this.language; }, getValue() { return this.value; },
    setValue: vi.fn((value: string) => { model.value = value; }), dispose: vi.fn(),
  };
  models.push(model);
  return model;
}),
```

新增 registrar fixture（留在本 test 檔，其他 workers 不可匯入）：

```ts
const routing = vi.hoisted(() => ({
  settled: true,
  revision: 1,
  enabled: true,
  listeners: new Set<() => void>(),
  contexts: new Map<object, () => StaticModelContext>(),
}));
function resolveReview(context: StaticModelContext): LexicalLanguageRoute {
  if (/\.json$/i.test(context.file))
    return {
      kind: "core",
      monacoLanguage: "json",
      displayName: "JSON",
      catalogRevision: routing.revision,
    };
  if (routing.enabled && /\.toy$/i.test(context.file))
    return {
      kind: "static",
      monacoLanguage: "toy",
      displayName: "Toy",
      catalogRevision: routing.revision,
      staticOwner: { pluginId: "acme.toy", sourceKey: "dev:toy", generation: 1, languageId: "toy" },
    };
  return {
    kind: "plaintext",
    monacoLanguage: "plaintext",
    displayName: "Plain Text",
    catalogRevision: routing.revision,
  };
}
const reviewRegistrar = {
  resolve: vi.fn(resolveReview),
  trackModel: vi.fn((model: object, context: () => StaticModelContext) => {
    routing.contexts.set(model, context);
    return {
      dispose: () => {
        routing.contexts.delete(model);
      },
    };
  }),
  refreshModels: () => {
    for (const [model, context] of routing.contexts)
      (model as { language: string }).language = resolveReview(context()).monacoLanguage;
  },
} as unknown as StaticLanguageRegistrar;
function publishRoute(revision: number, enabled: boolean) {
  // T4's revision gate is a mocked contract here; its implementation is tested in T4/T8.
  if (revision < routing.revision) return;
  routing.revision = revision;
  routing.enabled = enabled;
  reviewRegistrar.refreshModels();
}
vi.mock("../editor/static-language-bootstrap.js", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useStaticLanguages: () => ({
      runtime: { registrar: reviewRegistrar },
      snapshot: {
        settled: useSyncExternalStore(
          (listener) => {
            routing.listeners.add(listener);
            return () => {
              routing.listeners.delete(listener);
            };
          },
          () => routing.settled,
        ),
      },
    }),
  };
});
```

`beforeEach` 新增 `routing.contexts.clear(); routing.revision = 1; routing.enabled = true; routing.settled = true;`。原兩個 child editor ariaLabel 精確 expectation 各加 `maxTokenizationLineLength: 10000`。既有 empty-history test 將 `expect(mocks.models[0]!.setValue).toHaveBeenCalledWith("");` 改為 `expect(mocks.models[0]!.getValue()).toBe("");`，避免要求為相同空字串建立多餘 edit。加入：

```ts
it("revokes hidden and newly created diff models before a stale catalog resolves", async () => {
  const props = {
    file: "main.toy",
    original: "old",
    modified: "draft",
    originalLabel: "Original",
    modifiedLabel: "Modified",
    resolvedTheme: "light" as const,
  };
  let finishOld!: () => void;
  const oldCatalog = new Promise<void>((resolve) => {
    finishOld = resolve;
  });
  const oldReply = oldCatalog.then(() => publishRoute(1, true));
  await act(() =>
    root.render(
      createElement(
        "div",
        null,
        createElement("div", { hidden: true, key: "old" }, createElement(FileDiff, props)),
      ),
    ),
  );
  const retained = [...mocks.models];
  const writes = retained.map((model) => model.setValue.mock.calls.length);
  await act(() => {
    publishRoute(2, false);
    root.render(
      createElement(
        "div",
        null,
        createElement("div", { hidden: true, key: "old" }, createElement(FileDiff, props)),
        createElement(FileDiff, { ...props, key: "new", file: "new.toy" }),
      ),
    );
  });
  expect(mocks.models.every((model) => model.language === "plaintext")).toBe(true);
  await act(async () => {
    finishOld();
    await oldReply;
  });
  expect(mocks.models.every((model) => model.language === "plaintext")).toBe(true);
  expect(retained.map((model) => model.setValue.mock.calls.length)).toEqual(writes);
  expect(retained.map((model) => model.getValue())).toEqual(["old", "draft"]);
  expect(retained.every((model) => model.dispose.mock.calls.length === 0)).toBe(true);
});

it("waits for bootstrap and sends both review models the current project binding", async () => {
  routing.settled = false;
  const binding = {
    epoch: 4,
    pluginId: "test.toy",
    sourceKey: "builtin:test.toy",
    language: "toy",
    extensions: ["toy"],
    capabilities: ["analysis" as const],
    frontend: {
      language: "toy",
      sourceExtensions: ["toy"],
      entryExtensions: ["toy"],
      ir: { min: 1, max: 1 },
    },
  };
  const props = {
    ...conflict(),
    file: "main.toy",
    workspaceId: "w",
    status: { epoch: 4, conflicts: [], availability: { kind: "available" as const, binding } },
  };
  await act(() => root.render(createElement(FileConflictDialog, props)));
  expect(mocks.models).toHaveLength(0);
  await act(() => {
    routing.settled = true;
    for (const listener of routing.listeners) listener();
  });
  expect(mocks.models).toHaveLength(2);
  for (const getContext of routing.contexts.values())
    expect(getContext()).toEqual({ file: "main.toy", workspaceId: "w", binding });
  expect(mocks.createDiffEditor).toHaveBeenCalledWith(
    expect.any(HTMLElement),
    expect.objectContaining({ maxTokenizationLineLength: 10000 }),
  );
  for (const target of [mocks.instance, mocks.originalEditor, mocks.modifiedEditor])
    for (const [options] of target.updateOptions.mock.calls)
      expect(options).toMatchObject({ maxTokenizationLineLength: 10000 });
  const before = [...mocks.models];
  await act(() =>
    root.render(createElement(FileConflictDialog, { ...props, file: "renamed.json" })),
  );
  expect(mocks.models).toEqual(before);
  expect(before.every((model) => model.language === "json")).toBe(true);
});
```

RF2 的 parent/key 保持一致，因此確認的是既存 hidden models，而不是 React 替換 subtree 後建立的新模型。

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/workspace/file-review-dialog.test.ts`

Expected: FAIL；原實作立即建立 basic-plus models，不傳 binding，也沒有 track／clamp。

- [ ] **Step 2: 完整替換 FileDiff，保留原兩個 Dialog 的動作與文案**

`file-review-dialog.tsx` 加以下 imports、CommonProps 兩個 optional 成員：

```ts
import type { LanguageStatus } from "../../shared/language-services.js";
import type { StaticModelContext } from "../editor/static-language-registration.js";
import { useStaticLanguages } from "../editor/static-language-bootstrap.js";

// Inside CommonProps:
workspaceId?: string;
status?: LanguageStatus;
```

完整替換原 `FileDiff` 到 `FileConflictDialog` 之前的區塊：

```tsx
interface FileDiffProps {
  file: string;
  original: string;
  modified: string;
  originalLabel: string;
  modifiedLabel: string;
  resolvedTheme: "dark" | "light";
  workspaceId?: string;
  status?: LanguageStatus;
}
export function FileDiff(props: FileDiffProps): React.JSX.Element {
  const { snapshot } = useStaticLanguages();
  return snapshot.settled ? (
    <ReadyFileDiff {...props} />
  ) : (
    <div className="file-review-diff" aria-busy="true" />
  );
}
function ReadyFileDiff({
  file,
  original,
  modified,
  originalLabel,
  modifiedLabel,
  resolvedTheme,
  workspaceId,
  status,
}: FileDiffProps): React.JSX.Element {
  const { runtime } = useStaticLanguages();
  const { values } = useSyncExternalStore(settingsStore.subscribe, settingsStore.getSnapshot);
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | undefined>(undefined);
  const models = useRef<monaco.editor.IDiffEditorModel | undefined>(undefined);
  const binding =
    status?.availability.kind === "available" ? status.availability.binding : undefined;
  const context = useRef<StaticModelContext>({ file });
  context.current = {
    file,
    ...(workspaceId ? { workspaceId } : {}),
    ...(binding ? { binding } : {}),
  };
  useEffect(() => {
    if (!container.current) return;
    const sequence = ++reviewSequence;
    const language = runtime.registrar.resolve(context.current).monacoLanguage;
    const makeModel = (side: string) =>
      monaco.editor.createModel(
        "",
        language,
        monaco.Uri.from({ scheme: "kobrixa-review", path: `/${sequence}/${side}/${file}` }),
      );
    const pair = { original: makeModel("original"), modified: makeModel("modified") };
    const tracks = [pair.original, pair.modified].map((model) =>
      runtime.registrar.trackModel(model, () => context.current),
    );
    const instance = monaco.editor.createDiffEditor(container.current, {
      automaticLayout: true,
      readOnly: true,
      domReadOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      renderSideBySideInlineBreakpoint: 520,
      useInlineViewWhenSpaceIsLimited: true,
      enableSplitViewResizing: true,
      renderOverviewRuler: false,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      lineNumbersMinChars: 3,
      wordWrap: "on",
      contextmenu: false,
      renderIndicators: true,
      diffAlgorithm: "advanced",
      maxComputationTime: 2000,
      maxTokenizationLineLength: 10000,
    });
    restoreEditorHoverDelegate();
    models.current = pair;
    editor.current = instance;
    instance.setModel(pair);
    return () => {
      editor.current = undefined;
      models.current = undefined;
      for (const track of tracks) track.dispose();
      instance.dispose();
      restoreEditorHoverDelegate();
      pair.original.dispose();
      pair.modified.dispose();
    };
  }, []);
  useEffect(() => {
    runtime.registrar.refreshModels();
  }, [file, workspaceId, status]);
  useEffect(() => {
    editor.current?.updateOptions({
      fontSize: values.codeSize,
      lineHeight: Math.round((values.codeSize * 25) / 16),
      maxTokenizationLineLength: 10000,
    });
  }, [values.codeSize]);
  useEffect(() => {
    const pair = models.current;
    if (!pair) return;
    if (pair.original.getValue() !== original) pair.original.setValue(original);
    if (pair.modified.getValue() !== modified) pair.modified.setValue(modified);
  }, [original, modified]);
  useEffect(() => {
    monaco.editor.setTheme(`kobrixa-${resolvedTheme}`);
    editor.current
      ?.getOriginalEditor()
      .updateOptions({ ariaLabel: `${originalLabel}: ${file}`, maxTokenizationLineLength: 10000 });
    editor.current
      ?.getModifiedEditor()
      .updateOptions({ ariaLabel: `${modifiedLabel}: ${file}`, maxTokenizationLineLength: 10000 });
  }, [file, resolvedTheme, originalLabel, modifiedLabel]);
  return (
    <div className="file-review-diff">
      <div className="file-review-diff-labels" aria-hidden="true">
        <span>{originalLabel}</span>
        <span>{modifiedLabel}</span>
      </div>
      <div className="file-review-diff-editor" ref={container} />
    </div>
  );
}
```

兩個既有 dialog 的 destructure 都加 `workspaceId, status`；各自 `<FileDiff>` 加以下 props（exact optional types 不傳顯式 undefined）：

```tsx
{...(workspaceId ? { workspaceId } : {})}
{...(status ? { status } : {})}
```

- [ ] **Step 3: 執行並確認 PASS**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/workspace/file-review-dialog.test.ts`

Expected: PASS；既有 conflict/history focus、close、reload、restore tests 保留。Review 不註冊 dynamic providers，`kobrixa-review` 不會收到 `kobrixa` selector 的服務。

- [ ] **Step 4: Commit（controller 執行）**

```bash
git add apps/desktop/src/renderer/workspace/file-review-dialog.tsx apps/desktop/src/renderer/workspace/file-review-dialog.test.ts
git commit -m "feat(editor): route review models through the shared language registrar"
```

#### 5.6 App restoration、status labels 與 static plugin UI

- [ ] **Step 1: 加 app wiring／label 及 static UI failing tests**

建立 `app.test.ts`。大型 App 的 bootstrap wiring 使用 source contract test；實際 promise timing 與 component model-creation barrier 已分別在 5.1、5.4、5.5 以行為測試驗證。這裡不以 source test 聲稱跑過 Electron restore。

```ts
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { languageDisplayName } from "./i18n/copy.js";
import type { LexicalLanguageRoute } from "./editor/static-language-routing.js";
const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
it("places the same static barrier before restoration, project initialization, opening and formatting", () => {
  expect(app).toMatch(
    /await staticLanguages\.ready;\s*const saved = await window\.kobrixa\.workspace\.restoreSession\(\)/,
  );
  for (const name of ["initializeProject", "openFile", "saveTab"]) {
    const start = app.indexOf(`async function ${name}(`);
    expect(start).toBeGreaterThan(0);
    const body = app.slice(start).match(/\): Promise<[^>]+> \{\s*([^\n]+)/);
    expect(body?.[1]).toBe("await staticLanguages.ready;");
  }
  expect(app).toContain("languageDisplayName(activeLexicalRoute, locale)");
  expect(app).not.toContain('endsWith(".json") ? "JSON" : t.basicPlus');
});
it.each(["en", "zh-TW"] as const)(
  "uses catalog aliases and localized fallback labels in %s",
  (locale) => {
    const route: LexicalLanguageRoute = {
      kind: "static",
      monacoLanguage: "toy",
      displayName: "Toy 😀",
      catalogRevision: 1,
    };
    expect(languageDisplayName(route, locale)).toBe("Toy 😀");
    expect(languageDisplayName({ ...route, displayName: "toy" }, locale)).toBe("toy");
    expect(languageDisplayName({ ...route, kind: "core", monacoLanguage: "json" }, locale)).toBe(
      "JSON",
    );
    expect(
      languageDisplayName({ ...route, kind: "plaintext", monacoLanguage: "plaintext" }, locale),
    ).toBe(locale === "zh-TW" ? "純文字" : "Plain Text");
  },
);
```

`plugins-panel.test.ts` 在現有 harness 加以下 fixture read 和 tests，使用 T0 已擴充的 `PluginsView`／`PluginsApi`（不匯入 T2 真實 manager）：

```ts
import { readFileSync } from "node:fs";
const toyManifest = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../packages/plugin-protocol/test-fixtures/static-languages/toy/kobrixa-plugin.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { id: string; runtime: { kind: "static" } };

it.each(["en", "zh-TW"] as const)(
  "shows enabled static contributions without a process in %s",
  async (locale) => {
    api.state.mockResolvedValueOnce({
      ...snapshot,
      plugins: [
        snapshot.plugins[0]!,
        {
          ...snapshot.plugins[1]!,
          id: toyManifest.id,
          runtime: toyManifest.runtime.kind,
          status: "enabled",
          running: false,
          commands: [],
          problems: [],
        },
      ],
    });
    await render(locale);
    expect(container.textContent).toContain(locale === "en" ? "Static contributions" : "靜態貢獻");
    expect(container.textContent).toContain(locale === "en" ? "Enabled" : "已啟用");
    expect(container.textContent).not.toContain(locale === "en" ? "Running" : "執行中");
    const label = locale === "en" ? "Disable" : "停用";
    const toggles = [...container.querySelectorAll("button")].filter(
      (item) => item.textContent === label,
    );
    expect(toggles).toHaveLength(1);
    await act(async () => toggles[0]!.click());
    expect(api.setEnabled).toHaveBeenCalledWith(snapshot.plugins[1]!.sourceKey, false);
    expect(api.execute).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      locale === "en" ? "static regular expressions" : "靜態正規表示式",
    );
  },
);
it.each(["en", "zh-TW"] as const)(
  "shows complete static resource, conflict and registration problems in %s",
  async (locale) => {
    api.state.mockResolvedValueOnce({
      ...snapshot,
      plugins: [
        {
          ...snapshot.plugins[1]!,
          runtime: "static",
          commands: [],
          problems: [
            {
              code: "PLUGIN_E_STATIC_LANGUAGE",
              message: "acme.toy resource rejected",
              detail: {
                languageId: "toy",
                resourcePath: "language/tokenizer.json",
                fieldPath: "states[0].rules[0].regex.pattern",
                limit: "STATIC_LANGUAGE_LIMITS_V1.patternLength",
                allowed: 2048,
                actual: 2049,
              },
            },
            {
              code: "PLUGIN_E_STATIC_LANGUAGE_CONFLICT",
              message: "acme.toy extension conflict",
              detail: {
                languageId: "toy",
                conflictingSources: [
                  { pluginId: "acme.toy", sourceKey: "dev:toy", languageId: "toy" },
                  { pluginId: "acme.other", sourceKey: "dev:other", languageId: "other" },
                ],
              },
            },
            {
              code: "PLUGIN_E_STATIC_LANGUAGE_REGISTRATION",
              message: "acme.toy registration rejected",
              detail: {
                languageId: "toy",
                limit: "STATIC_LANGUAGE_LIMITS_V1.sessionLanguageIds",
                allowed: 256,
                actual: 257,
              },
            },
          ],
        },
      ],
    });
    await render(locale);
    for (const text of [
      "language/tokenizer.json",
      "states[0].rules[0].regex.pattern",
      "2048",
      "2049",
      "acme.other",
      "dev:other",
      "256",
      "257",
    ])
      expect(container.textContent).toContain(text);
    expect(container.textContent).toContain(
      locale === "en" ? "Restart Kobrixa" : "重新啟動 Kobrixa",
    );
    expect(container.textContent).not.toContain("[object Object]");
  },
);
```

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/app.test.ts src/renderer/settings/plugins-panel.test.ts`

Expected: FAIL；label helper 未存在、app 未等待 static promise、static runtime 未翻譯，structured detail 未呈現。

- [ ] **Step 2: App 使用同一個 window barrier 和 resolver**

`app.tsx` 加 imports，App body 最前取得 window runtime（在 settings/recovery UI 之前，但不等待它才 render shell）：

```ts
import { useStaticLanguages } from "./editor/static-language-bootstrap.js";
import { languageDisplayName } from "./i18n/copy.js";
import type { editor as MonacoEditor } from "monaco-editor";

// First statement inside App:
const { runtime: staticLanguages, snapshot: staticLanguageState } = useStaticLanguages();
```

在 restoration 的 `try`，`const saved = await ...restoreSession()` **前一行**插入 `await staticLanguages.ready;`；在 `initializeProject`、`openFile`、`saveTab` 的 function body 第一行加入同一 `await staticLanguages.ready;`。其後原 promise／generation／draft guards 全保留。`saveTab` 也保護尚未開啟的 recovered file 走 `editor-format.ts` 建立 JSON temporary model 的入口；不修改 formatter。

在 `const active = tabs.find(...)` 後加入：

```ts
const activeLexicalRoute = staticLanguages.registrar.resolve({
  file: active?.file ?? "",
  ...(workspace ? { workspaceId: workspace.id } : {}),
  ...(languageBinding ? { binding: languageBinding } : {}),
});
```

footer 原 Basic Plus ternary 換成 `{languageDisplayName(activeLexicalRoute, locale)}`。`useStaticLanguages` 的 registrar subscription 保證 catalog alias／route 變化會 rerender label，不拿 service epoch 驅動 lexical label。不要把 `staticLanguageState` 加到 `analysisSession.configure`／`completionSession.configure` 的 dependencies。

`<Editor>` 加 `workspaceId={workspace.id}`。`<FileConflictDialog>`／`<LocalHistoryDialog>` 分別加對應 review 的 workspace id；只有它仍是目前 `languageStatus` 的 workspace 時才傳 status，避免將 A 的 binding 用在 B 的歷史檔案：

```tsx
// FileConflictDialog:
workspaceId={fileReview.workspaceId}
{...(workspace?.id === fileReview.workspaceId && languageStatus ? { status: languageStatus } : {})}
// LocalHistoryDialog:
workspaceId={historyReview.workspaceId}
{...(workspace?.id === historyReview.workspaceId && languageStatus ? { status: languageStatus } : {})}
```

inactive review context 不能冒用 active workspace 的 binding；其已知 binding 應從 retained project 的 `EditorModels` 取得。在 `editor-models.ts` 增加 `getLanguageStatus(): LanguageStatus | undefined { return this.status; }`，然後以上兩處完整 status expression 分別改為：

```tsx
{...(() => {
  const status = workspace?.id === fileReview.workspaceId ? languageStatus
    : sessions.get(fileReview.workspaceId)?.editor.getLanguageStatus();
  return status ? { status } : {};
})()}
```

LocalHistoryDialog 使用同一個完整 block，但將三個 `fileReview.workspaceId` 換成 `historyReview.workspaceId`。這只是同 task 的 EditorModels context，不新增 shared LanguageBinding DTO。

在 `<PluginRecoveryNotice ... />` 之後加入獨立 banner；既有 recovery settings link 與 N2 status row 都不動：

```tsx
{
  staticLanguageState.result?.kind === "plaintext" && (
    <div className="file-change-banner" role="status" data-static-language-bootstrap="failed">
      <span>{t.staticLanguageFailed}</span>
      <button
        onClick={() => {
          setSettingsCategory((previous) => ({
            category: "plugins",
            request: previous.request + 1,
          }));
          setSettingsOpen(true);
          setSettingsActive(true);
        }}
      >
        {t.languageSettings}
      </button>
    </div>
  );
}
```

在 `i18n/copy.ts` 兩個 locale 的開頭加：

```ts
// en:
plainText: "Plain Text",
staticLanguageFailed: "Language highlighting could not be loaded. You can keep editing in plain text.",
// zh-TW:
plainText: "純文字",
staticLanguageFailed: "無法載入語法上色，仍可繼續以純文字編輯。",
```

該檔增加 type-only import 並在檔尾加 helper：

```ts
import type { LexicalLanguageRoute } from "../editor/static-language-routing.js";
export function languageDisplayName(route: LexicalLanguageRoute, locale: Locale): string {
  if (route.kind === "plaintext") return copy[locale].plainText;
  if (route.kind === "core" && route.monacoLanguage === "json") return "JSON";
  return route.displayName;
}
```

長行 split coverage 有 ownership gap：`split-editor.tsx` 不在 write set。T5 在現有 app `onEditorReady` entry 作 runtime 保護（split 在 callback 前以 `model: null` 建立，此時尚未接上 project model），真正 constructor/update literal 修正交 T8。新增 app helper 並只將 `<SplitEditor onEditorReady={keyboard.bindEditor}>` 換成 `onEditorReady={bindSplitEditor}`：

```ts
function bindSplitEditor(instance: MonacoEditor.IStandaloneCodeEditor): () => void {
  const clamp = () => {
    if (instance.getRawOptions().maxTokenizationLineLength !== 10000)
      instance.updateOptions({ maxTokenizationLineLength: 10000 });
  };
  clamp();
  const change = instance.onDidChangeConfiguration(clamp);
  const off = keyboard.bindEditor(instance);
  return () => {
    change.dispose();
    off();
  };
}
```

這不是宣稱已完成 §4「所有 construction 明確寫 10000」；T8 必須取得 split 檔 ownership 後補齊，並驗證 initial/final configuration。

- [ ] **Step 3: 完整靜態問題呈現與雙語信任文案**

`plugin-copy.ts` 的 `pluginCopy.en`／`pluginCopy["zh-TW"]` 各增加：

```ts
// en:
staticRuntime: "Static contributions",
staticRestart: "Restart Kobrixa to register more languages.",
staticDetail: { language: "Language", resource: "Resource", field: "Field", limit: "Limit", allowed: "Allowed", actual: "Actual", conflicts: "Conflicting source" },
// zh-TW:
staticRuntime: "靜態貢獻",
staticRestart: "請重新啟動 Kobrixa，才能註冊更多語言。",
staticDetail: { language: "語言", resource: "資源", field: "欄位", limit: "上限", allowed: "允許值", actual: "實際值", conflicts: "衝突來源" },
```

替換 trust 與 developerHint 的完整值（其他 safe-mode／required 文案保留）：

```ts
// en:
trust: "Development plugins can run normal programs or load static regular expressions on this computer. Static regular expressions can block the editor even without a plugin process. Kobrixa permissions only limit what a plugin asks Kobrixa to do; they are not a sandbox. Load only plugins you trust. After an unresponsive session, restart Kobrixa to use safe mode and disable the problem plugin.",
developerHint: "Loads code and static language resources from folders you link on this computer. Only link plugins you trust.",
// zh-TW:
trust: "開發插件可在這部電腦執行一般程式，或載入靜態正規表示式。即使沒有插件程序，靜態正規表示式仍可能阻塞編輯器。Kobrixa 權限只限制插件透過 Kobrixa 提出的要求，並不是沙箱。請只載入你信任的插件。若畫面沒有回應，請重新啟動 Kobrixa，透過安全模式停用有問題的插件。",
developerHint: "會從你連結的資料夾載入程式碼與靜態語言資源。請只連結你信任的插件。",
```

在 `problems` table 加三個精確 error codes：

```ts
PLUGIN_E_STATIC_LANGUAGE: ["無法載入靜態語言資源", "Static language resources could not be loaded"],
PLUGIN_E_STATIC_LANGUAGE_CONFLICT: ["靜態語言或副檔名有衝突", "Static language or extension conflict"],
PLUGIN_E_STATIC_LANGUAGE_REGISTRATION: ["無法在編輯器啟用靜態語言", "The static language could not be enabled in the editor"],
```

在 `plugin-copy.ts` 加 type import 及完整 detail helper，不把 structured object 直接插入 JSX：

```ts
import type { PluginSummary } from "../../shared/plugins.js";
export function problemDetailLines(
  problem: PluginSummary["problems"][number],
  locale: Locale,
): string[] {
  const detail = problem.detail;
  if (!detail) return [];
  const t = pluginCopy[locale];
  const labels = t.staticDetail;
  const lines = [`${labels.language}: ${detail.languageId}`];
  if (detail.resourcePath) lines.push(`${labels.resource}: ${detail.resourcePath}`);
  if (detail.fieldPath) lines.push(`${labels.field}: ${detail.fieldPath}`);
  if (detail.limit) lines.push(`${labels.limit}: ${detail.limit}`);
  if (detail.allowed !== undefined)
    lines.push(
      `${labels.allowed}: ${Array.isArray(detail.allowed) ? detail.allowed.join(", ") : detail.allowed}`,
    );
  if (detail.actual !== undefined) lines.push(`${labels.actual}: ${detail.actual}`);
  for (const source of detail.conflictingSources ?? [])
    lines.push(
      `${labels.conflicts}: ${source.pluginId} / ${source.sourceKey} / ${source.languageId}`,
    );
  if (detail.limit === "STATIC_LANGUAGE_LIMITS_V1.sessionLanguageIds") lines.push(t.staticRestart);
  return lines;
}
```

`plugins-panel.tsx` 加 `problemDetailLines` import；row metadata array 的 `plugin.runtime` 換成 `plugin.runtime === "static" ? t.staticRuntime : plugin.runtime`；`plugin.running ? t.running : undefined` 換成 `plugin.runtime !== "static" && plugin.running ? t.running : undefined`。`t.status[plugin.status]` 保留，無 PID 不會被當成 unavailable。替換 `plugin.problems.map` 完整 JSX：

```tsx
{
  plugin.problems.map((problem, index) => (
    <div key={index} className="settings-hint" style={{ overflowWrap: "anywhere" }}>
      <p>{problemText(problem, locale)}</p>
      {problem.detail && (
        <ul>
          {problemDetailLines(problem, locale).map((line, detailIndex) => (
            <li key={detailIndex}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  ));
}
```

Enable／disable／reload／unlink 仍使用既有 host API 與 acknowledged state；不因 `runtime === "static"` 額外呼叫 execute、launch 或自動 retry。Builtin row 的 development-only action guard 保留。

- [ ] **Step 4: 執行 UI tests 並確認 PASS**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/app.test.ts src/renderer/settings/plugins-panel.test.ts src/renderer/editor/language-status.test.ts src/renderer/workspace/file-review-dialog.test.ts`

Expected: PASS；語言服務 status 分類與 N2 原有行為未改。Static-only enable/disable 顯示與 recovery 可使用既有 UI；真正 no-PID／safe-mode process 行為仍是 T2/T3/T7 → T8 驗收。

- [ ] **Step 5: Task-local verification、format、lint**

從 repository root 執行。下列兩個 package build 是 **controller 在 T0 單獨執行階段準備 T5 dependency environment 的命令**（part0 Step 8 已要求），不是讓 T5 worker 越界重寫其他 package 的 generated artifacts。T5 使用該精確 T0 commit 的已建置 dist，不讀其他 parallel branch 的輸出；不重新產生 schema、不 install、不修改 dependency files。

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime build
```

T5 worker 的 verification command：

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/app.test.ts src/renderer/editor/static-language-bootstrap.test.ts src/renderer/editor/model-language-route.test.ts src/renderer/editor/language-routing.test.ts src/renderer/editor/editor.test.ts src/renderer/editor/language-features.test.ts src/renderer/editor/semantic-tokens.test.ts src/renderer/workspace/file-review-dialog.test.ts src/renderer/settings/plugins-panel.test.ts src/renderer/editor/language-status.test.ts src/renderer/editor/editor-format.test.ts src/renderer/editor/completion-session.test.ts
```

Expected: PASS using T0 + T5；T4 factories/IPC lifecycle and T6 theme 都由本 task mocks 供給。既有 2B-2 companion 演算法用 T0 baseline 跑回歸，不依賴 T6 尚未合併的移植程式。`editor-format.test.ts` 和 `completion-session.test.ts` 只讀執行，不改檔。

以下明列全部 T5 changed files，避免 parallel worktree 的其他檔案混進格式化／lint：

```bash
t5_files=(
  apps/desktop/src/renderer/app.tsx
  apps/desktop/src/renderer/app.test.ts
  apps/desktop/src/renderer/editor/static-language-bootstrap.ts
  apps/desktop/src/renderer/editor/static-language-bootstrap.test.ts
  apps/desktop/src/renderer/editor/model-language-route.ts
  apps/desktop/src/renderer/editor/model-language-route.test.ts
  apps/desktop/src/renderer/editor/language-routing.ts
  apps/desktop/src/renderer/editor/language-routing.test.ts
  apps/desktop/src/renderer/editor/editor-models.ts
  apps/desktop/src/renderer/editor/editor.tsx
  apps/desktop/src/renderer/editor/editor.test.ts
  apps/desktop/src/renderer/editor/language-companion.ts
  apps/desktop/src/renderer/editor/language-features.ts
  apps/desktop/src/renderer/editor/language-features.test.ts
  apps/desktop/src/renderer/editor/semantic-tokens.ts
  apps/desktop/src/renderer/editor/semantic-tokens.test.ts
  apps/desktop/src/renderer/workspace/file-review-dialog.tsx
  apps/desktop/src/renderer/workspace/file-review-dialog.test.ts
  apps/desktop/src/renderer/settings/plugin-copy.ts
  apps/desktop/src/renderer/settings/plugins-panel.tsx
  apps/desktop/src/renderer/settings/plugins-panel.test.ts
  apps/desktop/src/renderer/i18n/copy.ts
)
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --write "${t5_files[@]}"
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --check "${t5_files[@]}"
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec eslint "${t5_files[@]}"
git diff --check
git diff --name-only
rg -n 'companion\.monacoLanguage|registerBasicPlusLanguage|let registered' apps/desktop/src/renderer/editor/editor.tsx apps/desktop/src/renderer/editor/language-routing.ts apps/desktop/src/renderer/editor/language-features.ts
rg -n 'basic-plus|bp\|bpi\|bpm|t\.basicPlus' apps/desktop/src/renderer/editor/language-routing.ts apps/desktop/src/renderer/workspace/file-review-dialog.tsx
```

Expected: prettier／ESLint／diff check PASS；兩個 `rg` 無命中（exit 1 是此處預期），changed files 全在上方 write set。`app.tsx` 既有 implicit-project entry 預設與 simulator `.bp` source selection 不屬 lexical inference，不在本 task 重構。

**Branch-local type checking 的已知邊界：** `pnpm --filter @kobrixa/desktop check` 是 whole-desktop check，會包含 T6 尚未修改的 typed companion object 和無 owner 的 completion test fixture。T5 不宣稱它在 T0 上通過、不加 cast/index signature 掩蓋、不等待 T6 才讓單元測試跑。完整 check 命令及必要 hand-off 列於下方，必須在 T8 清掉，不能作為可發布的既知錯誤保留。

- [ ] **Step 6: Commit（controller 執行）**

最後一次 commit 包含 5.6 changes 與上一步在 T5 write set 內的格式化；之前小節已分別 commit。controller 在同一 shell 使用上方 `t5_files` 的明確清單：

```bash
git add "${t5_files[@]}"
git commit -m "feat(plugins): show static language state and gate renderer restoration"
```

**Deferred to T8**

- T4 真 store／registrar + T3 IPC 的 disable-before-old-fetch、invalid snapshot、failed fetch、same-revision late bootstrap recovery、quarantine 不自動 retry、256/257 ids、StrictMode 和所有 live models 的同步撤銷；5.1／5.4／5.5 mock tests 只驗證 T5 消費契約。RF2 的真競態仍由 T4 regression 及合併後實際 review/UI 驗證。
- 與 T6 真 theme／Basic Plus resources 合併後，執行 `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/static-language-migration.test.ts`。RF5 的 renamed session/draft、failed generation 與 register-once 必須同時檢查，不以本 task 的 URI prefix 或 mock 替代資料遷移驗收。
- Controller 解決下方 fixture ownership 後執行 `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop check`；T5/T6 移除 companion 欄位的兩半都必須合併，再驗整個 desktop。T5 的 scoped tests／lint 不等同這項 type check。
- `split-editor.tsx` construction/updateOptions 的 literal clamp，以及真正 Monaco 0.57.0 standalone、split、diff original/modified 在 9,999／10,000／10,001 UTF-16 邊界的 `tokenize`／`tokenizeEncoded`、後續多行 state、typing/save/undo。app callback 的 runtime 保護不能替代這個驗收。
- T7 實際 static-only no-PID、safe mode、disable/re-enable、renderer-unresponsive 下一次啟動、無 repository 原始碼的 packaged app；全套語言功能和多 model selector 隔離、light/dark、內容／undo／selection／draft／view-state 保留。執行 `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm test:desktop:smoke`，completion 門檻仍為 p95 ≤100 ms、新變數 ≤200 ms、30,000 行 ≤300 ms。環境無法執行時記錄真錯誤與人工結果，不以 mock PASS 代替。
- N2 未納入：本 task 的 static bootstrap failure 使用 app 獨立 banner，沒有修改 `language-status.tsx` 的 loader messages 呈現區域；保留原錯誤分類與 `role="status"`。N1 仍是 T7，T5 不寫 smoke preload。

**Contract gaps**

- **T0 未凍結 window owner、retained context、provider selector 和 label 的本地 glue。** 已在 T5 write set 的 `static-language-bootstrap.ts`、`model-language-route.ts`、`editor-models.ts`、`i18n/copy.ts` 完整定義；T0 的 bootstrap/result、route/interfaces、T4 factory 和 T6 theme 函式名稱／簽章都不變。`LanguageFeatures.register(route, model)` 是 T5-only 呼叫面；不要求其他 worker 編輯其檔案。
- **Split options ownership 缺口。** 實際 `apps/desktop/src/renderer/editor/split-editor.tsx` 也有 `monaco.editor.create` 與 `updateOptions`，但 §11.1／part0 都未分配給 T5。T5 在自己擁有的 `app.tsx` 加 pre-model callback clamp；controller 必須在各 task 停止寫入後交 T8 修改 split 檔及其直接測試，才能滿足全部 options construction 的精確要求。T5 不越界修改。
- **獨立 whole-desktop type check 與 companion 欄位移除的缺口。** T0 仍保留 T6 的 `companions/basic-plus/companion.ts:8-10` typed object 及 `apps/desktop/src/renderer/editor/completion-session.test.ts:37` 的 `monacoLanguage`，後者不在任何已列 T5 ownership；刪 T5 interface 後產生 excess-property errors。T6 負責前者；controller 必須將後者在 T8 唯一接手，移除該 fixture 欄位並執行上面的全 desktop check。本計畫的 T0-only gates 是 mocked Vitest + scoped prettier/ESLint，沒有虛報全 desktop typecheck 可獨立通過。
### Task 6: Basic Plus resources, raw bundling, and independent editor themes

**Files:**

- Modify: `plugins/basic-plus/kobrixa-plugin.json:1-39` (`apiVersion` and `contributes`; retain frontend/service declarations).
- Create: `plugins/basic-plus/language/tokenizer.json`.
- Create: `plugins/basic-plus/language/configuration.json`.
- Modify: `apps/desktop/src/main/plugins/builtin.ts:1-9` (T0 adds the required empty `resources` maps).
- Modify/Test: `apps/desktop/src/main/plugins/builtin.test.ts:1-82` (retain both compiler regression tests).
- Modify: `apps/desktop/src/renderer/editor/companions/basic-plus/registration.ts:1-135` (replace with a theme-only re-export).
- Modify: `apps/desktop/src/renderer/editor/companions/basic-plus/companion.ts:8-19` (remove the lexical id; retain all dynamic functions).
- Create: `apps/desktop/src/renderer/editor/companions/basic-plus/theme.ts`.
- Modify: `apps/desktop/src/renderer/editor/editor-theme.ts` (replace the T0 stub).
- Create/Test: `apps/desktop/src/renderer/editor/editor-theme.test.ts`.
- Create/Test: `apps/desktop/src/renderer/editor/static-language-migration.test.ts`.

These are the complete write set for this task. Line numbers describe the inspected pre-T0 files; the named declarations are the edit anchors after T0. Read-only inputs include `frontends/basic-plus/src/{language,indentation}.ts`, `apps/desktop/src/shared/workspace-session.ts`, `apps/desktop/src/renderer/editor/documents.ts`, and T0's two `packages/plugin-protocol/test-fixtures/static-languages/basic-plus/*.json` files. Do not edit the shared fixtures, frontend, T4 infrastructure, T5 consumers, smoke tests, package manifests, or lockfile.

**Interfaces:**

- Consumes: T0's `PluginSource = { kind: "builtin"; manifest: unknown; resources: Readonly<Record<string, string>> } | { kind: "development"; directory: string }` from `@kobrixa/plugin-runtime`; existing `BUILTIN_PLUGIN_SOURCES: readonly PluginSource[]` retains its name and order.
- Consumes: T0's `StaticLanguageDecl`, `StaticLanguageTokenizerV1`, `StaticLanguageConfigurationV1`, and `validateStaticLanguageResources(input: ValidateStaticLanguageResourcesInput): StaticLanguageValidationResult`. The validator remains a throwing stub on this branch; do not invoke it in the branch-local gate. T8 validates the shipped bytes through its real implementation.
- Consumes: T0's exact Basic Plus fixture paths above; `BASIC_PLUS_KEYWORDS`, `BASIC_PLUS_INDENTATION_RULES`, `formatBasicPlus`, and `basicPlusLineIndentation` from `@kobrixa/basic-plus/language`.
- Consumes: existing `LanguageCompanion`, `workspaceSessionSchema`, and `Documents.replace(tabs: DocumentTab[]): void` / `getSnapshot(): DocumentTab[]`. T0 still requires the obsolete companion lexical field; §6.3 defines an owned local compatibility type for its removal, without changing the shared interface.
- Produces: Basic Plus API `^1.4.0` declaration with `id: "bp"`, extensions `["bp", "bpi", "bpm"]`, aliases `["Basic Plus", "Basic+"]`, and version-1 paths `language/tokenizer.json` / `language/configuration.json`. The host map uses exactly these keys and raw strings; EV3 retains `resources: {}`.
- Produces: `basicPlusThemeRules(dark: boolean): editor.ITokenThemeRule[]` in `companions/basic-plus/theme.ts`; T0's unchanged `EditorThemeApi { defineTheme(name: string, data: editor.IStandaloneThemeData): void }` and `initializeEditorThemes(api: EditorThemeApi): void` in `editor-theme.ts`. T5 calls `initializeEditorThemes(monaco.editor)` independently of catalog/bootstrap success.
- Produces: `basicPlusCompanion` with the same dynamic behavior and no own `monacoLanguage` property. `registration.ts` becomes a side-effect-free re-export of `basicPlusThemeRules`; it exports neither a tokenizer nor a registration function.

Run in a dedicated worktree from the T0 commit. This task's tests use frozen resource fixtures, real existing frontend exports, the installed Monaco 0.57.0 compiler/tokenizer, and local mocks for window-facing Monaco APIs. They do not use T1's validator, T2's catalog implementation, or T4/T5's implementations. A passing fixture conversion test proves resource parity, not conformance of the final T4 adapter. The T0-to-final removal of the old editor import and companion field crosses T5's ownership; the combined desktop typecheck belongs to T8, as recorded under Contract gaps.

#### 6.1 Declare and bundle the exact Basic Plus resources

- [ ] **Step 1: Write failing manifest, raw-byte, keyword, and configuration tests**

Append the following imports and tests to `apps/desktop/src/main/plugins/builtin.test.ts`, retaining both existing tests and their helpers. There is no new runtime mock: the existing `loadPlugins()` compiler tests continue to exercise T0's unchanged compiler behavior; the new tests inspect the host source contract directly.

```ts
import { readFile } from "node:fs/promises";
import { pluginManifestSchema } from "@kobrixa/plugin-protocol";
import { BASIC_PLUS_KEYWORDS, BASIC_PLUS_INDENTATION_RULES } from "@kobrixa/basic-plus/language";
import type {
  StaticLanguageTokenizerV1,
  StaticLanguageConfigurationV1,
} from "@kobrixa/plugin-protocol";

const repository = new URL("../../../../../", import.meta.url);
const readRepository = (file: string) => readFile(new URL(file, repository), "utf8");

it("declares bp without changing the builtin frontend or language service", () => {
  const source = BUILTIN_PLUGIN_SOURCES[0]!;
  expect(source.kind).toBe("builtin");
  if (source.kind !== "builtin") throw new Error("Expected bundled Basic Plus.");
  const manifest = pluginManifestSchema.parse(source.manifest);
  expect(manifest.id).toBe("kobrixa.basic-plus");
  expect(manifest.apiVersion).toBe("^1.4.0");
  expect(manifest.runtime).toEqual({ kind: "builtin" });
  expect(manifest.contributes?.languages).toEqual([
    {
      id: "bp",
      extensions: ["bp", "bpi", "bpm"],
      aliases: ["Basic Plus", "Basic+"],
      tokenizer: { version: 1, path: "language/tokenizer.json" },
      configuration: { version: 1, path: "language/configuration.json" },
    },
  ]);
  expect(manifest.contributes?.frontends).toEqual([
    {
      language: "bp",
      entryExtensions: ["bp"],
      sourceExtensions: ["bp", "bpi", "bpm"],
      ir: { min: 1, max: 1 },
    },
  ]);
  expect(manifest.contributes?.languageServices).toEqual([
    {
      language: "bp",
      extensions: ["bp", "bpi", "bpm"],
      capabilities: [
        "analysis",
        "completion",
        "quickFixes",
        "semanticTokens",
        "hover",
        "signatureHelp",
        "definition",
        "references",
        "rename",
        "documentSymbols",
        "documentFormatting",
        "rangeFormatting",
      ],
    },
  ]);
});

it("bundles exact UTF-8 resource text under the manifest's relative keys", async () => {
  const source = BUILTIN_PLUGIN_SOURCES[0]!;
  if (source.kind !== "builtin") throw new Error("Expected bundled Basic Plus.");
  expect(Object.keys(source.resources).sort()).toEqual([
    "language/configuration.json",
    "language/tokenizer.json",
  ]);
  for (const name of ["tokenizer", "configuration"] as const) {
    const resourcePath = `language/${name}.json`;
    const raw = await readRepository(`plugins/basic-plus/${resourcePath}`);
    const fixture = await readRepository(
      `packages/plugin-protocol/test-fixtures/static-languages/basic-plus/${name}.json`,
    );
    expect(source.resources[resourcePath]).toBe(raw);
    expect(Buffer.from(source.resources[resourcePath]!, "utf8")).toEqual(
      await readFile(new URL(`plugins/basic-plus/${resourcePath}`, repository)),
    );
    expect(JSON.parse(raw)).toEqual(JSON.parse(fixture));
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.charCodeAt(0)).not.toBe(0xfeff);
  }
  const ev3 = BUILTIN_PLUGIN_SOURCES[1]!;
  if (ev3.kind !== "builtin") throw new Error("Expected bundled EV3.");
  expect(ev3.resources).toEqual({});
});

it("keeps all keyword lists, nine ordered rules and the original configuration", async () => {
  const tokenizer = JSON.parse(
    await readRepository("plugins/basic-plus/language/tokenizer.json"),
  ) as StaticLanguageTokenizerV1;
  const configuration = JSON.parse(
    await readRepository("plugins/basic-plus/language/configuration.json"),
  ) as StaticLanguageConfigurationV1;
  expect(tokenizer.ignoreCase).toBe(true);
  expect(tokenizer.defaultToken).toBe("invalid");
  expect(tokenizer.tokenPostfix).toBe(".basic-plus");
  expect(tokenizer.states.map((state) => state.name)).toEqual(["root"]);
  expect(tokenizer.states[0]!.rules).toHaveLength(9);
  expect(tokenizer.lists).toEqual([
    { name: "keywords", words: [...BASIC_PLUS_KEYWORDS] },
    {
      name: "control",
      words: [
        "If",
        "Then",
        "Else",
        "ElseIf",
        "EndIf",
        "For",
        "To",
        "Step",
        "EndFor",
        "While",
        "EndWhile",
        "Break",
        "Continue",
        "Return",
        "Goto",
      ],
    },
    { name: "types", words: ["Number", "String"] },
    { name: "booleans", words: ["True", "False"] },
    { name: "word_operators", words: ["And", "Or", "Not"] },
  ]);
  for (const list of tokenizer.lists!)
    expect(new Set(list.words.map((word) => word.toLowerCase())).size).toBe(list.words.length);
  for (const rule of tokenizer.states[0]!.rules) {
    if (!("regex" in rule)) throw new Error("Basic Plus has no includes.");
    expect(rule.regex.flags).toBe("i");
  }
  const identifier = tokenizer.states[0]!.rules[4]!;
  if (!("regex" in identifier) || !("cases" in identifier.action))
    throw new Error("Expected ordered identifier cases.");
  expect(identifier.action.cases.map((branch) => branch.when)).toEqual([
    "@types",
    "@booleans",
    "@word_operators",
    "@control",
    "@keywords",
    "@default",
  ]);
  expect(configuration).toEqual({
    comments: { lineComment: "'" },
    brackets: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
    ],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
      { open: '"', close: '"', notIn: ["string", "comment"] },
    ],
    surroundingPairs: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
      { open: '"', close: '"' },
    ],
    indentationRules: Object.fromEntries(
      Object.entries(BASIC_PLUS_INDENTATION_RULES).map(([name, regex]) => [
        name,
        { pattern: regex.source, flags: regex.flags },
      ]),
    ),
  });
  expect(configuration).not.toHaveProperty("wordPattern");
  expect(configuration).not.toHaveProperty("onEnterRules");
  for (const name of ["increaseIndentPattern", "decreaseIndentPattern"] as const) {
    const data = configuration.indentationRules![name];
    const regex = new RegExp(data.pattern, data.flags);
    for (const line of [
      "If True Then",
      "\tELSEIF ready",
      "Else",
      "While ready",
      "For i = 1 To 2",
      "Sub Main()",
      "Function Double()",
      "Module Math",
      "EndIf",
      "EndWhile",
      "EndFor",
      "EndSub",
      "EndFunction",
      "EndModule",
      "If.member = 1",
      "ElseIf.member = 2",
      "WhileLoop = 1",
      "' If True Then",
      'caption = "If"',
    ])
      expect(regex.test(line), `${name}: ${line}`).toBe(
        BASIC_PLUS_INDENTATION_RULES[name].test(line),
      );
    expect(regex.test("If.member = 1")).toBe(false);
    expect(regex.test("Else.member = 1")).toBe(false);
  }
});
```

- [ ] **Step 2: Run the tests and expect FAIL**

Build the packages consumed by desktop before the first test run. No source edits or dependency installation are involved in these builds.

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol build && pnpm --filter @kobrixa/plugin-runtime build && pnpm --filter @kobrixa/ir build && pnpm --filter @kobrixa/compiler build && pnpm --filter @kobrixa/basic-plus build && pnpm --filter @kobrixa/backend-ev3 build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/builtin.test.ts
```

Expected: FAIL for the new manifest/resource assertions (`^1.3.0`, missing `languages`, empty raw map, missing resource files); the two existing compiler tests remain green. A build/setup failure is not the intended red result.

- [ ] **Step 3: Write the manifest, complete resources, and raw imports**

Replace `plugins/basic-plus/kobrixa-plugin.json` with:

```json
{
  "id": "kobrixa.basic-plus",
  "version": "1.0.0",
  "apiVersion": "^1.4.0",
  "displayName": { "en": "Basic Plus", "zh-TW": "Basic Plus" },
  "runtime": { "kind": "builtin" },
  "contributes": {
    "languages": [
      {
        "id": "bp",
        "extensions": ["bp", "bpi", "bpm"],
        "aliases": ["Basic Plus", "Basic+"],
        "tokenizer": { "version": 1, "path": "language/tokenizer.json" },
        "configuration": { "version": 1, "path": "language/configuration.json" }
      }
    ],
    "frontends": [
      {
        "language": "bp",
        "entryExtensions": ["bp"],
        "sourceExtensions": ["bp", "bpi", "bpm"],
        "ir": { "min": 1, "max": 1 }
      }
    ],
    "languageServices": [
      {
        "language": "bp",
        "extensions": ["bp", "bpi", "bpm"],
        "capabilities": [
          "analysis",
          "completion",
          "quickFixes",
          "semanticTokens",
          "hover",
          "signatureHelp",
          "definition",
          "references",
          "rename",
          "documentSymbols",
          "documentFormatting",
          "rangeFormatting"
        ]
      }
    ]
  }
}
```

Create `plugins/basic-plus/language/tokenizer.json` with the exact T0 fixture content:

```json
{
  "ignoreCase": true,
  "tokenPostfix": ".basic-plus",
  "defaultToken": "invalid",
  "lists": [
    {
      "name": "keywords",
      "words": [
        "And",
        "Break",
        "Continue",
        "Dim",
        "Else",
        "ElseIf",
        "EndFor",
        "EndFunction",
        "EndIf",
        "EndModule",
        "EndRegion",
        "EndSub",
        "EndWhile",
        "False",
        "For",
        "Folder",
        "Function",
        "Goto",
        "If",
        "Include",
        "Import",
        "In",
        "Module",
        "Not",
        "Number",
        "Or",
        "Out",
        "Private",
        "Property",
        "Region",
        "Return",
        "Step",
        "String",
        "Sub",
        "Then",
        "To",
        "True",
        "While"
      ]
    },
    {
      "name": "control",
      "words": [
        "If",
        "Then",
        "Else",
        "ElseIf",
        "EndIf",
        "For",
        "To",
        "Step",
        "EndFor",
        "While",
        "EndWhile",
        "Break",
        "Continue",
        "Return",
        "Goto"
      ]
    },
    {
      "name": "types",
      "words": ["Number", "String"]
    },
    {
      "name": "booleans",
      "words": ["True", "False"]
    },
    {
      "name": "word_operators",
      "words": ["And", "Or", "Not"]
    }
  ],
  "states": [
    {
      "name": "root",
      "rules": [
        {
          "regex": {
            "pattern": "[ \\t\\r]+",
            "flags": "i"
          },
          "action": {
            "token": "white"
          }
        },
        {
          "regex": {
            "pattern": "'[^\\r\\n]*",
            "flags": "i"
          },
          "action": {
            "token": "comment"
          }
        },
        {
          "regex": {
            "pattern": "\"(?:[^\"\\r\\n]|\"\")*\"(?!\")",
            "flags": "i"
          },
          "action": {
            "token": "string"
          }
        },
        {
          "regex": {
            "pattern": "\"[^\\r\\n]*$",
            "flags": "i"
          },
          "action": {
            "token": "string.invalid"
          }
        },
        {
          "regex": {
            "pattern": "[A-Za-z_][\\w.]*",
            "flags": "i"
          },
          "action": {
            "cases": [
              {
                "when": "@types",
                "action": {
                  "token": "type"
                }
              },
              {
                "when": "@booleans",
                "action": {
                  "token": "constant.language"
                }
              },
              {
                "when": "@word_operators",
                "action": {
                  "token": "operator.word"
                }
              },
              {
                "when": "@control",
                "action": {
                  "token": "keyword.control"
                }
              },
              {
                "when": "@keywords",
                "action": {
                  "token": "keyword"
                }
              },
              {
                "when": "@default",
                "action": {
                  "token": "identifier"
                }
              }
            ]
          }
        },
        {
          "regex": {
            "pattern": "(?:\\d+\\.\\d*|\\.\\d+|\\d+)",
            "flags": "i"
          },
          "action": {
            "token": "number"
          }
        },
        {
          "regex": {
            "pattern": "!=|<=|>=|<>|\\+=|-=|\\*=|\\/=|\\+\\+|--|[=<>+\\-*/%]",
            "flags": "i"
          },
          "action": {
            "token": "operator"
          }
        },
        {
          "regex": {
            "pattern": "@",
            "flags": "i"
          },
          "action": {
            "token": "operator"
          }
        },
        {
          "regex": {
            "pattern": "[()[\\],.:]",
            "flags": "i"
          },
          "action": {
            "token": "delimiter"
          }
        }
      ]
    }
  ]
}
```

Create `plugins/basic-plus/language/configuration.json` with the exact T0 fixture content:

```json
{
  "comments": {
    "lineComment": "'"
  },
  "brackets": [
    {
      "open": "(",
      "close": ")"
    },
    {
      "open": "[",
      "close": "]"
    }
  ],
  "autoClosingPairs": [
    {
      "open": "(",
      "close": ")"
    },
    {
      "open": "[",
      "close": "]"
    },
    {
      "open": "\"",
      "close": "\"",
      "notIn": ["string", "comment"]
    }
  ],
  "surroundingPairs": [
    {
      "open": "(",
      "close": ")"
    },
    {
      "open": "[",
      "close": "]"
    },
    {
      "open": "\"",
      "close": "\""
    }
  ],
  "indentationRules": {
    "increaseIndentPattern": {
      "pattern": "^[\\t ]*(?:If|ElseIf|Else|While|For|Sub|Function|Module)(?![A-Za-z0-9_.])",
      "flags": "i"
    },
    "decreaseIndentPattern": {
      "pattern": "^[\\t ]*(?:ElseIf|Else|EndIf|EndWhile|EndFor|EndSub|EndFunction|EndModule)(?![A-Za-z0-9_.])",
      "flags": "i"
    }
  }
}
```

Replace `apps/desktop/src/main/plugins/builtin.ts` with:

```ts
import type { PluginSource } from "@kobrixa/plugin-runtime";
import basicPlus from "../../../../../plugins/basic-plus/kobrixa-plugin.json" with { type: "json" };
import tokenizer from "../../../../../plugins/basic-plus/language/tokenizer.json?raw";
import configuration from "../../../../../plugins/basic-plus/language/configuration.json?raw";
import ev3 from "../../../../../plugins/ev3/kobrixa-plugin.json" with { type: "json" };

/** Built-in manifests and raw resources are bundled; the registry validates both. */
export const BUILTIN_PLUGIN_SOURCES: readonly PluginSource[] = [
  {
    kind: "builtin",
    manifest: basicPlus,
    resources: {
      "language/tokenizer.json": tokenizer,
      "language/configuration.json": configuration,
    },
  },
  { kind: "builtin", manifest: ev3, resources: {} },
];
```

`vite/client` is already in the desktop tsconfig. No new declaration file is needed. The production module performs no filesystem read or parse/stringify conversion; only tests read repository files. T2 owns validation, limits, eligibility, source identity, and catalog publication.

- [ ] **Step 4: Format, run, and expect PASS**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --write plugins/basic-plus/kobrixa-plugin.json plugins/basic-plus/language/tokenizer.json plugins/basic-plus/language/configuration.json apps/desktop/src/main/plugins/builtin.ts apps/desktop/src/main/plugins/builtin.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/builtin.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --check plugins/basic-plus/kobrixa-plugin.json plugins/basic-plus/language/tokenizer.json plugins/basic-plus/language/configuration.json apps/desktop/src/main/plugins/builtin.ts apps/desktop/src/main/plugins/builtin.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec eslint apps/desktop/src/main/plugins/builtin.ts apps/desktop/src/main/plugins/builtin.test.ts
```

Expected: PASS, including both original compiler tests. ESLint covers the changed TypeScript; JSON is covered by Prettier and parsing assertions. This does not claim T1 semantic validation or packaged-app acceptance.

- [ ] **Step 5: Have the controller commit**

The controller runs:

```bash
git add plugins/basic-plus/kobrixa-plugin.json plugins/basic-plus/language/tokenizer.json plugins/basic-plus/language/configuration.json apps/desktop/src/main/plugins/builtin.ts apps/desktop/src/main/plugins/builtin.test.ts
git commit -m "feat(plugins): bundle Basic Plus static language resources"
```

#### 6.2 Pin lexical parity through the installed Monaco engine

- [ ] **Step 1: Write the failing resource-to-Monarch parity tests**

Create `apps/desktop/src/renderer/editor/static-language-migration.test.ts` with this complete test body. The local conversion deliberately supports only the frozen Basic Plus fixture. It is test code, not a second production adapter. It never calls T0's throwing `adaptStaticLanguage()` or validator stub. The independent legacy definition below transcribes `registration.ts:5-56` before its removal.

```ts
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import type { languages } from "monaco-editor";
import type { StaticLanguageTokenizerV1 } from "@kobrixa/plugin-protocol";
import { BASIC_PLUS_KEYWORDS } from "@kobrixa/basic-plus/language";

const repository = new URL("../../../../../", import.meta.url);
const tokenizerFile = new URL("plugins/basic-plus/language/tokenizer.json", repository);

// A test-only projection of the nine-rule fixture, never a public adapter API.
function basicPlusFixtureDefinition(input: StaticLanguageTokenizerV1): languages.IMonarchLanguage {
  expect(input.states.map((state) => state.name)).toEqual(["root"]);
  expect(input.states[0]!.rules).toHaveLength(9);
  const root: languages.IMonarchLanguageRule[] = input.states[0]!.rules.map((rule) => {
    if (!("regex" in rule)) throw new Error("Unexpected include in Basic Plus fixture.");
    const regex = new RegExp(rule.regex.pattern.replaceAll("@", "@@"), rule.regex.flags);
    if ("cases" in rule.action) {
      const cases: Record<string, string> = {};
      for (const branch of rule.action.cases) {
        expect(Object.keys(branch.action)).toEqual(["token"]);
        const key = branch.when === "@default" ? "@default" : `@list_${branch.when.slice(1)}`;
        cases[key] = branch.action.token;
      }
      return [regex, { cases }];
    }
    expect(Object.keys(rule.action)).toEqual(["token"]);
    return [regex, rule.action.token];
  });
  return {
    ignoreCase: input.ignoreCase,
    defaultToken: input.defaultToken!,
    tokenPostfix: input.tokenPostfix!,
    ...Object.fromEntries(input.lists!.map((list) => [`list_${list.name}`, [...list.words]])),
    tokenizer: { root },
  };
}

const legacyDefinition: languages.IMonarchLanguage = {
  ignoreCase: true,
  tokenPostfix: ".basic-plus",
  defaultToken: "invalid",
  keywords: [...BASIC_PLUS_KEYWORDS],
  control: [
    "If",
    "Then",
    "Else",
    "ElseIf",
    "EndIf",
    "For",
    "To",
    "Step",
    "EndFor",
    "While",
    "EndWhile",
    "Break",
    "Continue",
    "Return",
    "Goto",
  ],
  types: ["Number", "String"],
  booleans: ["True", "False"],
  wordOperators: ["And", "Or", "Not"],
  tokenizer: {
    root: [
      [/[ \t\r]+/, "white"],
      [/'[^\r\n]*/, "comment"],
      [/"(?:[^"\r\n]|"")*"(?!")/, "string"],
      [/"[^\r\n]*$/, "string.invalid"],
      [
        /[A-Za-z_][\w.]*/,
        {
          cases: {
            "@types": "type",
            "@booleans": "constant.language",
            "@wordOperators": "operator.word",
            "@control": "keyword.control",
            "@keywords": "keyword",
            "@default": "identifier",
          },
        },
      ],
      [/(?:\d+\.\d*|\.\d+|\d+)/, "number"],
      [/!=|<=|>=|<>|\+=|-=|\*=|\/=|\+\+|--|[=<>+\-*/%]/, "operator"],
      [/@/, "operator"],
      [/[()[\],.:]/, "delimiter"],
    ],
  },
};

interface ClassicTokenizer {
  getInitialState(): unknown;
  tokenize(
    line: string,
    hasEOL: boolean,
    state: unknown,
  ): {
    tokens: { offset: number; type: string; language: string }[];
    endState: unknown;
  };
  dispose(): void;
}
async function monarch(
  id: string,
  definition: languages.IMonarchLanguage,
): Promise<ClassicTokenizer> {
  // Monaco 0.57.0 maps package subpaths to esm/vs; do not add an esm/vs prefix.
  // Variable imports avoid inventing declarations for Monaco's private JS modules.
  const compilePath = "monaco-editor/editor/standalone/common/monarch/monarchCompile.js";
  const lexerPath = "monaco-editor/editor/standalone/common/monarch/monarchLexer.js";
  const { compile } = (await import(compilePath)) as {
    compile(languageId: string, source: languages.IMonarchLanguage): unknown;
  };
  const { MonarchTokenizer } = (await import(lexerPath)) as {
    MonarchTokenizer: new (
      languageService: object,
      themeService: object,
      languageId: string,
      lexer: unknown,
      configuration: {
        getValue(): number;
        onDidChangeConfiguration(): { dispose(): void };
      },
    ) => ClassicTokenizer;
  };
  // Classic tokenize needs no DOM, embedded language service, or token theme.
  return new MonarchTokenizer({}, {}, id, compile(id, definition), {
    getValue: () => 10000,
    onDidChangeConfiguration: () => ({ dispose() {} }),
  });
}
function spans(tokenizer: ClassicTokenizer, text: string) {
  let state = tokenizer.getInitialState();
  return text.split("\n").map((line) => {
    const result = tokenizer.tokenize(line, true, state);
    state = result.endState;
    return result.tokens.map((token, index) => ({
      start: token.offset,
      end: result.tokens[index + 1]?.offset ?? line.length,
      type: token.type,
    }));
  });
}

it("preserves legacy token classes and UTF-16 ranges for all nine rules", async () => {
  const wire = JSON.parse(await readFile(tokenizerFile, "utf8")) as StaticLanguageTokenizerV1;
  const old = await monarch("basic-plus", legacyDefinition);
  const current = await monarch("bp", basicPlusFixtureDefinition(wire));
  try {
    const samples = [
      " \t\r",
      "' 中文😀 If True @",
      'caption = "say ""hello"""',
      'caption = "unfinished""\nEndIf',
      '""',
      '"""',
      "rEgIoN Demo\nIf True And count != @value Then\nEndRegion",
      "If.member ElseIf.member foo.bar _value",
      "0 12 3.14 .5 12.",
      "!= <= >= <> += -= *= /= ++ -- = < > + - * / %",
      "@ @@ @name \\@ $",
      "(value)[index],.:",
      "中文😀",
      "LCD.Clear()\r\nReturn 1",
      ...BASIC_PLUS_KEYWORDS.flatMap((word) => [word, word.toLowerCase(), word.toUpperCase()]),
    ];
    for (const sample of samples)
      expect(spans(current, sample), sample).toEqual(spans(old, sample));
    expect(
      spans(current, "nUmBeR tRuE aNd iF dIm x")[0]!
        .filter((token) => token.type !== "white.basic-plus")
        .map((token) => token.type),
    ).toEqual([
      "type.basic-plus",
      "constant.language.basic-plus",
      "operator.word.basic-plus",
      "keyword.control.basic-plus",
      "keyword.basic-plus",
      "identifier.basic-plus",
    ]);
    expect(spans(current, '"say ""hello"""')[0]).toEqual([
      { start: 0, end: 15, type: "string.basic-plus" },
    ]);
    expect(spans(current, '"unfinished""\nEndIf').map((line) => line[0]!.type)).toEqual([
      "string.invalid.basic-plus",
      "keyword.control.basic-plus",
    ]);
    expect(
      spans(current, "@ @@ @name")[0]!
        .filter((token) => token.type === "operator.basic-plus")
        .map(({ start, end }) => [start, end]),
    ).toEqual([
      [0, 1],
      [2, 4],
      [5, 6],
    ]);
  } finally {
    old.dispose();
    current.dispose();
  }
});

it("keeps the Basic Plus root state after skipped long lines", async () => {
  const wire = JSON.parse(await readFile(tokenizerFile, "utf8")) as StaticLanguageTokenizerV1;
  const current = await monarch("bp", basicPlusFixtureDefinition(wire));
  try {
    for (const length of [9999, 10000, 10001]) {
      const sample = `"${"x".repeat(length - 1)}\nIf True Then`;
      const result = spans(current, sample);
      expect(result[0]![0]!.type).toBe(length < 10000 ? "string.invalid.basic-plus" : "");
      expect(result[1]![0]!.type).toBe("keyword.control.basic-plus");
    }
    const astral = `"${"😀".repeat(4999)}x`;
    expect(astral.length).toBe(10000);
    expect(spans(current, astral)[0]![0]!.type).toBe("");
  } finally {
    current.dispose();
  }
});

it("removes the handwritten production grammar and registration bridge", async () => {
  const registration = await readFile(
    new URL("./companions/basic-plus/registration.ts", import.meta.url),
    "utf8",
  );
  expect(registration.trim()).toBe('export { basicPlusThemeRules } from "./theme.js";');
});
```

- [ ] **Step 2: Run and expect FAIL at the legacy bridge assertion**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/static-language-migration.test.ts
```

Expected: lexical/range and Basic Plus long-line parity pass with §6.1's resource bytes; the final test fails because production `registration.ts` still contains its old grammar and registration logic. A private Monaco import failure is a test setup problem, not an acceptable red result.

- [ ] **Step 3: Move theme rules and retire the old lexical bridge**

Create `apps/desktop/src/renderer/editor/companions/basic-plus/theme.ts` by moving the complete theme function unchanged:

```ts
import type { editor } from "monaco-editor";

export function basicPlusThemeRules(dark: boolean): editor.ITokenThemeRule[] {
  const color = (darkColor: string, lightColor: string) => (dark ? darkColor : lightColor);
  const rules: editor.ITokenThemeRule[] = [
    { token: "keyword.basic-plus", foreground: color("569CD6", "0000FF") },
    { token: "keyword.control.basic-plus", foreground: color("C586C0", "AF00DB") },
    { token: "constant.language.basic-plus", foreground: color("569CD6", "0000FF") },
    { token: "operator.word.basic-plus", foreground: color("569CD6", "0000FF") },
    { token: "operator.basic-plus", foreground: color("E6EAF0", "1E2933") },
    { token: "delimiter.basic-plus", foreground: color("E6EAF0", "1E2933") },
    { token: "string.basic-plus", foreground: color("CE9178", "A31515") },
    { token: "string.invalid.basic-plus", foreground: color("CE9178", "A31515") },
    { token: "number.basic-plus", foreground: color("B5CEA8", "098658") },
    { token: "comment.basic-plus", foreground: color("6A9955", "008000") },
    { token: "identifier.basic-plus", foreground: color("9CDCFE", "001080") },
    { token: "invalid.basic-plus", foreground: color("F44747", "CD3131") },
  ];
  // Standalone Monaco matches semantic types/modifiers directly against theme rules.
  for (const [type, foreground] of [
    ["type", color("4EC9B0", "267F99")],
    ["namespace", color("4EC9B0", "267F99")],
    ["function", color("DCDCAA", "795E26")],
    ["method", color("DCDCAA", "795E26")],
    ["variable", color("9CDCFE", "001080")],
    ["parameter", color("9CDCFE", "001080")],
    ["label", color("C8C8C8", "000000")],
  ]) {
    rules.push(
      { token: type!, foreground: foreground! },
      { token: `${type}.basic-plus`, foreground: foreground! },
    );
  }
  return rules.map((rule) => ({ ...rule, fontStyle: "" }));
}
```

Replace the entirety of `apps/desktop/src/renderer/editor/companions/basic-plus/registration.ts` with:

```ts
export { basicPlusThemeRules } from "./theme.js";
```

This removes `basicPlusMonarch`, `registerBasicPlusLanguage()`, the `registered` flag, all `monaco.languages` calls, and all frontend/JSON imports from that module. The theme-only re-export has no runtime side effects. T5 removes `editor.tsx:11`, `registerLanguage()` at lines 45–50, and its mount call at line 488 in its own worktree; do not retain a no-op or hidden grammar registration under the old name to accommodate that consumer.

- [ ] **Step 4: Format, run, and expect PASS**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --write apps/desktop/src/renderer/editor/static-language-migration.test.ts apps/desktop/src/renderer/editor/companions/basic-plus/theme.ts apps/desktop/src/renderer/editor/companions/basic-plus/registration.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/static-language-migration.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --check apps/desktop/src/renderer/editor/static-language-migration.test.ts apps/desktop/src/renderer/editor/companions/basic-plus/theme.ts apps/desktop/src/renderer/editor/companions/basic-plus/registration.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec eslint apps/desktop/src/renderer/editor/static-language-migration.test.ts apps/desktop/src/renderer/editor/companions/basic-plus/theme.ts apps/desktop/src/renderer/editor/companions/basic-plus/registration.ts
```

Expected: PASS for all three tests. Classic tokenization runs through real Monaco; the configuration service is local and has a fixed 10,000 limit. This checks the Basic Plus one-state recovery fixture, not T5's actual editor/diff options or all v1 state transitions.

- [ ] **Step 5: Have the controller commit**

```bash
git add apps/desktop/src/renderer/editor/static-language-migration.test.ts apps/desktop/src/renderer/editor/companions/basic-plus/theme.ts apps/desktop/src/renderer/editor/companions/basic-plus/registration.ts
git commit -m "refactor(editor): retire the Basic Plus lexical registration bridge"
```

#### 6.3 Initialize themes independently and remove the companion lexical id

- [ ] **Step 1: Write failing theme and migration-boundary tests**

Create `apps/desktop/src/renderer/editor/editor-theme.test.ts`:

```ts
import { expect, it, vi } from "vitest";
import type { editor } from "monaco-editor";
import { initializeEditorThemes } from "./editor-theme.js";
import { basicPlusThemeRules } from "./companions/basic-plus/theme.js";

const colors = [
  ["keyword.basic-plus", "569CD6", "0000FF"],
  ["keyword.control.basic-plus", "C586C0", "AF00DB"],
  ["constant.language.basic-plus", "569CD6", "0000FF"],
  ["operator.word.basic-plus", "569CD6", "0000FF"],
  ["operator.basic-plus", "E6EAF0", "1E2933"],
  ["delimiter.basic-plus", "E6EAF0", "1E2933"],
  ["string.basic-plus", "CE9178", "A31515"],
  ["string.invalid.basic-plus", "CE9178", "A31515"],
  ["number.basic-plus", "B5CEA8", "098658"],
  ["comment.basic-plus", "6A9955", "008000"],
  ["identifier.basic-plus", "9CDCFE", "001080"],
  ["invalid.basic-plus", "F44747", "CD3131"],
] as const;
const semantic = [
  ["type", "4EC9B0", "267F99"],
  ["namespace", "4EC9B0", "267F99"],
  ["function", "DCDCAA", "795E26"],
  ["method", "DCDCAA", "795E26"],
  ["variable", "9CDCFE", "001080"],
  ["parameter", "9CDCFE", "001080"],
  ["label", "C8C8C8", "000000"],
] as const;

it.each([false, true])("preserves every lexical and semantic theme rule: dark=%s", (dark) => {
  expect(basicPlusThemeRules(dark)).toEqual([
    ...colors.map(([token, night, day]) => ({
      token,
      foreground: dark ? night : day,
      fontStyle: "",
    })),
    ...semantic.flatMap(([token, night, day]) =>
      [token, `${token}.basic-plus`].map((name) => ({
        token: name,
        foreground: dark ? night : day,
        fontStyle: "",
      })),
    ),
  ]);
});

it("initializes both themes with only defineTheme, even when no grammar is available", () => {
  const defineTheme = vi.fn<(name: string, data: editor.IStandaloneThemeData) => void>();
  initializeEditorThemes({ defineTheme });
  expect(defineTheme.mock.calls).toEqual([
    [
      "kobrixa-light",
      {
        base: "vs",
        inherit: true,
        rules: basicPlusThemeRules(false),
        colors: {
          "editor.background": "#fdfaf4",
          "editor.foreground": "#1e2933",
          "editorLineNumber.foreground": "#91958f",
          "editorLineNumber.activeForeground": "#2457d6",
          "editor.lineHighlightBackground": "#f0ede5",
          "editor.selectionBackground": "#cddbf8",
          "editorCursor.foreground": "#2457d6",
          "editorWidget.background": "#fdfaf4",
          "editorWidget.border": "#d7d1c7",
        },
      },
    ],
    [
      "kobrixa-dark",
      {
        base: "vs-dark",
        inherit: true,
        rules: basicPlusThemeRules(true),
        colors: {
          "editor.background": "#18212b",
          "editor.foreground": "#e6eaf0",
          "editorLineNumber.foreground": "#697a8b",
          "editorLineNumber.activeForeground": "#88acff",
          "editor.lineHighlightBackground": "#202c3a",
          "editor.selectionBackground": "#344a72",
          "editorCursor.foreground": "#88acff",
          "editorWidget.background": "#222e3b",
          "editorWidget.border": "#3a4857",
        },
      },
    ],
  ]);
});
```

In `static-language-migration.test.ts`, add `vi` to the Vitest import, add the following imports/mock, and append the tests. The public `monaco-editor` mock is separate from the two private module imports above; actual lexical parity still uses Monaco. Mock functions deliberately throw if the companion or theme attempts to install lexical providers.

```ts
import type { LanguageCompanion } from "./language-companion.js";
import { workspaceSessionSchema } from "../../shared/workspace-session.js";
import { Documents } from "./documents.js";
import { initializeEditorThemes } from "./editor-theme.js";
import { basicPlusCompanion } from "./companions/basic-plus/companion.js";
import { formatBasicPlus } from "@kobrixa/basic-plus/language";
import { basicPlusCompletions } from "./companions/basic-plus/completions.js";
import { basicPlusSignatureHelp } from "./companions/basic-plus/signatures.js";
import { basicPlusRangeFormattingEdits } from "./companions/basic-plus/formatting.js";
import { legend, structuralChange } from "./companions/basic-plus/structure.js";

const lexicalCalls = vi.hoisted(() => ({
  register: vi.fn(() => {
    throw new Error("T6 must not register a language.");
  }),
  setMonarchTokensProvider: vi.fn(() => {
    throw new Error("T6 must not install a tokenizer.");
  }),
  setLanguageConfiguration: vi.fn(() => {
    throw new Error("T6 must not install configuration.");
  }),
}));
vi.mock("monaco-editor", () => ({ languages: lexicalCalls }));

it("leaves the companion's dynamic behavior intact without a lexical id", () => {
  const dynamic: Omit<LanguageCompanion, "monacoLanguage"> = basicPlusCompanion;
  expect(dynamic).not.toHaveProperty("monacoLanguage");
  expect(dynamic.legend).toBe(legend);
  expect(dynamic.completions).toBe(basicPlusCompletions);
  expect(dynamic.signatureHelp).toBe(basicPlusSignatureHelp);
  expect(dynamic.structuralChange).toBe(structuralChange);
  expect(dynamic.rangeFormatting).toBe(basicPlusRangeFormattingEdits);
  expect(dynamic.triggerCharacters).toEqual([".", "@"]);
  expect(dynamic.signatureTriggers).toEqual(["(", ","]);
  expect(dynamic.signatureRetriggers).toEqual([")"]);
  for (const size of [2, 4] as const) {
    const source = "If True Then\nLCD.Clear()\nEndIf\n";
    expect(dynamic.formatSource(source, size)).toBe(formatBasicPlus(source, { indentSize: size }));
  }
});

it("restores renamed drafts across failed generations without registering a shell twice", async () => {
  // Boundary test: the persisted session is real; failed generations are supplied
  // by a contract-level caller. Registrar/model reconciliation belongs to T4/T5.
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const location = { line: 2, column: 3, endLine: 2, endColumn: 6, scrollTop: 12, scrollLeft: 0 };
  const restored = workspaceSessionSchema.parse({
    projects: [
      {
        workspaceId,
        files: ["renamed.bpi"],
        activeFile: "renamed.bpi",
        selectedTreePath: "renamed.bpi",
        expandedTreePaths: [""],
        locations: { "renamed.bpi": location },
        monacoLanguage: "basic-plus",
      },
    ],
    activeWorkspaceId: workspaceId,
  });
  expect(restored.projects[0]).not.toHaveProperty("monacoLanguage");
  expect(restored.projects[0]!.locations["renamed.bpi"]).toEqual(location);
  const documents = new Documents();
  const draft = "If True Then\n  LCD.Clear()\nEndIf\n";
  documents.replace([{ file: "renamed.bpi", content: draft, saved: "LCD.Clear()\n" }]);
  const tab = documents.getSnapshot()[0]!;
  expect(tab.dirty).toBe(true);
  const defineTheme = vi.fn();
  for (const generation of [1, 2, 3, 4]) {
    // T6 initialization has no dependency on generation/catalog success. A caller
    // may replay it after failed loads; it must never allocate another id shell.
    initializeEditorThemes({ defineTheme });
    expect(documents.getSnapshot()[0], `generation ${generation}`).toBe(tab);
    expect(tab.content).toBe(draft);
    expect(tab.file).toBe(restored.projects[0]!.activeFile);
  }
  expect(defineTheme).toHaveBeenCalledTimes(8);
  expect(basicPlusCompanion).not.toHaveProperty("monacoLanguage");
  const manifest = JSON.parse(
    await readFile(new URL("plugins/basic-plus/kobrixa-plugin.json", repository), "utf8"),
  );
  expect(manifest.contributes.languages[0].id).toBe("bp");
  expect(manifest.contributes.languages[0].extensions).toContain("bpi");
  for (const call of Object.values(lexicalCalls)) expect(call).not.toHaveBeenCalled();
});
```

RF5's local assertion is deliberately limited to T6: old persisted lexical metadata is not authoritative, drafts remain intact, theme replay works, and T6 never registers a shell. It does not simulate undo or assert that a fake registrar implements lifecycle correctly. The real failed-generation/rename/restore/single-shell test, using T4's registrar and T5's restore path, is mandatory at T8.

- [ ] **Step 2: Run and expect FAIL**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/editor-theme.test.ts src/renderer/editor/static-language-migration.test.ts
```

Expected: FAIL because T0's `initializeEditorThemes()` does nothing and `basicPlusCompanion` still owns `monacoLanguage: "basic-plus"`. The resource parity tests from §6.2 continue to pass.

- [ ] **Step 3: Implement the frozen theme initializer and remove the companion field**

Replace T0's `apps/desktop/src/renderer/editor/editor-theme.ts` with:

```ts
import type { editor } from "monaco-editor";
import { basicPlusThemeRules } from "./companions/basic-plus/theme.js";

export interface EditorThemeApi {
  defineTheme(name: string, data: editor.IStandaloneThemeData): void;
}

export function initializeEditorThemes(api: EditorThemeApi): void {
  for (const theme of ["light", "dark"] as const) {
    const dark = theme === "dark";
    api.defineTheme(`kobrixa-${theme}`, {
      base: dark ? "vs-dark" : "vs",
      inherit: true,
      rules: basicPlusThemeRules(dark),
      colors: {
        "editor.background": dark ? "#18212b" : "#fdfaf4",
        "editor.foreground": dark ? "#e6eaf0" : "#1e2933",
        "editorLineNumber.foreground": dark ? "#697a8b" : "#91958f",
        "editorLineNumber.activeForeground": dark ? "#88acff" : "#2457d6",
        "editor.lineHighlightBackground": dark ? "#202c3a" : "#f0ede5",
        "editor.selectionBackground": dark ? "#344a72" : "#cddbf8",
        "editorCursor.foreground": dark ? "#88acff" : "#2457d6",
        "editorWidget.background": dark ? "#222e3b" : "#fdfaf4",
        "editorWidget.border": dark ? "#3a4857" : "#d7d1c7",
      },
    });
  }
}
```

Replace `apps/desktop/src/renderer/editor/companions/basic-plus/companion.ts` with:

```ts
import { formatBasicPlus } from "@kobrixa/basic-plus/language";
import type { LanguageCompanion } from "../../language-companion.js";
import { basicPlusSignatureHelp } from "./signatures.js";
import { basicPlusCompletions } from "./completions.js";
import { basicPlusRangeFormattingEdits } from "./formatting.js";
import { legend, structuralChange } from "./structure.js";
export { legend, structuralChange } from "./structure.js";

// Compiles locally against both T0's old interface and T5's field-free interface.
// No lexical field or cast is added to the runtime companion object.
type BasicPlusDynamicCompanion = Omit<LanguageCompanion, "monacoLanguage">;
export const basicPlusCompanion: BasicPlusDynamicCompanion = {
  legend,
  triggerCharacters: [".", "@"],
  signatureTriggers: ["(", ","],
  signatureRetriggers: [")"],
  completions: basicPlusCompletions,
  signatureHelp: basicPlusSignatureHelp,
  structuralChange,
  formatSource: (source, indentSize) => formatBasicPlus(source, { indentSize }),
  rangeFormatting: basicPlusRangeFormattingEdits,
};
```

The local type is not a new cross-task interface. After T5 removes `LanguageCompanion.monacoLanguage`, it has exactly the same shape as `LanguageCompanion`; no runtime fallback id remains. Do not change the builtin composition key `kobrixa.basic-plus:bp`, dynamic algorithms, diagnostic source, help links, or frontend indentation exports.

- [ ] **Step 4: Format and run the complete branch-local gate; expect PASS**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --write apps/desktop/src/renderer/editor/editor-theme.ts apps/desktop/src/renderer/editor/editor-theme.test.ts apps/desktop/src/renderer/editor/companions/basic-plus/companion.ts apps/desktop/src/renderer/editor/static-language-migration.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol build && pnpm --filter @kobrixa/plugin-runtime build && pnpm --filter @kobrixa/ir build && pnpm --filter @kobrixa/compiler build && pnpm --filter @kobrixa/basic-plus build && pnpm --filter @kobrixa/backend-ev3 build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/builtin.test.ts src/renderer/editor/static-language-migration.test.ts src/renderer/editor/editor-theme.test.ts src/renderer/editor/language-imports.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --check plugins/basic-plus/kobrixa-plugin.json plugins/basic-plus/language/tokenizer.json plugins/basic-plus/language/configuration.json apps/desktop/src/main/plugins/builtin.ts apps/desktop/src/main/plugins/builtin.test.ts apps/desktop/src/renderer/editor/companions/basic-plus/registration.ts apps/desktop/src/renderer/editor/companions/basic-plus/companion.ts apps/desktop/src/renderer/editor/companions/basic-plus/theme.ts apps/desktop/src/renderer/editor/editor-theme.ts apps/desktop/src/renderer/editor/editor-theme.test.ts apps/desktop/src/renderer/editor/static-language-migration.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec eslint apps/desktop/src/main/plugins/builtin.ts apps/desktop/src/main/plugins/builtin.test.ts apps/desktop/src/renderer/editor/companions/basic-plus/registration.ts apps/desktop/src/renderer/editor/companions/basic-plus/companion.ts apps/desktop/src/renderer/editor/companions/basic-plus/theme.ts apps/desktop/src/renderer/editor/editor-theme.ts apps/desktop/src/renderer/editor/editor-theme.test.ts apps/desktop/src/renderer/editor/static-language-migration.test.ts
git diff --check
git diff --name-only
```

Expected: PASS for the selected tests, package builds, Prettier, ESLint, and whitespace check. Confirm every changed path appears in Files. The final selected tests do not import `editor.tsx` or `builtin-language-companions.ts`; both remain T5 consumers of the removed contract on the T0 branch. Do not claim `pnpm --filter @kobrixa/desktop check`, the complete desktop suite, or application startup passes in this intermediate worktree. The plan's complete desktop/typecheck/packaging gates run after T5 merges at T8.

- [ ] **Step 5: Have the controller commit**

```bash
git add apps/desktop/src/renderer/editor/editor-theme.ts apps/desktop/src/renderer/editor/editor-theme.test.ts apps/desktop/src/renderer/editor/companions/basic-plus/companion.ts apps/desktop/src/renderer/editor/static-language-migration.test.ts
git commit -m "refactor(editor): initialize themes independently of static languages"
```

**Deferred to T8**

- Validate the two shipped raw resources with real `validateStaticLanguageResources()`: supply `languageId: "bp"`, format/limits versions `1`, parsed original resources, `Buffer.byteLength(raw, "utf8")` counts, and the exact manifest-relative paths. Require success with `rules: 9`, `regexes: 11`, and `expandedRules: 9`. Run T1 schemas/conformance and T2's same-reader builtin/development validation, BOM/limit handling, required-builtin and safe-mode checks; mock/fixture parity is not that evidence.
- Repeat §6.2's legacy spans against real T4 `adaptStaticLanguage(language: ValidatedStaticLanguage)` using the host-produced DTO. Check actual Monaco configuration/autoclosing/indentation and actual editor/diff `maxTokenizationLineLength: 10000`; retain T7 highlighting/indentation smoke for visual light/dark and semantic colors.
- Run RF5 with the real T4 registrar and T5 restoration path: restore an old renamed draft by current file/catalog into `bp`, repeat failed reload generations, recover, preserve undo/selection/view state, and register the same id once. Cover unknown/JSON files, hidden/review/diff models, and 256/257 ids in the owning T4/T5/T7 suites; the local boundary test above does not prove those behaviors.
- After T5 removes all old editor registration imports/flags and the shared companion field/readers, run `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop check` and the complete integration gates from part0. Scan for product `basicPlusMonarch`, `registerBasicPlusLanguage`, companion lexical reads, renderer JSON imports, and obsolete extension inference. T8 may remove the harmless local `Omit` type after the ownership hand-off.
- Verify packaged main contains raw resources and Basic Plus works without the repository `plugins/` directory or resource HTTP fetch; run actual packaged/recovery smoke, completion/formatting/worker regressions, and bytecode checks. Record platform/environment skips as unrun acceptance.

**Contract gaps**

- T0 preserves required `LanguageCompanion.monacoLanguage` and `editor.tsx`'s `registerBasicPlusLanguage` import while T6 must remove both provider exports and T5 must remove their consumers. T6 defines the local `BasicPlusDynamicCompanion = Omit<LanguageCompanion, "monacoLanguage">` inside its owned `companion.ts`; no cast or fake runtime field hides the migration. This makes owned-module tests usable on T0, but the complete T0 desktop typecheck remains incompatible at the stale composition table and editor import until T5 merges. T8 must verify those two removals; T6 must not modify their files. No public signature or fixture name is missing or renamed.
### Task 7: Static-language acceptance harnesses, recovery fixtures, and author documentation

**Files:**

- Create: `tests/desktop/fixtures/static-languages/cases.json`
- Create: `tests/desktop/static-languages-fixtures.mjs`
- Create: `tests/desktop/static-languages-harness.mjs`
- Create: `tests/desktop/static-languages-contract.test.mjs`
- Create: `tests/desktop/static-languages-acceptance.mjs`
- Create: `tests/desktop/static-languages-acceptance.test.mjs`
- Create: `tests/desktop/static-languages-main.ts`
- Create: `tests/desktop/static-languages-run.mjs`
- Create: `tests/desktop/static-languages-packaged.mjs`
- Create: `tests/desktop/static-languages-docs.test.mjs`
- Modify: `tests/desktop/preload.cjs:13-15,50-99` (`windowChrome`, plugin snapshot and subscriptions)
- Modify: `tests/desktop/smoke-harness.test.mjs:9-31,34-42,102-122` (`loadPreload`, catalog test, API comparison)
- Modify: `tests/desktop/smoke-main.mjs:24-25,216-217` (imports and separate plugin IPC handlers)
- Modify: `tests/desktop/highlighting-smoke.mjs:50-53` (Monaco language id only)
- Modify: `tests/desktop/indentation-smoke.mjs:8,36` (Monaco language id only)
- Modify: `tests/desktop/packaged-smoke.mjs:1-24,52-62,146-147,165-166,246-251` (isolated installed copy, launch hook, acceptance call, cleanup)
- Create: `docs/en/plugin-static-languages.md`
- Create: `docs/zh-TW/plugin-static-languages.md`
- Modify: `docs/en/language-support.md:5-9` and `docs/zh-TW/language-support.md:5-9` (lexical support versus compiler support)
- Modify: `docs/en/architecture.md:108,135,152,162` and `docs/zh-TW/architecture.md:108,135,152,162` (API 1.4, static lifecycle, recovery)

Line numbers refer to the inspected pre-T0 baseline; use the named anchors after T0. This is the complete chosen write set, contained in §11.1's T7 ownership. Do not edit `run-smoke.mjs`, product modules, package scripts, CI, the spec, T0 fixtures, or other tasks' tests. T8 owns root command/CI wiring. `language-features-smoke.mjs` and `completion-performance-smoke.mjs` need no source changes: the existing desktop runner already executes them, and their thresholds remain unchanged.

**Interfaces:**

- Consumes: T0 `PluginsApi.staticLanguages(): Promise<StaticLanguagesCatalog>` on `plugins:static-languages`; `PluginsApi.reportLanguageRegistrationFailure(input: ReportLanguageRegistrationFailureInput): Promise<ReportLanguageRegistrationFailureResult>` on `plugins:report-language-registration-failure`; `state(): Promise<PluginsView>` and `onEvent(listener: (event: PluginEvent) => void): () => void`. A state event is `{ type: "state", state: PluginsView }`; its `staticLanguagesRevision` and complete `staticLanguageOwners` match the catalog revision. Reports use the frozen ownership fields, five reasons, and 2,048-code-point detail limit.
- Consumes: T0 `StaticLanguagesCatalog`, `ValidatedStaticLanguage`, `StaticLanguageOwner`, `StaticLanguageConflict`, and `LanguageBinding` without redefining their product types. `formatVersion` and `limitsVersion` are both `1`. Use the runtime's existing `developmentSourceKey(directory): string` on a real temporary directory; no fixture supplies a trusted identity.
- Consumes: existing `startPlugins(options: StartPluginsOptions): Promise<PluginController>`, `registerPluginIpc(handle: IpcHandle, plugins: PluginIpcTarget, publish: (event: PluginEvent) => void): () => void`, `installPluginQuitCleanup`, `SessionMarkerFile.markThirdPartyStaticContributions(): void`, and `waitForSmokeExit(child, phase)` from `plugins-smoke-process.mjs`. Call catalog/report through registered handlers, rather than inventing an unfrozen controller method.
- Consumes, read-only: all seven T0 resources under `packages/plugin-protocol/test-fixtures/static-languages/`: `minimal/{tokenizer,configuration}.json`, `basic-plus/{tokenizer,configuration}.json`, and `toy/{kobrixa-plugin.json,language/tokenizer.json,language/configuration.json}`. The `toy` manifest remains `acme.toy`, language/extension `toy`, runtime `{kind:"static"}`, API `^1.4.0`.
- Produces, test-only: `readStaticLanguageFixtures(): Promise<{toyManifest, toyTokenizer, toyConfiguration, basicPlusTokenizer, basicPlusConfiguration, builtin, binding}>`, retaining resource texts; `writeStaticLanguageFixtures(directory: string): Promise<Record<string,string>>`; `basicPlusSmokeCatalog(): Promise<StaticLanguagesCatalog>`; `createStaticLanguagesHarness(catalog: StaticLanguagesCatalog)` returning `state`, `staticLanguages`, and `reportLanguageRegistrationFailure` mock methods.
- Produces, test-only: `checkStaticLanguageLifecycle(api, pluginId: string, languageId: string): Promise<void>`; `checkPackagedStaticLanguages({js, send, until, profile, sourceKey}): Promise<void>`; executable `static-languages-run.mjs` for real runtime/controller/recovery acceptance. These are T7-owned test adapters, not new public product APIs.

Run from the T0 commit in T7's worktree. The **branch gate** executes Node harness/fixture/assertion tests and source syntax/lint checks only. It never calls the T0 validator stub or requires implemented registration, catalog construction, or controller delivery. The **T8 gate** executes the same acceptance assertions through real implementation, Electron, production preload/UI, and packaged resources. Passing mocks is not an acceptance result.

#### 7.1 Freeze smoke fixtures, add catalog-shaped mocks, and fix N1

- [ ] **Step 1: Write failing fixture and preload-contract tests**

Create `tests/desktop/static-languages-contract.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { developmentSourceKey } from "../../packages/plugin-runtime/dist/index.js";
import {
  readStaticLanguageFixtures,
  writeStaticLanguageFixtures,
} from "./static-languages-fixtures.mjs";
import {
  basicPlusSmokeCatalog,
  createStaticLanguagesHarness,
} from "./static-languages-harness.mjs";

test("copies T0 toy bytes and constructs distinct conflict and invalid-resource fixtures", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kobrixa-static-contract-"));
  try {
    const paths = await writeStaticLanguageFixtures(directory);
    const fixtures = await readStaticLanguageFixtures();
    const read = (name, relative) => readFile(path.join(paths[name], relative), "utf8");
    assert.equal(await read("toy", "language/tokenizer.json"), fixtures.toyTokenizer);
    assert.equal(await read("toy", "language/configuration.json"), fixtures.toyConfiguration);
    assert.deepEqual(JSON.parse(await read("toy", "kobrixa-plugin.json")), fixtures.toyManifest);
    const declaration = async (name) =>
      JSON.parse(await read(name, "kobrixa-plugin.json")).contributes.languages[0];
    assert.equal((await declaration("shared")).id, "toy-other");
    assert.deepEqual((await declaration("shared")).extensions, ["toy", "other"]);
    assert.equal((await declaration("duplicate")).id, "toy");
    assert.equal((await declaration("invalid")).id, "toy-invalid");
    const bad = JSON.parse(await read("invalid", "language/tokenizer.json"));
    assert.equal(Object.hasOwn(bad.states[0].rules[0].regex, "flags"), false);
    const hostile = JSON.parse(await read("hostile", "language/tokenizer.json"));
    assert.equal(hostile.states[0].rules[0].regex.pattern, "(a+)+$");
    // Do not compile or execute the hostile regex in this process.
    for (const name of ["toy", "shared", "duplicate", "invalid", "hostile"]) {
      const manifest = JSON.parse(await read(name, "kobrixa-plugin.json"));
      assert.deepEqual(manifest.runtime, { kind: "static" });
      assert.equal(Object.hasOwn(manifest, "sourceKey"), false);
      assert.match(developmentSourceKey(await realpath(paths[name])), /^dev:/);
    }
    assert.notEqual(
      developmentSourceKey(await realpath(paths.toy)),
      developmentSourceKey(await realpath(paths.duplicate)),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("test builtin has an owned frontend/service and a complete same-owner binding", async () => {
  const { builtin, binding } = await readStaticLanguageFixtures();
  assert.equal(builtin.kind, "builtin");
  assert.equal(builtin.manifest.id, binding.pluginId);
  assert.equal(binding.sourceKey, `builtin:${binding.pluginId}`);
  assert.deepEqual(builtin.manifest.contributes.frontends, [binding.frontend]);
  assert.deepEqual(builtin.manifest.contributes.languageServices, [
    {
      language: binding.language,
      extensions: binding.extensions,
      capabilities: binding.capabilities,
    },
  ]);
  assert.deepEqual(builtin.manifest.contributes.languages[0].extensions, binding.extensions);
  assert.deepEqual(Object.keys(builtin.resources).sort(), [
    "language/configuration.json",
    "language/tokenizer.json",
  ]);
});

test("smoke snapshot includes full owner identity, original byte sizes, and defensive clones", async () => {
  const catalog = await basicPlusSmokeCatalog();
  const harness = createStaticLanguagesHarness(catalog);
  const state = harness.state();
  assert.equal(state.staticLanguagesRevision, catalog.revision);
  assert.deepEqual(state.staticLanguageOwners, [
    {
      sourceKey: "builtin:kobrixa.basic-plus",
      pluginId: "kobrixa.basic-plus",
      generation: 1,
      languageId: "bp",
      extensions: ["bp", "bpi", "bpm"],
    },
  ]);
  const { basicPlusTokenizer, basicPlusConfiguration } = await readStaticLanguageFixtures();
  assert.deepEqual(catalog.languages[0].resourceBytes, {
    tokenizer: Buffer.byteLength(basicPlusTokenizer),
    configuration: Buffer.byteLength(basicPlusConfiguration),
  });
  assert.equal(catalog.languages[0].expandedRules, 9);
  state.staticLanguageOwners[0].extensions.length = 0;
  harness.staticLanguages().languages.length = 0;
  assert.equal(harness.staticLanguages().languages.length, 1);
  assert.equal(harness.state().staticLanguageOwners[0].extensions.length, 3);
});
```

In `smoke-harness.test.mjs`, add this import:

```js
import {
  basicPlusSmokeCatalog,
  createStaticLanguagesHarness,
} from "./static-languages-harness.mjs";
```

Immediately after `const preload = ...`, add `const staticHarness = createStaticLanguagesHarness(await basicPlusSmokeCatalog());`. Change `loadPreload(source = preload)` to `loadPreload(source = preload, platform = "win32")`, replace `process: { platform: "win32" }` with `process: { platform }`, and replace the `ipcRenderer.invoke` implementation with:

```js
ipcRenderer.invoke = async (...args) => {
  calls.push(args);
  if (args[0] === "plugins:state") return staticHarness.state();
  if (args[0] === "plugins:static-languages") return staticHarness.staticLanguages();
  if (args[0] === "plugins:report-language-registration-failure")
    return staticHarness.reportLanguageRegistrationFailure(args[1]);
  return reply;
};
```

Append these tests; keep existing language forwarding/unsubscribe tests:

```js
for (const platform of ["win32", "darwin", "linux"]) {
  test(`N1 exposes windowChrome only on Windows (${platform})`, () => {
    const { api } = loadPreload(preload, platform);
    assert.equal(Object.hasOwn(api, "windowChrome"), platform === "win32");
  });
}

test("smoke preload forwards the frozen static-language IPC and disposes event listeners", async () => {
  const { api, calls, ipcRenderer } = loadPreload();
  const state = await api.plugins.state();
  const catalog = await api.plugins.staticLanguages();
  assert.equal(catalog.formatVersion, 1);
  assert.equal(catalog.limitsVersion, 1);
  assert.equal(catalog.revision, state.staticLanguagesRevision);
  assert.equal(state.staticLanguageOwners[0].languageId, "bp");
  assert.deepEqual(structuredClone(calls.slice(-2)), [
    ["plugins:state"],
    ["plugins:static-languages"],
  ]);
  const report = {
    sourceKey: "builtin:kobrixa.basic-plus",
    generation: 1,
    languageId: "bp",
    revision: catalog.revision,
    reason: "monaco",
    detail: "smoke report",
  };
  assert.deepEqual(await api.plugins.reportLanguageRegistrationFailure(report), {
    accepted: false,
    revision: catalog.revision,
  });
  assert.deepEqual(structuredClone(calls.at(-1)), [
    "plugins:report-language-registration-failure",
    report,
  ]);
  const received = [];
  const off = api.plugins.onEvent((event) => received.push(event));
  const event = { type: "state", state };
  ipcRenderer.emit("plugins:event", {}, event);
  off();
  ipcRenderer.emit("plugins:event", {}, event);
  assert.deepEqual(received, [event]);
  assert.equal(ipcRenderer.listenerCount("plugins:event"), 0);
});
```

In the existing real-preload API-tree test, replace its `const real`/`const smoke` declarations and immediate `assertApiKeys` call with:

```js
for (const platform of ["win32", "darwin", "linux"]) {
  const real = loadPreload(compiled, platform).api;
  const smoke = loadPreload(preload, platform).api;
  assertApiKeys(smoke, real);
  assert.equal(Object.hasOwn(smoke, "windowChrome"), Object.hasOwn(real, "windowChrome"));
}
const real = loadPreload(compiled).api;
const smoke = loadPreload().api;
```

Keep the deliberate deletion assertions below that replacement.

- [ ] **Step 2: Run and confirm failure**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false
pnpm --filter @kobrixa/plugin-protocol build
pnpm --filter @kobrixa/plugin-runtime build
pnpm exec node --test tests/desktop/static-languages-contract.test.mjs tests/desktop/smoke-harness.test.mjs
```

Expected: FAIL because the new fixture/harness modules do not exist. Once they exist, the N1 and static IPC tests still fail until the preload changes land. These builds use T0's compilable stubs, not T1/T2 implementations.

- [ ] **Step 3: Implement fixtures and isolated smoke replies**

Create `tests/desktop/fixtures/static-languages/cases.json`:

```json
[
  { "name": "toy", "pluginId": "acme.toy", "languageId": "toy", "extensions": ["toy"] },
  {
    "name": "shared",
    "pluginId": "acme.other",
    "languageId": "toy-other",
    "extensions": ["toy", "other"]
  },
  {
    "name": "duplicate",
    "pluginId": "acme.duplicate",
    "languageId": "toy",
    "extensions": ["duplicate"]
  },
  {
    "name": "invalid",
    "pluginId": "acme.invalid",
    "languageId": "toy-invalid",
    "extensions": ["invalid"]
  },
  {
    "name": "hostile",
    "pluginId": "acme.hostile",
    "languageId": "toy-hostile",
    "extensions": ["hostile"]
  }
]
```

Create `tests/desktop/static-languages-fixtures.mjs`:

```js
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const shared = new URL(
  "../../packages/plugin-protocol/test-fixtures/static-languages/",
  import.meta.url,
);
const read = (relative) => readFile(new URL(relative, shared), "utf8");

export async function readStaticLanguageFixtures() {
  const [manifest, toyTokenizer, toyConfiguration, basicPlusTokenizer, basicPlusConfiguration] =
    await Promise.all([
      read("toy/kobrixa-plugin.json"),
      read("toy/language/tokenizer.json"),
      read("toy/language/configuration.json"),
      read("basic-plus/tokenizer.json"),
      read("basic-plus/configuration.json"),
    ]);
  const toyManifest = JSON.parse(manifest);
  const frontend = {
    language: "fixture-owner",
    entryExtensions: ["toy"],
    sourceExtensions: ["toy"],
    ir: { min: 1, max: 1 },
  };
  const binding = {
    epoch: 1,
    pluginId: "kobrixa-smoke.owner",
    sourceKey: "builtin:kobrixa-smoke.owner",
    language: "fixture-owner",
    extensions: ["toy"],
    capabilities: ["analysis"],
    frontend,
  };
  const declaration = structuredClone(toyManifest.contributes.languages[0]);
  declaration.id = binding.language;
  declaration.aliases = ["Fixture owner"];
  const builtin = {
    kind: "builtin",
    manifest: {
      id: binding.pluginId,
      version: "1.0.0",
      apiVersion: "^1.4.0",
      runtime: { kind: "builtin" },
      contributes: {
        frontends: [frontend],
        languageServices: [
          { language: binding.language, extensions: ["toy"], capabilities: ["analysis"] },
        ],
        languages: [declaration],
      },
    },
    resources: {
      "language/tokenizer.json": toyTokenizer,
      "language/configuration.json": toyConfiguration,
    },
  };
  return {
    toyManifest,
    toyTokenizer,
    toyConfiguration,
    basicPlusTokenizer,
    basicPlusConfiguration,
    builtin,
    binding,
  };
}

export async function writeStaticLanguageFixtures(directory) {
  const cases = JSON.parse(
    await readFile(new URL("./fixtures/static-languages/cases.json", import.meta.url), "utf8"),
  );
  const { toyManifest, toyTokenizer } = await readStaticLanguageFixtures();
  await mkdir(directory, { recursive: true });
  const paths = {};
  for (const item of cases) {
    const destination = path.join(directory, item.name);
    await cp(fileURLToPath(new URL("toy/", shared)), destination, { recursive: true });
    paths[item.name] = destination;
    if (item.name === "toy") continue;
    const manifest = structuredClone(toyManifest);
    manifest.id = item.pluginId;
    manifest.contributes.languages[0].id = item.languageId;
    manifest.contributes.languages[0].extensions = item.extensions;
    await writeFile(
      path.join(destination, "kobrixa-plugin.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    if (item.name === "invalid" || item.name === "hostile") {
      const tokenizer = JSON.parse(toyTokenizer);
      if (item.name === "invalid") delete tokenizer.states[0].rules[0].regex.flags;
      else tokenizer.states[0].rules[0].regex.pattern = "(a+)+$";
      await writeFile(
        path.join(destination, "language/tokenizer.json"),
        JSON.stringify(tokenizer, null, 2) + "\n",
      );
    }
  }
  return paths;
}
```

The hostile fixture is data only. Loading it must not run document regexes. Any later actual ReDoS/tokenization experiment must run in a separate Electron process with a parent-enforced kill deadline; never call `.test()` on it in a Node test or a Vitest worker.

Create `tests/desktop/static-languages-harness.mjs`:

```js
import { createHash } from "node:crypto";
import { readStaticLanguageFixtures } from "./static-languages-fixtures.mjs";

export async function basicPlusSmokeCatalog() {
  const { basicPlusTokenizer, basicPlusConfiguration } = await readStaticLanguageFixtures();
  return {
    formatVersion: 1,
    limitsVersion: 1,
    revision: 1,
    languages: [
      {
        sourceKey: "builtin:kobrixa.basic-plus",
        pluginId: "kobrixa.basic-plus",
        generation: 1,
        id: "bp",
        extensions: ["bp", "bpi", "bpm"],
        aliases: ["Basic Plus", "Basic+"],
        resourceDigest: createHash("sha256")
          .update(basicPlusTokenizer)
          .update("\0")
          .update(basicPlusConfiguration)
          .digest("hex"),
        tokenizer: JSON.parse(basicPlusTokenizer),
        configuration: JSON.parse(basicPlusConfiguration),
        resourceBytes: {
          tokenizer: Buffer.byteLength(basicPlusTokenizer),
          configuration: Buffer.byteLength(basicPlusConfiguration),
        },
        expandedRules: 9,
      },
    ],
    extensionRoutes: { bp: "bp", bpi: "bp", bpm: "bp" },
    conflicts: [],
  };
}

export function createStaticLanguagesHarness(catalog) {
  const value = structuredClone(catalog);
  return {
    state: () => ({
      revision: 0,
      diagnosticHelpRevision: 0,
      staticLanguagesRevision: value.revision,
      staticLanguageOwners: value.languages.map((language) => ({
        sourceKey: language.sourceKey,
        pluginId: language.pluginId,
        generation: language.generation,
        languageId: language.id,
        extensions: [...language.extensions],
      })),
      safeMode: false,
      developmentMode: false,
      plugins: [],
      developer: { enabled: false, commandLine: false, linkedCount: 0 },
      origins: {},
      python: { pendingReload: [] },
      inflight: [],
    }),
    staticLanguages: () => structuredClone(value),
    reportLanguageRegistrationFailure: () => ({ accepted: false, revision: value.revision }),
  };
}
```

This catalog is explicitly a test reply built from T0 raw fixtures; its digest is an opaque mock identity. It does not validate a plugin or establish real resource-loader/packaging acceptance.

Apply these replacements in `preload.cjs`, preserving all unrelated API methods:

```diff
-  windowChrome: { setAppearance: async () => {} },
+  ...(process.platform === "win32"
+    ? { windowChrome: { setAppearance: async () => {} } }
+    : {}),
```

Replace the whole existing `state: async () => ({ ... }),` property in `plugins` with these properties:

```js
    state: () => ipcRenderer.invoke("plugins:state"),
    staticLanguages: () => ipcRenderer.invoke("plugins:static-languages"),
    reportLanguageRegistrationFailure: (input) =>
      ipcRenderer.invoke("plugins:report-language-registration-failure", input),
```

Replace only `plugins.onEvent: () => () => {}` with:

```js
    onEvent: (listener) => {
      const receive = (_event, event) => listener(event);
      ipcRenderer.on("plugins:event", receive);
      return () => ipcRenderer.removeListener("plugins:event", receive);
    },
```

In `smoke-main.mjs`, after the `checkWorkbenchFeatures` import add:

```js
import {
  basicPlusSmokeCatalog,
  createStaticLanguagesHarness,
} from "./static-languages-harness.mjs";
```

Immediately before the existing `ipcMain.handle("smoke", ...)` registration add:

```js
const staticHarness = createStaticLanguagesHarness(await basicPlusSmokeCatalog());
ipcMain.handle("plugins:state", () => staticHarness.state());
ipcMain.handle("plugins:static-languages", () => staticHarness.staticLanguages());
ipcMain.handle("plugins:report-language-registration-failure", (_event, input) =>
  staticHarness.reportLanguageRegistrationFailure(input),
);
```

- [ ] **Step 4: Verify branch-local behavior**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false
pnpm exec node --test tests/desktop/static-languages-contract.test.mjs tests/desktop/smoke-harness.test.mjs
pnpm exec prettier --write tests/desktop/fixtures/static-languages/cases.json tests/desktop/static-languages-fixtures.mjs tests/desktop/static-languages-harness.mjs tests/desktop/static-languages-contract.test.mjs tests/desktop/preload.cjs tests/desktop/smoke-main.mjs tests/desktop/smoke-harness.test.mjs
pnpm exec eslint tests/desktop/static-languages-fixtures.mjs tests/desktop/static-languages-harness.mjs tests/desktop/static-languages-contract.test.mjs tests/desktop/preload.cjs tests/desktop/smoke-main.mjs tests/desktop/smoke-harness.test.mjs
```

Expected: PASS against T0 alone, including Windows, macOS and Linux VM branches. The existing diagnostic-help revision stays `0`; static revision is independently `1`.

- [ ] **Step 5: Controller commits subsection 7.1**

```bash
git add tests/desktop/fixtures/static-languages/cases.json tests/desktop/static-languages-fixtures.mjs tests/desktop/static-languages-harness.mjs tests/desktop/static-languages-contract.test.mjs tests/desktop/preload.cjs tests/desktop/smoke-main.mjs tests/desktop/smoke-harness.test.mjs
git commit -m "test(desktop): freeze static language smoke contracts and platform guard"
```

#### 7.2 Add executable lifecycle, ownership, and recovery acceptance with a mock-only branch gate

- [ ] **Step 1: Write failing tests for the acceptance assertions**

Create `tests/desktop/static-languages-acceptance.test.mjs`. This mock models the expected replies to test the assertion helper itself; it is not a runtime implementation test.

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";
import { checkStaticLanguageLifecycle } from "./static-languages-acceptance.mjs";

function apiFixture({ running = false, revoke = true } = {}) {
  let enabled = true,
    quarantined = false,
    revision = 1,
    generation = 1;
  const calls = [];
  const owner = { sourceKey: "dev:0123456789abcdef", pluginId: "acme.toy", languageId: "toy" };
  const api = {
    async state() {
      return {
        revision,
        diagnosticHelpRevision: 0,
        staticLanguagesRevision: revision,
        staticLanguageOwners:
          enabled && !quarantined ? [{ ...owner, generation, extensions: ["toy"] }] : [],
        safeMode: false,
        developmentMode: true,
        developer: { enabled: true, commandLine: false, linkedCount: 1 },
        origins: { [owner.sourceKey]: "linked" },
        python: { pendingReload: [] },
        inflight: [],
        plugins: [
          {
            id: owner.pluginId,
            sourceKey: owner.sourceKey,
            source: "development",
            runtime: "static",
            running,
            status: enabled ? "enabled" : "disabled",
            commands: [],
            problems: [],
          },
        ],
      };
    },
    async staticLanguages() {
      return {
        formatVersion: 1,
        limitsVersion: 1,
        revision,
        languages:
          (enabled || !revoke) && !quarantined
            ? [
                {
                  sourceKey: owner.sourceKey,
                  pluginId: owner.pluginId,
                  generation,
                  id: "toy",
                  extensions: ["toy"],
                  aliases: ["Toy"],
                  resourceDigest: "test-digest",
                  tokenizer: {
                    ignoreCase: false,
                    states: [
                      {
                        name: "root",
                        rules: [
                          { regex: { pattern: ".", flags: "" }, action: { token: "identifier" } },
                        ],
                      },
                    ],
                  },
                  configuration: {},
                  resourceBytes: { tokenizer: 150, configuration: 3 },
                  expandedRules: 1,
                },
              ]
            : [],
        extensionRoutes: enabled && !quarantined ? { toy: "toy" } : {},
        conflicts: [],
      };
    },
    async setEnabled(key, value) {
      calls.push(["setEnabled", key, value]);
      enabled = value;
      quarantined = false;
      revision++;
      if (value) generation++;
      return { ok: true, state: await api.state() };
    },
    async reload(key) {
      calls.push(["reload", key]);
      generation++;
      revision++;
      quarantined = false;
      return { ok: true, state: await api.state() };
    },
    async reportLanguageRegistrationFailure(input) {
      calls.push(["report", input]);
      const accepted =
        input.revision === revision && input.generation === generation && !quarantined;
      if (accepted) {
        quarantined = true;
        revision++;
      }
      return { accepted, revision };
    },
  };
  return { api, calls };
}

test("acceptance checks disable/enable/reload and generation quarantine using frozen APIs", async () => {
  const { api, calls } = apiFixture();
  await checkStaticLanguageLifecycle(api, "acme.toy", "toy");
  assert.deepEqual(
    calls.filter(([name]) => name === "setEnabled"),
    [
      ["setEnabled", "dev:0123456789abcdef", false],
      ["setEnabled", "dev:0123456789abcdef", true],
    ],
  );
  assert.equal(calls.filter(([name]) => name === "report").length, 2);
  assert.equal(calls.filter(([name]) => name === "reload").length, 2);
});

test("acceptance rejects an accidentally spawned static plugin", async () => {
  await assert.rejects(
    checkStaticLanguageLifecycle(apiFixture({ running: true }).api, "acme.toy", "toy"),
    /running/,
  );
});

test("acceptance rejects a catalog that retains a disabled language", async () => {
  await assert.rejects(
    checkStaticLanguageLifecycle(apiFixture({ revoke: false }).api, "acme.toy", "toy"),
    /disabled/,
  );
});

test("Electron acceptance entry is syntactically complete without executing T0 stubs", async () => {
  const source = await readFile(new URL("./static-languages-main.ts", import.meta.url), "utf8");
  const result = ts.transpileModule(source, {
    fileName: "static-languages-main.ts",
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  assert.deepEqual(result.diagnostics, []);
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false
pnpm exec node --test tests/desktop/static-languages-acceptance.test.mjs
```

Expected: FAIL, missing `static-languages-acceptance.mjs` and the Electron entry.

- [ ] **Step 3: Implement the reusable assertions and real integration runner**

Create `tests/desktop/static-languages-acceptance.mjs`:

```js
import assert from "node:assert/strict";

export async function checkStaticLanguageLifecycle(api, pluginId, languageId) {
  const row = (await api.state()).plugins.find((plugin) => plugin.id === pluginId);
  assert.ok(row, `missing ${pluginId}`);
  assert.equal(row.runtime, "static");
  assert.equal(row.running, false, "static plugin must never be running");
  const sourceKey = row.sourceKey;
  const own = (catalog) =>
    catalog.languages.find(
      (language) => language.sourceKey === sourceKey && language.id === languageId,
    );
  const first = await api.staticLanguages();
  assert.equal(first.formatVersion, 1);
  assert.equal(first.limitsVersion, 1);
  assert.ok(own(first));
  assert.equal((await api.state()).staticLanguagesRevision, first.revision);
  assert.equal((await api.setEnabled(sourceKey, false)).ok, true);
  const disabled = await api.staticLanguages();
  assert.equal(own(disabled), undefined, "disabled language must leave the catalog");
  assert.ok(disabled.revision > first.revision);
  assert.equal((await api.setEnabled(sourceKey, true)).ok, true);
  const enabled = await api.staticLanguages();
  assert.ok(own(enabled));
  assert.ok(enabled.revision > disabled.revision);
  assert.equal((await api.reload(sourceKey)).ok, true);
  const reloaded = await api.staticLanguages();
  assert.ok(own(reloaded).generation > own(enabled).generation);
  const report = {
    sourceKey,
    generation: own(reloaded).generation,
    languageId,
    revision: reloaded.revision,
    reason: "monaco",
    detail: "Acceptance fixture: simulated registration failure",
  };
  assert.equal((await api.reportLanguageRegistrationFailure(report)).accepted, true);
  const isolated = await api.staticLanguages();
  assert.equal(own(isolated), undefined);
  assert.equal((await api.reportLanguageRegistrationFailure(report)).accepted, false);
  assert.equal((await api.staticLanguages()).revision, isolated.revision);
  assert.equal((await api.reload(sourceKey)).ok, true);
  assert.ok(own(await api.staticLanguages()));
  assert.equal(
    (await api.state()).plugins.find((plugin) => plugin.sourceKey === sourceKey).running,
    false,
  );
}
```

Create `tests/desktop/static-languages-main.ts`. It runs only in the T8 integration gate. The test-only handler table exercises the real `registerPluginIpc` validation and controller; the separate packaged checks in 7.3 exercise the actual trusted Electron sender and production preload. Do not label this table as a sender-security test.

```ts
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, type IpcMainInvokeEvent } from "electron";
import type { PluginSource } from "@kobrixa/plugin-runtime";
import type { PluginsApi } from "../../apps/desktop/src/shared/plugins.js";
import type { LanguageBinding } from "../../apps/desktop/src/shared/language-services.js";
import type { IpcHandle } from "../../apps/desktop/src/main/ipc.js";
import { startPlugins } from "../../apps/desktop/src/main/plugins/controller.js";
import { registerPluginIpc } from "../../apps/desktop/src/main/plugins/ipc.js";
import { SessionMarkerFile } from "../../apps/desktop/src/main/plugins/session.js";
import { installPluginQuitCleanup } from "../../apps/desktop/src/main/plugins/quit.js";
import { resolveLexicalLanguage } from "../../apps/desktop/src/renderer/editor/static-language-routing.js";
import { checkStaticLanguageLifecycle } from "./static-languages-acceptance.mjs";

const [directory, phase] = process.argv.slice(-2) as [string, string];
const fail = (error: unknown) => {
  console.error(error);
  app.exit(1);
};
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
setTimeout(() => fail(new Error(`static acceptance timed out: ${phase}`)), 60_000).unref();

void app.whenReady().then(async () => {
  const input = JSON.parse(await readFile(path.join(directory, "input.json"), "utf8")) as {
    paths: Record<string, string>;
    builtin: PluginSource;
    binding: LanguageBinding;
  };
  const names =
    phase === "conflicts" ? ["toy", "shared", "duplicate", "invalid", "hostile"] : ["toy"];
  let launches = 0;
  const plugins = await startPlugins({
    userData: app.getPath("userData"),
    builtins: [input.builtin],
    commandLine: {
      developmentDirectories: names.map((name) => input.paths[name]!),
      safeMode: phase === "cli-safe",
    },
    dialogs: {
      confirmDeveloperMode: async () => true,
      chooseFolder: async () => undefined,
      confirmLink: async () => true,
      confirmUnlink: async () => true,
      choosePython: async () => undefined,
    },
    locale: "en",
    launcher: () => async () => {
      launches++;
      throw new Error("static contribution attempted process launch");
    },
  });
  installPluginQuitCleanup(app, plugins);
  app.on("quit", () => plugins.finishSession());
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const handle: IpcHandle = (channel, action) => {
    handlers.set(channel, action as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown);
  };
  const off = registerPluginIpc(handle, plugins, () => {});
  app.on("will-quit", off);
  const invoke = async (channel: string, ...args: unknown[]) => {
    const action = handlers.get(channel);
    assert.ok(action, `missing channel ${channel}`);
    return action({} as IpcMainInvokeEvent, ...args);
  };
  const api = {
    state: async () => plugins.state(),
    staticLanguages: async () => invoke("plugins:static-languages"),
    reportLanguageRegistrationFailure: async (value: unknown) =>
      invoke("plugins:report-language-registration-failure", value),
    setEnabled: async (key: string, enabled: boolean) =>
      invoke("plugins:set-enabled", key, enabled),
    reload: async (key: string) => invoke("plugins:reload", key),
  } as Pick<
    PluginsApi,
    "state" | "staticLanguages" | "reportLanguageRegistrationFailure" | "setEnabled" | "reload"
  >;
  const markerFile = path.join(app.getPath("userData"), "plugins/session.json");
  const marker = async () =>
    JSON.parse(await readFile(markerFile, "utf8")) as {
      thirdPartyStaticContributions: boolean;
      thirdPartyRunning: boolean;
    };
  const toy = () => plugins.state().plugins.find((row) => row.id === "acme.toy");
  const builtinId = input.binding.language;

  if (phase === "lifecycle") {
    await checkStaticLanguageLifecycle(api, "acme.toy", "toy");
    assert.equal((await marker()).thirdPartyStaticContributions, true);
    await api.setEnabled(toy()!.sourceKey, false);
    assert.equal(
      (await marker()).thirdPartyStaticContributions,
      true,
      "risk marker stays sticky after disable",
    );
    await api.setEnabled(toy()!.sourceKey, true);
  } else if (phase === "conflicts") {
    let catalog = await api.staticLanguages();
    const duplicate = catalog.conflicts.find(
      (conflict) => conflict.kind === "id" && conflict.key === "toy",
    );
    assert.deepEqual(duplicate?.sources.map((source) => source.pluginId).sort(), [
      "acme.duplicate",
      "acme.toy",
    ]);
    assert.equal(
      catalog.languages.some((language) => language.id === "toy"),
      false,
    );
    const duplicateRow = plugins.state().plugins.find((row) => row.id === "acme.duplicate")!;
    assert.equal((await api.setEnabled(duplicateRow.sourceKey, false)).ok, true);
    catalog = await api.staticLanguages();
    assert.equal(catalog.extensionRoutes.toy, null);
    assert.equal(catalog.extensionRoutes.other, "toy-other");
    const route = (binding?: LanguageBinding) =>
      resolveLexicalLanguage({
        file: "main.toy",
        catalog,
        activeOwners: plugins.state().staticLanguageOwners,
        coreExtensionRoutes: { json: "json" },
        ...(binding ? { binding } : {}),
      });
    assert.equal(route().monacoLanguage, "plaintext");
    assert.equal(route(input.binding).monacoLanguage, builtinId);
    assert.equal(
      plugins.state().plugins.find((row) => row.id === "acme.invalid")?.status,
      "enabled",
    );
    assert.ok(
      plugins
        .state()
        .plugins.find((row) => row.id === "acme.invalid")
        ?.problems.some(
          (problem) =>
            problem.code === "PLUGIN_E_STATIC_LANGUAGE" &&
            problem.detail?.languageId === "toy-invalid",
        ),
    );
    // A resource-only load of the hostile fixture must finish without running document regexes.
    assert.equal(
      plugins.state().plugins.find((row) => row.id === "acme.hostile")?.status,
      "enabled",
    );
    const required = await api.setEnabled(input.binding.sourceKey, false);
    assert.equal(required.ok, false);
    if (!required.ok) assert.equal(required.code, "PLUGIN_E_BUILTIN_REQUIRED");
  } else if (phase === "unclean" || phase === "hang") {
    await api.staticLanguages();
    assert.equal((await marker()).thirdPartyStaticContributions, true);
    assert.equal((await marker()).thirdPartyRunning, false);
    if (phase === "hang") plugins.markRendererUnresponsive();
    // Persist a per-source disable before dying: restoring the lock must not undo it.
    await api.setEnabled(toy()!.sourceKey, false);
    await writeFile(path.join(directory, `${phase}-ready.json`), JSON.stringify({ launches }));
    process.kill(process.pid, "SIGKILL");
    return;
  } else if (phase === "recover" || phase === "recover-hang" || phase === "cli-safe") {
    assert.equal(plugins.state().safeMode, true);
    if (phase !== "cli-safe")
      assert.equal(
        plugins.state().safeModeLock?.reason,
        phase === "recover-hang" ? "renderer-unresponsive" : "unclean-exit",
      );
    assert.equal(
      (await api.staticLanguages()).languages.every((language) =>
        language.sourceKey.startsWith("builtin:"),
      ),
      true,
    );
    assert.ok(
      (await api.staticLanguages()).languages.some((language) => language.id === builtinId),
    );
    if (phase !== "cli-safe") {
      assert.equal((await plugins.clearSafeModeLock()).ok, true);
      assert.equal(
        (await api.staticLanguages()).languages.some((language) => language.id === "toy"),
        false,
      );
      assert.equal((await api.setEnabled(toy()!.sourceKey, true)).ok, true);
      assert.ok((await api.staticLanguages()).languages.some((language) => language.id === "toy"));
    }
  } else if (phase === "marker-failure") {
    // The runner persists toy as disabled before startup, so no third-party catalog was delivered.
    assert.equal((await marker()).thirdPartyStaticContributions, false);
    const original = SessionMarkerFile.prototype.markThirdPartyStaticContributions;
    SessionMarkerFile.prototype.markThirdPartyStaticContributions = () => {
      throw new Error("fixture marker write failure");
    };
    try {
      await api.setEnabled(toy()!.sourceKey, true);
      const catalog = await api.staticLanguages();
      assert.equal(
        catalog.languages.some((language) => language.id === "toy"),
        false,
      );
      assert.ok(catalog.languages.some((language) => language.id === builtinId));
      const afterFailure = plugins.state();
      assert.ok(
        afterFailure.stateProblem?.code === "PLUGIN_E_STATE_SAVE" ||
          afterFailure.plugins.some((row) =>
            row.problems.some((problem) => problem.code === "PLUGIN_E_STATE_SAVE"),
          ),
      );
      console.log(
        "PASS refuses post-startup static catalog delivery when marker persistence fails",
      );
      assert.equal((await marker()).thirdPartyStaticContributions, false);
    } finally {
      SessionMarkerFile.prototype.markThirdPartyStaticContributions = original;
    }
  } else throw new Error(`unknown phase ${phase}`);
  assert.equal(launches, 0, "static-only launcher/handshake count");
  console.log(`PASS static acceptance: ${phase}`);
  app.quit();
});
```

Create `tests/desktop/static-languages-run.mjs`:

```js
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { developmentSourceKey } from "../../packages/plugin-runtime/dist/index.js";
import {
  readStaticLanguageFixtures,
  writeStaticLanguageFixtures,
} from "./static-languages-fixtures.mjs";
import { waitForSmokeExit } from "./plugins-smoke-process.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(path.join(root, "apps/desktop/package.json"));
const electron = require("electron");
const directory = await mkdtemp(path.join(tmpdir(), "kobrixa-static-acceptance-"));
let passed = false;
try {
  const paths = await writeStaticLanguageFixtures(path.join(directory, "plugins"));
  const { builtin, binding } = await readStaticLanguageFixtures();
  await writeFile(path.join(directory, "input.json"), JSON.stringify({ paths, builtin, binding }));
  const main = path.join(directory, "main.cjs");
  await build({
    entryPoints: [path.join(root, "tests/desktop/static-languages-main.ts")],
    outfile: main,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    alias: {
      "@kobrixa/plugin-protocol": path.join(root, "packages/plugin-protocol/src/index.ts"),
      "@kobrixa/plugin-runtime": path.join(root, "packages/plugin-runtime/src/index.ts"),
    },
  });
  const run = async (phase, profile, killed = false) => {
    const child = spawn(electron, [main, `--user-data-dir=${profile}`, directory, phase], {
      stdio: "inherit",
    });
    const result = await waitForSmokeExit(child, `static languages ${phase}`);
    if (killed) {
      assert.notEqual(result.code, 0);
      const ready = JSON.parse(await readFile(path.join(directory, `${phase}-ready.json`), "utf8"));
      assert.equal(ready.launches, 0);
      const marker = JSON.parse(await readFile(path.join(profile, "plugins/session.json"), "utf8"));
      assert.equal(marker.thirdPartyStaticContributions, true);
    } else assert.equal(result.code, 0, `${phase}: ${result.signal}`);
  };
  for (const phase of ["lifecycle", "conflicts", "cli-safe"])
    await run(phase, path.join(directory, phase));
  for (const [crash, recover] of [
    ["unclean", "recover"],
    ["hang", "recover-hang"],
  ]) {
    const profile = path.join(directory, `${crash}-profile`);
    await run(crash, profile, true);
    await run(recover, profile);
    await assert.rejects(readFile(path.join(profile, "plugins/session.json")), { code: "ENOENT" });
  }
  const failureProfile = path.join(directory, "failure-profile");
  await mkdir(path.join(failureProfile, "plugins"), { recursive: true });
  await writeFile(
    path.join(failureProfile, "plugins/state.json"),
    JSON.stringify({
      schemaVersion: 2,
      developerMode: false,
      sources: [],
      legacyDisabledIds: [],
      disabled: [developmentSourceKey(await realpath(paths.toy))],
    }),
  );
  await run("marker-failure", failureProfile);
  passed = true;
} finally {
  if (passed) await rm(directory, { recursive: true, force: true });
  else console.error(`Static language acceptance artifacts: ${directory}`);
}
```

The recovery phases intentionally kill **their own test process** after writing readiness evidence; the existing parent `waitForSmokeExit` force-kills a stalled Electron process after 90 seconds. No hostile regex is executed here. The `hang` phase exercises persisted renderer-unresponsive recovery via the real controller hook; an actual unresponsive renderer and its next-launch recovery UI remain a separate packaged/manual gate in 7.4 and T8.

- [ ] **Step 4: Run the branch gate, and record the real gate without running it on T0**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false
pnpm exec node --test tests/desktop/static-languages-acceptance.test.mjs
pnpm exec node --check tests/desktop/static-languages-run.mjs
pnpm exec prettier --write tests/desktop/static-languages-acceptance.mjs tests/desktop/static-languages-acceptance.test.mjs tests/desktop/static-languages-main.ts tests/desktop/static-languages-run.mjs
pnpm exec eslint tests/desktop/static-languages-acceptance.mjs tests/desktop/static-languages-acceptance.test.mjs tests/desktop/static-languages-main.ts tests/desktop/static-languages-run.mjs
```

Expected: PASS against T0. After merge, T8 runs `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec node tests/desktop/static-languages-run.mjs`. Expected then: real lifecycle, conflict resolution, no launch, marker failure, sticky recovery, and persistent disable assertions pass. No acceptance check is skipped or changed to an expected failure on the integration run.

- [ ] **Step 5: Controller commits subsection 7.2**

```bash
git add tests/desktop/static-languages-acceptance.mjs tests/desktop/static-languages-acceptance.test.mjs tests/desktop/static-languages-main.ts tests/desktop/static-languages-run.mjs
git commit -m "test(desktop): add static language lifecycle and recovery acceptance"
```

#### 7.3 Migrate existing smoke consumers and add shipped-app static-language checks

- [ ] **Step 1: Write failing runner/probe tests**

Append to `static-languages-contract.test.mjs`:

```js
test("legacy smoke tokenization calls use bp while theme token classes retain basic-plus", async () => {
  for (const name of ["highlighting-smoke.mjs", "indentation-smoke.mjs"]) {
    const source = await readFile(new URL(name, import.meta.url), "utf8");
    assert.doesNotMatch(source, /,\s*'basic-plus'\)/);
    assert.match(source, /,\s*'bp'\)/);
    assert.match(source, /keyword\.control\.basic-plus/);
  }
});

test("packaged runner invokes static acceptance from a copied app with a temporary cwd", async () => {
  const source = await readFile(new URL("./packaged-smoke.mjs", import.meta.url), "utf8");
  assert.match(source, /await checkPackagedStaticLanguages\(/);
  assert.match(source, /await cp\(appDirectory, installedDirectory/);
  assert.match(source, /cwd: profile/);
  assert.match(source, /--plugin-dev-dir=/);
});
```

These narrow source guards verify harness wiring only; the underlying outcomes are checked by the executable helper below. Append to `static-languages-acceptance.test.mjs`:

```js
test("packaged assertion helper exports a callable acceptance entry", async () => {
  const module = await import("./static-languages-packaged.mjs");
  assert.equal(typeof module.checkPackagedStaticLanguages, "function");
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false
pnpm exec node --test tests/desktop/static-languages-contract.test.mjs tests/desktop/static-languages-acceptance.test.mjs
```

Expected: FAIL on old `basic-plus` tokenize calls and absent packaged helper/wiring. No Electron process is started.

- [ ] **Step 3: Implement the real Monaco and packaged checks**

In `highlighting-smoke.mjs:52`, change only the tokenize language argument from `'basic-plus'` to `'bp'`. In `indentation-smoke.mjs:8,36`, make the same two replacements. Keep every `.basic-plus` token-class assertion and existing theme/indentation expectation unchanged.

Use this exact edit script for those three argument replacements:

```bash
python3 - <<'PY'
from pathlib import Path
for name, expected in [('highlighting-smoke.mjs', 1), ('indentation-smoke.mjs', 2)]:
    file = Path('tests/desktop') / name
    source = file.read_text()
    count = source.count(", 'basic-plus')") + source.count(",'basic-plus')")
    assert count == expected, (name, count)
    file.write_text(source.replace(", 'basic-plus')", ", 'bp')").replace(",'basic-plus')", ",'bp')"))
PY
```

In `highlighting-smoke.mjs`, before `// Changing a dependency must remove obsolete function semantics`, insert this complete check. It uses the existing real `ed`, `js` and `until` helpers. It reads the final configuration service value used by Monarch, then forces the model's actual tokenization path. Monaco 0.57.0 exposes this setting through `StandaloneEditor._configurationService`, not `EditorOption`; the probe follows the inspected `standaloneCodeEditor.js` and `monarchLexer.js` implementation.

```js
const codeSize = await js("smoke.settingsStore.getSnapshot().values.codeSize");
try {
  for (const length of [9999, 10000, 10001]) {
    const line = "If True Then".padEnd(length, " ");
    await js(`ed.setValue(${JSON.stringify(line + "\nEndIf")});
          ed.getModel().tokenization.forceTokenization(2)`);
    assert.equal(await js("ed.getModel().getLineLength(1)"), length);
    assert.equal(
      await js(
        "ed._configurationService.getValue('editor.maxTokenizationLineLength',{overrideIdentifier:'bp'})",
      ),
      10000,
    );
    const count = await js("ed.getModel().tokenization.getLineTokens(1).getCount()");
    assert.equal(count > 1, length < 10000, `actual model tokenization at ${length} UTF-16 units`);
    assert.equal(
      await js("smoke.monaco.editor.tokenize('EndIf','bp')[0][0].type"),
      "keyword.control.basic-plus",
    );
    await js(
      "ed.executeEdits('long-line-smoke',[{range:new smoke.monaco.Range(2,6,2,6),text:' '}]);ed.trigger('long-line-smoke','undo',null)",
    );
    assert.equal(await js("ed.getValue()"), line + "\nEndIf");
  }
  await js(`smoke.settingsStore.set('codeSize',${codeSize === 18 ? 19 : 18})`);
  await until(
    "ed._configurationService.getValue('editor.maxTokenizationLineLength',{overrideIdentifier:'bp'}) === 10000",
  );
} finally {
  await js(
    `smoke.settingsStore.set('codeSize',${JSON.stringify(codeSize)});ed.setValue(${JSON.stringify(sample)})`,
  );
}
await until('highlightColor(3,15) === "rgb(121, 94, 38)"');
```

Create `tests/desktop/static-languages-packaged.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

export async function checkPackagedStaticLanguages({ js, send, until, profile, sourceKey }) {
  const catalog = await js("window.kobrixa.plugins.staticLanguages()");
  const builtin = catalog.languages.find((language) => language.id === "bp");
  assert.ok(builtin, "packaged raw Basic Plus resources must reach the catalog");
  assert.equal(builtin.pluginId, "kobrixa.basic-plus");
  assert.equal(builtin.tokenizer.tokenPostfix, ".basic-plus");
  assert.equal(builtin.tokenizer.states[0].rules.length, 9);
  assert.equal(Object.hasOwn(builtin.configuration, "wordPattern"), false);
  assert.equal(Object.hasOwn(builtin.configuration, "onEnterRules"), false);
  assert.ok(builtin.resourceBytes.tokenizer > 0 && builtin.resourceBytes.configuration > 0);
  assert.equal(
    await js(
      "Boolean(document.querySelector('.editor-stage .monaco-editor[data-mode-id=\"bp\"]'))",
    ),
    true,
  );
  const required = await js(
    `window.kobrixa.plugins.setEnabled(${JSON.stringify(builtin.sourceKey)},false)`,
  );
  assert.equal(required.ok, false);
  assert.equal(required.code, "PLUGIN_E_BUILTIN_REQUIRED");
  const state = await js("window.kobrixa.plugins.state()");
  const toy = state.plugins.find((plugin) => plugin.sourceKey === sourceKey);
  assert.equal(toy?.runtime, "static");
  assert.equal(toy?.running, false);
  const markerFile = path.join(profile, "plugins/session.json");
  const marker = () => readFile(markerFile, "utf8").then(JSON.parse);
  assert.equal((await marker()).thirdPartyStaticContributions, true);
  assert.equal((await marker()).thirdPartyRunning, false);
  const mode = (id) =>
    js(`Boolean(document.querySelector('.editor-stage .monaco-editor[data-mode-id="${id}"]'))`);
  const select = async (file, language) => {
    await js(`document.querySelector('[data-tree-path="${file}"]').click()`);
    await until(() => mode(language));
  };
  await select("sample.toy", "toy");
  assert.match(await js('document.querySelector(".status-details").textContent'), /Toy/);
  await send("Page.bringToFront");
  await js('document.querySelector(".editor-stage .monaco-editor textarea").focus()');
  await send("Input.insertText", { text: "draft_value 42 " });
  await until(() =>
    js('document.querySelector(".editor-stage .view-lines").textContent.includes("draft_value")'),
  );
  const edited = await js('document.querySelector(".editor-stage .view-lines").textContent');
  assert.equal(
    (await js(`window.kobrixa.plugins.setEnabled(${JSON.stringify(sourceKey)},false)`)).ok,
    true,
  );
  await until(() => mode("plaintext"));
  assert.equal(await js('document.querySelector(".editor-stage .view-lines").textContent'), edited);
  assert.match(
    await js('document.querySelector(".status-details").textContent'),
    /Plain Text|純文字/,
  );
  assert.equal((await marker()).thirdPartyStaticContributions, true);
  // Hide the dirty toy document while its contribution is unavailable, then restore it.
  await select("main.bp", "bp");
  assert.equal(
    (await js(`window.kobrixa.plugins.setEnabled(${JSON.stringify(sourceKey)},true)`)).ok,
    true,
  );
  await select("sample.toy", "toy");
  assert.equal(await js('document.querySelector(".editor-stage .view-lines").textContent'), edited);
  await select("unknown.xyz", "plaintext");
  await select("data.json", "json");
  await select("main.bp", "bp");
  const resources = await js("performance.getEntriesByType('resource').map(entry=>entry.name)");
  assert.equal(
    resources.some((url) => /\/language\/(tokenizer|configuration)\.json(?:[?#]|$)/.test(url)),
    false,
  );
}
```

The `data-mode-id` observation is Monaco 0.57.0's existing code-editor DOM attribute (set by `codeEditorWidget` on model-language changes), not an invented product hook. This packaged probe verifies visible routing, labels, and retained content. It does not claim to inspect hidden-model identity, undo internals, diff options, or semantic tokens; those use real Monaco/T5 tests and the explicit T8 matrix below.

In `packaged-smoke.mjs`, extend the fs import with `cp` and add:

```js
import { developmentSourceKey } from "../../packages/plugin-runtime/dist/index.js";
import { writeStaticLanguageFixtures } from "./static-languages-fixtures.mjs";
import { checkPackagedStaticLanguages } from "./static-languages-packaged.mjs";
```

Immediately after the `appDirectory` declaration and before `const executable`, add:

```js
const installedDirectory = path.join(profile, "installed");
await cp(appDirectory, installedDirectory, { recursive: true, dereference: true });
const staticFixtures = await writeStaticLanguageFixtures(path.join(profile, "static-fixtures"));
const staticSourceKey = developmentSourceKey(await realpath(staticFixtures.toy));
```

Change only the first argument of `const executable = path.join(...)` from `appDirectory` to `installedDirectory`. The copy retains the `.app`/resources layout; dereferencing prevents the temporary installation from following symlinks back to the checkout. In the loop that writes each `main.bp`, also write:

```js
await writeFile(path.join(inputPath, "sample.toy"), "value 1\n");
await writeFile(path.join(inputPath, "unknown.xyz"), "unknown text\n");
await writeFile(path.join(inputPath, "data.json"), '{"value":1}\n');
```

In `launch`, append this CLI argument after `"--remote-debugging-port=0"`:

```js
      `--plugin-dev-dir=${staticFixtures.toy}`,
```

Change the spawn options to:

```js
    { cwd: profile, stdio: ["ignore", "pipe", "pipe"] },
```

Change `await check(js, send)` to `await check(js, send, until)`. Change the **first** callback from `await launch(async (js, send) => {` to `await launch(async (js, send, until) => {`, then insert at the beginning of that callback:

```js
await checkPackagedStaticLanguages({ js, send, until, profile, sourceKey: staticSourceKey });
```

Before the second `launch`, after the existing `main.bp` disk assertion, add:

```js
assert.equal(await readFile(path.join(inputPaths[1], "sample.toy"), "utf8"), "value 1\n");
```

The existing smoke assumes unsaved drafts are not auto-saved; this new assertion preserves that existing setup. Its second launch now restores two dirty files, so keep the existing assertion on `.project-tab .dirty` (**one dirty project**) unchanged, and add a sample-specific check after it:

```js
await js("document.querySelector('[data-tree-path=\"sample.toy\"]').click()");
for (let attempt = 0; attempt < 50; attempt++) {
  if (
    await js(
      "Boolean(document.querySelector('.editor-stage .monaco-editor[data-mode-id=\"toy\"]'))",
    )
  )
    break;
  await pause(100);
}
assert.equal(
  await js("Boolean(document.querySelector('.editor-stage .monaco-editor[data-mode-id=\"toy\"]'))"),
  true,
);
assert.match(
  await js('document.querySelector(".editor-stage .view-lines").textContent'),
  /draft_value/,
);
```

After both launches, assert marker cleanup:

```js
await assert.rejects(readFile(path.join(profile, "plugins/session.json")), { code: "ENOENT" });
```

Keep the existing `finally` cleanup of the isolated `profile`; it also deletes the copied application. Actual proof that **no repository source directory exists** requires running this copied artifact on the T8 packaging machine/container without the checkout mounted; a temporary `cwd` alone is not that proof. Record that run separately.

- [ ] **Step 4: Run the local harness gate**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false
pnpm exec node --test tests/desktop/static-languages-contract.test.mjs tests/desktop/static-languages-acceptance.test.mjs tests/desktop/smoke-harness.test.mjs
pnpm exec node --check tests/desktop/static-languages-packaged.mjs
pnpm exec node --check tests/desktop/packaged-smoke.mjs
pnpm exec prettier --write tests/desktop/static-languages-contract.test.mjs tests/desktop/static-languages-acceptance.test.mjs tests/desktop/static-languages-packaged.mjs tests/desktop/packaged-smoke.mjs tests/desktop/highlighting-smoke.mjs tests/desktop/indentation-smoke.mjs
pnpm exec eslint tests/desktop/static-languages-contract.test.mjs tests/desktop/static-languages-acceptance.test.mjs tests/desktop/static-languages-packaged.mjs tests/desktop/packaged-smoke.mjs tests/desktop/highlighting-smoke.mjs tests/desktop/indentation-smoke.mjs
```

Expected: PASS without real catalog/renderer implementation. Real `pnpm test:desktop:smoke` and `pnpm test:desktop:packaged` are deferred to T8; do not weaken their assertions to accommodate T0. The completion suite still enforces hot p95 ≤100 ms, new variable ≤200 ms, and 30,000 lines ≤300 ms.

- [ ] **Step 5: Controller commits subsection 7.3**

```bash
git add tests/desktop/static-languages-contract.test.mjs tests/desktop/static-languages-acceptance.test.mjs tests/desktop/static-languages-packaged.mjs tests/desktop/packaged-smoke.mjs tests/desktop/highlighting-smoke.mjs tests/desktop/indentation-smoke.mjs
git commit -m "test(desktop): cover static languages in Monaco and packaged smoke"
```

#### 7.4 Publish bilingual author contracts and the integration acceptance record

- [ ] **Step 1: Write failing documentation conformance tests**

Create `tests/desktop/static-languages-docs.test.mjs`:

````js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { readStaticLanguageFixtures } from "./static-languages-fixtures.mjs";

for (const locale of ["en", "zh-TW"]) {
  test(`${locale} author examples equal the frozen T0 toy fixture`, async () => {
    const text = await readFile(
      new URL(`../../docs/${locale}/plugin-static-languages.md`, import.meta.url),
      "utf8",
    );
    const examples = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
      JSON.parse(match[1]),
    );
    const fixture = await readStaticLanguageFixtures();
    assert.deepEqual(examples, [
      fixture.toyManifest,
      JSON.parse(fixture.toyTokenizer),
      JSON.parse(fixture.toyConfiguration),
    ]);
    for (const contract of [
      "^1.4.0",
      "--plugin-dev-dir",
      "--safe-mode",
      "thirdPartyStaticContributions",
      "PLUGIN_E_STATIC_LANGUAGE",
      "PLUGIN_E_STATIC_LANGUAGE_CONFLICT",
      "PLUGIN_E_STATIC_LANGUAGE_REGISTRATION",
      "PLUGIN_E_BUILTIN_REQUIRED",
      "PLUGIN_E_STATE_SAVE",
      "10,000",
      "5,000",
      "256",
      "257",
    ])
      assert.ok(text.includes(contract), `missing author contract ${contract}`);
    const support = await readFile(
      new URL(`../../docs/${locale}/language-support.md`, import.meta.url),
      "utf8",
    );
    const architecture = await readFile(
      new URL(`../../docs/${locale}/architecture.md`, import.meta.url),
      "utf8",
    );
    assert.match(support, /plugin-static-languages\.md/);
    assert.match(architecture, /thirdPartyStaticContributions/);
    assert.doesNotMatch(
      architecture,
      /Static language contributions are reserved for 2C|靜態語言貢獻留待 2C/,
    );
  });
}
````

- [ ] **Step 2: Run and confirm failure**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false
pnpm exec node --test tests/desktop/static-languages-docs.test.mjs
```

Expected: FAIL with missing author documents. This compares examples with frozen inputs, not with T1's unimplemented validator.

- [ ] **Step 3: Write the complete English author guide**

Create `docs/en/plugin-static-languages.md` with the following content:

````markdown
# Static language plugins

Plugin API 1.4.0 lets trusted local development plugins provide syntax coloring and editor configuration from JSON. A static language does not add a compiler, project inference, or a language service. Basic Plus remains the only shipped source frontend; third-party `frontends`, `backends`, and `languageServices` remain prohibited, including empty declarations. Existing compatible 1.x plugins continue to load.

## A complete static-only plugin

Place these three files in one folder. This example is the shared `acme.toy` acceptance fixture. There is no executable entry, SDK initialization, registration RPC, or plugin process.

`kobrixa-plugin.json`:

```json
{
  "id": "acme.toy",
  "version": "1.0.0",
  "apiVersion": "^1.4.0",
  "displayName": "Toy static language",
  "runtime": { "kind": "static" },
  "contributes": {
    "languages": [
      {
        "id": "toy",
        "extensions": ["toy"],
        "aliases": ["Toy"],
        "tokenizer": { "version": 1, "path": "language/tokenizer.json" },
        "configuration": { "version": 1, "path": "language/configuration.json" }
      }
    ]
  }
}
```

`language/tokenizer.json`:

```json
{
  "ignoreCase": false,
  "defaultToken": "invalid",
  "states": [
    {
      "name": "root",
      "rules": [
        { "regex": { "pattern": "[ \\t]+", "flags": "" }, "action": { "token": "white" } },
        {
          "regex": { "pattern": "[A-Za-z_][A-Za-z0-9_]*", "flags": "" },
          "action": { "token": "identifier" }
        },
        { "regex": { "pattern": "[0-9]+", "flags": "" }, "action": { "token": "number" } }
      ]
    }
  ]
}
```

`language/configuration.json`:

```json
{}
```

The resource declarations carry `version: 1`; the JSON resource bodies do not repeat it. Both resources are required. An empty configuration selects Monaco defaults; inline configuration is not supported. Resource paths are package-relative `.json` paths, at most 600 characters and seven directory segments, with no URLs, absolute paths, backslashes or `..` segments. A symlink cannot escape the linked folder.

`runtime: {"kind":"static"}` accepts only `kind`. It cannot declare `entry`, `activationEvents`, `permissions`, commands, frontends, backends or language services, even as empty arrays. It needs a nonempty language contribution or valid `diagnosticHelp`. A resource error rejects its language without retroactively invalidating the static runtime. Node/Python plugins may also contribute these resources; reading their grammars does not start their processes.

## Load, reload and recover

Use Settings → Plugins to enable developer mode after the native trust confirmation, then link the folder. Alternatively launch the application with `--plugin-dev-dir=/absolute/path/to/toy`; multiple folders use `:` on macOS/Linux and `;` on Windows. Changes take effect after Reload. Enable/Disable applies to the whole plugin and persists by source identity. A static-only plugin can be enabled without a PID.

Only load grammars from authors you trust. JSON is data, but its regular expressions run in the editor and can block the renderer. Validation is not a ReDoS proof, a sandbox, or an interruptible worker. The 5,000 ms source I/O deadline and initial IPC wait do not interrupt synchronous regex execution. The 10,000 UTF-16-code-unit line threshold skips lexical tokenization at length ≥10,000; it does not bound indentation, on-enter or word-pattern input and does not make short patterns safe.

The host synchronously persists `thirdPartyStaticContributions` before delivering a third-party catalog, even for a plugin with no process. The bit stays set for the session after disable. A failed write prevents third-party delivery with `PLUGIN_E_STATE_SAVE`; builtin and plain-text editing remain available. Old markers without this field mean false. An unclean exit after delivery enters safe mode on the next launch; a renderer-unresponsive reason takes priority. Normal quit clears the marker unless a renderer hang must be remembered.

If the window hangs, quit it and restart, using `--safe-mode` if needed. Safe mode skips third-party folders and keeps Basic Plus and builtin services. The next launch exposes recovery settings independently of the hung renderer. Restore plugins is an explicit user action; it does not re-enable individually disabled sources, and it cannot end a CLI `--safe-mode` session. Do not rely on a button in an already blocked renderer to stop a regex.

## Resource format v1

Objects are strict: unlisted fields are rejected. State/list/rule/case arrays retain order. The `root` state is required; names use `^[a-z][a-z0-9_]{0,31}$`. State names `pop`, `popall`, `push`, list names `default`, `eos`, and map keys `__proto__`, `constructor`, `prototype` are reserved.

Tokenizer rules contain either `{regex, action}` or a local `include: "@state"`. Includes must exist, be acyclic, and fit the expansion limits, including unreachable states. Actions contain a literal `token` with optional `next` and `bracket`, or an ordered `cases` array whose branches use `@list`, `@eos`, and a final single `@default`. Nested cases and arbitrary guards are forbidden. Transitions accept an existing `@state`, `@pop`, or `@popall`; legal transition cycles are distinct from forbidden include cycles. `@brackets` requires a tokenizer bracket table and cannot also override `bracket`.

Every regex has `pattern` and explicit `flags`, exactly `""` or `"i"`. Every tokenizer regex must match `ignoreCase ? "i" : ""`; configuration regex flags are independent. Patterns are ECMAScript regex sources. Write literal `@`, `@@`, `@name`, and `$` normally; the adapter protects them from Monarch macro interpretation. `$S`/`$s` followed by a digit is rejected even when escaped. Backreferences, lookbehind, unsupported syntax, and tokenizer rules that cannot be proven to consume at least one code unit are rejected. Lookahead is supported. Configuration anchors may consume zero characters through the same purpose-aware validator.

Functions, imports, modules, callbacks, remote resources, external includes, custom macros, capture-action arrays, tuple shortcuts, dynamic substitutions, `@push`, `@rematch`, `goBack`, `switchTo`, `nextEmbedded`, `log`, `unicode`, `includeLF` and custom `start` are not part of v1. Strings are never evaluated as JavaScript.

Configuration may contain comments, brackets, auto-closing pairs with `notIn`, surrounding pairs, indentation regexes, on-enter rules, and a word pattern. On-enter indentation actions are `none`, `indent`, `indentOutdent`, or `outdent`. The full field contract and the strict public schemas `static-language-tokenizer-v1` and `static-language-configuration-v1` are described in the [approved design, sections 2–4](../superpowers/specs/2026-10-17-plugin-system-2c-static-languages-design.md). Zod, exported draft-2020-12 JSON Schema, and SDK conformance share the format; Python does not use its regex engine to validate ECMAScript patterns.

## Fixed limits

`STATIC_LANGUAGE_FORMAT_VERSION = 1` binds these immutable `STATIC_LANGUAGE_LIMITS_V1` values. Authors cannot raise them; incompatible format/limit changes require a new version. String lengths count decoded Unicode code points except the editor line threshold, which counts UTF-16 code units. Resource bytes count original UTF-8 including BOM; repeated references are charged repeatedly.

| Limit                                               |                               Value |
| --------------------------------------------------- | ----------------------------------: |
| Pattern / adapter-compiled pattern                  |           2,048 / 4,096 code points |
| Raw rules / regexes per language                    |                       1,024 / 1,024 |
| States / keyword lists                              |                             64 / 32 |
| Words per language / characters per word            |                          4,096 / 64 |
| Cases per rule / on-enter rules                     |                             32 / 32 |
| Resource file / language / plugin                   | 524,288 / 786,432 / 1,048,576 bytes |
| All active resources                                |                     8,388,608 bytes |
| Expanded rules per language / total                 |                      8,192 / 65,536 |
| Include depth                                       |                            16 edges |
| Languages per plugin / active total                 |                             8 / 128 |
| Registered plugin language ids per renderer session |     256; the 257th requires restart |
| Lexical line threshold                              |            10,000 UTF-16 code units |

Extensions are 1–16 distinct values of 1–16 lowercase alphanumeric characters without a dot. Language ids use `^[a-z][a-z0-9-]{0,31}$`. Aliases are 1–8 distinct single-line strings of 1–80 code points; the first is the label, or the id if omitted. Token/postfix lengths are at most 80. Pair/comment atoms are 1–16; each pair table is at most 32; `notIn` has at most three distinct values. On-enter `appendText` is at most 256 code points and `removeText` an integer 0–256. Controls in strings are rejected; textual regex escapes can match controls. All states and all configuration regex fields count toward limits.

## Ownership, fallback and errors

Routing is core → applicable selected binding's same-owner static language → unique global extension → plain text. Core JSON/plaintext ids and `.json` are reserved. A selected binding never borrows another owner's grammar when its own is missing. Without an applicable binding, two distinct languages sharing an extension make that global mapping ambiguous; no load-order winner exists. Other extensions and both language registrations survive. Duplicate purely static ids exclude every claimant. Aliases never choose ownership. A frontend reserves its logical id even if its grammar fails; matching frontend/service/static extension sets must be equal.

Disable, removal or failed reload updates existing visible, hidden and review models to plain text without losing text, undo, drafts, cursor or view state. Re-enable restores eligible open files. Lexical revision is separate from service epoch; grammar failures do not make a healthy analysis service unavailable. Plain-text fallback clears semantic coloring. Basic Plus uses Monaco id `bp` and token postfix `.basic-plus`, with unchanged keywords, comments, pairs, indentation and themes. Builtins cannot be disabled (`PLUGIN_E_BUILTIN_REQUIRED`).

| Problem                                 | Meaning                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `PLUGIN_E_MANIFEST`                     | Invalid declaration, static runtime semantics, or same-owner extension mismatch          |
| `PLUGIN_E_STATIC_LANGUAGE`              | Resource, format, regex, include, I/O or budget failure; only that language is rejected  |
| `PLUGIN_E_STATIC_LANGUAGE_CONFLICT`     | Ownership/id conflict or ambiguous/reserved extension; details identify all participants |
| `PLUGIN_E_STATIC_LANGUAGE_REGISTRATION` | Renderer validation, adapter, Monaco or session-id-limit failure                         |

The Plugins panel shows the plugin id, `detail.languageId`, relative `resourcePath`, applicable `fieldPath`, and limit `allowed`/`actual` or conflicting sources. Reload or explicit enable retries a quarantined generation; repeated catalog notifications do not. These are lexical capabilities only: no marketplace, theme contributions, file-association UI, glob/filename/first-line matching, or third-party language-service RPC is introduced.
````

- [ ] **Step 4: Write the complete Traditional Chinese author guide**

Create `docs/zh-TW/plugin-static-languages.md` with the following content:

````markdown
# 靜態語言插件

插件 API 1.4.0 允許可信任的本機開發插件，以 JSON 提供詞法上色及編輯器設定。靜態語言不會增加編譯器、隱式專案推斷或語言服務。Basic Plus 仍是唯一隨附的來源前端；第三方 `frontends`、`backends`、`languageServices` 仍禁止宣告，空陣列也不例外。符合 host API range 的既有 1.x 插件繼續載入。

## 完整的純靜態插件

在同一資料夾建立下列三個檔案。這是共用的 `acme.toy` 驗收 fixture，沒有執行入口、SDK 初始化、註冊 RPC 或插件程序。

`kobrixa-plugin.json`：

```json
{
  "id": "acme.toy",
  "version": "1.0.0",
  "apiVersion": "^1.4.0",
  "displayName": "Toy static language",
  "runtime": { "kind": "static" },
  "contributes": {
    "languages": [
      {
        "id": "toy",
        "extensions": ["toy"],
        "aliases": ["Toy"],
        "tokenizer": { "version": 1, "path": "language/tokenizer.json" },
        "configuration": { "version": 1, "path": "language/configuration.json" }
      }
    ]
  }
}
```

`language/tokenizer.json`：

```json
{
  "ignoreCase": false,
  "defaultToken": "invalid",
  "states": [
    {
      "name": "root",
      "rules": [
        { "regex": { "pattern": "[ \\t]+", "flags": "" }, "action": { "token": "white" } },
        {
          "regex": { "pattern": "[A-Za-z_][A-Za-z0-9_]*", "flags": "" },
          "action": { "token": "identifier" }
        },
        { "regex": { "pattern": "[0-9]+", "flags": "" }, "action": { "token": "number" } }
      ]
    }
  ]
}
```

`language/configuration.json`：

```json
{}
```

版本放在資源宣告的 `version: 1`，JSON 本體不重複版本欄位。兩份資源都必填；空 configuration 使用 Monaco 預設，不接受 inline configuration。資源必須是封裝內相對 `.json` 路徑，最多 600 字元、七層目錄，不能使用 URL、絕對路徑、反斜線或 `..` segment；symlink 也不能越出連結的資料夾。

`runtime: {"kind":"static"}` 只接受 `kind`。不可宣告 `entry`、`activationEvents`、`permissions`、commands、frontends、backends、languageServices，空陣列也不合法。至少需要非空 languages 或有效 diagnosticHelp；資源失敗只拒絕該語言，不反過來使已合法的 runtime 失效。Node／Python 插件也能提供靜態資源；只讀語法不會啟動程序。

## 載入、重新載入與復原

在「設定 → 插件」經原生信任確認開啟開發者模式，再連結資料夾。也可用 `--plugin-dev-dir=/absolute/path/to/toy` 啟動；多資料夾在 macOS／Linux 用 `:`，Windows 用 `;` 分隔。修改後按重新載入；啟用／停用以整個插件為單位，依來源身分持久保存。沒有 PID 的純靜態插件仍可處於啟用狀態。

只載入可信任作者提供的語法。JSON 雖是資料，其中 regex 仍在編輯器執行，可能阻塞 renderer。驗證不是 ReDoS 證明、沙箱或可中斷 worker。每來源 I/O 與首次 IPC 等待的 5,000 ms 上限不能中斷同步 regex。長度 ≥10,000 UTF-16 code units 的行跳過詞法 tokenization；這不限制縮排、on-enter、word-pattern 的輸入，也不保證短 pattern 安全。

宿主在交付第三方 catalog 前，同步保存 `thirdPartyStaticContributions`，沒有程序的插件也適用；本次 session 內即使停用仍保持 true。寫入失敗以 `PLUGIN_E_STATE_SAVE` 阻止第三方語法交付，保留 builtin／純文字編輯。舊 marker 缺欄位時視為 false。交付後非正常退出，下次啟動進入安全模式；renderer-unresponsive 原因優先。正常結束會清除 marker，但曾無回應的 renderer 仍需保留復原原因。

視窗卡住時，結束並重新啟動，必要時加 `--safe-mode`。安全模式不讀第三方資料夾，保留 Basic Plus 及內建服務；下一次啟動的復原設定不依賴卡住的 renderer。「恢復插件」必須由使用者明確操作，不會重新啟用個別持久停用來源，也無法結束 CLI `--safe-mode` session。不要依賴已被同步 regex 卡住的畫面按鈕來撤銷語法。

## 資源格式 v1

所有 objects 都是 strict，未列欄位會被拒絕。state／list／rule／case arrays 保留順序。必須包含 `root`；名稱符合 `^[a-z][a-z0-9_]{0,31}$`。state 保留 `pop`、`popall`、`push`，list 保留 `default`、`eos`，map key 保留 `__proto__`、`constructor`、`prototype`。

Tokenizer rule 是 `{regex, action}` 或本地 `include: "@state"`。Include 必須存在、無循環且符合展開上限，未被引用的 states 也驗證。Action 可為 literal `token` 搭配選填 `next`／`bracket`，或有序 `cases`；分支使用 `@list`、`@eos`，最後必須有且只有一個 `@default`。禁止巢狀 cases 與任意 guard。Transition 只接受現有 `@state`、`@pop`、`@popall`；合法 transition cycle 不等於 include cycle。`@brackets` 要求 tokenizer bracket table，不能另覆寫 `bracket`。

每個 regex 必填 `pattern` 與 `flags`，flags 只能是 `""` 或 `"i"`。Tokenizer 的每筆 flags 必須等於 `ignoreCase ? "i" : ""`；configuration 各筆可獨立選擇。Pattern 是 ECMAScript regex source；正常書寫 literal `@`、`@@`、`@name`、`$`，adapter 會保護其字面語意。`$S`／`$s` 後接數字一律拒絕，即使 escaped 也不例外。拒絕 backreference、lookbehind、不支援語法及無法證明至少消耗一個 code unit 的 tokenizer rule；允許 lookahead。Configuration anchor 可經同一個依用途區分的 validator 接受零寬匹配。

V1 不接受 functions、imports、modules、callbacks、remote resources、external includes、自訂 macros、capture-action arrays、tuple shortcuts、動態 substitution、`@push`、`@rematch`、`goBack`、`switchTo`、`nextEmbedded`、`log`、`unicode`、`includeLF` 或自訂 `start`。字串不會當 JavaScript 執行。

Configuration 可包含 comments、brackets、帶 `notIn` 的 autoClosingPairs、surroundingPairs、indentationRules、onEnterRules、wordPattern。On-enter 縮排動作為 `none`、`indent`、`indentOutdent`、`outdent`。完整欄位及公開 strict schemas `static-language-tokenizer-v1`、`static-language-configuration-v1` 見[正式設計 §2–§4](../superpowers/specs/2026-10-17-plugin-system-2c-static-languages-design.md)。Zod、draft-2020-12 JSON Schema 與 SDK conformance 共用格式；Python 不使用 Python regex 引擎驗證 ECMAScript patterns。

## 固定限制

`STATIC_LANGUAGE_FORMAT_VERSION = 1` 綁定不可變的 `STATIC_LANGUAGE_LIMITS_V1`。插件不能提高上限；格式／限制不相容變更必須新增版本。字串長度計算解碼後 Unicode code points，只有 editor 長行門檻採 UTF-16 code units。資源以原始 UTF-8 bytes 計量，包含 BOM；重複 path 引用每次計費。

| 限制                                     |                              數值 |
| ---------------------------------------- | --------------------------------: |
| Pattern／adapter compiled pattern        |          2,048／4,096 code points |
| 每語言 raw rules／regexes                |                      1,024／1,024 |
| States／keyword lists                    |                            64／32 |
| 每語言 words／每 word 字數               |                         4,096／64 |
| 每 rule cases／on-enter rules            |                            32／32 |
| 每 resource／語言／插件                  | 524,288／786,432／1,048,576 bytes |
| 所有活動資源                             |                   8,388,608 bytes |
| 每語言／全部 expanded rules              |                     8,192／65,536 |
| Include depth                            |                          16 edges |
| 每插件／活動 language ids                |                            8／128 |
| 每 renderer session 註冊過的插件語言 ids |          256；第 257 個需重新啟動 |
| 詞法長行門檻                             |          10,000 UTF-16 code units |

Extensions 為 1–16 筆不重複值，每筆 1–16 個小寫英數字、無前導點。語言 id 符合 `^[a-z][a-z0-9-]{0,31}$`。Aliases 為 1–8 筆不重複單行文字，每筆 1–80 code points；第一筆為標籤，省略時用 id。Token／postfix 最多 80；pair／comment atom 1–16；各配對表最多 32，`notIn` 最多三個不重複值。On-enter `appendText` 最多 256 code points，`removeText` 是 0–256 整數。字串不接受控制字元，但 regex 文字 escape 可表達控制字元匹配。所有 states 與 configuration regex 欄位都納入合計。

## Ownership、純文字與問題回報

解析次序是核心 → 適用 selected binding 的同 owner static → 唯一 global extension → 純文字。核心 JSON／plaintext ids 與 `.json` 保留。Selected binding 的 owner 缺少語法時，不會借用另一插件。沒有適用 binding 時，不同語言共用 extension 使 global mapping ambiguous，不依載入順序選 winner；其他 extensions 與語言註冊仍保留。純靜態 id 重複時排除全部參與者。Alias 不決定 ownership。Frontend 語法失敗仍保留 logical id；同 owner 的 frontend／service／static extension 集合必須相等。

停用、移除或失敗 reload 會把可見、隱藏與 review models 改為純文字，保留內容、undo、draft、cursor、view state；重新啟用後恢復符合條件的已開文件。Lexical revision 與 service epoch 分離；語法失敗不使健康的分析服務 unavailable。Fallback 清除 semantic coloring。Basic Plus Monaco id 為 `bp`，token postfix 保持 `.basic-plus`，keywords、comments、pairs、縮排與主題不變。內建不可停用，回 `PLUGIN_E_BUILTIN_REQUIRED`。

| 問題碼                                  | 意義                                                             |
| --------------------------------------- | ---------------------------------------------------------------- |
| `PLUGIN_E_MANIFEST`                     | 宣告、static runtime 語意或同 owner extension 集合不合法         |
| `PLUGIN_E_STATIC_LANGUAGE`              | 資源、格式、regex、include、I/O 或預算失敗；只拒絕該語言         |
| `PLUGIN_E_STATIC_LANGUAGE_CONFLICT`     | Ownership／id 衝突或 ambiguous／保留 extension；列出所有參與來源 |
| `PLUGIN_E_STATIC_LANGUAGE_REGISTRATION` | Renderer validation、adapter、Monaco 或 session id 上限失敗      |

插件設定顯示 plugin id、`detail.languageId`、相對 `resourcePath`、適用的 `fieldPath`，以及 limit 的 `allowed`／`actual` 或衝突來源。只有 reload 或明確 enable 才重試已隔離 generation，catalog 通知不會造成重試迴圈。本功能不加入 marketplace、theme contributions、file-association UI、glob／filename／first-line 配對或第三方 language-service RPC。
````

- [ ] **Step 5: Update existing architecture/support anchors without rewriting unrelated documentation**

Run this exact edit script from the repository root. Each replacement asserts that the inspected anchor occurs once; a mismatch requires re-reading that owned file, not a broad replacement.

```bash
python3 - <<'PY'
from pathlib import Path

def replace(file, before, after):
    p = Path(file)
    text = p.read_text()
    assert text.count(before) == 1, (file, before)
    p.write_text(text.replace(before, after))

replace('docs/en/language-support.md', '## Basic Plus (`.bp`) — v1', '''## Static editor languages

Trusted development plugins can add lexical coloring and editor configuration through API 1.4.0 static resources. This does not add a compiler or change the implicit `bp` / `ev3-native` project defaults. Unknown files remain Plain Text; JSON uses the core JSON route. Conflicts or unavailable grammars preserve editing and drafts. See [Static language plugins](plugin-static-languages.md) for the format, fixed limits, trust boundary and recovery workflow.

## Basic Plus (`.bp`) — v1''')
replace('docs/zh-TW/language-support.md', '## Basic Plus（`.bp`）— v1', '''## 編輯器靜態語言

可信任的開發插件可透過 API 1.4.0 靜態資源新增詞法上色與編輯器設定，不會新增編譯器或改變隱式專案的 `bp`／`ev3-native` 預設。未知檔案使用純文字，JSON 使用核心路由；衝突或語法不可用仍保留編輯與草稿。格式、固定限制、信任邊界及復原方式見[靜態語言插件](plugin-static-languages.md)。

## Basic Plus（`.bp`）— v1''')
replace('docs/en/architecture.md', 'Phase 1 supports trusted local JS/TS and Python plugins.', 'The development preview supports trusted local JS/TS, Python, and static-only JSON plugins.')
replace('docs/zh-TW/architecture.md', '第一階段支援可信任的本機 JS／TS 與 Python 插件。', '開發預覽支援可信任的本機 JS／TS、Python 與純靜態 JSON 插件。')
replace('docs/en/architecture.md', 'Plugin API **1.3.0** supports compiler frontend and backend declarations and `contributes.diagnosticHelp`.', 'Plugin API **1.4.0** supports static languages, compiler frontend/backend declarations and `contributes.diagnosticHelp`; compatible 1.3.x manifests remain accepted.')
replace('docs/zh-TW/architecture.md', '插件 API **1.3.0** 支援編譯前端、後端與 `contributes.diagnosticHelp` 宣告。', '插件 API **1.4.0** 支援靜態語言、編譯前端／後端與 `contributes.diagnosticHelp`；符合 host range 的 1.3.x manifests 仍接受。')
replace('docs/en/architecture.md', '`<userData>/plugins/session.json` records whether a third-party plugin process ran and whether the window stopped responding;', '`<userData>/plugins/session.json` records whether a third-party plugin process ran, whether `thirdPartyStaticContributions` was delivered, and whether the window stopped responding;')
replace('docs/en/architecture.md', 'and either flag is set, Kobrixa writes a safe-mode lock:', 'and any risk flag is set, Kobrixa writes a safe-mode lock:')
replace('docs/zh-TW/architecture.md', '`<userData>/plugins/session.json` 記錄是否有第三方插件程序執行過、視窗是否停止回應；', '`<userData>/plugins/session.json` 記錄第三方插件程序是否執行過、是否交付 `thirdPartyStaticContributions`、視窗是否停止回應；')
replace('docs/en/architecture.md', 'Static language contributions are reserved for 2C; external language-service RPC is not implemented.', '''Static languages use strict version-1 tokenizer/configuration JSON and the shared protocol validator. Runtime publishes an atomic revisioned catalog; one renderer store and registrar manage all live document and review models. Builtin raw JSON is bundled into main, not fetched from the repository. Catalog revisions are separate from service epochs. The static risk marker is synchronously persisted before third-party delivery and remains sticky until clean exit; write failure blocks that delivery. No static-only process or handshake is started. See [Static language plugins](plugin-static-languages.md) for authoring, conflict resolution, bounded resource accounting and recovery. External language-service RPC is not implemented.''')
replace('docs/zh-TW/architecture.md', '靜態語言貢獻留待 2C，沒有第三方語言服務 RPC。', '''靜態語言使用 strict v1 tokenizer／configuration JSON 與共用 protocol validator。Runtime 原子發布 revisioned catalog，由單一 renderer store／registrar 管理所有文件與 review models；builtin raw JSON 封裝於 main，不從 repository 讀取。Catalog revision 與 service epoch 分離。第三方交付前同步保存 static risk marker，保持 sticky 到正常結束；寫入失敗阻止該交付。純靜態插件不啟動程序或 handshake。作者格式、衝突解析、有界資源計量與復原見[靜態語言插件](plugin-static-languages.md)。沒有第三方語言服務 RPC。''')
PY
```

Keep the historical paragraph “API 1.3.0 adds `contributes.languageServices`”: that records when services were introduced, not the current host version. Do not edit SDK README files (T1 ownership) or samples README (outside T7's write set).

- [ ] **Step 6: Run documentation tests and the complete T7 branch gate**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false
pnpm --filter @kobrixa/plugin-protocol build
pnpm --filter @kobrixa/plugin-runtime build
pnpm exec node --test tests/desktop/static-languages-contract.test.mjs tests/desktop/static-languages-acceptance.test.mjs tests/desktop/static-languages-docs.test.mjs tests/desktop/smoke-harness.test.mjs
pnpm exec prettier --write docs/en/plugin-static-languages.md docs/zh-TW/plugin-static-languages.md docs/en/language-support.md docs/zh-TW/language-support.md docs/en/architecture.md docs/zh-TW/architecture.md tests/desktop/static-languages-docs.test.mjs
pnpm exec prettier --check tests/desktop/static-languages-*.mjs tests/desktop/static-languages-main.ts tests/desktop/fixtures/static-languages/cases.json tests/desktop/preload.cjs tests/desktop/smoke-main.mjs tests/desktop/smoke-harness.test.mjs tests/desktop/highlighting-smoke.mjs tests/desktop/indentation-smoke.mjs tests/desktop/packaged-smoke.mjs docs/en/plugin-static-languages.md docs/zh-TW/plugin-static-languages.md docs/en/language-support.md docs/zh-TW/language-support.md docs/en/architecture.md docs/zh-TW/architecture.md
pnpm exec eslint tests/desktop/static-languages-*.mjs tests/desktop/static-languages-main.ts tests/desktop/preload.cjs tests/desktop/smoke-main.mjs tests/desktop/smoke-harness.test.mjs tests/desktop/highlighting-smoke.mjs tests/desktop/indentation-smoke.mjs tests/desktop/packaged-smoke.mjs
```

Expected: PASS with T0 stubs and fixture bytes. ESLint targets all changed JavaScript/TypeScript; Markdown/JSON use Prettier because the repository has no Markdown/JSON ESLint parser. No desktop build or real acceptance is claimed here. The package builds refresh desktop-consumed `dist/` from the T0 contracts; T7 changes no package source or generated committed files.

T8 runs these exact existing/new entry points after all branches merge and implementations are present:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false
pnpm --filter @kobrixa/plugin-protocol build
pnpm --filter @kobrixa/plugin-runtime build
pnpm -r build
pnpm exec node tests/desktop/static-languages-run.mjs
pnpm test:plugins:smoke
pnpm test:desktop:smoke
pnpm test:desktop:packaged
```

The full protocol/runtime/desktop/schema/SDK/bytecode/web/typecheck checks remain T8's integration responsibilities from part0. T8 also validates the guide's JSON resources using the real protocol validator and public schemas; T7's byte/example equality tests do not substitute for that check.

The controller records the following acceptance evidence in T8's integration record, including platform, command, exit code, observed result, and actual failure reason for anything unrun. Do not write an evidence file outside T7's ownership while this task is active.

| Gate                                  | Required observation after merge                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production IPC and packaged resources | Both raw Basic Plus resources reach the catalog from the bundled main; no resource HTTP fetch; actual copied app works on a machine/container where the repository source directory is absent.                                                                                                                                                                                                                                                                                  |
| Real static-only recovery             | No PID or launcher/handshake; enable/disable/reload works; risk bit is written before initial and post-startup delivery, stays sticky, and clears on clean exit. RF1 marker failure withholds third-party grammar and keeps builtin editing.                                                                                                                                                                                                                                    |
| Next launch after a real hang         | Launch a dedicated test process with the hostile fixture and a parent hard deadline, or deliberately block only its renderer; kill it if needed. Restart with the same isolated profile, verify `renderer-unresponsive` recovery UI is usable, disable the offending source, restore plugins explicitly, and restart again to verify the disable persists. Record this separately from the controller-hook simulation. Never run the hostile pattern in the test runner thread. |
| Hidden models and review              | Open a toy file and another tab, create a real history/conflict review, then disable/reload/remove the toy source. Main, hidden tab and both diff models become plaintext together. Re-enable restores all eligible models without recreation; record content, undo, draft, cursor, selection and view-state preservation. Review with the T7 builtin binding resolves its owner despite extension ambiguity; without binding it remains plaintext.                             |
| Long lines and tokenization state     | Main and both real diff editors report final `maxTokenizationLineLength === 10000` before and after product option updates. Test 9,999/10,000/10,001 UTF-16 units (including non-BMP text) with actual `tokenize`/`tokenizeEncoded` instrumentation from T4/T5, and retain a fixed multiline-state fixture result. Typing, save and undo still work.                                                                                                                            |
| Bootstrap/revisions                   | Block or fail initial IPC: no project model or restored document precedes the barrier; after 5,000 ms it restores plain text and later upgrades. Disable/conflict metadata preceding an old reply cannot revive a stale grammar. Lexical-only changes leave worker binding epoch unchanged.                                                                                                                                                                                     |
| Regression                            | Existing real highlighting/indentation/features/completion smoke passes with `bp`, unchanged `.basic-plus` colors, and unchanged completion thresholds. JSON/unknown extensions, old session/draft restore and renamed files use current routes. Semantic tokens clear on fallback and do not leak to unrelated plain text.                                                                                                                                                     |
| Bilingual UX                          | Exercise both locales: alias/id labels, conflict participants, resource details, static enabled state without PID, required builtin refusal, safe-mode recovery and individual disable persistence. N1 has all three VM platform cases. T8 records whether T5 touched the N2 status row and, if so, its multiline-message test.                                                                                                                                                 |

- [ ] **Step 7: Controller commits subsection 7.4 and closes T7 ownership**

```bash
git add tests/desktop/static-languages-docs.test.mjs docs/en/plugin-static-languages.md docs/zh-TW/plugin-static-languages.md docs/en/language-support.md docs/zh-TW/language-support.md docs/en/architecture.md docs/zh-TW/architecture.md
git commit -m "docs(plugins): document static language format trust and recovery"
```

The executor reports local gate results and stops writing before T8 merges. The controller performs every commit; the Codex sandbox does not.

**Deferred to T8**

- Execute the authored real runtime/controller/Electron and production-packaged acceptance entry points after T1–T6 merge; mocks are branch-local checks only.
- Run the full integration matrix above: real sender checks, actual renderer hang/next-launch UI, repository-absent packaging, real review/hidden-model lifecycle and selected binding, long-line `tokenize`/`tokenizeEncoded` state behavior, bootstrap races, semantic fallback and performance. Record unavailable environments and manual outcomes explicitly.
- Wire new Node tests and `static-languages-run.mjs` into root scripts/CI, validate both guide examples with the real validator/schema, run existing regressions, and resolve any smoke runner's esbuild handling of T6 `?raw` imports in `tests/desktop/run-smoke.mjs` only after ownership hand-off. T7 cannot edit that unowned runner.

**Contract gaps**

- T0 contains no builtin frontend/service fixture for selected-binding disambiguation. T7 defines `builtin` and the complete `LanguageBinding` in `tests/desktop/static-languages-fixtures.mjs` using the frozen `PluginSource.resources` shape and toy resource bytes. The fixture is host-created, never a development manifest claiming builtin identity; its real runtime/resolver check runs in T8. No new product factory/companion is introduced.
- T0 contains no smoke catalog provider, marker-failure injection helper, or installed-app assertion entry. T7 defines these entirely in its new `tests/desktop/static-languages-*` files, using the frozen IPC channels and `SessionMarkerFile.markThirdPartyStaticContributions` hook. These are test-local contracts; no production signature or shared fixture changes are needed.
## Controller Rulings (cross-task)

- R1: After a static language registration failure, an explicit enable of the plugin (and any reload) MUST publish a fresh `generation` for that source. T2 owns this in `packages/plugin-runtime/**`; its implementer must add a test that disable → enable after a reported failure yields a higher generation. T4's quarantine key `(pluginId, sourceKey, generation, languageId)` relies on it. No new IPC retry field.
- R2: `apps/desktop/src/renderer/editor/split-editor.tsx` (and its direct tests) is owned by T8. T8 applies the host `maxTokenizationLineLength: 10000` clamp at its `monaco.editor.create` and `updateOptions` sites.
- R3: `apps/desktop/src/renderer/editor/completion-session.test.ts` (the legacy `monacoLanguage` fixture at line ~37) is owned by T8, which removes the field after T5/T6 merge.
- R4: `tests/desktop/run-smoke.mjs` (esbuild handling of T6 `?raw` imports) and any other unowned runner are owned by T8.
- R5: N2 (2B-2 status-row loader messages) is not done in 2C because T5 did not touch that area. This follows spec §9.3 and is recorded as deferred.
- R6: T2's `CORE_STATIC_LANGUAGE_IDS` is the single core-id list. T8 verifies it against the actual renderer Monaco registrations and fixes T4/T5 core routing to use it.
- R7: T6's local `BasicPlusDynamicCompanion = Omit<...>` may be simplified by T8 after the hand-off.

### Task 8: Integration

This task starts **after all T1–T7 writers stop, pass their branch gates, and hand off their files**. Inherit part0's header, Global Constraints, Review Focus and frozen interfaces; do not introduce another public DTO or retry field. Commands below describe future implementation, not checks performed while drafting this plan. Git mutations are controller-only. No local dependency installation is needed; the existing CI setup performs the frozen install. Prefer returning semantic defects to the original owner, with exclusive ownership during that repair.

**Files:**

- Modify: `package.json`; `.github/workflows/ci.yml`.
- Create: `tools/generate-static-language-core-ids.mjs`; `tools/check-static-language-boundaries.mjs`; generated `apps/desktop/src/renderer/editor/core-static-language-ids.json`; `apps/desktop/src/renderer/editor/core-language-routes.ts`.
- Modify: `apps/desktop/src/renderer/editor/{split-editor.tsx,completion-session.test.ts,static-language-routing.ts,static-language-registration.ts,static-language-bootstrap.ts,language-routing.ts,static-language-migration.test.ts}`; `apps/desktop/src/renderer/editor/companions/basic-plus/companion.ts`.
- Create/test: `apps/desktop/src/renderer/editor/split-editor.test.ts`.
- Create: `tests/desktop/raw-resource-plugin.mjs`; `tests/desktop/static-languages-integration.test.mjs`; `tests/desktop/static-languages-browser.html`; `tests/desktop/static-languages-browser.ts`.
- Modify: `tests/desktop/{run-smoke.mjs,static-languages-run.mjs,static-languages-main.ts,static-languages-harness.mjs,static-languages-docs.test.mjs}`.
- Exclusive original-owner repairs in §8.5a: T2 `packages/plugin-runtime/src/{packaged-json-resource,static-languages}.test.ts`; T4 `apps/desktop/src/renderer/editor/static-language-registration.test.ts`. T8 waits for these reviewed hand-offs.
- Test, retain: T1 protocol/schema/SDK suites; T2 `packaged-json-resource.test.ts`, `static-languages.test.ts`, `manager.static-languages.test.ts`; T3 `controller.test.ts`, `ipc.test.ts`, `session.test.ts`, preload/shared tests; T4's four test files; T5 bootstrap/routing/models/features/semantic/editor/review/settings tests; T6 builtin/theme/migration tests; T7 Node, Electron and packaged smoke entries.

The files above become T8's integration write set only at hand-off. R1 remains T2's required repair/test; T8 verifies it independently. No edits to `language-status.tsx` or its loader-message presentation are planned.

**Interfaces:**

- Consumes: `validateStaticLanguageResources(input: ValidateStaticLanguageResourcesInput): StaticLanguageValidationResult`, `staticLanguageDeclarationProblems(manifest: PluginManifest): string[]`, API `1.4.0`, format/limits version `1` from T1.
- Consumes: `PluginManager.create(options: PluginManagerOptions): Promise<PluginManager>`, `state(): PluginsSnapshot`, `staticLanguages(): StaticLanguagesCatalog`, `setEnabled(sourceKey: string, enabled: boolean)`, `reloadSource(sourceKey: string)`, `reportLanguageRegistrationFailure(input)`, `shutdown()` and `CORE_STATIC_LANGUAGE_IDS: readonly string[]` from T2. Tests call the manager's **`reloadSource`**, while preload calls **`reload`**.
- Consumes: T3 `startPlugins`, `registerPluginIpc`, production `registerIpc` trusted-sender wrapper, production preload `PluginsApi`, complete state events, sticky session marker, report reason/detail validation. Shared/renderer modules retain type-only runtime imports.
- Consumes: T4 `adaptStaticLanguage`, `createStaticLanguageStore`, `createStaticLanguageRegistrar`, `resolveLexicalLanguage`; T5 `bootstrapStaticLanguages`, `routeLanguage`, model hooks and single window lifetime; T6 `BUILTIN_PLUGIN_SOURCES`, raw resources and `initializeEditorThemes`.
- Consumes: T7 `readStaticLanguageFixtures`, `writeStaticLanguageFixtures`, `checkStaticLanguageLifecycle`, `waitForSmokeExit`, existing packaged assertions and bilingual guides.
- Produces, renderer-local: `CORE_LANGUAGE_IDS: ReadonlySet<string>` and `CORE_EXTENSION_ROUTES: Readonly<Record<string, string>>`. The generated JSON is a checked projection of T2's list, never a separately maintained list. Only `.json` is a reserved extension; do not silently adopt Monaco's implicit `.py`, `.ts`, filename or first-line associations.
- Produces, test-only: `rawResourcePlugin()` for esbuild; `runStaticLanguagesBrowserChecks(): Promise<void>`; `test:static-languages`, `test:static-languages:boundaries`, `test:static-languages:smoke`, and `generate:static-language-core-ids` root scripts. No product IPC changes.

#### 8.1 Merge the seven completed task branches

- [ ] **Step 1: Inspect hand-offs before merging**

Run from `/Users/kingsley/Documents/Kobrixa/.claude/worktrees/plugin-2b1`:

```bash
git branch --show-current
git status --short
git worktree list
git log -1 --oneline feat/plugin-2c-t1
git log -1 --oneline feat/plugin-2c-t2
git log -1 --oneline feat/plugin-2c-t3
git log -1 --oneline feat/plugin-2c-t4
git log -1 --oneline feat/plugin-2c-t5
git log -1 --oneline feat/plugin-2c-t6
git log -1 --oneline feat/plugin-2c-t7
```

Expected: target branch `feat/plugin-2c-static-languages`; clean implementation checkout; seven reviewed hand-offs based on the same T0 commit. Verify T2's R1 regression is in its hand-off. Do not merge an actively written branch or discard uncommitted work to manufacture a clean tree.

- [ ] **Step 2: Controller merges in dependency order**

Order: **T1 → T2 → T3 → T4 → T5 → T6 → T7**, matching part0. T5/T6's temporary lexical-field incompatibility is resolved before running desktop checks.

```bash
git switch feat/plugin-2c-static-languages
git merge --no-ff feat/plugin-2c-t1 -m "merge: plugin 2c t1"
git merge --no-ff feat/plugin-2c-t2 -m "merge: plugin 2c t2"
git merge --no-ff feat/plugin-2c-t3 -m "merge: plugin 2c t3"
git merge --no-ff feat/plugin-2c-t4 -m "merge: plugin 2c t4"
git merge --no-ff feat/plugin-2c-t5 -m "merge: plugin 2c t5"
git merge --no-ff feat/plugin-2c-t6 -m "merge: plugin 2c t6"
git merge --no-ff feat/plugin-2c-t7 -m "merge: plugin 2c t7"
git diff --check
```

Run each merge only after the previous command succeeds. Disjoint write sets mean no textual conflicts are expected. If one appears, stop the sequence, run `git diff --name-only --diff-filter=U` and `git status --short`, then controller runs `git merge --abort`. Compare both branches' changes with part0 ownership and the hand-offs; have the responsible owner correct the overlap before retrying that merge. Do not use blanket `ours`/`theirs` resolution. Semantic failures after a clean merge still block integration.

#### 8.2 Close the unowned edits and core-routing gap

- [ ] **Step 1: Pin the missing split-editor clamp**

Create `apps/desktop/src/renderer/editor/split-editor.test.ts`. This checks the literal final property at both actual call sites; §8.5 separately checks real Monaco configuration/tokenization.

```ts
import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";

it("clamps every split create and updateOptions call after other options", () => {
  const source = ts.createSourceFile(
    "split-editor.tsx",
    readFileSync(new URL("./split-editor.tsx", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const seen: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      if (name === "create" || name === "updateOptions") {
        const options = node.arguments[name === "create" ? 1 : 0];
        expect(options && ts.isObjectLiteralExpression(options)).toBe(true);
        if (!options || !ts.isObjectLiteralExpression(options)) throw new Error(name);
        expect(options.properties.at(-1)?.getText(source)).toMatch(
          /^maxTokenizationLineLength:\s*10000$/,
        );
        seen.push(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(seen).toEqual(["create", "updateOptions"]);
});
```

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/split-editor.test.ts`

Expected before the edit: FAIL at the final-property assertion.

- [ ] **Step 2: Apply R2, R3 and R7 with exact replacements**

The following script uses inspected current anchors for R2/R3 and T6's planned post-merge anchor for R7. An anchor mismatch means re-read that file and reconcile the concrete change; never perform an unchecked global deletion of `monacoLanguage` (routes still need it).

```bash
python3 - <<'PY'
from pathlib import Path

def replace(file, before, after):
    p = Path(file)
    text = p.read_text()
    assert text.count(before) == 1, (file, before)
    p.write_text(text.replace(before, after))

replace('apps/desktop/src/renderer/editor/split-editor.tsx',
        '      ariaLabel: zh ? "分割編輯器" : "Split editor",\n',
        '      ariaLabel: zh ? "分割編輯器" : "Split editor",\n      maxTokenizationLineLength: 10000,\n')
replace('apps/desktop/src/renderer/editor/split-editor.tsx',
        '      ...resolveEditorOptions(editorOptions, fontSize, wordWrap, reducedMotion),\n      readOnly,\n',
        '      ...resolveEditorOptions(editorOptions, fontSize, wordWrap, reducedMotion),\n      readOnly,\n      maxTokenizationLineLength: 10000,\n')
replace('apps/desktop/src/renderer/editor/completion-session.test.ts',
        '  monacoLanguage: "basic-plus",\n', '')
file = Path('apps/desktop/src/renderer/editor/companions/basic-plus/companion.ts')
text = file.read_text()
import re
text, count = re.subn(r'type BasicPlusDynamicCompanion\s*=\s*Omit<LanguageCompanion,\s*"monacoLanguage">;\n', '', text)
assert count == 1
assert text.count(': BasicPlusDynamicCompanion =') == 1
file.write_text(text.replace(': BasicPlusDynamicCompanion =', ': LanguageCompanion ='))
PY
```

- [ ] **Step 3: Add the raw-resource esbuild adapter and wire every affected runner**

Create `tests/desktop/raw-resource-plugin.mjs`:

```js
import { readFile } from "node:fs/promises";
import path from "node:path";

export function rawResourcePlugin() {
  return {
    name: "kobrixa-raw-resource",
    setup(build) {
      build.onResolve({ filter: /\?raw$/ }, ({ path: request, resolveDir }) => ({
        path: path.resolve(resolveDir, request.slice(0, -4)),
        namespace: "kobrixa-raw-resource",
      }));
      build.onLoad({ filter: /.*/, namespace: "kobrixa-raw-resource" }, async ({ path: file }) => ({
        contents: await readFile(file, "utf8"),
        loader: "text",
      }));
    },
  };
}
```

In `tests/desktop/run-smoke.mjs` and `tests/desktop/static-languages-run.mjs`, add `import { rawResourcePlugin } from "./raw-resource-plugin.mjs";` and add **`plugins: [rawResourcePlugin()],` to their Node esbuild `await build({ ... })` objects**, immediately after `external: ["electron"],`. Keep the Vite plugins intact. The complete mechanical edit is:

```bash
python3 - <<'PY'
from pathlib import Path
for name in ['run-smoke.mjs', 'static-languages-run.mjs']:
    p = Path('tests/desktop') / name
    text = p.read_text()
    assert text.count('    external: ["electron"],\n') == 1, name
    text = 'import { rawResourcePlugin } from "./raw-resource-plugin.mjs";\n' + text
    p.write_text(text.replace('    external: ["electron"],\n',
        '    external: ["electron"],\n    plugins: [rawResourcePlugin()],\n'))
PY
rg -n 'esbuild|await build\(|builtin-language-resolution|plugins/builtin' tests/desktop/*run*.mjs
```

Expected: every runner that bundles the builtin provider uses this plugin. Other runners stay unchanged unless their reachable imports include T6's raw files; any newly affected runner is T8-owned under R4 and receives the identical import and `plugins` property. Do not use a JSON loader or parse/re-stringify raw resources: BOM and authored UTF-8 byte counts must survive bundling.

- [ ] **Step 4: Generate the browser projection of T2's authoritative list**

Create `tools/generate-static-language-core-ids.mjs`:

```js
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { format } from "prettier";
import { CORE_STATIC_LANGUAGE_IDS } from "../packages/plugin-runtime/dist/index.js";

const file = new URL(
  "../apps/desktop/src/renderer/editor/core-static-language-ids.json",
  import.meta.url,
);
assert.equal(new Set(CORE_STATIC_LANGUAGE_IDS).size, CORE_STATIC_LANGUAGE_IDS.length);
assert.ok(CORE_STATIC_LANGUAGE_IDS.includes("plaintext"));
assert.ok(CORE_STATIC_LANGUAGE_IDS.includes("json"));
const expected = await format(JSON.stringify(CORE_STATIC_LANGUAGE_IDS), { parser: "json" });
if (process.argv.includes("--check")) {
  assert.equal(await readFile(file, "utf8"), expected, "Regenerate the core-id projection from T2");
} else {
  await writeFile(file, expected);
}
```

Create `apps/desktop/src/renderer/editor/core-language-routes.ts`:

```ts
import ids from "./core-static-language-ids.json";

// Generated from runtime; never maintain a second list of installed core ids here.
export const CORE_LANGUAGE_IDS: ReadonlySet<string> = new Set(ids);
if (!CORE_LANGUAGE_IDS.has("plaintext") || !CORE_LANGUAGE_IDS.has("json")) {
  throw new Error("Core language contract is missing plaintext or json");
}
export const CORE_EXTENSION_ROUTES: Readonly<Record<string, string>> = Object.freeze({
  json: ids.find((id) => id === "json")!,
});
```

Apply the following complete glue changes after generating the JSON. T4's registrar protects **all** installed core ids, including ids with no reserved extension; T4/T5 use the same core extension policy. No value import of the Node runtime enters a renderer bundle.

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false
pnpm --filter @kobrixa/plugin-protocol build
pnpm --filter @kobrixa/plugin-runtime build
node tools/generate-static-language-core-ids.mjs
python3 - <<'PY'
from pathlib import Path
base = Path('apps/desktop/src/renderer/editor')
def change(name, before, after, imports):
    p = base / name
    text = p.read_text()
    assert text.count(before) == 1, (name, before)
    p.write_text(imports + text.replace(before, after))
change('static-language-registration.ts',
       'const coreIds = new Set(["plaintext", "json", ...Object.values(coreExtensionRoutes)]);',
       'const coreIds = CORE_LANGUAGE_IDS;',
       'import { CORE_LANGUAGE_IDS } from "./core-language-routes.js";\n')
change('static-language-routing.ts', '    if (id)\n',
       '    if (id && CORE_LANGUAGE_IDS.has(id))\n',
       'import { CORE_LANGUAGE_IDS } from "./core-language-routes.js";\n')
for name in ['static-language-bootstrap.ts', 'language-routing.ts']:
    change(name, 'coreExtensionRoutes: { json: "json" },',
           'coreExtensionRoutes: CORE_EXTENSION_ROUTES,',
           'import { CORE_EXTENSION_ROUTES } from "./core-language-routes.js";\n')
PY
pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/split-editor.test.ts src/renderer/editor/completion-session.test.ts src/renderer/editor/static-language-routing.test.ts src/renderer/editor/static-language-registration.test.ts
pnpm --filter @kobrixa/desktop check
```

Expected: PASS after the seven merges and these edits. §8.5 compares this list with `monaco.languages.getLanguages()` **before registering any plugin shell**; an import/package change must fail there, not silently expand the reservation set.

#### 8.3 Replace fixture boundaries with real validators and catalog data

- [ ] **Step 1: Add one Node integration suite using built packages and real files**

Create `tests/desktop/static-languages-integration.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { PluginManager } from "../../packages/plugin-runtime/dist/index.js";
import { validateStaticLanguageResources } from "../../packages/plugin-protocol/dist/index.js";
import {
  writeStaticLanguageFixtures,
  readStaticLanguageFixtures,
} from "./static-languages-fixtures.mjs";
import { rawResourcePlugin } from "./raw-resource-plugin.mjs";

async function withManager(sources, check) {
  let launches = 0;
  const manager = await PluginManager.create({
    sources,
    store: {
      load: async () => ({ disabled: new Set(), legacyDisabledIds: new Set() }),
      save: async () => {},
    },
    safeMode: false,
    locale: "en",
    launcher: async () => {
      launches++;
      throw new Error("Unexpected process launch");
    },
  });
  try {
    await check(manager);
    assert.equal(launches, 0);
  } finally {
    await manager.shutdown();
  }
}

test("real validation, mixed runtimes, failure quarantine and fresh enable generations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kobrixa-static-real-"));
  try {
    const paths = await writeStaticLanguageFixtures(root);
    const file = path.join(paths.toy, "kobrixa-plugin.json");
    const original = JSON.parse(await readFile(file, "utf8"));
    for (const kind of ["static", "node", "python"]) {
      const manifest = structuredClone(original);
      manifest.runtime = kind === "static" ? { kind } : { kind, entry: "entry.txt" };
      await writeFile(path.join(paths.toy, "entry.txt"), "must not execute");
      await writeFile(file, JSON.stringify(manifest));
      await withManager([{ kind: "development", directory: paths.toy }], async (manager) => {
        const first = manager.staticLanguages();
        const language = first.languages.find((value) => value.id === "toy");
        assert.ok(language);
        assert.equal(manager.state().plugins[0].running, false);
        const report = {
          sourceKey: language.sourceKey,
          generation: language.generation,
          languageId: language.id,
          revision: first.revision,
          reason: "monaco",
          detail: "Integration registration failure",
        };
        assert.equal(manager.reportLanguageRegistrationFailure(report).accepted, true);
        const failed = manager.staticLanguages();
        assert.equal(failed.languages.length, 0);
        assert.equal(manager.reportLanguageRegistrationFailure(report).accepted, false);
        assert.equal(manager.staticLanguages().revision, failed.revision);
        assert.equal((await manager.setEnabled(language.sourceKey, false)).ok, true);
        assert.equal((await manager.setEnabled(language.sourceKey, true)).ok, true);
        const enabled = manager.staticLanguages().languages[0];
        assert.ok(enabled.generation > language.generation, "R1: fresh enable generation");
        assert.equal((await manager.reloadSource(language.sourceKey)).ok, true);
        assert.ok(manager.staticLanguages().languages[0].generation > enabled.generation);
      });
    }
    const forbidden = structuredClone(original);
    forbidden.contributes.languageServices = [];
    await writeFile(file, JSON.stringify(forbidden));
    await withManager([{ kind: "development", directory: paths.toy }], async (manager) => {
      const row = manager.state().plugins[0];
      assert.equal(row.status, "invalid");
      assert.ok(row.problems.some((p) => p.code === "PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN"));
    });
    await writeFile(file, JSON.stringify(original));
    const resource = path.join(paths.toy, "language/tokenizer.json");
    const raw = await readFile(resource, "utf8");
    await writeFile(resource, "\uFEFF" + raw);
    await withManager([{ kind: "development", directory: paths.toy }], async (manager) => {
      assert.equal(
        manager.staticLanguages().languages[0].resourceBytes.tokenizer,
        Buffer.byteLength(raw, "utf8") + 3,
      );
    });
    const invalid = JSON.parse(raw);
    invalid.states[0].rules[0].regex.pattern = String.raw`\$S1`;
    await writeFile(resource, JSON.stringify(invalid));
    await withManager([{ kind: "development", directory: paths.toy }], async (manager) => {
      assert.equal(manager.staticLanguages().languages.length, 0);
      assert.equal(manager.state().plugins[0].status, "enabled");
      assert.ok(
        manager
          .state()
          .plugins[0].problems.some(
            (p) => p.code === "PLUGIN_E_STATIC_LANGUAGE" && p.detail.languageId === "toy",
          ),
      );
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("frontend reservation and extension conflicts are independent of source order", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kobrixa-static-conflict-"));
  try {
    const paths = await writeStaticLanguageFixtures(root);
    const { builtin, binding } = await readStaticLanguageFixtures();
    const broken = structuredClone(builtin);
    broken.resources["language/tokenizer.json"] = "{}";
    const sources = [
      broken,
      { kind: "development", directory: paths.toy },
      { kind: "development", directory: paths.shared },
    ];
    let expected;
    for (const order of [sources, [...sources].reverse()]) {
      await withManager(order, async (manager) => {
        const catalog = manager.staticLanguages();
        assert.equal(catalog.extensionRoutes.toy, null);
        assert.equal(
          catalog.languages.some((value) => value.id === binding.language),
          false,
        );
        const normalized = {
          ids: catalog.languages.map((value) => value.id).sort(),
          conflicts: catalog.conflicts
            .map((value) => [
              value.kind,
              value.key,
              value.sources.map((source) => source.pluginId).sort(),
            ])
            .sort(),
        };
        if (expected) assert.deepEqual(normalized, expected);
        expected = normalized;
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shipped raw resources pass the real validator and esbuild preserves their bytes", async () => {
  const base = new URL("../../plugins/basic-plus/", import.meta.url);
  const tokenizer = await readFile(new URL("language/tokenizer.json", base), "utf8");
  const configuration = await readFile(new URL("language/configuration.json", base), "utf8");
  const result = validateStaticLanguageResources({
    languageId: "bp",
    formatVersion: 1,
    limitsVersion: 1,
    tokenizer: JSON.parse(tokenizer),
    configuration: JSON.parse(configuration),
    resourceBytes: {
      tokenizer: Buffer.byteLength(tokenizer),
      configuration: Buffer.byteLength(configuration),
    },
    resourcePaths: {
      tokenizer: "language/tokenizer.json",
      configuration: "language/configuration.json",
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual([result.rules, result.regexes, result.expandedRules], [9, 11, 9]);
  const bundled = await build({
    stdin: {
      contents: 'export { default } from "./plugins/basic-plus/language/tokenizer.json?raw";',
      resolveDir: process.cwd(),
      loader: "js",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    plugins: [rawResourcePlugin()],
  });
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
  );
  assert.equal(module.default, tokenizer);
});
```

Run: `node --test tests/desktop/static-languages-integration.test.mjs`

Expected: real validators/catalog lifecycle pass; R1 fails before the T2 repair. These are additional boundary tests, not replacements for T2's explicit orchestration doubles, injected I/O deadlines, aggregate budgets or race tests.

- [ ] **Step 2: Make the existing migration parity test use the real adapter and host DTO**

In `static-language-migration.test.ts`, remove the entire local `basicPlusFixtureDefinition` function (from its declaration up to `const legacyDefinition`). Retain the independent `legacyDefinition`, `monarch`, `spans`, samples and all expected spans. Add these imports and this helper:

```ts
import { PluginManager } from "@kobrixa/plugin-runtime";
import { validateStaticLanguageResources } from "@kobrixa/plugin-protocol";
import { BUILTIN_PLUGIN_SOURCES } from "../../main/plugins/builtin.js";
import { adaptStaticLanguage } from "./static-language-adapter.js";

async function realBasicPlusDefinition(): Promise<languages.IMonarchLanguage> {
  const manager = await PluginManager.create({
    sources: BUILTIN_PLUGIN_SOURCES,
    store: {
      load: async () => ({ disabled: new Set<string>(), legacyDisabledIds: new Set<string>() }),
      save: async () => {},
    },
    safeMode: false,
    locale: "en",
    launcher: async () => {
      throw new Error("Static loading must not launch a plugin");
    },
  });
  try {
    const value = manager.staticLanguages().languages.find((language) => language.id === "bp");
    expect(value).toBeDefined();
    if (!value) throw new Error("No host-produced Basic Plus DTO");
    const validated = validateStaticLanguageResources({
      languageId: value.id,
      formatVersion: 1,
      limitsVersion: 1,
      tokenizer: value.tokenizer,
      configuration: value.configuration,
      resourceBytes: value.resourceBytes,
    });
    expect(validated).toMatchObject({ ok: true, rules: 9, regexes: 11, expandedRules: 9 });
    return adaptStaticLanguage(value).tokenizer;
  } finally {
    await manager.shutdown();
  }
}
```

Replace both `const current = await monarch("bp", basicPlusFixtureDefinition(wire));` lines with `const current = await monarch("bp", await realBasicPlusDefinition());`. Remove the two now-unused `wire` declarations, `tokenizerFile`, `repository` (if no remaining use), and the `StaticLanguageTokenizerV1` type import. T6's existing `vi.mock("monaco-editor", ...)` must expose the real configuration enum as well as the spy methods:

```ts
vi.mock("monaco-editor", () => ({
  languages: {
    ...lexicalCalls,
    IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 },
  },
}));
```

Only the window-facing namespace is a double here; the validator, runtime catalog, T4 adapter and imported Monarch compiler/tokenizer are real. Runtime value imports in this Node-only `.test.ts` are test dependencies, never imported by the shipped renderer. The browser test below supplies the real window-facing Monaco namespace too.

- [ ] **Step 3: Validate both guide examples and use real catalog data in ordinary UI smoke**

Append to `tests/desktop/static-languages-docs.test.mjs`:

````js
import {
  pluginManifestSchema,
  staticLanguageDeclarationProblems,
  validateStaticLanguageResources,
} from "../../packages/plugin-protocol/dist/index.js";

for (const locale of ["en", "zh-TW"]) {
  test(`${locale} examples pass the actual schema and resource validator`, async () => {
    const text = await readFile(
      new URL(`../../docs/${locale}/plugin-static-languages.md`, import.meta.url),
      "utf8",
    );
    const blocks = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => match[1]);
    assert.equal(blocks.length, 3);
    const manifest = pluginManifestSchema.parse(JSON.parse(blocks[0]));
    assert.deepEqual(staticLanguageDeclarationProblems(manifest), []);
    const declaration = manifest.contributes.languages[0];
    const result = validateStaticLanguageResources({
      languageId: declaration.id,
      formatVersion: 1,
      limitsVersion: 1,
      tokenizer: JSON.parse(blocks[1]),
      configuration: JSON.parse(blocks[2]),
      resourceBytes: {
        tokenizer: Buffer.byteLength(blocks[1]),
        configuration: Buffer.byteLength(blocks[2]),
      },
      resourcePaths: {
        tokenizer: declaration.tokenizer.path,
        configuration: declaration.configuration.path,
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
  });
}
````

Replace `basicPlusSmokeCatalog` in `static-languages-harness.mjs` with the following function, adding the two imports. Keep the harness mock and fixture tests explicitly labeled as such; they remain useful for event-shape checks.

```js
import { readFile } from "node:fs/promises";
import { PluginManager } from "../../packages/plugin-runtime/dist/index.js";

export async function basicPlusSmokeCatalog() {
  const base = new URL("../../plugins/basic-plus/", import.meta.url);
  const manager = await PluginManager.create({
    sources: [
      {
        kind: "builtin",
        manifest: JSON.parse(await readFile(new URL("kobrixa-plugin.json", base), "utf8")),
        resources: {
          "language/tokenizer.json": await readFile(
            new URL("language/tokenizer.json", base),
            "utf8",
          ),
          "language/configuration.json": await readFile(
            new URL("language/configuration.json", base),
            "utf8",
          ),
        },
      },
    ],
    store: {
      load: async () => ({ disabled: new Set(), legacyDisabledIds: new Set() }),
      save: async () => {},
    },
    safeMode: false,
    locale: "en",
    launcher: async () => {
      throw new Error("Unexpected static launch");
    },
  });
  try {
    const catalog = manager.staticLanguages();
    if (!catalog.languages.some((language) => language.id === "bp"))
      throw new Error("Missing Basic Plus catalog");
    return catalog;
  } finally {
    await manager.shutdown();
  }
}
```

Remove the now-unused `createHash`/`readStaticLanguageFixtures` imports from that harness if they have no other references. Do not force a fake revision or digest to preserve a fixture assertion: Node contract tests should assert positive revision, valid owners and catalog consistency. Run the existing T7 contract/docs tests and the migration test; all must pass with real data.

#### 8.4 Exercise real Electron IPC, including the trusted-sender wrapper

- [ ] **Step 1: Upgrade T7's controller-only entry to production preload and IPC**

In `tests/desktop/static-languages-main.ts`, replace the Electron import with `import { app, BrowserWindow } from "electron";`, remove the `IpcHandle` import, and add:

```ts
import { registerIpc } from "../../apps/desktop/src/main/ipc.js";
import { BUILTIN_PLUGIN_SOURCES } from "../../apps/desktop/src/main/plugins/builtin.js";
```

Replace `builtins: [input.builtin],` with `builtins: phase === "browser" ? BUILTIN_PLUGIN_SOURCES : [input.builtin],`. Replace the entire local `handlers`/`handle`/`off`/`invoke`/`api` block, stopping before `const markerFile`, with this complete block:

```ts
const rendererUrl = process.argv.at(-3)!;
const windowOptions = {
  show: false,
  webPreferences: {
    preload: path.join(directory, "preload.cjs"),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  },
};
const win = new BrowserWindow(windowOptions);
type RegisterArgs = Parameters<typeof registerIpc>;
// Unused product-service fixtures let us install the actual trust wrapper.
// No plugin, IPC, validator, catalog or renderer-language implementation is mocked.
registerIpc(
  () => win.webContents,
  {} as RegisterArgs[1],
  {} as RegisterArgs[2],
  {} as RegisterArgs[3],
  {} as RegisterArgs[4],
  {} as RegisterArgs[5],
  {} as RegisterArgs[6],
  undefined,
  undefined,
  undefined,
  [
    (handle) => {
      const unsubscribe = registerPluginIpc(handle, plugins, (event) => {
        if (!win.isDestroyed()) win.webContents.send("plugins:event", event);
      });
      app.on("will-quit", unsubscribe);
    },
  ],
);
await win.loadURL(phase === "browser" ? rendererUrl : "about:blank");
const call = <T>(method: string, ...args: unknown[]): Promise<T> =>
  win.webContents.executeJavaScript(
    `window.kobrixa.plugins[${JSON.stringify(method)}](...${JSON.stringify(args)})`,
  ) as Promise<T>;
const api: Pick<
  PluginsApi,
  "state" | "staticLanguages" | "reportLanguageRegistrationFailure" | "setEnabled" | "reload"
> = {
  state: () => call("state"),
  staticLanguages: () => call("staticLanguages"),
  reportLanguageRegistrationFailure: (report) => call("reportLanguageRegistrationFailure", report),
  setEnabled: (key, enabled) => call("setEnabled", key, enabled),
  reload: (key) => call("reload", key),
};
if (phase === "lifecycle") {
  const stranger = new BrowserWindow(windowOptions);
  try {
    await stranger.loadURL("about:blank");
    for (const method of ["staticLanguages", "reportLanguageRegistrationFailure"]) {
      await assert.rejects(
        stranger.webContents.executeJavaScript(`window.kobrixa.plugins.${method}({})`),
        /untrusted sender/,
      );
    }
  } finally {
    stranger.destroy();
  }
  for (const detail of [
    "/private/plugin/tokenizer.json",
    "C:\\plugin\\tokenizer.json",
    "x".repeat(2049),
  ]) {
    await assert.rejects(
      api.reportLanguageRegistrationFailure({
        sourceKey: "development:forged",
        generation: 1,
        languageId: "toy",
        revision: 1,
        reason: "monaco",
        detail,
      }),
    );
  }
}
```

Insert the browser phase at the existing lifecycle dispatch using this exact edit. Its anchor distinguishes dispatch from the preceding sender-check block:

```bash
python3 - <<'PY'
from pathlib import Path
p = Path('tests/desktop/static-languages-main.ts')
text = p.read_text()
before = '  if (phase === "lifecycle") {\n    await checkStaticLanguageLifecycle'
after = ('  if (phase === "browser") {\n'
         '    await win.webContents.executeJavaScript("window.staticAcceptance");\n'
         '  } else if (phase === "lifecycle") {\n    await checkStaticLanguageLifecycle')
assert text.count(before) == 1
p.write_text(text.replace(before, after))
PY
```

Keep every existing conflict, marker-failure, crash and recovery assertion. The API now traverses the production preload, Electron serialization, actual trusted wrapper, report parser, controller and manager. T3's subframe rejection unit test remains necessary: a second BrowserWindow is a foreign sender, not a forged subframe. The `hang` phase still simulates the controller event; it must not be reported as an actual renderer-hang UI pass.

- [ ] **Step 2: Build the production preload and serve the integration page in T7's runner**

In `tests/desktop/static-languages-run.mjs`, add `import { createServer } from "vite";`. Immediately before `let passed = false;`, add:

```js
const server = await createServer({
  root: path.join(root, "apps/desktop"),
  configFile: path.join(root, "apps/desktop/vite.renderer.config.ts"),
  server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
});
```

At the beginning of the existing `try`, add:

```js
await server.listen();
const address = server.httpServer.address();
assert.ok(address && typeof address !== "string");
const rendererUrl = `http://127.0.0.1:${address.port}/@fs/${path.join(root, "tests/desktop/static-languages-browser.html")}`;
await build({
  entryPoints: [path.join(root, "apps/desktop/src/preload/index.ts")],
  outfile: path.join(directory, "preload.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
});
```

Replace the child argument array with `[main, \`--user-data-dir=${profile}\`, rendererUrl, directory, phase]`. Replace the first phase list with `["browser", "lifecycle", "conflicts", "cli-safe"]`. Add `await server.close();`as the first statement of the existing`finally`. Keep the existing parent deadline and failure artifacts; never replace it with a Promise timeout around synchronous regex execution.

#### 8.5 One browser integration entry for the real store, registrar, adapter and Monaco

- [ ] **Step 1: Create the complete browser entry**

Create `tests/desktop/static-languages-browser.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Static language integration</title>
  </head>
  <body>
    <script type="module" src="./static-languages-browser.ts"></script>
  </body>
</html>
```

Create `tests/desktop/static-languages-browser.ts`:

```ts
import * as monaco from "monaco-editor";
import { createStaticLanguageStore } from "../../apps/desktop/src/renderer/editor/static-language-store.js";
import { createStaticLanguageRegistrar } from "../../apps/desktop/src/renderer/editor/static-language-registration.js";
import { bootstrapStaticLanguages } from "../../apps/desktop/src/renderer/editor/static-language-bootstrap.js";
import {
  CORE_LANGUAGE_IDS,
  CORE_EXTENSION_ROUTES,
} from "../../apps/desktop/src/renderer/editor/core-language-routes.js";
import { resolveLexicalLanguage } from "../../apps/desktop/src/renderer/editor/static-language-routing.js";
import { initializeEditorThemes } from "../../apps/desktop/src/renderer/editor/editor-theme.js";
import type { PluginsApi } from "../../apps/desktop/src/shared/plugins.js";
import type { StaticLanguagesCatalog } from "../../apps/desktop/src/shared/static-languages.js";

declare global {
  interface Window {
    staticAcceptance: Promise<void>;
  }
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function equal(a: unknown, b: unknown, message: string): void {
  assert(
    JSON.stringify(a) === JSON.stringify(b),
    `${message}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`,
  );
}
async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!check()) {
    assert(performance.now() < deadline, "Timed out waiting for catalog/model reconciliation");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function container(): HTMLDivElement {
  const element = document.createElement("div");
  element.style.cssText = "width:600px;height:240px";
  document.body.append(element);
  return element;
}

export async function runStaticLanguagesBrowserChecks(): Promise<void> {
  equal(
    monaco.languages
      .getLanguages()
      .map((language) => language.id)
      .sort(),
    [...CORE_LANGUAGE_IDS].sort(),
    "Installed Monaco core ids before plugin registration",
  );
  initializeEditorThemes(monaco.editor);
  const api = window.kobrixa.plugins;
  const pending: {
    resolve?: (catalog: StaticLanguagesCatalog) => void;
    catalog?: StaticLanguagesCatalog;
  } = {};
  let holdNext = false;
  const storeApi: Pick<PluginsApi, "state" | "staticLanguages" | "onEvent"> = {
    state: () => api.state(),
    onEvent: (listener) => api.onEvent(listener),
    staticLanguages: async () => {
      const catalog = await api.staticLanguages();
      if (!holdNext) return catalog;
      holdNext = false;
      pending.catalog = catalog;
      return new Promise((resolve) => {
        pending.resolve = resolve;
      });
    },
  };
  const store = createStaticLanguageStore(storeApi);
  const counts = new Map<string, number>();
  let failToyConfiguration = false;
  let configurations = 0;
  const observedMonaco = {
    ...monaco,
    languages: {
      ...monaco.languages,
      register: (language: { id: string }) => {
        counts.set(language.id, (counts.get(language.id) ?? 0) + 1);
        monaco.languages.register(language);
      },
      setLanguageConfiguration: (
        id: string,
        configuration: monaco.languages.LanguageConfiguration,
      ) => {
        if (id === "toy") {
          configurations++;
          if (failToyConfiguration) {
            failToyConfiguration = false;
            throw new Error("Integration fixture: second-half registration failure");
          }
        }
        return monaco.languages.setLanguageConfiguration(id, configuration);
      },
    },
  };
  const registrar = createStaticLanguageRegistrar({
    monaco: observedMonaco,
    store,
    api,
    coreExtensionRoutes: CORE_EXTENSION_ROUTES,
  });
  const models: monaco.editor.ITextModel[] = [];
  const disposables: { dispose(): void }[] = [];
  const elements: HTMLElement[] = [];
  try {
    equal(
      (await bootstrapStaticLanguages({ store, registrar })).kind,
      "ready",
      "Real IPC bootstrap",
    );
    const catalog = await api.staticLanguages();
    const toy = catalog.languages.find((language) => language.id === "toy");
    assert(toy, "Real toy language missing");
    const make = (file: string) => {
      const model = monaco.editor.createModel(
        "value 1\n",
        "plaintext",
        monaco.Uri.parse(`file:///integration/${file}`),
      );
      models.push(model);
      disposables.push(registrar.trackModel(model, () => ({ file })));
      return model;
    };
    const main = make("main.toy");
    const hidden = make("hidden.toy");
    const original = make("original.toy");
    const modified = make("modified.toy");
    const host = container(),
      splitHost = container(),
      diffHost = container();
    elements.push(host, splitHost, diffHost);
    const editor = monaco.editor.create(host, { model: main, maxTokenizationLineLength: 10000 });
    const split = monaco.editor.create(splitHost, {
      model: main,
      maxTokenizationLineLength: 10000,
    });
    const diff = monaco.editor.createDiffEditor(diffHost, { maxTokenizationLineLength: 10000 });
    disposables.push(editor, split, diff);
    diff.setModel({ original, modified });
    await until(() => models.every((model) => model.getLanguageId() === "toy"));
    editor.setPosition({ lineNumber: 1, column: 1 });
    editor.executeEdits("integration", [{ range: new monaco.Range(1, 1, 1, 1), text: "draft " }]);
    editor.pushUndoStop();
    const edited = main.getValue();
    const position = editor.getPosition();
    const selection = editor.getSelection();
    const view = editor.saveViewState();

    holdNext = true;
    const staleRequest = store.refresh();
    await until(() => pending.resolve !== undefined);
    assert((await api.setEnabled(toy.sourceKey, false)).ok, "Disable failed");
    await until(() => models.every((model) => model.getLanguageId() === "plaintext"));
    const late = make("late-review.toy");
    equal(late.getLanguageId(), "plaintext", "New model after revocation");
    assert(pending.catalog && pending.resolve, "No held response");
    pending.resolve(pending.catalog);
    await staleRequest;
    equal(
      models.map((model) => model.getLanguageId()),
      models.map(() => "plaintext"),
      "Stale response cannot revive models",
    );
    equal(main.getValue(), edited, "Text retained");
    equal(editor.getPosition(), position, "Cursor retained");
    equal(editor.getSelection(), selection, "Selection retained");
    equal(editor.saveViewState(), view, "View state retained");
    assert(
      editor.getModel() === main && split.getModel() === main,
      "Shared model identity retained",
    );
    assert(hidden === models[1], "Hidden model identity retained");
    assert((await api.setEnabled(toy.sourceKey, true)).ok, "Enable failed");
    await until(() => models.every((model) => model.getLanguageId() === "toy"));
    editor.trigger("integration", "undo", null);
    equal(main.getValue(), "value 1\n", "Undo stack retained through disable/enable");

    failToyConfiguration = true;
    assert((await api.reload(toy.sourceKey)).ok, "Reload failed");
    await until(() => registrar.resolve({ file: "main.toy" }).monacoLanguage === "plaintext");
    await until(
      () => !store.getSnapshot().catalog.languages.some((language) => language.id === "toy"),
    );
    const attempts = configurations;
    await store.refresh();
    await store.refresh();
    equal(configurations, attempts, "Quarantine cannot retry on catalog refresh");
    assert((await api.setEnabled(toy.sourceKey, false)).ok, "Disable quarantined source");
    assert((await api.setEnabled(toy.sourceKey, true)).ok, "Enable quarantined source");
    await until(() => models.every((model) => model.getLanguageId() === "toy"));
    equal(counts.get("toy"), 1, "Register one shell across failed generations");
    assert(
      (await api.staticLanguages()).languages.find((language) => language.id === "toy")!
        .generation > toy.generation,
      "Recovery must publish a fresh generation",
    );

    const current = store.getSnapshot();
    const binding = {
      epoch: 1,
      pluginId: "kobrixa-smoke.missing",
      sourceKey: "builtin:kobrixa-smoke.missing",
      language: "missing",
      extensions: ["toy"],
      capabilities: ["analysis" as const],
      frontend: {
        language: "missing",
        entryExtensions: ["toy"],
        sourceExtensions: ["toy"],
        ir: { min: 1, max: 1 },
      },
    };
    equal(
      resolveLexicalLanguage({
        file: "main.toy",
        binding,
        catalog: current.catalog,
        activeOwners: current.owners,
        coreExtensionRoutes: CORE_EXTENSION_ROUTES,
      }).monacoLanguage,
      "plaintext",
      "Missing selected owner must not borrow the unique global toy route",
    );
    equal(registrar.resolve({ file: "main.JSON" }).monacoLanguage, "json", "Core route");
    equal(registrar.resolve({ file: "main.unknown" }).monacoLanguage, "plaintext", "Unknown route");

    // Pinned internal API: public editor.tokenize alone does not test tokenizeEncoded.
    // @ts-expect-error Monaco's pinned private JS module has no public declaration.
    const { TokenizationRegistry } = await import("monaco-editor/editor/common/languages.js");
    const support = await TokenizationRegistry.getOrCreate("bp");
    assert(support, "Basic Plus tokenizer support");
    const bp = make("long.bp");
    editor.setModel(bp);
    split.setModel(bp);
    monaco.editor.setModelLanguage(original, "bp");
    monaco.editor.setModelLanguage(modified, "bp");
    const editors = [editor, split, diff.getOriginalEditor(), diff.getModifiedEditor()];
    for (const pane of editors) {
      pane.updateOptions({ fontSize: 17, maxTokenizationLineLength: 10000 });
      const internal = pane as typeof pane & {
        _configurationService: {
          getValue(key: string, overrides: { overrideIdentifier: string }): number;
        };
      };
      equal(
        internal._configurationService.getValue("editor.maxTokenizationLineLength", {
          overrideIdentifier: "bp",
        }),
        10000,
        "Actual Monaco configuration after updateOptions",
      );
    }
    for (const length of [9999, 10000, 10001]) {
      const line = '"' + "x".repeat(length - 1);
      for (const model of [bp, original, modified]) model.setValue(line + "\nIf True Then");
      const state = support.getInitialState();
      const classic = support.tokenize(line, true, state);
      const encoded = support.tokenizeEncoded(line, true, state);
      equal(
        classic.tokens[0].type,
        length < 10000 ? "string.invalid.basic-plus" : "",
        "Classic >= boundary",
      );
      if (length >= 10000) {
        assert(classic.endState.equals(state), "Skipped line preserves incoming state");
        assert(encoded.endState.equals(state), "Encoded skipped line preserves incoming state");
        equal(encoded.tokens.length, 2, "One default encoded token on skipped line");
      }
      equal(
        support.tokenize("If True Then", true, classic.endState).tokens[0].type,
        "keyword.control.basic-plus",
        "Fixed root-state continuation fixture",
      );
      const expected = bp.getValue();
      editor.setPosition({ lineNumber: 2, column: 1 });
      editor.trigger("integration", "type", { text: "x" });
      editor.trigger("integration", "undo", null);
      equal(bp.getValue(), expected, "Long-line document remains editable and undoable");
    }
    const astral = '"' + "😀".repeat(4999) + "x";
    equal(astral.length, 10000, "UTF-16 boundary");
    equal(
      support.tokenize(astral, true, support.getInitialState()).tokens[0].type,
      "",
      "Astral line skips",
    );
    console.log("PASS real static IPC/store/registrar/Monaco integration");
  } finally {
    for (const disposable of disposables.reverse()) disposable.dispose();
    for (const model of models) model.dispose();
    registrar.dispose();
    store.dispose();
    for (const element of elements) element.remove();
  }
}
window.staticAcceptance = runStaticLanguagesBrowserChecks();
```

This is a test-only dependency on Monaco 0.57.0. Do not add it to production code. The Node parent's deadline can terminate the Electron process; no hostile patterns execute in Vitest. A finite smoke timeout is not a claim of ReDoS safety.

- [ ] **Step 2: Extend migration tests with actual validator/adapter macro and transformed-size boundaries**

Append to `static-language-migration.test.ts`; the existing file already imports `expect`, `it`, `languages` and the real validator/adapter after §8.3. Add the type-only import below:

```ts
import type { ValidatedStaticLanguage } from "../../shared/static-languages.js";

it("validates real macro literals and the 4096 transformed-source boundary before Monaco", async () => {
  const compilerPath = "monaco-editor/editor/standalone/common/monarch/monarchCompile.js";
  const { compile } = (await import(compilerPath)) as {
    compile(
      id: string,
      source: languages.IMonarchLanguage,
    ): {
      tokenizer: Record<string, { regex: RegExp }[]>;
    };
  };
  function value(pattern: string): ValidatedStaticLanguage {
    const tokenizer = {
      ignoreCase: false,
      states: [
        {
          name: "root",
          rules: [{ regex: { pattern, flags: "" as const }, action: { token: "identifier" } }],
        },
      ],
    };
    return {
      id: "integration-literal",
      pluginId: "acme.literal",
      sourceKey: "development:literal",
      generation: 1,
      extensions: ["literal"],
      aliases: ["😀".repeat(80)],
      resourceDigest: "test",
      tokenizer,
      configuration: {},
      expandedRules: 1,
      resourceBytes: { tokenizer: Buffer.byteLength(JSON.stringify(tokenizer)), configuration: 2 },
    };
  }
  for (const pattern of [
    "@",
    "@@",
    "@name",
    String.raw`\@`,
    String.raw`\$`,
    "a(?=b)",
    "@".repeat(2045) + "a",
  ]) {
    const dto = value(pattern);
    const definition = adaptStaticLanguage(dto);
    const rule = compile(dto.id, definition.tokenizer).tokenizer.root![0]!;
    for (const input of ["@", "@@", "@name", "\\@", "$", "ab", "@".repeat(2045) + "a"])
      expect(rule.regex.exec(input)?.[0]).toBe(new RegExp(`^(?:${pattern})`).exec(input)?.[0]);
  }
  const atLimit = "@".repeat(2045) + "a";
  expect(Array.from(`^(?:${atLimit.replaceAll("@", "@@")})`)).toHaveLength(4096);
  for (const pattern of [
    "@".repeat(2046),
    String.raw`\$S1`,
    "$s2",
    "a*",
    "(?<=a)b",
    String.raw`(a)\1`,
  ])
    expect(() => adaptStaticLanguage(value(pattern)), pattern).toThrow();
  const anchor = value(".");
  anchor.configuration = {
    indentationRules: {
      increaseIndentPattern: { pattern: "^", flags: "" },
      decreaseIndentPattern: { pattern: "^$", flags: "i" },
    },
  };
  anchor.resourceBytes.configuration = Buffer.byteLength(JSON.stringify(anchor.configuration));
  expect(
    adaptStaticLanguage(anchor).configuration.indentationRules!.increaseIndentPattern.source,
  ).toBe("^");
});
```

Synthetic DTO bytes here represent the actual serialized test resource; shipped-resource byte tests still use original raw files. Non-BMP declaration/schema limits remain T1's test responsibility; this test only carries an accepted alias through adaptation.

- [ ] **Step 3: Run focused integration and retained race suites**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false
pnpm --filter @kobrixa/plugin-protocol build
pnpm --filter @kobrixa/plugin-runtime build
pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/static-language-adapter.test.ts src/renderer/editor/static-language-store.test.ts src/renderer/editor/static-language-registration.test.ts src/renderer/editor/static-language-routing.test.ts src/renderer/editor/static-language-migration.test.ts src/renderer/editor/static-language-bootstrap.test.ts src/renderer/editor/editor.test.ts src/renderer/editor/model-language-route.test.ts src/renderer/editor/language-features.test.ts src/renderer/editor/semantic-tokens.test.ts src/renderer/workspace/file-review-dialog.test.ts
node --test tests/desktop/static-languages-integration.test.mjs tests/desktop/static-languages-contract.test.mjs tests/desktop/static-languages-acceptance.test.mjs tests/desktop/static-languages-docs.test.mjs tests/desktop/smoke-harness.test.mjs
node tests/desktop/static-languages-run.mjs
```

Expected: PASS. The retained unit tests supply adversarial scheduling, failed/latest fetch, same-revision bootstrap recovery, session ids 256/257, StrictMode replay, process crash versus whole-plugin isolation, semantic detach and worker guards. The new browser entry proves real boundary compatibility and shared-model state preservation. It deliberately does not claim that constructing a diff editor in this page exercises the application's `FileReviewDialog` or `SplitEditor` React wiring; those retained tests and the manual acceptance list cover the actual consumers.

#### 8.5a Close P5 with an executable boundary ledger

This gate is mandatory before acceptance. T1 owns the structural corpus and pure validator tests in part1; T2 owns reader/catalog tests; T4 owns registrar tests; T8 owns this runner and real Monaco checks. The T2/T4 additions below are **exclusive original-owner repairs after hand-off**: the controller assigns those files back to that owner, merges the repair, then resumes T8. T8 never writes an active owner's files. Do not change the frozen interfaces or limits to make a fixture pass.

For a range `m..N`, part1's shared corpus executes distinct `0`, `max(0,m-1)`, `m`, `max(1,m)`, `N-1`, `N`, `N+1` samples (duplicates removed). Array entries are distinct wherever uniqueness is meaningful. Empty optional collections and omitted fields remain separately legal; empty static contributions remain semantically invalid without diagnostic help. A schema pass proves structure; reference/uniqueness/aggregate semantics use the public validator tests.

| Effective §2–§4 bound | Executable cases / exceptions | Owner and exact test file(s) |
| --- | --- | --- |
| Languages 0..8; static runtime requires ≥1 contribution; resource version exactly 1 | `languages`, `resourceVersion`; static empty/help-only and version 0/1/2 cases | T1 `packages/plugin-protocol/src/static-language-manifest.test.ts`, `conformance.test.ts` |
| Language id 1..32; extensions 1..16 items, text 1..16; aliases optional or 1..8 items, text 1..80 code points | `id`, `extensions`, `extensionText`, `aliases`, `aliasText`; astral alias strings, omitted aliases and semantic uniqueness | T1 same files |
| Resource path 0..7 directories, directory segment/stem 1..64, effective length 6..524; declared cap 600 | `pathDepth`, `directorySegment`, `fileStem`, `pathLength` for both resources. 523/524 pass, 525 fails. 599/600/601 all fail the grammar; `json-schema.test.ts` still asserts `maxLength:600`. No impossible 600-character positive fixture. `.json` adds 5 beyond the stem's 64. | T1 same files plus `json-schema.test.ts` |
| States 1..64; state/list names 1..32; include/next/when references 2..33 | `states`, `stateName`, `listName`, `include`, `next`, `when`; missing root, reserved/duplicate names and missing references are semantic tests | T1 `conformance.test.ts`, `static-languages.test.ts` |
| Literal token 0..80 at default/action/bracket positions; postfix 2..80 | `defaultToken`, `actionToken`, `bracketToken`, `tokenPostfix`; empty token is legal, `@brackets` requires ≥1 bracket entry | T1 same files |
| Lists 0..32, words 0..4096 total, word text 1..64; cases 1..32 | `lists`, `words`, `wordText`, `cases`; split-list 4095/4096/4097 and distinct-list cases 0/1/31/32/33 ending in one default through public validator | T1 same files |
| Pair tables each 0..32; open/close/comment atoms 1..16 | `tokenizerBrackets`, `configurationBrackets`, `autoClosingPairs`, `surroundingPairs`, `pairOpen`, `pairClose`, `lineComment`. All pair positions reuse `pairSchema`; controls and astral text tested. | T1 `conformance.test.ts`, `static-language-schemas.test.ts` |
| `notIn` 0..3 unique enum values; onEnter 0..32; append 0..256; remove integer 0..256 | `notIn`, `onEnterRules`, `appendText`, `removeText`, plus remove -1/0.5. Four distinct legal `notIn` values are impossible: the fourth sample repeats a legal value; semantic duplicate rejection is tested separately at count 2. | T1 same files plus `static-languages.test.ts` |
| Raw patterns 1..2048 code points; compiled source ≤4096; tokenizer minimum consumption 1 | `tokenizerPattern`, `configurationPattern`; raw 0/1/2047/2048/2049; normalized tokenizer and configuration 4095/4096/4097; zero/one-consumption AST tests | T1 `conformance.test.ts`, `static-language-regex.test.ts`; T8 `static-language-migration.test.ts` uses real adapter/Monaco |
| Flags exactly `""` or `"i"`; tokenizer must match ignoreCase | Both allowed values, mismatches and prohibited/repeated flags; no numeric lower/upper interval | T1 schema/regex tests; T8 migration/browser checks |
| Raw rules 0..1024 across states including includes; regex occurrences 0..1024 across tokenizer + configuration | `boundary semantic totals and byte counters`: 0/1/1023/1024/1025, plus original include-count and all 4 indentation + 3 onEnter + wordPattern tests | T1 `static-languages.test.ts` |
| Expanded rules 0..8192 per language; include depth 0..16 edges | 0/1/8191/8192/8193 with ≤64 states and ≤1024 raw entries; 0/1/15/16/17 edges, DAG/cycles and saturated exponential counts | T1 `static-language-graph.test.ts` |
| File bytes ≤524288, language bytes ≤786432 | Both byte counters 0/1/524287/524288/524289; sum 0/786431/786432/786433. Pure API allows nonnegative counters; reader rejects empty/non-JSON bytes, so no fabricated positive empty JSON resource. Real BOM-inclusive reader tests below. | T1 `static-languages.test.ts`; T2 `packaged-json-resource.test.ts` |
| Plugin bytes ≤1048576; total bytes ≤8388608; admitted ids ≤128; expanded total ≤65536 | Empty catalog plus N-1/N/N+1 below, repeated-path accounting retained. Every language stays within file/per-language limits; global bytes use 16 sources, expanded totals use 8 or 9 languages. | T2 `static-languages.test.ts` |
| Session ids ≤256, including revoked shells | 0/1/255/256/257 below; old id can return at cap without new register; count distinct ids, not plugins or current catalog entries | T4 `static-language-registration.test.ts` |
| Tokenization line length ≥10000 UTF-16 units skips | 9999/10000/10001, classic/encoded, final create/update configuration and astral text; actual main/split/review consumers retained | T8 `static-languages-browser.ts`, migration/split tests; T5 editor/review tests and §8.8 |

Every shared `boundary ...` case is in `packages/plugin-protocol/conformance/cases.json`: Zod executes it in `conformance.test.ts`, Python executes the same value against the exported schema in `sdks/python/tests/test_conformance.py`. The inventory assertion prevents omission of any structural family/sample. Upper-only aggregates have a legal empty/zero case, not a negative collection or byte allocation. Existing API compatibility, strictness, control rejection and semantic tests remain required alongside this numeric ledger.

- [ ] **Step 1: Add the owner-scoped regression tests**

T2 appends to `packages/plugin-runtime/src/packaged-json-resource.test.ts`, using its existing `read`, `directory`, imports and cleanup:

```ts
it("boundary original file bytes for disk and builtin providers", async () => {
  for (const size of [524287, 524288, 524289]) {
    const raw = "\uFEFF{}" + " ".repeat(size - 5); // BOM 3 bytes, JSON object 2.
    expect(Buffer.byteLength(raw)).toBe(size);
    await writeFile(path.join(directory, "boundary.json"), raw);
    if (size <= L.resourceFileBytes) {
      expect((await read("boundary.json")).bytes).toBe(size);
      expect(
        readBuiltinJson({ "boundary.json": raw }, "boundary.json", L.resourceFileBytes).bytes,
      ).toBe(size);
    } else {
      await expect(read("boundary.json")).rejects.toMatchObject({ actual: size });
      expect(() =>
        readBuiltinJson({ "boundary.json": raw }, "boundary.json", L.resourceFileBytes),
      ).toThrow();
    }
  }
  for (const raw of ["", " "]) {
    await writeFile(path.join(directory, "empty.json"), raw);
    await expect(read("empty.json")).rejects.toThrow();
    expect(() =>
      readBuiltinJson({ "empty.json": raw }, "empty.json", L.resourceFileBytes),
    ).toThrow();
  }
});
```

T2 appends to `packages/plugin-runtime/src/static-languages.test.ts`, reusing its existing `build`, `builtinToy`, `acceptFixture`, imports and T1 double. These are admission-accounting tests; T1 proves the supplied counts and T8 retains the real-validator integration:

```ts
it("boundary runtime plugin and global admission totals", async () => {
  const padded = (raw: string, bytes: number) => {
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(bytes);
    return raw + " ".repeat(bytes - Buffer.byteLength(raw));
  };
  const sized = (i: number, bytes: number) => {
    const source = builtinToy(`test.b${String(i).padStart(3, "0")}`, `b${i}`, [`b${i}`]);
    source.resources = {
      "language/tokenizer.json": padded(source.resources["language/tokenizer.json"]!, bytes - 2),
      "language/configuration.json": "{}",
    };
    return source;
  };
  expect((await build([])).catalog.languages).toEqual([]);
  for (const delta of [-1, 0, 1]) {
    const total = L.resourceBytesPerPlugin + delta;
    const first = sized(0, L.resourceFileBytes);
    const second = sized(1, total - L.resourceFileBytes);
    const manifest = first.manifest as PluginManifest;
    const declaration = manifest.contributes!.languages![0]!;
    manifest.contributes!.languages = [
      { ...declaration, id: "a", extensions: ["a"] },
      {
        ...declaration,
        id: "b",
        extensions: ["b"],
        tokenizer: { version: 1, path: "second.json" },
      },
    ];
    first.resources = {
      ...first.resources,
      "second.json": second.resources["language/tokenizer.json"]!,
    };
    const result = await build([first]);
    expect(result.catalog.languages).toHaveLength(delta <= 0 ? 2 : 1);
    if (delta > 0)
      expect(result.problems.get("builtin:test.b000")?.[0]?.detail).toMatchObject({
        limit: "STATIC_LANGUAGE_LIMITS_V1.resourceBytesPerPlugin",
        allowed: L.resourceBytesPerPlugin,
        actual: total,
      });
    else
      expect(
        result.catalog.languages.reduce(
          (sum, item) => sum + item.resourceBytes.tokenizer + item.resourceBytes.configuration,
          0,
        ),
      ).toBe(total);

    const sources = Array.from({ length: 16 }, (_, i) =>
      sized(i, L.resourceFileBytes + (i === 15 ? delta : 0)),
    );
    const global = await build(sources.reverse());
    expect(global.catalog.languages).toHaveLength(delta <= 0 ? 16 : 15);
    if (delta > 0)
      expect(global.problems.get("builtin:test.b015")?.[0]?.detail).toMatchObject({
        limit: "STATIC_LANGUAGE_LIMITS_V1.resourceBytesTotal",
        allowed: L.resourceBytesTotal,
        actual: L.resourceBytesTotal + 1,
      });
    else
      expect(
        global.catalog.languages.reduce(
          (sum, item) => sum + item.resourceBytes.tokenizer + item.resourceBytes.configuration,
          0,
        ),
      ).toBe(L.resourceBytesTotal + delta);
  }
  for (const count of [0, 1, 127, 128, 129]) {
    const result = await build(
      Array.from({ length: count }, (_, i) =>
        builtinToy(`test.i${String(i).padStart(3, "0")}`, `i${i}`, [`i${i}`]),
      ),
    );
    expect(result.catalog.languages).toHaveLength(Math.min(count, 128));
    if (count === 129)
      expect(result.problems.get("builtin:test.i128")?.[0]?.detail).toMatchObject({
        limit: "STATIC_LANGUAGE_LIMITS_V1.languagesTotal",
        allowed: 128,
        actual: 129,
      });
  }
  try {
    for (const total of [0, 1, 65535, 65536, 65537]) {
      const counts: number[] = [];
      for (let remaining = total; remaining > 0; remaining -= L.expandedRulesPerLanguage)
        counts.push(Math.min(remaining, L.expandedRulesPerLanguage));
      vi.mocked(validateStaticLanguageResources).mockImplementation((input) => {
        const accepted = acceptFixture(input);
        if (!accepted.ok) throw new Error("Expected fixture acceptance");
        return { ...accepted, expandedRules: counts[Number(input.languageId.slice(1))]! };
      });
      const result = await build(
        counts.map((_, i) => builtinToy(`test.r${i}`, `r${i}`, [`r${i}`])),
      );
      expect(result.catalog.languages.reduce((sum, item) => sum + item.expandedRules, 0)).toBe(
        Math.min(total, 65536),
      );
      if (total === 65537)
        expect(result.problems.get("builtin:test.r8")?.[0]?.detail).toMatchObject({
          limit: "STATIC_LANGUAGE_LIMITS_V1.expandedRulesTotal",
          allowed: 65536,
          actual: 65537,
        });
    }
  } finally {
    vi.mocked(validateStaticLanguageResources).mockImplementation(acceptFixture);
  }
});
```

T4 appends to `apps/desktop/src/renderer/editor/static-language-registration.test.ts`, using its existing harness. Retain the original revocation/recreation tests:

```ts
it("boundary session distinct ids at zero one 255 256 257", () => {
  const h = harness();
  expect(h.register).not.toHaveBeenCalled();
  for (let index = 1; index <= 257; index++) {
    h.publish(ready(catalog(index, [language(`boundary-${index}`)])));
    if ([1, 255, 256, 257].includes(index)) {
      expect(h.register).toHaveBeenCalledTimes(Math.min(index, 256));
      expect(h.registrar.resolve({ file: "main.toy" }).monacoLanguage).toBe(
        index <= 256 ? `boundary-${index}` : "plaintext",
      );
      if (index <= 256) expect(h.report).not.toHaveBeenCalled();
    }
  }
  expect(h.report).toHaveBeenCalledTimes(1);
  expect(h.report.mock.calls[0]![0]).toMatchObject({
    languageId: "boundary-257",
    reason: "session-language-ids",
  });
  h.publish(ready(catalog(258, [])));
  h.publish(ready(catalog(259, [language("boundary-1", 2)])));
  expect(h.registrar.resolve({ file: "main.toy" }).monacoLanguage).toBe("boundary-1");
  expect(h.register).toHaveBeenCalledTimes(256);
  h.registrar.dispose();
});
```

- [ ] **Step 2: Run before implementation, expect FAIL**

Each original owner adds these tests to its initial failing-test step (T2 §2.1/§2.2; T4 §4.4), before implementing the corresponding stub. Run exactly:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false
pnpm --filter @kobrixa/plugin-runtime exec vitest run src/packaged-json-resource.test.ts src/static-languages.test.ts
pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/static-language-registration.test.ts
```

Expected at that point: FAIL on missing reader/catalog or registrar stubs. If an owner already implemented the module before receiving this assignment, record the tests as added coverage, run them against that implementation, and preserve the original red result; do not fabricate a new failure or weaken a working implementation.

- [ ] **Step 3: Implement in the owning task, then add the T8 completion runner**

T1 implements the full schemas/validator/corpus recipes in part1. T2 implements part2's bounded reader and deterministic admission against the frozen limits. T4 implements part4's session history and cap. Any failing boundary goes back to that exclusive owner's implementation, followed by the same tests. No new product interface, duplicate limit constant or cross-owner implementation is introduced here.

T8 creates `tools/check-static-language-boundaries.mjs`. This rejects absent test assignments, skipped tests, failed suites and Python SKIP; a green unrelated Vitest filter cannot close the ledger:

```js
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const directory = await mkdtemp(path.join(tmpdir(), "kobrixa-boundaries-"));
const pnpmEntry = process.env.npm_execpath;
assert.ok(pnpmEntry, "Run through pnpm test:static-languages:boundaries");
function run(args) {
  const result = spawnSync(process.execPath, [pnpmEntry, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      pnpm_config_pm_on_fail: "ignore",
      pnpm_config_verify_deps_before_run: "false",
    },
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) throw result.error;
  assert.equal(result.status, 0, args.join(" "));
  return `${result.stdout}\n${result.stderr}`;
}
const groups = [
  [
    "@kobrixa/plugin-protocol",
    [
      "src/conformance.test.ts",
      "src/json-schema.test.ts",
      "src/static-language-manifest.test.ts",
      "src/static-language-schemas.test.ts",
      "src/static-language-regex.test.ts",
      "src/static-language-graph.test.ts",
      "src/static-languages.test.ts",
    ],
    [
      "boundary structural inventory is complete",
      "boundary manifest collections and text",
      "boundary resource path grammar and versions",
      "boundary raw and compiled regex sources",
      "boundary include depth independently of DFS visitation order",
      "boundary expanded rules with bounded raw entries",
      "boundary semantic totals and byte counters",
    ],
  ],
  [
    "@kobrixa/plugin-runtime",
    ["src/packaged-json-resource.test.ts", "src/static-languages.test.ts"],
    [
      "boundary original file bytes for disk and builtin providers",
      "boundary runtime plugin and global admission totals",
    ],
  ],
  [
    "@kobrixa/desktop",
    [
      "src/renderer/editor/static-language-registration.test.ts",
      "src/renderer/editor/static-language-migration.test.ts",
    ],
    [
      "boundary session distinct ids at zero one 255 256 257",
      "validates real macro literals and the 4096 transformed-source boundary before Monaco",
    ],
  ],
];
try {
  for (const [index, [pkg, files, required]] of groups.entries()) {
    const report = path.join(directory, `${index}.json`);
    run([
      "--filter",
      pkg,
      "exec",
      "vitest",
      "run",
      ...files,
      "--allowOnly=false",
      "--reporter=json",
      `--outputFile=${report}`,
    ]);
    const result = JSON.parse(await readFile(report, "utf8"));
    assert.equal(result.success, true);
    const tests = result.testResults.flatMap((suite) => suite.assertionResults);
    assert.ok(tests.length > 0);
    assert.ok(
      tests.every((test) => test.status === "passed"),
      "No skipped/pending boundary suite tests",
    );
    for (const title of required)
      assert.ok(
        tests.some((test) => test.title === title),
        `Missing assigned boundary test: ${title}`,
      );
  }
  const python = run(["test:python-sdk"]);
  assert.doesNotMatch(python, /\bskip(?:ped)?\b/i, "Python schema conformance must execute");
} finally {
  await rm(directory, { recursive: true, force: true });
}
```

Register the root script now so the runner can invoke the same pnpm JavaScript entry point through Node on every platform (including Windows), without a shell. §8.6 retains this entry:

```bash
node --input-type=module <<'JS'
import { readFile, writeFile } from "node:fs/promises";
const file = "package.json";
const pkg = JSON.parse(await readFile(file, "utf8"));
pkg.scripts["test:static-languages:boundaries"] = "node tools/check-static-language-boundaries.mjs";
await writeFile(file, JSON.stringify(pkg, null, 2) + "\n");
JS
```

- [ ] **Step 4: Execute the ledger after all repairs, expect PASS**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false
pnpm --filter @kobrixa/plugin-protocol build
pnpm --filter @kobrixa/plugin-runtime build
pnpm test:static-languages:boundaries
node tests/desktop/static-languages-run.mjs
```

Expected: PASS for every ledger row, including real Monaco 9999/10000/10001 checks in the browser runner. Record the exact passing commands/commit and any grammar-dominated exception in the controller acceptance report. Missing cases, skipped Python, mock-only evidence for real-Monaco rows or a failed/unrun browser check block acceptance; return repairs to the named owner and repeat only affected groups. A green aggregate suite alone is insufficient.

- [ ] **Step 5: Controller commits each exclusive owner repair and the runner**

Run the first pair on T2's repair branch, the second on T4's repair branch, then merge those reviewed repairs before T8 resumes. T1's changes are committed by part1's existing steps.

```bash
git add packages/plugin-runtime/src/packaged-json-resource.test.ts packages/plugin-runtime/src/static-languages.test.ts
git commit -m "test(plugin-runtime): close static language admission boundaries"
git add apps/desktop/src/renderer/editor/static-language-registration.test.ts
git commit -m "test(desktop): close static language session id boundaries"
git add package.json tools/check-static-language-boundaries.mjs
git commit -m "test(plugins): require complete static language boundary ledger"
```

If a boundary exposes a product defect, its owner also stages only the specific implementation files repaired within that owner's write set, after review and its own red → implementation → green cycle. The commands above stage only the known test additions; they are not permission to stage unrelated work.

#### 8.6 Wire the tests into root scripts and CI

- [ ] **Step 1: Add scripts without dropping existing checks**

Run this complete edit from repository root:

```bash
node --input-type=module <<'JS'
import { readFile, writeFile } from "node:fs/promises";
const file = "package.json";
const pkg = JSON.parse(await readFile(file, "utf8"));
pkg.scripts["generate:static-language-core-ids"] = "node tools/generate-static-language-core-ids.mjs";
pkg.scripts["test:static-languages"] = "node tools/generate-static-language-core-ids.mjs --check && node --test tests/desktop/static-languages-*.test.mjs tests/desktop/smoke-harness.test.mjs";
pkg.scripts["test:static-languages:boundaries"] = "node tools/check-static-language-boundaries.mjs";
pkg.scripts["test:static-languages:smoke"] = "node tests/desktop/static-languages-run.mjs";
for (const name of ["test", "test:desktop", "test:ci"]) {
  if (!pkg.scripts[name].includes("pnpm test:static-languages")) {
    pkg.scripts[name] += " && pnpm test:static-languages";
  }
}
await writeFile(file, JSON.stringify(pkg, null, 2) + "\n");
JS
```

The runtime/protocol builds precede Node integration tests in the verification sequence and CI. Unit-test commands stay usable independently. Neither the generator nor its check invokes installation or changes T2's canonical list.

- [ ] **Step 2: Insert schema/projection and real static-smoke gates in the desktop CI job**

After the existing `- run: pnpm build:core` in `.github/workflows/ci.yml`, insert:

```yaml
- name: Verify static language schemas and generated core ids
  shell: bash
  run: |
    pnpm --filter @kobrixa/plugin-protocol schema
    node tools/generate-static-language-core-ids.mjs --check
    git diff --exit-code -- packages/plugin-protocol/schema/plugin-protocol.schema.json sdks/python/kobrixa/plugin-protocol.schema.json apps/desktop/src/renderer/editor/core-static-language-ids.json
```

After `- run: pnpm test:desktop` and before the existing plugin smoke step, insert:

```yaml
- name: Static language boundary ledger (P5)
  run: pnpm test:static-languages:boundaries
- name: Static language IPC, Monaco and recovery smoke
  shell: bash
  run: |
    if [ "$RUNNER_OS" = "Linux" ]; then
      xvfb-run -a pnpm test:static-languages:smoke
    else
      pnpm test:static-languages:smoke
    fi
```

`pnpm test:desktop` now includes all new Node tests, so do not add a duplicate Node-test CI step. Keep existing Python, plugin-process, packaged application and release steps. `tools/ci/changes.mjs` already routes `tests/**`, desktop paths and non-CI `tools/**` to desktop, and shared package/CI changes to both products; no routing-policy edit is required. The setup action's existing `pnpm install --frozen-lockfile` verifies T1's lockfile without a local T8 install.

- [ ] **Step 3: Verify wiring and format the actual changed files**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false
pnpm exec prettier --write package.json .github/workflows/ci.yml tools/generate-static-language-core-ids.mjs tools/check-static-language-boundaries.mjs apps/desktop/src/renderer/editor/core-static-language-ids.json apps/desktop/src/renderer/editor/core-language-routes.ts apps/desktop/src/renderer/editor/split-editor.tsx apps/desktop/src/renderer/editor/split-editor.test.ts apps/desktop/src/renderer/editor/completion-session.test.ts apps/desktop/src/renderer/editor/companions/basic-plus/companion.ts apps/desktop/src/renderer/editor/static-language-routing.ts apps/desktop/src/renderer/editor/static-language-registration.ts apps/desktop/src/renderer/editor/static-language-bootstrap.ts apps/desktop/src/renderer/editor/language-routing.ts apps/desktop/src/renderer/editor/static-language-migration.test.ts tests/desktop/raw-resource-plugin.mjs tests/desktop/run-smoke.mjs tests/desktop/static-languages-*.mjs tests/desktop/static-languages-main.ts tests/desktop/static-languages-browser.ts tests/desktop/static-languages-browser.html
pnpm test:static-languages
pnpm test:ci-routing
git diff --check
```

Expected: PASS. The core-id generator uses Prettier itself, so formatting must not make its `--check` fail. Validate the Windows Node glob invocation through CI; Node 24 supplies the `--test` glob handling. Any test that only passed with a fixture double must not be relabeled as a real integration result.

#### 8.7 Full verification gate

- [ ] **Step 1: Build, typecheck, schema, SDK and non-Electron regression gates**

From repository root, use the prepared dependency environment. Run each command, retaining its real exit status; a failure in one group does not erase the need to run independent groups.

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false
node --version
pnpm --version
pnpm --filter @kobrixa/plugin-protocol build
pnpm --filter @kobrixa/plugin-runtime build
pnpm --filter @kobrixa/plugin-sdk build
node tools/generate-static-language-core-ids.mjs --check
pnpm --filter @kobrixa/desktop check
pnpm --filter @kobrixa/plugin-protocol schema
git diff --exit-code -- packages/plugin-protocol/schema/plugin-protocol.schema.json sdks/python/kobrixa/plugin-protocol.schema.json
pnpm test:static-languages:boundaries
pnpm test
pnpm test:web
pnpm test:release
pnpm check
pnpm exec eslint .
pnpm format:check
pnpm -r build
git diff --check
```

Expected: PASS, including bytecode through `pnpm test`, both API `1.4.0` schemas byte-identical, compatible `1.3.x` manifests, JS/Python conformance and web worker tests. `pnpm check` already includes ESLint; the explicit ESLint command may reuse that successful result instead of running twice. Similarly reuse an identical earlier scoped test result when nothing affecting it has changed. Python's runner can print SKIP locally; that is **unrun**, not passing acceptance. CI provisions Python 3.12 and must not skip.

- [ ] **Step 2: Run Electron regressions, thresholds and packaged smoke**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false
pnpm test:plugins:smoke
pnpm test:static-languages:smoke
pnpm test:desktop:smoke
KOBRIXA_SMOKE_COMPLETION_ONLY=1 pnpm test:desktop:smoke
KOBRIXA_SMOKE_PERFORMANCE_ONLY=1 pnpm test:desktop:smoke
pnpm build:desktop
pnpm test:desktop:packaged
```

Use `xvfb-run -a` before each Electron command on headless Linux, as in CI. Keep completion thresholds exactly **warm p95 ≤100 ms; new variable ≤200 ms; 30,000 lines ≤300 ms**. The completion/performance-only runs are independent gates even when full smoke fails before reaching them. Retain highlighting/indentation/light-dark images, language-feature/formatting and worker stale-result results from the full smoke.

Record these known environment issues **without fixing them in 2C**:

- Desktop packaging can fail with `ENOENT` for hoisted `node-addon-api` in pnpm-11 worktrees. It also fails on the base branch. Do not install/move dependencies, change packaging, or modify the lockfile to hide it. Mark the affected recursive-build/desktop-package/packaged-smoke results failed or blocked; a stale package is not valid acceptance evidence.
- Full desktop smoke's README window-dimension assertion also fails on the base branch. Preserve its assertion and report the exact observed dimensions/error. Record completion-only and performance-only results separately; their passing does not turn full smoke green.

For each unavailable Electron/packaged/recovery result record command, commit, OS/arch, Node/pnpm versions, actual error, base-branch comparison, artifact location and manual result. A release still requires the blocked acceptance on a working packaging/display environment. Do not claim mock results or base-branch failure as a waiver.

- [ ] **Step 3: Run the spec §9.2 hardcoding/import scan**

```bash
rg -n '@kobrixa/basic-plus|basicPlusMonarch|registerBasicPlusLanguage|companion\.monacoLanguage|basic-plus|\bbpi\b|\bbpm\b|["\x27]bp["\x27]' apps/desktop/src/renderer apps/desktop/src/shared --glob '!**/*.test.ts' --glob '!**/companions/basic-plus/**'
rg -n 'basic-plus|\bbp\b|\bbpi\b|\bbpm\b|t\.basicPlus|monacoLanguage' apps/desktop/src/renderer/editor/language-routing.ts apps/desktop/src/renderer/app.tsx apps/desktop/src/renderer/workspace/file-review-dialog.tsx
rg -n 'registerBasicPlusLanguage|basicPlusMonarch|companion\.monacoLanguage' apps/desktop/src/renderer apps/desktop/src/shared --glob '!**/*.test.ts'
rg -n 'tokenizer\.json|configuration\.json' apps/desktop/src/renderer apps/desktop/src/shared --glob '!**/*.test.ts'
rg -n 'T0 contract stub|not implemented|acceptFixture|vi\.mock' packages/plugin-protocol/src packages/plugin-runtime/src apps/desktop/src --glob '!**/*.test.ts' --glob '!**/test-static-languages.ts'
```

Expected: no obsolete lexical registration/readers, renderer raw-resource imports or production T0 stubs. Inspect all matches in the first two commands: `kobrixa.basic-plus:bp` in the builtin companion composition table, its companion import path, the dedicated theme bridge and descriptive/localized product copy are allowed; extension guesses, generic `@kobrixa/basic-plus` imports and non-JSON→Basic-Plus fallbacks are not. Current route fields named `monacoLanguage` are required and are not the removed **companion** field. `rg` exit 1 means no matches, not execution failure. Preserve actual findings; do not whitelist whole generic renderer files.

- [ ] **Step 4: Controller commits the reviewed integration change**

```bash
git diff --check
git diff --stat
git add package.json .github/workflows/ci.yml tools/generate-static-language-core-ids.mjs tools/check-static-language-boundaries.mjs apps/desktop/src/renderer/editor/core-static-language-ids.json apps/desktop/src/renderer/editor/core-language-routes.ts apps/desktop/src/renderer/editor/split-editor.tsx apps/desktop/src/renderer/editor/split-editor.test.ts apps/desktop/src/renderer/editor/completion-session.test.ts apps/desktop/src/renderer/editor/companions/basic-plus/companion.ts apps/desktop/src/renderer/editor/static-language-routing.ts apps/desktop/src/renderer/editor/static-language-registration.ts apps/desktop/src/renderer/editor/static-language-bootstrap.ts apps/desktop/src/renderer/editor/language-routing.ts apps/desktop/src/renderer/editor/static-language-migration.test.ts tests/desktop/raw-resource-plugin.mjs tests/desktop/run-smoke.mjs tests/desktop/static-languages-integration.test.mjs tests/desktop/static-languages-docs.test.mjs tests/desktop/static-languages-harness.mjs tests/desktop/static-languages-run.mjs tests/desktop/static-languages-main.ts tests/desktop/static-languages-browser.html tests/desktop/static-languages-browser.ts
git commit -m "test(plugins): integrate static languages across runtime IPC and Monaco"
```

Do not stage unrelated work. Any original-owner repair is separately reviewed/committed and merged before this commit. A commit is not a release-readiness declaration while required checks or manual results are outstanding.

#### 8.8 Manual acceptance for the user / 使用者人工驗收

- [ ] **Step 1: Prepare one isolated profile, the toy fixtures and a fresh package**

Use T7's retained fixture/profile artifacts from the real smoke or a copy of the three files in `docs/en/plugin-static-languages.md` / `docs/zh-TW/plugin-static-languages.md`. Keep the ordinary profile untouched. The two-id extension-conflict fixtures are `toy` and `shared`; `duplicate` tests same-id rejection. Keep the builtin frontend/service owner fixture host-created. Never make product Basic Plus disableable to run these checks. Record PASS/FAIL/unrun and observed results in the controller's acceptance report for **each locale**.

| English — run with locale `en`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 繁體中文 — 以 `zh-TW` 重跑                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open Basic Plus in light and dark themes. Check keywords, numbers, comments, escaped/unfinished strings, dot identifiers and `@`; test brackets, quote auto-closing and indentation. Status says Basic Plus and Monaco id is `bp`. JSON stays JSON and an unknown extension stays Plain Text.                                                                                                                                                                                                    | 在淺色與深色主題開啟 Basic Plus，檢查關鍵字、數字、註解、跳脫／未閉合字串、點號識別字與 `@`；測試括號、自動引號與縮排。狀態列為 Basic Plus、Monaco id 為 `bp`；JSON 維持 JSON，未知副檔名為「純文字」。                                                                                                                                |
| Enable the trusted toy static plugin. Verify highlighting, alias and no running process/PID. Edit a toy file, open a second tab, a split and a real file-history/conflict review. Disable, re-enable, reload and remove the source; visible/hidden/review models fall back and recover together. Text, undo, dirty draft, cursor, selection and scroll position survive. Rename a restored old draft from `.toy` to an unknown extension and back; current filename/catalog determine its route. | 啟用可信任 toy 純靜態插件，確認上色、別名且沒有執行程序／PID。修改 toy 檔，開啟另一分頁、分割畫面與真正的歷史／衝突檢視。停用、重新啟用、reload、移除來源，確認可見／隱藏／review models 同步退回及恢復；內容、undo、未存草稿、游標、選取與捲動位置保留。將還原的舊草稿由 `.toy` 改成未知副檔名再改回，以目前檔名與 catalog 決定語言。 |
| Restart with `--safe-mode`: no third-party grammar is loaded and Basic Plus still works. Clear safe mode explicitly; individually disabled plugins stay disabled after another restart. Basic Plus's disable control is unavailable and its API returns `PLUGIN_E_BUILTIN_REQUIRED`.                                                                                                                                                                                                             | 以 `--safe-mode` 重啟，第三方語法不載入、Basic Plus 仍可用。明確退出安全模式後，個別停用的插件在再次重啟後仍停用。Basic Plus 不提供停用操作，API 回 `PLUGIN_E_BUILTIN_REQUIRED`。                                                                                                                                                      |
| In main, actual split, and both actual review diff panes test 9,999/10,000/10,001 UTF-16 units, including astral characters. Inspect final Monaco configuration after changing font/editor settings: 10000 everywhere. At ≥10000 lexical tokenization skips; typing, Save, close/reopen and undo still work. Record following-line state using the fixed unfinished-string→`If True Then` fixture.                                                                                               | 在主編輯器、真正分割畫面及 review diff 兩側測試 9,999／10,000／10,001 UTF-16 units，包含非 BMP 字元。改變字型／編輯設定後檢查實際 Monaco configuration 全為 10000；≥10000 跳過詞法上色，但可輸入、儲存、關閉重開及 undo。使用固定未閉合字串→`If True Then` fixture 記錄下一行狀態。                                                    |
| Enable `toy` plus `shared`: a shared extension becomes Plain Text, both sources appear in the conflict message, and the unshared extension still highlights. Disable one source and the already-open file recovers. Repeat reverse enable order and the same-id `duplicate` fixture. With the host-created selected binding, use only its owner's grammar; when that grammar fails, remain Plain Text even if another global route exists.                                                       | 同時啟用 `toy`、`shared`：共用副檔名變「純文字」，衝突訊息列出雙方，非共用副檔名仍上色。停用其中一方，已開文件恢復；交換啟用順序並測試同 id 的 `duplicate`。使用 host 建立的 selected binding 時，只取同 owner 語法；該語法失敗時，即使另有 global route 仍為純文字。                                                                  |
| Force a registration failure in the isolated fixture, then disable→enable. Confirm a higher generation restores coloring once, with no report/revision retry loop. Confirm fallback removes semantic coloring; an adjacent unrelated Plain Text document receives no completion/format/semantic provider. Change only lexical aliases/extensions/digest and observe status/model updates without restarting the analysis worker or changing service epoch.                                       | 在隔離 fixture 製造註冊失敗，再停用→啟用；確認 generation 增加、上色恢復一次，沒有 report／revision 重試迴圈。Fallback 清除 semantic coloring，旁邊無關的純文字文件不收到補全／格式化／semantic provider。只改詞法別名／副檔名／digest，狀態列與 model 更新，但分析 worker 不重啟、service epoch 不變。                                |
| On an isolated test process, deliberately block only its renderer, wait for the real unresponsive event, and let the parent terminate it by deadline. Restart the same profile: the renderer-unresponsive recovery UI must work. Disable the source, explicitly restore plugins, restart again and confirm the disable persists. Record this separately from the simulated controller-hook phase.                                                                                                | 僅在隔離測試程序故意阻塞 renderer，等待真正的 unresponsive 事件，由父程序在 deadline 終止。用同一 profile 重啟，確認 renderer-unresponsive 復原入口可操作；停用問題來源、明確恢復插件並再次重啟，確認停用仍保留。此結果須與模擬 controller hook 的測試分開記錄。                                                                       |
| Copy the fresh packaged app and fixtures to a machine/container with **no repository source tree mounted**. Launch from the installed copy: Basic Plus works in both themes, toy enables/disables without PID, and no raw JSON HTTP request or repository file is needed. Repeat recovery there. Merely changing cwd or copying beside the checkout is insufficient.                                                                                                                             | 將新封裝程式與 fixtures 複製到**未掛載 repository 原始碼**的機器／容器。由安裝副本啟動，確認 Basic Plus 兩種主題、toy 無 PID 啟停，且不需要 raw JSON HTTP 請求或 repository 檔案；在此環境重跑復原。只更換 cwd 或複製到 checkout 旁邊不算完成。                                                                                        |

Manual actions that need fault injection use the isolated acceptance harness/fixture and a parent process deadline, never the user's normal profile and never the Vitest process. Record an unavailable check as unrun with its concrete reason. N2 remains deferred under R5; do not report its multi-message loader presentation as delivered.

## Self-review

- **Schema／SDK — T1 + T2 + T8:** `static-language-manifest.test.ts`, `static-language-schemas.test.ts`, `conformance.test.ts`, `json-schema.test.ts`, JS SDK `index.test.ts`, Python `test_conformance.py` / `test_static_languages.py`; T2 registry/manager tests and T8 `static-languages-integration.test.mjs` establish source restriction precedence with real validators. Both guides now pass real schema/resource validation. No acceptance waiver for Python SKIP.
- **Limits — T1 + T2 + T4 + T8:** T1 schema/regex/graph/resource suites pin structure, Unicode and regex/configuration totals; T2 `packaged-json-resource.test.ts`, `static-languages.test.ts`, `manager.static-languages.test.ts` cover repeated references, multi-language/plugin/global budgets and I/O; T4 registrar tests cover 256/257 ids. T8 migration and browser tests cover transformed 4096/4097 and UTF-16 9999/10000/10001. **P5 completion gate:** execute every row in §8.5a with `pnpm test:static-languages:boundaries` and the real browser runner. T1/T2/T4 must close their assigned cases before acceptance; preserve the explicit path/notIn/empty-resource exceptions. Missing, failed or skipped cases block acceptance.
- **Regex／adapter — T1 + T4 + T6 + T8:** `static-language-regex.test.ts`, `static-language-adapter.test.ts`, upgraded `static-language-migration.test.ts`, and `static-languages-browser.ts`: real macro semantics, flags, substitution/backreference/lookbehind/zero-width rejection, configuration anchors, lookahead, escaped strings, case folding and normalization limits. No test result establishes safety for untrusted regexes; any stress execution belongs in a parent-terminable process.
- **Include graph — T1 + T2:** `static-language-graph.test.ts` and `static-languages.test.ts` cover missing/reference/reserved names, reachable/unreachable cycles, 16/17 edges, DAG depth, saturation/materialization and legal next cycles. Real runtime validation is exercised by T8; injected orchestration tests remain explicitly scoped.
- **Resource／packaging — T2 + T6 + T7 + T8:** `packaged-json-resource.test.ts`, `registry.timeout.test.ts`, `manager.static-languages.test.ts`, `builtin.test.ts`, T8 Node raw/BOM tests and real Electron entry. Preserve tests for traversal/symlink/directory/missing/stat-growth/deadline/late completion and per-source isolation. Source-free packaging still needs the manual/clean-machine result below.
- **Ownership — T2 + T4 + T7 + T8:** RF3 in runtime `static-languages.test.ts`; `static-language-routing.test.ts`; T7 conflicts phase; T8 source-order and real browser selected-owner fallback checks; R6 compares actual Monaco registrations and guards every reserved id. Actual selected binding inside the application's review UI remains a manual check, distinct from the pure resolver test.
- **Lifecycle — T2 + T4 + T7 + T8:** `manager.static-languages.test.ts`, registrar tests, `checkStaticLanguageLifecycle`, T8 real mixed-runtime Node test and browser failure/re-enable test. T2 must deliver R1's own disable→enable higher-generation test. No PID/launcher/handshake, disposal, removal/reload failures and crash-versus-isolation stay covered; do not substitute builtin disable for third-party lifecycle.
- **Renderer races — T4 + T5 + T8:** store/registrar RF2/RF5 tests; bootstrap and `file-review-dialog.test.ts`; T8 real delayed IPC response, all-model revocation, partial registration rollback and no refresh retry. T3 IPC tests cover forged subframes and duplicate/stale reports, with real foreign-window IPC added here. 256/257 and StrictMode adversarial cases remain unit-level, not claimed as actual application UI tests.
- **Revision／epoch — T2 + T4 + T5 + T8:** runtime catalog revision tests, `model-language-route.test.ts`, `language-routing.test.ts`, editor/language-feature/semantic suites, existing language-worker/analysis-session/completion-session regressions. **Remaining integration evidence:** actual application's worker identity/service epoch during lexical-only alias/extension/digest changes is manual in §8.8; the new browser harness has no analysis worker and cannot prove it.
- **Models／UX — T4 + T5 + T6 + T7 + T8:** registrar/model/editor/review tests, RF5 migration, packaged draft round trip, T8 real hidden/diff/shared models, undo/cursor/selection/view-state assertions. **Remaining integration evidence:** actual review/split React wiring, persisted renamed drafts across failed generations, and semantic-provider clearing/isolation together require §8.8; isolated mocks and DOM content checks do not establish those combined properties.
- **Bootstrap／recovery — T2 + T3 + T5 + T7 + T8:** manager disabled/safe-mode/corrupt-state tests; controller/session/IPC/preload tests; bootstrap/app restoration tests; upgraded T7 real IPC phases for sticky marker, post-startup failure, recovery and persistent disables. **Remaining integration evidence:** a real renderer hang followed by next-launch recovery UI is not automated by any T1–T7 test (T7 calls a hook); explicitly assigned to T8 manual acceptance, not marked PASS by the simulated phase.
- **Builtin required — T2 + T3 + T5 + T6 + T7:** runtime/controller required-source tests, plugin settings tests, builtin source tests, T7 safe-mode/conflict/packaged checks and §8.8. Builtin lexical resource failure must preserve valid dynamic service availability; no product disable switch is added.
- **Long lines — T5 + T6 + T7 + T8:** T5 editor/review option tests; T8 direct split call-site test; T6 upgraded classic tokenizer fixture; T7 main-editor smoke; T8 real configuration, classic/encoded boundary and fixed subsequent-line state. **Remaining integration evidence:** saving/closing/reopening long-line documents and actual application split/review option updates are manual; the standalone harness is not proof of those product entry points.
- **Basic Plus parity — T6 + T4 + T5 + T7 + T8:** builtin keyword/configuration parity, theme tests, upgraded legacy-span migration through the host DTO and actual adapter; highlighting/indentation smoke and packaged restoration check `bp`, `.basic-plus`, JSON and unknown fallback. Light/dark and old renamed-session/draft behavior are repeated manually in both locales.
- **Regression — T1–T8:** `pnpm test`/bytecode, web/worker and SDK suites, completion-session/language-features/semantic/formatting/structure tests, full and performance-only smoke, §9.2 scans. T7 `smoke-harness.test.mjs` covers N1 Windows and non-Windows branches. **N2 is deliberately deferred, not missing implementation by accident**, under spec §9.3/R5. Keep all three completion thresholds unchanged.
- **Real packaging — T6 + T7 + T8:** raw provider tests, `static-languages-run.mjs` and `test:desktop:packaged`; §8.8 requires a fresh app on a machine without the checkout plus actual recovery UI. **Remaining gap:** no current automated task removes the source tree from the execution environment; T7's copied app/cwd change is insufficient. The clean-machine/manual run is mandatory, and the known packaging ENOENT may block obtaining its artifact.
- **Plan integrity:** all seven rulings are verbatim; branch names match part0; modifications have one owner after hand-off; real validators/IPC/catalog are exercised without deleting useful unit doubles; root scripts/CI include new Node/Electron entries. This plan does not claim executed tests. No entire §10 row is unassigned. The §8.5a boundary gate and the explicitly identified real-UI/worker/hang/source-free-packaging evidence must all pass; 2C is not releasable with those gaps.
