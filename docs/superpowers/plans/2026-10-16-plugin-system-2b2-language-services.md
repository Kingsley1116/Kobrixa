# 語言服務提供者 2B-2 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 所有現有動態語言功能經由內建插件宣告、main 選定的提供者執行；來源正確、換綁定即失效、不可用狀態可辨識，保留 Basic Plus 的演算法、編輯體驗及效能。

**Architecture:** `plugin-protocol` 定義 API 1.3.0 的語言服務宣告，`plugin-runtime` 依 frontend 擁有者解析服務。main 為每個工作區維持一個 binding coordinator，兩條 worker 共用其 epoch，但各自保有分析與補全 session；worker adapter 封裝原生分析及語意查詢，browser companion 封裝即時補全、結構性失效與格式化。shared 只傳通用 DTO，renderer 只負責 Monaco、文件版本、幾何位移及狀態呈現。

**Tech Stack:** TypeScript（strict、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`）、Node.js 24、Electron 44、Zod 4、Vitest、React 19、Monaco、Python 3.10+ unittest。

**Spec:** [`docs/superpowers/specs/2026-10-16-plugin-system-2b2-language-services-design.md`](../specs/2026-10-16-plugin-system-2b2-language-services-design.md) §1–10（已核准；綁定權威）。格式參照 [`2026-10-16-plugin-system-2b1-diagnostic-source.md`](2026-10-16-plugin-system-2b1-diagnostic-source.md)。

本文件只規劃實作。下列 commit 命令供後續有 git metadata 寫入權限的實作者使用；撰寫本計畫時不執行。保留 §10 的七個 task，不合併或拆分；Task 2 的描述讀取是提供者選擇所需的同一個可測交付項目。

## Global Constraints

- 插件 API 升為 **1.3.0**（protocol schema、JSON Schema、JS SDK 常數、Python SDK、conformance 同步）。
- capability 名稱固定為 `analysis`, `completion`, `quickFixes`, `semanticTokens`, `hover`, `signatureHelp`, `definition`, `references`, `rename`, `documentSymbols`, `documentFormatting`, `rangeFormatting`。
- `languageServices` 陣列最多 8 筆；宣告為 strict object；`extensions`、`capabilities` 非空、不重複；同插件內 `language` 不重複。
- `language` 沿用 `/^[a-z][a-z0-9-]{0,31}$/`；`extensions` 沿用 `/^[a-z0-9]{1,16}$/`；必含 `analysis`，且與同插件同語言 frontend 的 `sourceExtensions` 集合完全相同。
- 非內建插件只要宣告 `languageServices`（包含空陣列）即為 invalid，問題碼 **`PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN`**；信任 registry source，不信任 manifest runtime 自稱。
- 內建 `kobrixa.basic-plus` 的 `apiVersion` 改為 `^1.3.0`，宣告 `bp`、`["bp", "bpi", "bpm"]` 及全部 12 capabilities。
- 綁定鍵為 `pluginId:language`；manifest 中沒有任何實作路徑；宣告 ⊆ 實作。
- 先檢查 `PLUGIN_E_PROVIDER_CONFLICT` 的 `language:<id>`，再判定 `missing`；backend 缺席或 IR 版本不相容不影響編輯器分析。
- 不再退回 Basic Plus；副檔名只限制選定提供者的檔案，不用副檔名改選插件；隱式專案維持現有 `bp`／`ev3-native` 預設。
- 分析診斷使用 `stampDiagnostics(diagnostics, binding.pluginId)`；core 載入器診斷維持 `kobrixa.core`；提供者自帶 `source` 時發布 core BUILD1007，刪除 2B-1 相容 adapter。
- 通用 renderer 與 shared 程式碼不得匯入 `@kobrixa/basic-plus`（型別亦同）；只有 Basic Plus companion 與 worker adapter 可以。
- 每個工作區維持分析／Quick Fix worker 與補全 worker 兩條通道；不為每個插件各開 worker。
- `epoch` 附在所有同步請求、回覆、已接受的分析、Quick Fix 請求與補全快取上；pluginId／sourceKey／generation、專案語言、路由設定或 worker 重啟改變時換新 epoch。
- 一般輸入只遞增文件 revision，不換 epoch；取消後仍依序套用文件更新；保留相依 context 快取、有界分析與 fix 歷史、緊湊 token／occurrence 打包與差異更新。
- 補全只在 refresh 時掃描磁碟，補全 50 ms／150 ms 排程不變。
- 效能門檻：熱補全 p95 ≤100 ms、新變數 ≤200 ms、30,000 行 ≤300 ms。
- `unavailable`、`result`（含空診斷）、`resync` 必須可區分；不可用時清除診斷、tokens、補全索引、Quick Fix，保留編輯與既有詞法高亮。
- 語言狀態列使用 `role="status"`；`conflict` 升級為工作區橫幅並列出插件；文字中英雙語，動作為開啟插件設定。
- Wire schemas 必須可匯出為 JSON Schema：不用 refine／transform／coercion，regex 不用 `\d`、`\w`、`\s`、`\b`；關聯驗證放在獨立語意函式。
- desktop 消費 workspace packages 的 `dist/`；套件修改後，先重建再跑 desktop tests 或 `pnpm --filter @kobrixa/desktop check`。
- 內建插件仍受 `PLUGIN_E_BUILTIN_REQUIRED` 保護，不新增只停用語言服務的開關。
- 不實作第三方語言服務、外部程序 RPC 或 2C 靜態語言貢獻；保留編譯期內建 Monaco 註冊橋接。
- 所有命令從 repo 根目錄執行；每個 pnpm 命令前加 `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false;`；lint 使用 `pnpm exec eslint <files>`。

## Review Focus

以下五項是規格隱含、基本 happy-path 測試不會捕捉的失敗模式；各自的 pinning test 放入擁有程式碼的 task。

1. **同一插件、同一語言重新載入，或 routing 設定變了但文件沒打字**：generation／entry／extensions 改變仍須換 epoch；舊成功回覆不能復活。→ Task 2 `advances for generation and routing but not document revisions`、Task 5 `rejects an old result after a same-provider restart`。
2. **取消的文件增量緊接著下一筆增量，與換 epoch 同時發生**：同 epoch 的取消仍推進 revision；跨 epoch 一律完整同步，不能把新提供者套在舊 overlays。→ Task 5 `applies cancelled deltas before the next request and resets across epochs`。
3. **檔名從支援副檔名改成 JSON／未知副檔名，或同路徑換成新 model**：清掉動態功能、pending edits 與 completion decorations，但保留 JSON 功能、詞法高亮及文件內容。→ Task 6 `detaches a renamed or replaced model without losing its text`。
4. **不可用狀態在使用者沒輸入時恢復，或舊 unavailable 晚於新 result 到達**：UI 主動恢復，舊回覆不能再次清掉結果；空診斷成功不顯示不可用。→ Task 6 `recovers without typing and ignores an older unavailable status`、`restarts analysis after availability recovers without a document edit`。
5. **第二語言有 `Foo`／`foo`、不同 token legend，並使用 `BP1043`**：兩個候選都保留，token type 按新 legend 解碼，Quick Fix 只派給其真正來源。→ Task 3 `preserves opaque shadow keys and token dictionaries`、Task 7 `isolates case-sensitive symbols, legends and overlapping diagnostic codes`。

## File Structure

表中 `{a,b}` 是精確檔案集合的縮寫，不代表掃描式修改；各 task 的 Files 與 git add 展開列出。

| 檔案                                                                                                                                                                                                                                                                                          | 建立／修改與責任                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/plugin-protocol/src/{manifest,limits,index}.ts`                                                                                                                                                                                                                                     | 修改：宣告、12 capabilities、語意驗證與 API 常數                                                   |
| `packages/plugin-protocol/src/{language-services,compiler-manifest,diagnostic-help,conformance,json-schema}.test.ts`                                                                                                                                                                          | 新增第一個、修改其餘：結構／語意區分、版本與跨語言 parity                                          |
| `packages/plugin-protocol/conformance/cases.json`                                                                                                                                                                                                                                             | 修改：宣告正反例與 registry 預期                                                                   |
| `packages/plugin-protocol/schema/plugin-protocol.schema.json`、`sdks/python/kobrixa/plugin-protocol.schema.json`                                                                                                                                                                              | exporter 產物，不手編                                                                              |
| `packages/plugin-sdk-js/src/index.test.ts`、`sdks/python/kobrixa/_plugin.py`、`sdks/python/tests/test_plugin.py`、`sdks/python/tests/test_conformance.py`                                                                                                                                     | 修改：API 1.3.0 與結構 conformance                                                                 |
| `plugins/basic-plus/kobrixa-plugin.json`                                                                                                                                                                                                                                                      | 修改：內建宣告                                                                                     |
| `packages/plugin-runtime/src/{registry,errors,compiler-resolution,manager,index}.ts`                                                                                                                                                                                                          | 修改：語意守門、frontend-only resolver、service snapshot 與 generation                             |
| `packages/plugin-runtime/src/{registry,compiler-resolution,manager}.test.ts`、`packages/plugin-runtime/src/language-service-conformance.test.ts`                                                                                                                                              | 修改前三者、新增末者：registry、衝突、不可停用、來源 conformance                                   |
| `packages/compiler/src/{manifest,manifest.test}.ts`                                                                                                                                                                                                                                           | 修改：抽出 `readProjectDescription`，保留 loader 診斷與隱式專案規則                                |
| `apps/desktop/src/shared/language-services.ts`、`apps/desktop/src/shared/language-types.ts`、`apps/desktop/src/shared/language-query.ts`                                                                                                                                                      | 新增：binding/status、DTO、語意查詢契約                                                            |
| `apps/desktop/src/shared/{language-sync,completion-sync,quick-fixes,api}.ts`                                                                                                                                                                                                                  | 修改：通用 DTO、epoch 與 unavailable                                                               |
| `apps/desktop/src/shared/{language-sync,completion-sync,quick-fixes}.test.ts`                                                                                                                                                                                                                 | 修改：打包、delta、來源與 epoch                                                                    |
| `apps/desktop/src/main/workspace/{language-binding,builtin-language-services}.ts`                                                                                                                                                                                                             | 新增：main 選擇／epoch、worker-safe factory 表                                                     |
| `apps/desktop/src/main/workspace/language-binding.test.ts`                                                                                                                                                                                                                                    | 新增：backend 獨立、衝突、路由與 epoch                                                             |
| `apps/desktop/src/main/language/{language-provider,basic-plus-service,basic-plus-results,basic-plus-quick-fixes,basic-plus-outline,language-worker-session,language-lane}.ts`                                                                                                                 | 新增：adapter 契約、原生 session、轉換、專屬 fixes／outline、worker 狀態機、單工作區 analysis lane |
| `apps/desktop/src/main/language/{basic-plus-service,language-worker-session}.test.ts`                                                                                                                                                                                                         | 新增：轉換、原生結果等價與狀態機                                                                   |
| `apps/desktop/src/main/language/{language-worker,completion-worker,language,completion,language-protocol,quick-fix-request}.ts`                                                                                                                                                               | 修改：兩條通道、epoch、取消、驗證及 query 路由                                                     |
| `apps/desktop/src/main/language/{language,quick-fix-request}.test.ts`                                                                                                                                                                                                                         | 修改：保留真 worker 測試與 IPC 邊界測試                                                            |
| `apps/desktop/src/main/workspace/workspace-ipc.test.ts`                                                                                                                                                                                                                                       | 修改：專案設定／外部更新觸發 refresh，普通來源存檔不換 binding                                     |
| `apps/desktop/src/main/plugins/{controller,controller.test}.ts`                                                                                                                                                                                                                               | 修改：轉送 service resolution／state subscription                                                  |
| `apps/desktop/src/main/{index,ipc}.ts`、`apps/desktop/src/preload/index.ts`                                                                                                                                                                                                                   | 修改：注入 resolver、狀態事件與 query IPC                                                          |
| `apps/desktop/src/renderer/editor/{language-companion,builtin-language-companions,language-routing,language-status-store}.ts`                                                                                                                                                                 | 新增：browser 契約、內建表、model 選擇、狀態訂閱                                                   |
| `apps/desktop/src/renderer/editor/companions/basic-plus/{companion,completions,formatting,registration}.ts`                                                                                                                                                                                   | 新增：僅此 renderer 目錄可匯入 Basic Plus；靜態橋接仍為內建                                        |
| `apps/desktop/src/renderer/editor/{editor,language-status}.tsx`                                                                                                                                                                                                                               | 修改 editor、新增狀態列                                                                            |
| `apps/desktop/src/renderer/editor/{language-features,semantic-tokens,completion-cache,completion-session,diagnostic-presentation,basic-plus-language,basic-plus-formatting,editor-format,analysis-session,analysis-transport,outline}.ts`、`apps/desktop/src/renderer/editor/breadcrumbs.tsx` | 修改：Monaco 通用化、路由、epoch 與通用 outline；兩個 basic-plus 舊入口改純 re-export              |
| `apps/desktop/src/renderer/editor/{language-routing,language-status-store,language-status,language-imports}.test.ts`                                                                                                                                                                          | 新增：model 邊界、恢復、UI、匯入邊界                                                               |
| `apps/desktop/src/renderer/editor/{language-features,semantic-tokens,completion-cache,completion-session,diagnostic-presentation,analysis-session,analysis-transport,editor,outline}.test.ts`                                                                                                 | 修改：保留既有測試並轉換 fixture                                                                   |
| `apps/desktop/src/renderer/{app.tsx,i18n/copy.ts,settings/plugin-copy.ts}`、`apps/desktop/src/renderer/workbench/{diagnostic-details.tsx,diagnostic-details.test.ts}`                                                                                                                         | 修改：工作區狀態、雙語、Quick Fix capability                                                       |
| `apps/desktop/src/shared/basic-plus-quick-fixes.ts`                                                                                                                                                                                                                                           | 刪除；專屬 code 資格移到 worker adapter                                                            |
| `apps/desktop/src/main/language/testing/second-language.ts`、`apps/desktop/src/main/language/language-provider.integration.test.ts`                                                                                                                                                           | 新增：只在測試 bundle 註冊的第二語言與整合回歸                                                     |
| `docs/en/architecture.md`、`docs/zh-TW/architecture.md`、`plugins/samples/README.md`、`sdks/python/README.md`                                                                                                                                                                                 | 修改：作者契約、內建限制與架構                                                                     |

## 已核對的基線與實作決定

- `builtin-compilers.ts` 的 `BUILTIN_FRONTENDS` 已以 `pluginId:language` 為鍵；`resolveCompilerProviders` 同時要求 frontend/backend；`markProviderConflicts` 先分組再使雙方 invalid。新 resolver 共用 frontend 選取，但保持舊 build 的 BUILD1001／BUILD1002 訊息。
- `registry.test.ts` 有 `manifest(overrides)`、`plugin(name, value, entry?, prefix?)`、`builtin`、`none`；`compiler-resolution.test.ts` 有 `front`、`back`、`source(id, contributes)`、`sources`、`reads(values?)`、`options`。以下直接使用這些實際 helper。
- `language.test.ts` 的 `root`／`workerRoot`／`workers`／`createWorker`／`service`、`useInjectedAnalyzer()` 與 esbuild 真 worker bundle 已存在；不另造假 `createProject()` helper。
- `language-features.test.ts` 的 `model(file, initial)`、`setup(sources)`、`token`；`completion-session.test.ts` 的 `model(initial)`、`workspace(id)`、`reply(request, documents)`；`analysis-session.test.ts` 的 `harness()`；`analysis-transport.test.ts` 的 `server()`；`semantic-tokens.test.ts` 的 `model(text)`、`read(provider, model)`、`cancellation` 都要沿用。
- `manifest.test.ts` 使用 `fixture(overrides)` 與 `roots` cleanup，沒有共用 `root` 變數；`plugin-copy.ts` 的 `problems` 值為 `[zh-TW, en]` tuple；錯誤碼來自 `PLUGIN_ERROR_CODES` tuple，而非手寫 union。
- `loadProject` 沒有「只讀描述」入口；Task 2 從既有 manifest 前半段抽出，避免 main 為每筆補全重新列舉來源。仍只使用已保存且通過 `parseManifest` 的專案描述；未保存的 `kobrixa.json` 仍由 JSON 編輯器處理，不變更既有專案設定生效時機。
- 「非重複」與 frontend 集合相等是 manifest 語意契約；Zod 結構 schema 不加 refine。conformance 明確分 `valid`（結構）及 `registry`（宿主語意／來源），避免 Python SDK 假裝知道可信來源。這與既有 compiler 宣告的結構／語意分層一致。
- 規格的 `LanguageAvailability` 保持原形；新增外層 `LanguageStatus { epoch, availability, conflicts }`，讓 unavailable 也帶 epoch，並可顯示缺 factory 的擁有者或衝突雙方。generation 是 main 的 fingerprint 輸入，不從 renderer 接受。
- 「提供者回傳通用結果」採 worker 語意 query（hover／signature／definition／references／rename／outline）與 browser companion（即時 completion／formatting）兩種內建介面；沒有新增外部 RPC。原生 AST、名稱折疊、dependency binding、rename 規則留在 adapter。

---

### Task 1: 宣告、registry 語意驗證、API 1.3.0 與 SDK parity

**Files:**

- Modify: `packages/plugin-protocol/src/manifest.ts`、`packages/plugin-protocol/src/limits.ts`、`packages/plugin-protocol/src/index.ts`
- Create: `packages/plugin-protocol/src/language-services.test.ts`、`packages/plugin-runtime/src/language-service-conformance.test.ts`
- Modify: `packages/plugin-protocol/src/compiler-manifest.test.ts`、`packages/plugin-protocol/src/diagnostic-help.test.ts`、`packages/plugin-protocol/src/conformance.test.ts`、`packages/plugin-protocol/src/json-schema.test.ts`
- Modify: `packages/plugin-protocol/conformance/cases.json`、`packages/plugin-protocol/schema/plugin-protocol.schema.json`、`sdks/python/kobrixa/plugin-protocol.schema.json`
- Modify: `packages/plugin-runtime/src/registry.ts`（`semanticProblems`）、`packages/plugin-runtime/src/errors.ts`、`packages/plugin-runtime/src/registry.test.ts`、`packages/plugin-runtime/src/manager.test.ts`
- Modify: `packages/plugin-sdk-js/src/index.test.ts`、`sdks/python/kobrixa/_plugin.py`、`sdks/python/tests/test_plugin.py`、`sdks/python/tests/test_conformance.py`
- Modify: `plugins/basic-plus/kobrixa-plugin.json`、`apps/desktop/src/renderer/settings/plugin-copy.ts`

**Interfaces:**

- Consumes: `compilerIdSchema`、`extensionSchema`、`pluginManifestSchema`、`readSource(source: PluginSource, options: { safeMode: boolean; timeoutMs?: number }): Promise<ReadPlugin>`。
- Produces: `LANGUAGE_CAPABILITIES`（下面的 readonly tuple）、`LanguageCapability`、`LanguageServiceDecl`、`languageServiceDeclSchema`、`languageServiceDeclarationProblems(manifest: PluginManifest): string[]`；`PluginErrorCode` 新成員 `PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN`。

- [ ] **Step 1: 寫結構與語意的失敗測試**

建立 `packages/plugin-protocol/src/language-services.test.ts`：

```ts
import { expect, it } from "vitest";
import {
  LANGUAGE_CAPABILITIES,
  PLUGIN_API_VERSION,
  pluginManifestSchema,
  languageServiceDeclarationProblems,
} from "./index.js";

const front = {
  language: "bp",
  entryExtensions: ["bp"],
  sourceExtensions: ["bp", "bpi", "bpm"],
  ir: { min: 1, max: 1 },
};
const service = { language: "bp", extensions: front.sourceExtensions, capabilities: ["analysis"] };
const value = (languageServices: unknown, frontends: unknown = [front]) => ({
  id: "test.language",
  version: "1.0.0",
  apiVersion: "^1.3.0",
  runtime: { kind: "builtin" },
  contributes: { frontends, languageServices },
});
it("exports API 1.3.0 and exactly twelve capabilities", () => {
  expect(PLUGIN_API_VERSION).toBe("1.3.0");
  expect(LANGUAGE_CAPABILITIES).toEqual([
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
  ]);
});
it("accepts eight declarations and rejects nine, empty fields and unknown fields", () => {
  expect(pluginManifestSchema.safeParse(value(Array(8).fill(service))).success).toBe(true);
  for (const declarations of [
    Array(9).fill(service),
    [{ ...service, extensions: [] }],
    [{ ...service, capabilities: [] }],
    [{ ...service, capabilities: ["compile"] }],
    [{ ...service, language: "BP" }],
    [{ ...service, extensions: [".bp"] }],
    [{ ...service, implementation: "service.js" }],
  ])
    expect(pluginManifestSchema.safeParse(value(declarations)).success).toBe(false);
});
it("checks unique values, analysis and exact frontend ownership after structural parsing", () => {
  const check = (services: unknown, fronts: unknown = [front]) =>
    languageServiceDeclarationProblems(pluginManifestSchema.parse(value(services, fronts)));
  expect(check([{ ...service, extensions: ["bpm", "bp", "bpi"] }])).toEqual([]);
  for (const services of [
    [service, service],
    [{ ...service, capabilities: ["completion"] }],
    [{ ...service, capabilities: ["analysis", "analysis"] }],
    [{ ...service, extensions: ["bp", "bpi", "bpm", "bp"] }],
    [{ ...service, extensions: ["bp"] }],
  ])
    expect(check(services)).not.toEqual([]);
  expect(check([service], [])).not.toEqual([]);
  expect(check([service], [{ ...front, language: "other" }])).not.toEqual([]);
});
```

在 `registry.test.ts` 的 `describe("loadPlugins")` 加入，使用現有 `plugin`、`manifest`、`none`：

```ts
it.each([[], [{ language: "bp", extensions: ["bp"], capabilities: ["analysis"] }]])(
  "rejects development languageServices even when empty: %j",
  async (languageServices) => {
    const source = await plugin("language", manifest({ contributes: { languageServices } }));
    const [loaded] = await loadPlugins([source], none);
    expect(loaded?.status).toBe("invalid");
    expect(loaded?.problems.map((p) => p.code)).toContain(
      "PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN",
    );
  },
);
it("rejects a built-in language declaration without its frontend", async () => {
  await expect(
    readSource(
      {
        kind: "builtin",
        manifest: {
          id: "test.language",
          version: "1.0.0",
          apiVersion: "^1.3.0",
          runtime: { kind: "builtin" },
          contributes: {
            languageServices: [{ language: "bp", extensions: ["bp"], capabilities: ["analysis"] }],
          },
        },
      },
      { safeMode: false },
    ),
  ).rejects.toThrow("Invalid built-in plugin manifest");
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol exec vitest run src/language-services.test.ts`

Expected: FAIL（缺少 `LANGUAGE_CAPABILITIES`／`languageServiceDeclarationProblems` 匯出；目前版本仍是 1.2.0）。

- [ ] **Step 3: 實作宣告與語意檢查**

在 `manifest.ts` 的 `FrontendDecl` 定義之前加入；所有既有 schema 維持原本 loose／strict 選擇，只有新宣告 strict：

```ts
export const LANGUAGE_CAPABILITIES = [
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
] as const;
export const languageCapabilitySchema = z.enum(LANGUAGE_CAPABILITIES);
export type LanguageCapability = z.infer<typeof languageCapabilitySchema>;
export const languageServiceDeclSchema = z.strictObject({
  language: compilerIdSchema,
  extensions: z.array(extensionSchema).min(1),
  capabilities: z.array(languageCapabilitySchema).min(1),
});
export type LanguageServiceDecl = z.infer<typeof languageServiceDeclSchema>;
```

`contributes` 增加 `languageServices: z.array(languageServiceDeclSchema).max(8).optional(),`。檔尾加入：

```ts
export function languageServiceDeclarationProblems(manifest: PluginManifest): string[] {
  const problems: string[] = [];
  const languages = new Set<string>();
  for (const service of manifest.contributes?.languageServices ?? []) {
    if (languages.has(service.language))
      problems.push("Language services must have unique languages.");
    languages.add(service.language);
    if (new Set(service.extensions).size !== service.extensions.length)
      problems.push("Language service extensions must be unique.");
    if (new Set(service.capabilities).size !== service.capabilities.length)
      problems.push("Language service capabilities must be unique.");
    if (!service.capabilities.includes("analysis"))
      problems.push("Language services must support analysis.");
    const frontends = (manifest.contributes?.frontends ?? []).filter(
      (f) => f.language === service.language,
    );
    const frontend = frontends[0];
    if (
      frontends.length !== 1 ||
      !frontend ||
      new Set(frontend.sourceExtensions).size !== new Set(service.extensions).size ||
      frontend.sourceExtensions.some((extension) => !service.extensions.includes(extension))
    )
      problems.push(
        "Language services require one matching frontend with the same source extensions.",
      );
  }
  return problems;
}
```

確認 `index.ts` 的 `export * from "./manifest.js"` 保留。`limits.ts` 改 `export const PLUGIN_API_VERSION = "1.3.0";`。`registry.ts` 匯入新函式；在 `semanticProblems` 的 compiler 檢查後加入：

```ts
problems.push(
  ...languageServiceDeclarationProblems(manifest).map((message) =>
    problem("PLUGIN_E_MANIFEST", message),
  ),
);
if (manifest.contributes?.languageServices !== undefined && source !== "builtin")
  problems.push(
    problem(
      "PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN",
      "Language services can only be contributed by built-in plugins in this version.",
    ),
  );
```

`errors.ts` 的 `PLUGIN_ERROR_CODES` tuple 加 `"PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN",`，`PluginErrorCode` 自動推導。`plugin-copy.ts` 現有 `problems: Record<string, [string, string]>` 對照表加入：

```ts
PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN: [
  "此版本僅允許內建插件提供語言服務。",
  "Only built-in plugins can provide language services in this version.",
],
```

保持現有 `problemText(problem, locale)` 的陣列索引查詢。

- [ ] **Step 4: 加入跨語言 conformance 與版本測試**

`conformance/cases.json` 末尾加入以下完整案例。`registry` 是 runtime 測試專用期望；TypeScript/Python 結構 runner 仍只讀 `definition`、`valid`、`value`：

```json
[
  {
    "name": "API 1.3 built-in language services",
    "definition": "manifest",
    "valid": true,
    "registry": { "source": "builtin", "codes": [] },
    "value": {
      "id": "test.language",
      "version": "1.0.0",
      "apiVersion": "^1.3.0",
      "runtime": { "kind": "builtin" },
      "contributes": {
        "frontends": [
          {
            "language": "case",
            "entryExtensions": ["csx"],
            "sourceExtensions": ["csx"],
            "ir": { "min": 1, "max": 1 }
          }
        ],
        "languageServices": [
          { "language": "case", "extensions": ["csx"], "capabilities": ["analysis", "completion"] }
        ]
      }
    }
  },
  {
    "name": "language service rejects implementation path",
    "definition": "manifest",
    "valid": false,
    "value": {
      "id": "test.language",
      "version": "1.0.0",
      "apiVersion": "^1.3.0",
      "runtime": { "kind": "builtin" },
      "contributes": {
        "languageServices": [
          {
            "language": "case",
            "extensions": ["csx"],
            "capabilities": ["analysis"],
            "entry": "service.js"
          }
        ]
      }
    }
  },
  {
    "name": "language service rejects empty capabilities",
    "definition": "manifest",
    "valid": false,
    "value": {
      "id": "test.language",
      "version": "1.0.0",
      "apiVersion": "^1.3.0",
      "runtime": { "kind": "builtin" },
      "contributes": {
        "languageServices": [{ "language": "case", "extensions": ["csx"], "capabilities": [] }]
      }
    }
  },
  {
    "name": "development empty services are structurally valid but forbidden by registry",
    "definition": "manifest",
    "valid": true,
    "registry": {
      "source": "development",
      "codes": ["PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN"]
    },
    "value": {
      "id": "test.language",
      "version": "1.0.0",
      "apiVersion": "^1.3.0",
      "runtime": { "kind": "node", "entry": "main.js" },
      "contributes": { "languageServices": [] }
    }
  }
]
```

建立 `language-service-conformance.test.ts`，沒有對 production 暴露可偽造來源的入口：

```ts
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { readSource, resolvePlugins } from "./index.js";
const cases = JSON.parse(
  await readFile(new URL("../../plugin-protocol/conformance/cases.json", import.meta.url), "utf8"),
) as Array<{
  name: string;
  value: unknown;
  registry?: { source: "builtin" | "development"; codes: string[] };
}>;
it.each(cases.filter((item) => item.registry))("registry: $name", async (item) => {
  const root = await mkdtemp(path.join(tmpdir(), "kobrixa-service-conformance-"));
  try {
    await writeFile(path.join(root, "kobrixa-plugin.json"), JSON.stringify(item.value));
    await writeFile(path.join(root, "main.js"), "");
    const read = await readSource(
      item.registry!.source === "builtin"
        ? { kind: "builtin", manifest: item.value }
        : { kind: "development", directory: root },
      { safeMode: false },
    );
    const [plugin] = resolvePlugins([read], { safeMode: false, disabled: new Set() });
    expect(plugin!.problems.map((p) => p.code).sort()).toEqual([...item.registry!.codes].sort());
    expect(plugin!.status).toBe(item.registry!.codes.length ? "invalid" : "enabled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

版本 edits 為精確值替換：`_plugin.py` 的 `API_VERSION = "1.3.0"`；`test_plugin.py` initialize result、`plugin-sdk-js/src/index.test.ts` 的 `API_VERSION` 與 initialize result、`compiler-manifest.test.ts`、`diagnostic-help.test.ts` 的當前版本斷言改 `1.3.0`。保留原 `^1.0.0`／`^1.1.0`／`^1.2.0` fixture，驗證向後相容。JS SDK 常數本來重匯出 protocol，無需另造常數。`json-schema.test.ts` 加：

```ts
it("publishes the 1.3.0 schema and a strict language service declaration", () => {
  const schema = JSON.parse(serializeJsonSchema());
  expect(schema.$id).toBe("https://kobrixa.com/schemas/plugin-protocol/1.3.0.json");
  const services = schema.$defs.manifest.properties.contributes.properties.languageServices;
  expect(services.maxItems).toBe(8);
  expect(services.items.additionalProperties).toBe(false);
});
```

`sdks/python/tests/test_conformance.py` 的 `ConformanceTest` 加：

```python
    def test_language_services_are_strict_and_api_is_1_3(self):
        from kobrixa._plugin import API_VERSION
        self.assertEqual(API_VERSION, "1.3.0")
        validator = Validator.bundled()
        value = {"id": "test.language", "version": "1.0.0", "apiVersion": "^1.3.0",
                 "runtime": {"kind": "builtin"}, "contributes": {"languageServices": [
                     {"language": "case", "extensions": ["csx"], "capabilities": ["analysis"]}]}}
        validator.validate("manifest", value)
        value["contributes"]["languageServices"][0]["entry"] = "service.py"
        with self.assertRaises(SchemaError):
            validator.validate("manifest", value)
