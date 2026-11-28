import type { PublicationTicket } from "./engine-port.js";
import { randomUUID } from "node:crypto";
import { storedRecoverySchema } from "./namespace.js";
import { expect, it, vi } from "vitest";
import type { RecordMeta, RecordWrite, ResourceOwner } from "@kobrixa/plugin-protocol";
import type { ReservationEnded } from "@kobrixa/plugin-runtime";
import { createPersistenceLifecycle, type LifecycleDependencies } from "./lifecycle.js";
import { checkpointRecoveryId } from "./engine-port.js";
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
    pendingPublication: () => false,
    pendingSettings: () => false,
    settle: async () => {},
    evidence: evidenceDouble(() => now),
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

it("late abandon completion preserves a replacement checkpoint", async () => {
  const f = fixture();
  const original = await f.life.register(owner, {
    id: record.id,
    expectedRevision: record.revision,
  });
  if (!original.ok) throw new Error("registration failed");
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  f.deps.persist = async (_owner, document) => {
    if (document.state === "interrupted") await paused;
  };
  const abandoning = f.life.abandon(owner, { checkpoint: original.value.checkpoint });
  f.life.retireCheckpoint(owner, checkpointRecoveryId(original.value.checkpoint));
  const replacement = await f.life.register(owner, {
    id: record.id,
    expectedRevision: record.revision,
  });
  if (!replacement.ok) throw new Error("replacement failed");
  resume();
  expect((await abandoning).ok).toBe(true);
  expect(f.life.open(owner)).toBe(true);
  expect((await f.life.abandon(owner, { checkpoint: replacement.value.checkpoint })).ok).toBe(true);
});

it("T5fix2 discard cannot acknowledge a replacement open head", async () => {
  const f = fixture();
  const registered = await f.life.register(owner, {
    id: record.id,
    expectedRevision: record.revision,
  });
  if (!registered.ok) throw new Error("registration failed");
  const offer = f.life.participant.freeze(owner, "shutdown", 10000);
  const dispatch = async () => ({
    ok: true as const,
    value: { status: "checkpoint-only" as const, writes: [] },
  });
  await f.life.participant.drain(offer, dispatch);
  f.life.retireCheckpoint(owner, checkpointRecoveryId(registered.value.checkpoint));
  f.deps.reads.stat = async () => ({
    ...record,
    revision: `r_${"2".repeat(32)}`,
    checkpoint: "open",
  });
  f.deps.evidence.flush = async () => ({
    completedMonotonicMs: f.deps.now(),
    state: "failed",
    accepted: [],
    incomplete: [record.id],
    unknown: [],
  });
  await f.life.refreshRecovery(owner, 10000);
  expect((await f.life.participant.drain(offer, dispatch)).blocker).toBe(true);
});

it("T5fix2 discarded checkpoint leaves unknown barrier evidence blocking", async () => {
  const f = fixture();
  const registered = await f.life.register(owner, {
    id: record.id,
    expectedRevision: record.revision,
  });
  if (!registered.ok) throw new Error("registration failed");
  const offer = f.life.participant.freeze(owner, "shutdown", 10000);
  const dispatch = async () => ({
    ok: true as const,
    value: { status: "checkpoint-only" as const, writes: [] },
  });
  await f.life.participant.drain(offer, dispatch);
  f.life.retireCheckpoint(owner, checkpointRecoveryId(registered.value.checkpoint));
  f.deps.evidence.flush = async () => ({
    completedMonotonicMs: f.deps.now(),
    state: "unknown",
    accepted: [],
    incomplete: [record.id],
    unknown: ["other-ticket"],
  });
  await f.life.refreshRecovery(owner, 10000);
  expect(await f.life.participant.drain(offer, dispatch)).toMatchObject({
    state: "uncertain",
    blocker: true,
  });
});
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

