import { afterEach, expect, it, vi } from "vitest";
import { createMemoryChannelPair, RpcPeer } from "@kobrixa/plugin-protocol";
import { createDeviceBroker } from "./broker-port.js";
import {
  operationHarness,
  pluginPrincipal,
  ID,
} from "./fake-provider.js";
import { attachDeviceRpc } from "./rpc-router.js";
import { bindEventChannel } from "../../../../../packages/plugin-sdk-js/src/events.js";
import { createDevicesClient } from "../../../../../packages/plugin-sdk-js/src/devices.js";
import { createCoreActionLedger } from "../plugins/core-recovery.js";
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

it("independent: terminal recovery cleanup releases both host observer quotas", async () => {
  const f = await setup();
  bindEventChannel(f.child, f.principal.owner);
  const client = createDevicesClient(f.child, Promise.resolve("1.8.0"));
  await Promise.resolve();
  const first = vi.fn(),
    second = vi.fn();
  const a = await client.subscribe({ topic: "connectionRecovery" }, first);
  const b = await client.subscribe({ topic: "connectionRecovery" }, second);
  if (!a.ok || !b.ok) throw Error("subscribe");
  f.broker.events.resync(f.principal.owner, a.value.subscriptionId);
  await vi.waitFor(() => {
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });
  expect(a.value.lastSequence).toBe(0);
  expect(b.value.lastSequence).toBe(0);
  // Explicitly replacing and disposing the new observer does not release the old affected row.
  const fresh = await client.subscribe({ topic: "connectionRecovery" }, vi.fn());
  if (!fresh.ok) throw Error("fresh subscribe");
  await fresh.value.dispose();
  expect(f.broker.events.diagnostics()).toEqual({
    subscriptions: 0,
    queuedEvents: 0,
    queuedBytes: 0,
  });
});

it("terminal cleanup drains all 32 recovery observers through the bounded RPC window", async () => {
  const f = await setup();
  bindEventChannel(f.child, f.principal.owner);
  const client = createDevicesClient(f.child, Promise.resolve("1.8.0"));
  await Promise.resolve();
  const seen = vi.fn();
  const ids: string[] = [];
  for (let i = 0; i < 32; i++) {
    const sub = await client.subscribe({ topic: "connectionRecovery" }, seen);
    if (!sub.ok) throw Error("subscribe");
    ids.push(sub.value.subscriptionId);
  }
  f.broker.events.resync(f.principal.owner, ids[0]!);
  await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(32));
  expect(f.broker.events.diagnostics()).toEqual({
    subscriptions: 0,
    queuedEvents: 0,
    queuedBytes: 0,
  });
});
