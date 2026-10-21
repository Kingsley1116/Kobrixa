import { createDeviceBroker } from "./broker-port.js";
import type { JournalPort } from "./journal-port.js";
import { journalDocument } from "./journal.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcPeer, requestMethods, type MessageChannelLike } from "@kobrixa/plugin-protocol";
import type { Principal, Stage3Event } from "@kobrixa/plugin-runtime";
import type { DeviceBrokerPort } from "./broker-port.js";
import { attachDeviceRpc } from "./rpc-router.js";
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const p: Principal = {
  kind: "plugin",
  owner: {
    sourceKey: "dev:0000000000000001",
    pluginId: "test.consumer",
    generation: 1,
    hostEpoch: id(1),
    processEpoch: id(2),
  },
  authorityContext: null,
};
const peers: RpcPeer[] = [];
afterEach(() => {
  for (const peer of peers.splice(0)) peer.close();
});
function fixture(principal: () => Principal = () => p) {
  let listener: (text: string) => void = () => {};
  const replies: Record<string, unknown>[] = [];
  const transport: MessageChannelLike = {
    send: (text) => {
      replies.push(JSON.parse(text));
    },
    onMessage: (fn) => {
      listener = fn;
      return () => {
        listener = () => {};
      };
    },
  };
  const peer = new RpcPeer(transport);
  peers.push(peer);
  const request = vi.fn<
    (principal: Principal, method: string, params: unknown, signal: AbortSignal) => Promise<unknown>
  >(async () => ({
    ok: true,
    value: {
      devicesContractVersion: 1,
      eventVersion: 1,
      capabilities: [],
      requirementsSatisfied: true,
    },
  }));
  const channel = {
    owner:
      p.kind === "plugin"
        ? p.owner
        : (() => {
            throw new Error("plugin required");
          })(),
    negotiated: vi.fn(),
    activate: vi.fn(),
    abandon: vi.fn(),
    dispose: vi.fn(),
  };
  const attachChannel = vi.fn<DeviceBrokerPort["attachChannel"]>(() => channel);
  const broker = { request, attachChannel } as unknown as DeviceBrokerPort;
  const dispose = attachDeviceRpc({ peer, principal, broker });
  let sequence = 0;
  const call = async (method: string, params: object) => {
    const messageId = ++sequence;
    listener(JSON.stringify({ jsonrpc: "2.0", id: messageId, method, params }));
    await vi.waitFor(() => expect(replies.some((reply) => reply.id === messageId)).toBe(true));
    return replies.find((reply) => reply.id === messageId)!;
  };
  return { peer, broker, request, replies, dispose, call, listener, channel, attachChannel };
}
describe("device RPC", () => {
  it("F02/F03 validates wire before binding and forwards the host principal", async () => {
    const f = fixture();
    const invalid = await f.call("devices/negotiate", { owner: p, role: "host", holder: true });
    expect(invalid).toHaveProperty("error");
    expect(f.request).not.toHaveBeenCalled();
    await f.call("devices/negotiate", {});
    expect(f.request.mock.calls[0]![0]).toEqual(p);
    expect(f.request.mock.calls[0]![1]).toBe("devices/negotiate");
  });
  it.each([
    ["PLUGIN_E_PERMISSION_DENIED", { kind: "permission", reason: "permission" }],
    [
      "PLUGIN_E_DISABLED",
      {
        kind: "device",
        reason: "disabled",
        dispatch: "not-sent",
        stopConfirmation: "not-required",
      },
    ],
    ["PLUGIN_E_STALE_RESOURCE", { kind: "resource", reason: "stale", resource: "operation" }],
    [
      "PLUGIN_E_DEVICE_CAPABILITY",
      {
        kind: "device",
        reason: "unsupported-capability",
        dispatch: "not-sent",
        stopConfirmation: "not-required",
      },
    ],
    ["PLUGIN_E_RESOURCE_LIMIT", { kind: "resource", reason: "queue", resource: "rpc", limit: 4 }],
  ])(
    "F18 preserves %s rather than flattening business failure into transport success",
    async (code, detail) => {
      const f = fixture();
      const result = { ok: false, error: { code, message: "denied", detail } };
      f.request.mockResolvedValueOnce(result as never);
      const reply = await f.call("devices/motion/query", { operationId: id(3) });
      expect(reply.result).toEqual(result);
    },
  );
  it("F04/F18 preserves accepted sent/unknown state, including query after cancellation", async () => {
    const f = fixture();
    const result = {
      ok: false,
      error: {
        code: "PLUGIN_E_DEVICE_STOP_UNCONFIRMED",
        message: "reply lost",
        detail: {
          kind: "device",
          reason: "readback-failed",
          operationId: id(3),
          dispatch: "unknown",
          stopConfirmation: "unconfirmed",
        },
      },
    };
    f.request.mockResolvedValue(result as never);
    const reply = await f.call("devices/motion/start", { operationId: id(3) });
    expect(reply.result).toEqual(result);
    expect((await f.call("devices/motion/query", { operationId: id(3) })).result).toEqual(result);
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("F17 disposing removes authority without closing another domain's transport", async () => {
    const f = fixture();
    f.dispose();
    f.dispose();
    expect(f.peer.closed).toBe(false);
    expect(await f.call("devices/negotiate", {})).toHaveProperty("error");
    expect(f.request).not.toHaveBeenCalled();
  });
  it("F13 registers only published device/common-event methods and emits no unsolicited events", async () => {
    const f = fixture();
    await f.call("devices/negotiate", {});
    expect(f.replies.every((reply) => "id" in reply)).toBe(true);
    for (const name of ["devices/provide", "devices/events/ack", "settings/unwatch"])
      expect(await f.call(name, {})).toHaveProperty("error");
    expect(Object.hasOwn(requestMethods, "events/ack")).toBe(true);
    expect(Object.hasOwn(requestMethods, "events/unsubscribe")).toBe(true);
  });
  it("F13 routes common ack/unsubscribe without inventing domain aliases", async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce({ ok: true, value: { acknowledged: 7 } });
    expect((await f.call("events/ack", { subscriptionId: id(8), sequence: 7 })).result).toEqual({
      ok: true,
      value: { acknowledged: 7 },
    });
    f.request.mockResolvedValueOnce({ ok: true, value: { removed: false } });
    expect((await f.call("events/unsubscribe", { subscriptionId: id(8) })).result).toEqual({
      ok: true,
      value: { removed: false },
    });
    expect(f.request.mock.calls.map((call) => call[1])).toEqual([
      "events/ack",
      "events/unsubscribe",
    ]);
  });
  it("F18 rejects a mismatched code/kind/reason result at the real peer boundary", async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "PLUGIN_E_PERMISSION_DENIED",
        message: "wrong detail",
        detail: { kind: "resource", reason: "stale", resource: "operation" },
      },
    });
    const reply = await f.call("devices/motion/query", { operationId: id(3) });
    expect(reply).toHaveProperty("error");
    expect(reply).not.toHaveProperty("result");
  });
  it("F17 saturated public calls cannot suppress direct retirement", async () => {
    const f = fixture();
    f.request.mockImplementation(() => new Promise(() => {}));
    for (let n = 1; n <= 4; n++)
      f.listener(
        JSON.stringify({
          jsonrpc: "2.0",
          id: n,
          method: "devices/motion/query",
          params: { operationId: id(3) },
        }),
      );
    expect(f.request).toHaveBeenCalledTimes(4);
    const stop = vi.fn();
    const resources = {
      retire: () => {
        stop();
        return {
          drain: null,
          settled: Promise.resolve({ stopConfirmed: true, journalCommitted: true, faultIds: [] }),
        };
      },
    };
    const result = resources.retire();
    expect(stop).toHaveBeenCalledOnce();
    await result.settled;
    expect(f.replies).toHaveLength(0);
  });
});

