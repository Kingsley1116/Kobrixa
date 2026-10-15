# 插件化編譯鏈 2A 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 由內建插件提供 Basic Plus 前端與 EV3 後端，以經驗證的通用成品完成建置、模擬及部署，保持既有專案與輸出位置相容。

**Architecture:** 主程序依專案的 language／target 取得提供者快照，worker 依內建工廠建立編譯器，以 compileToMemory 完成前端、IR、後端與成品驗證。BuildSession 將完整成品組寫進 staging，取得 outputDir 排他鎖後依序提交；BuildService 以實體 outputDir 排隊，部署則先驗證整批 bytes 再傳給設備。renderer 分開記錄建置成功與是否可以部署，模擬共用相同編譯路徑。

**Tech Stack:** TypeScript（strict、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`）、Node.js 24、Electron 44、Zod 4、Vitest、esbuild、React 19、Python 3.10+ unittest、SHA-256。

**Spec:** [`2026-10-16-plugin-system-2a-build-chain-design.md`](../specs/2026-10-16-plugin-system-2a-build-chain-design.md) §1–10（已核准）。格式範本：[`2026-10-15-plugin-loading-1b-gui-management.md`](2026-10-15-plugin-loading-1b-gui-management.md)。

## Global Constraints

- 工作分支為 `feat/plugin-system-2a-build-chain`；本文件只規劃 2A，不實作 2B 的診斷 source／語言服務，也不實作 2C tokenizer。
- `LanguageId`、`TargetId`、slot、kind：`/^[a-z][a-z0-9-]{0,31}$/`；Extension：`/^[a-z0-9]{1,16}$/`，不含點；mediaType 為 type/subtype，最長 127。
- `frontends` 最多 8、`backends` 最多 8、每個後端的 `artifacts` 最多 16；entryExtensions 必須為 sourceExtensions 的子集；IR 為正整數閉區間。
- 有 `capabilities.deploy` 的後端，必須恰好宣告一個 `required: true` 的 `deploy-main`；後端只能宣告 `deploy-main`／`aux`，不能宣告 `deploy-asset`。
- 目前 IR 版本為 1；Basic Plus 與 EV3 都宣告 `{ min: 1, max: 1 }`；解析取交集最大值，實際 IR 必須與選定版本一致。
- **API 版本升為 1.1.0。** 同步 protocol 常數、提交的 JSON Schema、JS SDK、Python SDK 與共用 conformance；有效的 1.0 外部插件仍相容；內建前端直接補必填宣告，不做舊前端宣告相容層。
- 外部插件宣告 frontends／backends，整個插件 invalid：`PLUGIN_E_FRONTEND_REQUIRES_BUILTIN`／`PLUGIN_E_BACKEND_REQUIRES_BUILTIN`；後者訊息逐字為 `Compiler backends can only be contributed by built-in plugins in this version.`。
- 同一 language／target 的啟用提供者衝突時全部失效：`PLUGIN_E_PROVIDER_CONFLICT`，解析回 `BUILD1001`，不取第一筆；重新檢查時只計入有效且啟用的提供者，停用者不阻礙其餘提供者恢復。
- 找不到提供者回 `BUILD1001`「找不到已啟用的語言／目標提供者：<language>／<target>」，不啟動 build worker；IR 無交集回 `BUILD1002`「前端產出的 IR 版本與目標不相容」。
- `ProjectManifest.schemaVersion` 維持 1；language／target 改為驗證後的字串；無 manifest 的專案仍預設 `bp`／`ev3-native`。
- 只限內建編譯器；新增 `kobrixa.ev3`（`plugins/ev3/kobrixa-plugin.json`）並加入 `apps/desktop/src/main/plugins/builtin.ts`；假前端／假後端只在測試註冊。
- 安全模式與內建插件不可由一般設定停用的 1a／1b 規則保留；內建插件在安全模式下仍保留。提供者集合的停用／恢復測試使用測試註冊資料，不開放外部編譯器；本計畫末尾列出 spec 的這項交界。
- `compileToMemory(project, frontend, backend, signal)` 共用給 BuildSession 與 prepare-simulation；模擬保留後端成功門檻、4 個入口、64 個資源／1 MiB、來源／資源快照檢查。
- `BUILD_LIMITS`（v1）：後端產生的成品數 64；含資源的成品總數 1024；單一成品 64 MiB；全部成品合計 256 MiB；檔名 128 bytes（UTF-8）；相對路徑 512 bytes（UTF-8）。每項要有等於上限與超過上限測試。
- 後端只回 `{ slot, data }`；宿主決定 metadata／路徑／hash／byteLength；保留 slot 為 `ir`、`asset`；失敗時成品清單一律為空。
- 未宣告／重複／缺少必要 slot、空 deploy-main、NFC 加小寫後名稱碰撞、`.kobrixa*` 保留名稱、越界或經符號連結的資源、超過上限皆為 `BUILD1003`；驗證失敗不能改動最終輸出。
- **輸出位置不變：** `outputDir/<名稱>.<extension>`、`outputDir/assets/<相對路徑>`；IR 為 `<名稱>.ir.json`；既有 `<名稱>.rbf` 不搬家。
- 所有 staging 寫入、資源複製、大小累計與 staging 實際內容 hash 驗證完成後才碰最終成品；staging 位於 `outputDir/.kobrixa-<buildId>.tmp/`。
- 提交依 **aux → deploy-asset → deploy-main**；第一次 rename 前最後檢查取消；此前取消回 `BUILD0001`，開始 rename 後一定做完；中途 I/O 失敗回 `BUILD9000`、成品清單為空，磁碟可能新舊混合。
- 程序內依 `realpath(outputDir)` FIFO；同一 outputDir 一次只執行一個建置；不同目錄可並行；排隊中的取消不得開 worker。
- 跨程序鎖為 `.kobrixa-build.lock`，以 `open(path, "wx")` 建立，內容 `{ pid, startedAt }`；只在提交持鎖。
- pid 不存在（`process.kill(pid, 0)` 回 ESRCH）或內容無法解析且檔案超過 60 秒，視為殘留，刪除後重試一次；EPERM 不代表 pid 不存在。
- 鎖每 100 ms 重試，最多 5 秒；逾時回 `BUILD1004`「另一個 Kobrixa 視窗正在寫入這個專案的建置輸出」；釋放只刪自己的鎖（比對內容）；文件註明網路磁碟跨主機 pid 判斷不保證正確。
- 部署依 `deploy`／`role` 選檔；方式不符回 `BUILD1005`；全批讀入記憶體、驗 sha256，檔案遺失／hash 不符回 `BUILD1006`「成品已變更，請重新建置」，未驗完不得上傳任何檔案。
- 資源按 remotePath 排序先傳、main 最後；上傳驗過的同一批 bytes；保留 Folder／runtimeDirectory、設備鎖、略過未變資源；設備傳輸本身不是原子操作。
- 成功但不可部署仍是建置成功；執行／部署按鈕提供雙語原因；全庫移除通用 `kind === "rbf"` 判斷，設備自己的 motor-test helper `.rbf` 不在範圍。
- 保留 IR 診斷、`BUILD0001`、`BUILD9000`、`EV39000`、worker 共享記憶體同步取消；新增 `BUILD1001`–`BUILD1006` 在 diagnostic-help 補英文／繁中及既有官方網址格式。
- 介面、診斷說明與文件一律有 `en`、`zh-TW`；低階例外保持英文並帶固定 code，由 UI 的雙語說明負責可讀呈現。
- 桌面端從 `@kobrixa/plugin-runtime` 的 `dist/` 取用 runtime：改完 runtime 後、跑桌面端測試或型別檢查前，先執行 `pnpm --filter @kobrixa/plugin-runtime build`。
- 本機環境：pnpm 版本與專案釘選不同時，先 `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false`。
- 每個 task 結束前對改到的檔案執行 `pnpm exec prettier --write`，再跑 `pnpm exec prettier --check` 與 `pnpm exec eslint`；ESLint 只傳 TS／TSX／MJS，Python 用 unittest／py_compile，JSON／Markdown 用 Prettier。處理控制字元用字元碼迴圈；未使用參數以 `_` 開頭。
- 所有命令從 repo 根目錄執行；本文件中的 git 命令僅供日後實作者執行。本次撰寫不 commit、不修改 spec 或程式碼。

## Review Focus

1. **建置成功後檔案被另一個視窗改寫／刪除**：全批檢查完成前不能傳任何檔案，檢查後更動磁碟也只能傳已驗過的 bytes。→ Task 7 的 `rejects a changed or missing last file before any upload`、`uploads the verified snapshot even if disk changes during transfer`。
2. **大小寫／Unicode 不同的資源撞名，或資源被換成符號連結**：不能覆寫其他成品或讀取專案外檔案。→ Task 4 的 `rejects NFC case collisions, reserved paths and file-directory conflicts`、`rejects asset symlinks and traversal before output exists`。
3. **等待另一個視窗提交時取消，或 rename 中途取消／失敗**：取消分界必須準確，不能回報帶半套成品的成功。→ Task 6 的 `cancels at the last checkpoint and finishes after the first rename`、`keeps final files on staging failure and returns no artifacts on rename failure`。
4. **兩個視窗遇到活鎖／殘留鎖，同一程序以別名指定同一輸出目錄**：不得交錯提交、誤刪別人的鎖或永遠卡住。→ Task 6 的 `queues canonical output aliases in FIFO order`、`reclaims only stale locks and never releases another owner`；Task 8 的 `serializes commits from two real processes`。
5. **非 EV3 成品或成功但不可部署，被 UI 判成建置失敗；模擬繞過失敗後端**：保留成功紀錄且不可誤傳，模擬仍拒絕後端失敗。→ Task 7 的 `keeps a successful non-deployable build without a build error`；Task 5 的 `requires backend success for all four simulation entries`。

## 檔案結構

| 檔案                                                                   | 責任                                          |
| ---------------------------------------------------------------------- | --------------------------------------------- |
| `packages/plugin-protocol/src/manifest.ts`                             | 編譯貢獻的結構及語意檢查                      |
| `packages/plugin-protocol/src/limits.ts`                               | API 常數                                      |
| `packages/plugin-sdk-js/src/index.ts`                                  | 公開 API_VERSION                              |
| `plugins/basic-plus/kobrixa-plugin.json`                               | 必填前端宣告                                  |
| `packages/plugin-protocol/conformance/cases.json`                      | 共用結構案例                                  |
| `packages/plugin-protocol/schema/plugin-protocol.schema.json`          | 產生的公開 schema                             |
| `sdks/python/kobrixa/_plugin.py`                                       | 提供 Python SDK API 1.1.0 常數                |
| `sdks/python/tests/test_plugin.py`                                     | 驗證 Python initialize 回覆版本               |
| `sdks/python/tests/test_conformance.py`                                | 用共用案例驗證 Python 打包的 JSON Schema      |
| `sdks/python/kobrixa/plugin-protocol.schema.json`                      | Python 打包 schema                            |
| `packages/plugin-runtime/src/registry.test.ts`                         | 驗證 registry 的契約與回歸                    |
| `packages/plugin-runtime/src/manager.test.ts`                          | 驗證 manager 的契約與回歸                     |
| `packages/plugin-protocol/src/compiler-manifest.test.ts`（新）         | 驗證 compiler-manifest 的契約與回歸           |
| `packages/plugin-sdk-js/src/index.test.ts`                             | 驗證 index 的契約與回歸                       |
| `packages/plugin-protocol/src/conformance.test.ts`                     | 既有共用案例 runner                           |
| `packages/plugin-protocol/src/json-schema.test.ts`                     | 既有共用案例 runner                           |
| `packages/plugin-runtime/src/compiler-resolution.ts`（新）             | 快照與解析                                    |
| `packages/plugin-runtime/src/registry.ts`                              | 語意拒絕、衝突重算                            |
| `packages/plugin-runtime/src/manager.ts`                               | 公開 resolveCompiler                          |
| `packages/plugin-runtime/src/errors.ts`                                | 定義插件錯誤碼                                |
| `packages/plugin-runtime/src/index.ts`                                 | 匯出 runtime 公開介面                         |
| `apps/desktop/src/main/plugins/controller.ts`                          | 控制器轉送                                    |
| `apps/desktop/src/renderer/settings/plugin-copy.ts`                    | 雙語問題文字                                  |
| `packages/plugin-runtime/src/compiler-resolution.test.ts`（新）        | 驗證 compiler-resolution 的契約與回歸         |
| `packages/compiler/src/contracts.ts`                                   | 可選資源快照                                  |
| `packages/compiler/src/build-error.ts`（新）                           | 固定建置錯誤與失敗結果                        |
| `packages/compiler/src/index.ts`                                       | 匯出 compiler 公開介面                        |
| `packages/compiler/package.json`                                       | 宣告 compiler 的 protocol 依賴                |
| `packages/compiler/tsconfig.json`                                      | 宣告 compiler 的 TypeScript project reference |
| `pnpm-lock.yaml`                                                       | 記錄 compiler importer 的 workspace 依賴      |
| `packages/backend-ev3/src/backend.ts`                                  | EV3Result                                     |
| `plugins/ev3/kobrixa-plugin.json`（新）                                | 內建後端宣告                                  |
| `apps/desktop/src/main/workspace/builtin-compilers.ts`（新）           | 預設內建 resolver                             |
| `apps/desktop/src/main/plugins/builtin.ts`                             | 加入 EV3                                      |
| `apps/desktop/src/main/plugins/builtin.test.ts`                        | 驗證 builtin 的契約與回歸                     |
| `packages/compiler/src/diagnostic-help.ts`                             | 六個雙語說明                                  |
| `packages/compiler/src/diagnostic-help.test.ts`                        | 94／BUILD: 8                                  |
| `packages/compiler/src/artifacts.ts`（新）                             | 記憶體成品驗證與 layout                       |
| `packages/compiler/src/safe-files.ts`（新）                            | 不跟隨連結的受限讀取                          |
| `packages/compiler/src/test-build.ts`（新）                            | 只供測試匯入的假編譯器及 IR                   |
| `packages/compiler/src/artifacts.test.ts`（新）                        | 驗證 artifacts 的契約與回歸                   |
| `packages/compiler/src/compile-memory.ts`（新）                        | 共用記憶體編譯                                |
| `packages/compiler/src/manifest.ts`                                    | 動態副檔名與 loader callback                  |
| `apps/desktop/src/main/workspace/workspace.ts`                         | 將宣告帶進 loader                             |
| `apps/desktop/src/main/workspace/prepare-simulation.ts`                | 共用編譯與快照                                |
| `apps/desktop/src/main/workspace/build-protocol.ts`                    | worker 快照契約                               |
| `apps/desktop/vitest.config.ts`                                        | 測試使用 compiler 原始碼                      |
| `packages/compiler/src/manifest.test.ts`                               | 驗證動態副檔名、overlay、輸出排除與路徑安全   |
| `packages/compiler/src/compile-memory.test.ts`（新）                   | 驗證 compile-memory 的契約與回歸              |
| `apps/desktop/src/main/workspace/prepare-simulation.test.ts`（新）     | 驗證 prepare-simulation 的契約與回歸          |
| `packages/compiler/src/output-lock.ts`（新）                           | 跨程序鎖                                      |
| `packages/compiler/src/commit-artifacts.ts`（新）                      | 完整 staging、驗 hash、排序提交               |
| `packages/compiler/src/build-session.ts`                               | 記憶體編譯後提交                              |
| `apps/desktop/src/main/workspace/output-queue.ts`（新）                | canonical outputDir FIFO                      |
| `apps/desktop/src/main/workspace/build.ts`                             | 保存快照、排隊、單次完成                      |
| `apps/desktop/src/main/workspace/build-worker.ts`                      | 按快照建立兩端                                |
| `apps/desktop/src/main/workspace/builtin-frontends.ts`（刪）           | 刪除舊的單前端工廠表                          |
| `apps/desktop/src/main/index.ts`                                       | 注入 resolveCompiler                          |
| `packages/compiler/src/commit-artifacts.test.ts`（新）                 | 驗證 commit-artifacts 的契約與回歸            |
| `packages/compiler/src/output-lock.test.ts`（新）                      | 驗證 output-lock 的契約與回歸                 |
| `apps/desktop/src/main/workspace/output-queue.test.ts`（新）           | 驗證 output-queue 的契約與回歸                |
| `apps/desktop/src/main/workspace/build.test.ts`                        | 排隊取消與非同步 worker 啟動                  |
| `packages/compiler/src/deployment.ts`（新）                            | 全批驗 hash 的部署快照                        |
| `apps/desktop/src/main/device/device.ts`                               | 傳同一批 bytes、依 role 略過未變資源          |
| `apps/desktop/src/renderer/execution/build-path.ts`                    | 通用部署路徑與雙語原因                        |
| `apps/desktop/src/renderer/execution/execution.ts`                     | 成功與可部署分開                              |
| `apps/desktop/src/renderer/execution/version-label.ts`                 | 不可部署版本也能顯示                          |
| `apps/desktop/src/renderer/workbench/toolbar.tsx`                      | 按鈕原因                                      |
| `apps/desktop/src/main/device/deployment-snapshot.test.ts`（新）       | 驗證 deployment-snapshot 的契約與回歸         |
| `apps/desktop/src/renderer/execution/build-path.test.ts`               | 驗證 build-path 的契約與回歸                  |
| `apps/desktop/src/renderer/execution/execution.test.ts`                | 驗證 execution 的契約與回歸                   |
| `apps/desktop/src/renderer/workbench/toolbar-deployment.test.ts`（新） | 驗證 toolbar-deployment 的契約與回歸          |
| `apps/desktop/src/main/device/recovery.test.ts`                        | 快照 fixture                                  |
| `apps/desktop/src/main/workspace/compiler-chain.test.ts`（新）         | 假插件完整流程                                |
| `packages/compiler/src/output-lock.process.test.ts`（新）              | 兩個真實 Node 程序提交                        |
| `apps/desktop/src/main/workspace/integration.test.ts`                  | 改用內建 adapter                              |
| `apps/desktop/src/main/workspace/examples.test.ts`                     | 範例回歸使用 role                             |
| `tests/desktop/packaged-smoke.mjs`                                     | 成品契約                                      |
| `tests/desktop/smoke-main.mjs`                                         | 完整 CompileResult fixture                    |
| `docs/en/architecture.md`                                              | 記錄英文架構、插件與編譯成品契約              |
| `docs/zh-TW/architecture.md`                                           | 記錄繁中架構、插件與編譯成品契約              |
| `plugins/samples/README.md`                                            | 雙語外部插件界線                              |

依 spec §10 保留八個 task；將通用型別放進 Task 3（adapter 必須使用），將成品驗證提前為 Task 4、共用編譯與來源探索放 Task 5。每個 task 的單元測試只測該邊界；Task 6 接上正式提交後，Task 8 再驗收整個工作樹、打包 worker 與全套回歸。新增匯出的型別都在各 task 的 Interfaces 重述，實作者不需猜測跨 task 的欄位。

---

### Task 1: Manifest schema、API 1.1.0、JSON Schema 與兩個 SDK

**Files:**

- Modify: `packages/plugin-protocol/src/manifest.ts:1–58`（編譯貢獻的結構及語意檢查）
- Modify: `packages/plugin-protocol/src/limits.ts:1`（API 常數）
- Modify: `packages/plugin-sdk-js/src/index.ts:1–12`（公開 API_VERSION）
- Modify: `sdks/python/kobrixa/_plugin.py:13`（Python API 常數）
- Modify: `plugins/basic-plus/kobrixa-plugin.json:1–8`（必填前端宣告）
- Modify: `packages/plugin-protocol/conformance/cases.json:1–末尾`（共用結構案例）
- Modify: `packages/plugin-protocol/schema/plugin-protocol.schema.json:1–末尾`（產生的公開 schema）
- Modify: `sdks/python/kobrixa/plugin-protocol.schema.json:1–末尾`（Python 打包 schema）
- Modify: `packages/plugin-runtime/src/registry.test.ts:37,110`、`packages/plugin-runtime/src/manager.test.ts:53`（既有內建 fixture 補必填欄位）
- Test: `packages/plugin-protocol/src/compiler-manifest.test.ts`（新）
- Test: `packages/plugin-sdk-js/src/index.test.ts:6–38`
- Test: `sdks/python/tests/test_plugin.py:97–100`
- Test: `packages/plugin-protocol/src/conformance.test.ts`、`packages/plugin-protocol/src/json-schema.test.ts`、`sdks/python/tests/test_conformance.py`（既有共用案例 runner）

**Interfaces:**

- Consumes：`pluginManifestSchema.safeParse(value: unknown): ReturnType<typeof pluginManifestSchema.safeParse>`、`serializeJsonSchema(): string`；`scripts/export-schema.mjs` 已經同時寫 repo 與 Python 兩份 schema，不另造產物流程。
- Produces：`compilerIdSchema`、`extensionSchema`、`frontendDeclSchema`、`backendDeclSchema`、`artifactDeclSchema`（可匯出 JSON Schema 的 Zod schema）。
- Produces：`FrontendDecl = { language: string; entryExtensions: string[]; sourceExtensions: string[]; ir: { min: number; max: number } }`；`ArtifactDecl = { slot: string; kind: string; extension: string; mediaType: string; role: "deploy-main" | "aux"; required: boolean }`；`BackendDecl = { target: string; ir: { min: number; max: number }; capabilities: { deploy?: "ev3" }; artifacts: ArtifactDecl[] }`。
- Produces：`compilerDeclarationProblems(manifest: PluginManifest): string[]`；關聯條件（子集、閉區間、唯一 slot、部署主檔）在宿主語意驗證，不能用 Zod refinement 讓 JSON exporter 靜默遺失規則。Schema／兩 SDK conformance 測結構，runtime 測語意。
- Produces：`PLUGIN_API_VERSION = "1.1.0"`、JS `API_VERSION` 與 Python `API_VERSION` 同值。

- [ ] **Step 1: 寫失敗的 schema 與版本測試**

建立 `packages/plugin-protocol/src/compiler-manifest.test.ts`：

```ts
import { expect, it } from "vitest";
import { PLUGIN_API_VERSION, pluginManifestSchema, compilerDeclarationProblems } from "./index.js";

const frontend = {
  language: "bp",
  entryExtensions: ["bp"],
  sourceExtensions: ["bp", "bpi", "bpm"],
  ir: { min: 1, max: 1 },
};
const main = {
  slot: "program",
  kind: "rbf",
  extension: "rbf",
  mediaType: "application/octet-stream",
  role: "deploy-main" as const,
  required: true,
};
const backend = {
  target: "ev3-native",
  ir: { min: 1, max: 1 },
  capabilities: { deploy: "ev3" as const },
  artifacts: [main],
};
const manifest = {
  id: "test.compiler",
  version: "1.0.0",
  apiVersion: "^1.1.0",
  runtime: { kind: "builtin" as const },
  contributes: { frontends: [frontend], backends: [backend] },
};
it("exports API 1.1 and accepts complete compiler declarations", () => {
  expect(PLUGIN_API_VERSION).toBe("1.1.0");
  expect(pluginManifestSchema.parse(manifest).contributes?.backends).toEqual([backend]);
  expect(compilerDeclarationProblems(pluginManifestSchema.parse(manifest))).toEqual([]);
});
it("checks semantic relations without hiding them in the wire schema", () => {
  for (const contributes of [
    { frontends: [{ ...frontend, entryExtensions: ["py"] }] },
    { frontends: [{ ...frontend, ir: { min: 2, max: 1 } }] },
    { backends: [{ ...backend, ir: { min: 2, max: 1 } }] },
    { backends: [{ ...backend, artifacts: [] }] },
    { backends: [{ ...backend, artifacts: [{ ...main, required: false }] }] },
    { backends: [{ ...backend, artifacts: [main, { ...main, slot: "second" }] }] },
    { backends: [{ ...backend, artifacts: [main, { ...main, role: "aux" }] }] },
    { backends: [{ ...backend, artifacts: [{ ...main, slot: "ir" }] }] },
    { backends: [{ ...backend, artifacts: [{ ...main, slot: "asset" }] }] },
  ])
    expect(
      compilerDeclarationProblems(pluginManifestSchema.parse({ ...manifest, contributes })),
    ).not.toEqual([]);
});
it("bounds both provider arrays and each artifact declaration array", () => {
  for (const [field, value, limit] of [
    ["frontends", frontend, 8],
    ["backends", backend, 8],
  ] as const) {
    expect(
      pluginManifestSchema.safeParse({
        ...manifest,
        contributes: { [field]: Array(limit).fill(value) },
      }).success,
    ).toBe(true);
    expect(
      pluginManifestSchema.safeParse({
        ...manifest,
        contributes: { [field]: Array(limit + 1).fill(value) },
      }).success,
    ).toBe(false);
  }
  for (const count of [16, 17])
    expect(
      pluginManifestSchema.safeParse({
        ...manifest,
        contributes: {
          backends: [
            {
              ...backend,
              artifacts: Array.from({ length: count }, (_, i) => ({ ...main, slot: `s${i}` })),
            },
          ],
        },
      }).success,
    ).toBe(count === 16);
});
```

`packages/plugin-sdk-js/src/index.test.ts` 的 `init.apiVersion` 及 initialize 回覆預期改成以下實際值，並加入公開常數斷言；同檔的其他測試保持原內容：

```ts
// 加入既有 ./index.js import。
import { API_VERSION } from "./index.js";
it("exposes the same API version as its initialize response", () => {
  expect(API_VERSION).toBe("1.1.0");
});
```

JS 的請求與回覆斷言兩處都使用 `apiVersion: "1.1.0"`。Python `test_plugin.py` 對應的請求欄位與回覆斷言分別替換為：

```python
"apiVersion": "1.1.0", "pluginId": "acme.behaviors", "locale": "zh-TW",
```

```python
self.assertEqual(reply["result"]["apiVersion"], "1.1.0")
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter @kobrixa/plugin-protocol exec vitest run src/compiler-manifest.test.ts`
Expected: FAIL，找不到 `compilerDeclarationProblems` 匯出；版本仍為 `1.0.0`。

- [ ] **Step 3: 實作可匯出的宣告 schema 與語意檢查**

在 `manifest.ts` 的 `runtimeSchema` 後加入以下完整宣告；將原來 contributes.frontends 的 schema 換成最後兩行的 frontends／backends 屬性：

```ts
export const compilerIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
export const extensionSchema = z.string().regex(/^[a-z0-9]{1,16}$/);
const irRangeSchema = z.looseObject({ min: z.number().int().min(1), max: z.number().int().min(1) });
export const frontendDeclSchema = z.looseObject({
  language: compilerIdSchema,
  entryExtensions: z.array(extensionSchema).min(1),
  sourceExtensions: z.array(extensionSchema).min(1),
  ir: irRangeSchema,
});
export const artifactDeclSchema = z.looseObject({
  slot: compilerIdSchema,
  kind: compilerIdSchema,
  extension: extensionSchema,
  mediaType: z
    .string()
    .max(127)
    .regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/),
  role: z.enum(["deploy-main", "aux"]),
  required: z.boolean(),
});
export const backendDeclSchema = z.looseObject({
  target: compilerIdSchema,
  ir: irRangeSchema,
  capabilities: z.looseObject({ deploy: z.literal("ev3").optional() }),
  artifacts: z.array(artifactDeclSchema).max(16),
});
export type FrontendDecl = z.infer<typeof frontendDeclSchema>;
export type BackendDecl = z.infer<typeof backendDeclSchema>;
export type ArtifactDecl = z.infer<typeof artifactDeclSchema>;
```

```ts
frontends: z.array(frontendDeclSchema).max(8).optional(),
backends: z.array(backendDeclSchema).max(8).optional(),
```

在 `PluginManifest` 型別後加入：

```ts
export function compilerDeclarationProblems(manifest: PluginManifest): string[] {
  const problems: string[] = [];
  for (const frontend of manifest.contributes?.frontends ?? []) {
    if (frontend.ir.min > frontend.ir.max) problems.push("Frontend IR range is empty.");
    if (
      frontend.entryExtensions.some((extension) => !frontend.sourceExtensions.includes(extension))
    )
      problems.push("Entry extensions must be a subset of source extensions.");
  }
  for (const backend of manifest.contributes?.backends ?? []) {
    if (backend.ir.min > backend.ir.max) problems.push("Backend IR range is empty.");
    const slots = backend.artifacts.map((artifact) => artifact.slot);
    if (new Set(slots).size !== slots.length) problems.push("Artifact slots must be unique.");
    if (slots.some((slot) => slot === "ir" || slot === "asset"))
      problems.push("Artifact slot is reserved by the host.");
    const mains = backend.artifacts.filter((artifact) => artifact.role === "deploy-main");
    if (backend.capabilities.deploy && (mains.length !== 1 || !mains[0]!.required))
      problems.push("A deployable backend requires exactly one required deploy-main.");
  }
  return problems;
}
```

`limits.ts` 第一行換成 `export const PLUGIN_API_VERSION = "1.1.0";`。JS SDK 在 import 後加 `export const API_VERSION = PLUGIN_API_VERSION;`；Python `_plugin.py` 改成 `API_VERSION = "1.1.0"`。既有 `index.ts` 已經 `export * from "./manifest.js"`，不必重複匯出。

- [ ] **Step 4: 補齊內建 manifest 與現有 fixture**

`plugins/basic-plus/kobrixa-plugin.json` 全文：

```json
{
  "id": "kobrixa.basic-plus",
  "version": "1.0.0",
  "apiVersion": "^1.1.0",
  "displayName": { "en": "Basic Plus", "zh-TW": "Basic Plus" },
  "runtime": { "kind": "builtin" },
  "contributes": {
    "frontends": [
      {
        "language": "bp",
        "entryExtensions": ["bp"],
        "sourceExtensions": ["bp", "bpi", "bpm"],
        "ir": { "min": 1, "max": 1 }
      }
    ]
  }
}
```

對 `registry.test.ts` 兩處及 `manager.test.ts` 一處 `{ language: "bp" }`，完整替換值為：

```ts
{ language: "bp", entryExtensions: ["bp"], sourceExtensions: ["bp", "bpi", "bpm"], ir: { min: 1, max: 1 } }
```

外部插件反例也必須使用結構有效的宣告，才能確實走到 `PLUGIN_E_FRONTEND_REQUIRES_BUILTIN`。

- [ ] **Step 5: 加共用 conformance 並重新產生兩份 JSON Schema**

在根目錄執行以下完整腳本。它只新增具名案例，保留既有 API 1.0 相容案例，不全庫替換產品版本：

```bash
node --input-type=module <<'JS'
import { readFile, writeFile } from "node:fs/promises";
const file = "packages/plugin-protocol/conformance/cases.json";
const cases = JSON.parse(await readFile(file, "utf8"));
const front = { language: "bp", entryExtensions: ["bp"], sourceExtensions: ["bp", "bpi"], ir: { min: 1, max: 1 } };
const artifact = { slot: "program", kind: "rbf", extension: "rbf", mediaType: "application/octet-stream", role: "deploy-main", required: true };
const back = { target: "ev3-native", ir: { min: 1, max: 1 }, capabilities: { deploy: "ev3" }, artifacts: [artifact] };
const base = { id: "test.compiler", version: "1.0.0", apiVersion: "^1.1.0", runtime: { kind: "builtin" } };
const additions = [];
const add = (name, contributes, valid) => additions.push({ name: `compiler 1.1 ${name}`, definition: "manifest", value: { ...base, contributes }, valid });
add("complete", { frontends: [front], backends: [back] }, true);
add("required frontend fields", { frontends: [{ language: "bp" }] }, false);
for (const id of ["a", "a".repeat(32), "Bad", "a".repeat(33), "x\n", "../x"]) {
  const valid = id === "a" || id === "a".repeat(32);
  add(`language ${JSON.stringify(id)}`, { frontends: [{ ...front, language: id }] }, valid);
  add(`target ${JSON.stringify(id)}`, { backends: [{ ...back, target: id }] }, valid);
  for (const field of ["slot", "kind"]) add(`${field} ${JSON.stringify(id)}`, { backends: [{ ...back, artifacts: [{ ...artifact, [field]: id }] }] }, valid);
}
for (const extension of ["a", "a".repeat(16), ".rbf", "A", "a".repeat(17), "x\n"]) {
  const valid = extension === "a" || extension.length === 16;
  add(`extension ${JSON.stringify(extension)}`, { backends: [{ ...back, artifacts: [{ ...artifact, extension }] }] }, valid);
  add(`source extension ${JSON.stringify(extension)}`, { frontends: [{ ...front, sourceExtensions: [extension] }] }, valid);
}
for (const min of [0, -1, 1.5, 1]) add(`IR ${min}`, { frontends: [{ ...front, ir: { min, max: 2 } }] }, min === 1);
for (const count of [8, 9]) {
  add(`${count} frontends`, { frontends: Array(count).fill(front) }, count === 8);
  add(`${count} backends`, { backends: Array(count).fill(back) }, count === 8);
}
for (const count of [16, 17]) add(`${count} artifacts`, { backends: [{ ...back, artifacts: Array(count).fill(artifact) }] }, count === 16);
for (const [mediaType, valid] of [["a/" + "b".repeat(125), true], ["a/" + "b".repeat(126), false], ["text", false]])
  add(`media ${mediaType.length} ${valid}`, { backends: [{ ...back, artifacts: [{ ...artifact, mediaType }] }] }, valid);
