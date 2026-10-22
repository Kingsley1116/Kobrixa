import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createDeviceBroker,
  type DeviceBrokerPort,
  type LegacyOperationPort,
  type DeviceBrokerOptions,
} from "./broker-port.js";
import { operationHarness, pluginPrincipal, ID } from "./fake-provider.js";
it("F19 canonical factory has no hidden Electron side effects", () => {
  expectTypeOf<ReturnType<typeof createDeviceBroker>>().toEqualTypeOf<
    DeviceBrokerPort & LegacyOperationPort
  >();
  const h = operationHarness();
  const broker = createDeviceBroker({
    journal: h.dependencies.journal,
    profile: h.dependencies.profile,
    now: h.dependencies.now,
    authority: {
      current: () => null,
      assertContinuation() {
        throw new Error("unbound");
      },
      subscribe: () => () => {},
    },
    coreActions: { claim: () => false, isClaimed: () => false, complete() {} },
    hasPermission: () => true,
    requirements: () => [],
    operationGate: () => ({ ok: true, value: null }),
    connectionPolicy: () => ({
      wifiConnectTimeoutMs: 5000,
      wifiHandshakeTimeoutMs: 3000,
      usbAutoReconnect: false,
      usbRetryInterval: "backoff",
      usbRetryLimit: 3,
    }),
  });
  expect(broker.recovery.snapshot().faults).toEqual([]);
  expect(() => broker.sessions.quiesce(ID, { reason: "suspended" })).toThrow();
});
const signal = () => new AbortController().signal;
function setup(
  allowed = true,
  overrides: Partial<
    Pick<DeviceBrokerOptions, "requirements" | "operationGate" | "connectionPolicy">
  > = {},
) {
  const h = operationHarness();
  const broker = createDeviceBroker({
    journal: h.dependencies.journal,
    profile: h.dependencies.profile,
    now: h.dependencies.now,
    authority: {
      current: () => ({
        ref: ID,
        epoch: ID,
        workbenchInstance: ID,
        state: "local",
        roomBinding: null,
        connected: false,
        synced: true,
        role: null,
        isHolder: true,
      }),
      assertContinuation() {},
      subscribe: () => () => {},
    },
    coreActions: { claim: () => true, isClaimed: () => true, complete() {} },
    hasPermission: () => allowed,
    requirements: () => [],
    operationGate: () => ({ ok: true, value: null }),
    connectionPolicy: () => ({
      wifiConnectTimeoutMs: 5000,
      wifiHandshakeTimeoutMs: 3000,
      usbAutoReconnect: false,
      usbRetryInterval: "backoff",
      usbRetryLimit: 3,
    }),
    ...overrides,
  });
  const unregister = broker.registerProvider(h.provider);
  return { ...h, broker, unregister };
}
it("current-device stop journals a real request before stop and does not invent a prior fault", async () => {
  const h = setup(),
    principal = pluginPrincipal();
  const connected = await h.broker.request(
    principal,
    "devices/connect",
    { target: { kind: "wifi-address", providerId: h.provider.id, address: "127.0.0.1" } },
    signal(),
  );
  if (!connected.ok) throw new Error("connect failed");
  expect(h.broker.recovery.snapshot().faults).toEqual([]);
  const result = await h.broker.stopCurrentDevice({
    sessionId: connected.value.session.sessionId,
    action: { actionToken: ID, scope: { hostEpoch: ID, workbenchInstance: ID } },
  });
  expect(result.ok).toBe(true);
  expect(h.provider.calls).toContain("stop");
  expect(h.broker.recovery.snapshot().faults[0]).toMatchObject({
    operationClass: "safety-stop",
    state: "resolved",
    stopConfirmation: "confirmed",
  });
});