```

`plugins/basic-plus/kobrixa-plugin.json` 保留既有 frontend，在 `contributes` 加：

```json
"languageServices": [{
  "language": "bp", "extensions": ["bp", "bpi", "bpm"],
  "capabilities": ["analysis", "completion", "quickFixes", "semanticTokens", "hover", "signatureHelp", "definition", "references", "rename", "documentSymbols", "documentFormatting", "rangeFormatting"]
}]
```

同檔把 `"apiVersion": "^1.1.0"` 改成 `"apiVersion": "^1.3.0"`。`manager.test.ts` 沿用實際 `create`／`builtin` fixture，加入以下測試而不改 manager 的停用保護：

```ts
it("keeps a built-in language-service plugin required", async () => {
  const manifest = {
    ...builtin.manifest,
    apiVersion: "^1.3.0",
    contributes: {
      ...builtin.manifest.contributes,
      languageServices: [
        { language: "bp", extensions: ["bp", "bpi", "bpm"], capabilities: ["analysis"] },
      ],
    },
  };
  const manager = await create([{ kind: "builtin", manifest }]);
  try {
    expect(await manager.setEnabled("builtin:kobrixa.basic-plus", false)).toMatchObject({
      ok: false,
      code: "PLUGIN_E_BUILTIN_REQUIRED",
    });
    expect(manager.state().plugins[0]?.status).toBe("enabled");
  } finally {
    await manager.shutdown();
  }
});
```

- [ ] **Step 5: 重新產生 schema 並確認 PASS**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol schema
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol test
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime test
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-sdk test
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm test:python-sdk
```

Expected: PASS，包括兩份 JSON Schema parity、portable patterns、keyword allowlist、既有 manager 的 built-in 禁止停用測試。不得為了測試第二語言移除 `PLUGIN_E_BUILTIN_REQUIRED`。

- [ ] **Step 6: 格式化、lint 與 commit**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --write packages/plugin-protocol/src packages/plugin-protocol/conformance/cases.json packages/plugin-runtime/src packages/plugin-sdk-js/src/index.test.ts plugins/basic-plus/kobrixa-plugin.json apps/desktop/src/renderer/settings/plugin-copy.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --check packages/plugin-protocol/src packages/plugin-runtime/src packages/plugin-sdk-js/src/index.test.ts plugins/basic-plus/kobrixa-plugin.json apps/desktop/src/renderer/settings/plugin-copy.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec eslint packages/plugin-protocol/src packages/plugin-runtime/src packages/plugin-sdk-js/src/index.test.ts apps/desktop/src/renderer/settings/plugin-copy.ts
git add packages/plugin-protocol/src/manifest.ts packages/plugin-protocol/src/limits.ts packages/plugin-protocol/src/index.ts packages/plugin-protocol/src/language-services.test.ts packages/plugin-protocol/src/compiler-manifest.test.ts packages/plugin-protocol/src/diagnostic-help.test.ts packages/plugin-protocol/src/conformance.test.ts packages/plugin-protocol/src/json-schema.test.ts packages/plugin-protocol/conformance/cases.json packages/plugin-protocol/schema/plugin-protocol.schema.json packages/plugin-runtime/src/registry.ts packages/plugin-runtime/src/errors.ts packages/plugin-runtime/src/registry.test.ts packages/plugin-runtime/src/manager.test.ts packages/plugin-runtime/src/language-service-conformance.test.ts packages/plugin-sdk-js/src/index.test.ts sdks/python/kobrixa/_plugin.py sdks/python/kobrixa/plugin-protocol.schema.json sdks/python/tests/test_plugin.py sdks/python/tests/test_conformance.py plugins/basic-plus/kobrixa-plugin.json apps/desktop/src/renderer/settings/plugin-copy.ts
git commit -m "feat(protocol): declare built-in language services in plugin API 1.3.0"
```

---

### Task 2: Frontend-only 解析、描述讀取與工作區 epoch

**Files:**

- Modify: `packages/plugin-runtime/src/compiler-resolution.ts`、`packages/plugin-runtime/src/compiler-resolution.test.ts`、`packages/plugin-runtime/src/manager.ts`、`packages/plugin-runtime/src/index.ts`
- Modify: `packages/compiler/src/manifest.ts`（原 `loadProject` 223–341）、`packages/compiler/src/manifest.test.ts`
- Create: `apps/desktop/src/shared/language-services.ts`、`apps/desktop/src/main/workspace/language-binding.ts`、`apps/desktop/src/main/workspace/language-binding.test.ts`
- Modify: `apps/desktop/src/main/plugins/controller.ts`、`apps/desktop/src/main/plugins/controller.test.ts`

**Interfaces:**

- Consumes: `RegisteredPlugin`、`ProviderRef<FrontendDecl>`、`LanguageServiceDecl`、`ProjectManifest`、`parseManifest(value: unknown)`。
- Produces: `resolveFrontendProvider(plugins: readonly RegisteredPlugin[], language: string): FrontendResolution`；`PluginManager.resolveLanguageService(language: string): LanguageServiceResolution`；`PluginController.resolveLanguageService(language: string): LanguageServiceResolution`。
- Produces: `readProjectDescription(inputPath: string, selectedEntry?: string): Promise<ProjectDescriptionResult>`；`LanguageBindings.select(workspaceId: string, manifest: ProjectManifest, resolution: LanguageServiceResolution, routingKey?: string): LanguageStatus`、`.restart(workspaceId: string): LanguageStatus | undefined`、`.get(workspaceId: string): LanguageStatus | undefined`、`.forget(workspaceId: string): void`。
- `LanguageBinding`／`LanguageAvailability`／`LanguageStatus` 的完整形狀見 Step 5，供 Task 3–7 使用。epoch 為宿主正整數；renderer 不指定 pluginId、factory 或 frontend。

- [ ] **Step 1: 在既有 resolver 測試寫失敗案例**

`compiler-resolution.test.ts` 匯入 `resolveFrontendProvider`，使用已有 `front`、`back`、`source`、`reads`、`options`：

```ts
it("resolves a frontend without a backend or compatible backend IR", async () => {
  for (const values of [
    [source("test.front", { frontends: [front] })],
    [
      source("test.front", { frontends: [front] }),
      source("test.back", {
        backends: [{ ...back, ir: { min: 99, max: 100 } }],
      }),
    ],
  ]) {
    const plugins = resolvePlugins(await reads(values), options);
    expect(resolveFrontendProvider(plugins, "test")).toMatchObject({
      ok: true,
      frontend: { pluginId: "test.front", contribution: front },
    });
    expect(resolveCompilerProviders(plugins, "test", "test-vm").ok).toBe(false);
  }
});
it("reports both invalid frontend owners as conflict before missing", async () => {
  const plugins = resolvePlugins(
    await reads([
      source("test.one", { frontends: [front] }),
      source("test.two", { frontends: [front] }),
    ]),
    options,
  );
  expect(plugins.map((p) => p.status)).toEqual(["invalid", "invalid"]);
  expect(resolveFrontendProvider(plugins, "test")).toEqual({
    ok: false,
    reason: "conflict",
    language: "test",
    conflicts: ["test.one", "test.two"],
  });
  expect(resolveFrontendProvider(plugins, "other")).toEqual({
    ok: false,
    reason: "missing",
    language: "other",
    conflicts: [],
  });
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime exec vitest run src/compiler-resolution.test.ts`

Expected: FAIL（新 resolver 不存在）。

- [ ] **Step 3: 抽 frontend resolver，保留 build 行為**

`compiler-resolution.ts` 加入以下程式。`resolveCompilerProviders` 刪除原本 `frontends` 建構式，改為 `const selected = resolveFrontendProvider(plugins, language);`；原 `if (frontends.length !== 1 || backends.length !== 1)` 改 `if (!selected.ok || backends.length !== 1)`；`const frontend = frontends[0]!` 改 `const frontend = selected.frontend`。錯誤訊息、backend 選擇與 IR intersection 不改。

```ts
export type FrontendResolution =
  | { ok: true; frontend: ProviderRef<FrontendDecl> }
  | { ok: false; reason: "missing" | "conflict"; language: string; conflicts: string[] };

export function resolveFrontendProvider(
  plugins: readonly RegisteredPlugin[],
  language: string,
): FrontendResolution {
  const message = `Multiple enabled plugins provide language:${language}.`;
  const conflicts = plugins
    .filter((plugin) =>
      plugin.problems.some((p) => p.code === "PLUGIN_E_PROVIDER_CONFLICT" && p.message === message),
    )
    .map((plugin) => plugin.id)
    .sort();
  if (conflicts.length) return { ok: false, reason: "conflict", language, conflicts };
  const frontends = plugins
    .filter((p) => p.status === "enabled")
    .flatMap((plugin) =>
      (plugin.manifest?.contributes?.frontends ?? [])
        .filter((f) => f.language === language)
        .map((contribution) => ({
          pluginId: plugin.id,
          sourceKey: plugin.sourceKey,
          contribution,
        })),
    );
  if (frontends.length > 1)
    return {
      ok: false,
      reason: "conflict",
      language,
      conflicts: frontends.map((f) => f.pluginId).sort(),
    };
  return frontends.length === 1
    ? structuredClone({ ok: true, frontend: frontends[0]! })
    : { ok: false, reason: "missing", language, conflicts: [] };
}
```

同檔匯入 `LanguageServiceDecl` 並加入 resolution；`index.ts` 透過既有 compiler-resolution 重匯出：

```ts
export type LanguageServiceResolution =
  | {
      ok: true;
      frontend: ProviderRef<FrontendDecl>;
      generation: number;
      declaration: LanguageServiceDecl;
    }
  | { ok: false; reason: "missing" | "conflict"; language: string; conflicts: string[] };
```

`manager.ts` 匯入新 resolver/type，加入方法（使用真正的 `#entries`，不從 summary 猜 manifest 或 generation）：

```ts
resolveLanguageService(language: string): LanguageServiceResolution {
  const result = resolveFrontendProvider(this.#entries.map((entry) => entry.plugin), language);
  if (!result.ok) return result;
  const entry = this.#entries.find((entry) => entry.plugin.sourceKey === result.frontend.sourceKey)!;
  const declaration = entry.plugin.manifest?.contributes?.languageServices?.find((s) => s.language === language);
  return declaration
    ? structuredClone({ ok: true, frontend: result.frontend, generation: entry.generation, declaration })
    : { ok: false, reason: "missing", language, conflicts: [] };
}
```

`PluginManagerPort` 加 `"resolveLanguageService"`；`controller.ts` 加：

```ts
resolveLanguageService(language: string): ReturnType<PluginManager["resolveLanguageService"]> {
  return this.deps.manager.resolveLanguageService(language);
}
```

`controller.test.ts` 現有 fake manager 加 `resolveLanguageService: vi.fn((language: string) => ({ ok: false as const, reason: "missing" as const, language, conflicts: [] }))`；在 fake manager describe 加：

```ts
it("forwards frontend-only language service selection", () => {
  const { controller } = setup();
  expect(controller.resolveLanguageService("case")).toEqual({
    ok: false,
    reason: "missing",
    language: "case",
    conflicts: [],
  });
});
```

- [ ] **Step 4: 寫 epoch 與 factory capability 的失敗測試**

建立 `language-binding.test.ts`（所有新 helper 在此定義）：

```ts
import { expect, it, vi } from "vitest";
import type { ProjectManifest } from "@kobrixa/compiler";
import type { LanguageServiceResolution } from "@kobrixa/plugin-runtime";
import { LanguageBindings } from "./language-binding.js";
const manifest: ProjectManifest = {
  schemaVersion: 1,
  name: "test",
  language: "case",
  target: "missing-vm",
  entry: "main.csx",
  outputDir: "out",
  assets: [],
};
const resolution = (generation = 0): LanguageServiceResolution => ({
  ok: true,
  generation,
  frontend: {
    pluginId: "test.case",
    sourceKey: "builtin:test.case",
    contribution: {
      language: "case",
      entryExtensions: ["csx"],
      sourceExtensions: ["csx"],
      ir: { min: 1, max: 1 },
    },
  },
  declaration: { language: "case", extensions: ["csx"], capabilities: ["analysis"] },
});
it("advances for generation and routing but not document revisions", () => {
  const bindings = new LanguageBindings({ "test.case:case": { capabilities: ["analysis"] } });
  const one = bindings.select("w", manifest, resolution());
  expect(bindings.select("w", { ...manifest, name: "renamed" }, resolution()).epoch).toBe(
    one.epoch,
  );
  const two = bindings.select("w", manifest, resolution(1));
  expect(two.epoch).toBeGreaterThan(one.epoch);
  const three = bindings.select("w", { ...manifest, entry: "next.csx" }, resolution(1));
  expect(three.epoch).toBeGreaterThan(two.epoch);
  expect(bindings.restart("w")!.epoch).toBeGreaterThan(three.epoch);
  expect(bindings.select("other", manifest, resolution()).epoch).toBeGreaterThan(three.epoch);
});
it("marks missing factories and capability mismatches as conflict without changing plugin state", () => {
  const log = vi.fn();
  const selected = resolution();
  const bindings = new LanguageBindings({}, log);
  expect(bindings.select("w", manifest, selected)).toMatchObject({
    availability: { kind: "unavailable", reason: "conflict", language: "case" },
    conflicts: ["test.case"],
  });
  expect(log).toHaveBeenCalledOnce();
  expect(selected).toEqual(resolution());
  const incompatible = new LanguageBindings({ "test.case:case": { capabilities: [] } }, log);
  expect(incompatible.select("w", manifest, selected).availability.kind).toBe("unavailable");
});
it("distinguishes missing, conflicts and available transitions with detached snapshots", () => {
  const bindings = new LanguageBindings({ "test.case:case": { capabilities: ["analysis"] } });
  const one = bindings.select("w", manifest, resolution());
  if (one.availability.kind !== "available") throw new Error("Expected binding");
  one.availability.binding.extensions.push("json");
  const missing = bindings.select("w", manifest, {
    ok: false,
    reason: "missing",
    language: "case",
    conflicts: [],
  });
  const recovered = bindings.select("w", manifest, resolution());
  expect(recovered.epoch).toBeGreaterThan(missing.epoch);
  expect(recovered.availability).toMatchObject({ binding: { extensions: ["csx"] } });
});
```

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime build`

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/workspace/language-binding.test.ts`

Expected: FAIL（`LanguageBindings` 模組尚未建立）。

- [ ] **Step 5: 實作 binding DTO 與 coordinator**

`shared/language-services.ts`：

```ts
import type { FrontendDecl, LanguageCapability } from "@kobrixa/plugin-protocol";
export type LanguageBinding = {
  epoch: number;
  pluginId: string;
  sourceKey: string;
  language: string;
  extensions: string[];
  capabilities: LanguageCapability[];
  frontend: FrontendDecl;
};
export type LanguageAvailability =
  | { kind: "available"; binding: LanguageBinding }
  | { kind: "unavailable"; reason: "missing" | "conflict"; language: string };
export interface LanguageStatus {
  epoch: number;
  availability: LanguageAvailability;
  conflicts: string[];
}
export interface LanguageStatusEvent {
  workspaceId: string;
  status: LanguageStatus;
}
export const bindingKey = (binding: LanguageBinding): string =>
  `${binding.pluginId}:${binding.language}`;
export function supportsFile(binding: LanguageBinding, file: string): boolean {
  const name = file.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 && binding.extensions.includes(name.slice(dot + 1).toLowerCase());
}
```

`main/workspace/language-binding.ts`：

```ts
import type { ProjectManifest } from "@kobrixa/compiler";
import type { LanguageCapability } from "@kobrixa/plugin-protocol";
import type { LanguageServiceResolution } from "@kobrixa/plugin-runtime";
import type { LanguageStatus } from "../../shared/language-services.js";

export class LanguageBindings {
  private nextEpoch = 0;
  private states = new Map<string, { fingerprint: string; status: LanguageStatus }>();
  constructor(
    private readonly factories: Readonly<
      Record<string, { capabilities: readonly LanguageCapability[] }>
    >,
    private readonly log: (message: string) => void = console.error,
  ) {}
  select(
    workspaceId: string,
    manifest: ProjectManifest,
    resolution: LanguageServiceResolution,
    routingKey = "",
  ): LanguageStatus {
    const fingerprint = JSON.stringify([
      routingKey,
      manifest.language,
      manifest.entry,
      manifest.outputDir,
      resolution,
    ]);
    const previous = this.states.get(workspaceId);
    if (previous?.fingerprint === fingerprint) return structuredClone(previous.status);
    const epoch = ++this.nextEpoch;
    let status: LanguageStatus;
    if (!resolution.ok)
      status = {
        epoch,
        availability: {
          kind: "unavailable",
          reason: resolution.reason,
          language: manifest.language,
        },
        conflicts: [...resolution.conflicts],
      };
    else {
      const { frontend, declaration } = resolution;
      const key = `${frontend.pluginId}:${manifest.language}`;
      const factory = this.factories[key];
      if (
        !factory ||
        declaration.capabilities.some((capability) => !factory.capabilities.includes(capability))
      ) {
        this.log(`Language service factory is missing or incompatible: ${key}.`);
        status = {
          epoch,
          conflicts: [frontend.pluginId],
          availability: {
            kind: "unavailable",
            reason: "conflict",
            language: manifest.language,
          },
        };
      } else
        status = {
          epoch,
          conflicts: [],
          availability: {
            kind: "available",
            binding: {
              epoch,
              pluginId: frontend.pluginId,
              sourceKey: frontend.sourceKey,
              language: declaration.language,
              extensions: [...declaration.extensions],
              capabilities: [...declaration.capabilities],
              frontend: structuredClone(frontend.contribution),
            },
          },
        };
    }
    this.states.set(workspaceId, { fingerprint, status });
    return structuredClone(status);
  }
  restart(workspaceId: string): LanguageStatus | undefined {
    const entry = this.states.get(workspaceId);
    if (!entry) return;
    entry.status.epoch = ++this.nextEpoch;
    if (entry.status.availability.kind === "available")
      entry.status.availability.binding.epoch = entry.status.epoch;
    return structuredClone(entry.status);
  }
  get(workspaceId: string): LanguageStatus | undefined {
    const status = this.states.get(workspaceId)?.status;
    return status && structuredClone(status);
  }
  forget(workspaceId: string): void {
    this.states.delete(workspaceId);
  }
}
```

同一 coordinator 的 epoch 全域單調，仍以工作區保存狀態；`forget` 不歸零 counter，避免關閉再開啟後碰撞。文件 revision 不傳入 fingerprint；factory table 編譯期固定。

- [ ] **Step 6: 寫只讀描述的失敗測試**

在 `packages/compiler/src/manifest.test.ts` 匯入 `readProjectDescription`，使用該檔實際的 `fixture(overrides)`，由既有 `roots`／afterEach 清理：

```ts
it("reads a validated description without loading sources or requiring a backend", async () => {
  const root = await fixture();
  const value = {
    schemaVersion: 1,
    name: "case",
    language: "case",
    target: "missing-vm",
    entry: "not-created.csx",
    assets: [],
    outputDir: "out",
  };
  await writeFile(path.join(root, "kobrixa.json"), JSON.stringify(value));
  expect(await readProjectDescription(root)).toMatchObject({
    description: { root, manifest: value, implicit: false },
    diagnostics: [],
    implicit: false,
  });
  await writeFile(path.join(root, "kobrixa.json"), "{");
  expect((await readProjectDescription(root)).diagnostics).toEqual([
    expect.objectContaining({ source: "kobrixa.core", code: "MAN1001" }),
  ]);
});
```

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/compiler exec vitest run src/manifest.test.ts`

Expected: FAIL（沒有 `readProjectDescription`）。

- [ ] **Step 7: 抽取 loader 的描述階段，保留來源階段**

在 `manifest.ts` 加以下型別與函式；把原 `loadProject` 從 `const stat = await lstat(inputPath)` 到 `else` 的 MAN1000 return 整段搬入 `try`，唯一變動是所有描述失敗 return 仍回 diagnostics／implicit，而成功路徑加下面的 return。這是原程式的完整區段搬移，不重寫 `parseManifest`、`implicitManifest`、候選排序或錯誤碼。

```ts
export interface ProjectDescription {
  root: string;
  manifest: ProjectManifest;
  implicit: boolean;
}
export interface ProjectDescriptionResult {
  description?: ProjectDescription;
  diagnostics: Diagnostic[];
  implicit: boolean;
  candidates?: string[];
}
```

抽取後的入口／尾端為：

```ts
export async function readProjectDescription(
  inputPath: string,
  selectedEntry?: string,
): Promise<ProjectDescriptionResult> {
  const diagnostics: Diagnostic[] = [];
  try {
    const stat = await lstat(inputPath);
    let root: string;
    let manifest: ProjectManifest;
    let implicit = false;

    if (stat.isFile() && inputPath.toLocaleLowerCase("en-US").endsWith("kobrixa.json")) {
      root = path.dirname(inputPath);
      const raw: unknown = JSON.parse(await readFile(inputPath, "utf8"));
      const parsed = parseManifest(raw);
      if (!parsed.manifest) return { diagnostics: parsed.diagnostics, implicit: false };
      manifest = parsed.manifest;
    } else if (stat.isFile() && inputPath.toLocaleLowerCase("en-US").endsWith(".bp")) {
      root = path.dirname(inputPath);
      const entry = path.basename(inputPath);
      manifest = implicitManifest(entry);
      implicit = true;
    } else if (stat.isDirectory()) {
      root = inputPath;
      const manifestPath = path.join(root, "kobrixa.json");
      try {
        const raw: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
        const parsed = parseManifest(raw);
        if (!parsed.manifest) return { diagnostics: parsed.diagnostics, implicit: false };
        manifest = parsed.manifest;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        const candidates = (
          await fg("**/*.bp", {
            cwd: root,
            onlyFiles: true,
            dot: false,
            followSymbolicLinks: false,
            braceExpansion: false,
          })
        ).sort();
        const entry = selectedEntry ?? (candidates.length === 1 ? candidates[0] : undefined);
        if (!entry) return { diagnostics, implicit: true, candidates };
        manifest = implicitManifest(entry);
        implicit = true;
      }
    } else {
      return {
        diagnostics: [diagnostic("MAN1000", "Open a folder, kobrixa.json, or .bp file.")],
        implicit: false,
      };
    }

    return { description: { root, manifest, implicit }, diagnostics, implicit };
  } catch (error) {
    return {
      diagnostics: [
        diagnostic(
          error instanceof SyntaxError ? "MAN1001" : "MAN1002",
          error instanceof Error ? error.message : "Unable to load project.",
        ),
      ],
      implicit: false,
    };
  }
}
```

`loadProject` 原描述區段由以下精確程式替換；其後 `resolveInside`、資源、`resolveFrontend`、`loadSources`、BuildError 處理原封保留：

```ts
const described = await readProjectDescription(inputPath, selectedEntry);
if (!described.description) return described;
const { root, implicit } = described.description;
let { manifest } = described.description;
```

此 helper 每次只讀描述；顯式專案不 glob。隱式專案僅選 entry 時列舉原有 `.bp` 候選；Task 5 在 initial／refresh 使用 helper，一般 completion delta 使用快取 descriptor。worker 的 loader 仍重新核對語言；不以 main 的快取取代 worker 驗證。

- [ ] **Step 8: 確認 PASS、格式化與 commit**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/compiler test
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime test
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/compiler build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/workspace/language-binding.test.ts src/main/plugins/controller.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --write packages/compiler/src/manifest.ts packages/compiler/src/manifest.test.ts packages/plugin-runtime/src/compiler-resolution.ts packages/plugin-runtime/src/compiler-resolution.test.ts packages/plugin-runtime/src/manager.ts apps/desktop/src/shared/language-services.ts apps/desktop/src/main/workspace/language-binding.ts apps/desktop/src/main/workspace/language-binding.test.ts apps/desktop/src/main/plugins/controller.ts apps/desktop/src/main/plugins/controller.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec eslint packages/compiler/src/manifest.ts packages/compiler/src/manifest.test.ts packages/plugin-runtime/src/compiler-resolution.ts packages/plugin-runtime/src/compiler-resolution.test.ts packages/plugin-runtime/src/manager.ts apps/desktop/src/shared/language-services.ts apps/desktop/src/main/workspace/language-binding.ts apps/desktop/src/main/workspace/language-binding.test.ts apps/desktop/src/main/plugins/controller.ts apps/desktop/src/main/plugins/controller.test.ts
git add packages/compiler/src/manifest.ts packages/compiler/src/manifest.test.ts packages/plugin-runtime/src/compiler-resolution.ts packages/plugin-runtime/src/compiler-resolution.test.ts packages/plugin-runtime/src/manager.ts packages/plugin-runtime/src/index.ts apps/desktop/src/shared/language-services.ts apps/desktop/src/main/workspace/language-binding.ts apps/desktop/src/main/workspace/language-binding.test.ts apps/desktop/src/main/plugins/controller.ts apps/desktop/src/main/plugins/controller.test.ts
git commit -m "feat(language): resolve frontend-owned services and issue workspace binding epochs"
```

Expected: PASS；沒有 backend 的 frontend 可被選中，build 的既有精確錯誤訊息測試仍通過。

---

### Task 3: 共通 DTO、緊湊傳輸與提供者查詢契約

**Files:**

- Create: `apps/desktop/src/shared/language-types.ts`、`apps/desktop/src/shared/language-query.ts`
- Modify: `apps/desktop/src/shared/language-sync.ts`、`apps/desktop/src/shared/completion-sync.ts`、`apps/desktop/src/shared/quick-fixes.ts`
- Test: `apps/desktop/src/shared/language-sync.test.ts`、`apps/desktop/src/shared/completion-sync.test.ts`、`apps/desktop/src/shared/quick-fixes.test.ts`

**Interfaces:**

- Consumes: `PublishedDiagnostic`、`SourceRange`、Task 2 `LanguageBinding`／`LanguageStatus`。
- Produces: `LanguageAnalysis`、`LanguageIndex`、`LanguageSymbol`、`CompletionIndex`、`SemanticToken`、`QuickFix`、`LanguageFeatureQuery`、`LanguageFeatureResult`（完整定義如下）。
- Produces: `diffAnalysis(before: LanguageAnalysis | undefined, after: LanguageAnalysis, base: number | null, version: number): AnalysisPatch`；`applyAnalysis(before: { version: number; analysis: LanguageAnalysis } | undefined, patch: AnalysisPatch): { version: number; analysis: LanguageAnalysis }`。epoch 在回覆 envelope 驗證後才能呼叫 apply，不混入 packed token 欄位。
- `PublishedAnalysis` 改為 `LanguageAnalysis` 的暫存別名，不再依賴 Basic Plus type；本 task 獨立驗收 shared transport，Task 4–6 切換其生產者與消費者。

- [ ] **Step 1: 寫通用 round-trip 與 Review Focus 5 的失敗測試**

在 `language-sync.test.ts` 現有 import 加 `emptyLanguageIndex`，其餘沿用該檔的 `emptyAnalysis`、`diffAnalysis`、`applyAnalysis`：

```ts
it("preserves opaque shadow keys and token dictionaries", () => {
  expect(emptyLanguageIndex().symbols).toEqual({});
  const analysis = emptyAnalysis();
  const range = { startLine: 1, startColumn: 2, endLine: 1, endColumn: 5 };
  analysis.index.sources["名字.csx"] = "\uFEFFFoo foo 😀\r\n";
  analysis.index.symbols = Object.fromEntries(
    ["Foo", "foo"].map((name) => [
      name,
      {
        id: name,
        name,
        kind: "variable" as const,
        signature: `case ${name}`,
        labels: [{ text: name, detail: `case ${name}` }],
        group: "opaque/context",
        shadowKey: name,
        location: { file: "名字.csx", range },
      },
    ]),
  );
  analysis.tokensByFile["名字.csx"] = [{ range, type: "caseIdentifier", modifiers: ["mutable"] }];
  const patch = diffAnalysis(undefined, analysis, null, 1);
  expect(patch.tokensByFile.set["名字.csx"]!.data).toBeInstanceOf(Uint32Array);
  expect(patch.tokensByFile.set["名字.csx"]!.data.byteLength).toBe(6 * 4);
  const received = applyAnalysis(undefined, structuredClone(patch));
  expect(received.analysis).toEqual(analysis);
  expect(Object.values(received.analysis.index.symbols).map((s) => s.shadowKey)).toEqual([
    "Foo",
    "foo",
  ]);
  const delta = diffAnalysis(analysis, structuredClone(analysis), 1, 2);
  expect(delta.tokensByFile.set).toEqual({});
  expect(delta.index.symbols.set).toEqual({});
  expect(applyAnalysis(received, delta).analysis.tokensByFile).toBe(received.analysis.tokensByFile);
});
```

在 `quick-fixes.test.ts` 加 `QuickFix` type import 並加入：

```ts
it("carries localized fix text without a Basic Plus title key", () => {
  const fix: QuickFix = {
    id: "case.close",
    title: { en: "Close expression", "zh-TW": "結束運算式" },
    edits: [{ range: { startLine: 1, startColumn: 4, endLine: 1, endColumn: 4 }, newText: ")" }],
  };
  expect(structuredClone(fix)).toEqual(fix);
  expect(fix).not.toHaveProperty("titleKey");
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/shared/language-sync.test.ts src/shared/quick-fixes.test.ts`

Expected: FAIL（沒有 `emptyLanguageIndex` 匯出）。

- [ ] **Step 3: 定義完整通用型別**

建立 `shared/language-types.ts`：

```ts
import type { PublishedDiagnostic, SourceRange } from "@kobrixa/compiler";
export interface LanguageLocation {
  file: string;
  range: SourceRange;
}
export type LanguageSymbolKind =
  "function" | "method" | "variable" | "parameter" | "label" | "namespace";
export interface LanguageSymbol {
  id: string;
  name: string;
  kind: LanguageSymbolKind;
  signature: string;
  documentation?: string;
  location?: LanguageLocation;
  labels: Array<{ text: string; detail: string }>;
  /** Opaque provider-defined visibility and shadowing values. */
  group: string;
  shadowKey: string;
}
export interface LanguageOccurrence extends LanguageLocation {
  symbolId: string;
  context: string;
  declaration: boolean;
}
export interface LanguageScope {
  id: string;
  context: string;
  location?: LanguageLocation;
}
export interface SemanticToken {
  range: SourceRange;
  type: string;
  modifiers: string[];
}
export interface SemanticLegend {
  tokenTypes: string[];
  tokenModifiers: string[];
}
export interface LanguageDocumentSymbol {
  name: string;
  detail: string;
  kind: LanguageSymbolKind;
  range: SourceRange;
  selectionRange: SourceRange;
  children: LanguageDocumentSymbol[];
}
export interface LanguageIndex {
  symbols: Record<string, LanguageSymbol>;
  occurrencesByFile: Record<string, LanguageOccurrence[]>;
  sources: Record<string, string>;
  fileContexts: Record<string, string>;
  contextFiles: Record<string, string[]>;
  scopes: LanguageScope[];
  invalidContexts: string[];
}
/** Missing optional provider sections normalize to empty records at the adapter boundary. */
export interface LanguageAnalysis {
  diagnostics: PublishedDiagnostic[];
  index: LanguageIndex;
  tokensByFile: Record<string, SemanticToken[]>;
}
export interface CompletionIndex {
  symbols: Record<string, LanguageSymbol>;
  scopes: LanguageScope[];
  fileContexts: Record<string, string>;
  contextFiles: Record<string, string[]>;
  guardsByFile: Record<string, SourceRange[]>;
}
export interface QuickFix {
  id: string;
  title: { en: string; "zh-TW"?: string };
  edits: Array<{ range: SourceRange; newText: string }>;
}
export function emptyLanguageIndex(): LanguageIndex {
  return {
    symbols: Object.create(null),
    occurrencesByFile: Object.create(null),
    sources: Object.create(null),
    fileContexts: Object.create(null),
    contextFiles: Object.create(null),
    scopes: [],
    invalidContexts: [],
  };
}
```

建立 `shared/language-query.ts`，所有功能請求繫結至已接受分析，沒有 AST 或原生 binding metadata：

```ts
import type { SourceRange } from "@kobrixa/compiler";
import type { LanguageLocation, LanguageDocumentSymbol } from "./language-types.js";
export interface AnalysisIdentity {
  epoch: number;
  session: string;
  revision: number;
  analysisVersion: number;
}
export type LanguageFeatureQuery =
  | { kind: "hover"; file: string; line: number; column: number }
  | { kind: "signatureHelp"; file: string; line: number; column: number }
  | { kind: "definition"; file: string; line: number; column: number }
  | { kind: "references"; file: string; line: number; column: number; includeDeclaration: boolean }
  | { kind: "renameLocation"; file: string; line: number; column: number }
  | { kind: "rename"; file: string; line: number; column: number; newName: string }
  | { kind: "documentSymbols"; file: string };
export type LanguageFeatureResult =
  | { kind: "hover"; value: { range: SourceRange; contents: string[] } | null }
  | {
      kind: "signatureHelp";
      value: {
        label: string;
        parameters: Array<[number, number]>;
        activeParameter: number;
        documentation?: string;
      } | null;
    }
  | { kind: "definition" | "references"; locations: LanguageLocation[] }
  | { kind: "renameLocation"; range?: SourceRange; text: string; rejectReason?: string }
  | {
      kind: "rename";
      edits: Array<LanguageLocation & { text: string; expected: string }>;
      rejectReason?: string;
    }
  | { kind: "documentSymbols"; symbols: LanguageDocumentSymbol[] };
export interface LanguageFeatureRequest extends AnalysisIdentity {
  requestId: string;
  query: LanguageFeatureQuery;
}
export type LanguageFeatureReply =
  | { kind: "result"; epoch: number; result: LanguageFeatureResult }
  | { kind: "stale"; epoch: number };
```

- [ ] **Step 4: 精確替換傳輸型別，保留 packing 演算法**

`language-sync.ts` 刪除 Basic Plus imports 與原 Omit alias，加入：

```ts
import {
  emptyLanguageIndex,
  type LanguageAnalysis,
  type LanguageIndex,
  type SemanticToken,
  type LanguageOccurrence,
} from "./language-types.js";
export { emptyLanguageIndex } from "./language-types.js";
export type PublishedAnalysis = LanguageAnalysis;
```

整檔識別字替換：`BasicPlusSymbolIndex` → `LanguageIndex`、`BasicPlusSemanticToken` → `SemanticToken`、`BasicPlusOccurrence` → `LanguageOccurrence`。`emptyAnalysis` 改為：

```ts
export function emptyAnalysis(): LanguageAnalysis {
  return { diagnostics: [], tokensByFile: Object.create(null), index: emptyLanguageIndex() };
}
```

保留 `Uint32Array(tokens.length * 6)`、`Uint32Array(occurrences.length * 8)`、dictionary、`diffRecord`／`applyRecord`、immutable identity 與 base version 判斷，不額外傳 raw analysis 副本。

`completion-sync.ts` import 改 `import type { CompletionIndex } from "./language-types.js";`，`index: BasicPlusCompletionIndex` 改 `index: CompletionIndex`。`quick-fixes.ts` 改 `import type { QuickFix } from "./language-types.js";` 並 `export type { QuickFix } from "./language-types.js";`，`fixes: BasicPlusQuickFix[]` 改 `fixes: QuickFix[]`。`sameDiagnostic` 原封保留。

不加入可選 epoch 兼容模式；Task 5 一次把兩條同步 envelope 與呼叫點改為必填 epoch。

- [ ] **Step 5: 確認 PASS 與傳輸不增肥**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/shared/language-sync.test.ts src/shared/completion-sync.test.ts src/shared/quick-fixes.test.ts`

Expected: PASS；既有 changed/deleted sections、prototype keys、UTF-16 packing 測試仍通過。全桌面 type check 在 Task 6 的 consumers 切換後執行。

- [ ] **Step 6: 格式化、lint 與 commit**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --write apps/desktop/src/shared/language-types.ts apps/desktop/src/shared/language-query.ts apps/desktop/src/shared/language-sync.ts apps/desktop/src/shared/completion-sync.ts apps/desktop/src/shared/quick-fixes.ts apps/desktop/src/shared/language-sync.test.ts apps/desktop/src/shared/quick-fixes.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec eslint apps/desktop/src/shared/language-types.ts apps/desktop/src/shared/language-query.ts apps/desktop/src/shared/language-sync.ts apps/desktop/src/shared/completion-sync.ts apps/desktop/src/shared/quick-fixes.ts apps/desktop/src/shared/language-sync.test.ts apps/desktop/src/shared/quick-fixes.test.ts
git add apps/desktop/src/shared/language-types.ts apps/desktop/src/shared/language-query.ts apps/desktop/src/shared/language-sync.ts apps/desktop/src/shared/completion-sync.ts apps/desktop/src/shared/quick-fixes.ts apps/desktop/src/shared/language-sync.test.ts apps/desktop/src/shared/completion-sync.test.ts apps/desktop/src/shared/quick-fixes.test.ts
git commit -m "refactor(language): introduce provider-neutral analysis and editor result contracts"
```

---

### Task 4: 內建工廠、Basic Plus worker adapter 與 browser companion

**Files:**

- Create: `apps/desktop/src/main/language/language-provider.ts`、`apps/desktop/src/main/language/basic-plus-service.ts`、`apps/desktop/src/main/language/basic-plus-results.ts`、`apps/desktop/src/main/language/basic-plus-quick-fixes.ts`、`apps/desktop/src/main/language/basic-plus-outline.ts`、`apps/desktop/src/main/language/basic-plus-service.test.ts`
- Create: `apps/desktop/src/main/workspace/builtin-language-services.ts`
- Create: `apps/desktop/src/renderer/editor/language-companion.ts`、`apps/desktop/src/renderer/editor/builtin-language-companions.ts`
- Create: `apps/desktop/src/renderer/editor/companions/basic-plus/companion.ts`、`apps/desktop/src/renderer/editor/companions/basic-plus/completions.ts`、`apps/desktop/src/renderer/editor/companions/basic-plus/formatting.ts`、`apps/desktop/src/renderer/editor/companions/basic-plus/registration.ts`
- Modify: `apps/desktop/src/main/language/language-worker.ts`、`apps/desktop/src/renderer/editor/basic-plus-formatting.ts`、`apps/desktop/src/renderer/editor/basic-plus-language.ts`、`apps/desktop/src/renderer/editor/diagnostic-presentation.ts`、`apps/desktop/src/renderer/editor/diagnostic-presentation.test.ts`
- Delete: `apps/desktop/src/shared/basic-plus-quick-fixes.ts`（所有 callers 在 Task 5–6 轉用 capability 或 adapter）

- Modify: `apps/desktop/src/shared/quick-fixes.test.ts`、`apps/desktop/src/renderer/editor/language-features.test.ts`（移動 Basic Plus 專屬資格測試與 import）

**Interfaces:**

- Consumes: Task 3 DTO、`BasicPlusProjectAnalyzer.analyze(project: SourceProject, signal: AbortSignal)`、`BasicPlusCompletionAnalyzer.analyze(project: SourceProject, signal: AbortSignal)`、`getBasicPlusQuickFixes`、`occurrenceAt`、`prepareSymbolRename`、`symbolReferences`、`symbolSignature`、`visibleSymbols`、`editingContext`。
- Produces: `LanguageServiceFactory { capabilities; createAnalysis(); createCompletion() }`、`LanguageAnalysisProvider`、`LanguageCompletionProvider`、`LanguageCompanion`，完整簽名在 Step 3／6。
- Produces: `basicPlusLanguageService: LanguageServiceFactory`、`basicPlusCompanion: LanguageCompanion`、`BUILTIN_LANGUAGE_SERVICES: Readonly<Record<string, LanguageServiceFactory>>`、`BUILTIN_LANGUAGE_COMPANIONS: Readonly<Record<string, LanguageCompanion>>`。
- Worker factory 不匯入 Electron、main controller、renderer 或 compiler backend。registry 只有編譯期 import；不解析 manifest 的 JS 路徑。

- [ ] **Step 1: 寫 adapter 的失敗測試**

建立 `basic-plus-service.test.ts`；來源 fixture 取自 `language.test.ts` 已存在的 Include／Import／Double 案例，沒有新增 parser 演算法：

```ts
import { expect, it } from "vitest";
import { BasicPlusProjectAnalyzer } from "@kobrixa/basic-plus";
import type { SourceProject } from "@kobrixa/compiler";
import { LANGUAGE_CAPABILITIES } from "@kobrixa/plugin-protocol";
import { basicPlusLanguageService } from "./basic-plus-service.js";
const signal = new AbortController().signal;
const project: SourceProject = {
  root: "/project",
  manifest: {
    schemaVersion: 1,
    name: "test",
    language: "bp",
    entry: "main.bp",
    target: "ev3-native",
    outputDir: "out",
    assets: [],
  },
  assets: [],
  sources: [
    { path: "main.bp", content: 'Include "config"\nImport "helper"\nresult = Double(shared)\n' },
    { path: "config.bpi", content: "shared = 2\n" },
    {
      path: "helper.bpm",
      content: "Function Double(in number value)\nReturn value * 2\nEndFunction\n",
    },
  ],
};
it("preserves native diagnostics, tokens and source snapshots with generic display symbols", () => {
  const provider = basicPlusLanguageService.createAnalysis();
  const raw = new BasicPlusProjectAnalyzer().analyze(project, signal);
  const result = provider.analyze(project, 1, signal);
  expect(result.diagnostics).toEqual(raw.diagnostics);
  expect(result.tokensByFile).toEqual(raw.tokensByFile);
  expect(result.index.sources).toEqual(raw.index.sources);
  const double = Object.values(result.index.symbols).find((s) => s.name === "Double")!;
  expect(double).toMatchObject({
    kind: "function",
    signature: "Double(in number value): number",
    shadowKey: "call:double",
  });
  expect(double).not.toHaveProperty("parameters");
  expect(double).not.toHaveProperty("scope");
  expect(
    provider.query(1, { kind: "definition", file: "main.bp", line: 3, column: 10 }, signal),
  ).toMatchObject({
    kind: "definition",
    locations: [{ file: "helper.bpm" }],
  });
  expect([...basicPlusLanguageService.capabilities]).toEqual([...LANGUAGE_CAPABILITIES]);
  provider.dispose();
  expect(() => provider.query(1, { kind: "documentSymbols", file: "main.bp" }, signal)).toThrow(
    "Analysis expired",
  );
});
it("keeps two raw analyses and returns localized, single-file fixes", () => {
  const provider = basicPlusLanguageService.createAnalysis();
  const broken = { ...project, sources: [{ path: "main.bp", content: "LCD.Clear(\n" }] };
  const one = provider.analyze(broken, 1, signal);
  const diagnostic = one.diagnostics.find((d) => d.code === "BP1043")!;
  const fixes = provider.quickFixes(
    1,
    "main.bp",
    { ...diagnostic, source: "kobrixa.basic-plus" },
    signal,
  );
  expect(fixes[0]?.title).toEqual({ en: "Insert closing parenthesis )", "zh-TW": "補上右括號 )" });
  provider.analyze(project, 2, signal);
  provider.analyze(project, 3, signal);
  expect(() => provider.query(1, { kind: "documentSymbols", file: "main.bp" }, signal)).toThrow(
    "Analysis expired",
  );
  provider.dispose();
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/language/basic-plus-service.test.ts`

Expected: FAIL（adapter 尚不存在）。

- [ ] **Step 3: 實作 factory 與原生結果轉換**

`language-provider.ts`：

```ts
import type { Diagnostic, PublishedDiagnostic, SourceProject } from "@kobrixa/compiler";
import type { LanguageCapability } from "@kobrixa/plugin-protocol";
import type { LanguageAnalysis, CompletionIndex, QuickFix } from "../../shared/language-types.js";
import type { LanguageFeatureQuery, LanguageFeatureResult } from "../../shared/language-query.js";
export type ProviderAnalysis = Omit<LanguageAnalysis, "diagnostics"> & {
  diagnostics: Diagnostic[];
};
export interface LanguageAnalysisProvider {
  analyze(project: SourceProject, version: number, signal: AbortSignal): ProviderAnalysis;
  query(version: number, query: LanguageFeatureQuery, signal: AbortSignal): LanguageFeatureResult;
  quickFixes(
    version: number,
    file: string,
    diagnostic: PublishedDiagnostic,
    signal: AbortSignal,
  ): QuickFix[];
  dispose(): void;
}
export interface LanguageCompletionProvider {
  analyze(project: SourceProject, signal: AbortSignal): CompletionIndex;
  dispose(): void;
}
export interface LanguageServiceFactory {
  capabilities: readonly LanguageCapability[];
  createAnalysis(): LanguageAnalysisProvider;
  createCompletion(): LanguageCompletionProvider;
}
```

`basic-plus-results.ts`：

```ts
import type {
  BasicPlusCompletionIndex,
  BasicPlusProjectAnalysis,
  BasicPlusSymbol,
} from "@kobrixa/basic-plus";
import { symbolSignature } from "@kobrixa/basic-plus/intelligence";
import type { CompletionIndex, LanguageSymbol } from "../../shared/language-types.js";
import type { ProviderAnalysis } from "./language-provider.js";
export function basicPlusSymbol(symbol: BasicPlusSymbol): LanguageSymbol {
  return {
    id: symbol.id,
    name: symbol.name,
    kind: symbol.kind === "sub" ? "function" : symbol.kind,
    signature: symbolSignature(symbol),
    ...(symbol.documentation === undefined ? {} : { documentation: symbol.documentation }),
    ...(symbol.declaration ? { location: symbol.declaration } : {}),
    labels: symbol.aliases.map((text) => ({ text, detail: symbolSignature(symbol, text) })),
    group: symbol.scope === "global" ? symbol.context : symbol.scopeId,
    shadowKey: `${symbol.kind === "function" || symbol.kind === "sub" ? "call" : symbol.kind === "label" ? "label" : "value"}:${symbol.name.toLowerCase()}`,
  };
}
function symbols(input: Record<string, BasicPlusSymbol>): Record<string, LanguageSymbol> {
  return Object.fromEntries(
    Object.values(input)
      .filter((s) => s.scope !== "builtin")
      .map((s) => [s.id, basicPlusSymbol(s)]),
  );
}
export function basicPlusAnalysis(raw: BasicPlusProjectAnalysis): ProviderAnalysis {
  return {
    diagnostics: raw.diagnostics,
    tokensByFile: raw.tokensByFile,
    index: { ...raw.index, symbols: symbols(raw.index.symbols) },
  };
}
export function basicPlusCompletion(raw: BasicPlusCompletionIndex): CompletionIndex {
  return { ...raw, symbols: symbols(raw.symbols) };
}
```

`basic-plus-quick-fixes.ts` 搬入目前 shared 檔的 `BASIC_PLUS_SOURCE`、codes Set、`offersBasicPlusQuickFix`，並把 `diagnostic-presentation.ts` 的完整五筆 `fixTitles` 物件搬來。加 `BasicPlusQuickFix` type import，型別改為 `Record<BasicPlusQuickFix["titleKey"], { en: string; "zh-TW": string }>`，匯出：

```ts
export const basicPlusFixTitle = (
  key: BasicPlusQuickFix["titleKey"],
): { en: string; "zh-TW": string } => fixTitles[key];
```

`diagnostic-presentation.ts` 的 quick-fix title adapter 改為通用；刪掉 Basic Plus type 與五筆標題表：

```ts
import type { QuickFix } from "../../shared/language-types.js";
export const quickFixTitle = (title: QuickFix["title"], locale: DiagnosticLocale): string =>
  title[locale] ?? title.en;
```

`diagnostic-presentation.test.ts` 原來只有診斷說明測試，保留它們，新增以下通用標題測試（import 加 `quickFixTitle`）：

```ts
it("uses the provider's localized fix title and falls back to English", () => {
  expect(quickFixTitle({ en: "Remove !", "zh-TW": "移除 !" }, "zh-TW")).toBe("移除 !");
  expect(quickFixTitle({ en: "Remove !" }, "zh-TW")).toBe("Remove !");
});
```

把 `shared/quick-fixes.test.ts` 中 `only offers Basic Plus fixes for Basic Plus diagnostics` 整個測試搬至 `basic-plus-service.test.ts`，import 改 `./basic-plus-quick-fixes.js`；shared 測試刪掉該 import，只保留 sameDiagnostic／通用 title contract 測試。`language-features.test.ts` 的 BASIC_PLUS_SOURCE import 指向 `../../main/language/basic-plus-quick-fixes.js`（僅測試使用）。

- [ ] **Step 4: 實作所有原生語意 query**

把現有 `renderer/editor/outline.ts` 的 `OutlineItem`、`CALLABLE`、`before`、`documentOutline` 搬到 `main/language/basic-plus-outline.ts`；保留整個演算法及 `contains` 的 Basic Plus import。原 renderer 的幾何 `outlinePath` 留給 Task 6。在該新檔末尾加入：

```ts
import type { LanguageDocumentSymbol } from "../../shared/language-types.js";
export function basicPlusOutline(
  index: BasicPlusSymbolIndex,
  file: string,
): LanguageDocumentSymbol[] {
  const convert = (item: OutlineItem): LanguageDocumentSymbol => ({
    ...item,
    detail: "",
    kind: item.kind === "sub" ? "function" : item.kind,
    children: item.children.map(convert),
  });
  return documentOutline(index, file).map(convert);
}
```

建立 `basic-plus-service.ts`，完整 session／query 程式：

```ts
import {
  BasicPlusProjectAnalyzer,
  BasicPlusCompletionAnalyzer,
  getBasicPlusQuickFixes,
  type BasicPlusProjectAnalysis,
} from "@kobrixa/basic-plus";
import {
  occurrenceAt,
  prepareSymbolRename,
  symbolReferences,
  symbolSignature,
  visibleSymbols,
  editingContext,
} from "@kobrixa/basic-plus/intelligence";
import { BASIC_PLUS_API_COMPLETIONS } from "@kobrixa/basic-plus/language";
import { LANGUAGE_CAPABILITIES } from "@kobrixa/plugin-protocol";
import type { LanguageServiceFactory } from "./language-provider.js";
import type { LanguageFeatureQuery, LanguageFeatureResult } from "../../shared/language-query.js";
import { basicPlusAnalysis, basicPlusCompletion } from "./basic-plus-results.js";
import { basicPlusFixTitle, offersBasicPlusQuickFix } from "./basic-plus-quick-fixes.js";
import { basicPlusOutline } from "./basic-plus-outline.js";

function queryBasicPlus(
  raw: BasicPlusProjectAnalysis,
  query: LanguageFeatureQuery,
): LanguageFeatureResult {
  const source = raw.index.sources[query.file] ?? "";
  if (query.kind === "documentSymbols")
    return { kind: query.kind, symbols: basicPlusOutline(raw.index, query.file) };
  const occurrence = occurrenceAt(raw.index, query.file, query.line, query.column);
  const symbol = occurrence && raw.index.symbols[occurrence.symbolId];
  switch (query.kind) {
    case "hover":
      return {
        kind: query.kind,
        value:
          symbol && occurrence
            ? {
                range: occurrence.range,
                contents: [
                  `\`\`\`basic-plus\n${symbolSignature(symbol)}\n\`\`\``,
                  ...(symbol.documentation ? [symbol.documentation] : []),
                ],
              }
            : null,
      };
    case "definition":
      return { kind: query.kind, locations: symbol?.declaration ? [symbol.declaration] : [] };
    case "references":
      return {
        kind: query.kind,
        locations: symbol ? symbolReferences(raw.index, symbol, query.includeDeclaration) : [],
      };
    case "renameLocation":
      return symbol?.declaration && occurrence
        ? {
            kind: query.kind,
            range: occurrence.range,
            text: source
              .split("\n")
              [query.line - 1]!.slice(
                occurrence.range.startColumn - 1,
                occurrence.range.endColumn - 1,
              ),
          }
        : {
            kind: query.kind,
            text: "",
            rejectReason: "A current, editable user-defined symbol is required.",
          };
    case "rename": {
      const result = prepareSymbolRename(raw, query.file, query.line, query.column, query.newName);
      return result.rejectReason
        ? { kind: query.kind, edits: [], rejectReason: result.rejectReason }
        : { kind: query.kind, edits: result.edits ?? [] };
    }
    case "signatureHelp": {
      const call = editingContext(
        (source.split("\n")[query.line - 1] ?? "").slice(0, query.column - 1),
      ).call;
      if (!call) return { kind: query.kind, value: null };
      const callable = visibleSymbols(raw.index, query.file, query.line, query.column).find(
        (s) => s.parameters && s.aliases.some((a) => a.toLowerCase() === call.name.toLowerCase()),
      );
      const api = BASIC_PLUS_API_COMPLETIONS.find(
        (a) => a.label.toLowerCase() === call.name.toLowerCase(),
      );
      if (!callable && !api) return { kind: query.kind, value: null };
      const label = api?.signature ?? symbolSignature(callable!, call.name);
      const texts = api
        ? label
            .slice(label.indexOf("(") + 1, label.lastIndexOf(")"))
            .split(", ")
            .filter(Boolean)
        : callable!.parameters!.map((p) => `${p.direction} ${p.type} ${p.name}`);
      let start = label.indexOf("(") + 1;
      const parameters = texts.map((text): [number, number] => {
        const range: [number, number] = [start, start + text.length];
        start += text.length + 2;
        return range;
      });
      return {
        kind: query.kind,
        value: {
          label,
          parameters,
          activeParameter: Math.min(call.argument, Math.max(0, parameters.length - 1)),
          ...(api ? { documentation: api.documentation } : {}),
        },
      };
    }
  }
}
export const basicPlusLanguageService: LanguageServiceFactory = {
  capabilities: LANGUAGE_CAPABILITIES,
  createAnalysis() {
    const analyzer = new BasicPlusProjectAnalyzer();
    const history = new Map<number, BasicPlusProjectAnalysis>();
    const get = (version: number) => {
      const raw = history.get(version);
      if (!raw) throw new Error("Analysis expired.");
      return raw;
    };
    return {
      analyze(project, version, signal) {
        const raw = analyzer.analyze(project, signal);
        history.set(version, raw);
        while (history.size > 2) history.delete(history.keys().next().value!);
        return basicPlusAnalysis(raw);
      },
      query(version, query, signal) {
        signal.throwIfAborted();
        const result = queryBasicPlus(get(version), query);
        signal.throwIfAborted();
        return result;
      },
      quickFixes(version, file, diagnostic, signal) {
        if (!offersBasicPlusQuickFix(diagnostic)) return [];
        const source = get(version).index.sources[file];
        if (source === undefined) return [];
        return getBasicPlusQuickFixes(file, source, diagnostic, signal).map(
          ({ id, titleKey, edits }) => ({ id, title: basicPlusFixTitle(titleKey), edits }),
        );
      },
      dispose() {
        history.clear();
      },
    };
  },
  createCompletion() {
    let analyzer: BasicPlusCompletionAnalyzer | undefined = new BasicPlusCompletionAnalyzer();
    return {
      analyze(project, signal) {
        if (!analyzer) throw new Error("Completion session disposed.");
        return basicPlusCompletion(analyzer.analyze(project, signal));
      },
      dispose() {
        analyzer = undefined;
      },
    };
  },
};
```

`builtin-language-services.ts`：

```ts
import type { LanguageServiceFactory } from "../language/language-provider.js";
import { basicPlusLanguageService } from "../language/basic-plus-service.js";
export const BUILTIN_LANGUAGE_SERVICES: Readonly<Record<string, LanguageServiceFactory>> = {
  "kobrixa.basic-plus:bp": basicPlusLanguageService,
};
```

worker 分析呼叫在 Task 5 切換成 `provider.analyze(loaded.project, id, signal)`。目前 `language-worker.ts` 第 141–164 行的相容 adapter 不搬入 `basic-plus-service.ts`；刪除後由 Task 5 的宿主 `publishAnalysis` 統一加註來源與處理 BUILD1007。原 `useInjectedAnalyzer` 測試仍攔截 prototype，所以可繼續驗證 provider 來源偽造。

- [ ] **Step 5: 執行 adapter 測試確認 PASS**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/language/basic-plus-service.test.ts`