function evidenceDouble(now: () => number): LifecycleDependencies["evidence"] {
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
    flush: async () => ({
      completedMonotonicMs: now(),
      state: "saved",
      accepted: [],
      incomplete: [],
      unknown: [],
    }),
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
    completedMonotonicMs: f.deps.now(),
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
    completedMonotonicMs: f.deps.now(),
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

it("T5fix re-fences admitted tickets when an end or coalesced target shortens the deadline", async () => {
  const f = fixture();
  const fences = new Map<string, number>();
  f.deps.fenceTarget = (_owner, id, deadline) => {
    fences.set(id, Math.min(fences.get(id) ?? Infinity, deadline));
    return [];
  };
  f.deps.record = async (_owner, id) => ({ ...record, id });
  await f.life.register(owner, { id: record.id, expectedRevision: record.revision, reservation });
  const otherId = "00000000-0000-4000-8000-000000000008";
  await f.life.register(owner, { id: otherId, expectedRevision: record.revision, reservation });
  f.end();
  f.life.participant.endReservation(event, 10100);
  const shorter = f.life.participant.endReservation(event, 500)!;
  expect(shorter.deadlineMonotonicMs).toBe(500);
  expect([...fences.values()]).toEqual([500, 500]);
  await f.life.participant.drain({ ...shorter, deadlineMonotonicMs: 400 }, async () => ({
    ok: true,
    value: { status: "checkpoint-only", writes: [] },
  }));
  expect([...fences.values()]).toEqual([400, 400]);
});

it("T5fix sequential drains preserve their result with single-use worker barriers", async () => {
  const f = fixture(),
    captures = new Set<string>();
  let sequence = 0;
  f.deps.evidence.capture = (scope, deadlineMonotonicMs) => {
    const id = String(++sequence);
    captures.add(id);
    return { id, scope, deadlineMonotonicMs, through: 0 };
  };
  f.deps.evidence.flush = vi.fn(async (barrier) => {
    if (!captures.delete(barrier.id)) throw new Error("stale");
    return {
      completedMonotonicMs: f.deps.now(),
      state: "saved" as const,
      accepted: [],
      incomplete: [],
      unknown: [],
    };
  });
  await f.life.register(owner, { id: record.id, expectedRevision: record.revision });
  const offer = f.life.participant.freeze(owner, "shutdown", 10000);
  const dispatch = vi.fn(async () => {
    f.setFinal();
    return { ok: true as const, value: { status: "submitted" as const, writes: [] } };
  });
  const first = await f.life.participant.drain(offer, dispatch);
  expect(first.state).toBe("saved");
  expect(await f.life.participant.drain(offer, dispatch)).toEqual(first);
  const repeated = f.life.participant.freeze(owner, "shutdown", 10000);
  expect(await f.life.participant.drain(repeated, dispatch)).toEqual(first);
  expect(dispatch).toHaveBeenCalledOnce();
  expect(captures.size).toBe(0);
});

it("T5fix terminal history is finite, expires at 120 seconds, and preserves unresolved registrations", async () => {
  const f = fixture();
  f.deps.record = async (_owner, id) => ({ ...record, id });
  const unresolved = await f.life.register(owner, {
    id: record.id,
    expectedRevision: record.revision,
  });
  expect(unresolved.ok).toBe(true);
  for (let i = 0; i < 63; i++) {
    const id = `00000000-0000-4000-8000-${String(i + 100).padStart(12, "0")}`;
    const registered = await f.life.register(owner, { id, expectedRevision: record.revision });
    if (!registered.ok) throw new Error("terminal admission failed");
    f.life.committed(
      owner,
      {
        target: { mode: "replace", id, expectedRevision: record.revision },
        kind: record.kind,
        schemaVersion: 1,
        label: "",
        mediaType: record.mediaType,
        byteLength: 0,
        sha256: record.sha256,
        checkpoint: { handle: registered.value.checkpoint, phase: "final" },
      },
      { ...record, id, checkpoint: "final" },
    );
  }
  const next = "00000000-0000-4000-8000-000000000900";
  expect(
    await f.life.register(owner, { id: next, expectedRevision: record.revision }),
  ).toMatchObject({ error: { code: "PLUGIN_E_RESOURCE_LIMIT" } });
  f.advance(119999);
  expect((await f.life.register(owner, { id: next, expectedRevision: record.revision })).ok).toBe(
    false,
  );
  f.advance(1);
  expect((await f.life.register(owner, { id: next, expectedRevision: record.revision })).ok).toBe(
    true,
  );
  expect(
    await f.life.register(owner, {
      id: "00000000-0000-4000-8000-000000000901",
      expectedRevision: record.revision,
    }),
  ).toMatchObject({ error: { code: "PLUGIN_E_RESOURCE_LIMIT" } });
  const offer = f.life.participant.freeze(owner, "shutdown", 130000);
  f.setFinal();
  await f.life.participant.drain(offer, async () => ({
    ok: true,
    value: { status: "submitted", writes: [] },
  }));
  f.advance(120000);
  expect(
    (
      await f.life.register(owner, {
        id: "00000000-0000-4000-8000-000000000902",
        expectedRevision: record.revision,
      })
    ).ok,
  ).toBe(false);
});

it("T5fix a cached drain expires sealed eligibility without renewing its original deadline", async () => {
  const f = fixture();
  f.deps.pendingWrites = () => [{ write: "ticket", id: record.id, state: "sealed" }];
  f.deps.payload = () => ({ kind: "complete-staging", expiresMonotonicMs: 30000 });
  f.deps.evidence.flush = async () => ({
    completedMonotonicMs: f.deps.now(),
    state: "failed",
    accepted: ["ticket"],
    incomplete: ["ticket"],
    unknown: [],
  });
  const offer = f.life.participant.freeze(owner, "disable", 10000);
  const dispatch = async () => ({
    ok: true as const,
    value: { status: "checkpoint-only" as const, writes: [] },
  });
  const first = await f.life.participant.drain(offer, dispatch);
  expect(first.state).toBe("retryable");
  f.advance(30000);
  const expired = await f.life.participant.drain(offer, dispatch);
  expect(expired.state).toBe("checkpoint-only");
  expect(expired.records[0]?.payload).toBe("checkpoint-only");
  expect(expired.records[0]).not.toHaveProperty("expiresAt");
});

it.each([true, false])(
  "fractional retention reports validate for registered=%s and expire at the original payload deadline",
  async (registered) => {
    const f = fixture();
    let now = 0.25;
    f.deps.now = () => (now += 0.125);
    f.deps.wall = () => 100000 + Math.floor(now);
    if (registered)
      expect(
        (await f.life.register(owner, { id: record.id, expectedRevision: record.revision })).ok,
      ).toBe(true);
    else f.deps.pendingWrites = () => [{ write: reservation, id: record.id, state: "sealed" }];
    const fence = vi.fn<LifecycleDependencies["fence"]>(() => []);
    f.deps.fence = fence;
    const expiry = 30000.375;
    f.deps.payload = () => ({ kind: "complete-staging", expiresMonotonicMs: expiry });
    f.deps.evidence.flush = async () => ({
      completedMonotonicMs: f.deps.now(),
      state: "failed",
      accepted: [],
      incomplete: [record.id],
      unknown: [],
    });
    const recover = vi.fn<LifecycleDependencies["recover"]>(async (_owner, report) => {
      storedRecoverySchema.shape.report.parse(report);
      return report;
    });
    f.deps.recover = recover;
    const retained = await f.life.participant.ownerLost(owner);
    storedRecoverySchema.shape.report.parse(retained);
    expect(retained).toMatchObject({
      state: "retryable",
      records: [{ payload: "complete-staging" }],
    });
    expect(retained.records[0]!.expiresAt).toBeLessThanOrEqual(130000);
    expect(fence.mock.calls[0]![1] % 1).not.toBe(0);
    // Refresh reads the original monotonic payload deadline rather than the rounded wall projection.
    now = expiry - 0.125;
    f.deps.now = () => now;
    await f.life.refreshRecovery(owner, now + 10000);
    expect(recover.mock.calls.at(-1)![1]).toMatchObject({
      records: [{ payload: "complete-staging" }],
    });
    now = expiry;
    await f.life.refreshRecovery(owner, now + 10000);
    const expired = recover.mock.calls.at(-1)![1];
    expect(expired).toMatchObject({
      state: "checkpoint-only",
      records: [{ payload: "checkpoint-only" }],
    });
    expect(expired.records[0]).not.toHaveProperty("expiresAt");
  },
);

it("retained frozen callback survives ordinary liveness revocation without reopening admission", async () => {
  const f = fixture();
  const registered = await f.life.register(owner, {
    id: record.id,
    expectedRevision: record.revision,
  });
  if (!registered.ok) throw new Error("registration failed");
  f.deps.live = () => false;
  const offer = f.life.participant.freeze(owner, "disable", 10000);
  const callback = vi.fn(async (original, request) => {
    expect(original).toEqual(owner);
    expect(request.token).toBe(offer.token);
    expect(request.checkpoints[0]?.checkpoint).toBe(registered.value.checkpoint);
    f.setFinal();
    return { ok: true as const, value: { status: "submitted" as const, writes: [] } };
  });
  expect(await f.life.participant.drain(offer, callback)).toMatchObject({ state: "saved" });
  expect(callback).toHaveBeenCalledOnce();
  expect(
    await f.life.register(owner, { id: record.id, expectedRevision: record.revision }),
  ).toMatchObject({ error: { code: "PLUGIN_E_STALE_RESOURCE" } });
});

it.each(["lost", "expired", "owner", "token"] as const)(
  "retained frozen callback remains blocked after %s",
  async (reason) => {
    const f = fixture();
    expect(
      (await f.life.register(owner, { id: record.id, expectedRevision: record.revision })).ok,
    ).toBe(true);
    f.deps.live = () => false;
    const original = f.life.participant.freeze(owner, "disable", 10000);
    if (reason === "lost") await f.life.participant.ownerLost(owner);
    if (reason === "expired") f.advance(10000);
    const offer =
      reason === "owner"
        ? { ...original, owner: { ...owner, processEpoch: "00000000-0000-4000-8000-000000000099" } }
        : reason === "token"
          ? { ...original, token: "00000000-0000-4000-8000-000000000098" }
          : original;
    const callback = vi.fn(async () => ({
      ok: true as const,
      value: { status: "submitted" as const, writes: [] },
    }));
    await f.life.participant.drain(offer, callback);
    expect(callback).not.toHaveBeenCalled();
  },
);

it("keeps bounded original barrier evidence across more than the host limit of fresh reads", async () => {
  const f = fixture();
  const member: PublicationTicket = {
    id: randomUUID(),
    owner,
    target: { kind: "record", id: record.id, expectedRevision: null },
    metadata: { kind: "record", record, deleted: false },
    deadlineMonotonicMs: 10000,
  };
  f.deps.evidence.tickets = () => [member];
  const offer = f.life.participant.freeze(owner, "shutdown", 10000);
  let count = 0;
  f.deps.evidence.flush = async () => {
    count++;
    return {
      completedMonotonicMs: f.deps.now(),
      state: "unknown",
      accepted: [],
      unknown: [member.id],
      incomplete: [],
    };
  };
  const first = await f.life.participant.drain(offer, async () => ({
    ok: true,
    value: { status: "submitted", writes: [] },
  }));
  expect(first.blocker).toBe(true);
  for (let i = 0; i < 1100; i++)
    expect((await f.life.refreshRecovery(owner, 10000))?.blocker).toBe(true);
  expect(count).toBe(1102);
  for (const changed of [
    { ...member, deadlineMonotonicMs: 999 },
    { ...member, target: { ...member.target, id: randomUUID() } },
    { ...member, metadata: { ...member.metadata, record: { ...record, label: "Different" } } },
  ]) {
    f.life.resolveTicket(owner, changed);
    expect((await f.life.refreshRecovery(owner, 10000))?.blocker).toBe(true);
  }
  f.life.resolveTicket(owner, member);
  expect((await f.life.refreshRecovery(owner, 10000))?.state).toBe("saved");
});

it("reclaims clean owner histories without reopening old generations", async () => {
  const f = fixture();
  for (let generation = 1; generation <= 195; generation++) {
    const next = { ...owner, generation };
    const offer = f.life.participant.freeze(next, "shutdown", f.deps.now() + 10000);
    expect(
      (
        await f.life.participant.drain(offer, async () => ({
          ok: true,
          value: { status: "submitted", writes: [] },
        }))
      ).state,
    ).toBe("saved");
    f.advance(120001);
  }
  expect(
    (await f.life.register(owner, { id: record.id, expectedRevision: record.revision })).ok,
  ).toBe(false);
});

it("shortens both callers while the flush producer is pending", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    const flush = vi.fn(() => new Promise<never>(() => {}));
    f.deps.evidence.flush = flush;
    const offer = f.life.participant.freeze(owner, "shutdown", 500);
    const dispatch = vi.fn();
    const receipts: boolean[] = [];
    const first = f.life.participant.drain(offer, dispatch).then((r) => receipts.push(r.blocker));
    await vi.advanceTimersByTimeAsync(0);
    expect(flush).toHaveBeenCalled();
    const second = f.life.participant
      .drain({ ...offer, deadlineMonotonicMs: 10 }, dispatch)
      .then((r) => receipts.push(r.blocker));
    f.advance(10);
    await vi.advanceTimersByTimeAsync(10);
    expect(receipts).toEqual([true, true]);
    await Promise.all([first, second]);
  } finally {
    vi.useRealTimers();
  }
});