it("attaches one immutable full owner and publishes negotiation only after the reply", async () => {
  const f = fixture();
  expect(f.attachChannel).toHaveBeenCalledOnce();
  expect(f.attachChannel.mock.calls[0]![0].owner).toEqual(p.kind === "plugin" && p.owner);
  expect(f.channel.negotiated).not.toHaveBeenCalled();
  await f.call("devices/negotiate", {});
  expect(f.channel.negotiated).toHaveBeenCalledExactlyOnceWith("devices", 1);
  expect(() => attachDeviceRpc({ peer: f.peer, principal: () => p, broker: f.broker })).toThrow(
    "already",
  );
  f.dispose();
  f.dispose();
  expect(f.channel.dispose).toHaveBeenCalledOnce();
  expect(f.peer.closed).toBe(false);
});
it("does not mark an invalid negotiation result published", async () => {
  const f = fixture();
  f.request.mockResolvedValueOnce({ ok: true, value: {} });
  expect(await f.call("devices/negotiate", {})).toHaveProperty("error");
  expect(f.channel.negotiated).not.toHaveBeenCalled();
});

it("activates after serialized reply and sends through the actual events/deliver notification", async () => {
  const f = fixture();
  await f.call("devices/negotiate", {});
  f.request.mockResolvedValueOnce({
    ok: true,
    value: {
      subscriptionId: id(8),
      sequence: 0,
      snapshot: { revision: 0, providers: [], sessions: [] },
    },
  });
  f.channel.activate.mockImplementation((subscriptionId) => {
    expect(f.replies.at(-1)).toMatchObject({ result: { ok: true, value: { subscriptionId } } });
    const owner = f.attachChannel.mock.calls[0]![0].owner;
    f.attachChannel.mock.calls[0]![0].send({
      version: 1,
      owner,
      subscriptionId,
      sequence: 1,
      delivery: "control",
      kind: "events.resyncRequired",
      data: { reason: "overflow", affected: [subscriptionId] },
    });
  });
  await f.call("devices/subscribe", { topic: "catalog" });
  expect(f.channel.activate).toHaveBeenCalledExactlyOnceWith(id(8));
  expect(f.channel.activate.mock.results[0]).toEqual({ type: "return", value: undefined });
  expect(f.channel.abandon).not.toHaveBeenCalled();
  expect(f.replies.at(-1)).toMatchObject({
    method: "events/deliver",
    params: { subscriptionId: id(8), sequence: 1 },
  });
  f.peer.close();
  expect(() =>
    f.attachChannel.mock.calls[0]![0].send({
      version: 1,
      owner: f.attachChannel.mock.calls[0]![0].owner,
      subscriptionId: id(8),
      sequence: 2,
      delivery: "control",
      kind: "events.resyncRequired",
      data: { reason: "overflow", affected: [id(8)] },
    }),
  ).toThrow("closed");
});