Expected: PASS；原演算法仍來自 Basic Plus package，generic DTO 不含 parameters、scope、AST 或 titleKey。

- [ ] **Step 6: 定義 browser companion，搬移即時補全與格式化**

建立 `language-companion.ts`：

```ts
import type { editor, languages, Position, IRange, CancellationToken } from "monaco-editor";
import type { LanguageSymbol, SemanticLegend } from "../../shared/language-types.js";
export interface LanguageCompanion {
  monacoLanguage: string;
  legend: SemanticLegend;
  triggerCharacters: string[];
  signatureTriggers: string[];
  signatureRetriggers: string[];
  completions(
    model: editor.ITextModel,
    position: Position,
    candidates: readonly LanguageSymbol[],
    token: CancellationToken,
  ): languages.CompletionList;
  structuralChange(model: editor.ITextModel, event: editor.IModelContentChangedEvent): boolean;
  formatSource(source: string, indentSize: 2 | 4): string;
  rangeFormatting(
    model: editor.ITextModel,
    range: IRange,
    options: languages.FormattingOptions,
    token: CancellationToken,
  ): languages.TextEdit[];
}
```

`companions/basic-plus/formatting.ts` 完整搬移既有 `basic-plusRangeFormattingEdits`，調整相對 import；舊 `basic-plus-formatting.ts` 留 `export { basicPlusRangeFormattingEdits } from "./companions/basic-plus/formatting.js";`，讓原測試繼續定位入口。

`completions.ts` 從原 `BasicPlusLanguageFeatures.completions` 精確搬出下列演算法區段：從 `const before = model.getLineContent...` 到 `const suggestions...`，再從 `const normalized...` 對候選的迴圈到 API completion 迴圈；移除讀取 `this.current`、`pendingCompletion`、`visibleSymbols` 的區段。函式簽名及候選迴圈替換為：

```ts
import * as monaco from "monaco-editor";
import {
  BASIC_PLUS_API_COMPLETIONS,
  BASIC_PLUS_KEYWORDS,
  BASIC_PLUS_INDENTATION_RULES,
} from "@kobrixa/basic-plus/language";
import { editingContext } from "@kobrixa/basic-plus/intelligence";
import type { LanguageSymbol } from "../../../../shared/language-types.js";
import { basicPlusRangeFormattingEdits } from "./formatting.js";
export function basicPlusCompletions(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  candidates: readonly LanguageSymbol[],
  token: monaco.CancellationToken,
): monaco.languages.CompletionList {
  if (model.isDisposed() || token.isCancellationRequested) return { suggestions: [] };
  const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
  if (editingContext(before).inLiteral) return { suggestions: [] };
  const prefix = before.match(/[A-Za-z_][A-Za-z0-9_.]*$/)?.[0] ?? "";
  const after =
    model
      .getLineContent(position.lineNumber)
      .slice(position.column - 1)
      .match(/^[A-Za-z0-9_.]*/)?.[0] ?? "";
  const range = new monaco.Range(
    position.lineNumber,
    position.column - prefix.length,
    position.lineNumber,
    position.column + after.length,
  );
  const normalized = prefix.toLowerCase();
  const suggestions: monaco.languages.CompletionItem[] = [];
  for (const symbol of candidates)
    for (const { text: label, detail } of symbol.labels) {
      if (!label.toLowerCase().startsWith(normalized)) continue;
      suggestions.push({
        label,
        range,
        insertText: label,
        detail,
        kind:
          symbol.kind === "parameter" || symbol.kind === "variable"
            ? monaco.languages.CompletionItemKind.Variable
            : symbol.kind === "label"
              ? monaco.languages.CompletionItemKind.Reference
              : monaco.languages.CompletionItemKind.Function,
        sortText: `0-${label.toLowerCase()}`,
      });
    }
  if (!prefix.includes(".")) {
    const line = model.getLineContent(position.lineNumber);
    const leading = before.slice(0, range.startColumn - 1);
    let closingIndent: string | undefined;
    for (const label of BASIC_PLUS_KEYWORDS)
      if (label.toLowerCase().startsWith(normalized)) {
        const item: monaco.languages.CompletionItem = {
          label,
          range,
          insertText: label,
          kind: monaco.languages.CompletionItemKind.Keyword,
          sortText: `2-${label}`,
        };
        if (
          /^[\t ]*$/.test(leading) &&
          BASIC_PLUS_INDENTATION_RULES.decreaseIndentPattern.test(label) &&
          !BASIC_PLUS_INDENTATION_RULES.decreaseIndentPattern.test(line)
        ) {
          closingIndent ??=
            basicPlusRangeFormattingEdits(
              {
                getLineContent: (number) =>
                  number === position.lineNumber
                    ? leading + label + line.slice(range.endColumn - 1)
                    : model.getLineContent(number),
              },
              range,
              model.getOptions(),
              token,
            )[0]?.text ?? leading;
          if (closingIndent !== leading) {
            item.range = new monaco.Range(
              position.lineNumber,
              1,
              position.lineNumber,
              range.endColumn,
            );
            item.insertText = closingIndent + label;
            item.filterText = leading + label;
          }
        }
        suggestions.push(item);
      }
  }
  for (const api of BASIC_PLUS_API_COMPLETIONS)
    if (api.label.toLowerCase().startsWith(normalized))
      suggestions.push({
        label: api.label,
        range,
        kind: monaco.languages.CompletionItemKind.Method,
        insertText: api.insertText,
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        detail: api.signature,
        documentation: { value: api.documentation },
        sortText: `1-${api.label}`,
      });
  return { suggestions };
}
```

