import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  connectionRecoverySnapshotSchema,
  validateConnectionRecoverySnapshot,
} from "./device-connection-recovery.js";
import {
  deviceRequestSchemas,
  deviceRequestSchemasV180,
  validDeviceResultV180,
} from "./device-methods.js";
import { eventEnvelopeSchema, eventEnvelopeSchemaV180 } from "./events.js";
import { RpcPeer } from "./peer.js";
import { createMemoryChannelPair } from "./memory-channel.js";
const cases = JSON.parse(
  readFileSync(
    new URL("../test-fixtures/connection-recovery-v180/cases.json", import.meta.url),
    "utf8",
  ),
) as Array<{ id: string; valid: boolean; snapshot: unknown }>;
it.each(cases)("shared recovery vector $id", ({ valid, snapshot }) => {
  if (valid) expect(validateConnectionRecoverySnapshot(snapshot)).toEqual(snapshot);
  else expect(() => validateConnectionRecoverySnapshot(snapshot)).toThrow();
});
const id = "00000000-0000-4000-8000-000000000001";
const snapshot = { hostEpoch: id, revision: 1, recovery: null };
const negotiated = {
  ok: true as const,
  value: {
    devicesContractVersion: 1 as const,
    eventVersion: 1 as const,
    capabilities: [],
    requirementsSatisfied: true,
  },
};
const init = (apiVersion: string) => ({
  apiVersion,
  pluginId: "test.recovery",
  locale: "en" as const,
  grantedPermissions: [],
});
const peers: RpcPeer[] = [];
afterEach(() => {
  peers.splice(0).forEach((p) => p.close());
  vi.useRealTimers();
});
const tick = () => new Promise<void>((r) => setImmediate(r));
function pair(replyVersion = "1.8.0") {
  const [a, b] = createMemoryChannelPair();
  const errors = vi.fn();
  const host = new RpcPeer(a, { onProtocolError: errors }),
    plugin = new RpcPeer(b, { onProtocolError: errors });
  peers.push(host, plugin);
  plugin.handle("initialize", () => ({
    apiVersion: replyVersion,
    sdk: { name: "test", version: "1.8.0" },
  }));
  host.handle("devices/negotiate", () => negotiated);
  host.handle("devices/connectionRecovery/read", () => ({ ok: true as const, value: snapshot }));
  host.handle("devices/subscribe", () => ({
    ok: true as const,
    value: { subscriptionId: id, sequence: 0 as const, snapshot },
  }));
  return { host, plugin, errors, a, b };
}
it("exports strict JSON schemas without refinements, retaining legacy topic/event rejection", () => {
  expect(() =>
    z.toJSONSchema(connectionRecoverySnapshotSchema, { unrepresentable: "throw" }),
  ).not.toThrow();
  expect(
    deviceRequestSchemas["devices/subscribe"].params.safeParse({ topic: "connectionRecovery" })
      .success,
  ).toBe(false);
  expect(
    deviceRequestSchemasV180["devices/subscribe"].params.safeParse({ topic: "connectionRecovery" })
      .success,
  ).toBe(true);
  const event = {
    version: 1,
    subscriptionId: id,
    owner: {
      sourceKey: "builtin:test.recovery",
      pluginId: "test.recovery",
      generation: 1,
      hostEpoch: id,
      processEpoch: id,
    },
    sequence: 1,
    delivery: "control",
    kind: "devices.connectionRecovery",
    data: snapshot,
  };
  expect(eventEnvelopeSchema.safeParse(event).success).toBe(false);
  expect(eventEnvelopeSchemaV180.safeParse(event).success).toBe(true);
});
it.each(["1.5.0", "1.6.0", "1.7.0"])(
  "never widens old initialize offer or reply %s",
  async (old) => {
    for (const [offer, reply] of [
      [old, "1.8.0"],
      ["1.8.0", old],
    ]) {
      const { host, plugin } = pair(reply);
      await host.request("initialize", init(offer!));
      await plugin.request("devices/negotiate", {});
      expect(host.connectionRecoveryReady).toBe(false);
      expect(plugin.connectionRecoveryReady).toBe(false);
      await expect(plugin.request("devices/connectionRecovery/read", {})).rejects.toThrow();
      await expect(
        plugin.request("devices/subscribe", { topic: "connectionRecovery" }),
      ).rejects.toThrow();
    }
  },
);
it("negotiates independently of UI, correlates snapshots and event topics and retires late replies", async () => {
  const { host, plugin, errors, a } = pair();
  await host.request("initialize", init("1.8.0"));
  await expect(plugin.request("devices/connectionRecovery/read", {})).rejects.toThrow();
  await plugin.request("devices/negotiate", {});
  expect(plugin.connectionRecoveryReady).toBe(true);
  expect(plugin.uiResourceVersion).toBeNull();
  expect(await plugin.request("devices/connectionRecovery/read", {})).toEqual({
    ok: true as const,
    value: snapshot,
  });
  await plugin.request("devices/subscribe", { topic: "connectionRecovery" });
  const listener = vi.fn();
  plugin.onNotification("events/deliver", listener);
  const event = {
    version: 1 as const,
    subscriptionId: id,
    owner: {
      sourceKey: "builtin:test.recovery",
      pluginId: "test.recovery",
      generation: 1,
      hostEpoch: id,
      processEpoch: id,
    },
    sequence: 1,
    delivery: "control" as const,
    kind: "devices.connectionRecovery" as const,
    data: snapshot,
  };
  host.notify("events/deliver", event);
  await tick();
  expect(listener).toHaveBeenCalledOnce();
  a.send(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "events/deliver",
      params: { ...event, subscriptionId: id.slice(0, -1) + "2" },
    }),
  );
  await tick();
  expect(listener).toHaveBeenCalledOnce();
  expect(errors).toHaveBeenCalled();
  expect(
    validDeviceResultV180(
      "devices/subscribe",
      { ok: true, value: { subscriptionId: id, sequence: 0 as const, snapshot } },
      { topic: "catalog" },
    ),
  ).toBe(false);
  host.handle("devices/subscribe", () => ({
    ok: true as const,
    value: {
      subscriptionId: id,
      sequence: 0 as const,
      snapshot: { revision: 1, providers: [], sessions: [] },
    },
  }));
  await expect(
    plugin.request("devices/subscribe", { topic: "connectionRecovery" }),
  ).rejects.toThrow();
  let finish!: (v: { ok: true; value: typeof snapshot }) => void;
  host.handle(
    "devices/connectionRecovery/read",
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const pending = plugin.request("devices/connectionRecovery/read", {});
  const rejected = expect(pending).rejects.toThrow();
  await tick();
  plugin.handle("shutdown", () => null);
  await host.request("shutdown", {});
  finish({ ok: true as const, value: snapshot });
  await rejected;
  expect(plugin.connectionRecoveryReady).toBe(false);
});
it("abandoned initialize and late old response cannot authorize recovery", async () => {
  const { host, plugin } = pair();
  let finish!: (v: { apiVersion: string; sdk: { name: string; version: string } }) => void;
  plugin.handle(
    "initialize",
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const abort = new AbortController();
  const pending = host.request("initialize", init("1.8.0"), { signal: abort.signal });
  const rejected = expect(pending).rejects.toThrow();
  await tick();
  abort.abort();
  await rejected;
  await tick();
  finish({ apiVersion: "1.8.0", sdk: { name: "test", version: "1.8.0" } });
  await tick();
  expect(host.connectionRecoveryReady).toBe(false);
  expect(plugin.connectionRecoveryReady).toBe(false);
});

it("a previous negotiation cannot authorize a new initialization, and exit retires readiness", async () => {
  const { host, plugin } = pair();
  await host.request("initialize", init("1.8.0"));
  let finish!: (v: typeof negotiated) => void;
  host.handle(
    "devices/negotiate",
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const pending = plugin.request("devices/negotiate", {});
  const rejected = expect(pending).rejects.toThrow();
  await tick();
  await host.request("initialize", init("1.8.0"));
  finish(negotiated);
  await rejected;
  expect(host.connectionRecoveryReady).toBe(false);
  expect(plugin.connectionRecoveryReady).toBe(false);
  host.handle("devices/negotiate", () => negotiated);
  await plugin.request("devices/negotiate", {});
  expect(plugin.connectionRecoveryReady).toBe(true);
  host.notify("exit", {});
  await tick();
  expect(host.connectionRecoveryReady).toBe(false);
  expect(plugin.connectionRecoveryReady).toBe(false);
});
