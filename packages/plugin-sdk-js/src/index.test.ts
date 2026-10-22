import { EventEmitter } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { createMemoryChannelPair, RpcPeer, type ParamsOf } from "@kobrixa/plugin-protocol";
import { API_VERSION, definePlugin, electronParentPortChannel, runPlugin } from "./index.js";

const init: ParamsOf<"initialize"> = {
  apiVersion: "1.1.0",
  pluginId: "acme.hello",
  locale: "zh-TW",
  grantedPermissions: ["ui.notifications"],
};
function connect(definition: Parameters<typeof runPlugin>[0]) {
  const [hostEnd, pluginEnd] = createMemoryChannelPair();
  const host = new RpcPeer(hostEnd);
  const exit = vi.fn();
  void runPlugin(definition, { channel: pluginEnd, exit });
  return { host, exit };
}

describe("JS plugin SDK", () => {
  it.each([false, true])(
    "F16 real-port readiness follows successful initialize publication (send failure: %s)",
    async (sendFailure) => {
      const { port1, port2 } = new MessageChannel();
      const sent: string[] = [];
      const channel = (port: typeof port1, plugin = false) => ({
        onMessage(listener: (text: string) => void) {
          port.on("message", listener);
          return () => {
            port.off("message", listener);
          };
        },
        send(text: string) {
          const message = JSON.parse(text);
          if (plugin && message.result?.sdk) {
            if (sendFailure) throw new Error("initialize publication failed");
            sent.push("initialize-response");
          }
          if (plugin && message.method === "devices/negotiate") sent.push("devices/negotiate");
          port.postMessage(text);
        },
      });
      const host = new RpcPeer(channel(port1));
      const negotiate = vi.fn(() => ({
        ok: true as const,
        value: {
          devicesContractVersion: 1 as const,
          eventVersion: 1 as const,
          capabilities: [],
          requirementsSatisfied: true,
        },
      }));
      host.handle("devices/negotiate", negotiate);
      let background: Promise<void> | undefined;
      let after: (() => Promise<unknown>) | undefined;
      void runPlugin(
        definePlugin({
          activate(context) {
            after = () => context.devices.negotiate();
            background = (async () => {
              for (let attempt = 0; attempt < 8; attempt++)
                if ((await context.devices.negotiate()).ok) return;
            })();
          },
        }),
        { channel: channel(port2, true), exit() {} },
      );
      try {
        const initialization = host.request("initialize", { ...init, apiVersion: "1.5.0" });
        if (sendFailure)
          await expect(initialization).rejects.toThrow("initialize publication failed");
        else await initialization;
        await background;
        expect(after).toBeDefined();
        const result = await after!();
        if (sendFailure) {
          expect(result).toMatchObject({
            ok: false,
            error: { code: "PLUGIN_E_DEVICE_UNAVAILABLE" },
          });
          expect(negotiate).not.toHaveBeenCalled();
          expect(sent).toEqual([]);
        } else {
          expect(result).toMatchObject({ ok: true });
          expect(sent).toEqual(["initialize-response", "devices/negotiate"]);
        }
      } finally {
        host.close();
        port1.close();
        port2.close();
      }
    },
  );
  it("F16 makes devices ready when initialize returns, without opening them during activation", async () => {
    vi.useFakeTimers();
    const negotiation = {
      ok: true as const,
      value: {
        devicesContractVersion: 1 as const,
        eventVersion: 1 as const,
        capabilities: [],
        requirementsSatisfied: true,
      },
    };
    let duringActivation: unknown, afterInitialize: unknown;
    const { host } = connect(
      definePlugin({
        async activate(context) {
          duringActivation = await context.devices.negotiate();
          context.commands.register("acme.hello.devices", async () => {
            afterInitialize = await context.devices.negotiate();
          });
        },
      }),
    );
    const negotiate = vi.fn(() => negotiation);
    host.handle("devices/negotiate", negotiate);
    try {
      await host.request("initialize", { ...init, apiVersion: "1.5.0" });
      expect(duringActivation).toMatchObject({
        ok: false,
        error: { code: "PLUGIN_E_DEVICE_UNAVAILABLE" },
      });
      expect(negotiate).not.toHaveBeenCalled();
      await host.request("command/execute", { command: "acme.hello.devices" });
      expect(afterInitialize).toEqual(negotiation);
      expect(negotiate).toHaveBeenCalledTimes(1);
    } finally {
      host.close();
      vi.useRealTimers();
    }
  });
  it("exposes the same API version as its initialize response", () => {
    expect(API_VERSION).toBe("1.6.0");
  });
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
      apiVersion: "1.6.0",
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

it("U06 ready can query host after negotiation, and legacy remains null", async () => {
  let pluginReceive: ((text: string) => void) | undefined;
  let hostReceive: ((text: string) => void) | undefined;
  const host = new RpcPeer({
    send: (text) => queueMicrotask(() => pluginReceive?.(text)),
    onMessage: (listener) => {
      hostReceive = listener;
      return () => {
        hostReceive = undefined;
      };
    },
  });
  let legacy = 0;
  let ready = 0;
  const plugin = await runPlugin(
    {
      activate(context) {
        context.commands.register("acme.ui.old", () => {
          legacy++;
        });
        context.commands.registerContext("acme.ui.run", {}, async (invocation) => {
          expect(invocation).toHaveProperty(
            "invocation.context.actionRef",
            "00000000-0000-4000-8000-000000000099",
          );
          expect(invocation).not.toHaveProperty("invocation.signal");
          expect(Object.isFrozen(invocation)).toBe(true);
          return { output: {}, fieldErrors: [] };
        });
      },
      async ready(context) {
        const instances = await context.ui.instances();
        expect(instances.ok).toBe(true);
        ready++;
      },
    },
    {
      channel: {
        send: (text) => queueMicrotask(() => hostReceive?.(text)),
        onMessage: (listener) => {
          pluginReceive = listener;
          return () => {
            pluginReceive = undefined;
          };
        },
      },
      exit() {},
    },
  );
  host.handle("ui/instances", async () => ({ ok: true, value: { instances: [] } }));
  try {
    await host.request("initialize", {
      apiVersion: "1.6.0",
      pluginId: "acme.ui",
      locale: "en",
      grantedPermissions: ["ui.panels"],
    });
    expect(ready).toBe(0);
    expect((await host.request("ui/ready", {})).ok).toBe(false);
    await host.request("ui/negotiate", { commandEnvelopeVersions: [1], uiResourceVersions: [1] });
    expect((await host.request("ui/ready", {})).ok).toBe(true);
    expect((await host.request("ui/ready", {})).ok).toBe(true);
    expect(ready).toBe(1);
    expect(
      await host.request("command/invoke", {
        version: 1,
        invocationId: "00000000-0000-4000-8000-000000000001",
        command: "acme.ui.run",
        arguments: {},
        context: {
          contextRef: null,
          origin: "management",
          locale: "en",
          actionRef: "00000000-0000-4000-8000-000000000099",
          trigger: { kind: "activate" },
        },
      }),
    ).toEqual({ ok: true, value: { output: {}, fieldErrors: [] } });
    expect(await host.request("command/execute", { command: "acme.ui.old" })).toBeNull();
    expect(legacy).toBe(1);
  } finally {
    host.close();
    plugin.close();
  }
});

import { createInvocationContext, type PluginContext } from "./index.js";
import type { CommandInvocation } from "@kobrixa/plugin-protocol";
it("isolates overlapping invocation factories without mutating the base context", async () => {
  let base!: PluginContext;
  const { host } = connect({
    activate(context) {
      base = context;
    },
  });
  try {
    await host.request("initialize", init);
    const invocation = (n: number): CommandInvocation => ({
      version: 1,
      invocationId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      command: "acme.hello.run",
      arguments: {},
      context: {
        contextRef: null,
        origin: "management",
        locale: "en",
        actionRef: `00000000-0000-4000-8000-${String(n + 10).padStart(12, "0")}`,
        trigger: { kind: "activate" },
      },
    });
    const before = Object.keys(base);
    const a = createInvocationContext(base, invocation(1), new AbortController().signal);
    const b = createInvocationContext(base, invocation(2), new AbortController().signal);
    const absent = invocation(3);
    delete absent.context.actionRef;
    const c = createInvocationContext(base, absent, new AbortController().signal);
    const seen: unknown[] = [];
    await Promise.all([
      Promise.resolve().then(() => seen.push(b.invocation.context.actionRef)),
      Promise.resolve().then(() => seen.push(a.invocation.context.actionRef)),
    ]);
    expect(seen).toEqual([invocation(2).context.actionRef, invocation(1).context.actionRef]);
    expect(c.invocation.context).not.toHaveProperty("actionRef");
    expect(Object.keys(base)).toEqual(before);
    for (const context of [base, a, b, c])
      for (const key of ["actions", "storage", "settings", "drain"])
        expect(context).not.toHaveProperty(key);
    expect(base).not.toHaveProperty("invocation");
  } finally {
    host.close();
  }
});
