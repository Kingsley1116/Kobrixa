import { expect, it, vi } from "vitest";
import type { RecordMeta, RecordWrite, ResourceOwner } from "@kobrixa/plugin-protocol";
import type { ReservationEnded } from "@kobrixa/plugin-runtime";
import { createPersistenceLifecycle, type LifecycleDependencies } from "./lifecycle.js";
const owner: ResourceOwner = {
  sourceKey: "builtin:test.drain",
  pluginId: "test.drain",
  generation: 1,
  hostEpoch: "00000000-0000-4000-8000-000000000001",
  processEpoch: "00000000-0000-4000-8000-000000000002",
};
const record: RecordMeta = {
  id: "00000000-0000-4000-8000-000000000003",
  revision: `r_${"1".repeat(32)}`,
  kind: "test.record",
  schemaVersion: 1,
  label: "Data",
  mediaType: "text/plain",
  byteLength: 0,
  sha256: "a".repeat(64),
  createdAt: 0,
  updatedAt: 0,
  checkpoint: "none",
  interrupted: false,
};
const reservation = "00000000-0000-4000-8000-000000000004";
const event: ReservationEnded = {
  owner,
  reservationId: reservation,
  sessionId: "00000000-0000-4000-8000-000000000005",
  providerGeneration: 1,
  reason: "released",
  lastSequence: 9,
  endedMonotonicMs: 100,
  drain: { owner, reservationId: reservation, lastSequence: 9, expiresMonotonicMs: 10100 },
};
function fixture() {
  let now = 0,
    active = true,
    final = false;
  const targetFence = vi.fn(() => []),
    ownerFence = vi.fn(() => []);
  const deps: LifecycleDependencies = {
    now: () => now,
    wall: () => 100000 + now,
    live: () => true,
    reservations: {
      validate: () =>
        active
          ? { owner, reservationId: reservation, sessionId: event.sessionId, providerGeneration: 1 }
          : null,
      onEnded: () => {
        throw new Error("second listener");
      },
    },
    record: async () => record,
    persist: async () => {},
    fence: ownerFence,
    fenceTarget: targetFence,
    pendingWrites: () => [],
    pendingSettings: () => false,
    settle: async () => {},
    evidence: evidenceDouble(),
    reads: { stat: async () => ({ ...record, checkpoint: final ? "final" : "open" }) },
    payload: () => ({ kind: "checkpoint-only" }),
    recover: async (_owner, report) => report,
    checkpointOpen: () => false,
    recovery: {
      recoverySnapshot: () => ({ revision: 0, items: [] }),
      retry: async () => ({
        state: "checkpoint-only",
        blocker: true,
        pendingSettings: false,
        records: [],
        errors: [],
      }),
      discard: async () => ({
        state: "checkpoint-only",
        blocker: false,
        pendingSettings: false,
        records: [],
        errors: [],
      }),
    },
  };
  const life = createPersistenceLifecycle(deps);
  return {
    life,
    deps,
    targetFence,
    ownerFence,
    end: () => {
      active = false;
      now = 100;
    },
    setFinal: () => {
      final = true;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}
it("B2-RF3: registration awaiting durable evidence is included in first end and cannot ack active", async () => {
  const f = fixture();
  let release!: () => void;
  f.deps.persist = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const registering = f.life.register(owner, {
    id: record.id,
    expectedRevision: record.revision,
    reservation,
  });
  await Promise.resolve();
  await Promise.resolve();
  f.end();
  const offer = f.life.participant.endReservation(event, 20000);
  expect(offer?.checkpoints).toHaveLength(1);
  expect(offer?.deadlineMonotonicMs).toBe(10100);
  release();
  expect(await registering).toMatchObject({ error: { code: "PLUGIN_E_STALE_RESOURCE" } });
  expect(f.ownerFence).not.toHaveBeenCalled();
  expect(f.targetFence).toHaveBeenCalledOnce();
});
it("B2-RF3: duplicate end and retirement keep token/deadline and dispatch each target once", async () => {
  const f = fixture();
  await f.life.register(owner, { id: record.id, expectedRevision: record.revision, reservation });
  f.end();
  const first = f.life.participant.endReservation(event, 20000)!;
  const repeated = f.life.participant.endReservation(event, 30000)!;
  const retired = f.life.participant.freeze(owner, "disable", 9000, event.drain!);
  expect(repeated.token).toBe(first.token);
  expect(retired.token).toBe(first.token);
  expect(retired.deadlineMonotonicMs).toBe(9000);
  const dispatch = vi.fn(async () => {
    f.setFinal();
    return { ok: true as const, value: { status: "submitted" as const, writes: [] } };
  });
  const [a, b] = await Promise.all([
    f.life.participant.drain(first, dispatch),
    f.life.participant.drain(retired, dispatch),
  ]);
  expect(dispatch).toHaveBeenCalledOnce();
  expect(a.state).toBe("saved");
  expect(b.state).toBe("saved");
});
it("B2-12.1-6: submitted is not saved; null grant goes ownerLost without callback", async () => {
  const f = fixture();
  await f.life.register(owner, { id: record.id, expectedRevision: record.revision, reservation });
  f.end();
  const offer = f.life.participant.endReservation({ ...event, drain: null }, 10100)!;
  expect(offer).not.toBeNull();
  const report = await f.life.participant.ownerLost(owner);
  expect(report).toMatchObject({ state: "checkpoint-only", blocker: true });
  const g = fixture();
  await g.life.register(owner, { id: record.id, expectedRevision: record.revision });
  const frozen = g.life.participant.freeze(owner, "shutdown", 10000);
  expect(
    await g.life.participant.drain(frozen, async () => ({
      ok: true,
      value: { status: "submitted", writes: [] },
    })),
  ).toMatchObject({ state: "checkpoint-only", blocker: true });
});
it("B2-12.1-6: target end preserves other ordinary work; foreign/new generation tokens fail", async () => {
  const f = fixture();
  await f.life.register(owner, { id: record.id, expectedRevision: record.revision, reservation });
  f.end();
  const offer = f.life.participant.endReservation(event, 10100)!;
  const write = {
    target: { mode: "replace" as const, id: record.id, expectedRevision: record.revision },
    kind: record.kind,
    schemaVersion: 1,
    label: "",
    mediaType: record.mediaType,
    byteLength: 0,
    sha256: record.sha256,
  };
  expect(() => f.life.authorize(owner, write)).toThrow();
  expect(f.life.authorize(owner, { ...write, target: { mode: "create" } })).toBe("none");
  expect(() =>
    f.life.authorize({ ...owner, generation: 2 }, { ...write, drainToken: offer.token }),
  ).toThrow();
  f.advance(10000);
  expect(() => f.life.authorize(owner, { ...write, drainToken: offer.token })).toThrow();
});
it("B2-RF3: a shorter concurrent freeze rearms the already-running drain", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    await f.life.register(owner, { id: record.id, expectedRevision: record.revision });
    const offer = f.life.participant.freeze(owner, "shutdown", 10000);
    const dispatch = vi.fn(() => new Promise<never>(() => {}));
    const draining = f.life.participant.drain(offer, dispatch);
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).toHaveBeenCalledOnce();
    f.advance(100);
    await vi.advanceTimersByTimeAsync(100);
    const earlier = f.life.participant.freeze(owner, "renderer-crash", 500);
    expect(earlier.token).toBe(offer.token);
    f.advance(400);
    await vi.advanceTimersByTimeAsync(400);
    expect(await draining).toMatchObject({ blocker: true });
    expect(dispatch).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
it("B2-RF3: target-only scope excludes unrelated settings and final authorization cannot repeat", async () => {
  const f = fixture();
  const registered = await f.life.register(owner, {
    id: record.id,
    expectedRevision: record.revision,
    reservation,
  });
  if (!registered.ok) throw new Error("registration failed");
  f.deps.pendingSettings = () => true;
  f.deps.evidence.capture = vi.fn(f.deps.evidence.capture);
  f.end();
  const offer = f.life.participant.endReservation(event, 10100)!;
  const write: RecordWrite = {
    target: { mode: "replace", id: record.id, expectedRevision: record.revision },
    kind: record.kind,
    schemaVersion: 1,
    label: "",
    mediaType: record.mediaType,
    byteLength: 0,
    sha256: record.sha256,
    checkpoint: { handle: registered.value.checkpoint, phase: "final" },
    drainToken: offer.token,
  };
  expect(f.life.authorize(owner, write)).toBe("final");
  f.life.committed(owner, write, { ...record, checkpoint: "final" });
  f.setFinal();
  expect(() => f.life.authorize(owner, write)).toThrow();
  const report = await f.life.participant.drain(offer, async () => ({
    ok: true,
    value: { status: "submitted", writes: [] },
  }));
  expect(report).toMatchObject({ state: "saved", pendingSettings: false });
  expect(f.deps.evidence.capture).toHaveBeenCalledWith(
    { kind: "target", owner, recordId: record.id },
    10100,
  );
  expect(f.deps.evidence.capture).not.toHaveBeenCalledWith(
    { kind: "namespace", owner },
    expect.anything(),
  );
});

function evidenceDouble(): LifecycleDependencies["evidence"] {
  const fail = () => {
    throw new Error("Unexpected evidence I/O");
  };
  return {
    capture: (scope, deadlineMonotonicMs) => ({
      id: "barrier",
      scope,
      through: 0,
      deadlineMonotonicMs,
    }),
    tickets: () => [],
    flush: async () => ({ state: "saved", accepted: [], incomplete: [], unknown: [] }),
    quota: fail,
    settingsDigest: fail,
    auxiliary: fail,
    auxiliaryKeys: fail,
    recoveryPage: fail,
    loadRecovery: fail,
    saveRecovery: fail,
    removeRecovery: fail,
  };
}
it("sealed admitted writes survive owner loss even without a registered checkpoint", async () => {
  const f = fixture();
  f.deps.pendingWrites = () => [{ write: "ticket", id: record.id, state: "sealed" }];
  f.deps.payload = () => ({ kind: "complete-staging", expiresMonotonicMs: 30000 });
  f.deps.evidence.flush = async () => ({
    state: "failed",
    accepted: ["ticket"],
    incomplete: ["ticket"],
    unknown: [],
  });
  expect(await f.life.participant.ownerLost(owner)).toMatchObject({
    state: "retryable",
    blocker: true,
    records: [{ id: record.id, payload: "complete-staging", expiresAt: 130000 }],
  });
});
it("unknown barrier evidence remains uncertain even with a final checkpoint head", async () => {
  const f = fixture();
  await f.life.register(owner, { id: record.id, expectedRevision: record.revision });
  f.setFinal();
  f.deps.evidence.flush = async () => ({
    state: "unknown",
    accepted: ["ticket"],
    incomplete: [],
    unknown: ["ticket"],
  });
  const offer = f.life.participant.freeze(owner, "shutdown", 10000);
  expect(
    await f.life.participant.drain(offer, async () => ({
      ok: true,
      value: { status: "submitted", writes: [] },
    })),
  ).toMatchObject({ state: "uncertain", blocker: true });
});
it("keeps each target's original reservation grant when two ends share an owner", async () => {
  const f = fixture(),
    otherId = "00000000-0000-4000-8000-000000000006",
    otherReservation = "00000000-0000-4000-8000-000000000007";
  f.deps.record = async (_owner, id) => ({ ...record, id });
  f.deps.reservations.validate = (_owner, reservationId) => ({
    owner,
    reservationId,
    sessionId: event.sessionId,
    providerGeneration: 1,
  });
  const a = await f.life.register(owner, {
    id: record.id,
    expectedRevision: record.revision,
    reservation,
  });
  const b = await f.life.register(owner, {
    id: otherId,
    expectedRevision: record.revision,
    reservation: otherReservation,
  });
  if (!a.ok || !b.ok) throw new Error("registration failed");
  const first = f.life.participant.endReservation(event, 10000)!;
  const other = {
    ...event,
    reservationId: otherReservation,
    drain: { ...event.drain!, reservationId: otherReservation },
  };
  const second = f.life.participant.endReservation(other, 9000)!;
  for (const [id, checkpoint, grant] of [
    [record.id, a.value.checkpoint, event.drain],
    [otherId, b.value.checkpoint, other.drain],
  ] as const) {
    const authorized = f.life.finalGrant(owner, {
      target: { mode: "replace", id, expectedRevision: record.revision },
      kind: record.kind,
      schemaVersion: 1,
      label: "",
      mediaType: record.mediaType,
      byteLength: 0,
      sha256: record.sha256,
      checkpoint: { handle: checkpoint, phase: "final" },
      drainToken: first.token,
    });
    expect(authorized?.deviceDrain).toBe(grant);
    expect(authorized?.deadlineMonotonicMs).toBe(second.deadlineMonotonicMs);
  }
});
