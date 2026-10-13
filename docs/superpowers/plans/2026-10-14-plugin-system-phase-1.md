# 插件系統第一階段實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal：** 建立插件系統的基礎：以 Zod 撰寫、輸出 JSON Schema 的協定套件，與 Electron 無關的插件宿主，JS／TS 與 Python（僅開發模式）兩套 SDK，最小的命令與通知 API，設定頁中的插件面板，以及插件化的 Basic Plus 編譯入口。

**Architecture：** `@kobrixa/plugin-protocol` 定義 manifest、JSON-RPC 2.0 訊息、各方法的參數與結果、`Content-Length` 分幀和雙向的 `RpcPeer`；JSON Schema 由 Zod 產生並提交到 repo，另以共用的有效／無效案例驗證 TS 與 Python 行為一致。`@kobrixa/plugin-runtime` 負責讀取 manifest、在註冊任何貢獻前判斷停用、管理插件程序的生命週期（握手、取消、逾時、當機與有限重啟），不依賴 Electron。桌面端只提供兩種啟動器（`utilityProcess`＋MessagePort、Python 子程序＋stdio）、IPC、preload 與設定頁面板；Basic Plus 透過內建插件 manifest 註冊為 `bp` 前端，建置 worker 依插件 ID 選擇實作。

**Tech Stack：** TypeScript 6、Zod 4.6、Vitest 5、Electron 44（`utilityProcess`、`MessageChannelMain`）、React 19、Python 3.10+（僅標準函式庫）、esbuild（測試與 smoke 打包）。

**Spec：** [`docs/superpowers/specs/2026-10-14-plugin-system-design.md`](../specs/2026-10-14-plugin-system-design.md)（協商紀錄：[`2026-10-14-plugin-system-negotiation.md`](../specs/2026-10-14-plugin-system-negotiation.md)）

## Global Constraints

- Node.js 24 以上、pnpm 10.15.0（`package.json` 已釘選）；Python 3.10 以上，Python SDK 只用標準函式庫。
- 公開 API 三層：JSON-RPC 2.0、Zod 定義與產出的 JSON Schema、語言 SDK（設計 §4.1）。
- Wire schema 不得使用無法匯出的 `transform`、隱含 coercion 或未公開的自訂 refinement；匯出遇到無法表示的型別必須失敗，不得放寬為 `{}`／`any`（設計 §4.1）。
- CI 重新產生 JSON Schema 並與已提交版本比較；另以共用的有效／無效訊息案例驗證跨語言行為（設計 §4.1）。
- JS／TS 插件跑在 Electron `utilityProcess`，以 MessagePort 傳 JSON-RPC 訊息，不使用 stdin（設計 §4.2）。
- stdio 協定使用 `Content-Length` 訊息邊界，stdout 只輸出協定訊息，stderr 用於日誌（設計 §4.2）。
- 功能參數、工作區上下文與授權能力經握手與 API 傳遞，不以環境變數、程序 ID 或工作目錄作為 API 語意（設計 §4.2）。
- Python 只支援開發目錄載入，使用開發者明確指定的本機 runtime；不下載 runtime，也不做正式套件（設計 §4.2、§7）。
- 呼叫者身分由宿主綁定的通道判定，不能信任訊息自行宣告的插件 ID（設計 §5.2）。
- 取消是協定要求；超過寬限期仍未回應時，由宿主終止程序（設計 §5.2）。
- 當機後可以有限次重啟，但不得自動重播任何操作（設計 §8.1）。
- 第一階段要保留宿主可信身分，以及「載入任何貢獻之前的停用判斷」（設計 §12）。
- v1 是「可信任的本機插件」：介面不得把 API 權限清單描述成沙箱（設計 §8.2）。
- 前三階段第三方插件只限開發模式（設計 §9）。
- `compiler`、`device` 與新的 `plugin-protocol`／`plugin-runtime` 都不得依賴 Electron（設計 §2）。
- Basic Plus 第一階段只做最小轉接，沿用既有的 EV3 後端與建置行為；通用成品契約留到第二階段（設計 §11）。
- 公開契約變更時，同步更新英文與繁體中文的 architecture 與 roadmap（設計 §12）。
- 每次 commit 前，對本次改動的檔案執行 `pnpm exec prettier --write <檔案>`（產生的 schema 檔已列入 `.prettierignore`），並確認 `pnpm format:check` 通過。
- 測試資料夾、tsconfig 與 Vitest 設定都照抄 `packages/collab-protocol` 的寫法；套件之間的依賴要在 tsconfig 寫 `references`，寫法參考 `packages/compiler/tsconfig.json` 對 `../ir` 的引用。

**不在第一階段範圍（不要實作）：** 語言靜態貢獻與 tokenizer 上限、`diagnosticHelp`、`Diagnostic.source`、`devices`／`workspace`／`editor` API、宣告式 view 與 webview、`.kbxp` 打包、管理 runtime、WASM。

**與設計的一處差異（需使用者確認）：** 設計 §4.1 說其他語言 SDK「從公開 schema 產生型別與驗證程式」。本計畫的 Python SDK 直接用提交到 repo 的 JSON Schema 驗證訊息（task 11 的 `_schema.py`），但不產生 Python 型別，SDK 對外使用一般 `dict`。型別產生留到第四階段補其他 SDK 時再做。

## Review Focus

1. **Python 插件用 `print()` 除錯**：使用者預期訊息出現在日誌，插件繼續運作。Python SDK 會把 `print` 改導到 stderr（task 11）；其他語言的插件若把非協定資料寫到 stdout，宿主停止該插件並顯示 `PLUGIN_E_PROTOCOL`，工作台不受影響（task 7）。
2. **插件資料夾路徑含空格或中文**（例如 Windows 使用者名稱是中文）：使用者預期可以正常載入與執行（task 6、task 11）。
3. **命令處理器卡住、不理會取消**：使用者預期逾時後插件被終止，下一次執行命令時重新啟動（task 8）。
4. **插件還在啟動時連續點同一個命令**：使用者預期只啟動一個程序，兩次執行都會完成（task 8）。
5. **關閉 Kobrixa 時插件仍在執行**：使用者預期不留下孤兒程序（task 9 的 `dispose`、task 11 讀到 stdin EOF 就結束）。

---

## 檔案結構

```text
packages/plugin-protocol/            @kobrixa/plugin-protocol（只依賴 zod）
  src/limits.ts                      API 版本、大小與數量上限
  src/common.ts                      共用 id、文字、權限、locale schema
  src/manifest.ts                    kobrixa-plugin.json schema
  src/rpc.ts                         JSON-RPC 2.0 信封
  src/errors.ts                      JSON-RPC 錯誤碼
  src/methods.ts                     每個方法的參數／結果 schema
  src/framing.ts                     Content-Length 編碼與解碼
  src/peer.ts                        雙向 RpcPeer（請求、通知、取消、逾時）
  src/memory-channel.ts              測試用的記憶體通道
  src/json-schema.ts                 由 Zod 產生 JSON Schema
  scripts/export-schema.mjs          寫出已提交的 schema 檔
  schema/plugin-protocol.schema.json 產物，提交到 repo（prettier 忽略）
  schema/keywords.json               兩種驗證器都支援的 JSON Schema 關鍵字
  conformance/cases.json             TS 與 Python 共用的有效／無效案例
packages/plugin-runtime/             @kobrixa/plugin-runtime（不依賴 Electron）
  src/errors.ts                      PLUGIN_E_* 錯誤碼與 PluginError
  src/registry.ts                    讀取 manifest、語意規則、停用判斷
  src/process.ts                     PluginProcess、stdio 程序、輸出尾端
  src/supervisor.ts                  單一插件程序的生命週期
  src/manager.ts                     多插件組合、命令路由、啟停、事件
  src/test-python.ts                 測試用：尋找 Python 3.10+
packages/plugin-sdk-js/              @kobrixa/plugin-sdk
  src/index.ts                       definePlugin、runPlugin、parentPort 通道
sdks/python/                         kobrixa-plugin-sdk（Python，開發模式）
  kobrixa/_framing.py  _schema.py  _plugin.py  plugin-protocol.schema.json
  tests/
plugins/basic-plus/kobrixa-plugin.json   內建 Basic Plus 前端 manifest
plugins/samples/hello-ts/                TS 範例插件
plugins/samples/hello-python/            Python 範例插件
apps/desktop/src/main/plugins/           options、state-store、launchers、builtin、ipc
apps/desktop/src/shared/plugins.ts       跨程序型別與 PluginsApi
apps/desktop/src/renderer/settings/plugins-panel.tsx、plugin-copy.ts
apps/desktop/src/main/workspace/builtin-frontends.ts
tests/desktop/run-plugins-smoke.mjs、plugins-smoke-main.ts、fixtures/crash-plugin.ts
tools/run-python-tests.mjs
```

---

### Task 1: 建立 `@kobrixa/plugin-protocol` 與 manifest schema

**Files:**

- Create: `packages/plugin-protocol/package.json`、`tsconfig.json`、`vitest.config.ts`
- Create: `packages/plugin-protocol/src/limits.ts`、`src/common.ts`、`src/manifest.ts`、`src/index.ts`
- Test: `packages/plugin-protocol/src/manifest.test.ts`
- Modify: `tsconfig.base.json`（`paths`）

**Interfaces:**

- Produces: `PLUGIN_API_VERSION`、`PLUGIN_LIMITS`、`namespacedIdSchema`、`semverSchema`、`pluginLocaleSchema`／`PluginLocale`、`permissionSchema`／`Permission`、`localizedTextSchema`／`LocalizedText`、`pluginManifestSchema`／`PluginManifest`

- [ ] **Step 1: 建立套件骨架**

`packages/plugin-protocol/package.json`：

```json
{
  "name": "@kobrixa/plugin-protocol",
  "version": "1.0.1-beta.1",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": "./dist/index.js",
  "files": ["dist", "schema"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "check": "tsc -b tsconfig.json",
    "test": "vitest run",
    "schema": "tsc -p tsconfig.json && node scripts/export-schema.mjs"
  },
  "dependencies": {
    "zod": "^4.6.5"
  }
}
```

`tsconfig.json` 與 `vitest.config.ts` 直接照抄 `packages/collab-protocol/` 的同名檔案。在 `tsconfig.base.json` 的 `paths` 加入：

```json
"@kobrixa/plugin-protocol": ["./packages/plugin-protocol/src/index.ts"],
"@kobrixa/plugin-runtime": ["./packages/plugin-runtime/src/index.ts"],
"@kobrixa/plugin-sdk": ["./packages/plugin-sdk-js/src/index.ts"]
```

執行 `pnpm install`，讓 workspace 連結新套件並更新 `pnpm-lock.yaml`。

- [ ] **Step 2: 寫會失敗的測試**

`packages/plugin-protocol/src/manifest.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { pluginManifestSchema } from "./index.js";

const valid = {
  id: "acme.line-count",
  version: "1.0.0",
  apiVersion: "^1.0.0",
  displayName: { en: "Line count", "zh-TW": "行數統計" },
  runtime: { kind: "python", entry: "main.py" },
  activationEvents: ["onCommand:acme.line-count.run"],
  permissions: ["ui.notifications"],
  contributes: { commands: [{ id: "acme.line-count.run", title: "Count lines" }] },
};
const accepts = (value: unknown) => pluginManifestSchema.safeParse(value).success;

describe("plugin manifest", () => {
  it("accepts a complete manifest and unknown forward-compatible fields", () => {
    expect(accepts(valid)).toBe(true);
    expect(accepts({ ...valid, "x-future": true })).toBe(true);
    expect(accepts({ ...valid, contributes: { ...valid.contributes, views: [] } })).toBe(true);
  });
  it("rejects entries that leave the plugin folder", () => {
    for (const entry of ["../escape.py", "/abs.py", "dir/../x.py", ".hidden/x.py", "a\\b.py", ""])
      expect(accepts({ ...valid, runtime: { kind: "python", entry } }), entry).toBe(false);
  });
  it("requires lowercase namespaced ids without trailing newlines", () => {
    for (const id of ["Acme.plugin", "acme", "acme.plugin\n", "acme..plugin", "acme.-x"])
      expect(accepts({ ...valid, id }), JSON.stringify(id)).toBe(false);
  });
  it("rejects control characters in titles and unknown permissions", () => {
    expect(
      accepts({
        ...valid,
        contributes: { commands: [{ id: "acme.line-count.run", title: "a\u0007" }] },
      }),
    ).toBe(false);
    expect(accepts({ ...valid, permissions: ["fs.write"] })).toBe(false);
  });
  it("bounds the number of commands", () => {
    const commands = Array.from({ length: 65 }, (_, index) => ({
      id: `acme.line-count.c${index}`,
      title: "x",
    }));
    expect(accepts({ ...valid, contributes: { commands } })).toBe(false);
  });
});
```

- [ ] **Step 3: 執行測試，確認失敗**

Run: `pnpm vitest run --project @kobrixa/plugin-protocol`
Expected: FAIL，錯誤為找不到 `./index.js` 匯出的 `pluginManifestSchema`。若 Vitest 回報找不到 project，在 `vitest.config.ts` 加上 `name: "@kobrixa/plugin-protocol"`。

- [ ] **Step 4: 實作**

`src/limits.ts`：

```ts
export const PLUGIN_API_VERSION = "1.0.0";
export const PLUGIN_LIMITS = {
  messageBytes: 1024 * 1024,
  headerBytes: 1024,
  idLength: 128,
  textLength: 200,
  messageLength: 2000,
  errorMessageLength: 2000,
  commandsPerPlugin: 64,
  activationEvents: 64,
  manifestBytes: 64 * 1024,
} as const;
```

`src/common.ts`：

```ts
import { z } from "zod";
import { PLUGIN_LIMITS } from "./limits.js";

// Wire schemas stay exportable to JSON Schema: no transform, coercion or custom refinement.
// Patterns avoid \d, \w, \s and \b so ECMAScript and Python regular expressions agree.
// eslint-disable-next-line no-control-regex -- the pattern rejects control characters.
export const SINGLE_LINE = /^[^\u0000-\u001F\u007F]*$/;
// eslint-disable-next-line no-control-regex -- allows tab and newline, rejects other controls.
export const MULTI_LINE = /^[^\u0000-\u0008\u000B-\u001F\u007F]*$/;

export const namespacedIdSchema = z
  .string()
  .min(3)
  .max(PLUGIN_LIMITS.idLength)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/);
export const semverSchema = z
  .string()
  .max(64)
  .regex(
    /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  );
export const pluginLocaleSchema = z.enum(["en", "zh-TW"]);
export type PluginLocale = z.infer<typeof pluginLocaleSchema>;
export const permissionSchema = z.enum(["ui.notifications"]);
export type Permission = z.infer<typeof permissionSchema>;
const text = z.string().min(1).max(PLUGIN_LIMITS.textLength).regex(SINGLE_LINE);
export const localizedTextSchema = z.union([
  text,
  z.looseObject({ en: text, "zh-TW": text.optional() }),
]);
export type LocalizedText = z.infer<typeof localizedTextSchema>;
```

`src/manifest.ts`：

```ts
import { z } from "zod";
import { PLUGIN_LIMITS } from "./limits.js";
import {
  localizedTextSchema,
  namespacedIdSchema,
  permissionSchema,
  semverSchema,
} from "./common.js";

// Segments cannot start with "." so "..", hidden folders and absolute paths are rejected.
const relativePath = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/);
const runtimeSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("builtin") }),
  z.looseObject({ kind: z.literal("node"), entry: relativePath }),
  z.looseObject({ kind: z.literal("python"), entry: relativePath }),
]);

/** Unknown fields are allowed for forward compatibility; invalid known fields are errors. */
export const pluginManifestSchema = z.looseObject({
  id: namespacedIdSchema,
  version: semverSchema,
  apiVersion: z
    .string()
    .max(64)
    .regex(/^[\^~]?(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/),
  displayName: localizedTextSchema.optional(),
  runtime: runtimeSchema,
  activationEvents: z
    .array(
      z
        .string()
        .max(160)
        .regex(/^onCommand:[a-z0-9.-]+$/),
    )
    .max(PLUGIN_LIMITS.activationEvents)
    .optional(),
  permissions: z.array(permissionSchema).max(16).optional(),
  contributes: z
    .looseObject({
      commands: z
        .array(z.looseObject({ id: namespacedIdSchema, title: localizedTextSchema }))
        .max(PLUGIN_LIMITS.commandsPerPlugin)
        .optional(),
      frontends: z
        .array(z.looseObject({ language: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/) }))
        .max(8)
        .optional(),
    })
    .optional(),
});
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
```

`src/index.ts`：

```ts
export * from "./limits.js";
export * from "./common.js";
export * from "./manifest.js";
```

- [ ] **Step 5: 執行測試，確認通過**

Run: `pnpm vitest run --project @kobrixa/plugin-protocol && pnpm --filter @kobrixa/plugin-protocol check`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/plugin-protocol tsconfig.base.json pnpm-lock.yaml
git commit -m "feat(plugin-protocol): add package and manifest schema"
```

---

### Task 2: JSON-RPC 信封、錯誤碼與方法 schema

**Files:**

- Create: `packages/plugin-protocol/src/rpc.ts`、`src/errors.ts`、`src/methods.ts`
- Modify: `packages/plugin-protocol/src/index.ts`
- Test: `packages/plugin-protocol/src/rpc.test.ts`

**Interfaces:**

- Consumes: task 1 的 `namespacedIdSchema`、`semverSchema`、`pluginLocaleSchema`、`permissionSchema`、`MULTI_LINE`、`PLUGIN_LIMITS`
- Produces: `jsonRpcIdSchema`／`JsonRpcId`、`jsonRpcMessageSchema`／`JsonRpcMessage`、`RPC_ERRORS`、`severitySchema`／`Severity`、`requestMethods`、`notificationMethods`、`RequestMethod`、`NotificationMethod`、`ParamsOf<M>`、`ResultOf<M>`、`NotificationParamsOf<M>`

方法清單（方向：H = 宿主，P = 插件）：

| 方法              | 類型         | 方向 | params                                               | result                             |
| ----------------- | ------------ | ---- | ---------------------------------------------------- | ---------------------------------- |
| `initialize`      | request      | H→P  | `{apiVersion, pluginId, locale, grantedPermissions}` | `{apiVersion, sdk:{name,version}}` |
| `command/execute` | request      | H→P  | `{command}`                                          | `null`                             |
| `shutdown`        | request      | H→P  | `{}`                                                 | `null`                             |
| `ui/showMessage`  | request      | P→H  | `{severity, message}`                                | `null`                             |
| `$/cancelRequest` | notification | 雙向 | `{id}`                                               | —                                  |
| `exit`            | notification | H→P  | `{}`                                                 | —                                  |

- [ ] **Step 1: 寫會失敗的測試**

`src/rpc.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { jsonRpcMessageSchema, notificationMethods, requestMethods } from "./index.js";

const ok = (value: unknown) => jsonRpcMessageSchema.safeParse(value).success;

