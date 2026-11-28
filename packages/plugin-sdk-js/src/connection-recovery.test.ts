import { afterEach, expect, it, vi } from "vitest";
import {
  createMemoryChannelPair,
  RpcPeer,
  type ConnectionRecoverySnapshot,
} from "@kobrixa/plugin-protocol";
import { createDevicesClient } from "./devices.js";
import { EventInbox, bindEventChannel, eventInbox } from "./events.js";
const id = "00000000-0000-4000-8000-000000000001";
const owner = {
  sourceKey: "builtin:test.recovery",
  pluginId: "test.recovery",
  generation: 1,
  hostEpoch: id,
  processEpoch: id,
};
const snapshot: ConnectionRecoverySnapshot = { hostEpoch: id, revision: 1, recovery: null };
const peers: RpcPeer[] = [];
afterEach(() => {
  peers.splice(0).forEach((p) => p.close());
  vi.useRealTimers();
});
const tick = () => new Promise<void>((r) => setImmediate(r));
async function fixture(version = "1.8.0") {
  const [a, b] = createMemoryChannelPair();
  const host = new RpcPeer(a),
    plugin = new RpcPeer(b);
  peers.push(host, plugin);
  plugin.handle("initialize", () => ({
    apiVersion: version,
    sdk: { name: "test", version: "1.8.0" },
  }));
  host.handle("devices/negotiate", () => ({
    ok: true as const,
    value: {
      devicesContractVersion: 1 as const,
      eventVersion: 1 as const,
      capabilities: [],
      requirementsSatisfied: true,
    },
  }));
  host.handle("events/ack", (p) => ({ ok: true as const, value: { acknowledged: p.sequence } }));
  host.handle("events/unsubscribe", () => ({ ok: true as const, value: { removed: true } }));
  host.handle("devices/subscribe", () => ({
    ok: true as const,
    value: { subscriptionId: id, sequence: 0 as const, snapshot },
  }));
  const read = vi.fn(async () => ({ ok: true as const, value: snapshot }));
  host.handle("devices/connectionRecovery/read", read);
  await host.request("initialize", {
    apiVersion: "1.8.0",
    pluginId: owner.pluginId,
    locale: "en",
    grantedPermissions: [],
  });
  bindEventChannel(plugin, owner);
  const client = createDevicesClient(plugin, Promise.resolve(version));
  await Promise.resolve();
  return { host, plugin, client, read };
}
it("read is negotiated, read-only, five seconds, one call, no automatic retry", async () => {
  const f = await fixture();
  expect(await f.client.connectionRecovery.read({})).toEqual({ ok: true, value: snapshot });
  expect(f.read).toHaveBeenCalledOnce();
  await f.client.negotiate();
  vi.useFakeTimers();
  const pendingRead = vi.fn(() => new Promise<never>(() => {}));
  f.host.handle("devices/connectionRecovery/read", pendingRead);
  const pending = f.client.connectionRecovery.read({});
  const rejected = expect(pending).rejects.toMatchObject({ code: -32001 });
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
  expect(pendingRead).toHaveBeenCalledOnce();
});
it.each(["1.5.0", "1.6.0", "1.7.0"])("old session %s never sends recovery", async (version) => {
  const f = await fixture(version);
  expect((await f.client.connectionRecovery.read({})).ok).toBe(false);
  expect(f.read).not.toHaveBeenCalled();
});
it("shared events update snapshots monotonically and disposal stops delivery", async () => {
  const f = await fixture();
  const listener = vi.fn();
  const result = await f.client.subscribe({ topic: "connectionRecovery" }, listener);
  if (!result.ok) throw Error("subscribe");
  const event = (sequence: number, revision: number) => ({
    version: 1 as const,
    owner,
    subscriptionId: id,
    sequence,
    delivery: "control" as const,
    kind: "devices.connectionRecovery" as const,
    data: { ...snapshot, revision },
  });
  f.host.notify("events/deliver", event(1, 3));
  await tick();
  f.host.notify("events/deliver", event(2, 2));
  await tick();
  expect(result.value.snapshot).toEqual({ ...snapshot, revision: 3 });
  expect(listener).toHaveBeenCalledOnce();
  await result.value.dispose();
  expect(() => f.host.notify("events/deliver", event(3, 4))).toThrow();
});
it("abort before/after await and shutdown fence the original read", async () => {
  const f = await fixture();
  const abort = new AbortController();
  abort.abort();
  await expect(f.client.connectionRecovery.read({}, abort.signal)).rejects.toThrow();
  expect(f.read).not.toHaveBeenCalled();
  await f.client.negotiate();
  let done!: (r: { ok: true; value: ConnectionRecoverySnapshot }) => void;
  f.host.handle(
    "devices/connectionRecovery/read",
    () =>
      new Promise((r) => {
        done = r;
      }),
  );
  const controller = new AbortController();
  const pending = f.client.connectionRecovery.read({}, controller.signal);
  const rejected = expect(pending).rejects.toThrow();
  await tick();
  controller.abort();
  await rejected;
  done({ ok: true, value: snapshot });
  await tick();
  f.plugin.handle("shutdown", () => null);
  await f.host.request("shutdown", {});
  await expect(f.client.connectionRecovery.read({})).rejects.toThrow();
});

