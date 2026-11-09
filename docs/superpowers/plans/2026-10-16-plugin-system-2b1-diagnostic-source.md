# 診斷來源契約與插件診斷說明 2B-1 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 所有經宿主發布的診斷都帶有宿主加註、不可偽造的 `source`；說明以 `(source, code, helpKey)` 查詢；任何合法插件可用封裝 JSON 註冊純文字說明與 HTTPS 連結。

**Architecture:** `@kobrixa/compiler` 新增 `PublishedDiagnostic` 與加註工具，`compileToMemory` 依宿主從提供者快照取得的 `DiagnosticSources` 加註前端與後端診斷，核心自己產生的診斷固定為 `kobrixa.core`；desktop 在發布前以 `requirePublished` 守門。插件端由 `plugin-protocol` 定義 `contributes.diagnosticHelp` 與資源 schema，`plugin-runtime` 在讀取開發插件時有界載入資源，manager 依啟用狀態組出有 revision 的說明目錄；desktop 經 preload 提供給 renderer，renderer 以 `resolveDiagnosticHelp` 統一查詢內建與插件說明。

**Tech Stack:** TypeScript（strict、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`）、Node.js 24、Electron 44、Zod 4、Vitest、React 19、Monaco、Python 3.10+ unittest。

**Spec:** [`2026-10-16-plugin-system-2b1-diagnostic-source-design.md`](../specs/2026-10-16-plugin-system-2b1-diagnostic-source-design.md) §1–10（已核准）。格式範本：[`2026-10-16-plugin-system-2a-build-chain.md`](2026-10-16-plugin-system-2a-build-chain.md)。

## Global Constraints

- 工作分支為 `feat/plugin-2b1-diagnostic-source`（從 `feat/plugin-system-stage-2` 分出）；完成後以 `--no-ff` 合回 stage-2。本計畫不做 2B-2 的語言服務提供者，也不做 2C tokenizer。
- 保留來源 `kobrixa.core`（`CORE_DIAGNOSTIC_SOURCE`）；內建來源只有 `kobrixa.core`、`kobrixa.basic-plus`、`kobrixa.ev3`。
- `source` 一律來自宿主可信上下文：前端 `snapshot.frontend.pluginId`、後端 `snapshot.backend.pluginId`、IR／MAN／BUILD／SIM 與 compiler 的 `diagnostic()` 為 `kobrixa.core`、語言 worker 分析診斷為 `kobrixa.basic-plus`。絕不依診斷碼推測。
- producer 回傳的診斷自帶 `source` 時回 **BUILD1007**（`kobrixa.core`），不默默移除欄位。
- 經宿主發布到 renderer 的診斷型別為 `PublishedDiagnostic`（`source` 必填）；`@kobrixa/compiler` 的 `Diagnostic.source` 保持可選，不傳 `sources` 的函式庫呼叫行為不變。
- 診斷碼格式（插件與 Quick Fix 請求）：`/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/`；helpKey：`/^[a-z0-9-]{1,100}$/`；source：與 `namespacedIdSchema` 相同。
- `contributes.diagnosticHelp = { version: 1, path }`；path：`/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\/){0,7}[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\.json$/`。任何合法插件可宣告；內建插件不宣告。
- **API 版本升為 1.2.0。** 同步 protocol 常數、提交的 JSON Schema、JS SDK、Python SDK 與 conformance；有效的 1.0／1.1 插件仍相容。
- `DIAGNOSTIC_HELP_LIMITS`（v1）：資源檔 1 MiB（1_048_576 bytes）、每插件 512 筆、單筆 JSON 序列化 16 KiB（16_384 bytes）、每語系 16 步驟、每筆 4 連結、URL 2048 字元、title／單一步驟／連結標籤 500 字元、cause／example 單欄 4000 字元、全部插件合計 8 MiB（8_388_608 bytes）。每項要有剛好到上限與超過上限的測試。
- 說明資源只接受純文字：title、步驟、連結標籤為單行；cause、example 可多行；連結只接受 `https:`。`en` 必填、`zh-TW` 可選並退回英文。schema 為 strict，未知欄位（含 `source`）拒絕。
- 說明資源失敗時插件仍為啟用，只加 `PLUGIN_E_DIAGNOSTIC_HELP` 問題；合計超限時依 `sourceKey` 字典序載入，第一個使合計超限的插件失敗，其後照常檢查。
- 說明查詢：內建來源走 `getBuiltinDiagnosticHelp(source, code, helpKey)`；插件來源先 `(code, helpKey)` 再 `(code)`，只在同一 source 內；不跨來源退回。
- 內建擁有者：BP → `kobrixa.basic-plus`；EV3 → `kobrixa.ev3`；MAN、IR、BUILD → `kobrixa.core`；共有例外表 `EV32031` → `kobrixa.basic-plus` 與 `kobrixa.ev3`。
- 既有代碼、helpKey、官方網址 `https://kobrixa.com/docs/diagnostics/<code>?lang=<locale>[#<helpKey>]`、`related` 網址、bytecode 與網站路由不變；`getDiagnosticHelp`、`diagnosticDocumentationUrl` 匯出保持原簽名。
- renderer 永遠不提供 URL：第三方連結只送 `(source, code, helpKey?, linkIndex)`，main 查表後以 `new URL()` 確認 `https:` 再 `shell.openExternal`。
- 介面與診斷說明一律有 `en`、`zh-TW`；低階例外保持英文並帶固定 code。
- 桌面端從 `@kobrixa/plugin-runtime`、`@kobrixa/plugin-protocol`、`@kobrixa/compiler` 的 `dist/` 取用：改完這些套件後、跑桌面端測試或型別檢查前，先執行 `pnpm --filter <套件> build`。
- 本機環境：pnpm 版本與專案釘選不同時，先 `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false`。
- Wire schema 必須可匯出 JSON Schema：不用 transform、coercion、refine；regex 不用 `\d`、`\w`、`\s`、`\b`。關聯規則（重複鍵、序列化大小、URL 解析）放在語意檢查函式。
- 每個 task 結束前對改到的檔案執行 `pnpm exec prettier --write`，再跑 `pnpm exec prettier --check` 與 `pnpm exec eslint`；ESLint 只傳 TS／TSX／MJS；兩份產生的 schema 由 exporter 寫入，不手動格式化。
- 所有命令從 repo 根目錄執行。

## Review Focus

1. **同一個 Basic Plus 錯誤同時出現在即時分析與建置結果**：兩者 source 相同，問題面板應只顯示一筆；不同 source 的同碼診斷應顯示兩筆。→ Task 7 的 `merges same-source duplicates and keeps different sources apart`。
2. **重新載入插件時說明面板開著，或兩次目錄請求的回應順序顛倒**：renderer 不能退回較舊的目錄。→ Task 7 的 `ignores an older catalog that resolves after a newer one`。
3. **說明檔在 `stat` 之後被改大，或被換成指向插件外的符號連結**：不能讀入超過上限的內容或插件外檔案。→ Task 4 的 `rejects a file that grows past the limit after stat` 與 `rejects a symlink that escapes the plugin folder`。
4. **第三方插件回報 `BP1015`**：不顯示 Basic Plus 說明、不觸發 Basic Plus Quick Fix、不產生官方網址。→ Task 5 的 `never falls back across sources`、Task 6 的 `only offers Basic Plus fixes for Basic Plus diagnostics`、Task 7 的 `rejects official documentation for plugin sources`。
5. **模擬或建置 worker 中途崩潰、包裝層漏傳來源**：發布前要攔下沒有 source 的診斷，以 core 的 BUILD9000 取代，不把無來源資料送到 UI。→ Task 1 的 `replaces an unsourced result with a core BUILD9000`。

## 檔案結構

| 檔案                                                                           | 責任                                                             |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `packages/compiler/src/contracts.ts`                                           | `Diagnostic.source?`、`PublishedDiagnostic`、`DiagnosticSources` |
| `packages/compiler/src/diagnostic-source.ts`（新）                             | `CORE_DIAGNOSTIC_SOURCE`、`stampDiagnostics`、`requirePublished` |
| `packages/compiler/src/diagnostics.ts`                                         | `diagnostic()` 固定標 core                                       |
| `packages/compiler/src/build-error.ts`                                         | BUILD1007                                                        |
| `packages/compiler/src/compile-memory.ts`                                      | 依 `sources` 加註前端、後端                                      |
| `packages/compiler/src/build-session.ts`                                       | 轉傳 `diagnosticSources`                                         |
| `packages/compiler/src/diagnostic-help.ts`                                     | BUILD1007 說明、內建擁有者、`getBuiltinDiagnosticHelp`           |
| `apps/desktop/src/main/workspace/builtin-compilers.ts`                         | 由快照產生 `sources`                                             |
| `apps/desktop/src/main/workspace/{build-worker,prepare-simulation,build}.ts`   | 傳遞來源、發布前守門                                             |
| `apps/desktop/src/shared/{api,simulator}.ts`                                   | 發布型別                                                         |
| `packages/plugin-runtime/src/{errors,registry}.ts`                             | 保留 ID、讀取說明資源                                            |
| `packages/plugin-protocol/src/diagnostic-help.ts`（新）                        | 宣告與資源 schema、語意檢查                                      |
| `packages/plugin-protocol/src/{limits,manifest,json-schema,index}.ts`          | API 1.2.0、上限、manifest 欄位、JSON Schema                      |
| `packages/plugin-runtime/src/diagnostic-help.ts`（新）                         | 有界讀取與驗證                                                   |
| `packages/plugin-runtime/src/manager.ts`                                       | 說明目錄、revision、合計上限                                     |
| `apps/desktop/src/shared/diagnostic-help.ts`（新）                             | `resolveDiagnosticHelp`、`diagnosticIdentity`、在地化            |
| `apps/desktop/src/shared/basic-plus-quick-fixes.ts`（新）                      | Basic Plus 的 Quick Fix 代碼與資格                               |
| `apps/desktop/src/shared/{language-sync,quick-fixes,documentation,plugins}.ts` | 發布分析型別、來源比較、文件請求、說明 API                       |
| `apps/desktop/src/main/language/{language-worker,quick-fix-request}.ts`        | 分析加註、請求 schema                                            |
| `apps/desktop/src/main/window/documentation.ts`                                | 內建網址與第三方連結                                             |
| `apps/desktop/src/main/plugins/{controller,ipc}.ts`、`preload/index.ts`        | 說明目錄 IPC                                                     |
| `apps/desktop/src/renderer/editor/diagnostic-help-store.ts`（新）              | renderer 說明目錄 store                                          |
| `apps/desktop/src/renderer/...`                                                | marker、面板、問題清單、Quick Fix 閘門                           |
| `apps/web/src/features/docs/diagnostic-urls.test.ts`（新）                     | 鎖定官方網址                                                     |

---

### Task 1: `source` 型別、BUILD1007 與建置鏈加註

**Files:**

- Modify: `packages/compiler/src/contracts.ts`（`Diagnostic`、新型別）
- Create: `packages/compiler/src/diagnostic-source.ts`
- Modify: `packages/compiler/src/diagnostics.ts`、`packages/compiler/src/build-error.ts`、`packages/compiler/src/compile-memory.ts`、`packages/compiler/src/build-session.ts`、`packages/compiler/src/index.ts`
- Modify: `packages/compiler/src/diagnostic-help.ts`（BUILD1007 條目，接在 BUILD1006 之後）
- Modify: `apps/desktop/src/main/workspace/builtin-compilers.ts`、`build-worker.ts`、`prepare-simulation.ts`、`build.ts`
- Modify: `apps/desktop/src/shared/api.ts`、`apps/desktop/src/shared/simulator.ts`
- Test: `packages/compiler/src/diagnostic-source.test.ts`（新）、`packages/compiler/src/compile-memory.test.ts`、`apps/desktop/src/main/workspace/compiler-chain.test.ts`、`apps/desktop/src/main/workspace/build.test.ts`、`apps/desktop/src/main/workspace/prepare-simulation.test.ts`

**Interfaces:**

- Produces（`@kobrixa/compiler`）：
  - `interface Diagnostic { …; source?: string }`
  - `type PublishedDiagnostic = Omit<Diagnostic, "source"> & { source: string }`
  - `interface DiagnosticSources { frontend: string; backend: string }`
  - `type PublishedCompileResult = Omit<CompileResult, "diagnostics"> & { diagnostics: PublishedDiagnostic[] }`
  - `const CORE_DIAGNOSTIC_SOURCE = "kobrixa.core"`
  - `stampDiagnostics(items: readonly Diagnostic[], source: string): PublishedDiagnostic[]`（任何一筆自帶 source 時拋 `BuildError("BUILD1007", …)`）
  - `isPublishedDiagnostic(item: Diagnostic): item is PublishedDiagnostic`
  - `requirePublished(items: readonly Diagnostic[]): PublishedDiagnostic[]`（缺 source 時拋一般 `Error`）
  - `diagnostic(...)`、`diagnosticFromSpan(...)` 回傳 `PublishedDiagnostic`，source 為 core。
  - `compileToMemory(project, frontend, backend, signal, sources?: DiagnosticSources)`
  - `new BuildSession(frontend, backend, onProgress?, controller?, id?, commitOptions?, diagnosticSources?)`
- Produces（desktop）：`createBuiltinCompilers(snapshot): { frontend; backend; sources: DiagnosticSources }`；`shared/api.ts` 的 `Diagnostic` 改為 `PublishedDiagnostic` 的別名、`CompileResult` 改為 `PublishedCompileResult` 的別名。

- [ ] **Step 1: 寫失敗的加註工具測試**

建立 `packages/compiler/src/diagnostic-source.test.ts`：

```ts
import { expect, it } from "vitest";
import {
  CORE_DIAGNOSTIC_SOURCE,
  isPublishedDiagnostic,
  requirePublished,
  stampDiagnostics,
} from "./diagnostic-source.js";
import { diagnostic, diagnosticFromSpan } from "./diagnostics.js";
import { BuildError } from "./build-error.js";

const raw = {
  code: "BP1015",
  severity: "error" as const,
  file: "main.bp",
  range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
  message: "x",
};

it("stamps the trusted source on every diagnostic", () => {
  expect(stampDiagnostics([raw], "kobrixa.basic-plus")).toEqual([
    { ...raw, source: "kobrixa.basic-plus" },
  ]);
});
it("rejects producer-supplied sources with BUILD1007", () => {
  const forged = { ...raw, source: "kobrixa.ev3" };
  expect(() => stampDiagnostics([raw, forged], "kobrixa.basic-plus")).toThrow(BuildError);
  try {
    stampDiagnostics([forged], "kobrixa.basic-plus");
  } catch (error) {
    expect((error as BuildError).code).toBe("BUILD1007");
  }
});
it("marks host diagnostics as core", () => {
  expect(diagnostic("MAN1001", "bad").source).toBe(CORE_DIAGNOSTIC_SOURCE);
  expect(diagnosticFromSpan("IR1001", "bad").source).toBe(CORE_DIAGNOSTIC_SOURCE);
});
it("requires a source before publication", () => {
  expect(isPublishedDiagnostic(raw)).toBe(false);
  expect(() => requirePublished([raw])).toThrow(/without a source/);
  const published = { ...raw, source: "kobrixa.basic-plus" };
  expect(requirePublished([published])).toEqual([published]);
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter @kobrixa/compiler exec vitest run src/diagnostic-source.test.ts`
Expected: FAIL，`./diagnostic-source.js` 不存在。

- [ ] **Step 3: 實作型別與加註工具**

`contracts.ts` 在 `Diagnostic` 的 `message` 後加：

```ts
  /** Host-assigned provider identity. Producers must leave it unset. */
  source?: string;
}
export type PublishedDiagnostic = Omit<Diagnostic, "source"> & { source: string };
export interface DiagnosticSources {
  frontend: string;
  backend: string;
}
```

並在 `CompileResult` 之後加：

```ts
export type PublishedCompileResult = Omit<CompileResult, "diagnostics"> & {
  diagnostics: PublishedDiagnostic[];
};
```

`build-error.ts` 的 `BuildErrorCode` 加上 `| "BUILD1007"`。

建立 `packages/compiler/src/diagnostic-source.ts`：

```ts
import type { Diagnostic, PublishedDiagnostic } from "./contracts.js";
import { BuildError } from "./build-error.js";

export { CORE_DIAGNOSTIC_SOURCE } from "./diagnostics.js";

/** Assigns the host-verified provider identity; producers must not choose their own. */
export function stampDiagnostics(
  items: readonly Diagnostic[],
  source: string,
): PublishedDiagnostic[] {
  if (items.some((item) => item.source !== undefined))
    throw new BuildError(
      "BUILD1007",
      "A compiler provider returned diagnostics with a source; Kobrixa assigns diagnostic sources.",
    );
  return items.map((item) => ({ ...item, source }));
}

export const isPublishedDiagnostic = (item: Diagnostic): item is PublishedDiagnostic =>
  typeof item.source === "string" && item.source.length > 0;

/** Publication guard: an unsourced diagnostic means a host path forgot to stamp it. */
export function requirePublished(items: readonly Diagnostic[]): PublishedDiagnostic[] {
  const missing = items.find((item) => !isPublishedDiagnostic(item));
  if (missing) throw new Error(`Diagnostic ${missing.code} was published without a source.`);
  return items as PublishedDiagnostic[];
}
```

`diagnostics.ts` 定義常數（`build-error.ts` 匯入 `diagnostics.ts`，`diagnostic-source.ts` 匯入 `build-error.ts`，常數放在 `diagnostics.ts` 才不會循環匯入）：

```ts
/** Reserved identity for diagnostics produced by Kobrixa itself; no plugin may register it. */
export const CORE_DIAGNOSTIC_SOURCE = "kobrixa.core";
```

`diagnostic()` 回傳型別改為 `PublishedDiagnostic`，回傳物件改為 `{ code, severity, file, range, message, source: CORE_DIAGNOSTIC_SOURCE }`；`diagnosticFromSpan` 回傳型別同步改為 `PublishedDiagnostic`。

`index.ts` 加 `export * from "./diagnostic-source.js";`。

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm --filter @kobrixa/compiler exec vitest run src/diagnostic-source.test.ts`
Expected: PASS

- [ ] **Step 5: 寫失敗的 compileToMemory 加註測試**

在 `compile-memory.test.ts` 末尾加入：

```ts
const sources = { frontend: "test.front", backend: "test.back" };
// Unstamped producer output: diagnostic() now adds the core source, so remove it again.
const warning = (code: string) => {
  const { source: _source, ...rest } = diagnostic(code, code);
  return { ...rest, severity: "warning" as const };
};

it("stamps frontend, IR and backend diagnostics independently", async () => {
  const backend = testBackend();
  const compile = backend.compile.bind(backend);
  backend.compile = async (ir, signal) => ({
    ...(await compile(ir, signal)),
    diagnostics: [warning("EV30001")],
  });
  const frontend = {
    id: "toy",
    compile: async (input: Parameters<typeof testFrontend.compile>[0], signal: AbortSignal) => ({
      ...(await testFrontend.compile(input, signal)),
      diagnostics: [warning("BP0001")],
    }),
  };
  const result = await compileToMemory(
    testProject(root),
    frontend,
    backend,
    new AbortController().signal,
    sources,
  );
  expect(result.diagnostics.map((item) => [item.code, item.source])).toEqual([
    ["BP0001", "test.front"],
    ["EV30001", "test.back"],
  ]);
});
it("reports IR validation failures as core", async () => {
  const badIR = structuredClone(minimalIR);
  badIR.program.entryFunction = "missing";
  const result = await compileToMemory(
    testProject(root),
    { id: "toy", compile: async () => ({ ir: badIR, diagnostics: [] }) },
    testBackend(),
    new AbortController().signal,
    sources,
  );
  expect(result.diagnostics[0]).toMatchObject({ code: "IR1001", source: "kobrixa.core" });
});
it("fails with a core BUILD1007 when a provider forges a source", async () => {
  const forged = {
    id: "toy",
    compile: async () => ({ diagnostics: [{ ...warning("BP0001"), source: "kobrixa.ev3" }] }),
  };
  const result = await compileToMemory(
    testProject(root),
    forged,
    testBackend(),
    new AbortController().signal,
    sources,
  );
  expect(result.success).toBe(false);
  expect(result.diagnostics).toEqual([
    expect.objectContaining({ code: "BUILD1007", source: "kobrixa.core" }),
  ]);
  const backend = testBackend();
  backend.compile = async () => ({
    artifacts: [],
    diagnostics: [{ ...warning("EV30001"), source: "x.y" }],
  });
  const late = await compileToMemory(
    testProject(root),
    testFrontend,
    backend,
    new AbortController().signal,
    sources,
  );
  expect(late.diagnostics.at(-1)).toMatchObject({ code: "BUILD1007", source: "kobrixa.core" });
  expect(late.diagnostics.some((item) => item.source === "x.y")).toBe(false);
});
it("keeps library calls without sources unchanged", async () => {
  const frontend = { id: "toy", compile: async () => ({ diagnostics: [warning("BP0001")] }) };
  const result = await compileToMemory(
    testProject(root),
    frontend,
    testBackend(),
    new AbortController().signal,
  );
  expect(result.diagnostics[0]!.source).toBeUndefined();
});
```

- [ ] **Step 6: 執行測試確認失敗**

Run: `pnpm --filter @kobrixa/compiler exec vitest run src/compile-memory.test.ts`
Expected: FAIL，`compileToMemory` 不接受第五個參數或未加註。

- [ ] **Step 7: 實作 compileToMemory 與 BuildSession 加註**

`compile-memory.ts`：

```ts
export async function compileToMemory(
  project: SourceProject,
  frontend: LanguageFrontend,
  backend: CompilerBackend,
  signal: AbortSignal,
  sources?: DiagnosticSources,
): Promise<CompileMemoryResult> {
  const diagnostics: Diagnostic[] = [];
  // Library callers keep producer output as is; the host passes trusted provider identities.
  const stamp = (items: readonly Diagnostic[], source: string | undefined): Diagnostic[] =>
    source === undefined ? [...items] : stampDiagnostics(items, source);
```

把 `diagnostics.push(...source.diagnostics)` 換成 `diagnostics.push(...stamp(source.diagnostics, sources?.frontend))`，把 `diagnostics.push(...result.diagnostics)` 換成 `diagnostics.push(...stamp(result.diagnostics, sources?.backend))`。IR 診斷已由 `diagnosticFromSpan` 標 core，`failedBuild` 加入的錯誤由 `diagnostic()` 標 core，不必改。`stampDiagnostics` 在 push 之前拋出，所以被拒的那一批不會進入結果。

`build-session.ts` 建構子在 `commitOptions` 之後加 `private readonly diagnosticSources?: DiagnosticSources`，`compileToMemory(..., this.controller.signal, this.diagnosticSources)`。

- [ ] **Step 8: 執行 compiler 測試確認通過**

Run: `pnpm --filter @kobrixa/compiler test`
Expected: PASS（既有測試不傳 `sources`，維持原行為；斷言整個 `diagnostic()` 物件的既有測試若因多出 `source: "kobrixa.core"` 而失敗，更新期望值加上這個欄位）。

- [ ] **Step 9: 補 BUILD1007 說明**

在 `diagnostic-help.ts` 的 BUILD1006 條目之後加入：

```ts
  internal(
    "BUILD1007",
    ["編譯提供者自行設定了診斷來源", "A compiler provider set its own diagnostic source"],
    [
      "診斷來源由 Kobrixa 依提供者身分填入；提供者回傳的診斷不可自帶 source。",
      "Kobrixa assigns diagnostic sources from the provider identity; providers must not return diagnostics with a source.",
    ],
    [
      "更新或停用造成問題的插件，然後重新建置。",
      "Update or disable the plugin that caused the problem, then build again.",
    ],
  ),
```

Run: `pnpm --filter @kobrixa/compiler exec vitest run src/diagnostic-help.test.ts`
Expected: PASS（既有「每個產品代碼都有說明」測試涵蓋 BUILD1007）。

- [ ] **Step 10: 寫失敗的 desktop 發布測試**

在 `apps/desktop/src/main/workspace/compiler-chain.test.ts` 加入（沿用檔內既有的範例專案與 `resolveBuiltinCompiler` fixture）：

```ts
it("publishes provider identities from the compiler snapshot", () => {
  const resolution = resolveBuiltinCompiler("bp", "ev3-native");
  if (!resolution.ok) throw new Error(resolution.message);
  expect(createBuiltinCompilers(resolution).sources).toEqual({
    frontend: "kobrixa.basic-plus",
    backend: "kobrixa.ev3",
  });
});
```

在 `build.test.ts` 末尾加入（與既有「reports worker error」測試相同的 `BuildService` 建立方式，worker 改用 `EventEmitter` 假物件）：

```ts
it("replaces an unsourced result with a core BUILD9000", async () => {
  service.dispose();
  service = new BuildService(
    { project: async (_id, overlays) => (await loadProject(root, overlays, "main.bp")).project! },
    () =>
      ({
        isDestroyed: () => false,
        send: (_channel: string, event: BuildEvent) => events.push(event),
      }) as unknown as WebContents,
    (request) => {
      const worker = Object.assign(new EventEmitter(), {
        terminate: async () => 0,
        postMessage: () => undefined,
      });
      // A wrapper that forgot to stamp sources: the diagnostic has no `source`.
      setImmediate(() =>
        worker.emit("message", {
          type: "complete",
          result: {
            buildId: request.buildId,
            target: "ev3-native",
            success: false,
            artifacts: [],
            diagnostics: [
              {
                code: "BP3001",
                severity: "error",
                file: "main.bp",
                range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
                message: "unstamped",
              },
            ],
          },
        }),
      );
      return worker as unknown as Worker;
    },
  );
  const built = await result(await service.start("project", {}));
  expect(built.success).toBe(false);
  expect(built.diagnostics).toEqual([
    expect.objectContaining({ code: "BUILD9000", source: "kobrixa.core" }),
  ]);
});

it("stamps Basic Plus, core and EV3 sources on a real build", async () => {
  const failed = await result(await service.start("project", { "main.bp": "Unknown.Do()\n" }));
  expect(failed.diagnostics).toEqual([
    expect.objectContaining({ code: "BP3001", source: "kobrixa.basic-plus" }),
  ]);
  const ok = await result(await service.start("project", {}));
  expect(ok.diagnostics.every((item) => typeof item.source === "string")).toBe(true);
});
```

在 `prepare-simulation.test.ts` 加入（沿用檔內的 `snapshot` 與 `test-build.js` fixture；檔內既有測試的 `create` 回傳值一併補上 `sources: { frontend: "test.front", backend: "test.back" }`）：

```ts
it("stamps frontend diagnostics with the snapshot provider and SIM1001 with core", async () => {
  const project = testProject("/unused");
  project.sources = [{ path: "a.toy", content: "test" }];
  const warn = {
    code: "TOY1",
    severity: "warning" as const,
    file: "a.toy",
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
    message: "w",
  };
  const frontend = {
    id: "toy",
    compile: async (input: Parameters<typeof testFrontend.compile>[0], signal: AbortSignal) => ({
      ...(await testFrontend.compile(input, signal)),
      diagnostics: [warn],
    }),
  };
  const create = () => ({
    frontend,
    backend: testBackend(),
    sources: { frontend: snapshot.frontend.pluginId, backend: snapshot.backend.pluginId },
  });
  const signal = new AbortController().signal;
  const ok = await prepareSimulation(project, ["a.toy"], {}, signal, snapshot, create);
  expect(ok.diagnostics).toEqual([expect.objectContaining({ code: "TOY1", source: "test.front" })]);
  const missing = await prepareSimulation(project, ["missing.toy"], {}, signal, snapshot, create);
  expect(missing.diagnostics).toEqual([
    expect.objectContaining({ code: "SIM1001", source: "kobrixa.core" }),
  ]);
});
```

- [ ] **Step 11: 執行 desktop 測試確認失敗**

Run: `pnpm --filter @kobrixa/compiler build && pnpm --filter @kobrixa/desktop exec vitest run src/main/workspace/compiler-chain.test.ts src/main/workspace/build.test.ts src/main/workspace/prepare-simulation.test.ts`
Expected: FAIL

- [ ] **Step 12: 實作 desktop 接線**

`builtin-compilers.ts` 的 `createBuiltinCompilers` 回傳型別加 `sources: DiagnosticSources`，回傳值加 `sources: { frontend: front.pluginId, backend: back.pluginId }`。

`build-worker.ts`：`const { frontend, backend, sources } = createBuiltinCompilers(request.compiler);`，`new BuildSession(..., controller, request.buildId, {}, sources)`。

`prepare-simulation.ts`：`const { frontend, backend, sources } = create(compiler);`，`compileToMemory(..., signal, sources)`；`SimulationPrepareResult["diagnostics"]` 改為 `PublishedDiagnostic[]`（見下）。

`build.ts` 的 `complete()` 在設定 `record.result` 前守門：

```ts
let published: PublishedCompileResult;
try {
  published = { ...result, diagnostics: requirePublished(result.diagnostics) };
} catch (error) {
  published = failedBuild(buildId, result.target, error, entry) as PublishedCompileResult;
}
record.result = { ...published, buildId, artifacts: published.success ? published.artifacts : [] };
```

（`failedBuild(…, error)` 對一般 `Error` 只產生一筆 core 的 BUILD9000，原本無來源的診斷被丟棄。）`BuildRecord.result` 型別改為 `PublishedCompileResult`。`prepareSimulation` 回傳前同樣以 `requirePublished` 守門，失敗時回 `{ success: false, diagnostics: failedBuild("simulation", "unknown", error, "<project>").diagnostics }`。

`shared/simulator.ts` 的 `Diagnostic` 匯入改為 `PublishedDiagnostic`。`shared/api.ts` 匯入 `PublishedDiagnostic`、`PublishedCompileResult`，並把末尾的再匯出改為：

```ts
export type { BuildArtifact, DeviceDescriptor, RemoteEntry };
export type Diagnostic = PublishedDiagnostic;
export type CompileResult = PublishedCompileResult;
```

`api.ts` 內原本使用 `Diagnostic`／`CompileResult` 的宣告不需改名。修正 desktop 型別錯誤：renderer 與 main 中建立診斷字面值的地方（多半是測試）補上 `source`。

- [ ] **Step 13: 執行測試與型別檢查**

Run: `pnpm --filter @kobrixa/compiler build && pnpm --filter @kobrixa/desktop exec vitest run src/main/workspace && pnpm --filter @kobrixa/desktop check`
Expected: PASS

- [ ] **Step 14: 格式化與 commit**

```bash
pnpm exec prettier --write packages/compiler/src apps/desktop/src/main/workspace apps/desktop/src/shared/api.ts apps/desktop/src/shared/simulator.ts
pnpm exec prettier --check packages/compiler/src apps/desktop/src/main/workspace apps/desktop/src/shared
pnpm exec eslint packages/compiler/src apps/desktop/src/main/workspace apps/desktop/src/shared
git add packages/compiler/src apps/desktop/src
git commit -m "feat(compiler): stamp host-verified diagnostic sources through the build chain"
```

---

### Task 2: 保留 `kobrixa.core` 與內建 ID 優先

**Files:**

- Modify: `packages/plugin-runtime/src/errors.ts`（加 `PLUGIN_E_RESERVED_ID`）
- Modify: `packages/plugin-runtime/src/registry.ts`（`semanticProblems`）
- Modify: `apps/desktop/src/renderer/settings/plugin-copy.ts`（雙語文案）
- Test: `packages/plugin-runtime/src/registry.test.ts`

**Interfaces:**

- Consumes：`CORE_DIAGNOSTIC_SOURCE` 不從 compiler 匯入（runtime 不依賴 compiler）；在 `registry.ts` 定義 `export const RESERVED_PLUGIN_IDS: ReadonlySet<string> = new Set(["kobrixa.core"]);`，並在 Task 1 的 `diagnostic-source.test.ts` 之外由本 task 測試保證兩邊值相同（見 Step 1）。
- Produces：`PLUGIN_E_RESERVED_ID`；`RESERVED_PLUGIN_IDS`。

- [ ] **Step 1: 寫失敗測試**

在 `registry.test.ts` 的 `describe("loadPlugins")` 中加入：

```ts
it("rejects the reserved kobrixa.core identity", async () => {
  const [loaded] = await loadPlugins(
    [
      await plugin(
        "core",
        manifest({
          id: "kobrixa.core",
          activationEvents: ["onCommand:kobrixa.core.greet"],
          contributes: { commands: [{ id: "kobrixa.core.greet", title: "Greet" }] },
        }),
      ),
    ],
    none,
  );
  expect(loaded).toMatchObject({ status: "invalid" });
  expect(loaded!.problems.map((item) => item.code)).toContain("PLUGIN_E_RESERVED_ID");
});
it("keeps the built-in plugin when a development plugin reuses its id", async () => {
  const impostor = await plugin(
    "impostor",
    manifest({
      id: "kobrixa.basic-plus",
      activationEvents: ["onCommand:kobrixa.basic-plus.greet"],
      contributes: { commands: [{ id: "kobrixa.basic-plus.greet", title: "Greet" }] },
    }),
  );
  for (const order of [
    [builtin, impostor],
    [impostor, builtin],
  ]) {
    const loaded = await loadPlugins(order, none);
    const real = loaded.find((item) => item.source === "builtin")!;
    const fake = loaded.find((item) => item.source === "development")!;
    expect(real.status).toBe("enabled");
    expect(fake.problems.map((item) => item.code)).toContain("PLUGIN_E_DUPLICATE_ID");
  }
});
it("reserves the same identity the compiler stamps as core", async () => {
  const { RESERVED_PLUGIN_IDS } = await import("./index.js");
  expect([...RESERVED_PLUGIN_IDS]).toEqual(["kobrixa.core"]);
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `pnpm --filter @kobrixa/plugin-runtime exec vitest run src/registry.test.ts`
Expected: FAIL（保留 ID 未拒絕；若 `[impostor, builtin]` 順序下內建插件被判重複，第二個測試也失敗）。

- [ ] **Step 3: 實作**

`errors.ts` 的 `PLUGIN_ERROR_CODES` 加 `"PLUGIN_E_RESERVED_ID"`。`registry.ts` 加：

```ts
/** Identities Kobrixa itself uses for diagnostics; no plugin may claim them. */
export const RESERVED_PLUGIN_IDS: ReadonlySet<string> = new Set(["kobrixa.core"]);
```

`semanticProblems` 開頭加：

```ts
if (RESERVED_PLUGIN_IDS.has(manifest.id))
  problems.push(problem("PLUGIN_E_RESERVED_ID", `${manifest.id} is reserved by Kobrixa.`));
```

`resolvePlugins` 判定重複 ID 前，先把所有 `source === "builtin"` 的 ID 放入 `seen`，讓內建插件不論在來源清單中的位置都先占用 ID：

```ts
const seen = new Set<string>(
  resolved
    .filter((plugin) => plugin.source === "builtin" && plugin.status !== "invalid")
    .map((plugin) => plugin.id),
);
```

並把迴圈中 `if (seen.has(plugin.id))` 改為 `if (plugin.source !== "builtin" && seen.has(plugin.id))`，迴圈末端只對非內建插件 `seen.add(plugin.id)`（內建已預先加入）。

`plugin-copy.ts` 加：

```ts
  PLUGIN_E_RESERVED_ID: ["這個插件 ID 由 Kobrixa 保留", "This plugin id is reserved by Kobrixa"],
```

- [ ] **Step 4: 執行確認通過**

Run: `pnpm --filter @kobrixa/plugin-runtime test && pnpm --filter @kobrixa/plugin-runtime build && pnpm --filter @kobrixa/desktop exec vitest run src/renderer/settings`
Expected: PASS（plugin-copy 若有「每個錯誤碼都有文案」測試，會涵蓋新代碼）。

- [ ] **Step 5: 格式化與 commit**

```bash
pnpm exec prettier --write packages/plugin-runtime/src/errors.ts packages/plugin-runtime/src/registry.ts packages/plugin-runtime/src/registry.test.ts apps/desktop/src/renderer/settings/plugin-copy.ts
pnpm exec eslint packages/plugin-runtime/src apps/desktop/src/renderer/settings/plugin-copy.ts
git add packages/plugin-runtime/src apps/desktop/src/renderer/settings/plugin-copy.ts
git commit -m "feat(plugins): reserve kobrixa.core and keep built-in ids ahead of development plugins"
```

---

### Task 3: `diagnosticHelp` 宣告、資源 schema、上限與 API 1.2.0

**Files:**

- Create: `packages/plugin-protocol/src/diagnostic-help.ts`
- Modify: `packages/plugin-protocol/src/limits.ts`（API 1.2.0、`DIAGNOSTIC_HELP_LIMITS`）
- Modify: `packages/plugin-protocol/src/manifest.ts`（`contributes.diagnosticHelp`）
- Modify: `packages/plugin-protocol/src/json-schema.ts`（`SCHEMA_DEFINITIONS` 加 `diagnostic-help`）
- Modify: `packages/plugin-protocol/src/index.ts`
- Modify: `packages/plugin-protocol/conformance/cases.json`
- Regenerate: `packages/plugin-protocol/schema/plugin-protocol.schema.json`、`sdks/python/kobrixa/plugin-protocol.schema.json`
- Modify: `sdks/python/kobrixa/_plugin.py:13`
- Modify（版本字串 1.1.0 → 1.2.0 的斷言）：`packages/plugin-sdk-js/src/index.test.ts`、`sdks/python/tests/test_plugin.py`、`packages/plugin-protocol/src/compiler-manifest.test.ts`
- Test: `packages/plugin-protocol/src/diagnostic-help.test.ts`（新）

**Interfaces:**

- Produces：
  - `DIAGNOSTIC_HELP_LIMITS = { fileBytes: 1_048_576, entriesPerPlugin: 512, entryBytes: 16_384, stepsPerLocale: 16, linksPerEntry: 4, urlLength: 2048, lineLength: 500, blockLength: 4000, totalBytes: 8_388_608 } as const`
  - `diagnosticHelpDeclSchema`（`{ version: 1; path: string }`）、`DiagnosticHelpDecl`
  - `diagnosticCodeSchema`、`diagnosticHelpKeySchema`
  - `pluginDiagnosticHelpFileSchema`、`PluginDiagnosticHelpFile`、`PluginDiagnosticHelpEntry`
  - `diagnosticHelpProblems(file: PluginDiagnosticHelpFile): string[]`（重複鍵、單筆序列化大小、URL 必須能以 `new URL()` 解析且 protocol 為 `https:`、host 非空）
  - `PLUGIN_API_VERSION = "1.2.0"`；JS `API_VERSION`、Python `API_VERSION` 同值。

- [ ] **Step 1: 寫失敗測試**

建立 `packages/plugin-protocol/src/diagnostic-help.test.ts`：

```ts
import { expect, it } from "vitest";
import {
  DIAGNOSTIC_HELP_LIMITS as L,
  PLUGIN_API_VERSION,
  diagnosticHelpProblems,
  pluginDiagnosticHelpFileSchema,
  pluginManifestSchema,
} from "./index.js";

const entry = (overrides: Record<string, unknown> = {}) => ({
  code: "ACME100",
  title: { en: "Thing failed", "zh-TW": "動作失敗" },
  cause: { en: "Because.\nReally." },
  steps: { en: ["Do it again."] },
  links: [{ url: "https://example.com/help", label: { en: "Docs" } }],
  ...overrides,
});
const parse = (entries: unknown[]) => pluginDiagnosticHelpFileSchema.safeParse({ entries });

it("is API 1.2.0", () => expect(PLUGIN_API_VERSION).toBe("1.2.0"));
it("accepts a minimal English entry and a helpKey variant", () => {
  expect(parse([entry(), entry({ helpKey: "missing-paren" })]).success).toBe(true);
});
it("rejects source, HTML-style extra fields and unknown keys", () => {
  expect(parse([entry({ source: "acme.x" })]).success).toBe(false);
  expect(parse([entry({ html: "<b>" })]).success).toBe(false);
});
it("rejects non-https and malformed links", () => {
  for (const url of [
    "http://example.com",
    "javascript:alert(1)",
    "https://",
    "file:///etc/passwd",
  ]) {
    const file = parse([entry({ links: [{ url, label: { en: "x" } }] })]);
    expect(file.success && diagnosticHelpProblems(file.data).length === 0).toBe(false);
  }
});
it("enforces every per-field limit at and over the bound", () => {
  const line = (n: number) => "a".repeat(n);
  expect(parse([entry({ title: { en: line(L.lineLength) } })]).success).toBe(true);
  expect(parse([entry({ title: { en: line(L.lineLength + 1) } })]).success).toBe(false);
  expect(parse([entry({ cause: { en: line(L.blockLength) } })]).success).toBe(true);
  expect(parse([entry({ cause: { en: line(L.blockLength + 1) } })]).success).toBe(false);
  expect(parse([entry({ steps: { en: Array(L.stepsPerLocale).fill("s") } })]).success).toBe(true);
  expect(parse([entry({ steps: { en: Array(L.stepsPerLocale + 1).fill("s") } })]).success).toBe(
    false,
  );
  const link = { url: "https://example.com", label: { en: "x" } };
  expect(parse([entry({ links: Array(L.linksPerEntry).fill(link) })]).success).toBe(true);
  expect(parse([entry({ links: Array(L.linksPerEntry + 1).fill(link) })]).success).toBe(false);
  const url = `https://example.com/${"a".repeat(L.urlLength - 20)}`;
  expect(parse([entry({ links: [{ url, label: { en: "x" } }] })]).success).toBe(true);
  expect(parse([entry({ links: [{ url: url + "a", label: { en: "x" } }] })]).success).toBe(false);
  const many = Array.from({ length: L.entriesPerPlugin }, (_, i) => entry({ code: `ACME${i}` }));
  expect(parse(many).success).toBe(true);
  expect(parse([...many, entry({ code: "ACMEX" })]).success).toBe(false);
});
it("rejects single-line fields with newlines", () => {
  expect(parse([entry({ title: { en: "a\nb" } })]).success).toBe(false);
});
it("reports duplicate keys and oversized entries semantically", () => {
  const dup = parse([entry(), entry()]);
  expect(dup.success && diagnosticHelpProblems(dup.data)).toEqual([
    expect.stringMatching(/ACME100.*more than once/),
  ]);
  const big = parse([
    entry({
      cause: { en: "a".repeat(L.blockLength), "zh-TW": "a".repeat(L.blockLength) },
      steps: {
        en: Array(16).fill("a".repeat(L.lineLength)),
        "zh-TW": Array(16).fill("a".repeat(L.lineLength)),
      },
    }),
  ]);
  expect(big.success && diagnosticHelpProblems(big.data)).toEqual([
    expect.stringMatching(/larger than 16 KiB/),
  ]);
});
it("declares help with a contained relative json path", () => {
  const base = {
    id: "acme.x",
    version: "1.0.0",
    apiVersion: "^1.2.0",
    runtime: { kind: "node", entry: "main.js" },
  };
  const ok = (path: string) =>
    pluginManifestSchema.safeParse({
      ...base,
      contributes: { diagnosticHelp: { version: 1, path } },
    }).success;
  expect(ok("help.json")).toBe(true);
  expect(ok("diagnostics/help.json")).toBe(true);
  for (const bad of [
    "../help.json",
    "/help.json",
    "a/../help.json",
    "help.txt",
    "./help.json",
    "a\\help.json",
  ])
    expect(ok(bad)).toBe(false);
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `pnpm --filter @kobrixa/plugin-protocol exec vitest run src/diagnostic-help.test.ts`
Expected: FAIL

- [ ] **Step 3: 實作 schema 與語意檢查**

`limits.ts`：第一行改為 `export const PLUGIN_API_VERSION = "1.2.0";`，並加入上方 Interfaces 列出的 `DIAGNOSTIC_HELP_LIMITS`。

建立 `packages/plugin-protocol/src/diagnostic-help.ts`：

```ts
import { z } from "zod";
import { MULTI_LINE, SINGLE_LINE } from "./common.js";
import { DIAGNOSTIC_HELP_LIMITS as L } from "./limits.js";

export const diagnosticCodeSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/);
export const diagnosticHelpKeySchema = z.string().regex(/^[a-z0-9-]{1,100}$/);
export const diagnosticHelpDeclSchema = z.strictObject({
  version: z.literal(1),
  path: z
    .string()
    .max(600)
    .regex(/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\/){0,7}[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\.json$/),
});
export type DiagnosticHelpDecl = z.infer<typeof diagnosticHelpDeclSchema>;

const line = z.string().min(1).max(L.lineLength).regex(SINGLE_LINE);
const block = z.string().min(1).max(L.blockLength).regex(MULTI_LINE);
const text = (value: z.ZodString) => z.strictObject({ en: value, "zh-TW": value.optional() });
const steps = z.array(line).min(1).max(L.stepsPerLocale);
const link = z.strictObject({
  // Parsed again by diagnosticHelpProblems(); the pattern only rules out controls and spaces.
  url: z
    .string()
    .max(L.urlLength)
    .regex(/^https:\/\/[^\u0000- \u007F]+$/),
  label: text(line),
});
export const pluginDiagnosticHelpEntrySchema = z.strictObject({
  code: diagnosticCodeSchema,
  helpKey: diagnosticHelpKeySchema.optional(),
  title: text(line),
  cause: text(block),
  steps: z.strictObject({ en: steps, "zh-TW": steps.optional() }),
  example: z.strictObject({ before: block, after: block }).optional(),
  links: z.array(link).max(L.linksPerEntry).optional(),
});
export const pluginDiagnosticHelpFileSchema = z.strictObject({
  entries: z.array(pluginDiagnosticHelpEntrySchema).max(L.entriesPerPlugin),
});
export type PluginDiagnosticHelpEntry = z.infer<typeof pluginDiagnosticHelpEntrySchema>;
export type PluginDiagnosticHelpFile = z.infer<typeof pluginDiagnosticHelpFileSchema>;

const encoder = new TextEncoder();
/** Relations JSON Schema cannot express; run after the structural parse. */
export function diagnosticHelpProblems(file: PluginDiagnosticHelpFile): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const entry of file.entries) {
    const key = `${entry.code}:${entry.helpKey ?? ""}`;
    const label = entry.helpKey ? `${entry.code}#${entry.helpKey}` : entry.code;
    if (keys.has(key)) problems.push(`Diagnostic help for ${label} is declared more than once.`);
    keys.add(key);
    if (encoder.encode(JSON.stringify(entry)).length > L.entryBytes)
      problems.push(`Diagnostic help for ${label} is larger than 16 KiB.`);
    for (const { url } of entry.links ?? []) {
      let parsed: URL | undefined;
      try {
        parsed = new URL(url);
      } catch {
        parsed = undefined;
      }
      if (!parsed || parsed.protocol !== "https:" || !parsed.hostname)
        problems.push(`Diagnostic help for ${label} has an invalid https link.`);
    }
  }
  return problems;
}
```

`manifest.ts`：匯入 `diagnosticHelpDeclSchema`，在 `contributes` 的 `backends` 後加 `diagnosticHelp: diagnosticHelpDeclSchema.optional(),`。

`json-schema.ts` 的 `SCHEMA_DEFINITIONS` 在 `manifest` 後加 `"diagnostic-help": pluginDiagnosticHelpFileSchema,`。`index.ts` 加 `export * from "./diagnostic-help.js";`。

`_plugin.py` 第 13 行改為 `API_VERSION = "1.2.0"`；把 Interfaces 中列出的三個測試檔的 `"1.1.0"` 斷言改為 `"1.2.0"`（`apiVersion: "^1.1.0"` 的 manifest fixture 保持不變，它們仍滿足 1.2.0）。

在 `conformance/cases.json` 末尾加入五個案例：

```json
  {
    "name": "diagnostic help file",
    "definition": "diagnostic-help",
    "valid": true,
    "value": { "entries": [{ "code": "ACME100", "title": { "en": "Failed" }, "cause": { "en": "Because" }, "steps": { "en": ["Retry"] }, "links": [{ "url": "https://example.com", "label": { "en": "Docs" } }] }] }
  },
  {
    "name": "diagnostic help rejects source",
    "definition": "diagnostic-help",
    "valid": false,
    "value": { "entries": [{ "code": "ACME100", "source": "acme.x", "title": { "en": "Failed" }, "cause": { "en": "Because" }, "steps": { "en": ["Retry"] } }] }
  },
  {
    "name": "diagnostic help rejects http link",
    "definition": "diagnostic-help",
    "valid": false,
    "value": { "entries": [{ "code": "ACME100", "title": { "en": "Failed" }, "cause": { "en": "Because" }, "steps": { "en": ["Retry"] }, "links": [{ "url": "http://example.com", "label": { "en": "Docs" } }] }] }
  },
  {
    "name": "manifest declares diagnostic help",
    "definition": "manifest",
    "valid": true,
    "value": { "id": "acme.x", "version": "1.0.0", "apiVersion": "^1.2.0", "runtime": { "kind": "node", "entry": "main.js" }, "contributes": { "diagnosticHelp": { "version": 1, "path": "diagnostics/help.json" } } }
  },
  {
    "name": "manifest rejects escaping diagnostic help path",
    "definition": "manifest",
    "valid": false,
    "value": { "id": "acme.x", "version": "1.0.0", "apiVersion": "^1.2.0", "runtime": { "kind": "node", "entry": "main.js" }, "contributes": { "diagnosticHelp": { "version": 1, "path": "../help.json" } } }
  }
```

- [ ] **Step 4: 重新產生 schema 並執行全部協定測試**

```bash
pnpm --filter @kobrixa/plugin-protocol schema
pnpm --filter @kobrixa/plugin-protocol test && pnpm --filter @kobrixa/plugin-sdk test && pnpm test:python-sdk
```

Expected: exporter 更新兩份產物，`$id` 為 `https://kobrixa.com/schemas/plugin-protocol/1.2.0.json`；schema drift、keyword allowlist（若 `diagnostic-help` 用到新 keyword，依 `schema/keywords.json` 的規則確認是否允許，不得改用 refine）、兩個 SDK initialize 與共用 conformance 全部通過；舊 `^1.0.0`、`^1.1.0` 插件仍有效。

- [ ] **Step 5: 格式化與 commit**

```bash
pnpm exec prettier --write packages/plugin-protocol/src packages/plugin-protocol/conformance/cases.json packages/plugin-sdk-js/src/index.test.ts
pnpm exec prettier --check packages/plugin-protocol/src packages/plugin-protocol/conformance/cases.json packages/plugin-sdk-js/src
pnpm exec eslint packages/plugin-protocol/src packages/plugin-sdk-js/src
pnpm --filter @kobrixa/plugin-protocol build
git add packages/plugin-protocol packages/plugin-sdk-js/src sdks/python
git commit -m "feat(protocol): add the diagnosticHelp contribution, resource schema and API 1.2.0"
```

---

### Task 4: 說明資源載入、目錄、revision 與合計上限

**Files:**

- Create: `packages/plugin-runtime/src/diagnostic-help.ts`
- Modify: `packages/plugin-runtime/src/errors.ts`（`PLUGIN_E_DIAGNOSTIC_HELP`）
- Modify: `packages/plugin-runtime/src/registry.ts`（`ReadPlugin`、`readDevelopmentPlugin`）
- Modify: `packages/plugin-runtime/src/manager.ts`（目錄、revision、summary）
- Modify: `packages/plugin-runtime/src/index.ts`
- Modify: `apps/desktop/src/renderer/settings/plugin-copy.ts`
- Test: `packages/plugin-runtime/src/diagnostic-help.test.ts`（新）、`packages/plugin-runtime/src/manager.test.ts`

**Interfaces:**

- Consumes：Task 3 的 `diagnosticHelpDeclSchema`、`pluginDiagnosticHelpFileSchema`、`diagnosticHelpProblems`、`DIAGNOSTIC_HELP_LIMITS`。
- Produces：
  - `interface LoadedDiagnosticHelp { entries: PluginDiagnosticHelpEntry[]; bytes: number }`
  - `readDiagnosticHelp(root: string, decl: DiagnosticHelpDecl, deps?: { stat(file: string): Promise<{ isFile(): boolean }> }): Promise<{ ok: true; help: LoadedDiagnosticHelp } | { ok: false; problem: PluginProblem }>`
  - `ReadPlugin` 新增 `diagnosticHelp?: LoadedDiagnosticHelp` 與 `helpProblem?: PluginProblem`（不放進 `problems`，因此不會讓插件 invalid）。
  - `interface DiagnosticHelpCatalog { revision: number; plugins: Array<{ source: string; sourceKey: string; entries: PluginDiagnosticHelpEntry[] }> }`
  - `PluginManager.diagnosticHelp(): DiagnosticHelpCatalog`
  - `PluginsSnapshot.diagnosticHelpRevision: number`
  - `PluginSummary.problems` 會包含讀取或合計超限的 `PLUGIN_E_DIAGNOSTIC_HELP`。

- [ ] **Step 1: 寫失敗的載入器測試**

建立 `packages/plugin-runtime/src/diagnostic-help.test.ts`：

```ts
import { mkdir, mkdtemp, rm, symlink, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DIAGNOSTIC_HELP_LIMITS } from "@kobrixa/plugin-protocol";
import { readDiagnosticHelp } from "./diagnostic-help.js";

let root: string;
let plugin: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-help-"));
  plugin = path.join(root, "plugin");
  await mkdir(plugin);
});
afterEach(() => rm(root, { recursive: true, force: true }));
const entry = {
  code: "ACME100",
  title: { en: "Failed" },
  cause: { en: "Because" },
  steps: { en: ["Retry"] },
};
const decl = (p = "help.json") => ({ version: 1 as const, path: p });
const write = (name: string, value: unknown) =>
  writeFile(path.join(plugin, name), typeof value === "string" ? value : JSON.stringify(value));

it("reads a valid file with a byte order mark", async () => {
  await write("help.json", `﻿${JSON.stringify({ entries: [entry] })}`);
  const result = await readDiagnosticHelp(plugin, decl());
  expect(result).toMatchObject({ ok: true, help: { entries: [entry] } });
});
it("rejects a symlink that escapes the plugin folder", async () => {
  await writeFile(path.join(root, "outside.json"), JSON.stringify({ entries: [entry] }));
  await symlink(path.join(root, "outside.json"), path.join(plugin, "help.json"));
  expect(await readDiagnosticHelp(plugin, decl())).toMatchObject({
    ok: false,
    problem: { code: "PLUGIN_E_DIAGNOSTIC_HELP" },
  });
});
it("rejects directories, missing files, invalid JSON and schema failures", async () => {
  await mkdir(path.join(plugin, "dir.json"));
  await write("bad.json", "{");
  await write("schema.json", { entries: [{ ...entry, source: "x.y" }] });
  await write("dup.json", { entries: [entry, entry] });
  for (const name of ["dir.json", "missing.json", "bad.json", "schema.json", "dup.json"])
    expect((await readDiagnosticHelp(plugin, decl(name))).ok).toBe(false);
});
it("accepts a file exactly at the size limit and rejects one byte more", async () => {
  const body = JSON.stringify({ entries: [entry] });
  const padded = body + " ".repeat(DIAGNOSTIC_HELP_LIMITS.fileBytes - Buffer.byteLength(body));
  await write("max.json", padded);
  await write("over.json", padded + " ");
  expect((await readDiagnosticHelp(plugin, decl("max.json"))).ok).toBe(true);
  expect(await readDiagnosticHelp(plugin, decl("over.json"))).toMatchObject({
    ok: false,
    problem: { message: expect.stringMatching(/1 MiB/) },
  });
});
it("rejects a file that grows past the limit after stat", async () => {
  await write("grow.json", JSON.stringify({ entries: [entry] }));
  // The size decision must come from the bounded read, not only from stat.
  const growingStat = async (file: string) => {
    const info = await stat(file);
    await appendFile(file, " ".repeat(DIAGNOSTIC_HELP_LIMITS.fileBytes));
    return info;
  };
  expect(await readDiagnosticHelp(plugin, decl("grow.json"), { stat: growingStat })).toMatchObject({
    ok: false,
    problem: { message: expect.stringMatching(/1 MiB/) },
  });
});
```

（檔頭匯入改為 `import { appendFile, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";`，並移除 `vi`。）

- [ ] **Step 2: 執行確認失敗**

Run: `pnpm --filter @kobrixa/plugin-protocol build && pnpm --filter @kobrixa/plugin-runtime exec vitest run src/diagnostic-help.test.ts`
Expected: FAIL

- [ ] **Step 3: 實作載入器**

`errors.ts` 加 `"PLUGIN_E_DIAGNOSTIC_HELP"`。建立 `packages/plugin-runtime/src/diagnostic-help.ts`：

```ts
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  DIAGNOSTIC_HELP_LIMITS,
  diagnosticHelpProblems,
  pluginDiagnosticHelpFileSchema,
  type DiagnosticHelpDecl,
  type PluginDiagnosticHelpEntry,
} from "@kobrixa/plugin-protocol";
import { messageOf, type PluginProblem } from "./errors.js";

export interface LoadedDiagnosticHelp {
  entries: PluginDiagnosticHelpEntry[];
  /** UTF-8 size of the file as read; counts toward DIAGNOSTIC_HELP_LIMITS.totalBytes. */
  bytes: number;
}
type Result = { ok: true; help: LoadedDiagnosticHelp } | { ok: false; problem: PluginProblem };
const fail = (file: string, reason: string): Result => ({
  ok: false,
  problem: { code: "PLUGIN_E_DIAGNOSTIC_HELP", message: `${file}: ${reason}` },
});

/** Reads one plugin's help resource without following links out of the plugin folder. */
export async function readDiagnosticHelp(
  root: string,
  decl: DiagnosticHelpDecl,
  // Injected only by tests that change the file between stat and read.
  deps: { stat: (file: string) => Promise<{ isFile(): boolean }> } = { stat },
): Promise<Result> {
  const limit = DIAGNOSTIC_HELP_LIMITS.fileBytes;
  let text: string;
  try {
    const base = await realpath(root);
    const file = await realpath(path.resolve(base, decl.path));
    const relative = path.relative(base, file);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      return fail(decl.path, "resolves outside the plugin folder.");
    if (!(await deps.stat(file)).isFile()) return fail(decl.path, "is not a regular file.");
    const handle = await open(file, "r");
    try {
      // Read one byte past the limit so a file that grew after stat is still rejected.
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
        if (length > limit) return fail(decl.path, "is larger than 1 MiB.");
      }
      text = buffer.subarray(0, length).toString("utf8").replace(/^﻿/, "");
    } finally {
      await handle.close();
    }
  } catch (error) {
    return fail(decl.path, `cannot be read: ${messageOf(error)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return fail(decl.path, `is not valid JSON: ${messageOf(error)}`);
  }
  const parsed = pluginDiagnosticHelpFileSchema.safeParse(value);
  if (!parsed.success)
    return fail(
      decl.path,
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    );
  const problems = diagnosticHelpProblems(parsed.data);
  if (problems.length) return fail(decl.path, problems.join(" "));
  return { ok: true, help: { entries: parsed.data.entries, bytes: Buffer.byteLength(text) } };
}
```

- [ ] **Step 4: 執行確認載入器通過**

Run: `pnpm --filter @kobrixa/plugin-runtime exec vitest run src/diagnostic-help.test.ts`
Expected: PASS

- [ ] **Step 5: 寫失敗的 manager 目錄測試**

在 `manager.test.ts` 末尾加入（沿用檔內的 `root`、`devPlugin`、`builtin`、`memoryStore`、`launcher`、`keyOf`；`readFile`、`writeFile` 已匯入）：

```ts
describe("diagnostic help", () => {
  const helpEntry = (code: string) => ({
    code,
    title: { en: "T" },
    cause: { en: "C" },
    steps: { en: ["S"] },
  });
  const writeHelp = (name: string, help: unknown) =>
    writeFile(
      path.join(root, name, "help.json"),
      typeof help === "string" ? help : JSON.stringify({ entries: help }),
    );
  async function helpPlugin(name: string, help: unknown) {
    const source = await devPlugin(name);
    const file = path.join(source.directory, "kobrixa-plugin.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.contributes.diagnosticHelp = { version: 1, path: "help.json" };
    await writeFile(file, JSON.stringify(manifest));
    await writeHelp(name, help);
    return source;
  }
  const createWith = (
    sources: Parameters<typeof PluginManager.create>[0]["sources"],
    options: { safeMode?: boolean; diagnosticHelpTotalBytes?: number } = {},
  ) =>
    PluginManager.create({
      sources,
      store: memoryStore(),
      safeMode: options.safeMode ?? false,
      launcher,
      locale: "en",
      now: () => 1000,
      ...(options.diagnosticHelpTotalBytes === undefined
        ? {}
        : { diagnosticHelpTotalBytes: options.diagnosticHelpTotalBytes }),
    });

  it("publishes enabled plugins' help and drops it when disabled or reloaded", async () => {
    const source = await helpPlugin("one", [helpEntry("ACME100")]);
    const manager = await createWith([builtin, source]);
    const first = manager.diagnosticHelp();
    expect(first.plugins).toEqual([
      expect.objectContaining({
        source: "acme.one",
        sourceKey: keyOf(source),
        entries: [expect.objectContaining({ code: "ACME100" })],
      }),
    ]);
    expect(manager.state().diagnosticHelpRevision).toBe(first.revision);
    await manager.setEnabled(keyOf(source), false);
    const disabled = manager.diagnosticHelp();
    expect(disabled.plugins).toEqual([]);
    expect(disabled.revision).toBeGreaterThan(first.revision);
    await manager.setEnabled(keyOf(source), true);
    await writeHelp("one", [helpEntry("ACME200")]);
    await manager.reloadSource(keyOf(source));
    expect(manager.diagnosticHelp().plugins[0]!.entries[0]!.code).toBe("ACME200");
  });
  it("keeps the plugin enabled when its help file is invalid", async () => {
    const source = await helpPlugin("broken", "{");
    const manager = await createWith([source]);
    const summary = manager.state().plugins.find((item) => item.sourceKey === keyOf(source))!;
    expect(summary.status).toBe("enabled");
    expect(summary.problems.map((item) => item.code)).toEqual(["PLUGIN_E_DIAGNOSTIC_HELP"]);
    expect(manager.diagnosticHelp().plugins).toEqual([]);
  });
  it("does not read help in safe mode", async () => {
    const source = await helpPlugin("safe", [helpEntry("ACME100")]);
    const manager = await createWith([source], { safeMode: true });
    expect(manager.diagnosticHelp().plugins).toEqual([]);
  });
  it("fails the first plugin by source key that exceeds the total budget", async () => {
    const sources = await Promise.all(
      ["a", "b", "c"].map((name) => helpPlugin(name, [helpEntry("ACME100")])),
    );
    const size = Buffer.byteLength(await readFile(path.join(root, "a", "help.json")));
    const manager = await createWith(sources, { diagnosticHelpTotalBytes: size * 2 });
    const keys = sources.map(keyOf).sort();
    expect(manager.diagnosticHelp().plugins.map((item) => item.sourceKey)).toEqual(
      keys.slice(0, 2),
    );
    const last = manager.state().plugins.find((item) => item.sourceKey === keys[2])!;
    expect(last.status).toBe("enabled");
    expect(last.problems.map((item) => item.code)).toContain("PLUGIN_E_DIAGNOSTIC_HELP");
  });
});
```

- [ ] **Step 6: 執行確認失敗**

Run: `pnpm --filter @kobrixa/plugin-runtime exec vitest run src/manager.test.ts`
Expected: FAIL

- [ ] **Step 7: 實作 registry 與 manager**

`registry.ts`：`ReadPlugin` 加

```ts
  /** Loaded help resource; absent when undeclared, unread or invalid. */
  diagnosticHelp?: LoadedDiagnosticHelp;
  /** A broken help resource disables only the help, never the plugin. */
  helpProblem?: PluginProblem;
```

`readDevelopmentPlugin` 在成功解析 entry、回傳 `{ ...plugin, entry }` 之前讀取說明（仍在 `readSource` 的逾時競賽內）：

```ts
const decl = plugin.manifest?.contributes?.diagnosticHelp;
if (!decl) return { ...plugin, entry };
const help = await readDiagnosticHelp(root, decl);
return help.ok
  ? { ...plugin, entry, diagnosticHelp: help.help }
  : { ...plugin, entry, helpProblem: help.problem };
```

`manager.ts`：

- `PluginManagerOptions` 加 `diagnosticHelpTotalBytes?: number`（預設 `DIAGNOSTIC_HELP_LIMITS.totalBytes`，只供測試調低）。
- `PluginsSnapshot` 加 `diagnosticHelpRevision: number`；`state()` 填入 `this.#help.revision`。
- 新欄位 `#help: { revision: number; key: string; catalog: DiagnosticHelpCatalog["plugins"]; overBudget: Set<string> }`。
- `#reconcile()` 末尾呼叫 `this.#rebuildHelp()`：

```ts
  #rebuildHelp(): void {
    const budget = this.options.diagnosticHelpTotalBytes ?? DIAGNOSTIC_HELP_LIMITS.totalBytes;
    const contributors = this.#entries
      .filter((entry) => entry.plugin.status === "enabled" && entry.read.diagnosticHelp)
      .sort((a, b) => (a.read.sourceKey < b.read.sourceKey ? -1 : a.read.sourceKey > b.read.sourceKey ? 1 : 0));
    const key = contributors.map((entry) => `${entry.read.sourceKey}@${entry.generation}`).join("\n");
    if (key === this.#help.key) return;
    let total = 0;
    const catalog: DiagnosticHelpCatalog["plugins"] = [];
    const overBudget = new Set<string>();
    for (const entry of contributors) {
      const help = entry.read.diagnosticHelp!;
      if (total + help.bytes > budget) {
        overBudget.add(entry.read.sourceKey);
        continue;
      }
      total += help.bytes;
      catalog.push({ source: entry.plugin.id, sourceKey: entry.read.sourceKey, entries: help.entries });
    }
    this.#help = { revision: this.#help.revision + 1, key, catalog, overBudget };
  }

  diagnosticHelp(): DiagnosticHelpCatalog {
    return structuredClone({ revision: this.#help.revision, plugins: this.#help.catalog });
  }
```

初始值 `{ revision: 0, key: "", catalog: [], overBudget: new Set() }`。`reloadSource` 會遞增 `entry.generation` 並重新讀取，因此 key 改變、revision 遞增。

- `#summary` 的 `problems` 改為：

```ts
      problems: [
        ...plugin.problems,
        ...(plugin.status === "enabled" && plugin.helpProblem ? [plugin.helpProblem] : []),
        ...(this.#help.overBudget.has(plugin.sourceKey)
          ? [{ code: "PLUGIN_E_DIAGNOSTIC_HELP" as const,
               message: "Diagnostic help was not loaded because all plugins' help exceeds 8 MiB." }]
          : []),
        ...(supervisor?.problem ? [supervisor.problem] : []),
      ],
```

（`RegisteredPlugin` 由 `ReadPlugin` 展開而來，已帶有 `helpProblem`／`diagnosticHelp`。）

`index.ts` 匯出 `readDiagnosticHelp`、`LoadedDiagnosticHelp`、`DiagnosticHelpCatalog`。`plugin-copy.ts` 加：

```ts
  PLUGIN_E_DIAGNOSTIC_HELP: ["無法載入插件的診斷說明", "The plugin's diagnostic help could not be loaded"],
```

- [ ] **Step 8: 執行確認通過**

Run: `pnpm --filter @kobrixa/plugin-runtime test && pnpm --filter @kobrixa/plugin-runtime build`
Expected: PASS（既有 `state()` 快照斷言若因新欄位 `diagnosticHelpRevision` 失敗，更新期望值）。

- [ ] **Step 9: 格式化與 commit**

```bash
pnpm exec prettier --write packages/plugin-runtime/src apps/desktop/src/renderer/settings/plugin-copy.ts
pnpm exec eslint packages/plugin-runtime/src apps/desktop/src/renderer/settings/plugin-copy.ts
git add packages/plugin-runtime/src apps/desktop/src/renderer/settings/plugin-copy.ts
git commit -m "feat(plugins): load bounded diagnostic help resources into a revisioned catalog"
```

---

### Task 5: 內建擁有者、`getBuiltinDiagnosticHelp`、`resolveDiagnosticHelp` 與網址鎖定

**Files:**

- Modify: `packages/compiler/src/diagnostic-help.ts`（擁有者與來源查詢，置於檔尾的查詢函式旁）
- Create: `apps/desktop/src/shared/diagnostic-help.ts`
- Test: `packages/compiler/src/diagnostic-help.test.ts`、`apps/desktop/src/shared/diagnostic-help.test.ts`（新）、`apps/web/src/features/docs/diagnostic-urls.test.ts`（新）

**Interfaces:**

- Produces（`@kobrixa/compiler/diagnostic-help`，browser-safe，不匯入 Node 模組）：
  - `BUILTIN_DIAGNOSTIC_SOURCES = ["kobrixa.core", "kobrixa.basic-plus", "kobrixa.ev3"] as const`、`type BuiltinDiagnosticSource`
  - `isBuiltinDiagnosticSource(source: string): source is BuiltinDiagnosticSource`
  - `SHARED_BUILTIN_HELP: Readonly<Record<string, readonly BuiltinDiagnosticSource[]>>`（`{ EV32031: ["kobrixa.basic-plus", "kobrixa.ev3"] }`）
  - `builtinHelpOwners(code: string): readonly BuiltinDiagnosticSource[]`
  - `getBuiltinDiagnosticHelp(source: string, code: string, helpKey?: string): DiagnosticHelp | undefined`
- Produces（`apps/desktop/src/shared/diagnostic-help.ts`）：
  - `interface PluginHelpCatalogView { revision: number; plugins: Record<string, { displayName?: LocalizedText; entries: PluginDiagnosticHelpEntry[] }> }`（以 source 為鍵）
  - `type ResolvedHelp = { kind: "builtin"; help: DiagnosticHelp } | { kind: "plugin"; source: string; entry: PluginDiagnosticHelpEntry }`
  - `resolveDiagnosticHelp(diagnostic: Pick<PublishedDiagnostic, "source" | "code" | "helpKey">, catalog: PluginHelpCatalogView | undefined): ResolvedHelp | undefined`
  - `interface HelpText { title: string; cause: string; steps: string[]; example?: { before: string; after: string } }`
  - `localizeHelp(resolved: ResolvedHelp, locale: DiagnosticLocale): HelpText`（插件條目缺 `zh-TW` 時退回 `en`）
  - `diagnosticIdentity(item: PublishedDiagnostic): string`（含 source、code、helpKey、severity、file、range、message）
  - `diagnosticSourceLabel(source: string, catalog: PluginHelpCatalogView | undefined, locale: DiagnosticLocale): string`（core → `"Kobrixa"`；插件 → displayName 在地化或 ID）

- [ ] **Step 1: 寫失敗的內建擁有者測試**

在 `packages/compiler/src/diagnostic-help.test.ts` 加入：

```ts
import {
  DIAGNOSTIC_HELP,
  DIAGNOSTIC_HELP_VARIANTS,
  SHARED_BUILTIN_HELP,
  builtinHelpOwners,
  diagnosticDocumentationUrl,
  getBuiltinDiagnosticHelp,
  getDiagnosticHelp,
} from "./diagnostic-help.js";

it("assigns every built-in entry to at least one owner and only listed codes to several", () => {
  for (const help of [...DIAGNOSTIC_HELP, ...DIAGNOSTIC_HELP_VARIANTS]) {
    const owners = builtinHelpOwners(help.code);
    expect(owners.length, help.code).toBeGreaterThan(0);
    expect(owners.length > 1, help.code).toBe(Object.hasOwn(SHARED_BUILTIN_HELP, help.code));
  }
  expect(builtinHelpOwners("BP1015")).toEqual(["kobrixa.basic-plus"]);
  expect(builtinHelpOwners("EV39000")).toEqual(["kobrixa.ev3"]);
  expect(builtinHelpOwners("BUILD1007")).toEqual(["kobrixa.core"]);
  expect(builtinHelpOwners("EV32031")).toEqual(["kobrixa.basic-plus", "kobrixa.ev3"]);
});
it("never falls back across sources", () => {
  expect(getBuiltinDiagnosticHelp("kobrixa.basic-plus", "BP1015")).toBe(
    getDiagnosticHelp("BP1015"),
  );
  expect(getBuiltinDiagnosticHelp("kobrixa.ev3", "BP1015")).toBeUndefined();
  expect(getBuiltinDiagnosticHelp("acme.x", "BP1015")).toBeUndefined();
  expect(getBuiltinDiagnosticHelp("kobrixa.basic-plus", "EV32031")).toBeDefined();
});
it("keeps helpKey variants and same-source fallback", () => {
  const variant = DIAGNOSTIC_HELP_VARIANTS[0]!;
  const owner = builtinHelpOwners(variant.code)[0]!;
  expect(getBuiltinDiagnosticHelp(owner, variant.code, variant.helpKey)).toBe(variant);
  expect(getBuiltinDiagnosticHelp(owner, variant.code, "no-such-key")).toBe(
    getDiagnosticHelp(variant.code),
  );
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `pnpm --filter @kobrixa/compiler exec vitest run src/diagnostic-help.test.ts`
Expected: FAIL

- [ ] **Step 3: 實作內建擁有者**

在 `diagnostic-help.ts` 的 `getDiagnosticHelp` 之後加入：

```ts
export const BUILTIN_DIAGNOSTIC_SOURCES = [
  "kobrixa.core",
  "kobrixa.basic-plus",
  "kobrixa.ev3",
] as const;
export type BuiltinDiagnosticSource = (typeof BUILTIN_DIAGNOSTIC_SOURCES)[number];
export const isBuiltinDiagnosticSource = (source: string): source is BuiltinDiagnosticSource =>
  (BUILTIN_DIAGNOSTIC_SOURCES as readonly string[]).includes(source);

/** Catalog entries emitted by more than one built-in provider. */
export const SHARED_BUILTIN_HELP: Readonly<Record<string, readonly BuiltinDiagnosticSource[]>> = {
  // Basic Plus lowering and the EV3 backend both validate Sensor.ReadSIValue arguments.
  EV32031: ["kobrixa.basic-plus", "kobrixa.ev3"],
};
// Ownership of this static catalog. Runtime diagnostics get their source from the host, never
// from these prefixes; the table only decides which source may show which built-in entry.
const CATALOG_OWNERS: ReadonlyArray<[RegExp, BuiltinDiagnosticSource]> = [
  [/^BP[0-9]{4}$/, "kobrixa.basic-plus"],
  [/^EV3[0-9]{4}$/, "kobrixa.ev3"],
  [/^(?:MAN|IR|BUILD)[0-9]{4}$/, "kobrixa.core"],
];
export function builtinHelpOwners(code: string): readonly BuiltinDiagnosticSource[] {
  if (!byCode.has(code)) return [];
  return (
    SHARED_BUILTIN_HELP[code] ??
    CATALOG_OWNERS.filter(([pattern]) => pattern.test(code)).map(([, owner]) => owner)
  );
}
export function getBuiltinDiagnosticHelp(
  source: string,
  code: string,
  helpKey?: string,
): DiagnosticHelp | undefined {
  return isBuiltinDiagnosticSource(source) && builtinHelpOwners(code).includes(source)
    ? getDiagnosticHelp(code, helpKey)
    : undefined;
}
```

（若某些 variant 的 code 不在 `byCode`，`builtinHelpOwners` 改為同時檢查 `DIAGNOSTIC_HELP_VARIANTS` 的代碼集合。）

- [ ] **Step 4: 執行確認通過**

Run: `pnpm --filter @kobrixa/compiler exec vitest run src/diagnostic-help.test.ts && pnpm --filter @kobrixa/compiler build`
Expected: PASS

- [ ] **Step 5: 寫失敗的統一查詢測試**

建立 `apps/desktop/src/shared/diagnostic-help.test.ts`：

```ts
import { expect, it } from "vitest";
import { getDiagnosticHelp } from "@kobrixa/compiler/diagnostic-help";
import {
  diagnosticIdentity,
  diagnosticSourceLabel,
  localizeHelp,
  resolveDiagnosticHelp,
  type PluginHelpCatalogView,
} from "./diagnostic-help.js";

const pluginEntry = (code: string, helpKey?: string) => ({
  code,
  ...(helpKey ? { helpKey } : {}),
  title: { en: `T ${code}${helpKey ?? ""}` },
  cause: { en: "C", "zh-TW": "原因" },
  steps: { en: ["S"] },
});
const catalog: PluginHelpCatalogView = {
  revision: 3,
  plugins: {
    "acme.x": {
      displayName: { en: "Acme", "zh-TW": "愛克米" },
      entries: [pluginEntry("BP1015"), pluginEntry("ACME1", "k")],
    },
  },
};

it("resolves built-in sources from the built-in catalog only", () => {
  expect(resolveDiagnosticHelp({ source: "kobrixa.basic-plus", code: "BP1015" }, catalog)).toEqual({
    kind: "builtin",
    help: getDiagnosticHelp("BP1015"),
  });
});
it("resolves plugin entries within their own source and never falls back across sources", () => {
  const own = resolveDiagnosticHelp({ source: "acme.x", code: "BP1015" }, catalog);
  expect(own).toMatchObject({
    kind: "plugin",
    source: "acme.x",
    entry: { title: { en: "T BP1015" } },
  });
  expect(resolveDiagnosticHelp({ source: "acme.y", code: "BP1015" }, catalog)).toBeUndefined();
  expect(resolveDiagnosticHelp({ source: "acme.x", code: "BP9999" }, catalog)).toBeUndefined();
});
it("prefers the helpKey variant and falls back to the code within the same source", () => {
  const exact = resolveDiagnosticHelp({ source: "acme.x", code: "ACME1", helpKey: "k" }, catalog);
  expect(exact).toMatchObject({ entry: { helpKey: "k" } });
  const fallback = resolveDiagnosticHelp(
    { source: "acme.x", code: "BP1015", helpKey: "zzz" },
    catalog,
  );
  expect(fallback).toMatchObject({ entry: { code: "BP1015" } });
});
it("localizes plugin text with an English fallback", () => {
  const resolved = resolveDiagnosticHelp({ source: "acme.x", code: "BP1015" }, catalog)!;
  expect(localizeHelp(resolved, "zh-TW")).toMatchObject({
    title: "T BP1015",
    cause: "原因",
    steps: ["S"],
  });
});
it("labels sources for markers", () => {
  expect(diagnosticSourceLabel("kobrixa.core", catalog, "en")).toBe("Kobrixa");
  expect(diagnosticSourceLabel("acme.x", catalog, "zh-TW")).toBe("愛克米");
  expect(diagnosticSourceLabel("acme.z", catalog, "en")).toBe("acme.z");
});
it("includes the source in the diagnostic identity", () => {
  const base = {
    code: "BP1015",
    severity: "error" as const,
    file: "a.bp",
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
    message: "m",
  };
  expect(diagnosticIdentity({ ...base, source: "kobrixa.basic-plus" })).toBe(
    diagnosticIdentity({ ...base, source: "kobrixa.basic-plus" }),
  );
  expect(diagnosticIdentity({ ...base, source: "kobrixa.basic-plus" })).not.toBe(
    diagnosticIdentity({ ...base, source: "acme.x" }),
  );
});
```

建立 `apps/web/src/features/docs/diagnostic-urls.test.ts`：

```ts
import { expect, it } from "vitest";
import {
  DIAGNOSTIC_HELP,
  DIAGNOSTIC_HELP_VARIANTS,
  diagnosticDocumentationUrl,
} from "@kobrixa/compiler/diagnostic-help";

it("keeps every official diagnostic URL format unchanged", () => {
  for (const help of [...DIAGNOSTIC_HELP, ...DIAGNOSTIC_HELP_VARIANTS])
    for (const locale of ["en", "zh-TW"] as const)
      expect(diagnosticDocumentationUrl(help.code, help.helpKey, locale)).toBe(
        `https://kobrixa.com/docs/diagnostics/${help.code}?lang=${locale}${help.helpKey ? `#${help.helpKey}` : ""}`,
      );
  expect(diagnosticDocumentationUrl("BP1015", undefined, "en")).toBe(
    "https://kobrixa.com/docs/diagnostics/BP1015?lang=en",
  );
});
```

- [ ] **Step 6: 執行確認失敗**

Run: `pnpm --filter @kobrixa/desktop exec vitest run src/shared/diagnostic-help.test.ts && pnpm --filter @kobrixa/web exec vitest run src/features/docs/diagnostic-urls.test.ts`
Expected: desktop FAIL（模組不存在）；web 測試應直接 PASS（它鎖定現況，作為回歸防線）。

- [ ] **Step 7: 實作統一查詢**

建立 `apps/desktop/src/shared/diagnostic-help.ts`：

```ts
import {
  getBuiltinDiagnosticHelp,
  isBuiltinDiagnosticSource,
  type DiagnosticHelp,
  type DiagnosticLocale,
} from "@kobrixa/compiler/diagnostic-help";
import type { PublishedDiagnostic } from "@kobrixa/compiler";
import type { LocalizedText, PluginDiagnosticHelpEntry } from "@kobrixa/plugin-protocol";

export interface PluginHelpCatalogView {
  revision: number;
  /** Keyed by diagnostic source (plugin id). */
  plugins: Record<string, { displayName?: LocalizedText; entries: PluginDiagnosticHelpEntry[] }>;
}
export type ResolvedHelp =
  | { kind: "builtin"; help: DiagnosticHelp }
  | { kind: "plugin"; source: string; entry: PluginDiagnosticHelpEntry };
export interface HelpText {
  title: string;
  cause: string;
  steps: string[];
  example?: { before: string; after: string };
}

export function resolveDiagnosticHelp(
  diagnostic: Pick<PublishedDiagnostic, "source" | "code" | "helpKey">,
  catalog: PluginHelpCatalogView | undefined,
): ResolvedHelp | undefined {
  const { source, code, helpKey } = diagnostic;
  if (isBuiltinDiagnosticSource(source)) {
    const help = getBuiltinDiagnosticHelp(source, code, helpKey);
    return help && { kind: "builtin", help };
  }
  const entries =
    catalog && Object.hasOwn(catalog.plugins, source) ? catalog.plugins[source]!.entries : [];
  const entry =
    (helpKey
      ? entries.find((item) => item.code === code && item.helpKey === helpKey)
      : undefined) ?? entries.find((item) => item.code === code && item.helpKey === undefined);
  return entry && { kind: "plugin", source, entry };
}

const pick = <T>(value: { en: T; "zh-TW"?: T }, locale: DiagnosticLocale): T =>
  locale === "zh-TW" ? (value["zh-TW"] ?? value.en) : value.en;

export function localizeHelp(resolved: ResolvedHelp, locale: DiagnosticLocale): HelpText {
  if (resolved.kind === "builtin") {
    const { help } = resolved;
    return {
      title: help.title[locale],
      cause: help.cause[locale],
      steps: help.steps[locale],
      ...(help.example
        ? { example: { before: help.example.before, after: help.example.after } }
        : {}),
    };
  }
  const { entry } = resolved;
  return {
    title: pick(entry.title, locale),
    cause: pick(entry.cause, locale),
    steps: pick(entry.steps, locale),
    ...(entry.example ? { example: entry.example } : {}),
  };
}

export function diagnosticSourceLabel(
  source: string,
  catalog: PluginHelpCatalogView | undefined,
  locale: DiagnosticLocale,
): string {
  if (source === "kobrixa.core") return "Kobrixa";
  const name =
    catalog && Object.hasOwn(catalog.plugins, source)
      ? catalog.plugins[source]!.displayName
      : undefined;
  if (name === undefined) return source;
  return typeof name === "string" ? name : pick(name, locale);
}

export const diagnosticIdentity = (item: PublishedDiagnostic): string =>
  JSON.stringify([
    item.source,
    item.code,
    item.helpKey ?? null,
    item.severity,
    item.file,
    item.range.startLine,
    item.range.startColumn,
    item.range.endLine,
    item.range.endColumn,
    item.message,
  ]);
```

（`displayName` 為 `LocalizedText`：字串或 `{ en, "zh-TW"? }`。內建插件的顯示名稱由 Task 7 的 controller 一併放進 `plugins`，即使它們沒有說明條目。）

- [ ] **Step 8: 執行確認通過**

Run: `pnpm --filter @kobrixa/desktop exec vitest run src/shared/diagnostic-help.test.ts && pnpm --filter @kobrixa/web exec vitest run src/features/docs`
Expected: PASS

- [ ] **Step 9: 格式化與 commit**

```bash
pnpm exec prettier --write packages/compiler/src/diagnostic-help.ts packages/compiler/src/diagnostic-help.test.ts apps/desktop/src/shared/diagnostic-help.ts apps/desktop/src/shared/diagnostic-help.test.ts apps/web/src/features/docs/diagnostic-urls.test.ts
pnpm exec eslint packages/compiler/src/diagnostic-help.ts packages/compiler/src/diagnostic-help.test.ts apps/desktop/src/shared/diagnostic-help.ts apps/desktop/src/shared/diagnostic-help.test.ts apps/web/src/features/docs/diagnostic-urls.test.ts
git add packages/compiler/src/diagnostic-help.ts packages/compiler/src/diagnostic-help.test.ts apps/desktop/src/shared/diagnostic-help.ts apps/desktop/src/shared/diagnostic-help.test.ts apps/web/src/features/docs/diagnostic-urls.test.ts
git commit -m "feat(diagnostics): resolve help by source with explicit built-in catalog ownership"
```

---

### Task 6: 語言分析加註、Quick Fix 來源比對與 Basic Plus 專屬代碼

**Files:**

- Modify: `apps/desktop/src/shared/language-sync.ts`（`PublishedAnalysis`）
- Modify: `apps/desktop/src/main/language/language-worker.ts`、`language.ts`、`language-protocol.ts`
- Modify: `apps/desktop/src/main/language/quick-fix-request.ts`
- Modify: `apps/desktop/src/shared/quick-fixes.ts`
- Create: `apps/desktop/src/shared/basic-plus-quick-fixes.ts`
- Modify: `apps/desktop/src/shared/api.ts`、`apps/desktop/src/renderer/editor/{analysis-session,analysis-transport,semantic-tokens,editor,language-features}.ts(x)`、`apps/desktop/src/renderer/workbench/diagnostic-details.tsx`（`BasicPlusProjectAnalysis` → `PublishedAnalysis` 與 Quick Fix 閘門）
- Test: `apps/desktop/src/main/language/language.test.ts`、`apps/desktop/src/shared/quick-fixes.test.ts`（新）、`apps/desktop/src/main/language/quick-fix-request.test.ts`（新）

**Interfaces:**

- Consumes：Task 1 的 `stampDiagnostics`、`PublishedDiagnostic`。
- Produces：
  - `type PublishedAnalysis = Omit<BasicPlusProjectAnalysis, "diagnostics"> & { diagnostics: PublishedDiagnostic[] }`；`emptyAnalysis(): PublishedAnalysis`；`diffAnalysis`／`applyAnalysis` 改用 `PublishedAnalysis`；`AnalysisPatch.diagnostics?: PublishedDiagnostic[]`。
  - `QuickFixRequest.diagnostic: Pick<PublishedDiagnostic, "source" | "code" | "helpKey" | "range">`
  - `sameDiagnostic(a, b)` 比較 `source`。
  - `BASIC_PLUS_SOURCE = "kobrixa.basic-plus"`、`BASIC_PLUS_QUICK_FIX_CODES: ReadonlySet<string>`、`offersBasicPlusQuickFix(d: Pick<PublishedDiagnostic, "source" | "code">): boolean`
  - `QUICK_FIX_CODES` 自 `shared/quick-fixes.ts` 移除。

- [ ] **Step 1: 寫失敗測試**

建立 `apps/desktop/src/shared/quick-fixes.test.ts`：

```ts
import { expect, it } from "vitest";
import { sameDiagnostic } from "./quick-fixes.js";
import { offersBasicPlusQuickFix } from "./basic-plus-quick-fixes.js";

const range = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 };
it("treats diagnostics from different sources as different", () => {
  const a = { source: "kobrixa.basic-plus", code: "BP1015", range };
  expect(sameDiagnostic(a, { ...a })).toBe(true);
  expect(sameDiagnostic(a, { ...a, source: "acme.x" })).toBe(false);
});
it("only offers Basic Plus fixes for Basic Plus diagnostics", () => {
  expect(offersBasicPlusQuickFix({ source: "kobrixa.basic-plus", code: "BP1015" })).toBe(true);
  expect(offersBasicPlusQuickFix({ source: "acme.x", code: "BP1015" })).toBe(false);
  expect(offersBasicPlusQuickFix({ source: "kobrixa.basic-plus", code: "BP9999" })).toBe(false);
});
```

建立 `apps/desktop/src/main/language/quick-fix-request.test.ts`：

```ts
import { expect, it } from "vitest";
import { quickFixRequestSchema } from "./quick-fix-request.js";

const request = (diagnostic: Record<string, unknown>) => ({
  requestId: "r1",
  session: "s",
  revision: 1,
  analysisVersion: 1,
  file: "main.bp",
  diagnostic: { range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, ...diagnostic },
});
it("requires a source and accepts plugin code formats", () => {
  expect(quickFixRequestSchema.safeParse(request({ code: "BP1015" })).success).toBe(false);
  expect(
    quickFixRequestSchema.safeParse(request({ code: "BP1015", source: "kobrixa.basic-plus" }))
      .success,
  ).toBe(true);
  expect(
    quickFixRequestSchema.safeParse(request({ code: "ACME.e-1", source: "acme.x" })).success,
  ).toBe(true);
  expect(quickFixRequestSchema.safeParse(request({ code: "1BAD", source: "acme.x" })).success).toBe(
    false,
  );
  expect(
    quickFixRequestSchema.safeParse(request({ code: "BP1015", source: "Not An Id" })).success,
  ).toBe(false);
});
```

在 `language.test.ts` 的 `describe("LanguageService background checks")` 內加入（沿用檔內的 `service`、`root`、`applyAnalysis`、`LanguageSyncRequest`）：

```ts
it("publishes analysis diagnostics as Basic Plus and loader diagnostics as core", async () => {
  expect(await service.diagnostics("workspace", { "main.bp": "Unknown.Do()\n" })).toEqual([
    expect.objectContaining({ code: "BP3001", source: "kobrixa.basic-plus" }),
  ]);
  await writeFile(path.join(root, "kobrixa.json"), "{");
  const loader = await service.diagnostics("workspace", {});
  expect(loader.length).toBeGreaterThan(0);
  expect(loader.every((item) => item.source === "kobrixa.core")).toBe(true);
});

it("returns stale when the requested source differs from the published diagnostic", async () => {
  const request: LanguageSyncRequest = {
    session: "source-test",
    revision: 1,
    baseRevision: null,
    analysisBase: null,
    overlays: { set: { "main.bp": "LCD.Clear( ' comment\n" }, removed: [] },
  };
  const reply = await service.sync("workspace", request);
  if (reply.kind !== "result") throw new Error("resync");
  const diagnostic = applyAnalysis(undefined, reply.patch).analysis.diagnostics.find(
    (d) => d.code === "BP1043",
  )!;
  expect(diagnostic.source).toBe("kobrixa.basic-plus");
  const query = {
    requestId: "source-query",
    session: request.session,
    revision: request.revision,
    analysisVersion: reply.patch.version,
    file: "main.bp",
    diagnostic,
  };
  expect(
    await service.quickFixes("workspace", {
      ...query,
      requestId: "forged",
      diagnostic: { ...diagnostic, source: "acme.x" },
    }),
  ).toEqual({ kind: "stale" });
  expect(await service.quickFixes("workspace", query)).toMatchObject({ kind: "result" });
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `pnpm --filter @kobrixa/desktop exec vitest run src/shared/quick-fixes.test.ts src/main/language`
Expected: FAIL

- [ ] **Step 3: 實作**

建立 `apps/desktop/src/shared/basic-plus-quick-fixes.ts`：把 `shared/quick-fixes.ts` 中的 `QUICK_FIX_CODES` 內容原樣搬來並改名：

```ts
import type { PublishedDiagnostic } from "@kobrixa/compiler";

export const BASIC_PLUS_SOURCE = "kobrixa.basic-plus";
/** Codes the Basic Plus parser can repair; other providers' codes never qualify. */
export const BASIC_PLUS_QUICK_FIX_CODES: ReadonlySet<string> = new Set([
  "BP1015",
  "BP1024",
  "BP1013",
  "BP1040",
  "BP1043",
  "BP1033",
  "BP1034",
  "BP1014",
  "BP1030",
  "BP1031",
  "BP1035",
]);
export const offersBasicPlusQuickFix = (
  diagnostic: Pick<PublishedDiagnostic, "source" | "code">,
): boolean =>
  diagnostic.source === BASIC_PLUS_SOURCE && BASIC_PLUS_QUICK_FIX_CODES.has(diagnostic.code);
```

`shared/quick-fixes.ts`：刪除 `QUICK_FIX_CODES`；`QuickFixRequest.diagnostic` 與 `sameDiagnostic` 參數型別改為 `Pick<PublishedDiagnostic, "source" | "code" | "helpKey" | "range">`；`sameDiagnostic` 第一行加 `a.source === b.source &&`。

`quick-fix-request.ts` 的 `diagnostic` 物件改為：

```ts
    diagnostic: z
      .object({
        source: namespacedIdSchema,
        code: diagnosticCodeSchema,
        helpKey: diagnosticHelpKeySchema.optional(),
        range: /* 原 range schema 不變 */,
      })
      .strict(),
```

並自 `@kobrixa/plugin-protocol` 匯入 `namespacedIdSchema`、`diagnosticCodeSchema`、`diagnosticHelpKeySchema`（desktop 已依賴此套件；若 package.json 沒有，加入 `"@kobrixa/plugin-protocol": "workspace:*"` 並以 `pnpm install --lockfile-only --ignore-scripts --offline` 更新 lockfile）。

`language-sync.ts`：

```ts
export type PublishedAnalysis = Omit<BasicPlusProjectAnalysis, "diagnostics"> & {
  diagnostics: PublishedDiagnostic[];
};
```

`AnalysisPatch.diagnostics` 改為 `PublishedDiagnostic[]`；`emptyAnalysis`、`diffAnalysis`、`applyAnalysis` 的 `BasicPlusProjectAnalysis` 改為 `PublishedAnalysis`。把 Files 中列出的 desktop 檔案裡的 `BasicPlusProjectAnalysis` 型別引用改為 `PublishedAnalysis`（只換型別，不改邏輯）。

`language-worker.ts`：`history` 型別改為 `Map<number, PublishedAnalysis>`；分析處改為：

```ts
let analysis: PublishedAnalysis;
if (!loaded.project) {
  if (!loaded.diagnostics.length) throw new Error("Choose an entry file before checking.");
  analysis = { ...emptyAnalysis(), diagnostics: requirePublished(loaded.diagnostics) };
} else {
  const raw = analyzer.analyze(loaded.project, signal);
  // 2B-1 compatibility adapter: the worker still hosts Basic Plus directly; 2B-2 stamps
  // the selected language-service provider instead.
  analysis = { ...raw, diagnostics: stampDiagnostics(raw.diagnostics, BASIC_PLUS_SOURCE) };
}
```

（載入器診斷由 `diagnostic()` 產生，已是 core；`stampDiagnostics` 若因分析器自帶 source 拋出 BUILD1007，由既有 catch 回 `{ ok: false, error }`。）Quick Fix 分支呼叫 `getBasicPlusQuickFixes` 前，以找到的已發布診斷判斷：

```ts
          const published = analysis?.diagnostics.find(
            (d) => d.file === query.file && sameDiagnostic(d, query.diagnostic),
          );
          if (
            request.workspaceId === currentWorkspaceId &&
            query.session === documentSession &&
            query.revision === documentRevision &&
            source !== undefined &&
            published !== undefined &&
            offersBasicPlusQuickFix(published)
          ) {
```

`getBasicPlusQuickFixes` 的第三個參數傳 `published`（只用 code／helpKey／range，與原本相同）。

renderer：`analysis-transport.ts` 的請求 `diagnostic` 加 `source: diagnostic.source`；`language-features.ts` 兩處與 `diagnostic-details.tsx` 一處的 `QUICK_FIX_CODES.has(diagnostic.code)` 改為 `offersBasicPlusQuickFix(diagnostic)`，並更新匯入。

- [ ] **Step 4: 執行確認通過**

Run: `pnpm --filter @kobrixa/desktop exec vitest run src/shared src/main/language src/renderer/editor src/renderer/workbench && pnpm --filter @kobrixa/desktop check`
Expected: PASS

- [ ] **Step 5: 格式化與 commit**

```bash
pnpm exec prettier --write apps/desktop/src/shared apps/desktop/src/main/language apps/desktop/src/renderer/editor apps/desktop/src/renderer/workbench/diagnostic-details.tsx
pnpm exec eslint apps/desktop/src/shared apps/desktop/src/main/language apps/desktop/src/renderer/editor apps/desktop/src/renderer/workbench/diagnostic-details.tsx
git add apps/desktop/src apps/desktop/package.json pnpm-lock.yaml
git commit -m "feat(language): stamp analysis sources and route quick fixes by published source"
```

---

### Task 7: 說明目錄 IPC、說明面板、marker、去重與文件連結

**Files:**

- Modify: `apps/desktop/src/shared/plugins.ts`（`PluginsApi.diagnosticHelp`）
- Modify: `apps/desktop/src/main/plugins/controller.ts`、`apps/desktop/src/main/plugins/ipc.ts`、`apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/shared/documentation.ts`、`apps/desktop/src/main/window/documentation.ts`、`apps/desktop/src/main/ipc.ts`
- Create: `apps/desktop/src/renderer/editor/diagnostic-help-store.ts`
- Modify: `apps/desktop/src/renderer/editor/diagnostic-presentation.ts`、`apps/desktop/src/renderer/editor/editor.tsx`、`apps/desktop/src/renderer/workbench/diagnostic-details.tsx`、`apps/desktop/src/renderer/workbench/bottom-panel.tsx`、`apps/desktop/src/renderer/app.tsx`
- Test: `apps/desktop/src/main/window/documentation.test.ts`、`apps/desktop/src/renderer/editor/diagnostic-help-store.test.ts`（新）、`apps/desktop/src/renderer/workbench/diagnostic-details.test.ts`、`apps/desktop/src/main/plugins/controller.test.ts`、`apps/desktop/src/main/plugins/ipc.test.ts`

**Interfaces:**

- Consumes：Task 4 的 `PluginManager.diagnosticHelp()`、`PluginsSnapshot.diagnosticHelpRevision`；Task 5 的 `PluginHelpCatalogView`、`resolveDiagnosticHelp`、`localizeHelp`、`diagnosticIdentity`、`diagnosticSourceLabel`、`getBuiltinDiagnosticHelp`、`isBuiltinDiagnosticSource`。
- Produces：
  - `PluginsApi.diagnosticHelp(): Promise<PluginHelpCatalogView>`；IPC channel `plugins:diagnosticHelp`。
  - `PluginsController.diagnosticHelp(): PluginHelpCatalogView`：由 manager 目錄轉成以 source 為鍵，並把所有啟用插件（含內建）的 `displayName` 放進 `plugins`（無說明者 `entries: []`）；revision 沿用 manager 目錄的 revision。
  - `PluginsController.diagnosticHelpEntry(source: string, code: string, helpKey?: string): PluginDiagnosticHelpEntry | undefined`（同 `resolveDiagnosticHelp` 的插件分支）。
  - `type DocumentationRequest = { source: string; code: string; helpKey?: string; locale: "zh-TW" | "en" } & ({ relatedIndex?: number } | { linkIndex: number })`
  - `documentationUrl(value: unknown, lookup: (source: string, code: string, helpKey?: string) => PluginDiagnosticHelpEntry | undefined): string`
  - `createDiagnosticHelpStore(api: Pick<PluginsApi, "diagnosticHelp" | "onEvent">): { subscribe(listener: () => void): () => void; getSnapshot(): PluginHelpCatalogView | undefined; dispose(): void }`
  - `diagnosticSummary(diagnostic, locale, catalog)`、`diagnosticMarkerMessage(diagnostic, locale, catalog)` 多一個 `catalog` 參數。

- [ ] **Step 1: 寫失敗的文件連結測試**

在 `documentation.test.ts` 加入（既有測試的請求補上 `source: "kobrixa.basic-plus"` 或對應的內建來源）：

```ts
const entry = {
  code: "BP1015",
  title: { en: "t" },
  cause: { en: "c" },
  steps: { en: ["s"] },
  links: [{ url: "https://acme.example/help", label: { en: "Acme" } }],
};
const lookup = (source: string, code: string) =>
  source === "acme.x" && code === "BP1015" ? entry : undefined;

it("opens official documentation only for the owning built-in source", () => {
  expect(
    documentationUrl({ source: "kobrixa.basic-plus", code: "BP1015", locale: "en" }, lookup),
  ).toBe("https://kobrixa.com/docs/diagnostics/BP1015?lang=en");
  expect(() =>
    documentationUrl({ source: "kobrixa.ev3", code: "BP1015", locale: "en" }, lookup),
  ).toThrow();
});
it("rejects official documentation for plugin sources", () => {
  expect(() =>
    documentationUrl({ source: "acme.x", code: "BP1015", locale: "en" }, lookup),
  ).toThrow();
  expect(() =>
    documentationUrl({ source: "acme.x", code: "BP1015", locale: "en", relatedIndex: 0 }, lookup),
  ).toThrow();
});
it("opens a plugin's own https link by index only", () => {
  expect(
    documentationUrl({ source: "acme.x", code: "BP1015", locale: "en", linkIndex: 0 }, lookup),
  ).toBe("https://acme.example/help");
  expect(() =>
    documentationUrl({ source: "acme.x", code: "BP1015", locale: "en", linkIndex: 1 }, lookup),
  ).toThrow();
  expect(() =>
    documentationUrl({ source: "acme.y", code: "BP1015", locale: "en", linkIndex: 0 }, lookup),
  ).toThrow();
  expect(() =>
    documentationUrl(
      { source: "kobrixa.basic-plus", code: "BP1015", locale: "en", linkIndex: 0 },
      lookup,
    ),
  ).toThrow();
  expect(() =>
    documentationUrl(
      { source: "acme.x", code: "BP1015", locale: "en", url: "https://evil" },
      lookup,
    ),
  ).toThrow();
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `pnpm --filter @kobrixa/desktop exec vitest run src/main/window/documentation.test.ts`
Expected: FAIL

- [ ] **Step 3: 實作文件請求與連結**

`shared/documentation.ts`：

```ts
interface DocumentationTarget {
  source: string;
  code: string;
  helpKey?: string;
  locale: "zh-TW" | "en";
}
export type DocumentationRequest = DocumentationTarget &
  ({ relatedIndex?: number } | { linkIndex: number });
```

`main/window/documentation.ts`：

```ts
const target = {
  source: namespacedIdSchema,
  code: diagnosticCodeSchema,
  helpKey: diagnosticHelpKeySchema.optional(),
  locale: z.enum(["zh-TW", "en"]),
};
const schema = z.union([
  z.object({ ...target, relatedIndex: z.number().int().nonnegative().optional() }).strict(),
  z.object({ ...target, linkIndex: z.number().int().nonnegative() }).strict(),
]);
export type PluginHelpLookup = (
  source: string,
  code: string,
  helpKey?: string,
) => PluginDiagnosticHelpEntry | undefined;

/** Resolve only authored catalog links, never renderer-supplied URLs. */
export function documentationUrl(value: unknown, lookup: PluginHelpLookup): string {
  const request = schema.parse(value);
  if ("linkIndex" in request) {
    if (isBuiltinDiagnosticSource(request.source))
      throw new Error("Built-in diagnostics have no plugin links.");
    const link = lookup(request.source, request.code, request.helpKey)?.links?.[request.linkIndex];
    if (!link) throw new Error("Unknown plugin help link.");
    const url = new URL(link.url);
    if (url.protocol !== "https:" || !url.hostname) throw new Error("Invalid plugin help link.");
    return url.toString();
  }
  const help = getBuiltinDiagnosticHelp(request.source, request.code, request.helpKey);
  if (!help) throw new Error("Unknown diagnostic documentation.");
  // 以下保留原本的官方網址與 related 連結邏輯，只把 getDiagnosticHelp 換成上面的 help。
}
```

`main/ipc.ts` 的 handler 改為 `shell.openExternal(documentationUrl(request, (source, code, helpKey) => plugins.diagnosticHelpEntry(source, code, helpKey)))`（`plugins` 為 ipc 註冊函式已可取得的 `PluginsController`；若目前 `registerIpc` 沒有傳入，從 `index.ts` 補傳）。

- [ ] **Step 4: 執行確認通過**

Run: `pnpm --filter @kobrixa/desktop exec vitest run src/main/window/documentation.test.ts`
Expected: PASS

- [ ] **Step 5: 寫失敗的 store、controller 與面板測試**

建立 `apps/desktop/src/renderer/editor/diagnostic-help-store.test.ts`：

```ts
import { expect, it, vi } from "vitest";
import { createDiagnosticHelpStore } from "./diagnostic-help-store.js";
import type { PluginHelpCatalogView } from "../../shared/diagnostic-help.js";

const view = (revision: number): PluginHelpCatalogView => ({ revision, plugins: {} });
function fakeApi() {
  let listener: ((event: unknown) => void) | undefined;
  const pending: Array<(value: PluginHelpCatalogView) => void> = [];
  return {
    api: {
      diagnosticHelp: vi.fn(
        () => new Promise<PluginHelpCatalogView>((resolve) => pending.push(resolve)),
      ),
      onEvent: (next: (event: unknown) => void) => {
        listener = next;
        return () => (listener = undefined);
      },
    },
    emitRevision: (revision: number) =>
      listener?.({ type: "state", state: { diagnosticHelpRevision: revision } }),
    resolve: (index: number, value: PluginHelpCatalogView) => pending[index]!(value),
  };
}

it("loads once and refetches only when the catalog revision changes", async () => {
  const fake = fakeApi();
  const store = createDiagnosticHelpStore(fake.api as never);
  fake.resolve(0, view(1));
  await Promise.resolve();
  expect(store.getSnapshot()?.revision).toBe(1);
  fake.emitRevision(1);
  expect(fake.api.diagnosticHelp).toHaveBeenCalledTimes(1);
  fake.emitRevision(2);
  expect(fake.api.diagnosticHelp).toHaveBeenCalledTimes(2);
});
it("ignores an older catalog that resolves after a newer one", async () => {
  const fake = fakeApi();
  const store = createDiagnosticHelpStore(fake.api as never);
  fake.emitRevision(5);
  fake.resolve(1, view(5));
  await Promise.resolve();
  fake.resolve(0, view(4));
  await Promise.resolve();
  expect(store.getSnapshot()?.revision).toBe(5);
});
```

在 `controller.test.ts` 的 `describe("PluginController with a fake manager")` 中：`snapshot` fixture 加 `diagnosticHelpRevision: 2`，`plugins` 再加一筆內建插件 `{ sourceKey: "builtin:kobrixa.basic-plus", id: "kobrixa.basic-plus", source: "builtin", runtime: "builtin", displayName: { en: "Basic Plus", "zh-TW": "Basic Plus" }, status: "enabled", running: false, problems: [], commands: [] }`（若既有測試依賴 `plugins` 長度，改用 `options.snapshot` 只在新測試傳入）；fake `manager` 加：

```ts
      diagnosticHelp: () => ({
        revision: 2,
        plugins: [{ source: "acme.hello", sourceKey: key, entries: [helpEntry] }],
      }),
```

並在 describe 開頭定義 `const helpEntry = { code: "ACME1", title: { en: "t" }, cause: { en: "c" }, steps: { en: ["s"] } };`。加入：

```ts
it("keys the help catalog by source and includes enabled plugins' names", () => {
  const { controller } = setup();
  expect(controller.diagnosticHelp()).toEqual({
    revision: 2,
    plugins: {
      "acme.hello": { entries: [helpEntry] },
      "kobrixa.basic-plus": {
        displayName: { en: "Basic Plus", "zh-TW": "Basic Plus" },
        entries: [],
      },
    },
  });
  expect(controller.diagnosticHelpEntry("acme.hello", "ACME1")).toEqual(helpEntry);
  expect(controller.diagnosticHelpEntry("acme.other", "ACME1")).toBeUndefined();
  expect(controller.diagnosticHelpEntry("kobrixa.basic-plus", "BP1015")).toBeUndefined();
});
```

在 `ipc.test.ts`：`plugins` fake 加 `diagnosticHelp: vi.fn(() => ({ revision: 0, plugins: {} })),`；「registers every plugin channel」的清單加 `"plugins:diagnosticHelp"`；加入：

```ts
it("forwards the diagnostic help catalog", () => {
  const { plugins, call } = setup();
  expect(call("plugins:diagnosticHelp")).toEqual({ revision: 0, plugins: {} });
  expect(plugins.diagnosticHelp).toHaveBeenCalledOnce();
});
```

在 `apps/desktop/src/renderer/workbench/diagnostic-details.test.ts` 中：檔頭 `diagnostic` fixture 加 `source: "kobrixa.basic-plus"`；`setup()` 的 `host` 加 `helpCatalog: undefined`；既有斷言 `toHaveBeenCalledWith({ code: "BP1043", locale: "zh-TW" })` 改為 `({ source: "kobrixa.basic-plus", code: "BP1043", locale: "zh-TW" })`。末尾加入：

```ts
const pluginCatalog = {
  revision: 1,
  plugins: {
    "acme.x": {
      displayName: { en: "Acme" },
      entries: [
        {
          code: "BP1043",
          title: { en: "Acme title" },
          cause: { en: "Acme cause" },
          steps: { en: ["Acme step"] },
          links: [{ url: "https://acme.example/help", label: { en: "Acme docs" } }],
        },
      ],
    },
  },
};

it("shows a plugin's own help with its links and no official link", async () => {
  const { host, render } = setup();
  host.helpCatalog = pluginCatalog;
  await render({ ...diagnostic, source: "acme.x" });
  expect(container.textContent).toContain("Acme title");
  expect(container.textContent).toContain("Provided by Acme");
  expect(container.textContent).not.toContain("Call is missing a closing parenthesis");
  expect(container.textContent).not.toContain("View this diagnostic online");
  expect(host.getQuickFixes).not.toHaveBeenCalled();
  const buttons = [...container.querySelectorAll<HTMLButtonElement>(".diagnostic-links button")];
  expect(buttons.map((button) => button.textContent)).toEqual(["Acme docs ↗"]);
  await act(() => buttons[0]!.click());
  expect(host.openDocumentation).toHaveBeenCalledWith({
    source: "acme.x",
    code: "BP1043",
    locale: "en",
    linkIndex: 0,
  });
});

it("keeps the original message when no help exists for the source", async () => {
  const { host, render } = setup();
  host.helpCatalog = pluginCatalog;
  await render({ ...diagnostic, source: "acme.y", message: "raw" });
  expect(container.textContent).toContain("Check the original message and source location.");
  expect(container.textContent).not.toContain("Call is missing a closing parenthesis");
  expect(container.querySelector(".diagnostic-original pre")?.textContent).toBe("raw");
  expect(container.querySelector(".diagnostic-links")).toBeNull();
});
```

在 `app.tsx` 的去重改用 `diagnosticIdentity` 後，於 `apps/desktop/src/shared/diagnostic-help.test.ts` 補：

```ts
it("merges same-source duplicates and keeps different sources apart", () => {
  const base = {
    code: "BP1015",
    severity: "error" as const,
    file: "a.bp",
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
    message: "m",
  };
  const live = { ...base, source: "kobrixa.basic-plus" };
  const build = { ...base, source: "kobrixa.basic-plus" };
  const other = { ...base, source: "acme.x" };
  const unique = new Map([live, build, other].map((item) => [diagnosticIdentity(item), item]));
  expect([...unique.values()]).toEqual([live, other]);
});
```

- [ ] **Step 6: 執行確認失敗**

Run: `pnpm --filter @kobrixa/desktop exec vitest run src/renderer/editor/diagnostic-help-store.test.ts src/main/plugins src/renderer/workbench src/shared/diagnostic-help.test.ts`
Expected: FAIL（新測試）

- [ ] **Step 7: 實作 IPC、store 與 UI**

`shared/plugins.ts` 的 `PluginsApi` 加 `diagnosticHelp(): Promise<PluginHelpCatalogView>;`。`main/plugins/ipc.ts` 加 `handle("plugins:diagnosticHelp", () => plugins.diagnosticHelp());`，`PluginIpcTarget` 型別加上此方法。`preload/index.ts` 的 `plugins` 加 `diagnosticHelp: () => ipcRenderer.invoke("plugins:diagnosticHelp"),`。

`controller.ts`：

```ts
  diagnosticHelp(): PluginHelpCatalogView {
    const catalog = this.deps.manager.diagnosticHelp();
    const plugins: PluginHelpCatalogView["plugins"] = Object.create(null);
    for (const plugin of this.deps.manager.state().plugins)
      if (plugin.status === "enabled")
        plugins[plugin.id] = { ...(plugin.displayName ? { displayName: plugin.displayName } : {}), entries: [] };
    for (const item of catalog.plugins)
      plugins[item.source] = { ...plugins[item.source], entries: item.entries };
    return { revision: catalog.revision, plugins };
  }

  diagnosticHelpEntry(source: string, code: string, helpKey?: string): PluginDiagnosticHelpEntry | undefined {
    const resolved = resolveDiagnosticHelp({ source, code, ...(helpKey ? { helpKey } : {}) }, this.diagnosticHelp());
    return resolved?.kind === "plugin" ? resolved.entry : undefined;
  }
```

（`deps.manager` 的 Pick 型別加 `"diagnosticHelp"`。）

建立 `renderer/editor/diagnostic-help-store.ts`：

```ts
import type { PluginsApi } from "../../shared/plugins.js";
import type { PluginHelpCatalogView } from "../../shared/diagnostic-help.js";

/** Keeps the newest plugin help catalog; an older response never replaces a newer one. */
export function createDiagnosticHelpStore(api: Pick<PluginsApi, "diagnosticHelp" | "onEvent">) {
  let current: PluginHelpCatalogView | undefined;
  let requested = -1;
  const listeners = new Set<() => void>();
  const load = () => {
    void api.diagnosticHelp().then(
      (next) => {
        if (current && next.revision <= current.revision) return;
        current = next;
        for (const listener of listeners) listener();
      },
      () => undefined,
    );
  };
  load();
  const off = api.onEvent((event) => {
    if (event.type !== "state") return;
    const revision = event.state.diagnosticHelpRevision;
    if (revision === requested || (current && revision <= current.revision)) return;
    requested = revision;
    load();
  });
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => current,
    dispose: off,
  };
}
```

`diagnostic-presentation.ts`：`diagnosticSummary(diagnostic, locale, catalog)` 改為 `const resolved = resolveDiagnosticHelp(diagnostic, catalog); return resolved ? localizeHelp(resolved, locale).title : diagnostic.message;`；`diagnosticMarkerMessage` 同樣改用 `resolveDiagnosticHelp`／`localizeHelp`，格式不變（`${code}: ${title}\n${cause}\n${steps[0] ?? ""}\n\n${message}`）。

`app.tsx`：建立一次 store（`useMemo(() => createDiagnosticHelpStore(window.kobrixa.plugins), [])`，unmount 時 `dispose`），以 `useSyncExternalStore(store.subscribe, store.getSnapshot)` 取得 `helpCatalog`，傳給 `Editor`、`BottomPanel`、`DiagnosticDetails`；去重改為：

```ts
const seen = new Set<string>();
return [...liveDiagnostics, ...buildDiagnostics].filter((item) => {
  const key = diagnosticIdentity(item);
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});
```

`editor.tsx` 的 marker：`source: diagnosticSourceLabel(item.source, helpCatalog, locale)`，`message: diagnosticMarkerMessage(item, locale, helpCatalog)`，effect 依賴加 `helpCatalog`。`bottom-panel.tsx` 傳入 `helpCatalog`。

`diagnostic-details.tsx`：

- `const resolved = resolveDiagnosticHelp(diagnostic, host.helpCatalog); const text = resolved && localizeHelp(resolved, locale);`，把原本 `help?.title[locale]`、`help?.cause[locale]`、`help.steps[locale]`、`help.example` 換成 `text?.title`、`text?.cause`、`text.steps`、`text?.example`。
- `resolved?.kind === "plugin"` 時在標題下顯示 `t("由 {name} 提供", "Provided by {name}")`（`name = diagnosticSourceLabel(diagnostic.source, host.helpCatalog, locale)`）。
- 連結區：`resolved?.kind === "builtin"` 時保留原本「在官網查看」與 `related` 按鈕，`open()` 請求加 `source: diagnostic.source`；`resolved?.kind === "plugin"` 時改為每個 `resolved.entry.links` 一個按鈕（標籤 `pick(label, locale) ↗`），點擊送 `{ source, code, helpKey?, locale, linkIndex }`。
- `DiagnosticDetailsHost` 加 `helpCatalog: PluginHelpCatalogView | undefined`。

- [ ] **Step 8: 執行確認通過**

Run: `pnpm --filter @kobrixa/plugin-runtime build && pnpm --filter @kobrixa/desktop exec vitest run && pnpm --filter @kobrixa/desktop check`
Expected: PASS

- [ ] **Step 9: 格式化與 commit**

```bash
pnpm exec prettier --write apps/desktop/src
pnpm exec prettier --check apps/desktop/src
pnpm exec eslint apps/desktop/src
git add apps/desktop/src
git commit -m "feat(desktop): show source-scoped diagnostic help, markers and plugin links"
```

---

## 全分支驗收

- [ ] **Step 1: 全部建置與測試**

```bash
pnpm -r build
pnpm test
pnpm test:bytecode
pnpm test:python-sdk
pnpm --filter @kobrixa/web test
pnpm exec prettier --check .
pnpm lint
```

Expected: 全部通過。`pnpm test:hardware` 與桌面 smoke（本機在 base 上即因 README 視窗尺寸失敗）不列為阻擋條件，於交付說明註明。

- [ ] **Step 2: 手動檢查（`pnpm --filter @kobrixa/desktop dev`）**

1. 開啟含 Basic Plus 錯誤的範例：marker hover 顯示來源「Basic Plus」，問題清單只有一筆（即時分析與建置不重複）；Quick Fix 仍可用。
2. 開發者模式連結一個帶 `diagnosticHelp` 的測試插件：設定頁顯示啟用、無問題；把 `help.json` 改壞後重新載入，插件仍啟用並顯示 `PLUGIN_E_DIAGNOSTIC_HELP`。
3. 「在官網查看此錯誤」對 BP1015 開啟 `https://kobrixa.com/docs/diagnostics/BP1015?lang=zh-TW`。

## Spec 對照

| Spec 段落                                              | Task                     |
| ------------------------------------------------------ | ------------------------ |
| §2 `source` 型別、BUILD1007                            | 1                        |
| §3 加註點、保留身分                                    | 1、2、6                  |
| §4 `contributes.diagnosticHelp`、格式、上限、API 1.2.0 | 3                        |
| §5 資源載入與生命週期                                  | 4                        |
| §6 內建擁有者、共有例外、統一查詢                      | 5                        |
| §7 桌面 UI、文件與連結、Quick Fix、網站、協作          | 5、6、7（協作無需變更）  |
| §8 錯誤碼                                              | 1、2、4                  |
| §9 測試與驗收                                          | 各 task 測試、全分支驗收 |
