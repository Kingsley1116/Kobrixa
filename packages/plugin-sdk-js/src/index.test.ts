import { EventEmitter } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import {
  createMemoryChannelPair,
  RpcError,
  RpcPeer,
  type ParamsOf,
} from "@kobrixa/plugin-protocol";
import {
  createPersistenceContext,
  API_VERSION,
  definePlugin,
  electronParentPortChannel,
  runPlugin,
} from "./index.js";

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
    expect(API_VERSION).toBe("1.7.0");
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
      apiVersion: "1.7.0",
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
      for (const key of ["drain"]) expect(context).not.toHaveProperty(key);
    expect(base).not.toHaveProperty("invocation");
  } finally {
    host.close();
  }
});

it("preserves business errors and sends unwatch through events/unsubscribe", async () => {
  const [a, b] = createMemoryChannelPair();
  const host = new RpcPeer(a);
  const client = new RpcPeer(b);
  const denied = {
    ok: false as const,
    error: {
      code: "PLUGIN_E_SETTINGS_CONFLICT" as const,
      message: "Revision changed",
      detail: { kind: "persistence" as const, reason: "revision-mismatch" as const },
    },
  };
  const ids: string[] = [];
  host.handle("settings/update", () => denied);
  host.handle("events/unsubscribe", ({ subscriptionId }) => {
    const removed = !ids.includes(subscriptionId);
    ids.push(subscriptionId);
    return { ok: true as const, value: { removed } };
  });
  const ctx = createPersistenceContext(client);
  try {
    expect(
      await ctx.settings.update({
        schemaVersion: 1,
        expectedRevision: null,
        changes: [{ key: "fixture.enabled", value: true }],
      }),
    ).toEqual(denied);
    const params = { subscriptionId: "11111111-1111-4111-8111-111111111111" };
    expect(await ctx.settings.unwatch(params)).toEqual({ ok: true, value: { removed: true } });
    expect(await ctx.settings.unwatch(params)).toEqual({ ok: true, value: { removed: false } });
    expect(ctx.actions.actionRef).toBeUndefined();
  } finally {
    host.close();
    client.close();
  }
});
it("isolates overlapping invocation actionRefs without changing the base", async () => {
  let base!: PluginContext;
  const { host } = connect(
    definePlugin({
      activate(ctx) {
        base = ctx;
      },
    }),
  );
  const invocation = {
    version: 1 as const,
    invocationId: "11111111-1111-4111-8111-111111111111",
    command: "test.action",
    arguments: {},
    context: {
      contextRef: null,
      origin: "management" as const,
      locale: "en" as const,
      trigger: { kind: "activate" as const },
    },
  };
  try {
    await host.request("initialize", { ...init, apiVersion: "1.7.0" });
    const signal = new AbortController().signal;
    const first = createInvocationContext(
      base,
      {
        ...invocation,
        context: { ...invocation.context, actionRef: "22222222-2222-4222-8222-222222222222" },
      },
      signal,
    );
    const second = createInvocationContext(
      base,
      {
        ...invocation,
        context: { ...invocation.context, actionRef: "33333333-3333-4333-8333-333333333333" },
      },
      signal,
    );
    expect(first.actions.actionRef).toBe("22222222-2222-4222-8222-222222222222");
    expect(second.actions.actionRef).toBe("33333333-3333-4333-8333-333333333333");
    expect(first.actions).not.toBe(second.actions);
    expect(Object.getOwnPropertyDescriptor(first.actions, "actionRef")?.set).toBeUndefined();
    expect(createInvocationContext(base, invocation, signal).actions.actionRef).toBeUndefined();
    expect(base.actions.actionRef).toBeUndefined();
  } finally {
    host.close();
  }
});
it.each(["1.4.0", "1.5.0", "1.6.0"])(
  "never invokes a drain callback for host %s",
  async (apiVersion) => {
    const drain = vi.fn(async () => ({
      ok: true as const,
      value: { status: "submitted" as const, writes: [] },
    }));
    const { host } = connect(definePlugin({ activate() {}, drain }));
    try {
      await host.request("initialize", { ...init, apiVersion });
      await expect(
        host.request("storage/drain", {
          token: "11111111-1111-4111-8111-111111111111",
          reason: "shutdown",
          remainingMs: 10000,
          checkpoints: [],
          writes: [],
        }),
      ).rejects.toMatchObject({ code: -32601 });
      expect(drain).not.toHaveBeenCalled();
    } finally {
      host.close();
    }
  },
);
it("keeps drain cancellation separate from the ordinary command", async () => {
  let commandStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    commandStarted = resolve;
  });
  let drainSignal: AbortSignal | undefined;
  const { host } = connect(
    definePlugin({
      activate(ctx) {
        ctx.commands.register(
          "test.wait",
          ({ signal }) =>
            new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
              commandStarted();
            }),
        );
      },
      drain(ctx) {
        drainSignal = ctx.signal;
        return { ok: true, value: { status: "checkpoint-only", writes: [] } };
      },
    }),
  );
  try {
    await host.request("initialize", { ...init, apiVersion: "1.7.0" });
    const ordinary = new AbortController();
    const command = host.request(
      "command/execute",
      { command: "test.wait" },
      { signal: ordinary.signal },
    );
    const rejected = expect(command).rejects.toMatchObject({ code: -32800 });
    await started;
    ordinary.abort();
    await rejected;
    expect(
      await host.request("storage/drain", {
        token: "11111111-1111-4111-8111-111111111111",
        reason: "shutdown",
        remainingMs: 10000,
        checkpoints: [],
        writes: [],
      }),
    ).toEqual({ ok: true, value: { status: "checkpoint-only", writes: [] } });
    expect(drainSignal?.aborted).toBe(false);
  } finally {
    host.close();
  }
});