add("host owns assets", { backends: [{ ...back, artifacts: [{ ...artifact, role: "deploy-asset" }] }] }, false);
add("unknown deploy capability", { backends: [{ ...back, capabilities: { deploy: "other" } }] }, false);
const names = new Set(additions.map((item) => item.name));
await writeFile(file, JSON.stringify([...cases.filter((item) => !names.has(item.name)), ...additions], null, 2) + "\n");
JS
pnpm --filter @kobrixa/plugin-protocol schema
```

Expected: exporter 用 `scripts/export-schema.mjs` 更新兩份相同產物，`$id` 為 `https://kobrixa.com/schemas/plugin-protocol/1.1.0.json`。

- [ ] **Step 6: 執行測試確認通過**

Run: `pnpm --filter @kobrixa/plugin-protocol test && pnpm --filter @kobrixa/plugin-sdk test && pnpm test:python-sdk`
Expected: PASS，含 schema drift、JSON keyword allowlist、兩個 SDK initialize 及共用 conformance；舊 `^1.0.0` 命令插件仍有效。

- [ ] **Step 7: 格式化與靜態檢查**

```bash
pnpm exec prettier --write packages/plugin-protocol/src/manifest.ts packages/plugin-protocol/src/limits.ts packages/plugin-protocol/src/compiler-manifest.test.ts packages/plugin-protocol/conformance/cases.json packages/plugin-protocol/schema/plugin-protocol.schema.json sdks/python/kobrixa/plugin-protocol.schema.json packages/plugin-sdk-js/src/index.ts packages/plugin-sdk-js/src/index.test.ts plugins/basic-plus/kobrixa-plugin.json packages/plugin-runtime/src/registry.test.ts packages/plugin-runtime/src/manager.test.ts
pnpm exec prettier --check packages/plugin-protocol/src packages/plugin-protocol/conformance/cases.json packages/plugin-sdk-js/src plugins/basic-plus/kobrixa-plugin.json sdks/python/kobrixa/plugin-protocol.schema.json packages/plugin-runtime/src/registry.test.ts packages/plugin-runtime/src/manager.test.ts
pnpm exec eslint packages/plugin-protocol/src packages/plugin-sdk-js/src packages/plugin-runtime/src/registry.test.ts packages/plugin-runtime/src/manager.test.ts
pnpm --filter @kobrixa/plugin-protocol build
```

Expected: 全部通過；`.prettierignore` 已排除兩份產生的 schema 與 pnpm-lock.yaml；用 schema drift／frozen-lockfile 驗證它們，不能手動格式化產物。

- [ ] **Step 8: Commit**

```bash
git add packages/plugin-protocol/src/manifest.ts packages/plugin-protocol/src/limits.ts packages/plugin-protocol/src/compiler-manifest.test.ts packages/plugin-protocol/conformance/cases.json packages/plugin-protocol/schema/plugin-protocol.schema.json packages/plugin-sdk-js/src/index.ts packages/plugin-sdk-js/src/index.test.ts sdks/python/kobrixa/_plugin.py sdks/python/kobrixa/plugin-protocol.schema.json sdks/python/tests/test_plugin.py plugins/basic-plus/kobrixa-plugin.json packages/plugin-runtime/src/registry.test.ts packages/plugin-runtime/src/manager.test.ts
git commit -m "feat(plugin-protocol): declare compiler providers in API 1.1" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 2: 提供者解析、全部衝突失效、IR 交集與外部插件拒絕

**Files:**

- Create: `packages/plugin-runtime/src/compiler-resolution.ts`（快照與解析）
- Modify: `packages/plugin-runtime/src/registry.ts:11–17,63–107,260–末尾`（語意拒絕、衝突重算）
- Modify: `packages/plugin-runtime/src/manager.ts:191–198`（公開 resolveCompiler）
- Modify: `packages/plugin-runtime/src/errors.ts:9`、`packages/plugin-runtime/src/index.ts:1–末尾`（匯出）
- Modify: `apps/desktop/src/main/plugins/controller.ts:63–76,152–154`（控制器轉送）
- Modify: `apps/desktop/src/renderer/settings/plugin-copy.ts:144–148`（雙語問題文字）
- Test: `packages/plugin-runtime/src/compiler-resolution.test.ts`（新）
- Test: `packages/plugin-runtime/src/registry.test.ts:104–120`、`packages/plugin-runtime/src/manager.test.ts:103–110`

**Interfaces:**

- Consumes：`readSource(source: PluginSource, options: { safeMode: boolean; timeoutMs?: number }): Promise<ReadPlugin>`；`resolvePlugins(read: readonly ReadPlugin[], options: { disabled: ReadonlySet<string>; safeMode: boolean }): RegisteredPlugin[]`。
- Consumes：`FrontendDecl`／`BackendDecl`／`compilerDeclarationProblems(manifest: PluginManifest): string[]`（Task 1）；`RegisteredPlugin.status` 為 `enabled | disabled | invalid`。
- Produces：`ProviderRef<T extends FrontendDecl | BackendDecl = FrontendDecl | BackendDecl> = { pluginId: string; sourceKey: string; contribution: T }`。
- Produces：`CompilerResolution = { ok: true; frontend: ProviderRef<FrontendDecl>; backend: ProviderRef<BackendDecl>; ir: number } | { ok: false; code: "BUILD1001" | "BUILD1002"; message: string }`；`CompilerSnapshot = Extract<CompilerResolution, { ok: true }>`。
- Produces：`markProviderConflicts(plugins: RegisteredPlugin[]): void`；`resolveCompilerProviders(plugins: readonly RegisteredPlugin[], language: string, target: string): CompilerResolution`。
- Produces：`PluginManager.resolveCompiler(language: string, target: string): CompilerResolution`、`PluginController.resolveCompiler(language: string, target: string): CompilerResolution`。不啟動插件程序，快照以 structuredClone 複製。

- [ ] **Step 1: 寫失敗的解析測試**

建立 `compiler-resolution.test.ts`：

```ts
import { expect, it, vi } from "vitest";
import {
  PluginManager,
  readSource,
  resolvePlugins,
  resolveCompilerProviders,
  type PluginSource,
  type ReadPlugin,
} from "./index.js";

const front = {
  language: "test",
  entryExtensions: ["test"],
  sourceExtensions: ["test", "inc"],
  ir: { min: 1, max: 3 },
};
const back = { target: "test-vm", ir: { min: 2, max: 4 }, capabilities: {}, artifacts: [] };
const source = (id: string, contributes: unknown): PluginSource => ({
  kind: "builtin",
  manifest: {
    id,
    version: "1.0.0",
    apiVersion: "^1.1.0",
    runtime: { kind: "builtin" },
    contributes,
  },
});
const sources = [
  source("test.front", { frontends: [front] }),
  source("test.back", { backends: [back] }),
];
async function reads(values = sources): Promise<ReadPlugin[]> {
  return Promise.all(values.map((value) => readSource(value, { safeMode: false })));
}
const options = { disabled: new Set<string>(), safeMode: false };
it("chooses the largest IR intersection and returns an immutable snapshot", async () => {
  const launcher = vi.fn();
  const manager = await PluginManager.create({
    sources,
    safeMode: true,
    launcher,
    locale: "en",
    store: {
      load: async () => ({ disabled: new Set(), legacyDisabledIds: new Set() }),
      save: async () => {},
    },
  });
  const result = manager.resolveCompiler("test", "test-vm");
  expect(result).toMatchObject({
    ok: true,
    ir: 3,
    frontend: { pluginId: "test.front", sourceKey: "builtin:test.front" },
    backend: { pluginId: "test.back" },
  });
  if (!result.ok) throw new Error(result.message);
  result.frontend.contribution.sourceExtensions.push("mutated");
  const again = manager.resolveCompiler("test", "test-vm");
  if (!again.ok) throw new Error(again.message);
  expect(again.frontend.contribution.sourceExtensions).toEqual(["test", "inc"]);
  expect(launcher).not.toHaveBeenCalled();
  await manager.shutdown();
});
it.each(["frontend", "backend"] as const)(
  "invalidates every conflicting %s provider and restores the remaining enabled provider",
  async (kind) => {
    const extra = source(
      "test.extra",
      kind === "frontend" ? { frontends: [front] } : { backends: [back] },
    );
    const input = await reads([...sources, extra]);
    const result = resolvePlugins(input, options);
    const conflicted = result.filter((plugin) =>
      plugin.problems.some((problem) => problem.code === "PLUGIN_E_PROVIDER_CONFLICT"),
    );
    expect(conflicted.map((plugin) => plugin.id).sort()).toEqual(
      [kind === "frontend" ? "test.front" : "test.back", "test.extra"].sort(),
    );
    expect(conflicted.every((plugin) => plugin.status === "invalid")).toBe(true);
    expect(resolveCompilerProviders(result, "test", "test-vm")).toMatchObject({
      ok: false,
      code: "BUILD1001",
    });
    // 僅測試用的來源資料：停用集合經 registry 重算後，不能保留上輪衝突。
    // 正式 readSource 仍會拒絕 development 編譯器；本測試不新增生產註冊入口。
    const testInput = input.map((plugin) => ({ ...plugin, source: "development" as const }));
    const restored = resolvePlugins(testInput, {
      ...options,
      disabled: new Set([input[2]!.sourceKey]),
    });
    expect(restored[2]).toMatchObject({ status: "disabled", disabledBy: "user" });
    expect(resolveCompilerProviders(restored, "test", "test-vm")).toMatchObject({
      ok: true,
      ir: 3,
    });
  },
);
it("rejects missing providers and an empty IR intersection", async () => {
  const registered = resolvePlugins(await reads(), options);
  expect(resolveCompilerProviders(registered, "missing", "test-vm")).toMatchObject({
    ok: false,
    code: "BUILD1001",
  });
  const incompatible = await reads([
    sources[0]!,
    source("test.back", { backends: [{ ...back, ir: { min: 4, max: 5 } }] }),
  ]);
  expect(
    resolveCompilerProviders(resolvePlugins(incompatible, options), "test", "test-vm"),
  ).toMatchObject({ ok: false, code: "BUILD1002" });
});
it("keeps API 1.0 command plugins compatible", async () => {
  const item = await readSource(
    {
      kind: "builtin",
      manifest: {
        id: "test.old",
        version: "1.0.0",
        apiVersion: "^1.0.0",
        runtime: { kind: "builtin" },
        contributes: { commands: [{ id: "test.old.run", title: "Run" }] },
      },
    },
    { safeMode: false },
  );
  expect(item.problems).toEqual([]);
});
```

在既有 `registry.test.ts` 的錯誤矩陣加入完整有效後端宣告：

```ts
["PLUGIN_E_FRONTEND_REQUIRES_BUILTIN", { contributes: { frontends: [] } }],
["PLUGIN_E_BACKEND_REQUIRES_BUILTIN", { contributes: { backends: [] } }],
["PLUGIN_E_BACKEND_REQUIRES_BUILTIN", { contributes: { backends: [{
  target: "test-vm", ir: { min: 1, max: 1 }, capabilities: {}, artifacts: [],
}] } }],
```

將 `manager.test.ts` 兩個 `frontendFor` 斷言換成：

```ts
expect(manager.resolveCompiler("bp", "missing")).toMatchObject({ ok: false, code: "BUILD1001" });
expect(manager.resolveCompiler("python", "ev3-native")).toMatchObject({
  ok: false,
  code: "BUILD1001",
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter @kobrixa/plugin-runtime exec vitest run src/compiler-resolution.test.ts src/registry.test.ts src/manager.test.ts`
Expected: FAIL，`resolveCompiler is not a function`／缺少 resolver 匯出；外部後端沒有 invalid。

- [ ] **Step 3: 實作解析與全體衝突**

`compiler-resolution.ts` 全文：

```ts
import type { BackendDecl, FrontendDecl } from "@kobrixa/plugin-protocol";
import type { RegisteredPlugin } from "./registry.js";

export type ProviderRef<T extends FrontendDecl | BackendDecl = FrontendDecl | BackendDecl> = {
  pluginId: string;
  sourceKey: string;
  contribution: T;
};
export type CompilerResolution =
  | { ok: true; frontend: ProviderRef<FrontendDecl>; backend: ProviderRef<BackendDecl>; ir: number }
  | { ok: false; code: "BUILD1001" | "BUILD1002"; message: string };
export type CompilerSnapshot = Extract<CompilerResolution, { ok: true }>;

export function markProviderConflicts(plugins: RegisteredPlugin[]): void {
  const owners = new Map<string, RegisteredPlugin[]>();
  for (const plugin of plugins) {
    if (plugin.status !== "enabled") continue;
    const keys = [
      ...(plugin.manifest?.contributes?.frontends ?? []).map((item) => `language:${item.language}`),
      ...(plugin.manifest?.contributes?.backends ?? []).map((item) => `target:${item.target}`),
    ];
    for (const key of keys) owners.set(key, [...(owners.get(key) ?? []), plugin]);
  }
  // 先建立全部分組再改 status，避免前一組失效使後一組誤剩單一提供者。
  for (const [key, group] of owners) {
    if (group.length < 2) continue;
    for (const plugin of new Set(group)) {
      plugin.status = "invalid";
      plugin.problems.push({
        code: "PLUGIN_E_PROVIDER_CONFLICT",
        message: `Multiple enabled plugins provide ${key}.`,
      });
    }
  }
}
export function resolveCompilerProviders(
  plugins: readonly RegisteredPlugin[],
  language: string,
  target: string,
): CompilerResolution {
  const active = plugins.filter((plugin) => plugin.status === "enabled");
  const frontends: ProviderRef<FrontendDecl>[] = active.flatMap((plugin) =>
    (plugin.manifest?.contributes?.frontends ?? [])
      .filter((item) => item.language === language)
      .map((contribution) => ({ pluginId: plugin.id, sourceKey: plugin.sourceKey, contribution })),
  );
  const backends: ProviderRef<BackendDecl>[] = active.flatMap((plugin) =>
    (plugin.manifest?.contributes?.backends ?? [])
      .filter((item) => item.target === target)
      .map((contribution) => ({ pluginId: plugin.id, sourceKey: plugin.sourceKey, contribution })),
  );
  if (frontends.length !== 1 || backends.length !== 1)
    return {
      ok: false,
      code: "BUILD1001",
      message: `No unique enabled language/target provider: ${language}/${target}.`,
    };
  const frontend = frontends[0]!;
  const backend = backends[0]!;
  const min = Math.max(frontend.contribution.ir.min, backend.contribution.ir.min);
  const max = Math.min(frontend.contribution.ir.max, backend.contribution.ir.max);
  if (min > max)
    return {
      ok: false,
      code: "BUILD1002",
      message: "Frontend and target IR versions are incompatible.",
    };
  return structuredClone({ ok: true, frontend, backend, ir: max });
}
```

`errors.ts` 在 `PLUGIN_E_FRONTEND_REQUIRES_BUILTIN` 後加入：

```ts
"PLUGIN_E_BACKEND_REQUIRES_BUILTIN",
"PLUGIN_E_PROVIDER_CONFLICT",
```

`registry.ts` 加入 imports：

```ts
import { compilerDeclarationProblems } from "@kobrixa/plugin-protocol";
import { markProviderConflicts } from "./compiler-resolution.js";
```

在 `semanticProblems()` 的 `const problems` 後加入：

```ts
problems.push(
  ...compilerDeclarationProblems(manifest).map((message) => problem("PLUGIN_E_MANIFEST", message)),
);
```

現有前端拒絕條件改為 `manifest.contributes?.frontends !== undefined && source !== "builtin"`；這也拒絕外部空陣列宣告。後方加入：

```ts
if (manifest.contributes?.backends !== undefined && source !== "builtin")
  problems.push(
    problem(
      "PLUGIN_E_BACKEND_REQUIRES_BUILTIN",
      "Compiler backends can only be contributed by built-in plugins in this version.",
    ),
  );
```

`resolvePlugins()` 的 `return resolved;` 前加入 `markProviderConflicts(resolved);`。它每次都從 `read.problems` 建立新陣列，衝突不得寫回 ReadPlugin。既有 plugin ID／command ID 的保護規則不改。

- [ ] **Step 4: 接上 manager、controller 與雙語文字**

manager 加 import，取代 `frontendFor` 方法：

```ts
import { resolveCompilerProviders, type CompilerResolution } from "./compiler-resolution.js";
```

```ts
resolveCompiler(language: string, target: string): CompilerResolution {
  return resolveCompilerProviders(this.#entries.map((entry) => entry.plugin), language, target);
}
```

runtime `index.ts` 加 `export * from "./compiler-resolution.js";`。controller 的 manager Pick 將 `"frontendFor"` 換為 `"resolveCompiler"`，原方法換成：

```ts
resolveCompiler(language: string, target: string): ReturnType<PluginManager["resolveCompiler"]> {
  return this.deps.manager.resolveCompiler(language, target);
}
```

controller 已經匯入 `PluginManager`，不另建重複型別。`plugin-copy.ts` 的 problems 物件加入：

```ts
PLUGIN_E_BACKEND_REQUIRES_BUILTIN: ["目前只有內建插件能提供編譯後端", "Only built-in plugins can provide compiler backends for now"],
PLUGIN_E_PROVIDER_CONFLICT: ["有多個已啟用的插件提供相同語言或目標", "Multiple enabled plugins provide the same language or target"],
```

- [ ] **Step 5: 執行測試確認通過**

Run: `pnpm --filter @kobrixa/plugin-runtime exec vitest run && pnpm --filter @kobrixa/plugin-runtime build`
Expected: PASS；safe mode 的內建提供者仍可解析、衝突沒有取首筆、外部宣告全插件 invalid。

- [ ] **Step 6: 格式化與 lint**

```bash
pnpm exec prettier --write packages/plugin-runtime/src/compiler-resolution.ts packages/plugin-runtime/src/compiler-resolution.test.ts packages/plugin-runtime/src/registry.ts packages/plugin-runtime/src/manager.ts packages/plugin-runtime/src/errors.ts packages/plugin-runtime/src/index.ts packages/plugin-runtime/src/registry.test.ts packages/plugin-runtime/src/manager.test.ts apps/desktop/src/main/plugins/controller.ts apps/desktop/src/renderer/settings/plugin-copy.ts
pnpm exec prettier --check packages/plugin-runtime/src apps/desktop/src/main/plugins/controller.ts apps/desktop/src/renderer/settings/plugin-copy.ts
pnpm exec eslint packages/plugin-runtime/src apps/desktop/src/main/plugins/controller.ts apps/desktop/src/renderer/settings/plugin-copy.ts
```

- [ ] **Step 7: Commit**

```bash
git add packages/plugin-runtime/src/compiler-resolution.ts packages/plugin-runtime/src/compiler-resolution.test.ts packages/plugin-runtime/src/registry.ts packages/plugin-runtime/src/manager.ts packages/plugin-runtime/src/errors.ts packages/plugin-runtime/src/index.ts packages/plugin-runtime/src/registry.test.ts packages/plugin-runtime/src/manager.test.ts apps/desktop/src/main/plugins/controller.ts apps/desktop/src/renderer/settings/plugin-copy.ts
git commit -m "feat(plugin-runtime): resolve compiler providers without first-wins conflicts" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 3: 通用型別、內建工廠與 EV3 adapter

**Files:**

- Modify: `packages/compiler/src/contracts.ts:20–84`（通用成品契約）
- Create: `packages/compiler/src/build-error.ts`（固定建置錯誤與失敗結果）
- Modify: `packages/compiler/src/index.ts:1–末尾`、`packages/compiler/package.json:22–28`、`packages/compiler/tsconfig.json:9`（protocol 型別依賴）
- Modify: `pnpm-lock.yaml`（compiler importer 的 workspace 依賴）
- Modify: `packages/backend-ev3/src/backend.ts:1,3832–3884`（EV3Result）
- Create: `plugins/ev3/kobrixa-plugin.json`（內建後端宣告）
- Create: `apps/desktop/src/main/workspace/builtin-compilers.ts`（兩張工廠表）
- Modify: `apps/desktop/src/main/plugins/builtin.ts:1–8`（加入 EV3）
- Test: `apps/desktop/src/main/plugins/builtin.test.ts:1–15`
- Modify: `packages/compiler/src/diagnostic-help.ts:1327`（六個雙語說明）
- Test: `packages/compiler/src/diagnostic-help.test.ts:50–58`（94／BUILD: 8）

**Interfaces:**

- Consumes：`CompilerSnapshot = { ok: true; frontend: ProviderRef<FrontendDecl>; backend: ProviderRef<BackendDecl>; ir: number }`（Task 2）；`BasicPlusFrontend.compile(project: SourceProject, signal: AbortSignal): Promise<FrontendResult>`；原 `EV3Backend.compile(ir: KobrixaIR, signal: AbortSignal): Promise<{ rbf?: Uint8Array; listing?: string; diagnostics: Diagnostic[] }>`。
- Produces：`EV3Result = { rbf?: Uint8Array; listing?: string; diagnostics: Diagnostic[] }`，`EV3Backend.compile(ir: KobrixaIR, signal: AbortSignal): Promise<EV3Result>`；演算法與 EV39000 不改。
- Produces：`CompilerBackend = { id: string; declaration: BackendDecl; irVersion: number; compile(ir: KobrixaIR, signal: AbortSignal): Promise<BackendResult> }`；`BackendResult = { artifacts: { slot: string; data: Uint8Array }[]; diagnostics: Diagnostic[] }`。
- Produces：`createBuiltinCompilers(snapshot: CompilerSnapshot): { frontend: LanguageFrontend; backend: CompilerBackend }`；工廠鍵為 `${pluginId}:${language}`／`${pluginId}:${target}`；unknown factory 拋 `BuildError("BUILD1001", message)`。
- Produces：`BuildArtifact`、`CompileResult`、`MemoryArtifact`、`CompileMemoryResult`，完整定義見 Step 3；`BuildError(code: BuildErrorCode, message: string)`、`failedBuild(buildId: string, target: string, error: unknown, entry: string, diagnostics?: Diagnostic[]): CompileResult`。

- [ ] **Step 1: 寫失敗的內建註冊測試**

以以下全文取代 `apps/desktop/src/main/plugins/builtin.test.ts`：

```ts
import { expect, it } from "vitest";
import { loadPlugins, resolveCompilerProviders } from "@kobrixa/plugin-runtime";
import { BasicPlusFrontend } from "@kobrixa/basic-plus";
import { EV3Backend } from "@kobrixa/backend-ev3";
import { BUILTIN_PLUGIN_SOURCES } from "./builtin.js";
import { createBuiltinCompilers } from "../workspace/builtin-compilers.js";

it("registers separate Basic Plus and EV3 providers in safe mode", async () => {
  const plugins = await loadPlugins(BUILTIN_PLUGIN_SOURCES, {
    disabled: new Set(),
    safeMode: true,
  });
  expect(plugins.map((plugin) => [plugin.id, plugin.status])).toEqual([
    ["kobrixa.basic-plus", "enabled"],
    ["kobrixa.ev3", "enabled"],
  ]);
  const snapshot = resolveCompilerProviders(plugins, "bp", "ev3-native");
  if (!snapshot.ok) throw new Error(snapshot.message);
  const { frontend, backend } = createBuiltinCompilers(snapshot);
  expect(frontend).toBeInstanceOf(BasicPlusFrontend);
  const project = {
    root: "/unused",
    manifest: {
      schemaVersion: 1 as const,
      name: "demo",
      language: "bp",
      target: "ev3-native",
      entry: "main.bp",
      outputDir: "build",
      assets: [],
    },
    sources: [{ path: "main.bp", content: "LCD.Clear()\n" }],
    assets: [],
  };
  const signal = new AbortController().signal;
  const compiled = await frontend.compile(project, signal);
  const raw = await new EV3Backend().compile(compiled.ir!, signal);
  const adapted = await backend.compile(compiled.ir!, signal);
  expect(adapted).toEqual({
    artifacts: [
      { slot: "program", data: raw.rbf },
      { slot: "listing", data: new TextEncoder().encode(raw.listing) },
    ],
    diagnostics: raw.diagnostics,
  });
  expect(backend.declaration.capabilities.deploy).toBe("ev3");
  expect(backend.irVersion).toBe(1);
  expect(() =>
    createBuiltinCompilers({
      ...snapshot,
      backend: { ...snapshot.backend, pluginId: "test.missing" },
    }),
  ).toThrow("BUILD1001");
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter @kobrixa/plugin-runtime build && pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/builtin.test.ts`
Expected: FAIL，缺少 `builtin-compilers.js`；內建清單只有 Basic Plus。

- [ ] **Step 3: 實作通用型別與具 code 的例外**

`contracts.ts` 新增 `import type { BackendDecl } from "@kobrixa/plugin-protocol";`。以以下定義取代既有 BuildArtifact／CompileResult／BackendResult／CompilerBackend，將 ProjectManifest 的 language、target 與 LanguageFrontend.id 改成 `string`；其餘既有 SourceRange／Diagnostic／SourceProject／BuildProgress 保留：

```ts
export interface BuildArtifact {
  slot: string;
  kind: string;
  role: "deploy-main" | "deploy-asset" | "aux";
  mediaType: string;
  path: string;
  sha256: string;
  byteLength: number;
  remotePath?: string;
}
export interface CompileResult {
  buildId: string;
  target: string;
  deploy?: "ev3";
  runtimeDirectory?: string;
  success: boolean;
  diagnostics: Diagnostic[];
  artifacts: BuildArtifact[];
}
export interface BackendResult {
  artifacts: Array<{ slot: string; data: Uint8Array }>;
  diagnostics: Diagnostic[];
}
export interface CompilerBackend {
  id: string;
  declaration: BackendDecl;
  irVersion: number;
  compile(ir: KobrixaIR, signal: AbortSignal): Promise<BackendResult>;
}
export interface MemoryArtifact {
  slot: string;
  kind: string;
  role: BuildArtifact["role"];
  mediaType: string;
  relativePath: string;
  data: Uint8Array;
  remotePath?: string;
}
export type CompileMemoryResult =
  | {
      success: true;
      ir: KobrixaIR;
      diagnostics: Diagnostic[];
      artifacts: MemoryArtifact[];
      runtimeDirectory?: string;
    }
  | { success: false; diagnostics: Diagnostic[]; artifacts: [] };
```

`build-error.ts` 全文：

```ts
import type { CompileResult, Diagnostic } from "./contracts.js";
import { diagnostic } from "./diagnostics.js";
export type BuildErrorCode =
  | "BUILD0001"
  | "BUILD1001"
  | "BUILD1002"
  | "BUILD1003"
  | "BUILD1004"
  | "BUILD1005"
  | "BUILD1006"
  | "BUILD9000";
export class BuildError extends Error {
  constructor(
    readonly code: BuildErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "BuildError";
  }
}
export function failedBuild(
  buildId: string,
  target: string,
  error: unknown,
  entry: string,
  diagnostics: Diagnostic[] = [],
): CompileResult {
  const code =
    error instanceof BuildError
      ? error.code
      : error instanceof Error && error.name === "AbortError"
        ? "BUILD0001"
        : "BUILD9000";
  const message =
    code === "BUILD0001"
      ? "Build cancelled."
      : error instanceof Error
        ? error.message
        : String(error);
  return {
    buildId,
    target,
    success: false,
    artifacts: [],
    diagnostics: [...diagnostics, diagnostic(code, message, entry)],
  };
}
```

compiler index 加 `export * from "./build-error.js";`。package dependencies 加 `"@kobrixa/plugin-protocol": "workspace:*"`；tsconfig references 增加 `{ "path": "../plugin-protocol" }`。執行 `pnpm install --lockfile-only --ignore-scripts --offline` 更新 lockfile，確認只多這個 importer 依賴，沒有改解析版本。

- [ ] **Step 4: EV3 保留原始結果、內建 adapter 轉通用成品**

`backend.ts` 第一行改成 `import type { Diagnostic } from "@kobrixa/compiler";`，在 `EV3Backend` 前新增：

```ts
export interface EV3Result {
  rbf?: Uint8Array;
  listing?: string;
  diagnostics: Diagnostic[];
}
```

`export class EV3Backend implements CompilerBackend` 改成 `export class EV3Backend`；`compile` 回傳型別改成 `Promise<EV3Result>`，`emit` 回傳型別改成 `EV3Result`，方法本體一字不動。backend-ev3 的 index 已 `export *`，會同時匯出 EV3Result。

建立 `plugins/ev3/kobrixa-plugin.json`：

```json
{
  "id": "kobrixa.ev3",
  "version": "1.0.0",
  "apiVersion": "^1.1.0",
  "displayName": { "en": "EV3 native backend", "zh-TW": "EV3 原生後端" },
  "runtime": { "kind": "builtin" },
  "contributes": {
    "backends": [
      {
        "target": "ev3-native",
        "ir": { "min": 1, "max": 1 },
        "capabilities": { "deploy": "ev3" },
        "artifacts": [
          {
            "slot": "program",
            "kind": "rbf",
            "extension": "rbf",
            "mediaType": "application/octet-stream",
            "role": "deploy-main",
            "required": true
          },
          {
            "slot": "listing",
            "kind": "listing",
            "extension": "lst",
            "mediaType": "text/plain",
            "role": "aux",
            "required": false
          }
        ]
      }
    ]
  }
}
```

`builtin-compilers.ts` 全文：

```ts
import { BasicPlusFrontend } from "@kobrixa/basic-plus";
import { EV3Backend } from "@kobrixa/backend-ev3";
import type { CompilerBackend, LanguageFrontend } from "@kobrixa/compiler";
import { BuildError } from "../../../../../packages/compiler/src/build-error.js";
import type { CompilerSnapshot } from "@kobrixa/plugin-runtime";
import type { BackendDecl } from "@kobrixa/plugin-protocol";

const key = (pluginId: string, id: string): string => `${pluginId}:${id}`;
export const BUILTIN_FRONTENDS: Readonly<Record<string, () => LanguageFrontend>> = {
  "kobrixa.basic-plus:bp": () => new BasicPlusFrontend(),
};
export const BUILTIN_BACKENDS: Readonly<
  Record<string, (declaration: BackendDecl, irVersion: number) => CompilerBackend>
> = {
  "kobrixa.ev3:ev3-native": (declaration, irVersion) => ({
    id: declaration.target,
    declaration: structuredClone(declaration),
    irVersion,
    async compile(ir, signal) {
      const result = await new EV3Backend().compile(ir, signal);
      return {
        artifacts: [
          ...(result.rbf ? [{ slot: "program", data: result.rbf }] : []),
          ...(result.listing === undefined
            ? []
            : [{ slot: "listing", data: new TextEncoder().encode(result.listing) }]),
        ],
        diagnostics: result.diagnostics,
      };
    },
  }),
};
export function createBuiltinCompilers(snapshot: CompilerSnapshot): {
  frontend: LanguageFrontend;
  backend: CompilerBackend;
} {
  const front = snapshot.frontend;
  const back = snapshot.backend;
  const createFrontend = BUILTIN_FRONTENDS[key(front.pluginId, front.contribution.language)];
  const createBackend = BUILTIN_BACKENDS[key(back.pluginId, back.contribution.target)];
  if (!createFrontend || !createBackend)
    throw new BuildError(
      "BUILD1001",
      "No built-in compiler factory matches the provider snapshot.",
    );
  return { frontend: createFrontend(), backend: createBackend(back.contribution, snapshot.ir) };
}
```

為了讓本 task 的 adapter 測試直接使用尚未 build 的 compiler 新檔，上述 BuildError 暫用原始碼 import；Task 6 完成 compiler build 後，同 task 的收尾會改為正式 package import。這是明列的中間接線，不新增不同的錯誤型別。

`plugins/builtin.ts` 加 import 與第二筆來源：

```ts
import ev3 from "../../../../../plugins/ev3/kobrixa-plugin.json" with { type: "json" };
```

```ts
{ kind: "builtin", manifest: ev3 },
```

舊 `builtin-frontends.ts` 此時保留，讓尚未遷移的 worker 仍可載入；不在舊表註冊假實作。Task 6 將刪除整檔及其引用。

- [ ] **Step 5: 加六個雙語診斷說明**

在 `diagnostic-help.ts` 的 `BUILD9000` entry 前加入以下完整項目：

```ts
entry("BUILD1001", ["找不到編譯提供者", "Compiler provider unavailable"],
  ["找不到已啟用的語言／目標提供者，或有多個提供者衝突。", "The language or target has no enabled provider, or multiple providers conflict."],
  [["檢查 kobrixa.json 的 language／target 與插件狀態；衝突時先排除重複提供者。", "Check language/target in kobrixa.json and plugin status; remove conflicting providers."]], "architecture"),
entry("BUILD1002", ["IR 版本不相容", "Incompatible IR versions"],
  ["前端產出的 IR 版本與目標不相容。", "The frontend IR version is incompatible with the target."],
  [["使用支援相同 KobrixaIR 版本的語言前端與目標後端。", "Use a frontend and target backend that support the same KobrixaIR version."]], "architecture"),
entry("BUILD1003", ["建置成品無效", "Invalid build artifacts"],
  ["成品不符合宣告、路徑不安全、名稱碰撞，或超過建置上限。", "Artifacts violate their declarations, use unsafe or colliding paths, or exceed build limits."],
  [["檢查成品宣告、資源路徑與大小，修正後重新建置。", "Check artifact declarations, resource paths and sizes, then build again."]], "architecture"),
entry("BUILD1004", ["建置輸出正被使用", "Build output is busy"],
  ["另一個 Kobrixa 視窗正在寫入這個專案的建置輸出。", "Another Kobrixa window is writing this project's build output."],
  [["等待另一個視窗完成建置再重試；不要刪除仍在使用中的鎖。", "Wait for the other window to finish and retry; do not remove an active lock."]], "architecture"),
entry("BUILD1005", ["目標不可部署", "Target cannot be deployed"],
  ["這次建置的目標不支援目前設備的部署方式。", "This build target does not support the connected device's deployment method."],
  [["建置結果仍可使用；要部署至 EV3，請選擇提供 ev3 部署能力的目標。", "The successful build remains available; choose a target with ev3 deployment capability to deploy to EV3."]], "architecture"),
entry("BUILD1006", ["成品已變更", "Build artifacts changed"],
  ["成品已變更，請重新建置。", "Build artifacts changed or are missing; build again."],
  [["重新建置再部署，並避免其他視窗或工具在部署前修改輸出檔案。", "Build again before deploying and prevent other windows or tools from changing the output files."]], "architecture"),
```

`diagnostic-help.test.ts` 原 `toBe(88)` 改 `toBe(94)`，`BUILD: 2` 改 `BUILD: 8`；加：

```ts
it.each(["BUILD1001", "BUILD1002", "BUILD1003", "BUILD1004", "BUILD1005", "BUILD1006"])(
  "documents %s in both locales",
  (code) => {
    const help = getDiagnosticHelp(code)!;
    expect(help.title.en).toBeTruthy();
    expect(help.title["zh-TW"]).toBeTruthy();
    expect(diagnosticDocumentationUrl(code, undefined, "en")).toBe(
      `https://kobrixa.com/docs/diagnostics/${code}?lang=en`,
    );
    expect(diagnosticDocumentationUrl(code, undefined, "zh-TW")).toBe(
      `https://kobrixa.com/docs/diagnostics/${code}?lang=zh-TW`,
    );
  },
);
```

- [ ] **Step 6: 執行測試確認通過**

Run: `pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/builtin.test.ts && pnpm --filter @kobrixa/backend-ev3 test && pnpm --filter @kobrixa/compiler exec vitest run src/diagnostic-help.test.ts`
Expected: PASS；adapter 的 rbf／listing bytes 與原 EV3Result 完全相同。完整 compiler 型別遷移會在 Task 6 取代舊 BuildSession，最後由 Task 8 全庫 check 驗收。

- [ ] **Step 7: 格式化與 lint**

```bash
pnpm exec prettier --write packages/compiler/src/contracts.ts packages/compiler/src/build-error.ts packages/compiler/src/index.ts packages/compiler/src/diagnostic-help.ts packages/compiler/src/diagnostic-help.test.ts packages/compiler/package.json packages/compiler/tsconfig.json packages/backend-ev3/src/backend.ts plugins/ev3/kobrixa-plugin.json apps/desktop/src/main/workspace/builtin-compilers.ts apps/desktop/src/main/plugins/builtin.ts apps/desktop/src/main/plugins/builtin.test.ts pnpm-lock.yaml
pnpm exec prettier --check packages/compiler/src/contracts.ts packages/compiler/src/build-error.ts packages/compiler/src/index.ts packages/compiler/src/diagnostic-help.ts packages/compiler/src/diagnostic-help.test.ts packages/compiler/package.json packages/compiler/tsconfig.json packages/backend-ev3/src/backend.ts plugins/ev3/kobrixa-plugin.json apps/desktop/src/main/workspace/builtin-compilers.ts apps/desktop/src/main/plugins/builtin.ts apps/desktop/src/main/plugins/builtin.test.ts pnpm-lock.yaml
pnpm exec eslint packages/compiler/src/contracts.ts packages/compiler/src/build-error.ts packages/compiler/src/index.ts packages/compiler/src/diagnostic-help.ts packages/compiler/src/diagnostic-help.test.ts packages/backend-ev3/src/backend.ts apps/desktop/src/main/workspace/builtin-compilers.ts apps/desktop/src/main/plugins/builtin.ts apps/desktop/src/main/plugins/builtin.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add packages/compiler/src/contracts.ts packages/compiler/src/build-error.ts packages/compiler/src/index.ts packages/compiler/src/diagnostic-help.ts packages/compiler/src/diagnostic-help.test.ts packages/compiler/package.json packages/compiler/tsconfig.json packages/backend-ev3/src/backend.ts plugins/ev3/kobrixa-plugin.json apps/desktop/src/main/workspace/builtin-compilers.ts apps/desktop/src/main/plugins/builtin.ts apps/desktop/src/main/plugins/builtin.test.ts pnpm-lock.yaml
git commit -m "feat(compiler): define generic artifacts and built-in compiler adapters" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 4: 成品驗證、路徑安全與 BUILD_LIMITS