`companion.ts`：

```ts
import { formatBasicPlus } from "@kobrixa/basic-plus/language";
import type { LanguageCompanion } from "../../language-companion.js";
import { basicPlusCompletions } from "./completions.js";
import { basicPlusRangeFormattingEdits } from "./formatting.js";
const structuralText = /\b(?:function|sub|endfunction|endsub|include|import)\b/i;
export const basicPlusCompanion: LanguageCompanion = {
  monacoLanguage: "basic-plus",
  legend: {
    tokenTypes: ["namespace", "function", "method", "variable", "parameter", "label"],
    tokenModifiers: ["declaration", "defaultLibrary", "local", "global"],
  },
  triggerCharacters: [".", "@"],
  signatureTriggers: ["(", ","],
  signatureRetriggers: [")"],
  completions: basicPlusCompletions,
  structuralChange(model, event) {
    let delta = 0;
    for (const change of [...event.changes].sort((a, b) => a.rangeOffset - b.rangeOffset)) {
      if (structuralText.test(change.text)) return true;
      const start = change.rangeOffset + delta;
      for (const offset of [start, start + change.text.length])
        if (structuralText.test(model.getLineContent(model.getPositionAt(offset).lineNumber)))
          return true;
      delta += change.text.length - change.rangeLength;
    }
    return false;
  },
  formatSource: (source, indentSize) => formatBasicPlus(source, { indentSize }),
  rangeFormatting: basicPlusRangeFormattingEdits,
};
```

上述 `\b` 僅在 Basic Plus editor 演算法，不是 wire schema。`builtin-language-companions.ts`：

```ts
import type { LanguageCompanion } from "./language-companion.js";
import { basicPlusCompanion } from "./companions/basic-plus/companion.js";
export const BUILTIN_LANGUAGE_COMPANIONS: Readonly<Record<string, LanguageCompanion>> = {
  "kobrixa.basic-plus:bp": basicPlusCompanion,
};
```

`registration.ts` 搬入 `editor.tsx` 原 `registerLanguage` 的靜態 register／languageConfiguration／Monarch／theme code（第 41–84 行），匯出 `registerBasicPlusLanguage(): void`；兩個動態 formatting providers 不搬入，Task 6 依 capability 註冊。`basic-plus-language.ts` 原 Monarch 與 theme 函式也搬進 `registration.ts`，舊入口只 re-export `basicPlusMonarch`／`basicPlusThemeRules`。不修改 tokenizer 規則或 theme 值。

- [ ] **Step 7: 執行 companion 回歸、格式化與 commit**

