# 插件載入 1b：圖形介面管理 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 開發者用一般方式開啟 Kobrixa，就能在「設定 → 插件」開啟開發者模式、連結資料夾、選 Python、重新載入、取消命令、查看日誌；上次沒有正常結束時，下次啟動自動暫停第三方插件，並能一鍵恢復。

**Architecture:** 主程序新增 `PluginController`（`apps/desktop/src/main/plugins/controller.ts`），包住 1a 的 `PluginManager`：它擁有開發者模式、原生對話框、Python 探測、日誌與通知緩衝、session marker，並在主程序檢查每個操作的授權（開發者模式、安全模式、是否正在關閉）。renderer 只送 `sourceKey` 或候選 ID。控制器把 manager 的 snapshot 加上自己的欄位，組成 `PluginsView` 送給面板；`revision` = manager revision + 控制器 revision，兩者都只增不減。runtime 只補三個小 API（命令取消訊號、`removeSource` 保留停用紀錄、`leaveSafeMode`）並修好 `resume()` 不 reconcile 的問題。

**Tech Stack:** TypeScript（strict、`exactOptionalPropertyTypes`）、Node.js 24、Electron 44（`dialog`、`utilityProcess`）、Zod 4、semver、Vitest（jsdom 用於面板）、React 19。

**Spec:** [`docs/superpowers/specs/2026-10-15-plugin-loading-ux-design.md`](../specs/2026-10-15-plugin-loading-ux-design.md) §2、§4、§5。1a 計畫：[`2026-10-15-plugin-loading-1a-runtime-hardening.md`](2026-10-15-plugin-loading-1a-runtime-hardening.md)。

## Global Constraints

- 定位不變：這是「可信任的本機插件」開發模式，不是沙箱。所有確認對話框與面板文字都要講清楚這一點。
- renderer 只傳 `sourceKey`（以 `sourceKeySchema` 驗證）、`commandId`（`namespacedIdSchema`）、布林值、Python 候選 ID（`python3`、`python`、`py`、`saved`、`other`）與日誌游標（非負整數）。**任何路徑或執行檔都不從 renderer 傳入**。
- 開發者模式、安全模式、是否正在關閉，一律在主程序 `PluginController` 檢查；renderer 的按鈕停用只是體驗，不是防線。
- 開發者模式預設關閉；開啟前必須經過主程序的原生確認對話框。`--plugin-dev-dir` 視為本次 session 已授權，不寫入設定，也不能繞過安全模式。
- 連結時以 `fs.promises.realpath` 取得實際路徑，存進 `state.json` 的 `sources`，`sourceKey` 由這個實際路徑計算；重複以 `sourceKey` 判斷（等於以 realpath 比對）。
- Python 探測：executable + args，不經 shell；限時 `PYTHON_PROBE_TIMEOUT_MS = 3_000`；stdout 上限 `PYTHON_PROBE_OUTPUT_BYTES = 4 * 1024`；可用門檻 Python ≥ 3.10、`import kobrixa` 成功、SDK `API_VERSION` 主版號等於 `PLUGIN_API_VERSION` 主版號。
- 日誌：每個來源 `LOG_SOURCE_LIMIT_BYTES = 256 * 1024`，全部合計 `LOG_TOTAL_LIMIT_BYTES = 4 * 1024 * 1024`，單次讀取 `LOG_READ_LIMIT_BYTES = 64 * 1024`；先丟最舊；只存在記憶體；解除連結時清除。通知每個來源最多 `NOTICE_SOURCE_LIMIT = 100` 則。
- session marker：`<userData>/plugins/session.json`，欄位 `startedAt`、`thirdPartyRunning`、`rendererUnresponsive`；**同步**寫入（temp + rename），避免非同步寫入在結束時把已刪除的 marker 又寫回來。
- 新錯誤碼（加在 runtime 的 `PLUGIN_ERROR_CODES`，面板才能翻譯）：`PLUGIN_E_DEVELOPER_MODE`、`PLUGIN_E_SESSION_SOURCE`、`PLUGIN_E_PYTHON_UNUSABLE`。
- 新 IPC channel 名稱照 spec §4.7：`plugins:setDeveloperMode`、`plugins:linkFolder`、`plugins:relinkFolder`、`plugins:unlink`、`plugins:reload`、`plugins:cancel`、`plugins:pythonCandidates`、`plugins:setPython`、`plugins:readLog`、`plugins:clearSafeModeLock`；另加唯讀的 `plugins:notices`（見 Task 8 的 ruling）。既有的 `plugins:state`、`plugins:execute`、`plugins:set-enabled`、`plugins:event` 保留原名。
- 任何情況都不重播命令；不刪除使用者的任何檔案。
- 介面與對話框文字一律提供 `en` 與 `zh-TW`。
- 桌面端從 `@kobrixa/plugin-runtime` 的 `dist/` 取用 runtime：改完 runtime 後、跑桌面端測試或型別檢查前，先執行 `pnpm --filter @kobrixa/plugin-runtime build`。
- 本機環境：pnpm 版本與專案釘選不同時，先 `export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false`。
- 每個 task 結束前對改到的檔案執行 `pnpm exec prettier --write`，再跑 `pnpm exec prettier --check` 與 `pnpm exec eslint`。計畫中的程式碼片段不保證已符合 Prettier 排版，以格式化後的結果為準。ESLint 有 `no-control-regex`，處理控制字元時用字元碼迴圈，不要寫進正規表達式；未使用的參數要以 `_` 開頭。

## Review Focus

1. **大小寫不同的同一個資料夾**（macOS／Windows 不分大小寫）：連結 `/Users/a/Hello` 後再選 `/users/a/hello`，應提示「已連結」並捲動到該列，不能出現兩列。→ Task 7 Step 1 的 `treats a differently-cased path that resolves to a linked folder as a duplicate` 測試（注入 realpath）。
2. **原生對話框開著時狀態改變**（使用者在確認視窗前停住，期間 app 開始關閉或進入其他狀態）：按下確認後必須重新檢查授權，不能在關閉途中寫入設定或加入來源。→ Task 7 Step 1 的 `re-checks permission after the confirmation dialog closes` 測試。
3. **選到會卡住或大量輸出的「Python」**：探測要在 3 秒內結束、輸出超過 4 KiB 就判定失敗，不能讓設定頁一直轉圈。→ Task 4 Step 1 的 `stops a probe that hangs or floods stdout` 測試。
4. **單一插件狂印日誌**：只能擠掉自己的舊內容；全域上限到了時擠掉的是「最舊的那一行」，而不是剛連結的插件；超長單行也不會讓緩衝區超量。→ Task 3 Step 1 的 `evicts the oldest line across sources at the global limit` 與 `drops a single line larger than the source limit` 測試。
5. **畫面卡住後使用者正常關閉**：下次啟動仍然要進入安全模式（sticky），但如果只是沒有第三方程序在跑時當機，不應該鎖住。→ Task 5 Step 1 的 `keeps the marker after a hang even when the session ends cleanly` 與 `ignores a crash while no third-party process ran` 測試。

## 檔案結構

| 檔案                                                                                                       | 責任                                                                                                       |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `packages/plugin-runtime/src/{errors,supervisor,manager}.ts`                                               | 新錯誤碼；`LaunchablePlugin.sourceKey`；取消訊號、`removeSource` 選項、`leaveSafeMode`、`resume` reconcile |
| `apps/desktop/src/main/plugins/state-store.ts`                                                             | `PluginSettingsStore`：`settings()`／`update()`                                                            |
| `apps/desktop/src/shared/plugins.ts`                                                                       | 面板與主程序共用的型別（`PluginsView`、Python、日誌、通知、`PluginsApi`）                                  |
| `apps/desktop/src/main/plugins/logs.ts`（新）                                                              | 日誌清理、`PluginLogs`、`PluginNotices`                                                                    |
| `apps/desktop/src/main/plugins/python.ts`（新）                                                            | 候選清單、探測、分類                                                                                       |
| `apps/desktop/src/main/plugins/launchers.ts`                                                               | Python 改用 getter；輸出 hook                                                                              |
| `apps/desktop/src/main/plugins/session.ts`（新）                                                           | session marker、SIGINT／SIGTERM、畫面健康監看                                                              |
| `apps/desktop/src/main/plugins/dialogs.ts`（新）                                                           | Electron 原生對話框（可注入假實作）                                                                        |
| `apps/desktop/src/main/plugins/controller.ts`（新）                                                        | `PluginController` 與 `startPlugins()`                                                                     |
| `apps/desktop/src/main/plugins/ipc.ts`、`apps/desktop/src/preload/index.ts`                                | 新 channel                                                                                                 |
| `apps/desktop/src/main/index.ts`                                                                           | 接線                                                                                                       |
| `apps/desktop/src/renderer/settings/{plugins-panel.tsx,plugin-log.tsx,plugin-recovery.tsx,plugin-copy.ts}` | 面板、日誌檢視、復原橫幅、文字                                                                             |
| `apps/desktop/src/renderer/{app.tsx,settings/settings-panel.tsx,styles/workbench.css}`                     | 橫幅位置、設定分類、樣式                                                                                   |
| `tests/desktop/{plugins-gui-smoke-main.ts,run-plugins-smoke.mjs}`                                          | 以假對話框跑的 Electron smoke                                                                              |
| `plugins/samples/README.md`、`docs/{en,zh-TW}/architecture.md`、`README.md`、第二階段待辦                  | 文件改以圖形介面為主                                                                                       |

---

### Task 1: runtime 補上取消訊號、保留式移除、離開安全模式，並讓 resume 重新 reconcile

**Files:**

- Modify: `packages/plugin-runtime/src/errors.ts`
- Modify: `packages/plugin-runtime/src/supervisor.ts`（`LaunchablePlugin`）
- Modify: `packages/plugin-runtime/src/manager.ts`
- Test: `packages/plugin-runtime/src/manager.test.ts`

**Interfaces:**

- Consumes（1a）：`PluginManager`、`readSource`、`#enqueue`、`#apply`、`#closed`、`convertLegacy`、`readOptions`。
- Produces:
  - 錯誤碼 `PLUGIN_E_DEVELOPER_MODE`、`PLUGIN_E_SESSION_SOURCE`、`PLUGIN_E_PYTHON_UNUSABLE`
  - `LaunchablePlugin.sourceKey?: string`（manager 一律填入）
  - `PluginManager.executeCommand(commandId: string, signal?: AbortSignal): Promise<PluginCommandResult>`
  - `PluginManager.removeSource(sourceKey: string, options?: { forget?: boolean }): Promise<PluginActionResult>`；`forget: false` 時保留停用紀錄（關閉開發者模式用），預設 `true`（解除連結用）
  - `PluginManager.leaveSafeMode(): Promise<PluginActionResult>`：讀取所有開發來源、離開安全模式、reconcile；已不在安全模式時直接回傳目前狀態
  - `PluginManager.resume()` 完成後會 reconcile，被關閉打斷的 reload 不會留下「已啟用但沒有 supervisor」的列

- [ ] **Step 1: 寫失敗的測試**

在 `packages/plugin-runtime/src/manager.test.ts` 的 `describe("dynamic sources", …)` 區塊內、`hangingLauncher` 宣告之後，加一個會回應取消的 launcher：

```ts
const cancellableLauncher = vi.fn(
  async () =>
    memoryPlugin((peer, { exit }) => {
      peer.handle("initialize", () => ({
        apiVersion: "1.0.0",
        sdk: { name: "t", version: "1" },
      }));
      peer.handle(
        "command/execute",
        (_params, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("stopped")), {
              once: true,
            });
          }),
      );
      peer.handle("shutdown", () => null);
      peer.onNotification("exit", () => exit(0));
    }).process,
);
afterEach(() => cancellableLauncher.mockClear());
```

在同一個區塊最後（`converts a schema v1 disable when its folder is added later` 之後）加：

```ts
it("cancels one command through its signal and keeps the plugin running", async () => {
  const hello = await devPlugin("hello");
  const manager = await createWith([hello], cancellableLauncher);
  const abort = new AbortController();
  const running = manager.executeCommand("acme.hello.greet", abort.signal);
  await vi.waitFor(() => expect(manager.state().plugins[0]!.running).toBe(true));
  abort.abort();
  expect(await running).toMatchObject({ ok: false, code: "PLUGIN_E_CANCELLED" });
  expect(manager.state().plugins[0]).toMatchObject({ status: "enabled", running: true });
  expect(cancellableLauncher).toHaveBeenCalledWith(
    expect.objectContaining({ sourceKey: keyOf(hello) }),
  );
  await manager.shutdown();
});
it("keeps the disabled choice when a source is removed without forgetting it", async () => {
  const hello = await devPlugin("hello");
  const store = memoryStore([keyOf(hello)]);
  const manager = await create([hello], store);
  expect(await manager.removeSource(keyOf(hello), { forget: false })).toMatchObject({
    ok: true,
  });
  expect(store.saved).toEqual([]);
  await manager.addSource(hello);
  expect(manager.state().plugins[0]).toMatchObject({ status: "disabled", disabledBy: "user" });
  await manager.removeSource(keyOf(hello));
  expect(savedDisabled(store)).toEqual([[]]);
});
it("leaves safe mode by reading development folders; plugins still start lazily", async () => {
  const hello = await devPlugin("hello");
  const off = await devPlugin("off");
  const manager = await create([builtin, hello, off], memoryStore([keyOf(off)]), true);
  expect(manager.state().plugins[1]).toMatchObject({ id: "hello", disabledBy: "safe-mode" });
  expect(await manager.leaveSafeMode()).toMatchObject({ ok: true, state: { safeMode: false } });
  expect(manager.state().plugins.map((plugin) => [plugin.id, plugin.status])).toEqual([
    ["kobrixa.basic-plus", "enabled"],
    ["acme.hello", "enabled"],
    ["acme.off", "disabled"],
  ]);
  expect(launcher).not.toHaveBeenCalled();
  expect(await manager.executeCommand("acme.hello.greet")).toEqual({ ok: true });
  expect(await manager.leaveSafeMode()).toMatchObject({ ok: true });
  expect(await manager.reloadSource(keyOf(hello))).toMatchObject({ ok: true });
  await manager.shutdown();
});
it("refuses to leave safe mode while shutting down", async () => {
  const manager = await create([await devPlugin("hello")], memoryStore(), true);
  void manager.shutdown();
  expect(await manager.leaveSafeMode()).toMatchObject({
    ok: false,
    code: "PLUGIN_E_SHUTTING_DOWN",
  });
  expect(manager.state().safeMode).toBe(true);
});
it("re-registers a plugin whose reload was interrupted by shutdown once resumed", async () => {
  const hello = await devPlugin("hello");
  const manager = await createWith([hello]);
  expect(await manager.executeCommand("acme.hello.greet")).toEqual({ ok: true });
  const reloading = manager.reloadSource(keyOf(hello));
  // The reload has retired the old supervisor and is waiting for it to stop.
  await vi.waitFor(() => expect(manager.state().plugins[0]!.running).toBe(false));
  const shutdown = manager.shutdown();
  expect(await reloading).toMatchObject({ ok: false, code: "PLUGIN_E_SHUTTING_DOWN" });
  await shutdown;
  await manager.resume();
  expect(await manager.executeCommand("acme.hello.greet")).toEqual({ ok: true });
  await manager.shutdown();
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter @kobrixa/plugin-runtime exec vitest run src/manager.test.ts`
Expected: FAIL——`leaveSafeMode is not a function`；取消測試回傳 `ok: true` 以外的逾時或卡住；`removeSource` 的 `forget: false` 仍然存了一次；resume 後回傳 `PLUGIN_E_UNKNOWN_COMMAND`。

- [ ] **Step 3: 實作**

`packages/plugin-runtime/src/errors.ts`：在 `"PLUGIN_E_SOURCE_EXISTS",` 之後加：

```ts
  "PLUGIN_E_DEVELOPER_MODE",
  "PLUGIN_E_SESSION_SOURCE",
  "PLUGIN_E_PYTHON_UNUSABLE",
```

`packages/plugin-runtime/src/supervisor.ts`：在 `LaunchablePlugin` 的 `readonly id: string;` 之後加：

```ts
  /** The manager's source key, so launchers can file output under the right source. */
  readonly sourceKey?: string;
```

`packages/plugin-runtime/src/manager.ts`：

1. `readOptions` 改成接收安全模式：

```ts
const readOptions = (options: PluginManagerOptions, safeMode: boolean) => ({
  safeMode,
  ...(options.sourceReadTimeoutMs === undefined ? {} : { timeoutMs: options.sourceReadTimeoutMs }),
});
```

`create()` 內改成 `readSource(source, readOptions(options, options.safeMode))`；`#addSource` 與 `#reloadSource` 內改成 `readOptions(this.options, this.#safeMode)`。

2. 在 `#stateProblem` 欄位之後加 `#safeMode: boolean;`，constructor 第一行加 `this.#safeMode = options.safeMode;`。把其餘四處 `this.options.safeMode`（`state()`、`#setEnabled`、`#reloadSource`、`#reconcile`）全部換成 `this.#safeMode`。

3. `executeCommand` 改成：

```ts
  async executeCommand(commandId: string, signal?: AbortSignal): Promise<PluginCommandResult> {
    if (this.#shutdown) return failure("PLUGIN_E_DISABLED", "Kobrixa is shutting down plugins.");
    const owner = this.#commands.get(commandId);
    const supervisor = owner ? this.#supervisors.get(owner) : undefined;
    if (!supervisor)
      return failure("PLUGIN_E_UNKNOWN_COMMAND", `No enabled plugin contributes ${commandId}.`);
    try {
      await supervisor.executeCommand(commandId, signal);
      return { ok: true };
    } catch (error) {
      return error instanceof PluginError
        ? failure(error.code, error.message)
        : failure("PLUGIN_E_COMMAND_FAILED", messageOf(error));
    }
  }
```

4. `removeSource` 與 `#removeSource`：

```ts
  /**
   * Stops and unregisters a development source. Its files are never touched. `forget: false`
   * keeps its disabled choice for when the same folder is added again.
   */
  removeSource(sourceKey: string, options: { forget?: boolean } = {}): Promise<PluginActionResult> {
    return this.#enqueue(() => this.#removeSource(sourceKey, options.forget !== false));
  }
```

```ts
  async #removeSource(sourceKey: string, forget: boolean): Promise<PluginActionResult> {
    const refused = this.#refuseChange(sourceKey, "removed");
    if (refused) return refused;
    this.#entries = this.#entries.filter((entry) => entry.read.sourceKey !== sourceKey);
    if (forget && this.#disabled.delete(sourceKey)) await this.#saveBestEffort();
    await this.#apply("cancelled");
    return { ok: true, state: this.state() };
  }
```

5. 在 `reloadSource` 之後加公開方法，並在 `#reloadSource` 之後加私有實作：

```ts
  /**
   * Leaves safe mode for the rest of the session: every development folder is read now and
   * enabled plugins start lazily on their next command.
   */
  leaveSafeMode(): Promise<PluginActionResult> {
    return this.#enqueue(() => this.#leaveSafeMode());
  }
```

```ts
  async #leaveSafeMode(): Promise<PluginActionResult> {
    const closed = this.#closed();
    if (closed) return closed;
    if (!this.#safeMode) return { ok: true, state: this.state() };
    const development = this.#entries.filter((entry) => entry.read.source === "development");
    const reads = await Promise.all(
      development.map((entry) => readSource(entry.source, readOptions(this.options, false))),
    );
    const closedAfterRead = this.#closed();
    if (closedAfterRead) return closedAfterRead;
    development.forEach((entry, index) => {
      entry.read = reads[index]!;
    });
    this.#safeMode = false;
    if (convertLegacy(reads, this.#disabled, this.#legacy)) await this.#saveBestEffort();
    await this.#apply("disabled");
    return { ok: true, state: this.state() };
  }
```

6. `resume()` 改成：

```ts
  async resume(): Promise<void> {
    if (!this.#shutdown) return;
    await this.#shutdown.catch(() => undefined);
    this.#shutdown = undefined;
    // A change interrupted by the shutdown may have left an enabled plugin without a supervisor.
    await this.#enqueue(() => this.#apply("cancelled"));
  }
```

7. `#register` 建立 `PluginSupervisor` 時，第一個參數物件在 `id: plugin.id,` 之後加 `sourceKey,`。

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm --filter @kobrixa/plugin-runtime exec vitest run`
Expected: PASS（全部 runtime 測試，包含 1a 的既有測試）。

Run: `pnpm --filter @kobrixa/plugin-runtime check && pnpm --filter @kobrixa/plugin-runtime build`
Expected: 無錯誤。

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-runtime/src/errors.ts packages/plugin-runtime/src/supervisor.ts packages/plugin-runtime/src/manager.ts packages/plugin-runtime/src/manager.test.ts
git commit -m "feat(plugin-runtime): cancel commands, keep disables on removal and leave safe mode"
```

---

### Task 2: 狀態檔提供設定讀寫（開發者模式、來源、Python、安全模式鎖）

**Files:**

- Modify: `apps/desktop/src/main/plugins/state-store.ts`
- Test: `apps/desktop/src/main/plugins/state-store.test.ts`

**Interfaces:**

- Consumes（1a）：`PluginStateDocument`、`v2Schema`、`filePluginStateStore(userData, { now? })`。
- Produces:
  - `interface PluginSettingsStore extends PluginStateStore { settings(): PluginStateDocument; update(change: (current: PluginStateDocument) => PluginStateDocument): Promise<void> }`
  - `filePluginStateStore(...)` 回傳型別改成 `PluginSettingsStore`
  - `type SafeModeLock = NonNullable<PluginStateDocument["safeModeLock"]>`、`type StoredPython = NonNullable<PluginStateDocument["python"]>`

- [ ] **Step 1: 寫失敗的測試**

在 `apps/desktop/src/main/plugins/state-store.test.ts` 最後加：

```ts
const lockedSettings = {
  schemaVersion: 2,
  developerMode: true,
  sources: [{ directory: "/plugins/hello" }],
  disabled: ["dev:aaaaaaaaaaaaaaaa"],
  legacyDisabledIds: [],
  python: { executable: "py", args: ["-3"] },
  safeModeLock: { since: "2026-10-15T00:00:00.000Z", reason: "unclean-exit" },
};

it("updates the settings the manager does not own and keeps them across saves", async () => {
  const store = filePluginStateStore(root);
  await store.load();
  await store.update((current) => ({
    ...current,
    developerMode: true,
    sources: [{ directory: "/plugins/hello" }],
    python: { executable: "py", args: ["-3"] },
    safeModeLock: { since: "2026-10-15T00:00:00.000Z", reason: "unclean-exit" },
  }));
  await store.save(state(["dev:aaaaaaaaaaaaaaaa"]));
  expect(await stored()).toEqual(lockedSettings);
  expect(store.settings()).toEqual(lockedSettings);
  const reloaded = filePluginStateStore(root);
  await reloaded.load();
  expect(reloaded.settings()).toEqual(lockedSettings);
});

it("rejects an invalid update or a failed write without changing the settings", async () => {
  const store = filePluginStateStore(root);
  await store.load();
  await expect(
    store.update((current) => ({ ...current, sources: [{ directory: "" }] })),
  ).rejects.toThrow();
  expect(store.settings().sources).toEqual([]);
  // A file where the plugins folder should be makes the write fail.
  await writeFile(path.join(root, "plugins"), "");
  await expect(store.update((current) => ({ ...current, developerMode: true }))).rejects.toThrow();
  expect(store.settings().developerMode).toBe(false);
  await rm(path.join(root, "plugins"));
  await store.update((current) => ({ ...current, developerMode: true }));
  expect((await stored()).developerMode).toBe(true);
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/state-store.test.ts`
Expected: FAIL，`store.update is not a function`。

- [ ] **Step 3: 實作**

在 `state-store.ts` 的 `export type PluginStateDocument = …` 之後加：

```ts
export type SafeModeLock = NonNullable<PluginStateDocument["safeModeLock"]>;
export type StoredPython = NonNullable<PluginStateDocument["python"]>;
export interface PluginSettingsStore extends PluginStateStore {
  /** The latest loaded or saved document. Treat it as read-only. */
  settings(): PluginStateDocument;
  /**
   * Applies `change` to the latest document and writes it, serialized with save(). The result
   * is validated first; a rejected change or a failed write leaves settings() unchanged.
   */
  update(change: (current: PluginStateDocument) => PluginStateDocument): Promise<void>;
}
```

`filePluginStateStore` 的回傳型別改成 `PluginSettingsStore`。在 `write` 宣告之後加：

```ts
const commit = (change: (current: PluginStateDocument) => PluginStateDocument) => {
  const run = writes.then(async () => {
    const next = v2Schema.parse(change(document));
    await write(next);
    document = next;
  });
  writes = run.catch(() => undefined);
  return run;
};
```

回傳物件的 `save(state) { … }` 整段換成下面三個成員（`load` 不變）：

```ts
    save: (state) =>
      commit((current) => ({
        ...current,
        disabled: [...state.disabled].sort(),
        legacyDisabledIds: [...state.legacyDisabledIds].sort(),
      })),
    settings: () => document,
    update: commit,
```

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/state-store.test.ts`
Expected: PASS（含 1a 的既有測試）。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/plugins/state-store.ts apps/desktop/src/main/plugins/state-store.test.ts
git commit -m "feat(desktop): read and update plugin settings beyond disabled sources"
```

---

### Task 3: 共用型別，以及主程序的日誌與通知緩衝

**Files:**

- Modify: `apps/desktop/src/shared/plugins.ts`
- Create: `apps/desktop/src/main/plugins/logs.ts`
- Test: `apps/desktop/src/main/plugins/logs.test.ts`

**Interfaces:**

- Produces（`shared/plugins.ts`，本 task 只新增，不改既有的 `PluginEvent`／`PluginsApi`，那兩個在 Task 8 才換）：
  - `PythonStatus`、`PythonProblem`、`PythonProbe`、`PythonChoiceId`、`PythonChoice`、`PythonView`
  - `PluginOrigin = "builtin" | "linked" | "session"`、`SafeModeLockView`
  - `PluginsView extends PluginsSnapshot { developer; safeModeLock?; origins; python; inflight }`
  - `StoredNotice extends PluginNotice { id: number }`、`LogLine`、`LogRead`、`PluginsResult`
