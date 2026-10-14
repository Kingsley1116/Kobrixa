# 插件載入 1a：執行層強化 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 plugin runtime 以來源身分（`sourceKey`）追蹤插件、支援執行中新增／移除／重新載入，並讓每一條停止流程都有時間上限，為 1b 圖形介面管理打底。

**Architecture:** registry 拆成「讀取單一來源」（`readSource`，有逾時、安全模式不讀）與「整組判定」（`resolvePlugins`）。PluginManager 改成以 `Entry`（來源＋讀取結果＋generation）為單位，每次修改都經過同一個佇列，再由 `#reconcile()` 依整組結果增減 supervisor。Supervisor 的停止多一個原因（`disabled`／`cancelled`），並為握手失敗與啟動中停止加上時間上限。桌面端狀態檔升到 v2，面板改用 `sourceKey` 與 `revision`。

**Tech Stack:** TypeScript（strict、`exactOptionalPropertyTypes`）、Node.js 24、Electron utilityProcess、Zod 4、Vitest、React（面板）。

**Spec:** [`docs/superpowers/specs/2026-10-15-plugin-loading-ux-design.md`](../specs/2026-10-15-plugin-loading-ux-design.md) §2、§3。

## Global Constraints

- 只動 runtime 與桌面端的插件管線；使用者看得到的變化只有：狀態檔損毀提示、「未保存」提示、安全模式下開發插件以資料夾名稱顯示。
- `sourceKey` 格式：內建 `builtin:<manifest id>`；開發 `dev:` 加 `path.resolve(directory)` 的 SHA-256 前 16 個十六進位字元。計算時不碰檔案系統（見 Task 8 對 spec 的修正）。
- 單一來源讀取上限 `SOURCE_READ_TIMEOUT_MS = 5_000`；所有來源**平行**讀取。
- Supervisor 的停止上限沿用 `stopTimeoutMs + exitTimeoutMs`（預設 2 000 + 4 000 ms）。
- 桌面 Node 插件等待 `spawn` 上限 `PLUGIN_SPAWN_TIMEOUT_MS = 10_000`。
- 新錯誤碼：`PLUGIN_E_SHUTTING_DOWN`、`PLUGIN_E_SOURCE_TIMEOUT`、`PLUGIN_E_SOURCE_EXISTS`、`PLUGIN_E_STATE_CORRUPT`。沿用既有的 `PLUGIN_E_CANCELLED`。
- 任何情況都不重播命令。
- spec §3.6「`PluginManager.create` 失敗時仍然開啟視窗」的做法：讓 `create` 本身不會因第三方插件而失敗。狀態檔讀不到就當作損毀並停用第三方插件（Task 3），資料夾讀取有逾時（Task 1）。唯一還會 reject 的情況是內建 manifest 無效，那屬於建置錯誤，由既有測試擋下，所以 `index.ts` 不需要修改。
- 桌面端從 `@kobrixa/plugin-runtime` 的 `dist/` 取用 runtime：改完 runtime 後、跑桌面端測試或型別檢查前，先執行 `pnpm --filter @kobrixa/plugin-runtime build`。
- 介面文字一律提供 `en` 與 `zh-TW`。
- 每個 task 結束前執行 `pnpm exec prettier --check <改到的檔案>`。

## Review Focus

1. **重新載入時資料夾已被刪除**：該列應保留成 invalid（`PLUGIN_E_MANIFEST`），舊命令被移除，不能拋錯或讓整個 manager 卡住。→ Task 4 Step 1 的 `reload of a deleted folder` 測試。
2. **重新載入後 ID 撞到另一個插件**：依「來源順序固定、先到先得」，排在前面的保留、後面的變 invalid 並停止；使用者會看到是哪一個被擋。→ Task 4 Step 1 的 `reload that takes another plugin's id` 測試。
3. **修改操作排隊或讀取資料夾時開始關閉**：reload／add 開始前或讀完後，只要已經在 shutdown，就不能再登記新的 supervisor。→ Task 4 Step 1 的 `shutdown starts while a reload is queued` 測試；讀完後的檢查由 Task 4 Step 3 的 `closedAfterRead`／`closed` 負責。
4. **狀態檔損毀後使用者重新啟用插件**：應寫出合法的 v2 檔並清掉 `stateProblem`，不能一直卡在損毀提示。→ Task 3 Step 1 的 `corrupt state` 測試。
5. **已移除插件的舊程序在停止途中送通知**：不能出現在通知列表；同樣情境下只是停用的插件，通知照常送達。→ Task 4 Step 1 的 `drops notices from a removed source` 測試。

---

### Task 1: registry 拆成 readSource／resolvePlugins，加入 sourceKey 與讀取逾時

**Files:**

- Modify: `packages/plugin-runtime/src/errors.ts`
- Modify: `packages/plugin-runtime/src/registry.ts`（整檔替換）
- Modify: `packages/plugin-runtime/src/registry.test.ts`
- Create: `packages/plugin-runtime/src/registry.timeout.test.ts`

**Interfaces:**

- Produces:
  - `SOURCE_READ_TIMEOUT_MS: number`
  - `type DevelopmentSource = { kind: "development"; directory: string }`
  - `sourceKeySchema: z.ZodString`
  - `developmentSourceKey(directory: string): string`
  - `interface ReadPlugin { sourceKey; id; source; directory?; manifest?; entry?; problems: readonly PluginProblem[]; unread?: true }`
  - `interface RegisteredPlugin extends Omit<ReadPlugin, "problems"> { status; disabledBy?; problems: PluginProblem[] }`
  - `readSource(source: PluginSource, options: { safeMode: boolean; timeoutMs?: number }): Promise<ReadPlugin>`
  - `resolvePlugins(read: readonly ReadPlugin[], options: { disabled: ReadonlySet<string>; safeMode: boolean }): RegisteredPlugin[]`，其中 `disabled` 是 sourceKey 集合
  - `loadPlugins(sources, options: { disabled; safeMode; timeoutMs? }): Promise<RegisteredPlugin[]>`（平行讀取後 resolve）

- [ ] **Step 1: 加新錯誤碼**

在 `packages/plugin-runtime/src/errors.ts` 的 `PLUGIN_ERROR_CODES` 陣列中，`"PLUGIN_E_STATE_SAVE",` 之後加：

```ts
  "PLUGIN_E_STATE_CORRUPT",
  "PLUGIN_E_SHUTTING_DOWN",
  "PLUGIN_E_SOURCE_TIMEOUT",
  "PLUGIN_E_SOURCE_EXISTS",
```

- [ ] **Step 2: 改寫 registry 測試（先讓它失敗）**

在 `packages/plugin-runtime/src/registry.test.ts`：

1. import 改成：

```ts
import { developmentSourceKey, loadPlugins, readSource, sourceKeySchema } from "./index.js";
```

2. 把 `"marks disabled and safe-mode plugins before contributions load"` 整個 `it` 換成：

```ts
it("marks disabled plugins by source key and skips reading folders in safe mode", async () => {
  const source = await plugin("a", manifest());
  const key = developmentSourceKey(source.directory);
  expect(
    (await loadPlugins([source], { disabled: new Set([key]), safeMode: false }))[0],
  ).toMatchObject({ sourceKey: key, status: "disabled", disabledBy: "user" });
  // A manifest id no longer disables anything: identity is the source, not the id.
  expect(
    (await loadPlugins([source], { disabled: new Set(["acme.hello"]), safeMode: false }))[0]!
      .status,
  ).toBe("enabled");
  const [safe] = await loadPlugins([source], { disabled: new Set(), safeMode: true });
  expect(safe).toMatchObject({
    sourceKey: key,
    id: "a",
    status: "disabled",
    disabledBy: "safe-mode",
    unread: true,
    problems: [],
  });
  expect(safe!.manifest).toBeUndefined();
  const [userDisabled] = await loadPlugins([source], { disabled: new Set([key]), safeMode: true });
  expect(userDisabled).toMatchObject({ status: "disabled", disabledBy: "user" });
  expect(
    (
      await loadPlugins([builtin], {
        disabled: new Set(["builtin:kobrixa.basic-plus"]),
        safeMode: true,
      })
    )[0],
  ).toMatchObject({ sourceKey: "builtin:kobrixa.basic-plus", status: "enabled" });
});
it("never reads a missing folder in safe mode", async () => {
  const [safe] = await loadPlugins(
    [{ kind: "development", directory: path.join(root, "absent") }],
    { disabled: new Set(), safeMode: true },
  );
  expect(safe).toMatchObject({ status: "disabled", disabledBy: "safe-mode", problems: [] });
});
it("derives stable, valid source keys without touching the file system", () => {
  const key = developmentSourceKey(path.join(root, "x"));
  expect(key).toMatch(/^dev:[0-9a-f]{16}$/);
  expect(developmentSourceKey(path.join(root, "y", "..", "x"))).toBe(key);
  expect(sourceKeySchema.safeParse(key).success).toBe(true);
  expect(sourceKeySchema.safeParse("builtin:kobrixa.basic-plus").success).toBe(true);
  expect(sourceKeySchema.safeParse("dev:../../etc").success).toBe(false);
});
it("reads one source on its own without deciding conflicts", async () => {
  const read = await readSource(await plugin("solo", manifest()), { safeMode: false });
  expect(read).toMatchObject({ id: "acme.hello", source: "development", problems: [] });
  expect(read).not.toHaveProperty("status");
});
```

3. 在 `"rejects a command id that another plugin already contributes"` 裡，把

```ts
const results = await loadPlugins([first, second], {
  disabled: new Set(["acme.hello"]),
  safeMode: false,
});
```

換成

```ts
const results = await loadPlugins([first, second], {
  disabled: new Set([developmentSourceKey(first.directory)]),
  safeMode: false,
});
```

- [ ] **Step 3: 新增逾時測試**

建立 `packages/plugin-runtime/src/registry.timeout.test.ts`：

```ts
import { expect, it, vi } from "vitest";
import { readSource } from "./index.js";

// A folder on a hung network disk: realpath never settles.
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  realpath: vi.fn(() => new Promise(() => {})),
}));

it("gives up on a development folder that does not answer in time", async () => {
  const read = await readSource(
    { kind: "development", directory: "/hung/plugin" },
    { safeMode: false, timeoutMs: 20 },
  );
  expect(read).toMatchObject({ id: "plugin", source: "development" });
  expect(read.problems.map((problem) => problem.code)).toEqual(["PLUGIN_E_SOURCE_TIMEOUT"]);
});
```

- [ ] **Step 4: 確認測試失敗**

Run: `pnpm --filter @kobrixa/plugin-runtime exec vitest run src/registry.test.ts src/registry.timeout.test.ts`
Expected: FAIL，`developmentSourceKey`／`readSource`／`sourceKeySchema` 未匯出。

- [ ] **Step 5: 整檔替換 `packages/plugin-runtime/src/registry.ts`**

