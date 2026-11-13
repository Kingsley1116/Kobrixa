import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createDeviceBroker,
  type DeviceBrokerPort,
  type LegacyOperationPort,
  type DeviceBrokerOptions,
} from "./broker-port.js";
import { operationHarness, pluginPrincipal, ID } from "./fake-provider.js";
import type { BuiltinDeviceProvider } from "./provider.js";
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
import { createJournal, journalDocument, parseJournal } from "./journal.js";
import type { JournalFilesystem } from "./journal-filesystem.js";
import { createCoreActionLedger } from "../plugins/core-recovery.js";
async function realSetup(durabilityAvailable = true) {
  const h = operationHarness();
  const files = new Map<string, Uint8Array>();
  const filesystem: JournalFilesystem = {
    initialize: async () => {
      if (!durabilityAvailable)
        throw Object.assign(new Error("durability unavailable"), { code: "ENOTSUP" });
    },
    inventory: async () => [...files].map(([name, bytes]) => ({ name, bytes: bytes.length })),
    read: async (name) => files.get(name)?.slice() ?? null,
    write: async (name, bytes) => {
      files.set(name, bytes.slice());
    },
    sync: async () => {},
    replace: async (from, to) => {
      const bytes = files.get(from);
      if (!bytes) throw new Error("missing journal temporary");
      files.set(to, bytes);
      files.delete(from);
    },
    syncDirectory: async () => {},
    remove: async (name) => {
      files.delete(name);
    },
  };
  h.dependencies.journal = createJournal(filesystem, h.dependencies.profile);
  await h.dependencies.journal.load();
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
  return {
    ...h,
    files,
    filesystem,
    broker,
    unregister,
    actions,
    scope,
    sessionId: result.value.session.sessionId,
  };
}
// T10 Step 18 removes this gate.
it.each([true, false])("W02b program dispatch requires durability=%s", async (available) => {
  const h = await realSetup(available);
  const admission = h.broker.begin({
    principal: {
      kind: "core",
      adapter: "program",
      hostEpoch: ID,
      workbenchInstance: ID,
      authorityContext: { ref: ID, epoch: ID },
    },
    sessionId: h.sessionId,
    operationClass: "program-launch",
    signal: signal(),
  });
  if (!available) {
    // Non-ready journals now refuse risk admission itself, before marker writes.
    await expect(admission).rejects.toMatchObject({
      result: { error: { detail: { reason: "journal-unwritable", dispatch: "not-sent" } } },
    });
    expect(h.provider.calls).not.toContain("run");
    expect(h.files.size).toBe(0);
    expect(h.broker.recovery.snapshot().journalHealth).toBe("unwritable");
    return;
  }
  const operation = await admission;
  try {
    const running = operation.execute({ kind: "run", remotePath: "/test.rbf" });
    expect((await running).error).toBeNull();
    expect(h.provider.calls.filter((call) => call === "run")).toHaveLength(1);
    expect(parseJournal(h.files.get("faults.json")!).entries[0]?.state).toBe("active-program");
  } finally {
    await operation.cancel();
  }
});
it("W02b trusted stop still dispatches when durability is unavailable without claiming success", async () => {
  const h = await realSetup(false);
  const result = await h.broker.stopCurrentDevice({
    sessionId: h.sessionId,
    action: h.actions.mint(h.scope, { kind: "device-current-stop", sessionId: h.sessionId }),
  });
  expect(result).toMatchObject({
    ok: false,
    error: { detail: { reason: "journal-unwritable", stopConfirmation: "unconfirmed" } },
  });
  expect(h.broker.recovery.snapshot().journalHealth).toBe("unwritable");
  expect(h.files.size).toBe(0);
  // The required best-effort physical stop is independent of durable resolution.
  expect(h.provider.calls.filter((call) => call === "stop")).toHaveLength(1);
  await expect(h.unregister.retirement!.retire()).rejects.toMatchObject({
    disposition: { stopConfirmed: false, journalCommitted: false, faultIds: [] },
  });
  expect(h.provider.calls).not.toContain("disconnect");
  expect(h.provider.calls).not.toContain("dispose");
});
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
    "real facade journal failure at commit %i still attempts one trusted stop and retains blockers",
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
      expect(await h.broker.stopCurrentDevice({ sessionId: h.sessionId, action })).toMatchObject({
        ok: false,
        error: { detail: { reason: "journal-unwritable", stopConfirmation: "unconfirmed" } },
      });
      // §7.2 requires hardware stop to continue on journal failure; only new
      // motion/Run must remain undispatched without a committed pending marker.
      expect(h.provider.calls.filter((call) => call === "stop")).toHaveLength(1);
      expect(count).toBe(failAt);
      if (failAt === 1) {
        expect(h.files.size).toBe(0);
        expect(h.broker.recovery.snapshot().faults).toEqual([]);
      } else {
        expect(parseJournal(h.files.get("faults.json")!).entries[0]).toMatchObject({
          state: "pending",
          stopConfirmation: "pending",
          resolution: null,
        });
        expect(h.broker.recovery.snapshot().blockers).toHaveLength(1);
      }
      await expect(
        h.broker.begin({
          principal: pluginPrincipal(),
          sessionId: h.sessionId,
          operationClass: "file-read",
          signal: signal(),
        }),
      ).rejects.toThrow();
      await expect(
        h.broker.begin({
          principal: pluginPrincipal(),
          sessionId: h.sessionId,
          operationClass: "program-launch",
          signal: signal(),
        }),
      ).rejects.toThrow();
      expect(h.provider.calls).not.toContain("run");
      expect(h.provider.calls).not.toContain("motion");
      await expect(h.unregister.retirement!.retire()).rejects.toMatchObject({
        disposition: { stopConfirmed: false, journalCommitted: false },
      });
      expect(h.provider.calls).not.toContain("disconnect");
      expect(h.provider.calls).not.toContain("dispose");
    },
  );
  it("real read-only reconciliation observes without issuing a stop", async () => {
    const h = await realSetup();
    const action = h.actions.mint(h.scope, { kind: "device-current-stop", sessionId: h.sessionId });
    await h.broker.stopCurrentDevice({ sessionId: h.sessionId, action });
    const document = await h.dependencies.journal.load(),
      entry = document.entries[0]!;
    await h.dependencies.journal.commit(
      journalDocument(document.revision + 1, [
        {
          ...entry,
          revision: entry.revision + 1,
          state: "unconfirmed",
          stopConfirmation: "unconfirmed",
          resolution: null,
        },
      ]),
    );
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

it("trusted stop survives a pending commit timeout; late publication cannot resolve or unblock it", async () => {
  const h = await realSetup();
  const entered = retirementGate(),
    release = retirementGate();
  const commit = h.dependencies.journal.commit.bind(h.dependencies.journal);
  const committing = vi.spyOn(h.dependencies.journal, "commit").mockImplementation(async (doc) => {
    entered.resolve();
    await release.promise;
    await commit(doc);
  });
  vi.useFakeTimers();
  try {
    const stopping = h.broker.stopCurrentDevice({
      sessionId: h.sessionId,
      action: h.actions.mint(h.scope, { kind: "device-current-stop", sessionId: h.sessionId }),
    });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(5000);
    expect(await stopping).toMatchObject({
      ok: false,
      error: { detail: { reason: "journal-unwritable", stopConfirmation: "unconfirmed" } },
    });
    expect(h.provider.calls.filter((call) => call === "stop")).toHaveLength(1);
    expect(committing).toHaveBeenCalledTimes(1);
    expect(h.files.size).toBe(0);
    await expect(h.unregister.retirement!.retire()).rejects.toMatchObject({
      disposition: { stopConfirmed: false, journalCommitted: false },
    });
    release.resolve();
    await committing.mock.results[0]!.value;
    expect(parseJournal(h.files.get("faults.json")!).entries[0]).toMatchObject({
      state: "pending",
      stopConfirmation: "pending",
      resolution: null,
    });
    expect(h.broker.recovery.snapshot().blockers).toHaveLength(1);
    await expect(h.unregister.retirement!.retire()).rejects.toMatchObject({
      disposition: { stopConfirmed: false, journalCommitted: false },
    });
    expect(committing).toHaveBeenCalledTimes(1);
    expect(h.provider.calls).not.toContain("run");
    expect(h.provider.calls).not.toContain("motion");
    expect(h.provider.calls).not.toContain("disconnect");
    expect(h.provider.calls).not.toContain("dispose");
  } finally {
    release.resolve();
    vi.useRealTimers();
  }
});

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

type RealSetup = Awaited<ReturnType<typeof realSetup>>;
async function failCurrentStop(h: RealSetup, kind: "stop" | "journal" | "no-fault" = "stop") {
  const originalCommit = h.dependencies.journal.commit;
  if (kind === "stop")
    vi.spyOn(h.provider, "stopAndReadback").mockRejectedValueOnce(new Error("stop failed"));
  else {
    const commit = h.dependencies.journal.commit.bind(h.dependencies.journal);
    let writes = 0;
    vi.spyOn(h.dependencies.journal, "commit").mockImplementation(async (document) => {
      if (++writes === (kind === "no-fault" ? 1 : 2))
        throw new Error("recoverable journal port failure");
      await commit(document);
    });
  }
  expect(
    (
      await h.broker.stopCurrentDevice({
        sessionId: h.sessionId,
        action: h.actions.mint(h.scope, { kind: "device-current-stop", sessionId: h.sessionId }),
      })
    ).ok,
  ).toBe(false);
  h.dependencies.journal.commit = originalCommit;
  return h.broker.recovery.snapshot().faults[0];
}
function recoverFault(h: RealSetup, faultId: string, observe = false) {
  const target = observe
    ? {
        kind: "device-reconcile" as const,
        faultId,
        sessionId: h.sessionId,
        identityEvidence: "serial-match" as const,
      }
    : { kind: "device-stop" as const, faultId, sessionId: h.sessionId };
  const action = h.actions.mint(h.scope, target);
  const request = { ...target, action };
  return {
    action,
    run: () =>
      observe
        ? h.broker.recovery.reconcile({ ...request, identityEvidence: "serial-match" })
        : h.broker.recovery.stopCurrent(request),
  };
}
async function expectRetirementBlocked(h: RealSetup) {
  await expect(h.unregister.retirement!.retire()).rejects.toMatchObject({
    disposition: { stopConfirmed: false },
  });
  expect(h.provider.calls).not.toContain("disconnect");
  expect(h.provider.calls).not.toContain("dispose");
  expect(() => h.broker.registerProvider(h.provider)).toThrow("retirement is pending");
}
it.each([false, true])(
  "contract2 clear retains exact recovery evidence through completed retirement (prior attempt: %s)",
  async (priorAttempt) => {
    const h = await realSetup();
    const fault = (await failCurrentStop(h))!;
    if (priorAttempt) await expectRetirementBlocked(h);
    expect((await recoverFault(h, fault.id).run()).ok).toBe(true);
    const clear = () => {
      const target = { kind: "device-clear" as const, entryIds: [fault.id] };
      return h.broker.recovery.clearResolved({
        entryIds: target.entryIds,
        action: h.actions.mint(h.scope, target),
      });
    };
    const committed = parseJournal(h.files.get("faults.json")!);
    const expectRetained = async () => {
      expect(await clear()).toMatchObject({
        ok: false,
        error: {
          code: "PLUGIN_E_STALE_RESOURCE",
          detail: { kind: "resource", reason: "stale", resource: "journal" },
        },
      });
      expect(parseJournal(h.files.get("faults.json")!)).toEqual(committed);
      expect(h.broker.recovery.snapshot().faults).toEqual(committed.entries);
    };
    await expectRetained();
    const entered = retirementGate(),
      release = retirementGate();
    const dispose = h.provider.dispose.bind(h.provider);
    vi.spyOn(h.provider, "dispose").mockImplementation(async (ctx) => {
      entered.resolve();
      await release.promise;
      await dispose(ctx);
    });
    const retiring = h.unregister.retirement!.retire();
    await entered.promise;
    // A successful safety disposition alone does not complete retirement.
    await expectRetained();
    release.resolve();
    await retiring;
    expect((await clear()).ok).toBe(true);
    expect(parseJournal(h.files.get("faults.json")!).entries).toEqual([]);
    await h.unregister.retirement!.retire();
    expect(h.provider.calls.filter((call) => call === "disconnect")).toHaveLength(1);
    expect(h.provider.calls.filter((call) => call === "dispose")).toHaveLength(1);
  },
);
it.each(["stop", "journal"] as const)(
  "contract2 real journal: %s failure needs new physical proof and committed resolution before one retirement",
  async (kind) => {
    const h = await realSetup();
    const fault = (await failCurrentStop(h, kind))!;
    const originalFault = structuredClone(fault);
    const receipt = h.broker.sessions.quiesce(h.sessionId, { reason: "suspended" });
    const oldDisposition = await receipt.settled;
    const oldCopy = structuredClone(oldDisposition);
    await expectRetirementBlocked(h);
    const recovery = recoverFault(h, fault.id, kind === "journal");
    const entered = retirementGate(),
      release = retirementGate();
    const commit = h.dependencies.journal.commit.bind(h.dependencies.journal);
    vi.spyOn(h.dependencies.journal, "commit").mockImplementation(async (document) => {
      entered.resolve();
      await release.promise;
      await commit(document);
    });
    const recovering = recovery.run();
    await entered.promise;
    let retired = false;
    const retiring = h.unregister.retirement!.retire().then(() => {
      retired = true;
    });
    await Promise.resolve();
    expect(retired).toBe(false);
    expect(h.broker.recovery.snapshot().blockers).toContain(fault.id);
    expect(h.provider.calls).not.toContain("disconnect");
    // Ordinary current-stop cannot use the constrained lease, even with a fresh action.
    expect(
      (
        await h.broker.stopCurrentDevice({
          sessionId: h.sessionId,
          action: h.actions.mint(h.scope, { kind: "device-current-stop", sessionId: h.sessionId }),
        })
      ).ok,
    ).toBe(false);
    release.resolve();
    expect((await recovering).ok).toBe(true);
    await retiring;
    await h.unregister.retirement!.retire();
    expect(h.provider.calls.filter((call) => call === "disconnect")).toHaveLength(1);
    expect(h.provider.calls.filter((call) => call === "dispose")).toHaveLength(1);
    const committed = parseJournal(h.files.get("faults.json")!);
    expect(committed.entries[0]).toMatchObject({
      id: fault.id,
      revision: fault.revision + 1,
      state: "resolved",
      stopConfirmation: "confirmed",
    });
    expect(oldDisposition).toEqual(oldCopy);
    expect(fault).toEqual(originalFault);
    expect((await recovery.run()).ok).toBe(false);
    // Replacement is admitted only after actual disposal.
    const replacement = h.broker.registerProvider(h.provider);
    await replacement.retirement!.retire();
  },
);
it("contract2 failed and replayed recovery cannot improve an original receipt; a new action can recover", async () => {
  const h = await realSetup(),
    fault = (await failCurrentStop(h))!;
  const receipt = h.broker.sessions.quiesce(h.sessionId, { reason: "suspended" });
  const original = await receipt.settled;
  const attempt = recoverFault(h, fault.id);
  vi.spyOn(h.provider, "stopAndReadback").mockRejectedValueOnce(new Error("still failed"));
  expect((await attempt.run()).ok).toBe(false);
  expect((await attempt.run()).ok).toBe(false);
  await expectRetirementBlocked(h);
  expect((await recoverFault(h, fault.id).run()).ok).toBe(true);
  expect(h.broker.sessions.quiesce(h.sessionId, { reason: "suspended" })).toBe(receipt);
  expect(await receipt.settled).toEqual({
    stopConfirmed: true,
    journalCommitted: true,
    faultIds: [],
  });
  expect(original.stopConfirmed).toBe(false);
  await h.unregister.retirement!.retire();
});
it.each(["digest", "family", "basis", "strength", "key"] as const)(
  "contract2 changed physical %s cannot authorize recovery or retirement",
  async (field) => {
    const h = await realSetup(),
      fault = (await failCurrentStop(h))!;
    const describe = h.provider.describe.bind(h.provider);
    vi.spyOn(h.provider, "describe").mockImplementation((key) => {
      const live = describe(key);
      if (field === "key") return { ...live, key: {} as typeof key };
      return {
        ...live,
        physical: {
          ...live.physical,
          ...(field === "digest"
            ? { digest: "b".repeat(64) }
            : field === "family"
              ? { family: "other" }
              : field === "basis"
                ? { basis: "endpoint" as const }
                : { strength: "session-only" as const }),
        },
      };
    });
    expect((await recoverFault(h, fault.id).run()).ok).toBe(false);
    expect(h.provider.calls).not.toContain("stop");
    await expectRetirementBlocked(h);
  },
);
it("contract2 concurrent recovery stays excluded through journal publication; quarantine still fences ordinary work", async () => {
  const h = await realSetup(),
    fault = (await failCurrentStop(h))!;
  const entered = retirementGate(),
    release = retirementGate();
  const commit = h.dependencies.journal.commit.bind(h.dependencies.journal);
  vi.spyOn(h.dependencies.journal, "commit").mockImplementation(async (document) => {
    entered.resolve();
    await release.promise;
    await commit(document);
  });
  const first = recoverFault(h, fault.id).run();
  await entered.promise;
  expect((await recoverFault(h, fault.id).run()).ok).toBe(false);
  expect(h.provider.calls.filter((call) => call === "stop")).toHaveLength(1);
  release.resolve();
  expect((await first).ok).toBe(true);
  await expect(
    h.broker.begin({
      principal: pluginPrincipal(),
      sessionId: h.sessionId,
      operationClass: "file-read",
      signal: signal(),
    }),
  ).rejects.toThrow();
  await h.unregister.retirement!.retire();
});
it("contract2 no-fault uncertainty cannot acquire a recovery lease or retire as time passes", async () => {
  const h = await realSetup();
  expect(await failCurrentStop(h, "no-fault")).toBeUndefined();
  expect(h.provider.calls.filter((call) => call === "stop")).toHaveLength(1);
  h.setNow(100000);
  expect((await recoverFault(h, ID).run()).ok).toBe(false);
  await expectRetirementBlocked(h);
  // The original trusted stop was attempted; invalid recovery adds no dispatch.
  expect(h.provider.calls.filter((call) => call === "stop")).toHaveLength(1);
});
it("contract2 real filesystem failure latches the journal: restored writes never manufacture recovery", async () => {
  const h = await realSetup();
  const write = h.filesystem.write;
  let writes = 0;
  h.filesystem.write = async (name, bytes) => {
    if (++writes === 2) throw new Error("filesystem full");
    await write(name, bytes);
  };
  expect(
    (
      await h.broker.stopCurrentDevice({
        sessionId: h.sessionId,
        action: h.actions.mint(h.scope, { kind: "device-current-stop", sessionId: h.sessionId }),
      })
    ).ok,
  ).toBe(false);
  const fault = h.broker.recovery.snapshot().faults[0]!;
  h.filesystem.write = write;
  expect((await recoverFault(h, fault.id).run()).ok).toBe(false);
  expect(h.broker.recovery.snapshot()).toMatchObject({
    journalHealth: "unwritable",
    blockers: [fault.id],
  });
  expect(parseJournal(h.files.get("faults.json")!).entries[0]!.state).toBe("pending");
  await expectRetirementBlocked(h);
});

async function retainedJournalObligation(h: RealSetup) {
  // Seed an independent unresolved journal obligation, never successful proof.
  // Every resolution below must still execute the real core-ledger recovery path.
  expect(
    (
      await h.broker.stopCurrentDevice({
        sessionId: h.sessionId,
        action: h.actions.mint(h.scope, { kind: "device-current-stop", sessionId: h.sessionId }),
      })
    ).ok,
  ).toBe(true);
  const document = await h.dependencies.journal.load(),
    entry = document.entries[0]!;
  const unresolved = {
    ...entry,
    revision: entry.revision + 1,
    state: "unconfirmed" as const,
    stopConfirmation: "unconfirmed" as const,
    resolution: null,
  };
  await h.dependencies.journal.commit(journalDocument(document.revision + 1, [unresolved]));
  return unresolved;
}
it("contract2 all original fault IDs require separate physical proof and commits; partial resolution stays blocked", async () => {
  const h = await realSetup(),
    retained = await retainedJournalObligation(h);
  await failCurrentStop(h);
  const faults = h.broker.recovery.snapshot().faults;
  expect(faults).toHaveLength(2);
  const fresh = faults.find((entry) => entry.id !== retained.id)!;
  const receipt = h.broker.sessions.quiesce(h.sessionId, { reason: "suspended" });
  const original = await receipt.settled;
  expect(original.faultIds).toEqual(expect.arrayContaining([retained.id, fresh.id]));
  expect((await recoverFault(h, fresh.id).run()).ok).toBe(true);
  await expectRetirementBlocked(h);
  expect((await recoverFault(h, retained.id, true).run()).ok).toBe(true);
  expect(h.broker.sessions.quiesce(h.sessionId, { reason: "suspended" })).toBe(receipt);
  expect(await receipt.settled).toEqual({
    stopConfirmed: true,
    journalCommitted: true,
    faultIds: [],
  });
  expect(original.faultIds).toHaveLength(2);
  await h.unregister.retirement!.retire();
});
it("contract2 a no-fault failure cannot borrow another obligation's successful recovery", async () => {
  const h = await realSetup(),
    retained = await retainedJournalObligation(h);
  await failCurrentStop(h, "no-fault");
  const receipt = h.broker.sessions.quiesce(h.sessionId, { reason: "suspended" });
  expect((await receipt.settled).stopConfirmed).toBe(false);
  expect((await recoverFault(h, retained.id).run()).ok).toBe(true);
  expect(h.broker.recovery.snapshot().blockers).toEqual([]);
  await expectRetirementBlocked(h);
});
it("contract2 a fault from the wrong generation cannot occupy a quarantined session", async () => {
  const h = await realSetup(),
    fault = (await failCurrentStop(h))!;
  const document = await h.dependencies.journal.load();
  await h.dependencies.journal.commit(
    journalDocument(document.revision + 1, [
      {
        ...fault,
        revision: fault.revision + 1,
        providerGeneration: fault.providerGeneration + 1,
      },
    ]),
  );
  expect((await recoverFault(h, fault.id).run()).ok).toBe(false);
  expect(h.provider.calls).not.toContain("stop");
  await expectRetirementBlocked(h);
});
it("contract2 a journal revision changed during recovery cannot publish stale resolution", async () => {
  const h = await realSetup(),
    fault = (await failCurrentStop(h))!;
  const load = h.dependencies.journal.load.bind(h.dependencies.journal);
  let changed = false;
  h.dependencies.journal.load = async () => {
    const document = await load();
    if (!changed) {
      changed = true;
      await h.dependencies.journal.commit(
        journalDocument(document.revision + 1, [{ ...fault, revision: fault.revision + 1 }]),
      );
    }
    return load();
  };
  expect((await recoverFault(h, fault.id).run()).ok).toBe(false);
  expect(h.broker.recovery.snapshot().blockers).toEqual([fault.id]);
  await expectRetirementBlocked(h);
});
it("contract2 original provider work without a transport exchange still excludes recovery", async () => {
  const h = await realSetup(),
    entered = retirementGate(),
    release = retirementGate();
  const stop = h.provider.stopAndReadback.bind(h.provider);
  let originalDeadline = 0;
  vi.spyOn(h.provider, "stopAndReadback").mockImplementationOnce(async (_key, _target, ctx) => {
    originalDeadline = ctx.deadlineMonotonicMs;
    entered.resolve();
    await release.promise;
    expect(ctx.deadlineMonotonicMs).toBe(originalDeadline);
    throw new Error("old provider finished unsuccessfully");
  });
  const original = h.broker.stopCurrentDevice({
    sessionId: h.sessionId,
    action: h.actions.mint(h.scope, { kind: "device-current-stop", sessionId: h.sessionId }),
  });
  await entered.promise;
  const fault = h.broker.recovery.snapshot().faults[0]!;
  expect((await recoverFault(h, fault.id).run()).ok).toBe(false);
  expect(h.provider.calls).not.toContain("stop");
  release.resolve();
  expect((await original).ok).toBe(false);
  h.provider.stopAndReadback = stop;
  expect((await recoverFault(h, fault.id).run()).ok).toBe(true);
  await h.unregister.retirement!.retire();
});
it("contract2 timed-out original transport cannot be waived by recovery or retirement", async () => {
  vi.useFakeTimers();
  try {
    const h = await realSetup(),
      entered = retirementGate(),
      release = retirementGate();
    vi.spyOn(h.provider, "stopAndReadback").mockImplementationOnce(async (_key, _target, ctx) => {
      await ctx.exchange("stop", async () => {
        entered.resolve();
        await release.promise;
      });
      throw new Error("original readback absent");
    });
    const stopping = h.broker.stopCurrentDevice({
      sessionId: h.sessionId,
      action: h.actions.mint(h.scope, { kind: "device-current-stop", sessionId: h.sessionId }),
    });
    await entered.promise;
    h.setNow(2000);
    await vi.advanceTimersByTimeAsync(2000);
    h.setNow(15000);
    await vi.advanceTimersByTimeAsync(13000);
    expect((await stopping).ok).toBe(false);
    const fault = h.broker.recovery.snapshot().faults[0]!;
    expect((await recoverFault(h, fault.id).run()).ok).toBe(false);
    const retirement = h.unregister.retirement!.retire();
    const blocked = expect(retirement).rejects.toMatchObject({
      disposition: { stopConfirmed: false },
    });
    expect(h.provider.calls).not.toContain("disconnect");
    expect(() => h.broker.registerProvider(h.provider)).toThrow("retirement is pending");
    release.resolve();
    await blocked;
    expect((await recoverFault(h, fault.id).run()).ok).toBe(true);
    await h.unregister.retirement!.retire();
  } finally {
    vi.useRealTimers();
  }
});
it("contract2 recording excludes fault recovery on a healthy session", async () => {
  const h = await realSetup(),
    fault = await retainedJournalObligation(h);
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
  const before = h.provider.calls.length;
  expect((await recoverFault(h, fault.id).run()).ok).toBe(false);
  expect(h.provider.calls).toHaveLength(before);
});

it("contract2 a terminal motion receipt is not proof its original provider promise settled", async () => {
  const h = await realSetup(),
    principal = pluginPrincipal();
  const entered = retirementGate(),
    release = retirementGate(),
    completed = retirementGate();
  h.provider.motion = async () => {
    entered.resolve();
    await release.promise;
    completed.resolve();
    return { movement: "interrupted", angle: null, displacement: null };
  };
  let originalCleanup: Parameters<typeof h.provider.stopAndReadback>[2] | undefined;
  vi.spyOn(h.provider, "stopAndReadback").mockImplementationOnce(async (_key, _target, ctx) => {
    originalCleanup = ctx;
    throw new Error("original motion stop failed");
  });
  const scope = h.broker.intent.bindMotionScope({
    owner: principal.owner,
    contextRef: ID,
    panelInstance: ID,
    uiResourceGeneration: 1,
    workbenchInstance: ID,
  });
  h.broker.intent.pulsePanel(scope, 1);
  const prepared = await h.broker.request(
    principal,
    "devices/motion/prepare",
    {
      sessionId: h.sessionId,
      motion: h.admission.motion,
      contextRef: ID,
      motionScopeRef: scope,
    },
    signal(),
  );
  if (!prepared.ok) throw new Error("motion prepare");
  expect(
    (
      await h.broker.request(
        principal,
        "devices/motion/start",
        {
          operationId: prepared.value.operation.operationId,
        },
        signal(),
      )
    ).ok,
  ).toBe(true);
  await entered.promise;
  const receipt = h.broker.sessions.quiesce(h.sessionId, { reason: "suspended" });
  const original = await receipt.settled;
  expect(original.stopConfirmed).toBe(false);
  const fault = h.broker.recovery.snapshot().faults[0]!;
  expect((await recoverFault(h, fault.id).run()).ok).toBe(false);
  await expectRetirementBlocked(h);
  const deadline = originalCleanup!.deadlineMonotonicMs;
  h.setNow(deadline + 1);
  release.resolve();
  await completed.promise;
  // Join the real provider's continuation without altering its original deadline.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(originalCleanup!.deadlineMonotonicMs).toBe(deadline);
  expect((await recoverFault(h, fault.id).run()).ok).toBe(true);
  expect(await receipt.settled).toEqual({
    stopConfirmed: true,
    journalCommitted: true,
    faultIds: [],
  });
  expect(original.stopConfirmed).toBe(false);
  await h.unregister.retirement!.retire();
});

it("contract2 unrelated fault resolution cannot cover an original passive transport timeout", async () => {
  vi.useFakeTimers();
  try {
    const h = await realSetup(),
      fault = await retainedJournalObligation(h);
    const entered = retirementGate(),
      release = retirementGate();
    vi.spyOn(h.provider, "read").mockImplementationOnce(async (_key, ctx) => {
      await ctx.exchange("read", async () => {
        entered.resolve();
        await release.promise;
      });
      throw new Error("passive read failed");
    });
    const reading = h.broker.request(
      pluginPrincipal(),
      "devices/read",
      {
        sessionId: h.sessionId,
        channelIds: [ID],
        freshness: "fresh",
      },
      signal(),
    );
    await entered.promise;
    h.setNow(5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await reading).ok).toBe(false);
    release.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect((await recoverFault(h, fault.id).run()).ok).toBe(true);
    expect(h.broker.recovery.snapshot().blockers).toEqual([]);
    await expectRetirementBlocked(h);
  } finally {
    vi.useRealTimers();
  }
});

it("contract2 failed recovery publication needs another action, physical readback and real commit", async () => {
  const h = await realSetup(),
    fault = (await failCurrentStop(h))!;
  const commit = h.dependencies.journal.commit;
  h.dependencies.journal.commit = vi
    .fn()
    .mockRejectedValueOnce(new Error("recoverable publication failure"));
  const failed = recoverFault(h, fault.id);
  expect((await failed.run()).ok).toBe(false);
  h.dependencies.journal.commit = commit;
  expect((await failed.run()).ok).toBe(false);
  await expectRetirementBlocked(h);
  expect(h.provider.calls.filter((call) => call === "stop")).toHaveLength(1);
  expect((await recoverFault(h, fault.id).run()).ok).toBe(true);
  expect(h.provider.calls.filter((call) => call === "stop")).toHaveLength(2);
  await h.unregister.retirement!.retire();
});
it("contract2 idle-looking readback without stop confirmation cannot resolve a stop fault", async () => {
  const h = await realSetup(),
    fault = (await failCurrentStop(h))!;
  const original = h.provider.stopAndReadback.bind(h.provider);
  const provider: BuiltinDeviceProvider = h.provider;
  provider.stopAndReadback = async (key, target, ctx) => ({
    ...(await original(key, target, ctx)),
    stopConfirmation: "unconfirmed",
  });
  expect((await recoverFault(h, fault.id).run()).ok).toBe(false);
  expect(h.broker.recovery.snapshot().blockers).toEqual([fault.id]);
  await expectRetirementBlocked(h);
});
