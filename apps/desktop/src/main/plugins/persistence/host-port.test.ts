import type { RecordMeta } from "@kobrixa/plugin-protocol";
import { createHash, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createPersistenceHost } from "./host-port.js";
import type { PersistenceBackend, PublicationTicket, StoredRecovery } from "./engine-port.js";
import type { CommonEventLedgerPort } from "@kobrixa/plugin-runtime";
const owner = {
  sourceKey: "builtin:test.host",
  pluginId: "test.host",
  generation: 1,
  hostEpoch: "00000000-0000-4000-8000-000000000001",
  processEpoch: "00000000-0000-4000-8000-000000000002",
};
const principal = { kind: "plugin" as const, owner, authorityContext: null };
function fixture() {
  const fail = () => {
    throw new Error("Unexpected I/O");
  };
  const tickets: PublicationTicket[] = [];
  const off = vi.fn();
  const events: CommonEventLedgerPort = {
    diagnostics: fail,
    create: fail,
    owns: fail,
    publish: fail,
    activate: fail,
    resync: fail,
    snapshot: fail,
    ack: fail,
    unsubscribe: fail,
    closeAfterControl: fail,
    onRemoved: vi.fn(() => off),
  };
  const backend: PersistenceBackend = {
    engine: {
      reserve: vi.fn(async (t) => {
        tickets.push(t);
      }),
      append: async (_t, _o, b) => b.length,
      seal: async () => {},
      publish: fail,
      reconcile: async () => ({ disposition: "not-committed" }),
      abort: async () => "aborted",
      fence: () => [],
      fenceTarget: () => [],
    },
    reads: {
      settings: fail,
      stat: fail,
      list: fail,
      open: fail,
      read: fail,
      close: vi.fn(async () => {}),
    },
    evidence: {
      capture: (scope, deadlineMonotonicMs) => ({
        id: randomUUID(),
        scope,
        through: tickets.length,
        deadlineMonotonicMs,
      }),
      tickets: (b) => tickets.slice(0, b.through),
      flush: async () => ({ state: "saved", accepted: [], incomplete: [], unknown: [] }),
      quota: fail,
      settingsDigest: fail,
      auxiliary: async () => null,
      auxiliaryKeys: async () => ({ keys: [], nextCursor: null }),
      recoveryPage: async () => ({ items: [], nextCursor: null }),
      loadRecovery: async () => null,
      saveRecovery: async () => {},
      removeRecovery: async () => {},
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
    output: {
      begin: fail,
      append: fail,
      commit: fail,
      reconcile: fail,
      abort: async () => "aborted",
    },
    destinations: { register: fail, release: async () => {} },
    sources: {
      resolvePreferences: fail,
      register: fail,
      map: fail,
      appendMapped: fail,
      releaseMapped: fail,
      inventory: fail,
      read: fail,
    },
    dispose: vi.fn(async () => {}),
  };
  const input: Parameters<typeof createPersistenceHost>[0] = {
    profile: { hostEpoch: owner.hostEpoch, assertHeld: vi.fn() },
    composition: {
      backend,
      events,
      sources: { current: () => true, settings: vi.fn(async () => null), coreOwner: () => owner },
      dispatchDrain: async () => ({ ok: true, value: { status: "checkpoint-only", writes: [] } }),
      imports: {
        run: fail,
        acceptPreferences: fail,
        issuePreferences: fail,
        retirePreferences: fail,
        acceptPreferencesEvidence: fail,
      },
    },
    reservations: { validate: () => null, onEnded: fail },
    actions: { claim: fail },
    actionAdapter: { chooseDestination: async () => null, copyText: async () => {} },
    coreActions: { claim: () => false, isClaimed: () => false, complete: () => {} },
    now: () => 0,
    hasPermission: () => true,
  };
  return { input, backend, off };
}
it.each(["backend", "sources", "events", "dispatchDrain", "imports"])(
  "rejects missing composition %s before exposure",
  async (key) => {
    const f = fixture();
    Reflect.deleteProperty(f.input.composition, key);
    await expect(createPersistenceHost(f.input)).rejects.toThrow(
      "Incomplete persistence composition",
    );
    expect(f.backend.dispose).toHaveBeenCalledTimes(key === "backend" ? 0 : 1);
  },
);
it("closes initialized services on recovery restoration failure", async () => {
  const f = fixture();
  f.backend.evidence.recoveryPage = async () => {
    throw new Error("corrupt");
  };
  await expect(createPersistenceHost(f.input)).rejects.toThrow("corrupt");
  expect(f.off).toHaveBeenCalledOnce();
  expect(f.backend.dispose).toHaveBeenCalledOnce();
});
it("permission precedes source reads, reservation and strict validation", async () => {
  const f = fixture();
  f.input.hasPermission = () => false;
  const host = await createPersistenceHost(f.input);
  expect(
    await host.request(principal, "storage/beginWrite", {} as never, new AbortController().signal),
  ).toMatchObject({ error: { code: "PLUGIN_E_PERMISSION_DENIED" } });
  expect(f.input.composition.sources.settings).not.toHaveBeenCalled();
  expect(f.backend.engine.reserve).not.toHaveBeenCalled();
  f.input.hasPermission = () => true;
  await expect(
    host.request(principal, "storage/beginWrite", {} as never, new AbortController().signal),
  ).rejects.toThrow();
  await host.dispose();
});
it("charges queued serialized chunks before decoding", async () => {
  const f = fixture(),
    releases: Array<() => void> = [];
  f.backend.engine.append = async (_t, _o, b) => {
    await new Promise<void>((resolve) => releases.push(resolve));
    return b.length;
  };
  const host = await createPersistenceHost(f.input),
    bytes = Buffer.alloc(262144),
    signal = new AbortController().signal;
  const params = {
    target: { mode: "create" as const },
    kind: "test.record",
    schemaVersion: 1,
    label: "data",
    mediaType: "application/octet-stream" as const,
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const a = await host.request(principal, "storage/beginWrite", params, signal),
    b = await host.request(principal, "storage/beginWrite", params, signal);
  if (!a.ok || !b.ok) throw new Error("admission failed");
  const chunk = { write: a.value.write, offset: 0, data: bytes.toString("base64") };
  const one = host.request(principal, "storage/writeChunk", chunk, signal);
  const two = host.request(
    principal,
    "storage/writeChunk",
    { ...chunk, write: b.value.write },
    signal,
  );
  expect(await host.request(principal, "storage/writeChunk", chunk, signal)).toMatchObject({
    error: { code: "PLUGIN_E_RESOURCE_LIMIT" },
  });
  await vi.waitFor(() => expect(releases).toHaveLength(2));
  releases.forEach((release) => release());
  expect((await one).ok).toBe(true);
  expect((await two).ok).toBe(true);
  await host.dispose();
});
it("repeated disposal waits for the same backend shutdown while lock is held", async () => {
  const f = fixture();
  let release!: () => void;
  f.backend.dispose = vi.fn(async () => {
    f.input.profile.assertHeld();
    await new Promise<void>((r) => (release = r));
  });
  const host = await createPersistenceHost(f.input),
    a = host.dispose(),
    b = host.dispose();
  expect(a).toBe(b);
  await vi.waitFor(() => expect(f.backend.dispose).toHaveBeenCalledOnce());
  let done = false;
  void b.then(() => (done = true));
  await Promise.resolve();
  expect(done).toBe(false);
  release();
  await a;
  expect(f.off).toHaveBeenCalledOnce();
});
it("final drain uses the private grant admission and persists terminal checkpoint metadata", async () => {
  const f = fixture(),
    id = randomUUID(),
    revision = `r_${"1".repeat(32)}`;
  let record: RecordMeta = {
    id,
    revision,
    kind: "test.record",
    schemaVersion: 1,
    label: "data",
    mediaType: "text/plain" as const,
    byteLength: 0,
    sha256: createHash("sha256").update("").digest("hex"),
    createdAt: 0,
    updatedAt: 0,
    checkpoint: "none" as "none" | "open" | "final",
    interrupted: false,
  };
  f.backend.reads.stat = async () => record;
  f.backend.engine.publish = async (ticket) => {
    if (ticket.metadata.kind === "record") record = ticket.metadata.record;
    return {
      disposition: "committed",
      receipt: { revision: record.revision, commitId: ticket.id, durability: "file-sync-only" },
    };
  };
  f.backend.engine.reconcile = f.backend.engine.publish;
  f.backend.engine.reserveFinal = vi.fn(async (t, n) => f.backend.engine.reserve(t, n));
  f.backend.evidence.saveCheckpoint = vi.fn(async () => {});
  f.backend.evidence.retainSealed = async () => ({ pin: randomUUID(), expiresMonotonicMs: 30000 });
  const host = await createPersistenceHost(f.input),
    signal = new AbortController().signal;
  const registered = await host.request(
    principal,
    "storage/registerCheckpoint",
    { id, expectedRevision: revision },
    signal,
  );
  if (!registered.ok) throw new Error("register failed");
  const offer = host.participant.freeze(owner, "shutdown", 10000);
  const report = await host.participant.drain(offer, async (_owner, request) => {
    const begun = await host.request(
      principal,
      "storage/beginWrite",
      {
        target: { mode: "replace", id, expectedRevision: revision },
        kind: record.kind,
        schemaVersion: 1,
        label: "data",
        mediaType: "text/plain",
        byteLength: 0,
        sha256: record.sha256,
        checkpoint: { handle: registered.value.checkpoint, phase: "final" },
        drainToken: request.token,
      },
      signal,
    );
    if (!begun.ok) throw new Error("final admission failed");
    expect(
      (await host.request(principal, "storage/sealWrite", { write: begun.value.write }, signal)).ok,
    ).toBe(true);
    expect(
      (
        await host.request(
          principal,
          "storage/commitWrite",
          { write: begun.value.write, drainToken: request.token },
          signal,
        )
      ).ok,
    ).toBe(true);
    return { ok: true, value: { status: "submitted", writes: [begun.value.write] } };
  });
  expect(report.state).toBe("saved");
  expect(f.backend.engine.reserveFinal).toHaveBeenCalledOnce();
  await host.dispose();
  expect(f.backend.evidence.saveCheckpoint).toHaveBeenCalledWith(
    owner,
    expect.objectContaining({ state: "final" }),
  );
});
it("normalizes cumulative worker append offsets for multi-chunk record writes", async () => {
  const f = fixture();
  f.backend.engine.append = async (_t, offset, b) => offset + b.length;
  const host = await createPersistenceHost(f.input),
    signal = new AbortController().signal;
  const begun = await host.request(
    principal,
    "storage/beginWrite",
    {
      target: { mode: "create" },
      kind: "test",
      schemaVersion: 1,
      label: "data",
      mediaType: "text/plain",
      byteLength: 2,
      sha256: createHash("sha256")
        .update(Buffer.from([1, 2]))
        .digest("hex"),
    },
    signal,
  );
  if (!begun.ok) throw new Error("begin failed");
  expect(
    (
      await host.request(
        principal,
        "storage/writeChunk",
        { write: begun.value.write, offset: 0, data: "AQ==" },
        signal,
      )
    ).ok,
  ).toBe(true);
  expect(
    (
      await host.request(
        principal,
        "storage/writeChunk",
        { write: begun.value.write, offset: 1, data: "Ag==" },
        signal,
      )
    ).ok,
  ).toBe(true);
  await host.dispose();
});
it("disposal joins an already-running original-peer drain before stopping the backend", async () => {
  const f = fixture();
  let release!: () => void;
  const waiting = new Promise<void>((r) => (release = r));
  const id = randomUUID(),
    record = {
      id,
      revision: `r_${"1".repeat(32)}`,
      kind: "test",
      schemaVersion: 1,
      label: "",
      mediaType: "text/plain" as const,
      byteLength: 0,
      sha256: "a".repeat(64),
      createdAt: 0,
      updatedAt: 0,
      checkpoint: "none" as const,
      interrupted: false,
    };
  f.backend.reads.stat = async () => record;
  f.backend.engine.publish = async (t) => ({
    disposition: "committed",
    receipt: { revision: record.revision, commitId: t.id, durability: "file-sync-only" },
  });
  const host = await createPersistenceHost(f.input);
  await host.request(
    principal,
    "storage/registerCheckpoint",
    { id, expectedRevision: record.revision },
    new AbortController().signal,
  );
  const offer = host.participant.freeze(owner, "shutdown", 10000);
  const dispatch = vi.fn(async () => {
    await waiting;
    return { ok: true as const, value: { status: "checkpoint-only" as const, writes: [] } };
  });
  const drain = host.participant.drain(offer, dispatch);
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
  const closing = host.dispose();
  await new Promise((r) => setTimeout(r, 10));
  expect(f.backend.dispose).not.toHaveBeenCalled();
  release();
  await drain;
  await closing;
  expect(f.backend.dispose).toHaveBeenCalledOnce();
});
it("retains the original publishing ticket on owner loss even without checkpoint registration", async () => {
  const f = fixture();
  f.backend.engine.publish = async () => ({ disposition: "unknown" });
  f.backend.engine.reconcile = async () => ({ disposition: "unknown" });
  f.backend.evidence.flush = async (b) => ({
    state: "unknown",
    accepted: f.backend.evidence.tickets(b).map((t) => t.id),
    incomplete: [],
    unknown: f.backend.evidence.tickets(b).map((t) => t.id),
  });
  f.backend.evidence.saveRecovery = vi.fn(async () => {});
  const host = await createPersistenceHost(f.input),
    signal = new AbortController().signal;
  const begun = await host.request(
    principal,
    "storage/beginWrite",
    {
      target: { mode: "create" },
      kind: "test",
      schemaVersion: 1,
      label: "",
      mediaType: "text/plain",
      byteLength: 0,
      sha256: "a".repeat(64),
    },
    signal,
  );
  if (!begun.ok) throw new Error("begin failed");
  await host.request(principal, "storage/sealWrite", { write: begun.value.write }, signal);
  await host.request(principal, "storage/commitWrite", { write: begun.value.write }, signal);
  await host.participant.ownerLost(owner);
  expect(f.backend.evidence.saveRecovery).toHaveBeenCalledWith(
    expect.objectContaining({ ticket: expect.objectContaining({ id: begun.value.write }) }),
  );
  await host.dispose();
});

function checkpointFixture() {
  const f = fixture();
  let record: RecordMeta = {
    id: randomUUID(),
    revision: `r_${"1".repeat(32)}`,
    kind: "test.record",
    schemaVersion: 1,
    label: "data",
    mediaType: "text/plain",
    byteLength: 0,
    sha256: createHash("sha256").update("").digest("hex"),
    createdAt: 0,
    updatedAt: 0,
    checkpoint: "none",
    interrupted: false,
  };
  const rows = new Map<string, StoredRecovery>();
  f.backend.reads.stat = async (_o, id) => ({ ...record, id });
  f.backend.engine.publish = async (t) => {
    if (t.metadata.kind === "record") record = t.metadata.record;
    return {
      disposition: "committed",
      receipt: { revision: record.revision, commitId: t.id, durability: "file-sync-only" },
    };
  };
  f.backend.engine.reconcile = f.backend.engine.publish;
  f.backend.engine.reserveFinal = async (t, n) => f.backend.engine.reserve(t, n);
  f.backend.evidence.saveCheckpoint = async () => {};
  f.backend.evidence.retainSealed = async () => ({ pin: randomUUID(), expiresMonotonicMs: 30000 });
  f.backend.evidence.recoveryPage = async () => ({ items: [...rows.values()], nextCursor: null });
  f.backend.evidence.loadRecovery = async (id) => rows.get(id) ?? null;
  f.backend.evidence.saveRecovery = async (row) => {
    rows.set(row.id, structuredClone(row));
  };
  f.backend.evidence.removeRecovery = async (id) => {
    rows.delete(id);
  };
  f.input.coreActions = { claim: () => true, isClaimed: () => true, complete() {} };
  return { ...f, rows, record: () => record };
}

it.each([false, true])(
  "T5fix shutdown permits the original final continuation (already draining=%s)",
  async (already) => {
    const f = checkpointFixture(),
      signal = new AbortController().signal;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const paused = new Promise<void>((r) => {
      release = r;
    });
    const results: boolean[] = [];
    f.input.composition.dispatchDrain = async (_owner, request) => {
      entered();
      if (already) await paused;
      const record = f.record();
      const ordinary = await host.request(
        principal,
        "storage/beginWrite",
        {
          target: { mode: "create" },
          kind: record.kind,
          schemaVersion: 1,
          label: "",
          mediaType: "text/plain",
          byteLength: 0,
          sha256: record.sha256,
        },
        signal,
      );
      expect(ordinary.ok).toBe(false);
      const begin = await host.request(
        principal,
        "storage/beginWrite",
        {
          target: { mode: "replace", id: record.id, expectedRevision: record.revision },
          kind: record.kind,
          schemaVersion: 1,
          label: "",
          mediaType: "text/plain",
          byteLength: 0,
          sha256: record.sha256,
          checkpoint: { handle: request.checkpoints[0]!.checkpoint, phase: "final" },
          drainToken: request.token,
        },
        signal,
      );
      results.push(begin.ok);
      if (begin.ok) {
        results.push(
          (await host.request(principal, "storage/sealWrite", { write: begin.value.write }, signal))
            .ok,
        );
        results.push(
          (
            await host.request(
              principal,
              "storage/commitWrite",
              { write: begin.value.write, drainToken: request.token },
              signal,
            )
          ).ok,
        );
      }
      return { ok: true, value: { status: "submitted", writes: [] } };
    };
    const host = await createPersistenceHost(f.input);
    expect(
      (
        await host.request(
          principal,
          "storage/registerCheckpoint",
          {
            id: f.record().id,
            expectedRevision: f.record().revision,
          },
          signal,
        )
      ).ok,
    ).toBe(true);
    let draining: Promise<unknown> | undefined;
    if (already) {
      draining = host.participant.drain(
        host.participant.freeze(owner, "shutdown", 10000),
        f.input.composition.dispatchDrain,
      );
      await started;
    }
    const closing = host.dispose();
    release?.();
    await closing;
    await draining;
    expect(results).toEqual([true, true, true]);
    expect(f.record().checkpoint).toBe("final");
  },
);

it.each(["open", "final", "none"] as const)(
  "T5fix retry distinguishes committed %s checkpoints",
  async (checkpoint) => {
    const f = checkpointFixture(),
      record = { ...f.record(), checkpoint },
      id = randomUUID();
    const ticket: PublicationTicket = {
      id: randomUUID(),
      owner,
      deadlineMonotonicMs: 10000,
      metadata: { kind: "record", record, deleted: false },
      target: { kind: "record", id: record.id, expectedRevision: null },
    };
    f.rows.set(id, {
      id,
      owner,
      ticket,
      sealedPin: randomUUID(),
      expiresAt: Date.now() + 30000,
      report: {
        recovery: id,
        state: "retryable",
        blocker: true,
        pendingSettings: false,
        records: [
          {
            id: record.id,
            committedRevision: null,
            final: false,
            payload: "complete-staging",
            expiresAt: Date.now() + 30000,
          },
        ],
        errors: [],
      },
    });
    const host = await createPersistenceHost(f.input);
    const result = await host.participant.retry(id, {
      actionToken: randomUUID(),
      scope: { hostEpoch: owner.hostEpoch, workbenchInstance: randomUUID() },
    });
    expect(result.state).toBe(checkpoint === "open" ? "checkpoint-only" : "saved");
    expect(result.blocker).toBe(checkpoint === "open");
    expect(result.records[0]?.final).toBe(checkpoint === "final");
    await host.dispose();
  },
);

it("T5fix known discard frees checkpoint slots without reviving old generations", async () => {
  const f = checkpointFixture(),
    host = await createPersistenceHost(f.input),
    signal = new AbortController().signal;
  const oldOwners = [];
  for (let generation = 1; generation <= 2; generation++) {
    const old = { ...owner, generation, processEpoch: randomUUID() };
    oldOwners.push(old);
    expect(
      (
        await host.request(
          { ...principal, owner: old },
          "storage/registerCheckpoint",
          {
            id: randomUUID(),
            expectedRevision: f.record().revision,
          },
          signal,
        )
      ).ok,
    ).toBe(true);
    const report = await host.participant.ownerLost(old);
    expect(
      (
        await host.participant.discard(report.recovery!, {
          actionToken: randomUUID(),
          scope: { hostEpoch: owner.hostEpoch, workbenchInstance: randomUUID() },
        })
      ).blocker,
    ).toBe(false);
  }
  expect(f.rows.size).toBe(0);
  for (const old of oldOwners)
    expect(
      (
        await host.request(
          { ...principal, owner: old },
          "storage/registerCheckpoint",
          { id: randomUUID(), expectedRevision: f.record().revision },
          signal,
        )
      ).ok,
    ).toBe(false);
  expect(
    (
      await host.request(
        { ...principal, owner: { ...owner, generation: 3, processEpoch: randomUUID() } },
        "storage/registerCheckpoint",
        {
          id: randomUUID(),
          expectedRevision: f.record().revision,
        },
        signal,
      )
    ).ok,
  ).toBe(true);
  await host.dispose();
});

it("T5fix owner identity capacity fails closed instead of TTL-evicting revocation", async () => {
  const f = checkpointFixture();
  let now = 0;
  f.input.now = () => now;
  const host = await createPersistenceHost(f.input),
    signal = new AbortController().signal;
  for (let generation = 1; generation <= 64; generation++) {
    const current = { ...owner, generation, processEpoch: randomUUID() };
    expect(
      (
        await host.request(
          { ...principal, owner: current },
          "storage/stat",
          { id: f.record().id },
          signal,
        )
      ).ok,
    ).toBe(true);
    await host.participant.ownerLost(current);
  }
  now = 120001;
  expect(
    await host.request(
      { ...principal, owner: { ...owner, generation: 65 } },
      "storage/stat",
      { id: f.record().id },
      signal,
    ),
  ).toMatchObject({ error: { code: "PLUGIN_E_RESOURCE_LIMIT" } });
  await host.dispose();
});
