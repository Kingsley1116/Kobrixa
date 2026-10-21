import type {
  Stage3ChannelContext,
  Stage3RuntimePorts,
  Stage3HostAttachment,
} from "./ui-lifecycle.js";
import { appendFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { DIAGNOSTIC_HELP_LIMITS } from "@kobrixa/plugin-protocol";
import {
  developmentSourceKey,
  PLUGIN_FORCE_MARGIN_MS,
  PLUGIN_SHUTDOWN_DEADLINE_MS,
  PluginManager,
  PluginSupervisor,
  spawnPluginProcess,
  type PluginManagerEvent,
  type PluginPersistedState,
  type PluginProcess,
  type PluginStateStore,
} from "./index.js";
import { memoryPlugin } from "./test-process.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-manager-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));
afterEach(() => vi.useRealTimers());

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
  policy: "required" as const,
  resources: {},
  manifest: {
    id: "kobrixa.basic-plus",
    version: "1.0.0",
    apiVersion: "^1.0.0",
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
    },
  },
};
const builtinBackend = {
  kind: "builtin" as const,
  policy: "required" as const,
  resources: {},
  manifest: {
    id: "test.back",
    version: "1.0.0",
    apiVersion: "^1.1.0",
    runtime: { kind: "builtin" },
    contributes: {
      backends: [{ target: "test-vm", ir: { min: 1, max: 1 }, capabilities: {}, artifacts: [] }],
    },
  },
};
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
  it.each([true, false])(
    "migrates a disabled identity atomically with its alias present: %s",
    async (present) => {
      const alias = { kind: "development" as const, directory: path.join(root, "alias") };
      const canonical = { kind: "development" as const, directory: path.join(root, "canonical") };
      const unrelated = "dev:1111111111111111";
      const store = memoryStore([keyOf(alias), unrelated], ["acme.legacy"]);
      const manager = await create(present ? [alias] : [], store, true);
      const save = vi.spyOn(store, "save").mockRejectedValueOnce(new Error("Disk unavailable."));
      expect(await manager.migrateSourceDisable(keyOf(alias), keyOf(canonical))).toMatchObject({
        ok: false,
        code: "PLUGIN_E_STATE_SAVE",
      });
      expect([...(await store.load()).disabled]).toEqual([keyOf(alias), unrelated]);
      if (present)
        expect(manager.state().plugins[0]).toMatchObject({
          sourceKey: keyOf(alias),
          disabledBy: "user",
        });
      expect(await manager.migrateSourceDisable(keyOf(alias), keyOf(canonical))).toMatchObject({
        ok: true,
      });
      expect(save).toHaveBeenCalledTimes(2);
      expect([...(await store.load()).disabled].sort()).toEqual(
        [keyOf(canonical), unrelated].sort(),
      );
      expect([...(await store.load()).legacyDisabledIds]).toEqual(["acme.legacy"]);
      // Later ordinary saves must use the migrated set, not revive the alias.
      if (present) await manager.removeSource(keyOf(alias), { forget: false });
      await manager.addSource(canonical);
      expect(manager.state().plugins).toMatchObject([
        { sourceKey: keyOf(canonical), disabledBy: "user" },
      ]);
      await manager.removeSource(keyOf(canonical));
      expect([...(await store.load()).disabled]).toEqual([unrelated]);
    },
  );

  it("migrates a disable held only in memory after a failed user-disable save", async () => {
    const source = await devPlugin("hello");
    const target = developmentSourceKey(path.join(root, "canonical"));
    const store = memoryStore();
    const manager = await create([source], store, true);
    vi.spyOn(store, "save").mockRejectedValueOnce(new Error("Disk unavailable."));
    expect(await manager.setEnabled(keyOf(source), false)).toMatchObject({
      ok: true,
      persisted: false,
    });
    expect(await manager.migrateSourceDisable(keyOf(source), target)).toMatchObject({ ok: true });
    expect([...(await store.load()).disabled]).toEqual([target]);
  });

  it("refuses disable migration outside safe mode", async () => {
    const source = await devPlugin("hello");
    const store = memoryStore([keyOf(source)]);
    const manager = await create([source], store);
    expect(
      await manager.migrateSourceDisable(
        keyOf(source),
        developmentSourceKey(path.join(root, "canonical")),
      ),
    ).toMatchObject({ ok: false, code: "PLUGIN_E_SAFE_MODE" });
    expect(store.saved).toEqual([]);
  });

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
    const manager = await create([
      { kind: "builtin", policy: "required", resources: {}, manifest },
    ]);
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
  it("routes commands, tags notices with the channel's plugin id and resolves frontends", async () => {
    const hello = await devPlugin("hello");
    const manager = await create([builtin, builtinBackend, hello]);
    const events: PluginManagerEvent[] = [];
    manager.onEvent((event) => events.push(event));
    expect(manager.resolveCompiler("bp", "missing")).toMatchObject({
      ok: false,
      code: "BUILD1001",
    });
    expect(manager.resolveCompiler("bp", "test-vm").ok).toBe(true);
    await expect(manager.executeCommand("acme.hello.greet")).resolves.toEqual({ ok: true });
    expect(events).toContainEqual({
      type: "notice",
      notice: {
        pluginId: "acme.hello",
        sourceKey: keyOf(hello),
        severity: "info",
        message: "hi",
        at: 1000,
      },
    });
    expect(manager.state().plugins.find((p) => p.id === "acme.hello")).toMatchObject({
      running: true,
      status: "enabled",
    });
  });
  it("does not register contributions or launch disabled plugins", async () => {
    const hello = await devPlugin("hello");
    const manager = await create([hello], memoryStore([keyOf(hello)]));
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
    const hello = await devPlugin("hello");
    const manager = await create([hello], store);
    await manager.executeCommand("acme.hello.greet");
    const disabled = await manager.setEnabled(keyOf(hello), false);
    expect(disabled).toMatchObject({ ok: true });
    expect(savedDisabled(store)).toEqual([[keyOf(hello)]]);
    expect(await manager.executeCommand("acme.hello.greet")).toMatchObject({
      code: "PLUGIN_E_UNKNOWN_COMMAND",
    });
    await manager.setEnabled(keyOf(hello), true);
    expect(await manager.executeCommand("acme.hello.greet")).toEqual({ ok: true });
  });
  it("isolates throwing listeners during disable and shutdown", async () => {
    const a = await devPlugin("a");
    const b = await devPlugin("b");
    const manager = await create([a, b]);
    await manager.executeCommand("acme.a.greet");
    await manager.executeCommand("acme.b.greet");
    const events: PluginManagerEvent[] = [];
    manager.onEvent(() => {
      throw new Error("listener failed");
    });
    manager.onEvent((event) => events.push(event));

    await expect(manager.setEnabled(keyOf(a), false)).resolves.toMatchObject({ ok: true });
    expect(events).toContainEqual({ type: "state", state: manager.state() });
    events.length = 0;
    await expect(manager.executeCommand("acme.b.greet")).resolves.toEqual({ ok: true });
    expect(events).toContainEqual({
      type: "notice",
      notice: {
        pluginId: "acme.b",
        sourceKey: keyOf(b),
        severity: "info",
        message: "hi",
        at: 1000,
      },
    });
    await expect(manager.shutdown()).resolves.toBeUndefined();
    expect(manager.active).toBe(false);
    expect(events).toContainEqual({ type: "state", state: manager.state() });
  });
  it("lets safe mode persist a disable but refuses to enable", async () => {
    const store = memoryStore();
    const hello = await devPlugin("hello");
    const manager = await create([hello], store, true);
    expect(manager.state().plugins[0]).toMatchObject({
      id: "hello",
      sourceKey: keyOf(hello),
      status: "disabled",
      disabledBy: "safe-mode",
      commands: [],
    });
    expect(await manager.setEnabled(keyOf(hello), true)).toMatchObject({
      ok: false,
      code: "PLUGIN_E_SAFE_MODE",
      message: "Restore plugins first, or restart without --safe-mode.",
    });
    expect(await manager.setEnabled(keyOf(hello), false)).toMatchObject({ ok: true });
    expect(savedDisabled(store)).toEqual([[keyOf(hello)]]);
  });
  it("refuses to disable built-in plugins and unknown ids", async () => {
    const manager = await create([builtin]);
    expect(await manager.setEnabled("builtin:kobrixa.basic-plus", false)).toMatchObject({
      code: "PLUGIN_E_BUILTIN_REQUIRED",
    });
    expect(await manager.setEnabled("dev:ffffffffffffffff", false)).toMatchObject({
      code: "PLUGIN_E_UNKNOWN_PLUGIN",
    });
  });
  it("persists concurrent changes without losing one", async () => {
    const store = memoryStore();
    const a = await devPlugin("a");
    const b = await devPlugin("b");
    const manager = await create([a, b], store);
    await Promise.all([manager.setEnabled(keyOf(a), false), manager.setEnabled(keyOf(b), false)]);
    expect(savedDisabled(store).at(-1)).toEqual([keyOf(a), keyOf(b)].sort());
    expect([...(await store.load()).disabled].sort()).toEqual([keyOf(a), keyOf(b)].sort());
  });
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
  it("stops every running plugin on shutdown and refuses new commands", async () => {
    const manager = await create([await devPlugin("a"), await devPlugin("b")]);
    await manager.executeCommand("acme.a.greet");
    await manager.executeCommand("acme.b.greet");
    expect(manager.active).toBe(true);
    await manager.shutdown();
    expect(manager.state().plugins.every((plugin) => !plugin.running)).toBe(true);
    expect(manager.active).toBe(false);
    expect(await manager.executeCommand("acme.a.greet")).toMatchObject({
      code: "PLUGIN_E_DISABLED",
    });
  });
  it("clears the shutdown race timer after a graceful stop", async () => {
    vi.useFakeTimers();
    const manager = await create([await devPlugin("hello")]);
    await manager.executeCommand("acme.hello.greet");

    await manager.shutdown();

    expect(manager.active).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("clears the shutdown race timer after a forced stop", async () => {
    vi.useFakeTimers();
    const plugin = memoryPlugin((peer) => {
      peer.handle("initialize", () => ({ apiVersion: "1.0.0", sdk: { name: "t", version: "1" } }));
      peer.handle("command/execute", () => null);
      peer.handle("shutdown", () => new Promise(() => {}));
    });
    const manager = await PluginManager.create({
      sources: [await devPlugin("stubborn")],
      store: memoryStore(),
      safeMode: false,
      launcher: async () => plugin.process,
      locale: "en",
      supervisor: { stopTimeoutMs: 60_000 },
    });
    await manager.executeCommand("acme.stubborn.greet");

    const shutdown = manager.shutdown();
    await vi.advanceTimersByTimeAsync(3000);
    await shutdown;

    expect(plugin.killed()).toBe(true);
    expect(manager.active).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("resumes after a shutdown that did not end the app", async () => {
    const a = await devPlugin("a");
    const manager = await create([a]);
    await manager.executeCommand("acme.a.greet");
    await manager.shutdown();
    expect(await manager.setEnabled(keyOf(a), false)).toMatchObject({
      code: "PLUGIN_E_SHUTTING_DOWN",
    });
    await manager.resume();
    expect(await manager.executeCommand("acme.a.greet")).toEqual({ ok: true });
    expect(launcher).toHaveBeenCalledTimes(2); // Restarted lazily by the new command.
    expect(await manager.setEnabled(keyOf(a), false)).toMatchObject({ ok: true });
  });
  it("resumes after a rejected shutdown and allows commands and state changes again", async () => {
    const a = await devPlugin("a");
    const manager = await create([a]);
    const stop = vi
      .spyOn(PluginSupervisor.prototype, "stop")
      .mockRejectedValueOnce(new Error("stop failed"));
    try {
      await expect(manager.shutdown()).rejects.toThrow("stop failed");
    } finally {
      stop.mockRestore();
    }
    expect(await manager.executeCommand("acme.a.greet")).toMatchObject({
      code: "PLUGIN_E_DISABLED",
    });
    await expect(manager.resume()).resolves.toBeUndefined();
    expect(launcher).not.toHaveBeenCalled();
    expect(await manager.executeCommand("acme.a.greet")).toEqual({ ok: true });
    expect(await manager.setEnabled(keyOf(a), false)).toMatchObject({ ok: true });
    await expect(manager.shutdown()).resolves.toBeUndefined();
  });
  it("waits for a forced stop to finish before resuming commands", async () => {
    vi.useFakeTimers();
    const stubborn = memoryPlugin((peer) => {
      peer.handle("initialize", () => ({ apiVersion: "1.0.0", sdk: { name: "t", version: "1" } }));
      peer.handle("command/execute", () => null);
      peer.handle("shutdown", () => new Promise(() => {}));
    });
    const forceKill = vi.fn(() => setTimeout(() => stubborn.process.forceKill(), 50));
    const launch = vi.fn(launcher).mockResolvedValueOnce({ ...stubborn.process, forceKill });
    const manager = await PluginManager.create({
      sources: [await devPlugin("hello")],
      store: memoryStore(),
      safeMode: false,
      launcher: launch,
      locale: "en",
      supervisor: { stopTimeoutMs: 100, exitTimeoutMs: 100 },
    });
    await manager.executeCommand("acme.hello.greet");
    const shutdown = manager.shutdown(10);
    await vi.advanceTimersByTimeAsync(10);
    await shutdown;
    expect(forceKill).toHaveBeenCalledTimes(1);

    const resumed = manager.resume();
    const command = resumed.then(() => manager.executeCommand("acme.hello.greet"));
    expect(launch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(await command).toEqual({ ok: true });
    expect(launch).toHaveBeenCalledTimes(2);
    await manager.shutdown();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["running", "launching"] as const)(
    "does not reuse a forced stop for a %s plugin after resuming",
    async (state) => {
      vi.useFakeTimers();
      const stubborn = memoryPlugin((peer) => {
        peer.handle("initialize", () => ({
          apiVersion: "1.0.0",
          sdk: { name: "t", version: "1" },
        }));
        peer.handle("command/execute", () => null);
        peer.handle("shutdown", () => new Promise(() => {}));
      });
      const gracefulShutdown = vi.fn(() => null);
      const restarted = memoryPlugin((peer, { exit }) => {
        peer.handle("initialize", () => ({
          apiVersion: "1.0.0",
          sdk: { name: "t", version: "1" },
        }));
        peer.handle("command/execute", () => null);
        peer.handle("shutdown", gracefulShutdown);
        peer.onNotification("exit", () => exit(0));
      });
      const forceKill = vi.spyOn(restarted.process, "forceKill");
      let finishLaunch!: (child: PluginProcess) => void;
      const launch = vi
        .fn(() => new Promise<PluginProcess>((resolve) => (finishLaunch = resolve)))
        .mockResolvedValueOnce(stubborn.process);
      const manager = await PluginManager.create({
        sources: [await devPlugin("hello")],
        store: memoryStore(),
        safeMode: false,
        launcher: launch,
        locale: "en",
        supervisor: { stopTimeoutMs: 100, exitTimeoutMs: 100 },
      });
      await manager.executeCommand("acme.hello.greet");
      const first = manager.shutdown(10);
      await vi.advanceTimersByTimeAsync(1);
      await first;
      expect(stubborn.killed()).toBe(true);
      await manager.resume();
      expect(launch).toHaveBeenCalledTimes(1);

      const command = manager.executeCommand("acme.hello.greet");
      if (state === "running") {
        // This case checks graceful shutdown after resume; only launching reads #forced.
        finishLaunch(restarted.process);
        expect(await command).toEqual({ ok: true });
      }
      const second = manager.shutdown();
      if (state === "launching") {
        finishLaunch(restarted.process);
        expect(await command).toMatchObject({ code: "PLUGIN_E_DISABLED" });
      }
      await second;
      expect(forceKill).not.toHaveBeenCalled();
      if (state === "running") {
        expect(gracefulShutdown).toHaveBeenCalledTimes(1);
        expect(restarted.killed()).toBe(false);
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("does not force a resumed launch of a plugin that stopped before another was forced", async () => {
    vi.useFakeTimers();
    const a = await devPlugin("a");
    const b = await devPlugin("b");
    const stubborn = memoryPlugin((peer) => {
      peer.handle("initialize", () => ({ apiVersion: "1.0.0", sdk: { name: "t", version: "1" } }));
      peer.handle("command/execute", () => null);
      peer.handle("shutdown", () => new Promise(() => {}));
    });
    const forceB = vi.spyOn(stubborn.process, "forceKill");
    let finishLaunch!: (child: PluginProcess) => void;
    const launchA = vi
      .fn(() => new Promise<PluginProcess>((resolve) => (finishLaunch = resolve)))
      .mockResolvedValueOnce(await launcher());
    const manager = await PluginManager.create({
      sources: [a, b],
      store: memoryStore(),
      safeMode: false,
      launcher: (plugin) =>
        plugin.id === "acme.a" ? launchA() : Promise.resolve(stubborn.process),
      locale: "en",
      supervisor: { stopTimeoutMs: 60_000 },
    });
    await manager.executeCommand("acme.a.greet");
    await manager.executeCommand("acme.b.greet");
    const first = manager.shutdown();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.state().plugins.map((plugin) => plugin.running)).toEqual([false, false]);
    expect(manager.active).toBe(true); // B is still stopping; A has already finished.
    expect(forceB).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PLUGIN_SHUTDOWN_DEADLINE_MS - PLUGIN_FORCE_MARGIN_MS);
    await first;
    expect(forceB).toHaveBeenCalledOnce();
    await manager.resume();

    const restarted = await launcher();
    const killA = vi.spyOn(restarted, "kill");
    const forceA = vi.spyOn(restarted, "forceKill");
    const command = manager.executeCommand("acme.a.greet");
    expect(launchA).toHaveBeenCalledTimes(2);
    const second = manager.shutdown();
    finishLaunch(restarted);
    expect(await command).toMatchObject({ code: "PLUGIN_E_DISABLED" });
    await second;
    expect(killA).toHaveBeenCalledOnce();
    expect(forceA).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps tracking a plugin that is still being disabled", async () => {
    const stubborn = vi.fn(
      async () =>
        memoryPlugin((peer) => {
          peer.handle("initialize", () => ({
            apiVersion: "1.0.0",
            sdk: { name: "t", version: "1" },
          }));
          peer.handle("command/execute", () => null);
          // Never answers shutdown: stop() has to wait for its kill timeline (stopTimeoutMs).
          peer.handle("shutdown", () => new Promise(() => {}));
        }).process,
    );
    const slow = await devPlugin("slow");
    const manager = await PluginManager.create({
      sources: [slow],
      store: memoryStore(),
      safeMode: false,
      launcher: stubborn,
      locale: "en",
      supervisor: { stopTimeoutMs: 200 },
    });
    await manager.executeCommand("acme.slow.greet");
    const disabling = manager.setEnabled(keyOf(slow), false);
    // The supervisor has left the enabled map but its process is still stopping.
    await vi.waitFor(() => expect(manager.state().plugins[0]!.status).toBe("disabled"));
    expect(manager.active).toBe(true);
    await manager.shutdown();
    expect(manager.active).toBe(false);
    await expect(disabling).resolves.toMatchObject({ ok: true });
  });
  it("force-kills real processes that outlive the shutdown deadline", async () => {
    const fixture = fileURLToPath(new URL("../test-fixtures/stubborn-plugin.cjs", import.meta.url));
    let exited = false;
    const manager = await PluginManager.create({
      sources: [await devPlugin("stubborn")],
      store: memoryStore(),
      safeMode: false,
      locale: "en",
      // Neither a graceful stop nor kill escalation can finish before the deadline.
      supervisor: { stopTimeoutMs: 60_000 },
      launcher: async () => {
        const child = await spawnPluginProcess(process.execPath, [fixture], {
          cwd: process.cwd(),
          killGraceMs: 60_000,
        });
        child.onExit(() => (exited = true));
        return child;
      },
    });
    await manager.executeCommand("acme.stubborn.greet");
    const started = Date.now();
    await manager.shutdown(500);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(exited).toBe(true);
  });
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
        message: "Restore plugins first, or restart without --safe-mode.",
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
      let stopRequested!: () => void;
      const requested = new Promise<void>((resolve) => (stopRequested = resolve));
      let release!: () => void;
      const released = new Promise<null>((resolve) => (release = () => resolve(null)));
      let launches = 0;
      const slowStopLauncher = vi.fn(async () => {
        const first = launches++ === 0;
        return memoryPlugin((peer, { exit }) => {
          peer.handle("initialize", () => ({
            apiVersion: "1.0.0",
            sdk: { name: "t", version: "1" },
          }));
          peer.handle("command/execute", () => null);
          peer.handle("shutdown", () => {
            if (!first) return null;
            stopRequested();
            return released;
          });
          peer.onNotification("exit", () => exit(0));
        }).process;
      });
      const manager = await createWith([hello], slowStopLauncher);
      expect(await manager.executeCommand("acme.hello.greet")).toEqual({ ok: true });
      const reloading = manager.reloadSource(keyOf(hello));
      // The reload has retired the old supervisor and is waiting for it to stop.
      await requested;
      const shutdown = manager.shutdown();
      release();
      expect(await reloading).toMatchObject({ ok: false, code: "PLUGIN_E_SHUTTING_DOWN" });
      await shutdown;
      await manager.resume();
      expect(await manager.executeCommand("acme.hello.greet")).toEqual({ ok: true });
      await manager.shutdown();
    });
  });
});

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
    const enabled = manager.diagnosticHelp();
    expect(enabled.plugins).toEqual(first.plugins);
    expect(enabled.revision).toBeGreaterThan(disabled.revision);
    await writeHelp("one", [helpEntry("ACME200")]);
    await manager.reloadSource(keyOf(source));
    expect(manager.diagnosticHelp().plugins[0]!.entries[0]!.code).toBe("ACME200");
    expect(manager.diagnosticHelp().revision).toBeGreaterThan(enabled.revision);
    expect(manager.state().diagnosticHelpRevision).toBe(manager.diagnosticHelp().revision);
    expect(launcher).not.toHaveBeenCalled();
  });
  it.each(["enable", "disable", "remove"] as const)(
    "bumps the help revision when a plugin without help is changed: %s",
    async (action) => {
      const source = await devPlugin("plain");
      const manager = await create(
        [builtin, source],
        memoryStore(action === "enable" ? [keyOf(source)] : []),
      );
      const before = manager.state().diagnosticHelpRevision;
      const result =
        action === "remove"
          ? await manager.removeSource(keyOf(source))
          : await manager.setEnabled(keyOf(source), action === "enable");
      expect(result).toMatchObject({ ok: true });
      expect(manager.state().diagnosticHelpRevision).toBeGreaterThan(before);
      expect(manager.diagnosticHelp().plugins).toEqual([]);
    },
  );
  it("bumps the help revision when a plugin without help reloads with a new display name", async () => {
    const source = await devPlugin("plain");
    const file = path.join(source.directory, "kobrixa-plugin.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.displayName = { en: "Original", "zh-TW": "原名" };
    await writeFile(file, JSON.stringify(manifest));
    const manager = await create([source]);
    const before = manager.state().diagnosticHelpRevision;
    manifest.displayName = { en: "Renamed", "zh-TW": "新名" };
    await writeFile(file, JSON.stringify(manifest));
    expect(await manager.reloadSource(keyOf(source))).toMatchObject({ ok: true });
    expect(manager.state().plugins[0]!.displayName).toEqual(manifest.displayName);
    expect(manager.state().diagnosticHelpRevision).toBeGreaterThan(before);
    expect(manager.diagnosticHelp().plugins).toEqual([]);
  });
  it("keeps the help revision stable when an unrelated disabled plugin is removed", async () => {
    const source = await devPlugin("plain");
    const manager = await create([builtin, source], memoryStore([keyOf(source)]));
    const before = manager.state();
    expect(await manager.removeSource(keyOf(source))).toMatchObject({ ok: true });
    const after = manager.state();
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.plugins).toEqual(before.plugins.filter((plugin) => plugin.status === "enabled"));
    expect(after.diagnosticHelpRevision).toBe(before.diagnosticHelpRevision);
  });
  it("keeps the plugin enabled when its help file is invalid", async () => {
    const source = await helpPlugin("broken", "{");
    const manager = await createWith([source]);
    const summary = manager.state().plugins.find((item) => item.sourceKey === keyOf(source))!;
    expect(summary.status).toBe("enabled");
    expect(summary.problems.map((item) => item.code)).toEqual(["PLUGIN_E_DIAGNOSTIC_HELP"]);
    expect(summary.problems[0]!.message).toContain("help.json");
    expect(manager.diagnosticHelp().plugins).toEqual([]);
    await manager.setEnabled(keyOf(source), false);
    expect(manager.state().plugins[0]!.problems).toEqual([]);
  });
  it("does not read help in safe mode", async () => {
    const source = await helpPlugin("safe", [helpEntry("ACME100")]);
    const manager = await createWith([source], { safeMode: true });
    expect(manager.diagnosticHelp().plugins).toEqual([]);
    const revision = manager.diagnosticHelp().revision;
    expect(manager.state().plugins[0]).toMatchObject({
      id: "safe",
      status: "disabled",
      problems: [],
    });
    await manager.leaveSafeMode();
    expect(manager.diagnosticHelp().plugins[0]!.source).toBe("acme.safe");
    expect(manager.diagnosticHelp().revision).toBeGreaterThan(revision);
    expect(launcher).not.toHaveBeenCalled();
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
    await manager.setEnabled(keys[0]!, false);
    expect(manager.diagnosticHelp().plugins.map((item) => item.sourceKey)).toEqual(keys.slice(1));
    expect(manager.state().plugins.find((item) => item.sourceKey === keys[2])!.problems).toEqual(
      [],
    );
  });
  it("accepts exactly 8 MiB by default and rejects the plugin that adds one byte too many", async () => {
    const body = JSON.stringify({ entries: [helpEntry("ACME100")] });
    const size = Buffer.byteLength(body);
    const sources = await Promise.all(
      Array.from({ length: 9 }, (_, index) => helpPlugin(`limit${index}`, body)),
    );
    const sorted = [...sources].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1));
    await Promise.all(
      sorted
        .slice(0, 8)
        .map((source, index) =>
          writeFile(
            path.join(source.directory, "help.json"),
            body + " ".repeat(DIAGNOSTIC_HELP_LIMITS.fileBytes - size - (index === 7 ? size : 0)),
          ),
        ),
    );
    const manager = await createWith(sources.reverse());
    expect(manager.diagnosticHelp().plugins.map((item) => item.sourceKey)).toEqual(
      sorted.map(keyOf),
    );
    expect(manager.state().plugins.every((item) => item.problems.length === 0)).toBe(true);
    await appendFile(path.join(sorted[7]!.directory, "help.json"), " ");
    await manager.reloadSource(keyOf(sorted[7]!));
    expect(manager.diagnosticHelp().plugins.map((item) => item.sourceKey)).toEqual(
      sorted.slice(0, 8).map(keyOf),
    );
    expect(
      manager.state().plugins.find((item) => item.sourceKey === keyOf(sorted[8]!)),
    ).toMatchObject({
      status: "enabled",
      problems: [{ code: "PLUGIN_E_DIAGNOSTIC_HELP", message: expect.stringMatching(/8 MiB/) }],
    });
  });
  it("continues checking later plugins after a resource exceeds the remaining budget", async () => {
    const body = JSON.stringify({ entries: [helpEntry("ACME100")] });
    const size = Buffer.byteLength(body);
    const sources = await Promise.all(["a", "b", "c"].map((name) => helpPlugin(name, body)));
    const sorted = [...sources].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1));
    await writeFile(path.join(sorted[1]!.directory, "help.json"), body + " ".repeat(size));
    const manager = await createWith(sources, { diagnosticHelpTotalBytes: size * 2 });
    expect(manager.diagnosticHelp().plugins.map((item) => item.sourceKey)).toEqual([
      keyOf(sorted[0]!),
      keyOf(sorted[2]!),
    ]);
    expect(
      manager.state().plugins.find((item) => item.sourceKey === keyOf(sorted[1]!)),
    ).toMatchObject({
      status: "enabled",
      problems: [{ code: "PLUGIN_E_DIAGNOSTIC_HELP" }],
    });
  });
  it("removes stale help on an invalid reload and recovers when the resource is fixed", async () => {
    const source = await helpPlugin("one", [helpEntry("ACME100")]);
    const manager = await createWith([source]);
    const first = manager.diagnosticHelp();
    await writeHelp("one", "{");
    await manager.reloadSource(keyOf(source));
    const broken = manager.diagnosticHelp();
    expect(broken.plugins).toEqual([]);
    expect(broken.revision).toBeGreaterThan(first.revision);
    expect(manager.state().plugins[0]).toMatchObject({
      status: "enabled",
      problems: [{ code: "PLUGIN_E_DIAGNOSTIC_HELP" }],
    });
    await writeHelp("one", [helpEntry("ACME200")]);
    await manager.reloadSource(keyOf(source));
    expect(manager.diagnosticHelp().plugins[0]!.entries[0]!.code).toBe("ACME200");
    expect(manager.diagnosticHelp().revision).toBeGreaterThan(broken.revision);
    expect(manager.state().plugins[0]!.problems).toEqual([]);
  });
  it("removes and re-adds help atomically with the source's state events", async () => {
    const source = await helpPlugin("one", [helpEntry("ACME100")]);
    const manager = await createWith([source]);
    const first = manager.diagnosticHelp();
    const events: PluginManagerEvent[] = [];
    manager.onEvent((event) => events.push(event));
    await manager.removeSource(keyOf(source));
    const removed = manager.diagnosticHelp();
    expect(removed.plugins).toEqual([]);
    expect(removed.revision).toBeGreaterThan(first.revision);
    expect(events).toContainEqual({
      type: "state",
      state: expect.objectContaining({ diagnosticHelpRevision: removed.revision, plugins: [] }),
    });
    await manager.addSource(source);
    expect(manager.diagnosticHelp().plugins).toEqual(first.plugins);
    expect(manager.diagnosticHelp().revision).toBeGreaterThan(removed.revision);
  });
  it("returns isolated catalogs and bumps the revision when adding a plugin without help", async () => {
    const source = await helpPlugin("one", [helpEntry("ACME100")]);
    const manager = await createWith([source]);
    const first = manager.diagnosticHelp();
    const returned = manager.diagnosticHelp();
    returned.plugins[0]!.entries[0]!.steps.en.push("Changed");
    returned.plugins.length = 0;
    expect(manager.diagnosticHelp()).toEqual(first);
    await manager.addSource(await devPlugin("plain"));
    const added = manager.diagnosticHelp();
    expect(added.plugins).toEqual(first.plugins);
    expect(added.revision).toBeGreaterThan(first.revision);
    await manager.reloadSource(keyOf(source));
    expect(manager.diagnosticHelp().plugins).toEqual(first.plugins);
    expect(manager.diagnosticHelp().revision).toBeGreaterThan(added.revision);
    expect(launcher).not.toHaveBeenCalled();
  });
});

