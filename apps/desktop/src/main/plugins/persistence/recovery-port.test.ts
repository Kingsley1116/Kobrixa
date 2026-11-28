import { createPersistenceLifecycle } from "./lifecycle.js";
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
      releasePreferences: fail,
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
    expect(recovery.blocked(overflow)).toBe(true);
    expect(
      recovery.snapshot().items.some((r) => r.id === "retained" && r.state === "uncertain"),
    ).toBe(true);
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

it("keeps a failed retain blocking across repeated retention until authorized durable discard", async () => {
  const backend = recoveryBackendDouble();
  const changing = vi.fn(),
    subscriber = vi.fn();
  const recovery = createPersistenceRecovery({
    changing,
    coreOwner: () => owner,
    now: () => 0,
    wall: () => 100000,
    actions: { claim: () => true, isClaimed: () => true, complete: () => {} },
    retry: async () => report,
    discard: async () => ({ ...report, state: "saved", blocker: false }),
    backend,
    adapter: { chooseDestination: async () => null, copyText: async () => {} },
  });
  recovery.subscribe(subscriber);
  vi.spyOn(backend.evidence, "saveRecovery").mockRejectedValueOnce(new Error("io"));
  const failed = await recovery.retain(owner, report);
  expect(changing).toHaveBeenCalledOnce();
  expect(subscriber).toHaveBeenCalledOnce();
  const next = await recovery.retain(owner, { ...failed, state: "saved", blocker: false });
  expect(next).toMatchObject({ state: "uncertain", blocker: true, recovery: failed.recovery });
  expect((await backend.evidence.loadRecovery(failed.recovery!))?.report).toMatchObject({
    state: "uncertain",
    blocker: true,
  });
  expect(recovery.blocked(owner)).toBe(true);
  await recovery.discard(failed.recovery!, action);
  expect(recovery.blocked(owner)).toBe(false);
});

it("publishes the reserved blocker if the retain report exceeds the byte limit", async () => {
  const changing = vi.fn(),
    subscriber = vi.fn();
  const recovery = createPersistenceRecovery({
    coreOwner: () => owner,
    now: () => 0,
    wall: () => 0,
    changing,
    actions: { claim: () => true, isClaimed: () => true, complete() {} },
    retry: async () => report,
    discard: async () => ({ ...report, blocker: false }),
    backend: recoveryBackendDouble(),
    adapter: { chooseDestination: async () => null, copyText: async () => {} },
  });
  recovery.subscribe(subscriber);
  await expect(
    recovery.retain(owner, {
      ...report,
      errors: [{ code: "PLUGIN_E_STORAGE_IO", message: "x".repeat(8193) }],
    }),
  ).rejects.toThrow();
  expect(recovery.blocked(owner)).toBe(true);
  expect(changing).toHaveBeenCalledOnce();
  expect(subscriber).toHaveBeenCalledOnce();
  const [row] = recovery.snapshot().items;
  await recovery.discard(row!.id, action);
  expect(recovery.blocked(owner)).toBe(false);
});

