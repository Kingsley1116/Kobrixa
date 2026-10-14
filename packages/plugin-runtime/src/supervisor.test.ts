import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcPeer } from "@kobrixa/plugin-protocol";
import { PluginSupervisor, spawnPluginProcess, type LaunchablePlugin } from "./index.js";
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
  it("stops a real process that ignores shutdown and SIGTERM within a bounded time", async () => {
    const fixture = fileURLToPath(new URL("../test-fixtures/stubborn-plugin.cjs", import.meta.url));
    const supervisor = new PluginSupervisor(
      plugin,
      () =>
        spawnPluginProcess(process.execPath, [fixture], { cwd: process.cwd(), killGraceMs: 200 }),
      { locale: "en", onNotice: () => {}, stopTimeoutMs: 200 },
    );
    await supervisor.executeCommand("acme.hello.greet");
    const started = Date.now();
    await supervisor.stop();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(supervisor.state).toBe("idle");
  });
  it("does not wait for a pending handshake when stopping", async () => {
    const fixture = fileURLToPath(new URL("../test-fixtures/stubborn-plugin.cjs", import.meta.url));
    const supervisor = new PluginSupervisor(
      plugin,
      () =>
        spawnPluginProcess(process.execPath, [fixture, "silent"], {
          cwd: process.cwd(),
          killGraceMs: 200,
        }),
      { locale: "en", onNotice: () => {}, stopTimeoutMs: 200 },
    );
    // Attach the rejection assertion now: the command rejects while stop() is still running.
    const command = expect(supervisor.executeCommand("acme.hello.greet")).rejects.toBeDefined();
    await vi.waitFor(() => expect(supervisor.state).toBe("starting"));
    const started = Date.now();
    await supervisor.stop();
    expect(Date.now() - started).toBeLessThan(3000); // initializeTimeoutMs is 10 s.
    await command;
  });
  it("force-kills immediately when the overall deadline is reached", async () => {
    const fixture = fileURLToPath(new URL("../test-fixtures/stubborn-plugin.cjs", import.meta.url));
    const supervisor = new PluginSupervisor(
      plugin,
      () =>
        spawnPluginProcess(process.execPath, [fixture], {
          cwd: process.cwd(),
          killGraceMs: 60_000,
        }),
      { locale: "en", onNotice: () => {}, stopTimeoutMs: 60_000 },
    );
    await supervisor.executeCommand("acme.hello.greet");
    const started = Date.now();
    const stopping = supervisor.stop();
    supervisor.forceKill();
    await stopping;
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