it("F20 optional builtin toggles persist without development mode; required stays enabled", async () => {
  const optional = {
    ...builtin,
    policy: "optional" as const,
    manifest: {
      id: "kobrixa.device-ev3",
      version: "1.0.0",
      apiVersion: "^1.5.0",
      runtime: { kind: "builtin" },
    },
  };
  const store = memoryStore();
  const manager = await create([{ ...builtin, policy: "required" as const }, optional], store);
  expect(manager.state().developmentMode).toBe(false);
  expect(
    manager.state().plugins.map(({ required, canToggle }) => ({ required, canToggle })),
  ).toEqual([
    { required: true, canToggle: false },
    { required: false, canToggle: true },
  ]);
  expect(await manager.setEnabled("builtin:kobrixa.basic-plus", false)).toMatchObject({
    ok: false,
    code: "PLUGIN_E_BUILTIN_REQUIRED",
  });
  expect(await manager.setEnabled("builtin:kobrixa.device-ev3", false)).toMatchObject({ ok: true });
  expect((await store.load()).disabled.has("builtin:kobrixa.device-ev3")).toBe(true);
  const reopened = await create([{ ...builtin, policy: "required" as const }, optional], store);
  expect(reopened.state().plugins[1]).toMatchObject({ status: "disabled", disabledBy: "user" });
  expect(await reopened.setEnabled("builtin:kobrixa.device-ev3", true)).toMatchObject({ ok: true });
  expect(await reopened.removeSource("builtin:kobrixa.device-ev3")).toMatchObject({
    ok: false,
    code: "PLUGIN_E_BUILTIN_REQUIRED",
  });
  // This optional provider-only source has no process supervisor to publish withdrawal.
  const reloadStates: string[] = [];
  const off = reopened.onEvent((event) => {
    if (event.type === "state") {
      const provider = event.state.plugins.find(
        (source) => source.sourceKey === "builtin:kobrixa.device-ev3",
      );
      if (provider) reloadStates.push(provider.status);
    }
  });
  try {
    expect(await reopened.reloadSource("builtin:kobrixa.device-ev3")).toMatchObject({ ok: true });
    const disabled = reloadStates.indexOf("disabled");
    expect(disabled).toBeGreaterThanOrEqual(0);
    expect(reloadStates.slice(disabled + 1)).toContain("enabled");
  } finally {
    off();
  }
  await Promise.all([manager.shutdown(), reopened.shutdown()]);
});