在 `completion-cache.test.ts` 的結構偵測 import 改成 `basicPlusCompanion`，呼叫 `basicPlusCompanion.structuralChange(model, event)`；保留 `change` helper。原 keyword guard 測試移到 companion 呼叫後，`rebaseCompletionRanges` 的 structural flag 由測試明確傳 `true`，不要求 generic rebase 認識 Basic Plus keyword。

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/language/basic-plus-service.test.ts src/renderer/editor/basic-plus-formatting.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --write apps/desktop/src/main/language/basic-plus-service.ts apps/desktop/src/main/language/basic-plus-results.ts apps/desktop/src/main/language/basic-plus-quick-fixes.ts apps/desktop/src/main/language/basic-plus-outline.ts apps/desktop/src/main/language/language-provider.ts apps/desktop/src/main/language/basic-plus-service.test.ts apps/desktop/src/main/workspace/builtin-language-services.ts apps/desktop/src/renderer/editor/companions apps/desktop/src/renderer/editor/language-companion.ts apps/desktop/src/renderer/editor/builtin-language-companions.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec eslint apps/desktop/src/main/language/basic-plus-service.ts apps/desktop/src/main/language/basic-plus-results.ts apps/desktop/src/main/language/basic-plus-quick-fixes.ts apps/desktop/src/main/language/basic-plus-outline.ts apps/desktop/src/main/language/language-provider.ts apps/desktop/src/main/language/basic-plus-service.test.ts apps/desktop/src/main/workspace/builtin-language-services.ts apps/desktop/src/renderer/editor/companions apps/desktop/src/renderer/editor/language-companion.ts apps/desktop/src/renderer/editor/builtin-language-companions.ts
git add apps/desktop/src/shared/quick-fixes.test.ts apps/desktop/src/renderer/editor/language-features.test.ts apps/desktop/src/main/language/language-provider.ts apps/desktop/src/main/language/basic-plus-service.ts apps/desktop/src/main/language/basic-plus-results.ts apps/desktop/src/main/language/basic-plus-quick-fixes.ts apps/desktop/src/main/language/basic-plus-outline.ts apps/desktop/src/main/language/basic-plus-service.test.ts apps/desktop/src/main/workspace/builtin-language-services.ts apps/desktop/src/main/language/language-worker.ts apps/desktop/src/renderer/editor/language-companion.ts apps/desktop/src/renderer/editor/builtin-language-companions.ts apps/desktop/src/renderer/editor/companions/basic-plus/companion.ts apps/desktop/src/renderer/editor/companions/basic-plus/completions.ts apps/desktop/src/renderer/editor/companions/basic-plus/formatting.ts apps/desktop/src/renderer/editor/companions/basic-plus/registration.ts apps/desktop/src/renderer/editor/basic-plus-formatting.ts apps/desktop/src/renderer/editor/basic-plus-language.ts apps/desktop/src/renderer/editor/diagnostic-presentation.ts apps/desktop/src/renderer/editor/diagnostic-presentation.test.ts apps/desktop/src/renderer/editor/completion-cache.test.ts apps/desktop/src/shared/basic-plus-quick-fixes.ts
git commit -m "refactor(language): isolate Basic Plus worker and browser implementations"
```

Expected: adapter 與原 range formatting 測試 PASS。此時新增 implementations 可獨立測試；下一 task 才用它們取代兩條生產 worker 的 session。

---

### Task 5: 兩條 worker 通道、epoch、取消、Quick Fix 與語意查詢路由

**Files:**

- Create: `apps/desktop/src/main/language/language-worker-session.ts`、`apps/desktop/src/main/language/language-worker-session.test.ts`、`apps/desktop/src/main/language/language-lane.ts`
- Modify: `apps/desktop/src/main/language/language-worker.ts`、`apps/desktop/src/main/language/completion-worker.ts`、`apps/desktop/src/main/language/language.ts`、`apps/desktop/src/main/language/completion.ts`、`apps/desktop/src/main/language/language-protocol.ts`、`apps/desktop/src/main/language/quick-fix-request.ts`
- Modify: `apps/desktop/src/main/language/language.test.ts`、`apps/desktop/src/main/language/quick-fix-request.test.ts`
- Modify: `apps/desktop/src/shared/language-sync.ts`、`apps/desktop/src/shared/completion-sync.ts`、`apps/desktop/src/shared/quick-fixes.ts`、`apps/desktop/src/shared/api.ts`
- Modify: `apps/desktop/src/main/index.ts`、`apps/desktop/src/main/ipc.ts`、`apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/renderer/editor/analysis-transport.ts`、`apps/desktop/src/renderer/editor/analysis-transport.test.ts`（傳輸層先轉 epoch；UI 在 Task 6）

- Modify: `apps/desktop/src/main/workspace/builtin-language-services.ts`、`apps/desktop/src/main/workspace/workspace-ipc.test.ts`

**Interfaces:**

- Consumes: `LanguageBindings`、`readProjectDescription`、`LanguageServiceFactory`、`stampDiagnostics`、`requirePublished`、`sameDiagnostic`。
- Produces: `LanguageService.status(workspaceId: string, refresh?: boolean): Promise<LanguageStatus>`；`.refresh(workspaceId?: string): Promise<void>`；`.onStatus(listener: (event: LanguageStatusEvent) => void): () => void`；`.feature(workspaceId: string, request: LanguageFeatureRequest): Promise<LanguageFeatureReply>`；`.cancelFeature(workspaceId: string, requestId: string): void`；`.close(workspaceId: string): void`。
- Produces: `LanguageWorkerSession.sync(request: DiagnosticsRequest): Promise<LanguageSyncReply>`；`.quickFixes(request: QuickFixWorkerRequest): QuickFixReply`；`.feature(request: FeatureWorkerRequest): LanguageFeatureReply`；`.dispose(): void`。
- `LanguageService` 原有 `.sync`／`.completionSync`／`.quickFixes`／`.cancelQuickFix`／`.cancel`／`.dispose` 保留；`.analyze`／`.diagnostics` compatibility convenience API 遇 unavailable 拒絕，不把 unavailable 轉成 `[]`。
- 所有 reply（包含 `resync`／`stale`）都有 `epoch: number`；analysis 與 completion 都先檢查 epoch，再檢查 session/revision/model identity。

- [ ] **Step 1: 寫 worker session 的失敗測試**

建立 `language-worker-session.test.ts`。此 fixture 使用真實 temp files 及已完成 Basic Plus factory；新增 helper 全部在下面定義。

```ts
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { LanguageBinding } from "../../shared/language-services.js";
import { applyAnalysis } from "../../shared/language-sync.js";
import type { DiagnosticsRequest } from "./language-protocol.js";
import { basicPlusLanguageService } from "./basic-plus-service.js";
import { LanguageWorkerSession } from "./language-worker-session.js";
let root: string;
let worker: LanguageWorkerSession;
const binding = (epoch: number): LanguageBinding => ({
  epoch,
  pluginId: "kobrixa.basic-plus",
  sourceKey: "builtin:kobrixa.basic-plus",
  language: "bp",
  extensions: ["bp", "bpi", "bpm"],
  capabilities: [...basicPlusLanguageService.capabilities],
  frontend: {
    language: "bp",
    entryExtensions: ["bp"],
    sourceExtensions: ["bp", "bpi", "bpm"],
    ir: { min: 1, max: 1 },
  },
});
function request(
  epoch: number,
  revision: number,
  baseRevision: number | null,
  text: string,
): DiagnosticsRequest {
  return {
    id: revision,
    workspaceId: "w",
    binding: binding(epoch),
    input: { inputPath: root, selectedEntry: "main.bp" },
    cancellation: new SharedArrayBuffer(4),
    sync: {
      epoch,
      session: "s",
      revision,
      baseRevision,
      analysisBase: null,
      overlays: { set: { "main.bp": text }, removed: [] },
    },
  };
}
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-worker-session-"));
  await writeFile(path.join(root, "main.bp"), "LCD.Clear()\n");
  worker = new LanguageWorkerSession({ "kobrixa.basic-plus:bp": basicPlusLanguageService });
});
afterEach(async () => {
  worker.dispose();
  await rm(root, { recursive: true, force: true });
});
it("applies cancelled deltas before the next request and resets across epochs", async () => {
  const one = request(1, 1, null, "x = 1\n");
  Atomics.store(new Int32Array(one.cancellation), 0, 1);
  await expect(worker.sync(one)).rejects.toThrow("cancelled");
  const two = await worker.sync(request(1, 2, 1, "x = 2\n"));
  expect(two.kind).toBe("result");
  expect(await worker.sync(request(2, 3, 2, "x = 3\n"))).toEqual({ kind: "resync", epoch: 2 });
  const next = await worker.sync(request(2, 4, null, "x = 4\n"));
  if (next.kind !== "result") throw new Error("Expected analysis");
  expect(next.patch.base).toBeNull();
  expect(applyAnalysis(undefined, next.patch).analysis.index.sources["main.bp"]).toBe("x = 4\n");
  expect(await worker.sync(request(1, 5, null, "x = 5\n"))).toEqual({ kind: "resync", epoch: 2 });
});
it("returns resync when the project language changes during loading", async () => {
  await writeFile(
    path.join(root, "kobrixa.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "changed",
      language: "case",
      target: "missing-vm",
      entry: "main.csx",
      outputDir: "out",
      assets: [],
    }),
  );
  expect(await worker.sync(request(1, 1, null, "LCD.Clear()\n"))).toEqual({
    kind: "resync",
    epoch: 1,
  });
});
it("publishes BUILD1007 for forged sources without retaining a usable fix snapshot", async () => {
  const factory = {
    ...basicPlusLanguageService,
    createAnalysis() {
      const provider = basicPlusLanguageService.createAnalysis();
      const analyze = provider.analyze.bind(provider);
      provider.analyze = (...args) => {
        const result = analyze(...args);
        return {
          ...result,
          diagnostics: result.diagnostics.map((d) => ({ ...d, source: "test.forged" })),
        };
      };
      return provider;
    },
  };
  worker.dispose();
  worker = new LanguageWorkerSession({ "kobrixa.basic-plus:bp": factory });
  const reply = await worker.sync(request(1, 1, null, "LCD.Clear(\n"));
  if (reply.kind !== "result") throw new Error("Expected result");
  expect(applyAnalysis(undefined, reply.patch).analysis.diagnostics).toEqual([
    expect.objectContaining({ code: "BUILD1007", source: "kobrixa.core" }),
  ]);
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/language/language-worker-session.test.ts`

Expected: FAIL（worker session 尚未抽出）。

- [ ] **Step 3: 一次更新同步 envelopes 與 worker protocol**

`LanguageSyncRequest`、`CompletionSyncRequest`、`QuickFixRequest` 首欄加 `epoch: number`；reply unions 改成以下程式（各檔加入相應 import）：

```ts
// language-sync.ts
export type LanguageSyncReply =
  | { kind: "resync"; epoch: number }
  | { kind: "unavailable"; epoch: number; reason: "missing" | "conflict"; language: string }
  | { kind: "result"; epoch: number; session: string; revision: number; patch: AnalysisPatch };
// completion-sync.ts
export type CompletionSyncReply =
  | { kind: "resync"; epoch: number }
  | { kind: "unavailable"; epoch: number; reason: "missing" | "conflict"; language: string }
  | {
      kind: "result";
      epoch: number;
      session: string;
      revision: number;
      versions: Record<string, number>;
      index: CompletionIndex;
    };
// quick-fixes.ts
export type QuickFixReply =
  { kind: "result"; epoch: number; fixes: QuickFix[] } | { kind: "stale"; epoch: number };
```

`language-protocol.ts` 的 `DiagnosticsRequest` 加 `binding: LanguageBinding`；`DiagnosticsReply` 改為 `{ id: number; epoch: number; ok: true; reply: LanguageSyncReply } | { id: number; epoch: number; ok: false; error: string }`。`QuickFixWorkerReply` 加 `epoch: number`，並新增：

```ts
export interface FeatureWorkerRequest {
  kind: "feature";
  id: number;
  workspaceId: string;
  request: LanguageFeatureRequest;
  cancellation: SharedArrayBuffer;
}
export interface FeatureWorkerReply {
  kind: "feature";
  id: number;
  epoch: number;
  result: LanguageFeatureReply;
}
```

`CompletionWorkerRequest` 加 `binding: LanguageBinding`、`cancellation: SharedArrayBuffer`；`CompletionWorkerReply` 兩個分支都加 `epoch: number`。不得允許 renderer 送入 binding：只在 main 建立 worker request 時加上。

- [ ] **Step 4: 抽出可測 worker session，保留有界歷史與取消次序**

建立 `language-worker-session.ts`：

```ts
import {
  BuildError,
  diagnostic,
  loadProject,
  ProjectSourceCache,
  requirePublished,
  stampDiagnostics,
} from "@kobrixa/compiler";
import {
  applyRecord,
  diffAnalysis,
  emptyAnalysis,
  type LanguageSyncReply,
} from "../../shared/language-sync.js";
import { bindingKey, supportsFile, type LanguageBinding } from "../../shared/language-services.js";
import { sameDiagnostic, type QuickFixReply } from "../../shared/quick-fixes.js";
import type { LanguageAnalysis } from "../../shared/language-types.js";
import type { LanguageFeatureReply } from "../../shared/language-query.js";
import type {
  DiagnosticsRequest,
  QuickFixWorkerRequest,
  FeatureWorkerRequest,
} from "./language-protocol.js";
import type {
  LanguageServiceFactory,
  LanguageAnalysisProvider,
  ProviderAnalysis,
} from "./language-provider.js";

export function cancellationSignal(buffer: SharedArrayBuffer): AbortSignal {
  const bits = new Int32Array(buffer);
  const controller = new AbortController();
  const check = controller.signal.throwIfAborted.bind(controller.signal);
  controller.signal.throwIfAborted = () => {
    if (Atomics.load(bits, 0)) controller.abort(new Error("Diagnostics cancelled."));
    check();
  };
  return controller.signal;
}
export function publishAnalysis(raw: ProviderAnalysis, binding: LanguageBinding): LanguageAnalysis {
  try {
    return { ...raw, diagnostics: stampDiagnostics(raw.diagnostics, binding.pluginId) };
  } catch (error) {
    if (!(error instanceof BuildError) || error.code !== "BUILD1007") throw error;
    return { ...emptyAnalysis(), diagnostics: [diagnostic(error.code, error.detail)] };
  }
}
export class LanguageWorkerSession {
  private binding: LanguageBinding | undefined;
  private workspaceId = "";
  private provider: LanguageAnalysisProvider | undefined;
  private sources = new ProjectSourceCache();
  private session = "";
  private revision = 0;
  private overlays: Record<string, string> = Object.create(null);
  private history = new Map<number, LanguageAnalysis>();
  private fixes = new Map<string, QuickFixReply>();
  constructor(private readonly factories: Readonly<Record<string, LanguageServiceFactory>>) {}
  async sync(message: DiagnosticsRequest): Promise<LanguageSyncReply> {
    const { binding, workspaceId, sync, input, id } = message;
    const epoch = this.binding?.epoch ?? binding.epoch;
    if (binding.epoch < epoch || sync.epoch !== binding.epoch) return { kind: "resync", epoch };
    const changed = this.binding?.epoch !== binding.epoch || this.workspaceId !== workspaceId;
    if (changed) {
      this.dispose();
      this.binding = structuredClone(binding);
      this.workspaceId = workspaceId;
      this.provider = this.factories[bindingKey(binding)]?.createAnalysis();
      if (!this.provider) throw new Error("Language service factory is missing.");
    }
    if (
      sync.baseRevision !== null &&
      (changed ||
        this.session !== sync.session ||
        this.revision !== sync.baseRevision ||
        sync.revision <= this.revision)
    )
      return { kind: "resync", epoch: binding.epoch };
    if (!changed && this.session !== sync.session) {
      this.provider?.dispose();
      this.provider = this.factories[bindingKey(binding)]!.createAnalysis();
      this.history.clear();
      this.fixes.clear();
      this.sources = new ProjectSourceCache();
    }
    // Same-epoch cancelled requests still apply document deltas before checking cancellation.
    this.overlays = applyRecord(
      sync.baseRevision === null ? Object.create(null) : this.overlays,
      sync.overlays,
    );
    this.session = sync.session;
    this.revision = sync.revision;
    this.fixes.clear();
    const signal = cancellationSignal(message.cancellation);
    signal.throwIfAborted();
    let languageChanged = false;
    const loaded = await loadProject(
      input.inputPath,
      new Map(Object.entries(this.overlays).filter(([file]) => supportsFile(binding, file))),
      input.selectedEntry,
      this.sources,
      (manifest) => {
        if (manifest.language !== binding.language) {
          languageChanged = true;
          throw new BuildError("BUILD1001", "Language binding changed during project loading.");
        }
        return binding.frontend;
      },
    );
    if (languageChanged) return { kind: "resync", epoch: binding.epoch };
    signal.throwIfAborted();
    let analysis: LanguageAnalysis;
    if (!loaded.project) {
      if (!loaded.diagnostics.length) throw new Error("Choose an entry file before checking.");
      analysis = { ...emptyAnalysis(), diagnostics: requirePublished(loaded.diagnostics) };
    } else analysis = publishAnalysis(this.provider!.analyze(loaded.project, id, signal), binding);
    signal.throwIfAborted();
    const base = sync.analysisBase === null ? undefined : this.history.get(sync.analysisBase);
    const patch = diffAnalysis(base, analysis, sync.analysisBase, id);
    this.history.set(id, analysis);
    while (this.history.size > 2) this.history.delete(this.history.keys().next().value!);
    return {
      kind: "result",
      epoch: binding.epoch,
      session: sync.session,
      revision: sync.revision,
      patch,
    };
  }
  private owns(
    workspaceId: string,
    query: { epoch: number; session: string; revision: number; analysisVersion: number },
  ): boolean {
    return (
      this.workspaceId === workspaceId &&
      this.binding?.epoch === query.epoch &&
      this.session === query.session &&
      this.revision === query.revision &&
      this.history.has(query.analysisVersion)
    );
  }
  quickFixes(message: QuickFixWorkerRequest): QuickFixReply {
    const query = message.request;
    const stale: QuickFixReply = { kind: "stale", epoch: this.binding?.epoch ?? query.epoch };
    if (!this.binding || !this.provider || !this.owns(message.workspaceId, query)) return stale;
    const published = this.history
      .get(query.analysisVersion)!
      .diagnostics.find((d) => d.file === query.file && sameDiagnostic(d, query.diagnostic));
    if (
      !published ||
      published.source !== this.binding.pluginId ||
      !supportsFile(this.binding, query.file)
    )
      return stale;
    if (!this.binding.capabilities.includes("quickFixes"))
      return { kind: "result", epoch: query.epoch, fixes: [] };
    const key = JSON.stringify([
      query.epoch,
      query.session,
      query.revision,
      query.analysisVersion,
      query.file,
      query.diagnostic,
    ]);
    try {
      const signal = cancellationSignal(message.cancellation);
      signal.throwIfAborted();
      const result =
        this.fixes.get(key) ??
        ({
          kind: "result",
          epoch: query.epoch,
          fixes: this.provider.quickFixes(query.analysisVersion, query.file, published, signal),
        } satisfies QuickFixReply);
      signal.throwIfAborted();
      this.fixes.set(key, result);
      while (this.fixes.size > 128) this.fixes.delete(this.fixes.keys().next().value!);
      return result;
    } catch {
      return stale;
    }
  }
  feature(message: FeatureWorkerRequest): LanguageFeatureReply {
    const request = message.request;
    const stale: LanguageFeatureReply = {
      kind: "stale",
      epoch: this.binding?.epoch ?? request.epoch,
    };
    const capability = request.query.kind === "renameLocation" ? "rename" : request.query.kind;
    if (
      !this.binding ||
      !this.provider ||
      !this.owns(message.workspaceId, request) ||
      !this.binding.capabilities.includes(capability) ||
      !supportsFile(this.binding, request.query.file)
    )
      return stale;
    const signal = cancellationSignal(message.cancellation);
    signal.throwIfAborted();
    const result = this.provider.query(request.analysisVersion, request.query, signal);
    signal.throwIfAborted();
    return { kind: "result", epoch: request.epoch, result };
  }
  dispose(): void {
    this.provider?.dispose();
    this.provider = undefined;
    this.sources = new ProjectSourceCache();
    this.history.clear();
    this.fixes.clear();
    this.overlays = Object.create(null);
    this.session = "";
    this.revision = 0;
  }
}
```

`language-worker.ts` 刪除原 Basic Plus imports、全域 analyzer、history、fixes 與相容 adapter，改成入口（`startCompletionWorker` 改接受同一 factory 表）：

```ts
import { parentPort, workerData } from "node:worker_threads";
import { BUILTIN_LANGUAGE_SERVICES } from "../workspace/builtin-language-services.js";
import { startCompletionWorker } from "./completion-worker.js";
import { LanguageWorkerSession } from "./language-worker-session.js";
import type {
  DiagnosticsRequest,
  DiagnosticsReply,
  QuickFixWorkerRequest,
  QuickFixWorkerReply,
  FeatureWorkerRequest,
  FeatureWorkerReply,
} from "./language-protocol.js";
const port = parentPort;
if (!port) throw new Error("Diagnostics must run in a worker.");
if (workerData?.completion) startCompletionWorker(port, BUILTIN_LANGUAGE_SERVICES);
else {
  const session = new LanguageWorkerSession(BUILTIN_LANGUAGE_SERVICES);
  let queue = Promise.resolve();
  port.on(
    "message",
    (request: DiagnosticsRequest | QuickFixWorkerRequest | FeatureWorkerRequest) => {
      queue = queue.then(async () => {
        if ("kind" in request) {
          if (request.kind === "quick-fixes")
            port.postMessage({
              kind: "quick-fixes",
              id: request.id,
              epoch: request.request.epoch,
              result: session.quickFixes(request),
            } satisfies QuickFixWorkerReply);
          else {
            let result: FeatureWorkerReply["result"];
            try {
              result = session.feature(request);
            } catch {
              result = { kind: "stale", epoch: request.request.epoch };
            }
            port.postMessage({
              kind: "feature",
              id: request.id,
              epoch: request.request.epoch,
              result,
            } satisfies FeatureWorkerReply);
          }
          return;
        }
        let reply: DiagnosticsReply;
        try {
          reply = {
            id: request.id,
            epoch: request.binding.epoch,
            ok: true,
            reply: await session.sync(request),
          };
        } catch (error) {
          reply = {
            id: request.id,
            epoch: request.binding.epoch,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        port.postMessage(reply);
      });
    },
  );
  port.once("close", () => session.dispose());
}
```

- [ ] **Step 5: 切換 completion worker，保留 refresh-only 磁碟掃描**

`startCompletionWorker(port: MessagePort, factories: Readonly<Record<string, LanguageServiceFactory>>): void` 的精確 edits：

```ts
// Replace the BasicPlusCompletionAnalyzer import/state with these imports/state.
import type { LanguageServiceFactory, LanguageCompletionProvider } from "./language-provider.js";
import { bindingKey } from "../../shared/language-services.js";
import { cancellationSignal } from "./language-worker-session.js";
let provider: LanguageCompletionProvider | undefined;
let epoch = 0;
```

message handler 讀取 `binding`，在現有 nextKey/reset 區段之前加入：

```ts
if (binding.epoch < epoch || request.epoch !== binding.epoch) {
  port.postMessage({ id, epoch, ok: true, reply: { kind: "resync", epoch } });
  return;
}
const switched = binding.epoch !== epoch;
if (switched) {
  provider?.dispose();
  provider = factories[bindingKey(binding)]?.createCompletion();
  epoch = binding.epoch;
  key = "";
  revision = 0;
  documents = new Map();
  sources = new ProjectSourceCache();
  project = undefined;
  if (!provider) throw new Error("Language service factory is missing.");
}
const signal = cancellationSignal(message.cancellation);
```

原 nextKey 增加 epoch；reset 區段的 `new BasicPlusCompletionAnalyzer()` 改 `provider?.dispose(); provider = factories[bindingKey(binding)]!.createCompletion();`。文件 updates／revision 先套用再 `signal.throwIfAborted()`；`loadProject` 第五個參數必填：

```ts
let languageChanged = false;
const loaded = await loadProject(
  input.inputPath,
  new Map(),
  input.selectedEntry,
  sources,
  (manifest) => {
    if (manifest.language !== binding.language) {
      languageChanged = true;
      throw new BuildError("BUILD1001", "Language binding changed during project loading.");
    }
    return binding.frontend;
  },
);
if (languageChanged) {
  port.postMessage({ id, epoch, ok: true, reply: { kind: "resync", epoch } });
  return;
}
project = loaded.project;
```

此區段仍只存在 `if (!project || request.refresh)` 內；不要把 loader 移到每次 request。`analyzer.analyze` 改 `provider!.analyze`，使用 `signal`；發回結果前再 check cancellation。所有 `postMessage` 成功／失敗 envelope 及 resync/result 加當前 epoch；`port.once("close", () => provider?.dispose())`。overlays 只合併 `supportsFile(binding, file)` 成立者。

- [ ] **Step 6: 寫真 worker restart 與來源路由的失敗測試**

在 `language.test.ts` 的既有 background describe 加；constructor 加入 Task 2 resolver 注入後，現有 `service` fixture 改為四參數版本（見 Step 7）。`status()` 會發放 epoch，不在測試猜固定數字：

```ts
it("rejects an old result after a same-provider restart", async () => {
  const first = await service.status("workspace");
  const update = {
    epoch: first.epoch,
    session: "restart",
    revision: 1,
    baseRevision: null,
    analysisBase: null,
    overlays: { set: { "main.bp": "LCD.Clear(\n" }, removed: [] },
  };
  const reply = await service.sync("workspace", update);
  if (reply.kind !== "result") throw new Error("Expected result");
  const diagnostic = applyAnalysis(undefined, reply.patch).analysis.diagnostics[0]!;
  await workers[0]!.terminate();
  await vi.waitFor(async () =>
    expect((await service.status("workspace")).epoch).toBeGreaterThan(first.epoch),
  );
  expect(
    await service.quickFixes("workspace", {
      epoch: first.epoch,
      requestId: "old",
      session: update.session,
      revision: 1,
      analysisVersion: reply.patch.version,
      file: "main.bp",
      diagnostic,
    }),
  ).toMatchObject({ kind: "stale" });
  expect(await service.sync("workspace", update)).toMatchObject({ kind: "resync" });
  const next = await service.status("workspace");
  expect(
    await service.sync("workspace", { ...update, epoch: next.epoch, revision: 2 }),
  ).toMatchObject({
    kind: "result",
    epoch: next.epoch,
    patch: { base: null },
  });
});
it("does not start a worker for a missing language service", async () => {
  await writeFile(
    path.join(root, "kobrixa.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "missing",
      language: "case",
      target: "missing-vm",
      entry: "main.csx",
      assets: [],
      outputDir: "out",
    }),
  );
  const status = await service.status("workspace", true);
  const reply = await service.sync("workspace", {
    epoch: status.epoch,
    session: "s",
    revision: 1,
    baseRevision: null,
    analysisBase: null,
    overlays: { set: {}, removed: [] },
  });
  expect(reply).toEqual({
    kind: "unavailable",
    epoch: status.epoch,
    reason: "missing",
    language: "case",
  });
  expect(createWorker).not.toHaveBeenCalled();
});
```

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/language/language.test.ts`

Expected: FAIL（main 尚未提供 status／epoch handshake）。

- [ ] **Step 7: main 拆成每工作區兩條 lane，串同一 coordinator**

將目前 `language.ts` 的 `LanguageService` 類別搬至新 `language-lane.ts` 並改名 `LanguageLane`；移除 `CompletionService` import／field／constructor 建立／`completionSync`／dispose completion，並移除搬到 façade 的 `analyze`／`diagnostics` convenience methods 及不再使用的 `applyAnalysis` import。其餘 worker ref/unref、requestId 去重、取消、pending bookkeeping 保留。constructor 改：

```ts
constructor(
  private readonly workspaces: Pick<WorkspaceService, "projectInput">,
  private readonly createWorker: () => Worker,
  private readonly restarted: () => void,
) {}
private epoch = 0;
setBinding(binding: LanguageBinding): void {
  if (this.epoch === binding.epoch) return;
  this.cancel();
  const worker = this.worker; this.worker = undefined;
  this.workerSession = undefined; this.documents = undefined; this.accepted = undefined;
  this.epoch = binding.epoch;
  if (worker) void worker.terminate();
}
```

`LanguageLane.sync(workspaceId, update, binding)` 加第三參數；呼叫前由 façade `setBinding`。request 加 `binding`；`pending` 存 `epoch`；pending resolve type 改 `LanguageSyncReply`，成功後只有 `reply.kind === "result"` 才更新 accepted（存 epoch）。worker message 回應同時檢查 `worker === this.worker`、`reply.id`、`reply.epoch === pending.epoch === this.epoch`；接受結果的判斷為：

```ts
if (reply.epoch !== this.epoch || reply.epoch !== pending.epoch) return;
if (reply.ok) pending.resolve(reply.reply);
else pending.reject(new Error(reply.error));
```

pendingFixes 同樣存 epoch；`QuickFixRequest.epoch !== this.epoch` 直接 stale。`accepted` 四項舊檢查再加 epoch；postMessage 加 epoch 的 worker wrapper；await 之後重新驗證 accepted identity。`fail(worker,error)` 先移除 this.worker、清 accepted／pending、terminate 舊 worker，最後 `this.restarted()`；舊 exit 由 worker identity gate 忽略。`setBinding` 的主動 terminate 不觸發 restarted，避免無窮 epoch 增加。

新增 imports `LanguageFeatureRequest`／`LanguageFeatureReply`（`../../shared/language-query.js`）與 `FeatureWorkerRequest`／`FeatureWorkerReply`（`./language-protocol.js`），並加入以下成員：

```ts
private readonly pendingFeatures = new Map<number, {
  workspaceId: string; requestId: string; epoch: number;
  cancellation: Int32Array; resolve(result: LanguageFeatureReply): void;
}>();
async feature(workspaceId: string, request: LanguageFeatureRequest): Promise<LanguageFeatureReply> {
  if (this.disposed) throw new Error("Language service is disposed.");
  this.workspaces.projectInput(workspaceId);
  const accepted = this.accepted, worker = this.worker;
  if (!worker || !accepted || request.epoch !== this.epoch || accepted.epoch !== request.epoch ||
      accepted.workspaceId !== workspaceId || accepted.session !== request.session ||
      accepted.revision !== request.revision || accepted.analysisVersion !== request.analysisVersion ||
      [...this.pendingFeatures.values()].some((pending) =>
        pending.workspaceId === workspaceId && pending.requestId === request.requestId))
    return { kind: "stale", epoch: this.epoch };
  const cancellation = new Int32Array(new SharedArrayBuffer(4));
  const message: FeatureWorkerRequest = { kind: "feature", id: ++this.nextId, workspaceId,
    request, cancellation: cancellation.buffer as SharedArrayBuffer };
  worker.ref();
  const result = await new Promise<LanguageFeatureReply>((resolve) => {
    this.pendingFeatures.set(message.id, { workspaceId, requestId: request.requestId,
      epoch: request.epoch, cancellation, resolve });
    try { worker.postMessage(message); }
    catch (error) { this.fail(worker, error instanceof Error ? error : new Error(String(error))); }
  });
  return this.accepted === accepted && this.epoch === request.epoch
    ? result : { kind: "stale", epoch: this.epoch };
}
cancelFeature(workspaceId: string, requestId: string): void {
  for (const [id, pending] of this.pendingFeatures) {
    if (pending.workspaceId !== workspaceId || pending.requestId !== requestId) continue;
    Atomics.store(pending.cancellation, 0, 1);
    pending.resolve({ kind: "stale", epoch: this.epoch });
    this.pendingFeatures.delete(id);
    if (!this.pending && !this.pendingFixes.size && !this.pendingFeatures.size) this.worker?.unref();
    return;
  }
}
```

`startWorker` message union 加 `FeatureWorkerReply`；在既有 `"kind" in reply` 分支先處理 feature，不能將它誤送 pendingFixes：

```ts
if ("kind" in reply && reply.kind === "feature") {
  const pending = this.pendingFeatures.get(reply.id);
  if (!pending || reply.epoch !== pending.epoch || reply.epoch !== this.epoch) return;
  this.pendingFeatures.delete(reply.id);
  pending.resolve(
    reply.result.epoch === this.epoch ? reply.result : { kind: "stale", epoch: this.epoch },
  );
  if (!this.pending && !this.pendingFixes.size && !this.pendingFeatures.size) worker.unref();
  return;
}
```

`cancel`／`fail` 在清除 accepted 後、任何 early return 前加入；dispose 經由 cancel 清理，避免漏掉正在查詢的 request：

```ts
for (const pending of this.pendingFeatures.values()) {
  Atomics.store(pending.cancellation, 0, 1);
  pending.resolve({ kind: "stale", epoch: this.epoch });
}
this.pendingFeatures.clear();
```

所有 ref/unref 條件由 `!pending && !pendingFixes.size` 改為 `!pending && !pendingFixes.size && !pendingFeatures.size`；quick-fix 回覆也先驗其 wrapper 及 result 的 epoch，再從 map 移除，不能刪掉另一 epoch 的 pending。

`completion.ts` 保留 `CompletionService` 作單工作區 lane，constructor 加 `restarted: () => void`；`sync(workspaceId, request, binding)` 加第三參數；新增與 analysis lane 同形的 `setBinding`，clear pending 並 terminate worker；pending 存 epoch 與 cancellation。worker request 加 binding／cancellation。`stop(error, restart = true)` 先取消 SAB、清 worker，再且僅在 `restart` 時通知 coordinator；dispose／setBinding 呼叫 `stop(error, false)`。正常同 epoch superseded request 只設舊 SAB 並 reject，保留 worker，讓已排隊的 document delta 依序套用；不可沿用目前每次 supersede 就 terminate 的做法。

`language.ts` 新 façade 的 imports、必要狀態與 public constructor（routing 方法接在同一 class 內）：

```ts
import path from "node:path";
import { Worker } from "node:worker_threads";
import {
  readProjectDescription,
  requirePublished,
  type ProjectDescription,
  type PublishedDiagnostic,
} from "@kobrixa/compiler";
import type { LanguageServiceResolution } from "@kobrixa/plugin-runtime";
import { LanguageLane } from "./language-lane.js";
import { CompletionService } from "./completion.js";
import { LanguageBindings } from "../workspace/language-binding.js";
import {
  BUILTIN_LANGUAGE_SERVICES,
  resolveBuiltinLanguageService,
} from "../workspace/builtin-language-services.js";
import { ProjectLoadError } from "../workspace/project-load-error.js";
import type { WorkspaceService } from "../workspace/workspace.js";
import {
  applyAnalysis,
  emptyAnalysis,
  type LanguageSyncRequest,
  type LanguageSyncReply,
} from "../../shared/language-sync.js";
import type { CompletionSyncRequest, CompletionSyncReply } from "../../shared/completion-sync.js";
import type { LanguageAnalysis } from "../../shared/language-types.js";
import type { LanguageStatus, LanguageStatusEvent } from "../../shared/language-services.js";
import type { LanguageFeatureRequest, LanguageFeatureReply } from "../../shared/language-query.js";
import type { QuickFixRequest, QuickFixReply } from "../../shared/quick-fixes.js";
type Resolver = (language: string) => LanguageServiceResolution;
interface WorkspaceLanes {
  analysis: LanguageLane;
  completion: CompletionService;
  description?: ProjectDescription;
  inputKey: string;
  refreshSerial: number;
  projectErrorKey?: string;
}
export class LanguageService {
  private readonly bindings = new LanguageBindings(BUILTIN_LANGUAGE_SERVICES);
  private readonly lanes = new Map<string, WorkspaceLanes>();
  private readonly listeners = new Set<(event: LanguageStatusEvent) => void>();
  private disposed = false;
  private cancellationVersion = 0;
  constructor(
    private readonly workspaces: Pick<WorkspaceService, "projectInput">,
    private readonly createWorker = () => new Worker(path.join(__dirname, "language-worker.cjs")),
    private readonly resolve: Resolver = resolveBuiltinLanguageService,
    private readonly createCompletionWorker = () =>
      new Worker(path.join(__dirname, "language-worker.cjs"), { workerData: { completion: true } }),
  ) {}
  private workspace(id: string): WorkspaceLanes {
    this.workspaces.projectInput(id);
    if (this.disposed) throw new Error("Language service is disposed.");
    let lanes = this.lanes.get(id);
    if (!lanes) {
      const restarted = () => {
        const status = this.bindings.restart(id);
        if (status) this.publish(id, status);
      };
      lanes = {
        analysis: new LanguageLane(this.workspaces, this.createWorker, restarted),
        completion: new CompletionService(this.workspaces, this.createCompletionWorker, restarted),
        inputKey: "",
        refreshSerial: 0,
      };
      this.lanes.set(id, lanes);
    }
    return lanes;
  }
  private publish(workspaceId: string, status: LanguageStatus): void {
    const lanes = this.lanes.get(workspaceId)!;
    if (status.availability.kind === "available") {
      lanes.analysis.setBinding(status.availability.binding);
      lanes.completion.setBinding(status.availability.binding);
    } else {
      lanes.analysis.cancel();
      lanes.analysis.reset();
      lanes.completion.reset();
    }
    for (const listener of this.listeners) listener({ workspaceId, status });
  }
  async status(workspaceId: string, refresh = false): Promise<LanguageStatus> {
    const lanes = this.workspace(workspaceId);
    const input = this.workspaces.projectInput(workspaceId);
    const inputKey = JSON.stringify(input);
    if (!lanes.description || refresh || lanes.inputKey !== inputKey) {
      const serial = ++lanes.refreshSerial;
      const result = await readProjectDescription(input.inputPath, input.selectedEntry);
      if (this.disposed || this.lanes.get(workspaceId) !== lanes)
        throw new Error("Diagnostics cancelled.");
      if (serial !== lanes.refreshSerial) return this.status(workspaceId);
      if (!result.description) {
        // A malformed project is a core loader error, not a missing language provider.
        const key = JSON.stringify(result.diagnostics);
        if (lanes.projectErrorKey !== key) {
          lanes.projectErrorKey = key;
          const invalidated = this.bindings.restart(workspaceId);
          if (invalidated) this.publish(workspaceId, invalidated);
        }
        const previous = this.bindings.get(workspaceId);
        if (previous && lanes.description) return previous;
        throw new ProjectLoadError(requirePublished(result.diagnostics));
      }
      const recovered = lanes.projectErrorKey !== undefined;
      delete lanes.projectErrorKey;
      lanes.description = result.description;
      lanes.inputKey = inputKey;
      if (recovered) {
        const invalidated = this.bindings.restart(workspaceId);
        if (invalidated) this.publish(workspaceId, invalidated);
      }
    }
    const previous = this.bindings.get(workspaceId);
    const manifest = lanes.description.manifest;
    const status = this.bindings.select(
      workspaceId,
      manifest,
      this.resolve(manifest.language),
      inputKey,
    );
    if (previous?.epoch !== status.epoch) this.publish(workspaceId, status);
    return status;
  }
  async refresh(workspaceId?: string): Promise<void> {
    await Promise.all(
      [...this.lanes.keys()]
        .filter((id) => !workspaceId || id === workspaceId)
        .map(async (id) => {
          try {
            await this.status(id, true);
          } catch (error) {
            if (!(error instanceof ProjectLoadError)) throw error;
          }
        }),
    );
  }
  onStatus(listener: (event: LanguageStatusEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
```

上面 `reset()` 是新增到兩條 lane 的方法，不能留下未定義呼叫：

```ts
// LanguageLane
reset(): void {
  this.cancel();
  const worker = this.worker; this.worker = undefined;
  this.documents = undefined; this.workerSession = undefined; this.accepted = undefined;
  if (worker) void worker.terminate();
}
// CompletionService
reset(): void { this.stop(new Error("Language binding changed."), false); }
```

façade 的 routing 方法逐一加入；以下 `current` 只回 main 自己選出的 binding：

```ts
async sync(workspaceId: string, update: LanguageSyncRequest): Promise<LanguageSyncReply> {
  const cancellationVersion = this.cancellationVersion;
  const current = await this.status(workspaceId);
  if (cancellationVersion !== this.cancellationVersion) throw new Error("Diagnostics cancelled.");
  if (update.epoch !== current.epoch) return { kind: "resync", epoch: current.epoch };
  if (current.availability.kind === "unavailable") return { ...current.availability, epoch: current.epoch };
  const reply = await this.workspace(workspaceId).analysis.sync(workspaceId, update, current.availability.binding);
  if (this.bindings.get(workspaceId)?.epoch !== current.epoch) return { kind: "resync", epoch: this.bindings.get(workspaceId)!.epoch };
  if (reply.kind === "resync") await this.status(workspaceId, true);
  return reply;
}
async completionSync(workspaceId: string, request: CompletionSyncRequest): Promise<CompletionSyncReply> {
  const current = await this.status(workspaceId, request.refresh);
  if (request.epoch !== current.epoch) return { kind: "resync", epoch: current.epoch };
  if (current.availability.kind === "unavailable") return { ...current.availability, epoch: current.epoch };
  if (!current.availability.binding.capabilities.includes("completion")) return {
    kind: "result", epoch: current.epoch, session: request.session, revision: request.revision,
    versions: {}, index: { symbols: {}, scopes: [], fileContexts: {}, contextFiles: {}, guardsByFile: {} },
  };
  return this.workspace(workspaceId).completion.sync(workspaceId, request, current.availability.binding);
}
async quickFixes(workspaceId: string, request: QuickFixRequest): Promise<QuickFixReply> {
  this.workspaces.projectInput(workspaceId);
  const current = this.bindings.get(workspaceId);
  if (!current || request.epoch !== current.epoch || current.availability.kind !== "available")
    return { kind: "stale", epoch: current?.epoch ?? request.epoch };
  return this.workspace(workspaceId).analysis.quickFixes(workspaceId, request);
}
async feature(workspaceId: string, request: LanguageFeatureRequest): Promise<LanguageFeatureReply> {
  this.workspaces.projectInput(workspaceId);
  const current = this.bindings.get(workspaceId);
  if (!current || request.epoch !== current.epoch || current.availability.kind !== "available")
    return { kind: "stale", epoch: current?.epoch ?? request.epoch };
  return this.workspace(workspaceId).analysis.feature(workspaceId, request);
}
cancelQuickFix(workspaceId: string, requestId: string): void { this.lanes.get(workspaceId)?.analysis.cancelQuickFix(workspaceId, requestId); }
cancelFeature(workspaceId: string, requestId: string): void { this.lanes.get(workspaceId)?.analysis.cancelFeature(workspaceId, requestId); }
cancel(): void { this.cancellationVersion++; for (const lane of this.lanes.values()) lane.analysis.cancel(); }
close(workspaceId: string): void {
  const lanes = this.lanes.get(workspaceId);
  if (lanes) { lanes.refreshSerial++; lanes.analysis.dispose(); lanes.completion.dispose(); }
  this.lanes.delete(workspaceId); this.bindings.forget(workspaceId);
}
dispose(): void {
  this.disposed = true;
  for (const lane of this.lanes.values()) { lane.analysis.dispose(); lane.completion.dispose(); }
  this.lanes.clear(); this.listeners.clear();
}
```

`LanguageBindings.select` 的完整公開簽名增加可選 `routingKey?: string`，以 inputPath／selectedEntry 納入路由 fingerprint。`LanguageService` 加以下 convenience API，保留 core loader diagnostics 的來源；這些函式不提供 unavailable 的空診斷假象：

```ts
private compatibilityRevision = 0;
async analyze(workspaceId: string, overlays: Record<string, string>): Promise<LanguageAnalysis> {
  const cancellationVersion = this.cancellationVersion;
  try {
    const status = await this.status(workspaceId, true);
    if (cancellationVersion !== this.cancellationVersion) throw new Error("Diagnostics cancelled.");
    const reply = await this.sync(workspaceId, { epoch: status.epoch, session: "compatibility",
      revision: ++this.compatibilityRevision, baseRevision: null, analysisBase: null,
      overlays: { set: overlays, removed: [] } });
    if (reply.kind !== "result") throw new Error("Language service unavailable or resynchronizing.");
    return applyAnalysis(undefined, reply.patch).analysis;
  } catch (error) {
    if (!(error instanceof ProjectLoadError)) throw error;
    if (!error.diagnostics.length) throw new Error("Choose an entry file before checking.");
    return { ...emptyAnalysis(), diagnostics: requirePublished(error.diagnostics) };
  }
}
async diagnostics(workspaceId: string, overlays: Record<string, string>): Promise<PublishedDiagnostic[]> {
  return (await this.analyze(workspaceId, overlays)).diagnostics;
}
```

`resolveBuiltinLanguageService` 放 `builtin-language-services.ts`，補以下 imports 與函式。此方法仍以宣告解析，沒有硬寫 Basic Plus fallback；正式 `index.ts` 傳 manager resolver：

```ts
import { pluginManifestSchema } from "@kobrixa/plugin-protocol";
import {
  resolvePlugins,
  resolveFrontendProvider,
  type LanguageServiceResolution,
} from "@kobrixa/plugin-runtime";
import { BUILTIN_PLUGIN_SOURCES } from "../plugins/builtin.js";
export function resolveBuiltinLanguageService(language: string): LanguageServiceResolution {
  const plugins = resolvePlugins(
    BUILTIN_PLUGIN_SOURCES.map((source) => {
      if (source.kind !== "builtin") throw new Error("Built-in sources only.");
      const manifest = pluginManifestSchema.parse(source.manifest);
      return {
        id: manifest.id,
        sourceKey: `builtin:${manifest.id}`,
        source: "builtin" as const,
        problems: [],
        manifest,
      };
    }),
    { safeMode: false, disabled: new Set() },
  );
  const selected = resolveFrontendProvider(plugins, language);
  if (!selected.ok) return selected;
  const owner = plugins.find((plugin) => plugin.sourceKey === selected.frontend.sourceKey)!;
  const declaration = owner.manifest?.contributes?.languageServices?.find(
    (service) => service.language === language,
  );
  return declaration
    ? structuredClone({ ok: true, frontend: selected.frontend, generation: 0, declaration })
    : { ok: false, reason: "missing", language, conflicts: [] };
}
```

- [ ] **Step 8: 串 IPC、狀態事件與 wire 驗證**

`shared/api.ts` 的 `language` 增加上述 status／feature／cancelFeature 及 `onStatus(listener: (event: LanguageStatusEvent) => void): () => void`。preload 對應：

```ts
status: (workspaceId, refresh) => ipcRenderer.invoke("language:status", workspaceId, refresh ?? false),
feature: (workspaceId, request) => ipcRenderer.invoke("language:feature", workspaceId, request),
cancelFeature: (workspaceId, requestId) => ipcRenderer.invoke("language:cancel-feature", workspaceId, requestId),
onStatus: (listener) => {
  const receive = (_event: Electron.IpcRendererEvent, event: LanguageStatusEvent) => listener(event);
  ipcRenderer.on("language:status-changed", receive);
  return () => { ipcRenderer.removeListener("language:status-changed", receive); };
},
```

`main/index.ts` 建立 language 時明確注入 manager，並加入可解除的兩個訂閱；放在既有 will-quit callback 一起清理：

```ts
const language = new LanguageService(workspaces, undefined, (language) =>
  plugins.resolveLanguageService(language),
);
const offLanguageStatus = language.onStatus((event) => {
  const target = renderer();
  if (target && !target.isDestroyed()) target.send("language:status-changed", event);
});
const offLanguagePlugins = plugins.onEvent((event) => {
  if (event.type === "state") void language.refresh().catch(console.error);
});
// At the beginning of the existing will-quit callback:
offLanguageStatus();
offLanguagePlugins();
```

`main/ipc.ts` 在 handlers 前新增 helper；`workspace:refresh` 已由 App 的 external-change polling 呼叫，這是實際的外部更新入口，沒有另造不存在的 watcher：

```ts
const afterRouting = <T>(workspaceId: string, work: () => T | Promise<T>): Promise<T> =>
  Promise.resolve(work()).then(async (result) => {
    await language.refresh(workspaceId);
    return result;
  });
```

將 `workspace:select-entry`、`workspace:refresh`、`workspace:create-entry`、`workspace:move-entry`、`workspace:trash-entry` 的原 `workspaces.method(...)` expression 精確包成 `afterRouting(id.parse(workspaceId), () => workspaces.method(...))`；裡面的原有 id／file／entry／record schema parse 不改。write handler 替換為：

```ts
handle(
  "workspace:write",
  (_event, workspaceId: unknown, sourceFile: unknown, source: unknown, expected: unknown) => {
    const workspace = id.parse(workspaceId),
      name = file.parse(sourceFile);
    const text = content.parse(source),
      revision = fileRevision.parse(expected);
    const write = () => workspaces.write(workspace, name, text, revision);
    return /(?:^|\/)kobrixa\.json$/i.test(name) ? afterRouting(workspace, write) : write();
  },
);
handle("workspace:close", (_event, workspaceId: unknown) => {
  const workspace = id.parse(workspaceId);
  const result = workspaces.close(workspace);
  language.close(workspace);
  return result;
});
```

`afterRouting` 的描述錯誤不可讓已成功存檔的 write 回報失敗：`language.refresh` 對 `ProjectLoadError` 保留 core diagnostics 狀態、讓下一次 sync 發布 core 診斷；其他錯誤照常 throw。初次專案根本無有效描述時仍交現有 error UI，不能憑空選 `bp`。已有合法 binding 的 malformed manifest refresh 先換 epoch、清舊結果，worker 載入失敗只發布 core diagnostics；不執行 provider.analyze。修復後再換 epoch、自動重分析。

`apps/desktop/src/main/workspace/workspace-ipc.test.ts` 在現有 fake `service` 外加 `const language = { refresh: vi.fn(async () => {}), close: vi.fn() };`，`registerIpc` 第四參數由 `{ } as never` 改 `language as never`。在 `workspace file IPC` describe 中加入：

```ts
it("refreshes language routing after external project refresh but not ordinary source writes", async () => {
  await handlers.get("workspace:refresh")!(event, workspaceId, { [sourceFile]: revision });
  expect(language.refresh).toHaveBeenCalledWith(workspaceId);
  language.refresh.mockClear();
  await handlers.get("workspace:write")!(event, workspaceId, sourceFile, "edited", revision);
  expect(language.refresh).not.toHaveBeenCalled();
  await handlers.get("workspace:write")!(event, workspaceId, "kobrixa.json", "{}", revision);
  expect(language.refresh).toHaveBeenCalledWith(workspaceId);
});
```

`main/ipc.ts` 新 handlers：

```ts
handle("language:status", (_event, workspaceId: unknown, refresh: unknown) =>
  language.status(id.parse(workspaceId), z.boolean().parse(refresh)),
);
handle("language:feature", (_event, workspaceId: unknown, request: unknown) =>
  language.feature(id.parse(workspaceId), languageFeatureRequestSchema.parse(request)),
);
handle("language:cancel-feature", (_event, workspaceId: unknown, requestId: unknown) =>
  language.cancelFeature(id.parse(workspaceId), quickFixRequestIdSchema.parse(requestId)),
);
```

`quick-fix-request.ts` 新增 epoch，並移除原兩個 refine：file 改 `.regex(/^[^\u0000]+$/)`；range 順序另用 `validateQuickFixRequest(value: unknown): QuickFixRequest` 做 `.parse` 之後的比較。IPC 改呼叫此函式：

```ts
export function validateQuickFixRequest(value: unknown): QuickFixRequest {
  const request = quickFixRequestSchema.parse(value);
  const r = request.diagnostic.range;
  if (r.endLine < r.startLine || (r.endLine === r.startLine && r.endColumn < r.startColumn))
    throw new Error("Quick fix range is reversed.");
  return request;
}
```

同檔新增完整 query 與 sync schemas；IPC 的 analysis/completion inline object 改為下面兩個 schema 的 `.parse`，避免沿用含 refine 的通用 file schema。保留現有每份 content 的 `8 * 1024 * 1024` 字元上限，沒有新 refine。

```ts
const languageFile = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[^\u0000]+$/);
const languageContent = z.string().max(8 * 1024 * 1024);
const epochSchema = z.number().int().positive();
const syncIdentity = {
  epoch: epochSchema,
  session: z.string().min(1).max(100),
  revision: z.number().int().positive(),
  baseRevision: z.number().int().nonnegative().nullable(),
};
const queryPosition = { file: languageFile, line: position, column: position };
export const languageFeatureRequestSchema = z.strictObject({
  requestId: quickFixRequestIdSchema,
  epoch: epochSchema,
  session: z.string().min(1).max(100),
  revision: z.number().int().positive(),
  analysisVersion: z.number().int().positive(),
  query: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("hover"), ...queryPosition }),
    z.strictObject({ kind: z.literal("signatureHelp"), ...queryPosition }),
    z.strictObject({ kind: z.literal("definition"), ...queryPosition }),
    z.strictObject({
      kind: z.literal("references"),
      ...queryPosition,
      includeDeclaration: z.boolean(),
    }),
    z.strictObject({ kind: z.literal("renameLocation"), ...queryPosition }),
    z.strictObject({
      kind: z.literal("rename"),
      ...queryPosition,
      newName: z.string().min(1).max(1024),
    }),
    z.strictObject({ kind: z.literal("documentSymbols"), file: languageFile }),
  ]),
});
export const languageSyncRequestSchema = z.strictObject({
  ...syncIdentity,
  analysisBase: z.number().int().positive().nullable(),
  overlays: z.strictObject({
    set: z.record(languageFile, languageContent),
    removed: z.array(languageFile),
  }),
});
export const completionSyncRequestSchema = z.strictObject({
  ...syncIdentity,
  refresh: z.boolean(),
  updates: z.array(
    z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("reset"),
        file: languageFile,
        document: z.strictObject({
          version: z.number().int().nonnegative(),
          text: languageContent,
        }),
      }),
      z.strictObject({ kind: z.literal("remove"), file: languageFile }),
      z.strictObject({
        kind: z.literal("edit"),
        file: languageFile,
        before: z.number().int().nonnegative(),
        version: z.number().int().positive(),
        changes: z.array(
          z.strictObject({
            offset: z.number().int().nonnegative(),
            length: z.number().int().nonnegative(),
            text: languageContent,
          }),
        ),
      }),
    ]),
  ),
});
```

`quick-fix-request.ts` 的頂部另匯入 `type QuickFixRequest`。現有 `quick-fix-request.test.ts` 的 `request(diagnostic)` fixture 加 `epoch: 1`。保留 `quickFixRequestIdSchema` 與既有 range position 上限。

在 `quick-fix-request.test.ts` 加：

```ts
it("exports request schemas without refinements and rejects absent epochs", () => {
  expect(() => z.toJSONSchema(quickFixRequestSchema)).not.toThrow();
  expect(() => z.toJSONSchema(languageFeatureRequestSchema)).not.toThrow();
  expect(() => z.toJSONSchema(languageSyncRequestSchema)).not.toThrow();
  expect(() => z.toJSONSchema(completionSyncRequestSchema)).not.toThrow();
  const value = {
    requestId: "r",
    session: "s",
    revision: 1,
    analysisVersion: 1,
    query: { kind: "hover", file: "main.csx", line: 1, column: 1 },
  };
  expect(languageFeatureRequestSchema.safeParse(value).success).toBe(false);
  expect(languageFeatureRequestSchema.safeParse({ ...value, epoch: 1 }).success).toBe(true);
  expect(
    languageFeatureRequestSchema.safeParse({ ...value, epoch: 1, pluginId: "test.forged" }).success,
  ).toBe(false);
});
```

此測試加 `import { z } from "zod"` 與四個 schema imports。此基線的 quick-fix request 測試還沒有 reversed range case；加入以下實際測試：

```ts
it("rejects reversed ranges after structural parsing", () => {
  const value = request({
    code: "BP1043",
    source: "kobrixa.basic-plus",
    range: { startLine: 2, startColumn: 5, endLine: 1, endColumn: 1 },
  });
  expect(quickFixRequestSchema.safeParse(value).success).toBe(true);
  expect(() => validateQuickFixRequest(value)).toThrow("range is reversed");
});
```

- [ ] **Step 9: 讓 AnalysisTransport 接受宿主 epoch，驗收 worker**

`analysis-transport.ts` 完整替換為下列通用傳輸層；本 task 一併定義 `AnalysisOutcome`，Task 6 遷移 UI callers。不同 epoch 不沿用 baseline，取消的同 epoch 增量仍保留已送 revision：

```ts
import type { Diagnostic } from "../../shared/api.js";
import type { LanguageAnalysis } from "../../shared/language-types.js";
import type { LanguageStatus } from "../../shared/language-services.js";
import type { QuickFixRequest, QuickFixReply } from "../../shared/quick-fixes.js";
import type {
  AnalysisIdentity,
  LanguageFeatureQuery,
  LanguageFeatureRequest,
  LanguageFeatureReply,
} from "../../shared/language-query.js";
import {
  applyAnalysis,
  diffRecord,
  type LanguageSyncReply,
  type LanguageSyncRequest,
} from "../../shared/language-sync.js";

export type AnalysisOutcome =
  | { kind: "result"; epoch: number; analysis: LanguageAnalysis }
  | { kind: "unavailable"; epoch: number; reason: "missing" | "conflict"; language: string };
type AcceptedVersion = AnalysisIdentity & { workspaceId: string };
export class AnalysisTransport {
  private workspaceId: string | undefined;
  private epoch = 0;
  private session = "";
  private revision = 0;
  private overlays: Record<string, string> | undefined;
  private result: { version: number; analysis: LanguageAnalysis } | undefined;
  private readonly versions = new WeakMap<LanguageAnalysis, AcceptedVersion>();
  constructor(
    private readonly sync: (
      workspaceId: string,
      request: LanguageSyncRequest,
    ) => Promise<LanguageSyncReply>,
    private readonly requestFixes?: (
      workspaceId: string,
      request: QuickFixRequest,
    ) => Promise<QuickFixReply>,
    private readonly cancelFix?: (workspaceId: string, requestId: string) => Promise<void>,
    private readonly requestFeature?: (
      workspaceId: string,
      request: LanguageFeatureRequest,
    ) => Promise<LanguageFeatureReply>,
    private readonly cancelFeature?: (workspaceId: string, requestId: string) => Promise<void>,
    private readonly refreshStatus?: (workspaceId: string) => Promise<LanguageStatus>,
  ) {}
  configure(workspaceId: string, epoch: number): void {
    if (this.workspaceId === workspaceId && this.epoch === epoch) return;
    this.workspaceId = workspaceId;
    this.epoch = epoch;
    this.session = crypto.randomUUID();
    this.revision = 0;
    this.overlays = undefined;
    this.result = undefined;
  }
  private accepts(analysis: LanguageAnalysis, version: AcceptedVersion): boolean {
    return (
      this.workspaceId === version.workspaceId &&
      this.epoch === version.epoch &&
      this.session === version.session &&
      this.revision === version.revision &&
      this.result?.analysis === analysis
    );
  }
  private async query<R extends { epoch: number }>(
    analysis: LanguageAnalysis,
    signal: AbortSignal | undefined,
    send: (version: AcceptedVersion, requestId: string) => Promise<R>,
    cancel: ((workspaceId: string, requestId: string) => Promise<void>) | undefined,
    stale: () => R,
  ): Promise<R> {
    const version = this.versions.get(analysis);
    if (signal?.aborted || !version || !this.accepts(analysis, version)) return stale();
    const requestId = crypto.randomUUID();
    const pending = send(version, requestId);
    let resolveCancelled!: (reply: R) => void;
    const cancelled = new Promise<R>((resolve) => {
      resolveCancelled = resolve;
    });
    const abort = () => {
      resolveCancelled(stale());
      void cancel?.(version.workspaceId, requestId).catch(() => undefined);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const reply = await Promise.race([pending, cancelled]);
      return !signal?.aborted && this.accepts(analysis, version) && reply.epoch === version.epoch
        ? reply
        : stale();
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  async quickFixes(
    analysis: LanguageAnalysis,
    diagnostic: Diagnostic,
    signal?: AbortSignal,
  ): Promise<QuickFixReply> {
    const stale = (): QuickFixReply => ({ kind: "stale", epoch: this.epoch });
    if (!this.requestFixes) return stale();
    return this.query(
      analysis,
      signal,
      (version, requestId) =>
        this.requestFixes!(version.workspaceId, {
          epoch: version.epoch,
          session: version.session,
          revision: version.revision,
          analysisVersion: version.analysisVersion,
          requestId,
          file: diagnostic.file,
          diagnostic: {
            source: diagnostic.source,
            code: diagnostic.code,
            range: diagnostic.range,
            ...(diagnostic.helpKey ? { helpKey: diagnostic.helpKey } : {}),
          },
        }),
      this.cancelFix,
      stale,
    );
  }
  async feature(
    analysis: LanguageAnalysis,
    query: LanguageFeatureQuery,
    signal?: AbortSignal,
  ): Promise<LanguageFeatureReply> {
    const stale = (): LanguageFeatureReply => ({ kind: "stale", epoch: this.epoch });
    if (!this.requestFeature) return stale();
    return this.query(
      analysis,
      signal,
      (version, requestId) =>
        this.requestFeature!(version.workspaceId, {
          epoch: version.epoch,
          session: version.session,
          revision: version.revision,
          analysisVersion: version.analysisVersion,
          requestId,
          query,
        }),
      this.cancelFeature,
      stale,
    );
  }
  async analyze(workspaceId: string, overlays: Record<string, string>): Promise<AnalysisOutcome> {
    if (this.workspaceId !== workspaceId || !this.epoch)
      throw new Error("Language status must be configured before analysis.");
    for (let attempt = 0; attempt < 2; attempt++) {
      const epoch = this.epoch,
        session = this.session;
      const request: LanguageSyncRequest = {
        epoch,
        session,
        revision: this.revision + 1,
        baseRevision: this.overlays ? this.revision : null,
        overlays: diffRecord(this.overlays, overlays),
        analysisBase: this.result?.version ?? null,
      };
      this.revision = request.revision;
      this.overlays = overlays;
      try {
        const reply = await this.sync(workspaceId, request);
        if (session !== this.session || epoch !== this.epoch || request.revision !== this.revision)
          throw new Error("Diagnostics cancelled.");
        if (reply.kind === "resync") {
          this.overlays = undefined;
          this.result = undefined;
          if (this.refreshStatus) {
            const status = await this.refreshStatus(workspaceId);
            if (session !== this.session || epoch !== this.epoch)
              throw new Error("Diagnostics cancelled.");
            this.configure(workspaceId, status.epoch);
            if (status.availability.kind === "unavailable")
              return { ...status.availability, epoch: status.epoch };
          } else if (reply.epoch !== epoch) throw new Error("Diagnostics cancelled.");
          continue;
        }
        if (reply.epoch !== epoch) throw new Error("Diagnostics cancelled.");
        if (reply.kind === "unavailable") {
          this.result = undefined;
          this.overlays = undefined;
          return reply;
        }
        if (reply.session !== session || reply.revision !== request.revision)
          throw new Error("Language synchronization version mismatch.");
        this.result = applyAnalysis(this.result, reply.patch);
        this.versions.set(this.result.analysis, {
          workspaceId,
          epoch,
          session,
          revision: request.revision,
          analysisVersion: this.result.version,
        });
        return { kind: "result", epoch, analysis: this.result.analysis };
      } catch (error) {
        if (
          session === this.session &&
          epoch === this.epoch &&
          request.revision === this.revision &&
          !(error instanceof Error && /Diagnostics cancelled\./.test(error.message))
        ) {
          this.overlays = undefined;
          this.result = undefined;
        }
        throw error;
      }
    }
    throw new Error("Unable to synchronize language documents.");
  }
}
```

`analysis-transport.test.ts` 的真實 `server()` helper：sync reply 加 `epoch: request.epoch`；return 前建立 `transport` 並 `transport.configure("one", 1)`。測試內直接建立 transport 的地方亦先 configure；每次 `analyze("two", ...)` 前加 `transport.configure("two", 2)`。`reset` 的一次性 reply 改 `{ kind: "resync", epoch: 1 }`，先建立 `const retry = new AnalysisTransport(reset); retry.configure("one", 1);` 再呼叫 retry.analyze。兩處 `const analysis = await transport.analyze(...)` 改為先取得 outcome、以 `if (outcome.kind !== "result") throw new Error("Expected analysis");` narrowing，再取 `const analysis = outcome.analysis`。Quick Fix mock、deferred resolver type、result／stale 斷言都加入對應 epoch（工作區 one 為 1、切換 two 後 stale 為 2）。新增 imports `LanguageSyncReply`，供 Task 7 的反序回覆測試使用。

新增完整測試，驗證空成功與不可用分開、恢復強制 full sync：

```ts
it("keeps empty success distinct from unavailable and resynchronizes on recovery", async () => {
  const { sync, transport } = server();
  expect(await transport.analyze("one", {})).toMatchObject({
    kind: "result",
    epoch: 1,
    analysis: { diagnostics: [] },
  });
  sync.mockImplementationOnce(async () => ({
    kind: "unavailable",
    epoch: 1,
    reason: "missing",
    language: "bp",
  }));
  expect(await transport.analyze("one", {})).toEqual({
    kind: "unavailable",
    epoch: 1,
    reason: "missing",
    language: "bp",
  });
  transport.configure("one", 2);
  await transport.analyze("one", { "main.bp": "LCD.Clear()" });
  expect(sync.mock.calls.at(-1)![1]).toMatchObject({
    epoch: 2,
    baseRevision: null,
    analysisBase: null,
  });
});
```

將 `server()` 的 sync callback 回傳型別明寫 `Promise<LanguageSyncReply>`，讓不可用 mock 通過型別檢查。先執行 `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/analysis-transport.test.ts`，Expected: FAIL（原 transport 無 configure／outcome），再套用上面的實作並以相同命令驗證 PASS。

真 worker tests 全部 request object 由 `await service.status("workspace")` 取 epoch；completion 既有 independent-worker 測試改由同一 façade `service.completionSync`，使用 constructor 第四參數將 `{ workerData: { completion: true } }` 真 worker 加入 `workers`。既有 request/reply factory 必須回送收到的 epoch；Quick Fix title assertions 改 `title.en`。原 `useInjectedAnalyzer`、取消、dependency、UTF-16、BOM、stale 斷言保持；`analyzes unsaved include/import overlays` 的 symbol 斷言由 `{ name: "Double", type: "number", declaration: { file: "helper.bpm" } }` 改為 `{ name: "Double", signature: "Double(in number value): number", location: { file: "helper.bpm" } }`，不得留下 native symbol 欄位。

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/compiler build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/basic-plus build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/language src/main/workspace/workspace-ipc.test.ts src/renderer/editor/analysis-transport.test.ts
```

Expected: PASS；兩條 worker 真正獨立、source forgery 只有 BUILD1007、取消仍順序套用、restart 新 epoch、舊 request stale；沒有依 code 分派提供者。

- [ ] **Step 10: 格式化、lint 與 commit**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --write apps/desktop/src/main/workspace/builtin-language-services.ts apps/desktop/src/main/workspace/workspace-ipc.test.ts apps/desktop/src/main/language apps/desktop/src/shared/language-sync.ts apps/desktop/src/shared/completion-sync.ts apps/desktop/src/shared/quick-fixes.ts apps/desktop/src/shared/api.ts apps/desktop/src/main/index.ts apps/desktop/src/main/ipc.ts apps/desktop/src/preload/index.ts apps/desktop/src/renderer/editor/analysis-transport.ts apps/desktop/src/renderer/editor/analysis-transport.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec eslint apps/desktop/src/main/workspace/builtin-language-services.ts apps/desktop/src/main/workspace/workspace-ipc.test.ts apps/desktop/src/main/language apps/desktop/src/shared/language-sync.ts apps/desktop/src/shared/completion-sync.ts apps/desktop/src/shared/quick-fixes.ts apps/desktop/src/shared/api.ts apps/desktop/src/main/index.ts apps/desktop/src/main/ipc.ts apps/desktop/src/preload/index.ts apps/desktop/src/renderer/editor/analysis-transport.ts apps/desktop/src/renderer/editor/analysis-transport.test.ts
git add apps/desktop/src/main/workspace/workspace-ipc.test.ts apps/desktop/src/main/language/language-worker-session.ts apps/desktop/src/main/language/language-worker-session.test.ts apps/desktop/src/main/language/language-lane.ts apps/desktop/src/main/language/language-worker.ts apps/desktop/src/main/language/completion-worker.ts apps/desktop/src/main/language/language.ts apps/desktop/src/main/language/completion.ts apps/desktop/src/main/language/language-protocol.ts apps/desktop/src/main/language/quick-fix-request.ts apps/desktop/src/main/language/language.test.ts apps/desktop/src/main/language/quick-fix-request.test.ts apps/desktop/src/main/workspace/builtin-language-services.ts apps/desktop/src/shared/language-sync.ts apps/desktop/src/shared/completion-sync.ts apps/desktop/src/shared/quick-fixes.ts apps/desktop/src/shared/api.ts apps/desktop/src/main/index.ts apps/desktop/src/main/ipc.ts apps/desktop/src/preload/index.ts apps/desktop/src/renderer/editor/analysis-transport.ts apps/desktop/src/renderer/editor/analysis-transport.test.ts
git commit -m "feat(language): route worker sessions and stale results through binding epochs"
```

---

### Task 6: Renderer 全功能路由、epoch 快取與不可用 UX

**Files:**

- Create: `apps/desktop/src/renderer/editor/language-routing.ts`、`apps/desktop/src/renderer/editor/language-routing.test.ts`、`apps/desktop/src/renderer/editor/language-status-store.ts`、`apps/desktop/src/renderer/editor/language-status-store.test.ts`、`apps/desktop/src/renderer/editor/language-status.tsx`、`apps/desktop/src/renderer/editor/language-status.test.ts`、`apps/desktop/src/renderer/editor/language-imports.test.ts`
- Modify: `apps/desktop/src/renderer/editor/editor.tsx`、`apps/desktop/src/renderer/editor/language-features.ts`、`apps/desktop/src/renderer/editor/semantic-tokens.ts`、`apps/desktop/src/renderer/editor/completion-cache.ts`、`apps/desktop/src/renderer/editor/completion-session.ts`、`apps/desktop/src/renderer/editor/editor-format.ts`、`apps/desktop/src/renderer/editor/analysis-session.ts`、`apps/desktop/src/renderer/editor/analysis-transport.ts`、`apps/desktop/src/renderer/editor/outline.ts`、`apps/desktop/src/renderer/editor/breadcrumbs.tsx`
- Modify tests: `apps/desktop/src/renderer/editor/editor.test.ts`、`apps/desktop/src/renderer/editor/language-features.test.ts`、`apps/desktop/src/renderer/editor/semantic-tokens.test.ts`、`apps/desktop/src/renderer/editor/completion-cache.test.ts`、`apps/desktop/src/renderer/editor/completion-session.test.ts`、`apps/desktop/src/renderer/editor/analysis-session.test.ts`、`apps/desktop/src/renderer/editor/analysis-transport.test.ts`、`apps/desktop/src/renderer/editor/outline.test.ts`
- Modify: `apps/desktop/src/renderer/app.tsx`（原 file-change-banner 約 3701）、`apps/desktop/src/renderer/i18n/copy.ts`、`apps/desktop/src/renderer/workbench/diagnostic-details.tsx`、`apps/desktop/src/renderer/workbench/diagnostic-details.test.ts`

**Interfaces:**

- Consumes: `LanguageStatus`、`LanguageBinding`、`LanguageCompanion`、`LanguageFeatureRequest/Reply`、`CompletionIndex`、`LanguageSymbol`。
- Produces: `routeLanguage(file: string, status: LanguageStatus | undefined, companions?: Readonly<Record<string, LanguageCompanion>>): ModelLanguageRoute`、`createLanguageStatusStore(api: Pick<KobrixaApi["language"], "status" | "onStatus">)`。
- Produces: `LanguageFeatures`（取代 `BasicPlusLanguageFeatures`）與 `LanguageSemanticTokens`（取代 `BasicPlusSemanticTokens`）；`encodeSemanticTokens(tokens: readonly SemanticToken[], model: editor.ITextModel, legend: SemanticLegend, leadingBOM?: boolean): Uint32Array`。
- `EditorAnalysis` 加 `epoch: number; binding: LanguageBinding`；`AnalysisSession.configure(workspace: WorkspaceSummary | undefined, status?: LanguageStatus): void`；`CompletionSession.configure(workspace: WorkspaceSummary | undefined, status?: LanguageStatus, companion?: LanguageCompanion): void`。
- `AnalysisTransport.analyze` 回 `Promise<AnalysisOutcome>`，`type AnalysisOutcome = { kind: "result"; epoch: number; analysis: LanguageAnalysis } | { kind: "unavailable"; epoch: number; reason: "missing" | "conflict"; language: string }`；原 callers 都改讀明確 union。

- [ ] **Step 1: 寫 model 路由與 Review Focus 3 的失敗測試**

建立 `language-routing.test.ts`（新 fixture 完整定義）：

```ts
import { expect, it, vi } from "vitest";
import type { LanguageStatus } from "../../shared/language-services.js";
import { routeLanguage, replaceModelRoute } from "./language-routing.js";
vi.mock("monaco-editor", () => ({}));
const status: LanguageStatus = {
  epoch: 1,
  conflicts: [],
  availability: {
    kind: "available",
    binding: {
      epoch: 1,
      pluginId: "kobrixa.basic-plus",
      sourceKey: "builtin:kobrixa.basic-plus",
      language: "bp",
      extensions: ["bp", "bpi", "bpm"],
      capabilities: ["analysis", "completion"],
      frontend: {
        language: "bp",
        entryExtensions: ["bp"],
        sourceExtensions: ["bp", "bpi", "bpm"],
        ir: { min: 1, max: 1 },
      },
    },
  },
};
it("routes only selected extensions and preserves JSON and lexical highlighting", () => {
  expect(routeLanguage("中文.BP", status)).toMatchObject({
    monacoLanguage: "basic-plus",
    binding: { epoch: 1 },
  });
  expect(routeLanguage("kobrixa.json", status)).toEqual({ monacoLanguage: "json" });
  expect(routeLanguage("readme.txt", status)).toEqual({ monacoLanguage: "plaintext" });
  expect(
    routeLanguage("main.bp", {
      epoch: 2,
      conflicts: [],
      availability: {
        kind: "unavailable",
        reason: "missing",
        language: "bp",
      },
    }),
  ).toEqual({ monacoLanguage: "basic-plus" });
});
it("detaches a renamed or replaced model without losing its text", () => {
  const text = "LCD.Clear()";
  const oldModel = { text };
  const newModel = { text };
  const dispose = vi.fn();
  const attach = vi.fn(() => ({ dispose }));
  let previous = replaceModelRoute(undefined, oldModel, "main.bp", status, attach);
  previous = replaceModelRoute(previous, oldModel, "main.json", status, attach);
  expect(dispose).toHaveBeenCalledOnce();
  expect(attach).toHaveBeenCalledTimes(1);
  previous = replaceModelRoute(previous, newModel, "main.bp", status, attach);
  expect(attach).toHaveBeenCalledTimes(2);
  expect(oldModel.text).toBe(text);
  expect(newModel.text).toBe(text);
  previous.dispose();
  expect(dispose).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: 執行確認失敗並實作 model 路由**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/language-routing.test.ts`

Expected: FAIL（新路由不存在）。建立 `language-routing.ts`：

```ts
import {
  bindingKey,
  supportsFile,
  type LanguageBinding,
  type LanguageStatus,
} from "../../shared/language-services.js";
import type { LanguageCompanion } from "./language-companion.js";
import { BUILTIN_LANGUAGE_COMPANIONS } from "./builtin-language-companions.js";
export interface ModelLanguageRoute {
  monacoLanguage: string;
  binding?: LanguageBinding;
  companion?: LanguageCompanion;
}
export function routeLanguage(
  file: string,
  status: LanguageStatus | undefined,
  companions: Readonly<Record<string, LanguageCompanion>> = BUILTIN_LANGUAGE_COMPANIONS,
): ModelLanguageRoute {
  const lexical = /\.json$/i.test(file)
    ? "json"
    : /\.(bp|bpi|bpm)$/i.test(file)
      ? "basic-plus"
      : "plaintext";
  if (lexical === "json" || status?.availability.kind !== "available")
    return { monacoLanguage: lexical };
  const binding = status.availability.binding;
  if (!supportsFile(binding, file)) return { monacoLanguage: lexical };
  const companion = companions[bindingKey(binding)];
  return {
    monacoLanguage: companion?.monacoLanguage ?? lexical,
    binding,
    ...(companion ? { companion } : {}),
  };
}
interface AttachedRoute<T> {
  model: T;
  file: string;
  epoch: number | undefined;
  dispose(): void;
}
export function replaceModelRoute<T>(
  previous: AttachedRoute<T> | undefined,
  model: T,
  file: string,
  status: LanguageStatus | undefined,
  attach: (model: T, route: ModelLanguageRoute) => { dispose(): void },
): AttachedRoute<T> {
  const route = routeLanguage(file, status);
  if (
    previous?.model === model &&
    previous.file === file &&
    previous.epoch === route.binding?.epoch
  )
    return previous;
  previous?.dispose();
  const attached = route.binding ? attach(model, route) : undefined;
  return { model, file, epoch: route.binding?.epoch, dispose: () => attached?.dispose() };
}
```

`editor.tsx` 的 `languageFor(file)` 改呼叫 `routeLanguage(file, currentStatus)`；原所有非 JSON → Basic Plus 的 default 移除。`ensureModel` 與 rename target 都套用；model attach 呼叫 `replaceModelRoute`，disposer 負責 `semanticTokens.unbind(model)`、`completionSession.unbind(file, model)`、清 markers、取消該 model pending features。不 dispose model 本身。完整 editor lifecycle 測試仍在 Step 10。

- [ ] **Step 3: 寫狀態恢復與舊 unavailable 的失敗測試**

建立 `language-status-store.test.ts`：

```ts
import { expect, it, vi } from "vitest";
import type { LanguageStatus, LanguageStatusEvent } from "../../shared/language-services.js";
import { createLanguageStatusStore } from "./language-status-store.js";
const missing = (epoch: number): LanguageStatus => ({
  epoch,
  conflicts: [],
  availability: { kind: "unavailable", reason: "missing", language: "case" },
});
it("recovers without typing and ignores an older unavailable status", async () => {
  let emit!: (event: LanguageStatusEvent) => void;
  let resolve!: (status: LanguageStatus) => void;
  const off = vi.fn();
  const api = {
    status: vi.fn(
      () =>
        new Promise<LanguageStatus>((done) => {
          resolve = done;
        }),
    ),
    onStatus: (next: typeof emit) => {
      emit = next;
      return off;
    },
  };
  const store = createLanguageStatusStore(api);
  store.configure("w");
  emit({ workspaceId: "w", status: missing(2) });
  const available: LanguageStatus = {
    epoch: 3,
    conflicts: [],
    availability: {
      kind: "available",
      binding: {
        epoch: 3,
        pluginId: "test.case",
        sourceKey: "builtin:test.case",
        language: "case",
        extensions: ["csx"],
        capabilities: ["analysis"],
        frontend: {
          language: "case",
          entryExtensions: ["csx"],
          sourceExtensions: ["csx"],
          ir: { min: 1, max: 1 },
        },
      },
    },
  };
  emit({ workspaceId: "w", status: available });
  resolve(missing(1));
  await Promise.resolve();
  emit({ workspaceId: "w", status: missing(2) });
  expect(store.getSnapshot()).toEqual(available);
  emit({ workspaceId: "other", status: missing(99) });
  expect(store.getSnapshot()).toEqual(available);
  store.dispose();
  expect(off).toHaveBeenCalledOnce();
});
```

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/language-status-store.test.ts`

Expected: FAIL（store 尚不存在）。

- [ ] **Step 4: 實作狀態 store 並把 unavailable 與空 result 分流**

`language-status-store.ts`：

```ts
import type { LanguageStatus, LanguageStatusEvent } from "../../shared/language-services.js";
interface StatusApi {
  status(workspaceId: string, refresh?: boolean): Promise<LanguageStatus>;
  onStatus(listener: (event: LanguageStatusEvent) => void): () => void;
}
export function createLanguageStatusStore(
  api: StatusApi,
  report: (error: unknown) => void = console.error,
) {
  let workspaceId: string | undefined;
  let current: LanguageStatus | undefined;
  let sequence = 0;
  let disposed = false;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const accept = (id: string, status: LanguageStatus) => {
    if (disposed || id !== workspaceId || (current && status.epoch <= current.epoch)) return;
    current = status;
    emit();
  };
  const off = api.onStatus(({ workspaceId, status }) => accept(workspaceId, status));
  return {
    configure(id: string | undefined) {
      if (id === workspaceId) return;
      workspaceId = id;
      current = undefined;
      const request = ++sequence;
      emit();
      if (id)
        void api.status(id).then(
          (status) => {
            if (request === sequence) accept(id, status);
          },
          (error) => {
            if (!disposed && request === sequence) report(error);
          },
        );
    },
    getSnapshot: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      sequence++;
      off();
      listeners.clear();
    },
  };
}
```

`AnalysisTransport` 沿用 Task 5 已完整實作的 `AnalysisOutcome` 與 epoch gate。App 建立它時依 constructor 順序傳入 `api.language.sync`、`api.language.quickFixes`、`api.language.cancelQuickFix`、`api.language.feature`、`api.language.cancelFeature`、`(workspaceId) => api.language.status(workspaceId, true)`；分析 session 使用其明確 union，不能把 unavailable 轉為空成功。

先改 `analysis-session.test.ts` 的真實 `harness()`：requests／analyze Promise 型別由 `PublishedAnalysis` 改 `AnalysisOutcome`、callbacks 加 `unavailable: vi.fn()`；`result` 改下面函式；原 configure 呼叫全部加 `analysisStatus(1)`（包含切至 workspace two 的 case）。新增 `LanguageStatus`、`AnalysisOutcome` type imports 與 `emptyAnalysis` import，刪 native `emptySymbolIndex` import：

```ts
const result = (epoch = 1): AnalysisOutcome => ({
  kind: "result",
  epoch,
  analysis: emptyAnalysis(),
});
function analysisStatus(epoch: number): LanguageStatus {
  return {
    epoch,
    conflicts: [],
    availability: {
      kind: "available",
      binding: {
        epoch,
        pluginId: "kobrixa.basic-plus",
        sourceKey: "builtin:kobrixa.basic-plus",
        language: "bp",
        extensions: ["bp", "bpi", "bpm"],
        capabilities: ["analysis"],
        frontend: {
          language: "bp",
          entryExtensions: ["bp"],
          sourceExtensions: ["bp", "bpi", "bpm"],
          ir: { min: 1, max: 1 },
        },
      },
    },
  };
}
it("restarts analysis after availability recovers without a document edit", async () => {
  const { documents, session, callbacks, requests, workspace, detach } = harness();
  try {
    await vi.advanceTimersByTimeAsync(500);
    requests[0]!(result());
    await vi.advanceTimersByTimeAsync(0);
    const revision = documents.revision;
    session.configure(workspace, {
      epoch: 2,
      conflicts: [],
      availability: { kind: "unavailable", reason: "missing", language: "bp" },
    });
    expect(session.getCurrent()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(callbacks.analyze).toHaveBeenCalledTimes(1);
    session.configure(workspace, analysisStatus(3));
    await vi.advanceTimersByTimeAsync(500);
    expect(callbacks.analyze).toHaveBeenCalledTimes(2);
    expect(documents.revision).toBe(revision);
    requests[1]!(result(3));
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getCurrent()?.epoch).toBe(3);
    expect(callbacks.diagnostics).toHaveBeenCalledTimes(2);
  } finally {
    detach();
  }
});
```

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/analysis-session.test.ts`

Expected: FAIL（原 session 不會因 status 恢復而重新 schedule）。接著完整替換 `analysis-session.ts`：

```ts
import type { LanguageAnalysis } from "../../shared/language-types.js";
import { supportsFile, type LanguageStatus } from "../../shared/language-services.js";
import type { WorkspaceSummary } from "../../shared/api.js";
import type { AnalysisOutcome } from "./analysis-transport.js";
import type { EditorAnalysis } from "./editor.js";
import type { Documents } from "./documents.js";
import { LiveDiagnostics } from "./live-diagnostics.js";

type Snapshot = EditorAnalysis & { workspaceId: string; revision: number };
type Checked = {
  workspaceId: string;
  revision: number;
  epoch: number;
  overlays: Record<string, string>;
  outcome: AnalysisOutcome;
};
type Event = "result" | "invalidate" | "reset" | "failure";
export class AnalysisSession {
  private workspace: WorkspaceSummary | undefined;
  private status: LanguageStatus | undefined;
  private snapshot: Snapshot | undefined;
  private readonly listeners = new Set<(snapshot: Snapshot | undefined, event: Event) => void>();
  private readonly checker: LiveDiagnostics<Checked>;
  constructor(
    private readonly documents: Documents,
    callbacks: {
      analyze(workspaceId: string, overlays: Record<string, string>): Promise<AnalysisOutcome>;
      cancel(): void;
      diagnostics(result: LanguageAnalysis): void;
      unavailable(status: Extract<AnalysisOutcome, { kind: "unavailable" }>): void;
      checking(value: boolean): void;
      error(error: unknown): void;
    },
  ) {
    this.checker = new LiveDiagnostics({
      cancel: callbacks.cancel,
      check: async (workspaceId, overlays) => {
        const revision = documents.revision,
          epoch = this.status?.epoch ?? 0;
        return {
          workspaceId,
          revision,
          epoch,
          overlays,
          outcome: await callbacks.analyze(workspaceId, overlays),
        };
      },
      onDiagnostics: (checked) => {
        if (
          checked.revision !== documents.revision ||
          checked.workspaceId !== this.workspace?.id ||
          checked.epoch !== this.status?.epoch ||
          checked.outcome.epoch !== checked.epoch
        )
          return;
        if (checked.outcome.kind === "unavailable") {
          this.snapshot = undefined;
          this.emit("reset");
          callbacks.unavailable(checked.outcome);
          return;
        }
        if (this.status.availability.kind !== "available") return;
        this.snapshot = {
          workspaceId: checked.workspaceId,
          revision: checked.revision,
          epoch: checked.epoch,
          binding: this.status.availability.binding,
          overlays: checked.overlays,
          analysis: checked.outcome.analysis,
        };
        this.emit("result");
        callbacks.diagnostics(checked.outcome.analysis);
      },
      onChecking: callbacks.checking,
      onError: (error) => {
        this.snapshot = undefined;
        this.emit("failure");
        callbacks.error(error);
      },
    });
  }
  readonly getCurrent = (): Snapshot | undefined =>
    this.snapshot?.revision === this.documents.revision &&
    this.snapshot.epoch === this.status?.epoch
      ? this.snapshot
      : undefined;
  readonly subscribe = (listener: (snapshot: Snapshot | undefined, event: Event) => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  attach(): () => void {
    const unsubscribe = this.documents.onChange(() => this.schedule());
    this.schedule();
    return () => {
      unsubscribe();
      this.checker.cancel();
      this.snapshot = undefined;
    };
  }
  configure(workspace: WorkspaceSummary | undefined, status?: LanguageStatus): void {
    const previous = this.workspace,
      previousEpoch = this.status?.epoch;
    this.workspace = workspace;
    this.status = status;
    if (
      previous?.id === workspace?.id &&
      previous?.files === workspace?.files &&
      previous?.drafts === workspace?.drafts &&
      previousEpoch === status?.epoch
    )
      return;
    if (previous?.id !== workspace?.id || previousEpoch !== status?.epoch) {
      this.checker.cancel();
      this.snapshot = undefined;
      this.emit("reset");
    }
    this.schedule();
  }
  private schedule(): void {
    const hadSnapshot = Boolean(this.snapshot);
    this.snapshot = undefined;
    if (hadSnapshot) this.emit("invalidate");
    const availability = this.status?.availability;
    if (!this.workspace || availability?.kind !== "available") {
      this.checker.cancel();
      return;
    }
    const binding = availability.binding;
    this.checker.schedule(this.workspace.id, () =>
      Object.fromEntries([
        ...Object.entries(this.workspace?.drafts ?? {}).filter(([file]) =>
          supportsFile(binding, file),
        ),
        ...this.documents
          .getSnapshot()
          .filter((tab) => supportsFile(binding, tab.file))
          .map((tab) => [tab.file, tab.content]),
      ]),
    );
  }
  private emit(event: Event): void {
    for (const listener of this.listeners) listener(this.getCurrent(), event);
  }
}
```

以上相同命令 Expected: PASS，保留 500 ms 排程、lazy overlay、連續輸入與 effect reattachment 的原斷言。普通輸入只 emit invalidate；epoch 改變 emit reset。

`CompletionSession` 存 status／companion；configure epoch 改變時把現有「workspace id 改變」重設區段也執行：清 timer、pending updates、cache、模型 subscription、session UUID、base、generation；把所有仍存在的 editor models 透過 editor 重綁，強制 `baseRevision:null`／refresh true。模型 getValue 的讀取仍只發生同步快照時。把 `basic(file)` 全換 `binding && supportsFile(binding,file)`，`structuralCompletionChange` 改 companion.structuralChange；request 加 epoch，result 先驗 epoch／session，再採納 index。unavailable 清 cache，base null，不自動重試；resync 呼叫 status refresh 並重新 configure。舊 promise 的 finally 只可重設其 generation 的 running flag；新 epoch 可立即發出同步。

`CompletionCache` 加 `private epoch = 0`，`update(index: CompletionIndex, epoch: number)` 設 epoch；`symbols(file,position,epoch)` 先拒絕不相同 epoch。刪 `structuralText`，`rebaseCompletionRanges` 僅讀 `event.structural`、flush 與 guards；grouping／shadowing 改成：

```ts
for (const symbol of Object.values(index.symbols)) {
  let group = this.groups.get(symbol.group);
  if (!group) this.groups.set(symbol.group, (group = []));
  group.push(symbol);
}
// In symbols(), preserve local-then-context ordering, replace only the shadow filter:
const seen = new Set<string>();
return [
  ...(this.groups.get(state.scopeIds[local] ?? "") ?? []),
  ...(this.groups.get(context) ?? []),
].filter((symbol) => {
  if (seen.has(symbol.shadowKey)) return false;
  seen.add(symbol.shadowKey);
  return true;
});
```

`enrich` 必須保留 candidate 的 group/shadowKey，不用另一份分析的路由值覆蓋：`group[i] = { ...precise, group: group[i]!.group, shadowKey: group[i]!.shadowKey };`。types 全改 `LanguageSymbol`／`CompletionIndex`，model decoration description 改 `"language-completion-scope"`。

- [ ] **Step 5: 通用 Monaco feature router，逐一遷移全部功能**

`language-features.ts` 刪除所有 Basic Plus imports。`FeatureHost` 加：

```ts
binding(): LanguageBinding | undefined;
companion(): LanguageCompanion | undefined;
query(snapshot: EditorAnalysis, query: LanguageFeatureQuery, signal: AbortSignal): Promise<LanguageFeatureReply>;
completionSymbols?(model: monaco.editor.ITextModel, position: monaco.Position): LanguageSymbol[] | undefined;
```

類別改名 `LanguageFeatures`；保留原 `ready`、pending cancellation、snapshot/version checks、model ensure 與 workspaceEdit safeguards。`current` 再驗 binding epoch 和 extension：

```ts
const binding = this.host.binding();
if (
  !file ||
  !snapshot ||
  !binding ||
  snapshot.epoch !== binding.epoch ||
  !supportsFile(binding, file) ||
  !this.host.isCurrent(model, file, snapshot)
)
  return;
return { snapshot, file };
```

新增 query helper（每個 async 語意功能都走它，不直接呼叫 intelligence）：

```ts
private async query(model: monaco.editor.ITextModel, query: LanguageFeatureQuery,
  token: monaco.CancellationToken): Promise<{ current: NonNullable<ReturnType<LanguageFeatures["current"]>>; result: LanguageFeatureResult } | undefined> {
  const current = await this.ready(model, token);
  if (!current) return;
  const version = model.getVersionId(); const controller = new AbortController();
  this.pendingFixes.add(controller);
  const cancel = token.onCancellationRequested(() => controller.abort());
  try {
    const reply = await this.host.query(current.snapshot, query, controller.signal);
    if (reply.kind !== "result" || reply.epoch !== current.snapshot.epoch || controller.signal.aborted ||
        token.isCancellationRequested || this.disposed || model.isDisposed() ||
        model.getVersionId() !== version || this.current(model)?.snapshot !== current.snapshot) return;
    return { current, result: reply.result };
  } finally { cancel.dispose(); this.pendingFixes.delete(controller); }
}
private positionQuery(model: monaco.editor.ITextModel, position: monaco.Position) {
  const current = this.current(model);
  const file = this.host.fileFor(model) ?? "";
  const source = current?.snapshot.analysis.index.sources[file] ?? "";
  return { file, line: position.lineNumber,
    column: position.column + (position.lineNumber === 1 && source.startsWith("\uFEFF") ? 1 : 0) };
}
```

`register()` 的 selector 由 `this.host.companion()?.monacoLanguage` 產生；沒有 companion 時不註冊 Monaco handlers。使用單一 helper，所有 registrations 留在 `this.registrations`，epoch 切換 dispose 舊 instance 再建立新 instance：

```ts
const binding = this.host.binding(),
  companion = this.host.companion();
if (!binding || !companion) return;
const selector = { language: companion.monacoLanguage, scheme: "kobrixa" };
const add = (capability: LanguageCapability, register: () => monaco.IDisposable) => {
  if (binding.capabilities.includes(capability)) this.registrations.push(register());
};
```

將原十個 registrations 逐個包 `add`，對應為 completion、hover、signatureHelp、documentSymbols、definition、references、rename、quickFixes；新增 documentFormatting／rangeFormatting 兩個。trigger arrays 來自 companion。`provideDocumentFormattingEdits` 回 `[{ range: model.getFullModelRange(), text: companion.formatSource(model.getValue(), options.tabSize === 4 ? 4 : 2) }]`，先檢查該 model 的 `routeLanguage(...).binding?.epoch === binding.epoch` 及 cancellation；rangeFormatting 同 gate 後呼叫 companion.rangeFormatting。靜態 registration 不再註冊任何 formatting provider。

替換語意方法的核心（原 `ready`、`editorRange`、`rememberRename` 都保留）：

```ts
// hover()
const response = await this.query(
  model,
  { kind: "hover", ...this.positionQuery(model, position) },
  token,
);
if (response?.result.kind !== "hover" || !response.result.value) return;
return {
  range: editorRange(
    response.result.value.range,
    response.current.snapshot.analysis.index.sources[response.current.file]!,
  ),
  contents: response.result.value.contents.map((value) => ({ value })),
};

// signature()
const response = await this.query(
  model,
  { kind: "signatureHelp", ...this.positionQuery(model, position) },
  token,
);
if (response?.result.kind !== "signatureHelp" || !response.result.value) return;
const value = response.result.value;
return {
  value: {
    signatures: [
      {
        label: value.label,
        parameters: value.parameters.map((label) => ({ label })),
        ...(value.documentation === undefined ? {} : { documentation: value.documentation }),
      },
    ],
    activeSignature: 0,
    activeParameter: value.activeParameter,
  },
  dispose() {},
};

// definition(); references() uses kind:"references" plus includeDeclaration.
const response = await this.query(
  model,
  { kind: "definition", ...this.positionQuery(model, position) },
  token,
);
if (response?.result.kind !== "definition") return [];
return response.result.locations.map(({ file, range }) => {
  const source = response.current.snapshot.analysis.index.sources[file]!;
  return { uri: this.host.ensureModel(file, source).uri, range: editorRange(range, source) };
});

// rename() after the existing canEdit check
const response = await this.query(
  model,
  { kind: "rename", ...this.positionQuery(model, position), newName },
  token,
);
if (response?.result.kind !== "rename" || !this.host.canEdit())
  return {
    edits: [],
    rejectReason: "The document changed or is read-only. Try again after analysis completes.",
  };
if (response.result.rejectReason) return { edits: [], rejectReason: response.result.rejectReason };
const edit = {
  edits: response.result.edits.map(({ file, range, text }) => {
    const source = response.current.snapshot.analysis.index.sources[file]!;
    const target = this.host.ensureModel(file, source);
    return {
      resource: target.uri,
      versionId: target.getVersionId(),
      textEdit: { range: editorRange(range, source), text },
    };
  }),
};
rememberRename(edit, response.current.snapshot);
return edit;
```

`renameLocation()` 呼叫 kind renameLocation；失敗維持原 zero-length position range/rejectReason；成功將 SourceRange 以 editorRange 轉換，text 直接用 result.text。`documentSymbols()` 呼叫 query，kind mapping 為 `function→Function, method→Method, variable→Variable, parameter→Variable, label→Key, namespace→Namespace`；每項用原 convert 的 editorRange/model.validateRange、tags:[]、children 遞迴。outline 由 provider 回傳，不在 renderer 重新解釋 scope。

`completions()` 改為 companion.completions(model,position,candidates,token)；candidates 取 CompletionSession 的 cache，無 cache 回 `[]`，保留 `pendingCompletion` 與 refresh hook；result.incomplete 設 `!current`。同 epoch 有 current analysis 時以 `completionSession.enrich` 更新 display signature，無需在 renderer 呼叫 visibleSymbols。Quick Fix 的兩個 `offersBasicPlusQuickFix` guard 改為：

```ts
const binding = this.host.binding();
const canAskFix =
  binding?.capabilities.includes("quickFixes") &&
  diagnostic.source === binding.pluginId &&
  current.snapshot.epoch === binding.epoch;
```

仍保留 `sameDiagnostic` 的已發布診斷存在性檢查、可編輯、range intersection、取消、model/version 重驗；fix 標題改 `quickFixTitle(fix.title,locale)`。`DiagnosticDetails` 同樣讀 snapshot.binding.capabilities 及 source；移除 shared Basic Plus helper import。

- [ ] **Step 6: Semantic tokens、outline 與儲存格式化轉通用**

`semantic-tokens.ts` 刪固定 semanticLegend，constructor 改 `constructor(private readonly legend: SemanticLegend, private readonly languageId: string, private readonly epoch: number) {}`；class 改 `LanguageSemanticTokens`，getLegend 回 this.legend。`encodeSemanticTokens` 第三參數 legend，第 4 參數 BOM；`semanticLegend` 兩個讀取改 legend；所有 `model.getLanguageId() === "basic-plus"` 改 `=== this.languageId`。`update` 加最後參數 `epoch: number`，非 this.epoch 直接 return。一般 invalidate 保留舊 painted tokens；epoch/unavailable 時 dispose 舊 registration/provider，重新註冊才使用新 legend，不能只更新 legend 欄位。原 UTF-16/BOM/overlap tests 改傳 `basicPlusCompanion.legend`，不刪斷言。

新增 pinning test 至 `semantic-tokens.test.ts`，沿用該檔 `model`：

```ts
it("uses the selected legend rather than Basic Plus token ordinals", () => {
  const source = model("name = 1").model;
  const legend = { tokenTypes: ["caseIdentifier", "variable"], tokenModifiers: ["mutable"] };
  expect([
    ...encodeSemanticTokens(
      [
        {
          range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 5 },
          type: "caseIdentifier",
          modifiers: ["mutable"],
        },
      ],
      source,
      legend,
    ),
  ]).toEqual([0, 0, 4, 0, 1]);
});
```

`outline.ts` 只保留 `OutlineItem = LanguageDocumentSymbol` 與純幾何 `outlinePath`，用本地通用 range 比較取代 Basic Plus `contains`。`breadcrumbs.tsx` subscribe result 時呼叫 `analysisTransport.feature(snapshot.analysis,{ kind:"documentSymbols",file })`，捕捉 snapshot identity，回來仍是同一 snapshot 才 `setOutline(result.symbols)`；reset/unavailable 清空。`language-features` documentSymbols 與 breadcrumbs 共用同個 query entry。

`editor-format.ts` 刪 `formatBasicPlus` import，簽名增加 `status: LanguageStatus | undefined`：

```ts
const route = routeLanguage(file, status);
if (route.binding?.capabilities.includes("documentFormatting") && route.companion)
  return route.companion.formatSource(source, indentSize);
if (!/\.json$/i.test(file)) return source;
```

以下 JSON worker block 保留。`app.tsx` 儲存／recovery formatSource call 傳當前 status，捕捉 epoch；異步 JSON formatter 回來若 model/version 或 epoch 已變更就不套用。JSON 本身不因服務 unavailable 而失去格式化。

- [ ] **Step 7: 寫不可用 UI 的失敗測試**

建立 `language-status.test.ts`，沿用現有 editor tests 的 jsdom／React `act` 模式：

```ts
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { LanguageStatusRow } from "./language-status.js";
it.each(["en", "zh-TW"] as const)("shows the reason and settings action in %s", async (locale) => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const openSettings = vi.fn();
  try {
    await act(() =>
      root.render(
        createElement(LanguageStatusRow, {
          locale,
          openSettings,
          status: {
            epoch: 1,
            conflicts: [],
            availability: { kind: "unavailable", reason: "missing", language: "case" },
          },
        }),
      ),
    );
    expect(container.querySelector('[role="status"]')?.textContent).toContain("case");
    expect(container.textContent).toContain(
      locale === "en" ? "Open plugin settings" : "前往插件設定",
    );
    await act(() => container.querySelector("button")!.click());
    expect(openSettings).toHaveBeenCalledOnce();
    await act(() =>
      root.render(
        createElement(LanguageStatusRow, {
          locale,
          openSettings,
          status: {
            epoch: 2,
            conflicts: ["test.one", "test.two"],
            availability: { kind: "unavailable", reason: "conflict", language: "case" },
          },
        }),
      ),
    );
    expect(container.querySelector('[data-workspace-banner="true"]')).not.toBeNull();
    expect(container.textContent).toContain("test.one");
    expect(container.textContent).toContain("test.two");
    // An available provider with an empty diagnostics result is not unavailable.
    await act(() =>
      root.render(
        createElement(LanguageStatusRow, {
          locale,
          openSettings,
          status: {
            epoch: 3,
            conflicts: [],
            availability: {
              kind: "available",
              binding: {
                epoch: 3,
                pluginId: "test.one",
                sourceKey: "builtin:test.one",
                language: "case",
                extensions: ["csx"],
                capabilities: ["analysis"],
                frontend: {
                  language: "case",
                  sourceExtensions: ["csx"],
                  entryExtensions: ["csx"],
                  ir: { min: 1, max: 1 },
                },
              },
            },
          },
        }),
      ),
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
    await act(() =>
      root.render(createElement(LanguageStatusRow, { locale, openSettings, status: undefined })),
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
  } finally {
    await act(() => root.unmount());
  }
});
```

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/language-status.test.ts`

Expected: FAIL（component 尚不存在）。

- [ ] **Step 8: 實作雙語狀態列與 App wiring**

`i18n/copy.ts` 的 en／zh-TW 分別加：

```ts
// en
languageMissing: (language: string) => `No language service is available for this project's language '${language}'.`,
languageConflict: (language: string, plugins: string) => `Language service configuration conflict for '${language}': ${plugins}.`,
languageSettings: "Open plugin settings",
// zh-TW
languageMissing: (language: string) => `此專案的語言 ${language} 沒有可用的語言服務。`,
languageConflict: (language: string, plugins: string) => `語言 ${language} 的語言服務設定衝突：${plugins}。`,
languageSettings: "前往插件設定",
```

`language-status.tsx`：

```tsx
import { copy, type Locale } from "../i18n/copy.js";
import type { LanguageStatus } from "../../shared/language-services.js";
export function LanguageStatusRow({
  status,
  locale,
  openSettings,
}: {
  status: LanguageStatus | undefined;
  locale: Locale;
  openSettings(): void;
}) {
  if (status?.availability.kind !== "unavailable") return null;
  const { reason, language } = status.availability;
  const t = copy[locale];
  return (
    <div
      className="file-change-banner"
      role="status"
      data-workspace-banner={reason === "conflict" ? "true" : undefined}
    >
      <span>
        {reason === "missing"
          ? t.languageMissing(language)
          : t.languageConflict(language, status.conflicts.join(", "))}
      </span>
      <button onClick={openSettings}>{t.languageSettings}</button>
    </div>
  );
}
```

`app.tsx` 加 imports `createLanguageStatusStore`、`BUILTIN_LANGUAGE_COMPANIONS`、`bindingKey`、`LanguageStatusRow`，React import 加 `useSyncExternalStore`。在現有 completionSession 區段前加入：

```tsx
const languageStatusStore = useMemo(
  () => createLanguageStatusStore(window.kobrixa.language, report),
  [],
);
const languageStatus = useSyncExternalStore(
  languageStatusStore.subscribe,
  languageStatusStore.getSnapshot,
);
useLayoutEffect(() => {
  languageStatusStore.configure(workspace?.id);
}, [languageStatusStore, workspace?.id]);
useEffect(() => () => languageStatusStore.dispose(), [languageStatusStore]);
const languageBinding =
  languageStatus?.availability.kind === "available"
    ? languageStatus.availability.binding
    : undefined;
const languageCompanion = languageBinding
  ? BUILTIN_LANGUAGE_COMPANIONS[bindingKey(languageBinding)]
  : undefined;
```

AnalysisTransport 現有三個 callback 後依序加：

```ts
(workspaceId, request) => window.kobrixa.language.feature(workspaceId, request),
(workspaceId, requestId) => window.kobrixa.language.cancelFeature(workspaceId, requestId),
(workspaceId) => window.kobrixa.language.status(workspaceId, true),
```

AnalysisSession callbacks 加：

```ts
unavailable: () => {
  if (sessions.active?.documents === documents) setLiveDiagnostics([]);
},
```

現有只傳 workspace 的 `useLayoutEffect` 整段替換：

```tsx
useLayoutEffect(() => {
  if (workspace && languageStatus) analysisTransport.configure(workspace.id, languageStatus.epoch);
  analysisSession.configure(workspace, languageStatus);
  completionSession.configure(workspace, languageStatus, languageCompanion);
}, [
  analysisTransport,
  analysisSession,
  completionSession,
  workspace,
  languageStatus,
  languageCompanion,
]);
useLayoutEffect(() => {
  setLiveDiagnostics([]);
}, [workspace?.id, languageStatus?.epoch]);
```

`CompletionSession` constructor 在原 sync callback 後加 `private readonly refreshStatus: (workspaceId: string) => Promise<LanguageStatus>`；App 建立 CompletionSession 時傳 `(workspaceId) => window.kobrixa.language.status(workspaceId, true)` 作第二參數，resync 使用此 callback。測試傳有明確 binding 的 `async () => status` fixture，不能使用 production 的 Basic Plus fallback。

available→unavailable 由上述 configure 清 feature snapshots、tokens、Quick Fix actions 與 completion cache，build diagnostics 維持原建置結果歸屬。unavailable→available 自動 schedule，不能等下一個 keystroke。`languageStatus` 使用獨立名稱，避免覆蓋 App 既有的字串 `status`／`setStatus`。

missing row 放在原 `editor-stage`、file-change-banner 前；conflict row 放在包住整個工作區的區域、editor-simulation-layout 外且 settings 仍可操作。避免 split editor 重複兩次橫幅。兩個位置共用 `LanguageStatusRow` 並以 reason 決定只 render 一處。動作沿用現有插件橫幅的程式：

```tsx
openSettings={() => {
  setSettingsCategory((previous) => ({ category: "plugins", request: previous.request + 1 }));
  setSettingsOpen(true);
  setSettingsActive(true);
}}
```

傳 status 給兩個 Editor panes；Editor 的 effect 依 status.epoch 建立／dispose LanguageFeatures 與 LanguageSemanticTokens。`registerBasicPlusLanguage()` 僅呼叫一次；unavailable 不撤銷 Monaco lexical registration。

- [ ] **Step 9: 加入匯入邊界測試**

建立 `language-imports.test.ts`；使用 TypeScript parser 檢查靜態 import、export-from、dynamic import 與 import type，避免只用 grep 漏掉型別：

```ts
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
const root = fileURLToPath(new URL("../../", import.meta.url));
async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? files(path.join(directory, entry.name))
          : Promise.resolve([path.join(directory, entry.name)]),
      ),
    )
  ).flat();
}
it("keeps Basic Plus imports inside the browser companion and worker adapters", async () => {
  const violations: string[] = [];
  for (const file of [
    ...(await files(path.join(root, "renderer"))),
    ...(await files(path.join(root, "shared"))),
  ]) {
    if (
      !/\.tsx?$/.test(file) ||
      file.includes("/companions/basic-plus/") ||
      /\.test\.tsx?$/.test(file)
    )
      continue;
    const source = ts.createSourceFile(
      file,
      await readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) && /^@kobrixa\/basic-plus(?:\/|$)/.test(node.text))
        violations.push(file);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
});
```

測試檔的 Basic Plus imports 是 fixture producer，允許；生產 generic code 包含 editor／outline／diagnostic presentation／workbench 的 type imports 都禁止。`basic-plus-language.ts`、`basic-plus-formatting.ts` 只能 re-export companion，不直接匯入 package。

- [ ] **Step 10: 更新現有 fixtures 並確認全部 renderer 回歸 PASS**

現有 fixture 的精確調整：

- `language-features.test.ts setup(sources)`：仍使用真 `analyzeBasicPlusProject` 來源，透過 `basicPlusAnalysis(raw)` 轉 DTO、`stampDiagnostics` 加註；snapshot 加 epoch／binding；`query` fake 直接呼叫 `basicPlusLanguageService.createAnalysis()` 同一 raw project session 的 query，回 `{ kind:"result",epoch:1,result }`。quickFixes fake 改用 provider.quickFixes，所有既有 completion、rename、hover、signature、read-only、BOM、stale tests 保留。
- `completion-session.test.ts reply(request,documents)`：回 request.epoch；`known` symbol 改 `{ id:"known",name:"known",kind:"variable",signature:"global number known",labels:[{text:"known",detail:"global number known"}],group:"main.bp",shadowKey:"value:known" }`；configure 傳 available binding／basicPlusCompanion。保留連續輸入 50/150 ms、model replacement、512 history 上限測試。
- `analysis-session.test.ts` 使用 Step 4 已定義的 `analysisStatus`／`result(epoch)` 與遷移後 `harness()`，保留原兩項回歸測試。
- `analysis-transport.test.ts server()` 回 epoch；transport.configure 先於 analyze，assert 改讀 outcome.analysis；保留取消後 delta、未知錯誤 full sync、query cancellation，新增把舊 epoch unavailable 延後 resolve 的測試，斷言新 result 的 WeakMap identity 可繼續取 fixes。
- `editor.test.ts mocks` 加所有 registration dispose handles、`setModelLanguage` mock；新增 `status` props，render unavailable 後斷言 marker 清空、model.setValue 未增加呼叫次數、registrations disposed；恢復 available 後重新 attach；再 render `file:"kobrixa.json"` 驗證沒有該 model 的 dynamic requests。
- `outline.test.ts` 的 provider-specific tree construction 轉測 `basicPlusOutline`，`outlinePath` 仍用通用 tree 測；`diagnostic-details.test.ts` snapshot 加 binding capability，第三方同碼 source 不符合綁定時仍不問 fix。

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/shared src/main/language src/renderer/editor src/renderer/workbench
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop check
```