// P150 acceptance uses the actual T3/D150 factories and action ledger.
import { createCoreActionLedger } from "../plugins/core-recovery.js";
async function realSetup() {
  const h = operationHarness();
  const scope = { hostEpoch: ID, workbenchInstance: ID };
  const actions = createCoreActionLedger({
    now: h.dependencies.now,
    current: (other) =>
      other.hostEpoch === scope.hostEpoch && other.workbenchInstance === scope.workbenchInstance,
  });
  const broker = createDeviceBroker({
    journal: h.dependencies.journal,
    profile: h.dependencies.profile,
    now: h.dependencies.now,
    authority: {
      current: () => ({
        ref: ID,
        epoch: ID,
        workbenchInstance: ID,
        state: "local",
        roomBinding: null,
        connected: false,
        synced: true,
        role: null,
        isHolder: true,
      }),
      assertContinuation() {},
      subscribe: () => () => {},
    },
    coreActions: actions,
    hasPermission: () => true,
    requirements: () => [],
    operationGate: () => ({ ok: true, value: null }),
    connectionPolicy: () => ({
      wifiConnectTimeoutMs: 5000,
      wifiHandshakeTimeoutMs: 3000,
      usbAutoReconnect: false,
      usbRetryInterval: "backoff",
      usbRetryLimit: 3,
    }),
  });
  broker.registerProvider(h.provider);
  const result = await broker.request(
    pluginPrincipal(),
    "devices/connect",
    { target: { kind: "wifi-address", providerId: h.provider.id, address: "127.0.0.1" } },
    signal(),
  );
  if (!result.ok) throw new Error("connect");
  return { ...h, broker, actions, scope, sessionId: result.value.session.sessionId };
}
// T10 Step 18 removes this gate.
describe("real-factory acceptance", () => {
  it("real action ledger rejects replay and foreign-window current stops", async () => {
    const h = await realSetup(),
      action = h.actions.mint(h.scope, { kind: "device-current-stop", sessionId: h.sessionId });
    expect(
      (
        await h.broker.stopCurrentDevice({
          sessionId: h.sessionId,
          action: {
            ...action,
            scope: { ...h.scope, workbenchInstance: "00000000-0000-4000-8000-000000000002" },
          },
        })
      ).ok,
    ).toBe(false);
    expect(h.provider.calls).not.toContain("stop");
    expect((await h.broker.stopCurrentDevice({ sessionId: h.sessionId, action })).ok).toBe(true);
    expect((await h.broker.stopCurrentDevice({ sessionId: h.sessionId, action })).ok).toBe(false);
    expect(h.provider.calls.filter((call) => call === "stop")).toHaveLength(1);
  });
  it.each([1, 2])(
    "real facade journal failure at commit %i retains a blocker without extra dispatch",
    async (failAt) => {
      const h = await realSetup();
      let count = 0;
      const commit = h.dependencies.journal.commit;
      h.dependencies.journal.commit = async (document) => {
        if (++count === failAt) throw new Error("disk full");
        await commit(document);
      };
      const action = h.actions.mint(h.scope, {
        kind: "device-current-stop",
        sessionId: h.sessionId,
      });
      expect((await h.broker.stopCurrentDevice({ sessionId: h.sessionId, action })).ok).toBe(false);
      expect(h.provider.calls.filter((call) => call === "stop")).toHaveLength(failAt === 1 ? 0 : 1);
      await expect(
        h.broker.begin({
          principal: pluginPrincipal(),
          sessionId: h.sessionId,
          operationClass: "file-read",
          signal: signal(),
        }),
      ).rejects.toThrow();
    },
  );
  it("real read-only reconciliation observes without issuing a stop", async () => {
    const h = await realSetup();
    const action = h.actions.mint(h.scope, { kind: "device-current-stop", sessionId: h.sessionId });
    await h.broker.stopCurrentDevice({ sessionId: h.sessionId, action });
    const document = await h.dependencies.journal.load(),
      entry = document.entries[0]!;
    await h.dependencies.journal.commit({
      ...document,
      entries: [
        { ...entry, state: "unconfirmed", stopConfirmation: "unconfirmed", resolution: null },
      ],
    });
    let observations = 0;
    const observe = h.provider.observeIdle.bind(h.provider);
    h.provider.observeIdle = async (key, ctx) => {
      observations++;
      return observe(key, ctx);
    };
    const before = h.provider.calls.filter((call) => call === "stop").length;
    const reconcile = h.actions.mint(h.scope, {
      kind: "device-reconcile",
      faultId: entry.id,
      sessionId: h.sessionId,
      identityEvidence: "serial-match",
    });
    expect(
      (
        await h.broker.recovery.reconcile({
          faultId: entry.id,
          sessionId: h.sessionId,
          action: reconcile,
          identityEvidence: "serial-match",
        })
      ).ok,
    ).toBe(true);
    expect(observations).toBe(1);
    expect(h.provider.calls.filter((call) => call === "stop")).toHaveLength(before);
  });
  it("restart faults cannot seed a reconnect alias", async () => {
    const h = await realSetup();
    await h.broker.stopCurrentDevice({
      sessionId: h.sessionId,
      action: h.actions.mint(h.scope, { kind: "device-current-stop", sessionId: h.sessionId }),
    });
    expect(
      (await h.broker.reconnectForRecovery({ previousSessionId: h.sessionId, signal: signal() }))
        .ok,
    ).toBe(false);
  });
});
