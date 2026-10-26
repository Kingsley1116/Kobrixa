import { storedRecoverySchema } from "./namespace.js";
import type { RecordMeta } from "@kobrixa/plugin-protocol";
import type { ExportDestination } from "./actions.js";
import { expect, it, vi } from "vitest";
import type { DrainReport } from "@kobrixa/plugin-runtime";
import { createPersistenceRecovery } from "./recovery-port.js";
import type { PersistenceBackend, StoredRecovery } from "./engine-port.js";
function recoveryBackendDouble(): PersistenceBackend {
  const rows = new Map<string, StoredRecovery>();
  const fail = () => {
    throw new Error("Unexpected I/O in retention-only unit test.");
  };
  return {
    engine: {
      reserve: fail,
      append: fail,
      seal: fail,
      publish: fail,
      reconcile: fail,
      abort: fail,
      fence: fail,
      fenceTarget: fail,
    },
    reads: { settings: fail, stat: fail, list: fail, open: fail, read: fail, close: fail },
    evidence: {
      capture: fail,
      flush: fail,
      tickets: fail,
      quota: fail,
      settingsDigest: fail,
      auxiliary: fail,
      auxiliaryKeys: fail,
      recoveryPage: async () => ({ items: [...rows.values()], nextCursor: null }),
      loadRecovery: async (id) => rows.get(id) ?? null,
      saveRecovery: async (row) => {
        rows.set(row.id, structuredClone(row));
      },
      removeRecovery: async (id) => {
        rows.delete(id);
      },
    },
    imports: {
      load: fail,
      plan: fail,
      admit: fail,
      tagImport: fail,
      importReceipts: fail,
      record: fail,
      reconcile: fail,
      complete: fail,
    },
    output: { begin: fail, append: fail, commit: fail, reconcile: fail, abort: fail },
    destinations: { register: fail, release: fail },
    sources: {
      resolvePreferences: fail,
      register: fail,
      map: fail,
      appendMapped: fail,
      releaseMapped: fail,
      inventory: fail,
      read: fail,
    },
    dispose: async () => {},
  };
}
const owner = {
  sourceKey: "builtin:test.recovery",
  pluginId: "test.recovery",
  generation: 1,
  hostEpoch: "h",
  processEpoch: "p",
};
const action = { actionToken: "action", scope: { hostEpoch: "h", workbenchInstance: "window" } };
const report: DrainReport = {
  state: "retryable",
  blocker: true,
  pendingSettings: false,
  records: [
    {
      id: "record",
      committedRevision: null,
      final: false,
      payload: "complete-staging",
      expiresAt: 130000,
    },
  ],
  errors: [],
};

it.each([5000, 10001])("T5fix3 queued retry keeps its admission deadline (%s)", async (waited) => {
  const backend = recoveryBackendDouble();
  let now = 0;
  const retry = vi.fn(
    async (
      _owner: typeof owner,
      previous: DrainReport,
      _deadline: number,
    ): Promise<DrainReport> => ({
      ...previous,
      state: "saved",
      blocker: false,
      records: previous.records.map((r) => ({
        id: r.id,
        committedRevision: "final-revision",
        final: true,
        payload: "checkpoint-only",
      })),
    }),
  );
  const complete = vi.fn();
  const recovery = createPersistenceRecovery({
    coreOwner: () => owner,
    now: () => now,
    wall: () => 100000 + now,
    actions: { claim: () => true, isClaimed: () => true, complete },
    retry,
    discard: async () => report,
    backend,
    adapter: { chooseDestination: async () => null, copyText: async () => {} },
  });
  const initial = await recovery.retain(owner, report);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((done) => {
    enter = done;
  });
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const save = backend.evidence.saveRecovery;
  backend.evidence.saveRecovery = async (row) => {
    enter();
    await gate;
    await save(row);
  };
  const retaining = recovery.retain(owner, initial);
  await entered;
  const acting = recovery.retry(initial.recovery!, action).catch((error: unknown) => error);
  await new Promise<void>((done) => setTimeout(done, 0));
  const callsWhileRetaining = retry.mock.calls.length;
  now = waited;
  release();
  await retaining;
  const result = await acting;
  expect(callsWhileRetaining).toBe(0);
  expect(complete).toHaveBeenCalledOnce();
  if (waited > 10000) {
    expect(result).toMatchObject({ result: { error: { code: "PLUGIN_E_STALE_RESOURCE" } } });
    expect(retry).not.toHaveBeenCalled();
    expect((await backend.evidence.loadRecovery(initial.recovery!))?.report.state).toBe(
      "retryable",
    );
    // A timed-out queued action does not poison a legitimate new core retry.
    expect((await recovery.retry(initial.recovery!, action)).state).toBe("saved");
    expect(retry.mock.calls[0]?.[2]).toBe(20001);
  } else {
    expect(result).toMatchObject({ state: "saved", blocker: false });
    expect(retry.mock.calls[0]?.[2]).toBe(10000);
  }
  expect(recovery.snapshot().items[0]?.state).toBe("saved");
  expect((await backend.evidence.loadRecovery(initial.recovery!))?.expiresAt).toBe(130000);
});