describe("JSON-RPC envelope", () => {
  it("accepts the four message shapes", () => {
    expect(ok({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).toBe(true);
    expect(ok({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 1 } })).toBe(true);
    expect(ok({ jsonrpc: "2.0", id: 1, result: null })).toBe(true);
    expect(ok({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })).toBe(
      true,
    );
  });
  it("rejects malformed envelopes", () => {
    expect(ok({ jsonrpc: "1.0", id: 1, method: "x" })).toBe(false);
    expect(ok({ jsonrpc: "2.0", id: 1, method: "x", extra: true })).toBe(false);
    expect(ok({ jsonrpc: "2.0", id: 1, result: null, error: { code: 1, message: "" } })).toBe(
      false,
    );
    expect(ok({ jsonrpc: "2.0", id: 1, method: "x", params: [1] })).toBe(false);
    expect(ok({ jsonrpc: "2.0", id: 1.5, method: "x" })).toBe(false);
    expect(ok({ jsonrpc: "2.0", id: 1, result: "text" })).toBe(false);
  });
});

describe("method schemas", () => {
  it("rejects a plugin that declares its own identity", () => {
    const params = requestMethods["ui/showMessage"].params;
    expect(params.safeParse({ severity: "info", message: "hi" }).success).toBe(true);
    expect(
      params.safeParse({ severity: "info", message: "hi", pluginId: "kobrixa.basic-plus" }).success,
    ).toBe(false);
  });
  it("validates handshake locale and cancellation ids", () => {
    const initialize = requestMethods.initialize.params;
    const base = {
      apiVersion: "1.0.0",
      pluginId: "acme.x",
      locale: "zh-TW",
      grantedPermissions: [],
    };
    expect(initialize.safeParse(base).success).toBe(true);
    expect(initialize.safeParse({ ...base, locale: "fr" }).success).toBe(false);
    expect(notificationMethods["$/cancelRequest"].safeParse({ id: "a" }).success).toBe(true);
  });
  it("rejects message text with control characters but allows newlines", () => {
    const params = requestMethods["ui/showMessage"].params;
    expect(params.safeParse({ severity: "info", message: "a\nb\tc" }).success).toBe(true);
    expect(params.safeParse({ severity: "info", message: "a\u0000" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pnpm vitest run --project @kobrixa/plugin-protocol src/rpc.test.ts`
Expected: FAIL（`jsonRpcMessageSchema` 未定義）。

- [ ] **Step 3: 實作**

`src/errors.ts`：

```ts
export const RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  requestCancelled: -32800,
  timeout: -32001,
  permissionDenied: -32002,
  connectionClosed: -32003,
} as const;
```

`src/rpc.ts`：

```ts
import { z } from "zod";
import { PLUGIN_LIMITS } from "./limits.js";

export const jsonRpcIdSchema = z.union([
  z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  z.string().min(1).max(64),
]);
export type JsonRpcId = z.infer<typeof jsonRpcIdSchema>;
const version = z.literal("2.0");
const method = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[$A-Za-z][A-Za-z0-9/_-]*$/);
// Kobrixa methods always use object params and null or object results.
const params = z.looseObject({});

export const jsonRpcRequestSchema = z.strictObject({
  jsonrpc: version,
  id: jsonRpcIdSchema,
  method,
  params: params.optional(),
});
export const jsonRpcNotificationSchema = z.strictObject({
  jsonrpc: version,
  method,
  params: params.optional(),
});
export const jsonRpcSuccessSchema = z.strictObject({
  jsonrpc: version,
  id: jsonRpcIdSchema,
  result: z.union([z.null(), z.looseObject({})]),
});
export const jsonRpcFailureSchema = z.strictObject({
  jsonrpc: version,
  id: z.union([jsonRpcIdSchema, z.null()]),
  error: z.strictObject({
    code: z.int().min(-2147483648).max(2147483647),
    message: z.string().max(PLUGIN_LIMITS.errorMessageLength),
  }),
});
export const jsonRpcMessageSchema = z.union([
  jsonRpcRequestSchema,
  jsonRpcNotificationSchema,
  jsonRpcSuccessSchema,
  jsonRpcFailureSchema,
]);
export type JsonRpcMessage = z.infer<typeof jsonRpcMessageSchema>;
```

`src/methods.ts`：

```ts
import { z } from "zod";
import {
  MULTI_LINE,
  namespacedIdSchema,
  permissionSchema,
  pluginLocaleSchema,
  semverSchema,
} from "./common.js";
import { PLUGIN_LIMITS } from "./limits.js";
import { jsonRpcIdSchema } from "./rpc.js";

export const severitySchema = z.enum(["info", "warning", "error"]);
export type Severity = z.infer<typeof severitySchema>;
const empty = z.strictObject({});

export const requestMethods = {
  initialize: {
    params: z.strictObject({
      apiVersion: semverSchema,
      pluginId: namespacedIdSchema,
      locale: pluginLocaleSchema,
      grantedPermissions: z.array(permissionSchema).max(16),
    }),
    result: z.strictObject({
      apiVersion: semverSchema,
      sdk: z.strictObject({ name: z.string().min(1).max(64), version: z.string().min(1).max(64) }),
    }),
  },
  "command/execute": { params: z.strictObject({ command: namespacedIdSchema }), result: z.null() },
  shutdown: { params: empty, result: z.null() },
  "ui/showMessage": {
    params: z.strictObject({
      severity: severitySchema,
      message: z.string().min(1).max(PLUGIN_LIMITS.messageLength).regex(MULTI_LINE),
    }),
    result: z.null(),
  },
} as const;
export const notificationMethods = {
  "$/cancelRequest": z.strictObject({ id: jsonRpcIdSchema }),
  exit: empty,
} as const;

export type RequestMethod = keyof typeof requestMethods;
export type NotificationMethod = keyof typeof notificationMethods;
export type ParamsOf<M extends RequestMethod> = z.input<(typeof requestMethods)[M]["params"]>;
export type ResultOf<M extends RequestMethod> = z.output<(typeof requestMethods)[M]["result"]>;
export type NotificationParamsOf<M extends NotificationMethod> = z.output<
  (typeof notificationMethods)[M]
>;
```

在 `src/index.ts` 加入 `export * from "./errors.js"; export * from "./rpc.js"; export * from "./methods.js";`。

- [ ] **Step 4: 執行測試，確認通過**

Run: `pnpm vitest run --project @kobrixa/plugin-protocol && pnpm --filter @kobrixa/plugin-protocol check`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-protocol
git commit -m "feat(plugin-protocol): add JSON-RPC envelopes and method schemas"
```

---

### Task 3: `Content-Length` 分幀

**Files:**

- Create: `packages/plugin-protocol/src/framing.ts`
- Modify: `packages/plugin-protocol/src/index.ts`
- Test: `packages/plugin-protocol/src/framing.test.ts`

**Interfaces:**

- Produces: `encodeContentLength(text: string): Uint8Array`；`class ContentLengthDecoder { constructor(maxBytes?: number); push(chunk: Uint8Array): string[] }`；`class FramingError extends Error { code: "PLUGIN_E_FRAME_HEADER" | "PLUGIN_E_FRAME_SIZE" | "PLUGIN_E_FRAME_UTF8" }`

- [ ] **Step 1: 寫會失敗的測試**

```ts
import { describe, expect, it } from "vitest";
import { ContentLengthDecoder, encodeContentLength, FramingError } from "./index.js";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("Content-Length framing", () => {
  it("round-trips UTF-8 messages split across arbitrary chunks", () => {
    const frame = new Uint8Array([
      ...encodeContentLength('{"a":"插件😀"}'),
      ...encodeContentLength("{}"),
    ]);
    const decoder = new ContentLengthDecoder();
    const received: string[] = [];
    for (const byte of frame) received.push(...decoder.push(new Uint8Array([byte])));
    expect(received).toEqual(['{"a":"插件😀"}', "{}"]);
  });
  it("accepts extra headers and case-insensitive names", () => {
    const decoder = new ContentLengthDecoder();
    expect(decoder.push(bytes("content-length: 2\r\nContent-Type: x\r\n\r\n{}"))).toEqual(["{}"]);
  });
  it.each([
    ["missing length", "Content-Type: x\r\n\r\n{}", "PLUGIN_E_FRAME_HEADER"],
    ["non-header text", "hello from print()\r\n\r\n", "PLUGIN_E_FRAME_HEADER"],
    // A single print("debug") never sends "\r\n\r\n"; the first complete line must already fail.
    ["a lone debug line", "debug\n", "PLUGIN_E_FRAME_HEADER"],
    [
      "duplicate length",
      "Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}",
      "PLUGIN_E_FRAME_HEADER",
    ],
    ["oversized body", `Content-Length: ${1024 * 1024 + 1}\r\n\r\n`, "PLUGIN_E_FRAME_SIZE"],
  ])("rejects %s", (_name, input, code) => {
    expect(() => new ContentLengthDecoder().push(bytes(input))).toThrowError(
      expect.objectContaining({ code }) as Error,
    );
  });
  it("rejects a header that never ends and invalid UTF-8", () => {
    expect(() => new ContentLengthDecoder().push(bytes("x".repeat(1025)))).toThrow(FramingError);
    const invalid = new Uint8Array([...bytes("Content-Length: 1\r\n\r\n"), 0xff]);
    expect(() => new ContentLengthDecoder().push(invalid)).toThrowError(
      expect.objectContaining({ code: "PLUGIN_E_FRAME_UTF8" }) as Error,
    );
  });
  it("refuses to encode oversized messages", () => {
    expect(() => encodeContentLength("x".repeat(1024 * 1024 + 1))).toThrow(FramingError);
  });
});
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pnpm vitest run --project @kobrixa/plugin-protocol src/framing.test.ts`
Expected: FAIL（模組不存在）。

- [ ] **Step 3: 實作 `src/framing.ts`**

```ts
import { PLUGIN_LIMITS } from "./limits.js";

export class FramingError extends Error {
  constructor(
    readonly code: "PLUGIN_E_FRAME_HEADER" | "PLUGIN_E_FRAME_SIZE" | "PLUGIN_E_FRAME_UTF8",
    message: string,
  ) {
    super(message);
    this.name = "FramingError";
  }
}

const encoder = new TextEncoder();

export function encodeContentLength(text: string): Uint8Array {
  const body = encoder.encode(text);
  if (body.length > PLUGIN_LIMITS.messageBytes)
    throw new FramingError("PLUGIN_E_FRAME_SIZE", "Message exceeds 1 MiB.");
  const header = encoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
  const frame = new Uint8Array(header.length + body.length);
  frame.set(header);
  frame.set(body, header.length);
  return frame;
}

function headerEnd(buffer: Uint8Array): number {
  for (let index = 0; index + 3 < buffer.length; index++)
    if (
      buffer[index] === 13 &&
      buffer[index + 1] === 10 &&
      buffer[index + 2] === 13 &&
      buffer[index + 3] === 10
    )
      return index;
  return -1;
}

const HEADER_LINE = /^[A-Za-z0-9-]+:[^\r]*$/;

/** Rejects stray output such as a single print() line before a header terminator arrives. */
function assertHeaderPrefix(buffer: Uint8Array): void {
  const lines = new TextDecoder("latin1").decode(buffer).split("\n");
  lines.pop(); // The last line may still be arriving.
  for (const line of lines)
    if (!line.endsWith("\r") || !HEADER_LINE.test(line.slice(0, -1)))
      throw new FramingError("PLUGIN_E_FRAME_HEADER", "Malformed message header.");
}

export class ContentLengthDecoder {
  #buffer = new Uint8Array(0);
  readonly #utf8 = new TextDecoder("utf-8", { fatal: true });
  constructor(private readonly maxBytes: number = PLUGIN_LIMITS.messageBytes) {}

  push(chunk: Uint8Array): string[] {
    const merged = new Uint8Array(this.#buffer.length + chunk.length);
    merged.set(this.#buffer);
    merged.set(chunk, this.#buffer.length);
    this.#buffer = merged;
    const messages: string[] = [];
    for (;;) {
      const end = headerEnd(this.#buffer);
      if (
        end < 0 ? this.#buffer.length > PLUGIN_LIMITS.headerBytes : end > PLUGIN_LIMITS.headerBytes
      )
        throw new FramingError("PLUGIN_E_FRAME_HEADER", "Message header is too long.");
      if (end < 0) {
        assertHeaderPrefix(this.#buffer);
        return messages;
      }
      let length: number | undefined;
      for (const line of new TextDecoder("latin1")
        .decode(this.#buffer.subarray(0, end))
        .split("\r\n")) {
        const match = /^content-length:[ \t]*([0-9]{1,10})[ \t]*$/i.exec(line);
        if (match) {
          if (length !== undefined)
            throw new FramingError("PLUGIN_E_FRAME_HEADER", "Duplicate Content-Length.");
          length = Number(match[1]);
        } else if (!HEADER_LINE.test(line))
          throw new FramingError("PLUGIN_E_FRAME_HEADER", "Malformed message header.");
      }
      if (length === undefined)
        throw new FramingError("PLUGIN_E_FRAME_HEADER", "Missing Content-Length.");
      if (length > this.maxBytes)
        throw new FramingError("PLUGIN_E_FRAME_SIZE", "Message exceeds 1 MiB.");
      const start = end + 4;
      if (this.#buffer.length < start + length) return messages;
      try {
        messages.push(this.#utf8.decode(this.#buffer.subarray(start, start + length)));
      } catch {
        throw new FramingError("PLUGIN_E_FRAME_UTF8", "Message body is not valid UTF-8.");
      }
      this.#buffer = this.#buffer.slice(start + length);
    }
  }
}
```

在 `src/index.ts` 加入 `export * from "./framing.js";`。

- [ ] **Step 4: 執行測試，確認通過**

Run: `pnpm vitest run --project @kobrixa/plugin-protocol`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-protocol
git commit -m "feat(plugin-protocol): add Content-Length framing"
```

---

### Task 4: 產生 JSON Schema、檢查偏差、共用的一致性案例

**Files:**

- Create: `packages/plugin-protocol/src/json-schema.ts`、`scripts/export-schema.mjs`
- Create: `packages/plugin-protocol/schema/plugin-protocol.schema.json`（由腳本產生）、`schema/keywords.json`、`conformance/cases.json`
- Modify: `packages/plugin-protocol/src/index.ts`、`.prettierignore`
- Test: `packages/plugin-protocol/src/json-schema.test.ts`、`src/conformance.test.ts`

**Interfaces:**

- Consumes: task 1–2 的所有 schema
- Produces: `SCHEMA_DEFINITIONS: Record<string, z.ZodType>`，鍵名為 `manifest`、`message`、`<method>.params`、`<method>.result`（request 方法）與 `<method>.params`（notification 方法）；`buildJsonSchema()`、`serializeJsonSchema(): string`；`conformance/cases.json` 的格式為 `{ name: string; definition: keyof SCHEMA_DEFINITIONS; valid: boolean; value: unknown }[]`，`value` 中的 `{"$repeat": string, "count": number}` 會展開成重複字串

- [ ] **Step 1: 寫 `keywords.json` 與會失敗的測試**

`schema/keywords.json`（兩種驗證器都必須支援這份清單，不能多也不能少）：

```json
[
  "$schema",
  "$id",
  "title",
  "$defs",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "enum",
  "const",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "items",
  "minItems",
  "maxItems",
  "anyOf",
  "oneOf"
]
```

`src/json-schema.test.ts`：

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  notificationMethods,
  requestMethods,
  SCHEMA_DEFINITIONS,
  serializeJsonSchema,
} from "./index.js";

const read = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");

function keywords(node: unknown, found = new Set<string>(), inProperties = false): Set<string> {
  if (Array.isArray(node)) node.forEach((item) => keywords(item, found));
  else if (node && typeof node === "object")
    for (const [key, value] of Object.entries(node)) {
      if (!inProperties) found.add(key);
      keywords(value, found, !inProperties && (key === "properties" || key === "$defs"));
    }
  return found;
}

describe("published JSON Schema", () => {
  it("matches the committed schema (run pnpm --filter @kobrixa/plugin-protocol schema)", async () => {
    expect(await read("../schema/plugin-protocol.schema.json")).toBe(serializeJsonSchema());
  });
  it("uses only keywords that both validators implement and no $ref", async () => {
    const allowed = new Set(JSON.parse(await read("../schema/keywords.json")) as string[]);
    const used = keywords(JSON.parse(serializeJsonSchema()));
    expect([...used].filter((key) => !allowed.has(key))).toEqual([]);
  });
  it("keeps patterns portable between ECMAScript and Python", () => {
    expect(serializeJsonSchema()).not.toMatch(/\\\\[dwsbDWSB]/);
  });
  it("defines every method", () => {
    for (const method of Object.keys(requestMethods)) {
      expect(SCHEMA_DEFINITIONS).toHaveProperty([`${method}.params`]);
      expect(SCHEMA_DEFINITIONS).toHaveProperty([`${method}.result`]);
    }
    for (const method of Object.keys(notificationMethods))
      expect(SCHEMA_DEFINITIONS).toHaveProperty([`${method}.params`]);
  });
});
```

`src/conformance.test.ts`：

```ts
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { SCHEMA_DEFINITIONS } from "./index.js";

interface Case {
  name: string;
  definition: string;
  valid: boolean;
  value: unknown;
}
function expand(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.$repeat === "string" && typeof record.count === "number")
      return record.$repeat.repeat(record.count);
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, expand(item)]));
  }
  return value;
}
const cases = JSON.parse(
  await readFile(new URL("../conformance/cases.json", import.meta.url), "utf8"),
) as Case[];

it.each(cases)("$name", ({ definition, valid, value }) => {
  const schema = SCHEMA_DEFINITIONS[definition];
  expect(schema, definition).toBeDefined();
  expect(schema!.safeParse(expand(value)).success).toBe(valid);
});
```

`conformance/cases.json`（Python 端會在 task 11 讀同一個檔案）：

```json
[
  {
    "name": "initialize request",
    "definition": "message",
    "valid": true,
    "value": { "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }
  },
  {
    "name": "wrong JSON-RPC version",
    "definition": "message",
    "valid": false,
    "value": { "jsonrpc": "1.0", "id": 1, "method": "initialize" }
  },
  {
    "name": "extra envelope field",
    "definition": "message",
    "valid": false,
    "value": { "jsonrpc": "2.0", "id": 1, "method": "x", "pluginId": "acme.x" }
  },
  {
    "name": "cancel notification",
    "definition": "message",
    "valid": true,
    "value": { "jsonrpc": "2.0", "method": "$/cancelRequest", "params": { "id": 3 } }
  },
  {
    "name": "null result",
    "definition": "message",
    "valid": true,
    "value": { "jsonrpc": "2.0", "id": 1, "result": null }
  },
  {
    "name": "result and error together",
    "definition": "message",
    "valid": false,
    "value": { "jsonrpc": "2.0", "id": 1, "result": null, "error": { "code": 1, "message": "x" } }
  },
  {
    "name": "failure",
    "definition": "message",
    "valid": true,
    "value": { "jsonrpc": "2.0", "id": 2, "error": { "code": -32601, "message": "Unknown" } }
  },
  {
    "name": "array params",
    "definition": "message",
    "valid": false,
    "value": { "jsonrpc": "2.0", "id": 1, "method": "x", "params": [] }
  },
  {
    "name": "fractional id",
    "definition": "message",
    "valid": false,
    "value": { "jsonrpc": "2.0", "id": 1.5, "result": null }
  },
  {
    "name": "boolean id",
    "definition": "message",
    "valid": false,
    "value": { "jsonrpc": "2.0", "id": true, "result": null }
  },
  {
    "name": "minimal manifest",
    "definition": "manifest",
    "valid": true,
    "value": {
      "id": "acme.hello",
      "version": "1.0.0",
      "apiVersion": "^1.0.0",
      "runtime": { "kind": "python", "entry": "main.py" }
    }
  },
  {
    "name": "manifest unknown field",
    "definition": "manifest",
    "valid": true,
    "value": {
      "id": "acme.hello",
      "version": "1.0.0",
      "apiVersion": "^1.0.0",
      "runtime": { "kind": "node", "entry": "dist/index.cjs" },
      "x-future": 1
    }
  },
  {
    "name": "entry escapes folder",
    "definition": "manifest",
    "valid": false,
    "value": {
      "id": "acme.hello",
      "version": "1.0.0",
      "apiVersion": "^1.0.0",
      "runtime": { "kind": "python", "entry": "../main.py" }
    }
  },
  {
    "name": "absolute entry",
    "definition": "manifest",
    "valid": false,
    "value": {
      "id": "acme.hello",
      "version": "1.0.0",
      "apiVersion": "^1.0.0",
      "runtime": { "kind": "python", "entry": "/main.py" }
    }
  },
  {
    "name": "uppercase id",
    "definition": "manifest",
    "valid": false,
    "value": {
      "id": "Acme.hello",
      "version": "1.0.0",
      "apiVersion": "^1.0.0",
      "runtime": { "kind": "builtin" }
    }
  },
  {
    "name": "id with trailing newline",
    "definition": "manifest",
    "valid": false,
    "value": {
      "id": "acme.hello\n",
      "version": "1.0.0",
      "apiVersion": "^1.0.0",
      "runtime": { "kind": "builtin" }
    }
  },
  {
    "name": "unknown runtime kind",
    "definition": "manifest",
    "valid": false,
    "value": {
      "id": "acme.hello",
      "version": "1.0.0",
      "apiVersion": "^1.0.0",
      "runtime": { "kind": "ruby", "entry": "main.rb" }
    }
  },
  {
    "name": "message at 2000 UTF-16 units",
    "definition": "ui/showMessage.params",
    "valid": true,
    "value": { "severity": "info", "message": { "$repeat": "😀", "count": 1000 } }
  },
  {
    "name": "message over 2000 UTF-16 units",
    "definition": "ui/showMessage.params",
    "valid": false,
    "value": { "severity": "info", "message": { "$repeat": "😀", "count": 1001 } }
  },
  {
    "name": "spoofed plugin id",
    "definition": "ui/showMessage.params",
    "valid": false,
    "value": { "severity": "info", "message": "hi", "pluginId": "kobrixa.basic-plus" }
  },
  {
    "name": "NUL in message",
    "definition": "ui/showMessage.params",
    "valid": false,
    "value": { "severity": "info", "message": "a\u0000b" }
  },
  {
    "name": "unsupported locale",
    "definition": "initialize.params",
    "valid": false,
    "value": {
      "apiVersion": "1.0.0",
      "pluginId": "acme.x",
      "locale": "fr",
      "grantedPermissions": []
    }
  },
  {
    "name": "execute command",
    "definition": "command/execute.params",
    "valid": true,
    "value": { "command": "acme.hello.greet" }
  },
  {
    "name": "shutdown with params",
    "definition": "shutdown.params",
    "valid": false,
    "value": { "force": true }
  }
]
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pnpm vitest run --project @kobrixa/plugin-protocol`
Expected: FAIL（`SCHEMA_DEFINITIONS` 未定義、schema 檔不存在）。

- [ ] **Step 3: 實作 `src/json-schema.ts` 與匯出腳本**

```ts
import { z } from "zod";
import { PLUGIN_API_VERSION } from "./limits.js";
import { pluginManifestSchema } from "./manifest.js";
import { notificationMethods, requestMethods } from "./methods.js";
import { jsonRpcMessageSchema } from "./rpc.js";

export const SCHEMA_DEFINITIONS: Record<string, z.ZodType> = {
  manifest: pluginManifestSchema,
  message: jsonRpcMessageSchema,
  ...Object.fromEntries(
    Object.entries(requestMethods).flatMap(([method, { params, result }]) => [
      [`${method}.params`, params],
      [`${method}.result`, result],
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(notificationMethods).map(([method, params]) => [`${method}.params`, params]),
  ),
};

export function buildJsonSchema() {
  const $defs = Object.fromEntries(
    Object.entries(SCHEMA_DEFINITIONS).map(([name, schema]) => {
      // unrepresentable: "throw" makes unsupported Zod features fail instead of widening to {}.
      const { $schema: _dialect, ...definition } = z.toJSONSchema(schema, {
        target: "draft-2020-12",
        unrepresentable: "throw",
        io: "input",
        reused: "inline",
        cycles: "throw",
      });
      return [name, definition];
    }),
  );
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://kobrixa.com/schemas/plugin-protocol/${PLUGIN_API_VERSION}.json`,
    title: `Kobrixa plugin protocol ${PLUGIN_API_VERSION}`,
    $defs,
  };
}

export const serializeJsonSchema = (): string => `${JSON.stringify(buildJsonSchema(), null, 2)}\n`;
```

`scripts/export-schema.mjs`：

```js
// Regenerates the committed public schema from the Zod definitions in dist/.
import { writeFile } from "node:fs/promises";
import { serializeJsonSchema } from "../dist/json-schema.js";

const text = serializeJsonSchema();
for (const target of ["../schema/plugin-protocol.schema.json"])
  await writeFile(new URL(target, import.meta.url), text);
```

在 `src/index.ts` 加入 `export * from "./json-schema.js";`。在 `.prettierignore` 加入 `packages/plugin-protocol/schema/plugin-protocol.schema.json`，因為產物的格式由 `JSON.stringify` 決定，偏差檢查要逐字元比較。

- [ ] **Step 4: 產生 schema，執行測試確認通過**

Run: `pnpm --filter @kobrixa/plugin-protocol schema && pnpm vitest run --project @kobrixa/plugin-protocol`
Expected: PASS。如果關鍵字測試列出清單外的關鍵字，優先修改 Zod 定義避開它；真的需要時，在同一個 commit 裡同時把關鍵字加入 `keywords.json` 和 task 11 的 Python 驗證器。

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-protocol .prettierignore
git commit -m "feat(plugin-protocol): publish JSON Schema with drift and conformance tests"
```

---

### Task 5: 雙向 `RpcPeer` 與記憶體通道

**Files:**

- Create: `packages/plugin-protocol/src/peer.ts`、`src/memory-channel.ts`
- Modify: `packages/plugin-protocol/src/index.ts`
- Test: `packages/plugin-protocol/src/peer.test.ts`

**Interfaces:**

- Consumes: `jsonRpcMessageSchema`、`requestMethods`、`notificationMethods`、`RPC_ERRORS`、`PLUGIN_LIMITS`
- Produces:
  - `interface MessageChannelLike { send(text: string): void; onMessage(listener: (text: string) => void): () => void }`
  - `class RpcError extends Error { readonly code: number }`
  - `interface RequestContext { readonly signal: AbortSignal }`
  - `interface RpcPeerOptions { timeoutMs?: number; cancelGraceMs?: number; onProtocolError?(error: RpcError): void; onUnresponsive?(method: string): void }`
  - `class RpcPeer { constructor(channel, options?); handle(method, handler); onNotification(method, handler); request(method, params, { timeoutMs?, signal? }?): Promise<ResultOf<M>>; notify(method, params): void; close(error?: RpcError): void; readonly closed: boolean }`
  - `createMemoryChannelPair(): [MessageChannelLike, MessageChannelLike]`（非同步傳遞）

行為規則：

- 收到超過 1 MiB、不是 JSON、或不符合信封格式的訊息時，呼叫 `onProtocolError`，不回應。
- 收到未知的請求方法回 `-32601`；參數無效回 `-32602`；處理器丟出 `RpcError` 就沿用它的 code；被取消的處理器回 `-32800`；其他例外回 `-32603`。
- 送出的請求逾時或被 abort 時，先 reject，再送 `$/cancelRequest`，並啟動寬限計時。寬限內收到回應就丟棄；超過寬限仍未回應，呼叫 `onUnresponsive(method)`。
- 收到未知 id 的回應時呼叫 `onProtocolError`。
- 回應的 `result` 不符合方法 schema 時，以 `-32603` reject。
- `close()` 會 reject 所有等待中的請求，並 abort 所有處理中的請求。

- [ ] **Step 1: 寫會失敗的測試**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryChannelPair, RPC_ERRORS, RpcError, RpcPeer } from "./index.js";

afterEach(() => vi.useRealTimers());
const pair = (hostOptions = {}, pluginOptions = {}) => {
  const [a, b] = createMemoryChannelPair();
  return { host: new RpcPeer(a, hostOptions), plugin: new RpcPeer(b, pluginOptions), raw: b };
};
const init = {
  apiVersion: "1.0.0",
  pluginId: "acme.x",
  locale: "en",
  grantedPermissions: [],
} as const;
const initResult = { apiVersion: "1.0.0", sdk: { name: "t", version: "1" } };

describe("RpcPeer", () => {
  it("routes requests and validates results", async () => {
    const { host, plugin } = pair();
    plugin.handle("initialize", (params) => ({
      ...initResult,
      sdk: { name: params.pluginId, version: "1" },
    }));
    await expect(host.request("initialize", init)).resolves.toEqual({
      ...initResult,
      sdk: { name: "acme.x", version: "1" },
    });
  });
  it("reports unknown methods, invalid params and handler errors", async () => {
    const { host, plugin } = pair();
    await expect(host.request("shutdown", {})).rejects.toMatchObject({
      code: RPC_ERRORS.methodNotFound,
    });
    plugin.handle("command/execute", () => {
      throw new RpcError(RPC_ERRORS.permissionDenied, "no");
    });
    await expect(host.request("command/execute", { command: "acme.x.y" })).rejects.toMatchObject({
      code: RPC_ERRORS.permissionDenied,
    });
    plugin.handle("shutdown", () => ({ unexpected: true }) as unknown as null);
    await expect(host.request("shutdown", {})).rejects.toMatchObject({
      code: RPC_ERRORS.internalError,
    });
  });
  it("cancels on timeout, then reports an unresponsive peer after the grace period", async () => {
    vi.useFakeTimers();
    const onUnresponsive = vi.fn();
    const { host, plugin } = pair({ cancelGraceMs: 50, onUnresponsive });
    let signal: AbortSignal | undefined;
    plugin.handle("command/execute", (_params, context) => {
      signal = context.signal;
      return new Promise(() => {});
    });
    const result = host.request("command/execute", { command: "acme.x.y" }, { timeoutMs: 100 });
    const assertion = expect(result).rejects.toMatchObject({ code: RPC_ERRORS.timeout });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(onUnresponsive).toHaveBeenCalledWith("command/execute");
  });
  it("drops a late response after cancellation without a protocol error", async () => {
    const onProtocolError = vi.fn();
    const onUnresponsive = vi.fn();
    const { host, plugin } = pair({ onProtocolError, onUnresponsive, cancelGraceMs: 1000 });
    plugin.handle("command/execute", async (_params, { signal }) => {
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
      return null;
    });
    const controller = new AbortController();
    const pending = host.request(
      "command/execute",
      { command: "acme.x.y" },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: RPC_ERRORS.requestCancelled });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onProtocolError).not.toHaveBeenCalled();
    expect(onUnresponsive).not.toHaveBeenCalled();
  });
  it("treats malformed or oversized input as protocol errors", async () => {
    const onProtocolError = vi.fn();
    const [a, b] = createMemoryChannelPair();
    new RpcPeer(a, { onProtocolError });
    b.send("not json");
    b.send(JSON.stringify({ jsonrpc: "2.0", id: 99, result: null }));
    b.send(`"${"x".repeat(1024 * 1024)}"`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onProtocolError).toHaveBeenCalledTimes(3);
  });
  it("rejects pending requests on close and refuses new ones", async () => {
    const { host, plugin } = pair();
    plugin.handle("shutdown", () => new Promise(() => {}));
    const pending = host.request("shutdown", {});
    host.close(new RpcError(RPC_ERRORS.connectionClosed, "gone"));
    await expect(pending).rejects.toMatchObject({ code: RPC_ERRORS.connectionClosed });
    await expect(host.request("shutdown", {})).rejects.toMatchObject({
      code: RPC_ERRORS.connectionClosed,
    });
  });
  it("delivers notifications", async () => {
    const { host, plugin } = pair();
    const exit = vi.fn();
    plugin.onNotification("exit", exit);
    host.notify("exit", {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(exit).toHaveBeenCalledWith({});
  });
});
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pnpm vitest run --project @kobrixa/plugin-protocol src/peer.test.ts`
Expected: FAIL（模組不存在）。

- [ ] **Step 3: 實作 `src/memory-channel.ts`**

```ts
import type { MessageChannelLike } from "./peer.js";

/** Two connected in-memory channels for tests; delivery is asynchronous like real ports. */
export function createMemoryChannelPair(): [MessageChannelLike, MessageChannelLike] {
  const listeners = [new Set<(text: string) => void>(), new Set<(text: string) => void>()] as const;
  const end = (self: 0 | 1): MessageChannelLike => ({
    send: (text) =>
      queueMicrotask(() => listeners[self === 0 ? 1 : 0].forEach((listener) => listener(text))),
    onMessage: (listener) => {
      listeners[self].add(listener);
      return () => listeners[self].delete(listener);
    },
  });
  return [end(0), end(1)];
}
```

- [ ] **Step 4: 實作 `src/peer.ts`**

```ts
import type { z } from "zod";
import { RPC_ERRORS } from "./errors.js";
import { PLUGIN_LIMITS } from "./limits.js";
import {
  notificationMethods,
  requestMethods,
  type NotificationMethod,
  type NotificationParamsOf,
  type ParamsOf,
  type RequestMethod,
  type ResultOf,
} from "./methods.js";
import { jsonRpcMessageSchema, type JsonRpcId } from "./rpc.js";

export interface MessageChannelLike {
  send(text: string): void;
  onMessage(listener: (text: string) => void): () => void;
}
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}
export interface RequestContext {
  readonly signal: AbortSignal;
}
export interface RpcPeerOptions {
  timeoutMs?: number;
  cancelGraceMs?: number;
  onProtocolError?(error: RpcError): void;
  onUnresponsive?(method: string): void;
}
type Definition = { params: z.ZodType; result: z.ZodType };
type AnyHandler = (params: unknown, context: RequestContext) => unknown;
interface Pending {
  method: RequestMethod;
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

const encoder = new TextEncoder();
const tooLarge = (text: string) =>
  text.length > PLUGIN_LIMITS.messageBytes ||
  encoder.encode(text).length > PLUGIN_LIMITS.messageBytes;
const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(
    0,
    PLUGIN_LIMITS.errorMessageLength,
  );
const definitions = requestMethods as Record<string, Definition>;
const notifications = notificationMethods as Record<string, z.ZodType>;

export class RpcPeer {
  #nextId = 1;
  #closed: RpcError | undefined;
  readonly #pending = new Map<JsonRpcId, Pending>();
  readonly #abandoned = new Map<JsonRpcId, ReturnType<typeof setTimeout>>();
  readonly #incoming = new Map<JsonRpcId, AbortController>();
  readonly #handlers = new Map<string, AnyHandler>();
  readonly #notificationHandlers = new Map<string, (params: unknown) => void>();
  readonly #unsubscribe: () => void;

  constructor(
    private readonly channel: MessageChannelLike,
    private readonly options: RpcPeerOptions = {},
  ) {
    this.#unsubscribe = channel.onMessage((text) => this.#receive(text));
  }

  get closed(): boolean {
    return this.#closed !== undefined;
  }

  handle<M extends RequestMethod>(
    method: M,
    handler: (
      params: z.output<(typeof requestMethods)[M]["params"]>,
      context: RequestContext,
    ) =>
      | z.input<(typeof requestMethods)[M]["result"]>
      | Promise<z.input<(typeof requestMethods)[M]["result"]>>,
  ): void {
    this.#handlers.set(method, handler as AnyHandler);
  }

  onNotification<M extends Exclude<NotificationMethod, "$/cancelRequest">>(
    method: M,
    handler: (params: NotificationParamsOf<M>) => void,
  ): void {
    this.#notificationHandlers.set(method, handler as (params: unknown) => void);
  }

  request<M extends RequestMethod>(
    method: M,
    params: ParamsOf<M>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ResultOf<M>> {
    if (this.#closed) return Promise.reject(this.#closed);
    if (options.signal?.aborted)
      return Promise.reject(new RpcError(RPC_ERRORS.requestCancelled, `${method} was cancelled.`));
    const parsed = (requestMethods[method].params as z.ZodType).parse(params);
    const id = this.#nextId++;
    return new Promise<ResultOf<M>>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? 30_000;
      const abandon = (error: RpcError) => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        pending.cleanup();
        this.#pending.delete(id);
        this.#trySend({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } });
        this.#abandoned.set(
          id,
          setTimeout(() => {
            this.#abandoned.delete(id);
            this.options.onUnresponsive?.(method);
          }, this.options.cancelGraceMs ?? 5_000),
        );
        reject(error);
      };
      const onAbort = () =>
        abandon(new RpcError(RPC_ERRORS.requestCancelled, `${method} was cancelled.`));
      const timer = setTimeout(
        () =>
          abandon(new RpcError(RPC_ERRORS.timeout, `${method} timed out after ${timeoutMs} ms.`)),
        timeoutMs,
      );
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
        },
      });
      try {
        this.#send({ jsonrpc: "2.0", id, method, params: parsed });
      } catch (error) {
        this.#pending.get(id)?.cleanup();
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify<M extends NotificationMethod>(
    method: M,
    params: z.input<(typeof notificationMethods)[M]>,
  ): void {
    if (this.#closed) return;
    this.#send({
      jsonrpc: "2.0",
      method,
      params: (notificationMethods[method] as z.ZodType).parse(params),
    });
  }

  close(error = new RpcError(RPC_ERRORS.connectionClosed, "The connection was closed.")): void {
    if (this.#closed) return;
    this.#closed = error;
    this.#unsubscribe();
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.#pending.clear();
    for (const timer of this.#abandoned.values()) clearTimeout(timer);
    this.#abandoned.clear();
    for (const controller of this.#incoming.values()) controller.abort();
  }

  #send(message: object): void {
    const text = JSON.stringify(message);
    if (tooLarge(text)) throw new RpcError(RPC_ERRORS.internalError, "Message exceeds 1 MiB.");
    this.channel.send(text);
  }

  #trySend(message: object): void {
    try {
      this.#send(message);
    } catch {
      /* The channel is gone; the close path reports the failure. */
    }
  }

  #protocolError(message: string): void {
    this.options.onProtocolError?.(new RpcError(RPC_ERRORS.invalidRequest, message));
  }

  #receive(text: string): void {
    if (this.#closed) return;
    if (tooLarge(text)) return this.#protocolError("Message exceeds 1 MiB.");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return this.#protocolError("Message is not valid JSON.");
    }
    const parsed = jsonRpcMessageSchema.safeParse(value);
    if (!parsed.success) return this.#protocolError("Message is not a valid JSON-RPC 2.0 message.");
    const message = parsed.data;
    if ("method" in message) {
      if ("id" in message) void this.#onRequest(message.id, message.method, message.params);
      else this.#onNotification(message.method, message.params);
    } else if ("result" in message) this.#onResponse(message.id, { result: message.result });
    else if (message.id === null) this.#protocolError(`Peer reported: ${message.error.message}`);
    else this.#onResponse(message.id, { error: message.error });
  }

  async #onRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const handler = this.#handlers.get(method);
    const definition = definitions[method];
    if (!handler || !definition)
      return this.#trySend({
        jsonrpc: "2.0",
        id,
        error: { code: RPC_ERRORS.methodNotFound, message: `Unknown method ${method}.` },
      });
    if (this.#incoming.has(id))
      return this.#trySend({
        jsonrpc: "2.0",
        id,
        error: { code: RPC_ERRORS.invalidRequest, message: "Duplicate request id." },
      });
    const input = definition.params.safeParse(params);
    if (!input.success)
      return this.#trySend({
        jsonrpc: "2.0",
        id,
        error: { code: RPC_ERRORS.invalidParams, message: `Invalid parameters for ${method}.` },
      });
    const controller = new AbortController();
    this.#incoming.set(id, controller);
    try {
      const result = definition.result.parse(
        await handler(input.data, { signal: controller.signal }),
      );
      if (!this.#closed) this.#trySend({ jsonrpc: "2.0", id, result });
    } catch (error) {
      const code =
        error instanceof RpcError
          ? error.code
          : controller.signal.aborted
            ? RPC_ERRORS.requestCancelled
            : RPC_ERRORS.internalError;
      if (!this.#closed)
        this.#trySend({ jsonrpc: "2.0", id, error: { code, message: errorText(error) } });
    } finally {
      this.#incoming.delete(id);
    }
  }

  #onNotification(method: string, params: unknown): void {
    const schema = notifications[method];
    if (!schema) return; // Unknown notifications are ignored, as JSON-RPC allows.
    const input = schema.safeParse(params);
    if (!input.success) return this.#protocolError(`Invalid parameters for ${method}.`);
    if (method === "$/cancelRequest")
      this.#incoming.get((input.data as { id: JsonRpcId }).id)?.abort();
    else this.#notificationHandlers.get(method)?.(input.data);
  }

  #onResponse(
    id: JsonRpcId,
    outcome: { result: unknown } | { error: { code: number; message: string } },
  ): void {
    const pending = this.#pending.get(id);
    if (!pending) {
      const abandoned = this.#abandoned.get(id);
      if (abandoned === undefined)
        return this.#protocolError(`Unexpected response id ${String(id)}.`);
      clearTimeout(abandoned);
      this.#abandoned.delete(id);
      return;
    }
    pending.cleanup();
    this.#pending.delete(id);
    if ("error" in outcome)
      return pending.reject(new RpcError(outcome.error.code, outcome.error.message));
    const result = requestMethods[pending.method].result.safeParse(outcome.result);
    if (result.success) pending.resolve(result.data);
    else
      pending.reject(
        new RpcError(RPC_ERRORS.internalError, `Invalid result for ${pending.method}.`),
      );
  }
}
```

在 `src/index.ts` 加入 `export * from "./peer.js"; export * from "./memory-channel.js";`。

- [ ] **Step 5: 執行測試，確認通過**

Run: `pnpm vitest run --project @kobrixa/plugin-protocol && pnpm --filter @kobrixa/plugin-protocol check && pnpm eslint packages/plugin-protocol`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/plugin-protocol
git commit -m "feat(plugin-protocol): add bidirectional RPC peer with cancellation"
```