```ts
import { createHash } from "node:crypto";
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
/** Bound on reading one development folder, so a hung disk cannot block startup or recovery. */
export const SOURCE_READ_TIMEOUT_MS = 5_000;
export type PluginSource =
  { kind: "builtin"; manifest: unknown } | { kind: "development"; directory: string };
export type DevelopmentSource = Extract<PluginSource, { kind: "development" }>;
/** `builtin:<manifest id>` or `dev:` plus 16 hex digits; safe to accept from the renderer. */
export const sourceKeySchema = z
  .string()
  .max(160)
  .regex(/^(?:builtin:[a-z0-9.-]+|dev:[0-9a-f]{16})$/);

/** Identity of a development source that survives manifest id changes. Pure: no file access. */
export const developmentSourceKey = (directory: string): string =>
  `dev:${createHash("sha256").update(path.resolve(directory)).digest("hex").slice(0, 16)}`;

/** One source as read on its own; resolvePlugins() decides its status within the whole set. */
export interface ReadPlugin {
  sourceKey: string;
  id: string;
  source: "builtin" | "development";
  directory?: string;
  manifest?: PluginManifest;
  entry?: string;
  /** Problems of this source alone; empty means it is valid by itself. */
  problems: readonly PluginProblem[];
  /** Safe mode: the folder was deliberately not read. */
  unread?: true;
}
export interface RegisteredPlugin extends Omit<ReadPlugin, "problems"> {
  status: "enabled" | "disabled" | "invalid";
  disabledBy?: "user" | "safe-mode";
  problems: PluginProblem[];
}
type SourceRead = Omit<ReadPlugin, "sourceKey">;

const problem = (code: PluginErrorCode, message: string): PluginProblem => ({ code, message });

function semanticProblems(manifest: PluginManifest, source: ReadPlugin["source"]): PluginProblem[] {
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
  source: ReadPlugin["source"],
  fallbackId: string,
): SourceRead {
  const parsed = pluginManifestSchema.safeParse(value);
  if (!parsed.success)
    return {
      id: fallbackId,
      source,
      problems: [problem("PLUGIN_E_MANIFEST", z.prettifyError(parsed.error))],
    };
  return {
    id: parsed.data.id,
    source,
    manifest: parsed.data,
    problems: semanticProblems(parsed.data, source),
  };
}

async function readDevelopmentPlugin(directory: string): Promise<SourceRead> {
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
    const file = path.join(root, MANIFEST_FILE);
    if ((await stat(file)).size > PLUGIN_LIMITS.manifestBytes)
      return invalid(`${MANIFEST_FILE} is larger than 64 KiB.`);
    value = JSON.parse((await readFile(file, "utf8")).replace(/^﻿/, ""));
  } catch (error) {
    return invalid(`Cannot read ${MANIFEST_FILE}: ${messageOf(error)}`);
  }
  const plugin = { ...checkManifest(value, "development", fallback), directory: root };
  const runtime = plugin.manifest?.runtime;
  if (plugin.problems.length || !runtime || runtime.kind === "builtin") return plugin;
  try {
    const entry = await realpath(path.resolve(root, runtime.entry));
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

/** Reads one source. Built-in manifests are bundled, so an invalid one is a build error. */
export async function readSource(
  source: PluginSource,
  options: { safeMode: boolean; timeoutMs?: number },
): Promise<ReadPlugin> {
  if (source.kind === "builtin") {
    const plugin = checkManifest(source.manifest, "builtin", "builtin");
    if (plugin.problems.length)
      throw new Error(
        `Invalid built-in plugin manifest: ${plugin.problems.map((item) => item.message).join("; ")}`,
      );
    return { ...plugin, sourceKey: `builtin:${plugin.id}` };
  }
  const directory = path.resolve(source.directory);
  const sourceKey = developmentSourceKey(directory);
  const placeholder = {
    sourceKey,
    id: path.basename(directory),
    source: "development" as const,
    directory,
  };
  // Recovery: safe mode never touches third-party folders, so a hung disk cannot block it.
  if (options.safeMode) return { ...placeholder, problems: [], unread: true };
  const timeoutMs = options.timeoutMs ?? SOURCE_READ_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<SourceRead>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          ...placeholder,
          problems: [
            problem(
              "PLUGIN_E_SOURCE_TIMEOUT",
              `Reading ${MANIFEST_FILE} did not finish within ${timeoutMs} ms.`,
            ),
          ],
        }),
      timeoutMs,
    );
  });
  try {
    return { ...(await Promise.race([readDevelopmentPlugin(directory), timedOut])), sourceKey };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decides every status within the whole set, in source order: built-ins come first, so their ids
 * are protected, and an earlier source keeps an id or command over a later one. `disabled` holds
 * source keys; built-ins cannot be disabled.
 */
export function resolvePlugins(
  read: readonly ReadPlugin[],
  options: { disabled: ReadonlySet<string>; safeMode: boolean },
): RegisteredPlugin[] {
  const resolved = read.map((plugin): RegisteredPlugin => ({
    ...plugin,
    problems: [...plugin.problems],
    status: plugin.problems.length ? "invalid" : "enabled",
  }));
  const seen = new Set<string>();
  // Namespaces nest ("acme.hello." also covers "acme.hello.extra."), so command ids can collide
  // across plugins. Disabled plugins are checked too, so re-enabling one can never collide.
  const commandOwners = new Map<string, string>();
  for (const plugin of resolved) {
    if (plugin.unread) {
      Object.assign(
        plugin,
        options.disabled.has(plugin.sourceKey)
          ? { status: "disabled", disabledBy: "user" }
          : { status: "disabled", disabledBy: "safe-mode" },
      );
      continue;
    }
    if (plugin.status === "invalid") continue;
    if (seen.has(plugin.id)) {
      plugin.status = "invalid";
      plugin.problems.push(
        problem("PLUGIN_E_DUPLICATE_ID", `Another plugin already uses the id ${plugin.id}.`),
      );
      continue;
    }
    const commands = (plugin.manifest?.contributes?.commands ?? []).map((command) => command.id);
    const taken = commands.filter((id) => commandOwners.has(id));
    if (taken.length) {
      plugin.status = "invalid";
      for (const id of taken)
        plugin.problems.push(
          problem(
            "PLUGIN_E_DUPLICATE_COMMAND",
            `${id} is already contributed by ${commandOwners.get(id)}.`,
          ),
        );
      continue;
    }
    seen.add(plugin.id);
    for (const id of commands) commandOwners.set(id, plugin.id);
    if (plugin.source !== "development") continue;
    // Recovery: this decision happens before any contribution is registered or process launched.
    if (options.disabled.has(plugin.sourceKey))
      Object.assign(plugin, { status: "disabled", disabledBy: "user" });
    else if (options.safeMode)
      Object.assign(plugin, { status: "disabled", disabledBy: "safe-mode" });
  }
  return resolved;
}

/** Reads every source in parallel, so one slow folder costs at most one timeout, then resolves. */
export async function loadPlugins(
  sources: readonly PluginSource[],
  options: { disabled: ReadonlySet<string>; safeMode: boolean; timeoutMs?: number },
): Promise<RegisteredPlugin[]> {
  const read = await Promise.all(sources.map((source) => readSource(source, options)));
  return resolvePlugins(read, options);
}
```

- [ ] **Step 6: 跑 registry 測試**

Run: `pnpm --filter @kobrixa/plugin-runtime exec vitest run src/registry.test.ts src/registry.timeout.test.ts`
Expected: PASS。`manager.ts` 此時仍可編譯，因為 `loadPlugins` 與 `RegisteredPlugin` 的形狀相容。但 `disabled` 改成以 sourceKey 判斷後，`manager.test.ts` 中用 manifest ID 停用的測試會暫時失敗，Task 3 會一併修正。所以這個 task 只跑上面兩個測試檔，不跑整個 runtime 的測試。

- [ ] **Step 7: 格式檢查並提交**

```bash
pnpm exec prettier --write packages/plugin-runtime/src/errors.ts packages/plugin-runtime/src/registry.ts packages/plugin-runtime/src/registry.test.ts packages/plugin-runtime/src/registry.timeout.test.ts
git add packages/plugin-runtime/src/errors.ts packages/plugin-runtime/src/registry.ts packages/plugin-runtime/src/registry.test.ts packages/plugin-runtime/src/registry.timeout.test.ts
git commit -m "feat(plugin-runtime): identify sources by key and bound folder reads"
```

---

### Task 2: Supervisor 的停止原因與有上限的等待

**Files:**

- Modify: `packages/plugin-runtime/src/supervisor.ts`
- Modify: `packages/plugin-runtime/src/supervisor.test.ts`

**Interfaces:**

- Produces:
  - `type StopReason = "disabled" | "cancelled"`
  - `PluginSupervisor.stop(reason?: StopReason): Promise<void>`：預設 `"disabled"`。同時有多個呼叫時共用同一次停止，原因以第一個呼叫為準。被中斷的命令依原因得到 `PLUGIN_E_DISABLED` 或 `PLUGIN_E_CANCELLED`。

- [ ] **Step 1: 寫失敗的測試**

在 `packages/plugin-runtime/src/supervisor.test.ts` 的 `describe("PluginSupervisor", …)` 裡，緊接在 `"rejects a command interrupted by stop as disabled"` 之後加：

```ts
it("rejects a command interrupted by a cancelling stop as cancelled", async () => {
  const { supervisor } = setup();
  await supervisor.executeCommand("acme.hello.greet");
  const command = expect(supervisor.executeCommand("acme.hello.hang")).rejects.toMatchObject({
    code: "PLUGIN_E_CANCELLED",
  });
  await Promise.resolve();
  await Promise.all([supervisor.stop("cancelled"), command]);
  expect(supervisor.state).toBe("idle");
});
it("bounds the wait for a process that never reports exit after a failed handshake", async () => {
  vi.useFakeTimers();
  const silent = memoryPlugin((peer) =>
    peer.handle("initialize", () => ({ apiVersion: "2.0.0", sdk: { name: "t", version: "1" } })),
  );
  const launcher = vi
    .fn(async () => memoryPlugin((peer, { exit }) => ready(peer, exit)).process)
    .mockResolvedValueOnce({ ...silent.process, onExit: () => () => {}, kill: vi.fn() });
  const supervisor = new PluginSupervisor(plugin, launcher, {
    locale: "en",
    onNotice: () => {},
    stopTimeoutMs: 10,
    exitTimeoutMs: 20,
  });
  const first = supervisor.executeCommand("acme.hello.greet").catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(30);
  expect(await first).toMatchObject({ code: "PLUGIN_E_HANDSHAKE" });
  expect(supervisor.state).toBe("idle");
  await expect(supervisor.executeCommand("acme.hello.greet")).resolves.toBeUndefined();
  expect(launcher).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
it("gives up on a launch that never settles and kills the process if it appears later", async () => {
  vi.useFakeTimers();
  let finishLaunch!: (process: PluginProcess) => void;
  const late = memoryPlugin((peer, { exit }) => ready(peer, exit));
  const launcher = vi.fn(
    () =>
      new Promise<PluginProcess>((resolve) => {
        finishLaunch = resolve;
      }),
  );
  const supervisor = new PluginSupervisor(plugin, launcher, {
    locale: "en",
    onNotice: () => {},
    stopTimeoutMs: 10,
    exitTimeoutMs: 20,
  });
  const command = supervisor.executeCommand("acme.hello.greet").catch((error: unknown) => error);
  const stopping = supervisor.stop("cancelled");
  await vi.advanceTimersByTimeAsync(30);
  await stopping;
  expect(await command).toMatchObject({ code: "PLUGIN_E_CANCELLED" });
  expect(supervisor.state).toBe("idle");
  finishLaunch(late.process);
  await vi.advanceTimersByTimeAsync(0);
  expect(late.killed()).toBe(true);
});
```

- [ ] **Step 2: 確認測試失敗**

Run: `pnpm --filter @kobrixa/plugin-runtime exec vitest run src/supervisor.test.ts`
Expected: FAIL。cancelled 測試會得到 `PLUGIN_E_DISABLED`；握手測試逾時（`await exited` 沒有上限）；launch 測試的 `stopping` 永遠不會 resolve。

- [ ] **Step 3: 實作**

在 `packages/plugin-runtime/src/supervisor.ts`：

1. `export type SupervisorState = …` 下一行加：

```ts
/** Why a stop interrupts running commands: a disable, or a reload/removal that cancels them. */
export type StopReason = "disabled" | "cancelled";
```

2. 欄位：在 `#forced = false;` 之後加：

```ts
  #stopReason: StopReason = "disabled";
  /** Set while a launch is in flight; stop() calls it when the launch outlives the stop bound. */
  #abandonLaunch: (() => void) | undefined;
```

3. 把 `stop()` 換成：

```ts
  stop(reason: StopReason = "disabled"): Promise<void> {
    // Concurrent callers (disable, then app shutdown) share one stop: one shutdown request only.
    if (!this.#stoppingRun) this.#stopReason = reason;
    this.#stoppingRun ??= this.#stop().finally(() => {
      this.#stoppingRun = undefined;
    });
    return this.#stoppingRun;
  }
```

4. 在 `#stop()` 裡，把 `if (!this.#process) await this.#launching;` 換成：