it("F03/F18 checks all eight permission combinations and permission before foreign handles/provider absence", async () => {
  const permissions = ["devices.read", "devices.connect", "devices.control"] as const;
  for (let bits = 0; bits < 8; bits++) {
    const grants = new Set(permissions.filter((_, n) => bits & (1 << n)));
    const commit = vi.fn(async () => {});
    const journal: JournalPort = {
      load: async () => journalDocument(0, []),
      commit,
      snapshot: () => ({ revision: 0, journalHealth: "ready", faults: [], blockers: [] }),
      subscribe: () => () => {},
    };
    const broker = createDeviceBroker({
      profile: { hostEpoch: id(1), assertHeld() {} },
      journal,
      authority: {
        current: () => null,
        assertContinuation() {
          throw new Error("unbound");
        },
        subscribe: () => () => {},
      },
      coreActions: { claim: () => false, isClaimed: () => false, complete() {} },
      requirements: () => Object.freeze([]),
      operationGate: () => ({ ok: true, value: null }),
      connectionPolicy: () => ({
        wifiConnectTimeoutMs: 5000,
        wifiHandshakeTimeoutMs: 3000,
        usbAutoReconnect: false,
        usbRetryInterval: "backoff",
        usbRetryLimit: 3,
      }),
      now: () => 0,
      hasPermission: (_principal, permission) =>
        grants.has(permission as (typeof permissions)[number]),
    });
    const signal = new AbortController().signal;
    const negotiation = await broker.request(p, "devices/negotiate", {}, signal);
    expect(negotiation.ok).toBe(true);
    const cases = [
      ["devices.read", await broker.request(p, "devices/list", {}, signal)],
      [
        "devices.connect",
        await broker.request(
          p,
          "devices/connect",
          {
            target: {
              kind: "wifi-address",
              providerId: "kobrixa.device-ev3",
              address: "127.0.0.1",
            },
          },
          signal,
        ),
      ],
      [
        "devices.control",
        await broker.request(p, "devices/motion/start", { operationId: id(99) }, signal),
      ],
    ] as const;
    for (const [permission, result] of cases) {
      if (!grants.has(permission))
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: "PLUGIN_E_PERMISSION_DENIED",
            detail: { kind: "permission", reason: "permission" },
          },
        });
      else if (!result.ok) expect(result.error.code).not.toBe("PLUGIN_E_PERMISSION_DENIED");
    }
    if (grants.has("devices.control"))
      expect(cases[2][1]).toMatchObject({
        ok: false,
        error: {
          code: "PLUGIN_E_STALE_RESOURCE",
          detail: { kind: "resource", reason: "stale", resource: "operation" },
        },
      });
    const discovery = await broker.request(
      p,
      "devices/discover",
      { providerId: "kobrixa.device-ev3" },
      signal,
    );
    expect(discovery).toMatchObject({
      ok: false,
      error: {
        code: grants.has("devices.read")
          ? "PLUGIN_E_DEVICE_UNAVAILABLE"
          : "PLUGIN_E_PERMISSION_DENIED",
      },
    });
    expect(commit).not.toHaveBeenCalled();
    await broker.resources.beginShutdown();
  }
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