it.each([undefined, "1.7.0"])("rejects drain without a callback (host %s)", async (apiVersion) => {
  const { host } = connect(definePlugin({ activate() {} }));
  try {
    if (apiVersion) await host.request("initialize", { ...init, apiVersion });
    await expect(
      host.request("storage/drain", {
        token: "11111111-1111-4111-8111-111111111111",
        reason: "shutdown",
        remainingMs: 10000,
        checkpoints: [],
        writes: [],
      }),
    ).rejects.toMatchObject({ code: -32601 });
  } finally {
    host.close();
  }
});
it("preserves legacy numeric permission errors without retrying a persistence call", async () => {
  const [a, b] = createMemoryChannelPair();
  const host = new RpcPeer(a),
    peer = new RpcPeer(b);
  const denied = vi.fn(() => {
    throw new RpcError(-32002, "Denied");
  });
  host.handle("settings/read", denied);
  try {
    await expect(
      createPersistenceContext(peer).settings.read({ schemaVersion: 1 }),
    ).rejects.toMatchObject({ code: -32002 });
    expect(denied).toHaveBeenCalledTimes(1);
  } finally {
    host.close();
    peer.close();
  }
});

import { bindEventChannel, eventInbox } from "./events.js";
const settingsId = "00000000-0000-4000-8000-000000000001";
const settingsOwner = {
  sourceKey: "builtin:acme.test",
  pluginId: "acme.test",
  generation: 1,
  hostEpoch: settingsId,
  processEpoch: settingsId,
};
const settingsSnapshot = (value: boolean) => ({
  schemaVersion: 1,
  revision: null,
  values: [{ key: "fixture.enabled", value }],
});
const settingsEvent = (sequence: number, marker = true) => ({
  version: 1,
  subscriptionId: settingsId,
  owner: settingsOwner,
  sequence,
  ...(marker
    ? {
        delivery: "control",
        kind: "events.resyncRequired",
        data: { reason: "overflow", affected: [settingsId] },
      }
    : {
        delivery: "telemetry",
        kind: "settings.changed",
        data: {
          revision: "r_" + "1".repeat(32),
          schemaVersion: 1,
          changedKeys: ["fixture.enabled"],
          cause: "update",
        },
      }),
});
it.each([true, false])(
  "T8 settings refresh publishes the actual snapshot through the shared queue (marker %s)",
  async (marker) => {
    const [a, b] = createMemoryChannelPair();
    const host = new RpcPeer(a),
      peer = new RpcPeer(b);
    bindEventChannel(peer, settingsOwner);
    const fresh = settingsSnapshot(true),
      order: string[] = [],
      notices: unknown[] = [];
    host.handle("settings/watch", () => ({
      ok: true,
      value: { subscriptionId: settingsId, sequence: 0, snapshot: settingsSnapshot(false) },
    }));
    host.handle("settings/read", () => {
      order.push("read");
      return { ok: true, value: fresh };
    });
    host.handle("events/ack", ({ sequence }) => {
      order.push("ack");
      return { ok: true as const, value: { acknowledged: sequence } };
    });
    try {
      const result = await createPersistenceContext(peer).settings.watch(
        { schemaVersion: 1 },
        undefined,
        async (notice) => {
          order.push("callback");
          notices.push(notice);
          await Promise.resolve();
        },
      );
      expect(result).toMatchObject({ value: { snapshot: settingsSnapshot(false) } });
      const envelope = settingsEvent(marker ? 1 : 2, marker);
      expect(eventInbox(peer).accept(envelope)).toBe(true);
      await vi.waitFor(() => expect(notices).toHaveLength(marker ? 1 : 2));
      expect(notices[0]).toEqual({ type: "snapshot", snapshot: fresh });
      if (!marker) expect(notices[1]).toEqual({ type: "event", event: envelope });
      expect(order.indexOf("ack")).toBeLessThan(order.indexOf("callback"));
    } finally {
      host.close();
      peer.close();
    }
  },
);