```ts
if (!this.#process && this.#launching) {
  if (!(await this.#within(this.#launching, this.#stopBoundMs))) {
    // The launcher never settled: stop waiting, and kill its process if it appears later.
    this.#abandonLaunch?.();
    await this.#starting?.catch(() => undefined);
    return;
  }
}
```

5. 在 `#stop()` 裡，把從 `let bound: ReturnType<typeof setTimeout> | undefined;` 到 `clearTimeout(bound);` 的這段：

```ts
let bound: ReturnType<typeof setTimeout> | undefined;
const gaveUp = new Promise<boolean>((resolve) => {
  bound = setTimeout(
    () => resolve(false),
    this.#options.stopTimeoutMs + this.#options.exitTimeoutMs,
  );
});
if (!handshaking)
  void peer
    .request("shutdown", {}, { timeoutMs: this.#options.stopTimeoutMs })
    .then(() => peer.notify("exit", {}))
    .catch(() => child.kill());
const exitedInTime = await Promise.race([exited, gaveUp]);
clearTimeout(lingering);
clearTimeout(bound);
```

換成：

```ts
if (!handshaking)
  void peer
    .request("shutdown", {}, { timeoutMs: this.#options.stopTimeoutMs })
    .then(() => peer.notify("exit", {}))
    .catch(() => child.kill());
const exitedInTime = await this.#within(exited, this.#stopBoundMs);
clearTimeout(lingering);
```

6. 在 `forceKill()` 之前加兩個 helper：

```ts
  get #stopBoundMs(): number {
    return this.#options.stopTimeoutMs + this.#options.exitTimeoutMs;
  }

  /** True when `work` settles within `ms`; never leaves its timer behind. */
  async #within(work: Promise<unknown>, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  #stopError(message: string): PluginError {
    return new PluginError(
      this.#stopReason === "cancelled" ? "PLUGIN_E_CANCELLED" : "PLUGIN_E_DISABLED",
      message,
    );
  }
```

7. `#ensureStarted()` 的第一個 reject 改成：

```ts
if (this.#stopping) return Promise.reject(this.#stopError(`${this.plugin.id} is stopping.`));
```

8. `#start()` 裡，從 `let child: PluginProcess;` 到 `} finally { this.#launching = undefined; }` 換成：

```ts
let child: PluginProcess;
const launching = this.launcher(this.plugin);
const abandoned = new Promise<"abandoned">((resolve) => {
  this.#abandonLaunch = () => resolve("abandoned");
});
this.#launching = launching.then(
  () => undefined,
  () => undefined,
);
let launched: PluginProcess | "abandoned";
try {
  launched = await Promise.race([launching, abandoned]);
} catch (error) {
  this.#problem = { code: "PLUGIN_E_LAUNCH", message: messageOf(error) };
  this.#setState("idle");
  throw new PluginError("PLUGIN_E_LAUNCH", this.#problem.message);
} finally {
  this.#launching = undefined;
  this.#abandonLaunch = undefined;
}
if (launched === "abandoned") {
  void launching.then(
    (late) => late.forceKill(),
    () => undefined,
  );
  this.#setState("idle");
  throw this.#stopError(`${this.plugin.id} was stopped before it finished launching.`);
}
child = launched;
```

9. `#start()` 裡其餘三個 `new PluginError("PLUGIN_E_DISABLED", …)` 改用 `this.#stopError(…)`，訊息不變：

```ts
if (this.#stopping) {
  if (this.#forced) child.forceKill();
  throw this.#stopError(`${this.plugin.id} is stopping.`);
}
```

```ts
if (this.#stopping || this.#stoppedPeers.has(peer))
  throw this.#stopError(`${this.plugin.id} was stopped.`);
```

```ts
if (this.#stopping || this.#stoppedPeers.has(peer))
  throw this.#stopError(`${this.plugin.id} is stopping.`);
```

10. 握手失敗的等待：把

```ts
const exited = new Promise<void>((resolve) => child.onExit(() => resolve()));
this.#terminate(child, { code: "PLUGIN_E_HANDSHAKE", message: messageOf(error) });
await exited;
```

換成

```ts
const exited = new Promise<void>((resolve) => child.onExit(() => resolve()));
this.#terminate(child, { code: "PLUGIN_E_HANDSHAKE", message: messageOf(error) });
if (!(await this.#within(exited, this.#stopBoundMs)))
  this.#exited(child, peer, { code: null, reason: "did not exit after a forced kill" });
```

11. `#translate()` 裡 `connectionClosed` 的分支改成依原因回錯誤碼：

```ts
const code: PluginErrorCode =
  error.code === RPC_ERRORS.connectionClosed
    ? this.#stopping || this.#stoppedPeers.has(peer)
      ? this.#stopError(error.message).code
      : (this.#problem?.code ?? "PLUGIN_E_CRASHED")
    : error.code === RPC_ERRORS.timeout
      ? "PLUGIN_E_TIMEOUT"
      : error.code === RPC_ERRORS.requestCancelled
        ? "PLUGIN_E_CANCELLED"
        : "PLUGIN_E_COMMAND_FAILED";
```

- [ ] **Step 4: 跑測試**

Run: `pnpm --filter @kobrixa/plugin-runtime exec vitest run src/supervisor.test.ts`
Expected: PASS（含既有的 `"rejects a command interrupted by stop as disabled"` 與 `"retains the stop cause …"`）。

- [ ] **Step 5: 格式檢查並提交**

```bash
pnpm exec prettier --write packages/plugin-runtime/src/supervisor.ts packages/plugin-runtime/src/supervisor.test.ts
git add packages/plugin-runtime/src/supervisor.ts packages/plugin-runtime/src/supervisor.test.ts
git commit -m "fix(plugin-runtime): bound launch and handshake waits and report cancelled stops"
```

---

### Task 3: PluginManager 改以 sourceKey 追蹤，加入 revision 與狀態檔容錯

**Files:**

- Modify: `packages/plugin-runtime/src/manager.ts`（整檔替換）
- Modify: `packages/plugin-runtime/src/manager.test.ts`

**Interfaces:**

- Consumes: Task 1 的 `readSource`、`resolvePlugins`、`ReadPlugin`、`RegisteredPlugin`、`DevelopmentSource`、`developmentSourceKey`；Task 2 的 `StopReason`、`stop(reason)`。
- Produces:
  - `interface PluginPersistedState { disabled: ReadonlySet<string>; legacyDisabledIds: ReadonlySet<string> }`
  - `interface PluginStateStore { load(): Promise<PluginPersistedState & { problem?: string }>; save(state: PluginPersistedState): Promise<void> }`
  - `PluginManagerOptions.sourceReadTimeoutMs?: number`
  - `PluginSummary.sourceKey: string`
  - `PluginsSnapshot.revision: number`、`PluginsSnapshot.stateProblem?: PluginProblem`
  - `PluginNotice.sourceKey: string`
  - `PluginActionResult = { ok: true; state: PluginsSnapshot; persisted?: false } | Failure`
  - `PluginManager.setEnabled(sourceKey: string, enabled: boolean)`
  - 私有基礎設施，供 Task 4 使用：`#enqueue`、`#closed`、`#entryOf`、`#reconcile`、`#retire`、`#saveBestEffort`、module 層級的 `convertLegacy` 與 `readOptions`

- [ ] **Step 1: 改測試（先讓它失敗）**

在 `packages/plugin-runtime/src/manager.test.ts`：

1. import 換成：

```ts
import {
  developmentSourceKey,
  PluginManager,
  PluginSupervisor,
  spawnPluginProcess,
  type PluginManagerEvent,
  type PluginPersistedState,
  type PluginStateStore,
} from "./index.js";
```

2. `memoryStore` 整個換成：

```ts
function memoryStore(
  initial: string[] = [],
  legacy: string[] = [],
): PluginStateStore & { saved: PluginPersistedState[] } {
  const saved: PluginPersistedState[] = [];
  let value: PluginPersistedState = {
    disabled: new Set(initial),
    legacyDisabledIds: new Set(legacy),
  };
  return {
    saved,
    load: async () => ({
      disabled: new Set(value.disabled),
      legacyDisabledIds: new Set(value.legacyDisabledIds),
    }),
    save: async (next) => {
      value = {
        disabled: new Set(next.disabled),
        legacyDisabledIds: new Set(next.legacyDisabledIds),
      };
      saved.push(value);
    },
  };
}
const keyOf = (source: { directory: string }) => developmentSourceKey(source.directory);
const savedDisabled = (store: { saved: PluginPersistedState[] }) =>
  store.saved.map((state) => [...state.disabled].sort());
```

3. 依下表更新既有測試。左欄是原本的程式碼，右欄是替換內容。每個測試先把 `await devPlugin("x")` 存成變數（例如 `const hello = await devPlugin("hello");`），再傳給 `create`。

| 測試                                                | 原本                                                                                                               | 改成                                                                                                                                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| routes commands…                                    | `notice: { pluginId: "acme.hello", severity: "info", message: "hi", at: 1000 }`                                    | `notice: { pluginId: "acme.hello", sourceKey: keyOf(hello), severity: "info", message: "hi", at: 1000 }`                                                                                                                           |
| does not register…                                  | `memoryStore(["acme.hello"])`                                                                                      | `memoryStore([keyOf(hello)])`                                                                                                                                                                                                      |
| persists disabling…                                 | `setEnabled("acme.hello", …)`；`expect(store.saved).toEqual([["acme.hello"]])`                                     | `setEnabled(keyOf(hello), …)`；`expect(savedDisabled(store)).toEqual([[keyOf(hello)]])`                                                                                                                                            |
| isolates throwing listeners…                        | `setEnabled("acme.a", false)`；`notice: { pluginId: "acme.b", severity: …`                                         | `setEnabled(keyOf(a), false)`；`notice: { pluginId: "acme.b", sourceKey: keyOf(b), severity: …`                                                                                                                                    |
| lets safe mode persist…                             | `setEnabled("acme.hello", …)`；`expect(store.saved).toEqual([["acme.hello"]])`                                     | `setEnabled(keyOf(hello), …)`；`expect(savedDisabled(store)).toEqual([[keyOf(hello)]])`                                                                                                                                            |
| refuses to disable built-in plugins and unknown ids | `setEnabled("kobrixa.basic-plus", false)`；`setEnabled("acme.nope", false)`                                        | `setEnabled("builtin:kobrixa.basic-plus", false)`；`setEnabled("dev:ffffffffffffffff", false)`                                                                                                                                     |
| persists concurrent changes…                        | 兩個 `setEnabled("acme.a"/"acme.b", false)`；兩行 saved／load 斷言                                                 | `setEnabled(keyOf(a), false)`、`setEnabled(keyOf(b), false)`；`expect(savedDisabled(store).at(-1)).toEqual([keyOf(a), keyOf(b)].sort())`；`expect([...(await store.load()).disabled].sort()).toEqual([keyOf(a), keyOf(b)].sort())` |
| resumes after a shutdown…                           | `setEnabled("acme.a", false)).toMatchObject({ code: "PLUGIN_E_DISABLED" })` 與第二個 `setEnabled("acme.a", false)` | `setEnabled(keyOf(a), false)).toMatchObject({ code: "PLUGIN_E_SHUTTING_DOWN" })` 與 `setEnabled(keyOf(a), false)`                                                                                                                  |
| resumes after a rejected shutdown…                  | `setEnabled("acme.a", false)`                                                                                      | `setEnabled(keyOf(a), false)`                                                                                                                                                                                                      |
| keeps tracking a plugin…                            | `setEnabled("acme.slow", false)`                                                                                   | `setEnabled(keyOf(slow), false)`（其中 `const slow = await devPlugin("slow");`）                                                                                                                                                   |

4. 把 `"lets safe mode persist a disable but refuses to enable"` 裡的狀態斷言換成：

```ts
expect(manager.state().plugins[0]).toMatchObject({
  id: "hello",
  sourceKey: keyOf(hello),
  status: "disabled",
  disabledBy: "safe-mode",
  commands: [],
});
```

5. 把 `"keeps state unchanged when saving fails"` 整個 `it` 換成：