type WireMessage = {
  id?: number;
  method?: string;
  result?: { ok: boolean; value?: { subscriptionId?: string } };
};
function pairedFixture() {
  let current = p;
  const owner =
    p.kind === "plugin"
      ? p.owner
      : (() => {
          throw new Error("plugin required");
        })();
  const journal: JournalPort = {
    load: async () => journalDocument(0, []),
    commit: async () => {},
    snapshot: () => ({ revision: 0, journalHealth: "ready", faults: [], blockers: [] }),
    subscribe: () => () => {},
  };
  const broker = createDeviceBroker({
    profile: { hostEpoch: id(1), assertHeld() {} },
    journal,
    authority: {
      current: () => null,
      assertContinuation() {
        throw new Error("unbound");
      },
      subscribe: () => () => {},
    },
    coreActions: { claim: () => false, isClaimed: () => false, complete() {} },
    requirements: () => Object.freeze([]),
    operationGate: () => ({ ok: true, value: null }),
    connectionPolicy: () => ({
      wifiConnectTimeoutMs: 5000,
      wifiHandshakeTimeoutMs: 3000,
      usbAutoReconnect: false,
      usbRetryInterval: "backoff",
      usbRetryLimit: 3,
    }),
    now: () => 0,
    hasPermission: () => true,
  });
  let toHost: (text: string) => void = () => {};
  let toClient: (text: string) => void = () => {};
  const trace: WireMessage[] = [];
  const beforeSend = vi.fn<(message: WireMessage) => void>();
  const host = new RpcPeer({
    send(text) {
      const message = JSON.parse(text) as WireMessage;
      beforeSend(message);
      trace.push(message);
      toClient(text);
    },
    onMessage(fn) {
      toHost = fn;
      return () => {
        toHost = () => {};
      };
    },
  });
  const client = new RpcPeer({
    send: (text) => toHost(text),
    onMessage(fn) {
      toClient = fn;
      return () => {
        toClient = () => {};
      };
    },
  });
  peers.push(host, client);
  const attachChannel = vi.spyOn(broker, "attachChannel");
  const dispose = attachDeviceRpc({ peer: host, principal: () => current, broker });
  const attachment = attachChannel.mock.results[0]!.value!;
  const abandon = vi.spyOn(attachment, "abandon");
  const activate = vi.spyOn(attachment, "activate");
  const removed = vi.fn();
  const removeListener = broker.events.onRemoved(removed);
  cleanups.push(async () => {
    dispose();
    removeListener();
    await broker.resources.beginShutdown();
  });
  const notifications = vi.fn();
  client.onNotification("events/deliver", notifications);
  const publish = (subscriptionId: string) =>
    broker.events.publish(
      owner,
      subscriptionId,
      { kind: "devices.catalog", data: { revision: 1, providers: [], sessions: [] } },
      "control",
    );
  return {
    broker,
    host,
    client,
    trace,
    beforeSend,
    attachment,
    abandon,
    activate,
    removed,
    notifications,
    owner,
    publish,
    dispose,
    changeOwner(patch: Partial<typeof owner>) {
      current = { ...p, kind: "plugin", owner: { ...owner, ...patch } };
    },
  };
}

// Fault injection wraps the real broker request; subscription allocation, queues and
// cleanup still use the production broker and common ledger.
function interceptSubscription(
  f: ReturnType<typeof pairedFixture>,
  intercept: (result: Awaited<ReturnType<DeviceBrokerPort["request"]>>) => void,
  invalidResult = false,
) {
  const request = f.broker.request.bind(f.broker);
  return vi
    .spyOn(f.broker, "request")
    .mockImplementation(async (principal, method, params, signal) => {
      const result = await request(principal, method, params, signal);
      if (method === "devices/subscribe") {
        intercept(result);
        if (invalidResult && result.ok && "subscriptionId" in result.value)
          return {
            ok: true,
            value: { subscriptionId: result.value.subscriptionId, sequence: 0 },
          } as never;
      }
      return result;
    });
}

