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
    const stopping = supervisor.stop().then(() => {
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