function stage3Fixture() {
  const contexts: Stage3ChannelContext[] = [];
  let manager: PluginManager;
  const disposition = { stopConfirmed: true, faultIds: [], journalCommitted: true };
  const stage3: Stage3RuntimePorts = {
    device: {
      retire: vi.fn(() => ({ drain: null, settled: Promise.resolve(disposition) })),
      retireProvider: vi.fn(async () => disposition),
      beginShutdown: vi.fn(async () => disposition),
    },
    persistence: resourceFreePersistence150(),
    ui: unavailableUi150(),
  };
  const host: Stage3HostAttachment = {
    hostEpoch: "00000000-0000-4000-8000-000000000001",
    principal: (owner) => ({ kind: "plugin", owner, authorityContext: null }),
    hasPermission: () => false,
    requirements: (owner) => manager.requirements(owner),
    bindChannel: vi.fn((context) => {
      contexts.push(context);
      return { initialized: async () => {}, ready: async () => {}, dispose: vi.fn() };
    }),
    retireResources: vi.fn(async (owner, reason) => {
      expect(manager.requirements(owner)).toBeNull();
      await retireStage3Owner(
        stage3,
        owner,
        reason,
        () => 100,
        async () => {
          throw new Error("No storage dispatch at P150");
        },
      );
    }),
  };
  return {
    stage3,
    host,
    contexts,
    assign(value: PluginManager) {
      manager = value;
    },
  };
}