**Files:**

- Create: `packages/compiler/src/artifacts.ts`（記憶體成品驗證與 layout）
- Create: `packages/compiler/src/safe-files.ts`（不跟隨連結的受限讀取）
- Create: `packages/compiler/src/test-build.ts`（只供測試匯入的假編譯器及 IR）
- Modify: `packages/compiler/src/index.ts:1–末尾`（公開 validator 與常數）
- Test: `packages/compiler/src/artifacts.test.ts`（新）

**Interfaces:**

- Consumes：`BackendDecl = { target: string; ir: { min: number; max: number }; capabilities: { deploy?: "ev3" }; artifacts: ArtifactDecl[] }`；`BackendResult = { artifacts: { slot: string; data: Uint8Array }[]; diagnostics: Diagnostic[] }`。
- Consumes：`SourceProject = { root: string; manifest: ProjectManifest; sources: SourceFile[]; assets: { path: string; absolutePath: string }[] }`；`MemoryArtifact = { slot: string; kind: string; role: "aux" | "deploy-main" | "deploy-asset"; mediaType: string; relativePath: string; data: Uint8Array; remotePath?: string }`。
- Produces：`BUILD_LIMITS` 六個欄位 `backendArtifacts`／`artifacts`／`artifactBytes`／`totalBytes`／`filenameBytes`／`relativePathBytes`。
- Produces：`safeProjectName(name: string): string`；`validateBuildLimits(backendCount: number, entries: readonly { relativePath: string; byteLength: number }[]): void`；`validateArtifactLayout(entries: readonly { relativePath: string; remotePath?: string }[]): void`。
- Produces：`validateArtifacts(project: SourceProject, declaration: BackendDecl, result: BackendResult, ir: KobrixaIR, signal: AbortSignal): Promise<MemoryArtifact[]>`。
- Produces：`assertSafeRelative(relative: string): string`；`assertNoSymlinks(root: string, relative: string, allowMissing?: boolean): Promise<string>`；`readBoundedFile(root: string, relative: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array>`。無論來自 glob 或直接傳入 SourceProject，資源都要重新驗證。

- [ ] **Step 1: 寫失敗的路徑、slot 與每個上限測試**

建立 `test-build.ts`（只由 `.test.ts` 匯入，不從 index 匯出）：

```ts
import type { BackendDecl } from "@kobrixa/plugin-protocol";
import type { KobrixaIR } from "@kobrixa/ir";
import type { CompilerBackend, LanguageFrontend, SourceProject } from "./contracts.js";
export const minimalIR: KobrixaIR = {
  version: 1,
  program: { name: "demo", entryFunction: "main" },
  globals: [],
  functions: [
    {
      name: "main",
      parameters: [],
      returnType: { kind: "void" },
      locals: [],
      entryBlock: "entry",
      blocks: [{ id: "entry", instructions: [], terminator: { op: "stop" } }],
    },
  ],
  resources: [],
  sourceFiles: ["main.toy"],
};
export const TEST_BACKEND_DECL: BackendDecl = {
  target: "toy-vm",
  ir: { min: 1, max: 1 },
  capabilities: { deploy: "ev3" },
  artifacts: [
    {
      slot: "program",
      kind: "toy-image",
      extension: "bin",
      mediaType: "application/octet-stream",
      role: "deploy-main",
      required: true,
    },
    {
      slot: "notes",
      kind: "notes",
      extension: "txt",
      mediaType: "text/plain",
      role: "aux",
      required: false,
    },
    {
      slot: "map",
      kind: "source-map",
      extension: "map",
      mediaType: "application/json",
      role: "aux",
      required: false,
    },
  ],
};
export function testProject(root: string): SourceProject {
  return {
    root,
    manifest: {
      schemaVersion: 1,
      name: "demo",
      language: "toy",
      target: "toy-vm",
      entry: "main.toy",
      outputDir: "build",
      assets: [],
    },
    sources: [{ path: "main.toy", content: "test" }],
    assets: [],
  };
}
export const testFrontend: LanguageFrontend = {
  id: "toy",
  compile: async () => ({ ir: structuredClone(minimalIR), diagnostics: [] }),
};
export function testBackend(): CompilerBackend {
  return {
    id: "toy-vm",
    declaration: structuredClone(TEST_BACKEND_DECL),
    irVersion: 1,
    compile: async () => ({
      artifacts: [{ slot: "program", data: new Uint8Array([1, 2, 3]) }],
      diagnostics: [],
    }),
  };
}
```

建立 `artifacts.test.ts`：

```ts
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  BUILD_LIMITS,
  validateArtifacts,
  validateArtifactLayout,
  validateBuildLimits,
} from "./artifacts.js";
import { minimalIR, TEST_BACKEND_DECL, testProject } from "./test-build.js";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-artifacts-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));
const data = new Uint8Array([1]);
const signal = () => new AbortController().signal;
const entry = (relativePath = "x", byteLength = 1) => ({ relativePath, byteLength });
it("accepts every numeric limit exactly and rejects one beyond", () => {
  expect(BUILD_LIMITS).toEqual({
    backendArtifacts: 64,
    artifacts: 1024,
    artifactBytes: 64 * 1024 * 1024,
    totalBytes: 256 * 1024 * 1024,
    filenameBytes: 128,
    relativePathBytes: 512,
  });
  expect(() => validateBuildLimits(64, [entry()])).not.toThrow();
  expect(() => validateBuildLimits(65, [entry()])).toThrow("BUILD1003");
  expect(() =>
    validateBuildLimits(
      0,
      Array.from({ length: 1024 }, (_, i) => entry(`f${i}`)),
    ),
  ).not.toThrow();
  expect(() =>
    validateBuildLimits(
      0,
      Array.from({ length: 1025 }, (_, i) => entry(`f${i}`)),
    ),
  ).toThrow("BUILD1003");
  expect(() => validateBuildLimits(1, [entry("a", 64 * 1024 * 1024)])).not.toThrow();
  expect(() => validateBuildLimits(1, [entry("a", 64 * 1024 * 1024 + 1)])).toThrow("BUILD1003");
  const maximum = Array.from({ length: 4 }, (_, i) => entry(`a${i}`, 64 * 1024 * 1024));
  expect(() => validateBuildLimits(4, maximum)).not.toThrow();
  expect(() => validateBuildLimits(4, [...maximum, entry("extra")])).toThrow("BUILD1003");
  expect(() => validateBuildLimits(1, [entry("é".repeat(64))])).not.toThrow();
  expect(() => validateBuildLimits(1, [entry("é".repeat(64) + "x")])).toThrow("BUILD1003");
  const exactPath = ["a".repeat(127), "b".repeat(127), "c".repeat(127), "d".repeat(128)].join("/");
  expect(Buffer.byteLength(exactPath)).toBe(512);
  expect(() => validateBuildLimits(1, [entry(exactPath)])).not.toThrow();
  expect(() => validateBuildLimits(1, [entry("x/" + exactPath)])).toThrow("BUILD1003");
});
it.each(
  [
    [{ slot: "unknown", data }],
    [
      { slot: "program", data },
      { slot: "program", data },
    ],
    [],
    [{ slot: "program", data: new Uint8Array() }],
  ].map((artifacts) => ({ artifacts })),
)("rejects undeclared, duplicate, missing or empty-main slots (%#)", async ({ artifacts }) => {
  await expect(
    validateArtifacts(
      testProject(root),
      TEST_BACKEND_DECL,
      { artifacts, diagnostics: [] },
      minimalIR,
      signal(),
    ),
  ).rejects.toThrow("BUILD1003");
  expect(await readdir(root)).toEqual([]);
});
it("rejects NFC case collisions, reserved paths and file-directory conflicts", () => {
  for (const paths of [
    ["assets/É.txt", "assets/e\u0301.TXT"],
    [".kobrixa-build.lock"],
    ["assets/.KOBRIXA-other"],
    ["assets/a", "assets/A/b"],
    ["demo.bin", "DEMO.BIN"],
  ])
    expect(() => validateArtifactLayout(paths.map((relativePath) => ({ relativePath })))).toThrow(
      "BUILD1003",
    );
  expect(() =>
    validateArtifactLayout([
      { relativePath: "demo.bin" },
      { relativePath: "assets/demo.bin", remotePath: "DEMO.BIN" },
    ]),
  ).toThrow("BUILD1003");
});
it("rejects asset symlinks and traversal before output exists", async () => {
  await writeFile(path.join(root, "real.txt"), "safe");
  await symlink(path.join(root, "real.txt"), path.join(root, "link.txt"));
  await mkdir(path.join(root, "folder"));
  await writeFile(path.join(root, "folder/x.txt"), "safe");
  await symlink(path.join(root, "folder"), path.join(root, "linked"), "dir");
  for (const relative of [
    "link.txt",
    "linked/x.txt",
    "../outside",
    "/absolute",
    "C:\\outside",
    "a/../real.txt",
  ]) {
    const project = testProject(root);
    project.assets = [{ path: relative, absolutePath: path.resolve(root, relative) }];
    await expect(
      validateArtifacts(
        project,
        TEST_BACKEND_DECL,
        { artifacts: [{ slot: "program", data }], diagnostics: [] },
        minimalIR,
        signal(),
      ),
    ).rejects.toThrow("BUILD1003");
  }
  expect(await readdir(root)).not.toContain("build");
});
it("owns metadata, snapshots backend bytes and accepts optional aux absence", async () => {
  const bytes = new Uint8Array([9]);
  const result = await validateArtifacts(
    testProject(root),
    TEST_BACKEND_DECL,
    { artifacts: [{ slot: "program", data: bytes }], diagnostics: [] },
    minimalIR,
    signal(),
  );
  bytes[0] = 0;
  expect(result.map((item) => [item.slot, item.role, item.relativePath])).toEqual([
    ["program", "deploy-main", "demo.bin"],
    ["ir", "aux", "demo.ir.json"],
  ]);
  expect(result[0]!.data[0]).toBe(9);
});
it("rejects declared filename collisions and counts host IR and resources", async () => {
  const declaration = structuredClone(TEST_BACKEND_DECL);
  declaration.artifacts[1]!.extension = "bin";
  await expect(
    validateArtifacts(
      testProject(root),
      declaration,
      {
        artifacts: [
          { slot: "program", data },
          { slot: "notes", data },
        ],
        diagnostics: [],
      },
      minimalIR,
      signal(),
    ),
  ).rejects.toThrow("BUILD1003");
  await writeFile(path.join(root, "a.txt"), "asset");
  const project = testProject(root);
  project.assets = [{ path: "a.txt", absolutePath: path.join(root, "a.txt") }];
  const result = await validateArtifacts(
    project,
    TEST_BACKEND_DECL,
    { artifacts: [{ slot: "program", data }], diagnostics: [] },
    minimalIR,
    signal(),
  );
  expect(result).toHaveLength(3);
  expect(result[2]).toMatchObject({
    slot: "asset",
    role: "deploy-asset",
    relativePath: "assets/a.txt",
    remotePath: "a.txt",
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter @kobrixa/compiler exec vitest run src/artifacts.test.ts`
Expected: FAIL，找不到 artifacts 模組；不以記憶體配置 256 MiB 來測純計數邊界，實際讀取上限另由 Step 5 的檔案測試釘住。

- [ ] **Step 3: 實作路徑檢查與有上限的檔案讀取**

`safe-files.ts` 全文：

```ts
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { BuildError } from "./build-error.js";
const invalid = (message: string): never => {
  throw new BuildError("BUILD1003", message);
};
export function assertSafeRelative(relative: string): string {
  if (
    !relative ||
    path.posix.isAbsolute(relative) ||
    path.win32.isAbsolute(relative) ||
    relative.includes("\\") ||
    relative.includes(":")
  )
    return invalid("Artifact paths must be portable project-relative paths.");
  const parts = relative.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.normalize("NFC").toLowerCase().startsWith(".kobrixa") ||
        [...part].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
    )
  )
    return invalid("Unsafe or reserved artifact path.");
  return relative;
}
export async function assertNoSymlinks(
  root: string,
  relative: string,
  allowMissing = false,
): Promise<string> {
  assertSafeRelative(relative);
  const canonicalRoot = await realpath(root);
  let cursor = canonicalRoot;
  const parts = relative.split("/");
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]!);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) invalid("Artifact paths must not pass through symbolic links.");
      if (i < parts.length - 1 && !info.isDirectory())
        invalid("An artifact parent is not a directory.");
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return cursor;
}
export async function readBoundedFile(
  root: string,
  relative: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  const file = await assertNoSymlinks(root, relative);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes)
      invalid("Artifact exceeds the remaining byte budget.");
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      signal.throwIfAborted();
      const chunk = new Uint8Array(Math.min(64 * 1024, Math.max(1, maxBytes - total + 1)));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) invalid("Artifact grew beyond the remaining byte budget.");
      chunks.push(chunk.slice(0, bytesRead));
    }
    const after = await handle.stat();
    await assertNoSymlinks(root, relative);
    const current = await lstat(file);
    if (
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      total !== after.size
    )
      invalid("A resource changed while capturing the build snapshot.");
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}
```