it("retiring 1100 siblings leaves capacity for another included target", async () => {
  const f = fixture();
  await f.life.register(owner, { id: record.id, expectedRevision: record.revision, reservation });
  f.life.participant.endReservation(event, 10000);
  for (let i = 0; i < 1100; i++) {
    const id = randomUUID();
    f.deps.record = async () => ({ ...record, id });
    const result = await f.life.register(owner, { id, expectedRevision: record.revision });
    if (!result.ok) throw Error("registration failed");
    f.life.retireCheckpoint(owner, checkpointRecoveryId(result.value.checkpoint));
  }
  const id = randomUUID();
  f.deps.record = async () => ({ ...record, id });
  expect(
    (await f.life.register(owner, { id, expectedRevision: record.revision, reservation })).ok,
  ).toBe(true);
  expect(f.life.participant.endReservation(event, 10000)?.checkpoints.length).toBe(2);
});

it("reclaims discharged reservation-only groups over repeated source limits", async () => {
  const f = fixture();
  f.setFinal();
  for (let generation = 1; generation <= 195; generation++) {
    const next = { ...owner, generation },
      deadline = f.deps.now() + 10000;
    f.deps.reservations.validate = () => ({
      owner: next,
      reservationId: reservation,
      sessionId: event.sessionId,
      providerGeneration: 1,
    });
    expect(
      (
        await f.life.register(next, {
          id: record.id,
          expectedRevision: record.revision,
          reservation,
        })
      ).ok,
    ).toBe(true);
    const offer = f.life.participant.endReservation(
      {
        ...event,
        owner: next,
        endedMonotonicMs: f.deps.now(),
        drain: { ...event.drain!, owner: next, expiresMonotonicMs: deadline },
      },
      deadline,
    );
    if (!offer) throw Error("missing target offer");
    expect(
      (
        await f.life.participant.drain(offer, async () => ({
          ok: true,
          value: { status: "submitted", writes: [] },
        }))
      ).blocker,
    ).toBe(false);
    f.advance(120001);
  }
});