---

### Task 6: `@kobrixa/plugin-runtime`：錯誤碼與插件登錄

**Files:**

- Create: `packages/plugin-runtime/package.json`、`tsconfig.json`、`vitest.config.ts`
- Create: `packages/plugin-runtime/src/errors.ts`、`src/registry.ts`、`src/index.ts`
- Test: `packages/plugin-runtime/src/registry.test.ts`

**Interfaces:**

- Consumes: `pluginManifestSchema`、`PluginManifest`、`PLUGIN_API_VERSION`、`PLUGIN_LIMITS`
- Produces:
  - `type PluginErrorCode`（下列字串聯集）、`class PluginError extends Error { readonly code: PluginErrorCode }`、`interface PluginProblem { code: PluginErrorCode; message: string }`、`messageOf(error: unknown): string`
  - `type PluginSource = { kind: "builtin"; manifest: unknown } | { kind: "development"; directory: string }`
  - `interface RegisteredPlugin { id: string; source: "builtin" | "development"; directory?: string; manifest?: PluginManifest; entry?: string; status: "enabled" | "disabled" | "invalid"; disabledBy?: "user" | "safe-mode"; problems: PluginProblem[] }`
  - `MANIFEST_FILE = "kobrixa-plugin.json"`
  - `loadPlugins(sources, { disabled: ReadonlySet<string>; safeMode: boolean }): Promise<RegisteredPlugin[]>`

錯誤碼：`PLUGIN_E_MANIFEST`、`PLUGIN_E_API_VERSION`、`PLUGIN_E_DUPLICATE_ID`、`PLUGIN_E_COMMAND_NAMESPACE`、`PLUGIN_E_DUPLICATE_COMMAND`、`PLUGIN_E_ACTIVATION`、`PLUGIN_E_RUNTIME_NOT_ALLOWED`、`PLUGIN_E_FRONTEND_REQUIRES_BUILTIN`、`PLUGIN_E_ENTRY`、`PLUGIN_E_LAUNCH`、`PLUGIN_E_HANDSHAKE`、`PLUGIN_E_PROTOCOL`、`PLUGIN_E_UNRESPONSIVE`、`PLUGIN_E_CRASHED`、`PLUGIN_E_CRASH_LOOP`、`PLUGIN_E_TIMEOUT`、`PLUGIN_E_CANCELLED`、`PLUGIN_E_COMMAND_FAILED`、`PLUGIN_E_UNKNOWN_COMMAND`、`PLUGIN_E_UNKNOWN_PLUGIN`、`PLUGIN_E_DISABLED`、`PLUGIN_E_BUILTIN_REQUIRED`、`PLUGIN_E_SAFE_MODE`、`PLUGIN_E_STATE_SAVE`。

語意規則（JSON Schema 無法表達的部分，由宿主檢查，並在本 task 的測試中固定）：

1. `PLUGIN_API_VERSION` 必須滿足 manifest 的 `apiVersion` 範圍 → 否則 `PLUGIN_E_API_VERSION`。
2. `builtin` 來源只能用 `runtime.kind = "builtin"`；開發來源不能用 `builtin` → `PLUGIN_E_RUNTIME_NOT_ALLOWED`。
3. `contributes.frontends` 只允許 `builtin` runtime → `PLUGIN_E_FRONTEND_REQUIRES_BUILTIN`。
4. 每個命令 id 必須以 `<插件 id>.` 開頭 → `PLUGIN_E_COMMAND_NAMESPACE`；同一插件內不得重複 → `PLUGIN_E_DUPLICATE_COMMAND`。
5. `activationEvents` 的 `onCommand:X` 中的 X 必須是本插件貢獻的命令 → `PLUGIN_E_ACTIVATION`。
6. `entry` 的 realpath 必須留在插件資料夾內 → `PLUGIN_E_ENTRY`。
7. 插件 id 重複時，先出現的勝出（內建插件排在最前），後者 → `PLUGIN_E_DUPLICATE_ID`。
8. **停用判斷在註冊任何貢獻之前完成：** 開發插件在安全模式或位於 `disabled` 集合中時，`status = "disabled"`。內建插件 manifest 無效時直接 throw，這是程式錯誤。

- [ ] **Step 1: 建立套件骨架**

`packages/plugin-runtime/package.json`：

```json
{
  "name": "@kobrixa/plugin-runtime",
  "version": "1.0.1-beta.1",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": "./dist/index.js",
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "check": "tsc -b tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@kobrixa/plugin-protocol": "workspace:*",
    "semver": "7.8.5",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@types/semver": "7.8.0"
  }
}
```

`tsconfig.json`：照抄 collab-protocol 的版本，再加上 `"references": [{ "path": "../plugin-protocol" }]`，寫法參考 `packages/compiler/tsconfig.json` 怎麼引用 `ir`。`vitest.config.ts` 照抄。完成後執行 `pnpm install`。

- [ ] **Step 2: 寫會失敗的測試**

```ts
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPlugins } from "./index.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-plugins-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const manifest = (overrides: Record<string, unknown> = {}) => ({
  id: "acme.hello",
  version: "1.0.0",
  apiVersion: "^1.0.0",
  runtime: { kind: "python", entry: "main.py" },
  activationEvents: ["onCommand:acme.hello.greet"],
  permissions: ["ui.notifications"],
  contributes: { commands: [{ id: "acme.hello.greet", title: "Greet" }] },
  ...overrides,
});
async function plugin(name: string, value: unknown, entry = "main.py", prefix = "") {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "kobrixa-plugin.json"), prefix + JSON.stringify(value));
  await writeFile(path.join(directory, entry), "");
  return { kind: "development" as const, directory };
}
const builtin = {
  kind: "builtin" as const,
  manifest: {
    id: "kobrixa.basic-plus",
    version: "1.0.0",
    apiVersion: "^1.0.0",
    runtime: { kind: "builtin" },
    contributes: { frontends: [{ language: "bp" }] },
  },
};
const none = { disabled: new Set<string>(), safeMode: false };

describe("loadPlugins", () => {
  it("loads development plugins from folders with spaces and non-ASCII names", async () => {
    const [loaded] = await loadPlugins([await plugin("插件 測試", manifest())], none);
    expect(loaded).toMatchObject({ id: "acme.hello", status: "enabled", problems: [] });
    expect(loaded!.entry).toMatch(/main\.py$/);
  });
  it("accepts a UTF-8 byte order mark written by Windows editors", async () => {
    const [loaded] = await loadPlugins([await plugin("bom", manifest(), "main.py", "﻿")], none);
    expect(loaded!.status).toBe("enabled");
  });
  it("marks disabled and safe-mode plugins before contributions load", async () => {
    const source = await plugin("a", manifest());
    expect(
      (await loadPlugins([source], { disabled: new Set(["acme.hello"]), safeMode: false }))[0],
    ).toMatchObject({ status: "disabled", disabledBy: "user" });
    expect((await loadPlugins([source], { disabled: new Set(), safeMode: true }))[0]).toMatchObject(
      { status: "disabled", disabledBy: "safe-mode" },
    );
    expect(
      (
        await loadPlugins([builtin], { disabled: new Set(["kobrixa.basic-plus"]), safeMode: true })
      )[0]!.status,
    ).toBe("enabled");
  });
  it.each([
    ["PLUGIN_E_API_VERSION", { apiVersion: "^2.0.0" }],
    ["PLUGIN_E_RUNTIME_NOT_ALLOWED", { runtime: { kind: "builtin" } }],
    ["PLUGIN_E_FRONTEND_REQUIRES_BUILTIN", { contributes: { frontends: [{ language: "bp" }] } }],
    [
      "PLUGIN_E_COMMAND_NAMESPACE",
      { contributes: { commands: [{ id: "other.greet", title: "x" }] }, activationEvents: [] },
    ],
    [
      "PLUGIN_E_DUPLICATE_COMMAND",
      {
        contributes: {
          commands: [
            { id: "acme.hello.a", title: "x" },
            { id: "acme.hello.a", title: "y" },
          ],
        },
        activationEvents: [],
      },
    ],
    ["PLUGIN_E_ACTIVATION", { activationEvents: ["onCommand:acme.hello.missing"] }],
    ["PLUGIN_E_MANIFEST", { id: "Bad" }],
  ])("reports %s", async (code, overrides) => {
    const [loaded] = await loadPlugins([await plugin("p", manifest(overrides))], none);
    expect(loaded!.status).toBe("invalid");
    expect(loaded!.problems.map((problem) => problem.code)).toContain(code);
  });
  it("rejects a missing entry and an entry symlinked outside the folder", async () => {
    const missing = await plugin(
      "missing",
      manifest({ runtime: { kind: "python", entry: "nope.py" } }),
    );
    expect((await loadPlugins([missing], none))[0]!.problems[0]!.code).toBe("PLUGIN_E_ENTRY");
    const outside = path.join(root, "outside.py");
    await writeFile(outside, "");
    const linked = await plugin(
      "linked",
      manifest({ runtime: { kind: "python", entry: "link.py" } }),
      "unused.py",
    );
    await symlink(outside, path.join(linked.directory, "link.py"));
    expect((await loadPlugins([linked], none))[0]!.problems[0]!.code).toBe("PLUGIN_E_ENTRY");
  });
  it("reports unreadable folders, oversized and non-JSON manifests", async () => {
    const results = await loadPlugins(
      [
        { kind: "development", directory: path.join(root, "absent") },
        await plugin("big", { padding: "x".repeat(70 * 1024) }),
      ],
      none,
    );
    expect(results.map((item) => item.problems[0]?.code)).toEqual([
      "PLUGIN_E_MANIFEST",
      "PLUGIN_E_MANIFEST",
    ]);
  });
  it("keeps the first plugin when ids collide and protects built-in ids", async () => {
    const results = await loadPlugins(
      [
        builtin,
        await plugin(
          "spoof",
          manifest({ id: "kobrixa.basic-plus", activationEvents: [], contributes: {} }),
        ),
      ],
      none,
    );
    expect(results.map((item) => item.status)).toEqual(["enabled", "invalid"]);
    expect(results[1]!.problems[0]!.code).toBe("PLUGIN_E_DUPLICATE_ID");
  });
  it("throws on an invalid built-in manifest", async () => {
    await expect(loadPlugins([{ kind: "builtin", manifest: { id: "x" } }], none)).rejects.toThrow(
      /built-in/i,
    );
  });
});
```

Windows 一般使用者帳號不能建立 symlink。在 Windows 上，請把 symlink 那個測試改成 `it.skipIf(process.platform === "win32")`，並在旁邊加註解說明原因。

- [ ] **Step 3: 執行測試，確認失敗**

Run: `pnpm vitest run --project @kobrixa/plugin-runtime`
Expected: FAIL（`loadPlugins` 未定義）。

- [ ] **Step 4: 實作 `src/errors.ts`**

```ts
export const PLUGIN_ERROR_CODES = [
  "PLUGIN_E_MANIFEST",
  "PLUGIN_E_API_VERSION",
  "PLUGIN_E_DUPLICATE_ID",
  "PLUGIN_E_COMMAND_NAMESPACE",
  "PLUGIN_E_DUPLICATE_COMMAND",
  "PLUGIN_E_ACTIVATION",
  "PLUGIN_E_RUNTIME_NOT_ALLOWED",
  "PLUGIN_E_FRONTEND_REQUIRES_BUILTIN",
  "PLUGIN_E_ENTRY",
  "PLUGIN_E_LAUNCH",
  "PLUGIN_E_HANDSHAKE",
  "PLUGIN_E_PROTOCOL",
  "PLUGIN_E_UNRESPONSIVE",
  "PLUGIN_E_CRASHED",
  "PLUGIN_E_CRASH_LOOP",
  "PLUGIN_E_TIMEOUT",
  "PLUGIN_E_CANCELLED",
  "PLUGIN_E_COMMAND_FAILED",
  "PLUGIN_E_UNKNOWN_COMMAND",
  "PLUGIN_E_UNKNOWN_PLUGIN",
  "PLUGIN_E_DISABLED",
  "PLUGIN_E_BUILTIN_REQUIRED",
  "PLUGIN_E_SAFE_MODE",
  "PLUGIN_E_STATE_SAVE",
] as const;
export type PluginErrorCode = (typeof PLUGIN_ERROR_CODES)[number];
export interface PluginProblem {
  code: PluginErrorCode;
  message: string;
}
export class PluginError extends Error {
  constructor(
    readonly code: PluginErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PluginError";
  }
}
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
```

- [ ] **Step 5: 實作 `src/registry.ts`**

```ts
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import { z } from "zod";
import {
  PLUGIN_API_VERSION,
  PLUGIN_LIMITS,
  pluginManifestSchema,
  type PluginManifest,
} from "@kobrixa/plugin-protocol";
import { messageOf, type PluginErrorCode, type PluginProblem } from "./errors.js";

export const MANIFEST_FILE = "kobrixa-plugin.json";
export type PluginSource =
  { kind: "builtin"; manifest: unknown } | { kind: "development"; directory: string };
export interface RegisteredPlugin {
  id: string;
  source: "builtin" | "development";
  directory?: string;
  manifest?: PluginManifest;
  entry?: string;
  status: "enabled" | "disabled" | "invalid";
  disabledBy?: "user" | "safe-mode";
  problems: PluginProblem[];
}

const problem = (code: PluginErrorCode, message: string): PluginProblem => ({ code, message });

function semanticProblems(
  manifest: PluginManifest,
  source: RegisteredPlugin["source"],
): PluginProblem[] {
  const problems: PluginProblem[] = [];
  if (!semver.satisfies(PLUGIN_API_VERSION, manifest.apiVersion))
    problems.push(
      problem(
        "PLUGIN_E_API_VERSION",
        `This Kobrixa provides plugin API ${PLUGIN_API_VERSION}; the plugin requires ${manifest.apiVersion}.`,
      ),
    );
  const builtinRuntime = manifest.runtime.kind === "builtin";
  if (builtinRuntime !== (source === "builtin"))
    problems.push(
      problem(
        "PLUGIN_E_RUNTIME_NOT_ALLOWED",
        builtinRuntime
          ? "Only plugins shipped with Kobrixa can use the builtin runtime."
          : "Built-in plugins must use the builtin runtime in this version.",
      ),
    );
  if (manifest.contributes?.frontends?.length && !builtinRuntime)
    problems.push(
      problem(
        "PLUGIN_E_FRONTEND_REQUIRES_BUILTIN",
        "Compiler frontends can only be contributed by built-in plugins in this version.",
      ),
    );
  const commands = (manifest.contributes?.commands ?? []).map((command) => command.id);
  for (const id of commands)
    if (!id.startsWith(`${manifest.id}.`))
      problems.push(
        problem("PLUGIN_E_COMMAND_NAMESPACE", `Command ${id} must start with ${manifest.id}.`),
      );
  for (const id of new Set(commands.filter((id, index) => commands.indexOf(id) !== index)))
    problems.push(
      problem("PLUGIN_E_DUPLICATE_COMMAND", `Command ${id} is declared more than once.`),
    );
  for (const event of manifest.activationEvents ?? [])
    if (!commands.includes(event.slice("onCommand:".length)))
      problems.push(
        problem(
          "PLUGIN_E_ACTIVATION",
          `${event} does not refer to a command contributed by this plugin.`,
        ),
      );
  return problems;
}

function checkManifest(
  value: unknown,
  source: RegisteredPlugin["source"],
  fallbackId: string,
): RegisteredPlugin {
  const parsed = pluginManifestSchema.safeParse(value);
  if (!parsed.success)
    return {
      id: fallbackId,
      source,
      status: "invalid",
      problems: [problem("PLUGIN_E_MANIFEST", z.prettifyError(parsed.error))],
    };
  const problems = semanticProblems(parsed.data, source);
  return {
    id: parsed.data.id,
    source,
    manifest: parsed.data,
    status: problems.length ? "invalid" : "enabled",
    problems,
  };
}

async function readDevelopmentPlugin(directory: string): Promise<RegisteredPlugin> {
  const fallback = path.basename(directory);
  const invalid = (
    message: string,
    code: PluginErrorCode = "PLUGIN_E_MANIFEST",
  ): RegisteredPlugin => ({
    id: fallback,
    source: "development",
    directory,
    status: "invalid",
    problems: [problem(code, message)],
  });
  let root: string;
  let value: unknown;
  try {
    root = await realpath(directory);
    const file = path.join(root, MANIFEST_FILE);
    if ((await stat(file)).size > PLUGIN_LIMITS.manifestBytes)
      return invalid(`${MANIFEST_FILE} is larger than 64 KiB.`);
    value = JSON.parse((await readFile(file, "utf8")).replace(/^﻿/, ""));
  } catch (error) {
    return invalid(`Cannot read ${MANIFEST_FILE}: ${messageOf(error)}`);
  }
  const plugin = { ...checkManifest(value, "development", fallback), directory: root };
  const runtime = plugin.manifest?.runtime;
  if (plugin.status === "invalid" || !runtime || runtime.kind === "builtin") return plugin;
  try {
    const entry = await realpath(path.resolve(root, runtime.entry));
    const relative = path.relative(root, entry);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      return {
        ...plugin,
        status: "invalid",
        problems: [
          problem("PLUGIN_E_ENTRY", `${runtime.entry} resolves outside the plugin folder.`),
        ],
      };
    return { ...plugin, entry };
  } catch {
    return {
      ...plugin,
      status: "invalid",
      problems: [problem("PLUGIN_E_ENTRY", `Entry file ${runtime.entry} was not found.`)],
    };
  }
}

export async function loadPlugins(
  sources: readonly PluginSource[],
  options: { disabled: ReadonlySet<string>; safeMode: boolean },
): Promise<RegisteredPlugin[]> {
  const loaded: RegisteredPlugin[] = [];
  for (const source of sources) {
    if (source.kind === "development") {
      loaded.push(await readDevelopmentPlugin(source.directory));
      continue;
    }
    const plugin = checkManifest(source.manifest, "builtin", "builtin");
    if (plugin.status === "invalid")
      throw new Error(
        `Invalid built-in plugin manifest: ${plugin.problems.map((item) => item.message).join("; ")}`,
      );
    loaded.push(plugin);
  }
  const seen = new Set<string>();
  for (const plugin of loaded) {
    if (plugin.status === "invalid") continue;
    if (seen.has(plugin.id)) {
      plugin.status = "invalid";
      plugin.problems.push(
        problem("PLUGIN_E_DUPLICATE_ID", `Another plugin already uses the id ${plugin.id}.`),
      );
      continue;
    }
    seen.add(plugin.id);
    if (plugin.source !== "development") continue;
    // Recovery: this decision happens before any contribution is registered or process launched.
    if (options.disabled.has(plugin.id))
      Object.assign(plugin, { status: "disabled", disabledBy: "user" });
    else if (options.safeMode)
      Object.assign(plugin, { status: "disabled", disabledBy: "safe-mode" });
  }
  return loaded;
}
```

