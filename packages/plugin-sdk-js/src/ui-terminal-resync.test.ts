import { afterEach, expect, it, vi } from "vitest";
import {
  createMemoryChannelPair,
  RpcPeer,
  type Stage3EventEnvelope,
  type UiRequestMapV2,
} from "@kobrixa/plugin-protocol";
import { bindEventChannel, eventInbox, EventInbox, uiEventClientPort } from "./events.js";
import { UiClient, type UiResyncRequiredNotice } from "./ui.js";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = {
  sourceKey: "builtin:test.ui",
  pluginId: "test.ui",
  generation: 1,
  hostEpoch: id(1),
  processEpoch: id(2),
};
const snapshot = { instances: [], states: [], locale: "en" as const, theme: "light" as const };
const terminal = (carrier: string, affected = [carrier], sequence = 1): Stage3EventEnvelope => ({
  version: 1,
  owner,
  subscriptionId: carrier,
  sequence,
  delivery: "control",
  kind: "events.resyncRequired",
  data: { reason: "overflow", affected },
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
function setup() {
  const [a, b] = createMemoryChannelPair();
  const host = new RpcPeer(a),
    peer = new RpcPeer(b);
  const calls: string[] = [];
  let next = 100;
  host.handle("ui/subscribe", () => ({
    ok: true,
    value: { subscriptionId: id(next++), sequence: 0, snapshot },
  }));
  host.handle("events/ack", ({ sequence }) => {
    calls.push("ack");
    return { ok: true as const, value: { acknowledged: sequence } };
  });
  host.handle("events/unsubscribe", () => {
    calls.push("cleanup");
    return { ok: true as const, value: { removed: false } };
  });
  host.handle("ui/snapshot", () => {
    calls.push("snapshot");
    return { ok: true, value: { sequence: 3, snapshot } };
  });
  bindEventChannel(peer, owner);
  const ui = new UiClient(peer.request.bind(peer), uiEventClientPort(peer));
  ui.markReady();
  cleanups.push(() => {
    ui.retire();
    host.close();
    peer.close();
  });
  const subscribe = async () => {
    const r = await ui.subscribe({ topics: ["environment"] }, () => {});
    if (!r.ok) throw Error("subscribe");
    return r.value.subscriptionId;
  };
  return { host, peer, ui, calls, subscribe };
}
it.each(["slow", "throw"])(
  "terminal cleans old UI slots before %s callback and preserves raw results",
  async (mode) => {
    const { ui, peer, calls, subscribe } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const notices: UiResyncRequiredNotice[] = [];
    ui.onResyncRequired(async (notice) => {
      notices.push(notice);
      await notice.cleanup;
      if (mode === "throw") throw Error("consumer");
      await gate;
    });
    const old = await subscribe();
    expect(eventInbox(peer).accept(terminal(old))).toBe(true);
    await vi.waitFor(() => expect(notices).toHaveLength(1));
    await notices[0]!.cleanup;
    expect(calls).toEqual(["ack", "cleanup"]);
    expect(eventInbox(peer).last(old)).toBe(0);
    const fresh = await subscribe();
    expect(fresh).not.toBe(old);
    await ui.unsubscribe(old);
    expect(eventInbox(peer).last(fresh)).toBe(0);
    expect(notices[0]!.subscriptions[0]!.isCurrent()).toBe(false);
    release();
    await tick();
  },
);
it("cross-domain terminal bypasses hung telemetry but preserves device callback order", async () => {
  const { ui, peer, subscribe, calls } = setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const seen: string[] = [];
  ui.onResyncRequired(() => {
    seen.push("ui-terminal");
  });
  const old = await subscribe(),
    device = id(200);
  const inbox = eventInbox(peer);
  inbox.open(
    device,
    async (e) => {
      seen.push(e.kind);
      if (e.kind === "devices.catalog") await gate;
    },
    async () => {
      seen.push("device-query");
    },
  );
  inbox.accept({
    version: 1,
    owner,
    subscriptionId: device,
    sequence: 1,
    delivery: "control",
    kind: "devices.catalog",
    data: { revision: 1, providers: [], sessions: [] },
  });
  await tick();
  expect(inbox.accept(terminal(device, [device, old], 2))).toBe(true);
  await vi.waitFor(() => expect(seen).toContain("ui-terminal"));
  expect(seen).not.toContain("device-query");
  expect(calls).not.toContain("snapshot");
  release();
  await vi.waitFor(() => expect(seen).toContain("events.resyncRequired"));
  expect(seen.indexOf("device-query")).toBeGreaterThan(seen.indexOf("devices.catalog"));
});
it("terminal before response adoption retains original params and remains on the control budget", async () => {
  const { ui, peer, host, calls } = setup();
  const seen: UiResyncRequiredNotice[] = [];
  ui.onResyncRequired((n) => {
    seen.push(n);
  });
  const old = id(300);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  host.handle("ui/subscribe", async () => {
    await gate;
    return { ok: true, value: { subscriptionId: old, sequence: 0, snapshot } };
  });
  const params: UiRequestMapV2["ui/subscribe"]["params"] = { topics: ["environment"] };
  const pending = ui.subscribe(params, () => {
    throw Error("UI-only callback must not get terminal");
  });
  params.topics[0] = "instances";
  expect(eventInbox(peer).accept(terminal(old))).toBe(true);
  await tick();
  release();
  await pending;
  await vi.waitFor(() => expect(seen).toHaveLength(1));
  expect(seen[0]!.subscriptions[0]!.params).toEqual({ topics: ["environment"] });
  expect(calls).not.toContain("snapshot");
  await seen[0]!.cleanup;
  expect(eventInbox(peer).accept(terminal(old))).toBe(false);
});
it.each(["retire", "detach", "unsubscribe"])("queued terminal is fenced by %s", async (mode) => {
  const { ui, peer, subscribe } = setup();
  const cb = vi.fn();
  const detach = ui.onResyncRequired(cb);
  const old = await subscribe();
  eventInbox(peer).accept(terminal(old));
  if (mode === "retire") {
    ui.retire();
    ui.markReady();
  } else if (mode === "detach") detach();
  else await ui.unsubscribe(old);
  await tick();
  expect(cb).not.toHaveBeenCalled();
});
it("ordinary gaps keep same-ID snapshot and exact watermark; wrong owners are not ACKed", async () => {
  const { ui, peer, calls } = setup();
  const cb = vi.fn(),
    terminalCb = vi.fn();
  ui.onResyncRequired(terminalCb);
  const r = await ui.subscribe({ topics: ["environment"] }, cb);
  if (!r.ok) throw Error();
  const event: Stage3EventEnvelope = {
    version: 1,
    owner,
    subscriptionId: r.value.subscriptionId,
    sequence: 2,
    delivery: "control",
    kind: "ui.environment",
    data: { locale: "en", theme: "dark" },
  };
  for (const field of [
    "sourceKey",
    "pluginId",
    "generation",
    "hostEpoch",
    "processEpoch",
  ] as const) {
    expect(
      eventInbox(peer).accept({
        ...terminal(r.value.subscriptionId),
        owner: {
          ...owner,
          [field]:
            field === "generation"
              ? 2
              : field === "sourceKey"
                ? "builtin:other.ui"
                : field === "pluginId"
                  ? "other.ui"
                  : id(999),
        },
      }),
    ).toBe(false);
  }
  expect(calls).toEqual([]);
  eventInbox(peer).accept(event);
  await vi.waitFor(() => expect(calls).toContain("snapshot"));
  await tick();
  expect(cb).not.toHaveBeenCalled();
  expect(terminalCb).not.toHaveBeenCalled();
  eventInbox(peer).accept({ ...event, sequence: 4 });
  await vi.waitFor(() => expect(cb).toHaveBeenCalledOnce());
});
it("common terminal queue shares eight controls, early budget, and 32 affected bookkeeping", async () => {
  const ack = vi.fn(async () => {});
  const inbox = new EventInbox(ack, owner);
  inbox.enable();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  inbox.terminalHandler(() => async () => {
    await gate;
  });
  const finish = inbox.beginSubscription();
  for (let n = 0; n < 8; n++) expect(inbox.accept(terminal(id(400 + n)))).toBe(true);
  expect(inbox.accept(terminal(id(410)))).toBe(false);
  expect(ack).toHaveBeenCalledTimes(8);
  finish();
  release();
  await tick();
  await tick();
  const finish2 = inbox.beginSubscription();
  expect(
    inbox.accept(
      terminal(
        id(500),
        Array.from({ length: 32 }, (_, n) => id(500 + n)),
      ),
    ),
  ).toBe(true);
  expect(inbox.accept(terminal(id(600)))).toBe(false);
  finish2();
  await tick();
});
it("actual EventLedger removal + UiSubscriptions are recovered by query/new subscribe, never old snapshot", async () => {
  // Dynamic source imports keep this integration probe out of the SDK declaration build.
  const registryPath = new URL(
    "../../../apps/desktop/src/main/device-broker/registry.ts",
    import.meta.url,
  ).href;
  const statePath = new URL("../../plugin-runtime/src/ui-state.ts", import.meta.url).href;
  const subscriptionsPath = new URL("../../plugin-runtime/src/ui-subscriptions.ts", import.meta.url)
    .href;
  const { EventLedger } = await import(/* @vite-ignore */ registryPath);
  const { UiStateRegistry } = await import(/* @vite-ignore */ statePath);
  const { UiSubscriptions } = await import(/* @vite-ignore */ subscriptionsPath);
  const { ui, peer, host, calls } = setup();
  let now = 0;
  const ledger = new EventLedger(
    () => now,
    (event: Stage3EventEnvelope) => host.notify("events/deliver", event),
    () => {},
  );
  const state = new UiStateRegistry({ current: () => true });
  const subscriptions = new UiSubscriptions(state, ledger, () => {});
  cleanups.push(() => {
    subscriptions.dispose();
    ledger.dispose();
  });
  host.handle("ui/subscribe", (params) => subscriptions.subscribe(owner, params));
  host.handle("ui/snapshot", ({ subscriptionId }) => {
    calls.push("old-snapshot");
    return subscriptions.snapshot(owner, subscriptionId);
  });
  host.handle("ui/instances", () => ({ ok: true, value: { instances: state.instances(owner) } }));
  host.handle("events/ack", ({ subscriptionId, sequence }) =>
    ledger.ack(owner, subscriptionId, sequence),
  );
  host.handle("events/unsubscribe", ({ subscriptionId }) =>
    subscriptions.unsubscribe(owner, subscriptionId),
  );
  const notices: UiResyncRequiredNotice[] = [];
  ui.onResyncRequired((n) => {
    notices.push(n);
  });
  for (const reason of ["overflow", "ack-timeout"]) {
    const r = await ui.subscribe({ topics: ["environment"] }, () => {});
    if (!r.ok) throw Error();
    const old = r.value.subscriptionId;
    ledger.activate(owner, old);
    if (reason === "overflow") ledger.resync(owner, old);
    else {
      ledger.publish(
        owner,
        old,
        { kind: "ui.environment", data: { locale: "en", theme: "dark" } },
        "control",
      );
      now += 10001;
      ledger.sweep();
    }
    await vi.waitFor(() => expect(notices).toHaveLength(reason === "overflow" ? 1 : 2));
    await notices.at(-1)!.cleanup;
    expect(ledger.owns(owner, old)).toBe(false);
    expect(subscriptions.snapshot(owner, old).ok).toBe(false);
    expect(calls).not.toContain("old-snapshot");
    expect((await ui.instances()).ok).toBe(true);
    const fresh = await ui.subscribe({ topics: ["environment"] }, () => {});
    if (!fresh.ok) throw Error();
    expect(fresh.value.subscriptionId).not.toBe(old);
    expect(fresh.value.snapshot).toEqual(snapshot);
    await ui.unsubscribe(old);
    expect(ledger.owns(owner, fresh.value.subscriptionId)).toBe(true);
    await ui.unsubscribe(fresh.value.subscriptionId);
  }
  expect(eventInbox(peer)).toBeDefined();
});

it("early UI adoption reaches its hook while the device carrier callback is hung", async () => {
  const { ui, peer, host } = setup();
  const inbox = eventInbox(peer),
    device = id(800),
    old = id(801);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  inbox.enable();
  inbox.open(
    device,
    () => gate,
    async () => {},
  );
  inbox.accept({
    version: 1,
    owner,
    subscriptionId: device,
    sequence: 1,
    delivery: "control",
    kind: "devices.catalog",
    data: { revision: 1, providers: [], sessions: [] },
  });
  await tick();
  let reply!: () => void;
  const pendingReply = new Promise<void>((r) => {
    reply = r;
  });
  host.handle("ui/subscribe", async () => {
    await pendingReply;
    return { ok: true, value: { subscriptionId: old, sequence: 0, snapshot } };
  });
  const seen = vi.fn();
  ui.onResyncRequired(seen);
  const pending = ui.subscribe({ topics: ["environment"] }, () => {});
  inbox.accept(terminal(device, [device, old], 2));
  await tick();
  reply();
  await pending;
  await vi.waitFor(() => expect(seen).toHaveBeenCalledOnce());
  release();
  await tick();
});
it("unsubscribe before early adoption cancels the exact old lifetime", async () => {
  const { ui, peer, host } = setup();
  const old = id(810);
  const seen = vi.fn();
  ui.onResyncRequired(seen);
  let reply!: () => void;
  const gate = new Promise<void>((r) => {
    reply = r;
  });
  host.handle("ui/subscribe", async () => {
    await gate;
    return { ok: true, value: { subscriptionId: old, sequence: 0, snapshot } };
  });
  const pending = ui.subscribe({ topics: ["environment"] }, () => {});
  eventInbox(peer).accept(terminal(old));
  await ui.unsubscribe(old);
  reply();
  await expect(pending).rejects.toThrow("cancelled");
  await tick();
  expect(seen).not.toHaveBeenCalled();
});
it("32 old UI IDs are cleaned before callback recovery; cleanup failure is observable", async () => {
  const { ui, peer, host, subscribe } = setup();
  const ids = [];
  for (let n = 0; n < 32; n++) ids.push(await subscribe());
  const seen: UiResyncRequiredNotice[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  ui.onResyncRequired(async (notice) => {
    seen.push(notice);
    await gate;
  });
  eventInbox(peer).accept(terminal(ids[0]!, ids));
  await vi.waitFor(() => expect(seen).toHaveLength(1));
  expect(await seen[0]!.cleanup).toHaveLength(32);
  const fresh = await subscribe();
  expect(ids).not.toContain(fresh);
  const detach = ui.onResyncRequired(async (notice) => {
    await expect(notice.cleanup).rejects.toThrow();
    seen.push(notice);
  });
  expect(seen[0]!.subscriptions.every((s) => s.signal.aborted && !s.isCurrent())).toBe(true);
  release();
  await tick();
  await tick();
  host.handle("events/unsubscribe", () => {
    throw Error("cleanup failed");
  });
  eventInbox(peer).accept(terminal(fresh));
  await vi.waitFor(() => expect(seen).toHaveLength(2));
  detach();
  release();
  await tick();
});

it("actual settings adapter keeps snapshot notice semantics on a cross-domain terminal", async () => {
  const { createPersistenceContext } = await import("./index.js");
  const { ui, peer, host, subscribe } = setup();
  const uiNotices = vi.fn();
  ui.onResyncRequired(uiNotices);
  const old = await subscribe(),
    settingsId = id(900),
    settingsSnapshot = { schemaVersion: 1, revision: null, values: [] };
  host.handle("settings/watch", () => ({
    ok: true,
    value: { subscriptionId: settingsId, sequence: 0, snapshot: settingsSnapshot },
  }));
  host.handle("settings/read", () => ({ ok: true, value: settingsSnapshot }));
  const listener = vi.fn();
  const settings = createPersistenceContext(peer).settings;
  await settings.watch({ schemaVersion: 1 }, undefined, listener);
  eventInbox(peer).accept(terminal(settingsId, [settingsId, old]));
  await vi.waitFor(() => expect(uiNotices).toHaveBeenCalledOnce());
  await vi.waitFor(() =>
    expect(listener).toHaveBeenCalledExactlyOnceWith({
      type: "snapshot",
      snapshot: settingsSnapshot,
    }),
  );
  await settings.unwatch({ subscriptionId: settingsId });
});

it("an early settings carrier still receives its own terminal snapshot after adoption", async () => {
  const { createPersistenceContext } = await import("./index.js");
  const { ui, peer, host, subscribe } = setup();
  const uiNotices = vi.fn();
  ui.onResyncRequired(uiNotices);
  const old = await subscribe(),
    settingsId = id(910),
    settingsSnapshot = { schemaVersion: 1, revision: null, values: [] };
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  host.handle("settings/watch", async () => {
    await gate;
    return {
      ok: true,
      value: { subscriptionId: settingsId, sequence: 0, snapshot: settingsSnapshot },
    };
  });
  host.handle("settings/read", () => ({ ok: true, value: settingsSnapshot }));
  const listener = vi.fn();
  const settings = createPersistenceContext(peer).settings;
  const pending = settings.watch({ schemaVersion: 1 }, undefined, listener);
  eventInbox(peer).accept(terminal(settingsId, [settingsId, old]));
  await vi.waitFor(() => expect(uiNotices).toHaveBeenCalledOnce());
  release();
  await pending;
  await vi.waitFor(() =>
    expect(listener).toHaveBeenCalledExactlyOnceWith({
      type: "snapshot",
      snapshot: settingsSnapshot,
    }),
  );
  await settings.unwatch({ subscriptionId: settingsId });
});

it("the 33rd subscribe preserves the host quota Result; local adoption failure cleans only its new ID", async () => {
  const { ui, host, peer, subscribe } = setup();
  for (let n = 0; n < 32; n++) await subscribe();
  const quota = {
    ok: false as const,
    error: {
      code: "PLUGIN_E_RESOURCE_LIMIT" as const,
      message: "Subscription limit",
      detail: {
        kind: "resource" as const,
        reason: "quota" as const,
        resource: "subscription" as const,
        limit: 32,
      },
    },
  };
  host.handle("ui/subscribe", () => quota);
  expect(await ui.subscribe({ topics: ["environment"] }, () => {})).toEqual(quota);
  const extra = id(999);
  host.handle("ui/subscribe", () => ({
    ok: true,
    value: { subscriptionId: extra, sequence: 0, snapshot },
  }));
  await expect(ui.subscribe({ topics: ["environment"] }, () => {})).rejects.toThrow(
    "Subscription queue full",
  );
  expect(eventInbox(peer).last(extra)).toBe(0);
  await ui.unsubscribe(id(100));
  host.handle("ui/subscribe", () => ({
    ok: true,
    value: { subscriptionId: id(998), sequence: 0, snapshot },
  }));
  expect((await ui.subscribe({ topics: ["environment"] }, () => {})).ok).toBe(true);
});