Expected: PASS；此步第一次要求整個 desktop type check 通過，不以 type assertions 把 native symbols 假裝成通用 DTO。

- [ ] **Step 11: 格式化、lint 與 commit**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --write apps/desktop/src/renderer/editor apps/desktop/src/renderer/app.tsx apps/desktop/src/renderer/i18n/copy.ts apps/desktop/src/renderer/workbench/diagnostic-details.tsx apps/desktop/src/renderer/workbench/diagnostic-details.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --check apps/desktop/src/renderer/editor apps/desktop/src/renderer/app.tsx apps/desktop/src/renderer/i18n/copy.ts apps/desktop/src/renderer/workbench/diagnostic-details.tsx apps/desktop/src/renderer/workbench/diagnostic-details.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec eslint apps/desktop/src/renderer/editor apps/desktop/src/renderer/app.tsx apps/desktop/src/renderer/i18n/copy.ts apps/desktop/src/renderer/workbench/diagnostic-details.tsx apps/desktop/src/renderer/workbench/diagnostic-details.test.ts
git add apps/desktop/src/renderer/editor/language-routing.ts apps/desktop/src/renderer/editor/language-routing.test.ts apps/desktop/src/renderer/editor/language-status-store.ts apps/desktop/src/renderer/editor/language-status-store.test.ts apps/desktop/src/renderer/editor/language-status.tsx apps/desktop/src/renderer/editor/language-status.test.ts apps/desktop/src/renderer/editor/language-imports.test.ts apps/desktop/src/renderer/editor/editor.tsx apps/desktop/src/renderer/editor/language-features.ts apps/desktop/src/renderer/editor/semantic-tokens.ts apps/desktop/src/renderer/editor/completion-cache.ts apps/desktop/src/renderer/editor/completion-session.ts apps/desktop/src/renderer/editor/editor-format.ts apps/desktop/src/renderer/editor/analysis-session.ts apps/desktop/src/renderer/editor/analysis-transport.ts apps/desktop/src/renderer/editor/outline.ts apps/desktop/src/renderer/editor/breadcrumbs.tsx apps/desktop/src/renderer/editor/editor.test.ts apps/desktop/src/renderer/editor/language-features.test.ts apps/desktop/src/renderer/editor/semantic-tokens.test.ts apps/desktop/src/renderer/editor/completion-cache.test.ts apps/desktop/src/renderer/editor/completion-session.test.ts apps/desktop/src/renderer/editor/analysis-session.test.ts apps/desktop/src/renderer/editor/analysis-transport.test.ts apps/desktop/src/renderer/editor/outline.test.ts apps/desktop/src/renderer/app.tsx apps/desktop/src/renderer/i18n/copy.ts apps/desktop/src/renderer/workbench/diagnostic-details.tsx apps/desktop/src/renderer/workbench/diagnostic-details.test.ts
git commit -m "feat(editor): route Monaco features by language binding and show service availability"
```

---

### Task 7: 第二語言 fixture、競態／效能回歸與文件

**Files:**

- Create: `apps/desktop/src/main/language/testing/second-language.ts`、`apps/desktop/src/main/language/language-provider.integration.test.ts`
- Modify: `apps/desktop/src/main/language/language.test.ts`、`apps/desktop/src/main/language/basic-plus-service.test.ts`、`apps/desktop/src/renderer/editor/analysis-transport.test.ts`、`apps/desktop/src/renderer/editor/completion-cache.test.ts`、`apps/desktop/src/renderer/editor/completion-session.test.ts`
- Modify: `docs/en/architecture.md`、`docs/zh-TW/architecture.md`、`plugins/samples/README.md`、`sdks/python/README.md`
- Read/Run: `tests/desktop/completion-performance-smoke.mjs`、`tests/desktop/language-features-smoke.mjs`、`tests/desktop/indentation-smoke.mjs`、`tests/desktop/highlighting-smoke.mjs`、`tests/desktop/run-smoke.mjs`（門檻不改）

**Interfaces:**

- Consumes: 前六個 task 的宣告、resolver、epoch、factory／companion、worker 與 renderer 通用契約。
- Produces: 測試專用 `SECOND_MANIFEST`、`secondBinding(epoch: number): LanguageBinding`、`secondLanguageService: LanguageServiceFactory`；只由測試 entry/import 使用，正式兩張 builtin tables 不註冊第二語言。
- 第二語言為 `case`，副檔名 `csx`／`csi`，名稱大小寫敏感，legend `caseIdentifier`／`mutable`，診斷碼 `BP1043`，source 應為 `test.case`。沒有 backend 宣告。

- [ ] **Step 1: 寫第二語言整合的失敗測試**

建立 `language-provider.integration.test.ts`；fixture code 在 Step 3，測試先落地所以先 RED：

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, afterEach, expect, it } from "vitest";
import {
  readSource,
  resolvePlugins,
  resolveFrontendProvider,
  resolveCompilerProviders,
} from "@kobrixa/plugin-runtime";
import { applyAnalysis } from "../../shared/language-sync.js";
import { LanguageWorkerSession } from "./language-worker-session.js";
import {
  SECOND_MANIFEST,
  secondBinding,
  secondLanguageService,
} from "./testing/second-language.js";
import type { DiagnosticsRequest, QuickFixWorkerRequest } from "./language-protocol.js";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-second-language-"));
  await writeFile(
    path.join(root, "kobrixa.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "case",
      language: "case",
      target: "absent",
      entry: "main.csx",
      assets: [],
      outputDir: "out",
    }),
  );
  await writeFile(path.join(root, "main.csx"), "Foo foo !\n");
});
afterEach(() => rm(root, { recursive: true, force: true }));
it("isolates case-sensitive symbols, legends and overlapping diagnostic codes", async () => {
  const read = await readSource(
    { kind: "builtin", manifest: SECOND_MANIFEST },
    { safeMode: false },
  );
  const plugins = resolvePlugins([read], { safeMode: false, disabled: new Set() });
  expect(resolveFrontendProvider(plugins, "case").ok).toBe(true);
  expect(resolveCompilerProviders(plugins, "case", "absent").ok).toBe(false);
  const worker = new LanguageWorkerSession({ "test.case:case": secondLanguageService });
  try {
    const request: DiagnosticsRequest = {
      id: 1,
      workspaceId: "w",
      binding: secondBinding(1),
      cancellation: new SharedArrayBuffer(4),
      input: { inputPath: root },
      sync: {
        epoch: 1,
        session: "case",
        revision: 1,
        baseRevision: null,
        analysisBase: null,
        overlays: { set: {}, removed: [] },
      },
    };
    const reply = await worker.sync(request);
    if (reply.kind !== "result") throw new Error("Expected analysis");
    const result = applyAnalysis(undefined, reply.patch).analysis;
    expect(Object.values(result.index.symbols).map((symbol) => symbol.name)).toEqual([
      "Foo",
      "foo",
    ]);
    expect(result.tokensByFile["main.csx"]!.map((token) => token.type)).toEqual([
      "caseIdentifier",
      "caseIdentifier",
    ]);
    const diagnostic = result.diagnostics[0]!;
    expect(diagnostic).toMatchObject({ code: "BP1043", source: "test.case" });
    const query: QuickFixWorkerRequest = {
      kind: "quick-fixes",
      id: 2,
      workspaceId: "w",
      cancellation: new SharedArrayBuffer(4),
      request: {
        epoch: 1,
        requestId: "fix",
        session: "case",
        revision: 1,
        analysisVersion: reply.patch.version,
        file: "main.csx",
        diagnostic,
      },
    };
    expect(worker.quickFixes(query)).toMatchObject({
      kind: "result",
      fixes: [{ id: "case.remove-bang", title: { en: "Remove !" } }],
    });
    expect(
      worker.quickFixes({
        ...query,
        request: { ...query.request, diagnostic: { ...diagnostic, source: "kobrixa.basic-plus" } },
      }),
    ).toMatchObject({ kind: "stale" });
    expect(worker.quickFixes({ ...query, request: { ...query.request, epoch: 2 } })).toMatchObject({
      kind: "stale",
    });
    const next = await worker.sync({
      ...request,
      id: 3,
      binding: secondBinding(2),
      sync: { ...request.sync, epoch: 2, revision: 2 },
    });
    expect(next).toMatchObject({ kind: "result", epoch: 2, patch: { base: null } });
    expect(worker.quickFixes(query)).toMatchObject({ kind: "stale" });
  } finally {
    worker.dispose();
  }
});
it("returns no fixes when the selected declaration omits quickFixes", async () => {
  const worker = new LanguageWorkerSession({ "test.case:case": secondLanguageService });
  const binding = { ...secondBinding(1), capabilities: ["analysis" as const] };
  try {
    const reply = await worker.sync({
      id: 1,
      workspaceId: "w",
      binding,
      cancellation: new SharedArrayBuffer(4),
      input: { inputPath: root },
      sync: {
        epoch: 1,
        session: "s",
        revision: 1,
        baseRevision: null,
        analysisBase: null,
        overlays: { set: {}, removed: [] },
      },
    });
    if (reply.kind !== "result") throw new Error("Expected analysis");
    const diagnostic = applyAnalysis(undefined, reply.patch).analysis.diagnostics[0]!;
    expect(
      worker.quickFixes({
        kind: "quick-fixes",
        id: 2,
        workspaceId: "w",
        cancellation: new SharedArrayBuffer(4),
        request: {
          epoch: 1,
          requestId: "r",
          session: "s",
          revision: 1,
          analysisVersion: reply.patch.version,
          file: "main.csx",
          diagnostic,
        },
      }),
    ).toEqual({ kind: "result", epoch: 1, fixes: [] });
  } finally {
    worker.dispose();
  }
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/language/language-provider.integration.test.ts`