it.each(["source", "host"] as const)(
  "T5fix3 %s mutation admission is bounded and releases capacity",
  async (scope) => {
    const backend = recoveryBackendDouble();
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const save = backend.evidence.saveRecovery;
    backend.evidence.saveRecovery = async (row) => {
      if (row.owner.sourceKey !== "independent") await gate;
      await save(row);
    };
    const recovery = createPersistenceRecovery({
      coreOwner: () => owner,
      now: () => 0,
      wall: () => 100000,
      actions: { claim: () => true, isClaimed: () => true, complete() {} },
      retry: async () => report,
      discard: async () => report,
      backend,
      adapter: { chooseDestination: async () => null, copyText: async () => {} },
    });
    const count = scope === "source" ? 64 : 1024;
    const retained = { ...report, recovery: "retained" };
    const pending = Array.from({ length: count }, (_, i) =>
      recovery.retain(
        { ...owner, ...(scope === "host" ? { sourceKey: `source-${Math.floor(i / 64)}` } : {}) },
        { ...retained, recovery: `retained-${i}` },
      ),
    );
    const overflow =
      scope === "source" ? { ...owner, generation: 2 } : { ...owner, sourceKey: "overflow" };
    await expect(recovery.retain(overflow, retained)).rejects.toMatchObject({
      result: { error: { code: "PLUGIN_E_RESOURCE_LIMIT" } },
    });
    if (scope === "source")
      expect(
        (
          await recovery.retain(
            { ...owner, sourceKey: "independent" },
            { ...retained, recovery: "independent" },
          )
        ).recovery,
      ).toBe("independent");
    release();
    await Promise.all(pending);
    expect((await recovery.retain(overflow, retained)).recovery).toBe("retained");
  },
);

it.each(["retry", "discard"] as const)(
  "T5fix2 %s notifies composition only after durability and joins reconciliation",
  async (operation) => {
    const backend = recoveryBackendDouble(),
      completed = vi.fn();
    let release!: () => void,
      notified = false;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const notify = vi.fn(async (_owner: typeof owner, result: DrainReport) => {
      expect(result.recovery).toBe(id);
      const row = await backend.evidence.loadRecovery(id);
      if (operation === "retry") expect(row?.report.state).toBe("saved");
      else expect(row).toBeNull();
      notified = true;
      await pending;
    });
    const recovery = createPersistenceRecovery({
      coreOwner: () => owner,
      now: () => 0,
      wall: () => 100000,
      actions: { claim: () => true, isClaimed: () => true, complete: completed },
      retry: async () => ({ ...report, state: "saved", blocker: false }),
      discard: async () => ({ ...report, state: "checkpoint-only", blocker: false }),
      retried: notify,
      discarded: notify,
      backend,
      adapter: { chooseDestination: async () => null, copyText: async () => {} },
    });
    const id = (await recovery.retain(owner, report)).recovery!;
    let finished = false;
    const work = recovery[operation](id, action).then(() => {
      finished = true;
    });
    await vi.waitFor(() => expect(notified).toBe(true));
    expect(finished).toBe(false);
    expect(completed).not.toHaveBeenCalled();
    release();
    await work;
    expect(notify).toHaveBeenCalledOnce();
    expect(completed).toHaveBeenCalledOnce();
  },
);