it("publishes a discardable identity when restored reports exhaust the source byte budget", async () => {
  const backend = recoveryBackendDouble(),
    changing = vi.fn(),
    subscriber = vi.fn();
  const persistedOwner = {
    ...owner,
    hostEpoch: "00000000-0000-4000-8000-000000000001",
    processEpoch: "00000000-0000-4000-8000-000000000002",
  };
  const ids = Array.from(
    { length: 512 },
    (_, i) => `00000000-0000-4000-8000-${(i + 1).toString().padStart(12, "0")}`,
  );
  for (const id of ids) {
    const full: DrainReport = {
      state: "uncertain",
      blocker: true,
      records: [],
      pendingSettings: false,
      recovery: id,
      errors: Array.from({ length: 16 }, () => ({ code: "PLUGIN_E_STORAGE_IO", message: "x" })),
    };
    let space = 8192 - Buffer.byteLength(JSON.stringify(full));
    for (const error of full.errors) {
      const n = Math.min(space, 511);
      error.message += "x".repeat(n);
      space -= n;
    }
    expect(space).toBe(0);
    const row = {
      id,
      owner: persistedOwner,
      report: full,
      ticket: null,
      sealedPin: null,
      expiresAt: null,
    };
    storedRecoverySchema.parse(row);
    await backend.evidence.saveRecovery(row);
  }
  const load = backend.evidence.loadRecovery;
  backend.evidence.recoveryPage = async (cursor) => {
    const i = cursor ? ids.indexOf(cursor) + 1 : 0,
      page = ids.slice(i, i + 16);
    return {
      items: await Promise.all(page.map(async (id) => (await load(id))!)),
      nextCursor: i + 16 < ids.length ? page.at(-1)! : null,
    };
  };
  const recovery = createPersistenceRecovery({
    coreOwner: () => persistedOwner,
    now: () => 0,
    wall: () => 0,
    changing,
    actions: { claim: () => true, isClaimed: () => true, complete() {} },
    retry: async () => report,
    discard: async (_owner, previous) => ({ ...previous, blocker: false }),
    backend,
    adapter: { chooseDestination: async () => null, copyText: async () => {} },
  });
  await recovery.restore();
  recovery.subscribe(subscriber);
  const next = { ...persistedOwner, generation: 2 },
    id = "00000000-0000-4000-8000-000000000999";
  await expect(recovery.retain(next, { ...report, recovery: id })).rejects.toMatchObject({
    result: { error: { code: "PLUGIN_E_RESOURCE_LIMIT" } },
  });
  expect(changing).toHaveBeenCalledOnce();
  expect(subscriber).toHaveBeenCalledOnce();
  expect(recovery.blocked(next)).toBe(true);
  expect(recovery.snapshot().items.find((r) => r.id === id)).toMatchObject({
    state: "uncertain",
    actions: [{ kind: "discard" }],
  });
  const more = Array.from({ length: 64 }, (_, i) => ({
    owner: { ...persistedOwner, generation: 3 + Math.floor(i / 2) },
    id: `00000000-0000-4000-8000-${(1000 + i).toString().padStart(12, "0")}`,
  }));
  for (const item of more) {
    recovery.reserveIdentity(item.owner, item.id, "ticket");
    await expect(
      recovery.retain(item.owner, { ...report, recovery: item.id }),
    ).rejects.toMatchObject({ result: { error: { code: "PLUGIN_E_RESOURCE_LIMIT" } } });
    expect(recovery.blocked(item.owner)).toBe(true);
  }
  expect(changing).toHaveBeenCalledTimes(65);
  expect(subscriber).toHaveBeenCalledTimes(65);
  expect(recovery.snapshot().items).toHaveLength(577);
  for (const item of more) await recovery.discard(item.id, action);
  await recovery.discard(id, action);
  expect(recovery.blocked(next)).toBe(false);
  expect(recovery.snapshot().items).toHaveLength(512);
});

it.each([
  ["source", "discard"],
  ["host", "discard"],
  ["source", "retry"],
  ["host", "retry"],
] as const)("authorized %s queue refusal preserves %s blocker", async (scope, operation) => {
  const changing = vi.fn(),
    listener = vi.fn();
  const recovery = createPersistenceRecovery({
    coreOwner: () => owner,
    now: () => 0,
    wall: () => 0,
    changing,
    actions: { claim: () => true, isClaimed: () => true, complete() {} },
    retry: async () => report,
    discard: async () => ({ ...report, blocker: false }),
    backend: recoveryBackendDouble(),
    adapter: { chooseDestination: async () => null, copyText: async () => {} },
  });
  const lifecycle = recoveryLifecycle(recovery);
  const unused = vi.fn();
  changing.mockImplementation((owner) => lifecycle.invalidateRecovery(owner));
  const offer = lifecycle.participant.freeze(owner, "shutdown", 10000);
  const drain = () => lifecycle.participant.drain(offer, unused);
  expect((await drain()).state).toBe("saved");
  const item = await recovery.retain(owner, report);
  recovery.subscribe(listener);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = Array.from({ length: scope === "source" ? 64 : 1024 }, (_, i) =>
    recovery.persistCheckpoint(
      { ...owner, generation: 2, sourceKey: scope === "source" ? owner.sourceKey : String(i >> 6) },
      () => true,
      () => gate,
    ),
  );
  try {
    await expect(recovery[operation](item.recovery!, action)).rejects.toThrow();
    expect(changing).toHaveBeenCalledWith(owner);
    expect(listener).toHaveBeenCalled();
    expect(recovery.blocked(owner)).toBe(true);
  } finally {
    release();
    await Promise.all(pending);
  }
  expect(recovery.blocked(owner)).toBe(true);
  expect((await drain()).blocker).toBe(true);
  await recovery.discard(item.recovery!, action);
  expect(recovery.blocked(owner)).toBe(false);
  expect((await drain()).state).toBe("saved");
});