Expected: FAIL（第二語言 fixture module 不存在）。

- [ ] **Step 3: 實作最小但真正不同的測試提供者**

建立 `testing/second-language.ts`：

```ts
import type { SourceProject, SourceRange } from "@kobrixa/compiler";
import type { PluginManifest } from "@kobrixa/plugin-protocol";
import type { LanguageBinding } from "../../../shared/language-services.js";
import type { LanguageFeatureResult } from "../../../shared/language-query.js";
import { emptyLanguageIndex, type SemanticLegend } from "../../../shared/language-types.js";
import type { LanguageServiceFactory, ProviderAnalysis } from "../language-provider.js";
export const SECOND_LEGEND: SemanticLegend = {
  tokenTypes: ["caseIdentifier"],
  tokenModifiers: ["mutable"],
};
export const SECOND_MANIFEST: PluginManifest = {
  id: "test.case",
  version: "1.0.0",
  apiVersion: "^1.3.0",
  runtime: { kind: "builtin" },
  contributes: {
    frontends: [
      {
        language: "case",
        entryExtensions: ["csx"],
        sourceExtensions: ["csx", "csi"],
        ir: { min: 1, max: 1 },
      },
    ],
    languageServices: [
      {
        language: "case",
        extensions: ["csx", "csi"],
        capabilities: [
          "analysis",
          "completion",
          "quickFixes",
          "semanticTokens",
          "hover",
          "definition",
          "references",
          "documentSymbols",
        ],
      },
    ],
  },
};
export function secondBinding(epoch: number): LanguageBinding {
  const declaration = SECOND_MANIFEST.contributes!.languageServices![0]!;
  return {
    epoch,
    pluginId: SECOND_MANIFEST.id,
    sourceKey: "builtin:test.case",
    language: "case",
    extensions: [...declaration.extensions],
    capabilities: [...declaration.capabilities],
    frontend: structuredClone(SECOND_MANIFEST.contributes!.frontends![0]!),
  };
}
function analyze(project: SourceProject): ProviderAnalysis {
  const result: ProviderAnalysis = {
    diagnostics: [],
    index: emptyLanguageIndex(),
    tokensByFile: {},
  };
  for (const source of project.sources) {
    result.index.sources[source.path] = source.content;
    result.index.fileContexts[source.path] = source.path;
    result.index.contextFiles[source.path] = [source.path];
    result.tokensByFile[source.path] = [];
    result.index.occurrencesByFile[source.path] = [];
    source.content.split("\n").forEach((line, offset) => {
      const range = (start: number, length: number): SourceRange => ({
        startLine: offset + 1,
        endLine: offset + 1,
        startColumn: start + 1,
        endColumn: start + length + 1,
      });
      for (const match of line.matchAll(/[A-Za-z][A-Za-z0-9_]*/g)) {
        const name = match[0],
          id = `${source.path}:${name}`,
          at = range(match.index, name.length);
        const declaration = !Object.hasOwn(result.index.symbols, id);
        result.index.symbols[id] ??= {
          id,
          name,
          kind: "variable",
          signature: `case ${name}`,
          group: source.path,
          shadowKey: name,
          labels: [{ text: name, detail: `case ${name}` }],
          location: { file: source.path, range: at },
        };
        result.tokensByFile[source.path]!.push({
          range: at,
          type: "caseIdentifier",
          modifiers: ["mutable"],
        });
        result.index.occurrencesByFile[source.path]!.push({
          file: source.path,
          range: at,
          symbolId: id,
          context: source.path,
          declaration,
        });
      }
      const bang = line.indexOf("!");
      if (bang >= 0)
        result.diagnostics.push({
          code: "BP1043",
          severity: "error",
          file: source.path,
          message: "Exclamation marks are forbidden in Case.",
          range: range(bang, 1),
        });
    });
  }
  return result;
}
export const secondLanguageService: LanguageServiceFactory = {
  capabilities: SECOND_MANIFEST.contributes!.languageServices![0]!.capabilities,
  createAnalysis() {
    const history = new Map<number, ProviderAnalysis>();
    const get = (version: number) => {
      const result = history.get(version);
      if (!result) throw new Error("Analysis expired.");
      return result;
    };
    return {
      analyze(project, version, signal) {
        signal.throwIfAborted();
        const result = analyze(project);
        history.set(version, result);
        while (history.size > 2) history.delete(history.keys().next().value!);
        return result;
      },
      query(version, query, signal): LanguageFeatureResult {
        signal.throwIfAborted();
        const result = get(version);
        const occurrence =
          "line" in query
            ? result.index.occurrencesByFile[query.file]?.find(
                (o) =>
                  o.range.startLine === query.line &&
                  o.range.startColumn <= query.column &&
                  query.column < o.range.endColumn,
              )
            : undefined;
        const symbol = occurrence && result.index.symbols[occurrence.symbolId];
        switch (query.kind) {
          case "hover":
            return {
              kind: query.kind,
              value:
                symbol && occurrence
                  ? { range: occurrence.range, contents: [symbol.signature] }
                  : null,
            };
          case "definition":
            return { kind: query.kind, locations: symbol?.location ? [symbol.location] : [] };
          case "references":
            return {
              kind: query.kind,
              locations: Object.values(result.index.occurrencesByFile)
                .flat()
                .filter(
                  (o) => o.symbolId === symbol?.id && (query.includeDeclaration || !o.declaration),
                ),
            };
          case "documentSymbols":
            return {
              kind: query.kind,
              symbols: Object.values(result.index.symbols)
                .filter((s) => s.location?.file === query.file)
                .map((s) => ({
                  name: s.name,
                  detail: s.signature,
                  kind: s.kind,
                  range: s.location!.range,
                  selectionRange: s.location!.range,
                  children: [],
                })),
            };
          case "signatureHelp":
            return { kind: query.kind, value: null };
          case "renameLocation":
            return {
              kind: query.kind,
              text: "",
              rejectReason: "Case fixture does not support rename.",
            };
          case "rename":
            return {
              kind: query.kind,
              edits: [],
              rejectReason: "Case fixture does not support rename.",
            };
        }
      },
      quickFixes(version, file, diagnostic, signal) {
        signal.throwIfAborted();
        get(version);
        if (diagnostic.code !== "BP1043" || diagnostic.file !== file) return [];
        return [
          {
            id: "case.remove-bang",
            title: { en: "Remove !", "zh-TW": "移除 !" },
            edits: [{ range: diagnostic.range, newText: "" }],
          },
        ];
      },
      dispose() {
        history.clear();
      },
    };
  },
  createCompletion() {
    return {
      analyze(project, signal) {
        signal.throwIfAborted();
        const { index } = analyze(project);
        return {
          symbols: index.symbols,
          scopes: index.scopes,
          fileContexts: index.fileContexts,
          contextFiles: index.contextFiles,
          guardsByFile: {},
        };
      },
      dispose() {},
    };
  },
};
```