- Produces（`logs.ts`）：
  - 常數 `LOG_SOURCE_LIMIT_BYTES`、`LOG_TOTAL_LIMIT_BYTES`、`LOG_READ_LIMIT_BYTES`、`NOTICE_SOURCE_LIMIT`
  - `cleanLogLine(text: string): string[]`
  - `class PluginLogs { constructor(limits?: { source: number; total: number; read: number }); append(sourceKey: string, text: string): void; read(sourceKey: string, after: number): LogRead; clear(sourceKey: string): void }`
  - `class PluginNotices { add(notice: PluginNotice): StoredNotice; list(): StoredNotice[]; clear(sourceKey: string): void }`

- [ ] **Step 1: 寫失敗的測試**

建立 `apps/desktop/src/main/plugins/logs.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { cleanLogLine, NOTICE_SOURCE_LIMIT, PluginLogs, PluginNotices } from "./logs.js";

const texts = (read: { lines: { text: string }[] }) => read.lines.map((line) => line.text);

describe("cleanLogLine", () => {
  it("strips ANSI sequences and control characters but keeps tabs and text", () => {
    expect(cleanLogLine("\u001b[31mred\u001b[0m\tok\u0007\u0000")).toEqual(["red\tok"]);
    expect(cleanLogLine("\u001b]0;title\u0007after")).toEqual(["after"]);
    expect(cleanLogLine("\u009b1mbold")).toEqual(["bold"]);
    expect(cleanLogLine("世界 \u007f")).toEqual(["世界 "]);
  });
  it("turns an inline carriage return into a new line but ignores a CRLF ending", () => {
    expect(cleanLogLine("10%\r20%")).toEqual(["10%", "20%"]);
    expect(cleanLogLine("done\r")).toEqual(["done"]);
  });
});

describe("PluginLogs", () => {
  it("reads lines after a cursor", () => {
    const logs = new PluginLogs();
    logs.append("dev:a", "one");
    logs.append("dev:a", "two\rthree");
    const first = logs.read("dev:a", 0);
    expect(texts(first)).toEqual(["one", "two", "three"]);
    expect(first.truncated).toBe(false);
    logs.append("dev:a", "four");
    const second = logs.read("dev:a", first.next);
    expect(texts(second)).toEqual(["four"]);
    expect(logs.read("dev:a", second.next)).toEqual({
      lines: [],
      next: second.next,
      truncated: false,
    });
    expect(logs.read("dev:missing", 0)).toEqual({ lines: [], next: 0, truncated: false });
  });
  it("drops the oldest lines of one source, reports the gap and reads in batches", () => {
    // Each "line-N" costs 7 bytes: 6 characters and a newline.
    const logs = new PluginLogs({ source: 40, total: 1000, read: 20 });
    for (let index = 0; index < 10; index++) logs.append("dev:a", `line-${index}`);
    const first = logs.read("dev:a", 0);
    expect(first.truncated).toBe(true);
    expect(texts(first)).toEqual(["line-5", "line-6"]);
    const second = logs.read("dev:a", first.next);
    expect(second.truncated).toBe(false);
    expect(texts(second)).toEqual(["line-7", "line-8"]);
  });
  it("evicts the oldest line across sources at the global limit", () => {
    // Each "x-lineN" costs 8 bytes.
    const logs = new PluginLogs({ source: 40, total: 60, read: 1000 });
    for (let index = 0; index < 5; index++) logs.append("dev:a", `a-line${index}`);
    for (let index = 0; index < 3; index++) logs.append("dev:b", `b-line${index}`);
    expect(logs.read("dev:a", 0).truncated).toBe(true);
    expect(texts(logs.read("dev:a", 0))).toEqual(["a-line1", "a-line2", "a-line3", "a-line4"]);
    expect(logs.read("dev:b", 0)).toMatchObject({ truncated: false });
    expect(texts(logs.read("dev:b", 0))).toEqual(["b-line0", "b-line1", "b-line2"]);
  });
  it("drops a single line larger than the source limit", () => {
    const logs = new PluginLogs({ source: 40, total: 60, read: 1000 });
    logs.append("dev:a", "x".repeat(100));
    expect(logs.read("dev:a", 0)).toEqual({ lines: [], next: 1, truncated: true });
    logs.append("dev:a", "ok");
    expect(texts(logs.read("dev:a", 0))).toEqual(["ok"]);
  });
  it("frees a cleared source's share of the global limit", () => {
    const logs = new PluginLogs({ source: 40, total: 60, read: 1000 });
    for (let index = 0; index < 5; index++) logs.append("dev:a", `a-line${index}`);
    logs.clear("dev:a");
    expect(logs.read("dev:a", 0)).toEqual({ lines: [], next: 0, truncated: false });
    for (let index = 0; index < 5; index++) logs.append("dev:b", `b-line${index}`);
    expect(logs.read("dev:b", 0).truncated).toBe(false);
  });
});

describe("PluginNotices", () => {
  const notice = (sourceKey: string, message: string) => ({
    pluginId: "acme.a",
    sourceKey,
    severity: "info" as const,
    message,
    at: 0,
  });
  it("assigns increasing ids, keeps 100 per source and lists newest first", () => {
    const notices = new PluginNotices();
    for (let index = 0; index <= NOTICE_SOURCE_LIMIT; index++)
      notices.add(notice("dev:a", `a${index}`));
    const b = notices.add(notice("dev:b", "b"));
    expect(b).toEqual({ ...notice("dev:b", "b"), id: NOTICE_SOURCE_LIMIT + 2 });
    const listed = notices.list();
    expect(listed).toHaveLength(NOTICE_SOURCE_LIMIT + 1);
    expect(listed[0]).toEqual(b);
    expect(listed.at(-1)!.message).toBe("a1");
    notices.clear("dev:a");
    expect(notices.list().map((item) => item.message)).toEqual(["b"]);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/logs.test.ts`
Expected: FAIL，找不到 `./logs.js`。

- [ ] **Step 3: 實作**

`apps/desktop/src/shared/plugins.ts`：第一個 import 改成也匯入 `PluginErrorCode`：

```ts
import type {
  PluginActionResult,
  PluginCommandResult,
  PluginErrorCode,
  PluginManagerEvent,
  PluginNotice,
  PluginsSnapshot,
  PluginSummary,
} from "@kobrixa/plugin-runtime";
```

並在 `export type PluginEvent = PluginManagerEvent;` 之前加：

```ts
export type PythonStatus = "ok" | "warning" | "error";
export type PythonProblem = "sdk-missing" | "sdk-incompatible" | "too-old" | "failed";
export interface PythonProbe {
  status: PythonStatus;
  problem?: PythonProblem;
  /** Reported by the interpreter itself, never guessed from the command. */
  version?: string;
  path?: string;
  sdkApiVersion?: string;
  detail?: string;
}
/** The only interpreter identifiers the renderer may send; "other" opens a file picker. */
export type PythonChoiceId = "python3" | "python" | "py" | "saved" | "other";
export interface PythonChoice {
  id: Exclude<PythonChoiceId, "other">;
  label: string;
  selected: boolean;
  probe: PythonProbe;
}
export interface PythonView {
  current?: { label: string; origin: "settings" | "command-line" };
  /** Running Python plugins that keep their old interpreter until reloaded. */
  pendingReload: string[];
}
export type PluginOrigin = "builtin" | "linked" | "session";
export interface SafeModeLockView {
  since: string;
  reason: "unclean-exit" | "renderer-unresponsive";
}
export interface PluginsView extends PluginsSnapshot {
  developer: {
    enabled: boolean;
    /** Authorized by --plugin-dev-dir for this session only. */
    commandLine: boolean;
    linkedCount: number;
  };
  safeModeLock?: SafeModeLockView;
  /** Keyed by source key. */
  origins: Record<string, PluginOrigin>;
  python: PythonView;
  /** Source keys with a command in flight. */
  inflight: string[];
}
export interface StoredNotice extends PluginNotice {
  id: number;
}
export interface LogLine {
  seq: number;
  text: string;
}
export interface LogRead {
  lines: LogLine[];
  /** Pass back as `after` to read only newer lines. */
  next: number;
  /** Lines after the cursor were dropped by the size limits. */
  truncated: boolean;
}
export type PluginsResult =
  | {
      ok: true;
      state: PluginsView;
      persisted?: false;
      outcome?: "cancelled" | "duplicate";
      sourceKey?: string;
    }
  | { ok: false; code: PluginErrorCode; message: string };
```

建立 `apps/desktop/src/main/plugins/logs.ts`：

```ts
import type { PluginNotice } from "@kobrixa/plugin-runtime";
import type { LogLine, LogRead, StoredNotice } from "../../shared/plugins.js";

export const LOG_SOURCE_LIMIT_BYTES = 256 * 1024;
export const LOG_TOTAL_LIMIT_BYTES = 4 * 1024 * 1024;
export const LOG_READ_LIMIT_BYTES = 64 * 1024;
export const NOTICE_SOURCE_LIMIT = 100;

const ESC = 0x1b;
const CSI = 0x9b;

/** Returns the index of the escape sequence's last character. */
function skipEscape(text: string, start: number): number {
  const c1 = text.charCodeAt(start) === CSI;
  const kind = c1 ? 0x5b : text.charCodeAt(start + 1);
  let index = c1 ? start : start + 1;
  if (kind === 0x5b) {
    // CSI: parameter and intermediate bytes, then one final byte.
    while (++index < text.length) {
      const code = text.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return index;
    }
    return text.length - 1;
  }
  if (kind === 0x5d) {
    // OSC: ends with BEL or ESC \.
    while (++index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 0x07) return index;
      if (code === ESC && text.charCodeAt(index + 1) === 0x5c) return index + 1;
    }
    return text.length - 1;
  }
  return Math.min(start + 1, text.length - 1);
}

/**
 * Removes ANSI escape sequences and control characters (tabs stay). A carriage return inside
 * the line starts a new line, so progress output stays readable.
 */
export function cleanLogLine(text: string): string[] {
  const lines: string[] = [];
  let line = "";
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === ESC || code === CSI) {
      index = skipEscape(text, index);
      continue;
    }
    if (code === 0x0d) {
      lines.push(line);
      line = "";
      continue;
    }
    if (code === 0x09 || (code >= 0x20 && code !== 0x7f && (code < 0x80 || code > 0x9f)))
      line += text[index];
  }
  lines.push(line);
  // A CRLF line ending is not an inline carriage return.
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

interface SourceLog {
  lines: LogLine[];
  bytes: number;
  /** Sequence number of the newest dropped line. */
  droppedThrough: number;
}
const sizeOf = (text: string) => Buffer.byteLength(text, "utf8") + 1;

/** In-memory plugin output, kept across plugin restarts and never written to disk. */
export class PluginLogs {
  readonly #sources = new Map<string, SourceLog>();
  #total = 0;
  #seq = 0;

  constructor(
    private readonly limits = {
      source: LOG_SOURCE_LIMIT_BYTES,
      total: LOG_TOTAL_LIMIT_BYTES,
      read: LOG_READ_LIMIT_BYTES,
    },
  ) {}

  append(sourceKey: string, text: string): void {
    let log = this.#sources.get(sourceKey);
    if (!log) {
      log = { lines: [], bytes: 0, droppedThrough: 0 };
      this.#sources.set(sourceKey, log);
    }
    for (const clean of cleanLogLine(text)) {
      log.lines.push({ seq: ++this.#seq, text: clean });
      const size = sizeOf(clean);
      log.bytes += size;
      this.#total += size;
    }
    while (log.bytes > this.limits.source) this.#dropOldest(log);
    while (this.#total > this.limits.total) this.#dropOldest(this.#oldest()!);
  }

  read(sourceKey: string, after: number): LogRead {
    const log = this.#sources.get(sourceKey);
    if (!log) return { lines: [], next: after, truncated: false };
    const lines: LogLine[] = [];
    let bytes = 0;
    for (const line of log.lines) {
      if (line.seq <= after) continue;
      bytes += sizeOf(line.text);
      if (lines.length > 0 && bytes > this.limits.read) break;
      lines.push(line);
    }
    return {
      lines,
      next: lines.at(-1)?.seq ?? Math.max(after, log.droppedThrough),
      truncated: log.droppedThrough > after,
    };
  }

  clear(sourceKey: string): void {
    const log = this.#sources.get(sourceKey);
    if (!log) return;
    this.#total -= log.bytes;
    this.#sources.delete(sourceKey);
  }

  #dropOldest(log: SourceLog): void {
    const line = log.lines.shift()!;
    const size = sizeOf(line.text);
    log.bytes -= size;
    this.#total -= size;
    log.droppedThrough = line.seq;
  }

  #oldest(): SourceLog | undefined {
    let oldest: SourceLog | undefined;
    for (const log of this.#sources.values())
      if (log.lines.length && (!oldest || log.lines[0]!.seq < oldest.lines[0]!.seq)) oldest = log;
    return oldest;
  }
}

/** Plugin notices collected in main, so the panel can show them after it was closed. */
export class PluginNotices {
  readonly #sources = new Map<string, StoredNotice[]>();
  #id = 0;

  add(notice: PluginNotice): StoredNotice {
    const stored = { ...notice, id: ++this.#id };
    const list = this.#sources.get(notice.sourceKey) ?? [];
    list.push(stored);
    if (list.length > NOTICE_SOURCE_LIMIT) list.shift();
    this.#sources.set(notice.sourceKey, list);
    return stored;
  }

  /** Newest first. */
  list(): StoredNotice[] {
    return [...this.#sources.values()].flat().sort((a, b) => b.id - a.id);
  }

  clear(sourceKey: string): void {
    this.#sources.delete(sourceKey);
  }
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/logs.test.ts && pnpm --filter @kobrixa/desktop check`
Expected: PASS，型別檢查無錯誤。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/plugins.ts apps/desktop/src/main/plugins/logs.ts apps/desktop/src/main/plugins/logs.test.ts
git commit -m "feat(desktop): keep bounded plugin logs and notices in main"
```

---

### Task 4: Python 候選與探測，launcher 每次啟動時讀最新設定

**Files:**

- Create: `apps/desktop/src/main/plugins/python.ts`
- Test: `apps/desktop/src/main/plugins/python.test.ts`
- Modify: `apps/desktop/src/main/plugins/launchers.ts`
- Modify: `apps/desktop/src/main/plugins/launchers.test.ts`
- Modify: `apps/desktop/src/main/index.ts`（暫時改用 getter，Task 9 會整段替換）
- Modify: `tests/desktop/plugins-smoke-main.ts`（同上）

**Interfaces:**

- Consumes：Task 3 的 `PythonProbe`、`PythonChoiceId`；Task 1 的 `LaunchablePlugin.sourceKey`。
- Produces:
  - `PYTHON_PROBE_TIMEOUT_MS`、`PYTHON_PROBE_OUTPUT_BYTES`、`PYTHON_MINIMUM_VERSION`、`PYTHON_PROBE_SCRIPT`
  - `interface PythonCommand { executable: string; args: string[] }`
  - `interface PythonCandidateCommand { id: Exclude<PythonChoiceId, "other">; command: PythonCommand }`
  - `pythonCommands(platform: NodeJS.Platform, saved?: PythonCommand): PythonCandidateCommand[]`
  - `sameCommand(a: PythonCommand, b: PythonCommand): boolean`、`commandLabel(command: PythonCommand): string`
  - `classifyProbe(output: string): PythonProbe`
  - `runProbe(command, script, limits?: { timeoutMs: number; outputBytes: number }): Promise<string>`
  - `type ProbeRunner = (command: PythonCommand, script: string) => Promise<string>`
  - `probePython(command: PythonCommand, run?: ProbeRunner): Promise<PythonProbe>`
  - `createDesktopLauncher({ python?: () => PythonCommand | undefined; spawnTimeoutMs?: number; onOutput?: (plugin: LaunchablePlugin, line: string) => void })`

- [ ] **Step 1: 寫失敗的測試**

建立 `apps/desktop/src/main/plugins/python.test.ts`：

```ts
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyProbe,
  probePython,
  pythonCommands,
  PYTHON_PROBE_SCRIPT,
  runProbe,
} from "./python.js";

afterEach(() => vi.unstubAllEnvs());
const limits = { timeoutMs: 10_000, outputBytes: 4096 };
const node = (code: string) => ({ executable: process.execPath, args: ["-e", code, "--"] });

describe("pythonCommands", () => {
  it("lists PATH candidates, adds py -3 on Windows and keeps a custom saved choice", () => {
    expect(pythonCommands("darwin").map(({ id }) => id)).toEqual(["python3", "python"]);
    const custom = { executable: "C:/Python312/python.exe", args: [] };
    expect(pythonCommands("win32", custom)).toEqual([
      { id: "python3", command: { executable: "python3", args: [] } },
      { id: "python", command: { executable: "python", args: [] } },
      { id: "py", command: { executable: "py", args: ["-3"] } },
      { id: "saved", command: custom },
    ]);
    expect(
      pythonCommands("linux", { executable: "python3", args: [] }).map(({ id }) => id),
    ).toEqual(["python3", "python"]);
  });
});

describe("classifyProbe", () => {
  const report = (value: object) => `noise from sitecustomize\n${JSON.stringify(value)}\n`;
  it.each([
    [
      { version: "3.12.1", path: "/py", sdk: "1.0.0" },
      { status: "ok", version: "3.12.1", path: "/py", sdkApiVersion: "1.0.0" },
    ],
    [
      { version: "3.12.1", path: "/py" },
      { status: "warning", problem: "sdk-missing" },
    ],
    [
      { version: "3.10.0", path: "/py", sdk: "2.0.0" },
      { status: "warning", problem: "sdk-incompatible", sdkApiVersion: "2.0.0" },
    ],
    [
      { version: "3.10.0", path: "/py", sdk: "nonsense" },
      { status: "warning", problem: "sdk-incompatible" },
    ],
    [
      { version: "3.9.18", path: "/py", sdk: "1.0.0" },
      { status: "error", problem: "too-old", version: "3.9.18" },
    ],
  ])("classifies %j", (value, expected) => {
    expect(classifyProbe(report(value))).toMatchObject(expected);
  });
  it("fails on output that is not a report", () => {
    expect(classifyProbe("Python was not found")).toMatchObject({
      status: "error",
      problem: "failed",
    });
    expect(classifyProbe("")).toMatchObject({ status: "error", problem: "failed" });
  });
});

