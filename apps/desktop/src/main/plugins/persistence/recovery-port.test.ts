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