- [ ] **Step 4: 實作宣告驗證、layout 與六個常數**

`artifacts.ts` 全文：

```ts
import { serializeIR, type KobrixaIR } from "@kobrixa/ir";
import type { BackendDecl } from "@kobrixa/plugin-protocol";
import type { BackendResult, MemoryArtifact, SourceProject } from "./contracts.js";
import { BuildError } from "./build-error.js";
import { assertSafeRelative, readBoundedFile } from "./safe-files.js";
export const BUILD_LIMITS = {
  backendArtifacts: 64,
  artifacts: 1024,
  artifactBytes: 64 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  filenameBytes: 128,
  relativePathBytes: 512,
} as const;
const invalid = (message: string): never => {
  throw new BuildError("BUILD1003", message);
};
export function safeProjectName(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "program"
  );
}
export function validateBuildLimits(
  backendCount: number,
  entries: readonly { relativePath: string; byteLength: number }[],
): void {
  if (backendCount > BUILD_LIMITS.backendArtifacts || entries.length > BUILD_LIMITS.artifacts)
    invalid("Too many build artifacts.");
  let total = 0;
  for (const entry of entries) {
    if (
      !Number.isSafeInteger(entry.byteLength) ||
      entry.byteLength < 0 ||
      entry.byteLength > BUILD_LIMITS.artifactBytes
    )
      invalid("A build artifact exceeds 64 MiB.");
    total += entry.byteLength;
    if (total > BUILD_LIMITS.totalBytes) invalid("Build artifacts exceed 256 MiB.");
    if (
      Buffer.byteLength(entry.relativePath, "utf8") > BUILD_LIMITS.relativePathBytes ||
      entry.relativePath
        .split("/")
        .some((part) => Buffer.byteLength(part, "utf8") > BUILD_LIMITS.filenameBytes)
    )
      invalid("Artifact path exceeds the UTF-8 byte limit.");
  }
}
export function validateArtifactLayout(
  entries: readonly { relativePath: string; remotePath?: string }[],
): void {
  const check = (paths: string[]) => {
    const names = new Set<string>();
    for (const relative of paths) {
      const normalized = assertSafeRelative(relative).normalize("NFC").toLowerCase();
      if (names.has(normalized)) invalid("Artifact paths collide after NFC/case normalization.");
      names.add(normalized);
    }
    for (const name of names) {
      const parts = name.split("/");
      for (let i = 1; i < parts.length; i++)
        if (names.has(parts.slice(0, i).join("/")))
          invalid("Artifact file and directory paths collide.");
    }
  };
  check(entries.map((entry) => entry.relativePath));
  // 同時檢查部署的相對命名空間，避免資源覆蓋同名程式。
  check(entries.map((entry) => entry.remotePath ?? entry.relativePath));
}
export async function validateArtifacts(
  project: SourceProject,
  declaration: BackendDecl,
  result: BackendResult,
  ir: KobrixaIR,
  signal: AbortSignal,
): Promise<MemoryArtifact[]> {
  try {
    signal.throwIfAborted();
    if (result.artifacts.length > BUILD_LIMITS.backendArtifacts)
      invalid("Too many backend artifacts.");
    const seen = new Set<string>();
    const base = safeProjectName(project.manifest.name);
    const artifacts: MemoryArtifact[] = [];
    let backendBytes = 0;
    const declarations = new Map(declaration.artifacts.map((item) => [item.slot, item]));
    if (
      declarations.size !== declaration.artifacts.length ||
      declarations.has("ir") ||
      declarations.has("asset")
    )
      invalid("Duplicate or reserved declared slot.");
    for (const item of result.artifacts) {
      const declared = declarations.get(item.slot);
      if (!declared || seen.has(item.slot)) invalid("Undeclared or duplicate backend slot.");
      seen.add(item.slot);
      if (!(item.data instanceof Uint8Array)) invalid("Artifact data must be Uint8Array.");
      if (declared!.role === "deploy-main" && !item.data.byteLength)
        invalid("deploy-main must not be empty.");
      if (item.data.byteLength > BUILD_LIMITS.artifactBytes)
        invalid("A build artifact exceeds 64 MiB.");
      backendBytes += item.data.byteLength;
      if (backendBytes > BUILD_LIMITS.totalBytes) invalid("Build artifacts exceed 256 MiB.");
      artifacts.push({
        slot: declared!.slot,
        kind: declared!.kind,
        role: declared!.role,
        mediaType: declared!.mediaType,
        relativePath: `${base}.${declared!.extension}`,
        data: Uint8Array.from(item.data),
      });
    }
    if (declaration.artifacts.some((item) => item.required && !seen.has(item.slot)))
      invalid("Missing required backend slot.");
    const mains = artifacts.filter((item) => item.role === "deploy-main");
    const declaredMains = declaration.artifacts.filter((item) => item.role === "deploy-main");
    if (
      declaration.capabilities.deploy &&
      (mains.length !== 1 || declaredMains.length !== 1 || !declaredMains[0]!.required)
    )
      invalid("A deployable backend requires one non-empty required main.");
    const irText = serializeIR(ir);
    const irBytes = Buffer.byteLength(irText, "utf8");
    if (irBytes > BUILD_LIMITS.artifactBytes || backendBytes + irBytes > BUILD_LIMITS.totalBytes)
      invalid("Serialized IR exceeds the remaining artifact byte budget.");
    artifacts.push({
      slot: "ir",
      kind: "ir",
      role: "aux",
      mediaType: "application/json",
      relativePath: `${base}.ir.json`,
      data: new TextEncoder().encode(irText),
    });
    const assets = project.assets.map((asset) => ({
      slot: "asset",
      kind: "asset",
      role: "deploy-asset" as const,
      mediaType: "application/octet-stream",
      relativePath: `assets/${assertSafeRelative(asset.path.replaceAll("\\", "/"))}`,
      remotePath: asset.path.replaceAll("\\", "/"),
    }));
    // 所有路徑、數量先檢查，再開來源資源；不信任傳入的 absolutePath。
    validateArtifactLayout([...artifacts, ...assets]);
    validateBuildLimits(result.artifacts.length, [
      ...artifacts.map((item) => ({ ...item, byteLength: item.data.byteLength })),
      ...assets.map((item) => ({ ...item, byteLength: 0 })),
    ]);
    let total = artifacts.reduce((sum, item) => sum + item.data.byteLength, 0);
    for (const asset of assets) {
      const data = await readBoundedFile(
        project.root,
        asset.remotePath,
        Math.min(BUILD_LIMITS.artifactBytes, BUILD_LIMITS.totalBytes - total),
        signal,
      );
      total += data.byteLength;
      artifacts.push({ ...asset, data });
    }
    validateBuildLimits(
      result.artifacts.length,
      artifacts.map((item) => ({ ...item, byteLength: item.data.byteLength })),
    );
    return artifacts;
  } catch (error) {
    if (error instanceof BuildError || (error instanceof Error && error.name === "AbortError"))
      throw error;
    throw new BuildError("BUILD1003", error instanceof Error ? error.message : String(error));
  }
}
```

compiler index 加以下兩行：

```ts
export * from "./artifacts.js";
export * from "./safe-files.js";
```

- [ ] **Step 5: 加實際檔案上限測試並確認通過**

在 `artifacts.test.ts` import 加 `open` 與 `readBoundedFile`；加入：

```ts
it("bounds real reads at the remaining budget without allocating a huge fixture", async () => {
  const file = await open(path.join(root, "large.bin"), "w");
  await file.truncate(64 * 1024 * 1024 + 1);
  await file.close();
  await expect(readBoundedFile(root, "large.bin", 64 * 1024 * 1024, signal())).rejects.toThrow(
    "BUILD1003",
  );
  await writeFile(path.join(root, "small.bin"), new Uint8Array([1, 2, 3, 4]));
  expect(await readBoundedFile(root, "small.bin", 4, signal())).toEqual(Buffer.from([1, 2, 3, 4]));
  await expect(readBoundedFile(root, "small.bin", 3, signal())).rejects.toThrow("BUILD1003");
});
```

Run: `pnpm --filter @kobrixa/compiler exec vitest run src/artifacts.test.ts`
Expected: PASS；每個常數各有等於與超過上限、路徑與 slot 各有反例，失敗都未建立 outputDir。

- [ ] **Step 6: 格式化與 lint**

```bash
pnpm exec prettier --write packages/compiler/src/artifacts.ts packages/compiler/src/safe-files.ts packages/compiler/src/test-build.ts packages/compiler/src/artifacts.test.ts packages/compiler/src/index.ts
pnpm exec prettier --check packages/compiler/src/artifacts.ts packages/compiler/src/safe-files.ts packages/compiler/src/test-build.ts packages/compiler/src/artifacts.test.ts packages/compiler/src/index.ts
pnpm exec eslint packages/compiler/src/artifacts.ts packages/compiler/src/safe-files.ts packages/compiler/src/test-build.ts packages/compiler/src/artifacts.test.ts packages/compiler/src/index.ts
```

- [ ] **Step 7: Commit**

