import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import {
  PluginManager,
  spawnPluginProcess,
  type PluginManagerEvent,
  type PluginStateStore,
} from "./index.js";
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
  it("persists concurrent changes without losing one", async () => {
    const store = memoryStore();
    const manager = await create([await devPlugin("a"), await devPlugin("b")], store);
    await Promise.all([manager.setEnabled("acme.a", false), manager.setEnabled("acme.b", false)]);
    expect(store.saved.at(-1)).toEqual(["acme.a", "acme.b"]);
    expect(await store.load()).toEqual(new Set(["acme.a", "acme.b"]));
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
  it("resumes after a shutdown that did not end the app", async () => {
    const manager = await create([await devPlugin("a")]);
    await manager.executeCommand("acme.a.greet");
    await manager.shutdown();
    expect(await manager.setEnabled("acme.a", false)).toMatchObject({ code: "PLUGIN_E_DISABLED" });
    await manager.resume();
    expect(await manager.executeCommand("acme.a.greet")).toEqual({ ok: true });
    expect(launcher).toHaveBeenCalledTimes(2); // Restarted lazily by the new command.
    expect(await manager.setEnabled("acme.a", false)).toMatchObject({ ok: true });
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
    const manager = await PluginManager.create({
      sources: [await devPlugin("slow")],
      store: memoryStore(),
      safeMode: false,
      launcher: stubborn,
      locale: "en",
      supervisor: { stopTimeoutMs: 200 },
    });
    await manager.executeCommand("acme.slow.greet");
    const disabling = manager.setEnabled("acme.slow", false);
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
});