it.each(["retry", "discard"] as const)(
  "T5fix2 failed durable %s cannot retire aggregate evidence",
  async (operation) => {
    const backend = recoveryBackendDouble(),
      notify = vi.fn(async () => {});
    const recovery = createPersistenceRecovery({
      coreOwner: () => owner,
      now: () => 0,
      wall: () => 100000,
      actions: { claim: () => true, isClaimed: () => true, complete: () => {} },
      retry: async () => ({ ...report, state: "saved", blocker: false }),
      discard: async () => ({ ...report, state: "checkpoint-only", blocker: false }),
      retried: notify,
      discarded: notify,
      backend,
      adapter: { chooseDestination: async () => null, copyText: async () => {} },
    });
    const id = (await recovery.retain(owner, report)).recovery!;
    if (operation === "retry")
      backend.evidence.saveRecovery = async () => {
        throw new Error("save failed");
      };
    else
      backend.evidence.removeRecovery = async () => {
        throw new Error("remove failed");
      };
    await expect(recovery[operation](id, action)).rejects.toThrow("failed");
    expect(notify).not.toHaveBeenCalled();
    expect((await backend.evidence.loadRecovery(id))?.report.blocker).toBe(true);
  },
);
it("B2-RF3: failed retry never extends the original 30-second retention", async () => {
  let now = 0;
  const retry = vi.fn(async () => report);
  const recovery = createPersistenceRecovery({
    coreOwner: () => owner,
    now: () => now,
    wall: () => 100000 + now,
    actions: { claim: () => true, isClaimed: () => true, complete: () => {} },
    retry,
    discard: async () => ({ ...report, state: "checkpoint-only", blocker: false }),
    backend: recoveryBackendDouble(),
    adapter: { chooseDestination: async () => null, copyText: async () => {} },
  });
  const saved = await recovery.retain(owner, report);
  const id = saved.recovery!;
  now = 20000;
  await recovery.retry(id, action);
  expect(recovery.recoverySnapshot().items[0]!.expiresAt).toBe(130000);
  now = 30000;
  expect(recovery.recoverySnapshot().items[0]).toMatchObject({
    state: "checkpoint-only",
    payload: "none",
  });
  expect(recovery.recoverySnapshot().items[0]!.actions.map((x) => x.kind)).not.toContain("retry");
  await expect(recovery.retry(id, action)).rejects.toThrow();
  expect(retry).toHaveBeenCalledOnce();
});
it("B2-RF4/U16: core actions must match the item and cannot reuse feature proofs", async () => {
  const retry = vi.fn(async () => report),
    discard = vi.fn(async () => report);
  const recovery = createPersistenceRecovery({
    coreOwner: () => owner,
    now: () => 0,
    wall: () => 100000,
    actions: { claim: () => false, isClaimed: () => false, complete: () => {} },
    retry,
    discard,
    backend: recoveryBackendDouble(),
    adapter: { chooseDestination: async () => null, copyText: async () => {} },
  });
  const id = (await recovery.retain(owner, report)).recovery!;
  await expect(recovery.retry(id, action)).rejects.toThrow();
  await expect(recovery.discard(id, action)).rejects.toThrow();
  expect(retry).not.toHaveBeenCalled();
  expect(discard).not.toHaveBeenCalled();
});