此 fixture 有真正不同的大小寫、tokens 及修正；不能只回空 analysis，否則無法證明泛化成功。

- [ ] **Step 4: Pin in-flight provider switch、completion case 與增量等價**

`analysis-transport.test.ts` 加完整反序回覆測試，兩次 provider 的 analysis 使用不同 source；使用現有 `diffAnalysis`／`emptyAnalysis`，不引用未定義 deferred helper：

```ts
it("rejects an in-flight old provider after a new provider publishes", async () => {
  const pending: Array<{
    request: LanguageSyncRequest;
    resolve: (reply: LanguageSyncReply) => void;
  }> = [];
  const sync = vi.fn(
    (_workspace: string, request: LanguageSyncRequest) =>
      new Promise<LanguageSyncReply>((resolve) => pending.push({ request, resolve })),
  );
  const transport = new AnalysisTransport(sync);
  transport.configure("w", 1);
  const old = transport.analyze("w", { "main.bp": "LCD.Clear(\n" });
  const rejected = expect(old).rejects.toThrow("cancelled");
  transport.configure("w", 2);
  const next = transport.analyze("w", { "main.csx": "Foo foo" });
  const analysis = emptyAnalysis();
  analysis.index.sources["main.csx"] = "Foo foo";
  const second = pending[1]!;
  second.resolve({
    kind: "result",
    epoch: 2,
    session: second.request.session,
    revision: second.request.revision,
    patch: diffAnalysis(undefined, analysis, null, 2),
  });
  expect(await next).toMatchObject({ kind: "result", epoch: 2, analysis });
  pending[0]!.resolve({ kind: "unavailable", epoch: 1, reason: "missing", language: "bp" });
  await rejected;
  const third = transport.analyze("w", { "main.csx": "Foo foo" });
  expect(pending[2]!.request.analysisBase).toBe(2);
  pending[2]!.resolve({
    kind: "result",
    epoch: 2,
    session: pending[2]!.request.session,
    revision: pending[2]!.request.revision,
    patch: diffAnalysis(analysis, analysis, 2, 3),
  });
  expect(await third).toMatchObject({ kind: "result", epoch: 2 });
});
```

在 `completion-cache.test.ts` import `CompletionCache` 並加入，model 是本測試定義的最小 decoration adapter：

```ts
it("does not fold another provider's case-sensitive shadow keys", () => {
  const cache = new CompletionCache();
  const symbols = Object.fromEntries(
    ["Foo", "foo"].map((name) => [
      name,
      {
        id: name,
        name,
        kind: "variable" as const,
        signature: name,
        labels: [{ text: name, detail: name }],
        group: "case",
        shadowKey: name,
      },
    ]),
  );
  cache.update(
    {
      symbols,
      scopes: [],
      fileContexts: { "main.csx": "case" },
      contextFiles: { case: ["main.csx"] },
      guardsByFile: {},
    },
    2,
  );
  const model = {
    deltaDecorations: () => [],
    isDisposed: () => false,
    getDecorationRange: () => null,
  } as unknown as editor.ITextModel;
  expect(cache.attach("main.csx", model, [])).toBe(true);
  const position = { lineNumber: 1, column: 1 } as import("monaco-editor").Position;
  expect(cache.symbols("main.csx", position, 2)?.map((s) => s.name)).toEqual(["Foo", "foo"]);
  expect(cache.symbols("main.csx", position, 1)).toBeUndefined();
  cache.clear();
});
```

`basic-plus-service.test.ts` 使用該 task 已定義的 `project`、`signal`，加入：

```ts
it("matches fresh analysis after incremental dependency and UTF-16 edits", () => {
  const incremental = basicPlusLanguageService.createAnalysis();
  try {
    let version = 0;
    for (const text of [
      'Include "config"\nImport "helper"\nresult = Double(shared)\n',
      '\uFEFF\' 中文😀\r\nInclude "config"\r\nresult = shared\r\n',
      'Include "config"\nshared = 7\nLCD.Clear(\n',
    ]) {
      const next = {
        ...project,
        sources: project.sources.map((source) =>
          source.path === "main.bp" ? { ...source, content: text } : source,
        ),
      };
      const fresh = basicPlusLanguageService.createAnalysis();
      try {
        expect(incremental.analyze(next, ++version, signal)).toEqual(
          fresh.analyze(next, version, signal),
        );
      } finally {
        fresh.dispose();
      }
    }
  } finally {
    incremental.dispose();
  }
});
```

Run: `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/language/language-provider.integration.test.ts src/main/language/basic-plus-service.test.ts src/renderer/editor/analysis-transport.test.ts src/renderer/editor/completion-cache.test.ts src/renderer/editor/completion-session.test.ts`

Expected: PASS；若 case test 失敗，修 generic cache 的 group/shadowKey，不能在第二語言 fixture 轉成小寫。

- [ ] **Step 5: 加真 worker 第二語言與不掃磁碟回歸**

沿用 `language.test.ts` 既有 esbuild `stdin` 注入模式，在 beforeAll 加一份 `second-worker.cjs`（只存在 temp workerRoot）；輸入如下：

```ts
await build({
  stdin: {
    resolveDir: path.dirname(fileURLToPath(import.meta.url)),
    contents: `
    import { BUILTIN_LANGUAGE_SERVICES } from "../workspace/builtin-language-services.ts";
    import { secondLanguageService } from "./testing/second-language.ts";
    Object.assign(BUILTIN_LANGUAGE_SERVICES, { "test.case:case": secondLanguageService });
    void import("./language-worker.ts");
  `,
  },
  outfile: path.join(workerRoot, "second-worker.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
});
```

CommonJS bundle 以 dynamic import 在測試表注入後啟動 worker，沒有 top-level await。測試直接 `new Worker(..., { workerData: { completion:true }, execArgv:[] })`，向 completion worker 傳 `secondBinding`；不修改正式 factory 表。加入：

```ts
it("loads the second frontend once and keeps completion disk reads behind refresh", async () => {
  await writeFile(
    path.join(root, "kobrixa.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "case",
      language: "case",
      target: "absent",
      entry: "main.csx",
      assets: [],
      outputDir: "out",
    }),
  );
  await writeFile(path.join(root, "main.csx"), "Foo foo");
  const worker = new Worker(path.join(workerRoot, "second-worker.cjs"), {
    execArgv: [],
    workerData: { completion: true },
  });
  workers.push(worker);
  let id = 0;
  const send = (request: CompletionSyncRequest) =>
    new Promise<CompletionWorkerReply>((resolve) => {
      const nextId = ++id;
      const listener = (reply: CompletionWorkerReply) => {
        if (reply.id !== nextId) return;
        worker.off("message", listener);
        resolve(reply);
      };
      worker.on("message", listener);
      worker.postMessage({
        id: nextId,
        workspaceId: "case",
        input: { inputPath: root },
        binding: secondBinding(1),
        cancellation: new SharedArrayBuffer(4),
        request,
      });
    });
  const first = await send({
    epoch: 1,
    session: "case",
    revision: 1,
    baseRevision: null,
    refresh: true,
    updates: [],
  });
  expect(first).toMatchObject({ ok: true, reply: { kind: "result" } });
  await writeFile(path.join(root, "new.csi"), "DiskOnly");
  const second = await send({
    epoch: 1,
    session: "case",
    revision: 2,
    baseRevision: 1,
    refresh: false,
    updates: [],
  });
  if (!second.ok || second.reply.kind !== "result") throw new Error("Expected completion");
  expect(Object.values(second.reply.index.symbols).map((s) => s.name)).toEqual(["Foo", "foo"]);
  const third = await send({
    epoch: 1,
    session: "case",
    revision: 3,
    baseRevision: 2,
    refresh: true,
    updates: [],
  });
  if (!third.ok || third.reply.kind !== "result") throw new Error("Expected refresh");
  expect(Object.values(third.reply.index.symbols).map((s) => s.name)).toContain("DiskOnly");
});
```

加 `secondBinding` 與 `CompletionWorkerReply` imports。沿用 afterEach 的 worker terminate 與 rm，不留下測試 registry 入口。

- [ ] **Step 6: 更新四份文件的實際文字**

`docs/en/architecture.md` 原 API 1.2.0 compiler paragraph 改版本 1.3.0，並將「Language analysis providers ... remain planned」段替換為：

```markdown
Plugin API **1.3.0** adds `contributes.languageServices`. Only built-in plugins may declare it, including an empty array; development plugins receive `PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN`. The declaration must include `analysis`, match a frontend owned by the same plugin, and use exactly that frontend's source extensions. A plugin may declare at most eight services. Valid API 1.0, 1.1 and 1.2 plugins remain compatible.

The main process selects the enabled frontend owner for the validated project's language, independently of backend availability and IR compatibility. Its `pluginId:language` key selects a compiled-in worker factory and browser companion. Each workspace has independent analysis/Quick Fix and completion workers. All messages and accepted results carry a host-issued binding epoch; provider generation, routing changes or either worker restarting invalidates both channels and requires a full sync. Ordinary typing changes document revisions only.

Workers retain native semantic state and publish provider-neutral symbols, packed tokens and occurrences, completion visibility groups, and editor results. The host stamps diagnostic sources. Basic Plus completion filtering, structural edit checks and formatting live in its browser companion; generic renderer and shared modules do not import Basic Plus. Missing services show a language status row; configuration conflicts show a workspace banner naming the plugins. Both link to plugin settings. Built-in plugins remain required. Static language contributions are reserved for 2C; external language-service RPC is not implemented.
```

`docs/zh-TW/architecture.md` 對應段落：

```markdown
插件 API **1.3.0** 新增 `contributes.languageServices`。只有內建插件可宣告，空陣列也受限制；開發插件會收到 `PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN`。宣告必須包含 `analysis`，由同插件的 frontend 擁有該語言，且副檔名集合必須與該 frontend 的 `sourceExtensions` 完全相同。每插件最多八筆服務。有效的 API 1.0、1.1、1.2 插件仍相容。

main 依通過驗證的專案語言選取啟用中的 frontend 擁有者，backend 缺席或 IR 不相容不影響編輯器分析。以 `pluginId:language` 選取編譯期內建 worker factory 與 browser companion；每工作區保留獨立的分析／Quick Fix 和補全 worker。所有訊息及已接受結果都帶宿主發放的 binding epoch；提供者 generation、路由設定或任一 worker 重啟都讓兩條通道失效並要求完整同步，一般輸入只改文件 revision。

worker 保留原生語意狀態，只發布通用符號、緊湊 tokens／occurrences、補全可見性群組與編輯結果；診斷來源由宿主加註。Basic Plus 的即時補全過濾、結構性編輯偵測與格式化留在 browser companion，通用 renderer／shared 不匯入 Basic Plus。缺少服務顯示語言狀態列，設定衝突顯示列出插件的工作區橫幅，兩者皆可前往插件設定。內建插件仍不可停用；靜態語言貢獻留待 2C，沒有第三方語言服務 RPC。
```

`plugins/samples/README.md` 加「Language services / 語言服務」小節，貼入規格 §2 的完整 `bp` JSON 宣告（Task 1 已列出精確內容），並加：

```markdown
`languageServices` is a built-in-only API 1.3.0 contribution. Do not add it to the development samples, even as `[]`. Structural schema validation is shared with Python; the host additionally validates uniqueness, required `analysis`, frontend ownership, extension-set equality and trusted source. A declaration contains no implementation path. The runtime resolves frontend conflicts before deciding whether a service is missing. Built-in factory capabilities must cover every declared capability; a mismatch makes the language unavailable without changing the plugin's status.

`languageServices` 僅供 API 1.3.0 的內建插件使用，請勿加到開發插件範例，空陣列也不允許。Python 共用結構 schema；唯一性、必要的 `analysis`、frontend 擁有者、副檔名集合相等及可信來源由宿主另行驗證。宣告沒有實作路徑。runtime 先判定 frontend 衝突再判定缺少服務；工廠能力不足會讓語言不可用，但不改變插件本身狀態。
```

`sdks/python/README.md` API 版本敘述改為 1.3.0 並加：

```markdown
API 1.3.0 includes the structural `languageServices` manifest schema for parity with the host. Python development plugins cannot provide language services; declaring the field, including an empty array, produces `PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN`. This release does not add language-service RPC methods. Registry-only checks are separate from JSON Schema validation.

API 1.3.0 隨附 `languageServices` 的結構 schema，供跨語言驗證一致性使用；Python 開發插件不能提供語言服務，宣告欄位（含空陣列）會收到 `PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN`。此版本沒有新增語言服務 RPC，registry 語意檢查與 JSON Schema 驗證分開執行。
```

- [ ] **Step 7: 執行回歸與效能 smoke，記錄環境限制**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/language src/renderer/editor src/shared
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop check
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm test:desktop:smoke
```

Expected: 單元／整合 tests 與 type check PASS；smoke 的 completion path 使用現有 `checkCompletionPerformance`，熱補全 p95 ≤100 ms、新變數 ≤200 ms、30,000 行 ≤300 ms，不調高門檻。`completion-performance-smoke.mjs` 是 runner 匯入的模組，不能單獨 `node` 該檔假裝已跑測試。本機無法跑完整 Electron smoke 時，將其列為人工驗收，記錄失敗命令與真正錯誤，不宣稱效能已驗證。

- [ ] **Step 8: 格式化、lint 與 commit**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec prettier --write apps/desktop/src/main/language/testing/second-language.ts apps/desktop/src/main/language/language-provider.integration.test.ts apps/desktop/src/main/language/language.test.ts apps/desktop/src/main/language/basic-plus-service.test.ts apps/desktop/src/renderer/editor/analysis-transport.test.ts apps/desktop/src/renderer/editor/completion-cache.test.ts apps/desktop/src/renderer/editor/completion-session.test.ts docs/en/architecture.md docs/zh-TW/architecture.md plugins/samples/README.md sdks/python/README.md
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec eslint apps/desktop/src/main/language/testing/second-language.ts apps/desktop/src/main/language/language-provider.integration.test.ts apps/desktop/src/main/language/language.test.ts apps/desktop/src/main/language/basic-plus-service.test.ts apps/desktop/src/renderer/editor/analysis-transport.test.ts apps/desktop/src/renderer/editor/completion-cache.test.ts apps/desktop/src/renderer/editor/completion-session.test.ts
git add apps/desktop/src/main/language/testing/second-language.ts apps/desktop/src/main/language/language-provider.integration.test.ts apps/desktop/src/main/language/language.test.ts apps/desktop/src/main/language/basic-plus-service.test.ts apps/desktop/src/renderer/editor/analysis-transport.test.ts apps/desktop/src/renderer/editor/completion-cache.test.ts apps/desktop/src/renderer/editor/completion-session.test.ts docs/en/architecture.md docs/zh-TW/architecture.md plugins/samples/README.md sdks/python/README.md
git commit -m "test(language): verify a second provider and document language service contracts"
```

---

## Spec 對照

| Spec                                                                                    | 實作／驗證位置            |
| --------------------------------------------------------------------------------------- | ------------------------- |
| §1 全部既有動態功能、演算法不變、內建不可停用、2C 邊界                                  | Task 1、4、6、7           |
| §2 strict 宣告、8 筆、12 capabilities、語意關聯、只限 builtin、API 1.3.0                | Task 1                    |
| §3 compiled factory／companion tables、capability subset、缺 factory 不改 plugin status | Task 2、4                 |
| §4 frontend-only、conflict 優先、extension gate、描述重新核對、不回退、source stamping  | Task 2、5、6              |
| §5 DTO、通用編輯結果、opaque visibility、compact packing、companion、匯入限制           | Task 3、4、6              |
| §6 兩條 worker、epoch、取消更新次序、bounded history、refresh-only、50/150 ms、來源隔離 | Task 5、6、7              |
| §7 unavailable union、清動態結果、保留詞法、status row／workspace banner、雙語動作      | Task 5、6                 |
| §8 manifest／來源／factory 錯誤、ok:false、BUILD1007、restart、stale                    | Task 1、2、5              |
| §9 第二語言、schema parity、回歸、匯入、效能、完整測試                                  | Task 1–7 與下方全分支驗收 |
| §10 七項切分                                                                            | Task 1–7，順序不變        |

無未映射的規格需求。文件撰寫與後續實作分開；本計畫中的測試結果都是執行時預期，不是已完成的實作驗證。

## 全分支驗收（完整覆蓋 Spec §9）

- [ ] **Step 1: 第二內建語言與 registry 邊界**

第二語言只存在 testing fixture／測試 bundle，正式 manifest 與兩張 builtin tables 只有正式內建插件。驗證不同 `csx`／`csi` 副檔名、`Foo`／`foo` 大小寫敏感、不同 token legend、重疊 `BP1043`；manifest 結構拒絕、frontend／service 集合不一致、沒有 backend 仍可分析、frontend 雙方 invalid 後仍回 conflict、缺 factory／capability mismatch、來源偽造 BUILD1007、請求途中換提供者拒收舊 epoch、同碼不同來源 Quick Fix 隔離。不可透過停用正式內建插件來製造測試狀態。

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol test
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-runtime test
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/main/workspace/language-binding.test.ts src/main/language/language-provider.integration.test.ts src/main/language/language-worker-session.test.ts src/main/language/language.test.ts
```

- [ ] **Step 2: API 1.3.0 與跨語言 schema**

JSON Schema exporter、兩份 committed schema、portable regex、strict 新宣告、JS initialize、Python API_VERSION、共用結構 conformance，以及非內建宣告（含空陣列）的 registry conformance 全部通過；未新增 refine／transform／coercion。舊 `^1.0.0`、`^1.1.0`、`^1.2.0` fixtures 仍通過。

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol schema
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-protocol exec vitest run src/json-schema.test.ts src/conformance.test.ts src/language-services.test.ts
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/plugin-sdk test
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm test:python-sdk
```

- [ ] **Step 3: 防退化、通用匯入與 UI**

保留並擴充 worker 歸屬／stale、取消後增量、同插件 generation、結構性編輯、model 替換、連續輸入、UTF-16／BOM、tokens 在一般輸入時保留及換 epoch 時清除。增量 adapter 結果與全新 adapter 結果相同。generic renderer/shared import test 必須通過；不可把 Basic Plus 語意藏在通用檔案的 dynamic import。

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop exec vitest run src/shared src/main/language src/renderer/editor src/renderer/workbench
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop check
```

手動 UI 使用中英文各驗一次：missing 與 conflict 顯示不同說明、衝突列出插件、按鈕開啟插件設定；available 且 diagnostics 為空時沒有不可用列。切換狀態不改文件內容，JSON 繼續格式化，Basic Plus lexical 高亮保留。恢復後不用輸入就重啟分析。開啟 Basic Plus 範例，逐項確認 completion（含關鍵字收尾縮排）、Quick Fix、tokens、hover、signature、definition、references、rename、outline／breadcrumbs、document/range formatting。

- [ ] **Step 4: 效能 smoke／人工驗收**

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm test:desktop:smoke
```

`tests/desktop/completion-performance-smoke.mjs` 門檻不變：**熱補全 p95 ≤100 ms、新變數 ≤200 ms、30,000 行 ≤300 ms**。runner 同時涵蓋 language-features、indentation、highlighting。此機器可能無法跑 completion smoke，屆時將這三個數值與 Basic Plus 全功能 UI 流程列為**人工驗收未完成**，附環境錯誤；不得把模組載入成功或單元測試 PASS 當成效能 smoke PASS。

- [ ] **Step 5: 全套 build、tests、web、格式與 lint**

先重建 workspace packages，再執行 desktop checks（消費 `dist/`）。下列命令逐行執行，即使 desktop packaging 碰到已知環境問題，也要繼續執行其餘獨立驗證並分別記錄結果。

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm -r --filter '!@kobrixa/desktop' build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm -r build
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm test
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm test:bytecode
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm test:python-sdk
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/web test
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm test:web
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm --filter @kobrixa/desktop check
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; git diff --name-only --diff-filter=AM feat/plugin-system-stage-2 HEAD | xargs pnpm exec prettier --check  # 分支外有既存未格式化檔案，只檢查本分支改動
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false; pnpm exec eslint .
```

Expected: 全部通過，環境阻擋獨立列出。**此 worktree 的 desktop packaging 已知會因缺少 hoisted `node-addon-api` 而失敗，屬環境問題。** 不為掩蓋此錯誤修改 package manifests、lockfile、依賴提升設定或測試門檻；交付記錄保留命令及缺失模組訊息。這不免除可執行的 package builds、desktop type check、unit/integration、bytecode、Python、web、prettier 與 eslint。