it.each(["unwatch", "inbox-close", "dispose"])(
  "T8 suppresses late refresh after %s",
  async (stop) => {
    const [a, b] = createMemoryChannelPair();
    const host = new RpcPeer(a),
      peer = new RpcPeer(b);
    bindEventChannel(peer, settingsOwner);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const notices: unknown[] = [],
      read = vi.fn(async () => {
        await gate;
        return { ok: true as const, value: settingsSnapshot(true) };
      });
    host.handle("settings/watch", () => ({
      ok: true,
      value: { subscriptionId: settingsId, sequence: 0, snapshot: settingsSnapshot(false) },
    }));
    host.handle("settings/read", read);
    host.handle("events/ack", ({ sequence }) => ({
      ok: true as const,
      value: { acknowledged: sequence },
    }));
    host.handle("events/unsubscribe", () => ({ ok: true as const, value: { removed: true } }));
    try {
      const settings = createPersistenceContext(peer).settings;
      await settings.watch({ schemaVersion: 1 }, undefined, (notice) => {
        notices.push(notice);
      });
      eventInbox(peer).accept(settingsEvent(1));
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      if (stop === "unwatch") await settings.unwatch({ subscriptionId: settingsId });
      else if (stop === "inbox-close") eventInbox(peer).close(settingsId);
      else peer.close();
      release();
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(notices).toEqual([]);
    } finally {
      release();
      host.close();
      peer.close();
    }
  },
);

it("T8 awaits notices in the bounded queue and isolates callback errors", async () => {
  const [a, b] = createMemoryChannelPair();
  const host = new RpcPeer(a),
    peer = new RpcPeer(b);
  bindEventChannel(peer, settingsOwner);
  const notices: unknown[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  host.handle("settings/watch", () => ({
    ok: true,
    value: { subscriptionId: settingsId, sequence: 0, snapshot: settingsSnapshot(false) },
  }));
  host.handle("settings/read", () => ({ ok: true, value: settingsSnapshot(true) }));
  const ack = vi.fn(({ sequence }: ParamsOf<"events/ack">) => ({
    ok: true as const,
    value: { acknowledged: sequence },
  }));
  host.handle("events/ack", ack);
  try {
    await createPersistenceContext(peer).settings.watch(
      { schemaVersion: 1 },
      undefined,
      async (notice) => {
        notices.push(notice);
        if (notice.type === "snapshot") {
          await gate;
          throw new Error("consumer");
        }
      },
    );
    eventInbox(peer).accept(settingsEvent(1));
    eventInbox(peer).accept(settingsEvent(2, false));
    await vi.waitFor(() => expect(ack).toHaveBeenCalledTimes(2));
    expect(notices).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(notices).toHaveLength(2));
    expect(notices[1]).toEqual({ type: "event", event: settingsEvent(2, false) });
  } finally {
    release();
    host.close();
    peer.close();
  }
});

it("T8 bound JS inbox rejects reserved setting keys without ACK and accepts dotted duplicates", async () => {
  const [a, b] = createMemoryChannelPair();
  const host = new RpcPeer(a),
    peer = new RpcPeer(b);
  bindEventChannel(peer, settingsOwner);
  const ack = vi.fn(({ sequence }: ParamsOf<"events/ack">) => ({
    ok: true as const,
    value: { acknowledged: sequence },
  }));
  host.handle("events/ack", ack);
  const inbox = eventInbox(peer);
  inbox.enable();
  inbox.open(
    settingsId,
    () => {},
    async () => {},
  );
  try {
    const envelope = settingsEvent(1, false);
    for (const key of [
      "constructor",
      "prototype",
      "__proto__",
      "foo.constructor",
      "prototype.foo",
      "foo.__proto__.bar",
    ])
      expect(inbox.accept({ ...envelope, data: { ...envelope.data, changedKeys: [key] } })).toBe(
        false,
      );
    await Promise.resolve();
    expect(ack).not.toHaveBeenCalled();
    expect(
      inbox.accept({
        ...envelope,
        data: {
          ...envelope.data,
          changedKeys: ["fixture.enabled", "fixture.enabled", "constructorName.x"],
        },
      }),
    ).toBe(true);
    await vi.waitFor(() => expect(ack).toHaveBeenCalledTimes(1));
  } finally {
    host.close();
    peer.close();
  }
});

it("T8 snapshot callback can unwatch without a later event callback", async () => {
  const [a, b] = createMemoryChannelPair();
  const host = new RpcPeer(a),
    peer = new RpcPeer(b);
  bindEventChannel(peer, settingsOwner);
  host.handle("settings/watch", () => ({
    ok: true,
    value: { subscriptionId: settingsId, sequence: 0, snapshot: settingsSnapshot(false) },
  }));
  host.handle("settings/read", () => ({ ok: true, value: settingsSnapshot(true) }));
  host.handle("events/ack", ({ sequence }) => ({
    ok: true as const,
    value: { acknowledged: sequence },
  }));
  host.handle("events/unsubscribe", () => ({ ok: true as const, value: { removed: true } }));
  const notices: unknown[] = [];
  try {
    const settings = createPersistenceContext(peer).settings;
    await settings.watch({ schemaVersion: 1 }, undefined, async (notice) => {
      notices.push(notice);
      await settings.unwatch({ subscriptionId: settingsId });
    });
    eventInbox(peer).accept(settingsEvent(2, false));
    await vi.waitFor(() => expect(eventInbox(peer).last(settingsId)).toBe(0));
    expect(notices).toEqual([{ type: "snapshot", snapshot: settingsSnapshot(true) }]);
  } finally {
    host.close();
    peer.close();
  }
});
