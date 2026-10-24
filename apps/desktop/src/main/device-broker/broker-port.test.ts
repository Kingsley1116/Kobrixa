import { describe, expect, expectTypeOf, it, vi } from "vitest";
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
  const unregister = broker.registerProvider(h.provider);
  const result = await broker.request(
    pluginPrincipal(),
    "devices/connect",
    { target: { kind: "wifi-address", providerId: h.provider.id, address: "127.0.0.1" } },
    signal(),
  );
  if (!result.ok) throw new Error("connect");
  return { ...h, broker, unregister, actions, scope, sessionId: result.value.session.sessionId };
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

function retirementGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("real retirement waits for stop/readback and final journal commit, then disposes once; stale unregister cannot remove replacement", async () => {
  const h = await realSetup();
  const stop = retirementGate(),
    stopped = retirementGate();
  const journal = retirementGate(),
    committing = retirementGate();
  const original = h.provider.stopAndReadback.bind(h.provider);
  h.provider.stopAndReadback = async (key, target, ctx) => {
    stopped.resolve();
    await stop.promise;
    return original(key, target, ctx);
  };
  const commit = h.dependencies.journal.commit;
  let writes = 0;
  h.dependencies.journal.commit = async (document) => {
    if (++writes === 2) {
      committing.resolve();
      await journal.promise;
    }
    return commit(document);
  };
  const stopping = h.broker.stopCurrentDevice({
    sessionId: h.sessionId,
    action: h.actions.mint(h.scope, { kind: "device-current-stop", sessionId: h.sessionId }),
  });
  await stopped.promise;
  const retirement = h.unregister.retirement!;
  const pending = retirement.retire();
  expect(retirement.retire()).toBe(pending);
  let finished = false;
  void pending.then(() => {
    finished = true;
  });
  expect(() => h.broker.registerProvider(h.provider)).toThrow("retirement is pending");
  expect(
    await h.broker.request(
      pluginPrincipal(),
      "devices/read",
      { sessionId: h.sessionId, channelIds: [ID], freshness: "cached" },
      signal(),
    ),
  ).toMatchObject({ ok: false });
  stop.resolve();
  await committing.promise;
  expect(finished).toBe(false);
  expect(h.provider.calls).not.toContain("disconnect");
  journal.resolve();
  expect((await stopping).ok).toBe(true);
  await pending;
  expect(h.provider.calls.filter((call) => call === "disconnect")).toHaveLength(1);
  expect(h.provider.calls.filter((call) => call === "dispose")).toHaveLength(1);
  const replacement = h.broker.registerProvider(h.provider);
  const connected = await h.broker.request(
    pluginPrincipal(),
    "devices/connect",
    {
      target: { kind: "wifi-address", providerId: h.provider.id, address: "127.0.0.1" },
    },
    signal(),
  );
  expect(connected.ok).toBe(true);
  h.unregister();
  expect(retirement.retire()).toBe(pending);
  expect(
    await h.broker.request(
      pluginPrincipal(),
      "devices/discover",
      { providerId: h.provider.id },
      signal(),
    ),
  ).toMatchObject({ ok: true });
  await replacement.retirement!.retire();
});

it.each(["stop", "journal"])(
  "failed %s evidence survives retirement retries without process-exit proof or replacement",
  async (kind) => {
    const h = await realSetup();
    if (kind === "stop")
      h.provider.stopAndReadback = async () => {
        throw new Error("readback failed");
      };
    else {
      const commit = h.dependencies.journal.commit;
      let writes = 0;
      h.dependencies.journal.commit = async (document) => {
        if (++writes === 2) throw new Error("journal full");
        return commit(document);
      };
    }
    expect(
      (
        await h.broker.stopCurrentDevice({
          sessionId: h.sessionId,
          action: h.actions.mint(h.scope, { kind: "device-current-stop", sessionId: h.sessionId }),
        })
      ).ok,
    ).toBe(false);
    const faultIds = h.broker.recovery.snapshot().blockers;
    expect(faultIds).toHaveLength(1);
    for (let i = 0; i < 2; i++) {
      await expect(h.unregister.retirement!.retire()).rejects.toMatchObject({
        disposition: {
          stopConfirmed: false,
          faultIds,
        },
      });
      expect(() => h.broker.registerProvider(h.provider)).toThrow("retirement is pending");
    }
    expect(h.provider.calls).not.toContain("disconnect");
    expect(h.provider.calls).not.toContain("dispose");
  },
);