`src/index.ts`：`export * from "./errors.js"; export * from "./registry.js";`

- [ ] **Step 6: 執行測試，確認通過**

Run: `pnpm vitest run --project @kobrixa/plugin-runtime && pnpm --filter @kobrixa/plugin-runtime check`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add packages/plugin-runtime pnpm-lock.yaml
git commit -m "feat(plugin-runtime): load manifests with disable-before-contribution rules"
```

---

### Task 7: 插件程序抽象與 stdio 程序

**Files:**

- Create: `packages/plugin-runtime/src/process.ts`
- Modify: `packages/plugin-runtime/src/index.ts`
- Test: `packages/plugin-runtime/src/process.test.ts`

**Interfaces:**

- Consumes: `ContentLengthDecoder`、`encodeContentLength`、`MessageChannelLike`
- Produces:
  - `interface ProcessExit { code: number | null; reason?: string }`
  - `interface PluginProcess extends MessageChannelLike { onExit(listener: (exit: ProcessExit) => void): () => void; kill(): void; stderrTail(): string }`：程序已經結束後才註冊的 `onExit` listener，會在 microtask 中立即被呼叫
  - `class OutputTail { push(chunk: Uint8Array | string): void; text(): string }`：保留最後 16 KiB
  - `class ExitSignal { emit(exit: ProcessExit): void; subscribe(listener): () => void }`：只會 emit 一次
  - `stdioProcess(child: ChildProcessWithoutNullStreams): PluginProcess`
  - `spawnPluginProcess(command: string, args: readonly string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<PluginProcess>`：等 `spawn` 事件；`error`（例如 ENOENT）時 reject

stdout 出現非協定資料時，宿主終止程序，結束原因為 `Plugin wrote non-protocol data to stdout (<FramingError message>). Write logs to stderr.`；task 8 把它對應成 `PLUGIN_E_PROTOCOL`。

- [ ] **Step 1: 寫會失敗的測試**

```ts
import { describe, expect, it } from "vitest";
import { spawnPluginProcess } from "./index.js";

const node = (script: string) =>
  spawnPluginProcess(process.execPath, ["-e", script], { cwd: process.cwd() });
const echo = `
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  const end = buffer.indexOf("\\r\\n\\r\\n");
  if (end < 0) return;
  const length = Number(/Content-Length: (\\d+)/.exec(buffer.subarray(0, end).toString())[1]);
  const body = buffer.subarray(end + 4, end + 4 + length);
  if (body.length < length) return;
  process.stderr.write("log line\\n");
  process.stdout.write("Content-Length: " + body.length + "\\r\\n\\r\\n");
  process.stdout.write(body);
});`;

describe("stdio plugin process", () => {
  it("exchanges framed messages and keeps stderr as logs", async () => {
    const child = await node(echo);
    const received = new Promise<string>((resolve) => child.onMessage(resolve));
    child.send('{"hello":"世界"}');
    expect(await received).toBe('{"hello":"世界"}');
    expect(child.stderrTail()).toContain("log line");
    const exited = new Promise((resolve) => child.onExit(resolve));
    child.kill();
    await exited;
  });
  it("stops a plugin that prints to stdout and explains why", async () => {
    const child = await node(`console.log("debug"); setInterval(() => {}, 1000);`);
    const exit = await new Promise<{ reason?: string }>((resolve) => child.onExit(resolve));
    expect(exit.reason).toMatch(/non-protocol data to stdout/);
  });
  it("reports late exit subscribers immediately", async () => {
    const child = await node("process.exit(3)");
    await new Promise((resolve) => child.onExit(resolve));
    await expect(new Promise((resolve) => child.onExit(resolve))).resolves.toMatchObject({
      code: 3,
    });
  });
  it("rejects when the interpreter cannot be started", async () => {
    await expect(
      spawnPluginProcess("kobrixa-no-such-python", [], { cwd: process.cwd() }),
    ).rejects.toThrow(/ENOENT|not found/i);
  });
});
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pnpm vitest run --project @kobrixa/plugin-runtime src/process.test.ts`
Expected: FAIL（模組不存在）。

- [ ] **Step 3: 實作 `src/process.ts`**

```ts
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  ContentLengthDecoder,
  encodeContentLength,
  type MessageChannelLike,
} from "@kobrixa/plugin-protocol";

export interface ProcessExit {
  code: number | null;
  reason?: string;
}
export interface PluginProcess extends MessageChannelLike {
  onExit(listener: (exit: ProcessExit) => void): () => void;
  kill(): void;
  stderrTail(): string;
}

const TAIL_CHARACTERS = 16 * 1024;
export class OutputTail {
  #text = "";
  push(chunk: Uint8Array | string): void {
    this.#text = (
      this.#text + (typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
    ).slice(-TAIL_CHARACTERS);
  }
  text(): string {
    return this.#text;
  }
}

export class ExitSignal {
  #exit: ProcessExit | undefined;
  readonly #listeners = new Set<(exit: ProcessExit) => void>();
  emit(exit: ProcessExit): void {
    if (this.#exit) return;
    this.#exit = exit;
    for (const listener of this.#listeners) listener(exit);
    this.#listeners.clear();
  }
  subscribe(listener: (exit: ProcessExit) => void): () => void {
    const exit = this.#exit;
    if (exit) {
      queueMicrotask(() => listener(exit));
      return () => {};
    }
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

export function stdioProcess(child: ChildProcessWithoutNullStreams): PluginProcess {
  const decoder = new ContentLengthDecoder();
  const listeners = new Set<(text: string) => void>();
  const tail = new OutputTail();
  const exits = new ExitSignal();
  let framing: string | undefined;
  child.stdout.on("data", (chunk: Buffer) => {
    if (framing) return;
    try {
      for (const text of decoder.push(chunk)) for (const listener of listeners) listener(text);
    } catch (error) {
      framing = `Plugin wrote non-protocol data to stdout (${error instanceof Error ? error.message : String(error)}). Write logs to stderr.`;
      child.kill();
    }
  });
  child.stderr.on("data", (chunk: Buffer) => tail.push(chunk));
  child.stdin.on("error", () => {
    /* EPIPE after the plugin exits is reported through the exit event. */
  });
  child.once("error", (error) => exits.emit({ code: null, reason: error.message }));
  child.once("exit", (code, signal) =>
    exits.emit({
      code,
      ...(framing ? { reason: framing } : signal ? { reason: `terminated by ${signal}` } : {}),
    }),
  );
  return {
    send: (text) => {
      if (!child.stdin.writable) throw new Error("The plugin process is not accepting input.");
      child.stdin.write(encodeContentLength(text));
    },
    onMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onExit: (listener) => exits.subscribe(listener),
    kill: () => {
      child.kill();
    },
    stderrTail: () => tail.text(),
  };
}

export function spawnPluginProcess(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<PluginProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: "pipe",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.off("error", reject);
      resolve(stdioProcess(child));
    });
  });
}
```

`src/index.ts` 加入 `export * from "./process.js";`。

- [ ] **Step 4: 執行測試，確認通過**

Run: `pnpm vitest run --project @kobrixa/plugin-runtime`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-runtime
git commit -m "feat(plugin-runtime): add stdio plugin processes"
```

---

### Task 8: `PluginSupervisor`：握手、命令、取消、當機與有限重啟

**Files:**

- Create: `packages/plugin-runtime/src/supervisor.ts`、`src/test-process.ts`
- Modify: `packages/plugin-runtime/src/index.ts`（只匯出 `supervisor.js`；`test-process.ts` 只給測試用，不匯出）
- Test: `packages/plugin-runtime/src/supervisor.test.ts`

**Interfaces:**

- Consumes: `RpcPeer`、`RpcError`、`RPC_ERRORS`、`PLUGIN_API_VERSION`、`PluginProcess`、`PluginError`
- Produces:
  - `interface LaunchablePlugin { id; directory; entry; runtime: "node" | "python"; permissions: readonly Permission[]; commands: readonly string[] }`
  - `type PluginLauncher = (plugin: LaunchablePlugin) => Promise<PluginProcess>`
  - `type SupervisorState = "idle" | "starting" | "running" | "stopping" | "failed"`
  - `interface SupervisorOptions { locale; onNotice(notice: { severity: Severity; message: string }): void; onStateChange?(): void; restartLimit?: number; restartWindowMs?: number; initializeTimeoutMs?: number; commandTimeoutMs?: number; stopTimeoutMs?: number; cancelGraceMs?: number; now?(): number }`
  - `class PluginSupervisor { state; problem; executeCommand(command, signal?): Promise<void>; stop(): Promise<void> }`（`failed` 狀態不能在原物件上清除；停用再啟用時，manager 會建立新的 supervisor）
  - `test-process.ts`：`memoryPlugin(setup: (peer: RpcPeer, control: { exit(code?: number): void }) => void): { process: PluginProcess; killed(): boolean }`

預設值：`restartLimit = 3`、`restartWindowMs = 300000`、`initializeTimeoutMs = 10000`、`commandTimeoutMs = 30000`、`stopTimeoutMs = 2000`、`cancelGraceMs = 5000`。

錯誤對應：命令被拒時，`connectionClosed` 對應到目前的 `problem.code`（沒有 problem 時用 `PLUGIN_E_CRASHED`）；`timeout` 對應 `PLUGIN_E_TIMEOUT`；`requestCancelled` 對應 `PLUGIN_E_CANCELLED`；其他 RPC 錯誤對應 `PLUGIN_E_COMMAND_FAILED`。

- [ ] **Step 1: 寫測試輔助 `src/test-process.ts`**

```ts
import { createMemoryChannelPair, RpcPeer } from "@kobrixa/plugin-protocol";
import { ExitSignal, type PluginProcess } from "./process.js";

/** An in-memory plugin process whose plugin side is a raw RpcPeer, for supervisor tests. */
export function memoryPlugin(
  setup: (peer: RpcPeer, control: { exit(code?: number): void }) => void,
) {
  const [host, plugin] = createMemoryChannelPair();
  const exits = new ExitSignal();
  let killed = false;
  const peer = new RpcPeer(plugin);
  const exit = (code = 0) => {
    peer.close();
    queueMicrotask(() => exits.emit({ code }));
  };
  setup(peer, { exit });
  const process: PluginProcess = {
    ...host,
    onExit: (listener) => exits.subscribe(listener),
    kill: () => {
      killed = true;
      peer.close();
      queueMicrotask(() => exits.emit({ code: null, reason: "killed" }));
    },
    stderrTail: () => "",
  };
  return { process, killed: () => killed };
}
```

- [ ] **Step 2: 寫會失敗的測試**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcPeer } from "@kobrixa/plugin-protocol";
import { PluginSupervisor, type LaunchablePlugin } from "./index.js";
import { memoryPlugin } from "./test-process.js";

afterEach(() => vi.useRealTimers());
const plugin: LaunchablePlugin = {
  id: "acme.hello",
  directory: "/p",
  entry: "/p/main.py",
  runtime: "python",
  permissions: ["ui.notifications"],
  commands: ["acme.hello.greet", "acme.hello.crash", "acme.hello.hang"],
};
function ready(peer: RpcPeer, exit: (code?: number) => void) {
  peer.handle("initialize", () => ({ apiVersion: "1.0.0", sdk: { name: "test", version: "1" } }));
  peer.handle("command/execute", async ({ command }) => {
    if (command === "acme.hello.greet")
      await peer.request("ui/showMessage", { severity: "info", message: "hi" });
    if (command === "acme.hello.crash") exit(1);
    if (command === "acme.hello.hang") await new Promise(() => {});
    return null;
  });
  peer.handle("shutdown", () => null);
  peer.onNotification("exit", () => exit(0));
}
function setup(
  options: Partial<ConstructorParameters<typeof PluginSupervisor>[2]> = {},
  overrides: Partial<LaunchablePlugin> = {},
) {
  const launches: ReturnType<typeof memoryPlugin>[] = [];
  const notices: unknown[] = [];
  const launcher = vi.fn(async () => {
    const launched = memoryPlugin((peer, { exit }) => ready(peer, exit));
    launches.push(launched);
    return launched.process;
  });
  const supervisor = new PluginSupervisor({ ...plugin, ...overrides }, launcher, {
    locale: "zh-TW",
    onNotice: (notice) => notices.push(notice),
    ...options,
  });
  return { supervisor, launcher, launches, notices };
}