it.each(["report", "source", "host"] as const)(
  "charges the final retryable projection against the last %s bytes",
  async (bound) => {
    const backend = recoveryBackendDouble();
    const remaining = bound === "report" ? 8192 : 2048;
    function padded(input: DrainReport, bytes: number, actionBytes = 0): DrainReport {
      const full = {
        ...input,
        errors: Array.from({ length: 16 }, () => ({
          code: "PLUGIN_E_STORAGE_IO" as const,
          message: "x",
        })),
      };
      let left = bytes - actionBytes - Buffer.byteLength(JSON.stringify(full));
      for (const error of full.errors) {
        const n = Math.min(left, 511);
        error.message += "x".repeat(n);
        left -= n;
      }
      expect(left).toBe(0);
      return full;
    }
    if (bound !== "report") {
      const count = (bound === "host" ? 67108864 : 4194304) / 8192;
      const template = {
        state: "uncertain" as const,
        blocker: true,
        pendingSettings: false,
        records: [],
        errors: [],
        recovery: "00000000-0000-4000-8000-000000000000",
      };
      const full = padded(template, 8192),
        last = padded(template, 8192 - remaining);
      backend.evidence.recoveryPage = async (cursor) => {
        const first = Number(cursor ?? 0),
          end = Math.min(count, first + 16);
        return {
          items: Array.from({ length: end - first }, (_, i) => {
            const index = first + i,
              id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
            return {
              id,
              owner:
                bound === "host"
                  ? { ...owner, sourceKey: `source-${Math.floor(index / 512)}` }
                  : owner,
              report: { ...(index === count - 1 ? last : full), recovery: id },
              ticket: null,
              sealedPin: null,
              expiresAt: null,
            };
          }),
          nextCursor: end < count ? String(end) : null,
        };
      };
    }
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
    await recovery.restore();
    const input = { ...report, recovery: "10000000-0000-4000-8000-000000000001" };
    const actionBytes =
      Buffer.byteLength(JSON.stringify({ ...input, retryAction: input.recovery })) -
      Buffer.byteLength(JSON.stringify(input));
    for (const size of [remaining - 1, remaining, remaining + 1]) {
      const result = recovery.retain(owner, padded(input, size, actionBytes));
      if (size > remaining) {
        await expect(result).rejects.toThrow();
        expect(recovery.blocked(owner)).toBe(true);
      } else expect(Buffer.byteLength(JSON.stringify(await result))).toBe(size);
    }
  },
);

function recoveryLifecycle(recovery: ReturnType<typeof createPersistenceRecovery>) {
  const unused = () => {
    throw Error("unexpected namespace operation");
  };
  const backend = recoveryBackendDouble();
  return createPersistenceLifecycle({
    now: () => 0,
    wall: () => 0,
    live: () => true,
    reservations: { validate: unused, onEnded: unused },
    record: unused,
    persist: unused,
    fence: () => [],
    fenceTarget: () => [],
    pendingWrites: () => [],
    pendingPublication: () => false,
    pendingSettings: () => false,
    settle: async () => {},
    evidence: {
      ...backend.evidence,
      capture: (scope, deadlineMonotonicMs) => ({
        id: "cut",
        through: 0,
        scope,
        deadlineMonotonicMs,
      }),
      tickets: () => [],
      flush: async () => ({
        completedMonotonicMs: 0,
        state: "saved",
        accepted: [],
        unknown: [],
        incomplete: [],
      }),
    },
    reads: backend.reads,
    payload: unused,
    recover: async (_owner, result) => result,
    checkpointOpen: () => false,
    recovery,
  });
}