```bash
git add packages/compiler/src/artifacts.ts packages/compiler/src/safe-files.ts packages/compiler/src/test-build.ts packages/compiler/src/artifacts.test.ts packages/compiler/src/index.ts
git commit -m "feat(compiler): validate artifact declarations paths and byte budgets" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 5: 依前端探索來源、compileToMemory 與模擬快照

**Files:**

- Create: `packages/compiler/src/compile-memory.ts`（共用記憶體編譯）
- Modify: `packages/compiler/src/contracts.ts:70`（可選資源快照）
- Modify: `packages/compiler/src/artifacts.ts:資源讀取迴圈`（消費既有快照）
- Modify: `packages/compiler/src/manifest.ts:1–8,40–48,158–197,200–305`（動態副檔名與 loader callback）
- Modify: `packages/compiler/src/index.ts:1–末尾`（匯出）
- Modify: `apps/desktop/src/main/workspace/workspace.ts:725–735`（將宣告帶進 loader）
- Modify: `apps/desktop/src/main/workspace/prepare-simulation.ts:1–末尾`（共用編譯與快照）
- Modify: `apps/desktop/src/main/workspace/build-protocol.ts:1–13`（worker 快照契約）
- Modify: `apps/desktop/vitest.config.ts:6–13`（測試使用 compiler 原始碼）
- Test: `packages/compiler/src/compile-memory.test.ts`（新）
- Test: `packages/compiler/src/manifest.test.ts:末尾`
- Test: `apps/desktop/src/main/workspace/prepare-simulation.test.ts`（新）

**Interfaces:**

- Consumes：`LanguageFrontend.compile(project: SourceProject, signal: AbortSignal): Promise<FrontendResult>`；`CompilerBackend = { id: string; declaration: BackendDecl; irVersion: number; compile(ir: KobrixaIR, signal: AbortSignal): Promise<BackendResult> }`。
- Consumes：`validateArtifacts(project: SourceProject, declaration: BackendDecl, result: BackendResult, ir: KobrixaIR, signal: AbortSignal): Promise<MemoryArtifact[]>`；`createBuiltinCompilers(snapshot: CompilerSnapshot): { frontend: LanguageFrontend; backend: CompilerBackend }`。
- Produces：`compileToMemory(project: SourceProject, frontend: LanguageFrontend, backend: CompilerBackend, signal: AbortSignal): Promise<CompileMemoryResult>`，失敗無 IR／成品、成功含 IR 與記憶體成品。
- Produces：`SourceProject.assetSnapshots?: Readonly<Record<string, Uint8Array>>`，僅主程序／worker 內的可信任快照，存在時不得重新讀來源資源。
- Produces：`loadProject(inputPath: string, overlays?: ReadonlyMap<string, string>, selectedEntry?: string, sourceCache?: ProjectSourceCache, resolveFrontend?: (manifest: ProjectManifest) => FrontendDecl): Promise<ProjectLoadResult>`；`WorkspaceService.project(id: string, overlays: ReadonlyMap<string, string>, resolveFrontend?: (manifest: ProjectManifest) => FrontendDecl): Promise<SourceProject>`。
- Produces：`prepareSimulation(project: SourceProject, entries: string[], files: Record<string, number[]>, signal: AbortSignal, compiler: CompilerSnapshot, create?: typeof createBuiltinCompilers): Promise<SimulationPrepareResult>`；`snapshotSimulationAssets(project: SourceProject): Promise<Record<string, number[]>>`。
- Produces：`BuildRequest = { buildId: string; project: SourceProject; compiler: CompilerSnapshot; cancellation: SharedArrayBuffer; preview?: boolean; simulation?: { entries: string[]; files: Record<string, number[]> } }`。

- [ ] **Step 1: 寫失敗的記憶體編譯測試**

`compile-memory.test.ts` 全文：

```ts
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { compileToMemory } from "./compile-memory.js";
import { testBackend, testFrontend, testProject, minimalIR } from "./test-build.js";
import { diagnostic } from "./diagnostics.js";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-memory-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));
it("compiles a non-rbf main and multiple aux entirely in memory", async () => {
  const backend = testBackend();
  backend.compile = vi.fn(async () => ({
    artifacts: [
      { slot: "program", data: new Uint8Array([1]) },
      { slot: "notes", data: new Uint8Array([2]) },
      { slot: "map", data: new Uint8Array([3]) },
    ],
    diagnostics: [],
  }));
  const result = await compileToMemory(
    testProject(root),
    testFrontend,
    backend,
    new AbortController().signal,
  );
  expect(result.success).toBe(true);
  expect(result.artifacts.map((item) => item.relativePath)).toEqual([
    "demo.bin",
    "demo.txt",
    "demo.map",
    "demo.ir.json",
  ]);
  expect(await readdir(root)).toEqual([]);
});
it("stops on frontend errors, invalid IR, selected-version mismatch and backend errors", async () => {
  const backend = testBackend();
  const compile = vi.spyOn(backend, "compile");
  const project = testProject(root);
  const signal = new AbortController().signal;
  const badFrontend = {
    id: "toy",
    compile: async () => ({ diagnostics: [diagnostic("BUILD9000", "frontend failed")] }),
  };
  expect((await compileToMemory(project, badFrontend, backend, signal)).success).toBe(false);
  const badIR = structuredClone(minimalIR);
  badIR.program.entryFunction = "missing";
  expect(
    (
      await compileToMemory(
        project,
        { id: "toy", compile: async () => ({ ir: badIR, diagnostics: [] }) },
        backend,
        signal,
      )
    ).diagnostics[0]!.code,
  ).toBe("IR1001");
  backend.irVersion = 2;
  expect((await compileToMemory(project, testFrontend, backend, signal)).diagnostics[0]!.code).toBe(
    "BUILD1002",
  );
  expect(compile).not.toHaveBeenCalled();
  backend.irVersion = 1;
  compile.mockResolvedValue({
    artifacts: [],
    diagnostics: [diagnostic("EV39000", "backend failed")],
  });
  expect(await compileToMemory(project, testFrontend, backend, signal)).toMatchObject({
    success: false,
    artifacts: [],
    diagnostics: [expect.objectContaining({ code: "EV39000" })],
  });
});
it("keeps cancellation and never rereads captured simulation resources", async () => {
  const project = testProject(root);
  project.assets = [{ path: "a.txt", absolutePath: path.join(root, "not-present") }];
  project.assetSnapshots = { "a.txt": new Uint8Array([7]) };
  const result = await compileToMemory(
    project,
    testFrontend,
    testBackend(),
    new AbortController().signal,
  );
  expect(result.success).toBe(true);
  expect(result.artifacts.find((item) => item.role === "deploy-asset")!.data).toEqual(
    new Uint8Array([7]),
  );
  const controller = new AbortController();
  controller.abort();
  expect(
    await compileToMemory(project, testFrontend, testBackend(), controller.signal),
  ).toMatchObject({
    success: false,
    artifacts: [],
    diagnostics: [expect.objectContaining({ code: "BUILD0001" })],
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter @kobrixa/compiler exec vitest run src/compile-memory.test.ts`
Expected: FAIL，缺少 compile-memory 模組。

- [ ] **Step 3: 實作共用編譯與資源快照消費**

`compile-memory.ts` 全文：

```ts
import { validateIR } from "@kobrixa/ir";
import type {
  CompileMemoryResult,
  CompilerBackend,
  Diagnostic,
  LanguageFrontend,
  SourceProject,
} from "./contracts.js";
import { BuildError, failedBuild } from "./build-error.js";
import { diagnosticFromSpan } from "./diagnostics.js";
import { validateArtifacts } from "./artifacts.js";
export async function compileToMemory(
  project: SourceProject,
  frontend: LanguageFrontend,
  backend: CompilerBackend,
  signal: AbortSignal,
): Promise<CompileMemoryResult> {
  const diagnostics: Diagnostic[] = [];
  const failed = (): CompileMemoryResult => ({ success: false, diagnostics, artifacts: [] });
  try {
    signal.throwIfAborted();
    const source = await frontend.compile(project, signal);
    diagnostics.push(...source.diagnostics);
    if (!source.ir || diagnostics.some((item) => item.severity === "error")) return failed();
    signal.throwIfAborted();
    if (source.ir.version !== backend.irVersion)
      throw new BuildError(
        "BUILD1002",
        "The actual IR version differs from the resolved compiler version.",
      );
    const issues = validateIR(source.ir);
    diagnostics.push(
      ...issues.map((item) => diagnosticFromSpan(item.code, item.message, item.span)),
    );
    if (issues.length) return failed();
    const result = await backend.compile(source.ir, signal);
    diagnostics.push(...result.diagnostics);
    signal.throwIfAborted();
    if (diagnostics.some((item) => item.severity === "error")) return failed();
    const artifacts = await validateArtifacts(
      project,
      backend.declaration,
      result,
      source.ir,
      signal,
    );
    signal.throwIfAborted();
    return {
      success: true,
      ir: source.ir,
      diagnostics,
      artifacts,
      ...(source.ir.program.runtimeDirectory
        ? { runtimeDirectory: source.ir.program.runtimeDirectory }
        : {}),
    };
  } catch (error) {
    return {
      success: false,
      artifacts: [],
      diagnostics: failedBuild(
        "memory",
        project.manifest.target,
        error,
        project.manifest.entry,
        diagnostics,
      ).diagnostics,
    };
  }
}
```

`SourceProject` 加：

```ts
assetSnapshots?: Readonly<Record<string, Uint8Array>>;
```

`artifacts.ts` 資源迴圈的 `const data = await readBoundedFile(...)` 換成以下完整區塊：

```ts
let data: Uint8Array;
const remaining = Math.min(BUILD_LIMITS.artifactBytes, BUILD_LIMITS.totalBytes - total);
if (project.assetSnapshots !== undefined) {
  const captured = project.assetSnapshots[asset.remotePath];
  if (!captured || captured.byteLength > remaining)
    invalid("Missing or oversized captured resource.");
  data = Uint8Array.from(captured!);
} else {
  data = await readBoundedFile(project.root, asset.remotePath, remaining, signal);
}
```

index 加 `export * from "./compile-memory.js";`。

- [ ] **Step 4: 寫失敗的動態來源探索測試**

在 `manifest.test.ts` 既有 import 加 `symlink`；追加：

```ts
it("discovers declared extensions and overlays while excluding output and symlinks", async () => {
  const root = await fixture({ language: "toy", target: "toy-vm", entry: "src/main.toy" });
  await writeFile(path.join(root, "src/main.toy"), "disk");
  await writeFile(path.join(root, "src/module.inc"), "module");
  await mkdir(path.join(root, "build"));
  await writeFile(path.join(root, "build/old.toy"), "old");
  await symlink(path.join(root, "src/module.inc"), path.join(root, "src/link.inc"));
  const declaration = {
    language: "toy",
    entryExtensions: ["toy"],
    sourceExtensions: ["toy", "inc"],
    ir: { min: 1, max: 1 },
  };
  const overlays = new Map([
    ["src/main.toy", "overlay"],
    ["src/new.inc", "new"],
    ["build/old.toy", "ignored"],
    ["src/main.bp", "ignored"],
  ]);
  const loaded = await loadProject(root, overlays, undefined, undefined, () => declaration);
  expect(loaded.diagnostics).toEqual([]);
  expect(loaded.project!.sources).toEqual([
    { path: "src/main.toy", content: "overlay" },
    { path: "src/module.inc", content: "module" },
    { path: "src/new.inc", content: "new" },
  ]);
  const bad = await loadProject(
    root,
    new Map([["src/link.inc", "unsafe"]]),
    undefined,
    undefined,
    () => declaration,
  );
  expect(bad.project).toBeUndefined();
  const entryRejected = await loadProject(root, new Map(), undefined, undefined, () => ({
    ...declaration,
    entryExtensions: ["other"],
  }));
  expect(entryRejected.project).toBeUndefined();
});
it("accepts validated language and target ids without changing schema version", () => {
  expect(parseManifest({ ...manifest, language: "toy", target: "toy-vm" }).manifest).toMatchObject({
    schemaVersion: 1,
    language: "toy",
    target: "toy-vm",
  });
  for (const id of ["UPPER", "x".repeat(33), "../x"])
    expect(parseManifest({ ...manifest, language: id }).manifest).toBeUndefined();
});
```

Run: `pnpm --filter @kobrixa/compiler exec vitest run src/manifest.test.ts`
Expected: FAIL，`language`／`target` 仍只接受 literal，`.toy` 來源沒有載入。

- [ ] **Step 5: 實作宣告驅動的來源探索**

manifest imports 加：

```ts
import { compilerIdSchema, type FrontendDecl } from "@kobrixa/plugin-protocol";
import { BuildError } from "./build-error.js";
import { assertNoSymlinks } from "./safe-files.js";
```

schema 的 `language: z.literal("bp")`／`target: z.literal("ev3-native")` 換成 `language: compilerIdSchema`／`target: compilerIdSchema`。以以下全文取代 loadSources：

```ts
async function loadSources(
  root: string,
  manifest: ProjectManifest,
  overlays: ReadonlyMap<string, string>,
  declaration: FrontendDecl,
  cache?: ProjectSourceCache,
): Promise<SourceFile[]> {
  const extension = (file: string): string => path.posix.extname(file).slice(1).toLowerCase();
  const entryPath = manifest.entry.replaceAll(path.sep, "/");
  if (!declaration.entryExtensions.includes(extension(entryPath)))
    throw new Error("The entry extension is not supported by the selected frontend.");
  const entry = await assertNoSymlinks(root, entryPath);
  if (!(await lstat(entry)).isFile()) throw new Error("The project entry must be a regular file.");
  const output = await resolveInside(root, manifest.outputDir);
  const excluded = async (relative: string) =>
    isInside(output, await resolveInside(root, relative));
  const sourcePaths = new Set<string>([entryPath]);
  const discovered = await fg(
    declaration.sourceExtensions.map((value) => `**/*.${value}`),
    {
      cwd: root,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
      braceExpansion: false,
      caseSensitiveMatch: false,
      ignore: [`${fg.convertPathToPattern(manifest.outputDir)}/**`],
    },
  );
  for (const relative of discovered) if (!(await excluded(relative))) sourcePaths.add(relative);
  for (const relative of overlays.keys()) {
    if (!declaration.sourceExtensions.includes(extension(relative))) continue;
    await assertNoSymlinks(root, relative, true);
    if (!(await excluded(relative))) sourcePaths.add(relative);
  }
  const paths = new Set<string>();
  cache?.begin();
  const sources = await Promise.all(
    [...sourcePaths].sort().map(async (relative) => {
      const absolute = await assertNoSymlinks(root, relative, overlays.has(relative));
      paths.add(absolute);
      return {
        path: relative,
        content:
          overlays.get(relative) ??
          (cache ? await cache.read(absolute) : await readFile(absolute, "utf8")),
      };
    }),
  );
  cache?.retain(paths);
  return sources;
}
```

loadProject 第五個參數加：

```ts
resolveFrontend?: (manifest: ProjectManifest) => FrontendDecl,
```

在原 `const sources = await loadSources(...)` 處換成：

```ts
const declaration =
  resolveFrontend?.(manifest) ??
  (manifest.language === "bp"
    ? {
        language: "bp",
        entryExtensions: ["bp"],
        sourceExtensions: ["bp", "bpi", "bpm"],
        ir: { min: 1, max: 1 },
      }
    : undefined);
if (!declaration)
  throw new BuildError("BUILD1001", `No enabled language provider: ${manifest.language}.`);
const sources = await loadSources(root, manifest, overlays, declaration, sourceCache);
```

catch 中的 `diagnostic("MAN1002", ...)` 第一個參數改為 `error instanceof BuildError ? error.code : "MAN1002"`。保留原本資源 glob、resolveInside、outputDir 與 source root 的檢查。

`workspace.ts` 保留既有 `ProjectManifest` import，新增 protocol 的 `FrontendDecl` 型別與 compiler 的 `BuildError` import，完整取代 project 方法：

```ts
async project(id: string, overlays: ReadonlyMap<string, string>, resolveFrontend?: (manifest: ProjectManifest) => FrontendDecl): Promise<SourceProject> {
  const record = this.require(id);
  const result = await loadProject(record.inputPath, overlays, record.selectedEntry, undefined, resolveFrontend);
  if (!result.project) {
    const message = result.diagnostics.map((item) => item.message).join("\n") || "Choose an entry file before building.";
    const code = result.diagnostics[0]?.code;
    if (code === "BUILD1001" || code === "BUILD1002") throw new BuildError(code, message);
    throw new Error(message);
  }
  return result.project;
}
```

- [ ] **Step 6: 寫失敗的模擬門檻與邊界測試**

`apps/desktop/vitest.config.ts` 的 resolve.alias 陣列前方加入以下 entry（只限測試，用工作樹的 compiler 原始碼測新 API）：

```ts
{ find: /^@kobrixa\/compiler$/, replacement: fileURLToPath(new URL("../../packages/compiler/src/index.ts", import.meta.url)) },
```

`prepare-simulation.test.ts` 全文：

```ts
import { expect, it, vi } from "vitest";
import type { CompilerSnapshot } from "@kobrixa/plugin-runtime";
import { prepareSimulation } from "./prepare-simulation.js";
import {
  testBackend,
  testFrontend,
  testProject,
  TEST_BACKEND_DECL,
} from "../../../../../packages/compiler/src/test-build.js";
const declaration = {
  language: "toy",
  entryExtensions: ["toy"],
  sourceExtensions: ["toy", "inc"],
  ir: { min: 1, max: 1 },
};
const snapshot: CompilerSnapshot = {
  ok: true,
  ir: 1,
  frontend: { pluginId: "test.front", sourceKey: "builtin:test.front", contribution: declaration },
  backend: {
    pluginId: "test.back",
    sourceKey: "builtin:test.back",
    contribution: TEST_BACKEND_DECL,
  },
};
it("requires backend success for all four simulation entries", async () => {
  const project = testProject("/unused");
  const entries = ["a.toy", "b.toy", "c.toy", "d.toy"];
  project.sources = entries.map((path) => ({ path, content: "test" }));
  const backend = testBackend();
  const compile = vi.spyOn(backend, "compile");
  const create = () => ({ frontend: testFrontend, backend });
  const result = await prepareSimulation(
    project,
    entries,
    {},
    new AbortController().signal,
    snapshot,
    create,
  );
  expect(result.success).toBe(true);
  expect(compile).toHaveBeenCalledTimes(4);
  compile.mockResolvedValueOnce({ artifacts: [], diagnostics: [] });
  expect(
    await prepareSimulation(project, entries, {}, new AbortController().signal, snapshot, create),
  ).toMatchObject({
    success: false,
    diagnostics: [expect.objectContaining({ code: "BUILD1003" })],
  });
  expect(
    (
      await prepareSimulation(
        project,
        [...entries, "a.toy"],
        {},
        new AbortController().signal,
        snapshot,
        create,
      )
    ).success,
  ).toBe(false);
});
it("keeps 64 resources and 1 MiB inclusive and rejects overflow", async () => {
  const project = testProject("/unused");
  const files = Object.fromEntries(
    Array.from({ length: 64 }, (_, i) => [`a${i}`, Array(16 * 1024).fill(1)]),
  );
  project.assets = Object.keys(files).map((path) => ({ path, absolutePath: "/not-read" }));
  const create = () => ({ frontend: testFrontend, backend: testBackend() });
  expect(
    (
      await prepareSimulation(
        project,
        ["main.toy"],
        files,
        new AbortController().signal,
        snapshot,
        create,
      )
    ).success,
  ).toBe(true);
  expect(
    (
      await prepareSimulation(
        project,
        ["main.toy"],
        { ...files, extra: [] },
        new AbortController().signal,
        snapshot,
        create,
      )
    ).success,
  ).toBe(false);
  files.a0!.push(1);
  expect(
    (
      await prepareSimulation(
        project,
        ["main.toy"],
        files,
        new AbortController().signal,
        snapshot,
        create,
      )
    ).success,
  ).toBe(false);
});
```

Run: `pnpm --filter @kobrixa/desktop exec vitest run src/main/workspace/prepare-simulation.test.ts`
Expected: FAIL，模擬仍直接建立 Basic Plus／EV3，不能處理 `.toy`。

- [ ] **Step 7: 讓模擬使用同一解析快照與記憶體編譯**

`prepare-simulation.ts` 全文：

```ts
import {
  compileToMemory,
  diagnostic,
  readBoundedFile,
  type SourceProject,
} from "@kobrixa/compiler";
import type { CompilerSnapshot } from "@kobrixa/plugin-runtime";
import { PREVIEW_MAX_FILES, PREVIEW_MAX_FILE_BYTES } from "../../shared/offline-preview.js";
import type { PreparedSimulation, SimulationPrepareResult } from "../../shared/simulator.js";
import { createBuiltinCompilers } from "./builtin-compilers.js";
export async function snapshotSimulationAssets(
  project: SourceProject,
): Promise<Record<string, number[]>> {
  if (project.assets.length > PREVIEW_MAX_FILES)
    throw new Error("Simulation supports at most 64 resource files.");
  const files: Record<string, number[]> = Object.create(null);
  let total = 0;
  for (const asset of project.assets) {
    const relative = asset.path.replaceAll("\\", "/");
    try {
      const bytes = await readBoundedFile(
        project.root,
        relative,
        PREVIEW_MAX_FILE_BYTES - total,
        new AbortController().signal,
      );
      total += bytes.length;
      files[relative] = Array.from(bytes);
    } catch (error) {
      throw new Error(
        `Simulation resource snapshot exceeds the 1 MiB limit or changed while reading: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return files;
}
export async function prepareSimulation(
  project: SourceProject,
  entries: string[],
  files: Record<string, number[]>,
  signal: AbortSignal,
  compiler: CompilerSnapshot,
  create: typeof createBuiltinCompilers = createBuiltinCompilers,
): Promise<SimulationPrepareResult> {
  const diagnostics: SimulationPrepareResult["diagnostics"] = [];
  const programs: PreparedSimulation["programs"] = Object.create(null);
  try {
    if (entries.length > 4) throw new Error("Simulation supports at most four program entries.");
    if (
      Object.keys(files).length > PREVIEW_MAX_FILES ||
      Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0) > PREVIEW_MAX_FILE_BYTES
    )
      throw new Error("Simulation supports at most 64 resources totaling 1 MiB.");
    const assetSnapshots = Object.fromEntries(
      Object.entries(files).map(([name, bytes]) => [name, Uint8Array.from(bytes)]),
    );
    for (const entry of [...new Set(entries)]) {
      signal.throwIfAborted();
      if (
        !compiler.frontend.contribution.entryExtensions.includes(
          entry.split(".").at(-1)!.toLowerCase(),
        ) ||
        entry.includes("\\") ||
        entry.startsWith("/") ||
        entry.split("/").some((part) => part === ".." || part === ".") ||
        !project.sources.some((source) => source.path === entry)
      )
        throw new Error(`Unknown project program entry: ${entry}`);
      const { frontend, backend } = create(compiler);
      const result = await compileToMemory(
        { ...project, assetSnapshots, manifest: { ...project.manifest, entry } },
        frontend,
        backend,
        signal,
      );
      diagnostics.push(...result.diagnostics);
      if (!result.success) continue;
      if (result.ir.version !== 1) throw new Error("Unsupported simulation IR version.");
      programs[entry] = { ir: result.ir, files: structuredClone(files) };
    }
    signal.throwIfAborted();
    if (
      diagnostics.some((item) => item.severity === "error") ||
      Object.keys(programs).length !== new Set(entries).size
    )
      return { success: false, diagnostics };
    return { success: true, diagnostics, prepared: { programs } };
  } catch (error) {
    diagnostics.push(
      diagnostic(
        "SIM1001",
        error instanceof Error ? error.message : String(error),
        project.manifest.entry,
      ),
    );
    return { success: false, diagnostics };
  }
}
```

`build-protocol.ts` 加 `import type { CompilerSnapshot } from "@kobrixa/plugin-runtime";`，BuildRequest 全文改為：

```ts
export interface BuildRequest {
  buildId: string;
  project: SourceProject;
  compiler: CompilerSnapshot;
  cancellation: SharedArrayBuffer;
  preview?: boolean;
  simulation?: { entries: string[]; files: Record<string, number[]> };
}
```

BuildReply 不變。Task 6 用此完整契約接 main 與 worker；不保留 frontend 字串別名。

- [ ] **Step 8: 執行測試確認通過**

Run: `pnpm --filter @kobrixa/compiler exec vitest run src/compile-memory.test.ts src/manifest.test.ts src/source-cache.test.ts src/artifacts.test.ts && pnpm --filter @kobrixa/plugin-runtime build && pnpm --filter @kobrixa/desktop exec vitest run src/main/workspace/prepare-simulation.test.ts`
Expected: PASS；資源快照不重新讀來源、非 `.bp` 來源與 overlay 可探索、現有 cache／路徑回歸保留。

- [ ] **Step 9: 格式化與 lint**

```bash
pnpm exec prettier --write packages/compiler/src/compile-memory.ts packages/compiler/src/compile-memory.test.ts packages/compiler/src/contracts.ts packages/compiler/src/artifacts.ts packages/compiler/src/manifest.ts packages/compiler/src/manifest.test.ts packages/compiler/src/index.ts apps/desktop/src/main/workspace/workspace.ts apps/desktop/src/main/workspace/prepare-simulation.ts apps/desktop/src/main/workspace/prepare-simulation.test.ts apps/desktop/src/main/workspace/build-protocol.ts apps/desktop/vitest.config.ts
pnpm exec prettier --check packages/compiler/src/compile-memory.ts packages/compiler/src/compile-memory.test.ts packages/compiler/src/contracts.ts packages/compiler/src/artifacts.ts packages/compiler/src/manifest.ts packages/compiler/src/manifest.test.ts packages/compiler/src/index.ts apps/desktop/src/main/workspace/workspace.ts apps/desktop/src/main/workspace/prepare-simulation.ts apps/desktop/src/main/workspace/prepare-simulation.test.ts apps/desktop/src/main/workspace/build-protocol.ts apps/desktop/vitest.config.ts
pnpm exec eslint packages/compiler/src/compile-memory.ts packages/compiler/src/compile-memory.test.ts packages/compiler/src/contracts.ts packages/compiler/src/artifacts.ts packages/compiler/src/manifest.ts packages/compiler/src/manifest.test.ts packages/compiler/src/index.ts apps/desktop/src/main/workspace/workspace.ts apps/desktop/src/main/workspace/prepare-simulation.ts apps/desktop/src/main/workspace/prepare-simulation.test.ts apps/desktop/src/main/workspace/build-protocol.ts apps/desktop/vitest.config.ts
```

- [ ] **Step 10: Commit**

```bash
git add packages/compiler/src/compile-memory.ts packages/compiler/src/compile-memory.test.ts packages/compiler/src/contracts.ts packages/compiler/src/artifacts.ts packages/compiler/src/manifest.ts packages/compiler/src/manifest.test.ts packages/compiler/src/index.ts apps/desktop/src/main/workspace/workspace.ts apps/desktop/src/main/workspace/prepare-simulation.ts apps/desktop/src/main/workspace/prepare-simulation.test.ts apps/desktop/src/main/workspace/build-protocol.ts apps/desktop/vitest.config.ts
git commit -m "feat(compiler): share in-memory compilation and declared source discovery" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 6: staging、提交鎖、取消邊界、FIFO 與 worker 接線

**Files:**

- Create: `packages/compiler/src/output-lock.ts`（跨程序鎖）
- Create: `packages/compiler/src/commit-artifacts.ts`（完整 staging、驗 hash、排序提交）
- Modify: `packages/compiler/src/build-session.ts:1–末尾`（記憶體編譯後提交）
- Modify: `packages/compiler/src/index.ts:1–末尾`（匯出）
- Create: `apps/desktop/src/main/workspace/output-queue.ts`（canonical outputDir FIFO）
- Modify: `apps/desktop/src/main/workspace/build.ts:1–末尾`（保存快照、排隊、單次完成）
- Modify: `apps/desktop/src/main/workspace/build-worker.ts:1–末尾`（按快照建立兩端）
- Modify: `apps/desktop/src/main/workspace/builtin-compilers.ts:1–末尾`（預設內建 resolver）
- Delete: `apps/desktop/src/main/workspace/builtin-frontends.ts:1–8`（舊單端工廠）
- Modify: `apps/desktop/src/main/index.ts:189–191`（注入 resolveCompiler）
- Test: `packages/compiler/src/commit-artifacts.test.ts`（新）
- Test: `packages/compiler/src/output-lock.test.ts`（新）
- Test: `apps/desktop/src/main/workspace/output-queue.test.ts`（新）
- Test: `apps/desktop/src/main/workspace/build.test.ts:87–145,381`（快照、不開 worker、role）

**Interfaces:**

- Consumes：`compileToMemory(project: SourceProject, frontend: LanguageFrontend, backend: CompilerBackend, signal: AbortSignal): Promise<CompileMemoryResult>`；成功結果含 `ir`／`artifacts: MemoryArtifact[]`／`diagnostics`／可選 runtimeDirectory。
- Consumes：`CompilerSnapshot = { ok: true; frontend: ProviderRef<FrontendDecl>; backend: ProviderRef<BackendDecl>; ir: number }`；`BuildRequest` 完整欄位為 buildId、project、compiler、cancellation、可選 preview／simulation。
- Produces：`acquireOutputLock(outputDir: string, signal: AbortSignal, options?: LockOptions): Promise<() => Promise<void>>`；`LockOptions = { now?: () => number; sleep?: (ms: number) => Promise<void>; pidAlive?: (pid: number) => boolean }`。
- Produces：`commitArtifacts(project: SourceProject, buildId: string, artifacts: MemoryArtifact[], signal: AbortSignal, options?: CommitOptions): Promise<BuildArtifact[]>`；CommitOptions 的 IO／hook 完整定義見 Step 4，只供單元測試注入，不跨 IPC。
- Produces：`BuildSession(frontend: LanguageFrontend, backend: CompilerBackend, onProgress?: (progress: BuildProgress) => void, controller?: AbortController, id?: string, commitOptions?: CommitOptions)`；`compile(project: SourceProject): Promise<CompileResult>`、`cancel(): void`。
- Produces：`OutputQueue.run<T>(outputDir: string, work: () => Promise<T>): Promise<T>`。
- Produces：`BuildService.start(workspaceId: string, overlays: Record<string, string>, preview?: boolean): Promise<string>`；`prepareSimulation(workspaceId: string, overlays: Record<string, string>, entries: string[]): Promise<SimulationPrepareResult>`；失敗解析發 complete BUILD1001／1002，不開 worker。

- [ ] **Step 1: 寫失敗的 staging／取消測試**

`commit-artifacts.test.ts` 全文：

```ts
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { commitArtifacts } from "./commit-artifacts.js";
import { BuildSession } from "./build-session.js";
import type { MemoryArtifact } from "./contracts.js";
import { testBackend, testFrontend, testProject } from "./test-build.js";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-commit-"));
  await mkdir(path.join(root, "build"));
});
afterEach(() => rm(root, { recursive: true, force: true }));
function entries(): MemoryArtifact[] {
  return [
    {
      slot: "program",
      kind: "toy",
      role: "deploy-main",
      mediaType: "application/octet-stream",
      relativePath: "demo.bin",
      data: new Uint8Array([3]),
    },
    {
      slot: "asset",
      kind: "asset",
      role: "deploy-asset",
      mediaType: "application/octet-stream",
      relativePath: "assets/a",
      remotePath: "a",
      data: new Uint8Array([2]),
    },
    {
      slot: "ir",
      kind: "ir",
      role: "aux",
      mediaType: "application/json",
      relativePath: "demo.ir.json",
      data: new Uint8Array([1]),
    },
  ];
}
it("validates all staging bytes before replacing aux then assets then main", async () => {
  const order: string[] = [];
  const artifacts = await commitArtifacts(
    testProject(root),
    "order",
    entries(),
    new AbortController().signal,
    {
      io: {
        write: (file, bytes) => writeFile(file, bytes),
        rename: async (from, to) => {
          order.push(path.relative(path.join(root, "build"), to));
          await rename(from, to);
        },
      },
    },
  );
  expect(order).toEqual(["demo.ir.json", "assets/a", "demo.bin"]);
  expect(artifacts.map((item) => item.byteLength)).toEqual([1, 1, 1]);
  expect(artifacts.every((item) => /^[a-f0-9]{64}$/.test(item.sha256))).toBe(true);
  expect(
    (await readdir(path.join(root, "build"))).filter((name) => name.startsWith(".kobrixa")),
  ).toEqual([]);
});
it("cancels at the last checkpoint and finishes after the first rename", async () => {
  await writeFile(path.join(root, "build/demo.bin"), "old");
  const before = new AbortController();
  await expect(
    commitArtifacts(testProject(root), "before", entries(), before.signal, {
      beforeRename: (index) => {
        if (index === 0) before.abort();
      },
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(await readFile(path.join(root, "build/demo.bin"), "utf8")).toBe("old");
  const after = new AbortController();
  const committed = await commitArtifacts(testProject(root), "after", entries(), after.signal, {
    beforeRename: (index) => {
      if (index === 1) after.abort();
    },
  });
  expect(committed).toHaveLength(3);
  expect(await readFile(path.join(root, "build/demo.bin"))).toEqual(Buffer.from([3]));
});
it("keeps final files on staging failure and returns no artifacts on rename failure", async () => {
  await writeFile(path.join(root, "build/demo.bin"), "old");
  await expect(
    commitArtifacts(testProject(root), "write-fail", entries(), new AbortController().signal, {
      io: {
        write: async () => {
          throw new Error("disk full");
        },
        rename,
      },
    }),
  ).rejects.toThrow("BUILD9000");
  expect(await readFile(path.join(root, "build/demo.bin"), "utf8")).toBe("old");
  let renamed = 0;
  await expect(
    commitArtifacts(testProject(root), "rename-fail", entries(), new AbortController().signal, {
      io: {
        write: (file, bytes) => writeFile(file, bytes),
        rename: async (from, to) => {
          if (++renamed === 2) throw new Error("I/O failure");
          await rename(from, to);
        },
      },
    }),
  ).rejects.toThrow("BUILD9000");
  // 同一個注入經 BuildSession 路徑，確實測到提交 I/O 失敗而非後端失敗。
  let sessionRenames = 0;
  const session = new BuildSession(
    testFrontend,
    testBackend(),
    undefined,
    undefined,
    "session-fail",
    {
      io: {
        write: (file, bytes) => writeFile(file, bytes),
        rename: async (from, to) => {
          if (++sessionRenames === 2) throw new Error("session rename failure");
          await rename(from, to);
        },
      },
    },
  );
  expect(await session.compile(testProject(root))).toMatchObject({
    success: false,
    artifacts: [],
    diagnostics: [expect.objectContaining({ code: "BUILD9000" })],
  });
  expect(sessionRenames).toBe(2);
});
it("returns BUILD1004 with no final changes when commit lock acquisition times out", async () => {
  const output = path.join(root, "build");
  await writeFile(path.join(output, "demo.bin"), "old");
  const held = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
  await writeFile(path.join(output, ".kobrixa-build.lock"), held);
  let now = Date.now();
  const session = new BuildSession(testFrontend, testBackend(), undefined, undefined, "locked", {
    lock: {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      pidAlive: () => true,
    },
  });
  expect(await session.compile(testProject(root))).toMatchObject({
    success: false,
    artifacts: [],
    diagnostics: [expect.objectContaining({ code: "BUILD1004" })],
  });
  expect(await readFile(path.join(output, "demo.bin"), "utf8")).toBe("old");
  expect(await readFile(path.join(output, ".kobrixa-build.lock"), "utf8")).toBe(held);
  expect((await readdir(output)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});
it("rejects corrupted staging bytes before any final rename", async () => {
  await writeFile(path.join(root, "build/demo.bin"), "old");
  await expect(
    commitArtifacts(testProject(root), "corrupt", entries(), new AbortController().signal, {
      io: {
        write: (file) => writeFile(file, new Uint8Array([99])),
        rename: async () => {
          throw new Error("must not rename");
        },
      },
    }),
  ).rejects.toThrow("BUILD1003");
  expect(await readFile(path.join(root, "build/demo.bin"), "utf8")).toBe("old");
});
```

Run: `pnpm --filter @kobrixa/compiler exec vitest run src/commit-artifacts.test.ts`
Expected: FAIL，缺少 commit-artifacts 模組。

- [ ] **Step 2: 寫失敗的鎖與 FIFO 測試**

`output-lock.test.ts` 全文：

```ts
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { acquireOutputLock } from "./output-lock.js";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-lock-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));
it("reclaims only stale locks and never releases another owner", async () => {
  const file = path.join(root, ".kobrixa-build.lock");
  await writeFile(file, JSON.stringify({ pid: 123456, startedAt: Date.now() }));
  const release = await acquireOutputLock(root, new AbortController().signal, {
    pidAlive: () => false,
  });
  const other = JSON.stringify({ pid: process.pid, startedAt: Date.now() + 100 });
  await writeFile(file, other);
  await release();
  expect(await readFile(file, "utf8")).toBe(other);
  await writeFile(file, "broken");
  const old = new Date(Date.now() - 61_000);
  await utimes(file, old, old);
  const releaseOld = await acquireOutputLock(root, new AbortController().signal);
  await releaseOld();
  await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
});
it("polls active or freshly malformed locks every 100 ms for at most 5 seconds", async () => {
  for (const content of [
    JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
    "fresh malformed",
  ]) {
    await writeFile(path.join(root, ".kobrixa-build.lock"), content);
    let now = Date.now();
    const waits: number[] = [];
    await expect(
      acquireOutputLock(root, new AbortController().signal, {
        now: () => now,
        sleep: async (ms) => {
          waits.push(ms);
          now += ms;
        },
        pidAlive: () => true,
      }),
    ).rejects.toMatchObject({ code: "BUILD1004" });
    expect(waits).toHaveLength(50);
    expect(waits.every((ms) => ms === 100)).toBe(true);
    expect(await readFile(path.join(root, ".kobrixa-build.lock"), "utf8")).toBe(content);
  }
});
it("cancels while waiting without removing the active lock", async () => {
  const file = path.join(root, ".kobrixa-build.lock");
  const content = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
  await writeFile(file, content);
  const controller = new AbortController();
  await expect(
    acquireOutputLock(root, controller.signal, {
      sleep: async () => {
        controller.abort();
      },
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(await readFile(file, "utf8")).toBe(content);
});
```

`output-queue.test.ts` 全文：

```ts
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { OutputQueue } from "./output-queue.js";
it("queues canonical output aliases in FIFO order", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kobrixa-fifo-"));
  try {
    const output = path.join(root, "out");
    await mkdir(output);
    const alias = path.join(root, "alias");
    await symlink(output, alias, "dir");
    const queue = new OutputQueue();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const one = queue.run(output, async () => {
      order.push("a-start");
      await gate;
      order.push("a-end");
    });
    const two = queue.run(alias, async () => {
      order.push("b");
    });
    const three = queue.run(output, async () => {
      order.push("c");
    });
    const other = queue.run(path.join(root, "other"), async () => {
      order.push("other");
      release();
    });
    await Promise.all([one, two, three, other]);
    expect(order.indexOf("other")).toBeLessThan(order.indexOf("a-end"));
    expect(order.filter((item) => item !== "other")).toEqual(["a-start", "a-end", "b", "c"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

Run: `pnpm --filter @kobrixa/compiler exec vitest run src/output-lock.test.ts && pnpm --filter @kobrixa/desktop exec vitest run src/main/workspace/output-queue.test.ts`
Expected: FAIL，缺少 output-lock／output-queue 模組。

- [ ] **Step 3: 實作 open wx、殘留判斷與只釋放自己的鎖**

`output-lock.ts` 全文：

```ts
import { lstat, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { BuildError } from "./build-error.js";
export interface LockOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pidAlive?: (pid: number) => boolean;
}
let lastStartedAt = 0;
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
export async function acquireOutputLock(
  outputDir: string,
  signal: AbortSignal,
  options: LockOptions = {},
): Promise<() => Promise<void>> {
  const file = path.join(outputDir, ".kobrixa-build.lock");
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pidAlive = options.pidAlive ?? alive;
  const deadline = now() + 5_000;
  const startedAt = (lastStartedAt = Math.max(now(), lastStartedAt + 1));
  const content = JSON.stringify({ pid: process.pid, startedAt });
  let reclaimed = false;
  for (;;) {
    signal.throwIfAborted();
    if (now() >= deadline)
      throw new BuildError(
        "BUILD1004",
        "Another Kobrixa window is writing this project's build output.",
      );
    try {
      const handle = await open(file, "wx");
      const identity = await handle.stat();
      try {
        await handle.writeFile(content, "utf8");
      } catch (error) {
        const current = await lstat(file).catch(() => undefined);
        if (current?.ino === identity.ino && current.dev === identity.dev)
          await unlink(file).catch(() => undefined);
        throw error;
      } finally {
        await handle.close();
      }
      return async () => {
        try {
          const current = await lstat(file);
          if (
            current.dev === identity.dev &&
            current.ino === identity.ino &&
            (await readFile(file, "utf8")) === content
          )
            await unlink(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!reclaimed) {
      try {
        const info = await lstat(file);
        if (info.isSymbolicLink())
          throw new BuildError("BUILD1004", "The build lock path is a symbolic link.");
        const existing = await readFile(file, "utf8");
        let stale = false;
        try {
          const value = JSON.parse(existing) as { pid?: unknown; startedAt?: unknown };
          if (
            !value ||
            !Number.isSafeInteger(value.pid) ||
            Number(value.pid) <= 0 ||
            typeof value.startedAt !== "number" ||
            !Number.isFinite(value.startedAt)
          )
            throw new Error("Malformed lock");
          stale = !pidAlive(Number(value.pid));
        } catch {
          stale = now() - info.mtimeMs > 60_000;
        }
        if (stale) {
          const current = await lstat(file);
          if (
            current.ino === info.ino &&
            current.dev === info.dev &&
            (await readFile(file, "utf8")) === existing
          ) {
            await unlink(file);
            reclaimed = true;
            continue;
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    if (now() >= deadline)
      throw new BuildError(
        "BUILD1004",
        "Another Kobrixa window is writing this project's build output.",
      );
    await sleep(Math.min(100, deadline - now()));
  }
}
```

- [ ] **Step 4: 實作完整 staging 與不可中斷的提交段**

`commit-artifacts.ts` 全文：

```ts
import { createHash } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BuildArtifact, MemoryArtifact, SourceProject } from "./contracts.js";
import { BUILD_LIMITS, validateArtifactLayout, validateBuildLimits } from "./artifacts.js";
import { assertNoSymlinks, readBoundedFile } from "./safe-files.js";
import { resolveInside } from "./manifest.js";
import { acquireOutputLock, type LockOptions } from "./output-lock.js";
import { BuildError } from "./build-error.js";
export interface CommitOptions {
  io?: {
    write(file: string, data: Uint8Array): Promise<void>;
    rename(from: string, to: string): Promise<void>;
  };
  lock?: LockOptions;
  beforeRename?(index: number): void;
}
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export async function commitArtifacts(
  project: SourceProject,
  buildId: string,
  artifacts: MemoryArtifact[],
  signal: AbortSignal,
  options: CommitOptions = {},
): Promise<BuildArtifact[]> {
  if (!/^[a-zA-Z0-9-]+$/.test(buildId)) throw new BuildError("BUILD1003", "Invalid build id.");
  validateArtifactLayout(artifacts);
  validateBuildLimits(
    artifacts.filter((item) => item.slot !== "ir" && item.slot !== "asset").length,
    artifacts.map((item) => ({
      relativePath: item.relativePath,
      byteLength: item.data.byteLength,
    })),
  );
  const output = await resolveInside(project.root, project.manifest.outputDir);
  const staging = path.join(output, `.kobrixa-${buildId}.tmp`);
  const io = options.io ?? {
    write: (file: string, bytes: Uint8Array) => writeFile(file, bytes),
    rename,
  };
  let ownsStaging = false;
  let release: (() => Promise<void>) | undefined;
  let started = false;
  try {
    signal.throwIfAborted();
    await mkdir(output, { recursive: true });
    await mkdir(staging);
    ownsStaging = true;
    const staged: Array<{ memory: MemoryArtifact; artifact: BuildArtifact }> = [];
    let total = 0;
    for (const memory of artifacts) {
      signal.throwIfAborted();
      const file = path.join(staging, memory.relativePath);
      await mkdir(path.dirname(file), { recursive: true });
      await io.write(file, memory.data);
      const actual = await readBoundedFile(
        staging,
        memory.relativePath,
        Math.min(BUILD_LIMITS.artifactBytes, BUILD_LIMITS.totalBytes - total),
        signal,
      );
      total += actual.byteLength;
      const sha256 = hash(actual);
      if (actual.byteLength !== memory.data.byteLength || sha256 !== hash(memory.data))
        throw new BuildError(
          "BUILD1003",
          "Staged artifact differs from the validated memory snapshot.",
        );
      staged.push({
        memory,
        artifact: {
          slot: memory.slot,
          kind: memory.kind,
          role: memory.role,
          mediaType: memory.mediaType,
          path: path.join(output, memory.relativePath),
          sha256,
          byteLength: actual.byteLength,
          ...(memory.remotePath === undefined ? {} : { remotePath: memory.remotePath }),
        },
      });
    }
    release = await acquireOutputLock(output, signal, options.lock);
    for (const item of staged) {
      const destination = await assertNoSymlinks(output, item.memory.relativePath, true);
      const info = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
      if (info && !info.isFile())
        throw new BuildError("BUILD1003", "An artifact destination is not a regular file.");
    }
    const priority = { aux: 0, "deploy-asset": 1, "deploy-main": 2 };
    staged.sort(
      (a, b) =>
        priority[a.artifact.role] - priority[b.artifact.role] ||
        a.memory.relativePath.localeCompare(b.memory.relativePath, "en"),
    );
    for (let index = 0; index < staged.length; index++) {
      const item = staged[index]!;
      await mkdir(path.dirname(item.artifact.path), { recursive: true });
      options.beforeRename?.(index);
      if (!started) signal.throwIfAborted(); // 第一次 rename 前最後一個取消檢查。
      started = true;
      await io.rename(path.join(staging, item.memory.relativePath), item.artifact.path);
    }
    return staged.map((item) => item.artifact);
  } catch (error) {
    if (
      !started &&
      (error instanceof BuildError || (error instanceof Error && error.name === "AbortError"))
    )
      throw error;
    throw new BuildError("BUILD9000", error instanceof Error ? error.message : String(error));
  } finally {
    try {
      await release?.();
    } finally {
      if (ownsStaging) await rm(staging, { recursive: true, force: true });
    }
  }
}
```

這裡的「不碰 outputDir」指最終成品；spec 指定 staging／lock 就在 outputDir 內，暫存目錄建立／刪除本身是必要的。測試比較既有最終檔案的內容，不把 staging 的短暫存在誤判成覆寫。

- [ ] **Step 5: BuildSession 只協調共用編譯與提交**

`build-session.ts` 全文：

```ts
import { randomUUID } from "node:crypto";
import type {
  BuildProgress,
  CompileResult,
  CompilerBackend,
  LanguageFrontend,
  SourceProject,
} from "./contracts.js";
import { compileToMemory } from "./compile-memory.js";
import { commitArtifacts, type CommitOptions } from "./commit-artifacts.js";
import { failedBuild } from "./build-error.js";
export class BuildSession {
  #started = false;
  constructor(
    readonly frontend: LanguageFrontend,
    readonly backend: CompilerBackend,
    private readonly onProgress?: (progress: BuildProgress) => void,
    private readonly controller = new AbortController(),
    readonly id: string = randomUUID(),
    private readonly commitOptions: CommitOptions = {},
  ) {}
  cancel(): void {
    this.controller.abort();
  }
  async compile(project: SourceProject): Promise<CompileResult> {
    if (this.#started) throw new Error("A build session can only compile once.");
    this.#started = true;
    const progress = (stage: BuildProgress["stage"], message: string) =>
      this.onProgress?.({ buildId: this.id, stage, message });
    const result = await compileToMemory(
      project,
      {
        id: this.frontend.id,
        compile: async (input, signal) => {
          progress("frontend", "Compiling project sources");
          const value = await this.frontend.compile(input, signal);
          progress("ir", "Validating KobrixaIR");
          return value;
        },
      },
      {
        id: this.backend.id,
        declaration: this.backend.declaration,
        irVersion: this.backend.irVersion,
        compile: (ir, signal) => {
          progress("backend", "Generating declared artifacts");
          return this.backend.compile(ir, signal);
        },
      },
      this.controller.signal,
    );
    const base = {
      buildId: this.id,
      target: project.manifest.target,
      ...(this.backend.declaration.capabilities.deploy
        ? { deploy: this.backend.declaration.capabilities.deploy }
        : {}),
    };
    if (!result.success)
      return { ...base, success: false, diagnostics: result.diagnostics, artifacts: [] };
    try {
      progress("commit", "Committing verified artifacts");
      const artifacts = await commitArtifacts(
        project,
        this.id,
        result.artifacts,
        this.controller.signal,
        this.commitOptions,
      );
      progress("complete", "Build complete");
      return {
        ...base,
        success: true,
        diagnostics: result.diagnostics,
        artifacts,
        ...(result.runtimeDirectory ? { runtimeDirectory: result.runtimeDirectory } : {}),
      };
    } catch (error) {
      return failedBuild(
        this.id,
        project.manifest.target,
        error,
        project.manifest.entry,
        result.diagnostics,
      );
    }
  }
}
```

index 加：

```ts
export * from "./output-lock.js";
export * from "./commit-artifacts.js";
```

Run: `pnpm --filter @kobrixa/compiler exec vitest run && pnpm --filter @kobrixa/compiler build`
Expected: PASS；原先的泛用 BackendResult／BuildSession 型別接線完成，compiler 可獨立 build。

- [ ] **Step 6: 實作 canonical outputDir FIFO**

`output-queue.ts` 全文：

```ts
import { mkdir, realpath } from "node:fs/promises";
export class OutputQueue {
  #admissions: Promise<void> = Promise.resolve();
  #tails = new Map<string, Promise<void>>();
  run<T>(outputDir: string, work: () => Promise<T>): Promise<T> {
    let start!: () => void;
    const admitted = new Promise<void>((resolve) => {
      start = resolve;
    });
    let result!: Promise<T>;
    const admission = this.#admissions.then(async () => {
      await mkdir(outputDir, { recursive: true });
      const key = await realpath(outputDir);
      const previous = this.#tails.get(key) ?? Promise.resolve();
      result = previous.then(work);
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      this.#tails.set(key, tail);
      void tail.then(() => {
        if (this.#tails.get(key) === tail) this.#tails.delete(key);
      });
      start();
    });
    this.#admissions = admission.catch(() => undefined);
    return Promise.race([admitted.then(() => result), admission.then(() => result)]);
  }
}
```

admission 只串行化 realpath 與登記，不等待 work，所以不同 outputDir 仍能並行。建立不存在的空 outputDir 是為了取得 realpath，不寫任何最終成品；取消／驗證失敗不會覆寫原有成品。

- [ ] **Step 7: 主程序建立一次解析快照並把排隊納入 busy／cancel**

先在 `builtin-compilers.ts` 將 BuildError import 改為正式 `import { BuildError } from "@kobrixa/compiler";`，加入 imports 與 resolver：

```ts
import { pluginManifestSchema } from "@kobrixa/plugin-protocol";
import { resolveCompilerProviders, type CompilerResolution } from "@kobrixa/plugin-runtime";
import { BUILTIN_PLUGIN_SOURCES } from "../plugins/builtin.js";
export function resolveBuiltinCompiler(language: string, target: string): CompilerResolution {
  const plugins = BUILTIN_PLUGIN_SOURCES.map((source) => {
    if (source.kind !== "builtin") throw new Error("Built-in sources only.");
    const manifest = pluginManifestSchema.parse(source.manifest);
    return {
      id: manifest.id,
      sourceKey: `builtin:${manifest.id}`,
      source: "builtin" as const,
      status: "enabled" as const,
      problems: [],
      manifest,
    };
  });
  return resolveCompilerProviders(plugins, language, target);
}
```

`build.ts` 的完整最終內容如下（Task 7 只替換最後兩個部署方法）：

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import {
  BuildError,
  failedBuild,
  resolveInside,
  type BuildArtifact,
  type CompileResult,
  type ProjectManifest,
  type SourceProject,
} from "@kobrixa/compiler";
import type { CompilerResolution, CompilerSnapshot } from "@kobrixa/plugin-runtime";
import type { WebContents } from "electron";
import type { BuildEvent } from "../../shared/api.js";
import type { WorkspaceService } from "./workspace.js";
import type { BuildReply, BuildRequest } from "./build-protocol.js";
import type { OfflinePreviewProgram } from "../../shared/offline-preview.js";
import type { SimulationPrepareResult } from "../../shared/simulator.js";
import { snapshotSimulationAssets } from "./prepare-simulation.js";
import { resolveBuiltinCompiler } from "./builtin-compilers.js";
import { OutputQueue } from "./output-queue.js";
interface BuildRecord {
  cancellation: Int32Array;
  worker?: Worker;
  finished: boolean;
  result: CompileResult;
}
interface SimulationPreparation {
  controller: AbortController;
  cancellation: Int32Array;
  predecessor: Promise<void>;
  worker?: Worker;
  termination?: Promise<void>;
}
function untilCancelled<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export class BuildService {
  private disposed = false;
  private activeBuilds = 0;
  get busy(): boolean {
    return this.activeBuilds > 0;
  }
  readonly #builds = new Map<string, BuildRecord>();
  readonly #simulations = new Map<string, SimulationPreparation>();
  readonly #queue = new OutputQueue();
  #admissions: Promise<void> = Promise.resolve();
  private previewSnapshot:
    { buildId: string; program?: OfflinePreviewProgram; error?: string } | undefined;
  constructor(
    private readonly workspaces: Pick<WorkspaceService, "project">,
    private readonly renderer: () => WebContents | undefined,
    private readonly createWorker = (request: BuildRequest): Worker =>
      new Worker(path.join(__dirname, "build-worker.cjs"), { workerData: request }),
    private readonly resolveCompiler: (
      language: string,
      target: string,
    ) => CompilerResolution = resolveBuiltinCompiler,
  ) {}
  private async capture(
    workspaceId: string,
    overlays: Record<string, string>,
    onManifest?: (manifest: ProjectManifest) => void,
  ): Promise<{ project: SourceProject; compiler: CompilerSnapshot }> {
    let snapshot: CompilerSnapshot | undefined;
    const select = (manifest: ProjectManifest) => {
      onManifest?.(manifest);
      const resolution = this.resolveCompiler(manifest.language, manifest.target);
      if (!resolution.ok) throw new BuildError(resolution.code, resolution.message);
      snapshot = resolution;
      return resolution.frontend.contribution;
    };
    const project = await this.workspaces.project(
      workspaceId,
      new Map(Object.entries(overlays)),
      select,
    );
    // 測試 workspace stub 可直接回傳 SourceProject；正式 WorkspaceService 一定呼叫 select。
    if (!snapshot) select(project.manifest);
    return { project, compiler: structuredClone(snapshot!) };
  }
  async start(
    workspaceId: string,
    overlays: Record<string, string>,
    preview = false,
  ): Promise<string> {
    if (this.disposed) throw new Error("Build service is disposed.");
    const buildId = randomUUID();
    const cancellation = new Int32Array(new SharedArrayBuffer(4));
    const record: BuildRecord = {
      cancellation,
      finished: false,
      result: { buildId, target: "unknown", success: false, diagnostics: [], artifacts: [] },
    };
    this.#builds.set(buildId, record);
    this.activeBuilds++;
    const complete = (
      result: CompileResult,
      program?: OfflinePreviewProgram,
      previewError?: string,
    ) => {
      if (record.finished) return;
      record.finished = true;
      delete record.worker;
      this.activeBuilds--;
      record.result = { ...result, buildId, artifacts: result.success ? result.artifacts : [] };
      if (result.success && preview && !Atomics.load(cancellation, 0))
        this.previewSnapshot = {
          buildId,
          ...(program ? { program } : {}),
          ...(previewError ? { error: previewError } : {}),
        };
      if (!this.disposed)
        this.send({ type: "complete", workspaceId, buildId, result: record.result });
    };
    let entry = "<project>";
    const admission = this.#admissions.then(async () => {
      try {
        const { project, compiler } = await this.capture(workspaceId, overlays, (manifest) => {
          entry = manifest.entry;
          record.result.target = manifest.target;
        });
        entry = project.manifest.entry;
        record.result.target = project.manifest.target;
        const output = await resolveInside(project.root, project.manifest.outputDir);
        void this.#queue
          .run(output, async () => {
            if (this.disposed || Atomics.load(cancellation, 0))
              throw new DOMException("Build cancelled.", "AbortError");
            await new Promise<void>((resolve) => {
              const worker = this.createWorker({
                buildId,
                project,
                compiler,
                cancellation: cancellation.buffer as SharedArrayBuffer,
                preview,
              });
              record.worker = worker;
              const fail = (error: unknown) => {
                complete(failedBuild(buildId, project.manifest.target, error, entry));
                resolve();
              };
              worker.on("message", (reply: BuildReply) => {
                if (record.finished) return;
                if (reply.type === "complete") {
                  complete(reply.result, reply.preview, reply.previewError);
                  resolve();
                } else if (reply.type === "progress" && !this.disposed)
                  this.send({
                    type: "progress",
                    workspaceId,
                    buildId,
                    progress: { ...reply.progress, buildId },
                  });
              });
              worker.once("error", fail);
              worker.once("exit", (code) =>
                fail(
                  Atomics.load(cancellation, 0)
                    ? new DOMException("Build cancelled.", "AbortError")
                    : new Error(`Build worker exited before completing (code ${code}).`),
                ),
              );
            });
          })
          .catch((error: unknown) =>
            complete(failedBuild(buildId, record.result.target, error, entry)),
          );
      } catch (error) {
        complete(failedBuild(buildId, record.result.target, error, entry));
      }
    });
    this.#admissions = admission.catch(() => undefined);
    await admission;
    return buildId;
  }
  async prepareSimulation(
    workspaceId: string,
    overlays: Record<string, string>,
    entries: string[],
  ): Promise<SimulationPrepareResult> {
    if (this.disposed) throw new Error("Build service is disposed.");
    const previous = this.#simulations.get(workspaceId);
    this.cancelSimulation(workspaceId);
    const preparation: SimulationPreparation = {
      controller: new AbortController(),
      cancellation: new Int32Array(new SharedArrayBuffer(4)),
      predecessor: previous?.termination ?? Promise.resolve(),
    };
    this.#simulations.set(workspaceId, preparation);
    const signal = preparation.controller.signal;
    this.activeBuilds++;
    try {
      await untilCancelled(preparation.predecessor, signal);
      signal.throwIfAborted();
      let captured: { project: SourceProject; compiler: CompilerSnapshot };
      try {
        captured = await untilCancelled(this.capture(workspaceId, overlays), signal);
      } catch (error) {
        if (error instanceof BuildError)
          return {
            success: false,
            diagnostics: failedBuild("simulation", "unknown", error, "<project>").diagnostics,
          };
        throw error;
      }
      const { project, compiler } = captured;
      signal.throwIfAborted();
      const files = await untilCancelled(snapshotSimulationAssets(project), signal);
      signal.throwIfAborted();
      const worker = this.createWorker({
        buildId: randomUUID(),
        project,
        compiler,
        cancellation: preparation.cancellation.buffer as SharedArrayBuffer,
        simulation: { entries, files },
      });
      preparation.worker = worker;
      return await untilCancelled(
        new Promise<SimulationPrepareResult>((resolve, reject) => {
          worker.on("message", (reply: BuildReply) => {
            if (reply.type === "simulation") resolve(reply.result);
          });
          worker.once("error", reject);
          worker.once("exit", (code) =>
            reject(new Error(`Simulation compiler exited before completing (code ${code}).`)),
          );
        }),
        signal,
      );
    } finally {
      await this.terminateSimulation(preparation);
      if (this.#simulations.get(workspaceId) === preparation) this.#simulations.delete(workspaceId);
      this.activeBuilds--;
    }
  }
  cancelSimulation(workspaceId: string): void {
    const preparation = this.#simulations.get(workspaceId);
    if (!preparation) return;
    Atomics.store(preparation.cancellation, 0, 1);
    preparation.controller.abort(
      new DOMException("Simulation preparation cancelled.", "AbortError"),
    );
    void this.terminateSimulation(preparation);
  }
  private terminateSimulation(preparation: SimulationPreparation): Promise<void> {
    preparation.termination ??= Promise.all([
      preparation.predecessor,
      preparation.worker?.terminate().catch(() => undefined),
    ]).then(() => undefined);
    return preparation.termination;
  }
  cancel(buildId: string): void {
    Atomics.store(this.require(buildId).cancellation, 0, 1);
  }
  cancelAll(): void {
    for (const id of this.#simulations.keys()) this.cancelSimulation(id);
    for (const record of this.#builds.values())
      if (!record.finished) Atomics.store(record.cancellation, 0, 1);
  }
  dispose(): void {
    this.disposed = true;
    this.previewSnapshot = undefined;
    this.cancelAll();
  }
  artifacts(buildId: string): BuildArtifact[] {
    return structuredClone(this.require(buildId).result.artifacts);
  }
  preview(buildId: string): OfflinePreviewProgram {
    this.require(buildId);
    if (this.disposed || this.previewSnapshot?.buildId !== buildId)
      throw new Error("This build has no offline preview snapshot. Build the preview again.");
    if (!this.previewSnapshot.program)
      throw new Error(this.previewSnapshot.error ?? "No offline preview snapshot.");
    return structuredClone(this.previewSnapshot.program);
  }
  async artifactBytes(buildId: string): Promise<Uint8Array> {
    const main = this.require(buildId).result.artifacts.find((item) => item.role === "deploy-main");
    if (!main) throw new BuildError("BUILD1005", "This build has no deployable program.");
    return readFile(main.path);
  }
  async deployableArtifacts(
    buildId: string,
  ): Promise<Array<{ kind: "asset" | "rbf"; path: string; remotePath: string }>> {
    const artifacts = this.require(buildId).result.artifacts;
    const main = artifacts.find((item) => item.role === "deploy-main");
    if (!main) throw new BuildError("BUILD1005", "This build has no deployable program.");
    return [
      ...artifacts
        .filter((item) => item.role === "deploy-asset")
        .map((item) => ({ kind: "asset" as const, path: item.path, remotePath: item.remotePath! })),
      { kind: "rbf", path: main.path, remotePath: path.basename(main.path) },
    ];
  }
  private require(id: string): BuildRecord {
    const record = this.#builds.get(id);
    if (!record) throw new Error("Unknown build.");
    return record;
  }
  private send(event: BuildEvent): void {
    const target = this.renderer();
    if (target && !target.isDestroyed()) target.send("build:event", event);
  }
}
```

start 的 admission 依呼叫順序擷取來源並登記 FIFO，避免較快的第二次來源讀取插隊；admission 不等待編譯完成，不同目錄仍可同時編譯。Task 7 將上面最後兩個方法替換為整批驗 hash 的 byte snapshot，並刪 readFile import；它們目前只是將既有消費端接到 role，沒有聲稱已完成部署驗證。

- [ ] **Step 8: worker 傳遞 buildId、解析快照與共享取消**

`build-worker.ts` 全文：

```ts
import { parentPort, workerData } from "node:worker_threads";
import { BuildSession, failedBuild } from "@kobrixa/compiler";
import type { KobrixaIR } from "@kobrixa/ir";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createBuiltinCompilers } from "./builtin-compilers.js";
import { prepareSimulation } from "./prepare-simulation.js";
import type { BuildReply, BuildRequest } from "./build-protocol.js";
import {
  PREVIEW_MAX_FILES,
  PREVIEW_MAX_FILE_BYTES,
  type OfflinePreviewProgram,
} from "../../shared/offline-preview.js";
const port = parentPort;
if (!port) throw new Error("Compilation must run in a worker.");
const request = workerData as BuildRequest;
const cancellation = new Int32Array(request.cancellation);
const controller = new AbortController();
const check = controller.signal.throwIfAborted.bind(controller.signal);
controller.signal.throwIfAborted = () => {
  if (Atomics.load(cancellation, 0)) controller.abort();
  check();
};
const send = (reply: BuildReply) => port.postMessage(reply);
async function run(): Promise<void> {
  if (request.simulation) {
    const result = await prepareSimulation(
      request.project,
      request.simulation.entries,
      request.simulation.files,
      controller.signal,
      request.compiler,
    );
    send({ type: "simulation", result });
    return;
  }
  const { frontend, backend } = createBuiltinCompilers(request.compiler);
  let previewIR: KobrixaIR | undefined;
  const session = new BuildSession(
    {
      id: frontend.id,
      compile: async (project, signal) => {
        const result = await frontend.compile(project, signal);
        if (request.preview) previewIR = result.ir;
        return result;
      },
    },
    backend,
    (progress) => send({ type: "progress", progress }),
    controller,
    request.buildId,
  );
  const result = await session.compile(request.project);
  let preview: OfflinePreviewProgram | undefined;
  let previewError: string | undefined;
  if (result.success && previewIR) {
    try {
      if (previewIR.version !== 1) throw new Error("Unsupported preview IR version.");
      const assets = result.artifacts.filter((artifact) => artifact.role === "deploy-asset");
      if (assets.length > PREVIEW_MAX_FILES)
        throw new Error("Offline preview supports at most 64 resource files.");
      const files: Record<string, number[]> = Object.create(null);
      let total = 0;
      for (const asset of assets) {
        controller.signal.throwIfAborted();
        const info = await stat(asset.path);
        if (info.size > PREVIEW_MAX_FILE_BYTES - total)
          throw new Error("Offline preview resource files exceed the 1 MiB limit.");
        const bytes = await readFile(asset.path);
        total += bytes.length;
        if (total > PREVIEW_MAX_FILE_BYTES)
          throw new Error("Offline preview resource files exceed the 1 MiB limit.");
        if (!asset.remotePath || createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
          throw new Error("Build resources changed while preparing the preview. Build again.");
        files[asset.remotePath] = Array.from(bytes);
      }
      controller.signal.throwIfAborted();
      preview = { ir: previewIR, files };
    } catch (error) {
      previewError = error instanceof Error ? error.message : String(error);
    }
  }
  send({
    type: "complete",
    result,
    ...(preview ? { preview } : {}),
    ...(previewError ? { previewError } : {}),
  });
}
void run()
  .catch((error: unknown) => {
    const result = failedBuild(
      request.buildId,
      request.project.manifest.target,
      error,
      request.project.manifest.entry,
    );
    if (request.simulation)
      send({ type: "simulation", result: { success: false, diagnostics: result.diagnostics } });
    else send({ type: "complete", result });
  })
  .finally(() => port.close());
```

刪除 `builtin-frontends.ts`。main/index 的建構式改成：

```ts
const builds = new BuildService(workspaces, renderer, undefined, (language, target) =>
  plugins.resolveCompiler(language, target),
);
```

- [ ] **Step 9: 更新 worker 測試並確認找不到提供者時不開 worker**

`build.test.ts` 新增 `resolveBuiltinCompiler` import。第一個解析測試的最後參數改成 `resolveBuiltinCompiler`；斷言改成：

```ts
expect(requests[0]!.compiler).toMatchObject({
  frontend: { pluginId: "kobrixa.basic-plus" },
  backend: { pluginId: "kobrixa.ev3" },
  ir: 1,
});
```

原 `fails the build clearly when no enabled plugin provides the language` 整個測試換成：

```ts
it("does not open a worker when a provider is missing or incompatible", async () => {
  for (const code of ["BUILD1001", "BUILD1002"] as const) {
    service.dispose();
    const create = vi.fn(() => {
      throw new Error("must not start worker");
    });
    service = new BuildService(
      { project: async (_id, overlays) => (await loadProject(root, overlays, "main.bp")).project! },
      () =>
        ({
          isDestroyed: () => false,
          send: (_channel: string, event: BuildEvent) => events.push(event),
        }) as unknown as WebContents,
      create,
      () => ({ ok: false, code, message: "provider unavailable" }),
    );
    const id = await service.start("project", {});
    expect(await result(id)).toMatchObject({
      success: false,
      artifacts: [],
      diagnostics: [expect.objectContaining({ code })],
    });
    expect(create).not.toHaveBeenCalled();
    expect(service.busy).toBe(false);
  }
});
```

本檔 `original.artifacts.find((item) => item.kind === "rbf")` 改為 `original.artifacts.find((item) => item.role === "deploy-main")`。

Run: `pnpm --filter @kobrixa/plugin-runtime build && pnpm --filter @kobrixa/compiler build && pnpm --filter @kobrixa/desktop exec vitest run src/main/workspace/build.test.ts src/main/workspace/output-queue.test.ts src/main/workspace/prepare-simulation.test.ts src/main/plugins/builtin.test.ts`
Expected: PASS，包含現有同步編譯取消、四入口模擬、資源快照、worker error／exit 只完成一次及 preview 回歸。

- [ ] **Step 10: 格式化與 lint**

```bash
pnpm exec prettier --write packages/compiler/src/output-lock.ts packages/compiler/src/commit-artifacts.ts packages/compiler/src/build-session.ts packages/compiler/src/index.ts packages/compiler/src/output-lock.test.ts packages/compiler/src/commit-artifacts.test.ts apps/desktop/src/main/workspace/output-queue.ts apps/desktop/src/main/workspace/output-queue.test.ts apps/desktop/src/main/workspace/build.ts apps/desktop/src/main/workspace/build-worker.ts apps/desktop/src/main/workspace/build.test.ts apps/desktop/src/main/workspace/builtin-compilers.ts apps/desktop/src/main/index.ts
pnpm exec prettier --check packages/compiler/src/output-lock.ts packages/compiler/src/commit-artifacts.ts packages/compiler/src/build-session.ts packages/compiler/src/index.ts packages/compiler/src/output-lock.test.ts packages/compiler/src/commit-artifacts.test.ts apps/desktop/src/main/workspace/output-queue.ts apps/desktop/src/main/workspace/output-queue.test.ts apps/desktop/src/main/workspace/build.ts apps/desktop/src/main/workspace/build-worker.ts apps/desktop/src/main/workspace/build.test.ts apps/desktop/src/main/workspace/builtin-compilers.ts apps/desktop/src/main/index.ts
pnpm exec eslint packages/compiler/src/output-lock.ts packages/compiler/src/commit-artifacts.ts packages/compiler/src/build-session.ts packages/compiler/src/index.ts packages/compiler/src/output-lock.test.ts packages/compiler/src/commit-artifacts.test.ts apps/desktop/src/main/workspace/output-queue.ts apps/desktop/src/main/workspace/output-queue.test.ts apps/desktop/src/main/workspace/build.ts apps/desktop/src/main/workspace/build-worker.ts apps/desktop/src/main/workspace/build.test.ts apps/desktop/src/main/workspace/builtin-compilers.ts apps/desktop/src/main/index.ts
```

- [ ] **Step 11: Commit**

```bash
git add packages/compiler/src/output-lock.ts packages/compiler/src/commit-artifacts.ts packages/compiler/src/build-session.ts packages/compiler/src/index.ts packages/compiler/src/output-lock.test.ts packages/compiler/src/commit-artifacts.test.ts apps/desktop/src/main/workspace/output-queue.ts apps/desktop/src/main/workspace/output-queue.test.ts apps/desktop/src/main/workspace/build.ts apps/desktop/src/main/workspace/build-worker.ts apps/desktop/src/main/workspace/build.test.ts apps/desktop/src/main/workspace/builtin-compilers.ts apps/desktop/src/main/workspace/builtin-frontends.ts apps/desktop/src/main/index.ts
git commit -m "feat(build): stage validated artifacts and serialize output commits" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 7: 部署驗證記憶體快照與 renderer 可部署狀態

**Files:**

- Create: `packages/compiler/src/deployment.ts`（全批驗 hash 的部署快照）
- Modify: `packages/compiler/src/index.ts:末尾`（匯出）
- Modify: `apps/desktop/src/main/workspace/build.ts:artifactBytes／deployableArtifacts`（整批 bytes）
- Modify: `apps/desktop/src/main/device/device.ts:4,271–333`（傳同一批 bytes、依 role 略過未變資源）
- Modify: `apps/desktop/src/renderer/execution/build-path.ts:1–末尾`（通用部署路徑與雙語原因）
- Modify: `apps/desktop/src/renderer/execution/execution.ts:48–78,453–470,550–554,610–650`（成功與可部署分開）
- Modify: `apps/desktop/src/renderer/execution/version-label.ts:3–5`（不可部署版本也能顯示）
- Modify: `apps/desktop/src/renderer/workbench/toolbar.tsx:80–85,150–155,195–205`（按鈕原因）
- Test: `apps/desktop/src/main/device/deployment-snapshot.test.ts`（新）
- Test: `apps/desktop/src/renderer/execution/build-path.test.ts:1–末尾`
- Test: `apps/desktop/src/renderer/execution/execution.test.ts:6–27,末尾`
- Test: `apps/desktop/src/renderer/workbench/toolbar-deployment.test.ts`（新）
- Modify: `apps/desktop/src/main/device/recovery.test.ts:105–109`（快照 fixture）

**Interfaces:**

- Consumes：`CompileResult = { buildId: string; target: string; deploy?: "ev3"; runtimeDirectory?: string; success: boolean; diagnostics: Diagnostic[]; artifacts: BuildArtifact[] }`；BuildArtifact 包含 slot／kind／role／mediaType／path／sha256／byteLength／可選 remotePath。
- Produces：`DeploymentFile = { role: "deploy-asset" | "deploy-main"; path: string; remotePath: string; bytes: Uint8Array; sha256: string }`；`readDeploymentSnapshot(result: CompileResult, supported: "ev3", signal?: AbortSignal): Promise<DeploymentFile[]>`。
- Produces：`BuildService.deployableArtifacts(buildId: string, signal?: AbortSignal): Promise<DeploymentFile[]>`；`artifactBytes(buildId: string, signal?: AbortSignal): Promise<Uint8Array>`（也先驗全批）。
- Preserves：`DeviceService.deploy(id: string, buildId: string, remoteDirectory: string): Promise<void>`、`upload(id: string, buildId: string, remotePath: string): Promise<void>`；shared/api 與 main/ipc 的既有 channel／UUID 驗證不變，bytes 不傳往 renderer。
- Produces：`deploymentPath(result: CompileResult): string | undefined`；`deploymentUnavailableReason(code: "BUILD1005" | undefined, locale: "en" | "zh-TW"): string | undefined`。
- Produces：`BuildVersion = { workspaceId: string; buildId: string; time: number; path?: string; deploy?: "ev3"; undeployableReason?: "BUILD1005" }`；已部署的 state／recovery 仍要求 `path: string`。

- [ ] **Step 1: 寫失敗的整批驗證與設備快照測試**

`deployment-snapshot.test.ts` 全文：

```ts
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readDeploymentSnapshot, type CompileResult, type BuildArtifact } from "@kobrixa/compiler";
import { UsbTransport, type RemoteEntry } from "@kobrixa/device";
import { DeviceService } from "./device.js";
import type { BuildService } from "../workspace/build.js";
vi.mock("electron", () => ({ dialog: {} }));
let root: string;
const services: DeviceService[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-deploy-"));
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.reset()));
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const artifact = async (
    name: string,
    role: "deploy-main" | "deploy-asset",
    byte: number,
  ): Promise<BuildArtifact> => {
    const bytes = new Uint8Array([byte]);
    const file = path.join(root, name);
    await writeFile(file, bytes);
    return {
      slot: role === "deploy-main" ? "program" : "asset",
      kind: "not-rbf",
      role,
      mediaType: "application/octet-stream",
      path: file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: 1,
      ...(role === "deploy-asset" ? { remotePath: name } : {}),
    };
  };
  const result: CompileResult = {
    buildId: "build",
    target: "toy-vm",
    deploy: "ev3",
    runtimeDirectory: "/robot",
    success: true,
    diagnostics: [],
    artifacts: [
      await artifact("b.bin", "deploy-asset", 2),
      await artifact("main.bin", "deploy-main", 3),
      await artifact("a.bin", "deploy-asset", 1),
    ],
  };
  const session = {
    descriptor: { id: "mock", name: "EV3", transport: "usb" as const },
    connected: true,
    list: vi.fn(async (): Promise<RemoteEntry[]> => []),
    upload: vi.fn(async (_path: string, _bytes: Uint8Array) => {}),
    run: vi.fn(),
    stop: vi.fn(),
    disconnect: vi.fn(async () => {}),
    onDisconnect: () => () => {},
  };
  vi.spyOn(UsbTransport.prototype, "connect").mockResolvedValue(session as never);
  const builds = {
    deployableArtifacts: (_id: string, signal?: AbortSignal) =>
      readDeploymentSnapshot(result, "ev3", signal),
  } as unknown as BuildService;
  const service = new DeviceService(builds, () => undefined);
  services.push(service);
  const id = await service.connect(session.descriptor);
  return { result, service, session, id };
}
it("rejects a changed or missing last file before any upload", async () => {
  for (const missing of [false, true]) {
    const h = await fixture();
    const main = h.result.artifacts.find((item) => item.role === "deploy-main")!;
    if (missing) await rm(main.path);
    else await writeFile(main.path, new Uint8Array([9]));
    await expect(h.service.deploy(h.id, "build", "/robot")).rejects.toThrow("BUILD1006");
    expect(h.session.upload).not.toHaveBeenCalled();
    expect(h.session.list).not.toHaveBeenCalled();
    expect(h.service.busy).toBe(false);
  }
});
it("uploads the verified snapshot even if disk changes during transfer", async () => {
  const h = await fixture();
  h.session.upload.mockImplementationOnce(async () => {
    await writeFile(path.join(root, "main.bin"), new Uint8Array([99]));
  });
  await h.service.deploy(h.id, "build", h.result.runtimeDirectory!);
  expect(h.session.upload.mock.calls.map(([name, bytes]) => [name, [...bytes]])).toEqual([
    ["/robot/a.bin", [1]],
    ["/robot/b.bin", [2]],
    ["/robot/main.bin", [3]],
  ]);
});
it("rejects unsupported deployment and skips unchanged assets but always uploads main", async () => {
  const h = await fixture();
  const undeployable = { ...h.result };
  delete undeployable.deploy;
  await expect(readDeploymentSnapshot(undeployable, "ev3")).rejects.toThrow("BUILD1005");
  h.session.list.mockResolvedValue(
    [1, 2].map((byte, index) => ({
      name: `${index ? "b" : "a"}.bin`,
      path: `/robot/${index ? "b" : "a"}.bin`,
      kind: "file" as const,
      size: 1,
      checksum: createHash("md5")
        .update(new Uint8Array([byte]))
        .digest("hex"),
    })),
  );
  await h.service.deploy(h.id, "build", "/robot");
  expect(h.session.list).toHaveBeenCalledTimes(1);
  expect(h.session.upload.mock.calls.map(([name]) => name)).toEqual(["/robot/main.bin"]);
});
```

Run: `pnpm --filter @kobrixa/desktop exec vitest run src/main/device/deployment-snapshot.test.ts`
Expected: FAIL，沒有 readDeploymentSnapshot；目前會直接逐檔讀取並上傳。

- [ ] **Step 2: 實作全批驗證後回傳 bytes**

`packages/compiler/src/deployment.ts` 全文：

```ts
import { createHash } from "node:crypto";
import path from "node:path";
import type { CompileResult } from "./contracts.js";
import { BuildError } from "./build-error.js";
import { BUILD_LIMITS, validateArtifactLayout, validateBuildLimits } from "./artifacts.js";
import { readBoundedFile } from "./safe-files.js";
export interface DeploymentFile {
  role: "deploy-asset" | "deploy-main";
  path: string;
  remotePath: string;
  bytes: Uint8Array;
  sha256: string;
}
export async function readDeploymentSnapshot(
  result: CompileResult,
  supported: "ev3",
  signal = new AbortController().signal,
): Promise<DeploymentFile[]> {
  const mains = result.artifacts.filter((item) => item.role === "deploy-main");
  if (!result.success || result.deploy !== supported || mains.length !== 1 || !mains[0]!.byteLength)
    throw new BuildError("BUILD1005", "This target cannot be deployed to the selected device.");
  const assets = result.artifacts
    .filter((item) => item.role === "deploy-asset")
    .sort((a, b) =>
      (a.remotePath ?? "") < (b.remotePath ?? "")
        ? -1
        : (a.remotePath ?? "") > (b.remotePath ?? "")
          ? 1
          : 0,
    );
  const selected = [...assets, mains[0]!];
  try {
    const paths = selected.map((item) => ({
      relativePath:
        item.role === "deploy-main" ? path.basename(item.path) : (item.remotePath ?? ""),
      byteLength: item.byteLength,
    }));
    validateArtifactLayout(paths);
    validateBuildLimits(0, paths);
    const files: DeploymentFile[] = [];
    let total = 0;
    for (let index = 0; index < selected.length; index++) {
      signal.throwIfAborted();
      const artifact = selected[index]!;
      const bytes = await readBoundedFile(
        path.dirname(artifact.path),
        path.basename(artifact.path),
        Math.min(artifact.byteLength, BUILD_LIMITS.artifactBytes, BUILD_LIMITS.totalBytes - total),
        signal,
      );
      total += bytes.byteLength;
      if (
        bytes.byteLength !== artifact.byteLength ||
        createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
      )
        throw new Error("The artifact hash or byte length changed.");
      files.push({
        role: artifact.role as DeploymentFile["role"],
        path: artifact.path,
        remotePath: paths[index]!.relativePath,
        bytes,
        sha256: artifact.sha256,
      });
    }
    return files;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new BuildError("BUILD1006", "Build artifacts changed or are missing; build again.");
  }
}
```

compiler index 加 `export * from "./deployment.js";`。build.ts 刪除 `readFile` import，compiler import 加 `readDeploymentSnapshot`、`type DeploymentFile`，以以下方法取代原本兩個部署方法：

```ts
async artifactBytes(buildId: string, signal?: AbortSignal): Promise<Uint8Array> {
  const files = await this.deployableArtifacts(buildId, signal);
  return files.find((item) => item.role === "deploy-main")!.bytes;
}
async deployableArtifacts(buildId: string, signal?: AbortSignal): Promise<DeploymentFile[]> {
  return readDeploymentSnapshot(this.require(buildId).result, "ev3", signal);
}
```

device.ts 刪除 `readFile` import；upload 的呼叫換成：

```ts
await session.upload(remotePath, await this.builds.artifactBytes(buildId, signal), signal);
```

deploy 方法中的三個精確替換：

```ts
const files = await this.builds.deployableArtifacts(buildId, signal);
```

```ts
const bytes = file.bytes;
```

```ts
if (skipUnchanged && file.role === "deploy-asset") {
```

其他 `this.operation`、listings cache、md5、deployment recovery metadata、session 鎖、remoteDirectory 與傳輸錯誤包裝全部保留。這使第一次 session.list／upload 之前就已讀完且驗完所有檔案。

- [ ] **Step 3: 寫失敗的 renderer 成功／不可部署測試**

`build-path.test.ts` 全文：

```ts
import { expect, it } from "vitest";
import type { CompileResult } from "../../shared/api.js";
import { deploymentPath, deploymentUnavailableReason } from "./build-path.js";
const result: CompileResult = {
  buildId: "build",
  target: "toy-vm",
  deploy: "ev3",
  success: true,
  diagnostics: [],
  artifacts: [
    {
      slot: "program",
      kind: "not-rbf",
      role: "deploy-main",
      mediaType: "application/octet-stream",
      path: "C:\\project\\build\\card.bin",
      sha256: "abc",
      byteLength: 1,
    },
  ],
};
it("uses deploy capability and main role while preserving Folder", () => {
  expect(deploymentPath(result)).toBe("/home/root/lms2012/prjs/card.bin");
  expect(
    deploymentPath({ ...result, runtimeDirectory: "/home/root/lms2012/prjs/SD_Card/Lesson" }),
  ).toBe("/home/root/lms2012/prjs/SD_Card/Lesson/card.bin");
  const local = { ...result };
  delete local.deploy;
  expect(deploymentPath(local)).toBeUndefined();
  expect(deploymentPath({ ...result, success: false })).toBeUndefined();
  expect(deploymentPath({ ...result, artifacts: [] })).toBeUndefined();
  expect(deploymentUnavailableReason("BUILD1005", "en")).toContain("cannot deploy");
  expect(deploymentUnavailableReason("BUILD1005", "zh-TW")).toContain("無法部署");
});
```

execution.test.ts 的 success fixture 換成：

```ts
const success: CompileResult = {
  buildId: "b1",
  target: "ev3-native",
  deploy: "ev3",
  success: true,
  diagnostics: [],
  runtimeDirectory: "/robot",
  artifacts: [
    {
      slot: "program",
      kind: "rbf",
      role: "deploy-main",
      mediaType: "application/octet-stream",
      path: "/tmp/build/demo.rbf",
      sha256: "abc",
      byteLength: 1,
    },
  ],
};
```

failure fixture 加 `buildId: "failed", target: "ev3-native",`，保留原診斷。追加：

```ts
it("keeps a successful non-deployable build without a build error", async () => {
  const h = setup();
  const local: CompileResult = {
    buildId: "local",
    target: "analysis",
    success: true,
    diagnostics: [],
    artifacts: [],
  };
  h.api.build.start.mockImplementation(async () => {
    h.emitBuild({ type: "complete", workspaceId: "w1", buildId: "local", result: local });
    return "local";
  });
  await h.controller.build(h.request);
  expect(h.controller.getSnapshot()).toMatchObject({
    phase: "idle",
    successfulBuild: { buildId: "local", undeployableReason: "BUILD1005" },
  });
  expect(h.controller.getSnapshot().error).toBeUndefined();
  expect(h.controller.getSnapshot().logs.at(-1)).toMatchObject({ message: "built", failed: false });
  await h.controller.connect(usb);
  await h.controller.upload();
  await h.controller.run(h.request);
  expect(h.api.device.deploy).not.toHaveBeenCalled();
  expect(h.api.device.run).not.toHaveBeenCalled();
  expect(h.controller.getSnapshot().error).toBeUndefined();
});
```

Run: `pnpm --filter @kobrixa/desktop exec vitest run src/renderer/execution/build-path.test.ts src/renderer/execution/execution.test.ts`
Expected: FAIL，非 rbf 找不到路徑，成功但不可部署仍被 compile 丟出例外。

- [ ] **Step 4: 實作通用路徑與成功狀態**

`build-path.ts` 全文：

```ts
import type { CompileResult } from "../../shared/api.js";
export function deploymentPath(result: CompileResult): string | undefined {
  if (!result.success || result.deploy !== "ev3") return undefined;
  const mains = result.artifacts.filter((artifact) => artifact.role === "deploy-main");
  if (mains.length !== 1 || !mains[0]!.byteLength) return undefined;
  const filename = mains[0]!.path.replaceAll("\\", "/").split("/").at(-1);
  if (!filename) return undefined;
  return `${result.runtimeDirectory ?? "/home/root/lms2012/prjs"}/${filename}`;
}
export function deploymentUnavailableReason(
  code: "BUILD1005" | undefined,
  locale: "en" | "zh-TW",
): string | undefined {
  if (!code) return undefined;
  return locale === "zh-TW"
    ? "建置已成功；這個目標無法部署至 EV3。"
    : "Build succeeded; this target cannot deploy to EV3.";
}
```

execution.ts 的 BuildVersion 完整改為：

```ts
export interface BuildVersion {
  workspaceId: string;
  buildId: string;
  time: number;
  path?: string;
  deploy?: "ev3";
  undeployableReason?: "BUILD1005";
}
```

ExecutionState.recovery.deployed 的型別改成 `(BuildVersion & { path: string }) | undefined`；ExecutionState.deployed 改成 `(BuildVersion & { sessionId: string; path: string }) | undefined`。`compile()` 中從 `const path = deploymentPath(result);` 到 version 建構改為：

```ts
if (!result.success)
  throw new Error(
    result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n") || "Build failed.",
  );
const path = deploymentPath(result);
const version: BuildVersion = {
  workspaceId: request.workspaceId,
  buildId: waiting.id,
  time: Date.now(),
  ...(path ? { path, deploy: "ev3" as const } : { undeployableReason: "BUILD1005" as const }),
};
```

保留後面的 successfulBuild／built log／return。`buildAndMaybeRun` 的 `if (run)` 改成 `if (run && version.path && version.deploy === "ev3")`。`deploy` 方法最前面加入：

```ts
if (!version.path || version.deploy !== "ev3")
  throw new Error("BUILD1005: This target cannot deploy to EV3.");
```

其 update 改成：

```ts
this.update({ deployed: { ...version, path: version.path, sessionId: session.id } });
```

`upload()` 的提前 return 條件，在 `!version ||` 後加：

```ts
!version.path || version.deploy !== "ev3" ||
```

`version-label.ts` 全文：

```ts
import type { Locale } from "../i18n/copy.js";
export function versionLabel(
  version: { path?: string; buildId: string; time: number },
  locale: Locale,
): string {
  const name =
    version.path?.split("/").at(-1) ??
    (locale === "zh-TW" ? "建置 " : "Build ") + version.buildId.slice(0, 8);
  return `${name} · ${new Date(version.time).toLocaleTimeString(locale, { hour12: false })}`;
}
```

- [ ] **Step 5: 補按鈕雙語原因及 UI 測試**

toolbar.tsx 加 import：

```ts
import { deploymentUnavailableReason } from "../execution/build-path.js";
```

在 `const controlBlocked` 後加：

```ts
const deploymentReason = deploymentUnavailableReason(
  state.successfulBuild?.undeployableReason,
  locale,
);
```

Run 按鈕的 disabled／title 改為：

```tsx
disabled={deviceLocked || controlBlocked || Boolean(state.recovery) || Boolean(deploymentReason)}
title={deviceControlNotice ?? deploymentReason ?? hint(t.runOnDevice, "run")}
```

Upload 按鈕的 disabled／title 改為：

```tsx
disabled={deviceLocked || controlBlocked || !state.session || !state.successfulBuild?.path || Boolean(deploymentReason)}
title={deviceControlNotice ?? deploymentReason}
```

建立 `toolbar-deployment.test.ts`：

```ts
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Toolbar } from "./toolbar.js";
import { copy } from "../i18n/copy.js";
import type { ExecutionState } from "../execution/execution.js";
it.each(["en", "zh-TW"] as const)(
  "shows a non-deployable reason without disabling Build in %s",
  async (locale) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const noop = () => {};
    const state: ExecutionState = {
      phase: "idle",
      diagnostics: [],
      logs: [],
      session: { id: "s", name: "EV3", transport: "usb" },
      successfulBuild: { workspaceId: "w", buildId: "b", time: 0, undeployableReason: "BUILD1005" },
    };
    try {
      await act(async () =>
        root.render(
          createElement(Toolbar, {
            t: copy[locale],
            locale,
            theme: "dark",
            appearance: null,
            shortcutHint: () => "",
            name: "demo",
            locked: false,
            canSave: true,
            deviceLocked: false,
            state,
            onSaveAll: noop,
            onNew: noop,
            onOpen: noop,
            onSave: noop,
            onRun: noop,
            onStop: noop,
            onBuild: noop,
            onPreview: noop,
            onUpload: noop,
            onRunUploaded: noop,
            onDelete: noop,
            onCancel: noop,
            onDevice: noop,
          }),
        ),
      );
      const run = container.querySelector<HTMLButtonElement>(".run-button")!;
      expect(run.disabled).toBe(true);
      expect(run.title).toContain(locale === "zh-TW" ? "無法部署" : "cannot deploy");
      const menu = container.querySelector<HTMLButtonElement>(".more-button")!;
      await act(async () => menu.click());
      const build = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === copy[locale].build,
      )!;
      const upload = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === copy[locale].uploadLatest,
      )!;
      expect(build.disabled).toBe(false);
      expect(upload.disabled).toBe(true);
      expect(upload.title).toBe(run.title);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);
```

recovery.test.ts 的 BuildService stub 每次呼叫都回傳完整資源快照；fs import 加 `readFile`，整個 deployableArtifacts fixture 換成：

```ts
deployableArtifacts: vi.fn(async () => Promise.all([
  { role: "deploy-asset" as const, path: asset, remotePath: "assets/image.rgf" },
  { role: "deploy-main" as const, path: program, remotePath: "main.rbf" },
].map(async (file) => {
  const bytes = await readFile(file.path);
  return { ...file, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}))),
```

這是設備 recovery 測試的 BuildService stub；真正 BuildService 的 BUILD1006 行為由本 task 的整批快照測試釘住。

- [ ] **Step 6: 執行測試確認通過**

Run: `pnpm --filter @kobrixa/compiler build && pnpm --filter @kobrixa/plugin-runtime build && pnpm --filter @kobrixa/desktop exec vitest run src/main/device/deployment-snapshot.test.ts src/main/device/device.test.ts src/main/device/device-lock.test.ts src/main/device/recovery.test.ts src/renderer/execution/build-path.test.ts src/renderer/execution/execution.test.ts src/renderer/workbench/toolbar-deployment.test.ts src/renderer/device/recovery-ui.test.ts`
Expected: PASS，hash 失敗零上傳、檢查後磁碟改動不影響傳送 bytes、Folder／設備鎖／略過未變資源與 recovery 全保留。

- [ ] **Step 7: 格式化與 lint**

```bash
pnpm exec prettier --write packages/compiler/src/deployment.ts packages/compiler/src/index.ts apps/desktop/src/main/workspace/build.ts apps/desktop/src/main/device/device.ts apps/desktop/src/main/device/deployment-snapshot.test.ts apps/desktop/src/main/device/recovery.test.ts apps/desktop/src/renderer/execution/build-path.ts apps/desktop/src/renderer/execution/build-path.test.ts apps/desktop/src/renderer/execution/execution.ts apps/desktop/src/renderer/execution/execution.test.ts apps/desktop/src/renderer/execution/version-label.ts apps/desktop/src/renderer/workbench/toolbar.tsx apps/desktop/src/renderer/workbench/toolbar-deployment.test.ts
pnpm exec prettier --check packages/compiler/src/deployment.ts packages/compiler/src/index.ts apps/desktop/src/main/workspace/build.ts apps/desktop/src/main/device/device.ts apps/desktop/src/main/device/deployment-snapshot.test.ts apps/desktop/src/main/device/recovery.test.ts apps/desktop/src/renderer/execution/build-path.ts apps/desktop/src/renderer/execution/build-path.test.ts apps/desktop/src/renderer/execution/execution.ts apps/desktop/src/renderer/execution/execution.test.ts apps/desktop/src/renderer/execution/version-label.ts apps/desktop/src/renderer/workbench/toolbar.tsx apps/desktop/src/renderer/workbench/toolbar-deployment.test.ts
pnpm exec eslint packages/compiler/src/deployment.ts packages/compiler/src/index.ts apps/desktop/src/main/workspace/build.ts apps/desktop/src/main/device/device.ts apps/desktop/src/main/device/deployment-snapshot.test.ts apps/desktop/src/main/device/recovery.test.ts apps/desktop/src/renderer/execution/build-path.ts apps/desktop/src/renderer/execution/build-path.test.ts apps/desktop/src/renderer/execution/execution.ts apps/desktop/src/renderer/execution/execution.test.ts apps/desktop/src/renderer/execution/version-label.ts apps/desktop/src/renderer/workbench/toolbar.tsx apps/desktop/src/renderer/workbench/toolbar-deployment.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add packages/compiler/src/deployment.ts packages/compiler/src/index.ts apps/desktop/src/main/workspace/build.ts apps/desktop/src/main/device/device.ts apps/desktop/src/main/device/deployment-snapshot.test.ts apps/desktop/src/main/device/recovery.test.ts apps/desktop/src/renderer/execution/build-path.ts apps/desktop/src/renderer/execution/build-path.test.ts apps/desktop/src/renderer/execution/execution.ts apps/desktop/src/renderer/execution/execution.test.ts apps/desktop/src/renderer/execution/version-label.ts apps/desktop/src/renderer/workbench/toolbar.tsx apps/desktop/src/renderer/workbench/toolbar-deployment.test.ts
git commit -m "feat(deploy): upload verified artifact snapshots and preserve local build success" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 8: 假編譯器、跨程序競態、既有回歸與雙語文件

**Files:**

- Create: `apps/desktop/src/main/workspace/compiler-chain.test.ts`（假插件完整流程）
- Create: `packages/compiler/src/output-lock.process.test.ts`（兩個真實 Node 程序提交）
- Modify: `apps/desktop/src/main/workspace/build.test.ts:145–155,401–408,末尾`（排隊取消與非同步 worker 啟動）
- Modify: `apps/desktop/src/main/workspace/integration.test.ts:5–7,32–36`（改用內建 adapter）
- Modify: `apps/desktop/src/main/workspace/examples.test.ts:5–8,131–139`（範例回歸使用 role）
- Modify: `tests/desktop/packaged-smoke.mjs:177`（成品契約）
- Modify: `tests/desktop/smoke-main.mjs:260–264,591–595`（完整 CompileResult fixture）
- Modify: `docs/en/architecture.md:13–15,152,184–229`（英文編譯／插件契約）
- Modify: `docs/zh-TW/architecture.md:13–15,152,184–229`（繁中編譯／插件契約）
- Modify: `plugins/samples/README.md:48,75,124,151`（雙語外部插件界線）

**Interfaces:**

- Consumes：`PluginManager.resolveCompiler(language: string, target: string): CompilerResolution`；`WorkspaceService.project(id: string, overlays: ReadonlyMap<string, string>, resolveFrontend?: (manifest: ProjectManifest) => FrontendDecl): Promise<SourceProject>`；`BuildService.start(workspaceId: string, overlays: Record<string, string>, preview?: boolean): Promise<string>`／`BuildService.deployableArtifacts(buildId: string, signal?: AbortSignal): Promise<DeploymentFile[]>`。
- Consumes：`BuildRequest = { buildId: string; project: SourceProject; compiler: CompilerSnapshot; cancellation: SharedArrayBuffer; preview?: boolean; simulation?: { entries: string[]; files: Record<string, number[]> } }`。
- Consumes：`BuildSession(frontend: LanguageFrontend, backend: CompilerBackend, onProgress?: (progress: BuildProgress) => void, controller?: AbortController, id?: string, commitOptions?: CommitOptions)`；`commitArtifacts(project: SourceProject, buildId: string, artifacts: MemoryArtifact[], signal: AbortSignal, options?: CommitOptions): Promise<BuildArtifact[]>`；`DeploymentFile = { role: "deploy-asset" | "deploy-main"; path: string; remotePath: string; bytes: Uint8Array; sha256: string }`。
- Produces：只有測試與文件；不在正式 BUILTIN_FRONTENDS／BUILTIN_BACKENDS 註冊 toy，也不增加 build RPC 或 renderer 可傳路徑的介面。

- [ ] **Step 1: 加假編譯器的完整流程測試**

`compiler-chain.test.ts` 全文：

```ts
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import type { WebContents } from "electron";
import { expect, it, vi } from "vitest";
import { BuildSession, loadProject } from "@kobrixa/compiler";
import { PluginManager } from "@kobrixa/plugin-runtime";
import { BuildService } from "./build.js";
import type { BuildEvent } from "../../shared/api.js";
import {
  testBackend,
  testFrontend,
  TEST_BACKEND_DECL,
} from "../../../../../packages/compiler/src/test-build.js";
it("builds a test-only language and non-rbf target through resolution commit and deployment selection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kobrixa-chain-"));
  let service: BuildService | undefined;
  const source = (id: string, contributes: unknown) => ({
    kind: "builtin" as const,
    manifest: {
      id,
      version: "1.0.0",
      apiVersion: "^1.1.0",
      runtime: { kind: "builtin" },
      contributes,
    },
  });
  const manager = await PluginManager.create({
    safeMode: false,
    locale: "en",
    launcher: vi.fn(),
    sources: [
      source("test.toy", {
        frontends: [
          {
            language: "toy",
            entryExtensions: ["toy"],
            sourceExtensions: ["toy", "inc"],
            ir: { min: 1, max: 1 },
          },
        ],
      }),
      source("test.vm", { backends: [TEST_BACKEND_DECL] }),
    ],
    store: {
      load: async () => ({ disabled: new Set(), legacyDisabledIds: new Set() }),
      save: async () => {},
    },
  });
  try {
    await writeFile(path.join(root, "main.toy"), "disk");
    await writeFile(path.join(root, "lib.inc"), "library");
    await writeFile(path.join(root, "b.dat"), new Uint8Array([2]));
    await writeFile(path.join(root, "a.dat"), new Uint8Array([1]));
    await writeFile(
      path.join(root, "kobrixa.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "demo",
        language: "toy",
        target: "toy-vm",
        entry: "main.toy",
        outputDir: "build",
        assets: ["*.dat"],
      }),
    );
    const events: BuildEvent[] = [];
    service = new BuildService(
      {
        project: async (_id, overlays, resolve) => {
          const loaded = await loadProject(root, overlays, undefined, undefined, resolve);
          if (!loaded.project) throw new Error(JSON.stringify(loaded.diagnostics));
          return loaded.project;
        },
      },
      () =>
        ({
          isDestroyed: () => false,
          send: (_channel: string, event: BuildEvent) => events.push(event),
        }) as unknown as WebContents,
      (request) => {
        expect(request.compiler.frontend.pluginId).toBe("test.toy");
        expect(request.compiler.backend.pluginId).toBe("test.vm");
        expect(request.project.sources).toEqual([
          { path: "lib.inc", content: "library" },
          { path: "main.toy", content: "overlay" },
        ]);
        const emitter = new EventEmitter();
        const backend = testBackend();
        backend.compile = async () => ({
          diagnostics: [],
          artifacts: [
            { slot: "program", data: new Uint8Array([3]) },
            { slot: "notes", data: new TextEncoder().encode("notes") },
            { slot: "map", data: new TextEncoder().encode("{}") },
          ],
        });
        void new BuildSession(testFrontend, backend, undefined, undefined, request.buildId)
          .compile(request.project)
          .then((result) => {
            emitter.emit("message", { type: "complete", result });
            emitter.emit("exit", 0);
          })
          .catch((error: unknown) => emitter.emit("error", error));
        return Object.assign(emitter, { terminate: async () => 0 }) as unknown as Worker;
      },
      (language, target) => manager.resolveCompiler(language, target),
    );
    const id = await service.start("w", { "main.toy": "overlay" });
    await vi.waitFor(() => expect(events.some((event) => event.type === "complete")).toBe(true));
    const complete = events.find(
      (event): event is Extract<BuildEvent, { type: "complete" }> => event.type === "complete",
    )!;
    expect(complete.result).toMatchObject({
      buildId: id,
      target: "toy-vm",
      success: true,
      deploy: "ev3",
    });
    expect(complete.result.artifacts.filter((item) => item.role === "aux")).toHaveLength(3);
    const files = await service.deployableArtifacts(id);
    expect(files.map((file) => [file.role, file.remotePath, [...file.bytes]])).toEqual([
      ["deploy-asset", "a.dat", [1]],
      ["deploy-asset", "b.dat", [2]],
      ["deploy-main", "demo.bin", [3]],
    ]);
  } finally {
    service?.dispose();
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 加兩個真實程序的提交驗收**

`output-lock.process.test.ts` 全文：

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
const childSource = `
import { mkdir, rename, writeFile } from "node:fs/promises";
const { commitArtifacts } = await import(process.argv[1]);
const root = process.argv[2], label = process.argv[3], byte = Number(process.argv[4]);
const project = { root, manifest: { schemaVersion: 1, name: "demo", language: "toy", target: "toy-vm", entry: "main.toy", outputDir: "build", assets: [] }, sources: [], assets: [] };
await mkdir(root + "/build", { recursive: true });
const make = (relativePath, role, slot) => ({ relativePath, role, slot, kind: "test", mediaType: "application/octet-stream", data: new Uint8Array([byte]), ...(role === "deploy-asset" ? { remotePath: "a" } : {}) });
let first = true, firstRenameAt = 0, lastRenameAt = 0;
try {
  const artifacts = await commitArtifacts(project, label, [make("demo.bin", "deploy-main", "program"), make("assets/a", "deploy-asset", "asset"), make("demo.ir.json", "aux", "ir")], new AbortController().signal, { io: {
    write: (file, data) => writeFile(file, data),
    rename: async (from, to) => {
      if (first) { first = false; firstRenameAt = Date.now(); process.send({ type: "locked", label }); if (label === "a") await new Promise((resolve) => setTimeout(resolve, 250)); }
      await rename(from, to); lastRenameAt = Date.now();
    },
  } });
  process.send({ type: "done", label, count: artifacts.length, firstRenameAt, lastRenameAt });
} catch (error) { process.send({ type: "failed", message: String(error) }); process.exitCode = 1; }
process.disconnect();
`;
it("serializes commits from two real processes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kobrixa-process-lock-"));
  const children: ChildProcess[] = [];
  type Done = {
    type: "done";
    label: string;
    count: number;
    firstRenameAt: number;
    lastRenameAt: number;
  };
  function start(label: string, byte: number) {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        childSource,
        new URL("../dist/index.js", import.meta.url).href,
        root,
        label,
        String(byte),
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    children.push(child);
    let stderr = "";
    child.stderr!.on("data", (chunk) => {
      stderr += String(chunk);
    });
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const done = new Promise<Done>((resolve, reject) => {
      let value: Done | undefined;
      child.on("message", (message: unknown) => {
        const item = message as { type: string; message?: string };
        if (item.type === "locked") locked();
        else if (item.type === "done") value = message as Done;
        else reject(new Error(item.message));
      });
      child.once("error", reject);
      child.once("exit", (code) =>
        value && code === 0
          ? resolve(value)
          : reject(new Error(`Child ${label} exited ${code}: ${stderr}`)),
      );
    });
    return { acquired: Promise.race([acquired, done.then(() => undefined)]), done };
  }
  try {
    const a = start("a", 1);
    await a.acquired;
    const b = start("b", 2);
    const [first, second] = await Promise.all([a.done, b.done]);
    expect(first.count).toBe(3);
    expect(second.count).toBe(3);
    expect(second.firstRenameAt).toBeGreaterThanOrEqual(first.lastRenameAt);
    for (const file of ["demo.bin", "demo.ir.json", "assets/a"])
      expect(await readFile(path.join(root, "build", file))).toEqual(Buffer.from([2]));
    await expect(readFile(path.join(root, "build/.kobrixa-build.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    for (const child of children) child.kill();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
```

此測試使用已建置的 compiler dist，先執行 Step 3 的 build；它不是 fake timers 測試，也沒有以兩個 promise 冒充兩個程序。

- [ ] **Step 3: 執行完整接線測試並看到既有 fixture 的失敗**

Run: `pnpm --filter @kobrixa/compiler build && pnpm --filter @kobrixa/plugin-runtime build && pnpm --filter @kobrixa/desktop exec vitest run src/main/workspace/compiler-chain.test.ts src/main/workspace/integration.test.ts src/main/workspace/examples.test.ts && pnpm --filter @kobrixa/compiler exec vitest run src/output-lock.process.test.ts`
Expected: 新流程測試通過；舊 integration／examples 尚直接把 EV3Backend 當通用 CompilerBackend，會在 declaration／artifacts 缺失處失敗。下一步將 fixture 改成正式 adapter。

- [ ] **Step 4: 更新既有範例、打包與 smoke fixture**

integration.test.ts 與 examples.test.ts 都加入：

```ts
import { createBuiltinCompilers, resolveBuiltinCompiler } from "./builtin-compilers.js";
```

兩檔的 `new BuildSession(new BasicPlusFrontend(), new EV3Backend()).compile(...)` 整個運算式與 result 宣告改成以下完整區塊（examples 的迴圈內也使用這些區域變數）：

```ts
const selection = resolveBuiltinCompiler(
  loaded.project!.manifest.language,
  loaded.project!.manifest.target,
);
if (!selection.ok) throw new Error(selection.message);
const { frontend: buildFrontend, backend } = createBuiltinCompilers(selection);
const result = await new BuildSession(buildFrontend, backend).compile(loaded.project!);
```

兩檔從 backend-ev3 import 移除 EV3Backend、保留 inspectRbf；integration 移除 BasicPlusFrontend import，examples 保留它用於 IR 回歸。兩檔所有成品選主檔判斷換成 `artifact.role === "deploy-main"`，資源換成 `artifact.role === "deploy-asset"`。integration 的測試名稱改為 `builds Basic Plus into a verified committed main artifact`，不再稱整組檔案原子提交。

`tests/desktop/packaged-smoke.mjs` 的成品斷言換成：

```js
assert.equal(compiled.deploy, "ev3");
assert.ok(compiled.artifacts.some((artifact) => artifact.role === "deploy-main"));
```

`tests/desktop/smoke-main.mjs` 的 preview result 物件換成：

```js
result: {
  buildId, target: "ev3-native", deploy: "ev3", success: Boolean(ir), diagnostics,
  artifacts: ir ? [{ slot: "program", kind: "rbf", role: "deploy-main", mediaType: "application/octet-stream", path: "/tmp/preview.rbf", sha256: "smoke", byteLength: 1 }] : [],
},
```

background completeBuild 的 result 換成：

```js
result: {
  buildId: backgroundBuild.buildId, target: "ev3-native", deploy: "ev3", success: true, diagnostics: [],
  artifacts: [{ slot: "program", kind: "rbf", role: "deploy-main", mediaType: "application/octet-stream", path: "/tmp/build/program.rbf", sha256: "smoke", byteLength: 1 }],
},
```

smoke 的 sha256 為 renderer 專用 fixture，不拿它呼叫正式部署；驗 hash 使用 Task 7 的真實檔案測試。

`build.test.ts` 的 worker error／terminate 測試，在 `workers[0]!.emit(...)`／`await workers[0]!.terminate()` 前都加入：

```ts
await vi.waitFor(() => expect(workers).toHaveLength(1));
```

因為 start 現在先回 buildId，再從 FIFO 啟動 worker，不能同步假設 workers[0] 已存在。追加排隊取消測試：

```ts
it("cancels a queued build without starting its worker and releases the queue after failure", async () => {
  service.dispose();
  const created: EventEmitter[] = [];
  service = new BuildService(
    { project: async (_id, overlays) => (await loadProject(root, overlays, "main.bp")).project! },
    () =>
      ({
        isDestroyed: () => false,
        send: (_channel: string, event: BuildEvent) => events.push(event),
      }) as unknown as WebContents,
    () => {
      const emitter = new EventEmitter();
      created.push(emitter);
      return Object.assign(emitter, { terminate: async () => 0 }) as unknown as Worker;
    },
  );
  const first = await service.start("project", {});
  await vi.waitFor(() => expect(created).toHaveLength(1));
  const second = await service.start("project", {});
  service.cancel(second);
  expect(service.busy).toBe(true);
  created[0]!.emit("error", new Error("first failed"));
  expect(await result(first)).toMatchObject({ success: false, artifacts: [] });
  expect(await result(second)).toMatchObject({
    success: false,
    artifacts: [],
    diagnostics: [expect.objectContaining({ code: "BUILD0001" })],
  });
  expect(created).toHaveLength(1);
  const third = await service.start("project", {});
  await vi.waitFor(() => expect(created).toHaveLength(2));
  created[1]!.emit("error", new Error("third failed"));
  expect((await result(third)).success).toBe(false);
  expect(service.busy).toBe(false);
});
```

- [ ] **Step 5: 更新英文與繁中架構及插件文件的實際內容**

兩份 architecture 的 LanguageFrontend 範例都將 id 換成 `id: string;`。兩份 CompileResult／BuildArtifact 範例完整換成下列兩個 interface，Diagnostic interface 保留：

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

`docs/en/architecture.md` 的系統圖三行換成：

```text
          ├─ Workspace service → Resolved built-in frontend
          │                       → Typed KobrixaIR + validation
          │                       → Resolved backend → validated artifact set
```

原 `The built-in kobrixa.basic-plus ...` 整段換成以下英文（位於既有 Plugins development preview 節，保留原 anchor）：

```markdown
Plugin API **1.1.0** declares compiler frontends and backends. `kobrixa.basic-plus` provides language `bp`; the separate built-in `kobrixa.ev3` provides target `ev3-native`. Both declare IR version `{ min: 1, max: 1 }` and remain available in safe mode. Built-in plugins retain the phase 1 disable restrictions. Valid API 1.0 command plugins remain compatible, but external plugins declaring `frontends` or `backends` are invalid (`PLUGIN_E_FRONTEND_REQUIRES_BUILTIN` / `PLUGIN_E_BACKEND_REQUIRES_BUILTIN`). This release has no external compiler RPC.

The host resolves one enabled, valid provider for each language and target. Every conflicting provider is rejected with `PLUGIN_E_PROVIDER_CONFLICT`; no provider wins by load order. Recomputing a provider set excludes disabled providers and clears obsolete conflicts. The selected IR version is the maximum of the overlapping ranges. Missing/conflicting providers report `BUILD1001` before a worker starts; incompatible IR ranges report `BUILD1002`.

Frontend declarations supply entry and source extensions. Backend declarations supply artifact slots, kinds, media types, extensions, roles and required flags; the backend returns only slot/bytes. The host owns `ir` and `asset` slots and produces resource artifacts. A deployable backend must declare exactly one required, non-empty `deploy-main`. Compiler contributions are limited to 8 frontends and 8 backends per plugin and 16 artifact declarations per backend. IDs use `/^[a-z][a-z0-9-]{0,31}$/`; extensions use `/^[a-z0-9]{1,16}$/`. The committed JSON Schema describes structural validation; the host additionally validates extension subsets, IR ranges, unique slots and the main-artifact relationship.

`Diagnostic.source`, language analysis providers and static language contributions remain planned for 2B/2C; the `devices` API remains planned for phase 3. See the [plugin design](../superpowers/specs/2026-10-14-plugin-system-design.md).
```

其原 `Line and column numbers ... committed atomically` 段落換成：

```markdown
Line and column numbers are one-based. A successful build has no error diagnostics, contains every required artifact and, when deployable, exactly one non-empty main. A successful non-deployable build remains successful; Run and Upload explain why it cannot deploy. Failed or cancelled results contain no artifacts. `BUILD1003` reports undeclared, duplicate, missing, unsafe, colliding or oversized artifacts.

`compileToMemory` is shared by BuildSession and simulation. It runs the frontend, checks the actual IR version and IR validity, runs the backend and validates artifacts without writing outputs. Simulation still requires backend success and supports at most 4 entries and 64 resource files totaling 1 MiB; it uses captured sources/resources and the simulator's actual IR support, not a backend simulation capability.

Build limits are 64 backend artifacts, 1024 artifacts including resources, 64 MiB per artifact, 256 MiB total, 128 UTF-8 bytes per filename and 512 UTF-8 bytes per relative path. Names are checked after Unicode NFC normalization and lowercasing; `.kobrixa*` names are reserved. Resource traversal and symbolic links are rejected. Sizes are accumulated while reading/writing and hashes come from the actual staging contents.

Outputs remain at `outputDir/<name>.<extension>` and `outputDir/assets/<relative-path>`, including the existing `<name>.rbf`, `<name>.ir.json` and `<name>.lst` paths. The host validates all staging files under `.kobrixa-<buildId>.tmp` before replacing final files in aux → deploy-asset → deploy-main order. Cancellation before the first rename reports `BUILD0001`; once renaming starts the sequence finishes. An I/O failure reports `BUILD9000` with an empty artifact list; the disk may contain mixed generations. This is not a multi-file atomic transaction.

Within one process, builds use FIFO queues keyed by `realpath(outputDir)`. During commit, `.kobrixa-build.lock` is opened with `wx` and contains `{ pid, startedAt }`. A nonexistent PID, or malformed contents older than 60 seconds, can be reclaimed. A live lock is polled every 100 ms for at most 5 seconds, then `BUILD1004` is returned. Release compares ownership and removes only the caller's lock. PID checks do not guarantee correctness between different computers sharing a network disk.

Deployment requires a supported `deploy` capability (`ev3` today), otherwise `BUILD1005`. Every selected file is read into memory and checked against its SHA-256 before any upload; missing or changed files report `BUILD1006`. Resources are sorted by remotePath and uploaded before the main, using those same verified bytes. Folder/runtimeDirectory, the device lock and skipping unchanged resources are preserved. Device transfers themselves are not atomic.
```

`docs/zh-TW/architecture.md` 的系統圖三行換成：

```text
          ├─ 工作區服務 → 已解析的內建語言前端
          │              → 具型別 KobrixaIR + 驗證
          │              → 已解析的後端 → 經驗證的成品組
```

原 `內建插件 kobrixa.basic-plus ...` 整段換成以下繁中：

```markdown
插件 API **1.1.0** 可宣告編譯前端與後端。`kobrixa.basic-plus` 提供語言 `bp`，獨立的內建插件 `kobrixa.ev3` 提供目標 `ev3-native`；兩者都宣告 IR `{ min: 1, max: 1 }`，安全模式下仍保留，並沿用第一階段的內建停用限制。有效的 API 1.0 命令插件仍相容，但外部插件宣告 `frontends` 或 `backends` 時，整個插件無效（`PLUGIN_E_FRONTEND_REQUIRES_BUILTIN`／`PLUGIN_E_BACKEND_REQUIRES_BUILTIN`）。本版沒有外部編譯 RPC。

宿主為每個語言／目標解析唯一、有效且已啟用的提供者。衝突的提供者全部以 `PLUGIN_E_PROVIDER_CONFLICT` 失效，不依載入順序取首筆；重新檢查提供者集合時排除停用者，清除已消失的衝突。IR 版本選前後端範圍交集的最大值。找不到提供者或發生衝突時，在開 worker 前回 `BUILD1001`；IR 不相容回 `BUILD1002`。

前端宣告入口與來源副檔名；後端宣告成品 slot、kind、mediaType、副檔名、role 與 required，實際只回傳 slot／bytes。宿主保留 `ir`、`asset` slot，並負責產生資源成品。可部署後端必須宣告唯一、必填且非空的 `deploy-main`。每個插件最多 8 個前端、8 個後端，每個後端最多 16 個成品宣告；ID 格式為 `/^[a-z][a-z0-9-]{0,31}$/`，副檔名為 `/^[a-z0-9]{1,16}$/`。提交的 JSON Schema 驗證結構，宿主另外檢查副檔名子集、IR 閉區間、slot 唯一性與主檔關聯。

`Diagnostic.source`、語言分析提供者與靜態語言貢獻仍屬 2B／2C；`devices` API 仍規劃於第三階段。詳見[插件設計](../superpowers/specs/2026-10-14-plugin-system-design.md)。
```

原 `公共結果的行、列 ... 原子提交` 段落換成：

```markdown
公共結果的行、列從 1 起算。成功建置必須沒有 error 診斷、包含全部 required 成品；若可部署，還須有唯一且非空的主檔。成功但不可部署仍是建置成功，執行／上傳按鈕會說明原因。失敗或取消的成品清單一律為空。未宣告、重複、缺少必要成品、路徑不安全、名稱碰撞或超過上限，皆回 `BUILD1003`。

BuildSession 與模擬共用 `compileToMemory`：執行前端、檢查實際 IR 版本與 IR 有效性、執行後端、驗證成品，過程不寫輸出。模擬仍要求後端成功，保留最多 4 個入口、64 個資源／1 MiB 的限制，使用來源及資源快照；是否能模擬依實際 IR 與模擬器支援判斷，不增加後端模擬能力宣告。

建置上限為後端成品 64 個、含資源成品 1024 個、單一成品 64 MiB、總量 256 MiB、檔名 128 UTF-8 bytes、相對路徑 512 UTF-8 bytes。名稱先做 Unicode NFC 正規化再轉小寫檢查碰撞，`.kobrixa*` 為保留名稱；資源不得越界或經過符號連結。讀寫時累計大小，hash 取自 staging 的實際內容。

輸出仍位於 `outputDir/<名稱>.<extension>` 與 `outputDir/assets/<相對路徑>`，既有 `<名稱>.rbf`、`<名稱>.ir.json`、`<名稱>.lst` 位置不變。宿主在 `.kobrixa-<buildId>.tmp` 完成全部 staging 驗證後，才依 aux → deploy-asset → deploy-main 替換最終檔案。第一次 rename 前取消回 `BUILD0001`；開始 rename 後完成整段提交。I/O 失敗回 `BUILD9000`、成品清單為空，磁碟可能留下新舊混合的檔案；這不是多檔案原子交易。

同一程序依 `realpath(outputDir)` FIFO 排隊。提交期間以 `wx` 建立 `.kobrixa-build.lock`，內容為 `{ pid, startedAt }`。pid 不存在，或內容無法解析且檔案超過 60 秒，才回收殘留鎖；活鎖每 100 ms 輪詢，最多 5 秒後回 `BUILD1004`。釋放時比對所有權，只刪自己的鎖。不同電腦共用網路磁碟時，pid 判斷不保證正確。

部署要求設備支援的 `deploy`（目前為 `ev3`），否則回 `BUILD1005`。先把全部待部署檔案讀進記憶體並驗 SHA-256，再開始任何上傳；檔案遺失或變更回 `BUILD1006`。資源依 remotePath 排序、主檔最後，傳送的就是驗過的同一批 bytes。Folder／runtimeDirectory、設備鎖與略過未變資源的行為保留；設備傳輸本身仍非原子操作。
```

`plugins/samples/README.md` 英文 safe mode 段落的 `Built-in Basic Plus stays enabled.` 改為 `Built-in Basic Plus and EV3 remain enabled.`；繁中對應句改為 `內建 Basic Plus 與 EV3 保持啟用。`。在各語系現有 SDK／architecture 連結段落後分別加入：

```markdown
These samples remain API 1.0-compatible command plugins. Kobrixa's current plugin API is 1.1.0; compiler declarations are reserved for built-ins. Adding `frontends` or `backends` to an external manifest makes the entire plugin invalid. Build outputs stay in the project's configured outputDir; changing or deleting them before deployment requires a new build. See [compiler and artifact contracts](../../docs/en/architecture.md#compiler-contracts).
```

```markdown
這些範例仍是相容 API 1.0 的命令插件。Kobrixa 目前的插件 API 為 1.1.0，編譯器宣告只限內建插件；在外部 manifest 加入 `frontends` 或 `backends` 會讓整個插件無效。建置成品仍在專案設定的 outputDir；部署前修改或刪除成品後，必須重新建置。詳見[編譯器與成品契約](../../docs/zh-TW/architecture.md#編譯器契約)。
```

- [ ] **Step 6: 跑針對性的整合驗收與格式化**

```bash
pnpm build:core
pnpm --filter @kobrixa/plugin-runtime build
pnpm --filter @kobrixa/compiler exec vitest run
pnpm --filter @kobrixa/desktop exec vitest run src/main/workspace/build.test.ts src/main/workspace/compiler-chain.test.ts src/main/workspace/integration.test.ts src/main/workspace/examples.test.ts src/main/device/deployment-snapshot.test.ts
pnpm exec prettier --write apps/desktop/src/main/workspace/compiler-chain.test.ts packages/compiler/src/output-lock.process.test.ts apps/desktop/src/main/workspace/build.test.ts apps/desktop/src/main/workspace/integration.test.ts apps/desktop/src/main/workspace/examples.test.ts tests/desktop/packaged-smoke.mjs tests/desktop/smoke-main.mjs docs/en/architecture.md docs/zh-TW/architecture.md plugins/samples/README.md
pnpm exec prettier --check apps/desktop/src/main/workspace/compiler-chain.test.ts packages/compiler/src/output-lock.process.test.ts apps/desktop/src/main/workspace/build.test.ts apps/desktop/src/main/workspace/integration.test.ts apps/desktop/src/main/workspace/examples.test.ts tests/desktop/packaged-smoke.mjs tests/desktop/smoke-main.mjs docs/en/architecture.md docs/zh-TW/architecture.md plugins/samples/README.md
pnpm exec eslint apps/desktop/src/main/workspace/compiler-chain.test.ts packages/compiler/src/output-lock.process.test.ts apps/desktop/src/main/workspace/build.test.ts apps/desktop/src/main/workspace/integration.test.ts apps/desktop/src/main/workspace/examples.test.ts tests/desktop/packaged-smoke.mjs tests/desktop/smoke-main.mjs
```

Expected: PASS。打包 worker 由 build.test.ts 的 beforeAll 以 esbuild 產生 `.cjs` 後啟動真正 Worker，不能用只有 TS import 的測試替代。

- [ ] **Step 7: 全套回歸與移除舊契約檢查**

```bash
pnpm check
pnpm test
pnpm test:bytecode
pnpm test:python-sdk
pnpm test:plugins:smoke
rg -n 'kind === "rbf"|frontendFor|builtin-frontends' apps packages frontends tests --glob '*.{ts,tsx,mjs}'
git diff --check
```

Expected: 前五個命令全數 PASS；`pnpm test` 本身也會跑 bytecode，但仍單獨保留要求的 `pnpm test:bytecode` 驗收。`rg` 預期零筆（exit 1 是零筆，不是測試失敗）；motor-test 的設備 helper `.rbf` 檔名保留，不是通用成品判斷。`git diff --check` 無輸出。

**環境：** `pnpm test:plugins:smoke` 需要能啟動 Electron 的環境及 Python 3.10+；若執行環境禁止啟動 Electron，記錄為未執行，交給具備該環境的 CI／本機完成，不將 skip 記成 PASS。正式封裝驗收另外執行 `pnpm build:desktop && pnpm test:desktop:packaged`（需對應平台的 Electron／封裝工具）；這與不需要 UI 的 bundled-worker 單元測試分開記錄。

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/main/workspace/compiler-chain.test.ts packages/compiler/src/output-lock.process.test.ts apps/desktop/src/main/workspace/build.test.ts apps/desktop/src/main/workspace/integration.test.ts apps/desktop/src/main/workspace/examples.test.ts tests/desktop/packaged-smoke.mjs tests/desktop/smoke-main.mjs docs/en/architecture.md docs/zh-TW/architecture.md plugins/samples/README.md
git commit -m "test(build): cover compiler plugins races and artifact deployment contracts" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

---

## Spec 對照與交付檢查

| Spec                            | 對應 task 與驗收                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| §1 範圍／既有行為               | Global Constraints；Task 8 範例、Folder、bytecode 與雙語文件                                                  |
| §2 Manifest／API／兩 SDK        | Task 1 schema、語意檢查、export-schema.mjs、SDK initialize／conformance；Task 2 外部拒絕；Task 3 EV3 內建來源 |
| §3 提供者解析                   | Task 2 全體衝突／停用集合恢復／交集最大值；Task 5 manifest 字串；Task 6 不啟動 worker                         |
| §4 adapter／共用編譯／來源      | Task 3 工廠／EV3Result；Task 5 sourceExtensions、overlay、compileToMemory、模擬；Task 6 快照 worker           |
| §5 成品契約／每條驗證／每個上限 | Task 3 型別；Task 4 slot／名稱／路徑／六組邊界；Task 5 後端失敗門檻                                           |
| §6 staging／FIFO／鎖／取消      | Task 6 寫入與 rename 注入、最後取消點、殘留與活鎖、同路徑別名；Task 8 雙程序提交與排隊取消                    |
| §7 部署／renderer／模擬         | Task 7 整批 hash、同 bytes、role、Folder、不可部署成功與雙語 UI；Task 5 模擬實際 IR 門檻                      |
| §8 診斷                         | Task 3 BUILD1001–1006 雙語 help／官方網址；Task 5/6 BUILD0001、IR／EV39000／BUILD9000 回歸                    |
| §9 測試／回歸                   | Task 1–7 單元與邊界；Task 8 假插件完整路徑、真雙程序、全套與 Electron smoke                                   |
| §10 八項切分                    | Task 1–3 對應原 1–3；Task 4 提前原 5 的驗證；Task 5 對應原 4；Task 6–8 對應原 6–8                             |

## Spec 需釐清的文字（已於 2026-10-16 補進 spec）

1. §3「停用其中一個後恢復」與 §2「日後也能分開停用」、§3「停用沿用 1a／1b」有交界：1b 目前拒絕停用內建插件，而 2A 又只接受內建編譯器。本計畫保留目前產品限制，並以測試註冊集合驗證停用後重新解析；若驗收要求一般使用者現在就能停用內建編譯器，應明確追加設定／持久化／安全模式的設計，不能在 resolver 中暗開後門。
2. §5「不碰 outputDir」與 §6「staging 位於 outputDir 內」應區分最終成品與暫存工作目錄。本計畫在驗證失敗前不改最終成品；FIFO 為 realpath 建立空目錄，staging／lock 可暫時存在。若要求連目錄本身也完全不建立，需要另外決定不存在 outputDir 的 canonical key 與 staging 位置。
3. slot「ir／asset 保留給宿主」在 manifest 條件中沒有明寫拒絕規則。本計畫於語意檢查與成品驗證都拒絕後端宣告這兩個 slot，避免後端冒充宿主成品。

4. §6 的殘留鎖刪除是「比對內容後 unlink」，不是原子的 compare-and-delete。兩個程序若同時回收同一殘留鎖，極端排程下仍可能在檢查後刪到剛建立的新鎖；一般活鎖互斥與正常釋放不會碰到此路徑。本計畫忠實保留已核准演算法，雙程序驗收涵蓋活鎖等待；若要保證並行殘留回收也完全互斥，spec 應先指定跨平台的回收協調／作業系統鎖策略，再加入雙程序殘留回收驗收，不能將內容比對描述成原子保證。

## 本次計畫自我檢查

- spec §1–10 已逐節對照上表；Review Focus 五項均有同名測試與完整測試碼。
- 修正 Vitest it.each 對陣列資料列的展開方式，改用物件列，確實傳入整組 artifacts。
- 修正設備 transport mock 的具體回傳型別、workspace 既有 ProjectManifest 重複匯入與不可部署 BuildVersion 的 path 型別。
- 修正提交失敗測試，改為對 BuildSession 的第二次 rename 注入失敗，實際斷言 BUILD9000 與空成品。
- 修正 worker 啟動改為排隊後的測試時序，並讓 main 的 admission 保持 start 呼叫順序；provider 解析失敗也保留讀到的 target。
- 修正後端成品複製前的總量累計，超過 256 MiB 時先拒絕，避免宿主先複製超量 bytes。
- 修正模擬重讀資源的風險：assetSnapshots 只由主程序提供，compileToMemory 使用快照 bytes。
- 確認 schema exporter、JS SDK package 名稱 @kobrixa/plugin-sdk、Python unittest runner 與兩份 architecture 的實際位置；不新增重複產物流程。
- 檢查完整 TypeScript 程式碼區塊的語法，並以記憶體內的 TypeScript compiler host 檢查主要新模組與已套用的介面替換；這是計畫程式碼的靜態檢查，不冒稱已執行本文件的實作／回歸測試。