it("unknown core exports reconcile the original job without opening another destination", async () => {
  const backend = recoveryBackendDouble(),
    pin = "sealed",
    destination = Object.freeze({}) as ExportDestination;
  const row: StoredRecovery = {
    id: "recovery",
    owner,
    report: {
      ...report,
      recovery: "recovery",
      records: [
        {
          id: "record",
          committedRevision: "r_" + "1".repeat(32),
          final: false,
          payload: "checkpoint-only",
        },
      ],
    },
    ticket: null,
    sealedPin: null,
    expiresAt: null,
  };
  backend.evidence.recoveryPage = async () => ({ items: [row], nextCursor: null });
  backend.evidence.loadRecovery = async () => row;
  backend.reads.stat = async () => ({
    id: "record",
    revision: "r_" + "1".repeat(32),
    kind: "test",
    schemaVersion: 1,
    label: "",
    mediaType: "text/plain",
    byteLength: 0,
    sha256: "a".repeat(64),
    createdAt: 0,
    updatedAt: 0,
    checkpoint: "none",
    interrupted: false,
  });
  backend.reads.open = async () => pin;
  backend.reads.close = vi.fn(async () => {});
  backend.output.begin = vi.fn(async () => {});
  backend.output.commit = async () => ({ disposition: "unknown" });
  backend.output.reconcile = vi.fn(async () => ({ disposition: "unknown" as const }));
  backend.destinations.release = vi.fn(async () => {});
  const chooseDestination = vi.fn(async () => destination);
  const recovery = createPersistenceRecovery({
    coreOwner: () => owner,
    now: () => 0,
    wall: () => 100000,
    backend,
    actions: { claim: () => true, isClaimed: () => true, complete: () => {} },
    retry: async () => report,
    discard: async () => report,
    adapter: { chooseDestination, copyText: async () => {} },
  });
  await recovery.restore();
  expect(await recovery.export({ recovery: row.id, action })).toMatchObject({
    value: { disposition: "unknown" },
  });
  expect(backend.reads.close).not.toHaveBeenCalled();
  expect(backend.destinations.release).not.toHaveBeenCalled();
  await recovery.export({ recovery: row.id, action });
  expect(chooseDestination).toHaveBeenCalledOnce();
  expect(backend.output.begin).toHaveBeenCalledOnce();
  backend.output.reconcile = async () => ({ disposition: "committed" });
  expect(await recovery.export({ recovery: row.id, action })).toMatchObject({
    value: { disposition: "committed" },
  });
  expect(backend.reads.close).toHaveBeenCalledOnce();
  expect(backend.destinations.release).toHaveBeenCalledOnce();
});

it("T5fix restart export uses current core authority and preserves historical evidence", async () => {
  const backend = recoveryBackendDouble();
  const historical = { ...owner, hostEpoch: "old-host" },
    current = { ...owner, hostEpoch: "new-host", processEpoch: "core", generation: 0 };
  const row: StoredRecovery = {
    id: "restored",
    owner: historical,
    ticket: null,
    sealedPin: null,
    expiresAt: null,
    report: {
      ...report,
      state: "checkpoint-only",
      records: [
        {
          id: "record",
          committedRevision: "r_" + "1".repeat(32),
          final: false,
          payload: "checkpoint-only",
        },
      ],
    },
  };
  backend.evidence.recoveryPage = async () => ({ items: [row], nextCursor: null });
  backend.evidence.loadRecovery = async () => row;
  backend.reads.stat = vi.fn(async (o): Promise<RecordMeta> => {
    if (o.hostEpoch !== current.hostEpoch) throw new Error("stale");
    return {
      id: "record",
      revision: "r_" + "1".repeat(32),
      kind: "test",
      schemaVersion: 1,
      label: "",
      mediaType: "text/plain",
      byteLength: 0,
      sha256: "a".repeat(64),
      createdAt: 0,
      updatedAt: 0,
      checkpoint: "open",
      interrupted: false,
    };
  });
  backend.reads.open = vi.fn(async () => "pin");
  backend.reads.close = vi.fn(async () => {});
  backend.output.begin = vi.fn(async (_id, o) => {
    expect(o).toEqual(current);
  });
  backend.output.commit = async () => ({ disposition: "committed" });
  backend.destinations.release = async () => {};
  const coreOwner = vi.fn(() => current);
  const recovery = createPersistenceRecovery({
    now: () => 0,
    wall: () => 100000,
    backend,
    actions: { claim: () => true, isClaimed: () => true, complete() {} },
    coreOwner,
    retry: async () => report,
    discard: async () => report,
    adapter: {
      chooseDestination: async () => Object.freeze({}) as ExportDestination,
      copyText: async () => {},
    },
  });
  await recovery.restore();
  const fresh = { ...action, scope: { ...action.scope, hostEpoch: current.hostEpoch } };
  expect(await recovery.export({ recovery: row.id, action: fresh })).toMatchObject({
    value: { disposition: "committed" },
  });
  expect(coreOwner).toHaveBeenCalledWith({ sourceKey: historical.sourceKey, scope: fresh.scope });
  expect(backend.reads.close).toHaveBeenCalledWith(current, "pin");
  expect(row.owner).toEqual(historical);
});