```ts
it("still stops a plugin whose disable cannot be saved, but refuses an unsaved enable", async () => {
  const store = memoryStore();
  const hello = await devPlugin("hello");
  const manager = await create([hello], store);
  store.save = async () => {
    throw new Error("disk full");
  };
  await manager.executeCommand("acme.hello.greet");
  expect(await manager.setEnabled(keyOf(hello), false)).toMatchObject({
    ok: true,
    persisted: false,
  });
  expect(await manager.executeCommand("acme.hello.greet")).toMatchObject({
    code: "PLUGIN_E_UNKNOWN_COMMAND",
  });
  expect(manager.active).toBe(false);
  expect(await manager.setEnabled(keyOf(hello), true)).toMatchObject({
    ok: false,
    code: "PLUGIN_E_STATE_SAVE",
  });
});
```

6. 在 `describe` 結尾（最後一個 `it` 之後）加：

```ts
it("increases the snapshot revision with every state event", async () => {
  const hello = await devPlugin("hello");
  const manager = await create([hello]);
  const revisions: number[] = [];
  manager.onEvent((event) => {
    if (event.type === "state") revisions.push(event.state.revision);
  });
  const before = manager.state().revision;
  await manager.executeCommand("acme.hello.greet");
  const result = await manager.setEnabled(keyOf(hello), false);
  expect(revisions.length).toBeGreaterThan(1);
  expect(revisions).toEqual([...revisions].sort((x, y) => x - y));
  expect(new Set(revisions).size).toBe(revisions.length);
  expect(revisions[0]).toBeGreaterThan(before);
  expect(result).toMatchObject({ ok: true, state: { revision: revisions.at(-1) } });
});
it("keeps a duplicate-id row from borrowing another row's running state", async () => {
  const first = await devPlugin("hello");
  const copy = path.join(root, "copy");
  await mkdir(copy);
  await writeFile(path.join(copy, "main.py"), "");
  await writeFile(
    path.join(copy, "kobrixa-plugin.json"),
    await readFile(path.join(first.directory, "kobrixa-plugin.json"), "utf8"),
  );
  const manager = await create([first, { kind: "development", directory: copy }]);
  await manager.executeCommand("acme.hello.greet");
  const [original, duplicate] = manager.state().plugins;
  expect(original).toMatchObject({ status: "enabled", running: true });
  expect(duplicate).toMatchObject({ status: "invalid", running: false });
  expect(duplicate!.sourceKey).not.toBe(original!.sourceKey);
});
it("converts schema v1 disables once the manifest id is known", async () => {
  const hello = await devPlugin("hello");
  const store = memoryStore([], ["acme.hello"]);
  const manager = await create([hello], store);
  expect(manager.state().plugins[0]).toMatchObject({ status: "disabled", disabledBy: "user" });
  expect(store.saved.at(-1)).toEqual({
    disabled: new Set([keyOf(hello)]),
    legacyDisabledIds: new Set(),
  });
  expect(launcher).not.toHaveBeenCalled();
});
it("fails closed on a corrupt state store and recovers after a successful save", async () => {
  const hello = await devPlugin("hello");
  const store = memoryStore();
  store.load = async () => ({
    disabled: new Set(),
    legacyDisabledIds: new Set(),
    problem: "moved to state.json.corrupt-1",
  });
  const manager = await create([builtin, hello], store);
  expect(manager.state().stateProblem).toEqual({
    code: "PLUGIN_E_STATE_CORRUPT",
    message: "moved to state.json.corrupt-1",
  });
  expect(manager.state().plugins.map((plugin) => plugin.status)).toEqual(["enabled", "disabled"]);
  expect(await manager.setEnabled(keyOf(hello), true)).toMatchObject({ ok: true });
  expect(manager.state().stateProblem).toBeUndefined();
  expect(savedDisabled(store)).toEqual([[]]);
});
it("treats a store that cannot be read like a corrupt one", async () => {
  const hello = await devPlugin("hello");
  const store = memoryStore();
  store.load = async () => {
    throw new Error("EACCES");
  };
  const manager = await create([hello], store);
  expect(manager.state().stateProblem).toMatchObject({ code: "PLUGIN_E_STATE_CORRUPT" });
  expect(manager.state().plugins[0]!.status).toBe("disabled");
});
```

並把檔頭的 fs import 改成 `import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";`。

- [ ] **Step 2: 確認測試失敗**

Run: `pnpm --filter @kobrixa/plugin-runtime exec vitest run src/manager.test.ts`
Expected: FAIL（`sourceKey`、`revision`、`PluginPersistedState` 不存在等）。

- [ ] **Step 3: 整檔替換 `packages/plugin-runtime/src/manager.ts`**

```ts
import type { LocalizedText, PluginLocale, Severity } from "@kobrixa/plugin-protocol";
import { messageOf, PluginError, type PluginErrorCode, type PluginProblem } from "./errors.js";
import {
  readSource,
  resolvePlugins,
  type PluginSource,
  type ReadPlugin,
  type RegisteredPlugin,
} from "./registry.js";
import {
  PluginSupervisor,
  type PluginLauncher,
  type StopReason,
  type SupervisorOptions,
} from "./supervisor.js";

export interface PluginPersistedState {
  /** Source keys of development plugins the user disabled. */
  disabled: ReadonlySet<string>;
  /** Manifest ids kept from schema v1; each becomes a source key once a source with it loads. */
  legacyDisabledIds: ReadonlySet<string>;
}
export interface PluginStateStore {
  /** `problem` reports a corrupt store: the manager then keeps third-party plugins disabled. */
  load(): Promise<PluginPersistedState & { problem?: string }>;
  save(state: PluginPersistedState): Promise<void>;
}
export interface PluginManagerOptions {
  sources: readonly PluginSource[];
  store: PluginStateStore;
  safeMode: boolean;
  launcher: PluginLauncher;
  locale: PluginLocale;
  supervisor?: Omit<SupervisorOptions, "locale" | "onNotice" | "onStateChange">;
  /** Bound on reading one development folder; defaults to SOURCE_READ_TIMEOUT_MS. */
  sourceReadTimeoutMs?: number;
  now?(): number;
}
export interface PluginSummary {
  sourceKey: string;
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
  /** Increases with every state event; keep the snapshot with the highest revision. */
  revision: number;
  safeMode: boolean;
  developmentMode: boolean;
  /** The settings file was corrupt or unreadable; cleared by the next successful save. */
  stateProblem?: PluginProblem;
  plugins: PluginSummary[];
}
export interface PluginNotice {
  pluginId: string;
  sourceKey: string;
  severity: Severity;
  message: string;
  at: number;
}
export type PluginManagerEvent =
  { type: "state"; state: PluginsSnapshot } | { type: "notice"; notice: PluginNotice };
type Failure = { ok: false; code: PluginErrorCode; message: string };
export type PluginCommandResult = { ok: true } | Failure;
/** `persisted: false`: the change applies to this session but could not be saved. */
export type PluginActionResult = { ok: true; state: PluginsSnapshot; persisted?: false } | Failure;
const failure = (code: PluginErrorCode, message: string): Failure => ({ ok: false, code, message });
/** Default overall bound for shutdown(); the quit cleanup waits slightly longer (task 12). */
export const PLUGIN_SHUTDOWN_DEADLINE_MS = 4_000;
/** Time between force-killing leftovers and the deadline, for exit reports to arrive. */
export const PLUGIN_FORCE_MARGIN_MS = 1_000;

interface Entry {
  readonly source: PluginSource;
  read: ReadPlugin;
  plugin: RegisteredPlugin;
  /** Increases on every reload; events from an older generation's supervisor are dropped. */
  generation: number;
}
const commandIds = (plugin: RegisteredPlugin) =>
  (plugin.manifest?.contributes?.commands ?? []).map((command) => command.id);
const unresolved = (read: ReadPlugin): RegisteredPlugin => ({
  ...read,
  problems: [...read.problems],
  status: "invalid",
});
const readOptions = (options: PluginManagerOptions) => ({
  safeMode: options.safeMode,
  ...(options.sourceReadTimeoutMs === undefined ? {} : { timeoutMs: options.sourceReadTimeoutMs }),
});
/** Converts schema v1 disables (manifest ids) once a development source with that id was read. */
function convertLegacy(
  reads: Iterable<ReadPlugin>,
  disabled: Set<string>,
  legacy: Set<string>,
): boolean {
  let changed = false;
  for (const read of reads) {
    if (read.source !== "development" || !read.manifest || !legacy.has(read.id)) continue;
    disabled.add(read.sourceKey);
    legacy.delete(read.id);
    changed = true;
  }
  return changed;
}

export class PluginManager {
  #entries: Entry[];
  /** Keyed by source key: only the current supervisor of each enabled plugin. */
  readonly #supervisors = new Map<string, PluginSupervisor>();
  /** Supervisors of plugins being disabled, reloaded or removed stay tracked until they stop. */
  readonly #retiring = new Set<PluginSupervisor>();
  /** Command id → source key. */
  readonly #commands = new Map<string, string>();
  readonly #listeners = new Set<(event: PluginManagerEvent) => void>();
  #shutdown: Promise<void> | undefined;
  #changes: Promise<unknown> = Promise.resolve();
  #revision = 0;
  #disabled: Set<string>;
  readonly #legacy: Set<string>;
  #stateProblem: PluginProblem | undefined;

  static async create(options: PluginManagerOptions): Promise<PluginManager> {
    let stored: PluginPersistedState & { problem?: string };
    try {
      stored = await options.store.load();
    } catch (error) {
      stored = { disabled: new Set(), legacyDisabledIds: new Set(), problem: messageOf(error) };
    }
    const reads = await Promise.all(
      options.sources.map((source) => readSource(source, readOptions(options))),
    );
    const disabled = new Set(stored.disabled);
    const legacy = new Set(stored.legacyDisabledIds);
    const converted = convertLegacy(reads, disabled, legacy);
    const manager = new PluginManager(
      options,
      { disabled, legacy, problem: stored.problem },
      options.sources.map((source, index) => ({ source, read: reads[index]! })),
    );
    if (converted) await manager.#saveBestEffort();
    return manager;
  }

  private constructor(
    private readonly options: PluginManagerOptions,
    stored: { disabled: Set<string>; legacy: Set<string>; problem: string | undefined },
    sources: { source: PluginSource; read: ReadPlugin }[],
  ) {
    this.#disabled = stored.disabled;
    this.#legacy = stored.legacy;
    this.#entries = sources.map(({ source, read }) => ({
      source,
      read,
      plugin: unresolved(read),
      generation: 0,
    }));
    if (stored.problem !== undefined) {
      this.#stateProblem = { code: "PLUGIN_E_STATE_CORRUPT", message: stored.problem };
      // Fail closed: the unreadable file may have kept a problem plugin disabled.
      for (const { read } of this.#entries)
        if (read.source === "development") this.#disabled.add(read.sourceKey);
    }
    this.#reconcile();
  }

  state(): PluginsSnapshot {
    return {
      revision: this.#revision,
      safeMode: this.options.safeMode,
      developmentMode: this.#entries.some((entry) => entry.read.source === "development"),
      ...(this.#stateProblem ? { stateProblem: this.#stateProblem } : {}),
      plugins: this.#entries.map((entry) => this.#summary(entry)),
    };
  }

  frontendFor(language: string): string | undefined {
    return this.#entries.find(
      ({ plugin }) =>
        plugin.status === "enabled" &&
        plugin.manifest?.contributes?.frontends?.some((item) => item.language === language),
    )?.plugin.id;
  }

  async executeCommand(commandId: string): Promise<PluginCommandResult> {
    if (this.#shutdown) return failure("PLUGIN_E_DISABLED", "Kobrixa is shutting down plugins.");
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

  setEnabled(sourceKey: string, enabled: boolean): Promise<PluginActionResult> {
    return this.#enqueue(() => this.#setEnabled(sourceKey, enabled));
  }

  async #setEnabled(sourceKey: string, enabled: boolean): Promise<PluginActionResult> {
    const closed = this.#closed();
    if (closed) return closed;
    const entry = this.#entryOf(sourceKey);
    if (!entry || entry.plugin.status === "invalid")
      return failure("PLUGIN_E_UNKNOWN_PLUGIN", `No valid plugin has the source ${sourceKey}.`);
    if (entry.read.source === "builtin")
      return failure(
        "PLUGIN_E_BUILTIN_REQUIRED",
        `${entry.plugin.id} is part of Kobrixa and cannot be disabled in this version.`,
      );
    if (enabled && this.options.safeMode)
      return failure(
        "PLUGIN_E_SAFE_MODE",
        "Restart Kobrixa without --safe-mode to enable development plugins.",
      );
    if (this.#disabled.has(sourceKey) !== enabled) return { ok: true, state: this.state() };
    const next = new Set(this.#disabled);
    if (enabled) next.delete(sourceKey);
    else next.add(sourceKey);
    let persisted = true;
    try {
      await this.#save(next);
    } catch (error) {
      // Enabling must be saved first; a disable still applies now so a problem plugin can stop.
      if (enabled) return failure("PLUGIN_E_STATE_SAVE", messageOf(error));
      persisted = false;
    }
    this.#disabled = next;
    await this.#apply("disabled");
    return { ok: true, state: this.state(), ...(persisted ? {} : { persisted: false as const }) };
  }

  onEvent(listener: (event: PluginManagerEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** True while any plugin process is starting, running or stopping, including disabled ones. */
  get active(): boolean {
    return (
      this.#retiring.size > 0 ||
      [...this.#supervisors.values()].some((supervisor) =>
        ["starting", "running", "stopping"].includes(supervisor.state),
      )
    );
  }

  /**
   * Stops every plugin process, including plugins still being disabled, within deadlineMs.
   * Graceful stops run first; whatever is still alive at deadlineMs - PLUGIN_FORCE_MARGIN_MS is
   * force-killed, so callers can quit as soon as this resolves. Idempotent; afterwards commands
   * and changes are refused.
   */
  shutdown(deadlineMs: number = PLUGIN_SHUTDOWN_DEADLINE_MS): Promise<void> {
    this.#shutdown ??= (async () => {
      const supervisors = [...this.#supervisors.values(), ...this.#retiring];
      const stopped = Promise.all(supervisors.map((supervisor) => supervisor.stop())).then(
        () => true,
      );
      const waitForStop = async (ms: number) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            stopped,
            new Promise<false>((resolve) => {
              timer = setTimeout(() => resolve(false), ms);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      const forceAt = Math.max(0, deadlineMs - PLUGIN_FORCE_MARGIN_MS);
      if (await waitForStop(forceAt)) return;
      for (const supervisor of supervisors) supervisor.forceKill();
      await waitForStop(deadlineMs - forceAt);
    })();
    return this.#shutdown;
  }

  /**
   * Reopens plugin services after a shutdown that did not end the app, such as a failed update
   * installation. Stopped plugins restart lazily on their next command; nothing is replayed.
   */
  async resume(): Promise<void> {
    if (!this.#shutdown) return;
    await this.#shutdown.catch(() => undefined);
    this.#shutdown = undefined;
    this.#emitState();
  }

  /** Changes are serialized so each one computes and saves the next state from the latest one. */
  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const change = this.#changes.then(work);
    this.#changes = change.catch(() => undefined);
    return change;
  }

  #closed(): Failure | undefined {
    return this.#shutdown
      ? failure("PLUGIN_E_SHUTTING_DOWN", "Kobrixa is shutting down plugins.")
      : undefined;
  }

  #entryOf(sourceKey: string): Entry | undefined {
    return this.#entries.find((entry) => entry.read.sourceKey === sourceKey);
  }

  /** Reconciles, publishes the new statuses at once, then waits for retired processes to stop. */
  async #apply(reason: StopReason): Promise<void> {
    const retired = this.#reconcile();
    this.#emitState();
    if (!retired.length) return;
    await this.#retire(retired, reason);
    this.#emitState();
  }

  /**
   * Recomputes every status from the whole set and keeps only the supervisors of plugins that
   * are still enabled. Returns the supervisors that must now stop.
   */
  #reconcile(): PluginSupervisor[] {
    const resolved = resolvePlugins(
      this.#entries.map((entry) => entry.read),
      { disabled: this.#disabled, safeMode: this.options.safeMode },
    );
    const live = new Set<string>();
    this.#commands.clear();
    this.#entries.forEach((entry, index) => {
      entry.plugin = resolved[index]!;
      if (entry.plugin.status !== "enabled") return;
      const key = entry.read.sourceKey;
      live.add(key);
      if (!this.#supervisors.has(key)) this.#register(entry);
      if (this.#supervisors.has(key))
        for (const command of commandIds(entry.plugin)) this.#commands.set(command, key);
    });
    const retired: PluginSupervisor[] = [];
    for (const [key, supervisor] of this.#supervisors)
      if (!live.has(key)) {
        this.#supervisors.delete(key);
        retired.push(supervisor);
      }
    return retired;
  }

  async #retire(supervisors: readonly PluginSupervisor[], reason: StopReason): Promise<void> {
    await Promise.all(
      supervisors.map(async (supervisor) => {
        this.#retiring.add(supervisor);
        try {
          await supervisor.stop(reason);
        } finally {
          this.#retiring.delete(supervisor);
        }
      }),
    );
  }

  async #save(disabled: ReadonlySet<string>): Promise<void> {
    await this.options.store.save({ disabled, legacyDisabledIds: this.#legacy });
    this.#stateProblem = undefined;
  }

  async #saveBestEffort(): Promise<void> {
    try {
      await this.#save(this.#disabled);
    } catch {
      // Kept in memory; the next successful save writes it.
    }
  }

  #register(entry: Entry): void {
    const { plugin } = entry;
    const manifest = plugin.manifest;
    if (!manifest || manifest.runtime.kind === "builtin" || !plugin.entry || !plugin.directory)
      return;
    const { sourceKey } = plugin;
    const generation = entry.generation;
    // A removed or reloaded source's old process must not reach the current row.
    const current = () => this.#entryOf(sourceKey)?.generation === generation;
    const supervisor = new PluginSupervisor(
      {
        id: plugin.id,
        directory: plugin.directory,
        entry: plugin.entry,
        runtime: manifest.runtime.kind,
        permissions: manifest.permissions ?? [],
        commands: commandIds(plugin),
      },
      this.options.launcher,
      {
        ...this.options.supervisor,
        locale: this.options.locale,
        onNotice: (notice) => {
          if (!current()) return;
          this.#emit({
            type: "notice",
            notice: {
              pluginId: plugin.id,
              sourceKey,
              ...notice,
              at: (this.options.now ?? Date.now)(),
            },
          });
        },
        onStateChange: () => {
          if (current()) this.#emitState();
        },
      },
    );
    this.#supervisors.set(sourceKey, supervisor);
  }

  #summary({ plugin }: Entry): PluginSummary {
    const supervisor = this.#supervisors.get(plugin.sourceKey);
    const manifest = plugin.manifest;
    return {
      sourceKey: plugin.sourceKey,
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
    this.#revision += 1;
    this.#emit({ type: "state", state: this.state() });
  }

  #emit(event: PluginManagerEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A listener must not interrupt plugin lifecycle operations or other listeners.
      }
    }
  }
}
```

