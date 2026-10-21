import { describe, expect, it, vi } from "vitest";
import { assertInventory, classifySourceError, snapshotBytes } from "./import-sources.js";

const scope = {
  hostEpoch: "11111111-1111-4111-8111-111111111111",
  workbenchInstance: "22222222-2222-4222-8222-222222222222",
};
const nonce = "33333333-3333-4333-8333-333333333333";
const snapshot = () => ({ nonce, scope, entries: [{ key: "test.preference", raw: null }] });

describe("legacy source evidence", () => {
  it("distinguishes verified absence from permission and IO failures", () => {
    expect(classifySourceError({ code: "ENOENT" })).toBe("absent");
    for (const code of ["EACCES", "EPERM", "EIO", "EROFS", "ENOTDIR"])
      expect(classifySourceError({ code })).toBe("blocked");
    expect(classifySourceError(new Error("missing"))).toBe("blocked");
  });
  it("bounds names before filtering and rejects unsafe file evidence", () => {
    const entry = {
      name: "11111111-1111-4111-8111-111111111111.json",
      regular: true,
      contained: true,
      links: 1,
      bytes: 8 * 1024 * 1024,
    };
    expect(() => assertInventory(4096, [entry])).not.toThrow();
    expect(() => assertInventory(4097, [entry])).toThrow("inventory-limit");
    for (const patch of [
      { regular: false },
      { contained: false },
      { links: 2 },
      { bytes: 8 * 1024 * 1024 + 1 },
      { name: "../escape.json" },
    ])
      expect(() => assertInventory(1, [{ ...entry, ...patch }])).toThrow();
  });
  it("validates exact raw snapshot bytes without normalizing absent keys", () => {
    expect(
      JSON.parse(new TextDecoder().decode(snapshotBytes(snapshot(), ["test.preference"]))),
    ).toEqual(snapshot());
    for (const entries of [
      [],
      [{ key: "foreign", raw: null }],
      [snapshot().entries[0]!, snapshot().entries[0]!],
      [{ key: "test.preference", raw: "x".repeat(65536) }],
    ]) {
      expect(() => snapshotBytes({ ...snapshot(), entries }, ["test.preference"])).toThrow();
    }
    expect(() =>
      snapshotBytes(
        {
          ...snapshot(),
          entries: Array.from({ length: 129 }, (_, i) => ({ key: `k${i}`, raw: null })),
        },
        Array.from({ length: 129 }, (_, i) => `k${i}`),
      ),
    ).toThrow("snapshot-limit");
  });
});

import { createHash } from "node:crypto";
import {
  snapshotDigest,
  importIdFor,
  barrierKeyFor,
  parseNonceDocument,
  parseBarrierDocument,
  type LegacyPreferencesSnapshot,
} from "./import-sources.js";
const expectInvalidSnapshot = (value: unknown) =>
  expect(() => snapshotBytes(value as LegacyPreferencesSnapshot, ["test.preference"])).toThrow();