async function subscribe(f: ReturnType<typeof pairedFixture>) {
  const result = await f.client.request("devices/subscribe", { topic: "catalog" });
  if (!result.ok) throw new Error("subscribe failed");
  return result.value.subscriptionId;
}

describe("actual broker and paired RpcPeer publication", () => {
  it("publishes the serialized subscription reply before queued delivery and before the caller resumes", async () => {
    const f = pairedFixture();
    await f.client.request("devices/negotiate", {});
    interceptSubscription(f, (result) => {
      if (!result.ok || !("subscriptionId" in result.value)) throw new Error("subscribe failed");
      f.publish(result.value.subscriptionId);
      expect(f.broker.events.diagnostics().queuedBytes).toBeGreaterThan(0);
      expect(f.notifications).not.toHaveBeenCalled();
    });
    let resumed = false;
    f.notifications.mockImplementation(() => {
      expect(resumed).toBe(false);
    });
    const subscriptionId = await subscribe(f);
    resumed = true;
    expect(f.notifications).toHaveBeenCalledOnce();
    expect(f.trace.slice(-2)).toMatchObject([
      { result: { ok: true, value: { subscriptionId } } },
      { method: "events/deliver" },
    ]);
    expect(f.activate).toHaveBeenCalledExactlyOnceWith(subscriptionId);
    expect(f.abandon).not.toHaveBeenCalled();
    await f.client.request("events/ack", { subscriptionId, sequence: 1 });
    expect(f.broker.events.diagnostics().queuedBytes).toBe(0);
    await f.client.request("events/unsubscribe", { subscriptionId });
    expect(f.broker.events.diagnostics()).toEqual({
      subscriptions: 0,
      queuedEvents: 0,
      queuedBytes: 0,
    });
  });

  it.each(["send-throws", "invalid-result", "cancel", "close"] as const)(
    "abandons an inactive real subscription exactly once on %s",
    async (failure) => {
      const f = pairedFixture();
      await f.client.request("devices/negotiate", {});
      const controller = new AbortController();
      let subscriptionId = "";
      interceptSubscription(
        f,
        (result) => {
          if (!result.ok || !("subscriptionId" in result.value))
            throw new Error("subscribe failed");
          subscriptionId = result.value.subscriptionId;
          f.publish(subscriptionId);
          expect(f.broker.events.diagnostics().queuedBytes).toBeGreaterThan(0);
          if (failure === "cancel") controller.abort();
          if (failure === "close") {
            f.host.close();
            f.client.close();
          }
        },
        failure === "invalid-result",
      );
      f.beforeSend.mockImplementation((message) => {
        if (failure === "send-throws" && message.result?.value?.subscriptionId)
          throw new Error("subscription reply send failed");
      });
      await expect(
        f.client.request("devices/subscribe", { topic: "catalog" }, { signal: controller.signal }),
      ).rejects.toThrow();
      await vi.waitFor(() => expect(f.abandon).toHaveBeenCalledExactlyOnceWith(subscriptionId));
      expect(f.activate).not.toHaveBeenCalled();
      expect(f.notifications).not.toHaveBeenCalled();
      expect(f.removed).toHaveBeenCalledExactlyOnceWith(subscriptionId);
      expect(f.broker.events.diagnostics()).toEqual({
        subscriptions: 0,
        queuedEvents: 0,
        queuedBytes: 0,
      });
    },
  );

  it.each([
    { sourceKey: "dev:0000000000000002" },
    { pluginId: "test.other" },
    { generation: 2 },
    { hostEpoch: id(6) },
    { processEpoch: id(7) },
  ])("rejects a changed full owner before actual notification send: %j", async (patch) => {
    const f = pairedFixture();
    await f.client.request("devices/negotiate", {});
    const subscriptionId = await subscribe(f);
    f.changeOwner(patch);
    expect(() => f.publish(subscriptionId)).toThrow("owner");
    expect(f.notifications).not.toHaveBeenCalled();
    expect(f.trace.some((message) => message.method === "events/deliver")).toBe(false);
    expect(f.broker.events.diagnostics()).toEqual({
      subscriptions: 0,
      queuedEvents: 0,
      queuedBytes: 0,
    });
  });

  it.each([
    { kind: "ui.instances", data: { instances: [] } },
    {
      kind: "settings.changed",
      data: {
        revision: "r_00000000000000000000000000000001",
        schemaVersion: 1,
        changedKeys: [],
        cause: "update",
      },
    },
  ] satisfies Stage3Event[])(
    "rejects unnegotiated and unpublished $kind before sending",
    async (event) => {
      for (const negotiateFutureDomain of [false, true]) {
        const f = pairedFixture();
        await f.client.request("devices/negotiate", {});
        const subscriptionId = await subscribe(f);
        if (negotiateFutureDomain)
          f.attachment.negotiated(event.kind === "ui.instances" ? "ui" : "settings", 1);
        expect(() =>
          f.broker.events.publish(f.owner, subscriptionId, structuredClone(event), "control"),
        ).toThrow();
        expect(f.notifications).not.toHaveBeenCalled();
        expect(f.trace.some((message) => message.method === "events/deliver")).toBe(false);
        expect(f.broker.events.diagnostics()).toEqual({
          subscriptions: 0,
          queuedEvents: 0,
          queuedBytes: 0,
        });
      }
    },
  );

  it("retires the sink and all subscriptions after a notification send throws", async () => {
    const f = pairedFixture();
    await f.client.request("devices/negotiate", {});
    const first = await subscribe(f);
    const second = await subscribe(f);
    f.beforeSend.mockImplementation((message) => {
      if (message.method === "events/deliver") throw new Error("notification send failed");
    });
    expect(() => f.publish(first)).toThrow("notification send failed");
    expect.soft(f.broker.events.diagnostics()).toEqual({
      subscriptions: 0,
      queuedEvents: 0,
      queuedBytes: 0,
    });
    f.beforeSend.mockReset();
    expect.soft(() => f.publish(second)).toThrow();
    expect(f.notifications).not.toHaveBeenCalled();
  });
});