it("a pre-session connect is fenced and joined before provider disposal", async () => {
  const h = setup();
  const entered = retirementGate(),
    release = retirementGate();
  const connect = h.provider.connect.bind(h.provider);
  h.provider.connect = async (target, ctx) => {
    const result = await connect(target, ctx);
    entered.resolve();
    await release.promise;
    return result;
  };
  const connecting = h.broker.request(
    pluginPrincipal(),
    "devices/connect",
    {
      target: { kind: "wifi-address", providerId: h.provider.id, address: "127.0.0.1" },
    },
    signal(),
  );
  await entered.promise;
  const retiring = h.unregister.retirement!.retire();
  await Promise.resolve();
  expect(h.provider.calls).not.toContain("dispose");
  expect(() => h.broker.registerProvider(h.provider)).toThrow("retirement is pending");
  release.resolve();
  expect((await connecting).ok).toBe(false);
  await retiring;
  expect(h.provider.calls).toContain("dispose");
});

it("legacy unregister observes a rejecting dispose and explicit retry retains the original error", async () => {
  const h = setup();
  const error = new Error("dispose rejected");
  const dispose = vi.spyOn(h.provider, "dispose").mockRejectedValueOnce(error);
  h.unregister();
  await expect(h.unregister.retirement!.retire()).rejects.toBe(error);
  await h.unregister.retirement!.retire();
  expect(dispose).toHaveBeenCalledTimes(2);
});

import { LifecycleCoordinator, createResourceFreePersistence } from "./lifecycle-coordinator.js";
import { unavailableUi150 } from "@kobrixa/plugin-runtime";
import type { DrainReport, DrainOffer } from "@kobrixa/plugin-runtime";
it("real provider retirement joins onEnded/endReservation/drain, retains failed save, and retries reconciled evidence without retiring the consumer", async () => {
  const h = await realSetup();
  const persistence = createResourceFreePersistence(() => true);
  const trace: string[] = [];
  let report!: (value: DrainReport) => void;
  const storage = new Promise<DrainReport>((resolve) => {
    report = resolve;
  });
  const saved: DrainReport = {
    state: "saved",
    blocker: false,
    pendingSettings: false,
    records: [],
    errors: [],
  };
  const offer: DrainOffer = {
    owner: pluginPrincipal().owner,
    reason: "reservation-ended",
    deadlineMonotonicMs: 10000,
    token: ID,
    checkpoints: [],
    writes: [],
    acceptedTickets: [],
  };
  const end = vi.spyOn(persistence, "endReservation").mockImplementation(() => {
    trace.push("endReservation");
    return offer;
  });
  const drain = vi.spyOn(persistence, "drain").mockImplementation(() => {
    trace.push("drain");
    return storage;
  });
  const coordinator = new LifecycleCoordinator({
    ports: { device: h.broker.resources, persistence, ui: unavailableUi150() },
    resources: h.broker.resources,
    sessions: h.broker.sessions,
    reservations: h.broker.reservations,
    persistence,
    dispatch: async () => ({ ok: true, value: { status: "submitted", writes: [] } }),
    alive: () => true,
    owners: () => [pluginPrincipal().owner],
    now: h.dependencies.now,
    shutdown: async () => {},
    legacyFlush: async () => {
      trace.push("legacy");
    },
    report: () => {},
  });
  try {
    const reserved = await h.broker.request(
      pluginPrincipal(),
      "devices/recording/reserve",
      {
        sessionId: h.sessionId,
        channelIds: [ID],
        expectedSourceRevision: 1,
      },
      signal(),
    );
    expect(reserved.ok).toBe(true);
    const pending = h.unregister.retirement!.retire();
    const blocked = expect(pending).rejects.toMatchObject({ storage: [{ blocker: true }] });
    expect(trace[0]).toBe("endReservation");
    await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce());
    expect(h.provider.calls).not.toContain("disconnect");
    report({ ...saved, state: "retryable", blocker: true, recovery: ID });
    await blocked;
    expect(h.provider.calls).not.toContain("dispose");
    coordinator.reconcileRecovery(ID, saved);
    await h.unregister.retirement!.retire();
    expect(end).toHaveBeenCalledOnce();
    expect(drain).toHaveBeenCalledOnce();
    const replacement = h.broker.registerProvider(h.provider);
    expect(
      await h.broker.request(
        pluginPrincipal(),
        "devices/connect",
        {
          target: { kind: "wifi-address", providerId: h.provider.id, address: "127.0.0.1" },
        },
        signal(),
      ),
    ).toMatchObject({ ok: true });
    await replacement.retirement!.retire();
  } finally {
    report(saved);
    coordinator.dispose();
  }
});

it("an ended recording still requires its coordinator; absence never proves saved", async () => {
  const h = await realSetup();
  const reserved = await h.broker.request(
    pluginPrincipal(),
    "devices/recording/reserve",
    {
      sessionId: h.sessionId,
      channelIds: [ID],
      expectedSourceRevision: 1,
    },
    signal(),
  );
  if (!reserved.ok) throw new Error("reserve");
  await h.broker.request(
    pluginPrincipal(),
    "devices/recording/release",
    {
      reservationId: reserved.value.reservation.reservationId,
    },
    signal(),
  );
  await expect(h.unregister.retirement!.retire()).rejects.toThrow(
    "requires the reservation coordinator",
  );
  expect(h.provider.calls).not.toContain("dispose");
});