it("fractional recovery projections validate on retain/retry/snapshot without renewing retention", async () => {
  const backend = recoveryBackendDouble();
  const validOwner = {
    ...owner,
    hostEpoch: "00000000-0000-4000-8000-000000000001",
    processEpoch: "00000000-0000-4000-8000-000000000002",
  };
  const validReport: DrainReport = {
    ...report,
    records: [{ ...report.records[0]!, id: "00000000-0000-4000-8000-000000000003" }],
  };
  let now = 0.25;
  let advancing = true;
  let wall = () => 100000 + Math.floor(now);
  const clock = {
    now: () => (advancing ? (now += 0.125) : now),
    wall: () => wall(),
  };
  const saved: StoredRecovery[] = [];
  const save = backend.evidence.saveRecovery;
  backend.evidence.saveRecovery = async (row) => {
    storedRecoverySchema.parse(row);
    saved.push(structuredClone(row));
    await save(row);
  };
  const deadlines: number[] = [];
  const recovery = createPersistenceRecovery({
    ...clock,
    coreOwner: () => validOwner,
    actions: { claim: () => true, isClaimed: () => true, complete() {} },
    retry: async (_owner, previous, deadline) => {
      deadlines.push(deadline);
      now += 0.125;
      return { ...previous, records: previous.records.map((r) => ({ ...r, expiresAt: 200000 })) };
    },
    discard: async () => validReport,
    backend,
    adapter: { chooseDestination: async () => null, copyText: async () => {} },
  });
  const retained = await recovery.retain(validOwner, validReport);
  expect(saved).toHaveLength(1); // retain must not swallow a durable-schema failure.
  expect(retained.state).toBe("retryable");
  expect(saved[0]!.expiresAt).toBe(129999);
  const snapshot = recovery.snapshot();
  expect(Number.isInteger(snapshot.items[0]!.expiresAt)).toBe(true);
  expect(snapshot.items[0]!.expiresAt).toBeLessThanOrEqual(130000);
  const retried = await recovery.retry(retained.recovery!, action);
  storedRecoverySchema.shape.report.parse(retried);
  expect(saved).toHaveLength(2);
  expect(retried.records[0]!.expiresAt).toBeLessThanOrEqual(130000);
  expect(deadlines[0]! % 1).not.toBe(0);
  // Initial retain translates 130000 at monotonic 0.375 into 30000.375.
  // Later projection/rounding and failed retries cannot move that deadline.
  now = 30000.25;
  advancing = false;
  expect(recovery.snapshot().items[0]!.state).toBe("retryable");
  now = 30000.375;
  expect(recovery.snapshot().items[0]!.state).toBe("checkpoint-only");
  await expect(recovery.retry(retained.recovery!, action)).rejects.toThrow();
  expect(deadlines).toHaveLength(1);
  // An overdue finite retention projected after a backwards wall-clock jump
  // still persists valid evidence, with a zero wall expiry.
  now = 200000;
  wall = () => 0;
  await recovery.retain(validOwner, {
    ...retained,
    state: "checkpoint-only",
    records: retained.records.map((record) => ({
      id: record.id,
      committedRevision: record.committedRevision,
      final: record.final,
      payload: "none",
    })),
  });
  expect(saved).toHaveLength(3);
  expect(saved.at(-1)!.expiresAt).toBe(0);
});