it.each([
  null,
  [],
  42,
  "x",
  {},
  { nonce, scope: null, entries: [] },
  { nonce, scope, entries: null },
  { nonce, scope, entries: [null] },
  { ...snapshot(), extra: true },
  { ...snapshot(), nonce: "not-a-handle" },
  { ...snapshot(), scope: { ...scope, extra: true } },
  { ...snapshot(), entries: [{ key: "test.preference", raw: 1 }] },
  { ...snapshot(), entries: [{ key: "test.preference", raw: null, extra: true }] },
])("rejects malformed raw evidence %#", expectInvalidSnapshot);
it("hashes exact ordered UTF-8 entries including null and whitespace", () => {
  const raw = { nonce, scope, entries: [{ key: "test.preference", raw: "  中文\n\t  " }] };
  const bytes = snapshotBytes(raw, ["test.preference"]);
  expect(Buffer.from(bytes).toString("utf8")).toBe(JSON.stringify(raw));
  expect(snapshotDigest(raw, ["test.preference"])).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
  expect(snapshotDigest(raw, ["test.preference"])).not.toBe(
    snapshotDigest(snapshot(), ["test.preference"]),
  );
  expect(() => snapshotBytes(raw, ["test.preference", "test.preference"])).toThrow();
  raw.entries[0]!.raw = "changed";
  expect(Buffer.from(bytes).toString()).toContain("中文");
});
it("accepts exact key and byte bounds then rejects one over", () => {
  const keys = Array.from({ length: 128 }, (_, i) => `k${i}`),
    raw = { nonce, scope, entries: keys.map((key) => ({ key, raw: null })) };
  expect(snapshotBytes(raw, keys).length).toBeGreaterThan(0);
  expect(() =>
    snapshotBytes({ ...raw, entries: [...raw.entries, { key: "extra", raw: null }] }, [
      ...keys,
      "extra",
    ]),
  ).toThrow();
  const sized = { nonce, scope, entries: [{ key: "test.preference", raw: "" }] };
  const overhead = snapshotBytes(sized, ["test.preference"]).length;
  sized.entries[0]!.raw = "x".repeat(65536 - overhead);
  expect(snapshotBytes(sized, ["test.preference"])).toHaveLength(65536);
  sized.entries[0]!.raw += "x";
  expect(() => snapshotBytes(sized, ["test.preference"])).toThrow();
  expect(barrierKeyFor("a".repeat(128))).toHaveLength(72);
  expect(importIdFor("test.synthetic-import", "builtin:test.synthetic")).toHaveLength(71);
});
it("parses only bound nonce and barrier documents", () => {
  const sourceKey = "builtin:test.preferences",
    descriptorId = "test.synthetic-preferences";
  const ticket = {
    id: nonce,
    owner: {
      sourceKey,
      pluginId: "test.preferences",
      generation: 1,
      hostEpoch: scope.hostEpoch,
      processEpoch: scope.hostEpoch,
    },
    deadlineMonotonicMs: 10000,
    metadata: { kind: "import", key: "nonce/" + nonce },
    target: { kind: "import", key: "nonce/" + nonce },
  };
  const raw = snapshot(),
    digest = snapshotDigest(raw, ["test.preference"]);
  const document = {
    formatVersion: 1,
    kind: "nonce",
    sourceKey,
    descriptorId,
    nonce,
    scope,
    allowlist: ["test.preference"],
    state: "consumed",
    raw,
    digest,
    originalTicket: ticket,
    ticket,
  };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
  expect(parseNonceDocument(encode(document)).raw).toEqual(raw);
  for (const patch of [
    { formatVersion: 2 },
    { extra: true },
    { digest: "0".repeat(64) },
    { raw: null },
    { allowlist: ["foreign"] },
    { nonce: scope.hostEpoch },
    { sourceKey: "builtin:foreign" },
    { raw: { ...raw, scope: { ...scope, workbenchInstance: nonce } } },
  ])
    expect(() => parseNonceDocument(encode({ ...document, ...patch }))).toThrow();
  const key = barrierKeyFor(descriptorId),
    barrierTicket = {
      ...ticket,
      metadata: { kind: "import", key },
      target: { kind: "import", key },
    };
  const barrier = {
    formatVersion: 1,
    kind: "barrier",
    sourceKey,
    descriptorId,
    barrier: nonce,
    state: "active",
    originalTicket: barrierTicket,
    ticket: barrierTicket,
  };
  expect(parseBarrierDocument(encode(barrier)).barrier).toBe(nonce);
  for (const patch of [
    { kind: "nonce" },
    { state: "issued" },
    { descriptorId: "test.other" },
    { sourceKey: "builtin:other" },
    { extra: true },
  ])
    expect(() => parseBarrierDocument(encode({ ...barrier, ...patch }))).toThrow();
});

import { afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AtomicStore } from "./atomic-store.js";
import { createNodePersistenceFs } from "./filesystem.js";
import {
  createLegacyWriterBarrier,
  type LegacyWriterPort,
  type LegacyBarrierDocument,
} from "./import-sources.js";
import type { PersistenceBackend, PersistenceOwner } from "./engine-port.js";
const barrierRoots: string[] = [];
const stores: AtomicStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.dispose();
  for (const root of barrierRoots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function barrierFixture(root?: string, writers?: LegacyWriterPort[]) {
  const directory = root ?? (await mkdtemp(path.join(tmpdir(), "t6-barrier-")));
  if (!root) barrierRoots.push(directory);
  const owner: PersistenceOwner = {
    sourceKey: "builtin:test.synthetic",
    pluginId: "test.synthetic",
    generation: 1,
    hostEpoch: randomUUID(),
    processEpoch: randomUUID(),
  };
  const fs = await createNodePersistenceFs(
    directory,
    { hostEpoch: owner.hostEpoch, assertHeld() {} },
    { now: () => 0 },
  );
  const store = new AtomicStore(fs);
  stores.push(store);
  await store.initialize();
  const unavailable = (): never => {
    throw new Error("unexpected-port");
  };
  const backend: PersistenceBackend = {
    engine: store,
    reads: store,
    imports: {
      load: (o, id) => store.loadImport(o, id),
      plan: (o, p) => store.planImport(o, p),
      admit: (o, id, k) => store.admitImport(o, id, k),
      tagImport: (t, tag) => store.tagImport(t, tag),
      importReceipts: (o, id) => store.importReceipts(o, id),
      record: (o, id, e) => store.recordImport(o, id, e),
      reconcile: (t) => store.reconcileImport(t),
      complete: (o, id) => store.completeImport(o, id),
    },
    evidence: {
      capture: unavailable,
      flush: unavailable,
      tickets: unavailable,
      quota: unavailable,
      settingsDigest: (o) => store.settingsDigest(o),
      auxiliary: (o, k, id) => store.auxiliary(o, k, id),
      auxiliaryKeys: (o, k, c) => store.auxiliaryKeys(o, k, c),
      recoveryPage: unavailable,
      loadRecovery: unavailable,
      saveRecovery: unavailable,
      removeRecovery: unavailable,
    },
    sources: {
      register: unavailable,
      resolvePreferences: unavailable,
      inventory: unavailable,
      read: unavailable,
      map: unavailable,
      appendMapped: unavailable,
      releaseMapped: unavailable,
    },
    output: {
      begin: unavailable,
      append: unavailable,
      commit: unavailable,
      reconcile: unavailable,
      abort: unavailable,
    },
    destinations: { register: unavailable, release: unavailable },
    dispose: () => store.dispose(),
  };
  const descriptor = { id: "test.synthetic-import", targetSourceKey: owner.sourceKey };
  const controls =
    writers ??
    [0, 1].map(() => ({
      sourceKey: owner.sourceKey,
      freezeAdmission: vi.fn(),
      settled: vi.fn(async () => {}),
    }));
  const barrier = createLegacyWriterBarrier({
    backend,
    descriptors: [descriptor],
    writers: controls,
    importOwner: () => owner,
  });
  return { directory, owner, store, backend, descriptor, controls, barrier };
}
describe("T6 import-sources.test.ts: barrier", () => {
  it("freezes every matching writer synchronously and joins restoration and enter", async () => {
    const f = await barrierFixture();
    const first = f.barrier.enter(f.owner.sourceKey, f.descriptor.id);
    for (const w of f.controls) expect(w.freezeAdmission).toHaveBeenCalledTimes(1);
    const a = f.barrier.restore();
    expect(f.barrier.restore()).toBe(a);
    const [one, two] = await Promise.all([
      first,
      f.barrier.enter(f.owner.sourceKey, f.descriptor.id),
    ]);
    expect(one).toBe(two);
    for (const w of f.controls) expect(w.settled).toHaveBeenCalled();
    await expect(f.barrier.complete(one)).rejects.toThrow("incomplete");
  });
  it("keeps settlement behind the durable active marker", async () => {
    const f = await barrierFixture();
    let release!: () => void;
    const settled = new Promise<void>((r) => {
      release = r;
    });
    vi.mocked(f.controls[0]!.settled).mockReturnValue(settled);
    let finished = false;
    const entering = f.barrier.enter(f.owner.sourceKey, f.descriptor.id).then((v) => {
      finished = true;
      return v;
    });
    await vi.waitFor(() => expect(f.controls[0]!.settled).toHaveBeenCalled());
    expect(finished).toBe(false);
    expect(
      parseBarrierDocument(
        (await f.store.auxiliary(f.owner, "import", barrierKeyFor(f.descriptor.id)))!,
      ).state,
    ).toBe("active");
    release();
    await entering;
  });
  it("restores active and complete identities without writers through new epochs", async () => {
    let f = await barrierFixture();
    const root = f.directory,
      handle = await f.barrier.enter(f.owner.sourceKey, f.descriptor.id);
    await f.store.dispose();
    f = await barrierFixture(root, []);
    expect(await f.barrier.restore()).toEqual([
      { sourceKey: f.owner.sourceKey, descriptorId: f.descriptor.id, barrier: handle },
    ]);
    const id = importIdFor(f.descriptor.id, f.owner.sourceKey);
    await f.store.planImport(f.owner, {
      formatVersion: 1,
      id,
      descriptorId: f.descriptor.id,
      mappingVersion: 1,
      targetSourceKey: f.owner.sourceKey,
      preferencesEvidence: null,
      items: [],
    });
    await f.store.completeImport(f.owner, id);
    await Promise.all([f.barrier.complete(handle), f.barrier.complete(handle)]);
    const bytes = (await f.store.auxiliary(f.owner, "import", barrierKeyFor(f.descriptor.id)))!;
    const doc = parseBarrierDocument(bytes);
    expect(doc.state).toBe("complete");
    expect(doc.ticket.owner.hostEpoch).toBe(f.owner.hostEpoch);
    expect(doc.originalTicket.owner.hostEpoch).not.toBe(f.owner.hostEpoch);
    await f.store.dispose();
    f = await barrierFixture(root, []);
    expect((await f.barrier.restore())[0]?.barrier).toBe(handle);
    const publish = vi.spyOn(f.store, "publish");
    await f.barrier.complete(handle);
    expect(publish).not.toHaveBeenCalled();
  });
  it("retains an unknown marker without a second reserve, then reconciles it", async () => {
    const f = await barrierFixture(),
      publish = f.store.publish.bind(f.store),
      reserve = vi.spyOn(f.store, "reserve");
    let uncertain = true;
    vi.spyOn(f.store, "publish").mockImplementation(async (t) => {
      await publish(t);
      return { disposition: "unknown" };
    });
    const reconcile = f.backend.imports.reconcile;
    vi.spyOn(f.backend.imports, "reconcile").mockImplementation((t) =>
      uncertain ? Promise.resolve({ disposition: "unknown" }) : reconcile(t),
    );
    await expect(f.barrier.enter(f.owner.sourceKey, f.descriptor.id)).rejects.toThrow(
      "import-pending",
    );
    expect(reserve).toHaveBeenCalledTimes(1);
    uncertain = false;
    await f.barrier.enter(f.owner.sourceKey, f.descriptor.id);
    expect(reserve).toHaveBeenCalledTimes(1);
    for (const w of f.controls) expect(w.freezeAdmission).toHaveBeenCalled();
  });
  it("a known failed marker permits a later explicit enter with a fresh ticket", async () => {
    const f = await barrierFixture();
    vi.spyOn(f.store, "reserve").mockRejectedValueOnce(new Error("disk-full"));
    await expect(f.barrier.enter(f.owner.sourceKey, f.descriptor.id)).rejects.toThrow("disk-full");
    await expect(f.barrier.enter(f.owner.sourceKey, f.descriptor.id)).resolves.toMatch(
      /^[a-f0-9-]{36}$/,
    );
  });
});
describe("T6 import-sources.test.ts: shape", () => {
  it("keeps entry order and rejects every wrong container and scope type", () => {
    const raw = {
      nonce,
      scope,
      entries: [
        { key: "b", raw: "  中文\n" },
        { key: "a", raw: null },
      ],
    };
    expect(Buffer.from(snapshotBytes(raw, ["a", "b"])).toString()).toBe(JSON.stringify(raw));
    for (const value of [
      undefined,
      false,
      { ...snapshot(), scope: [] },
      { ...snapshot(), scope: { ...scope, hostEpoch: 5 } },
      { ...snapshot(), entries: {} },
      { ...snapshot(), entries: [{ key: 5, raw: null }] },
    ])
      expectInvalidSnapshot(value);
  });
});
describe("T6 import-sources.test.ts: source", () => {
  it("accepts 512 unique regular UUID files and rejects 513 and duplicate names", () => {
    const entries = Array.from({ length: 512 }, () => ({
      name: randomUUID() + ".json",
      regular: true,
      contained: true,
      links: 1,
      bytes: 8388608,
    }));
    expect(() => assertInventory(4096, entries)).not.toThrow();
    expect(() =>
      assertInventory(4096, [...entries, { ...entries[0]!, name: randomUUID() + ".json" }]),
    ).toThrow();
    expect(() => assertInventory(2, [entries[0]!, entries[0]!])).toThrow();
  });
});
describe("T6 import-sources.test.ts: bounds", () => {
  it("rejects changed full original tickets even when IDs match", async () => {
    const f = await barrierFixture();
    await f.barrier.enter(f.owner.sourceKey, f.descriptor.id);
    const doc = parseBarrierDocument(
      (await f.store.auxiliary(f.owner, "import", barrierKeyFor(f.descriptor.id)))!,
    );
    const invalid: LegacyBarrierDocument = {
      ...doc,
      state: "complete",
      ticket: { ...doc.ticket, deadlineMonotonicMs: doc.ticket.deadlineMonotonicMs + 1 },
    };
    expect(() => parseBarrierDocument(Buffer.from(JSON.stringify(invalid)))).toThrow();
    expect(() => parseBarrierDocument(Buffer.alloc(2097153))).toThrow();
    const raw = { nonce, scope, entries: [{ key: "x".repeat(128), raw: null }] };
    expect(() => snapshotBytes(raw, [raw.entries[0]!.key])).not.toThrow();
    raw.entries[0]!.key += "x";
    expect(() => snapshotBytes(raw, [raw.entries[0]!.key])).toThrow();
  });
});

import { publishImportDocument } from "./import-journal.js";
it("T6 import-sources.test.ts: bounds — aggregate nonce evidence is bounded before reserve", async () => {
  const f = await barrierFixture(),
    nonce = randomUUID(),
    raw = {
      nonce,
      scope: { hostEpoch: f.owner.hostEpoch, workbenchInstance: randomUUID() },
      entries: [{ key: "test.preference", raw: "" }],
    };
  raw.entries[0]!.raw = "x".repeat(65536 - snapshotBytes(raw, ["test.preference"]).length);
  let total = 0,
    accepted = 0;
  for (let index = 0; index < 33; index++) {
    const n = randomUUID(),
      key = "nonce/" + n,
      ticket = {
        id: randomUUID(),
        owner: f.owner,
        deadlineMonotonicMs: 10000,
        metadata: { kind: "import" as const, key },
        target: { kind: "import" as const, key },
      };
    const snapshot = { ...raw, nonce: n },
      document = {
        formatVersion: 1 as const,
        kind: "nonce" as const,
        descriptorId: "test.synthetic-preferences",
        sourceKey: f.owner.sourceKey,
        nonce: n,
        scope: snapshot.scope,
        allowlist: ["test.preference"],
        state: "consumed" as const,
        raw: snapshot,
        digest: snapshotDigest(snapshot, ["test.preference"]),
        originalTicket: ticket,
        ticket,
      };
    const length = Buffer.byteLength(JSON.stringify(document));
    if (total + length > 2097152) {
      const reserve = vi.spyOn(f.store, "reserve");
      await expect(publishImportDocument(f.backend, document)).rejects.toThrow("size-limit");
      expect(reserve).not.toHaveBeenCalled();
      break;
    }
    expect((await publishImportDocument(f.backend, document)).disposition).toBe("committed");
    total += length;
    accepted++;
  }
  expect(accepted).toBeGreaterThan(25);
  expect(total).toBeLessThanOrEqual(2097152);
}, 30000);

describe("T6 import-sources.test.ts: barrier", () => {
  it("rejects duplicate descriptors, invalid writer bindings and corrupt restored evidence", async () => {
    const f = await barrierFixture(),
      construct = (descriptors: (typeof f.descriptor)[], writers: LegacyWriterPort[]) =>
        createLegacyWriterBarrier({
          backend: f.backend,
          descriptors,
          writers,
          importOwner: () => f.owner,
        });
    expect(() => construct([f.descriptor, f.descriptor], [])).toThrow("duplicate-descriptor");
    expect(() =>
      construct(
        [f.descriptor],
        [{ sourceKey: "foreign", freezeAdmission() {}, async settled() {} }],
      ),
    ).toThrow("invalid-writer");
    await f.barrier.enter(f.owner.sourceKey, f.descriptor.id);
    vi.spyOn(f.backend.evidence, "auxiliary").mockResolvedValue(Buffer.from('{"formatVersion":2}'));
    const writer = {
      sourceKey: f.owner.sourceKey,
      freezeAdmission: vi.fn(),
      settled: vi.fn(async () => {}),
    };
    const restored = construct([f.descriptor], [writer]);
    const restoring = restored.restore();
    expect(writer.freezeAdmission).toHaveBeenCalledTimes(1);
    await expect(restoring).rejects.toThrow();
    expect(writer.settled).not.toHaveBeenCalled();
  });
  it("enter synchronously freezes only its matching source before global restoration", async () => {
    const f = await barrierFixture(),
      other = { id: "test.other", targetSourceKey: "builtin:test.other" };
    const writers = [f.descriptor, other].map((d) => ({
      sourceKey: d.targetSourceKey,
      freezeAdmission: vi.fn(),
      settled: vi.fn(async () => {}),
    }));
    const barrier = createLegacyWriterBarrier({
      backend: f.backend,
      descriptors: [f.descriptor, other],
      writers,
      importOwner: (key) => ({ ...f.owner, sourceKey: key }),
    });
    const entering = barrier.enter(f.owner.sourceKey, f.descriptor.id);
    expect(writers[0]!.freezeAdmission).toHaveBeenCalledTimes(1);
    expect(writers[1]!.freezeAdmission).not.toHaveBeenCalled();
    await entering;
    expect(writers[1]!.freezeAdmission).toHaveBeenCalledTimes(1);
  });
});

it("T6 import-sources.test.ts: barrier — duplicate in-flight enter and completion share promises", async () => {
  const f = await barrierFixture(),
    a = f.barrier.enter(f.owner.sourceKey, f.descriptor.id),
    b = f.barrier.enter(f.owner.sourceKey, f.descriptor.id);
  expect(b).toBe(a);
  const handle = await a;
  for (const writer of f.controls) expect(writer.settled).toHaveBeenCalledTimes(1);
  const id = importIdFor(f.descriptor.id, f.owner.sourceKey);
  await f.store.planImport(f.owner, {
    formatVersion: 1,
    id,
    descriptorId: f.descriptor.id,
    mappingVersion: 1,
    targetSourceKey: f.owner.sourceKey,
    preferencesEvidence: null,
    items: [],
  });
  await f.store.completeImport(f.owner, id);
  const first = f.barrier.complete(handle),
    second = f.barrier.complete(handle);
  expect(second).toBe(first);
  await first;
});