it("sequence-gap catchup reads recovery only and never replaces newer projections", async () => {
  const f = await fixture();
  const listener = vi.fn();
  const result = await f.client.subscribe({ topic: "connectionRecovery" }, listener);
  if (!result.ok) throw Error("subscribe");
  f.read.mockResolvedValue({ ok: true, value: { ...snapshot, revision: 4 } });
  const emit = async (sequence: number, revision: number) => {
    f.host.notify("events/deliver", {
      version: 1,
      owner,
      subscriptionId: id,
      sequence,
      delivery: "control",
      kind: "devices.connectionRecovery",
      data: { ...snapshot, revision },
    });
    await tick();
  };
  await emit(2, 2);
  expect(result.value.snapshot).toEqual({ ...snapshot, revision: 4 });
  expect(listener).not.toHaveBeenCalled();
  await emit(3, 5);
  await emit(5, 6); // Older catchup read cannot replace revision 5; revision 6 then advances it.
  expect(result.value.snapshot).toEqual({ ...snapshot, revision: 6 });
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(listener).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  "recovery terminal closes carrier and secondary observers without refreshing or resuming (UI handler %s)",
  async (withUi) => {
    const f = await fixture();
    if (withUi) eventInbox(f.plugin).terminalHandler(() => undefined);
    let count = 0;
    f.host.handle("devices/subscribe", () => ({
      ok: true as const,
      value: { subscriptionId: id.slice(0, -1) + String(++count), sequence: 0 as const, snapshot },
    }));
    const first = vi.fn(),
      second = vi.fn();
    const a = await f.client.subscribe({ topic: "connectionRecovery" }, first),
      b = await f.client.subscribe({ topic: "connectionRecovery" }, second);
    if (!a.ok || !b.ok) throw Error("subscribe");
    const terminal = {
      version: 1 as const,
      owner,
      subscriptionId: a.value.subscriptionId,
      sequence: 1,
      delivery: "control" as const,
      kind: "events.resyncRequired" as const,
      data: {
        reason: "overflow" as const,
        affected: [a.value.subscriptionId, b.value.subscriptionId],
      },
    };
    f.host.notify("events/deliver", terminal);
    await tick();
    await tick();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(f.read).not.toHaveBeenCalled();
    expect(() =>
      f.host.notify("events/deliver", {
        ...terminal,
        sequence: 2,
        kind: "devices.connectionRecovery",
        data: { ...snapshot, revision: 2 },
      }),
    ).toThrow();
    // A fresh explicit subscription remains usable; no automatic resubscribe occurred.
    expect(count).toBe(2);
    const fresh = await f.client.subscribe({ topic: "connectionRecovery" }, vi.fn());
    expect(fresh.ok).toBe(true);
  },
);

it("pure recovery terminal waits for catchup and drops its queued event before notifying", async () => {
  const ack = vi.fn(async () => {});
  const inbox = new EventInbox(ack, owner);
  inbox.enable();
  let release!: () => void;
  const refresh = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const listener = vi.fn();
  const terminal = vi.fn();
  inbox.open(id, listener, refresh, 0, terminal);
  expect(
    inbox.accept({
      version: 1,
      owner,
      subscriptionId: id,
      sequence: 2,
      delivery: "control",
      kind: "devices.connectionRecovery",
      data: snapshot,
    }),
  ).toBe(true);
  await tick();
  expect(refresh).toHaveBeenCalledOnce();
  expect(
    inbox.accept({
      version: 1,
      owner,
      subscriptionId: id,
      sequence: 3,
      delivery: "control",
      kind: "events.resyncRequired",
      data: { reason: "overflow", affected: [id] },
    }),
  ).toBe(true);
  await tick();
  expect(ack).toHaveBeenCalledTimes(2);
  expect(terminal).not.toHaveBeenCalled();
  release();
  await tick();
  expect(listener).not.toHaveBeenCalled();
  expect(terminal).toHaveBeenCalledOnce();
  expect(inbox.last(id)).toBe(0);
});

it("pure recovery terminal arriving before subscription adoption closes the late slot", async () => {
  const inbox = new EventInbox(async () => {}, owner);
  inbox.enable();
  const finish = inbox.beginSubscription(true);
  const event = {
    version: 1,
    owner,
    subscriptionId: id,
    sequence: 1,
    delivery: "control",
    kind: "events.resyncRequired",
    data: { reason: "overflow", affected: [id] },
  };
  expect(inbox.accept(event)).toBe(true);
  await tick();
  const listener = vi.fn(),
    refresh = vi.fn(async () => {}),
    terminal = vi.fn();
  inbox.open(id, listener, refresh, 0, terminal);
  finish();
  await tick();
  expect(terminal).toHaveBeenCalledOnce();
  expect(refresh).not.toHaveBeenCalled();
  expect(listener).not.toHaveBeenCalled();
  expect(inbox.accept({ ...event, sequence: 2 })).toBe(false);
});

it.each(["close", "shutdown", "downgrade"])(
  "independent: queued recovery callback is fenced by %s",
  async (mode) => {
    const f = await fixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const revisions: number[] = [];
    const result = await f.client.subscribe({ topic: "connectionRecovery" }, async (e) => {
      if (e.kind !== "devices.connectionRecovery") return;
      revisions.push(e.data.revision);
      if (revisions.length === 1) await blocked;
    });
    if (!result.ok) throw Error("subscribe");
    const emit = (sequence: number) =>
      f.host.notify("events/deliver", {
        version: 1,
        owner,
        subscriptionId: id,
        sequence,
        delivery: "control",
        kind: "devices.connectionRecovery",
        data: { ...snapshot, revision: sequence + 1 },
      });
    emit(1);
    await tick();
    emit(2);
    await tick();
    expect(revisions).toEqual([2]);
    if (mode === "close") f.plugin.close();
    if (mode === "shutdown") {
      f.plugin.handle("shutdown", () => null);
      await f.host.request("shutdown", {});
    }
    if (mode === "downgrade") {
      f.plugin.handle("initialize", () => ({
        apiVersion: "1.7.0",
        sdk: { name: "test", version: "1.7.0" },
      }));
      await f.host.request("initialize", {
        apiVersion: "1.7.0",
        pluginId: owner.pluginId,
        locale: "en",
        grantedPermissions: [],
      });
    }
    expect(f.plugin.connectionRecoveryReady).toBe(false);
    release();
    await tick();
    await tick();
    expect(revisions).toEqual([2]);
  },
);

it("terminal unsubscribe starts before listener drain; dispose joins it and suppresses terminal delivery", async () => {
  const f = await fixture();
  let releaseCallback!: () => void, releaseCleanup!: () => void;
  const callback = new Promise<void>((resolve) => {
    releaseCallback = resolve;
  });
  const cleanup = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const seen: string[] = [];
  const unsub = vi.fn(async () => {
    await cleanup;
    return { ok: true as const, value: { removed: true } };
  });
  f.host.handle("events/unsubscribe", unsub);
  const sub = await f.client.subscribe({ topic: "connectionRecovery" }, async (e) => {
    seen.push(e.kind);
    if (e.kind === "devices.connectionRecovery") await callback;
  });
  if (!sub.ok) throw Error("subscribe");
  f.host.notify("events/deliver", {
    version: 1,
    owner,
    subscriptionId: id,
    sequence: 1,
    delivery: "control",
    kind: "devices.connectionRecovery",
    data: snapshot,
  });
  await tick();
  f.host.notify("events/deliver", {
    version: 1,
    owner,
    subscriptionId: id,
    sequence: 2,
    delivery: "control",
    kind: "events.resyncRequired",
    data: { reason: "overflow", affected: [id] },
  });
  await tick();
  expect(unsub).toHaveBeenCalledOnce();
  const disposed = sub.value.dispose();
  releaseCleanup();
  await disposed;
  releaseCallback();
  await tick();
  await tick();
  expect(unsub).toHaveBeenCalledOnce();
  expect(seen).toEqual(["devices.connectionRecovery"]);
});

it("terminal notification waits for host cleanup and cannot revive after retirement", async () => {
  const f = await fixture();
  let release!: () => void;
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  f.host.handle("events/unsubscribe", async () => {
    await blocked;
    return { ok: true as const, value: { removed: true } };
  });
  const seen = vi.fn();
  await f.client.subscribe({ topic: "connectionRecovery" }, seen);
  f.host.notify("events/deliver", {
    version: 1,
    owner,
    subscriptionId: id,
    sequence: 1,
    delivery: "control",
    kind: "events.resyncRequired",
    data: { reason: "overflow", affected: [id] },
  });
  await tick();
  expect(seen).not.toHaveBeenCalled();
  f.plugin.close();
  release();
  await tick();
  await tick();
  expect(seen).not.toHaveBeenCalled();
});

import { runPlugin, type PluginContext } from "./index.js";
it("actual SDK reinitialization at 1.8 cannot revive an old observer after fresh negotiation", async () => {
  vi.stubEnv("KOBRIXA_RESOURCE_OWNER", JSON.stringify(owner));
  const [a, b] = createMemoryChannelPair();
  const host = new RpcPeer(a);
  peers.push(host);
  let context!: PluginContext;
  const plugin = await runPlugin(
    {
      activate(c) {
        context = c;
      },
    },
    { channel: b, exit() {} },
  );
  peers.push(plugin);
  vi.unstubAllEnvs();
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
  host.handle("events/ack", (p) => ({ ok: true as const, value: { acknowledged: p.sequence } }));
  const unsubscribe = vi.fn(() => ({ ok: true as const, value: { removed: true } }));
  host.handle("events/unsubscribe", unsubscribe);
  let serial = 0;
  host.handle("devices/subscribe", () => ({
    ok: true as const,
    value: {
      subscriptionId: id.slice(0, -1) + String(++serial),
      sequence: 0 as const,
      snapshot,
    },
  }));
  const initialize = () =>
    host.request("initialize", {
      apiVersion: "1.8.0",
      pluginId: owner.pluginId,
      locale: "en",
      grantedPermissions: [],
    });
  await initialize();
  let release!: () => void;
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  const seen: number[] = [];
  await context.devices.subscribe({ topic: "connectionRecovery" }, async (e) => {
    if (e.kind === "devices.connectionRecovery") {
      seen.push(e.data.revision);
      await blocked;
    }
  });
  const emit = (sequence: number) =>
    host.notify("events/deliver", {
      version: 1,
      owner,
      subscriptionId: id,
      sequence,
      delivery: "control",
      kind: "devices.connectionRecovery",
      data: { ...snapshot, revision: sequence + 1 },
    });
  emit(1);
  await tick();
  emit(2);
  await tick();
  await initialize();
  expect((await context.devices.subscribe({ topic: "connectionRecovery" }, vi.fn())).ok).toBe(true);
  expect(plugin.connectionRecoveryReady).toBe(true);
  release();
  await tick();
  await tick();
  expect(seen).toEqual([2]);
  expect(serial).toBe(2);
  expect(negotiate).toHaveBeenCalledTimes(2);
  expect(unsubscribe).toHaveBeenCalledOnce();
});