describe("runProbe", () => {
  it("runs the command's own arguments, then -c and the script, without a shell", async () => {
    expect(
      await runProbe(node("process.stdout.write(process.argv.slice(1).join('|'))"), "S", limits),
    ).toBe("-c|S");
  });
  it("stops a probe that hangs or floods stdout", async () => {
    const started = Date.now();
    await expect(
      runProbe(node("setTimeout(() => {}, 60_000)"), "", { timeoutMs: 200, outputBytes: 4096 }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
    await expect(
      runProbe(
        node("process.stdout.write('x'.repeat(100_000)); setTimeout(() => {}, 60_000)"),
        "",
        limits,
      ),
    ).rejects.toThrow(/maxBuffer/);
  });
  it("reports a runner failure as an unusable interpreter", async () => {
    expect(
      await probePython({ executable: "python3", args: [] }, async () => {
        throw new Error("spawn python3 ENOENT");
      }),
    ).toEqual({ status: "error", problem: "failed", detail: "spawn python3 ENOENT" });
  });
  const python = ["python3", "python"].find(
    (command) =>
      spawnSync(command, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"])
        .status === 0,
  );
  it.skipIf(!python)("probes a real interpreter with the repository SDK", async () => {
    vi.stubEnv("PYTHONPATH", fileURLToPath(new URL("../../../../../sdks/python", import.meta.url)));
    expect(await probePython({ executable: python!, args: [] })).toMatchObject({
      status: "ok",
      sdkApiVersion: "1.0.0",
    });
    expect(PYTHON_PROBE_SCRIPT).toContain("import kobrixa");
  });
});
```

在 `apps/desktop/src/main/plugins/launchers.test.ts`：

1. 既有測試 `wires Python stderr lines to the same prefixed main console` 的 `createDesktopLauncher({ python: "/python" })` 改成 `createDesktopLauncher({ python: () => ({ executable: "/python", args: [] }) })`，其餘斷言不變。
2. 檔案最後加：

```ts
it("reads the Python command on every launch and puts its arguments first", async () => {
  let python = { executable: "py", args: ["-3"] };
  const launch = createDesktopLauncher({ python: () => python });
  await launch({ ...plugin, runtime: "python" });
  expect(vi.mocked(spawnPluginProcess).mock.calls.at(-1)!.slice(0, 2)).toEqual([
    "py",
    ["-3", "-u", plugin.entry],
  ]);
  python = { executable: "/new/python", args: [] };
  await launch({ ...plugin, runtime: "python" });
  expect(vi.mocked(spawnPluginProcess).mock.calls.at(-1)![0]).toBe("/new/python");
});

it("refuses a Python plugin when no interpreter is chosen", async () => {
  await expect(
    createDesktopLauncher({ python: () => undefined })({ ...plugin, runtime: "python" }),
  ).rejects.toMatchObject({ code: "PLUGIN_E_LAUNCH" });
});

it("sends output lines to the output hook together with the plugin", async () => {
  const onOutput = vi.fn();
  await createDesktopLauncher({ python: () => ({ executable: "/python", args: [] }), onOutput })({
    ...plugin,
    sourceKey: "dev:0123456789abcdef",
    runtime: "python",
  });
  vi.mocked(spawnPluginProcess).mock.calls.at(-1)![2].onOutput?.("hi");
  expect(onOutput).toHaveBeenCalledWith(
    expect.objectContaining({ sourceKey: "dev:0123456789abcdef" }),
    "hi",
  );
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/python.test.ts src/main/plugins/launchers.test.ts`
Expected: FAIL，找不到 `./python.js`；launcher 測試因 `python` 不是函式而失敗。

- [ ] **Step 3: 實作**

建立 `apps/desktop/src/main/plugins/python.ts`：

```ts
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import semver from "semver";
import { z } from "zod";
import { PLUGIN_API_VERSION } from "@kobrixa/plugin-protocol";
import { messageOf } from "@kobrixa/plugin-runtime";
import type { PythonChoiceId, PythonProbe } from "../../shared/plugins.js";

export const PYTHON_PROBE_TIMEOUT_MS = 3_000;
export const PYTHON_PROBE_OUTPUT_BYTES = 4 * 1024;
export const PYTHON_MINIMUM_VERSION = "3.10.0";
export interface PythonCommand {
  executable: string;
  args: string[];
}
export interface PythonCandidateCommand {
  id: Exclude<PythonChoiceId, "other">;
  command: PythonCommand;
}

/** Prints one JSON line: the interpreter's version and path, and the SDK's API version. */
export const PYTHON_PROBE_SCRIPT = [
  "import json, sys",
  "result = {'version': '%d.%d.%d' % sys.version_info[:3], 'path': sys.executable}",
  "try:",
  "    import kobrixa",
  "    result['sdk'] = str(kobrixa.API_VERSION)",
  "except Exception:",
  "    pass",
  "print(json.dumps(result))",
].join("\n");

export const sameCommand = (a: PythonCommand, b: PythonCommand): boolean =>
  a.executable === b.executable &&
  a.args.length === b.args.length &&
  a.args.every((arg, index) => arg === b.args[index]);
export const commandLabel = (command: PythonCommand): string =>
  [command.executable, ...command.args].join(" ");

/** Interpreters found by name on PATH, plus a saved custom choice that none of them matches. */
export function pythonCommands(
  platform: NodeJS.Platform,
  saved?: PythonCommand,
): PythonCandidateCommand[] {
  const list: PythonCandidateCommand[] = [
    { id: "python3", command: { executable: "python3", args: [] } },
    { id: "python", command: { executable: "python", args: [] } },
  ];
  if (platform === "win32") list.push({ id: "py", command: { executable: "py", args: ["-3"] } });
  if (saved && !list.some(({ command }) => sameCommand(command, saved)))
    list.push({ id: "saved", command: saved });
  return list;
}

const reportSchema = z.object({
  version: z.string().max(32),
  path: z.string().max(4096),
  sdk: z.string().max(64).optional(),
});

export function classifyProbe(output: string): PythonProbe {
  let report: z.infer<typeof reportSchema>;
  try {
    report = reportSchema.parse(JSON.parse(output.trim().split("\n").at(-1) ?? ""));
  } catch {
    return {
      status: "error",
      problem: "failed",
      detail: "The interpreter did not report its version.",
    };
  }
  const found = { version: report.version, path: report.path };
  const version = semver.coerce(report.version);
  if (!version || semver.lt(version, PYTHON_MINIMUM_VERSION))
    return {
      ...found,
      status: "error",
      problem: "too-old",
      detail: `Python ${report.version} is older than 3.10.`,
    };
  if (report.sdk === undefined)
    return {
      ...found,
      status: "warning",
      problem: "sdk-missing",
      detail: "This interpreter cannot import the kobrixa Python SDK.",
    };
  const sdk = semver.valid(report.sdk);
  if (!sdk || semver.major(sdk) !== semver.major(PLUGIN_API_VERSION))
    return {
      ...found,
      sdkApiVersion: report.sdk,
      status: "warning",
      problem: "sdk-incompatible",
      detail: `The kobrixa SDK implements API ${report.sdk}; Kobrixa requires ${PLUGIN_API_VERSION}.`,
    };
  return { ...found, sdkApiVersion: sdk, status: "ok" };
}

export type ProbeRunner = (command: PythonCommand, script: string) => Promise<string>;

/** No shell; killed at the time limit or as soon as stdout passes the output limit. */
export function runProbe(
  command: PythonCommand,
  script: string,
  limits = { timeoutMs: PYTHON_PROBE_TIMEOUT_MS, outputBytes: PYTHON_PROBE_OUTPUT_BYTES },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command.executable,
      [...command.args, "-c", script],
      {
        cwd: tmpdir(),
        encoding: "utf8",
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
        killSignal: "SIGKILL",
        maxBuffer: limits.outputBytes,
        timeout: limits.timeoutMs,
        windowsHide: true,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/** A passing probe does not guarantee a working plugin: the launch handshake still checks. */
export async function probePython(
  command: PythonCommand,
  run: ProbeRunner = runProbe,
): Promise<PythonProbe> {
  try {
    return classifyProbe(await run(command, PYTHON_PROBE_SCRIPT));
  } catch (error) {
    return { status: "error", problem: "failed", detail: messageOf(error) };
  }
}
```

`apps/desktop/src/main/plugins/launchers.ts`：在 import 區加 `import type { PythonCommand } from "./python.js";`，並把 `createDesktopLauncher` 整個函式換成：

```ts
const logToConsole = (plugin: LaunchablePlugin, line: string) =>
  console.error(`[plugin ${plugin.id}] ${line}`);

export function createDesktopLauncher(options: {
  /** Read on every launch, so a newly chosen interpreter applies to the next plugin process. */
  python?: () => PythonCommand | undefined;
  spawnTimeoutMs?: number;
  onOutput?: (plugin: LaunchablePlugin, line: string) => void;
}): PluginLauncher {
  return async (plugin) => {
    const output = options.onOutput ?? logToConsole;
    const onOutput = (line: string) => output(plugin, line);
    if (plugin.runtime === "node")
      return launchNode(plugin, onOutput, options.spawnTimeoutMs ?? PLUGIN_SPAWN_TIMEOUT_MS);
    const python = options.python?.();
    if (!python)
      throw new PluginError(
        "PLUGIN_E_LAUNCH",
        "Choose a Python interpreter under Settings → Plugins → Developer mode, or start Kobrixa with --plugin-python=<interpreter>.",
      );
    return spawnPluginProcess(python.executable, [...python.args, "-u", plugin.entry], {
      onOutput,
      cwd: plugin.directory,
      env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });
  };
}
```

`apps/desktop/src/main/index.ts`：`launcher: createDesktopLauncher(pluginSettings),` 暫時改成：

```ts
    launcher: createDesktopLauncher({
      python: () =>
        pluginSettings.python === undefined
          ? undefined
          : { executable: pluginSettings.python, args: [] },
    }),
```

`tests/desktop/plugins-smoke-main.ts`：`launcher: createDesktopLauncher({ python }),` 改成 `launcher: createDesktopLauncher({ python: () => ({ executable: python, args: [] }) }),`。

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins && pnpm --filter @kobrixa/desktop check`
Expected: PASS；沒有 Python 3.10+ 的機器上，真實直譯器那一項顯示 skipped。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/plugins/python.ts apps/desktop/src/main/plugins/python.test.ts apps/desktop/src/main/plugins/launchers.ts apps/desktop/src/main/plugins/launchers.test.ts apps/desktop/src/main/index.ts tests/desktop/plugins-smoke-main.ts
git commit -m "feat(desktop): probe Python interpreters and read the choice on each launch"
```

---

### Task 5: session marker、訊號與畫面健康監看

**Files:**

- Create: `apps/desktop/src/main/plugins/session.ts`
- Test: `apps/desktop/src/main/plugins/session.test.ts`

**Interfaces:**

- Consumes：Task 2 的 `SafeModeLock`。
- Produces:
  - `class SessionMarkerFile { readonly file: string; constructor(userData: string, now?: () => Date); begin(): SafeModeLock["reason"] | undefined; update(patch: { thirdPartyRunning?: boolean; rendererUnresponsive?: true }): void; finish(): void }`
    - `begin()`：讀上一次留下的 marker——`rendererUnresponsive` 為真回傳 `"renderer-unresponsive"`，否則 `thirdPartyRunning` 為真回傳 `"unclean-exit"`，其他（不存在、讀不懂、兩者皆假）回傳 `undefined`；接著寫入本次的新 marker。
    - `finish()`：正常結束。先把 `thirdPartyRunning` 寫成 `false`；本次沒有卡住過就刪除 marker，卡住過就保留。之後的 `update()` 不再寫入。
  - `quitOnSignals(target: { on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown }, quit: () => void): void`
  - `interface RendererHealthSource`、`watchRendererHealth(window: RendererHealthSource, onHang: () => void): void`（`unresponsive` 與非 `clean-exit` 的 `render-process-gone` 視為卡住）

- [ ] **Step 1: 寫失敗的測試**

建立 `apps/desktop/src/main/plugins/session.test.ts`：

```ts
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { quitOnSignals, SessionMarkerFile, watchRendererHealth } from "./session.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-session-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));
const marker = () => new SessionMarkerFile(root, () => new Date("2026-10-15T00:00:00.000Z"));
const onDisk = async () =>
  JSON.parse(await readFile(path.join(root, "plugins/session.json"), "utf8"));

it("starts a marker and removes it on a clean exit", async () => {
  const session = marker();
  expect(session.begin()).toBeUndefined();
  expect(await onDisk()).toEqual({
    startedAt: "2026-10-15T00:00:00.000Z",
    thirdPartyRunning: false,
    rendererUnresponsive: false,
  });
  session.update({ thirdPartyRunning: true });
  expect((await onDisk()).thirdPartyRunning).toBe(true);
  session.finish();
  await expect(readFile(session.file)).rejects.toMatchObject({ code: "ENOENT" });
  expect(marker().begin()).toBeUndefined();
});

it("reports a crash while a third-party process ran", () => {
  const session = marker();
  session.begin();
  session.update({ thirdPartyRunning: true });
  expect(marker().begin()).toBe("unclean-exit");
});

it("ignores a crash while no third-party process ran", () => {
  const session = marker();
  session.begin();
  session.update({ thirdPartyRunning: true });
  session.update({ thirdPartyRunning: false });
  expect(marker().begin()).toBeUndefined();
});

it("keeps the marker after a hang even when the session ends cleanly", async () => {
  const session = marker();
  session.begin();
  session.update({ rendererUnresponsive: true });
  session.update({ thirdPartyRunning: true });
  session.finish();
  expect(await onDisk()).toMatchObject({ rendererUnresponsive: true, thirdPartyRunning: false });
  const next = marker();
  expect(next.begin()).toBe("renderer-unresponsive");
  // The new session starts clean, so its own clean exit clears the marker again.
  next.finish();
  expect(marker().begin()).toBeUndefined();
});

it("ignores an unreadable marker and stops writing after finish", async () => {
  await mkdir(path.join(root, "plugins"), { recursive: true });
  await writeFile(path.join(root, "plugins/session.json"), "{not json");
  const session = marker();
  expect(session.begin()).toBeUndefined();
  session.finish();
  session.update({ thirdPartyRunning: true });
  await expect(readFile(session.file)).rejects.toMatchObject({ code: "ENOENT" });
});

it("quits through Electron on SIGINT and SIGTERM", () => {
  const signals = new EventEmitter();
  const quit = vi.fn();
  quitOnSignals(signals, quit);
  signals.emit("SIGINT");
  signals.emit("SIGTERM");
  expect(quit).toHaveBeenCalledTimes(2);
});

it("treats an unresponsive window or a crashed renderer as a hang, but not a clean exit", () => {
  const window = Object.assign(new EventEmitter(), { webContents: new EventEmitter() });
  const onHang = vi.fn();
  watchRendererHealth(window, onHang);
  window.webContents.emit("render-process-gone", {}, { reason: "clean-exit" });
  expect(onHang).not.toHaveBeenCalled();
  window.emit("unresponsive");
  window.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  expect(onHang).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/session.test.ts`
Expected: FAIL，找不到 `./session.js`。

- [ ] **Step 3: 實作**

建立 `apps/desktop/src/main/plugins/session.ts`：

```ts
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { SafeModeLock } from "./state-store.js";

const markerSchema = z.strictObject({
  startedAt: z.iso.datetime(),
  thirdPartyRunning: z.boolean(),
  rendererUnresponsive: z.boolean(),
});
export type SessionMarker = z.infer<typeof markerSchema>;

/**
 * `<userData>/plugins/session.json` exists while Kobrixa runs; a crash leaves it behind. Writes
 * are synchronous so the clean-exit removal in Electron's quit event cannot be undone by a write
 * that was still pending.
 */
export class SessionMarkerFile {
  readonly file: string;
  #marker: SessionMarker | undefined;
  #finished = false;

  constructor(
    userData: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.file = path.join(userData, "plugins", "session.json");
  }

  /** Reads what the previous session left behind, then starts this session's marker. */
  begin(): SafeModeLock["reason"] | undefined {
    const previous = this.#read();
    this.#marker = {
      startedAt: this.now().toISOString(),
      thirdPartyRunning: false,
      rendererUnresponsive: false,
    };
    this.#write();
    if (previous?.rendererUnresponsive) return "renderer-unresponsive";
    if (previous?.thirdPartyRunning) return "unclean-exit";
    return undefined;
  }

  /** `rendererUnresponsive` is sticky for the rest of the session. */
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

  /** A clean exit. The marker stays when the renderer hung, so the next start still recovers. */
  finish(): void {
    const marker = this.#marker;
    if (!marker || this.#finished) return;
    this.#finished = true;
    this.#marker = { ...marker, thirdPartyRunning: false };
    this.#write();
    if (marker.rendererUnresponsive) return;
    try {
      rmSync(this.file, { force: true });
    } catch {
      // The marker left behind no longer claims a running plugin, so it triggers nothing.
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
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(temporary, JSON.stringify(this.#marker), { mode: 0o600 });
      renameSync(temporary, this.file);
    } catch {
      // Recovery is best effort: without a marker the next start simply cannot detect a crash.
      try {
        rmSync(temporary, { force: true });
      } catch {
        /* Nothing left to clean up. */
      }
    }
  }
}

/** SIGINT and SIGTERM go through Electron's normal quit, so plugins stop and the marker clears. */
export function quitOnSignals(
  target: { on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown },
  quit: () => void,
): void {
  target.on("SIGINT", quit);
  target.on("SIGTERM", quit);
}

export interface RendererHealthSource {
  on(event: "unresponsive", listener: () => void): unknown;
  webContents: {
    on(
      event: "render-process-gone",
      listener: (event: unknown, details: { reason: string }) => void,
    ): unknown;
  };
}

export function watchRendererHealth(window: RendererHealthSource, onHang: () => void): void {
  window.on("unresponsive", onHang);
  window.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit") onHang();
  });
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/session.test.ts && pnpm --filter @kobrixa/desktop check`
Expected: PASS，型別檢查無錯誤。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/plugins/session.ts apps/desktop/src/main/plugins/session.test.ts
git commit -m "feat(desktop): track unclean exits with a plugin session marker"
```

---

### Task 6: 原生對話框

**Files:**

- Create: `apps/desktop/src/main/plugins/dialogs.ts`
- Test: `apps/desktop/src/main/plugins/dialogs.test.ts`

**Interfaces:**

- Produces:
  - `interface LinkPreview { name: string; id: string; runtime?: string; directory: string; problems: string[] }`
  - `interface PluginDialogs { confirmDeveloperMode(): Promise<boolean>; chooseFolder(): Promise<string | undefined>; confirmLink(preview: LinkPreview): Promise<boolean>; confirmUnlink(preview: { name: string; directory: string }): Promise<boolean>; choosePython(): Promise<string | undefined> }`
  - `electronPluginDialogs(window: () => BrowserWindow | undefined, locale: PluginLocale): PluginDialogs`
- 確認對話框預設按鈕是「取消」（`defaultId: 1`、`cancelId: 1`），只有第一個按鈕回傳 `true`。

- [ ] **Step 1: 寫失敗的測試**

建立 `apps/desktop/src/main/plugins/dialogs.test.ts`：

```ts
import { beforeEach, expect, it, vi } from "vitest";
import { electronPluginDialogs } from "./dialogs.js";

const { showMessageBox, showOpenDialog } = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  showOpenDialog: vi.fn(),
}));
vi.mock("electron", () => ({ dialog: { showMessageBox, showOpenDialog } }));
beforeEach(() => {
  showMessageBox.mockReset();
  showOpenDialog.mockReset();
});

it("confirms developer mode only on the first button and says it is not a sandbox", async () => {
  showMessageBox.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 });
  const dialogs = electronPluginDialogs(() => undefined, "zh-TW");
  expect(await dialogs.confirmDeveloperMode()).toBe(true);
  expect(await dialogs.confirmDeveloperMode()).toBe(false);
  const [options] = showMessageBox.mock.calls[0]!;
  expect(options).toMatchObject({ buttons: ["開啟", "取消"], defaultId: 1, cancelId: 1 });
  expect(options.detail).toContain("不是沙箱");
});

it("shows what will be linked and promises that unlinking deletes nothing", async () => {
  showMessageBox.mockResolvedValue({ response: 0 });
  const dialogs = electronPluginDialogs(() => undefined, "en");
  expect(
    await dialogs.confirmLink({
      name: "Hello",
      id: "acme.hello",
      runtime: "python",
      directory: "/p/hello",
      problems: ["The entry file is missing"],
    }),
  ).toBe(true);
  const link = showMessageBox.mock.calls.at(-1)![0];
  expect(link.message).toContain("Hello");
  for (const text of ["acme.hello", "python", "/p/hello", "The entry file is missing"])
    expect(link.detail).toContain(text);
  await dialogs.confirmUnlink({ name: "Hello", directory: "/p/hello" });
  expect(showMessageBox.mock.calls.at(-1)![0].detail).toContain("No files are deleted");
});

it("returns the chosen path, undefined when cancelled, and attaches to a live window", async () => {
  const window = { isDestroyed: () => false };
  showOpenDialog
    .mockResolvedValueOnce({ canceled: false, filePaths: ["/p/hello"] })
    .mockResolvedValueOnce({ canceled: true, filePaths: [] });
  const dialogs = electronPluginDialogs(() => window as never, "en");
  expect(await dialogs.chooseFolder()).toBe("/p/hello");
  expect(showOpenDialog).toHaveBeenLastCalledWith(
    window,
    expect.objectContaining({ properties: ["openDirectory"] }),
  );
  expect(await dialogs.choosePython()).toBeUndefined();
  expect(showOpenDialog).toHaveBeenLastCalledWith(
    window,
    expect.objectContaining({ properties: ["openFile"] }),
  );
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/dialogs.test.ts`
Expected: FAIL，找不到 `./dialogs.js`。

- [ ] **Step 3: 實作**

建立 `apps/desktop/src/main/plugins/dialogs.ts`：

```ts
import {
  dialog,
  type BrowserWindow,
  type MessageBoxOptions,
  type OpenDialogOptions,
} from "electron";
import type { PluginLocale } from "@kobrixa/plugin-protocol";

export interface LinkPreview {
  name: string;
  id: string;
  runtime?: string;
  directory: string;
  problems: string[];
}
/** Native dialogs owned by main; the smoke test injects fakes with the same shape. */
export interface PluginDialogs {
  confirmDeveloperMode(): Promise<boolean>;
  chooseFolder(): Promise<string | undefined>;
  confirmLink(preview: LinkPreview): Promise<boolean>;
  confirmUnlink(preview: { name: string; directory: string }): Promise<boolean>;
  choosePython(): Promise<string | undefined>;
}

const copy = {
  en: {
    cancel: "Cancel",
    developerTitle: "Turn on developer mode?",
    developerDetail:
      "Developer mode runs the code in the plugin folders you link as normal programs on this computer, with your permissions. It is not a sandbox. Link only folders you trust.",
    turnOn: "Turn on",
    chooseFolder: "Choose a plugin folder",
    linkTitle: (name: string) => `Link “${name}”?`,
    id: "ID: ",
    runtime: "Runtime: ",
    folder: "Folder: ",
    problem: "Problem: ",
    unknown: "unknown",
    trust: "Its code will run on this computer. Link only plugins you trust.",
    link: "Link",
    unlinkTitle: (name: string) => `Unlink “${name}”?`,
    unlinkDetail: "Kobrixa stops the plugin and forgets the folder. No files are deleted.",
    unlink: "Unlink",
    choosePython: "Choose a Python interpreter",
  },
  "zh-TW": {
    cancel: "取消",
    developerTitle: "開啟開發者模式？",
    developerDetail:
      "開發者模式會以你的權限，把你連結的插件資料夾當作一般程式在這部電腦上執行。這不是沙箱，請只連結你信任的資料夾。",
    turnOn: "開啟",
    chooseFolder: "選擇插件資料夾",
    linkTitle: (name: string) => `連結「${name}」？`,
    id: "ID：",
    runtime: "執行環境：",
    folder: "資料夾：",
    problem: "問題：",
    unknown: "未知",
    trust: "它的程式碼會在這部電腦上執行，請只連結你信任的插件。",
    link: "連結",
    unlinkTitle: (name: string) => `解除連結「${name}」？`,
    unlinkDetail: "Kobrixa 會停止這個插件並移除連結，不會刪除任何檔案。",
    unlink: "解除連結",
    choosePython: "選擇 Python 直譯器",
  },
} as const;

export function electronPluginDialogs(
  window: () => BrowserWindow | undefined,
  locale: PluginLocale,
): PluginDialogs {
  const t = copy[locale];
  const parent = () => {
    const target = window();
    return target && !target.isDestroyed() ? target : undefined;
  };
  const confirm = async (options: {
    message: string;
    detail: string;
    accept: string;
    warning?: boolean;
  }) => {
    const box: MessageBoxOptions = {
      type: options.warning ? "warning" : "question",
      message: options.message,
      detail: options.detail,
      buttons: [options.accept, t.cancel],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const target = parent();
    const result = target
      ? await dialog.showMessageBox(target, box)
      : await dialog.showMessageBox(box);
    return result.response === 0;
  };
  const choose = async (options: OpenDialogOptions) => {
    const target = parent();
    const result = target
      ? await dialog.showOpenDialog(target, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? undefined : result.filePaths[0];
  };
  return {
    confirmDeveloperMode: () =>
      confirm({
        message: t.developerTitle,
        detail: t.developerDetail,
        accept: t.turnOn,
        warning: true,
      }),
    chooseFolder: () => choose({ title: t.chooseFolder, properties: ["openDirectory"] }),
    confirmLink: (preview) =>
      confirm({
        message: t.linkTitle(preview.name),
        detail: [
          `${t.id}${preview.id}`,
          `${t.runtime}${preview.runtime ?? t.unknown}`,
          `${t.folder}${preview.directory}`,
          ...preview.problems.map((problem) => `${t.problem}${problem}`),
          "",
          t.trust,
        ].join("\n"),
        accept: t.link,
      }),
    confirmUnlink: (preview) =>
      confirm({
        message: t.unlinkTitle(preview.name),
        detail: `${t.unlinkDetail}\n${t.folder}${preview.directory}`,
        accept: t.unlink,
      }),
    choosePython: () => choose({ title: t.choosePython, properties: ["openFile"] }),
  };
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/dialogs.test.ts && pnpm --filter @kobrixa/desktop check`
Expected: PASS，型別檢查無錯誤。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/plugins/dialogs.ts apps/desktop/src/main/plugins/dialogs.test.ts
git commit -m "feat(desktop): add native confirmations for plugin developer mode and links"
```

---

### Task 7: PluginController 與 startPlugins

**Files:**

- Create: `apps/desktop/src/main/plugins/controller.ts`
- Test: `apps/desktop/src/main/plugins/controller.test.ts`
- Modify: `apps/desktop/src/shared/plugins.ts`（加 `PluginsViewEvent`）

**Interfaces:**

- Consumes：Task 1 的 manager API；Task 2 的 `PluginSettingsStore`、`PluginStateDocument`；Task 3 的 `PluginLogs`、`PluginNotices` 與共用型別；Task 4 的 `PythonCommand`、`pythonCommands`、`sameCommand`、`commandLabel`、`probePython`、`createDesktopLauncher`；Task 5 的 `SessionMarkerFile`；Task 6 的 `PluginDialogs`；既有的 `PluginOptions`（`./options.js`）。
- Produces:
  - `type PluginsViewEvent = { type: "state"; state: PluginsView } | { type: "notice"; notice: StoredNotice }`（`shared/plugins.ts`）
  - `type PluginManagerPort = Pick<PluginManager, "state" | "executeCommand" | "setEnabled" | "addSource" | "removeSource" | "reloadSource" | "leaveSafeMode" | "onEvent" | "active" | "shutdown" | "resume" | "frontendFor">`
  - `interface PluginControllerDependencies`（見 Step 3）
  - `class PluginController`：
    - 讀取：`state(): PluginsView`、`notices(): StoredNotice[]`、`readLog(sourceKey, after): LogRead`、`python(): PythonCommand | undefined`、`get active(): boolean`、`frontendFor(language): string | undefined`、`onEvent(listener): () => void`
    - 命令：`execute(commandId): Promise<PluginCommandResult>`、`cancel(sourceKey): void`
    - 變更（皆回傳 `Promise<PluginsResult>`）：`setEnabled(sourceKey, enabled)`、`setDeveloperMode(enabled)`、`linkFolder()`、`relinkFolder(sourceKey)`、`unlink(sourceKey)`、`reload(sourceKey)`、`setPython(id: PythonChoiceId)`、`clearSafeModeLock()`
    - `pythonCandidates(): Promise<PythonChoice[]>`
    - 生命週期：`shutdown(deadlineMs?)`、`resume()`、`markRendererUnresponsive()`、`finishSession()`
  - `interface StartPluginsOptions`、`startPlugins(options): Promise<PluginController>`
- 授權規則（全部在主程序）：

| 操作                                    | 正在關閉 | 需要開發者模式 | 安全模式下      |
| --------------------------------------- | -------- | -------------- | --------------- |
| `setDeveloperMode`、`clearSafeModeLock` | 拒絕     | —              | 允許            |
| `setEnabled(…, true)`                   | 拒絕     | 是             | 由 manager 拒絕 |
| `setEnabled(…, false)`                  | 拒絕     | —              | 允許            |
| `linkFolder`、`relinkFolder`、`reload`  | 拒絕     | 是             | 拒絕            |
| `unlink`、`setPython`                   | 拒絕     | 是             | 允許            |

開了原生對話框的操作，在對話框關閉後**再檢查一次**。

- [ ] **Step 1: 寫失敗的測試**

建立 `apps/desktop/src/main/plugins/controller.test.ts`：

```ts
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  developmentSourceKey,
  PluginError,
  type LaunchablePlugin,
  type PluginManagerEvent,
  type PluginsSnapshot,
} from "@kobrixa/plugin-runtime";
import type { PluginsViewEvent, PythonProbe } from "../../shared/plugins.js";
import {
  PluginController,
  startPlugins,
  type PluginManagerPort,
  type StartPluginsOptions,
} from "./controller.js";
import { PluginLogs, PluginNotices } from "./logs.js";
import type { PluginStateDocument } from "./state-store.js";

vi.mock("electron", () => ({ utilityProcess: {}, MessageChannelMain: class {} }));

let root: string;
let userData: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "kobrixa-controller-")));
  userData = path.join(root, "user-data");
});
afterEach(() => rm(root, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

async function pluginFolder(name: string) {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "index.cjs"), "");
  await writeFile(
    path.join(directory, "kobrixa-plugin.json"),
    JSON.stringify({
      id: `acme.${name}`,
      version: "1.0.0",
      apiVersion: "^1.0.0",
      displayName: { en: `Hello ${name}`, "zh-TW": `哈囉 ${name}` },
      runtime: { kind: "node", entry: "index.cjs" },
      contributes: { commands: [{ id: `acme.${name}.greet`, title: "Greet" }] },
    }),
  );
  return directory;
}
const fakeDialogs = () => ({
  confirmDeveloperMode: vi.fn(async () => true),
  chooseFolder: vi.fn(async (): Promise<string | undefined> => undefined),
  confirmLink: vi.fn(async () => true),
  confirmUnlink: vi.fn(async () => true),
  choosePython: vi.fn(async (): Promise<string | undefined> => undefined),
});
const usable: PythonProbe = {
  status: "ok",
  version: "3.12.0",
  path: "/usr/bin/python3",
  sdkApiVersion: "1.0.0",
};
let hooks: Parameters<NonNullable<StartPluginsOptions["launcher"]>>[0];
const start = (dialogs = fakeDialogs(), options: Partial<StartPluginsOptions> = {}) =>
  startPlugins({
    userData,
    builtins: [],
    commandLine: { developmentDirectories: [], safeMode: false },
    dialogs,
    locale: "en",
    launcher: (given) => {
      hooks = given;
      return async () => {
        throw new PluginError("PLUGIN_E_LAUNCH", "Plugins do not run in these tests.");
      };
    },
    probe: async () => usable,
    platform: "linux",
    ...options,
  });
const enabled = async (dialogs = fakeDialogs(), options: Partial<StartPluginsOptions> = {}) => {
  const controller = await start(dialogs, options);
  expect(await controller.setDeveloperMode(true)).toMatchObject({ ok: true });
  return controller;
};
const saved = async () =>
  JSON.parse(await readFile(path.join(userData, "plugins/state.json"), "utf8"));

describe("startPlugins", () => {
  it("starts with developer mode off and refuses developer actions before any dialog", async () => {
    const dialogs = fakeDialogs();
    const controller = await start(dialogs);
    expect(controller.state()).toMatchObject({
      developer: { enabled: false, commandLine: false, linkedCount: 0 },
      safeMode: false,
      inflight: [],
      python: { pendingReload: [] },
    });
    for (const result of [
      await controller.linkFolder(),
      await controller.reload("dev:0123456789abcdef"),
      await controller.unlink("dev:0123456789abcdef"),
      await controller.setPython("python3"),
      await controller.setEnabled("dev:0123456789abcdef", true),
    ])
      expect(result).toMatchObject({ ok: false, code: "PLUGIN_E_DEVELOPER_MODE" });
    expect(dialogs.chooseFolder).not.toHaveBeenCalled();
  });

  it("turns developer mode on only after confirmation and remembers it", async () => {
    const dialogs = fakeDialogs();
    dialogs.confirmDeveloperMode.mockResolvedValueOnce(false);
    const controller = await start(dialogs);
    expect(await controller.setDeveloperMode(true)).toMatchObject({
      ok: true,
      outcome: "cancelled",
      state: { developer: { enabled: false } },
    });
    expect(await controller.setDeveloperMode(true)).toMatchObject({
      ok: true,
      state: { developer: { enabled: true } },
    });
    expect((await saved()).developerMode).toBe(true);
    expect((await start()).state().developer.enabled).toBe(true);
  });

  it("links a folder after confirmation, keeps it across restarts and refuses it twice", async () => {
    const folder = await pluginFolder("hello");
    const key = developmentSourceKey(folder);
    const dialogs = fakeDialogs();
    const controller = await enabled(dialogs);
    dialogs.chooseFolder.mockResolvedValueOnce(folder);
    expect(await controller.linkFolder()).toMatchObject({ ok: true, sourceKey: key });
    expect(dialogs.confirmLink).toHaveBeenCalledWith({
      name: "Hello hello",
      id: "acme.hello",
      runtime: "node",
      directory: folder,
      problems: [],
    });
    expect(controller.state()).toMatchObject({
      origins: { [key]: "linked" },
      developer: { linkedCount: 1 },
    });
    expect(controller.state().plugins.map((plugin) => [plugin.sourceKey, plugin.status])).toEqual([
      [key, "enabled"],
    ]);
    expect((await saved()).sources).toEqual([{ directory: folder }]);
    expect((await start()).state().origins).toEqual({ [key]: "linked" });
    dialogs.chooseFolder.mockResolvedValueOnce(folder);
    expect(await controller.linkFolder()).toMatchObject({
      ok: true,
      outcome: "duplicate",
      sourceKey: key,
    });
    expect(dialogs.confirmLink).toHaveBeenCalledOnce();
  });

  it.skipIf(process.platform === "win32")(
    "treats a symlink to a linked folder as a duplicate",
    async () => {
      const folder = await pluginFolder("hello");
      const alias = path.join(root, "alias");
      await symlink(folder, alias);
      const dialogs = fakeDialogs();
      const controller = await enabled(dialogs);
      dialogs.chooseFolder.mockResolvedValueOnce(folder).mockResolvedValueOnce(alias);
      await controller.linkFolder();
      expect(await controller.linkFolder()).toMatchObject({
        outcome: "duplicate",
        sourceKey: developmentSourceKey(folder),
      });
    },
  );

  it("treats a differently-cased path that resolves to a linked folder as a duplicate", async () => {
    const folder = await pluginFolder("hello");
    const dialogs = fakeDialogs();
    // On a case-insensitive file system realpath returns the folder's real spelling.
    const controller = await enabled(dialogs, {
      realpath: async (directory) =>
        directory.toLowerCase() === folder.toLowerCase() ? folder : directory,
    });
    dialogs.chooseFolder.mockResolvedValueOnce(folder).mockResolvedValueOnce(folder.toUpperCase());
    await controller.linkFolder();
    expect(await controller.linkFolder()).toMatchObject({
      outcome: "duplicate",
      sourceKey: developmentSourceKey(folder),
    });
    expect(controller.state().plugins).toHaveLength(1);
  });

  it("changes nothing when the folder dialog is cancelled or the link is declined", async () => {
    const dialogs = fakeDialogs();
    const controller = await enabled(dialogs);
    expect(await controller.linkFolder()).toMatchObject({ ok: true, outcome: "cancelled" });
    dialogs.chooseFolder.mockResolvedValueOnce(await pluginFolder("hello"));
    dialogs.confirmLink.mockResolvedValueOnce(false);
    expect(await controller.linkFolder()).toMatchObject({ ok: true, outcome: "cancelled" });
    expect(controller.state().plugins).toEqual([]);
    expect((await saved()).sources).toEqual([]);
  });

  it("re-checks permission after the confirmation dialog closes", async () => {
    const dialogs = fakeDialogs();
    const controller = await enabled(dialogs);
    dialogs.chooseFolder.mockResolvedValueOnce(await pluginFolder("hello"));
    dialogs.confirmLink.mockImplementationOnce(async () => {
      await controller.shutdown();
      return true;
    });
    expect(await controller.linkFolder()).toMatchObject({
      ok: false,
      code: "PLUGIN_E_SHUTTING_DOWN",
    });
    expect((await saved()).sources).toEqual([]);
    expect(await controller.setDeveloperMode(false)).toMatchObject({
      code: "PLUGIN_E_SHUTTING_DOWN",
    });
    await controller.resume();
    expect(await controller.setDeveloperMode(false)).toMatchObject({ ok: true });
  });

  it("turning developer mode off stops development plugins but keeps links and disables", async () => {
    const folder = await pluginFolder("hello");
    const key = developmentSourceKey(folder);
    const dialogs = fakeDialogs();
    const controller = await enabled(dialogs);
    dialogs.chooseFolder.mockResolvedValueOnce(folder);
    await controller.linkFolder();
    await controller.setEnabled(key, false);
    expect(await controller.setDeveloperMode(false)).toMatchObject({
      ok: true,
      state: { plugins: [], developer: { enabled: false, linkedCount: 1 } },
    });
    expect(await saved()).toMatchObject({
      developerMode: false,
      sources: [{ directory: folder }],
      disabled: [key],
    });
    await controller.setDeveloperMode(true);
    expect(controller.state().plugins).toMatchObject([
      { sourceKey: key, status: "disabled", disabledBy: "user" },
    ]);
    expect(dialogs.confirmDeveloperMode).toHaveBeenCalledTimes(2);
  });

  it("treats --plugin-dev-dir folders as session sources that authorize developer mode", async () => {
    const folder = await pluginFolder("hello");
    const key = developmentSourceKey(folder);
    const dialogs = fakeDialogs();
    const controller = await start(dialogs, {
      commandLine: { developmentDirectories: [folder], safeMode: false },
    });
    expect(controller.state()).toMatchObject({
      developer: { enabled: true, commandLine: true },
      origins: { [key]: "session" },
    });
    expect(await controller.unlink(key)).toMatchObject({
      ok: false,
      code: "PLUGIN_E_SESSION_SOURCE",
    });
    await expect(readFile(path.join(userData, "plugins/state.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    dialogs.chooseFolder.mockResolvedValueOnce(folder);
    expect(await controller.linkFolder()).toMatchObject({ ok: true, sourceKey: key });
    expect(controller.state().origins).toEqual({ [key]: "linked" });
    expect(controller.state().plugins).toHaveLength(1);
  });

  it("unlinks after confirmation, keeps the files and clears the source's logs", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const folder = await pluginFolder("hello");
    const key = developmentSourceKey(folder);
    const dialogs = fakeDialogs();
    const controller = await enabled(dialogs);
    dialogs.chooseFolder.mockResolvedValueOnce(folder);
    await controller.linkFolder();
    const launched: LaunchablePlugin = {
      id: "acme.hello",
      sourceKey: key,
      directory: folder,
      entry: path.join(folder, "index.cjs"),
      runtime: "node",
      permissions: [],
      commands: ["acme.hello.greet"],
    };
    hooks.onOutput(launched, "hello from it");
    expect(controller.readLog(key, 0).lines.map((line) => line.text)).toEqual(["hello from it"]);
    dialogs.confirmUnlink.mockResolvedValueOnce(false);
    expect(await controller.unlink(key)).toMatchObject({ ok: true, outcome: "cancelled" });
    expect(controller.state().plugins).toHaveLength(1);
    expect(await controller.unlink(key)).toMatchObject({
      ok: true,
      state: { plugins: [], developer: { linkedCount: 0 } },
    });
    expect(dialogs.confirmUnlink).toHaveBeenLastCalledWith({
      name: "Hello hello",
      directory: folder,
    });
    expect(controller.readLog(key, 0).lines).toEqual([]);
    expect((await saved()).sources).toEqual([]);
    await expect(readFile(path.join(folder, "kobrixa-plugin.json"), "utf8")).resolves.toContain(
      "acme.hello",
    );
  });

  it("points a linked folder that moved at its new location", async () => {
    const folder = await pluginFolder("hello");
    const oldKey = developmentSourceKey(folder);
    const dialogs = fakeDialogs();
    const controller = await enabled(dialogs);
    dialogs.chooseFolder.mockResolvedValueOnce(folder);
    await controller.linkFolder();
    const moved = path.join(root, "moved");
    await rename(folder, moved);
    await controller.reload(oldKey);
    expect(controller.state().plugins[0]!.status).toBe("invalid");
    expect(controller.state().plugins[0]!.problems[0]!.code).toBe("PLUGIN_E_MANIFEST");
    dialogs.chooseFolder.mockResolvedValueOnce(moved);
    expect(await controller.relinkFolder(oldKey)).toMatchObject({
      ok: true,
      sourceKey: developmentSourceKey(moved),
    });
    expect(controller.state().plugins.map((plugin) => [plugin.sourceKey, plugin.status])).toEqual([
      [developmentSourceKey(moved), "enabled"],
    ]);
    expect((await saved()).sources).toEqual([{ directory: moved }]);
  });

  it("in --safe-mode refuses linking and reloading but allows disabling and unlinking", async () => {
    const folder = await pluginFolder("hello");
    const key = developmentSourceKey(folder);
    const dialogs = fakeDialogs();
    const first = await enabled(dialogs);
    dialogs.chooseFolder.mockResolvedValueOnce(folder);
    await first.linkFolder();
    const controller = await start(dialogs, {
      commandLine: { developmentDirectories: [], safeMode: true },
    });
    expect(controller.state()).toMatchObject({
      safeMode: true,
      plugins: [{ sourceKey: key, disabledBy: "safe-mode" }],
    });
    expect(controller.state().safeModeLock).toBeUndefined();
    expect(await controller.linkFolder()).toMatchObject({ code: "PLUGIN_E_SAFE_MODE" });
    expect(await controller.reload(key)).toMatchObject({ code: "PLUGIN_E_SAFE_MODE" });
    // --safe-mode lasts the whole session, even after restoring.
    expect(await controller.clearSafeModeLock()).toMatchObject({
      ok: true,
      state: { safeMode: true },
    });
    expect(await controller.setEnabled(key, false)).toMatchObject({ ok: true });
    expect(await controller.unlink(key)).toMatchObject({ ok: true });
    expect((await saved()).safeModeLock).toBeUndefined();
  });

  it("locks safe mode after an unclean exit with third-party plugins running until restored", async () => {
    const folder = await pluginFolder("hello");
    const key = developmentSourceKey(folder);
    const dialogs = fakeDialogs();
    const first = await enabled(dialogs);
    dialogs.chooseFolder.mockResolvedValueOnce(folder);
    await first.linkFolder();
    // The previous session crashed while a plugin process ran.
    await writeFile(
      path.join(userData, "plugins/session.json"),
      JSON.stringify({
        startedAt: "2026-10-15T00:00:00.000Z",
        thirdPartyRunning: true,
        rendererUnresponsive: false,
      }),
    );
    const locked = await start(dialogs, { now: () => new Date("2026-10-15T08:00:00.000Z") });
    expect(locked.state()).toMatchObject({
      safeMode: true,
      safeModeLock: { since: "2026-10-15T08:00:00.000Z", reason: "unclean-exit" },
      plugins: [{ sourceKey: key, disabledBy: "safe-mode" }],
    });
    // The lock survives restarts until the user restores plugins.
    const still = await start(dialogs);
    expect(still.state()).toMatchObject({
      safeMode: true,
      safeModeLock: { reason: "unclean-exit" },
    });
    expect(await still.clearSafeModeLock()).toMatchObject({
      ok: true,
      state: { safeMode: false, plugins: [{ sourceKey: key, status: "enabled" }] },
    });
    expect(still.state().safeModeLock).toBeUndefined();
    expect((await saved()).safeModeLock).toBeUndefined();
    expect((await start(dialogs)).state().safeMode).toBe(false);
  });
});

describe("Python selection", () => {
  const probe = vi.fn(async (command: { executable: string }): Promise<PythonProbe> =>
    command.executable === "python"
      ? {
          status: "error",
          problem: "too-old",
          version: "3.8.0",
          detail: "Python 3.8.0 is older than 3.10.",
        }
      : usable,
  );

  it("lists probed candidates, saves a usable choice and refuses an unusable one", async () => {
    const dialogs = fakeDialogs();
    const controller = await enabled(dialogs, { probe });
    expect(await controller.pythonCandidates()).toEqual([
      { id: "python3", label: "python3", selected: false, probe: usable },
      {
        id: "python",
        label: "python",
        selected: false,
        probe: expect.objectContaining({ status: "error" }),
      },
    ]);
    expect(await controller.setPython("python")).toMatchObject({
      ok: false,
      code: "PLUGIN_E_PYTHON_UNUSABLE",
    });
    expect(await controller.setPython("py")).toMatchObject({
      ok: false,
      code: "PLUGIN_E_PYTHON_UNUSABLE",
    });
    expect(await controller.setPython("python3")).toMatchObject({
      ok: true,
      state: { python: { current: { label: "python3", origin: "settings" } } },
    });
    expect(hooks.python()).toEqual({ executable: "python3", args: [] });
    expect((await saved()).python).toEqual({ executable: "python3", args: [] });
    expect((await controller.pythonCandidates())[0]!.selected).toBe(true);
    const restarted = await start(dialogs, { probe });
    expect(hooks.python()).toEqual({ executable: "python3", args: [] });
    expect(restarted.state().python.current).toEqual({ label: "python3", origin: "settings" });
  });

  it("probes a picked interpreter and offers it as the saved choice", async () => {
    const dialogs = fakeDialogs();
    const controller = await enabled(dialogs, { probe });
    expect(await controller.setPython("other")).toMatchObject({ ok: true, outcome: "cancelled" });
    dialogs.choosePython.mockResolvedValueOnce("/opt/python/bin/python3.12");
    expect(await controller.setPython("other")).toMatchObject({ ok: true });
    expect(probe).toHaveBeenLastCalledWith({ executable: "/opt/python/bin/python3.12", args: [] });
    expect((await controller.pythonCandidates()).at(-1)).toMatchObject({
      id: "saved",
      label: "/opt/python/bin/python3.12",
      selected: true,
    });
  });

  it("lets --plugin-python override the saved choice for this session only", async () => {
    const controller = await enabled(fakeDialogs(), {
      probe,
      commandLine: { developmentDirectories: [], python: "/cli/python", safeMode: false },
    });
    await controller.pythonCandidates();
    await controller.setPython("python3");
    expect(hooks.python()).toEqual({ executable: "/cli/python", args: [] });
    expect(controller.state().python.current).toEqual({
      label: "/cli/python",
      origin: "command-line",
    });
    expect((await saved()).python).toEqual({ executable: "python3", args: [] });
  });
});

describe("PluginController with a fake manager", () => {
  const key = "dev:0123456789abcdef";
  const snapshot: PluginsSnapshot = {
    revision: 4,
    safeMode: false,
    developmentMode: true,
    plugins: [
      {
        sourceKey: key,
        id: "acme.hello",
        source: "development",
        runtime: "python",
        status: "enabled",
        running: true,
        problems: [],
        commands: [{ id: "acme.hello.greet", title: "Greet" }],
      },
    ],
  };
  function setup() {
    let listener: (event: PluginManagerEvent) => void = () => {};
    const manager = {
      active: false,
      state: () => snapshot,
      executeCommand: vi.fn(
        (_command: string, signal?: AbortSignal) =>
          new Promise((resolve) =>
            signal?.addEventListener("abort", () =>
              resolve({ ok: false, code: "PLUGIN_E_CANCELLED", message: "cancelled" }),
            ),
          ),
      ),
      onEvent: (next: (event: PluginManagerEvent) => void) => {
        listener = next;
        return () => {};
      },
    };
    const marker = { update: vi.fn(), finish: vi.fn() };
    let document: PluginStateDocument = {
      schemaVersion: 2,
      developerMode: true,
      sources: [],
      disabled: [],
      legacyDisabledIds: [],
    };
    const controller = new PluginController({
      manager: manager as unknown as PluginManagerPort,
      settings: {
        settings: () => document,
        update: async (change) => {
          document = change(document);
        },
      },
      dialogs: fakeDialogs(),
      logs: new PluginLogs(),
      notices: new PluginNotices(),
      marker,
      probe: async () => usable,
      realpath: async (directory) => directory,
      locale: "en",
      platform: "linux",
      session: { directories: [], safeMode: false },
    });
    return { controller, manager, marker, emit: (event: PluginManagerEvent) => listener(event) };
  }

  it("tracks in-flight commands per source and cancels only that source", async () => {
    const { controller } = setup();
    const events: PluginsViewEvent[] = [];
    controller.onEvent((event) => events.push(event));
    const running = controller.execute("acme.hello.greet");
    expect(controller.state().inflight).toEqual([key]);
    controller.cancel("dev:aaaaaaaaaaaaaaaa");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.state().inflight).toEqual([key]);
    controller.cancel(key);
    expect(await running).toMatchObject({ ok: false, code: "PLUGIN_E_CANCELLED" });
    expect(controller.state().inflight).toEqual([]);
    expect(
      events.flatMap((event) => (event.type === "state" ? [event.state.revision] : [])),
    ).toEqual([5, 6]);
  });

  it("records third-party processes and renderer hangs in the session marker", () => {
    const { controller, manager, marker, emit } = setup();
    manager.active = true;
    emit({ type: "state", state: snapshot });
    expect(marker.update).toHaveBeenLastCalledWith({ thirdPartyRunning: true });
    controller.markRendererUnresponsive();
    expect(marker.update).toHaveBeenLastCalledWith({ rendererUnresponsive: true });
    controller.finishSession();
    expect(marker.finish).toHaveBeenCalledOnce();
  });

  it("stores notices with ids and forwards them", () => {
    const { controller, emit } = setup();
    const events: PluginsViewEvent[] = [];
    controller.onEvent((event) => events.push(event));
    const notice = {
      pluginId: "acme.hello",
      sourceKey: key,
      severity: "warning" as const,
      message: "careful",
      at: 1,
    };
    emit({ type: "notice", notice });
    emit({ type: "notice", notice: { ...notice, message: "again" } });
    expect(events).toEqual([
      { type: "notice", notice: { ...notice, id: 1 } },
      { type: "notice", notice: { ...notice, message: "again", id: 2 } },
    ]);
    expect(controller.notices().map((item) => item.id)).toEqual([2, 1]);
  });

  it("marks running Python plugins for reload after the interpreter changes", async () => {
    const { controller, emit } = setup();
    await controller.pythonCandidates();
    expect(await controller.setPython("python3")).toMatchObject({
      ok: true,
      state: { python: { pendingReload: [key] } },
    });
    emit({
      type: "state",
      state: { ...snapshot, plugins: [{ ...snapshot.plugins[0]!, running: false }] },
    });
    expect(controller.state().python.pendingReload).toEqual([]);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter @kobrixa/plugin-runtime build && pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/controller.test.ts`
Expected: FAIL，找不到 `./controller.js`。

- [ ] **Step 3: 實作**

在 `apps/desktop/src/shared/plugins.ts` 的 `PluginsResult` 之後加：

```ts
export type PluginsViewEvent =
  { type: "state"; state: PluginsView } | { type: "notice"; notice: StoredNotice };
```

建立 `apps/desktop/src/main/plugins/controller.ts`：

```ts
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { LocalizedText, PluginLocale } from "@kobrixa/plugin-protocol";
import {
  developmentSourceKey,
  messageOf,
  PluginManager,
  readSource,
  type LaunchablePlugin,
  type PluginActionResult,
  type PluginCommandResult,
  type PluginErrorCode,
  type PluginLauncher,
  type PluginManagerOptions,
  type PluginPersistedState,
  type PluginsSnapshot,
  type PluginSource,
} from "@kobrixa/plugin-runtime";
import type {
  LogRead,
  PluginOrigin,
  PluginsResult,
  PluginsView,
  PluginsViewEvent,
  PythonChoice,
  PythonChoiceId,
  PythonProbe,
  StoredNotice,
} from "../../shared/plugins.js";
import type { PluginDialogs } from "./dialogs.js";
import { createDesktopLauncher } from "./launchers.js";
import { PluginLogs, PluginNotices } from "./logs.js";
import type { PluginOptions } from "./options.js";
import {
  commandLabel,
  probePython,
  pythonCommands,
  sameCommand,
  type PythonCommand,
} from "./python.js";
import { SessionMarkerFile } from "./session.js";
import { filePluginStateStore, type PluginSettingsStore } from "./state-store.js";

type Failure = Extract<PluginsResult, { ok: false }>;
const failure = (code: PluginErrorCode, message: string): Failure => ({ ok: false, code, message });
const localized = (text: LocalizedText, locale: PluginLocale) =>
  typeof text === "string" ? text : locale === "zh-TW" ? (text["zh-TW"] ?? text.en) : text.en;

/** Keeps the first spelling of each folder, by source key. */
function uniqueDirectories(directories: readonly string[]): string[] {
  const seen = new Set<string>();
  return directories.filter((directory) => {
    const key = developmentSourceKey(directory);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type PluginManagerPort = Pick<
  PluginManager,
  | "state"
  | "executeCommand"
  | "setEnabled"
  | "addSource"
  | "removeSource"
  | "reloadSource"
  | "leaveSafeMode"
  | "onEvent"
  | "active"
  | "shutdown"
  | "resume"
  | "frontendFor"
>;
export interface PluginControllerDependencies {
  manager: PluginManagerPort;
  settings: Pick<PluginSettingsStore, "settings" | "update">;
  dialogs: PluginDialogs;
  logs: PluginLogs;
  notices: PluginNotices;
  marker: Pick<SessionMarkerFile, "update" | "finish">;
  probe(command: PythonCommand): Promise<PythonProbe>;
  realpath(directory: string): Promise<string>;
  locale: PluginLocale;
  platform: NodeJS.Platform;
  session: {
    /** Real paths from --plugin-dev-dir. */
    directories: readonly string[];
    /** --plugin-python, which overrides the saved choice for this session only. */
    python?: PythonCommand;
    /** --safe-mode, which lasts the whole session. */
    safeMode: boolean;
  };
}
type Extra = { persisted?: false; outcome?: "cancelled" | "duplicate"; sourceKey?: string };

/**
 * Decides whether a plugin change may happen (developer mode, safe mode, shutdown) and owns what
 * the runtime must not know about: native dialogs, user settings, Python probing, logs, notices
 * and the session marker. The renderer only ever sends source keys and ids.
 *
 * These checks stop a renderer from adding paths or executables the user never chose; they
 * cannot protect against a compromised renderer that the user keeps clicking through.
 */
export class PluginController {
  #revision = 0;
  #developer: boolean;
  #commandLine: boolean;
  #closing = false;
  readonly #inflight = new Map<string, Set<AbortController>>();
  #candidates = new Map<string, PythonCommand>();
  readonly #pendingReload = new Set<string>();
  readonly #listeners = new Set<(event: PluginsViewEvent) => void>();

  constructor(private readonly deps: PluginControllerDependencies) {
    const saved = deps.settings.settings().developerMode;
    this.#developer = saved || deps.session.directories.length > 0;
    this.#commandLine = !saved && deps.session.directories.length > 0;
    deps.manager.onEvent((event) => {
      if (event.type === "notice") {
        this.#emit({ type: "notice", notice: deps.notices.add(event.notice) });
        return;
      }
      deps.marker.update({ thirdPartyRunning: deps.manager.active });
      for (const plugin of event.state.plugins)
        if (!plugin.running) this.#pendingReload.delete(plugin.sourceKey);
      this.#emit({ type: "state", state: this.#view(event.state) });
    });
  }

  state(): PluginsView {
    return this.#view(this.deps.manager.state());
  }

  notices(): StoredNotice[] {
    return this.deps.notices.list();
  }

  readLog(sourceKey: string, after: number): LogRead {
    return this.deps.logs.read(sourceKey, after);
  }

  /** The interpreter the launcher uses for the next Python plugin process. */
  python(): PythonCommand | undefined {
    return this.#currentPython()?.command;
  }

  get active(): boolean {
    return this.deps.manager.active;
  }

  frontendFor(language: string): string | undefined {
    return this.deps.manager.frontendFor(language);
  }

  onEvent(listener: (event: PluginsViewEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async execute(commandId: string): Promise<PluginCommandResult> {
    const owner = this.deps.manager
      .state()
      .plugins.find((plugin) =>
        plugin.commands.some((command) => command.id === commandId),
      )?.sourceKey;
    if (!owner) return this.deps.manager.executeCommand(commandId);
    const abort = new AbortController();
    const running = this.#inflight.get(owner) ?? new Set<AbortController>();
    this.#inflight.set(owner, running);
    running.add(abort);
    this.#changed();
    try {
      return await this.deps.manager.executeCommand(commandId, abort.signal);
    } finally {
      running.delete(abort);
      if (running.size === 0 && this.#inflight.get(owner) === running) this.#inflight.delete(owner);
      this.#changed();
    }
  }

  /** Cancels this source's in-flight commands through the protocol's cancellation. */
  cancel(sourceKey: string): void {
    for (const abort of this.#inflight.get(sourceKey) ?? []) abort.abort();
  }

  async setEnabled(sourceKey: string, enabled: boolean): Promise<PluginsResult> {
    const refused = this.#refuse({ developer: enabled });
    if (refused) return refused;
    return this.#result(await this.deps.manager.setEnabled(sourceKey, enabled));
  }

  async setDeveloperMode(enabled: boolean): Promise<PluginsResult> {
    const refused = this.#refuse({});
    if (refused) return refused;
    if (enabled === this.#developer) return this.#ok();
    if (enabled) {
      if (!(await this.deps.dialogs.confirmDeveloperMode()))
        return this.#ok({ outcome: "cancelled" });
      const closed = this.#refuse({});
      if (closed) return closed;
      try {
        await this.deps.settings.update((current) => ({ ...current, developerMode: true }));
      } catch (error) {
        return failure("PLUGIN_E_STATE_SAVE", messageOf(error));
      }
      this.#developer = true;
      this.#commandLine = false;
      for (const directory of this.#directories())
        await this.deps.manager.addSource({ kind: "development", directory });
      this.#changed();
      return this.#ok();
    }
    let persisted = true;
    try {
      await this.deps.settings.update((current) => ({ ...current, developerMode: false }));
    } catch {
      // Turning off still applies now, like disabling a plugin.
      persisted = false;
    }
    this.#developer = false;
    this.#commandLine = false;
    for (const plugin of this.deps.manager.state().plugins)
      if (plugin.source === "development")
        await this.deps.manager.removeSource(plugin.sourceKey, { forget: false });
    this.#pendingReload.clear();
    this.#changed();
    return this.#ok(persisted ? {} : { persisted: false });
  }

  async linkFolder(): Promise<PluginsResult> {
    const refused = this.#refuse({ developer: true, outsideSafeMode: true });
    if (refused) return refused;
    const picked = await this.deps.dialogs.chooseFolder();
    return picked === undefined ? this.#ok({ outcome: "cancelled" }) : this.#link(picked);
  }

  /** Points a linked source whose folder moved or broke at another folder. */
  async relinkFolder(sourceKey: string): Promise<PluginsResult> {
    const refused = this.#refuse({ developer: true, outsideSafeMode: true });
    if (refused) return refused;
    if (!this.#linked().has(sourceKey))
      return failure("PLUGIN_E_SESSION_SOURCE", "Only linked folders can be pointed elsewhere.");
    const picked = await this.deps.dialogs.chooseFolder();
    return picked === undefined
      ? this.#ok({ outcome: "cancelled" })
      : this.#link(picked, sourceKey);
  }

  async unlink(sourceKey: string): Promise<PluginsResult> {
    const refused = this.#refuse({ developer: true });
    if (refused) return refused;
    const directory = this.#linked().get(sourceKey);
    if (directory === undefined)
      return failure(
        "PLUGIN_E_SESSION_SOURCE",
        "Folders from --plugin-dev-dir cannot be unlinked; start Kobrixa without that option instead.",
      );
    const plugin = this.deps.manager.state().plugins.find((item) => item.sourceKey === sourceKey);
    const name = plugin?.displayName
      ? localized(plugin.displayName, this.deps.locale)
      : (plugin?.id ?? path.basename(directory));
    if (!(await this.deps.dialogs.confirmUnlink({ name, directory })))
      return this.#ok({ outcome: "cancelled" });
    const closed = this.#refuse({ developer: true });
    if (closed) return closed;
    const removed = await this.deps.manager.removeSource(sourceKey);
    if (!removed.ok && removed.code !== "PLUGIN_E_UNKNOWN_PLUGIN") return removed;
    let persisted = true;
    try {
      await this.deps.settings.update((current) => ({
        ...current,
        sources: current.sources.filter(
          (source) => developmentSourceKey(source.directory) !== sourceKey,
        ),
      }));
    } catch {
      persisted = false;
    }
    this.#clear(sourceKey);
    this.#changed();
    return this.#ok(persisted ? {} : { persisted: false });
  }

  async reload(sourceKey: string): Promise<PluginsResult> {
    const refused = this.#refuse({ developer: true, outsideSafeMode: true });
    if (refused) return refused;
    this.#pendingReload.delete(sourceKey);
    return this.#result(await this.deps.manager.reloadSource(sourceKey));
  }

  async pythonCandidates(): Promise<PythonChoice[]> {
    const commands = pythonCommands(this.deps.platform, this.deps.settings.settings().python);
    const probes = await Promise.all(commands.map(({ command }) => this.deps.probe(command)));
    const current = this.#currentPython()?.command;
    this.#candidates = new Map(commands.map(({ id, command }) => [id, command]));
    return commands.map(({ id, command }, index) => ({
      id,
      label: commandLabel(command),
      selected: current !== undefined && sameCommand(current, command),
      probe: probes[index]!,
    }));
  }

  async setPython(id: PythonChoiceId): Promise<PluginsResult> {
    const refused = this.#refuse({ developer: true });
    if (refused) return refused;
    let command: PythonCommand | undefined;
    if (id === "other") {
      const picked = await this.deps.dialogs.choosePython();
      if (picked === undefined) return this.#ok({ outcome: "cancelled" });
      command = { executable: picked, args: [] };
    } else command = this.#candidates.get(id);
    if (!command)
      return failure("PLUGIN_E_PYTHON_UNUSABLE", "Refresh the interpreter list and choose again.");
    // Probe again: the list may be stale and "other" was never probed.
    const probe = await this.deps.probe(command);
    if (probe.status === "error")
      return failure(
        "PLUGIN_E_PYTHON_UNUSABLE",
        `${commandLabel(command)}: ${probe.detail ?? probe.problem ?? "unusable"}`,
      );
    const closed = this.#refuse({ developer: true });
    if (closed) return closed;
    const chosen = command;
    try {
      await this.deps.settings.update((current) => ({ ...current, python: chosen }));
    } catch (error) {
      return failure("PLUGIN_E_STATE_SAVE", messageOf(error));
    }
    if (!this.deps.session.python)
      for (const plugin of this.deps.manager.state().plugins)
        if (plugin.runtime === "python" && plugin.running)
          this.#pendingReload.add(plugin.sourceKey);
    this.#changed();
    return this.#ok();
  }

  /** "Restore plugins": removes the lock and, unless --safe-mode was given, leaves safe mode. */
  async clearSafeModeLock(): Promise<PluginsResult> {
    const refused = this.#refuse({});
    if (refused) return refused;
    if (this.deps.settings.settings().safeModeLock) {
      try {
        await this.deps.settings.update((current) => {
          const next = { ...current };
          delete next.safeModeLock;
          return next;
        });
      } catch (error) {
        return failure("PLUGIN_E_STATE_SAVE", messageOf(error));
      }
    }
    if (!this.deps.session.safeMode) {
      const left = await this.deps.manager.leaveSafeMode();
      if (!left.ok) return left;
    }
    this.#changed();
    return this.#ok();
  }

  shutdown(deadlineMs?: number): Promise<void> {
    this.#closing = true;
    return this.deps.manager.shutdown(deadlineMs);
  }

  async resume(): Promise<void> {
    await this.deps.manager.resume();
    this.#closing = false;
    this.#changed();
  }

  markRendererUnresponsive(): void {
    this.deps.marker.update({ rendererUnresponsive: true });
  }

  /** Call from Electron's quit event, after plugins were shut down. */
  finishSession(): void {
    this.deps.marker.finish();
  }

  async #link(picked: string, replacing?: string): Promise<PluginsResult> {
    let directory: string;
    try {
      directory = await this.deps.realpath(picked);
    } catch (error) {
      return failure("PLUGIN_E_MANIFEST", `${picked} cannot be opened: ${messageOf(error)}`);
    }
    const sourceKey = developmentSourceKey(directory);
    if (sourceKey !== replacing && this.#linked().has(sourceKey))
      return this.#ok({ outcome: "duplicate", sourceKey });
    const read = await readSource({ kind: "development", directory }, { safeMode: false });
    const confirmed = await this.deps.dialogs.confirmLink({
      name: read.manifest?.displayName
        ? localized(read.manifest.displayName, this.deps.locale)
        : read.id,
      id: read.id,
      ...(read.manifest ? { runtime: read.manifest.runtime.kind } : {}),
      directory,
      problems: read.problems.map((problem) => problem.message),
    });
    if (!confirmed) return this.#ok({ outcome: "cancelled" });
    // The dialog may have stayed open while Kobrixa started quitting or changed mode.
    const refused = this.#refuse({ developer: true, outsideSafeMode: true });
    if (refused) return refused;
    try {
      await this.deps.settings.update((current) => ({
        ...current,
        sources:
          replacing === undefined
            ? [...current.sources, { directory }]
            : current.sources.map((source) =>
                developmentSourceKey(source.directory) === replacing ? { directory } : source,
              ),
      }));
    } catch (error) {
      return failure("PLUGIN_E_STATE_SAVE", messageOf(error));
    }
    if (replacing !== undefined && replacing !== sourceKey) {
      await this.deps.manager.removeSource(replacing);
      this.#clear(replacing);
    }
    const result =
      replacing === sourceKey
        ? await this.deps.manager.reloadSource(sourceKey)
        : await this.deps.manager.addSource({ kind: "development", directory });
    this.#changed();
    // A --plugin-dev-dir folder is already loaded; linking it only makes it permanent.
    if (!result.ok && result.code !== "PLUGIN_E_SOURCE_EXISTS") return result;
    return this.#ok({ sourceKey });
  }

  #refuse(needs: { developer?: boolean; outsideSafeMode?: boolean }): Failure | undefined {
    if (this.#closing)
      return failure("PLUGIN_E_SHUTTING_DOWN", "Kobrixa is shutting down plugins.");
    if (needs.developer && !this.#developer)
      return failure(
        "PLUGIN_E_DEVELOPER_MODE",
        "Turn on developer mode under Settings → Plugins first.",
      );
    if (needs.outsideSafeMode && this.deps.manager.state().safeMode)
      return failure(
        "PLUGIN_E_SAFE_MODE",
        "Plugins are paused in safe mode. Restore plugins first.",
      );
    return undefined;
  }

  #linked(): Map<string, string> {
    return new Map(
      this.deps.settings
        .settings()
        .sources.map((source) => [developmentSourceKey(source.directory), source.directory]),
    );
  }

  /** Saved links first, then command-line folders that are not also saved. */
  #directories(): string[] {
    return uniqueDirectories([
      ...this.deps.settings.settings().sources.map((source) => source.directory),
      ...this.deps.session.directories,
    ]);
  }

  #currentPython(): { command: PythonCommand; origin: "settings" | "command-line" } | undefined {
    if (this.deps.session.python)
      return { command: this.deps.session.python, origin: "command-line" };
    const saved = this.deps.settings.settings().python;
    return saved ? { command: saved, origin: "settings" } : undefined;
  }

  #clear(sourceKey: string): void {
    this.deps.logs.clear(sourceKey);
    this.deps.notices.clear(sourceKey);
    this.#pendingReload.delete(sourceKey);
  }

  #result(result: PluginActionResult): PluginsResult {
    if (!result.ok) return result;
    return this.#ok(result.persisted === false ? { persisted: false } : {});
  }

  #ok(extra: Extra = {}): PluginsResult {
    return { ok: true, state: this.state(), ...extra };
  }

  #view(snapshot: PluginsSnapshot): PluginsView {
    const settings = this.deps.settings.settings();
    const linked = this.#linked();
    const current = this.#currentPython();
    return {
      ...snapshot,
      // Both parts only increase, so the sum does too.
      revision: snapshot.revision + this.#revision,
      developer: {
        enabled: this.#developer,
        commandLine: this.#commandLine,
        linkedCount: settings.sources.length,
      },
      ...(settings.safeModeLock ? { safeModeLock: settings.safeModeLock } : {}),
      origins: Object.fromEntries(
        snapshot.plugins.map((plugin): [string, PluginOrigin] => [
          plugin.sourceKey,
          plugin.source === "builtin"
            ? "builtin"
            : linked.has(plugin.sourceKey)
              ? "linked"
              : "session",
        ]),
      ),
      python: {
        ...(current
          ? { current: { label: commandLabel(current.command), origin: current.origin } }
          : {}),
        pendingReload: [...this.#pendingReload],
      },
      inflight: [...this.#inflight.keys()],
    };
  }

  #changed(): void {
    this.#revision += 1;
    this.#emit({ type: "state", state: this.state() });
  }

  #emit(event: PluginsViewEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A listener must not interrupt plugin changes or other listeners.
      }
    }
  }
}

export interface StartPluginsOptions {
  userData: string;
  builtins: readonly PluginSource[];
  commandLine: PluginOptions;
  dialogs: PluginDialogs;
  locale: PluginLocale;
  /** Defaults to the Electron launcher. Receives the live Python choice and the log hook. */
  launcher?: (hooks: {
    python: () => PythonCommand | undefined;
    onOutput: (plugin: LaunchablePlugin, line: string) => void;
  }) => PluginLauncher;
  probe?(command: PythonCommand): Promise<PythonProbe>;
  realpath?(directory: string): Promise<string>;
  platform?: NodeJS.Platform;
  now?(): Date;
  supervisor?: PluginManagerOptions["supervisor"];
}

/**
 * Loads settings, checks how the previous session ended, then creates the manager with the
 * sources developer mode allows. A crash while third-party plugins ran, or a hung renderer,
 * locks safe mode until the user restores plugins.
 */
export async function startPlugins(options: StartPluginsOptions): Promise<PluginController> {
  const now = options.now ?? (() => new Date());
  const settings = filePluginStateStore(options.userData, { now });
  let loaded: PluginPersistedState & { problem?: string };
  try {
    loaded = await settings.load();
  } catch (error) {
    loaded = { disabled: new Set(), legacyDisabledIds: new Set(), problem: messageOf(error) };
  }
  const marker = new SessionMarkerFile(options.userData, now);
  const unclean = marker.begin();
  if (unclean && !settings.settings().safeModeLock)
    await settings
      .update((current) => ({
        ...current,
        safeModeLock: { since: now().toISOString(), reason: unclean },
      }))
      .catch(() => undefined);
  const safeMode =
    options.commandLine.safeMode ||
    unclean !== undefined ||
    settings.settings().safeModeLock !== undefined;
  const resolve = options.realpath ?? ((directory: string) => realpath(directory));
  const sessionDirectories = await Promise.all(
    options.commandLine.developmentDirectories.map((directory) =>
      resolve(directory).catch(() => path.resolve(directory)),
    ),
  );
  const document = settings.settings();
  const developer = document.developerMode || sessionDirectories.length > 0;
  const directories = developer
    ? uniqueDirectories([
        ...document.sources.map((source) => source.directory),
        ...sessionDirectories,
      ])
    : [];
  const logs = new PluginLogs();
  let controller: PluginController | undefined;
  const hooks = {
    python: () => controller?.python(),
    onOutput: (plugin: LaunchablePlugin, line: string) => {
      logs.append(plugin.sourceKey ?? `builtin:${plugin.id}`, line);
      console.error(`[plugin ${plugin.id}] ${line}`);
    },
  };
  const manager = await PluginManager.create({
    sources: [
      ...options.builtins,
      ...directories.map((directory) => ({ kind: "development" as const, directory })),
    ],
    // Already loaded above, so the manager sees the same result, including a corrupt file.
    store: { load: async () => loaded, save: (state) => settings.save(state) },
    safeMode,
    launcher: (options.launcher ?? createDesktopLauncher)(hooks),
    locale: options.locale,
    ...(options.supervisor ? { supervisor: options.supervisor } : {}),
  });
  const commandLinePython = options.commandLine.python;
  controller = new PluginController({
    manager,
    settings,
    dialogs: options.dialogs,
    logs,
    notices: new PluginNotices(),
    marker,
    probe: options.probe ?? ((command) => probePython(command)),
    realpath: resolve,
    locale: options.locale,
    platform: options.platform ?? process.platform,
    session: {
      directories: sessionDirectories,
      ...(commandLinePython === undefined
        ? {}
        : { python: { executable: commandLinePython, args: [] } }),
      safeMode: options.commandLine.safeMode,
    },
  });
  return controller;
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins && pnpm --filter @kobrixa/desktop check`
Expected: PASS（Windows 上 symlink 那一項為 skipped），型別檢查無錯誤。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/plugins.ts apps/desktop/src/main/plugins/controller.ts apps/desktop/src/main/plugins/controller.test.ts
git commit -m "feat(desktop): add a plugin controller for developer mode, links, Python and recovery"
```

---

### Task 8: IPC、preload、PluginsApi，並在主程序接上 PluginController

**Files:**

- Modify: `apps/desktop/src/shared/plugins.ts`
- Modify: `apps/desktop/src/main/plugins/ipc.ts`（整檔替換）
- Modify: `apps/desktop/src/main/plugins/ipc.test.ts`（整檔替換）
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/renderer/settings/plugins-panel.test.ts`（只補 mock，讓型別過關）
- Modify: `apps/desktop/src/main/index.ts`

**Interfaces:**

- Consumes：Task 5 的 `quitOnSignals`、`watchRendererHealth`；Task 6 的 `electronPluginDialogs`；Task 7 的 `startPlugins`、`PluginController`（`active`、`shutdown`、`resume`、`frontendFor`、`finishSession`、`markRendererUnresponsive`）、`PluginsViewEvent`。
- Produces:
  - `PluginEvent = PluginsViewEvent`
  - `PluginsApi`：`state()`、`notices()`、`execute(commandId)`、`cancel(sourceKey)`、`setEnabled(sourceKey, enabled)`、`setDeveloperMode(enabled)`、`linkFolder()`、`relinkFolder(sourceKey)`、`unlink(sourceKey)`、`reload(sourceKey)`、`pythonCandidates()`、`setPython(id: PythonChoiceId)`、`readLog(sourceKey, after)`、`clearSafeModeLock()`、`onEvent(listener)`
  - `registerPluginIpc(handle, plugins: PluginIpcTarget, publish): () => void`
  - 桌面版正式啟動流程改用控制器；`index.ts` 裡的 `plugins` 型別變成 `PluginController`

**Ruling（相對 spec §4.7）：** 另加唯讀的 `plugins:notices`。spec 要求通知由主程序保存、面板關閉期間也繼續收集；面板重新打開時需要一次讀回已保存的通知，而 state 事件每次都帶上全部通知太重。代價：多一個不帶參數的唯讀 channel，沒有新的授權面。

- [ ] **Step 1: 寫失敗的測試**

`apps/desktop/src/main/plugins/ipc.test.ts` 整檔替換為：

```ts
import { expect, it, vi } from "vitest";
import type { IpcHandle } from "../ipc.js";
import { registerPluginIpc, type PluginIpcTarget } from "./ipc.js";

const key = "dev:0123456789abcdef";
function setup() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const handle = ((channel, action) => handlers.set(channel, action as never)) as IpcHandle;
  const ok = async () => ({ ok: true }) as never;
  const plugins = {
    state: vi.fn(),
    notices: vi.fn(() => []),
    execute: vi.fn(async () => ({ ok: true as const })),
    cancel: vi.fn(),
    setEnabled: vi.fn(ok),
    setDeveloperMode: vi.fn(ok),
    linkFolder: vi.fn(ok),
    relinkFolder: vi.fn(ok),
    unlink: vi.fn(ok),
    reload: vi.fn(ok),
    pythonCandidates: vi.fn(async () => []),
    setPython: vi.fn(ok),
    readLog: vi.fn(() => ({ lines: [], next: 0, truncated: false })),
    clearSafeModeLock: vi.fn(ok),
    onEvent: vi.fn(() => () => {}),
  } satisfies PluginIpcTarget;
  const publish = vi.fn();
  registerPluginIpc(handle, plugins, publish);
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
  return { handlers, plugins, publish, call };
}

it("registers every plugin channel and forwards events", () => {
  const { handlers, plugins, publish } = setup();
  expect([...handlers.keys()].sort()).toEqual(
    [
      "plugins:state",
      "plugins:notices",
      "plugins:execute",
      "plugins:cancel",
      "plugins:set-enabled",
      "plugins:setDeveloperMode",
      "plugins:linkFolder",
      "plugins:relinkFolder",
      "plugins:unlink",
      "plugins:reload",
      "plugins:pythonCandidates",
      "plugins:setPython",
      "plugins:readLog",
      "plugins:clearSafeModeLock",
    ].sort(),
  );
  expect(plugins.onEvent).toHaveBeenCalledWith(publish);
});

it("validates every renderer argument before it reaches the controller", async () => {
  const { plugins, call } = setup();
  expect(await call("plugins:execute", "acme.hello.greet")).toEqual({ ok: true });
  expect(() => call("plugins:execute", "../../etc")).toThrow();
  for (const channel of [
    "plugins:cancel",
    "plugins:relinkFolder",
    "plugins:unlink",
    "plugins:reload",
  ]) {
    expect(() => call(channel, "/Users/me/plugin")).toThrow();
    expect(() => call(channel, "dev:../../etc")).toThrow();
    await call(channel, key);
  }
  expect(plugins.reload).toHaveBeenCalledWith(key);
  expect(() => call("plugins:set-enabled", key, "yes")).toThrow();
  expect(() => call("plugins:setDeveloperMode", "true")).toThrow();
  await call("plugins:setDeveloperMode", true);
  expect(plugins.setDeveloperMode).toHaveBeenCalledWith(true);
  expect(() => call("plugins:setPython", "/usr/bin/python3")).toThrow();
  await call("plugins:setPython", "other");
  expect(plugins.setPython).toHaveBeenCalledWith("other");
  expect(() => call("plugins:readLog", key, -1)).toThrow();
  expect(() => call("plugins:readLog", key, 1.5)).toThrow();
  await call("plugins:readLog", key, 3);
  expect(plugins.readLog).toHaveBeenCalledWith(key, 3);
  // Channels without arguments ignore anything the renderer adds.
  await call("plugins:linkFolder", "/etc");
  expect(plugins.linkFolder).toHaveBeenCalledWith();
});
```

在 `apps/desktop/src/renderer/settings/plugins-panel.test.ts` 的 `api` 物件裡、`onEvent` 之前加入下面的 mock（Task 9 會用到；本 task 只為了 `satisfies PluginsApi` 通過型別檢查）：

```ts
  notices: vi.fn<PluginsApi["notices"]>(async () => []),
  cancel: vi.fn<PluginsApi["cancel"]>(async () => {}),
  setDeveloperMode: vi.fn<PluginsApi["setDeveloperMode"]>(),
  linkFolder: vi.fn<PluginsApi["linkFolder"]>(),
  relinkFolder: vi.fn<PluginsApi["relinkFolder"]>(),
  unlink: vi.fn<PluginsApi["unlink"]>(),
  reload: vi.fn<PluginsApi["reload"]>(),
  pythonCandidates: vi.fn<PluginsApi["pythonCandidates"]>(async () => []),
  setPython: vi.fn<PluginsApi["setPython"]>(),
  readLog: vi.fn<PluginsApi["readLog"]>(async () => ({ lines: [], next: 0, truncated: false })),
  clearSafeModeLock: vi.fn<PluginsApi["clearSafeModeLock"]>(),
```

並把 `const snapshot: PluginsSnapshot = {` 改成 `const snapshot: PluginsView = {`，在 `developmentMode: true,` 之後加：

```ts
  developer: { enabled: true, commandLine: false, linkedCount: 1 },
  origins: { "builtin:kobrixa.basic-plus": "builtin", "dev:0123456789abcdef": "linked" },
  python: { pendingReload: [] },
  inflight: [],
```

import 改成 `import type { PluginEvent, PluginsApi, PluginsView } from "../../shared/plugins.js";`。`explains how to load development plugins and safe mode` 測試裡的 `api.state.mockResolvedValueOnce({ revision: 1, … })` 改成 `api.state.mockResolvedValueOnce({ ...snapshot, safeMode: true, developmentMode: false, plugins: [snapshot.plugins[0]!] })`（這個測試的斷言在本 task 仍然成立，Task 9 才改寫）。兩個通知測試的 `notice` 物件各加 `id`（`shows notices…` 用 `id: 1`；`keeps only the latest 20…` 用 `id: at + 1`）。

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter @kobrixa/desktop exec vitest run src/main/plugins/ipc.test.ts`
Expected: FAIL，`PluginIpcTarget` 不存在、新 channel 沒有註冊。

- [ ] **Step 3: 實作**

`apps/desktop/src/shared/plugins.ts`：

1. 第一個 import 移除 `PluginManagerEvent`（之後不再使用）。
2. `export type PluginEvent = PluginManagerEvent;` 改成 `export type PluginEvent = PluginsViewEvent;`，並移到 `PluginsViewEvent` 宣告之後。
3. `PluginsApi` 整個換成：

```ts
export interface PluginsApi {
  state(): Promise<PluginsView>;
  notices(): Promise<StoredNotice[]>;
  execute(commandId: string): Promise<PluginCommandResult>;
  cancel(sourceKey: string): Promise<void>;
  setEnabled(sourceKey: string, enabled: boolean): Promise<PluginsResult>;
  setDeveloperMode(enabled: boolean): Promise<PluginsResult>;
  linkFolder(): Promise<PluginsResult>;
  relinkFolder(sourceKey: string): Promise<PluginsResult>;
  unlink(sourceKey: string): Promise<PluginsResult>;
  reload(sourceKey: string): Promise<PluginsResult>;
  pythonCandidates(): Promise<PythonChoice[]>;
  setPython(id: PythonChoiceId): Promise<PluginsResult>;
  readLog(sourceKey: string, after: number): Promise<LogRead>;
  clearSafeModeLock(): Promise<PluginsResult>;
  onEvent(listener: (event: PluginEvent) => void): () => void;
}
```

`apps/desktop/src/main/plugins/ipc.ts` 整檔替換為：

```ts
import { z } from "zod";
import { namespacedIdSchema } from "@kobrixa/plugin-protocol";
import { sourceKeySchema } from "@kobrixa/plugin-runtime";
import type { PluginEvent } from "../../shared/plugins.js";
import type { IpcHandle } from "../ipc.js";
import type { PluginController } from "./controller.js";

export type PluginIpcTarget = Pick<
  PluginController,
  | "state"
  | "notices"
  | "execute"
  | "cancel"
  | "setEnabled"
  | "setDeveloperMode"
  | "linkFolder"
  | "relinkFolder"
  | "unlink"
  | "reload"
  | "pythonCandidates"
  | "setPython"
  | "readLog"
  | "clearSafeModeLock"
  | "onEvent"
>;
const pythonChoiceSchema = z.enum(["python3", "python", "py", "saved", "other"]);
const cursorSchema = z.number().int().nonnegative();

/**
 * Every channel goes through the trusted-sender wrapper. The renderer sends only source keys,
 * command ids, booleans, interpreter ids and log cursors, never a path or an executable; the
 * controller checks developer mode, safe mode and shutdown itself.
 */
export function registerPluginIpc(
  handle: IpcHandle,
  plugins: PluginIpcTarget,
  publish: (event: PluginEvent) => void,
): () => void {
  const key = (value: unknown) => sourceKeySchema.parse(value);
  handle("plugins:state", () => plugins.state());
  handle("plugins:notices", () => plugins.notices());
  handle("plugins:execute", (_event, commandId: unknown) =>
    plugins.execute(namespacedIdSchema.parse(commandId)),
  );
  handle("plugins:cancel", (_event, sourceKey: unknown) => plugins.cancel(key(sourceKey)));
  handle("plugins:set-enabled", (_event, sourceKey: unknown, enabled: unknown) =>
    plugins.setEnabled(key(sourceKey), z.boolean().parse(enabled)),
  );
  handle("plugins:setDeveloperMode", (_event, enabled: unknown) =>
    plugins.setDeveloperMode(z.boolean().parse(enabled)),
  );
  handle("plugins:linkFolder", () => plugins.linkFolder());
  handle("plugins:relinkFolder", (_event, sourceKey: unknown) =>
    plugins.relinkFolder(key(sourceKey)),
  );
  handle("plugins:unlink", (_event, sourceKey: unknown) => plugins.unlink(key(sourceKey)));
  handle("plugins:reload", (_event, sourceKey: unknown) => plugins.reload(key(sourceKey)));
  handle("plugins:pythonCandidates", () => plugins.pythonCandidates());
  handle("plugins:setPython", (_event, id: unknown) =>
    plugins.setPython(pythonChoiceSchema.parse(id)),
  );
  handle("plugins:readLog", (_event, sourceKey: unknown, after: unknown) =>
    plugins.readLog(key(sourceKey), cursorSchema.parse(after)),
  );
  handle("plugins:clearSafeModeLock", () => plugins.clearSafeModeLock());
  return plugins.onEvent(publish);
}
```

`apps/desktop/src/preload/index.ts` 的 `plugins: { … }` 整段換成：

```ts
  plugins: {
    state: () => ipcRenderer.invoke("plugins:state"),
    notices: () => ipcRenderer.invoke("plugins:notices"),
    execute: (commandId) => ipcRenderer.invoke("plugins:execute", commandId),
    cancel: (sourceKey) => ipcRenderer.invoke("plugins:cancel", sourceKey),
    setEnabled: (sourceKey, enabled) =>
      ipcRenderer.invoke("plugins:set-enabled", sourceKey, enabled),
    setDeveloperMode: (enabled) => ipcRenderer.invoke("plugins:setDeveloperMode", enabled),
    linkFolder: () => ipcRenderer.invoke("plugins:linkFolder"),
    relinkFolder: (sourceKey) => ipcRenderer.invoke("plugins:relinkFolder", sourceKey),
    unlink: (sourceKey) => ipcRenderer.invoke("plugins:unlink", sourceKey),
    reload: (sourceKey) => ipcRenderer.invoke("plugins:reload", sourceKey),
    pythonCandidates: () => ipcRenderer.invoke("plugins:pythonCandidates"),
    setPython: (id) => ipcRenderer.invoke("plugins:setPython", id),
    readLog: (sourceKey, after) => ipcRenderer.invoke("plugins:readLog", sourceKey, after),
    clearSafeModeLock: () => ipcRenderer.invoke("plugins:clearSafeModeLock"),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, value: PluginEvent) => listener(value);
      ipcRenderer.on("plugins:event", handler);
      return () => ipcRenderer.removeListener("plugins:event", handler);
    },
  },
```

`apps/desktop/src/main/index.ts`（主程序接線）：

1. import：刪除 `import { PluginManager } from "@kobrixa/plugin-runtime";`、`import { createDesktopLauncher } from "./plugins/launchers.js";`、`import { filePluginStateStore } from "./plugins/state-store.js";`，加入：

```ts
import { startPlugins } from "./plugins/controller.js";
import { electronPluginDialogs } from "./plugins/dialogs.js";
import { quitOnSignals, watchRendererHealth } from "./plugins/session.js";
```

2. 建立 manager 的區塊：把從 `const pluginSettings = pluginOptions(app.commandLine);` 到 `installPluginQuitCleanup(app, plugins);`（含）整段換成：

```ts
const pluginSettings = pluginOptions(app.commandLine);
const pluginLanguage = pluginLocale(app.getLocale());
const plugins = await startPlugins({
  userData: app.getPath("userData"),
  builtins: BUILTIN_PLUGIN_SOURCES,
  commandLine: pluginSettings,
  dialogs: electronPluginDialogs(() => mainWindow, pluginLanguage),
  locale: pluginLanguage,
});
installPluginQuitCleanup(app, plugins);
// Electron emits quit after will-quit, so plugin processes have already been stopped.
app.on("quit", () => plugins.finishSession());
quitOnSignals(process, () => app.quit());
```

3. 監看畫面是否卡住：`openWindow` 改成：

```ts
const openWindow = () => {
  createWindow(flushDeviceWork);
  if (mainWindow) watchRendererHealth(mainWindow, () => plugins.markRendererUnresponsive());
  mainWindow?.on("blur", () => {
    void motors.stopAll();
  });
  mainWindow?.on("hide", () => {
    void motors.stopAll();
  });
  mainWindow?.on("minimize", () => {
    void motors.stopAll();
  });
};
```

其他用到 `plugins` 的地方（`frontendFor`、`registerPluginIpc`、`beforeUpdateInstall` 的 `shutdown`／`resume`、`updates.onInstallationFailed`）不用改：控制器提供同名方法。

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm --filter @kobrixa/plugin-runtime build && pnpm --filter @kobrixa/desktop check && pnpm --filter @kobrixa/desktop exec vitest run`
Expected: 型別檢查無錯誤；桌面端測試全部 PASS（面板外觀尚未改變）。

Run: `pnpm test:plugins:smoke`
Expected: `PASS plugins: utilityProcess TS, Python stdio, crash isolation, quit cleanup`。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/plugins.ts apps/desktop/src/main/plugins/ipc.ts apps/desktop/src/main/plugins/ipc.test.ts apps/desktop/src/preload/index.ts apps/desktop/src/renderer/settings/plugins-panel.test.ts apps/desktop/src/main/index.ts
git commit -m "feat(desktop): manage plugins through the controller over validated IPC"
```

---

### Task 9: 設定頁插件面板、日誌檢視與復原橫幅

**Files:**

- Modify: `apps/desktop/src/renderer/settings/plugin-copy.ts`
- Create: `apps/desktop/src/renderer/settings/plugin-log.tsx`
- Create: `apps/desktop/src/renderer/settings/plugin-recovery.tsx`
- Modify: `apps/desktop/src/renderer/settings/plugins-panel.tsx`（整檔替換）
- Modify: `apps/desktop/src/renderer/settings/plugins-panel.test.ts`
- Modify: `apps/desktop/src/renderer/settings/settings-panel.tsx:212`
- Modify: `apps/desktop/src/renderer/app.tsx`（`settingsCategory` 型別、橫幅）
- Modify: `apps/desktop/src/renderer/styles/workbench.css`
- Modify: `tests/desktop/preload.cjs`（桌面 smoke 的 `window.kobrixa` 要有 `plugins`，否則橫幅一掛上就會出錯）

**Interfaces:**

- Consumes：Task 8 的 `PluginsApi`、`PluginEvent`；Task 3 的 `PluginsView`、`PythonChoice`、`StoredNotice`、`LogRead`。
- Produces:
  - `readableError(reason: unknown): string | undefined`、`pythonChoiceText(choice: PythonChoice, locale: Locale): string`（`plugin-copy.ts`）
  - `PluginLog({ sourceKey, labels })`、`LOG_POLL_MS = 1_000`（`plugin-log.tsx`）
  - `PluginRecoveryNotice({ locale, onOpenSettings })`（`plugin-recovery.tsx`）
  - `pluginRowId(sourceKey: string): string`（`plugins-panel.tsx`；每列 `<li>` 的 id）
- 忙碌規則：`run:<sourceKey>`（本面板送出的命令）或 `view.inflight` 含該列時，該列的命令按鈕停用並顯示「取消」；`row:<sourceKey>`（停用、重新載入、重新指定、解除連結進行中）時，該列所有按鈕停用。全域動作各自用 `developer`、`link`、`python`、`lock` 鍵。

- [ ] **Step 1: 寫失敗的測試**

修改 `apps/desktop/src/renderer/settings/plugins-panel.test.ts`：

1. shared 型別的 import 改成 `import type { PluginEvent, PluginsApi, PluginsView, PythonChoice } from "../../shared/plugins.js";`；import 加上 `import { PluginRecoveryNotice } from "./plugin-recovery.js";`、`import { LOG_POLL_MS } from "./plugin-log.js";`，並把 `import { pluginCopy, problemText } from "./plugin-copy.js";` 改成 `import { pluginCopy, problemText, readableError } from "./plugin-copy.js";`；`vitest` 的 import 加上 `describe`。
2. `const originalScrollTo = …` 下一行加 `const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");`；`afterEach` 裡還原 `scrollTo` 的兩行之後加：

```ts
if (originalScrollIntoView)
  Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
else delete (Element.prototype as Partial<Element>).scrollIntoView;
```

3. 在 `const button = …` 之後加：

```ts
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
```

4. 既有測試的修改：
   - `handles a rejected %s request…`：把 `expect(button("停用").disabled).toBe(true);`（click 之後、reject 之前那一行）改成 `expect(button("停用").disabled).toBe(method === "setEnabled");`。命令執行中只停用命令按鈕。
   - `explains how to load development plugins and safe mode` 整個換成：

```ts
it("explains developer mode and command-line safe mode", async () => {
  api.state.mockResolvedValueOnce({
    ...snapshot,
    safeMode: true,
    developmentMode: false,
    plugins: [snapshot.plugins[0]!],
    developer: { enabled: false, commandLine: false, linkedCount: 0 },
  });
  await render();
  expect(container.textContent).toContain(pluginCopy["zh-TW"].howTo);
  expect(container.textContent).toContain("--safe-mode");
  expect(container.textContent).not.toContain("--plugin-dev-dir");
});
```

- 刪除 `blocks concurrent commands and toggles until the command finishes`（由下面的每列忙碌測試取代）。
- `keeps only the latest 20 notices…` 的兩個期望值改成 `"資訊 acme.hello <img src=x> notice-20"` 與 `"資訊 acme.hello <img src=x> notice-1"`。
- `localizes text with English fallback…` 最後加：

```ts
expect(readableError(new Error("boom"))).toBe("boom");
expect(readableError({ message: "from main" })).toBe("from main");
expect(readableError({ reason: "opaque" })).toBeUndefined();
expect(readableError("text")).toBe("text");
```

5. 檔案最後加：

```ts
it("keeps row actions usable while that row's command runs, and cancels it", async () => {
  let finish!: (result: Awaited<ReturnType<PluginsApi["execute"]>>) => void;
  api.execute.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await act(async () => button("打招呼").click());
  expect(button("打招呼").disabled).toBe(true);
  expect(button("停用").disabled).toBe(false);
  expect(button("重新載入").disabled).toBe(false);
  expect(button("解除連結").disabled).toBe(false);
  await act(async () => button("取消").click());
  expect(api.cancel).toHaveBeenCalledWith("dev:0123456789abcdef");
  await act(async () => finish({ ok: false, code: "PLUGIN_E_CANCELLED", message: "cancelled" }));
  expect(button("取消")).toBeUndefined();
  expect(button("打招呼").disabled).toBe(false);
  expect(container.querySelector("[role=alert]")?.textContent).toBe("命令已取消：cancelled");
});

it("shows a cancel button for a command main reports as running", async () => {
  api.state.mockResolvedValueOnce({ ...snapshot, inflight: ["dev:0123456789abcdef"] });
  await render();
  expect(button("打招呼").disabled).toBe(true);
  expect(button("取消")).toBeDefined();
});

it("never shows [object Object] and clears a stale request failure on newer state", async () => {
  api.reload.mockRejectedValueOnce({ reason: "opaque" });
  await render();
  await act(async () => button("重新載入").click());
  expect(container.querySelector("[role=alert]")?.textContent).toBe("插件要求失敗：未知錯誤");
  await act(async () => emit({ type: "state", state: { ...snapshot, revision: 2 } }));
  expect(container.querySelector("[role=alert]")).toBeNull();
});

it("turns developer mode on through main and then offers linking", async () => {
  api.state.mockResolvedValueOnce({
    ...snapshot,
    developmentMode: false,
    plugins: [snapshot.plugins[0]!],
    developer: { enabled: false, commandLine: false, linkedCount: 2 },
  });
  api.setDeveloperMode.mockResolvedValueOnce({ ok: true, state: { ...snapshot, revision: 2 } });
  await render();
  expect(container.textContent).toContain("已保留 2 個連結的資料夾");
  expect(button("連結資料夾…")).toBeUndefined();
  const toggle = () => container.querySelector<HTMLInputElement>("input[type=checkbox]")!;
  expect(toggle().checked).toBe(false);
  await act(async () => toggle().click());
  expect(api.setDeveloperMode).toHaveBeenCalledWith(true);
  expect(toggle().checked).toBe(true);
  expect(button("連結資料夾…")).toBeDefined();
});

it("links a folder and scrolls to one that is already linked", async () => {
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  api.linkFolder.mockResolvedValueOnce({
    ok: true,
    state: snapshot,
    outcome: "duplicate",
    sourceKey: "dev:0123456789abcdef",
  });
  await render();
  await act(async () => button("連結資料夾…").click());
  expect(api.linkFolder).toHaveBeenCalledOnce();
  expect(container.querySelector("[role=alert]")?.textContent).toBe(
    pluginCopy["zh-TW"].alreadyLinked,
  );
  expect(
    container.querySelector("#plugin-dev-0123456789abcdef")?.hasAttribute("data-highlighted"),
  ).toBe(true);
  expect(scrollIntoView).toHaveBeenCalled();
});

it("labels session sources, offers relinking a broken folder and unlinks only linked ones", async () => {
  api.state.mockResolvedValueOnce({
    ...snapshot,
    plugins: [
      {
        ...snapshot.plugins[1]!,
        status: "invalid",
        commands: [],
        problems: [{ code: "PLUGIN_E_MANIFEST", message: "missing" }],
      },
      { ...snapshot.plugins[1]!, sourceKey: "dev:fedcba9876543210", id: "acme.cli", commands: [] },
    ],
    origins: { "dev:0123456789abcdef": "linked", "dev:fedcba9876543210": "session" },
  });
  api.relinkFolder.mockResolvedValueOnce({
    ok: true,
    state: snapshot,
    sourceKey: "dev:0123456789abcdef",
  });
  await render();
  const [linked, session] = [...container.querySelectorAll(".plugins-list > li")];
  expect(linked!.textContent).toContain("重新指定資料夾…");
  expect(session!.textContent).toContain("本次啟動參數");
  expect(session!.textContent).not.toContain("解除連結");
  await act(async () => button("重新指定資料夾…").click());
  expect(api.relinkFolder).toHaveBeenCalledWith("dev:0123456789abcdef");
});

it("reloads and unlinks a row through main", async () => {
  api.reload.mockResolvedValueOnce({ ok: true, state: { ...snapshot, revision: 2 } });
  api.unlink.mockResolvedValueOnce({
    ok: true,
    state: { ...snapshot, revision: 3, plugins: [snapshot.plugins[0]!] },
  });
  await render();
  await act(async () => button("重新載入").click());
  expect(api.reload).toHaveBeenCalledWith("dev:0123456789abcdef");
  await act(async () => button("解除連結").click());
  expect(api.unlink).toHaveBeenCalledWith("dev:0123456789abcdef");
  expect(container.textContent).not.toContain("acme.hello");
});

it("lists Python candidates with their status and saves a choice by id", async () => {
  const choices: PythonChoice[] = [
    {
      id: "python3",
      label: "python3",
      selected: true,
      probe: { status: "ok", version: "3.12.1", path: "/usr/bin/python3", sdkApiVersion: "1.0.0" },
    },
    {
      id: "python",
      label: "python",
      selected: false,
      probe: {
        status: "warning",
        problem: "sdk-missing",
        version: "3.11.0",
        path: "/usr/bin/python",
      },
    },
    {
      id: "saved",
      label: "/old/python",
      selected: false,
      probe: { status: "error", problem: "too-old", version: "3.8.0" },
    },
  ];
  // Once for the first load and once for the refresh after saving.
  api.pythonCandidates.mockResolvedValueOnce(choices).mockResolvedValueOnce(choices);
  api.setPython.mockResolvedValueOnce({ ok: true, state: { ...snapshot, revision: 2 } });
  await render();
  await flush();
  const select = container.querySelector<HTMLSelectElement>("select")!;
  expect([...select.options].map((option) => option.textContent)).toEqual([
    "✅ python3 · Python 3.12.1 · /usr/bin/python3",
    "⚠️ python · Python 3.11.0 · /usr/bin/python · 沒有安裝 kobrixa SDK",
    "❌ /old/python · Python 3.8.0 · 需要 Python 3.10 以上",
    "其他…",
  ]);
  expect(select.value).toBe("python3");
  expect(select.options[2]!.disabled).toBe(true);
  await act(async () => {
    select.value = "python";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
  expect(api.setPython).toHaveBeenCalledWith("python");
  expect(api.pythonCandidates).toHaveBeenCalledTimes(2);
});

it("explains pending Python reloads and a --plugin-python override", async () => {
  api.state.mockResolvedValueOnce({
    ...snapshot,
    python: {
      current: { label: "/cli/python", origin: "command-line" },
      pendingReload: ["dev:0123456789abcdef"],
    },
  });
  await render();
  expect(container.textContent).toContain(pluginCopy["zh-TW"].pendingReload);
  expect(container.textContent).toContain(pluginCopy["zh-TW"].pythonCommandLine("/cli/python"));
});

it("reads a row's log in batches only while the viewer is open", async () => {
  vi.useFakeTimers();
  try {
    api.readLog
      .mockResolvedValueOnce({ lines: [{ seq: 1, text: "first" }], next: 1, truncated: true })
      .mockResolvedValueOnce({ lines: [{ seq: 2, text: "second" }], next: 2, truncated: false });
    await render();
    expect(api.readLog).not.toHaveBeenCalled();
    await act(async () => button("查看日誌").click());
    expect(api.readLog).toHaveBeenLastCalledWith("dev:0123456789abcdef", 0);
    const log = () => container.querySelector("[role=log]")!.textContent;
    expect(log()).toContain(pluginCopy["zh-TW"].logTruncated);
    expect(log()).toContain("first");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOG_POLL_MS);
    });
    expect(api.readLog).toHaveBeenLastCalledWith("dev:0123456789abcdef", 1);
    expect(log()).toContain("second");
    await act(async () => button("收起日誌").click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOG_POLL_MS * 3);
    });
    expect(api.readLog).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it("shows notices main kept while the panel was closed, with their severity", async () => {
  const kept = {
    id: 7,
    pluginId: "acme.hello",
    sourceKey: "dev:0123456789abcdef",
    severity: "error" as const,
    message: "broke",
    at: 0,
  };
  api.notices.mockResolvedValueOnce([kept]);
  await render();
  expect(container.querySelector("[aria-live=polite] li")?.textContent).toBe(
    "錯誤 acme.hello broke",
  );
  await act(async () => emit({ type: "notice", notice: kept }));
  expect(container.querySelectorAll("[aria-live=polite] li")).toHaveLength(1);
});

it("restores plugins from a safe-mode lock inside the panel", async () => {
  api.state.mockResolvedValueOnce({
    ...snapshot,
    safeMode: true,
    safeModeLock: { since: "2026-10-15T00:00:00.000Z", reason: "unclean-exit" },
  });
  api.clearSafeModeLock.mockResolvedValueOnce({ ok: true, state: { ...snapshot, revision: 2 } });
  await render();
  expect(container.textContent).toContain("Kobrixa 上次沒有正常結束，已暫停第三方插件。");
  expect(button("重新載入").disabled).toBe(true);
  expect(button("連結資料夾…").disabled).toBe(true);
  await act(async () => button("恢復插件").click());
  expect(api.clearSafeModeLock).toHaveBeenCalledOnce();
  expect(container.textContent).not.toContain("上次沒有正常結束");
});

describe("PluginRecoveryNotice", () => {
  const locked: PluginsView = {
    ...snapshot,
    safeMode: true,
    safeModeLock: { since: "2026-10-15T00:00:00.000Z", reason: "renderer-unresponsive" },
  };
  const renderNotice = async () => {
    const onOpenSettings = vi.fn();
    await act(async () =>
      root.render(createElement(PluginRecoveryNotice, { locale: "zh-TW", onOpenSettings })),
    );
    return onOpenSettings;
  };
  it("renders nothing without a lock", async () => {
    await renderNotice();
    expect(container.textContent).toBe("");
  });
  it("restores plugins or opens the plugin settings", async () => {
    api.state.mockResolvedValueOnce(locked);
    api.clearSafeModeLock.mockResolvedValueOnce({ ok: true, state: { ...snapshot, revision: 2 } });
    const onOpenSettings = await renderNotice();
    expect(container.textContent).toContain("Kobrixa 上次沒有正常結束，已暫停第三方插件。");
    await act(async () => button("前往插件設定").click());
    expect(onOpenSettings).toHaveBeenCalledOnce();
    await act(async () => button("恢復插件").click());
    expect(container.textContent).toBe("");
  });
  it("keeps the banner with a readable failure", async () => {
    api.state.mockResolvedValueOnce(locked);
    api.clearSafeModeLock.mockResolvedValueOnce({
      ok: false,
      code: "PLUGIN_E_STATE_SAVE",
      message: "disk full",
    });
    await renderNotice();
    await act(async () => button("恢復插件").click());
    expect(container.querySelector("[role=alert]")?.textContent).toBe(
      "無法儲存插件設定：disk full",
    );
    expect(button("恢復插件").disabled).toBe(false);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter @kobrixa/desktop exec vitest run src/renderer/settings/plugins-panel.test.ts`
Expected: FAIL，找不到 `./plugin-recovery.js`、`./plugin-log.js`、`readableError`。

- [ ] **Step 3: 實作**

**3a. `plugin-copy.ts`。** 檔頭 import 改成：

```ts
import type { Locale } from "../i18n/copy.js";
import type { PythonChoice } from "../../shared/plugins.js";
```

`pluginCopy.en` 裡：`howTo`、`safeMode`、`notPersisted` 改成下面的值，其餘既有鍵保留，再加入新鍵：

```ts
    howTo: "Turn on developer mode below to link plugin folders.",
    safeMode:
      "Safe mode: Kobrixa was started with --safe-mode, so third-party plugins are paused for this session. You can still disable or unlink a problem plugin.",
    safeModeLocked: "Kobrixa did not shut down normally last time, so third-party plugins are paused.",
    restore: "Restore plugins",
    openSettings: "Open plugin settings",
    notPersisted:
      "Applied for this session, but the setting could not be saved. It may be undone after a restart.",
    alreadyLinked: "This folder is already linked.",
    unknownError: "Unknown error",
    developerMode: "Developer mode",
    developerToggle: "Turn on developer mode",
    developerHint:
      "Runs code from the folders you link on this computer. It is not a sandbox.",
    developerCommandLine: "Turned on by --plugin-dev-dir for this session only; not saved.",
    keptLinks: (count: number) =>
      `${count} linked folder(s) are kept and load again when developer mode is on.`,
    linkFolder: "Link folder…",
    reload: "Reload",
    relink: "Choose folder again…",
    unlink: "Unlink",
    showLog: "Show log",
    hideLog: "Hide log",
    cancel: "Cancel",
    sessionSource: "From launch options",
    pendingReload: "Reload to use the new Python interpreter.",
    python: "Python interpreter",
    pythonNone: "Not chosen",
    pythonOther: "Other…",
    pythonRefresh: "Detect again",
    pythonCommandLine: (label: string) =>
      `This session uses ${label} from --plugin-python; the choice here applies next time.`,
    pythonProblems: {
      "sdk-missing": "kobrixa SDK not installed",
      "sdk-incompatible": "kobrixa SDK version is incompatible",
      "too-old": "Needs Python 3.10 or later",
      failed: "Could not run",
    },
    logTitle: "Plugin log",
    logEmpty: "No output yet.",
    logTruncated: "Earlier output was dropped.",
    severity: { info: "Info", warning: "Warning", error: "Error" },
```

`pluginCopy["zh-TW"]` 同樣處理：

```ts
    howTo: "開啟下方的開發者模式後，就能連結插件資料夾。",
    safeMode:
      "安全模式：因為以 --safe-mode 啟動，本次已暫停所有第三方插件。仍然可以停用或解除連結有問題的插件。",
    safeModeLocked: "Kobrixa 上次沒有正常結束，已暫停第三方插件。",
    restore: "恢復插件",
    openSettings: "前往插件設定",
    notPersisted: "已套用到本次啟動，但設定未能保存，重新啟動後可能會還原。",
    alreadyLinked: "這個資料夾已經連結過了。",
    unknownError: "未知錯誤",
    developerMode: "開發者模式",
    developerToggle: "開啟開發者模式",
    developerHint: "會在這部電腦上執行你連結的資料夾裡的程式碼，不是沙箱。",
    developerCommandLine: "本次由 --plugin-dev-dir 開啟，只在這次有效，不會保存。",
    keptLinks: (count: number) => `已保留 ${count} 個連結的資料夾，開啟開發者模式後會重新載入。`,
    linkFolder: "連結資料夾…",
    reload: "重新載入",
    relink: "重新指定資料夾…",
    unlink: "解除連結",
    showLog: "查看日誌",
    hideLog: "收起日誌",
    cancel: "取消",
    sessionSource: "本次啟動參數",
    pendingReload: "重新載入後套用新的 Python 直譯器。",
    python: "Python 直譯器",
    pythonNone: "尚未選擇",
    pythonOther: "其他…",
    pythonRefresh: "重新偵測",
    pythonCommandLine: (label: string) =>
      `本次使用 --plugin-python 指定的 ${label}，這裡的選擇下次啟動才會套用。`,
    pythonProblems: {
      "sdk-missing": "沒有安裝 kobrixa SDK",
      "sdk-incompatible": "kobrixa SDK 版本不相容",
      "too-old": "需要 Python 3.10 以上",
      failed: "無法執行",
    },
    logTitle: "插件日誌",
    logEmpty: "目前沒有輸出。",
    logTruncated: "較早的輸出已截斷。",
    severity: { info: "資訊", warning: "警告", error: "錯誤" },
```

`problems` 表最後加：

```ts
  PLUGIN_E_DEVELOPER_MODE: ["請先開啟開發者模式", "Turn on developer mode first"],
  PLUGIN_E_SESSION_SOURCE: ["這個來源來自啟動參數", "This source comes from launch options"],
  PLUGIN_E_PYTHON_UNUSABLE: ["這個 Python 無法使用", "This Python interpreter cannot be used"],
```

檔案最後加：

```ts
/** Readable text for anything an IPC call rejects with; never "[object Object]". */
export function readableError(reason: unknown): string | undefined {
  if (reason instanceof Error) return reason.message || undefined;
  if (typeof reason === "string") return reason || undefined;
  if (
    reason &&
    typeof reason === "object" &&
    typeof (reason as { message?: unknown }).message === "string"
  )
    return (reason as { message: string }).message;
  return undefined;
}

const statusIcons = { ok: "✅", warning: "⚠️", error: "❌" } as const;

export function pythonChoiceText(choice: PythonChoice, locale: Locale): string {
  const { probe } = choice;
  return [
    `${statusIcons[probe.status]} ${choice.label}`,
    probe.version && `Python ${probe.version}`,
    probe.path,
    probe.problem && pluginCopy[locale].pythonProblems[probe.problem],
  ]
    .filter(Boolean)
    .join(" · ");
}
```

**3b. 建立 `plugin-log.tsx`：**

```tsx
import { useEffect, useState } from "react";

export const LOG_POLL_MS = 1_000;
const DISPLAY_LINES = 2_000;
type Entry = { key: string; text: string; gap: boolean };

/** Reads one source's log from main in batches while it is open; nothing streams per line. */
export function PluginLog({
  sourceKey,
  labels,
}: {
  sourceKey: string;
  labels: { title: string; empty: string; truncated: string };
}): React.JSX.Element {
  const [entries, setEntries] = useState<Entry[]>([]);
  useEffect(() => {
    let live = true;
    let cursor = 0;
    let gaps = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const read = await window.kobrixa.plugins.readLog(sourceKey, cursor);
        if (!live) return;
        const batch: Entry[] = [];
        if (read.truncated) batch.push({ key: `gap-${gaps++}`, text: "", gap: true });
        for (const line of read.lines)
          batch.push({ key: String(line.seq), text: line.text, gap: false });
        cursor = read.next;
        if (batch.length) setEntries((list) => [...list, ...batch].slice(-DISPLAY_LINES));
      } catch {
        // Try again on the next tick; the panel shows what it already has.
      }
      if (live) timer = setTimeout(() => void poll(), LOG_POLL_MS);
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [sourceKey]);
  return (
    <div className="plugins-log" role="log" aria-label={labels.title}>
      {entries.length === 0 ? (
        <p className="settings-hint">{labels.empty}</p>
      ) : (
        <pre>
          {entries.map((entry) => (
            <span key={entry.key} className={entry.gap ? "plugins-log-gap" : undefined}>
              {entry.gap ? labels.truncated : entry.text}
              {"\n"}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}
```

**3c. 建立 `plugin-recovery.tsx`：**

```tsx
import { useEffect, useState } from "react";
import type { Locale } from "../i18n/copy.js";
import type { PluginsView } from "../../shared/plugins.js";
import { pluginCopy, problemText, readableError } from "./plugin-copy.js";

/** Shown at startup after an unclean exit locked safe mode; it does not claim a plugin caused it. */
export function PluginRecoveryNotice({
  locale,
  onOpenSettings,
}: {
  locale: Locale;
  onOpenSettings(): void;
}): React.JSX.Element | null {
  const t = pluginCopy[locale];
  const [state, setState] = useState<PluginsView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const accept = (next: PluginsView) =>
    setState((current) => (current && current.revision > next.revision ? current : next));
  useEffect(() => {
    let live = true;
    void window.kobrixa.plugins.state().then(
      (value) => {
        if (live) accept(value);
      },
      () => {},
    );
    const off = window.kobrixa.plugins.onEvent((event) => {
      if (event.type === "state") accept(event.state);
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  if (!state?.safeModeLock) return null;
  const restore = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await window.kobrixa.plugins.clearSafeModeLock();
      if (result.ok) accept(result.state);
      else setError(problemText(result, locale));
    } catch (reason) {
      setError(
        `${t.requestFailed}${locale === "zh-TW" ? "：" : ": "}${readableError(reason) ?? t.unknownError}`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside className="update-notice plugin-recovery" role="status">
      <span>{t.safeModeLocked}</span>
      {error && <span role="alert">{error}</span>}
      <button disabled={busy} onClick={() => void restore()}>
        {t.restore}
      </button>
      <button onClick={onOpenSettings}>{t.openSettings}</button>
    </aside>
  );
}
```

**3d. `plugins-panel.tsx` 整檔替換：**

```tsx
import { useEffect, useState } from "react";
import type { Locale } from "../i18n/copy.js";
import type {
  LocalizedText,
  PluginCommandResult,
  PluginsResult,
  PluginsView,
  PluginSummary,
  PythonChoice,
  PythonChoiceId,
  StoredNotice,
} from "../../shared/plugins.js";
import { pluginCopy, problemText, pythonChoiceText, readableError } from "./plugin-copy.js";
import { PluginLog } from "./plugin-log.js";

export const localizedText = (text: LocalizedText, locale: Locale): string =>
  typeof text === "string" ? text : locale === "zh-TW" ? (text["zh-TW"] ?? text.en) : text.en;
export const pluginRowId = (sourceKey: string): string => `plugin-${sourceKey.replace(":", "-")}`;

const NOTICE_DISPLAY_LIMIT = 20;
type PanelError =
  | { kind: "problem"; code: string; message: string }
  | { kind: "request"; message?: string }
  | { kind: "notice"; copy: "notPersisted" | "alreadyLinked" };
type Pending = Readonly<Record<string, true>>;

const requestError = (reason: unknown): PanelError => {
  const message = readableError(reason);
  return message === undefined ? { kind: "request" } : { kind: "request", message };
};
const without = (pending: Pending, key: string): Pending => {
  const next: Record<string, true> = { ...pending };
  delete next[key];
  return next;
};
const mergeNotices = (incoming: readonly StoredNotice[], list: readonly StoredNotice[]) =>
  [...new Map([...list, ...incoming].map((notice) => [notice.id, notice])).values()]
    .sort((a, b) => b.id - a.id)
    .slice(0, NOTICE_DISPLAY_LIMIT);

export function PluginsPanel({ locale }: { locale: Locale }): React.JSX.Element {
  const t = pluginCopy[locale];
  const [state, setState] = useState<PluginsView>();
  const [notices, setNotices] = useState<StoredNotice[]>([]);
  const [pending, setPending] = useState<Pending>({});
  const [error, setError] = useState<PanelError>();
  const [highlight, setHighlight] = useState<string>();
  const [logFor, setLogFor] = useState<string>();
  const [candidates, setCandidates] = useState<PythonChoice[]>();
  // Action results can arrive after newer state events; keep the highest revision.
  const accept = (next: PluginsView) =>
    setState((current) => (current && current.revision > next.revision ? current : next));
  useEffect(() => {
    let live = true;
    void window.kobrixa.plugins.state().then(
      (value) => {
        if (live) accept(value);
      },
      (reason: unknown) => {
        if (live) setError(requestError(reason));
      },
    );
    void window.kobrixa.plugins.notices().then(
      (value) => {
        if (live) setNotices((list) => mergeNotices(value, list));
      },
      () => {},
    );
    const off = window.kobrixa.plugins.onEvent((event) => {
      if (event.type === "notice") {
        setNotices((list) => mergeNotices([event.notice], list));
        return;
      }
      accept(event.state);
      // A newer state supersedes a failed request; translated problems and notices stay.
      setError((current) => (current?.kind === "request" ? undefined : current));
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  const developerOn = state?.developer.enabled === true;
  const refreshPython = () =>
    window.kobrixa.plugins.pythonCandidates().then(setCandidates, () => setCandidates([]));
  useEffect(() => {
    if (developerOn) void refreshPython();
  }, [developerOn]);
  useEffect(() => {
    if (highlight)
      document.getElementById(pluginRowId(highlight))?.scrollIntoView?.({ block: "nearest" });
  }, [highlight]);
  const busy = (key: string) => pending[key] === true;
  const perform = async (
    key: string,
    work: () => Promise<PluginsResult | PluginCommandResult>,
  ): Promise<void> => {
    setPending((current) => ({ ...current, [key]: true }));
    setError(undefined);
    try {
      const result = await work();
      if (!result.ok) setError({ kind: "problem", code: result.code, message: result.message });
      else if ("state" in result) {
        accept(result.state);
        if (result.sourceKey) setHighlight(result.sourceKey);
        if (result.outcome === "duplicate") setError({ kind: "notice", copy: "alreadyLinked" });
        else if (result.persisted === false) setError({ kind: "notice", copy: "notPersisted" });
      }
    } catch (reason) {
      setError(requestError(reason));
    } finally {
      setPending((current) => without(current, key));
    }
  };
  const errorAlert = error && (
    <p className="settings-hint" role="alert">
      {error.kind === "problem"
        ? problemText(error, locale)
        : error.kind === "notice"
          ? t[error.copy]
          : `${t.requestFailed}${locale === "zh-TW" ? "：" : ": "}${error.message ?? t.unknownError}`}
    </p>
  );
  if (!state) return errorAlert ?? <p className="settings-hint">{t.loading}</p>;
  const row = (plugin: PluginSummary) => {
    const key = plugin.sourceKey;
    const origin = state.origins[key];
    const rowBusy = busy(`row:${key}`);
    const running = state.inflight.includes(key) || busy(`run:${key}`);
    const rowAction = (work: () => Promise<PluginsResult>) => () =>
      void perform(`row:${key}`, work);
    const enabling = plugin.status === "disabled" && plugin.disabledBy === "user";
    return (
      <li key={key} id={pluginRowId(key)} data-highlighted={highlight === key ? "" : undefined}>
        <h3 className="settings-subheading">
          {plugin.displayName ? localizedText(plugin.displayName, locale) : plugin.id}
        </h3>
        <p className="settings-hint">
          {[
            plugin.id,
            plugin.version,
            plugin.source === "builtin" ? t.builtin : t.development,
            origin === "session" ? t.sessionSource : undefined,
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
        {state.python.pendingReload.includes(key) && (
          <p className="settings-hint">{t.pendingReload}</p>
        )}
        {plugin.commands.length > 0 && (
          <div role="group" aria-label={t.commands}>
            {plugin.commands.map((command) => (
              <button
                key={command.id}
                disabled={rowBusy || running || plugin.status !== "enabled"}
                onClick={() =>
                  void perform(`run:${key}`, () => window.kobrixa.plugins.execute(command.id))
                }
              >
                {localizedText(command.title, locale)}
              </button>
            ))}
            {running && (
              <button
                onClick={() =>
                  void window.kobrixa.plugins
                    .cancel(key)
                    .catch((reason: unknown) => setError(requestError(reason)))
                }
              >
                {t.cancel}
              </button>
            )}
          </div>
        )}
        {plugin.source === "development" && (
          <div className="plugins-actions">
            {plugin.status !== "invalid" && (
              <button
                disabled={rowBusy || (enabling && state.safeMode)}
                onClick={rowAction(() => window.kobrixa.plugins.setEnabled(key, enabling))}
              >
                {enabling
                  ? t.enable
                  : plugin.disabledBy === "safe-mode"
                    ? t.keepDisabled
                    : t.disable}
              </button>
            )}
            <button
              disabled={rowBusy || state.safeMode}
              onClick={rowAction(() => window.kobrixa.plugins.reload(key))}
            >
              {t.reload}
            </button>
            {origin === "linked" && plugin.status === "invalid" && (
              <button
                disabled={rowBusy || state.safeMode}
                onClick={rowAction(() => window.kobrixa.plugins.relinkFolder(key))}
              >
                {t.relink}
              </button>
            )}
            {origin === "linked" && (
              <button
                disabled={rowBusy}
                onClick={rowAction(() => window.kobrixa.plugins.unlink(key))}
              >
                {t.unlink}
              </button>
            )}
            <button
              aria-expanded={logFor === key}
              onClick={() => setLogFor((current) => (current === key ? undefined : key))}
            >
              {logFor === key ? t.hideLog : t.showLog}
            </button>
          </div>
        )}
        {logFor === key && (
          <PluginLog
            sourceKey={key}
            labels={{ title: t.logTitle, empty: t.logEmpty, truncated: t.logTruncated }}
          />
        )}
      </li>
    );
  };
  const selected = candidates?.find((choice) => choice.selected);
  const choosePython = (id: PythonChoiceId) =>
    void perform("python", () => window.kobrixa.plugins.setPython(id)).then(refreshPython);
  return (
    <div className="plugins-panel">
      <p className="settings-hint">{t.trust}</p>
      {state.safeMode && (
        <div role="status">
          <p className="settings-hint">{state.safeModeLock ? t.safeModeLocked : t.safeMode}</p>
          {state.safeModeLock && (
            <button
              disabled={busy("lock")}
              onClick={() => void perform("lock", () => window.kobrixa.plugins.clearSafeModeLock())}
            >
              {t.restore}
            </button>
          )}
        </div>
      )}
      {state.stateProblem && (
        <p className="settings-hint" role="status">
          {problemText(state.stateProblem, locale)}
        </p>
      )}
      {errorAlert}
      <ul className="plugins-list">{state.plugins.map(row)}</ul>
      <h3 className="settings-subheading">{t.notices}</h3>
      <ul aria-live="polite">
        {notices.length === 0 && <li className="settings-hint">{t.noNotices}</li>}
        {notices.map((notice) => (
          <li key={notice.id} data-severity={notice.severity}>
            <span>{t.severity[notice.severity]}</span> <strong>{notice.pluginId}</strong>{" "}
            {notice.message}
          </li>
        ))}
      </ul>
      <section className="plugins-developer" aria-labelledby="plugins-developer-title">
        <h3 className="settings-subheading" id="plugins-developer-title">
          {t.developerMode}
        </h3>
        <label>
          <input
            type="checkbox"
            checked={state.developer.enabled}
            disabled={busy("developer")}
            onChange={() =>
              void perform("developer", () =>
                window.kobrixa.plugins.setDeveloperMode(!state.developer.enabled),
              )
            }
          />{" "}
          {t.developerToggle}
        </label>
        <p className="settings-hint">{state.developer.enabled ? t.developerHint : t.howTo}</p>
        {state.developer.commandLine && <p className="settings-hint">{t.developerCommandLine}</p>}
        {!state.developer.enabled && state.developer.linkedCount > 0 && (
          <p className="settings-hint">{t.keptLinks(state.developer.linkedCount)}</p>
        )}
        {state.developer.enabled && (
          <>
            <button
              disabled={busy("link") || state.safeMode}
              onClick={() => void perform("link", () => window.kobrixa.plugins.linkFolder())}
            >
              {t.linkFolder}
            </button>
            <label className="plugins-python">
              {t.python}{" "}
              <select
                value={selected?.id ?? ""}
                disabled={busy("python") || candidates === undefined}
                onChange={(event) => {
                  if (event.target.value) choosePython(event.target.value as PythonChoiceId);
                }}
              >
                {!selected && <option value="">{t.pythonNone}</option>}
                {candidates?.map((choice) => (
                  <option
                    key={choice.id}
                    value={choice.id}
                    disabled={choice.probe.status === "error"}
                  >
                    {pythonChoiceText(choice, locale)}
                  </option>
                ))}
                <option value="other">{t.pythonOther}</option>
              </select>
            </label>
            <button disabled={busy("python")} onClick={() => void refreshPython()}>
              {t.pythonRefresh}
            </button>
            {state.python.current?.origin === "command-line" && (
              <p className="settings-hint">{t.pythonCommandLine(state.python.current.label)}</p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
```

**3e. `settings-panel.tsx`：** 第 212 行的型別改成 `requestedCategory: { category: "appearance" | "shortcuts" | "updates" | "plugins"; request: number };`。

**3f. `app.tsx`：**

- import 區加 `import { PluginRecoveryNotice } from "./settings/plugin-recovery.js";`。
- `useState<{ category: "appearance" | "shortcuts" | "updates"; request: number; }>` 的 `category` 型別加上 `| "plugins"`。
- 在 `{updates &&\n          ["ready", "manual"].includes(updates.phase) &&` 這個區塊之前加：

```tsx
<PluginRecoveryNotice
  locale={locale}
  onOpenSettings={() => {
    setSettingsCategory((previous) => ({
      category: "plugins",
      request: previous.request + 1,
    }));
    openSettings();
  }}
/>
```

**3g. `workbench.css` 最後加：**

```css
.plugins-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.plugins-list > li[data-highlighted] {
  outline: 2px solid currentColor;
  outline-offset: 4px;
}
.plugins-log pre {
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.plugins-log-gap {
  font-style: italic;
  opacity: 0.7;
}
```

**3h. `tests/desktop/preload.cjs`：** 在 `documentation: { open: call("documentationOpen") },` 之後加：

```js
  // The workbench asks for plugin state at startup (recovery notice); the smoke has no plugins.
  plugins: {
    state: async () => ({
      revision: 0,
      safeMode: false,
      developmentMode: false,
      plugins: [],
      developer: { enabled: false, commandLine: false, linkedCount: 0 },
      origins: {},
      python: { pendingReload: [] },
      inflight: [],
    }),
    notices: async () => [],
    onEvent: () => () => {},
  },
```

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm --filter @kobrixa/desktop exec vitest run src/renderer && pnpm --filter @kobrixa/desktop check && pnpm exec eslint apps/desktop/src/renderer tests/desktop/preload.cjs`
Expected: PASS，無型別或 lint 錯誤。

Run: `pnpm test:desktop:smoke`
Expected: PASS（工作台啟動時橫幅不顯示、不報錯）。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/settings/plugin-copy.ts apps/desktop/src/renderer/settings/plugin-log.tsx apps/desktop/src/renderer/settings/plugin-recovery.tsx apps/desktop/src/renderer/settings/plugins-panel.tsx apps/desktop/src/renderer/settings/plugins-panel.test.ts apps/desktop/src/renderer/settings/settings-panel.tsx apps/desktop/src/renderer/app.tsx apps/desktop/src/renderer/styles/workbench.css tests/desktop/preload.cjs
git commit -m "feat(desktop): manage development plugins from the settings panel"
```

---

### Task 10: 以假對話框跑的 Electron GUI smoke

**Files:**

- Create: `tests/desktop/plugins-gui-smoke-main.ts`
- Modify: `tests/desktop/run-plugins-smoke.mjs`

**Interfaces:**

- Consumes：Task 7 的 `startPlugins`、`StartPluginsOptions`、`PluginController`（`state`、`setDeveloperMode`、`linkFolder`、`execute`、`reload`、`unlink`、`clearSafeModeLock`、`markRendererUnresponsive`、`finishSession`）；Task 6 的 `PluginDialogs`；既有的 `installPluginQuitCleanup`（`apps/desktop/src/main/plugins/quit.ts`）。
- Produces：`pnpm test:plugins:smoke` 在原本的 CLI smoke 通過後，再跑三個階段的 GUI smoke，最後印出 `PASS plugin GUI: developer mode, link, reload, unlink, recovery after a hang`。

Ruling：橫幅與面板的畫面由 Task 9 的 jsdom 單元測試涵蓋；這個 smoke 驗證的是驅動橫幅的主程序狀態（`safeModeLock`、`disabledBy`）以及真的 Electron 生命週期（`quit` 事件清 marker、`SIGKILL` 留下 marker）。用真的 renderer 點按鈕需要 Playwright 之類的新依賴，不在 1b 範圍內。

GUI smoke 只用 `hello-ts`（Node 執行環境），不需要 Python；Python 的實際探測由 Task 4 的測試涵蓋。

- [ ] **Step 1: 寫 GUI smoke 的主程式**

`tests/desktop/plugins-gui-smoke-main.ts`：

```ts
import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { startPlugins } from "../../apps/desktop/src/main/plugins/controller.js";
import type { PluginDialogs } from "../../apps/desktop/src/main/plugins/dialogs.js";
import { installPluginQuitCleanup } from "../../apps/desktop/src/main/plugins/quit.js";

// Three phases share one --user-data-dir: link and quit, use the link and crash while the
// renderer is marked unresponsive, then come back in the locked safe mode and restore.
const [directory, phase] = process.argv.slice(-2) as [string, "first" | "second" | "third"];
const hello = path.join(directory, "hello-ts");
const greet = "kobrixa-samples.hello-ts.greet";
const fail = (error: unknown) => {
  console.error(error);
  app.exit(1);
};
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
setTimeout(() => fail(new Error(`Plugin GUI smoke (${phase}) timed out`)), 60_000).unref();

// Scripted answers stand in for the native dialogs the user would click through.
const answers = { confirm: true, folder: hello };
const dialogs: PluginDialogs = {
  confirmDeveloperMode: () => Promise.resolve(answers.confirm),
  chooseFolder: () => Promise.resolve(answers.folder),
  confirmLink: () => Promise.resolve(answers.confirm),
  confirmUnlink: () => Promise.resolve(answers.confirm),
  choosePython: () => Promise.resolve(undefined),
};

void app.whenReady().then(async () => {
  const plugins = await startPlugins({
    userData: app.getPath("userData"),
    builtins: [],
    commandLine: { developmentDirectories: [], safeMode: false },
    dialogs,
    locale: "en",
  });
  // The same quit path as apps/desktop/src/main/index.ts.
  installPluginQuitCleanup(app, plugins);
  app.on("quit", () => plugins.finishSession());

  if (phase === "first") {
    assert.equal(plugins.state().developer.enabled, false, "Developer mode starts off");
    answers.confirm = false;
    const declined = await plugins.setDeveloperMode(true);
    assert.equal(declined.ok && declined.outcome, "cancelled");
    assert.equal(plugins.state().developer.enabled, false, "Declining the dialog changes nothing");
    answers.confirm = true;
    assert.equal((await plugins.setDeveloperMode(true)).ok, true);
    assert.equal(plugins.state().developer.enabled, true);
    const linked = await plugins.linkFolder();
    assert.equal(linked.ok, true);
    assert.equal(typeof (linked.ok ? linked.sourceKey : undefined), "string");
    assert.deepEqual(await plugins.execute(greet), { ok: true });
    app.quit();
    return;
  }

  if (phase === "second") {
    const [row] = plugins.state().plugins;
    assert.ok(row?.sourceKey, "The link survived the restart");
    assert.equal(plugins.state().origins[row.sourceKey], "linked");
    assert.deepEqual(await plugins.execute(greet), { ok: true });
    assert.equal((await plugins.reload(row.sourceKey)).ok, true);
    assert.deepEqual(await plugins.execute(greet), { ok: true }, "The command works after reload");
    assert.equal((await plugins.unlink(row.sourceKey)).ok, true);
    assert.deepEqual(plugins.state().plugins, []);
    // Unlinking never deletes the user's files.
    await access(path.join(hello, "kobrixa-plugin.json"));
    assert.equal((await plugins.linkFolder()).ok, true);
    assert.deepEqual(await plugins.execute(greet), { ok: true });
    // A hung renderer is sticky: even though this process dies, the next start must lock.
    plugins.markRendererUnresponsive();
    await writeFile(path.join(directory, "gui-crash-ready.txt"), "ready");
    process.kill(process.pid, "SIGKILL");
    return;
  }

  const locked = plugins.state();
  assert.equal(locked.safeMode, true);
  assert.equal(locked.safeModeLock?.reason, "renderer-unresponsive");
  assert.equal(locked.plugins[0]?.disabledBy, "safe-mode");
  assert.equal((await plugins.clearSafeModeLock()).ok, true);
  const restored = plugins.state();
  assert.equal(restored.safeMode, false);
  assert.equal(restored.safeModeLock, undefined);
  assert.equal(restored.plugins[0]?.status, "enabled");
  assert.deepEqual(await plugins.execute(greet), { ok: true });
  app.quit();
});
```

若格式化後 Prettier 把斷言拆成多行，以格式化結果為準。

- [ ] **Step 2: 執行既有的 smoke，確認 GUI 階段尚未接上**

Run: `pnpm --filter @kobrixa/plugin-runtime build && pnpm test:plugins:smoke`
Expected: PASS，輸出只有 `PASS plugins: utilityProcess TS, Python stdio, crash isolation, quit cleanup`，沒有 `PASS plugin GUI`。

- [ ] **Step 3: 在 runner 裡加上三個 GUI 階段**

`tests/desktop/run-plugins-smoke.mjs`：

1. 在檔案開頭的 import 把 `stat` 加進 `node:fs/promises`：

```js
import { access, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
```

2. 在 `console.log("PASS plugins: utilityProcess TS, Python stdio, crash isolation, quit cleanup");` 之後、`passed = true;` 之前插入：

```js
// The GUI flow: the same controller the settings panel drives, with scripted native dialogs.
await bundle(
  path.join(root, "tests/desktop/plugins-gui-smoke-main.ts"),
  path.join(temporary, "gui-main.cjs"),
  ["electron"],
);
const guiUserData = path.join(temporary, "gui-user-data");
const runGui = async (phase) => {
  const gui = spawn(
    process.execPath,
    [
      require.resolve("electron/cli.js"),
      path.join(temporary, "gui-main.cjs"),
      `--user-data-dir=${guiUserData}`,
      temporary,
      phase,
    ],
    { stdio: "inherit" },
  );
  return new Promise((resolve, reject) => {
    gui.once("error", reject);
    gui.once("exit", resolve);
  });
};
const first = await runGui("first");
if (first !== 0) throw new Error(`Plugin GUI smoke (first) failed (${first})`);
// electron/cli.js exits with 1 when Electron is killed by a signal.
const second = await runGui("second");
await access(path.join(temporary, "gui-crash-ready.txt")).catch(() => {
  throw new Error(`Plugin GUI smoke (second) failed before the simulated crash (${second})`);
});
if (second === 0) throw new Error("Plugin GUI smoke (second) should have been killed");
const third = await runGui("third");
if (third !== 0) throw new Error(`Plugin GUI smoke (third) failed (${third})`);
await access(path.join(temporary, "hello-ts/kobrixa-plugin.json"));
const marker = await stat(path.join(guiUserData, "plugins/session.json")).catch(() => undefined);
if (marker) throw new Error("A clean quit must remove the session marker");
const saved = JSON.parse(await readFile(path.join(guiUserData, "plugins/state.json"), "utf8"));
if (saved.developerMode !== true || saved.sources.length !== 1 || "safeModeLock" in saved)
  throw new Error(`Unexpected plugin settings after the GUI smoke: ${JSON.stringify(saved)}`);
console.log("PASS plugin GUI: developer mode, link, reload, unlink, recovery after a hang");
```

第二階段被 `SIGKILL` 後，`hello-ts` 的 utilityProcess 會在父程序消失時由 Electron 結束；這裡不額外檢查它的 PID，因為原本的 CLI smoke 已經驗證過「沒有插件程序比 Kobrixa 活得久」。

- [ ] **Step 4: 執行 smoke，確認通過**

Run: `pnpm --filter @kobrixa/plugin-runtime build && pnpm test:plugins:smoke`
Expected: PASS，最後兩行依序是：

```
PASS plugins: utilityProcess TS, Python stdio, crash isolation, quit cleanup
PASS plugin GUI: developer mode, link, reload, unlink, recovery after a hang
```

失敗時 runner 會印出 `Plugin smoke artifacts: <路徑>`，到 `<路徑>/gui-user-data/plugins/` 看 `state.json` 與 `session.json`。

- [ ] **Step 5: 格式與 lint**

Run: `pnpm exec prettier --write tests/desktop/plugins-gui-smoke-main.ts tests/desktop/run-plugins-smoke.mjs && pnpm exec prettier --check tests/desktop/plugins-gui-smoke-main.ts tests/desktop/run-plugins-smoke.mjs && pnpm exec eslint tests/desktop/plugins-gui-smoke-main.ts tests/desktop/run-plugins-smoke.mjs && pnpm check`
Expected: 全部通過。

- [ ] **Step 6: Commit**

```bash
git add tests/desktop/plugins-gui-smoke-main.ts tests/desktop/run-plugins-smoke.mjs
git commit -m "test(desktop): smoke the plugin GUI flow and recovery after a hang"
```

---

### Task 11: 文件改以圖形介面為主，並做最終驗證

**Files:**

- Modify: `plugins/samples/README.md`
- Modify: `docs/en/architecture.md`（`## Plugins (development preview)` 一節）
- Modify: `docs/zh-TW/architecture.md`（`## 插件（開發預覽）` 一節）
- Modify: `README.md`、`README.zh-TW.md`（`## Documentation`／`## 文件`）
- Modify: `docs/superpowers/plans/2026-10-15-plugin-system-phase-2-backlog.md`
- Modify: `docs/superpowers/specs/2026-10-15-plugin-loading-ux-design.md`（狀態行）

**Interfaces:**

- Consumes：Task 9 的面板文字（`pluginCopy`）。文件裡出現的按鈕名稱必須和面板完全相同：

| en                                     | zh-TW                   |
| -------------------------------------- | ----------------------- |
| Turn on developer mode                 | 開啟開發者模式          |
| Link folder…                           | 連結資料夾…             |
| Python interpreter / Detect again      | Python 直譯器／重新偵測 |
| Other…                                 | 其他…                   |
| Reload                                 | 重新載入                |
| Choose folder again…                   | 重新指定資料夾…         |
| Unlink                                 | 解除連結                |
| Show log                               | 查看日誌                |
| Restore plugins / Open plugin settings | 恢復插件／前往插件設定  |
| From launch options                    | 本次啟動參數            |
| Keep disabled after restart            | 重新啟動後也保持停用    |

- Produces：無程式介面。spec §6 的要求：圖形介面流程為主，命令列旗標改為進階用法；從第二階段待辦移除已處理的項目。

Ruling：根目錄 README 目前沒有任何插件內容，所以只在「Using Kobrixa」／「使用 Kobrixa」清單加一行連到範例說明，不另寫一節。

Ruling：待辦裡「轉送到 console 的插件輸出沒有清理」**保留**：1b 只清理存進面板日誌的內容，`console.error` 仍印原始行。

- [ ] **Step 1: 改寫 `plugins/samples/README.md`**

整份換成下面的內容（英文在前、繁體中文在後，維持原本的結構）：

````markdown
# Plugin samples (development preview)

These samples contribute a greeting command and display a message in Settings → Plugins. They demonstrate trusted local plugins, not Python or TypeScript compilation for EV3. Plugin permissions restrict calls through Kobrixa; they are not an operating-system sandbox.

## Prepare the samples

Use Node.js 24 or newer, pnpm 10.15.0 and Python 3.10 or newer with pip. From the repository root, run the following in a macOS/Linux shell. If Python requires a virtual environment, activate it first so the SDK is installed into the interpreter you will choose in Kobrixa.

```sh
pnpm install && pnpm build:core
npx esbuild plugins/samples/hello-ts/src/index.ts --bundle --platform=node --format=cjs \
  --tsconfig=tsconfig.base.json --outfile=plugins/samples/hello-ts/dist/index.cjs
python3 -m pip install -e sdks/python
pnpm dev
```

`--tsconfig=tsconfig.base.json` supplies the workspace mapping for `@kobrixa/plugin-sdk`. The bundle output matches the TypeScript manifest's `runtime.entry`. A packaged Kobrixa works the same way: open it normally, no launch options are needed.

## Link the samples

1. Open **Settings → Plugins** and select **Turn on developer mode** at the bottom. Kobrixa asks for confirmation, because linked plugins run as ordinary programs on this computer.
2. Select **Link folder…** and choose `plugins/samples/hello-ts`. Before linking, Kobrixa shows the plugin's name, ID, runtime, folder and any manifest problems. Repeat for `plugins/samples/hello-python`.
3. Under **Python interpreter**, choose the interpreter where you installed the SDK. Each candidate shows its version and whether the Kobrixa SDK is installed; **Other…** opens a file picker and **Detect again** checks the candidates again. On Windows, `py -3` is also listed.
4. Select **Say hello** on each sample. Plugin processes start only when a command runs.

The links and the Python choice are saved in `<userData>/plugins/state.json`, so the samples are still there after a restart. Kobrixa stores the folder's real path, so linking the same folder again (even with different letter case on macOS or Windows) only highlights the existing row.

The corresponding command IDs are:

- `kobrixa-samples.hello-ts.greet` — `hello-ts/src/index.ts`, bundled to `hello-ts/dist/index.cjs`.
- `kobrixa-samples.hello-python.greet` — `hello-python/main.py`, using `from kobrixa import Plugin`.

Both manifests request `ui.notifications` and declare the matching `onCommand:<command-id>` activation event. The greeting uses the host locale received at startup (`en` or `zh-TW`) and appears under **Messages from plugins** with the plugin ID and its severity.

## While developing

- **Reload** reads the folder again and restarts the plugin, for example after rebuilding `dist/index.cjs` or editing `main.py`. A Python choice made while a plugin is running takes effect at the next reload.
- **Choose folder again…** points a row at a moved folder. **Unlink** removes the row; it never deletes files.
- **Show log** shows the plugin's output: JS/TS stdout/stderr and Python stderr. Control characters are removed. Each plugin keeps up to 256 KiB and all plugins together up to 4 MiB, oldest lines first out; logs live only in memory and are cleared on unlink. The same lines also appear in the terminal running Kobrixa, prefixed with `[plugin <id>] `. Constructing `Plugin()` redirects Python `print()` to stderr, including top-level prints before `run()`; use stderr explicitly for any logs before construction.
- A running command shows **Cancel**. If the plugin does not stop within five seconds, Kobrixa terminates its process.
- **Disable** stops a plugin and removes its commands; **Enable** makes them available again. **Keep disabled after restart** saves the choice.
- Turning developer mode off stops every linked plugin but keeps the links; turning it on again loads them.

A crash never replays a command; three process failures within five minutes require disabling and enabling the plugin before another start.

## Recovery

If Kobrixa did not shut down normally while a third-party plugin was running, or its window stopped responding, the next start pauses all third-party plugins and shows a banner. Built-in Basic Plus stays enabled. Use **Open plugin settings** to disable or unlink the problem plugin, then **Restore plugins**.

## Advanced: launch options

Launch options apply to one session only. They are not saved, and the panel marks such rows **From launch options**; they cannot be unlinked. A folder that is also linked appears once.

| Switch                          | Effect                                                                                                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--plugin-dev-dir=<folders>`    | Loads these folders for this session without turning on developer mode. Separate folders with `:` on macOS/Linux and `;` on Windows; quote the value and use absolute paths. |
| `--plugin-python=<interpreter>` | Uses this interpreter for this session instead of the saved choice.                                                                                                          |
| `--safe-mode`                   | Keeps all third-party plugins off for this session. **Restore plugins** cannot end it; restart without the switch.                                                           |

From a checkout, pass them after one `--` separator: pnpm forwards it through the nested script, and Electron Forge passes the following switches to Electron.

```sh
pnpm dev -- --plugin-dev-dir="$PWD/plugins/samples/hello-ts:$PWD/plugins/samples/hello-python" \
  --plugin-python="$(command -v python3)"
```

For a packaged app on macOS, quit any running Kobrixa first:

```sh
open -a Kobrixa --args \
  --plugin-dev-dir="$PWD/plugins/samples/hello-ts:$PWD/plugins/samples/hello-python" \
  --plugin-python="$(command -v python3)"
```

Python must be installed locally with the SDK; Kobrixa does not download or manage the interpreter. Python stdout carries only protocol messages; write logs to stderr. See the [Python SDK](../../sdks/python/README.md) and [plugin architecture](../../docs/en/architecture.md#plugins-development-preview).

## 繁體中文

這兩個範例會提供問候命令，並在「設定 → 插件」顯示訊息。它們示範可信任的本機插件，不提供將 Python 或 TypeScript 編譯至 EV3 的功能。插件權限只限制透過 Kobrixa 的呼叫，並不是作業系統沙箱。

### 準備範例

請使用 Node.js 24 以上、pnpm 10.15.0，以及具備 pip 的 Python 3.10 以上版本。在儲存庫根目錄，以 macOS／Linux shell 執行以下命令。如果 Python 要求使用虛擬環境，請先啟用該環境，讓 SDK 安裝到之後要在 Kobrixa 選的直譯器。

```sh
pnpm install && pnpm build:core
npx esbuild plugins/samples/hello-ts/src/index.ts --bundle --platform=node --format=cjs \
  --tsconfig=tsconfig.base.json --outfile=plugins/samples/hello-ts/dist/index.cjs
python3 -m pip install -e sdks/python
pnpm dev
```

`--tsconfig=tsconfig.base.json` 提供 `@kobrixa/plugin-sdk` 的 workspace 路徑對應。輸出檔案符合 TypeScript manifest 的 `runtime.entry`。已封裝的 Kobrixa 用法相同：正常開啟即可，不需要啟動參數。

### 連結範例

1. 開啟「設定 → 插件」，在最下方選「開啟開發者模式」。Kobrixa 會先請你確認，因為連結的插件會以一般程式身分在這部電腦執行。
2. 選「連結資料夾…」，選擇 `plugins/samples/hello-ts`。連結前 Kobrixa 會顯示插件名稱、ID、執行環境、資料夾，以及 manifest 的問題（如果有）。再對 `plugins/samples/hello-python` 做一次。
3. 在「Python 直譯器」選擇安裝了 SDK 的直譯器。每個候選都會顯示版本，以及是否已安裝 Kobrixa SDK；「其他…」會開啟檔案選擇視窗，「重新偵測」會重新檢查候選。Windows 另外會列出 `py -3`。
4. 在兩個範例各按一次「打招呼」。插件程序要等命令執行時才會啟動。

連結的資料夾與 Python 選擇會保存在 `<userData>/plugins/state.json`，重新啟動後範例仍在。Kobrixa 存的是資料夾的實際路徑，所以再次連結同一個資料夾（即使在 macOS 或 Windows 上大小寫不同）只會標示既有的那一列。

對應的命令 ID 如下：

- `kobrixa-samples.hello-ts.greet`：原始碼為 `hello-ts/src/index.ts`，打包至 `hello-ts/dist/index.cjs`。
- `kobrixa-samples.hello-python.greet`：入口為 `hello-python/main.py`，使用 `from kobrixa import Plugin`。

兩份 manifest 都要求 `ui.notifications` 權限，並宣告對應的 `onCommand:<command-id>` 啟用事件。問候訊息使用啟動時從宿主收到的語系（`en` 或 `zh-TW`），附上插件 ID 與嚴重程度，顯示於「插件訊息」。

### 開發時

- 「重新載入」會重新讀取資料夾並重新啟動插件，例如重新打包 `dist/index.cjs` 或修改 `main.py` 之後。插件執行中變更的 Python 選擇，會在下次重新載入時套用。
- 「重新指定資料夾…」用於資料夾搬移之後。「解除連結」只移除這一列，不會刪除任何檔案。
- 「查看日誌」顯示插件的輸出：JS／TS 的 stdout／stderr 與 Python 的 stderr，控制字元會被移除。每個插件最多保留 256 KiB，全部插件合計最多 4 MiB，先丟最舊的行；日誌只存在記憶體，解除連結時清除。同樣的內容也會出現在執行 Kobrixa 的終端機，每行加上 `[plugin <id>] ` 前綴。建立 `Plugin()` 時，Python 的 `print()` 便會導向 stderr，包含呼叫 `run()` 之前的頂層輸出；建立實例之前的日誌則須明確寫入 stderr。
- 命令執行中會出現「取消」。插件若在五秒內沒有停下，Kobrixa 會結束它的程序。
- 「停用」會停止插件並移除其命令；「啟用」即可再次使用。「重新啟動後也保持停用」會保存這個選擇。
- 關閉開發者模式會停止所有連結的插件，但保留連結；再次開啟時會重新載入。

當機不會重播命令；五分鐘內發生三次程序失敗後，必須停用再啟用插件，才能再次啟動。

### 復原

如果 Kobrixa 在第三方插件執行時沒有正常結束，或視窗停止回應，下次啟動會暫停所有第三方插件並顯示提示橫幅。內建 Basic Plus 保持啟用。按「前往插件設定」停用或解除連結有問題的插件，再按「恢復插件」。

### 進階：啟動參數

啟動參數只對本次執行有效，不會保存，面板會在這些列標示「本次啟動參數」，這些列不能解除連結。已連結的資料夾若也出現在參數中，只會顯示一列。

| 開關                            | 效果                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `--plugin-dev-dir=<folders>`    | 本次執行載入這些資料夾，不需要開啟開發者模式。macOS／Linux 以 `:` 分隔資料夾，Windows 使用 `;`；請加上引號並使用絕對路徑。 |
| `--plugin-python=<interpreter>` | 本次執行改用這個直譯器，不使用保存的選擇。                                                                                 |
| `--safe-mode`                   | 本次執行保持關閉所有第三方插件。「恢復插件」無法解除；請移除這個開關後重新啟動。                                           |

從原始碼執行時，在一個 `--` 分隔符之後傳入：pnpm 會經由巢狀腳本保留此分隔符，Electron Forge 再將後續開關傳至 Electron。

```sh
pnpm dev -- --plugin-dev-dir="$PWD/plugins/samples/hello-ts:$PWD/plugins/samples/hello-python" \
  --plugin-python="$(command -v python3)"
```

在 macOS 啟動已封裝的應用程式前，先結束所有執行中的 Kobrixa：

```sh
open -a Kobrixa --args \
  --plugin-dev-dir="$PWD/plugins/samples/hello-ts:$PWD/plugins/samples/hello-python" \
  --plugin-python="$(command -v python3)"
```

必須在本機安裝 Python 與 SDK；Kobrixa 不下載或管理直譯器。Python stdout 只傳送協定訊息，日誌請寫入 stderr。詳見 [Python SDK](../../sdks/python/README.md) 與[插件架構](../../docs/zh-TW/architecture.md#插件開發預覽)。
````

寫入前先對照 Task 9 的 `plugin-copy.ts`：若實作時按鈕文字有調整，以程式碼為準同步改這份文件。「Say hello」／「打招呼」是範例 manifest 的命令標題，不是面板文字。

- [ ] **Step 2: 更新英文架構文件的插件一節**

`docs/en/architecture.md` 的 `## Plugins (development preview)`：

1. 第一段換成：

```markdown
Phase 1 supports trusted local JS/TS and Python plugins. Third-party plugins load only in developer mode, which is off by default and turned on in Settings → Plugins after a native confirmation dialog. The panel links plugin folders through a native folder picker, chooses the Python interpreter, lists built-in and development plugins with their load errors, messages and logs, runs and cancels contributed commands, and reloads, enables, disables or unlinks development plugins. See the [runnable samples](../../plugins/samples/README.md) and [Python SDK](../../sdks/python/README.md).
```

2. 在「JS/TS plugins run in Electron `utilityProcess` children…」那段之後，插入：

```markdown
The desktop main process wraps the runtime's `PluginManager` in a `PluginController` (`apps/desktop/src/main/plugins/controller.ts`). It owns developer mode, the native dialogs, Python probing, log and message buffers and the session marker, and it checks every request from the renderer: developer mode, safe mode and whether Kobrixa is shutting down are enforced in the main process, after any dialog closes. The renderer sends only source keys, command IDs, booleans, Python candidate IDs and log cursors — never a path or an executable. This prevents adding an arbitrary path or executable without the user's choice; it does not protect against a compromised renderer.

Linking stores the folder's real path (`fs.realpath`), and the source key is derived from it, so the same folder cannot be linked twice. Python candidates (`python3`, `python`, `py -3` on Windows, the saved choice, or one picked with **Other…**) are probed without a shell, with a 3-second limit and 4 KiB of output; a usable interpreter is Python 3.10 or newer with an importable `kobrixa` SDK of the same major API version.
```

3. 「Python stderr and JS/TS stdout/stderr appear in the main process's terminal/console…」那段換成：

```markdown
Python stderr and JS/TS stdout/stderr are kept in main-process memory for the panel's log viewer (256 KiB per plugin, 4 MiB in total, oldest lines dropped first, control characters removed, cleared on unlink), and are also written to the main process's terminal/console with each line prefixed `[plugin <id>] `. UTF-8 output is decoded across chunks, and a final partial line is flushed on exit. The Python SDK redirects `print()` to stderr as soon as `Plugin()` is constructed, including before `run()`; logs written before construction must explicitly use stderr.
```

4. 「Startup switches are parsed by the desktop main process:」換成 `Advanced launch options apply to one session only and are never saved:`，表格三列換成：

```markdown
| Switch                          | Effect                                                                                                                                                                                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--plugin-dev-dir=<folders>`    | Loads each named folder's `kobrixa-plugin.json` for this session, without turning on developer mode. Use `:` between folders on macOS/Linux and `;` on Windows. Relative paths resolve from the launch working directory; absolute paths are recommended. |
| `--plugin-python=<interpreter>` | Uses this local Python executable for this session instead of the saved choice. Install the SDK in this interpreter's environment.                                                                                                                        |
| `--safe-mode`                   | Disables all development plugins for this session before contributions are registered or processes are launched. Built-in plugins remain enabled. **Restore plugins** cannot end it.                                                                      |
```

5. 「User-disabled plugin IDs are saved in…」那段換成：

```markdown
`<userData>/plugins/state.json` (schema version 2) stores developer mode, the linked folders, the chosen Python interpreter, the source keys of plugins kept disabled after restart, and the safe-mode lock. A file that cannot be read keeps third-party plugins off instead of being overwritten.

`<userData>/plugins/session.json` records whether a third-party plugin process ran and whether the window stopped responding; it is written synchronously and removed on a normal quit. If it is still present at the next start and either flag is set, Kobrixa writes a safe-mode lock: third-party plugins stay paused and the app shows a banner until the user selects **Restore plugins**. A hung window keeps the marker even after a normal quit. Development plugins cannot be enabled, linked or reloaded during safe mode; they can still be disabled or unlinked.
```

- [ ] **Step 3: 更新繁體中文架構文件的插件一節**

`docs/zh-TW/architecture.md` 的 `## 插件（開發預覽）`，同樣五處：

1. 第一段換成：

```markdown
第一階段支援可信任的本機 JS／TS 與 Python 插件。第三方插件只在開發者模式載入；開發者模式預設關閉，需在「設定 → 插件」經過原生確認對話框才能開啟。面板透過原生資料夾選擇視窗連結插件資料夾、選擇 Python 直譯器、列出內建與開發插件及其載入錯誤、訊息與日誌，並提供執行與取消貢獻命令，以及重新載入、啟用、停用、解除連結開發插件的操作。詳見[可執行範例](../../plugins/samples/README.md)與 [Python SDK](../../sdks/python/README.md)。
```

2. 在「JS／TS 插件在 Electron `utilityProcess` 子程序中執行…」那段之後插入：

```markdown
桌面主程序以 `PluginController`（`apps/desktop/src/main/plugins/controller.ts`）包住 runtime 的 `PluginManager`。它負責開發者模式、原生對話框、Python 探測、日誌與訊息緩衝及 session marker，並檢查 renderer 送來的每個要求：開發者模式、安全模式與是否正在關閉都在主程序檢查，而且在對話框關閉後會再檢查一次。renderer 只傳來源 key、命令 ID、布林值、Python 候選 ID 與日誌游標，從不傳路徑或執行檔。這能防止沒經過使用者選擇就加入任意路徑或執行檔，但防不了已經被入侵的 renderer。

連結時會儲存資料夾的實際路徑（`fs.realpath`），來源 key 由它計算，所以同一個資料夾不會被連結兩次。Python 候選（`python3`、`python`、Windows 的 `py -3`、保存的選擇，或用「其他…」選的檔案）不經 shell 探測，限時 3 秒、輸出上限 4 KiB；可用的直譯器必須是 Python 3.10 以上，且能匯入 API 主版號相同的 `kobrixa` SDK。
```

3. 「Python 的 stderr 與 JS／TS 的 stdout／stderr 會顯示在主程序的終端機／主控台…」那段換成：

```markdown
Python 的 stderr 與 JS／TS 的 stdout／stderr 會保存在主程序記憶體，供面板的日誌檢視使用（每個插件 256 KiB、合計 4 MiB，先丟最舊的行，移除控制字元，解除連結時清除），同時寫到主程序的終端機／主控台，每行加上 `[plugin <id>] ` 前綴。UTF-8 輸出會跨資料區塊解碼，結束時也會輸出最後未換行的內容。Python SDK 在建立 `Plugin()` 時便將 `print()` 導向 stderr，涵蓋呼叫 `run()` 之前的輸出；建立實例之前的日誌須明確寫入 stderr。
```

4. 「啟動開關由桌面主程序解析：」換成 `進階啟動參數只對本次執行有效，從不保存：`，表格三列換成：

```markdown
| 開關                            | 效果                                                                                                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--plugin-dev-dir=<folders>`    | 本次執行載入每個指定資料夾的 `kobrixa-plugin.json`，不需要開啟開發者模式。macOS／Linux 以 `:` 分隔資料夾，Windows 使用 `;`。相對路徑以啟動時的工作目錄為基準；建議使用絕對路徑。 |
| `--plugin-python=<interpreter>` | 本次執行改用這個本機 Python 執行檔，不使用保存的選擇。請將 SDK 安裝到此直譯器的環境中。                                                                                          |
| `--safe-mode`                   | 在註冊貢獻或啟動程序之前，停用本次執行的所有開發插件。內建插件保持啟用。「恢復插件」無法解除。                                                                                   |
```

5. 「使用者停用的插件 ID 會儲存在…」那段換成：

```markdown
`<userData>/plugins/state.json`（schema 第 2 版）保存開發者模式、連結的資料夾、選擇的 Python 直譯器、重新啟動後也保持停用的插件來源 key，以及安全模式鎖。檔案無法讀取時，第三方插件保持關閉，不會覆寫該檔案。

`<userData>/plugins/session.json` 記錄是否有第三方插件程序執行過、視窗是否停止回應；它以同步方式寫入，正常結束時刪除。下次啟動時若檔案仍在且任一旗標成立，Kobrixa 會寫入安全模式鎖：第三方插件保持暫停，並顯示提示橫幅，直到使用者按「恢復插件」。視窗卡住過的話，即使之後正常結束也會保留 marker。安全模式中無法啟用、連結或重新載入開發插件，但仍可停用或解除連結。
```

- [ ] **Step 4: 根目錄 README 加上範例連結**

`README.md` 的 `**Using Kobrixa**` 清單，在 `- [Cloud collaboration](docs/en/collaboration.md)` 之後加一行：

```markdown
- [Plugin samples (development preview)](plugins/samples/README.md)
```

`README.zh-TW.md` 的 `**使用 Kobrixa**` 清單，在 `- [雲端協作](docs/zh-TW/collaboration.md)` 之後加一行：

```markdown
- [插件範例（開發預覽）](plugins/samples/README.md#繁體中文)
```

- [ ] **Step 5: 更新第二階段待辦與 spec 狀態**

`docs/superpowers/plans/2026-10-15-plugin-system-phase-2-backlog.md`：

1. 在 1a 那行引言之後加一行：

```markdown
> 2026-10-15：插件載入 1b（[計畫](2026-10-15-plugin-loading-1b-gui-management.md)）已處理設定頁插件面板的項目，以及「面板沒有取消正在執行的命令的按鈕」，並從下方移除。
```

2. 刪除整個 `### 設定頁插件面板（\`apps/desktop/src/renderer/settings\`）`小節（標題與底下五個項目，包括「錯誤處理」的兩個子項）。1b 的對應：每列各自的忙碌狀態（Task 9）、通知改在主程序收集（Task 3`PluginNotices`、Task 8 `plugins:notices`）、顯示嚴重程度與遞增 id（Task 9）、`readableError` 與新的 state 事件會清掉要求失敗（Task 9）。
3. 刪除「第二階段範圍，第一階段刻意不做」清單裡的 `- 面板沒有取消正在執行的命令的按鈕；協定和 supervisor 已經支援取消。`
4. 其餘項目保留，包括高優先表格的 `resume()`／`#forced` 那列與「轉送到 console 的插件輸出沒有清理」。

`docs/superpowers/specs/2026-10-15-plugin-loading-ux-design.md` 第 4 行的狀態改成：

```markdown
狀態：Claude 與 Codex 已達成共識，使用者已核准設計方向。實作分成兩份計畫：1a 執行層強化（已完成）、1b 圖形介面管理（[計畫](../plans/2026-10-15-plugin-loading-1b-gui-management.md)）。
```

- [ ] **Step 6: 格式檢查文件**

Run: `pnpm exec prettier --write plugins/samples/README.md docs/en/architecture.md docs/zh-TW/architecture.md README.md README.zh-TW.md docs/superpowers/plans/2026-10-15-plugin-system-phase-2-backlog.md docs/superpowers/specs/2026-10-15-plugin-loading-ux-design.md && pnpm exec prettier --check plugins/samples/README.md docs/en/architecture.md docs/zh-TW/architecture.md README.md README.zh-TW.md docs/superpowers/plans/2026-10-15-plugin-system-phase-2-backlog.md docs/superpowers/specs/2026-10-15-plugin-loading-ux-design.md`
Expected: 全部通過。Prettier 會重新對齊表格欄寬，這是預期的。

再確認文件裡的錨點仍然有效：

Run: `grep -n "## Plugins (development preview)" docs/en/architecture.md && grep -n "## 插件（開發預覽）" docs/zh-TW/architecture.md && grep -n "## 繁體中文" plugins/samples/README.md`
Expected: 三個標題各出現一次。

- [ ] **Step 7: 最終驗證**

Run:

```bash
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false
pnpm -r build
pnpm check
pnpm test
pnpm exec prettier --check $(git ls-files '*.ts' '*.tsx' '*.mjs' '*.md' '*.json' '*.css')
pnpm test:plugins:smoke
pnpm test:desktop:smoke
```

Expected：

- `pnpm -r build`、`pnpm check`、`pnpm test` 全部通過，沒有失敗或跳過的新測試（Task 4 的真 Python 測試在沒有 Python 3.10+ 的機器上會跳過，這是預期的）。
- Prettier 檢查通過。`plugins/samples/hello-python/main.py` 不在檢查範圍內，它的未提交修改與 1b 無關，不要動它。
- `pnpm test:plugins:smoke` 最後兩行是 `PASS plugins: …` 與 `PASS plugin GUI: …`。
- `pnpm test:desktop:smoke` 通過（Task 9 已在 `tests/desktop/preload.cjs` 補上 `plugins` stub，橫幅不會讓 smoke 當掉）。

任何一項失敗：回到負責那個檔案的 task 修正，不要在這一步臨時改程式碼。

- [ ] **Step 8: Commit**

```bash
git add plugins/samples/README.md docs/en/architecture.md docs/zh-TW/architecture.md README.md README.zh-TW.md docs/superpowers/plans/2026-10-15-plugin-system-phase-2-backlog.md docs/superpowers/specs/2026-10-15-plugin-loading-ux-design.md
git commit -m "docs: describe GUI plugin management and move launch options to advanced use"
```
