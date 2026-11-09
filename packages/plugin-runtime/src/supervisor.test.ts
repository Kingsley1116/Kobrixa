import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcPeer, ResourceOwner } from "@kobrixa/plugin-protocol";
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
  it("counts launch failures and latches the crash loop", async () => {
    const supervisor = new PluginSupervisor(
      plugin,
      async () => {
        throw new Error("python not found");
      },
      { locale: "en", onNotice: () => {} },
    );
    for (let index = 0; index < 4; index++)
      await expect(supervisor.executeCommand("acme.hello.greet")).rejects.toMatchObject({
        code: index < 2 ? "PLUGIN_E_LAUNCH" : "PLUGIN_E_CRASH_LOOP",
      });
    expect(supervisor.state).toBe("failed");
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
    expect(await first).toMatchObject({ code: "PLUGIN_E_TIMEOUT" });
    expect(supervisor.state).toBe("stopping");
    await expect(supervisor.executeCommand("acme.hello.greet")).rejects.toMatchObject({
      code: "PLUGIN_E_DISABLED",
    });
    expect(launcher).toHaveBeenCalledTimes(1);
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
    const stopping = expect(supervisor.stop("cancelled")).rejects.toMatchObject({
      code: "PLUGIN_E_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(30);
    await stopping;
    expect(await command).toMatchObject({ code: "PLUGIN_E_CANCELLED" });
    expect(supervisor.state).toBe("idle");
    finishLaunch(late.process);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.killed()).toBe(true);
  });
  it("retains the stop cause and fences replacement after the exit-report deadline", async () => {
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
    const stopping = expect(supervisor.stop()).rejects.toMatchObject({ code: "PLUGIN_E_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(30);
    await stopping;
    expect(await command).toMatchObject({
      code: "PLUGIN_E_DISABLED",
      message: "Plugin exit is not confirmed.",
    });
    expect(supervisor.state).toBe("stopping");
    await expect(supervisor.executeCommand("acme.hello.greet")).rejects.toMatchObject({
      code: "PLUGIN_E_DISABLED",
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("caps the total stop wait when a late launch never reports exit", async () => {
    vi.useFakeTimers();
    const launched = memoryPlugin((peer, { exit }) => ready(peer, exit));
    const supervisor = new PluginSupervisor(
      plugin,
      () =>
        new Promise<PluginProcess>((resolve) => {
          setTimeout(
            () => resolve({ ...launched.process, onExit: () => () => {}, kill: vi.fn() }),
            25,
          );
        }),
      { locale: "en", onNotice: () => {}, stopTimeoutMs: 10, exitTimeoutMs: 20 },
    );
    const command = supervisor.executeCommand("acme.hello.greet").catch((error: unknown) => error);
    let settled = false;
    const stopping = expect(supervisor.stop())
      .rejects.toMatchObject({ code: "PLUGIN_E_TIMEOUT" })
      .then(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(30);
    expect(settled).toBe(true);
    await stopping;
    expect(await command).toMatchObject({ code: "PLUGIN_E_DISABLED" });
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

it("F02 F17 channel identity is host allocated and stop waits for original disposition", async () => {
  const { PluginSupervisor: Supervisor } = await import("./supervisor.js");
  const { memoryPlugin: processFixture } = await import("./test-process.js");
  const owners: ResourceOwner[] = [];
  const owner = Object.freeze({
    sourceKey: "dev:0123456789abcdef",
    pluginId: "acme.probe",
    generation: 7,
    hostEpoch: "00000000-0000-4000-8000-000000000001",
    processEpoch: "00000000-0000-4000-8000-000000000002",
  });
  const calls: string[] = [];
  let finish!: () => void;
  const child = processFixture((peer, control) => {
    peer.handle("initialize", () => ({
      apiVersion: "1.5.0",
      sdk: { name: "fixture", version: "1" },
    }));
    peer.handle("command/execute", () => null);
    peer.handle("shutdown", () => {
      calls.push("shutdown");
      return null;
    });
    peer.onNotification("exit", () => control.exit());
  });
  const supervisor = new Supervisor(
    {
      id: "acme.probe",
      sourceKey: "dev:0123456789abcdef",
      directory: "/fixture",
      entry: "/fixture/main.cjs",
      runtime: "node",
      permissions: [],
      commands: ["acme.probe.run"],
    },
    async (plugin) => {
      expect(plugin.channelOwner).toBe(owner);
      return child.process;
    },
    {
      locale: "en",
      onNotice() {},
      resourceOwner: () => owner,
      hostEpoch: owner.hostEpoch,
      bindChannel(context) {
        owners.push(context.owner);
        return {
          async initialized(signal) {
            signal.throwIfAborted();
          },
          async ready(signal) {
            signal.throwIfAborted();
          },
          dispose() {
            calls.push("detach");
          },
        };
      },
      retireResources(owner, reason) {
        expect(owner).toBe(owners[0]);
        expect(reason).toBe("disable");
        calls.push("retire");
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
  );
  await supervisor.executeCommand("acme.probe.run");
  expect(owners[0]).toMatchObject({ generation: 7, pluginId: "acme.probe" });
  expect(owners[0]!.processEpoch).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  const stop = supervisor.stop();
  expect(calls).toEqual(["retire"]);
  await Promise.resolve();
  expect(child.killed()).toBe(false);
  finish();
  await stop;
  expect(calls).toEqual(["retire", "shutdown", "detach"]);
});

const channelOwner = Object.freeze({
  sourceKey: "dev:0123456789abcdef",
  pluginId: "acme.hello",
  generation: 1,
  hostEpoch: "00000000-0000-4000-8000-000000000001",
  processEpoch: "00000000-0000-4000-8000-000000000002",
});
const latch = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

it.each(["resourceOwner", "hostEpoch", "bindChannel", "retireResources"] as const)(
  "F02 rejects partial supervisor options missing %s",
  (missing) => {
    const options = {
      resourceOwner: () => channelOwner,
      hostEpoch: channelOwner.hostEpoch,
      bindChannel: () => ({ initialized: async () => {}, ready: async () => {}, dispose() {} }),
      retireResources: async () => {},
    };
    Reflect.deleteProperty(options, missing);
    expect(() => setup(options)).toThrow("Stage 3 supervisor options must be supplied together");
  },
);

it("F02 binds before initialize, exposes initialized before ready, and shares one deadline and launch", async () => {
  const order: string[] = [];
  const signals: AbortSignal[] = [];
  const release = latch();
  const child = memoryPlugin((peer, { exit }) => {
    ready(peer, exit);
    peer.handle("initialize", () => {
      order.push("initialize");
      return { apiVersion: "1.5.0", sdk: { name: "test", version: "1" } };
    });
  });
  const launcher = vi.fn(async () => child.process);
  const supervisor = new PluginSupervisor(plugin, launcher, {
    locale: "en",
    onNotice() {},
    resourceOwner: () => channelOwner,
    hostEpoch: channelOwner.hostEpoch,
    retireResources: async () => {},
    bindChannel() {
      order.push("bind");
      return {
        initialized: async (signal) => {
          signals.push(signal);
          await release.promise;
        },
        ready: async (signal) => {
          signals.push(signal);
        },
        dispose() {},
      };
    },
  });
  const signal = new AbortController().signal;
  const [a, b] = await Promise.all([
    supervisor.activateInitialized(signal),
    supervisor.activateInitialized(signal),
  ]);
  expect(a).toBe(b);
  expect(order).toEqual(["bind", "initialize"]);
  expect(supervisor.state).toBe("starting");
  release.resolve();
  await supervisor.ready(signal);
  expect(signals).toHaveLength(2);
  expect(signals[0]).toBe(signals[1]);
  expect(launcher).toHaveBeenCalledTimes(1);
  await supervisor.stop();
});

it.each(["initialize", "initialized", "ready"] as const)(
  "F17 physical exit during %s retires the original owner and rejects activation",
  async (phase) => {
    const entered = latch();
    const pending = latch();
    let exit!: () => void;
    const retired = vi.fn(async () => {});
    const dispose = vi.fn();
    const child = memoryPlugin((peer, control) => {
      exit = control.exit;
      ready(peer, control.exit);
      peer.handle("initialize", async () => {
        if (phase === "initialize") {
          entered.resolve();
          await pending.promise;
        }
        return { apiVersion: "1.5.0", sdk: { name: "test", version: "1" } };
      });
    });
    const supervisor = new PluginSupervisor(plugin, async () => child.process, {
      locale: "en",
      onNotice() {},
      resourceOwner: () => channelOwner,
      hostEpoch: channelOwner.hostEpoch,
      retireResources: retired,
      bindChannel: () => ({
        initialized: async () => {
          if (phase === "initialized") {
            entered.resolve();
            await pending.promise;
          }
        },
        ready: async () => {
          if (phase === "ready") {
            entered.resolve();
            await pending.promise;
          }
        },
        dispose,
      }),
    });
    const started = supervisor.ready(new AbortController().signal);
    const rejected = expect(started).rejects.toThrow();
    await entered.promise;
    exit();
    await rejected;
    expect(retired).toHaveBeenCalledExactlyOnceWith(channelOwner, "crashed");
    expect(dispose).toHaveBeenCalledOnce();
    pending.resolve();
    await supervisor.stop();
  },
);

it("F17 a failed launcher retires its preallocated owner before another launch", async () => {
  const retired = vi.fn(async () => {});
  const supervisor = new PluginSupervisor(
    plugin,
    async () => {
      throw new Error("launch failed");
    },
    {
      locale: "en",
      onNotice() {},
      resourceOwner: () => channelOwner,
      hostEpoch: channelOwner.hostEpoch,
      retireResources: retired,
      bindChannel: () => ({ initialized: async () => {}, ready: async () => {}, dispose() {} }),
    },
  );
  await expect(supervisor.ready(new AbortController().signal)).rejects.toThrow("launch failed");
  expect(retired).toHaveBeenCalledExactlyOnceWith(channelOwner, "crashed");
});

it("F17 binding failure retires before killing the child", async () => {
  const disposition = latch();
  const retired = vi.fn(() => disposition.promise);
  const child = memoryPlugin((peer, { exit }) => ready(peer, exit));
  const supervisor = new PluginSupervisor(plugin, async () => child.process, {
    locale: "en",
    onNotice() {},
    resourceOwner: () => channelOwner,
    hostEpoch: channelOwner.hostEpoch,
    retireResources: retired,
    bindChannel: () => {
      throw new Error("bind failed");
    },
  });
  const started = supervisor.ready(new AbortController().signal);
  const rejected = expect(started).rejects.toThrow("bind failed");
  await vi.waitFor(() => expect(retired).toHaveBeenCalledOnce());
  expect(child.killed()).toBe(false);
  disposition.resolve();
  await rejected;
  expect(child.killed()).toBe(true);
});

it("F02 applies one activation deadline even when a host ready callback ignores cancellation", async () => {
  const entered = latch();
  const pending = latch();
  const retired = vi.fn(async () => {});
  const child = memoryPlugin((peer, { exit }) => ready(peer, exit));
  const supervisor = new PluginSupervisor(plugin, async () => child.process, {
    locale: "en",
    onNotice() {},
    initializeTimeoutMs: 50,
    resourceOwner: () => channelOwner,
    hostEpoch: channelOwner.hostEpoch,
    retireResources: retired,
    bindChannel: () => ({
      initialized: async () => {},
      ready: async () => {
        entered.resolve();
        await pending.promise;
      },
      dispose() {},
    }),
  });
  const started = supervisor.ready(new AbortController().signal);
  const rejected = expect(started).rejects.toThrow();
  await entered.promise;
  await rejected;
  expect(retired).toHaveBeenCalledExactlyOnceWith(channelOwner, "crashed");
  expect(child.killed()).toBe(true);
  pending.resolve();
});

it.each(["stop", "forceKill", "handshake", "binding", "ready", "crash"] as const)(
  "tears down after rejected retirement during %s without unhandled rejections",
  async (mode) => {
    const disposition = latch();
    const retired = vi.fn(() => disposition.promise);
    const shutdown = vi.fn();
    let crash!: () => void;
    const child = memoryPlugin((peer, { exit }) => {
      crash = () => exit(1);
      ready(peer, exit);
      peer.handle("shutdown", () => {
        shutdown();
        return null;
      });
      if (mode === "handshake")
        peer.handle("initialize", () => {
          throw new Error("handshake failed");
        });
    });
    let launched = false;
    const supervisor = new PluginSupervisor(
      plugin,
      async () => {
        if (launched) throw new Error("next launch reached");
        launched = true;
        return child.process;
      },
      {
        locale: "en",
        onNotice() {},
        resourceOwner: () => channelOwner,
        hostEpoch: channelOwner.hostEpoch,
        retireResources: retired,
        bindChannel: () => {
          if (mode === "binding") throw new Error("binding failed");
          return {
            initialized: async () => {},
            ready: async () => {
              if (mode === "ready") throw new Error("ready failed");
            },
            dispose() {},
          };
        },
      },
    );
    const started = supervisor.ready(new AbortController().signal);
    let result: Promise<unknown>;
    if (["handshake", "binding", "ready"].includes(mode)) {
      result = expect(started).rejects.toThrow(`${mode} failed`);
    } else {
      await started;
      if (mode === "stop") result = expect(supervisor.stop()).rejects.toThrow("retirement failed");
      else {
        if (mode === "forceKill") supervisor.forceKill();
        else crash();
        result = Promise.resolve();
      }
    }
    await vi.waitFor(() => expect(retired).toHaveBeenCalledOnce());
    expect(child.killed()).toBe(false);
    expect(shutdown).not.toHaveBeenCalled();
    disposition.reject(new Error("retirement failed"));
    await result;
    await vi.waitFor(() => expect(supervisor.state).toBe("idle"));
    if (mode === "stop") expect(shutdown).toHaveBeenCalledOnce();
    else if (mode !== "crash") expect(child.killed()).toBe(true);
    // A failed retirement must not leave the stopping/terminating admission fence stuck.
    if (["stop", "forceKill", "crash"].includes(mode)) {
      await vi.waitFor(async () => {
        await expect(supervisor.ready(new AbortController().signal)).rejects.toThrow(
          "next launch reached",
        );
      });
    }
  },
);

describe("R160 crash-loop accounting (U13, B1-RF5)", () => {
  it("counts rejected launches, latches failed, and never launches on a timer", async () => {
    let now = 0;
    const launch = vi.fn(async (): Promise<PluginProcess> => {
      throw new Error("spawn denied");
    });
    const subject = new PluginSupervisor(plugin, launch, {
      locale: "en",
      onNotice: () => {},
      now: () => now,
    });
    for (let i = 0; i < 3; i++) {
      await expect(subject.executeCommand(plugin.commands[0]!)).rejects.toBeDefined();
      now += 1_000;
    }
    expect(subject.state).toBe("failed");
    now += 600_000;
    await expect(subject.executeCommand(plugin.commands[0]!)).rejects.toMatchObject({
      code: "PLUGIN_E_CRASH_LOOP",
    });
    expect(launch).toHaveBeenCalledTimes(3);
  });
  it("uses an exclusive five-minute window and one count per failed handshake", async () => {
    let now = 0;
    const launch = vi.fn(
      async () =>
        memoryPlugin((peer) => {
          peer.handle("initialize", () => {
            throw new Error("bad handshake");
          });
        }).process,
    );
    const subject = new PluginSupervisor(plugin, launch, {
      locale: "en",
      onNotice: () => {},
      now: () => now,
    });
    await expect(subject.executeCommand(plugin.commands[0]!)).rejects.toBeDefined();
    now = 300_000;
    await expect(subject.executeCommand(plugin.commands[0]!)).rejects.toBeDefined();
    now++;
    await expect(subject.executeCommand(plugin.commands[0]!)).rejects.toBeDefined();
    expect(subject.state).toBe("idle");
    now++;
    await expect(subject.executeCommand(plugin.commands[0]!)).rejects.toBeDefined();
    expect(subject.state).toBe("failed");
    expect(launch).toHaveBeenCalledTimes(4);
  });
  it("normal shutdown does not spend a crash attempt", async () => {
    const h = setup();
    for (let i = 0; i < 4; i++) {
      await h.supervisor.executeCommand("acme.hello.greet");
      await h.supervisor.stop();
      expect(h.supervisor.state).toBe("idle");
    }
  });
  it("uses a total four-second stop bound and keeps unconfirmed exit visible", async () => {
    vi.useFakeTimers();
    const h = memoryPlugin((peer, control) => ready(peer, control.exit));
    const forceKill = vi.fn();
    const subject = new PluginSupervisor(
      plugin,
      async () => ({
        ...h.process,
        kill: vi.fn(),
        forceKill,
        onExit: () => () => {},
      }),
      { locale: "en", onNotice: () => {} },
    );
    await subject.executeCommand("acme.hello.greet");
    const stopping = subject.stop();
    const rejected = expect(stopping).rejects.toMatchObject({ code: "PLUGIN_E_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(3_999);
    expect(forceKill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(forceKill).toHaveBeenCalledTimes(1);
  });
});

import { randomUUID } from "node:crypto";
describe("R160-1 startup failure cause survives the actual-exit fence", () => {
  it.each([
    ["initialize", false],
    ["initialize", true],
    ["bind", false],
    ["bind", true],
    ["initialized", false],
    ["initialized", true],
    ["ready", false],
    ["ready", true],
  ] as const)("counts each %s failure once (delayed exit: %s)", async (phase, delayed) => {
    vi.useFakeTimers();
    let exit!: () => void;
    const launch = vi.fn(async () => {
      const h = memoryPlugin((peer, control) => {
        exit = () => control.exit(1);
        ready(peer, control.exit);
        if (phase === "initialize")
          peer.handle("initialize", () => {
            throw new Error("failed initialize");
          });
      });
      return delayed ? { ...h.process, kill: vi.fn(), forceKill: vi.fn() } : h.process;
    });
    const hostEpoch = randomUUID();
    const retired = vi.fn(async () => {});
    const subject = new PluginSupervisor(plugin, launch, {
      locale: "en",
      onNotice: () => {},
      exitTimeoutMs: 20,
      hostEpoch,
      resourceOwner: () => ({
        sourceKey: "builtin:acme.hello",
        pluginId: plugin.id,
        generation: 1,
        hostEpoch,
        processEpoch: randomUUID(),
      }),
      bindChannel: () => {
        if (phase === "bind") throw new Error("failed binding");
        return {
          initialized: async () => {
            if (phase === "initialized") throw new Error("failed initialized");
          },
          ready: async () => {
            if (phase === "ready") throw new Error("failed ready");
          },
          dispose: vi.fn(),
        };
      },
      retireResources: retired,
    });
    for (let i = 0; i < 3; i++) {
      const result = subject.executeCommand("acme.hello.greet").catch((error) => error);
      if (delayed) {
        await vi.advanceTimersByTimeAsync(21);
        expect(await result).toMatchObject({ code: "PLUGIN_E_TIMEOUT" });
        expect(subject.state).toBe("stopping");
        await expect(subject.executeCommand("acme.hello.greet")).rejects.toMatchObject({
          code: "PLUGIN_E_DISABLED",
        });
        expect(launch).toHaveBeenCalledTimes(i + 1);
        exit();
      } else expect(await result).toBeInstanceOf(Error);
      await vi.advanceTimersByTimeAsync(0);
      expect(subject.state).toBe(i === 2 ? "failed" : "idle");
      expect(retired).toHaveBeenCalledTimes(i + 1);
    }
    await expect(subject.executeCommand("acme.hello.greet")).rejects.toMatchObject({
      code: "PLUGIN_E_CRASH_LOOP",
    });
    expect(launch).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not count ordinary requested stops with late actual exits", async () => {
    vi.useFakeTimers();
    let exit!: () => void;
    const launch = vi.fn(async () => {
      const h = memoryPlugin((peer, control) => {
        exit = () => control.exit();
        ready(peer, control.exit);
        peer.onNotification("exit", () => {});
      });
      return { ...h.process, kill: vi.fn(), forceKill: vi.fn() };
    });
    const subject = new PluginSupervisor(plugin, launch, {
      locale: "en",
      onNotice: () => {},
      exitTimeoutMs: 20,
    });
    for (let i = 0; i < 4; i++) {
      await subject.executeCommand("acme.hello.greet");
      const stopped = expect(subject.stop()).rejects.toMatchObject({ code: "PLUGIN_E_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(21);
      await stopped;
      expect(subject.state).toBe("stopping");
      exit();
      await vi.advanceTimersByTimeAsync(0);
      expect(subject.state).toBe("idle");
    }
    expect(launch).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });
});

import {
  createMemoryChannelPair,
  RpcPeer as DrainPeer170,
  RPC_ERRORS,
  type DrainRequest,
  type RequestContext,
} from "@kobrixa/plugin-protocol";
async function retained170(api = "1.7.0") {
  const { RetainedPersistenceChannel } = await import("./supervisor.js");
  const [a, b] = createMemoryChannelPair();
  const peer = new DrainPeer170(a),
    child = new DrainPeer170(b);
  let clock = 0;
  const lost = vi.fn(async () => {});
  const row = new RetainedPersistenceChannel(channelOwner, peer, () => clock, lost);
  row.negotiated(api);
  const request: DrainRequest = {
    token: "00000000-0000-4000-8000-000000000003",
    reason: "disable",
    remainingMs: 10000,
    checkpoints: [],
    writes: [],
  };
  return {
    row,
    peer,
    child,
    lost,
    request,
    signal: new AbortController().signal,
    time: (value: number) => {
      clock = value;
    },
    close() {
      peer.close();
      child.close();
    },
  };
}

it("R170 retained row pins original token deadline and clamps repeated shorter budgets", async () => {
  const h = await retained170();
  const callback = vi.fn(() => ({
    ok: true as const,
    value: { status: "checkpoint-only" as const, writes: [] },
  }));
  h.child.handle("storage/drain", callback);
  const send = vi.spyOn(h.peer, "request");
  try {
    await h.row.dispatch(channelOwner, { ...h.request, remainingMs: 100 }, h.signal);
    h.time(20);
    await h.row.dispatch(channelOwner, h.request, h.signal);
    expect(send.mock.calls[1]![1]).toMatchObject({ remainingMs: 80 });
    await h.row.dispatch(channelOwner, { ...h.request, remainingMs: 10 }, h.signal);
    h.time(30);
    await expect(h.row.dispatch(channelOwner, h.request, h.signal)).rejects.toMatchObject({
      code: RPC_ERRORS.timeout,
    });
    expect(callback).toHaveBeenCalledTimes(3);
  } finally {
    h.close();
  }
});

it("R170 retains 64 token outcomes for 120 seconds without refreshing on rejected callers", async () => {
  const h = await retained170();
  h.child.handle("storage/drain", () => ({
    ok: true,
    value: { status: "checkpoint-only", writes: [] },
  }));
  const send = vi.spyOn(h.peer, "request");
  try {
    for (let i = 0; i < 64; i++)
      await h.row.dispatch(
        channelOwner,
        {
          ...h.request,
          token: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          remainingMs: 1,
        },
        h.signal,
      );
    const rejected = { ...h.request, token: "10000000-0000-4000-8000-000000000001" };
    await expect(h.row.dispatch(channelOwner, rejected, h.signal)).rejects.toMatchObject({
      code: RPC_ERRORS.permissionDenied,
    });
    h.time(120000);
    await expect(h.row.dispatch(channelOwner, rejected, h.signal)).rejects.toMatchObject({
      code: RPC_ERRORS.permissionDenied,
    });
    const aborted = new AbortController();
    aborted.abort();
    await expect(h.row.dispatch(channelOwner, rejected, aborted.signal)).rejects.toBeDefined();
    expect(send).toHaveBeenCalledTimes(64);
    expect(h.lost).not.toHaveBeenCalled();
    h.time(120001);
    await expect(h.row.dispatch(channelOwner, rejected, h.signal)).resolves.toMatchObject({
      ok: true,
    });
    expect(send).toHaveBeenCalledTimes(65);
  } finally {
    h.close();
  }
});

it.each(["1.6.0", "1.7.0"])(
  "R170 missing drain callback on %s preserves numeric methodNotFound",
  async (api) => {
    const h = await retained170(api);
    const send = vi.spyOn(h.peer, "request");
    try {
      await expect(h.row.dispatch(channelOwner, h.request, h.signal)).rejects.toMatchObject({
        code: RPC_ERRORS.methodNotFound,
      });
      expect(send).toHaveBeenCalledTimes(api === "1.6.0" ? 0 : 1);
      expect(h.lost).not.toHaveBeenCalled();
    } finally {
      h.close();
    }
  },
);

it.each(["abort", "deadline", "close"] as const)(
  "R170 pending original callback is bounded by %s and never resurrects",
  async (mode) => {
    vi.useFakeTimers();
    const h = await retained170();
    const gate = latch();
    const entered = latch();
    let callbackSignal!: AbortSignal;
    const callback = vi.fn(async (_request: DrainRequest, context: RequestContext) => {
      callbackSignal = context.signal;
      entered.resolve();
      await gate.promise;
      return { ok: true as const, value: { status: "submitted" as const, writes: [] } };
    });
    h.child.handle("storage/drain", callback);
    const control = new AbortController();
    try {
      const pending = h.row.dispatch(
        channelOwner,
        { ...h.request, remainingMs: 10 },
        control.signal,
      );
      const failed = expect(pending).rejects.toMatchObject({
        code:
          mode === "close"
            ? RPC_ERRORS.connectionClosed
            : mode === "deadline"
              ? RPC_ERRORS.timeout
              : RPC_ERRORS.requestCancelled,
      });
      await entered.promise;
      if (mode === "abort") control.abort();
      else if (mode === "deadline") {
        h.time(10);
        await vi.advanceTimersByTimeAsync(10);
      } else void h.row.closed();
      await failed;
      await vi.advanceTimersByTimeAsync(0);
      expect(callbackSignal.aborted).toBe(true);
      gate.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(callback).toHaveBeenCalledOnce();
      expect(h.row.releasable).toBe(false);
      if (mode === "close") {
        await h.row.closed();
        expect(h.lost).toHaveBeenCalledOnce();
        await expect(h.row.dispatch(channelOwner, h.request, h.signal)).rejects.toMatchObject({
          code: RPC_ERRORS.connectionClosed,
        });
        h.row.disposition();
        expect(h.row.releasable).toBe(false);
        await h.row.confirmedExit();
        expect(h.row.releasable).toBe(true);
      }
    } finally {
      gate.resolve();
      h.close();
    }
  },
);

it("R170 collection and confirmed exit are idempotent in either disposition order", async () => {
  for (const first of ["exit", "disposition"]) {
    const h = await retained170();
    const collected = vi.fn();
    h.row.onCollect(collected);
    try {
      if (first === "exit") await h.row.confirmedExit();
      else h.row.disposition();
      expect(h.row.releasable).toBe(false);
      expect(collected).not.toHaveBeenCalled();
      h.row.disposition();
      await h.row.confirmedExit();
      h.row.disposition();
      await h.row.confirmedExit();
      expect(h.row.releasable).toBe(true);
      expect(collected).toHaveBeenCalledOnce();
      expect(h.lost).toHaveBeenCalledOnce();
    } finally {
      h.close();
    }
  }
});