import { retireStage3Owner, resourceFreePersistence150, unavailableUi150 } from "./ui-lifecycle.js";

it("F02 rejects partial manager stage3 options before touching sources or storage", async () => {
  const fixture = stage3Fixture();
  for (const pair of [{ stage3: fixture.stage3 }, { stage3Host: fixture.host }]) {
    const store = memoryStore();
    const load = vi.spyOn(store, "load");
    await expect(
      PluginManager.create({
        sources: [],
        store,
        launcher,
        locale: "en",
        safeMode: false,
        ...pair,
      }),
    ).rejects.toThrow("stage3 and stage3Host must be supplied together");
    expect(load).not.toHaveBeenCalled();
  }
});

it.each([false, true])(
  "F02 admits immutable full-tuple requirements and replaces process identity (requires: %s)",
  async (declared) => {
    const source = await devPlugin("owner");
    const file = path.join(source.directory, "kobrixa-plugin.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    if (declared)
      manifest.requires = { devices: [{ capability: "connection.v1", required: true }] };
    await writeFile(file, JSON.stringify(manifest));
    const fixture = stage3Fixture();
    const manager = await PluginManager.create({
      sources: [source],
      store: memoryStore(),
      launcher,
      locale: "en",
      safeMode: false,
      stage3: fixture.stage3,
      stage3Host: fixture.host,
    });
    fixture.assign(manager);
    const runtime = manager.stage3Runtime();
    expect(manager.stage3Runtime()).toBe(runtime);
    expect(Object.isFrozen(runtime)).toBe(true);
    const signal = new AbortController().signal;
    const [first, duplicate] = await Promise.all([
      runtime.activateInitialized(keyOf(source), signal),
      runtime.activateInitialized(keyOf(source), signal),
    ]);
    expect(first).toBe(duplicate);
    await runtime.ready(first.owner, signal);
    expect(launcher).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(first.owner)).toBe(true);
    const requirements = manager.requirements({ ...first.owner });
    expect(requirements).toEqual(declared ? [{ capability: "connection.v1", required: true }] : []);
    expect(Object.isFrozen(requirements)).toBe(true);
    if (declared) {
      expect(Object.isFrozen(requirements![0])).toBe(true);
      manifest.requires.devices[0].required = false;
      expect(requirements![0]!.required).toBe(true);
    }
    const foreign = { ...first.owner, processEpoch: "00000000-0000-4000-8000-000000000099" };
    expect(manager.requirements(foreign)).toBeNull();
    expect(runtime.current(foreign)).toBe(false);
    await expect(runtime.ready(foreign, signal)).rejects.toThrow("Retired ready owner");
    expect(runtime.owners()).toEqual([first.owner]);
    expect(runtime.commands(keyOf(source))).toEqual([]);
    await expect(runtime.dispatchDrain(first.owner, {} as never, signal)).rejects.toThrow(
      "unpublished",
    );
    expect(await manager.reloadSource(keyOf(source))).toMatchObject({ ok: true });
    expect(manager.requirements(first.owner)).toBeNull();
    expect(runtime.current(first.owner)).toBe(false);
    const second = await runtime.activateInitialized(keyOf(source), signal);
    await runtime.ready(second.owner, signal);
    expect(second.owner.hostEpoch).toBe(first.owner.hostEpoch);
    expect(second.owner.processEpoch).not.toBe(first.owner.processEpoch);
    expect(second.owner.generation).toBeGreaterThan(first.owner.generation);
    await manager.shutdown();
    expect(runtime.owners()).toEqual([]);
  },
);