- [ ] **Step 4: 跑整個 runtime 測試與型別檢查**

Run: `pnpm --filter @kobrixa/plugin-runtime exec vitest run && pnpm --filter @kobrixa/plugin-runtime check`
Expected: PASS。若 `"keeps tracking a plugin that is still being disabled"` 失敗，確認 `#apply` 在 `await this.#retire` **之前**就 `#emitState()`，也就是狀態先變成 disabled，之後才等程序結束。

- [ ] **Step 5: 格式檢查並提交**

```bash
pnpm exec prettier --write packages/plugin-runtime/src/manager.ts packages/plugin-runtime/src/manager.test.ts
git add packages/plugin-runtime/src/manager.ts packages/plugin-runtime/src/manager.test.ts
git commit -m "feat(plugin-runtime): track plugins by source key with revisions and fail-closed state"
```

---

### Task 4: PluginManager 的 addSource／removeSource／reloadSource

**Files:**

- Modify: `packages/plugin-runtime/src/manager.ts`
- Modify: `packages/plugin-runtime/src/manager.test.ts`

**Interfaces:**

- Consumes: Task 3 的私有基礎設施，以及 Task 1 的 `developmentSourceKey`、`DevelopmentSource`。
- Produces（1b 的 PluginController 會用）：
  - `addSource(source: DevelopmentSource): Promise<PluginActionResult>`：已存在時回 `PLUGIN_E_SOURCE_EXISTS`。
  - `removeSource(sourceKey: string): Promise<PluginActionResult>`：內建插件回 `PLUGIN_E_BUILTIN_REQUIRED`，不存在回 `PLUGIN_E_UNKNOWN_PLUGIN`。
  - `reloadSource(sourceKey: string): Promise<PluginActionResult>`：同上；安全模式中回 `PLUGIN_E_SAFE_MODE`。
  - 三者在關閉中都回 `PLUGIN_E_SHUTTING_DOWN`；被中斷的命令一律回 `PLUGIN_E_CANCELLED`。

- [ ] **Step 1: 寫失敗的測試**

在 `manager.test.ts` 檔頭的 fs import 再加入 `unlink`（`import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";`），並在 `describe` 結尾加：