it("reuses unresolved identities across clocks, unrelated admissions and failed reads at capacity", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    const members: PublicationTicket[] = Array.from({ length: 1024 }, () => ({
      id: randomUUID(),
      owner,
      target: { kind: "record", id: record.id, expectedRevision: null },
      metadata: { kind: "record", record, deleted: false },
      deadlineMonotonicMs: 10000,
    }));
    const member = members[0]!;
    let outcome: "unknown" | "rejected" | "timeout" | "saved" = "unknown";
    let sequence = 0;
    f.deps.evidence.capture = (scope, deadlineMonotonicMs) => ({
      id: randomUUID(),
      scope,
      through: ++sequence,
      deadlineMonotonicMs,
    });
    f.deps.evidence.tickets = () => (sequence <= 2 ? members : [member]);
    f.deps.evidence.flush = async (barrier) => {
      if (outcome === "timeout") return new Promise<never>(() => {});
      if (outcome === "rejected") throw new Error("unavailable");
      return {
        state: outcome,
        completedMonotonicMs: f.deps.now(),
        accepted: barrier.through <= 2 ? members.map((m) => m.id) : [member.id],
        unknown: outcome === "unknown" ? [member.id] : [],
        incomplete: [],
      };
    };
    const offer = f.life.participant.freeze(owner, "shutdown", 10000);
    expect((await f.life.participant.drain(offer, vi.fn())).blocker).toBe(true);
    for (const variant of ["rejected", "timeout", "unknown"] as const) {
      outcome = variant;
      for (let i = 0; i < (variant === "timeout" ? 2 : 550); i++) {
        f.advance(1);
        const reading = f.life.refreshRecovery(owner, f.deps.now() + 10);
        if (variant === "timeout") {
          await vi.advanceTimersByTimeAsync(0);
          f.advance(10);
          await vi.advanceTimersByTimeAsync(10);
        }
        expect((await reading)?.blocker).toBe(true);
      }
    }
    expect(sequence).toBe(1104);
    outcome = "saved";
    expect((await f.life.refreshRecovery(owner, f.deps.now() + 10))?.blocker).toBe(true);
    expect(f.life.resolveTicket(owner, member)).toBe(true);
    expect((await f.life.refreshRecovery(owner, f.deps.now() + 10))?.state).toBe("saved");
  } finally {
    vi.useRealTimers();
  }
});

