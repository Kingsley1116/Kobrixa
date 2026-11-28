import { afterEach, expect, it, vi } from "vitest";
import { createMemoryChannelPair, RpcPeer } from "@kobrixa/plugin-protocol";
import { createDeviceBroker } from "../device-broker/broker-port.js";
import { operationHarness, pluginPrincipal, ID } from "../device-broker/fake-provider.js";
import { attachDeviceRpc } from "../device-broker/rpc-router.js";
import { bindEventChannel } from "../../../../../packages/plugin-sdk-js/src/events.js";
import { createDevicesClient } from "../../../../../packages/plugin-sdk-js/src/devices.js";
import { cancelUiConnectionRecovery, createCoreActionLedger } from "./core-recovery.js";
const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((f) => f());
});
async function setup(version = "1.8.0", permission = true, recovery = false) {
  const h = operationHarness();
  const principal = pluginPrincipal();
  const actions = createCoreActionLedger({ now: () => 0, current: () => true });
  const broker = createDeviceBroker({
    profile: h.dependencies.profile,
    journal: h.dependencies.journal,
    now: h.dependencies.now,
    authority: {
      current: () =>
        recovery
          ? {
              ref: ID,
              epoch: ID,
              workbenchInstance: ID,
              state: "local",
              roomBinding: null,
              connected: false,
              synced: true,
              role: null,
              isHolder: true,
            }
          : null,
      assertContinuation: () => {
        if (!recovery) throw Error("observer acquired authority");
      },
      subscribe: () => () => {},
    },
    coreActions: actions,
    hasPermission: () => permission,
    requirements: () => [],
    operationGate: () => ({ ok: true, value: null }),
    connectionPolicy: () => ({
      wifiConnectTimeoutMs: 5000,
      wifiHandshakeTimeoutMs: 3000,
      usbAutoReconnect: recovery,
      usbRetryInterval: 10000,
      usbRetryLimit: 3,
    }),
  });
  const [a, b] = createMemoryChannelPair();
  const host = new RpcPeer(a),
    child = new RpcPeer(b);
  const off = attachDeviceRpc({ peer: host, principal: () => principal, broker });
  cleanup.push(() => {
    off();
    host.close();
    child.close();
  });
  child.handle("initialize", () => ({
    apiVersion: version,
    sdk: { name: "fixture", version: "1.8.0" },
  }));
  await host.request("initialize", {
    apiVersion: "1.8.0",
    pluginId: principal.owner.pluginId,
    locale: "en",
    grantedPermissions: ["devices.read"],
  });
  await child.request("devices/negotiate", {});
  return { broker, host, child, principal, actions, provider: h.provider };
}
it("actual broker/router read is observer-only; recovery shares normal subscription quota", async () => {
  const f = await setup();
  expect(await f.child.request("devices/connectionRecovery/read", {})).toMatchObject({
    ok: true,
    value: { hostEpoch: ID, recovery: null },
  });
  const subscriptions: string[] = [];
  for (let i = 0; i < 32; i++) {
    const r = await f.child.request("devices/subscribe", { topic: "connectionRecovery" });
    if (!r.ok) throw Error(JSON.stringify(r));
    subscriptions.push(r.value.subscriptionId);
    expect(r.value.snapshot).toMatchObject({ hostEpoch: ID, recovery: null });
  }
  expect(await f.child.request("devices/subscribe", { topic: "connectionRecovery" })).toMatchObject(
    { ok: false, error: { code: "PLUGIN_E_RESOURCE_LIMIT" } },
  );
  expect(f.broker.events.diagnostics().subscriptions).toBe(32);
  for (const subscriptionId of subscriptions)
    await f.child.request("events/unsubscribe", { subscriptionId });
  expect(f.broker.events.diagnostics().subscriptions).toBe(0);
});
it.each(["1.5.0", "1.6.0", "1.7.0"])(
  "actual router never exposes recovery to effective %s",
  async (version) => {
    const f = await setup(version);
    const request = vi.spyOn(f.broker, "request");
    await expect(f.child.request("devices/connectionRecovery/read", {})).rejects.toThrow();
    await expect(
      f.child.request("devices/subscribe", { topic: "connectionRecovery" }),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(f.broker.events.diagnostics().subscriptions).toBe(0);
  },
);
it("actual router preserves permission rejection and activates through original afterReply", async () => {
  const denied = await setup("1.8.0", false);
  expect(await denied.child.request("devices/connectionRecovery/read", {})).toMatchObject({
    ok: false,
    error: { code: "PLUGIN_E_PERMISSION_DENIED" },
  });
  const f = await setup();
  const seen = vi.fn();
  f.child.onNotification("events/deliver", seen);
  const original = f.broker.events.activate.bind(f.broker.events);
  vi.spyOn(f.broker.events, "activate").mockImplementation((owner, id) => {
    // The real ledger buffers before activation; RpcPeer has already correlated the published reply.
    f.broker.events.publish(
      owner,
      id,
      {
        kind: "devices.connectionRecovery",
        data: { hostEpoch: owner.hostEpoch, revision: 1, recovery: null },
      },
      "control",
    );
    original(owner, id);
  });
  const r = await f.child.request("devices/subscribe", { topic: "connectionRecovery" });
  if (!r.ok) throw Error("subscribe");
  await vi.waitFor(() => expect(seen).toHaveBeenCalledOnce());
  expect(seen.mock.calls[0]![0]).toMatchObject({
    subscriptionId: r.value.subscriptionId,
    kind: "devices.connectionRecovery",
    sequence: 1,
  });
  await f.child.request("events/unsubscribe", { subscriptionId: r.value.subscriptionId });
});

it("fresh JS observer reads real broker loss and receives trusted exact-episode cancellation", async () => {
  const f = await setup("1.8.0", true, true);
  const provider = f.provider;
  provider.describe = () => ({
    key: provider.session,
    descriptor: { ...provider.descriptor, transport: "usb" },
    physical: provider.physical,
    capabilities: [...provider.capabilities],
  });
  f.broker.registerProvider(provider);
  try {
    const connected = await f.broker.request(
      f.principal,
      "devices/connect",
      {
        target: { kind: "wifi-address", providerId: provider.id, address: "127.0.0.1" },
      },
      new AbortController().signal,
    );
    if (!connected.ok) throw Error(JSON.stringify(connected));
    provider.lose();
    bindEventChannel(f.child, f.principal.owner);
    const client = createDevicesClient(f.child, Promise.resolve("1.8.0"));
    await Promise.resolve();
    const observed = await client.connectionRecovery.read({});
    if (!observed.ok || !observed.value.recovery) throw Error("missing retained loss");
    const episode = observed.value.recovery;
    expect(episode.phase).toBe("waiting");
    const seen = vi.fn();
    const subscription = await client.subscribe({ topic: "connectionRecovery" }, seen);
    if (!subscription.ok) throw Error("subscribe");
    const connectCalls = provider.calls.filter((call) => call === "connect").length;
    const scope = { hostEpoch: ID, workbenchInstance: ID };
    expect(
      (
        await cancelUiConnectionRecovery({
          owner: f.principal.owner,
          recoveryId: episode.recoveryId,
          recovery: f.broker.connectionRecovery,
          principal: () => f.principal,
          hasPermission: (_principal, permission) => permission === "devices.read",
          current: () => true,
          scope: () => scope,
          currentScope: () => true,
          actions: f.actions,
        })
      ).ok,
    ).toBe(true);
    await vi.waitFor(() =>
      expect(subscription.value.snapshot).toMatchObject({
        recovery: { recoveryId: episode.recoveryId, phase: "cancelled", reason: "user" },
      }),
    );
    expect(seen.mock.calls.map(([event]) => event.data.recovery.phase)).toEqual([
      "cancelling",
      "cancelled",
    ]);
    expect(provider.calls.filter((call) => call === "connect")).toHaveLength(connectCalls);
    expect(f.actions.count()).toBe(0);
    // Business-terminal cancellation retains the observer for subsequent episodes.
    expect(f.broker.events.diagnostics().subscriptions).toBe(1);
    await subscription.value.dispose();
    expect(f.broker.events.diagnostics().subscriptions).toBe(0);
  } finally {
    await f.broker.resources.beginShutdown();
  }
});