describe("PluginSupervisor", () => {
  it("starts lazily, handshakes once and delivers channel-bound notices", async () => {
    const { supervisor, launcher, notices } = setup();
    expect(launcher).not.toHaveBeenCalled();
    await Promise.all([
      supervisor.executeCommand("acme.hello.greet"),
      supervisor.executeCommand("acme.hello.greet"),
    ]);
    expect(launcher).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([
      { severity: "info", message: "hi" },
      { severity: "info", message: "hi" },
    ]);
    expect(supervisor.state).toBe("running");
  });
  it("denies notifications without the permission", async () => {
    const { supervisor, notices } = setup({}, { permissions: [] });
    await expect(supervisor.executeCommand("acme.hello.greet")).rejects.toMatchObject({
      code: "PLUGIN_E_COMMAND_FAILED",
    });
    expect(notices).toEqual([]);
  });
  it("never replays a command after a crash and restarts on the next request", async () => {
    const { supervisor, launcher, launches } = setup();
    await expect(supervisor.executeCommand("acme.hello.crash")).rejects.toMatchObject({
      code: "PLUGIN_E_CRASHED",
    });
    expect(launcher).toHaveBeenCalledTimes(1);
    expect(supervisor.state).toBe("idle");
    await supervisor.executeCommand("acme.hello.greet");
    expect(launcher).toHaveBeenCalledTimes(2);
    expect(launches).toHaveLength(2);
  });
  // Recovery from "failed" is disabling and re-enabling, which builds a new supervisor (task 9).
  it("stays failed after repeated crashes", async () => {
    const { supervisor } = setup({ restartLimit: 3 });
    for (let index = 0; index < 2; index++)
      await expect(supervisor.executeCommand("acme.hello.crash")).rejects.toMatchObject({
        code: "PLUGIN_E_CRASHED",
      });
    await expect(supervisor.executeCommand("acme.hello.crash")).rejects.toMatchObject({
      code: "PLUGIN_E_CRASH_LOOP",
    });
    expect(supervisor.state).toBe("failed");
    await expect(supervisor.executeCommand("acme.hello.greet")).rejects.toMatchObject({
      code: "PLUGIN_E_CRASH_LOOP",
    });
  });
  it("kills a plugin that ignores cancellation after the grace period", async () => {
    vi.useFakeTimers();
    const { supervisor, launches } = setup({ commandTimeoutMs: 100, cancelGraceMs: 50 });
    const result = supervisor.executeCommand("acme.hello.hang");
    const assertion = expect(result).rejects.toMatchObject({ code: "PLUGIN_E_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    await vi.advanceTimersByTimeAsync(50);
    expect(launches[0]!.killed()).toBe(true);
    expect(supervisor.problem?.code).toBe("PLUGIN_E_UNRESPONSIVE");
  });
  it("reports launch failures without counting a crash loop", async () => {
    const supervisor = new PluginSupervisor(
      plugin,
      async () => {
        throw new Error("python not found");
      },
      { locale: "en", onNotice: () => {} },
    );
    for (let index = 0; index < 4; index++)
      await expect(supervisor.executeCommand("acme.hello.greet")).rejects.toMatchObject({
        code: "PLUGIN_E_LAUNCH",
      });
    expect(supervisor.state).toBe("idle");
  });
  it("rejects incompatible SDK API versions", async () => {
    const launcher = async () =>
      memoryPlugin((peer) =>
        peer.handle("initialize", () => ({
          apiVersion: "2.0.0",
          sdk: { name: "x", version: "1" },
        })),
      ).process;
    const supervisor = new PluginSupervisor(plugin, launcher, { locale: "en", onNotice: () => {} });
    await expect(supervisor.executeCommand("acme.hello.greet")).rejects.toMatchObject({
      code: "PLUGIN_E_HANDSHAKE",
    });
  });
  it("rejects commands the manifest does not contribute", async () => {
    const { supervisor, launcher } = setup();
    await expect(supervisor.executeCommand("acme.hello.other")).rejects.toMatchObject({
      code: "PLUGIN_E_UNKNOWN_COMMAND",
    });
    expect(launcher).not.toHaveBeenCalled();
  });
  it("stops gracefully with shutdown and exit", async () => {
    const { supervisor, launches } = setup();
    await supervisor.executeCommand("acme.hello.greet");
    await supervisor.stop();
    expect(supervisor.state).toBe("idle");
    expect(launches[0]!.killed()).toBe(false);
  });
});
```

- [ ] **Step 3: 執行測試，確認失敗**

Run: `pnpm vitest run --project @kobrixa/plugin-runtime src/supervisor.test.ts`
Expected: FAIL（`PluginSupervisor` 未定義）。

- [ ] **Step 4: 實作 `src/supervisor.ts`**

```ts
import {
  PLUGIN_API_VERSION,
  RPC_ERRORS,
  RpcError,
  RpcPeer,
  type Permission,
  type PluginLocale,
  type Severity,
} from "@kobrixa/plugin-protocol";
import { messageOf, PluginError, type PluginErrorCode, type PluginProblem } from "./errors.js";
import type { PluginProcess, ProcessExit } from "./process.js";

export interface LaunchablePlugin {
  readonly id: string;
  readonly directory: string;
  readonly entry: string;
  readonly runtime: "node" | "python";
  readonly permissions: readonly Permission[];
  readonly commands: readonly string[];
}
export type PluginLauncher = (plugin: LaunchablePlugin) => Promise<PluginProcess>;
export type SupervisorState = "idle" | "starting" | "running" | "stopping" | "failed";
export interface SupervisorOptions {
  locale: PluginLocale;
  onNotice(notice: { severity: Severity; message: string }): void;
  onStateChange?(): void;
  restartLimit?: number;
  restartWindowMs?: number;
  initializeTimeoutMs?: number;
  commandTimeoutMs?: number;
  stopTimeoutMs?: number;
  cancelGraceMs?: number;
  now?(): number;
}
const DEFAULTS = {
  restartLimit: 3,
  restartWindowMs: 5 * 60_000,
  initializeTimeoutMs: 10_000,
  commandTimeoutMs: 30_000,
  stopTimeoutMs: 2_000,
  cancelGraceMs: 5_000,
};
const major = (version: string) => version.split(".")[0];
const describeExit = (exit: ProcessExit) => exit.reason ?? `exit code ${exit.code ?? "unknown"}`;

export class PluginSupervisor {
  #state: SupervisorState = "idle";
  #problem: PluginProblem | undefined;
  #process: PluginProcess | undefined;
  #peer: RpcPeer | undefined;
  #starting: Promise<RpcPeer> | undefined;
  #stopping = false;
  #crashes: number[] = [];
  readonly #options: SupervisorOptions & typeof DEFAULTS;

  constructor(
    readonly plugin: LaunchablePlugin,
    private readonly launcher: PluginLauncher,
    options: SupervisorOptions,
  ) {
    this.#options = { ...DEFAULTS, ...options };
  }

  get state(): SupervisorState {
    return this.#state;
  }
  get problem(): PluginProblem | undefined {
    return this.#problem;
  }

  async executeCommand(command: string, signal?: AbortSignal): Promise<void> {
    if (!this.plugin.commands.includes(command))
      throw new PluginError(
        "PLUGIN_E_UNKNOWN_COMMAND",
        `${this.plugin.id} does not contribute ${command}.`,
      );
    const peer = await this.#ensureStarted();
    try {
      await peer.request(
        "command/execute",
        { command },
        { timeoutMs: this.#options.commandTimeoutMs, ...(signal ? { signal } : {}) },
      );
    } catch (error) {
      throw this.#translate(error);
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    try {
      await this.#starting?.catch(() => undefined);
      const peer = this.#peer;
      const child = this.#process;
      if (!peer || !child) return;
      this.#setState("stopping");
      const exited = new Promise<void>((resolve) => child.onExit(() => resolve()));
      const deadline = setTimeout(() => child.kill(), this.#options.stopTimeoutMs * 2);
      try {
        await peer.request("shutdown", {}, { timeoutMs: this.#options.stopTimeoutMs });
        peer.notify("exit", {});
      } catch {
        child.kill();
      }
      await exited;
      clearTimeout(deadline);
    } finally {
      this.#stopping = false;
    }
  }

  #ensureStarted(): Promise<RpcPeer> {
    if (this.#stopping)
      return Promise.reject(new PluginError("PLUGIN_E_DISABLED", `${this.plugin.id} is stopping.`));
    if (this.#state === "failed")
      return Promise.reject(
        new PluginError(
          "PLUGIN_E_CRASH_LOOP",
          this.#problem?.message ?? `${this.plugin.id} stopped after repeated failures.`,
        ),
      );
    if (this.#state === "running" && this.#peer) return Promise.resolve(this.#peer);
    this.#starting ??= this.#start().finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  async #start(): Promise<RpcPeer> {
    this.#problem = undefined;
    this.#setState("starting");
    let child: PluginProcess;
    try {
      child = await this.launcher(this.plugin);
    } catch (error) {
      this.#problem = { code: "PLUGIN_E_LAUNCH", message: messageOf(error) };
      this.#setState("idle");
      throw new PluginError("PLUGIN_E_LAUNCH", this.#problem.message);
    }
    const peer = new RpcPeer(child, {
      timeoutMs: this.#options.commandTimeoutMs,
      cancelGraceMs: this.#options.cancelGraceMs,
      onProtocolError: (error) =>
        this.#terminate(child, { code: "PLUGIN_E_PROTOCOL", message: error.message }),
      onUnresponsive: (method) =>
        this.#terminate(child, {
          code: "PLUGIN_E_UNRESPONSIVE",
          message: `${method} did not finish within ${this.#options.cancelGraceMs} ms after cancellation.`,
        }),
    });
    // Identity comes from this channel, never from message contents.
    peer.handle("ui/showMessage", (params) => {
      if (!this.plugin.permissions.includes("ui.notifications"))
        throw new RpcError(
          RPC_ERRORS.permissionDenied,
          "The plugin manifest does not request ui.notifications.",
        );
      this.#options.onNotice({ severity: params.severity, message: params.message });
      return null;
    });
    this.#process = child;
    this.#peer = peer;
    child.onExit((exit) => this.#exited(child, peer, exit));
    try {
      const result = await peer.request(
        "initialize",
        {
          apiVersion: PLUGIN_API_VERSION,
          pluginId: this.plugin.id,
          locale: this.#options.locale,
          grantedPermissions: [...this.plugin.permissions],
        },
        { timeoutMs: this.#options.initializeTimeoutMs },
      );
      if (major(result.apiVersion) !== major(PLUGIN_API_VERSION))
        throw new PluginError(
          "PLUGIN_E_HANDSHAKE",
          `The plugin SDK implements API ${result.apiVersion}; Kobrixa requires ${PLUGIN_API_VERSION}.`,
        );
    } catch (error) {
      this.#terminate(child, { code: "PLUGIN_E_HANDSHAKE", message: messageOf(error) });
      throw new PluginError(
        this.#problem?.code ?? "PLUGIN_E_HANDSHAKE",
        this.#problem?.message ?? messageOf(error),
      );
    }
    if (this.#peer !== peer)
      throw new PluginError(
        this.#problem?.code ?? "PLUGIN_E_CRASHED",
        this.#problem?.message ?? `${this.plugin.id} exited during startup.`,
      );
    this.#setState("running");
    return peer;
  }

  #terminate(child: PluginProcess, problem: PluginProblem): void {
    if (this.#process !== child) return;
    this.#problem ??= problem;
    child.kill();
  }

  #exited(child: PluginProcess, peer: RpcPeer, exit: ProcessExit): void {
    if (this.#process !== child) return;
    this.#process = undefined;
    this.#peer = undefined;
    if (this.#stopping) {
      peer.close();
      this.#setState("idle");
      return;
    }
    const tail = child.stderrTail().trim().split("\n").slice(-3).join("\n");
    this.#problem ??= {
      code: "PLUGIN_E_CRASHED",
      message: `${this.plugin.id} exited unexpectedly (${describeExit(exit)}).${tail ? `\n${tail}` : ""}`,
    };
    const now = (this.#options.now ?? Date.now)();
    this.#crashes = [
      ...this.#crashes.filter((at) => now - at < this.#options.restartWindowMs),
      now,
    ];
    const failed = this.#crashes.length >= this.#options.restartLimit;
    if (failed)
      this.#problem = {
        code: "PLUGIN_E_CRASH_LOOP",
        message: `${this.plugin.id} failed ${this.#crashes.length} times and stays stopped until it is disabled and enabled again. Last problem: ${this.#problem.message}`,
      };
    // Pending requests are rejected, never retried: side effects must not be replayed.
    peer.close(new RpcError(RPC_ERRORS.connectionClosed, this.#problem.message));
    this.#setState(failed ? "failed" : "idle");
  }

  #translate(error: unknown): PluginError {
    if (error instanceof PluginError) return error;
    if (!(error instanceof RpcError))
      return new PluginError("PLUGIN_E_COMMAND_FAILED", messageOf(error));
    const code: PluginErrorCode =
      error.code === RPC_ERRORS.connectionClosed
        ? (this.#problem?.code ?? "PLUGIN_E_CRASHED")
        : error.code === RPC_ERRORS.timeout
          ? "PLUGIN_E_TIMEOUT"
          : error.code === RPC_ERRORS.requestCancelled
            ? "PLUGIN_E_CANCELLED"
            : "PLUGIN_E_COMMAND_FAILED";
    return new PluginError(code, error.message);
  }

  #setState(state: SupervisorState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#options.onStateChange?.();
  }
}
```

`src/index.ts` 加入 `export * from "./supervisor.js";`。

- [ ] **Step 5: 執行測試，確認通過**

Run: `pnpm vitest run --project @kobrixa/plugin-runtime && pnpm --filter @kobrixa/plugin-runtime check`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/plugin-runtime
git commit -m "feat(plugin-runtime): supervise plugin lifecycles without replaying commands"
```

---

### Task 9: `PluginManager`：命令路由、啟停、狀態與事件

**Files:**

- Create: `packages/plugin-runtime/src/manager.ts`
- Modify: `packages/plugin-runtime/src/index.ts`
- Test: `packages/plugin-runtime/src/manager.test.ts`

**Interfaces:**

- Consumes: `loadPlugins`、`PluginSupervisor`、`PluginLauncher`、`PluginError`
- Produces:
  - `interface PluginStateStore { load(): Promise<Set<string>>; save(disabled: ReadonlySet<string>): Promise<void> }`
  - `interface PluginManagerOptions { sources: readonly PluginSource[]; store: PluginStateStore; safeMode: boolean; launcher: PluginLauncher; locale: PluginLocale; supervisor?: Omit<SupervisorOptions, "locale" | "onNotice" | "onStateChange">; now?(): number }`
  - `interface PluginSummary { id; source; directory?; version?; runtime?: "builtin" | "node" | "python"; displayName?: LocalizedText; status: "enabled" | "disabled" | "invalid" | "failed"; disabledBy?: "user" | "safe-mode"; running: boolean; problems: PluginProblem[]; commands: { id: string; title: LocalizedText }[] }`
  - `interface PluginsSnapshot { safeMode: boolean; developmentMode: boolean; plugins: PluginSummary[] }`
  - `interface PluginNotice { pluginId: string; severity: Severity; message: string; at: number }`
  - `type PluginManagerEvent = { type: "state"; state: PluginsSnapshot } | { type: "notice"; notice: PluginNotice }`
  - `type PluginCommandResult = { ok: true } | { ok: false; code: PluginErrorCode; message: string }`
  - `type PluginActionResult = { ok: true; state: PluginsSnapshot } | { ok: false; code: PluginErrorCode; message: string }`
  - `class PluginManager { static create(options): Promise<PluginManager>; state(): PluginsSnapshot; frontendFor(language: string): string | undefined; executeCommand(commandId): Promise<PluginCommandResult>; setEnabled(pluginId, enabled): Promise<PluginActionResult>; onEvent(listener): () => void; dispose(): Promise<void> }`

- [ ] **Step 1: 寫會失敗的測試**

```ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginManager, type PluginManagerEvent, type PluginStateStore } from "./index.js";
import { memoryPlugin } from "./test-process.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-manager-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function devPlugin(name: string) {
  const directory = path.join(root, name);
  await mkdir(directory);
  await writeFile(path.join(directory, "main.py"), "");
  await writeFile(
    path.join(directory, "kobrixa-plugin.json"),
    JSON.stringify({
      id: `acme.${name}`,
      version: "1.0.0",
      apiVersion: "^1.0.0",
      runtime: { kind: "python", entry: "main.py" },
      permissions: ["ui.notifications"],
      contributes: {
        commands: [{ id: `acme.${name}.greet`, title: { en: "Greet", "zh-TW": "打招呼" } }],
      },
    }),
  );
  return { kind: "development" as const, directory };
}
const builtin = {
  kind: "builtin" as const,
  manifest: {
    id: "kobrixa.basic-plus",
    version: "1.0.0",
    apiVersion: "^1.0.0",
    runtime: { kind: "builtin" },
    contributes: { frontends: [{ language: "bp" }] },
  },
};
function memoryStore(initial: string[] = []): PluginStateStore & { saved: string[][] } {
  const saved: string[][] = [];
  let value = new Set(initial);
  return {
    saved,
    load: async () => new Set(value),
    save: async (next) => {
      value = new Set(next);
      saved.push([...next]);
    },
  };
}
const launcher = vi.fn(
  async () =>
    memoryPlugin((peer, { exit }) => {
      peer.handle("initialize", () => ({ apiVersion: "1.0.0", sdk: { name: "t", version: "1" } }));
      peer.handle("command/execute", async () => {
        await peer.request("ui/showMessage", { severity: "info", message: "hi" });
        return null;
      });
      peer.handle("shutdown", () => null);
      peer.onNotification("exit", () => exit(0));
    }).process,
);
afterEach(() => launcher.mockClear());
const create = async (
  sources: Parameters<typeof PluginManager.create>[0]["sources"],
  store = memoryStore(),
  safeMode = false,
) => PluginManager.create({ sources, store, safeMode, launcher, locale: "en", now: () => 1000 });

describe("PluginManager", () => {
  it("routes commands, tags notices with the channel's plugin id and resolves frontends", async () => {
    const manager = await create([builtin, await devPlugin("hello")]);
    const events: PluginManagerEvent[] = [];
    manager.onEvent((event) => events.push(event));
    expect(manager.frontendFor("bp")).toBe("kobrixa.basic-plus");
    expect(manager.frontendFor("python")).toBeUndefined();
    await expect(manager.executeCommand("acme.hello.greet")).resolves.toEqual({ ok: true });
    expect(events).toContainEqual({
      type: "notice",
      notice: { pluginId: "acme.hello", severity: "info", message: "hi", at: 1000 },
    });
    expect(manager.state().plugins.find((p) => p.id === "acme.hello")).toMatchObject({
      running: true,
      status: "enabled",
    });
  });
  it("does not register contributions or launch disabled plugins", async () => {
    const manager = await create([await devPlugin("hello")], memoryStore(["acme.hello"]));
    expect(await manager.executeCommand("acme.hello.greet")).toMatchObject({
      ok: false,
      code: "PLUGIN_E_UNKNOWN_COMMAND",
    });
    expect(launcher).not.toHaveBeenCalled();
    expect(manager.state().plugins[0]).toMatchObject({
      status: "disabled",
      disabledBy: "user",
      commands: [],
    });
  });
  it("persists disabling, stops the process and re-enables", async () => {
    const store = memoryStore();
    const manager = await create([await devPlugin("hello")], store);
    await manager.executeCommand("acme.hello.greet");
    const disabled = await manager.setEnabled("acme.hello", false);
    expect(disabled).toMatchObject({ ok: true });
    expect(store.saved).toEqual([["acme.hello"]]);
    expect(await manager.executeCommand("acme.hello.greet")).toMatchObject({
      code: "PLUGIN_E_UNKNOWN_COMMAND",
    });
    await manager.setEnabled("acme.hello", true);
    expect(await manager.executeCommand("acme.hello.greet")).toEqual({ ok: true });
  });
  it("lets safe mode persist a disable but refuses to enable", async () => {
    const store = memoryStore();
    const manager = await create([await devPlugin("hello")], store, true);
    expect(manager.state().plugins[0]).toMatchObject({
      status: "disabled",
      disabledBy: "safe-mode",
    });
    expect(await manager.setEnabled("acme.hello", true)).toMatchObject({
      ok: false,
      code: "PLUGIN_E_SAFE_MODE",
    });
    expect(await manager.setEnabled("acme.hello", false)).toMatchObject({ ok: true });
    expect(store.saved).toEqual([["acme.hello"]]);
  });
  it("refuses to disable built-in plugins and unknown ids", async () => {
    const manager = await create([builtin]);
    expect(await manager.setEnabled("kobrixa.basic-plus", false)).toMatchObject({
      code: "PLUGIN_E_BUILTIN_REQUIRED",
    });
    expect(await manager.setEnabled("acme.nope", false)).toMatchObject({
      code: "PLUGIN_E_UNKNOWN_PLUGIN",
    });
  });
  it("keeps state unchanged when saving fails", async () => {
    const store = memoryStore();
    store.save = async () => {
      throw new Error("disk full");
    };
    const manager = await create([await devPlugin("hello")], store);
    expect(await manager.setEnabled("acme.hello", false)).toMatchObject({
      ok: false,
      code: "PLUGIN_E_STATE_SAVE",
    });
    expect(await manager.executeCommand("acme.hello.greet")).toEqual({ ok: true });
  });
  it("stops every running plugin on dispose", async () => {
    const manager = await create([await devPlugin("a"), await devPlugin("b")]);
    await manager.executeCommand("acme.a.greet");
    await manager.executeCommand("acme.b.greet");
    await manager.dispose();
    expect(manager.state().plugins.every((plugin) => !plugin.running)).toBe(true);
  });
});
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pnpm vitest run --project @kobrixa/plugin-runtime src/manager.test.ts`
Expected: FAIL（`PluginManager` 未定義）。

- [ ] **Step 3: 實作 `src/manager.ts`**

```ts
import type { LocalizedText, PluginLocale, Severity } from "@kobrixa/plugin-protocol";
import { messageOf, PluginError, type PluginErrorCode, type PluginProblem } from "./errors.js";
import { loadPlugins, type PluginSource, type RegisteredPlugin } from "./registry.js";
import { PluginSupervisor, type PluginLauncher, type SupervisorOptions } from "./supervisor.js";

export interface PluginStateStore {
  load(): Promise<Set<string>>;
  save(disabled: ReadonlySet<string>): Promise<void>;
}
export interface PluginManagerOptions {
  sources: readonly PluginSource[];
  store: PluginStateStore;
  safeMode: boolean;
  launcher: PluginLauncher;
  locale: PluginLocale;
  supervisor?: Omit<SupervisorOptions, "locale" | "onNotice" | "onStateChange">;
  now?(): number;
}
export interface PluginSummary {
  id: string;
  source: "builtin" | "development";
  directory?: string;
  version?: string;
  runtime?: "builtin" | "node" | "python";
  displayName?: LocalizedText;
  status: "enabled" | "disabled" | "invalid" | "failed";
  disabledBy?: "user" | "safe-mode";
  running: boolean;
  problems: PluginProblem[];
  commands: { id: string; title: LocalizedText }[];
}
export interface PluginsSnapshot {
  safeMode: boolean;
  developmentMode: boolean;
  plugins: PluginSummary[];
}
export interface PluginNotice {
  pluginId: string;
  severity: Severity;
  message: string;
  at: number;
}
export type PluginManagerEvent =
  { type: "state"; state: PluginsSnapshot } | { type: "notice"; notice: PluginNotice };
type Failure = { ok: false; code: PluginErrorCode; message: string };
export type PluginCommandResult = { ok: true } | Failure;
export type PluginActionResult = { ok: true; state: PluginsSnapshot } | Failure;
const failure = (code: PluginErrorCode, message: string): Failure => ({ ok: false, code, message });

export class PluginManager {
  readonly #supervisors = new Map<string, PluginSupervisor>();
  readonly #commands = new Map<string, string>();
  readonly #listeners = new Set<(event: PluginManagerEvent) => void>();

  static async create(options: PluginManagerOptions): Promise<PluginManager> {
    const disabled = await options.store.load();
    const plugins = await loadPlugins(options.sources, { disabled, safeMode: options.safeMode });
    return new PluginManager(options, disabled, plugins);
  }

  private constructor(
    private readonly options: PluginManagerOptions,
    private disabled: Set<string>,
    private readonly plugins: RegisteredPlugin[],
  ) {
    for (const plugin of plugins) if (plugin.status === "enabled") this.#register(plugin);
  }

  state(): PluginsSnapshot {
    return {
      safeMode: this.options.safeMode,
      developmentMode: this.plugins.some((plugin) => plugin.source === "development"),
      plugins: this.plugins.map((plugin) => this.#summary(plugin)),
    };
  }

  frontendFor(language: string): string | undefined {
    return this.plugins.find(
      (plugin) =>
        plugin.status === "enabled" &&
        plugin.manifest?.contributes?.frontends?.some((item) => item.language === language),
    )?.id;
  }

  async executeCommand(commandId: string): Promise<PluginCommandResult> {
    const owner = this.#commands.get(commandId);
    const supervisor = owner ? this.#supervisors.get(owner) : undefined;
    if (!supervisor)
      return failure("PLUGIN_E_UNKNOWN_COMMAND", `No enabled plugin contributes ${commandId}.`);
    try {
      await supervisor.executeCommand(commandId);
      return { ok: true };
    } catch (error) {
      return error instanceof PluginError
        ? failure(error.code, error.message)
        : failure("PLUGIN_E_COMMAND_FAILED", messageOf(error));
    }
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<PluginActionResult> {
    const plugin = this.plugins.find((item) => item.id === pluginId && item.status !== "invalid");
    if (!plugin)
      return failure("PLUGIN_E_UNKNOWN_PLUGIN", `No valid plugin has the id ${pluginId}.`);
    if (plugin.source === "builtin")
      return failure(
        "PLUGIN_E_BUILTIN_REQUIRED",
        `${pluginId} is part of Kobrixa and cannot be disabled in this version.`,
      );
    if (enabled && this.options.safeMode)
      return failure(
        "PLUGIN_E_SAFE_MODE",
        "Restart Kobrixa without --safe-mode to enable development plugins.",
      );
    const unchanged = enabled ? plugin.status === "enabled" : this.disabled.has(pluginId);
    if (unchanged) return { ok: true, state: this.state() };
    const next = new Set(this.disabled);
    if (enabled) next.delete(pluginId);
    else next.add(pluginId);
    try {
      await this.options.store.save(next);
    } catch (error) {
      return failure("PLUGIN_E_STATE_SAVE", messageOf(error));
    }
    this.disabled = next;
    if (enabled) {
      plugin.status = "enabled";
      delete plugin.disabledBy;
      this.#register(plugin);
    } else {
      const supervisor = this.#supervisors.get(pluginId);
      this.#supervisors.delete(pluginId);
      for (const [command, owner] of this.#commands)
        if (owner === pluginId) this.#commands.delete(command);
      plugin.status = "disabled";
      plugin.disabledBy = "user";
      await supervisor?.stop();
    }
    this.#emitState();
    return { ok: true, state: this.state() };
  }

  onEvent(listener: (event: PluginManagerEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.#supervisors.values()].map((supervisor) => supervisor.stop()));
  }

  #register(plugin: RegisteredPlugin): void {
    const manifest = plugin.manifest;
    if (!manifest || manifest.runtime.kind === "builtin" || !plugin.entry || !plugin.directory)
      return;
    const commands = (manifest.contributes?.commands ?? []).map((command) => command.id);
    const supervisor = new PluginSupervisor(
      {
        id: plugin.id,
        directory: plugin.directory,
        entry: plugin.entry,
        runtime: manifest.runtime.kind,
        permissions: manifest.permissions ?? [],
        commands,
      },
      this.options.launcher,
      {
        ...this.options.supervisor,
        locale: this.options.locale,
        onNotice: (notice) =>
          this.#emit({
            type: "notice",
            notice: { pluginId: plugin.id, ...notice, at: (this.options.now ?? Date.now)() },
          }),
        onStateChange: () => this.#emitState(),
      },
    );
    this.#supervisors.set(plugin.id, supervisor);
    for (const command of commands) this.#commands.set(command, plugin.id);
  }

  #summary(plugin: RegisteredPlugin): PluginSummary {
    const supervisor = this.#supervisors.get(plugin.id);
    const manifest = plugin.manifest;
    return {
      id: plugin.id,
      source: plugin.source,
      ...(plugin.directory ? { directory: plugin.directory } : {}),
      ...(manifest ? { version: manifest.version, runtime: manifest.runtime.kind } : {}),
      ...(manifest?.displayName ? { displayName: manifest.displayName } : {}),
      status: supervisor?.state === "failed" ? "failed" : plugin.status,
      ...(plugin.disabledBy ? { disabledBy: plugin.disabledBy } : {}),
      running: supervisor?.state === "running",
      problems: [...plugin.problems, ...(supervisor?.problem ? [supervisor.problem] : [])],
      commands:
        plugin.status === "enabled"
          ? (manifest?.contributes?.commands ?? []).map(({ id, title }) => ({ id, title }))
          : [],
    };
  }

  #emitState(): void {
    this.#emit({ type: "state", state: this.state() });
  }

  #emit(event: PluginManagerEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
```

`src/index.ts` 加入 `export * from "./manager.js";`。

- [ ] **Step 4: 執行測試，確認通過**

Run: `pnpm vitest run --project @kobrixa/plugin-runtime && pnpm --filter @kobrixa/plugin-runtime check && pnpm eslint packages/plugin-runtime`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-runtime
git commit -m "feat(plugin-runtime): add plugin manager with persisted disable state"
```

---

### Task 10: JS／TS SDK 與 TS 範例插件

**Files:**

- Create: `packages/plugin-sdk-js/package.json`、`tsconfig.json`、`vitest.config.ts`、`src/index.ts`
- Create: `plugins/samples/hello-ts/kobrixa-plugin.json`、`plugins/samples/hello-ts/src/index.ts`
- Test: `packages/plugin-sdk-js/src/index.test.ts`

**Interfaces:**

- Consumes: `RpcPeer`、`RpcError`、`RPC_ERRORS`、`PLUGIN_API_VERSION`、`MessageChannelLike`、`createMemoryChannelPair`
- Produces: `SDK_VERSION = "0.1.0"`、`definePlugin`、`runPlugin(definition, { channel?, exit? }?): Promise<RpcPeer>`、`electronParentPortChannel(parent?): Promise<MessageChannelLike>`、`PluginDefinition`、`PluginContext`、`CommandHandler`

- [ ] **Step 1: 建立套件骨架**

`package.json` 與 task 1 相同，差別如下：name 為 `@kobrixa/plugin-sdk`；`files` 只有 `["dist"]`；不需要 `schema` script；dependencies 為 `{ "@kobrixa/plugin-protocol": "workspace:*" }`。`tsconfig.json` 加入對 `../plugin-protocol` 的 reference。完成後執行 `pnpm install`。

- [ ] **Step 2: 寫會失敗的測試**

```ts
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createMemoryChannelPair, RpcPeer } from "@kobrixa/plugin-protocol";
import { definePlugin, electronParentPortChannel, runPlugin } from "./index.js";

const init = {
  apiVersion: "1.0.0",
  pluginId: "acme.hello",
  locale: "zh-TW",
  grantedPermissions: ["ui.notifications"],
} as const;
function connect(definition: Parameters<typeof runPlugin>[0]) {
  const [hostEnd, pluginEnd] = createMemoryChannelPair();
  const host = new RpcPeer(hostEnd);
  const exit = vi.fn();
  void runPlugin(definition, { channel: pluginEnd, exit });
  return { host, exit };
}

describe("JS plugin SDK", () => {
  it("activates during initialize and runs registered commands", async () => {
    const messages: unknown[] = [];
    const { host } = connect(
      definePlugin({
        activate(context) {
          context.commands.register("acme.hello.greet", () =>
            context.ui.showMessage(`${context.pluginId}:${context.locale}`),
          );
        },
      }),
    );
    host.handle("ui/showMessage", (params) => {
      messages.push(params);
      return null;
    });
    await expect(host.request("initialize", init)).resolves.toMatchObject({
      apiVersion: "1.0.0",
      sdk: { name: "@kobrixa/plugin-sdk" },
    });
    await host.request("command/execute", { command: "acme.hello.greet" });
    expect(messages).toEqual([{ severity: "info", message: "acme.hello:zh-TW" }]);
  });
  it("passes cancellation to handlers and reports unknown commands", async () => {
    let aborted = false;
    const { host } = connect(
      definePlugin({
        activate(context) {
          context.commands.register(
            "acme.hello.wait",
            ({ signal }) =>
              new Promise<void>((_, reject) =>
                signal.addEventListener("abort", () => {
                  aborted = true;
                  reject(new Error("stopped"));
                }),
              ),
          );
        },
      }),
    );
    await host.request("initialize", init);
    const controller = new AbortController();
    const pending = host.request(
      "command/execute",
      { command: "acme.hello.wait" },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    await vi.waitFor(() => expect(aborted).toBe(true));
    await expect(
      host.request("command/execute", { command: "acme.hello.missing" }),
    ).rejects.toMatchObject({ code: -32602 });
  });
  it("deactivates on shutdown and exits on the exit notification", async () => {
    const deactivate = vi.fn();
    const { host, exit } = connect(definePlugin({ activate() {}, deactivate }));
    await host.request("initialize", init);
    await host.request("shutdown", {});
    host.notify("exit", {});
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(deactivate).toHaveBeenCalled();
  });
  it("adapts Electron's parentPort and transferred MessagePort", async () => {
    const parent = new EventEmitter();
    const port = Object.assign(new EventEmitter(), { postMessage: vi.fn(), start: vi.fn() });
    const channel = electronParentPortChannel(parent as never);
    parent.emit("message", { data: {}, ports: [port] });
    const ready = await channel;
    const received = vi.fn();
    ready.onMessage(received);
    port.emit("message", { data: "{}" });
    port.emit("message", { data: 42 });
    ready.send("x");
    expect(received.mock.calls).toEqual([["{}"], [""]]);
    expect(port.postMessage).toHaveBeenCalledWith("x");
    expect(port.start).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: 執行測試，確認失敗**

Run: `pnpm vitest run --project @kobrixa/plugin-sdk`
Expected: FAIL（`runPlugin` 未定義）。

- [ ] **Step 4: 實作 `src/index.ts`**

```ts
import {
  PLUGIN_API_VERSION,
  RPC_ERRORS,
  RpcError,
  RpcPeer,
  type MessageChannelLike,
  type PluginLocale,
  type Severity,
} from "@kobrixa/plugin-protocol";

export const SDK_VERSION = "0.1.0";
export type CommandHandler = (context: { readonly signal: AbortSignal }) => void | Promise<void>;
export interface PluginContext {
  readonly pluginId: string;
  readonly locale: PluginLocale;
  readonly commands: { register(commandId: string, handler: CommandHandler): void };
  readonly ui: { showMessage(message: string, severity?: Severity): Promise<void> };
}
export interface PluginDefinition {
  activate(context: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
export const definePlugin = (definition: PluginDefinition): PluginDefinition => definition;

interface PortLike {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  off(event: "message", listener: (event: { data: unknown }) => void): void;
  start(): void;
}
interface ParentPortLike {
  once(event: "message", listener: (event: { data: unknown; ports: PortLike[] }) => void): void;
}

/** Waits for the MessagePort that Kobrixa transfers to a utilityProcess plugin. */
export function electronParentPortChannel(
  parent = (process as unknown as { parentPort?: ParentPortLike }).parentPort,
): Promise<MessageChannelLike> {
  if (!parent)
    return Promise.reject(new Error("Kobrixa JavaScript plugins must be started by Kobrixa."));
  return new Promise((resolve, reject) => {
    parent.once("message", ({ ports }) => {
      const port = ports[0];
      if (!port) return reject(new Error("Kobrixa did not provide a message port."));
      port.start();
      resolve({
        send: (text) => port.postMessage(text),
        onMessage: (listener) => {
          // Non-string data is forwarded as "" so the peer reports a protocol error.
          const handler = (event: { data: unknown }) =>
            listener(typeof event.data === "string" ? event.data : "");
          port.on("message", handler);
          return () => port.off("message", handler);
        },
      });
    });
  });
}

export async function runPlugin(
  definition: PluginDefinition,
  options: { channel?: MessageChannelLike; exit?(code: number): void } = {},
): Promise<RpcPeer> {
  const channel = options.channel ?? (await electronParentPortChannel());
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const peer = new RpcPeer(channel, { onProtocolError: () => exit(1) });
  const commands = new Map<string, CommandHandler>();
  peer.handle("initialize", async ({ pluginId, locale }) => {
    await definition.activate({
      pluginId,
      locale,
      commands: {
        register(commandId, handler) {
          if (commands.has(commandId))
            throw new Error(`Command ${commandId} is already registered.`);
          commands.set(commandId, handler);
        },
      },
      ui: {
        async showMessage(message, severity = "info") {
          await peer.request("ui/showMessage", { severity, message }, { timeoutMs: 10_000 });
        },
      },
    });
    return {
      apiVersion: PLUGIN_API_VERSION,
      sdk: { name: "@kobrixa/plugin-sdk", version: SDK_VERSION },
    };
  });
  peer.handle("command/execute", async ({ command }, { signal }) => {
    const handler = commands.get(command);
    if (!handler)
      throw new RpcError(RPC_ERRORS.invalidParams, `The plugin did not register ${command}.`);
    await handler({ signal });
    return null;
  });
  peer.handle("shutdown", async () => {
    await definition.deactivate?.();
    return null;
  });
  peer.onNotification("exit", () => exit(0));
  return peer;
}
```

- [ ] **Step 5: 建立 TS 範例插件**

`plugins/samples/hello-ts/kobrixa-plugin.json`：

```json
{
  "id": "kobrixa-samples.hello-ts",
  "version": "0.1.0",
  "apiVersion": "^1.0.0",
  "displayName": { "en": "Hello (TypeScript sample)", "zh-TW": "問候（TypeScript 範例）" },
  "runtime": { "kind": "node", "entry": "dist/index.cjs" },
  "activationEvents": ["onCommand:kobrixa-samples.hello-ts.greet"],
  "permissions": ["ui.notifications"],
  "contributes": {
    "commands": [
      {
        "id": "kobrixa-samples.hello-ts.greet",
        "title": { "en": "Say hello", "zh-TW": "打招呼" }
      }
    ]
  }
}
```

`plugins/samples/hello-ts/src/index.ts`：

```ts
import { definePlugin, runPlugin } from "@kobrixa/plugin-sdk";

void runPlugin(
  definePlugin({
    activate(context) {
      context.commands.register("kobrixa-samples.hello-ts.greet", () =>
        context.ui.showMessage(
          context.locale === "zh-TW"
            ? "來自 TypeScript 插件的問候"
            : "Hello from a TypeScript plugin",
        ),
      );
    },
  }),
);
```

`dist/` 已經被根目錄 `.gitignore` 的 `/**/dist` 忽略。打包指令寫在 task 16 的 README 裡，task 15 的 smoke 也會自動打包這個範例。

- [ ] **Step 6: 執行測試，確認通過**

Run: `pnpm vitest run --project @kobrixa/plugin-sdk && pnpm --filter @kobrixa/plugin-sdk check && pnpm eslint packages/plugin-sdk-js plugins`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add packages/plugin-sdk-js plugins/samples/hello-ts pnpm-lock.yaml
git commit -m "feat(plugin-sdk): add JS SDK over Electron MessagePort and sample plugin"
```

---

### Task 11: Python 開發版 SDK、範例插件與跨語言互通測試

**Files:**

- Create: `sdks/python/pyproject.toml`、`sdks/python/README.md`（只寫安裝方式；完整說明在 task 16）
- Create: `sdks/python/kobrixa/__init__.py`、`_framing.py`、`_schema.py`、`_plugin.py`、`plugin-protocol.schema.json`（由腳本複製）
- Create: `sdks/python/tests/__init__.py`、`test_framing.py`、`test_conformance.py`、`test_plugin.py`、`tests/fixtures/behaviors.py`
- Create: `plugins/samples/hello-python/kobrixa-plugin.json`、`main.py`
- Create: `tools/run-python-tests.mjs`；`packages/plugin-runtime/src/test-python.ts`
- Test: `packages/plugin-runtime/src/python.interop.test.ts`
- Modify: `packages/plugin-protocol/scripts/export-schema.mjs`（加入第二個寫出目標）、`packages/plugin-protocol/src/json-schema.test.ts`（檢查 Python 複本）、`.prettierignore`、`.gitignore`（`__pycache__/`）、根目錄 `package.json`（`test:python-sdk`，並加到 `test:desktop`）

**Interfaces:**

- Consumes: `schema/plugin-protocol.schema.json`、`schema/keywords.json`、`conformance/cases.json`、`PluginSupervisor`、`spawnPluginProcess`
- Produces（Python）：`kobrixa.Plugin`（`command(id)` 裝飾器，只接受 async 函式）、`plugin.run()`、`CommandContext`（`plugin_id`、`locale`、`ui.show_message(message, severity="info")`）、`kobrixa.RpcError`；`_schema.Validator.bundled().validate(name, value)` 失敗時丟 `SchemaError`；`_schema.SUPPORTED_KEYWORDS`
- Produces（TS）：`findPython(): string | undefined`，在 `CI` 環境找不到時直接 throw

- [ ] **Step 1: 讓 schema 匯出腳本同時寫一份 Python 複本**

`scripts/export-schema.mjs` 的目標清單改成：

```js
for (const target of ["../schema/plugin-protocol.schema.json", "../../../sdks/python/kobrixa/plugin-protocol.schema.json"])
```

在 `json-schema.test.ts` 加一個測試：

```ts
it("ships the same schema inside the Python SDK", async () => {
  expect(await read("../../../sdks/python/kobrixa/plugin-protocol.schema.json")).toBe(
    serializeJsonSchema(),
  );
});
```

在 `.prettierignore` 加入 `sdks/python/kobrixa/plugin-protocol.schema.json`；在 `.gitignore` 加入 `__pycache__/`。先執行 `mkdir -p sdks/python/kobrixa`，再執行 `pnpm --filter @kobrixa/plugin-protocol schema`。

- [ ] **Step 2: 寫 Python 的會失敗測試**

`sdks/python/tests/test_framing.py`：

```python
import unittest
from kobrixa._framing import Decoder, FramingError, encode


class FramingTest(unittest.TestCase):
    def test_round_trip_split_utf8(self):
        frame = encode('{"a":"插件😀"}') + encode("{}")
        decoder = Decoder()
        received = []
        for index in range(len(frame)):
            received += decoder.push(frame[index:index + 1])
        self.assertEqual(received, ['{"a":"插件😀"}', "{}"])

    def test_rejects_bad_frames(self):
        for data in [b"Content-Type: x\r\n\r\n{}", b"hello\r\n\r\n", b"debug\n", b"x" * 1025,
                     b"Content-Length: 1048577\r\n\r\n", b"Content-Length: 1\r\n\r\n\xff"]:
            with self.subTest(data=data[:20]):
                with self.assertRaises(FramingError):
                    Decoder().push(data)
```

`sdks/python/tests/test_conformance.py`：

```python
import json
import unittest
from pathlib import Path
from kobrixa._schema import SUPPORTED_KEYWORDS, SchemaError, Validator

PROTOCOL = Path(__file__).resolve().parents[3] / "packages" / "plugin-protocol"


def expand(value):
    if isinstance(value, list):
        return [expand(item) for item in value]
    if isinstance(value, dict):
        if isinstance(value.get("$repeat"), str) and isinstance(value.get("count"), int):
            return value["$repeat"] * value["count"]
        return {key: expand(item) for key, item in value.items()}
    return value


class ConformanceTest(unittest.TestCase):
    def test_keywords_match_the_shared_allowlist(self):
        allowed = json.loads((PROTOCOL / "schema" / "keywords.json").read_text("utf-8"))
        self.assertEqual(SUPPORTED_KEYWORDS, frozenset(allowed))

    def test_shared_cases(self):
        validator = Validator.bundled()
        cases = json.loads((PROTOCOL / "conformance" / "cases.json").read_text("utf-8"))
        for case in cases:
            with self.subTest(case["name"]):
                try:
                    validator.validate(case["definition"], expand(case["value"]))
                    accepted = True
                except SchemaError:
                    accepted = False
                self.assertEqual(accepted, case["valid"])
```

`sdks/python/tests/fixtures/behaviors.py`（測試專用插件）：

```python
from kobrixa import Plugin
import asyncio
import os

plugin = Plugin()


@plugin.command("acme.behaviors.greet")
async def greet(ctx):
    print("debug output must not corrupt the protocol")
    await ctx.ui.show_message(f"{ctx.plugin_id}:{ctx.locale}")


@plugin.command("acme.behaviors.hang")
async def hang(ctx):
    await asyncio.sleep(3600)


@plugin.command("acme.behaviors.crash")
async def crash(ctx):
    os._exit(3)


if __name__ == "__main__":
    plugin.run()
```

`sdks/python/tests/test_plugin.py`：

```python
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from kobrixa._framing import Decoder, encode

SDK = Path(__file__).resolve().parents[1]
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "behaviors.py"


class PluginProcessTest(unittest.TestCase):
    def setUp(self):
        env = {**os.environ, "PYTHONPATH": str(SDK), "PYTHONUNBUFFERED": "1"}
        self.child = subprocess.Popen([sys.executable, str(FIXTURE)], stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        self.decoder = Decoder()
        self.pending = []

    def tearDown(self):
        if self.child.poll() is None:
            self.child.kill()
        self.child.wait(5)
        for stream in (self.child.stdin, self.child.stdout, self.child.stderr):
            stream.close()

    def send(self, message):
        self.child.stdin.write(encode(json.dumps(message)))
        self.child.stdin.flush()

    def receive(self):
        while not self.pending:
            chunk = self.child.stdout.read1(65536)
            self.assertTrue(chunk, "plugin closed stdout")
            self.pending += self.decoder.push(chunk)
        return json.loads(self.pending.pop(0))

    def initialize(self):
        self.send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "apiVersion": "1.0.0", "pluginId": "acme.behaviors", "locale": "zh-TW",
            "grantedPermissions": ["ui.notifications"]}})
        reply = self.receive()
        self.assertEqual(reply["result"]["apiVersion"], "1.0.0")

    def test_command_round_trip_with_print_redirected(self):
        self.initialize()
        self.send({"jsonrpc": "2.0", "id": 2, "method": "command/execute",
                   "params": {"command": "acme.behaviors.greet"}})
        request = self.receive()
        self.assertEqual(request["method"], "ui/showMessage")
        self.assertEqual(request["params"], {"severity": "info", "message": "acme.behaviors:zh-TW"})
        self.send({"jsonrpc": "2.0", "id": request["id"], "result": None})
        self.assertEqual(self.receive(), {"jsonrpc": "2.0", "id": 2, "result": None})

    def test_cancellation_reports_request_cancelled(self):
        self.initialize()
        self.send({"jsonrpc": "2.0", "id": 3, "method": "command/execute",
                   "params": {"command": "acme.behaviors.hang"}})
        self.send({"jsonrpc": "2.0", "method": "$/cancelRequest", "params": {"id": 3}})
        self.assertEqual(self.receive()["error"]["code"], -32800)

    def test_unknown_command_and_invalid_params(self):
        self.initialize()
        self.send({"jsonrpc": "2.0", "id": 4, "method": "command/execute",
                   "params": {"command": "acme.behaviors.missing"}})
        self.assertEqual(self.receive()["error"]["code"], -32602)
        self.send({"jsonrpc": "2.0", "id": 5, "method": "command/execute", "params": {"command": 1}})
        self.assertEqual(self.receive()["error"]["code"], -32602)

    def test_exits_on_exit_notification_and_on_stdin_eof(self):
        self.initialize()
        self.send({"jsonrpc": "2.0", "method": "exit", "params": {}})
        self.assertEqual(self.child.wait(5), 0)

    def test_exits_when_host_disappears(self):
        self.initialize()
        self.child.stdin.close()
        self.assertEqual(self.child.wait(5), 0)
```

`sdks/python/tests/__init__.py` 是空檔案。

- [ ] **Step 3: 寫 `tools/run-python-tests.mjs` 與根目錄 script，確認測試失敗**

```js
// Runs the Python SDK unit tests with a local Python 3.10+; CI must provide one.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const candidates = [process.env.KOBRIXA_TEST_PYTHON, "python3", "python"].filter(Boolean);
const python = candidates.find(
  (command) =>
    spawnSync(command, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"])
      .status === 0,
);
if (!python) {
  if (process.env.CI) {
    console.error("Python 3.10+ is required in CI. Set KOBRIXA_TEST_PYTHON.");
    process.exit(1);
  }
  console.warn("SKIP Python SDK tests: Python 3.10+ was not found.");
  process.exit(0);
}
const sdk = path.join(root, "sdks/python");
const result = spawnSync(
  python,
  ["-m", "unittest", "discover", "-s", path.join(sdk, "tests"), "-t", sdk, "-v"],
  {
    stdio: "inherit",
    env: { ...process.env, PYTHONPATH: sdk },
  },
);
process.exit(result.status ?? 1);
```

在根目錄 `package.json` 加入 `"test:python-sdk": "node tools/run-python-tests.mjs"`，並把 `test:desktop` 改成 `vitest run --project "!web" && pnpm test:bytecode && pnpm test:release && pnpm test:python-sdk`。

Run: `pnpm test:python-sdk`
Expected: FAIL（`ModuleNotFoundError: kobrixa`）。

- [ ] **Step 4: 實作 `sdks/python`**

`pyproject.toml`：

```toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "kobrixa-plugin-sdk"
version = "0.1.0"
description = "Kobrixa plugin SDK for Python (development preview)"
requires-python = ">=3.10"
dependencies = []

[tool.setuptools]
packages = ["kobrixa"]

[tool.setuptools.package-data]
kobrixa = ["plugin-protocol.schema.json"]
```

`kobrixa/__init__.py`：

```python
"""Kobrixa plugin SDK for Python (development preview)."""
from ._plugin import API_VERSION, CommandContext, Plugin, RpcError

__all__ = ["API_VERSION", "CommandContext", "Plugin", "RpcError"]
```

`kobrixa/_framing.py`：

```python
"""Content-Length framing shared with the Kobrixa host."""

MAX_MESSAGE_BYTES = 1024 * 1024
MAX_HEADER_BYTES = 1024


class FramingError(Exception):
    pass


def _valid_header_line(line: str) -> bool:
    name, separator, value = line.partition(":")
    return bool(separator and name) and all(c.isascii() and (c.isalnum() or c == "-") for c in name) and "\r" not in value


def encode(text: str) -> bytes:
    body = text.encode("utf-8")
    if len(body) > MAX_MESSAGE_BYTES:
        raise FramingError("Message exceeds 1 MiB.")
    return f"Content-Length: {len(body)}\r\n\r\n".encode("ascii") + body


class Decoder:
    def __init__(self) -> None:
        self._buffer = bytearray()

    def push(self, chunk: bytes) -> list[str]:
        self._buffer += chunk
        messages: list[str] = []
        while True:
            end = self._buffer.find(b"\r\n\r\n")
            if (end < 0 and len(self._buffer) > MAX_HEADER_BYTES) or end > MAX_HEADER_BYTES:
                raise FramingError("Message header is too long.")
            if end < 0:
                # Reject stray output such as a single print() line before a terminator arrives.
                *complete, _partial = bytes(self._buffer).decode("latin-1").split("\n")
                for line in complete:
                    if not line.endswith("\r") or not _valid_header_line(line[:-1]):
                        raise FramingError("Malformed message header.")
                return messages
            length = None
            try:
                lines = bytes(self._buffer[:end]).decode("ascii").split("\r\n")
            except UnicodeDecodeError as error:
                raise FramingError("Malformed message header.") from error
            for line in lines:
                if not _valid_header_line(line):
                    raise FramingError("Malformed message header.")
                name, _separator, value = line.partition(":")
                if name.lower() == "content-length":
                    value = value.strip(" \t")
                    if length is not None or not value.isdigit() or len(value) > 10:
                        raise FramingError("Invalid Content-Length.")
                    length = int(value)
            if length is None:
                raise FramingError("Missing Content-Length.")
            if length > MAX_MESSAGE_BYTES:
                raise FramingError("Message exceeds 1 MiB.")
            start = end + 4
            if len(self._buffer) < start + length:
                return messages
            body = bytes(self._buffer[start:start + length])
            del self._buffer[:start + length]
            try:
                messages.append(body.decode("utf-8"))
            except UnicodeDecodeError as error:
                raise FramingError("Message body is not valid UTF-8.") from error
```

`kobrixa/_schema.py`：

```python
"""Validates messages against the committed Kobrixa JSON Schema.

Implements exactly the keywords in packages/plugin-protocol/schema/keywords.json.
String lengths count UTF-16 code units to match the TypeScript host, and an
anchored trailing "$" means end of string, as in ECMAScript.
"""
import json
import re
from functools import lru_cache
from importlib import resources

SUPPORTED_KEYWORDS = frozenset({
    "$schema", "$id", "title", "$defs", "type", "properties", "required",
    "additionalProperties", "enum", "const", "pattern", "minLength", "maxLength",
    "minimum", "maximum", "items", "minItems", "maxItems", "anyOf", "oneOf",
})


class SchemaError(ValueError):
    pass


@lru_cache(maxsize=None)
def _regex(pattern: str) -> "re.Pattern[str]":
    if pattern.endswith("$") and not pattern.endswith("\\$"):
        pattern = pattern[:-1] + r"\Z"
    return re.compile(pattern)


def _utf16_length(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_type(value, name: str) -> bool:
    if name == "integer":
        return _is_number(value) and float(value).is_integer()
    return {
        "number": _is_number(value),
        "string": isinstance(value, str),
        "boolean": isinstance(value, bool),
        "null": value is None,
        "object": isinstance(value, dict),
        "array": isinstance(value, list),
    }[name]


def _equal(left, right) -> bool:
    if isinstance(left, bool) or isinstance(right, bool):
        return left is right
    return left == right


class Validator:
    def __init__(self, document: dict) -> None:
        self._definitions = document["$defs"]

    @classmethod
    def bundled(cls) -> "Validator":
        text = resources.files("kobrixa").joinpath("plugin-protocol.schema.json").read_text("utf-8")
        return cls(json.loads(text))

    def has(self, name: str) -> bool:
        return name in self._definitions

    def validate(self, name: str, value) -> None:
        errors = self._check(self._definitions[name], value, "$")
        if errors:
            raise SchemaError(errors[0])

    def _check(self, schema: dict, value, path: str) -> list:
        unknown = set(schema) - SUPPORTED_KEYWORDS
        if unknown:
            raise SchemaError(f"Unsupported schema keywords: {sorted(unknown)}")
        if "anyOf" in schema and not any(not self._check(item, value, path) for item in schema["anyOf"]):
            return [f"{path}: no alternative matched"]
        if "oneOf" in schema and sum(1 for item in schema["oneOf"] if not self._check(item, value, path)) != 1:
            return [f"{path}: expected exactly one alternative"]
        if "const" in schema and not _equal(value, schema["const"]):
            return [f"{path}: expected {schema['const']!r}"]
        if "enum" in schema and not any(_equal(value, item) for item in schema["enum"]):
            return [f"{path}: expected one of {schema['enum']!r}"]
        if "type" in schema:
            types = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
            if not any(_is_type(value, item) for item in types):
                return [f"{path}: expected {schema['type']}"]
        errors = []
        if isinstance(value, str):
            length = _utf16_length(value)
            if length < schema.get("minLength", 0) or length > schema.get("maxLength", length):
                errors.append(f"{path}: length {length} is out of range")
            if "pattern" in schema and not _regex(schema["pattern"]).search(value):
                errors.append(f"{path}: does not match {schema['pattern']}")
        if _is_number(value):
            if value < schema.get("minimum", value) or value > schema.get("maximum", value):
                errors.append(f"{path}: {value} is out of range")
        if isinstance(value, list):
            if len(value) < schema.get("minItems", 0) or len(value) > schema.get("maxItems", len(value)):
                errors.append(f"{path}: wrong number of items")
            if "items" in schema:
                for index, item in enumerate(value):
                    errors += self._check(schema["items"], item, f"{path}[{index}]")
        if isinstance(value, dict):
            properties = schema.get("properties", {})
            for key in schema.get("required", []):
                if key not in value:
                    errors.append(f"{path}.{key}: is required")
            for key, item in value.items():
                if key in properties:
                    errors += self._check(properties[key], item, f"{path}.{key}")
                elif schema.get("additionalProperties") is False:
                    errors.append(f"{path}.{key}: is not allowed")
                elif isinstance(schema.get("additionalProperties"), dict):
                    errors += self._check(schema["additionalProperties"], item, f"{path}.{key}")
        return errors
```

`kobrixa/_plugin.py`：

```python
"""Python plugin runtime: JSON-RPC 2.0 over stdio with Content-Length framing."""
import asyncio
import json
import sys
import threading

from ._framing import Decoder, FramingError, encode
from ._schema import SchemaError, Validator

API_VERSION = "1.0.0"
SDK_VERSION = "0.1.0"
_CANCELLED, _INVALID_PARAMS, _METHOD_NOT_FOUND, _INTERNAL = -32800, -32602, -32601, -32603


class RpcError(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


class _Ui:
    def __init__(self, plugin: "Plugin") -> None:
        self._plugin = plugin

    async def show_message(self, message: str, severity: str = "info") -> None:
        await self._plugin._request("ui/showMessage", {"severity": severity, "message": message})


class CommandContext:
    def __init__(self, plugin: "Plugin") -> None:
        self.plugin_id = plugin.plugin_id
        self.locale = plugin.locale
        self.ui = _Ui(plugin)


class Plugin:
    def __init__(self) -> None:
        self.plugin_id = ""
        self.locale = "en"
        self._commands = {}
        self._tasks = {}
        self._pending = {}
        self._next_id = 1
        self._validator = Validator.bundled()
        self._stopping = False

    def command(self, command_id: str):
        def register(handler):
            if not asyncio.iscoroutinefunction(handler):
                raise TypeError("Kobrixa command handlers must be async functions.")
            self._commands[command_id] = handler
            return handler
        return register

    def run(self) -> None:
        output = sys.stdout.buffer
        # stdout carries protocol messages only; print() goes to stderr, which Kobrixa logs.
        sys.stdout = sys.stderr
        asyncio.run(self._main(sys.stdin.buffer, output))

    async def _main(self, source, output) -> None:
        self._loop = asyncio.get_running_loop()
        self._output = output
        queue: asyncio.Queue = asyncio.Queue()

        def read() -> None:
            decoder = Decoder()
            try:
                while True:
                    chunk = source.read1(65536)
                    if not chunk:
                        break
                    for text in decoder.push(chunk):
                        self._loop.call_soon_threadsafe(queue.put_nowait, text)
            except (FramingError, OSError, ValueError) as error:
                print(f"kobrixa: stopped reading input: {error}", file=sys.stderr)
            finally:
                self._loop.call_soon_threadsafe(queue.put_nowait, None)

        threading.Thread(target=read, daemon=True).start()
        while not self._stopping:
            text = await queue.get()
            if text is None:
                break  # The host closed stdin: exit so no orphan process remains.
            self._receive(text)
        for task in list(self._tasks.values()):
            task.cancel()

    def _send(self, message: dict) -> None:
        self._output.write(encode(json.dumps(message, ensure_ascii=False, separators=(",", ":"))))
        self._output.flush()

    def _receive(self, text: str) -> None:
        try:
            message = json.loads(text)
            self._validator.validate("message", message)
        except (ValueError, SchemaError) as error:
            print(f"kobrixa: ignored invalid message from host: {error}", file=sys.stderr)
            return
        if "method" in message and "id" in message:
            task = asyncio.ensure_future(self._handle(message))
            self._tasks[message["id"]] = task
            task.add_done_callback(lambda _task, key=message["id"]: self._tasks.pop(key, None))
        elif "method" in message:
            if message["method"] == "$/cancelRequest":
                task = self._tasks.get(message.get("params", {}).get("id"))
                if task:
                    task.cancel()
            elif message["method"] == "exit":
                self._stopping = True
        else:
            future = self._pending.pop(message["id"], None)
            if future and not future.done():
                future.set_result(message)

    async def _handle(self, message: dict) -> None:
        request_id, method = message["id"], message["method"]
        try:
            if not self._validator.has(f"{method}.params") or method == "ui/showMessage":
                raise RpcError(_METHOD_NOT_FOUND, f"Unknown method {method}.")
            params = message.get("params")
            try:
                self._validator.validate(f"{method}.params", params)
            except SchemaError as error:
                raise RpcError(_INVALID_PARAMS, f"Invalid parameters for {method}: {error}") from error
            result = await self._dispatch(method, params)
            self._send({"jsonrpc": "2.0", "id": request_id, "result": result})
        except asyncio.CancelledError:
            self._send({"jsonrpc": "2.0", "id": request_id,
                        "error": {"code": _CANCELLED, "message": f"{method} was cancelled."}})
        except RpcError as error:
            self._send({"jsonrpc": "2.0", "id": request_id,
                        "error": {"code": error.code, "message": str(error)[:2000]}})
        except Exception as error:  # noqa: BLE001 - report handler failures to the host
            self._send({"jsonrpc": "2.0", "id": request_id,
                        "error": {"code": _INTERNAL, "message": str(error)[:2000] or type(error).__name__}})

    async def _dispatch(self, method: str, params: dict):
        if method == "initialize":
            self.plugin_id, self.locale = params["pluginId"], params["locale"]
            return {"apiVersion": API_VERSION, "sdk": {"name": "kobrixa-plugin-sdk", "version": SDK_VERSION}}
        if method == "command/execute":
            handler = self._commands.get(params["command"])
            if handler is None:
                raise RpcError(_INVALID_PARAMS, f"The plugin did not register {params['command']}.")
            await handler(CommandContext(self))
            return None
        if method == "shutdown":
            return None
        raise RpcError(_METHOD_NOT_FOUND, f"Unknown method {method}.")

    async def _request(self, method: str, params: dict):
        self._validator.validate(f"{method}.params", params)
        request_id = self._next_id
        self._next_id += 1
        future = self._loop.create_future()
        self._pending[request_id] = future
        self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        try:
            reply = await asyncio.wait_for(future, 10)
        finally:
            self._pending.pop(request_id, None)
        if "error" in reply:
            raise RpcError(reply["error"]["code"], reply["error"]["message"])
        self._validator.validate(f"{method}.result", reply["result"])
        return reply["result"]
```

Python 端的取消會 cancel 執行處理器的 Task，處理器會收到 `asyncio.CancelledError`。這是 Python 對應 `AbortSignal` 的慣用做法（設計 §5.2）。

- [ ] **Step 5: 建立 Python 範例插件**

`plugins/samples/hello-python/kobrixa-plugin.json` 的格式與 TS 範例相同，差別如下：id 為 `kobrixa-samples.hello-python`；runtime 為 `{ "kind": "python", "entry": "main.py" }`；displayName 為 `{ "en": "Hello (Python sample)", "zh-TW": "問候（Python 範例）" }`；命令 id 為 `kobrixa-samples.hello-python.greet`；activationEvents 也跟著改。

`plugins/samples/hello-python/main.py`：

```python
from kobrixa import Plugin

plugin = Plugin()


@plugin.command("kobrixa-samples.hello-python.greet")
async def greet(ctx):
    await ctx.ui.show_message("來自 Python 插件的問候" if ctx.locale == "zh-TW" else "Hello from a Python plugin")


if __name__ == "__main__":
    plugin.run()
```

- [ ] **Step 6: 執行 Python 測試，確認通過**

Run: `pnpm test:python-sdk`
Expected: PASS（所有 unittest 都是 `ok`）。

- [ ] **Step 7: 寫 TS↔Python 互通測試**

`packages/plugin-runtime/src/test-python.ts`：

```ts
import { spawnSync } from "node:child_process";

/** Test helper: a Python 3.10+ command, or undefined outside CI. */
export function findPython(): string | undefined {
  const candidates = [process.env.KOBRIXA_TEST_PYTHON, "python3", "python"].filter(
    (item): item is string => Boolean(item),
  );
  const found = candidates.find(
    (command) =>
      spawnSync(command, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"])
        .status === 0,
  );
  if (!found && process.env.CI)
    throw new Error("Python 3.10+ is required in CI. Set KOBRIXA_TEST_PYTHON.");
  return found;
}
```

`packages/plugin-runtime/src/python.interop.test.ts`：

```ts
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PluginManager, spawnPluginProcess, type PluginNotice } from "./index.js";
import { findPython } from "./test-python.js";

const python = findPython();
const repository = fileURLToPath(new URL("../../../", import.meta.url));
let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-python-"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe.skipIf(!python)("Python plugin interop", () => {
  it("runs the Python sample from a folder with spaces and Chinese characters", async () => {
    const directory = path.join(root, "插件 測試", "hello-python");
    await cp(path.join(repository, "plugins/samples/hello-python"), directory, { recursive: true });
    const notices: PluginNotice[] = [];
    const manager = await PluginManager.create({
      sources: [{ kind: "development", directory }],
      store: { load: async () => new Set(), save: async () => {} },
      safeMode: false,
      locale: "zh-TW",
      launcher: (plugin) =>
        spawnPluginProcess(python!, ["-u", plugin.entry], {
          cwd: plugin.directory,
          env: {
            ...process.env,
            PYTHONPATH: path.join(repository, "sdks/python"),
            PYTHONIOENCODING: "utf-8",
          },
        }),
    });
    manager.onEvent((event) => {
      if (event.type === "notice") notices.push(event.notice);
    });
    expect(await manager.executeCommand("kobrixa-samples.hello-python.greet")).toEqual({
      ok: true,
    });
    expect(notices.map((notice) => [notice.pluginId, notice.message])).toEqual([
      ["kobrixa-samples.hello-python", "來自 Python 插件的問候"],
    ]);
    await manager.dispose();
    expect(manager.state().plugins[0]!.running).toBe(false);
  });
});
```

Run: `pnpm vitest run --project @kobrixa/plugin-runtime src/python.interop.test.ts`
Expected: PASS。若本機沒有 Python 3.10+，測試會顯示 skipped；CI 一定會執行。

- [ ] **Step 8: Commit**

```bash
git add sdks/python plugins/samples/hello-python tools/run-python-tests.mjs packages/plugin-runtime packages/plugin-protocol .prettierignore .gitignore package.json
git commit -m "feat(sdk-python): add development Python SDK with shared conformance cases"
```

---

### Task 12: 桌面主程序：選項、狀態檔、啟動器、IPC 與 preload

**Files:**

- Create: `apps/desktop/src/main/plugins/options.ts`、`state-store.ts`、`launchers.ts`、`ipc.ts`
- Create: `apps/desktop/src/shared/plugins.ts`
- Modify: `apps/desktop/src/shared/api.ts`（`KobrixaApi.plugins`）、`apps/desktop/src/preload/index.ts`、`apps/desktop/package.json`（依賴）
- Test: `apps/desktop/src/main/plugins/options.test.ts`、`state-store.test.ts`、`ipc.test.ts`

**Interfaces:**

- Consumes: `PluginManager`、`PluginStateStore`、`PluginLauncher`、`spawnPluginProcess`、`OutputTail`、`ExitSignal`、`PluginError`、`namespacedIdSchema`
- Produces:
  - `pluginOptions(commandLine: { getSwitchValue(name: string): string; hasSwitch(name: string): boolean }, cwd?: string): PluginOptions`，其中 `PluginOptions = { developmentDirectories: string[]; python?: string; safeMode: boolean }`
  - `filePluginStateStore(userData: string): PluginStateStore`（檔案為 `<userData>/plugins/state.json`）
  - `createDesktopLauncher({ python?: string }): PluginLauncher`
  - `pluginLocale(appLocale: string): PluginLocale`
  - `registerPluginIpc(handle: IpcHandle, plugins: Pick<PluginManager, "state" | "executeCommand" | "setEnabled" | "onEvent">, publish: (event: PluginEvent) => void): () => void`
  - IPC channel：`plugins:state`、`plugins:execute`、`plugins:set-enabled`；事件 channel：`plugins:event`
  - `shared/plugins.ts`：`PluginsApi { state(): Promise<PluginsSnapshot>; execute(commandId: string): Promise<PluginCommandResult>; setEnabled(pluginId: string, enabled: boolean): Promise<PluginActionResult>; onEvent(listener: (event: PluginEvent) => void): () => void }`，`PluginEvent = PluginManagerEvent`，並重新匯出 runtime 的相關型別

命令列開關（只做開發模式；路徑用 `path.delimiter` 分隔，Windows 是 `;`，其他平台是 `:`）：

- `--plugin-dev-dir=<資料夾>[<分隔符>…]`：要載入的開發插件資料夾。
- `--plugin-python=<直譯器>`：Python 開發插件使用的 interpreter；沒指定時，Python 插件執行會回報 `PLUGIN_E_LAUNCH`。
- `--safe-mode`：本次啟動停用所有開發插件，不改變已儲存的設定。

- [ ] **Step 1: 加入依賴**

在 `apps/desktop/package.json` 的 dependencies 加入 `"@kobrixa/plugin-protocol": "workspace:*"` 與 `"@kobrixa/plugin-runtime": "workspace:*"`，然後執行 `pnpm install`。

- [ ] **Step 2: 寫會失敗的測試**

`options.test.ts`：

```ts
import path from "node:path";
import { expect, it } from "vitest";
import { pluginLocale, pluginOptions } from "./options.js";

const commandLine = (switches: Record<string, string>) => ({
  getSwitchValue: (name: string) => switches[name] ?? "",
  hasSwitch: (name: string) => name in switches,
});

it("parses development folders, interpreter and safe mode", () => {
  const value = pluginOptions(
    commandLine({
      "plugin-dev-dir": ["a", "/abs/b", "a", ""].join(path.delimiter),
      "plugin-python": " /usr/bin/python3 ",
      "safe-mode": "",
    }),
    "/work",
  );
  expect(value).toEqual({
    developmentDirectories: [path.resolve("/work", "a"), path.resolve("/abs/b")],
    python: "/usr/bin/python3",
    safeMode: true,
  });
  expect(pluginOptions(commandLine({}))).toEqual({ developmentDirectories: [], safeMode: false });
});

it("maps the application locale", () => {
  expect(pluginLocale("zh-TW")).toBe("zh-TW");
  expect(pluginLocale("zh-HK")).toBe("zh-TW");
  expect(pluginLocale("en-US")).toBe("en");
});
```

`state-store.test.ts`：

```ts
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { filePluginStateStore } from "./state-store.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-plugin-state-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

it("round-trips the disabled set atomically", async () => {
  const store = filePluginStateStore(root);
  expect(await store.load()).toEqual(new Set());
  await store.save(new Set(["b.x", "a.x"]));
  expect(JSON.parse(await readFile(path.join(root, "plugins/state.json"), "utf8"))).toEqual({
    schemaVersion: 1,
    disabled: ["a.x", "b.x"],
  });
  expect(await store.load()).toEqual(new Set(["a.x", "b.x"]));
});

it("treats an unreadable or invalid file as empty", async () => {
  await mkdir(path.join(root, "plugins"));
  await writeFile(path.join(root, "plugins/state.json"), "{broken");
  expect(await filePluginStateStore(root).load()).toEqual(new Set());
});
```

`ipc.test.ts`：

```ts
import { expect, it, vi } from "vitest";
import type { IpcHandle } from "../ipc.js";
import { registerPluginIpc } from "./ipc.js";

it("validates renderer input before reaching the plugin manager", async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const handle = ((channel, action) => handlers.set(channel, action as never)) as IpcHandle;
  const manager = {
    state: vi.fn(() => ({ safeMode: false, developmentMode: false, plugins: [] })),
    executeCommand: vi.fn(async () => ({ ok: true as const })),
    setEnabled: vi.fn(async () => ({
      ok: true as const,
      state: { safeMode: false, developmentMode: false, plugins: [] },
    })),
    onEvent: vi.fn(() => () => {}),
  };
  const publish = vi.fn();
  registerPluginIpc(handle, manager, publish);
  expect(await handlers.get("plugins:execute")!({}, "acme.hello.greet")).toEqual({ ok: true });
  expect(() => handlers.get("plugins:execute")!({}, "../../etc")).toThrow();
  expect(() => handlers.get("plugins:set-enabled")!({}, "acme.hello", "yes")).toThrow();
  await handlers.get("plugins:set-enabled")!({}, "acme.hello", false);
  expect(manager.setEnabled).toHaveBeenCalledWith("acme.hello", false);
  expect(manager.onEvent).toHaveBeenCalledWith(publish);
});
```

- [ ] **Step 3: 執行測試，確認失敗**

Run: `pnpm vitest run --project desktop src/main/plugins`
Expected: FAIL（模組不存在）。

- [ ] **Step 4: 實作四個主程序模組**

`options.ts`：

```ts
import path from "node:path";
import type { PluginLocale } from "@kobrixa/plugin-protocol";

export interface PluginOptions {
  developmentDirectories: string[];
  python?: string;
  safeMode: boolean;
}
interface CommandLine {
  getSwitchValue(name: string): string;
  hasSwitch(name: string): boolean;
}

/** Development plugins load only from folders named explicitly on the command line. */
export function pluginOptions(commandLine: CommandLine, cwd = process.cwd()): PluginOptions {
  const directories = commandLine
    .getSwitchValue("plugin-dev-dir")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(cwd, item));
  const python = commandLine.getSwitchValue("plugin-python").trim();
  return {
    developmentDirectories: [...new Set(directories)],
    ...(python ? { python } : {}),
    safeMode: commandLine.hasSwitch("safe-mode"),
  };
}

export const pluginLocale = (appLocale: string): PluginLocale =>
  appLocale.toLowerCase().startsWith("zh") ? "zh-TW" : "en";
```

`state-store.ts`：

```ts
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PluginStateStore } from "@kobrixa/plugin-runtime";

const stateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  disabled: z.array(z.string().max(128)).max(1000),
});

export function filePluginStateStore(userData: string): PluginStateStore {
  const file = path.join(userData, "plugins", "state.json");
  return {
    async load() {
      try {
        const parsed = stateSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
        return new Set(parsed.success ? parsed.data.disabled : []);
      } catch {
        return new Set(); // First launch or unreadable state: nothing is disabled.
      }
    },
    async save(disabled) {
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(
        temporary,
        JSON.stringify({ schemaVersion: 1, disabled: [...disabled].sort() }),
        { mode: 0o600 },
      );
      await rename(temporary, file);
    },
  };
}
```

`launchers.ts`（Electron 專用，task 15 的 smoke 會實際執行）：

```ts
import { MessageChannelMain, utilityProcess } from "electron";
import {
  ExitSignal,
  OutputTail,
  PluginError,
  spawnPluginProcess,
  type LaunchablePlugin,
  type PluginLauncher,
  type PluginProcess,
} from "@kobrixa/plugin-runtime";

async function launchNode(plugin: LaunchablePlugin): Promise<PluginProcess> {
  const child = utilityProcess.fork(plugin.entry, [], {
    cwd: plugin.directory,
    serviceName: `Kobrixa plugin ${plugin.id}`,
    stdio: "pipe",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("exit", (code) =>
      reject(new Error(`The plugin process exited during launch (code ${code}).`)),
    );
  });
  const { port1, port2 } = new MessageChannelMain();
  child.postMessage({ type: "kobrixa-plugin-port" }, [port2]);
  port1.start();
  const tail = new OutputTail();
  child.stdout?.on("data", (chunk: Buffer) => tail.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => tail.push(chunk));
  const exits = new ExitSignal();
  child.once("exit", (code) => {
    port1.close();
    exits.emit({ code });
  });
  return {
    send: (text) => port1.postMessage(text),
    onMessage: (listener) => {
      const handler = (event: Electron.MessageEvent) =>
        listener(typeof event.data === "string" ? event.data : "");
      port1.on("message", handler);
      return () => port1.off("message", handler);
    },
    onExit: (listener) => exits.subscribe(listener),
    kill: () => {
      child.kill();
    },
    stderrTail: () => tail.text(),
  };
}

export function createDesktopLauncher(options: { python?: string }): PluginLauncher {
  return async (plugin) => {
    if (plugin.runtime === "node") return launchNode(plugin);
    if (!options.python)
      throw new PluginError(
        "PLUGIN_E_LAUNCH",
        "Start Kobrixa with --plugin-python=<interpreter> to run Python development plugins.",
      );
    return spawnPluginProcess(options.python, ["-u", plugin.entry], {
      cwd: plugin.directory,
      env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });
  };
}
```

`ipc.ts`：

```ts
import { z } from "zod";
import { namespacedIdSchema } from "@kobrixa/plugin-protocol";
import type { PluginManager } from "@kobrixa/plugin-runtime";
import type { PluginEvent } from "../../shared/plugins.js";
import type { IpcHandle } from "../ipc.js";

export function registerPluginIpc(
  handle: IpcHandle,
  plugins: Pick<PluginManager, "state" | "executeCommand" | "setEnabled" | "onEvent">,
  publish: (event: PluginEvent) => void,
): () => void {
  handle("plugins:state", () => plugins.state());
  handle("plugins:execute", (_event, commandId: unknown) =>
    plugins.executeCommand(namespacedIdSchema.parse(commandId)),
  );
  handle("plugins:set-enabled", (_event, pluginId: unknown, enabled: unknown) =>
    plugins.setEnabled(namespacedIdSchema.parse(pluginId), z.boolean().parse(enabled)),
  );
  return plugins.onEvent(publish);
}
```

- [ ] **Step 5: 共用型別與 preload**

`apps/desktop/src/shared/plugins.ts`：

```ts
import type {
  PluginActionResult,
  PluginCommandResult,
  PluginManagerEvent,
  PluginNotice,
  PluginsSnapshot,
  PluginSummary,
} from "@kobrixa/plugin-runtime";
import type { LocalizedText } from "@kobrixa/plugin-protocol";

export type {
  LocalizedText,
  PluginActionResult,
  PluginCommandResult,
  PluginNotice,
  PluginsSnapshot,
  PluginSummary,
};
export type PluginEvent = PluginManagerEvent;
export interface PluginsApi {
  state(): Promise<PluginsSnapshot>;
  execute(commandId: string): Promise<PluginCommandResult>;
  setEnabled(pluginId: string, enabled: boolean): Promise<PluginActionResult>;
  onEvent(listener: (event: PluginEvent) => void): () => void;
}
```

在 `shared/api.ts` 的 `KobrixaApi` 介面加入 `plugins: PluginsApi;`，並從 `./plugins.js` 匯入型別。在 `preload/index.ts` 的 `api` 物件中，`documentation` 之前加入：

```ts
  plugins: {
    state: () => ipcRenderer.invoke("plugins:state"),
    execute: (commandId) => ipcRenderer.invoke("plugins:execute", commandId),
    setEnabled: (pluginId, enabled) => ipcRenderer.invoke("plugins:set-enabled", pluginId, enabled),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, value: PluginEvent) => listener(value);
      ipcRenderer.on("plugins:event", handler);
      return () => ipcRenderer.removeListener("plugins:event", handler);
    },
  },
```

同時在 preload 加入 `import type { PluginEvent } from "../shared/plugins.js";`。`tests/desktop/preload.cjs` 是 UI smoke 用的假 preload；如果 `pnpm check:desktop` 或 smoke 因為缺少 `plugins` 而失敗，就在它的 `api` 中加入回傳空狀態的假實作：`state` 回傳 `{ safeMode: false, developmentMode: false, plugins: [] }`，`onEvent` 回傳 `() => {}`。

- [ ] **Step 6: 執行測試與型別檢查**

Run: `pnpm vitest run --project desktop src/main/plugins && pnpm --filter "@kobrixa/desktop..." -r check`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add apps/desktop pnpm-lock.yaml tests/desktop/preload.cjs
git commit -m "feat(desktop): add plugin launchers, state store, IPC and preload API"
```

---

### Task 13: 插件化 Basic Plus 編譯入口，並在主程序組裝插件系統

**Files:**

- Create: `plugins/basic-plus/kobrixa-plugin.json`
- Create: `apps/desktop/src/main/plugins/builtin.ts`、`apps/desktop/src/main/workspace/builtin-frontends.ts`
- Modify: `apps/desktop/src/main/workspace/build-protocol.ts`、`build-worker.ts`、`build.ts`、`apps/desktop/src/main/index.ts`
- Test: `apps/desktop/src/main/workspace/build.test.ts`（新增測試）、`apps/desktop/src/main/plugins/builtin.test.ts`

**Interfaces:**

- Consumes: `PluginManager.frontendFor`、`PluginManager.create`、task 12 的所有輸出
- Produces:
  - `BUILTIN_PLUGIN_SOURCES: readonly PluginSource[]`
  - `BUILTIN_FRONTENDS: Readonly<Record<string, () => LanguageFrontend>>`，鍵為插件 id
  - `BuildRequest.frontend: string`（插件 id）
  - `BuildService` 建構子新增第四個參數：`frontendFor: (language: string) => string | undefined`

- [ ] **Step 1: 寫會失敗的測試**

`plugins/basic-plus/kobrixa-plugin.json`：

```json
{
  "id": "kobrixa.basic-plus",
  "version": "1.0.0",
  "apiVersion": "^1.0.0",
  "displayName": { "en": "Basic Plus", "zh-TW": "Basic Plus" },
  "runtime": { "kind": "builtin" },
  "contributes": { "frontends": [{ "language": "bp" }] }
}
```

`apps/desktop/src/main/plugins/builtin.test.ts`：

```ts
import { expect, it } from "vitest";
import { loadPlugins } from "@kobrixa/plugin-runtime";
import { BUILTIN_FRONTENDS } from "../workspace/builtin-frontends.js";
import { BUILTIN_PLUGIN_SOURCES } from "./builtin.js";

it("registers Basic Plus as a valid built-in frontend with an implementation", async () => {
  const plugins = await loadPlugins(BUILTIN_PLUGIN_SOURCES, {
    disabled: new Set(),
    safeMode: true,
  });
  expect(plugins.map((plugin) => [plugin.id, plugin.status])).toEqual([
    ["kobrixa.basic-plus", "enabled"],
  ]);
  for (const plugin of plugins) expect(BUILTIN_FRONTENDS[plugin.id]).toBeTypeOf("function");
});
```

在 `apps/desktop/src/main/workspace/build.test.ts` 中加入兩個測試，沿用該檔案既有的 `service`、`events`、`root` 與 worker 建構方式：

```ts
it("asks the plugin registry for the project's frontend", async () => {
  const requests: BuildRequest[] = [];
  service = new BuildService(
    { project: async (_id, overlays) => (await loadProject(root, overlays, "main.bp")).project! },
    () =>
      ({
        isDestroyed: () => false,
        send: (_channel: string, event: BuildEvent) => events.push(event),
      }) as unknown as WebContents,
    (request) => {
      requests.push(request);
      return new Worker(path.join(workerRoot, "worker.cjs"), { workerData: request });
    },
    (language) => (language === "bp" ? "kobrixa.basic-plus" : undefined),
  );
  await service.start("project", {});
  await vi.waitFor(() => expect(events.some((event) => event.type === "complete")).toBe(true));
  expect(requests[0]!.frontend).toBe("kobrixa.basic-plus");
  expect(events.find((event) => event.type === "complete")).toMatchObject({
    result: { success: true },
  });
});

it("fails the build clearly when no enabled plugin provides the language", async () => {
  service = new BuildService(
    { project: async (_id, overlays) => (await loadProject(root, overlays, "main.bp")).project! },
    () =>
      ({
        isDestroyed: () => false,
        send: (_channel: string, event: BuildEvent) => events.push(event),
      }) as unknown as WebContents,
    (request) => new Worker(path.join(workerRoot, "worker.cjs"), { workerData: request }),
    () => undefined,
  );
  await service.start("project", {});
  await vi.waitFor(() => expect(events.some((event) => event.type === "complete")).toBe(true));
  expect(events.find((event) => event.type === "complete")).toMatchObject({
    result: {
      success: false,
      diagnostics: [
        {
          code: "BUILD9000",
          message: expect.stringContaining('No enabled plugin provides language "bp"'),
        },
      ],
    },
  });
});
```

如果該檔案的 `beforeEach` 只建立一次 `service`，請在 `afterEach` 確認它會 dispose 這兩個測試建立的 service，寫法參照檔案中已有的清理方式。

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pnpm vitest run --project desktop src/main/workspace/build.test.ts src/main/plugins/builtin.test.ts`
Expected: FAIL（`builtin.js` 不存在；`BuildService` 只有三個參數）。

- [ ] **Step 3: 實作**

`apps/desktop/src/main/plugins/builtin.ts`：

```ts
import type { PluginSource } from "@kobrixa/plugin-runtime";
import basicPlus from "../../../../../plugins/basic-plus/kobrixa-plugin.json" with { type: "json" };

/** Built-in manifests are bundled and validated by the same registry as development plugins. */
export const BUILTIN_PLUGIN_SOURCES: readonly PluginSource[] = [
  { kind: "builtin", manifest: basicPlus },
];
```

`apps/desktop/src/main/workspace/builtin-frontends.ts`：

```ts
import type { LanguageFrontend } from "@kobrixa/compiler";
import { BasicPlusFrontend } from "@kobrixa/basic-plus";

/** In-process implementations for built-in frontend plugins, keyed by plugin id. */
export const BUILTIN_FRONTENDS: Readonly<Record<string, () => LanguageFrontend>> = {
  "kobrixa.basic-plus": () => new BasicPlusFrontend(),
};
```

`build-protocol.ts` 的 `BuildRequest` 加入欄位與註解：

```ts
/** Plugin id of the frontend selected by the plugin registry; unknown ids fail the build. */
frontend: string;
```

`build-worker.ts`：移除 `import { BasicPlusFrontend } from "@kobrixa/basic-plus";`，改成 `import { BUILTIN_FRONTENDS } from "./builtin-frontends.js";`，並把 `const frontend = new BasicPlusFrontend();` 換成：

```ts
const create = BUILTIN_FRONTENDS[request.frontend];
if (!create)
  throw new Error(`No enabled plugin provides language "${request.project.manifest.language}".`);
const frontend = create();
```

worker 頂層 throw 會觸發既有的 `worker.once("error")` → `fail(message)` 路徑，產生 `BUILD9000` 診斷，不需要新增診斷碼。

`build.ts`：建構子加入第四個參數：

```ts
    private readonly frontendFor: (language: string) => string | undefined = () => "kobrixa.basic-plus",
```

在 `start()` 建立 worker 時傳入 `frontend: this.frontendFor(project.manifest.language) ?? ""`。

`apps/desktop/src/main/index.ts`：

1. 匯入：

```ts
import { PluginManager } from "@kobrixa/plugin-runtime";
import { BUILTIN_PLUGIN_SOURCES } from "./plugins/builtin.js";
import { createDesktopLauncher } from "./plugins/launchers.js";
import { pluginLocale, pluginOptions } from "./plugins/options.js";
import { filePluginStateStore } from "./plugins/state-store.js";
import { registerPluginIpc } from "./plugins/ipc.js";
```

2. 在 `const workspaces = new WorkspaceService();` 之後加入：

```ts
const pluginSettings = pluginOptions(app.commandLine);
const plugins = await PluginManager.create({
  sources: [
    ...BUILTIN_PLUGIN_SOURCES,
    ...pluginSettings.developmentDirectories.map((directory) => ({
      kind: "development" as const,
      directory,
    })),
  ],
  store: filePluginStateStore(app.getPath("userData")),
  safeMode: pluginSettings.safeMode,
  launcher: createDesktopLauncher(pluginSettings),
  locale: pluginLocale(app.getLocale()),
});
```

3. 把 `new BuildService(workspaces, renderer)` 改成 `new BuildService(workspaces, renderer, undefined, (language) => plugins.frontendFor(language))`。
4. 在既有的 `app.on("will-quit", () => { ... })` 區塊內加入 `void plugins.dispose();`。
5. `send` helper 宣告之後，才能把 IPC 模組加進 `registerIpc(...)` 最後的 modules 陣列：`(handle) => { registerPluginIpc(handle, plugins, (event) => send("plugins:event", event)); }`。

- [ ] **Step 4: 執行測試與檢查**

Run: `pnpm build:core && pnpm vitest run --project desktop && pnpm --filter "@kobrixa/desktop..." -r check && pnpm test:bytecode`
Expected: PASS，既有範例與 bytecode 測試也都通過。如果 Vite 或 esbuild 不接受 `with { type: "json" }`，先確認版本；不要改成在執行時讀檔，否則 manifest 不會被打包進去。

- [ ] **Step 5: Commit**

```bash
git add plugins/basic-plus apps/desktop
git commit -m "feat(desktop): select the Basic Plus frontend through the plugin registry"
```

---

### Task 14: 設定頁的插件面板

**Files:**

- Create: `apps/desktop/src/renderer/settings/plugins-panel.tsx`、`plugin-copy.ts`
- Modify: `apps/desktop/src/renderer/settings/settings-catalog.ts`（`CATEGORY_LABELS` 加入 `plugins`）、`settings-panel.tsx`（導覽列與內容）
- Test: `apps/desktop/src/renderer/settings/plugins-panel.test.ts`

**Interfaces:**

- Consumes: `window.kobrixa.plugins`（`PluginsApi`）、`PluginsSnapshot`、`PluginSummary`、`PluginNotice`、`LocalizedText`、`Locale`
- Produces: `PluginsPanel({ locale })`、`localizedText(text: LocalizedText, locale: Locale): string`、`problemText(problem: { code: string; message: string }, locale): string`、`pluginCopy`

面板內容：

1. 固定顯示「可信任的本機插件」警告，不得把權限描述成沙箱。
2. 未啟用開發模式時，顯示啟動方式說明（`--plugin-dev-dir`、`--plugin-python`）。
3. 安全模式橫幅。
4. 每個插件顯示：名稱、id、版本、來源、runtime、狀態、問題（以錯誤碼對應的雙語說明加上原始訊息）、命令按鈕（只有 enabled 時可按）、啟停按鈕（只限開發插件；安全模式下顯示「重新啟動後也保持停用」）。
5. 最近 20 則通知，標明 plugin id。

- [ ] **Step 1: 寫會失敗的測試**

```ts
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginEvent, PluginsSnapshot } from "../../shared/plugins.js";
import { PluginsPanel } from "./plugins-panel.js";

let root: Root;
let container: HTMLDivElement;
let emit: (event: PluginEvent) => void;
const snapshot: PluginsSnapshot = {
  safeMode: false,
  developmentMode: true,
  plugins: [
    {
      id: "kobrixa.basic-plus",
      source: "builtin",
      runtime: "builtin",
      version: "1.0.0",
      status: "enabled",
      running: false,
      problems: [],
      commands: [],
      displayName: "Basic Plus",
    },
    {
      id: "acme.hello",
      source: "development",
      runtime: "python",
      version: "1.0.0",
      status: "enabled",
      running: false,
      problems: [{ code: "PLUGIN_E_LAUNCH", message: "python not found" }],
      commands: [{ id: "acme.hello.greet", title: { en: "Greet", "zh-TW": "打招呼" } }],
    },
  ],
};
const api = {
  state: vi.fn(async () => snapshot),
  execute: vi.fn(async () => ({
    ok: false as const,
    code: "PLUGIN_E_LAUNCH" as const,
    message: "python not found",
  })),
  setEnabled: vi.fn(async () => ({
    ok: true as const,
    state: {
      ...snapshot,
      plugins: [
        snapshot.plugins[0]!,
        {
          ...snapshot.plugins[1]!,
          status: "disabled" as const,
          disabledBy: "user" as const,
          commands: [],
        },
      ],
    },
  })),
  onEvent: vi.fn((listener: (event: PluginEvent) => void) => {
    emit = listener;
    return () => {};
  }),
};
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(window, { kobrixa: { plugins: api } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const render = async () => {
  await act(async () => root.render(createElement(PluginsPanel, { locale: "zh-TW" })));
};
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(text))!;

it("lists plugins in Traditional Chinese with the trust warning and problems", async () => {
  await render();
  expect(container.textContent).toContain("並不是沙箱");
  expect(container.textContent).toContain("acme.hello");
  expect(container.textContent).toContain("找不到 Python");
  expect(button("打招呼").disabled).toBe(false);
});

it("runs a command and shows the translated failure", async () => {
  await render();
  await act(async () => button("打招呼").click());
  expect(api.execute).toHaveBeenCalledWith("acme.hello.greet");
  expect(container.querySelector("[role=alert]")?.textContent).toContain("python not found");
});

it("disables development plugins but never offers it for built-ins", async () => {
  await render();
  const toggles = [...container.querySelectorAll("button")].filter(
    (item) => item.textContent === "停用",
  );
  expect(toggles).toHaveLength(1);
  await act(async () => toggles[0]!.click());
  expect(api.setEnabled).toHaveBeenCalledWith("acme.hello", false);
  expect(container.textContent).toContain("已停用");
});

it("shows notices with their plugin id", async () => {
  await render();
  await act(async () =>
    emit({
      type: "notice",
      notice: { pluginId: "acme.hello", severity: "info", message: "哈囉", at: 0 },
    }),
  );
  expect(container.querySelector("[aria-live=polite]")?.textContent).toContain("acme.hello");
  expect(container.querySelector("[aria-live=polite]")?.textContent).toContain("哈囉");
});

it("explains how to load development plugins and safe mode", async () => {
  api.state.mockResolvedValueOnce({
    safeMode: true,
    developmentMode: false,
    plugins: [snapshot.plugins[0]!],
  });
  await render();
  expect(container.textContent).toContain("--plugin-dev-dir");
  expect(container.textContent).toContain("安全模式");
});
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pnpm vitest run --project desktop src/renderer/settings/plugins-panel.test.ts`
Expected: FAIL（模組不存在）。

- [ ] **Step 3: 實作 `plugin-copy.ts`**

```ts
import type { Locale } from "../i18n/copy.js";

export const pluginCopy = {
  en: {
    trust:
      "Development plugins run as normal programs on this computer. Kobrixa permissions only limit what a plugin asks Kobrixa to do; they are not a sandbox. Load only plugins you trust.",
    howTo:
      "To load development plugins, start Kobrixa with --plugin-dev-dir=<folder>. Python plugins also need --plugin-python=<interpreter>.",
    safeMode:
      "Safe mode: development plugins are off for this session. Disable a problem plugin here, then restart normally.",
    loading: "Loading plugins…",
    builtin: "Built-in",
    development: "Development",
    status: {
      enabled: "Enabled",
      disabled: "Disabled",
      invalid: "Cannot load",
      failed: "Stopped after errors",
    },
    running: "Running",
    enable: "Enable",
    disable: "Disable",
    keepDisabled: "Keep disabled after restart",
    commands: "Commands",
    notices: "Messages from plugins",
    noNotices: "No messages yet.",
  },
  "zh-TW": {
    trust:
      "開發插件會以一般程式身分在這部電腦執行。Kobrixa 權限只限制插件透過 Kobrixa 提出的要求，並不是沙箱。請只載入你信任的插件。",
    howTo:
      "要載入開發插件，請以 --plugin-dev-dir=<資料夾> 啟動 Kobrixa；Python 插件另需 --plugin-python=<直譯器>。",
    safeMode: "安全模式：本次啟動已關閉所有開發插件。可以在這裡停用有問題的插件，再正常重新啟動。",
    loading: "正在載入插件…",
    builtin: "內建",
    development: "開發",
    status: {
      enabled: "已啟用",
      disabled: "已停用",
      invalid: "無法載入",
      failed: "多次出錯後已停止",
    },
    running: "執行中",
    enable: "啟用",
    disable: "停用",
    keepDisabled: "重新啟動後也保持停用",
    commands: "命令",
    notices: "插件訊息",
    noNotices: "目前沒有訊息。",
  },
} as const;

const problems: Record<string, readonly [zh: string, en: string]> = {
  PLUGIN_E_MANIFEST: ["kobrixa-plugin.json 無效", "kobrixa-plugin.json is invalid"],
  PLUGIN_E_API_VERSION: [
    "插件需要其他版本的插件 API",
    "The plugin needs a different plugin API version",
  ],
  PLUGIN_E_DUPLICATE_ID: ["另一個插件已使用相同 id", "Another plugin uses the same id"],
  PLUGIN_E_COMMAND_NAMESPACE: [
    "命令 id 必須以插件 id 開頭",
    "Command ids must start with the plugin id",
  ],
  PLUGIN_E_DUPLICATE_COMMAND: ["命令重複宣告", "A command is declared twice"],
  PLUGIN_E_ACTIVATION: ["啟用事件指向不存在的命令", "An activation event names a missing command"],
  PLUGIN_E_RUNTIME_NOT_ALLOWED: ["不允許的執行方式", "This runtime is not allowed"],
  PLUGIN_E_FRONTEND_REQUIRES_BUILTIN: [
    "目前只有內建插件能提供編譯前端",
    "Only built-in plugins can provide compiler frontends for now",
  ],
  PLUGIN_E_ENTRY: [
    "找不到入口檔，或入口檔在插件資料夾外",
    "The entry file is missing or outside the plugin folder",
  ],
  PLUGIN_E_LAUNCH: [
    "無法啟動插件（例如找不到 Python）",
    "The plugin could not start (for example, Python was not found)",
  ],
  PLUGIN_E_HANDSHAKE: ["插件啟動握手失敗", "The plugin failed its startup handshake"],
  PLUGIN_E_PROTOCOL: [
    "插件送出無效的協定資料（日誌請寫到 stderr）",
    "The plugin sent invalid protocol data (write logs to stderr)",
  ],
  PLUGIN_E_UNRESPONSIVE: [
    "插件取消後沒有回應，已被終止",
    "The plugin did not respond to cancellation and was stopped",
  ],
  PLUGIN_E_CRASHED: [
    "插件意外結束；命令不會自動重試",
    "The plugin exited unexpectedly; the command is not retried",
  ],
  PLUGIN_E_CRASH_LOOP: [
    "插件多次出錯，停用再啟用後才會重新啟動",
    "The plugin failed repeatedly; disable and enable it to try again",
  ],
  PLUGIN_E_TIMEOUT: ["命令逾時", "The command timed out"],
  PLUGIN_E_CANCELLED: ["命令已取消", "The command was cancelled"],
  PLUGIN_E_COMMAND_FAILED: ["命令執行失敗", "The command failed"],
  PLUGIN_E_UNKNOWN_COMMAND: [
    "沒有已啟用的插件提供這個命令",
    "No enabled plugin provides this command",
  ],
  PLUGIN_E_UNKNOWN_PLUGIN: ["找不到插件", "Plugin not found"],
  PLUGIN_E_DISABLED: ["插件正在停止", "The plugin is stopping"],
  PLUGIN_E_BUILTIN_REQUIRED: ["內建插件不能停用", "Built-in plugins cannot be disabled"],
  PLUGIN_E_SAFE_MODE: [
    "安全模式下不能啟用開發插件",
    "Development plugins cannot be enabled in safe mode",
  ],
  PLUGIN_E_STATE_SAVE: ["無法儲存插件設定", "Plugin settings could not be saved"],
};

export function problemText(problem: { code: string; message: string }, locale: Locale): string {
  const text = problems[problem.code];
  const summary = text ? text[locale === "zh-TW" ? 0 : 1] : problem.code;
  return locale === "zh-TW" ? `${summary}：${problem.message}` : `${summary}: ${problem.message}`;
}
```

- [ ] **Step 4: 實作 `plugins-panel.tsx`**

```tsx
import { useEffect, useState } from "react";
import type { Locale } from "../i18n/copy.js";
import type {
  LocalizedText,
  PluginNotice,
  PluginsSnapshot,
  PluginSummary,
} from "../../shared/plugins.js";
import { pluginCopy, problemText } from "./plugin-copy.js";

export const localizedText = (text: LocalizedText, locale: Locale): string =>
  typeof text === "string" ? text : locale === "zh-TW" ? (text["zh-TW"] ?? text.en) : text.en;

export function PluginsPanel({ locale }: { locale: Locale }): React.JSX.Element {
  const t = pluginCopy[locale];
  const [state, setState] = useState<PluginsSnapshot>();
  const [notices, setNotices] = useState<PluginNotice[]>([]);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    void window.kobrixa.plugins.state().then((value) => {
      if (live) setState(value);
    });
    const off = window.kobrixa.plugins.onEvent((event) => {
      if (event.type === "state") setState(event.state);
      else setNotices((list) => [event.notice, ...list].slice(0, 20));
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  const perform = async (
    key: string,
    work: () => Promise<
      { ok: true; state?: PluginsSnapshot } | { ok: false; code: string; message: string }
    >,
  ) => {
    setBusy(key);
    setError(undefined);
    try {
      const result = await work();
      if (!result.ok) setError(problemText(result, locale));
      else if (result.state) setState(result.state);
    } finally {
      setBusy(undefined);
    }
  };
  if (!state) return <p className="settings-hint">{t.loading}</p>;
  const toggle = (plugin: PluginSummary) => {
    if (plugin.source !== "development" || plugin.status === "invalid") return null;
    const enabling = plugin.status === "disabled" && plugin.disabledBy === "user";
    const label = enabling
      ? t.enable
      : plugin.disabledBy === "safe-mode"
        ? t.keepDisabled
        : t.disable;
    return (
      <button
        disabled={busy !== undefined || (enabling && state.safeMode)}
        onClick={() =>
          void perform(plugin.id, () => window.kobrixa.plugins.setEnabled(plugin.id, enabling))
        }
      >
        {label}
      </button>
    );
  };
  return (
    <div className="plugins-panel">
      <p className="settings-hint">{t.trust}</p>
      {!state.developmentMode && <p className="settings-hint">{t.howTo}</p>}
      {state.safeMode && (
        <p className="settings-hint" role="status">
          {t.safeMode}
        </p>
      )}
      {error && (
        <p className="settings-hint" role="alert">
          {error}
        </p>
      )}
      <ul className="plugins-list">
        {state.plugins.map((plugin) => (
          <li key={`${plugin.source}:${plugin.directory ?? plugin.id}`}>
            <h3 className="settings-subheading">
              {plugin.displayName ? localizedText(plugin.displayName, locale) : plugin.id}
            </h3>
            <p className="settings-hint">
              {[
                plugin.id,
                plugin.version,
                plugin.source === "builtin" ? t.builtin : t.development,
                plugin.runtime,
                t.status[plugin.status],
                plugin.running ? t.running : undefined,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            {plugin.directory && <p className="settings-hint">{plugin.directory}</p>}
            {plugin.problems.map((problem, index) => (
              <p className="settings-hint" key={index}>
                {problemText(problem, locale)}
              </p>
            ))}
            {plugin.commands.length > 0 && (
              <div role="group" aria-label={t.commands}>
                {plugin.commands.map((command) => (
                  <button
                    key={command.id}
                    disabled={busy !== undefined}
                    onClick={() =>
                      void perform(command.id, () => window.kobrixa.plugins.execute(command.id))
                    }
                  >
                    {localizedText(command.title, locale)}
                  </button>
                ))}
              </div>
            )}
            {toggle(plugin)}
          </li>
        ))}
      </ul>
      <h3 className="settings-subheading">{t.notices}</h3>
      <ul aria-live="polite">
        {notices.length === 0 && <li className="settings-hint">{t.noNotices}</li>}
        {notices.map((notice, index) => (
          <li key={`${notice.at}-${index}`}>
            <strong>{notice.pluginId}</strong> {notice.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

這是開發預覽功能，只沿用既有的 `settings-hint`、`settings-subheading` 與按鈕樣式，不新增樣式表。插件訊息是不可信的文字，由 React 逸出後顯示，不使用 `dangerouslySetInnerHTML`。

- [ ] **Step 5: 接上設定頁**

1. `settings-catalog.ts`：在 `CATEGORY_LABELS` 的 `updates` 之前加入 `plugins: ["插件", "Plugins"],`。
2. `settings-panel.tsx`：匯入 `import { PluginsPanel } from "./plugins-panel.js";`；在導覽陣列的 `"updates"` 之前加入 `"plugins"`；在 `{group === "updates" && category === "updates" && !searching && (...)}` 之前加入：

```tsx
{
  group === "plugins" && category === "plugins" && !searching && (
    <PluginsPanel locale={settings.locale} />
  );
}
```

3. `settings-panel.test.ts` 已經 mock 了部分面板。如果測試環境沒有 `window.kobrixa.plugins`，就在檔案頂端加入 `vi.mock("./plugins-panel.js", () => ({ PluginsPanel: () => null }));`。

- [ ] **Step 6: 執行測試與檢查**

Run: `pnpm vitest run --project desktop src/renderer/settings && pnpm --filter @kobrixa/desktop check && pnpm eslint apps/desktop`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/settings
git commit -m "feat(desktop): add a bilingual plugins panel to settings"
```

---

### Task 15: Electron 插件 smoke 與 CI

**Files:**

- Create: `tests/desktop/run-plugins-smoke.mjs`、`tests/desktop/plugins-smoke-main.ts`、`tests/desktop/fixtures/crash-plugin.ts`
- Modify: 根目錄 `package.json`（`test:plugins:smoke`）、`.github/workflows/ci.yml`（`KOBRIXA_TEST_PYTHON` 與 smoke 步驟）

**Interfaces:**

- Consumes: `PluginManager`、`createDesktopLauncher`、`filePluginStateStore`、兩個範例插件、`@kobrixa/plugin-sdk`

這個 smoke 驗證只有真實 Electron 才能測的部分：`utilityProcess`、MessagePort 傳遞、TS 插件當機不影響其他插件、Python 插件透過真實啟動器執行，以及 `dispose` 之後沒有殘留的子程序。

- [ ] **Step 1: 寫 smoke**

`tests/desktop/fixtures/crash-plugin.ts`：

```ts
import { definePlugin, runPlugin } from "@kobrixa/plugin-sdk";

void runPlugin(
  definePlugin({
    activate(context) {
      context.commands.register("kobrixa-smoke.crash.exit", () => process.exit(7));
    },
  }),
);
```

`tests/desktop/plugins-smoke-main.ts`：

```ts
import assert from "node:assert/strict";
import { app } from "electron";
import { PluginManager, type PluginNotice } from "@kobrixa/plugin-runtime";
import { createDesktopLauncher } from "../../apps/desktop/src/main/plugins/launchers.js";
import { filePluginStateStore } from "../../apps/desktop/src/main/plugins/state-store.js";

const [directory, python] = process.argv.slice(-2) as [string, string];
const fail = (error: unknown) => {
  console.error(error);
  app.exit(1);
};
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
setTimeout(() => fail(new Error("Plugin smoke timed out")), 60_000).unref();

void app.whenReady().then(async () => {
  const manager = await PluginManager.create({
    sources: ["hello-ts", "插件 測試/hello-python", "crash"].map((name) => ({
      kind: "development" as const,
      directory: `${directory}/${name}`,
    })),
    store: filePluginStateStore(`${directory}/user-data`),
    safeMode: false,
    launcher: createDesktopLauncher({ python }),
    locale: "zh-TW",
  });
  const notices: PluginNotice[] = [];
  manager.onEvent((event) => {
    if (event.type === "notice") notices.push(event.notice);
  });
  assert.deepEqual(
    manager.state().plugins.map((plugin) => plugin.status),
    ["enabled", "enabled", "enabled"],
  );
  assert.deepEqual(await manager.executeCommand("kobrixa-samples.hello-ts.greet"), { ok: true });
  assert.deepEqual(await manager.executeCommand("kobrixa-samples.hello-python.greet"), {
    ok: true,
  });
  const crashed = await manager.executeCommand("kobrixa-smoke.crash.exit");
  assert.equal(crashed.ok, false);
  assert.equal(crashed.ok ? undefined : crashed.code, "PLUGIN_E_CRASHED");
  assert.deepEqual(
    await manager.executeCommand("kobrixa-samples.hello-ts.greet"),
    { ok: true },
    "Other plugins keep working after a crash",
  );
  assert.deepEqual(
    notices.map((notice) => [notice.pluginId, notice.message]),
    [
      ["kobrixa-samples.hello-ts", "來自 TypeScript 插件的問候"],
      ["kobrixa-samples.hello-python", "來自 Python 插件的問候"],
      ["kobrixa-samples.hello-ts", "來自 TypeScript 插件的問候"],
    ],
  );
  await manager.dispose();
  assert.ok(manager.state().plugins.every((plugin) => !plugin.running));
  console.log("PASS plugins: utilityProcess TS, Python stdio, crash isolation, shutdown");
  app.exit(0);
});
```

`tests/desktop/run-plugins-smoke.mjs`：

```js
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { build } from "esbuild";

// Uses real Electron: utilityProcess, MessagePort transfer and the Python stdio launcher.
const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(path.join(root, "apps/desktop/package.json"));
const temporary = await mkdtemp(path.join(tmpdir(), "kobrixa-plugins-smoke-"));
const alias = {
  "@kobrixa/plugin-protocol": path.join(root, "packages/plugin-protocol/src/index.ts"),
  "@kobrixa/plugin-runtime": path.join(root, "packages/plugin-runtime/src/index.ts"),
  "@kobrixa/plugin-sdk": path.join(root, "packages/plugin-sdk-js/src/index.ts"),
};
const bundle = (entry, outfile, external = []) =>
  build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    alias,
    external,
  });
const python = [process.env.KOBRIXA_TEST_PYTHON, "python3", "python"]
  .filter(Boolean)
  .find(
    (command) =>
      spawnSync(command, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"])
        .status === 0,
  );
if (!python) throw new Error("The plugin smoke needs Python 3.10+. Set KOBRIXA_TEST_PYTHON.");
let passed = false;
try {
  await bundle(
    path.join(root, "tests/desktop/plugins-smoke-main.ts"),
    path.join(temporary, "main.cjs"),
    ["electron"],
  );
  await cp(
    path.join(root, "plugins/samples/hello-ts/kobrixa-plugin.json"),
    path.join(temporary, "hello-ts/kobrixa-plugin.json"),
  );
  await bundle(
    path.join(root, "plugins/samples/hello-ts/src/index.ts"),
    path.join(temporary, "hello-ts/dist/index.cjs"),
  );
  await cp(
    path.join(root, "plugins/samples/hello-python"),
    path.join(temporary, "插件 測試/hello-python"),
    { recursive: true },
  );
  await bundle(
    path.join(root, "tests/desktop/fixtures/crash-plugin.ts"),
    path.join(temporary, "crash/dist/index.cjs"),
  );
  await writeFile(
    path.join(temporary, "crash/kobrixa-plugin.json"),
    JSON.stringify({
      id: "kobrixa-smoke.crash",
      version: "0.0.0",
      apiVersion: "^1.0.0",
      runtime: { kind: "node", entry: "dist/index.cjs" },
      contributes: { commands: [{ id: "kobrixa-smoke.crash.exit", title: "Crash" }] },
    }),
  );
  const child = spawn(
    process.execPath,
    [
      require.resolve("electron/cli.js"),
      path.join(temporary, "main.cjs"),
      `--user-data-dir=${path.join(temporary, "user-data")}`,
      temporary,
      python,
    ],
    {
      stdio: "inherit",
      env: { ...process.env, PYTHONPATH: path.join(root, "sdks/python") },
    },
  );
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) throw new Error(`Plugin smoke failed (${code})`);
  passed = true;
} finally {
  if (passed) await rm(temporary, { recursive: true, force: true });
  else console.error(`Plugin smoke artifacts: ${temporary}`);
}
```

在根目錄 `package.json` 加入 `"test:plugins:smoke": "node tests/desktop/run-plugins-smoke.mjs"`。

- [ ] **Step 2: 執行 smoke**

Run: `pnpm test:plugins:smoke`
Expected: 輸出 `PASS plugins: utilityProcess TS, Python stdio, crash isolation, shutdown`，exit code 0。如果 `utilityProcess` 在 `spawn` 之前就 `postMessage` 而遺失 port，檢查 task 12 的 `launchNode` 是否真的等待了 `spawn`。

- [ ] **Step 3: 加入 CI**

在 `.github/workflows/ci.yml` 的 `platform` job 加入 job 層級的環境變數：

```yaml
env:
  KOBRIXA_TEST_PYTHON: ${{ runner.os == 'Windows' && 'python' || 'python3' }}
```

在 `- run: pnpm test:desktop` 之後加入：

```yaml
- name: Plugin smoke (utilityProcess, Python, crash isolation)
  shell: bash
  run: |
    if [ "$RUNNER_OS" = "Linux" ]; then
      xvfb-run -a pnpm test:plugins:smoke
    else
      pnpm test:plugins:smoke
    fi
```

`tools/ci/changes.mjs` 會把 `sdks/` 和 `plugins/` 這些新目錄當成未知路徑，同時觸發網站與桌面的檢查，所以不需要修改。

- [ ] **Step 4: 執行完整的本機驗證**

Run: `pnpm format:check && pnpm check && pnpm build:core && pnpm test:desktop && pnpm test:plugins:smoke`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add tests/desktop package.json .github/workflows/ci.yml
git commit -m "test(desktop): add Electron plugin smoke and run it in CI"
```

---

### Task 16: 文件（英文與繁中同步）

**Files:**

- Modify: `docs/en/architecture.md`、`docs/zh-TW/architecture.md`（在 `## Project manifest`／`## 專案 manifest` 之前加入新章節）
- Modify: `docs/en/roadmap.md`、`docs/zh-TW/roadmap.md`（`## v1.x` 章節加一條）
- Modify: `tests/desktop/README.md`（plugin smoke 段落）
- Create: `plugins/samples/README.md`；完成 `sdks/python/README.md`

- [ ] **Step 1: 寫 architecture 章節**

英文版 `## Plugins (development preview)` 與繁中版 `## 插件（開發預覽）`，內容必須一致，涵蓋：

- 套件邊界：`plugin-protocol`（Zod 為撰寫來源，提交的 JSON Schema 為公開契約，含共用一致性案例）；`plugin-runtime`（不依賴 Electron）；`plugin-sdk`；`sdks/python`。
- 傳輸：JS/TS 用 `utilityProcess` 加 MessagePort；Python 用 stdio 加 `Content-Length`，stdout 只放協定、stderr 放日誌。
- 啟動開關：`--plugin-dev-dir`、`--plugin-python`、`--safe-mode`；狀態檔 `<userData>/plugins/state.json`。
- 第一階段 API：`initialize`、`command/execute`、`shutdown`、`exit`、`ui/showMessage`、`$/cancelRequest`；身分由通道綁定；當機不重播，5 分鐘內失敗 3 次就停止。
- 信任界線：可信任的本機插件，權限不是沙箱。
- Basic Plus 經內建插件 `kobrixa.basic-plus` 註冊為 `bp` 前端；通用成品契約、`Diagnostic.source`、語言靜態貢獻與 `devices` API 標為「規劃中（第二、三階段）」。

- [ ] **Step 2: roadmap**

在英文 `## v1.x — hardening` 加入：`- Plugin system phase 1 (development preview): protocol, JS/TS and Python SDKs, command and notification API, settings panel, and the Basic Plus frontend registered as a built-in plugin. Third-party plugins load only in development mode. See the [plugin design](../superpowers/specs/2026-10-14-plugin-system-design.md).`

在繁中 `## v1.x — 強化` 加入對應的一條。

- [ ] **Step 3: 範例與 SDK README**

`plugins/samples/README.md`（英文，附繁中段落）寫出可以直接執行的步驟：

```sh
pnpm install && pnpm build:core
npx esbuild plugins/samples/hello-ts/src/index.ts --bundle --platform=node --format=cjs \
  --outfile=plugins/samples/hello-ts/dist/index.cjs
python3 -m pip install -e sdks/python
pnpm dev -- -- --plugin-dev-dir="$PWD/plugins/samples/hello-ts:$PWD/plugins/samples/hello-python" \
  --plugin-python="$(command -v python3)"
```

也要說明 Windows 的分隔符是 `;`，以及 macOS 打包版本的啟動方式：`open -a Kobrixa --args --plugin-dev-dir=…`。

`tests/desktop/README.md` 加入 `## Plugin smoke` 段落，說明 `pnpm test:plugins:smoke` 涵蓋的內容與 `KOBRIXA_TEST_PYTHON`。

- [ ] **Step 4: 檢查並 commit**

Run: `pnpm format:check`
Expected: PASS（必要時先執行 `pnpm exec prettier --write` 格式化剛改過的 Markdown）。

```bash
git add docs plugins/samples/README.md sdks/python/README.md tests/desktop/README.md
git commit -m "docs: document plugin system phase 1 in English and Traditional Chinese"
```

---

## 完成標準（對應設計 §11 第一階段）

- TS 與 Python 開發插件可以載入、執行、停用：task 9、11、15。
- 不要求管理 Python runtime：task 11、12。
- Basic Plus 仍可編譯：task 13（`pnpm test:bytecode` 與範例測試）。
- 插件當機不影響工作台：task 8、15。
- 宿主可信身分與「載入貢獻前停用」：task 6、8、9。
- Schema 產物一致、語意一致：task 4、11。