```ts
describe("dynamic sources", () => {
  const hangingLauncher = vi.fn(
    async () =>
      memoryPlugin((peer, { exit }) => {
        peer.handle("initialize", () => ({
          apiVersion: "1.0.0",
          sdk: { name: "t", version: "1" },
        }));
        peer.handle("command/execute", () => new Promise(() => {}));
        peer.handle("shutdown", () => null);
        peer.onNotification("exit", () => exit(0));
      }).process,
  );
  afterEach(() => hangingLauncher.mockClear());
  const createWith = (
    sources: Parameters<typeof PluginManager.create>[0]["sources"],
    plugins = launcher,
  ) =>
    PluginManager.create({
      sources,
      store: memoryStore(),
      safeMode: false,
      launcher: plugins,
      locale: "en",
      now: () => 1000,
    });

  it("adds a folder, refuses the same folder twice and routes its commands", async () => {
    const manager = await createWith([builtin]);
    const hello = await devPlugin("hello");
    const added = await manager.addSource(hello);
    expect(added).toMatchObject({ ok: true });
    expect(manager.state().plugins.map((plugin) => plugin.sourceKey)).toEqual([
      "builtin:kobrixa.basic-plus",
      keyOf(hello),
    ]);
    expect(await manager.executeCommand("acme.hello.greet")).toEqual({ ok: true });
    expect(
      await manager.addSource({ kind: "development", directory: `${hello.directory}/.` }),
    ).toMatchObject({ ok: false, code: "PLUGIN_E_SOURCE_EXISTS" });
  });
  it("removes a source, cancels its running command and keeps its files", async () => {
    const hello = await devPlugin("hello");
    const manager = await createWith([hello], hangingLauncher);
    const running = manager.executeCommand("acme.hello.greet");
    await vi.waitFor(() => expect(manager.state().plugins[0]!.running).toBe(true));
    expect(await manager.removeSource(keyOf(hello))).toMatchObject({ ok: true });
    expect(await running).toMatchObject({ ok: false, code: "PLUGIN_E_CANCELLED" });
    expect(manager.state().plugins).toEqual([]);
    expect(manager.active).toBe(false);
    await expect(
      readFile(path.join(hello.directory, "kobrixa-plugin.json"), "utf8"),
    ).resolves.toContain("acme.hello");
  });
  it("refuses to remove or reload built-ins and unknown sources", async () => {
    const manager = await createWith([builtin]);
    expect(await manager.removeSource("builtin:kobrixa.basic-plus")).toMatchObject({
      code: "PLUGIN_E_BUILTIN_REQUIRED",
    });
    expect(await manager.reloadSource("builtin:kobrixa.basic-plus")).toMatchObject({
      code: "PLUGIN_E_BUILTIN_REQUIRED",
    });
    expect(await manager.removeSource("dev:ffffffffffffffff")).toMatchObject({
      code: "PLUGIN_E_UNKNOWN_PLUGIN",
    });
  });
  it("reloads a changed manifest, cancels the old command and never replays it", async () => {
    const hello = await devPlugin("hello");
    const manager = await createWith([hello], hangingLauncher);
    const running = manager.executeCommand("acme.hello.greet");
    await vi.waitFor(() => expect(manager.state().plugins[0]!.running).toBe(true));
    const file = path.join(hello.directory, "kobrixa-plugin.json");
    const changed = JSON.parse(await readFile(file, "utf8"));
    changed.contributes.commands.push({ id: "acme.hello.wave", title: "Wave" });
    await writeFile(file, JSON.stringify(changed));
    expect(await manager.reloadSource(keyOf(hello))).toMatchObject({ ok: true });
    expect(await running).toMatchObject({ ok: false, code: "PLUGIN_E_CANCELLED" });
    expect(hangingLauncher).toHaveBeenCalledTimes(1);
    expect(manager.state().plugins[0]).toMatchObject({
      sourceKey: keyOf(hello),
      status: "enabled",
      running: false,
    });
    expect(manager.state().plugins[0]!.commands.map((command) => command.id)).toEqual([
      "acme.hello.greet",
      "acme.hello.wave",
    ]);
  });
  it("keeps the disabled choice across a reload", async () => {
    const hello = await devPlugin("hello");
    const manager = await createWith([hello]);
    await manager.setEnabled(keyOf(hello), false);
    expect(await manager.reloadSource(keyOf(hello))).toMatchObject({ ok: true });
    expect(manager.state().plugins[0]).toMatchObject({ status: "disabled", disabledBy: "user" });
  });
  it("keeps a reload of a deleted folder as an invalid row without its old commands", async () => {
    const hello = await devPlugin("hello");
    const manager = await createWith([hello]);
    await unlink(path.join(hello.directory, "kobrixa-plugin.json"));
    expect(await manager.reloadSource(keyOf(hello))).toMatchObject({ ok: true });
    expect(manager.state().plugins[0]).toMatchObject({
      sourceKey: keyOf(hello),
      status: "invalid",
      commands: [],
    });
    expect(manager.state().plugins[0]!.problems[0]!.code).toBe("PLUGIN_E_MANIFEST");
    expect(await manager.executeCommand("acme.hello.greet")).toMatchObject({
      code: "PLUGIN_E_UNKNOWN_COMMAND",
    });
  });
  it("lets the earlier source keep an id when a reload takes another plugin's id", async () => {
    const a = await devPlugin("a");
    const b = await devPlugin("b");
    const manager = await createWith([a, b]);
    await manager.executeCommand("acme.b.greet");
    const file = path.join(a.directory, "kobrixa-plugin.json");
    const changed = JSON.parse(await readFile(file, "utf8"));
    changed.id = "acme.b";
    changed.contributes.commands = [{ id: "acme.b.other", title: "Other" }];
    await writeFile(file, JSON.stringify(changed));
    await manager.reloadSource(keyOf(a));
    const [first, second] = manager.state().plugins;
    expect(first).toMatchObject({ id: "acme.b", status: "enabled" });
    expect(second).toMatchObject({ id: "acme.b", status: "invalid", running: false });
    expect(second!.problems.map((problem) => problem.code)).toContain("PLUGIN_E_DUPLICATE_ID");
    expect(manager.active).toBe(false);
  });
  it("registers nothing when shutdown starts while a reload is queued", async () => {
    const hello = await devPlugin("hello");
    const manager = await createWith([hello]);
    const reloading = manager.reloadSource(keyOf(hello));
    const shutdown = manager.shutdown();
    expect(await reloading).toMatchObject({ ok: false, code: "PLUGIN_E_SHUTTING_DOWN" });
    await shutdown;
    expect(manager.active).toBe(false);
    expect(await manager.addSource(await devPlugin("late"))).toMatchObject({
      code: "PLUGIN_E_SHUTTING_DOWN",
    });
  });
  it("refuses reloads in safe mode", async () => {
    const hello = await devPlugin("hello");
    const manager = await create([hello], memoryStore(), true);
    expect(await manager.reloadSource(keyOf(hello))).toMatchObject({
      code: "PLUGIN_E_SAFE_MODE",
    });
  });
  it("drops notices from a removed source but delivers them while disabling", async () => {
    const farewell = vi.fn(
      async () =>
        memoryPlugin((peer, { exit }) => {
          peer.handle("initialize", () => ({
            apiVersion: "1.0.0",
            sdk: { name: "t", version: "1" },
          }));
          peer.handle("command/execute", () => null);
          peer.handle("shutdown", async () => {
            await peer.request("ui/showMessage", { severity: "info", message: "bye" });
            return null;
          });
          peer.onNotification("exit", () => exit(0));
        }).process,
    );
    const a = await devPlugin("a");
    const b = await devPlugin("b");
    const manager = await createWith([a, b], farewell);
    const messages: string[] = [];
    manager.onEvent((event) => {
      if (event.type === "notice")
        messages.push(`${event.notice.pluginId}:${event.notice.message}`);
    });
    await manager.executeCommand("acme.a.greet");
    await manager.executeCommand("acme.b.greet");
    await manager.setEnabled(keyOf(a), false);
    await manager.removeSource(keyOf(b));
    expect(messages).toEqual(["acme.a:bye"]);
  });
  it("converts a schema v1 disable when its folder is added later", async () => {
    const hello = await devPlugin("hello");
    const store = memoryStore([], ["acme.hello"]);
    const manager = await PluginManager.create({
      sources: [],
      store,
      safeMode: false,
      launcher,
      locale: "en",
    });
    await manager.addSource(hello);
    expect(manager.state().plugins[0]).toMatchObject({ status: "disabled", disabledBy: "user" });
    expect(store.saved.at(-1)!.legacyDisabledIds).toEqual(new Set());
  });
});
```

- [ ] **Step 2: 確認測試失敗**

Run: `pnpm --filter @kobrixa/plugin-runtime exec vitest run src/manager.test.ts -t "dynamic sources"`
Expected: FAIL，`manager.addSource is not a function`。

- [ ] **Step 3: 實作**

在 `packages/plugin-runtime/src/manager.ts`：

1. 檔頭 import 加上 `node:path`，並擴充 registry import：

```ts
import path from "node:path";
```

```ts
import {
  developmentSourceKey,
  readSource,
  resolvePlugins,
  type DevelopmentSource,
  type PluginSource,
  type ReadPlugin,
  type RegisteredPlugin,
} from "./registry.js";
```

2. 在 `onEvent(…)` 方法之前插入：

```ts
  /** Adds a development folder after startup. The folder is read before anything registers. */
  addSource(source: DevelopmentSource): Promise<PluginActionResult> {
    return this.#enqueue(() => this.#addSource(source));
  }

  /** Stops and unregisters a development source. Its files are never touched. */
  removeSource(sourceKey: string): Promise<PluginActionResult> {
    return this.#enqueue(() => this.#removeSource(sourceKey));
  }

  /**
   * Cancels the source's running commands, stops its process within the stop bound, then reads
   * its folder again and re-validates the whole set. Nothing is replayed; the next command starts
   * the new version lazily.
   */
  reloadSource(sourceKey: string): Promise<PluginActionResult> {
    return this.#enqueue(() => this.#reloadSource(sourceKey));
  }

  async #addSource(source: DevelopmentSource): Promise<PluginActionResult> {
    const closed = this.#closed();
    if (closed) return closed;
    const sourceKey = developmentSourceKey(source.directory);
    if (this.#entryOf(sourceKey))
      return failure(
        "PLUGIN_E_SOURCE_EXISTS",
        `${path.resolve(source.directory)} is already loaded.`,
      );
    const read = await readSource(source, readOptions(this.options));
    const closedAfterRead = this.#closed();
    if (closedAfterRead) return closedAfterRead;
    this.#entries.push({ source, read, plugin: unresolved(read), generation: 0 });
    if (convertLegacy([read], this.#disabled, this.#legacy)) await this.#saveBestEffort();
    await this.#apply("cancelled");
    return { ok: true, state: this.state() };
  }

  async #removeSource(sourceKey: string): Promise<PluginActionResult> {
    const refused = this.#refuseChange(sourceKey, "removed");
    if (refused) return refused;
    this.#entries = this.#entries.filter((entry) => entry.read.sourceKey !== sourceKey);
    if (this.#disabled.delete(sourceKey)) await this.#saveBestEffort();
    await this.#apply("cancelled");
    return { ok: true, state: this.state() };
  }

  async #reloadSource(sourceKey: string): Promise<PluginActionResult> {
    const refused = this.#refuseChange(sourceKey, "reloaded");
    if (refused) return refused;
    if (this.options.safeMode)
      return failure(
        "PLUGIN_E_SAFE_MODE",
        "Restart Kobrixa without safe mode to reload development plugins.",
      );
    const entry = this.#entryOf(sourceKey)!;
    // Block new commands and cancel running ones before the folder is read again.
    const supervisor = this.#supervisors.get(sourceKey);
    if (supervisor) {
      this.#supervisors.delete(sourceKey);
      for (const [command, owner] of this.#commands)
        if (owner === sourceKey) this.#commands.delete(command);
      this.#emitState();
      await this.#retire([supervisor], "cancelled");
    }
    entry.generation += 1;
    const read = await readSource(entry.source, readOptions(this.options));
    const closed = this.#closed();
    if (closed) return closed;
    entry.read = read;
    if (convertLegacy([read], this.#disabled, this.#legacy)) await this.#saveBestEffort();
    await this.#apply("cancelled");
    return { ok: true, state: this.state() };
  }

  #refuseChange(sourceKey: string, verb: "removed" | "reloaded"): Failure | undefined {
    const closed = this.#closed();
    if (closed) return closed;
    const entry = this.#entryOf(sourceKey);
    if (!entry)
      return failure("PLUGIN_E_UNKNOWN_PLUGIN", `No plugin source has the key ${sourceKey}.`);
    if (entry.read.source === "builtin")
      return failure(
        "PLUGIN_E_BUILTIN_REQUIRED",
        `${entry.plugin.id} is part of Kobrixa and cannot be ${verb}.`,
      );
    return undefined;
  }
```

- [ ] **Step 4: 跑整個 runtime 測試與型別檢查**

Run: `pnpm --filter @kobrixa/plugin-runtime exec vitest run && pnpm --filter @kobrixa/plugin-runtime check`
Expected: PASS。如果 `"registers nothing when shutdown starts while a reload is queued"` 拿到 `ok: true`，確認 `#reloadSource` 在 `await readSource` 之後先檢查 `#closed()`，才把 `entry.read` 換成新的。

- [ ] **Step 5: 格式檢查並提交**

```bash
pnpm exec prettier --write packages/plugin-runtime/src/manager.ts packages/plugin-runtime/src/manager.test.ts
git add packages/plugin-runtime/src/manager.ts packages/plugin-runtime/src/manager.test.ts
git commit -m "feat(plugin-runtime): add, remove and reload development sources at runtime"
```

---

### Task 5: 桌面 Node 插件等待 spawn 的上限

**Files:**

- Modify: `apps/desktop/src/main/plugins/launchers.ts`
- Modify: `apps/desktop/src/main/plugins/launchers.test.ts`

**Interfaces:**

- Produces: `PLUGIN_SPAWN_TIMEOUT_MS = 10_000`；`createDesktopLauncher(options: { python?: string; spawnTimeoutMs?: number })`

- [ ] **Step 1: 寫失敗的測試**

在 `launchers.test.ts` 結尾加：

```ts
it("kills a utilityProcess that never reports spawn and fails the launch", async () => {
  vi.useFakeTimers();
  try {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      postMessage: vi.fn(),
      kill: vi.fn(),
      pid: undefined,
    });
    vi.mocked(utilityProcess.fork).mockReturnValue(child as unknown as Electron.UtilityProcess);
    const launched = createDesktopLauncher({ spawnTimeoutMs: 50 })(plugin);
    const failed = expect(launched).rejects.toThrow("did not start within 50 ms");
    await vi.advanceTimersByTimeAsync(50);
    await failed;
    expect(child.kill).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
```

- [ ] **Step 2: 確認測試失敗**

Run: `pnpm --filter @kobrixa/plugin-runtime build && pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/launchers.test.ts`
Expected: FAIL（測試逾時：launch promise 永遠不會 settle）。