it.each([
  ["retry", "expiry before claim"],
  ["retry", "expiry in claim"],
  ["retry", "queued expiry"],
  ["retry", "stale state"],
  ["retry", "stale at admission"],
  ["retry", "removed before dequeue"],
  ["discard", "removed before dequeue"],
  ["retry", "unidentified"],
  ["discard", "unauthorized"],
  ["retry", "blocked result"],
  ["discard", "blocked result"],
  ["discard", "restart required"],
  ["discard", "export active"],
  ["retry", "size refusal"],
  ["discard", "size refusal"],
  ["retry", "load rejection"],
  ["discard", "load rejection"],
  ["retry", "save rejection"],
  ["retry", "dispatch rejection"],
  ["discard", "remove rejection"],
  ["discard", "dispatch rejection"],
  ["discard", "blocked save rejection"],
  ["retry", "queue refusal"],
  ["discard", "queue refusal"],
] as const)("claimed %s failure at %s invalidates the clean drain", async (operation, edge) => {
  const backend = recoveryBackendDouble();
  let now = 0;
  const complete = vi.fn();
  const claim = vi.fn(() => {
    if (edge === "expiry in claim") now = 30000;
    return edge !== "unauthorized";
  });
  const changing = vi.fn(),
    listener = vi.fn();
  const resolved = { ...report, state: "saved" as const, blocker: false };
  let dispatchFails = true;
  const dispatch = async () => {
    if (!dispatchFails) return resolved;
    if (edge === "dispatch rejection") throw Error(edge);
    if (edge === "size refusal")
      return {
        ...report,
        errors: [{ code: "PLUGIN_E_STORAGE_IO", message: "x".repeat(8192) }],
      } as DrainReport;
    return edge === "blocked save rejection" || edge === "blocked result" ? report : resolved;
  };
  const recovery = createPersistenceRecovery({
    backend,
    coreOwner: () => owner,
    now: () => now,
    wall: () => 100000 + now,
    changing,
    actions: { claim, isClaimed: () => true, complete },
    retry: dispatch,
    discard: dispatch,
    adapter: { chooseDestination: async () => null, copyText: async () => {} },
  });
  const lifecycle = recoveryLifecycle(recovery);
  changing.mockImplementation((owner) => lifecycle.invalidateRecovery(owner));
  const offer = lifecycle.participant.freeze(owner, "shutdown", 10000);
  const drain = () => lifecycle.participant.drain(offer, vi.fn());
  const item = await recovery.retain(owner, report);
  const id = item.recovery!;
  expect((await drain()).blocker).toBe(false);
  now = 29999;
  expect(recovery.snapshot().items[0]?.actions.map((a) => a.kind)).toContain("retry");
  recovery.subscribe(listener);
  changing.mockClear();
  if (edge === "expiry before claim") now = 30000;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queue = Array.from({ length: edge === "queue refusal" ? 64 : 0 }, () =>
    recovery.persistCheckpoint(
      owner,
      () => true,
      () => gate,
    ),
  );
  if (edge === "stale state")
    queue.push(recovery.retain(owner, { ...resolved, recovery: id }).then(() => {}));
  if (edge.includes("save rejection"))
    vi.spyOn(backend.evidence, "saveRecovery").mockRejectedValueOnce(Error(edge));
  if (edge === "remove rejection")
    vi.spyOn(backend.evidence, "removeRecovery").mockRejectedValueOnce(Error(edge));
  if (edge === "stale at admission") await recovery.retain(owner, { ...resolved, recovery: id });
  if (edge === "removed before dequeue") queue.push(recovery.discard(id, action).then(() => {}));
  if (edge === "load rejection")
    vi.spyOn(backend.evidence, "loadRecovery").mockRejectedValueOnce(Error(edge));
  let exporting: Promise<unknown> | undefined;
  if (edge === "export active") {
    vi.spyOn(backend.evidence, "loadRecovery").mockImplementationOnce(async () => {
      await gate;
      return null;
    });
    exporting = recovery.export({ recovery: id, action });
  }
  const target =
    edge === "restart required" ? recovery.retainRestartBlocker(owner, "restart").recovery! : id;
  listener.mockClear();
  const acting = recovery[operation](edge === "unidentified" ? "missing" : target, action);
  if (edge === "queued expiry") now = 30000;
  try {
    if (edge === "removed before dequeue" || edge === "unauthorized" || edge === "unidentified") {
      await expect(acting).rejects.toThrow();
      expect(complete).toHaveBeenCalledTimes(edge === "removed before dequeue" ? 2 : 0);
      expect(claim).toHaveBeenCalledTimes(
        edge === "removed before dequeue" ? 2 : edge === "unidentified" ? 0 : 1,
      );
      if (edge !== "removed before dequeue") {
        expect(changing).not.toHaveBeenCalled();
        expect(listener).not.toHaveBeenCalled();
      }
      expect(recovery.blocked(owner)).toBe(false);
      expect((await drain()).blocker).toBe(false);
      return;
    }
    if (edge === "blocked result" || edge === "export active" || edge === "restart required")
      await expect(acting).resolves.toMatchObject({ blocker: true, recovery: target });
    else await expect(acting).rejects.toThrow();
    expect(claim).toHaveBeenCalledTimes(edge === "export active" ? 2 : 1);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalled();
    expect(changing).toHaveBeenCalledWith(owner);
    expect(recovery.blocked(owner)).toBe(true);
    expect(recovery.blocked(owner, new Set(["other"]))).toBe(edge === "restart required");
    expect((await drain()).blocker).toBe(true);
    if (now >= 30000)
      expect(recovery.snapshot().items[0]?.actions.map((a) => a.kind)).not.toContain("retry");
  } finally {
    release();
    await Promise.all(queue);
    await exporting;
  }
  if (edge === "restart required") return; // Cleared by verified startup recovery.
  // The next authorized removal is durable.
  dispatchFails = false;
  await recovery.discard(id, action);
  expect(await backend.evidence.loadRecovery(id)).toBeNull();
  expect(recovery.blocked(owner)).toBe(false);
  expect((await drain()).blocker).toBe(false);
});
