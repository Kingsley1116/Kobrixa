import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { PersistenceBackend, PersistenceOwner, PublicationTicket } from "./engine-port.js";
import type {
  LegacySourceResolver,
  LegacyMappedItem,
  LegacyImportDescriptor,
} from "./import-sources.js";
import {
  createLegacyWriterBarrier,
  parseNonceDocument,
  snapshotBytes,
  importIdFor,
} from "./import-sources.js";
import { createLegacyImportCoordinator } from "./import-coordinator.js";
import {
  syntheticImportDescriptor,
  syntheticPreferencesImportDescriptor,
} from "./import-fixtures.js";
import { AtomicStore } from "./atomic-store.js";
import { createNodePersistenceFs } from "./filesystem.js";
const roots: string[] = [],
  opened: AtomicStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of opened.splice(0)) await store.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(
  descriptor: LegacyImportDescriptor,
  root?: string,
  options: { count?: number; size?: number } = {},
) {
  const directory = root ?? (await mkdtemp(path.join(tmpdir(), "import-coordinator-")));
  if (!root) roots.push(directory);
  const epoch = randomUUID(),
    scope = { hostEpoch: epoch, workbenchInstance: randomUUID() };
  const owner: PersistenceOwner = {
    sourceKey: descriptor.targetSourceKey,
    pluginId: descriptor.id,
    generation: 1,
    hostEpoch: epoch,
    processEpoch: randomUUID(),
  };
  const fs = await createNodePersistenceFs(
    directory,
    { hostEpoch: epoch, assertHeld() {} },
    { now: () => performance.now() },
  );
  const store = new AtomicStore(fs);
  opened.push(store);
  await store.initialize();
  const counts = { map: 0, reserve: 0, publish: 0, freeze: 0, settle: 0, peakPins: 0 };
  const fileBytes =
      options.size === undefined
        ? Buffer.from("synthetic immutable original")
        : Buffer.alloc(options.size, 73),
    fileKey = "11111111-1111-4111-8111-111111111111.json";
  let active = true,
    renderer: Uint8Array | null = null,
    registered = false,
    settle: Promise<void> = Promise.resolve();
  const pins = new Map<
    string,
    { bytes: Uint8Array; offset: number; ticket: PublicationTicket | null }
  >();
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const sources: LegacySourceResolver = {
    async register(value) {
      if (
        value.descriptorId !== descriptor.id ||
        value.mapperId !== descriptor.id ||
        value.sourceKind !== descriptor.sourceKind
      )
        throw new Error("invalid-mapper");
      registered = true;
    },
    async resolvePreferences(value) {
      if (
        value.owner.hostEpoch !== epoch ||
        value.owner.sourceKey !== owner.sourceKey ||
        value.descriptorId !== descriptor.id
      )
        throw new Error("stale");
      const encoded = await store.auxiliary(owner, "import", "nonce/" + value.evidence.nonce);
      if (!encoded) throw new Error("missing-evidence");
      const document = parseNonceDocument(encoded);
      if (
        document.state !== "consumed" ||
        !document.raw ||
        document.digest !== value.evidence.digest
      )
        throw new Error("missing-evidence");
      renderer = snapshotBytes(document.raw, document.allowlist);
    },
    async inventory() {
      if (!registered) throw new Error("stale");
      const bytes = descriptor.sourceKind === "renderer-preferences" ? renderer : fileBytes;
      if (!bytes) return { state: "blocked", entries: [] };
      return {
        state: "present",
        entries: Array.from({ length: options.count ?? 1 }, (_, i) => ({
          key: renderer ? "preferences" : i === 0 ? fileKey : `item-${i}`,
          format: 1,
          byteLength: bytes.length,
          sha256: hash(bytes),
        })),
      };
    },
    async read(_id, _key, offset, maxBytes) {
      return (renderer ?? fileBytes).slice(offset, offset + maxBytes);
    },
    async map(id, _key) {
      if (id !== descriptor.id || !registered) throw new Error("stale");
      counts.map++;
      const bytes = descriptor.sourceKind === "renderer-preferences" ? renderer : fileBytes;
      if (!bytes) throw new Error("missing-evidence");
      const mapped = randomUUID(),
        sha = hash(bytes);
      pins.set(mapped, { bytes: bytes.slice(), offset: 0, ticket: null });
      counts.peakPins = Math.max(counts.peakPins, pins.size);
      const value: LegacyMappedItem = {
        kind: "record",
        mapped,
        sourceSha256: sha,
        mappedSha256: sha,
        byteLength: bytes.length,
        metadata: {
          kind:
            descriptor.sourceKind === "renderer-preferences"
              ? "test.preferences"
              : "test.synthetic",
          schemaVersion: 1,
          label: "Fixture",
          mediaType: "application/octet-stream",
          byteLength: bytes.length,
          sha256: sha,
        },
      };
      return value;
    },
    async appendMapped(value) {
      const pin = pins.get(value.mapped);
      if (!pin || value.offset !== pin.offset || value.maxBytes > 262144) throw new Error("stale");
      pin.ticket = value.ticket;
      pin.offset = await store.append(
        value.ticket,
        pin.offset,
        pin.bytes.slice(pin.offset, pin.offset + value.maxBytes),
      );
      return { nextOffset: pin.offset, done: pin.offset === pin.bytes.length };
    },
    async releaseMapped(id) {
      const pin = pins.get(id);
      if (pin?.ticket && store.unresolvedTicket(pin.ticket.id))
        throw new Error("publish-uncertain");
      pins.delete(id);
    },
  };
  const unavailable = (): never => {
    throw new Error("unexpected-test-port");
  };
  const backend: PersistenceBackend = {
    engine: store,
    reads: store,
    sources,
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
      auxiliary: (o, k, key) => store.auxiliary(o, k, key),
      auxiliaryKeys: (o, k, c) => store.auxiliaryKeys(o, k, c),
      recoveryPage: (c) => store.recoveryPage(c),
      loadRecovery: (id) => store.loadRecovery(id),
      saveRecovery: (v) => store.saveRecovery(v),
      removeRecovery: (id) => store.removeRecovery(id),
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
  const reserve = store.reserve.bind(store),
    publish = store.publish.bind(store);
  vi.spyOn(store, "reserve").mockImplementation(async (...args) => {
    counts.reserve++;
    return reserve(...args);
  });
  vi.spyOn(store, "publish").mockImplementation(async (ticket) => {
    counts.publish++;
    return publish(ticket);
  });
  const writer = {
    sourceKey: owner.sourceKey,
    freezeAdmission() {
      counts.freeze++;
    },
    async settled() {
      counts.settle++;
      await settle;
    },
  };
  const barrier = createLegacyWriterBarrier({
    backend,
    descriptors: [descriptor],
    writers: [writer],
    importOwner: () => owner,
  });
  const coordinator = createLegacyImportCoordinator({
    backend,
    sources,
    barrier,
    descriptors: [descriptor],
    currentScope: (s) =>
      s.hostEpoch === scope.hostEpoch && s.workbenchInstance === scope.workbenchInstance,
    currentSource: () => active,
    importOwner: () => owner,
  });
  return {
    directory,
    descriptor,
    owner,
    scope,
    backend,
    store,
    barrier,
    coordinator,
    counts,
    pins,
    fileBytes,
    setActive(value: boolean) {
      active = value;
    },
    holdWriters(value: Promise<void>) {
      settle = value;
    },
    saved: () => backend.imports.load(owner, importIdFor(descriptor.id, owner.sourceKey)),
  };
}
it("freezes synchronously, settles writers before challenge, and joins challenge requests", async () => {
  const f = await fixture(syntheticPreferencesImportDescriptor);
  expect(f.counts.freeze).toBeGreaterThan(0);
  let release!: () => void;
  f.holdWriters(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  let returned = 0;
  const a = f.coordinator
    .issuePreferences({ descriptorId: f.descriptor.id, scope: f.scope })
    .then((v) => {
      returned++;
      return v;
    });
  const b = f.coordinator.issuePreferences({ descriptorId: f.descriptor.id, scope: f.scope });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(returned).toBe(0);
  release();
  const [first, second] = await Promise.all([a, b]);
  expect(first).toEqual(second);
  const bytes = await f.backend.evidence.auxiliary(f.owner, "import", "nonce/" + first.nonce);
  expect(parseNonceDocument(bytes!).state).toBe("issued");
  expect(parseNonceDocument(bytes!).raw).toBeNull();
  await f.backend.dispose();
});
it("captures a defensive snapshot, reconciles identical replay, rejects changed and retired replay", async () => {
  const f = await fixture(syntheticPreferencesImportDescriptor),
    challenge = await f.coordinator.issuePreferences({
      descriptorId: f.descriptor.id,
      scope: f.scope,
    });
  const snapshot = {
    nonce: challenge.nonce,
    scope: f.scope,
    entries: [{ key: "test.preference", raw: "  中文  " }],
  };
  const expected = structuredClone(snapshot),
    pending = f.coordinator.acceptPreferencesEvidence(snapshot);
  snapshot.entries[0]!.raw = "mutated";
  expect(await pending).toEqual({ state: "accepted" });
  const bytes = await f.backend.evidence.auxiliary(f.owner, "import", "nonce/" + challenge.nonce),
    document = parseNonceDocument(bytes!);
  expect(document.state).toBe("consumed");
  expect(document.raw).toEqual(expected);
  expect(await f.coordinator.acceptPreferencesEvidence(expected)).toEqual({ state: "reconciled" });
  await expect(f.coordinator.acceptPreferencesEvidence(snapshot)).rejects.toThrow("changed-replay");
  f.coordinator.retirePreferences(f.scope);
  await expect(f.coordinator.acceptPreferencesEvidence(expected)).rejects.toThrow("stale");
  await f.backend.dispose();
});
it("serializes concurrent submissions into one accepted transition", async () => {
  const f = await fixture(syntheticPreferencesImportDescriptor),
    challenge = await f.coordinator.issuePreferences({
      descriptorId: f.descriptor.id,
      scope: f.scope,
    });
  const snapshot = {
    nonce: challenge.nonce,
    scope: f.scope,
    entries: [{ key: "test.preference", raw: null }],
  };
  const results = await Promise.all([
    f.coordinator.acceptPreferencesEvidence(snapshot),
    f.coordinator.acceptPreferencesEvidence(snapshot),
  ]);
  expect(results).toEqual([{ state: "accepted" }, { state: "reconciled" }]);
  expect(
    parseNonceDocument(
      (await f.backend.evidence.auxiliary(f.owner, "import", "nonce/" + challenge.nonce))!,
    ).raw,
  ).toEqual(snapshot);
  await f.backend.dispose();
});
it("keeps missing renderer pending and safe-mode free of mapping", async () => {
  const f = await fixture(syntheticPreferencesImportDescriptor);
  f.setActive(false);
  expect((await f.coordinator.run(f.descriptor, new AbortController().signal)).state).toBe(
    "pending",
  );
  expect(f.counts.map).toBe(0);
  f.setActive(true);
  expect((await f.coordinator.run(f.descriptor, new AbortController().signal)).state).toBe(
    "pending",
  );
  expect(await f.saved()).toBeNull();
  await f.backend.dispose();
});
it("resumes consumed all-null preferences across three new epochs without a renderer", async () => {
  let f = await fixture(syntheticPreferencesImportDescriptor);
  const root = f.directory;
  const challenge = await f.coordinator.issuePreferences({
    descriptorId: f.descriptor.id,
    scope: f.scope,
  });
  const snapshot = {
    nonce: challenge.nonce,
    scope: f.scope,
    entries: [{ key: "test.preference", raw: null }],
  };
  await f.coordinator.acceptPreferencesEvidence(snapshot);
  await f.backend.dispose();
  const epochs = new Set<string>([f.owner.hostEpoch]);
  let ids: string[] | undefined;
  for (let i = 0; i < 3; i++) {
    f = await fixture(syntheticPreferencesImportDescriptor, root);
    expect(epochs.has(f.owner.hostEpoch)).toBe(false);
    epochs.add(f.owner.hostEpoch);
    const result = await f.coordinator.run(f.descriptor, new AbortController().signal);
    expect(result).toEqual({ state: "complete", completedItems: 1, totalItems: 1 });
    const records = (await f.backend.reads.list(f.owner, { limit: 64 })).entries;
    if (ids) expect(records.map((r) => r.id)).toEqual(ids);
    else ids = records.map((r) => r.id);
    await expect(f.coordinator.acceptPreferencesEvidence(snapshot)).rejects.toThrow("stale");
    expect(f.counts.map).toBe(i === 0 ? 2 : 0);
    await f.backend.dispose();
  }
});
it("persists the full plan before destination reserve and pins one payload at a time", async () => {
  const f = await fixture(syntheticImportDescriptor),
    reserve = AtomicStore.prototype.reserve.bind(f.store),
    originalHash = createHash("sha256").update(f.fileBytes).digest("hex");
  vi.spyOn(f.store, "reserve").mockImplementation(async (ticket, ...rest) => {
    if (ticket.target.kind === "record") {
      const saved = await f.saved();
      expect(saved?.plan.items).toHaveLength(1);
      expect(saved?.items[0]?.publicationTicket).toEqual(ticket);
      expect(saved?.plan.items[0]?.ticket.id).not.toBe(ticket.id);
    }
    return reserve(ticket, ...rest);
  });
  expect(await f.coordinator.run(f.descriptor, new AbortController().signal)).toEqual({
    state: "complete",
    completedItems: 1,
    totalItems: 1,
  });
  expect(f.counts.peakPins).toBe(1);
  expect(f.pins.size).toBe(0);
  expect(createHash("sha256").update(f.fileBytes).digest("hex")).toBe(originalHash);
  await f.backend.dispose();
});

import { describe } from "vitest";
import { parseBarrierDocument, barrierKeyFor, type LegacyNonceDocument } from "./import-sources.js";
import type { ImportPlan } from "./engine-port.js";
const signal = () => new AbortController().signal;
const snap = (f: Awaited<ReturnType<typeof fixture>>, nonce: string) => ({
  nonce,
  scope: f.scope,
  entries: [{ key: "test.preference", raw: "  中文\n\t" }],
});
const nonceDoc = async (f: Awaited<ReturnType<typeof fixture>>, nonce: string) =>
  parseNonceDocument((await f.store.auxiliary(f.owner, "import", "nonce/" + nonce))!);
describe("T6 import-coordinator.test.ts: ordering", () => {
  it("safe mode does no source registration, inventory, schema reads or mapping", async () => {
    const f = await fixture(syntheticImportDescriptor);
    f.setActive(false);
    const register = vi.spyOn(f.backend.sources, "register"),
      inventory = vi.spyOn(f.backend.sources, "inventory"),
      digest = vi.spyOn(f.backend.evidence, "settingsDigest");
    expect((await f.coordinator.run(f.descriptor, signal())).state).toBe("pending");
    expect(register).not.toHaveBeenCalled();
    expect(inventory).not.toHaveBeenCalled();
    expect(digest).not.toHaveBeenCalled();
    expect(f.counts.map).toBe(0);
  });
  it("uses installed descriptors without executing caller functions on main", async () => {
    const f = await fixture(syntheticImportDescriptor);
    const map = vi.fn(() => {
        throw new Error("main-map");
      }),
      validate = vi.fn(() => {
        throw new Error("main-validate");
      });
    expect((await f.coordinator.run({ ...f.descriptor, map, validate }, signal())).state).toBe(
      "complete",
    );
    expect(map).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
  });
  it("retirement wins while writer settlement is awaited", async () => {
    const f = await fixture(syntheticPreferencesImportDescriptor);
    let release!: () => void;
    f.holdWriters(
      new Promise<void>((r) => {
        release = r;
      }),
    );
    const issued = f.coordinator.issuePreferences({
      descriptorId: f.descriptor.id,
      scope: f.scope,
    });
    await vi.waitFor(() => expect(f.counts.settle).toBeGreaterThan(0));
    f.coordinator.retirePreferences(f.scope);
    release();
    await expect(issued).rejects.toThrow("stale");
    expect(
      (await f.backend.evidence.auxiliaryKeys(f.owner, "import")).keys.filter((k) =>
        k.startsWith("nonce/"),
      ),
    ).toEqual([]);
  });
  it("serializes concurrent runs and challenge/run without duplicate publication", async () => {
    const f = await fixture(syntheticImportDescriptor);
    const [a, b] = await Promise.all([
      f.coordinator.run(f.descriptor, signal()),
      f.coordinator.run(f.descriptor, signal()),
    ]);
    expect(a.state).toBe("complete");
    expect(b).toEqual(a);
    expect(f.counts.map).toBe(2);
    expect((await f.store.list(f.owner, { limit: 64 })).entries).toHaveLength(1);
  });
});
describe("T6 import-coordinator.test.ts: plan", () => {
  it.each(["source", "mapped", "length", "metadata", "kind"] as const)(
    "blocks changed %s on the second map before admission/reserve",
    async (change) => {
      const f = await fixture(syntheticImportDescriptor),
        original = f.backend.sources.map;
      vi.spyOn(f.backend.sources, "map").mockImplementation(async (...args) => {
        const value = await original(...args);
        if (f.counts.map === 1) return value;
        if (change === "source") return { ...value, sourceSha256: "0".repeat(64) };
        if (change === "mapped") return { ...value, mappedSha256: "0".repeat(64) };
        if (change === "length") return { ...value, byteLength: value.byteLength + 1 };
        if (change === "kind")
          return {
            mapped: value.mapped,
            kind: "settings",
            schemaVersion: 1,
            sourceSha256: value.sourceSha256,
            mappedSha256: value.mappedSha256,
            byteLength: value.byteLength,
          };
        if (value.kind !== "record") throw new Error("fixture");
        return { ...value, metadata: { ...value.metadata, label: "changed" } };
      });
      const admit = vi.spyOn(f.backend.imports, "admit");
      expect((await f.coordinator.run(f.descriptor, signal())).state).toBe("blocked");
      expect(admit).not.toHaveBeenCalled();
      expect(f.pins.size).toBe(0);
      expect((await f.store.list(f.owner, { limit: 64 })).entries).toHaveLength(0);
    },
  );
  it.each(["added", "deleted", "hash", "format"] as const)(
    "compares the entire %s inventory on resume",
    async (change) => {
      const f = await fixture(syntheticImportDescriptor);
      const admit = vi
        .spyOn(f.backend.imports, "admit")
        .mockRejectedValueOnce(new Error("crash-before-attempt"));
      expect((await f.coordinator.run(f.descriptor, signal())).state).toBe("blocked");
      admit.mockRestore();
      const inventory = f.backend.sources.inventory;
      vi.spyOn(f.backend.sources, "inventory").mockImplementation(async (...args) => {
        const value = await inventory(...args),
          first = value.entries[0]!;
        return {
          ...value,
          entries:
            change === "deleted"
              ? []
              : change === "added"
                ? [first, { ...first, key: "extra" }]
                : [
                    {
                      ...first,
                      ...(change === "hash" ? { sha256: "0".repeat(64) } : { format: 2 }),
                    },
                  ],
        };
      });
      const next = vi.spyOn(f.backend.imports, "admit");
      expect((await f.coordinator.run(f.descriptor, signal())).state).toBe("blocked");
      expect(next).not.toHaveBeenCalled();
      expect(f.counts.map).toBe(2);
    },
  );
  it.each(["blocked", "absent", "empty"] as const)("distinguishes %s inventory", async (state) => {
    const f = await fixture(syntheticImportDescriptor);
    vi.spyOn(f.backend.sources, "inventory").mockResolvedValue({
      state: state === "empty" ? "present" : state,
      entries: [],
    });
    const result = await f.coordinator.run(f.descriptor, signal());
    expect(result.state).toBe(state === "blocked" ? "blocked" : "complete-empty");
    expect(f.counts.map).toBe(0);
  });
  it("rejects oversized inventory and source bytes without mapping", async () => {
    for (const change of ["count", "bytes", "key", "absent-with-items"]) {
      const f = await fixture(syntheticImportDescriptor),
        inventory = f.backend.sources.inventory;
      vi.spyOn(f.backend.sources, "inventory").mockImplementation(async (...args) => {
        const value = await inventory(...args),
          first = value.entries[0]!;
        return {
          state: change === "absent-with-items" ? "absent" : "present",
          entries:
            change === "count"
              ? Array.from({ length: 513 }, (_, i) => ({ ...first, key: String(i) }))
              : [
                  {
                    ...first,
                    ...(change === "bytes"
                      ? { byteLength: 8388609 }
                      : change === "key"
                        ? { key: "x".repeat(129) }
                        : {}),
                  },
                ],
        };
      });
      expect((await f.coordinator.run(f.descriptor, signal())).state).toBe("blocked");
      expect(f.counts.map).toBe(0);
    }
  });
});
describe("T6 import-coordinator.test.ts: outcomes", () => {
  it.each(["reserve", "tag", "append", "seal", "publish"] as const)(
    "settles %s failure before freeing a publication pin",
    async (point) => {
      const f = await fixture(syntheticImportDescriptor);
      const fail = () => {
        throw new Error("injected-" + point);
      };
      if (point === "reserve") {
        const reserve = AtomicStore.prototype.reserve.bind(f.store);
        vi.spyOn(f.store, "reserve").mockImplementation((t, n) =>
          t.target.kind === "record" ? fail() : reserve(t, n),
        );
      }
      if (point === "tag") vi.spyOn(f.backend.imports, "tagImport").mockImplementation(fail);
      if (point === "append") vi.spyOn(f.backend.sources, "appendMapped").mockImplementation(fail);
      if (point === "seal") {
        const seal = f.store.seal.bind(f.store);
        vi.spyOn(f.store, "seal").mockImplementation((t, ...rest) =>
          t.target.kind === "record" ? fail() : seal(t, ...rest),
        );
      }
      if (point === "publish") {
        const publish = AtomicStore.prototype.publish.bind(f.store);
        vi.spyOn(f.store, "publish").mockImplementation((t) =>
          t.target.kind === "record" ? fail() : publish(t),
        );
      }
      expect((await f.coordinator.run(f.descriptor, signal())).state).toBe("blocked");
      expect(f.pins.size).toBe(0);
      expect((await f.saved())?.complete).toBe(false);
    },
  );
  it("retains unknown pins and never admits or publishes again until settled", async () => {
    const f = await fixture(syntheticImportDescriptor),
      publish = AtomicStore.prototype.publish.bind(f.store),
      reconcile = f.backend.imports.reconcile;
    let unknown = true;
    let itemPublications = 0;
    vi.spyOn(f.store, "publish").mockImplementation(async (t) => {
      const r = await publish(t);
      if (t.target.kind !== "record") return r;
      itemPublications++;
      return { disposition: "unknown" };
    });
    vi.spyOn(f.backend.imports, "reconcile").mockImplementation((t) =>
      unknown && t.target.kind === "record"
        ? Promise.resolve({ disposition: "unknown" })
        : reconcile(t),
    );
    const admit = vi.spyOn(f.backend.imports, "admit");
    expect((await f.coordinator.run(f.descriptor, signal())).state).toBe("blocked");
    expect(f.pins.size).toBe(1);
    expect((await f.coordinator.run(f.descriptor, signal())).state).toBe("blocked");
    expect(admit).toHaveBeenCalledTimes(1);
    expect(itemPublications).toBe(1);
    unknown = false;
    expect((await f.coordinator.run(f.descriptor, signal())).state).toBe("complete");
    expect(itemPublications).toBe(1);
    expect(f.pins.size).toBe(0);
  });
  it("cancellation after dispatch records only durable evidence and cannot report success", async () => {
    const f = await fixture(syntheticImportDescriptor),
      abort = new AbortController(),
      publish = AtomicStore.prototype.publish.bind(f.store);
    vi.spyOn(f.store, "publish").mockImplementation(async (t) => {
      const result = await publish(t);
      if (t.target.kind === "record") abort.abort();
      return result;
    });
    expect(await f.coordinator.run(f.descriptor, abort.signal)).toEqual({
      state: "blocked",
      completedItems: 1,
      totalItems: 1,
    });
    expect(f.pins.size).toBe(0);
    expect((await f.coordinator.run(f.descriptor, signal())).state).toBe("complete");
    expect((await f.store.list(f.owner, { limit: 64 })).entries).toHaveLength(1);
  });
});
describe("T6 import-coordinator.test.ts: nonce", () => {
  it("observes issued-with-raw and consumed documents containing byte-identical evidence", async () => {
    const f = await fixture(syntheticPreferencesImportDescriptor),
      challenge = await f.coordinator.issuePreferences({
        descriptorId: f.descriptor.id,
        scope: f.scope,
      });
    const seen: LegacyNonceDocument[] = [],
      publish = AtomicStore.prototype.publish.bind(f.store),
      raw = snap(f, challenge.nonce);
    vi.spyOn(f.store, "publish").mockImplementation(async (t) => {
      const result = await publish(t);
      if (t.target.kind === "import" && t.target.key === "nonce/" + challenge.nonce)
        seen.push(await nonceDoc(f, challenge.nonce));
      return result;
    });
    expect(await f.coordinator.acceptPreferencesEvidence(raw)).toEqual({ state: "accepted" });
    expect(seen.map((d) => d.state)).toEqual(["issued", "consumed"]);
    for (const doc of seen) {
      expect(Buffer.from(snapshotBytes(doc.raw!, doc.allowlist))).toEqual(
        Buffer.from(snapshotBytes(raw, ["test.preference"])),
      );
      expect(doc.digest).toBe(seen[0]!.digest);
      expect(doc.originalTicket).toEqual(seen[0]!.originalTicket);
    }
    expect(seen[0]!.ticket.id).not.toBe(seen[1]!.ticket.id);
  });
  it.each(["raw", "consumed"] as const)(
    "keeps unknown %s pending, compatibility rejects, exact replay reconciles",
    async (phase) => {
      const f = await fixture(syntheticPreferencesImportDescriptor),
        challenge = await f.coordinator.issuePreferences({
          descriptorId: f.descriptor.id,
          scope: f.scope,
        }),
        raw = snap(f, challenge.nonce);
      const publish = AtomicStore.prototype.publish.bind(f.store),
        reconcile = f.backend.imports.reconcile;
      let unknown = true,
        publishes = 0;
      vi.spyOn(f.store, "publish").mockImplementation(async (t) => {
        const result = await publish(t);
        publishes++;
        if (
          (await nonceDoc(f, challenge.nonce)).state === (phase === "raw" ? "issued" : "consumed")
        )
          return { disposition: "unknown" };
        return result;
      });
      vi.spyOn(f.backend.imports, "reconcile").mockImplementation((t) =>
        unknown ? Promise.resolve({ disposition: "unknown" }) : reconcile(t),
      );
      expect(await f.coordinator.acceptPreferencesEvidence(raw)).toEqual({ state: "pending" });
      const before = publishes;
      await expect(f.coordinator.acceptPreferences(raw)).rejects.toThrow("import-pending");
      expect(publishes).toBe(before);
      expect((await nonceDoc(f, challenge.nonce)).state).toBe(
        phase === "raw" ? "issued" : "consumed",
      );
      unknown = false;
      expect(await f.coordinator.acceptPreferencesEvidence(raw)).toEqual({ state: "reconciled" });
      expect((await nonceDoc(f, challenge.nonce)).raw).toEqual(raw);
    },
  );
  it("raw failure never consumes and a known failure can be retried", async () => {
    const f = await fixture(syntheticPreferencesImportDescriptor),
      challenge = await f.coordinator.issuePreferences({
        descriptorId: f.descriptor.id,
        scope: f.scope,
      }),
      raw = snap(f, challenge.nonce);
    vi.spyOn(f.store, "reserve").mockRejectedValueOnce(new Error("disk-full"));
    await expect(f.coordinator.acceptPreferencesEvidence(raw)).rejects.toThrow("disk-full");
    expect((await nonceDoc(f, challenge.nonce)).raw).toBeNull();
    expect(await f.coordinator.acceptPreferencesEvidence(raw)).toEqual({ state: "accepted" });
  });
  it("rejects wrong nonce, window, epoch, keys and malformed input", async () => {
    const f = await fixture(syntheticPreferencesImportDescriptor),
      challenge = await f.coordinator.issuePreferences({
        descriptorId: f.descriptor.id,
        scope: f.scope,
      }),
      raw = snap(f, challenge.nonce);
    for (const bad of [
      { ...raw, nonce: randomUUID() },
      { ...raw, scope: { ...f.scope, workbenchInstance: randomUUID() } },
      { ...raw, scope: { ...f.scope, hostEpoch: randomUUID() } },
      { ...raw, entries: [{ key: "foreign", raw: null }] },
    ])
      await expect(f.coordinator.acceptPreferencesEvidence(bad)).rejects.toThrow();
  });
});
describe("T6 import-coordinator.test.ts: restart", () => {
  it.each(["plan", "attempt", "head", "receipt", "import-marker", "barrier"] as const)(
    "resumes after %s through three fresh host epochs without republishing",
    async (boundary) => {
      let f = await fixture(syntheticImportDescriptor);
      const root = f.directory;
      if (boundary === "plan")
        vi.spyOn(f.backend.imports, "admit").mockRejectedValueOnce(new Error("crash"));
      if (boundary === "attempt") {
        const admit = f.backend.imports.admit;
        vi.spyOn(f.backend.imports, "admit").mockImplementationOnce(async (...args) => {
          await admit(...args);
          throw new Error("crash");
        });
      }
      if (boundary === "head")
        vi.spyOn(f.backend.imports, "record").mockRejectedValueOnce(new Error("crash"));
      if (boundary === "receipt")
        vi.spyOn(f.backend.imports, "complete").mockRejectedValueOnce(new Error("crash"));
      if (boundary === "import-marker")
        vi.spyOn(f.barrier, "complete").mockRejectedValueOnce(new Error("crash"));
      const initial = await f.coordinator.run(f.descriptor, signal());
      expect(initial.state).toBe(boundary === "barrier" ? "complete" : "blocked");
      const original = (await f.saved())!.plan,
        epochs = new Set([f.owner.hostEpoch]);
      let published = 0;
      await f.store.dispose();
      vi.restoreAllMocks();
      for (let i = 0; i < 3; i++) {
        f = await fixture(syntheticImportDescriptor, root);
        expect(epochs.has(f.owner.hostEpoch)).toBe(false);
        epochs.add(f.owner.hostEpoch);
        const publish = AtomicStore.prototype.publish.bind(f.store);
        vi.spyOn(f.store, "publish").mockImplementation((t) => {
          if (t.target.kind === "record") published++;
          return publish(t);
        });
        expect(await f.coordinator.run(f.descriptor, signal())).toEqual({
          state: "complete",
          completedItems: 1,
          totalItems: 1,
        });
        const saved = (await f.saved())!;
        expect(saved.plan).toEqual(original);
        expect(saved.items[0]!.publicationTicket!.id).not.toBe(original.items[0]!.ticket.id);
        const records = (await f.store.list(f.owner, { limit: 64 })).entries;
        expect(records).toHaveLength(1);
        expect(records[0]!.id).toBe(
          original.items[0]!.ticket.target.kind === "record"
            ? original.items[0]!.ticket.target.id
            : "",
        );
        const pin = await f.store.open(f.owner, records[0]!.id, records[0]!.revision);
        expect(await f.store.read(f.owner, pin, 0, 262144)).toEqual(f.fileBytes);
        await f.store.close(f.owner, pin);
        await f.store.dispose();
        vi.restoreAllMocks();
      }
      expect(published).toBe(boundary === "plan" || boundary === "attempt" ? 1 : 0);
    },
  );
  it.each(["challenge", "raw", "consumption"] as const)(
    "recovers %s with no renderer and rejects the historical window",
    async (boundary) => {
      let f = await fixture(syntheticPreferencesImportDescriptor);
      const root = f.directory,
        challenge = await f.coordinator.issuePreferences({
          descriptorId: f.descriptor.id,
          scope: f.scope,
        }),
        raw = snap(f, challenge.nonce);
      if (boundary === "raw") {
        const publish = AtomicStore.prototype.publish.bind(f.store);
        vi.spyOn(f.store, "publish").mockImplementation(async (t) => {
          const result = await publish(t);
          if (t.target.kind === "import" && t.target.key.startsWith("nonce/"))
            f.coordinator.retirePreferences(f.scope);
          return result;
        });
        await expect(f.coordinator.acceptPreferencesEvidence(raw)).rejects.toThrow("stale");
        expect((await nonceDoc(f, challenge.nonce)).state).toBe("issued");
      }
      if (boundary === "consumption") await f.coordinator.acceptPreferencesEvidence(raw);
      await f.store.dispose();
      vi.restoreAllMocks();
      f = await fixture(syntheticPreferencesImportDescriptor, root);
      expect((await f.coordinator.run(f.descriptor, signal())).state).toBe(
        boundary === "challenge" ? "pending" : "complete",
      );
      await expect(f.coordinator.acceptPreferencesEvidence(raw)).rejects.toThrow("stale");
      if (boundary !== "challenge") expect((await nonceDoc(f, challenge.nonce)).raw).toEqual(raw);
    },
  );
});
describe("T6 import-coordinator.test.ts: terminal/load", () => {
  it("restores a completed import across mapping/schema changes without mapping", async () => {
    let f = await fixture(syntheticImportDescriptor);
    const root = f.directory;
    expect((await f.coordinator.run(f.descriptor, signal())).state).toBe("complete");
    await f.store.dispose();
    vi.restoreAllMocks();
    f = await fixture(
      { ...syntheticImportDescriptor, mappingVersion: 2, targetRecordSchemaVersions: [2] },
      root,
    );
    expect((await f.coordinator.run(f.descriptor, signal())).state).toBe("complete");
    expect(f.counts.map).toBe(0);
    const marker = parseBarrierDocument(
      (await f.store.auxiliary(f.owner, "import", barrierKeyFor(f.descriptor.id)))!,
    );
    expect(marker.state).toBe("complete");
  });
});

describe("T6 import-coordinator.test.ts: terminal/load", () => {
  it("streams 50 × 8 MiB with one payload pin and bounded sequential chunks", async () => {
    let f = await fixture(syntheticImportDescriptor, undefined, { count: 50, size: 8388608 });
    const root = f.directory;
    let chunks = 0,
      maps = 0,
      publications = 0,
      original: ImportPlan | undefined;
    for (let epoch = 0; epoch < 3; epoch++) {
      const append = f.backend.sources.appendMapped,
        publish = AtomicStore.prototype.publish.bind(f.store);
      vi.spyOn(f.backend.sources, "appendMapped").mockImplementation(async (request) => {
        expect(request.maxBytes).toBeLessThanOrEqual(262144);
        chunks++;
        return append(request);
      });
      vi.spyOn(f.store, "publish").mockImplementation(async (ticket) => {
        const result = await publish(ticket);
        if (ticket.target.kind === "record" && result.disposition === "committed") publications++;
        return result;
      });
      const result = await f.coordinator.run(f.descriptor, signal());
      expect(result.totalItems).toBe(50);
      const saved = (await f.saved())!;
      if (original) expect(saved.plan).toEqual(original);
      else original = saved.plan;
      expect(f.counts.peakPins).toBe(1);
      expect(f.pins.size).toBe(0);
      maps += f.counts.map;
      if (result.state === "complete") break;
      expect(result.state).toBe("blocked");
      expect(result.completedItems).toBeGreaterThan(0);
      expect(result.completedItems).toBeLessThan(50);
      expect(saved.complete).toBe(false);
      await f.store.dispose();
      vi.restoreAllMocks();
      f = await fixture(syntheticImportDescriptor, root, { count: 50, size: 8388608 });
    }
    expect((await f.saved())?.complete).toBe(true);
    expect(publications).toBe(50);
    expect(chunks).toBe(1600);
    expect(maps).toBeGreaterThanOrEqual(100);
    const records = (await f.store.list(f.owner, { limit: 64 })).entries;
    expect(records).toHaveLength(50);
    expect(new Set(records.map((r) => r.id)).size).toBe(50);
    const hash = createHash("sha256").update(f.fileBytes).digest("hex");
    expect(records.every((r) => r.byteLength === 8388608 && r.sha256 === hash)).toBe(true);
  }, 120000);
  it("retains a trusted skip through restart and counts only durable terminal evidence", async () => {
    let f = await fixture(syntheticImportDescriptor);
    const root = f.directory;
    vi.spyOn(f.backend.imports, "admit").mockRejectedValueOnce(new Error("crash"));
    expect((await f.coordinator.run(f.descriptor, signal())).state).toBe("blocked");
    const saved = (await f.saved())!;
    await f.backend.imports.record(f.owner, saved.plan.id, {
      key: saved.plan.items[0]!.key,
      state: "skipped",
      receipt: null,
      skipReason: "trusted-user-skip",
      publicationTicket: null,
    });
    await f.store.dispose();
    vi.restoreAllMocks();
    f = await fixture(syntheticImportDescriptor, root);
    expect(await f.coordinator.run(f.descriptor, signal())).toEqual({
      state: "complete",
      completedItems: 1,
      totalItems: 1,
    });
    expect(f.counts.map).toBe(0);
    expect((await f.saved())?.items[0]?.skipReason).toBe("trusted-user-skip");
    expect((await f.store.list(f.owner, { limit: 64 })).entries).toHaveLength(0);
  });
  it("never resurrects a user-deleted completed destination", async () => {
    let f = await fixture(syntheticImportDescriptor);
    const root = f.directory;
    await f.coordinator.run(f.descriptor, signal());
    const saved = (await f.saved())!,
      original = saved.items[0]!.publicationTicket!;
    if (original.metadata.kind !== "record" || original.target.kind !== "record")
      throw new Error("fixture");
    const ticket: PublicationTicket = {
      ...original,
      id: randomUUID(),
      deadlineMonotonicMs: performance.now() + 10000,
      target: { ...original.target, expectedRevision: original.metadata.record.revision },
      metadata: {
        kind: "record",
        deleted: true,
        record: { ...original.metadata.record, revision: "r_" + randomUUID().replaceAll("-", "") },
      },
    };
    const empty = new Uint8Array();
    await f.store.reserve(ticket, 0);
    await f.store.seal(ticket, 0, createHash("sha256").update(empty).digest("hex"));
    expect((await f.store.publish(ticket)).disposition).toBe("committed");
    await f.store.dispose();
    vi.restoreAllMocks();
    f = await fixture({ ...syntheticImportDescriptor, mappingVersion: 2 }, root);
    expect((await f.coordinator.run(f.descriptor, signal())).state).toBe("complete");
    expect(f.counts.map).toBe(0);
    expect((await f.store.list(f.owner, { limit: 64 })).entries).toHaveLength(0);
  });
});

describe("T6 import-coordinator.test.ts: nonce", () => {
  it("never gives two live scopes authority over one descriptor", async () => {
    const f = await fixture(syntheticPreferencesImportDescriptor);
    let current = f.scope;
    const coordinator = createLegacyImportCoordinator({
      backend: f.backend,
      sources: f.backend.sources,
      barrier: f.barrier,
      descriptors: [f.descriptor],
      currentScope: (s) =>
        s.hostEpoch === current.hostEpoch && s.workbenchInstance === current.workbenchInstance,
      currentSource: () => true,
      importOwner: () => f.owner,
    });
    const old = await coordinator.issuePreferences({
      descriptorId: f.descriptor.id,
      scope: current,
    });
    const oldScope = current;
    current = { ...current, workbenchInstance: randomUUID() };
    const next = await coordinator.issuePreferences({
      descriptorId: f.descriptor.id,
      scope: current,
    });
    expect(next.nonce).not.toBe(old.nonce);
    current = oldScope;
    await expect(
      coordinator.acceptPreferencesEvidence({
        nonce: old.nonce,
        scope: oldScope,
        entries: [{ key: "test.preference", raw: null }],
      }),
    ).rejects.toThrow("stale");
  });
  it("rejects multiple captured candidates but an unfinished plan pins its exact evidence", async () => {
    let f = await fixture(syntheticPreferencesImportDescriptor);
    const root = f.directory,
      challenge = await f.coordinator.issuePreferences({
        descriptorId: f.descriptor.id,
        scope: f.scope,
      });
    await f.coordinator.acceptPreferencesEvidence(snap(f, challenge.nonce));
    const doc = await nonceDoc(f, challenge.nonce);
    vi.spyOn(f.backend.imports, "admit").mockRejectedValueOnce(new Error("crash"));
    expect((await f.coordinator.run(f.descriptor, signal())).state).toBe("blocked");
    const original = (await f.saved())!.plan.preferencesEvidence;
    const nonce = randomUUID(),
      key = "nonce/" + nonce,
      ticket: PublicationTicket = {
        ...doc.ticket,
        id: randomUUID(),
        metadata: { kind: "import", key },
        target: { kind: "import", key },
      };
    const raw = { ...doc.raw!, nonce, entries: [{ key: "test.preference", raw: "different" }] };
    const other: LegacyNonceDocument = {
      ...doc,
      nonce,
      raw,
      digest: createHash("sha256").update(snapshotBytes(raw, doc.allowlist)).digest("hex"),
      originalTicket: ticket,
      ticket,
    };
    await publishImportDocument(f.backend, other);
    await f.store.dispose();
    vi.restoreAllMocks();
    f = await fixture(syntheticPreferencesImportDescriptor, root);
    expect((await f.coordinator.run(f.descriptor, signal())).state).toBe("complete");
    expect((await f.saved())!.plan.preferencesEvidence).toEqual(original);
    // A separate namespace with no plan must not guess between captured records.
    const g = await fixture(syntheticPreferencesImportDescriptor),
      one = await g.coordinator.issuePreferences({ descriptorId: g.descriptor.id, scope: g.scope });
    await g.coordinator.acceptPreferencesEvidence(snap(g, one.nonce));
    const first = await nonceDoc(g, one.nonce),
      n = randomUUID(),
      k = "nonce/" + n,
      t: PublicationTicket = {
        ...first.ticket,
        id: randomUUID(),
        metadata: { kind: "import", key: k },
        target: { kind: "import", key: k },
      },
      r = { ...first.raw!, nonce: n };
    await publishImportDocument(g.backend, {
      ...first,
      nonce: n,
      raw: r,
      digest: createHash("sha256").update(snapshotBytes(r, first.allowlist)).digest("hex"),
      originalTicket: t,
      ticket: t,
    });
    await g.store.dispose();
    vi.restoreAllMocks();
    const reopened = await fixture(syntheticPreferencesImportDescriptor, g.directory);
    expect((await reopened.coordinator.run(reopened.descriptor, signal())).state).toBe("blocked");
    expect(reopened.counts.map).toBe(0);
  });
});
import { publishImportDocument } from "./import-journal.js";

describe("T6 import-coordinator.test.ts: plan", () => {
  it.each(["missing", "schema", "validation-digest"] as const)(
    "checks settings %s against committed evidence before reserve",
    async (failure) => {
      const descriptor: LegacyImportDescriptor = {
        ...syntheticImportDescriptor,
        id: "test.settings-import",
        sourceKind: "device-settings",
        targetSettingsSchemaVersion: 1,
        targetRecordSchemaVersions: [],
      };
      const f = await fixture(descriptor),
        map = f.backend.sources.map;
      vi.spyOn(f.backend.sources, "map").mockImplementation(async (...args) => {
        const value = await map(...args);
        return {
          kind: "settings",
          mapped: value.mapped,
          sourceSha256: value.sourceSha256,
          mappedSha256: value.mappedSha256,
          byteLength: value.byteLength,
          schemaVersion: failure === "schema" ? 2 : 1,
        };
      });
      let calls = 0;
      vi.spyOn(f.backend.evidence, "settingsDigest").mockImplementation(async () =>
        failure === "missing"
          ? null
          : {
              schemaVersion: 1,
              revision: "r_" + "0".repeat(32),
              validationDigest:
                failure === "validation-digest" && calls++ > 0 ? "1".repeat(64) : "0".repeat(64),
            },
      );
      const admit = vi.spyOn(f.backend.imports, "admit");
      expect((await f.coordinator.run(descriptor, signal())).state).toBe("blocked");
      expect(admit).not.toHaveBeenCalled();
      expect(f.pins.size).toBe(0);
    },
  );
  it("rejects device-settings above 64 KiB before mapping", async () => {
    const descriptor = { ...syntheticImportDescriptor, sourceKind: "device-settings" as const },
      f = await fixture(descriptor, undefined, { size: 65537 });
    expect((await f.coordinator.run(descriptor, signal())).state).toBe("blocked");
    expect(f.counts.map).toBe(0);
  });
  it("maps inventories over a 64-item boundary without holding planning payloads", async () => {
    const f = await fixture(syntheticImportDescriptor, undefined, { count: 65 });
    vi.spyOn(f.backend.imports, "admit").mockRejectedValueOnce(new Error("stop-after-plan"));
    expect((await f.coordinator.run(f.descriptor, signal())).state).toBe("blocked");
    expect((await f.saved())?.plan.items).toHaveLength(65);
    expect(f.counts.map).toBe(66);
    expect(f.counts.peakPins).toBe(1);
    expect(f.pins.size).toBe(0);
  });
});
describe("T6 import-coordinator.test.ts: outcomes", () => {
  it.each(["map", "admit", "append", "seal"] as const)(
    "revokes source admission during %s before the next side effect",
    async (phase) => {
      const f = await fixture(syntheticImportDescriptor),
        publish = vi.spyOn(f.store, "publish"),
        originalMap = f.backend.sources.map;
      if (phase === "map")
        vi.spyOn(f.backend.sources, "map").mockImplementation(async (...args) => {
          const result = await originalMap(...args);
          f.setActive(false);
          return result;
        });
      if (phase === "admit") {
        const admit = f.backend.imports.admit;
        vi.spyOn(f.backend.imports, "admit").mockImplementation(async (...args) => {
          const result = await admit(...args);
          f.setActive(false);
          return result;
        });
      }
      if (phase === "append") {
        const append = f.backend.sources.appendMapped;
        vi.spyOn(f.backend.sources, "appendMapped").mockImplementation(async (...args) => {
          const result = await append(...args);
          f.setActive(false);
          return result;
        });
      }
      if (phase === "seal") {
        const seal = f.store.seal.bind(f.store);
        vi.spyOn(f.store, "seal").mockImplementation(async (t, ...args) => {
          await seal(t, ...args);
          if (t.target.kind === "record") f.setActive(false);
        });
      }
      expect((await f.coordinator.run(f.descriptor, signal())).state).toBe("blocked");
      expect(publish.mock.calls.filter(([t]) => t.target.kind === "record")).toHaveLength(0);
      expect(f.pins.size).toBe(0);
    },
  );
  it("known noncommit blocks until a new explicit run admits a replacement", async () => {
    const f = await fixture(syntheticImportDescriptor),
      publish = AtomicStore.prototype.publish.bind(f.store);
    let fail = true;
    vi.spyOn(f.store, "publish").mockImplementation((t) => {
      if (t.target.kind === "record" && fail) {
        fail = false;
        return Promise.resolve({ disposition: "not-committed" });
      }
      return publish(t);
    });
    const admit = vi.spyOn(f.backend.imports, "admit");
    expect((await f.coordinator.run(f.descriptor, signal())).state).toBe("blocked");
    expect(admit).toHaveBeenCalledTimes(1);
    expect(f.pins.size).toBe(0);
    const previous = (await f.saved())!.items[0]!.publicationTicket!;
    expect((await f.coordinator.run(f.descriptor, signal())).state).toBe("complete");
    const current = (await f.saved())!.items[0]!.publicationTicket!;
    expect(current.id).not.toBe(previous.id);
    expect(current.deadlineMonotonicMs).toBe(previous.deadlineMonotonicMs);
    expect(admit).toHaveBeenCalledTimes(2);
  });
});

it("T6 import-coordinator.test.ts: ordering — rejects invalid fixed registries before restore", async () => {
  const f = await fixture(syntheticPreferencesImportDescriptor);
  for (const patch of [
    { id: "x".repeat(129) },
    { targetSourceKey: "bad\0namespace" },
    { sourceKind: "arbitrary-path" },
    { mappingVersion: 0 },
    { sourceFormatVersions: [1, 1] },
    { targetRecordSchemaVersions: [1, 1] },
    { rendererKeyAllowlist: ["test.preference", "test.preference"] },
  ]) {
    const descriptor = { ...f.descriptor, ...patch } as LegacyImportDescriptor;
    expect(() =>
      createLegacyImportCoordinator({
        backend: f.backend,
        sources: f.backend.sources,
        barrier: f.barrier,
        descriptors: [descriptor],
        currentScope: () => true,
        currentSource: () => true,
        importOwner: () => f.owner,
      }),
    ).toThrow("invalid-descriptor");
  }
});
it("T6 import-coordinator.test.ts: ordering — current owner changes revoke the whole attempt", async () => {
  const f = await fixture(syntheticImportDescriptor);
  let current = f.owner;
  const coordinator = createLegacyImportCoordinator({
    backend: f.backend,
    sources: f.backend.sources,
    barrier: f.barrier,
    descriptors: [f.descriptor],
    currentScope: () => true,
    currentSource: () => true,
    importOwner: () => current,
  });
  const admit = f.backend.imports.admit;
  vi.spyOn(f.backend.imports, "admit").mockImplementation(async (...args) => {
    const ticket = await admit(...args);
    current = { ...current, processEpoch: randomUUID(), generation: 2 };
    return ticket;
  });
  const publish = vi.spyOn(f.store, "publish");
  expect((await coordinator.run(f.descriptor, signal())).state).toBe("blocked");
  expect(publish.mock.calls.filter(([t]) => t.target.kind === "record")).toHaveLength(0);
  expect(f.pins.size).toBe(0);
});

it("T6 import-coordinator.test.ts: outcomes — cleanup uncertainty retains the mapped pin", async () => {
  const f = await fixture(syntheticImportDescriptor),
    publish = AtomicStore.prototype.publish.bind(f.store),
    abort = f.store.abort.bind(f.store),
    reconcile = f.backend.imports.reconcile;
  vi.spyOn(f.store, "publish").mockImplementation((t) =>
    t.target.kind === "record" ? Promise.resolve({ disposition: "not-committed" }) : publish(t),
  );
  vi.spyOn(f.store, "abort").mockImplementation((t) =>
    t.target.kind === "record" ? Promise.resolve("unknown") : abort(t),
  );
  vi.spyOn(f.backend.imports, "reconcile").mockImplementation((t) =>
    t.target.kind === "record" ? Promise.resolve({ disposition: "unknown" }) : reconcile(t),
  );
  expect((await f.coordinator.run(f.descriptor, signal())).state).toBe("blocked");
  expect(f.pins.size).toBe(1);
});

describe("T6 fix round1 authority boundaries", () => {
  it("retires an unresolved no-raw challenge when a replacement scope is issued", async () => {
    const f = await fixture(syntheticPreferencesImportDescriptor);
    let current = f.scope,
      unknown = true,
      oldNonce = "";
    const coordinator = createLegacyImportCoordinator({
      backend: f.backend,
      sources: f.backend.sources,
      barrier: f.barrier,
      descriptors: [f.descriptor],
      currentScope: (s) => s.workbenchInstance === current.workbenchInstance,
      currentSource: () => true,
      importOwner: () => f.owner,
    });
    const publish = AtomicStore.prototype.publish.bind(f.store),
      reconcile = f.backend.imports.reconcile;
    vi.spyOn(f.store, "publish").mockImplementation(async (t) => {
      const result = await publish(t);
      if (unknown && t.target.kind === "import" && t.target.key.startsWith("nonce/")) {
        oldNonce = t.target.key.slice(6);
        return { disposition: "unknown" };
      }
      return result;
    });
    vi.spyOn(f.backend.imports, "reconcile").mockImplementation((t) =>
      unknown && t.target.kind === "import" && t.target.key.startsWith("nonce/")
        ? Promise.resolve({ disposition: "unknown" })
        : reconcile(t),
    );
    await expect(
      coordinator.issuePreferences({ descriptorId: f.descriptor.id, scope: current }),
    ).rejects.toThrow("import-pending");
    expect(oldNonce).not.toBe("");
    unknown = false;
    const oldScope = current;
    current = { ...current, workbenchInstance: randomUUID() };
    const nextScope = current;
    const next = await coordinator.issuePreferences({
      descriptorId: f.descriptor.id,
      scope: current,
    });
    current = oldScope;
    await expect(
      coordinator.issuePreferences({ descriptorId: f.descriptor.id, scope: current }),
    ).rejects.toThrow("stale");
    await expect(coordinator.acceptPreferencesEvidence(snap(f, oldNonce))).rejects.toThrow("stale");
    expect((await nonceDoc(f, oldNonce)).raw).toBeNull();
    current = nextScope;
    expect(
      await coordinator.acceptPreferencesEvidence({ ...snap(f, next.nonce), scope: nextScope }),
    ).toEqual({ state: "accepted" });
  });

  it.each([
    "retirement",
    "source",
    "pluginId",
    "generation",
    "hostEpoch",
    "processEpoch",
    "sourceKey",
  ] as const)(
    "does not admit raw evidence after %s changes during budget preflight",
    async (change) => {
      const f = await fixture(syntheticPreferencesImportDescriptor);
      const challenge = await f.coordinator.issuePreferences({
        descriptorId: f.descriptor.id,
        scope: f.scope,
      });
      let reached!: () => void, release!: () => void;
      const paused = new Promise<void>((r) => {
        reached = r;
      });
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const keys = f.backend.evidence.auxiliaryKeys;
      vi.spyOn(f.backend.evidence, "auxiliaryKeys").mockImplementationOnce(async (...args) => {
        reached();
        await gate;
        return keys(...args);
      });
      const result = f.coordinator
        .acceptPreferencesEvidence(snap(f, challenge.nonce))
        .catch((e) => e);
      await paused;
      const before = f.counts.reserve,
        originalOwner = { ...f.owner };
      if (change === "retirement") f.coordinator.retirePreferences(f.scope);
      else if (change === "source") f.setActive(false);
      else if (change === "generation") f.owner.generation++;
      else if (change === "hostEpoch" || change === "processEpoch") f.owner[change] = randomUUID();
      else f.owner[change] += "-replacement";
      release();
      const error = await result;
      Object.assign(f.owner, originalOwner);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("stale");
      expect(f.counts.reserve).toBe(before);
      expect((await nonceDoc(f, challenge.nonce)).raw).toBeNull();
    },
  );

  it.each(["import", "barrier"] as const)(
    "observes cancellation during final %s completion and preserves repair evidence",
    async (boundary) => {
      const f = await fixture(syntheticImportDescriptor),
        abort = new AbortController();
      if (boundary === "import") {
        const complete = f.backend.imports.complete;
        vi.spyOn(f.backend.imports, "complete").mockImplementation(async (...args) => {
          await complete(...args);
          abort.abort();
        });
      } else {
        const complete = f.barrier.complete;
        vi.spyOn(f.barrier, "complete").mockImplementation(async (...args) => {
          await complete(...args);
          abort.abort();
        });
      }
      const completeBarrier = vi.spyOn(f.barrier, "complete");
      expect(await f.coordinator.run(f.descriptor, abort.signal)).toEqual({
        state: "blocked",
        completedItems: 1,
        totalItems: 1,
      });
      expect((await f.saved())?.complete).toBe(true);
      if (boundary === "import") expect(completeBarrier).not.toHaveBeenCalled();
      expect((await f.coordinator.run(f.descriptor, signal())).state).toBe("complete");
      expect((await f.store.list(f.owner, { limit: 64 })).entries).toHaveLength(1);
    },
  );
});