- [ ] **Step 3: 實作**

在 `launchers.ts`：

1. import 之後加：

```ts
/** A utilityProcess that reports neither spawn nor exit must not hang the launch. */
export const PLUGIN_SPAWN_TIMEOUT_MS = 10_000;
```

2. `launchNode` 的簽名與開頭改成（`sigkill` 移到前面，給逾時與 `escalatingKill` 共用）：

```ts
async function launchNode(
  plugin: LaunchablePlugin,
  onOutput: (line: string) => void,
  spawnTimeoutMs: number,
): Promise<PluginProcess> {
  const child = utilityProcess.fork(plugin.entry, [], {
    cwd: plugin.directory,
    serviceName: `Kobrixa plugin ${plugin.id}`,
    stdio: "pipe",
  });
  const sigkill = () => {
    try {
      if (child.pid !== undefined) process.kill(child.pid, "SIGKILL");
      else child.kill();
    } catch {
      /* The process already exited. */
    }
  };
  const tail = new OutputTail(onOutput);
  child.stdout?.on("data", (chunk: Buffer) => tail.push(chunk, "stdout"));
  child.stderr?.on("data", (chunk: Buffer) => tail.push(chunk, "stderr"));
  child.once("exit", () => tail.end());
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      sigkill();
      reject(new Error(`The plugin process did not start within ${spawnTimeoutMs} ms.`));
    }, spawnTimeoutMs);
    child.once("spawn", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The plugin process exited during launch (code ${code}).`));
    });
  });
```

3. `escalatingKill` 的第三個參數改成 `sigkill`：

```ts
const kill = escalatingKill(exits, () => child.kill(), sigkill);
```

4. `createDesktopLauncher` 改成：

```ts
export function createDesktopLauncher(options: {
  python?: string;
  spawnTimeoutMs?: number;
}): PluginLauncher {
  return async (plugin) => {
    const onOutput = (line: string) => console.error(`[plugin ${plugin.id}] ${line}`);
    if (plugin.runtime === "node")
      return launchNode(plugin, onOutput, options.spawnTimeoutMs ?? PLUGIN_SPAWN_TIMEOUT_MS);
```

其餘不變。

- [ ] **Step 4: 跑測試**

Run: `pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/launchers.test.ts`
Expected: PASS（三個測試）。

- [ ] **Step 5: 格式檢查並提交**

```bash
pnpm exec prettier --write apps/desktop/src/main/plugins/launchers.ts apps/desktop/src/main/plugins/launchers.test.ts
git add apps/desktop/src/main/plugins/launchers.ts apps/desktop/src/main/plugins/launchers.test.ts
git commit -m "fix(desktop): bound the wait for a plugin utilityProcess to spawn"
```

---

### Task 6: 桌面端狀態檔 v2

**Files:**

- Modify: `apps/desktop/src/main/plugins/state-store.ts`（整檔替換）
- Modify: `apps/desktop/src/main/plugins/state-store.test.ts`（整檔替換）

**Interfaces:**

- Consumes: Task 3 的 `PluginStateStore`、`PluginPersistedState`。
- Produces:
  - `type PluginStateDocument`（v2 的完整內容，1b 會用）
  - `filePluginStateStore(userData: string, options?: { now?(): Date }): PluginStateStore`。`save` 會保留 `developerMode`、`sources`、`python`、`safeModeLock` 等 manager 不認得的欄位。

- [ ] **Step 1: 整檔替換測試**

```ts
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { filePluginStateStore } from "./state-store.js";

let root: string;
const file = () => path.join(root, "plugins/state.json");
const stored = async () => JSON.parse(await readFile(file(), "utf8"));
const state = (disabled: string[], legacy: string[] = []) => ({
  disabled: new Set(disabled),
  legacyDisabledIds: new Set(legacy),
});
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-plugin-state-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

it("starts empty on first launch and round-trips schema v2", async () => {
  const store = filePluginStateStore(root);
  expect(await store.load()).toEqual(state([]));
  await store.save(state(["dev:bbbbbbbbbbbbbbbb", "dev:aaaaaaaaaaaaaaaa"]));
  expect(await stored()).toEqual({
    schemaVersion: 2,
    developerMode: false,
    sources: [],
    disabled: ["dev:aaaaaaaaaaaaaaaa", "dev:bbbbbbbbbbbbbbbb"],
    legacyDisabledIds: [],
  });
  expect(await filePluginStateStore(root).load()).toEqual(
    state(["dev:aaaaaaaaaaaaaaaa", "dev:bbbbbbbbbbbbbbbb"]),
  );
});

it("migrates schema v1 manifest ids into legacyDisabledIds", async () => {
  await mkdir(path.join(root, "plugins"));
  await writeFile(file(), JSON.stringify({ schemaVersion: 1, disabled: ["acme.b", "acme.a"] }));
  const store = filePluginStateStore(root);
  expect(await store.load()).toEqual(state([], ["acme.a", "acme.b"]));
  await store.save(state(["dev:aaaaaaaaaaaaaaaa"], ["acme.b"]));
  expect(await stored()).toMatchObject({
    schemaVersion: 2,
    disabled: ["dev:aaaaaaaaaaaaaaaa"],
    legacyDisabledIds: ["acme.b"],
  });
});

it("keeps fields it does not manage when saving", async () => {
  await mkdir(path.join(root, "plugins"));
  const document = {
    schemaVersion: 2,
    developerMode: true,
    sources: [{ directory: "/work/hello" }],
    disabled: [],
    legacyDisabledIds: [],
    python: { executable: "/usr/bin/python3", args: [] },
    safeModeLock: { since: "2026-10-15T00:00:00.000Z", reason: "unclean-exit" },
  };
  await writeFile(file(), JSON.stringify(document));
  const store = filePluginStateStore(root);
  await store.load();
  await store.save(state(["dev:aaaaaaaaaaaaaaaa"]));
  expect(await stored()).toEqual({ ...document, disabled: ["dev:aaaaaaaaaaaaaaaa"] });
});

it("backs up a corrupt file and reports it instead of silently enabling everything", async () => {
  await mkdir(path.join(root, "plugins"));
  await writeFile(file(), "{broken");
  const store = filePluginStateStore(root, { now: () => new Date("2026-10-15T01:02:03.000Z") });
  const loaded = await store.load();
  expect(loaded).toMatchObject(state([]));
  expect(loaded.problem).toContain("state.json.corrupt-2026-10-15T01-02-03.000Z");
  expect(await readdir(path.join(root, "plugins"))).toEqual([
    "state.json.corrupt-2026-10-15T01-02-03.000Z",
  ]);
});

it("treats a schema-invalid file as corrupt", async () => {
  await mkdir(path.join(root, "plugins"));
  await writeFile(file(), JSON.stringify({ schemaVersion: 2, disabled: "nope" }));
  expect((await filePluginStateStore(root).load()).problem).toBeDefined();
});

it("serializes concurrent saves so the last one wins", async () => {
  const store = filePluginStateStore(root);
  await Promise.all([
    store.save(state(["dev:aaaaaaaaaaaaaaaa"])),
    store.save(state(["dev:bbbbbbbbbbbbbbbb"])),
  ]);
  expect((await stored()).disabled).toEqual(["dev:bbbbbbbbbbbbbbbb"]);
});

it("removes its temporary file when the final rename fails", async () => {
  // A non-empty directory where the file should be makes rename fail on every platform.
  await mkdir(path.join(file(), "blocker"), { recursive: true });
  const store = filePluginStateStore(root);
  await expect(store.save(state(["dev:aaaaaaaaaaaaaaaa"]))).rejects.toThrow();
  expect(
    (await readdir(path.join(root, "plugins"))).filter((name) => name.endsWith(".tmp")),
  ).toEqual([]);
});
```

- [ ] **Step 2: 確認測試失敗**

Run: `pnpm --filter @kobrixa/plugin-runtime build && pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/state-store.test.ts`
Expected: FAIL（schemaVersion 1、load 回傳 Set 等）。

- [ ] **Step 3: 整檔替換 `state-store.ts`**

```ts
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PluginPersistedState, PluginStateStore } from "@kobrixa/plugin-runtime";

const LIMIT = 1000;
const keys = z.array(z.string().max(128)).max(LIMIT);
const v1Schema = z.strictObject({ schemaVersion: z.literal(1), disabled: keys });
const v2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  developerMode: z.boolean(),
  sources: z.array(z.strictObject({ directory: z.string().min(1).max(4096) })).max(LIMIT),
  disabled: keys,
  legacyDisabledIds: keys,
  python: z
    .strictObject({
      executable: z.string().min(1).max(4096),
      args: z.array(z.string().max(256)).max(8),
    })
    .optional(),
  safeModeLock: z
    .strictObject({
      since: z.iso.datetime(),
      reason: z.enum(["unclean-exit", "renderer-unresponsive"]),
    })
    .optional(),
});
export type PluginStateDocument = z.infer<typeof v2Schema>;

const empty = (): PluginStateDocument => ({
  schemaVersion: 2,
  developerMode: false,
  sources: [],
  disabled: [],
  legacyDisabledIds: [],
});
const persisted = (document: PluginStateDocument): PluginPersistedState => ({
  disabled: new Set(document.disabled),
  legacyDisabledIds: new Set(document.legacyDisabledIds),
});

/**
 * `<userData>/plugins/state.json`. Writes are serialized and atomic (temporary file + rename), so
 * the file always holds the latest save. A corrupt file is moved aside and reported, never
 * treated as "nothing disabled".
 */
