import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcPeer } from "@kobrixa/plugin-protocol";
import {
  PluginSupervisor,
  spawnPluginProcess,
  type LaunchablePlugin,
  type PluginProcess,
  type SupervisorState,
} from "./index.js";
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
  it.each(["incompatible", "timeout"] as const)(
    "waits for exit after %s initialization before allowing another launch",
    async (failure) => {
      vi.useFakeTimers();
      const first = memoryPlugin((peer) =>
        peer.handle("initialize", () =>
          failure === "timeout"
            ? new Promise(() => {})
            : { apiVersion: "2.0.0", sdk: { name: "test", version: "1" } },
        ),
      );
      let exited = false;
      first.process.onExit(() => {
        exited = true;
      });
      const kill = vi.fn(() => {
        if (kill.mock.calls.length === 1) setTimeout(() => first.process.kill(), 100);
      });
      const launcher = vi
        .fn(async () => memoryPlugin((peer, { exit }) => ready(peer, exit)).process)
        .mockResolvedValueOnce({ ...first.process, kill });
      const supervisor = new PluginSupervisor(plugin, launcher, {
        locale: "en",
        onNotice: () => {},
        initializeTimeoutMs: 10,
      });
      const firstCommand = supervisor.executeCommand("acme.hello.greet");
      const firstAssertion = expect(firstCommand).rejects.toMatchObject({
        code: "PLUGIN_E_HANDSHAKE",
      });
      let settled = false;
      void firstCommand.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await vi.advanceTimersByTimeAsync(10);
        expect(kill).toHaveBeenCalledTimes(1);
        expect(exited).toBe(false);
        expect(settled).toBe(false);
        const secondAssertion = expect(
          supervisor.executeCommand("acme.hello.greet"),
        ).rejects.toMatchObject({ code: "PLUGIN_E_HANDSHAKE" });
        await vi.advanceTimersByTimeAsync(0);
        expect(launcher).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(100);
        await Promise.all([firstAssertion, secondAssertion]);
        expect(exited).toBe(true);
        expect(supervisor.state).toBe("idle");
        await supervisor.executeCommand("acme.hello.greet");
        expect(launcher).toHaveBeenCalledTimes(2);
      } finally {
        await vi.advanceTimersByTimeAsync(100);
        await firstAssertion;
        await supervisor.stop();
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );
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
  it("rejects a command interrupted by stop as disabled", async () => {
    const { supervisor } = setup();
    await supervisor.executeCommand("acme.hello.greet");
    const command = expect(supervisor.executeCommand("acme.hello.hang")).rejects.toMatchObject({
      code: "PLUGIN_E_DISABLED",
      message: "acme.hello was stopped.",
    });
    // Allow the command request to reach the plugin before stopping it.
    await Promise.resolve();
    await Promise.all([supervisor.stop(), command]);
    expect(supervisor.state).toBe("idle");
  });
  it("retains the stop cause when the exit-report deadline clears the stopping flag", async () => {
    vi.useFakeTimers();
    const launched = memoryPlugin((peer, { exit }) => ready(peer, exit));
    const supervisor = new PluginSupervisor(
      plugin,
      async () => ({ ...launched.process, onExit: () => () => {}, kill: vi.fn() }),
      { locale: "en", onNotice: () => {}, stopTimeoutMs: 10, exitTimeoutMs: 20 },
    );
    await supervisor.executeCommand("acme.hello.greet");
    const command = supervisor.executeCommand("acme.hello.hang").catch((error: unknown) => error);
    await Promise.resolve();
    const stopping = supervisor.stop();
    await vi.advanceTimersByTimeAsync(30);
    await stopping;
    expect(await command).toMatchObject({
      code: "PLUGIN_E_DISABLED",
      message: "acme.hello was stopped.",
    });
    expect(supervisor.state).toBe("idle");
    expect(vi.getTimerCount()).toBe(0);
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
    let child: PluginProcess | undefined;
    const supervisor = new PluginSupervisor(
      plugin,
      async () => {
        child = await spawnPluginProcess(process.execPath, [fixture, "silent"], {
          cwd: process.cwd(),
          killGraceMs: 200,
        });
        return child;
      },
      { locale: "en", onNotice: () => {}, stopTimeoutMs: 200 },
    );
    // Attach the rejection assertion now: the command rejects while stop() is still running.
    const command = expect(supervisor.executeCommand("acme.hello.greet")).rejects.toMatchObject({
      code: "PLUGIN_E_DISABLED",
    });
    await vi.waitFor(() => expect(child?.stderrTail()).toContain("initialize pending"));
    expect(supervisor.state).toBe("starting");
    const started = Date.now();
    await Promise.all([supervisor.stop(), command]);
    expect(Date.now() - started).toBeLessThan(3000); // initializeTimeoutMs is 10 s.
  });
  it("does not run commands when initialize completes after stop begins", async () => {
    const fixture = fileURLToPath(new URL("../test-fixtures/stubborn-plugin.cjs", import.meta.url));
    const states: SupervisorState[] = [];
    const sent: string[] = [];
    let child: PluginProcess | undefined;
    let initialized = false;
    const supervisor = new PluginSupervisor(
      plugin,
      async () => {
        const launched = await spawnPluginProcess(process.execPath, [fixture, "slow-initialize"], {
          cwd: process.cwd(),
          killGraceMs: 1000,
        });
        child = launched;
        launched.onMessage(() => {
          initialized = true;
        });
        return {
          ...launched,
          send: (text) => {
            sent.push((JSON.parse(text) as { method: string }).method);
            launched.send(text);
          },
        };
      },
      {
        locale: "en",
        onNotice: () => {},
        onStateChange: () => states.push(supervisor.state),
        stopTimeoutMs: 200,
      },
    );
    const command = supervisor.executeCommand("acme.hello.greet").catch((error: unknown) => error);
    try {
      // SIGTERM must already be ignored, and initialize must be pending, before stop begins.
      await vi.waitFor(() => expect(child?.stderrTail()).toContain("initialize pending"));
      expect(supervisor.state).toBe("starting");
      expect(initialized).toBe(false);
      await Promise.all([supervisor.stop(), command]);
      expect(await command).toMatchObject({ code: "PLUGIN_E_DISABLED" });
      if (process.platform !== "win32") expect(initialized).toBe(true);
      expect(states).toEqual(["starting", "stopping", "idle"]);
      expect(sent).toEqual(["initialize"]);
      expect(supervisor.state).toBe("idle");
    } finally {
      supervisor.forceKill();
      await supervisor.stop();
    }
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