const captureCases = [
  ["refresh", "freeze", "held", 2, false],
  ["refresh", "drain", "held", 2, false],
  ["refresh", "minimum", "before dispatch", 3, true],
  ["corroboration", "freeze", "held", 2, true],
  ["discharge", "drain", "held", 3, true],
  ["original", "drain", "held", 3, true],
  ["original", "freeze", "before dispatch", 1, false],
  ["refresh", "freeze", "after fold", 2, false],
  ["refresh", "drain", "after fold", 3, true],
  ["refresh", "none", "held", 1, false],
] as const;
it.each(
  captureCases.flatMap(([capture, source, phase, callers, populated]) =>
    [9, 10, 11].map((stamp) => ({ capture, source, phase, callers, populated, stamp })),
  ),
)(
  "capture cutoff $capture $source $phase x$callers at $stamp",
  async ({ capture, source, phase, callers, populated, stamp }) => {
    const f = fixture();
    const member: PublicationTicket = {
      id: randomUUID(),
      owner,
      target: { kind: "record", id: record.id, expectedRevision: record.revision },
      metadata: { kind: "record", record, deleted: false },
      deadlineMonotonicMs: 500,
    };
    if (populated) f.deps.evidence.tickets = () => [member];
    const port = f.life.participant;
    if (source === "minimum" || capture === "corroboration") {
      expect(
        (
          await f.life.register(owner, {
            id: record.id,
            expectedRevision: record.revision,
            reservation,
          })
        ).ok,
      ).toBe(true);
      if (source === "minimum") {
        const target = port.endReservation(event, 500);
        expect(target?.deadlineMonotonicMs).toBe(500);
        f.setFinal();
      }
    }
    const offer = port.freeze(owner, "shutdown", 500);
    const result = (at: number) => ({
      completedMonotonicMs: at,
      state: "saved" as const,
      accepted: populated ? [member.id] : [],
      unknown: [],
      incomplete: [],
    });
    f.deps.evidence.flush = async () => result(0);
    if (capture === "corroboration")
      f.deps.evidence.flush = async () => ({
        ...result(0),
        state: "unknown",
        accepted: [],
        unknown: [member.id],
      });
    if (capture === "discharge")
      f.deps.evidence.flush = async () => {
        throw Error("no original result");
      };
    const dispatch = vi.fn();
    if (capture === "refresh") expect((await port.drain(offer, dispatch)).blocker).toBe(false);
    if (capture === "corroboration" || capture === "discharge") {
      expect((await port.drain(offer, dispatch)).blocker).toBe(true);
      f.setFinal();
      if (capture === "discharge") expect(f.life.resolveTicket(owner, member)).toBe(true);
    }
    const joined: Promise<{ blocker: boolean }>[] = [];
    const shorten = () => {
      const next =
        source === "drain"
          ? { ...offer, deadlineMonotonicMs: 10 }
          : source === "minimum"
            ? port.freeze(owner, "shutdown", 400, { ...event.drain!, expiresMonotonicMs: 10 })
            : port.freeze(owner, "shutdown", 10);
      for (let i = 1; i < callers; i++) joined.push(port.drain(next, dispatch));
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    f.deps.evidence.flush = async () => {
      signalEntered();
      await gate;
      return result(source === "none" ? 500 + stamp : stamp);
    };
    if (phase === "after fold")
      f.deps.pendingPublication = () => {
        shorten();
        return false;
      };
    const first =
      capture !== "original" ? f.life.refreshRecovery(owner, 600) : port.drain(offer, dispatch);
    if (phase === "before dispatch") shorten();
    await entered;
    if (phase === "held" && source !== "none") shorten();
    release();
    const receipts = [await first, ...(await Promise.all(joined))];
    expect(receipts.map((r) => r?.blocker)).toEqual(
      Array(callers).fill(source !== "none" && stamp >= 10),
    );
  },
);