export function filePluginStateStore(
  userData: string,
  options: { now?(): Date } = {},
): PluginStateStore {
  const file = path.join(userData, "plugins", "state.json");
  let document = empty();
  let writes: Promise<void> = Promise.resolve();
  const write = async (next: PluginStateDocument) => {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  };
  return {
    async load() {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        document = empty();
        return persisted(document);
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        value = undefined;
      }
      const current = v2Schema.safeParse(value);
      if (current.success) {
        document = current.data;
        return persisted(document);
      }
      const legacy = v1Schema.safeParse(value);
      if (legacy.success) {
        // v1 kept manifest ids; built-ins could not be disabled, so each id is a development one.
        document = { ...empty(), legacyDisabledIds: [...new Set(legacy.data.disabled)].sort() };
        return persisted(document);
      }
      const stamp = (options.now?.() ?? new Date()).toISOString().replaceAll(":", "-");
      const backup = `${file}.corrupt-${stamp}`;
      await rename(file, backup).catch(() => undefined);
      document = empty();
      return {
        ...persisted(document),
        problem: `The plugin settings file could not be read and was moved to ${backup}.`,
      };
    },
    save(state) {
      const run = writes.then(async () => {
        const next: PluginStateDocument = {
          ...document,
          disabled: [...state.disabled].sort(),
          legacyDisabledIds: [...state.legacyDisabledIds].sort(),
        };
        await write(next);
        document = next;
      });
      writes = run.catch(() => undefined);
      return run;
    },
  };
}
```

- [ ] **Step 4: 跑測試**

Run: `pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/state-store.test.ts`
Expected: PASS（7 個測試）。

- [ ] **Step 5: 格式檢查並提交**

```bash
pnpm exec prettier --write apps/desktop/src/main/plugins/state-store.ts apps/desktop/src/main/plugins/state-store.test.ts
git add apps/desktop/src/main/plugins/state-store.ts apps/desktop/src/main/plugins/state-store.test.ts
git commit -m "feat(desktop): store plugin state as schema v2 and fail closed on corruption"
```

---

### Task 7: IPC、preload 與面板改用 sourceKey 和 revision

**Files:**

- Modify: `apps/desktop/src/main/plugins/ipc.ts`
- Modify: `apps/desktop/src/main/plugins/ipc.test.ts`
- Modify: `apps/desktop/src/shared/plugins.ts`
- Modify: `apps/desktop/src/preload/index.ts:58`
- Modify: `apps/desktop/src/renderer/settings/plugin-copy.ts`
- Modify: `apps/desktop/src/renderer/settings/plugins-panel.tsx`
- Modify: `apps/desktop/src/renderer/settings/plugins-panel.test.ts`

**Interfaces:**

- Consumes: Task 1 的 `sourceKeySchema`；Task 3 的 `PluginsSnapshot.revision`／`stateProblem`、`PluginSummary.sourceKey`、`PluginActionResult.persisted`。
- Produces: `PluginsApi.setEnabled(sourceKey: string, enabled: boolean)`；IPC `plugins:set-enabled` 只接受符合 `sourceKeySchema` 的值。

- [ ] **Step 1: 改測試（先讓它失敗）**

1. `ipc.test.ts`：把兩個 `state: { safeMode: false, developmentMode: false, plugins: [] }` 改成 `{ revision: 0, safeMode: false, developmentMode: false, plugins: [] }`。把最後幾行的 set-enabled 斷言換成：

```ts
expect(() => handlers.get("plugins:set-enabled")!({}, "dev:0123456789abcdef", "yes")).toThrow();
expect(() => handlers.get("plugins:set-enabled")!({}, "acme.hello", false)).toThrow();
expect(() => handlers.get("plugins:set-enabled")!({}, "dev:../../etc", false)).toThrow();
await handlers.get("plugins:set-enabled")!({}, "dev:0123456789abcdef", false);
expect(manager.setEnabled).toHaveBeenCalledWith("dev:0123456789abcdef", false);
```

2. `plugins-panel.test.ts`：
   - `snapshot` 加上 `revision: 1,`（放在 `safeMode` 前）；第一個 plugin 加 `sourceKey: "builtin:kobrixa.basic-plus",`，第二個加 `sourceKey: "dev:0123456789abcdef",`。
   - 所有 `expect(api.setEnabled).toHaveBeenCalledWith("acme.hello", X)` 改成 `expect(api.setEnabled).toHaveBeenCalledWith("dev:0123456789abcdef", X)`（共四處）。
   - 檔尾加：

```ts
it("ignores an older snapshot that arrives after a newer state event", async () => {
  let finish!: (result: Awaited<ReturnType<PluginsApi["setEnabled"]>>) => void;
  api.setEnabled.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await act(async () => button("停用").click());
  act(() =>
    emit({
      type: "state",
      state: {
        ...snapshot,
        revision: 5,
        plugins: [snapshot.plugins[0]!, { ...snapshot.plugins[1]!, running: true }],
      },
    }),
  );
  await act(async () =>
    finish({
      ok: true,
      state: {
        ...snapshot,
        revision: 3,
        plugins: [snapshot.plugins[0]!, { ...snapshot.plugins[1]!, status: "invalid" }],
      },
    }),
  );
  expect(container.textContent).toContain("執行中");
  expect(container.textContent).not.toContain("無法載入");
});

it("shows a corrupt settings file and an unsaved disable", async () => {
  api.state.mockResolvedValueOnce({
    ...snapshot,
    stateProblem: { code: "PLUGIN_E_STATE_CORRUPT", message: "moved aside" },
  });
  api.setEnabled.mockResolvedValueOnce({
    ok: true,
    persisted: false,
    state: {
      ...snapshot,
      revision: 2,
      plugins: [
        snapshot.plugins[0]!,
        { ...snapshot.plugins[1]!, status: "disabled", disabledBy: "user", commands: [] },
      ],
    },
  });
  await render();
  expect(container.textContent).toContain("插件設定檔已損毀，已暫停開發插件：moved aside");
  await act(async () => button("停用").click());
  expect(container.querySelector("[role=alert]")?.textContent).toBe(
    pluginCopy["zh-TW"].notPersisted,
  );
});
```

- [ ] **Step 2: 確認測試失敗**

Run: `pnpm --filter @kobrixa/plugin-runtime build && pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/ipc.test.ts src/renderer/settings/plugins-panel.test.ts`
Expected: FAIL。

- [ ] **Step 3: 實作**

1. `ipc.ts`：import 改成 `import { sourceKeySchema, type PluginManager } from "@kobrixa/plugin-runtime";`（`namespacedIdSchema` 仍用於 `plugins:execute`）。set-enabled handler：

```ts
handle("plugins:set-enabled", (_event, sourceKey: unknown, enabled: unknown) =>
  plugins.setEnabled(sourceKeySchema.parse(sourceKey), z.boolean().parse(enabled)),
);
```

2. `shared/plugins.ts`：`setEnabled(sourceKey: string, enabled: boolean): Promise<PluginActionResult>;`

3. `preload/index.ts:58`：`setEnabled: (sourceKey, enabled) => ipcRenderer.invoke("plugins:set-enabled", sourceKey, enabled),`

4. `plugin-copy.ts`：
   - `en` 加 `notPersisted: "Disabled for this session, but the choice could not be saved. The plugin may be enabled again after a restart.",`
   - `zh-TW` 加 `notPersisted: "本次已停用，但設定未能保存，重新啟動後可能會恢復啟用。",`
   - `problems` 加：

```ts
  PLUGIN_E_STATE_CORRUPT: [
    "插件設定檔已損毀，已暫停開發插件",
    "The plugin settings file was damaged; development plugins are paused",
  ],
  PLUGIN_E_SHUTTING_DOWN: ["Kobrixa 正在關閉插件", "Kobrixa is shutting down plugins"],
  PLUGIN_E_SOURCE_TIMEOUT: ["讀取插件資料夾逾時", "Reading the plugin folder timed out"],
  PLUGIN_E_SOURCE_EXISTS: ["這個資料夾已經載入", "This folder is already loaded"],
```

5. `plugins-panel.tsx`：
   - `PanelError` 型別加上第三種：`| { kind: "notice"; message: string }`。
   - 緊接在 `const [error, setError] = useState<PanelError>();` 之後、`useEffect` 之前，加一個只接受較新快照的 setter。然後把所有 `setState(x)` 改成 `accept(x)`，包含 `state()` 首次載入的 `setState(value)`、`event.type === "state"` 的 `setState(event.state)`，以及 `perform` 裡的 `result.state`：

```tsx
// Action results can arrive after newer state events; keep the highest revision.
const accept = (next: PluginsSnapshot) =>
  setState((current) => (current && current.revision > next.revision ? current : next));
```

- `perform` 的 work 型別與成功分支改成：

```tsx
    work: () => Promise<
      | { ok: true; state?: PluginsSnapshot; persisted?: false }
      | { ok: false; code: string; message: string }
    >,
```

```tsx
if (!result.ok) setError({ kind: "problem", code: result.code, message: result.message });
else {
  if (result.state) accept(result.state);
  if (result.persisted === false) setError({ kind: "notice", message: t.notPersisted });
}
```

- `errorAlert` 改成：

```tsx
const errorAlert = error && (
  <p className="settings-hint" role="alert">
    {error.kind === "problem"
      ? problemText(error, locale)
      : error.kind === "notice"
        ? error.message
        : `${t.requestFailed}${locale === "zh-TW" ? "：" : ": "}${error.message}`}
  </p>
);
```

- toggle 的 `perform(plugin.id, () => window.kobrixa.plugins.setEnabled(plugin.id, enabling))` 改成 `perform(plugin.sourceKey, () => window.kobrixa.plugins.setEnabled(plugin.sourceKey, enabling))`。
- 列表的 key 改成 `<li key={plugin.sourceKey}>`。
- 在 `{state.safeMode && (…)}` 之後加：

```tsx
{
  state.stateProblem && (
    <p className="settings-hint" role="status">
      {problemText(state.stateProblem, locale)}
    </p>
  );
}
```

- [ ] **Step 4: 跑桌面端測試與型別檢查**

Run: `pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins src/renderer/settings && pnpm --filter @kobrixa/desktop check`
Expected: PASS。如果 `check` 回報 `tests/desktop/plugins-smoke-main.ts` 有錯，那支檔案不在 desktop 的 tsconfig 裡，這次不用改：它只用 `filePluginStateStore`、`PluginManager.create` 和 `executeCommand`，簽名都沒變。

- [ ] **Step 5: 格式檢查並提交**

```bash
pnpm exec prettier --write apps/desktop/src/main/plugins/ipc.ts apps/desktop/src/main/plugins/ipc.test.ts apps/desktop/src/shared/plugins.ts apps/desktop/src/preload/index.ts apps/desktop/src/renderer/settings/plugin-copy.ts apps/desktop/src/renderer/settings/plugins-panel.tsx apps/desktop/src/renderer/settings/plugins-panel.test.ts
git add apps/desktop/src/main/plugins/ipc.ts apps/desktop/src/main/plugins/ipc.test.ts apps/desktop/src/shared/plugins.ts apps/desktop/src/preload/index.ts apps/desktop/src/renderer/settings/plugin-copy.ts apps/desktop/src/renderer/settings/plugins-panel.tsx apps/desktop/src/renderer/settings/plugins-panel.test.ts
git commit -m "feat(desktop): address plugins by source key and keep the newest snapshot"
```

---

### Task 8: 文件同步與全面驗證

**Files:**

- Modify: `docs/superpowers/specs/2026-10-15-plugin-loading-ux-design.md`
- Modify: `docs/superpowers/plans/2026-10-15-plugin-system-phase-2-backlog.md`

- [ ] **Step 1: 修正 spec 與實作的兩處差異**

在 spec §3.3，把開發插件 `sourceKey` 的定義改成：

```markdown
- 開發插件：`dev:<path.resolve(directory) 的 SHA-256 前 16 個十六進位字元>`。計算時不碰檔案系統，安全模式和讀取卡住時也能得到同一個 key；以 `realpath` 去除別名的工作由 1b 在連結資料夾時完成，存進狀態檔的路徑本來就是 `realpath`。
```

在 spec §3.5 的 **v1 遷移** 項目，改成：

```markdown
- **v1 遷移：** v1 的 `disabled` 只有 manifest ID；當時內建插件不能停用，所以全部放進 `legacyDisabledIds`。之後任何開發來源載入時，如果 manifest ID 在 `legacyDisabledIds` 裡，就把該來源的 `sourceKey` 加入 `disabled`，並從 `legacyDisabledIds` 移除這個 ID。`developerMode` 預設為 `false`，`sources` 為空。
```

- [ ] **Step 2: 從待辦清單移除已處理的項目**

在 `docs/superpowers/plans/2026-10-15-plugin-system-phase-2-backlog.md` 刪除以下列（其他保留）：

- 高優先表格中 `supervisor.ts` 那一列（握手失敗後 `await exited` 沒有上限）。
- 高優先表格中 `launchers.ts` 那一列（`launchNode` 等 `spawn` 沒有上限）。
- 中優先「插件宿主」中的 `**stop() 在啟動中沒有上限**` 一項。
- 中優先「插件宿主」中的 `**無效的開發插件用資料夾名稱當 id**` 一項。
- 中優先「桌面端」中的 `**狀態檔寫入失敗時會留下 .tmp**…` 一項。
- 中優先「設定頁插件面板」中的 `**操作結果帶回的 state 可能蓋掉較新的 state 事件**` 一項。

然後在檔頭說明段落之後加一行：

```markdown
> 2026-10-15：插件載入 1a（[計畫](2026-10-15-plugin-loading-1a-runtime-hardening.md)）已處理部分項目，並從下表移除。
```

- [ ] **Step 3: 全面驗證**

依序執行，每一步都要成功：

```bash
pnpm -r build
pnpm check
pnpm test
pnpm format:check
pnpm test:plugins:smoke
```

Expected：全部成功。`pnpm test:plugins:smoke` 需要本機有 Python 3.10 以上並已安裝 SDK（`python3 -m pip install -e sdks/python`）；若本機沒有，記錄這一點並交給 CI 的 smoke job 驗證，不可宣稱已通過。

- [ ] **Step 4: 提交**

```bash
pnpm exec prettier --write docs/superpowers/specs/2026-10-15-plugin-loading-ux-design.md docs/superpowers/plans/2026-10-15-plugin-system-phase-2-backlog.md
git add docs/superpowers/specs/2026-10-15-plugin-loading-ux-design.md docs/superpowers/plans/2026-10-15-plugin-system-phase-2-backlog.md
git commit -m "docs: align plugin loading spec with 1a and trim the phase 2 backlog"
```