it("validates malformed wire before reading a changed host principal", async () => {
  let current = p;
  const principal = vi.fn(() => current);
  const f = fixture(principal);
  current = {
    ...p,
    kind: "plugin",
    owner: { ...(p as Extract<Principal, { kind: "plugin" }>).owner, processEpoch: id(10) },
  };
  principal.mockClear();
  expect(await f.call("devices/negotiate", { holder: true })).toMatchObject({
    error: { code: -32602 },
  });
  expect(principal).not.toHaveBeenCalled();
  expect(await f.call("devices/negotiate", {})).toMatchObject({
    error: { message: "Device channel owner changed." },
  });
  expect(principal).toHaveBeenCalledOnce();
  expect(f.request).not.toHaveBeenCalled();
});

it("passes the real cancellation signal without retrying or rewriting accepted broker state", async () => {
  const f = fixture();
  const accepted = Object.freeze({
    ok: false,
    error: Object.freeze({
      code: "PLUGIN_E_DEVICE_STOP_UNCONFIRMED",
      message: "reply lost",
      detail: Object.freeze({
        kind: "device",
        reason: "readback-failed",
        operationId: id(3),
        dispatch: "unknown",
        stopConfirmation: "unconfirmed",
      }),
    }),
  });
  let finish!: (value: unknown) => void;
  f.request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const start = f.call("devices/motion/start", { operationId: id(3) });
  const signal = f.request.mock.calls[0]![3];
  expect(signal.aborted).toBe(false);
  f.listener(JSON.stringify({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 1 } }));
  expect(signal.aborted).toBe(true);
  finish(accepted);
  expect(await start).toHaveProperty("error");
  f.request.mockResolvedValueOnce(accepted);
  expect((await f.call("devices/motion/query", { operationId: id(3) })).result).toEqual(accepted);
  expect(f.request.mock.calls.map((call) => call[1])).toEqual([
    "devices/motion/start",
    "devices/motion/query",
  ]);
});

it("rejects an unknown event kind through the real ledger and RpcPeer sink", async () => {
  const f = pairedFixture();
  await f.client.request("devices/negotiate", {});
  const subscriptionId = await subscribe(f);
  expect(() =>
    f.broker.events.publish(
      f.owner,
      subscriptionId,
      { kind: "events.unpublished", data: {} } as never,
      "control",
    ),
  ).toThrow();
  expect(f.notifications).not.toHaveBeenCalled();
  expect(f.broker.events.diagnostics()).toEqual({
    subscriptions: 0,
    queuedEvents: 0,
    queuedBytes: 0,
  });
});