it("F17 manager starts its process timer only after device and owner dispositions", async () => {
  const source = await devPlugin("drain");
  const fixture = stage3Fixture();
  const manager = await PluginManager.create({
    sources: [source],
    store: memoryStore(),
    launcher,
    locale: "en",
    safeMode: false,
    stage3: fixture.stage3,
    stage3Host: fixture.host,
  });
  fixture.assign(manager);
  const runtime = manager.stage3Runtime();
  const signal = new AbortController().signal;
  const context = await runtime.activateInitialized(keyOf(source), signal);
  await runtime.ready(context.owner, signal);
  let finish!: (value: {
    stopConfirmed: boolean;
    faultIds: string[];
    journalCommitted: boolean;
  }) => void;
  const barrier = {
    promise: new Promise<{ stopConfirmed: boolean; faultIds: string[]; journalCommitted: boolean }>(
      (resolve) => {
        finish = resolve;
      },
    ),
    resolve: (value: { stopConfirmed: boolean; faultIds: string[]; journalCommitted: boolean }) =>
      finish(value),
  };
  vi.mocked(fixture.stage3.device.beginShutdown).mockReturnValue(barrier.promise);
  vi.mocked(fixture.stage3.device.retire).mockReturnValue({
    drain: null,
    settled: barrier.promise,
  });
  const force = vi.spyOn(PluginSupervisor.prototype, "forceKill");
  vi.useFakeTimers();
  try {
    const shutdown = manager.shutdown(100);
    expect(fixture.host.retireResources).toHaveBeenCalledWith(context.owner, "shutdown");
    expect(runtime.current(context.owner)).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(context.peer.closed).toBe(false);
    expect(force).not.toHaveBeenCalled();
    barrier.resolve({
      stopConfirmed: false,
      faultIds: [context.owner.hostEpoch],
      journalCommitted: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    await shutdown;
    expect(context.peer.closed).toBe(true);
  } finally {
    force.mockRestore();
    vi.useRealTimers();
  }
});

it("F20 safe mode suppresses optional registration before any process launch", async () => {
  const fixture = stage3Fixture();
  const manager = await PluginManager.create({
    sources: [{ ...builtin, policy: "optional" }],
    store: memoryStore(),
    launcher,
    locale: "en",
    safeMode: true,
    stage3: fixture.stage3,
    stage3Host: fixture.host,
  });
  fixture.assign(manager);
  expect(manager.state().plugins[0]).toMatchObject({
    required: false,
    canToggle: true,
    status: "disabled",
  });
  await expect(
    manager
      .stage3Runtime()
      .activateInitialized("builtin:kobrixa.basic-plus", new AbortController().signal),
  ).rejects.toThrow("Source has no admitted process");
  expect(launcher).not.toHaveBeenCalled();
  await manager.shutdown();
});

it("F17 shutdown fences an idle source before waiting for device disposition", async () => {
  const source = await devPlugin("idleclose");
  const fixture = stage3Fixture();
  let finish!: () => void;
  vi.mocked(fixture.stage3.device.beginShutdown).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ stopConfirmed: true, faultIds: [], journalCommitted: true });
      }),
  );
  const manager = await PluginManager.create({
    sources: [source],
    store: memoryStore(),
    launcher,
    locale: "en",
    safeMode: false,
    stage3: fixture.stage3,
    stage3Host: fixture.host,
  });
  fixture.assign(manager);
  const shutdown = manager.shutdown();
  try {
    await expect(
      manager.stage3Runtime().activateInitialized(keyOf(source), new AbortController().signal),
    ).rejects.toThrow("shutting down");
    expect(launcher).not.toHaveBeenCalled();
  } finally {
    finish();
    await shutdown;
  }
});
