import { createHash, randomUUID } from "node:crypto";
import type { SettingsResourceV1, SettingsSnapshot, RecordMeta } from "@kobrixa/plugin-protocol";
import { mkdtemp, rm, mkdir, realpath, writeFile, unlink, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  startPersistenceWorker,
  PersistenceWorkerRequest,
  PersistenceWorkerResponse,
  type PersistenceFaultControl,
} from "./worker.js";
import { openStoreRoot, type PersistenceFaultPoint } from "./filesystem.js";
import type { PersistenceBackend, PublicationTicket, ImportPlan } from "./engine-port.js";
import { createRecordService } from "./record-service.js";
import { PersistenceFault } from "./record-port.js";
let directory: string, entry: string;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
beforeAll(async () => {
  directory = await realpath(await mkdtemp(path.join(tmpdir(), "persistence-worker-test-")));
  await mkdir(path.join(directory, "legacy", "sensor-lab"), { recursive: true });
  const workerPath = fileURLToPath(new URL("./worker.ts", import.meta.url)),
    fixturesPath = fileURLToPath(new URL("./import-fixtures.ts", import.meta.url));
  const fixtureEntry = path.join(directory, "worker-entry.ts");
  const filesystemPath = fileURLToPath(new URL("./filesystem.ts", import.meta.url));
  await writeFile(
    fixtureEntry,
    `import {runPersistenceWorker} from ${JSON.stringify(workerPath)};
      import {syntheticImportDescriptor,syntheticPreferencesImportDescriptor} from ${JSON.stringify(fixturesPath)};
      import {NodePersistenceFs} from ${JSON.stringify(filesystemPath)};
      import {existsSync,unlinkSync} from "node:fs";
      // Test-only fault injection: remove an enumerated child on real disk. All source
      // collection, messages, codecs, journals and subsequent reads remain native.
      const entries=NodePersistenceFs.prototype.entries;
      NodePersistenceFs.prototype.entries=async function(...args) {
        const result=await entries.apply(this,args);
        const trigger=${JSON.stringify(path.join(directory, "child-race.trigger"))};
        if(this.root===${JSON.stringify(path.join(directory, "legacy", "sensor-lab"))} && existsSync(trigger)) {
          unlinkSync(trigger);
          unlinkSync(this.root+"/22222222-2222-4222-8222-222222222222.json");
        }
        return result;
      };
      const unlink=NodePersistenceFs.prototype.unlink;
      NodePersistenceFs.prototype.unlink=async function(p) {
        if(existsSync(${JSON.stringify(path.join(directory, "cleanup-failure.trigger"))}) && this.name(p).endsWith("intent.json"))throw new Error("injected-cleanup");
        return unlink.call(this,p);
      };
      runPersistenceWorker({mappers:new Map([syntheticImportDescriptor,syntheticPreferencesImportDescriptor].map(d=>[d.id,d])),
        sourceRoots:new Map([[syntheticImportDescriptor.id,${JSON.stringify(path.join(directory, "legacy", "sensor-lab"))}]])});`,
  );
  await build({
    configFile: false,
    logLevel: "error",
    build: {
      target: "node24",
      outDir: path.join(directory, "bundle"),
      emptyOutDir: true,
      lib: { entry: fixtureEntry, formats: ["cjs"], fileName: () => "persistence-worker.cjs" },
      rollupOptions: { external: [/^node:/] },
      minify: false,
    },
  });
  entry = path.join(directory, "bundle", "persistence-worker.cjs");
}, 60000);
afterAll(async () => {
  if (!process.env.B2_NEGATIVE_EVIDENCE_DIR) await rm(directory, { recursive: true, force: true });
});
async function launch(userData: string) {
  await mkdir(userData, { recursive: true });
  const profile = { hostEpoch: randomUUID(), assertHeld() {} };
  const root = await openStoreRoot({ userData, profile });
  let control: PersistenceFaultControl | undefined;
  const started = await startPersistenceWorker({
    profile,
    root,
    workerEntry: entry,
    now: () => performance.now(),
    testControl: (c) => {
      control = c;
    },
  });
  return { ...started, profile, control: control! };
}
function make(owner: PublicationTicket["owner"], bytes: Uint8Array): PublicationTicket {
  const id = randomUUID();
  return {
    id: randomUUID(),
    owner,
    deadlineMonotonicMs: performance.now() + 120000,
    target: { kind: "record", id, expectedRevision: null },
    metadata: {
      kind: "record",
      deleted: false,
      record: {
        id,
        revision: "r_" + randomUUID().replaceAll("-", ""),
        kind: "test",
        schemaVersion: 1,
        label: "Worker",
        mediaType: "application/octet-stream",
        byteLength: bytes.length,
        sha256: hash(bytes),
        createdAt: 1,
        updatedAt: 1,
        checkpoint: "none",
        interrupted: false,
      },
    },
  };
}
const ownerFor = (epoch: string) => ({
  sourceKey: "builtin:kobrixa.lab",
  pluginId: "kobrixa.lab",
  generation: 1,
  hostEpoch: epoch,
  processEpoch: randomUUID(),
});
async function stage(backend: PersistenceBackend, t: PublicationTicket, bytes: Uint8Array) {
  await backend.engine.reserve(t, bytes.length);
  for (let n = 0; n < bytes.length; n += 262144)
    await backend.engine.append(t, n, bytes.subarray(n, n + 262144));
  await backend.engine.seal(t, bytes.length, hash(bytes));
}
it("preserves checksum, missing-record and read-quota failures through the real worker", async () => {
  const env = await launch(path.join(directory, randomUUID())),
    owner = ownerFor(env.profile.hostEpoch);
  const service = createRecordService({
    now: () => performance.now(),
    wall: Date.now,
    live: () => true,
    permission: () => true,
    engine: env.backend.engine,
    read: env.backend.reads,
    evidence: env.backend.evidence,
    checkpoint: {
      authorize: () => "none",
      committed() {},
      open: () => false,
      register: async () => {
        throw new Error("unused");
      },
      abandon: async () => {
        throw new Error("unused");
      },
    },
  });
  const principal = { kind: "plugin" as const, owner, authorityContext: null },
    signal = new AbortController().signal;
  try {
    const missing = await service.request(principal, "storage/stat", { id: randomUUID() }, signal);
    expect(missing).toMatchObject({
      ok: false,
      error: {
        code: "PLUGIN_E_STALE_RESOURCE",
        detail: { kind: "resource", reason: "stale", resource: "storage-read" },
      },
    });
    const bytes = Buffer.from("payload"),
      begin = await service.request(
        principal,
        "storage/beginWrite",
        {
          target: { mode: "create" },
          kind: "test",
          schemaVersion: 1,
          label: "Bad checksum",
          mediaType: "application/octet-stream",
          byteLength: bytes.length,
          sha256: hash(Buffer.from("different")),
        },
        signal,
      );
    expect(begin.ok).toBe(true);
    if (!begin.ok) throw new Error("begin failed");
    expect(
      (
        await service.request(
          principal,
          "storage/writeChunk",
          { write: begin.value.write, offset: 0, data: bytes.toString("base64") },
          signal,
        )
      ).ok,
    ).toBe(true);
    expect(
      await service.request(principal, "storage/sealWrite", { write: begin.value.write }, signal),
    ).toMatchObject({
      ok: false,
      error: {
        code: "PLUGIN_E_STORAGE_CONFLICT",
        detail: { kind: "persistence", reason: "checksum-mismatch" },
      },
    });
    expect(
      await service.request(principal, "storage/writeStatus", { write: begin.value.write }, signal),
    ).toMatchObject({ ok: true, value: { state: "failed" } });
    const t = make(owner, bytes);
    await stage(env.backend, t, bytes);
    await env.backend.engine.publish(t);
    if (t.metadata.kind !== "record") throw new Error("record required");
    const record = t.metadata.record,
      pins: string[] = [];
    for (let i = 0; i < 4; i++)
      pins.push(await env.backend.reads.open(owner, record.id, record.revision));
    try {
      const error = await env.backend.reads
        .open(owner, record.id, record.revision)
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(PersistenceFault);
      expect(error).toMatchObject({
        result: {
          ok: false,
          error: {
            code: "PLUGIN_E_RESOURCE_LIMIT",
            detail: { kind: "resource", reason: "quota", resource: "storage-read" },
          },
        },
      });
    } finally {
      for (const pin of pins) await env.backend.reads.close(owner, pin);
    }
  } finally {
    await service.close();
    await env.backend.dispose();
  }
});
it("rejects malformed private messages and missing capabilities", async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "malformed-worker-")));
  try {
    expect(
      PersistenceWorkerRequest.safeParse({ version: 1, id: 1, operation: "engine.fence", args: [] })
        .success,
    ).toBe(false);
    expect(
      PersistenceWorkerRequest.safeParse({
        version: 1,
        id: 1,
        operation: "reads.settings",
        args: [{ sourceKey: "forged" }],
      }).success,
    ).toBe(false);
    expect(
      PersistenceWorkerResponse.safeParse({
        version: 1,
        id: 1,
        ok: false,
        error: { code: "io", message: "io", path: "private" },
      }).success,
    ).toBe(false);
    await expect(
      openStoreRoot({
        userData: directory,
        profile: {
          hostEpoch: randomUUID(),
          assertHeld() {
            throw new Error("not-primary");
          },
        },
      }),
    ).rejects.toThrow("not-primary");
    await expect(
      startPersistenceWorker({
        profile: { hostEpoch: randomUUID(), assertHeld() {} },
        root: {} as never,
        workerEntry: path.join(directory, "unused.cjs"),
        now: () => 0,
      }),
    ).rejects.toThrow("unsafe-root");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("preserves exact opaque bytes, scoped barriers and one idempotent disposal", async () => {
  const env = await launch(path.join(directory, randomUUID())),
    bytes = new Uint8Array([0, 255, 123, 0, 10]),
    owner = ownerFor(env.profile.hostEpoch),
    t = make(owner, bytes);
  expect(persistenceWorkerCount(env.backend)).toBe(1);
  await stage(env.backend, t, bytes);
  const incomplete = env.backend.evidence.capture(
    { kind: "namespace", owner },
    performance.now() + 10000,
  );
  expect(env.backend.evidence.tickets(incomplete)).toEqual([t]);
  expect((await env.backend.evidence.flush(incomplete)).state).toBe("failed");
  expect(() => env.backend.evidence.tickets(incomplete)).toThrow("stale");
  const barrier = env.backend.evidence.capture(
    { kind: "namespace", owner },
    performance.now() + 10000,
  );
  const committed = await env.backend.engine.publish(t);
  expect(committed.disposition).toBe("committed");
  const id = t.target.kind === "record" ? t.target.id : "",
    meta = await env.backend.reads.stat(owner, id);
  expect([meta.byteLength, meta.sha256]).toEqual([bytes.length, hash(bytes)]);
  const pin = await env.backend.reads.open(owner, id, meta.revision);
  expect(await env.backend.reads.read(owner, pin, 0, 256)).toEqual(bytes);
  await env.backend.reads.close(owner, pin);
  const late = make(owner, bytes);
  await env.backend.engine.reserve(late, bytes.length);
  expect(env.backend.evidence.tickets(barrier)).toEqual([t]);
  expect((await env.backend.evidence.flush(barrier)).state).toBe("saved");
  await env.backend.engine.abort(late);
  const one = env.backend.dispose();
  expect(env.backend.dispose()).toBe(one);
  expect(persistenceWorkerCount(env.backend)).toBe(1);
  await one;
  expect(persistenceWorkerCount(env.backend)).toBe(0);
});
const points: PersistenceFaultPoint[] = [
  "reserve",
  "open-temp",
  "chunk-write",
  "seal-sync",
  "object-rename",
  "object-dir-sync",
  "backup-head",
  "head-write",
  "before-publish",
  "after-publish",
  "head-dir-sync",
  "cache-publish",
  "receipt-send",
  "cleanup",
  "import-marker",
];
for (const point of points)
  it(`real worker kill at ${point}`, async () => {
    const userData = path.join(directory, randomUUID()),
      env = await launch(userData),
      owner = ownerFor(env.profile.hostEpoch),
      bytes = Buffer.from(JSON.stringify({ formatVersion: 1, value: 1 }));
    const target = { kind: "import" as const, key: "fault-matrix" };
    const ticket = (): PublicationTicket => ({
      id: randomUUID(),
      owner,
      deadlineMonotonicMs: performance.now() + 120000,
      target,
      metadata: target,
    });
    const old = ticket();
    await stage(env.backend, old, bytes);
    await env.backend.engine.publish(old);
    env.control.arm(point, "pause");
    const reached = env.control.reached(point),
      next = ticket();
    const pending = stage(env.backend, next, bytes)
      .then(() => env.backend.engine.publish(next))
      .catch(() => null);
    await reached;
    expect(persistenceWorkerCount(env.backend)).toBe(1);
    await env.control.terminate();
    expect(persistenceWorkerCount(env.backend)).toBe(0);
    await pending;
    for (let attempt = 0; attempt < 3; attempt++) {
      const reopened = await launch(userData);
      try {
        expect(reopened.recovery).toBe("ready");
        expect(
          await reopened.backend.evidence.auxiliary(
            ownerFor(reopened.profile.hostEpoch),
            "import",
            "fault-matrix",
          ),
        ).toEqual(Uint8Array.from(bytes));
      } finally {
        await reopened.backend.dispose();
      }
    }
  }, 30000);
it("kill after imported head before receipt reconciles original ticket without new IDs", async () => {
  const userData = path.join(directory, randomUUID()),
    env = await launch(userData),
    owner = ownerFor(env.profile.hostEpoch),
    bytes = new Uint8Array([7, 0, 255]);
  const id =
    "import/" + hash(Buffer.from(JSON.stringify(["test.synthetic-import", owner.sourceKey])));
  const t = make(owner, bytes),
    tag = { importId: id, itemKey: "item", sourceSha256: hash(bytes) },
    skipTicket = make(owner, bytes);
  const plan: ImportPlan = {
    formatVersion: 1,
    id,
    descriptorId: "test.synthetic-import",
    preferencesEvidence: null,
    mappingVersion: 1,
    targetSourceKey: owner.sourceKey,
    items: [
      {
        key: "item",
        sourceFormat: 1,
        sourceSha256: hash(bytes),
        mappedSha256: hash(bytes),
        byteLength: bytes.length,
        ticket: t,
        tag,
      },
      {
        key: "skip",
        sourceFormat: 1,
        sourceSha256: hash(bytes),
        mappedSha256: hash(bytes),
        byteLength: bytes.length,
        ticket: skipTicket,
        tag: { ...tag, itemKey: "skip" },
      },
    ],
  };
  await env.backend.imports.plan(owner, plan);
  await env.backend.imports.record(owner, id, {
    key: "skip",
    state: "skipped",
    receipt: null,
    skipReason: "already-new",
    publicationTicket: null,
  });
  await expect(env.backend.imports.complete(owner, id)).rejects.toThrow();
  const publication = await env.backend.imports.admit(owner, id, "item");
  await env.backend.engine.reserve(publication, bytes.length);
  await env.backend.imports.tagImport(publication, tag);
  await env.backend.engine.append(publication, 0, bytes);
  await env.backend.engine.seal(publication, bytes.length, hash(bytes));
  env.control.arm("after-publish", "pause");
  const reached = env.control.reached("after-publish");
  const pending = env.backend.engine.publish(publication).catch(() => null);
  await reached;
  expect(persistenceWorkerCount(env.backend)).toBe(1);
  await env.control.terminate();
  expect(persistenceWorkerCount(env.backend)).toBe(0);
  await pending;
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = await launch(userData),
      current = ownerFor(next.profile.hostEpoch),
      saved = await next.backend.imports.load(current, id);
    expect(current.hostEpoch).not.toBe(owner.hostEpoch);
    await expect(next.backend.engine.reserve(t, bytes.length)).rejects.toThrow();
    expect(saved?.plan).toEqual(plan);
    expect(saved?.items[1]?.skipReason).toBe("already-new");
    expect((await next.backend.imports.reconcile(t)).disposition).toBe("committed");
    const receipts = await next.backend.imports.importReceipts(current, id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.ticket.id).toBe(publication.id);
    await next.backend.imports.complete(current, id);
    expect((await next.backend.imports.load(current, id))?.complete).toBe(true);
    expect((await next.backend.reads.list(current, { limit: 64 })).entries).toHaveLength(1);
    await next.backend.dispose();
  }
}, 30000);

import { snapshotBytes, snapshotDigest, type LegacyNonceDocument } from "./import-sources.js";
it("resolves a consumed nonce after host change without a renderer or filesystem fallback", async () => {
  const { syntheticPreferencesImportDescriptor } = await import("./import-fixtures.js");
  const userData = path.join(directory, randomUUID()),
    first = await launch(userData),
    d = syntheticPreferencesImportDescriptor;
  const owner = {
    ...ownerFor(first.profile.hostEpoch),
    sourceKey: d.targetSourceKey,
    pluginId: d.id,
  };
  const nonce = randomUUID(),
    scope = { hostEpoch: owner.hostEpoch, workbenchInstance: randomUUID() },
    raw = { nonce, scope, entries: [{ key: "test.preference", raw: null }] };
  const key = "nonce/" + nonce,
    ticket: PublicationTicket = {
      id: randomUUID(),
      owner,
      deadlineMonotonicMs: performance.now() + 10000,
      target: { kind: "import", key },
      metadata: { kind: "import", key },
    };
  const digest = snapshotDigest(raw, d.rendererKeyAllowlist!),
    document: LegacyNonceDocument = {
      formatVersion: 1,
      kind: "nonce",
      descriptorId: d.id,
      sourceKey: d.targetSourceKey,
      nonce,
      scope,
      allowlist: [...d.rendererKeyAllowlist!],
      state: "consumed",
      raw,
      digest,
      originalTicket: ticket,
      ticket,
    };
  await stage(first.backend, ticket, Buffer.from(JSON.stringify(document)));
  expect((await first.backend.engine.publish(ticket)).disposition).toBe("committed");
  await first.backend.dispose();
  const second = await launch(userData),
    current = {
      ...ownerFor(second.profile.hostEpoch),
      sourceKey: d.targetSourceKey,
      pluginId: d.id,
    };
  expect(current.hostEpoch).not.toBe(owner.hostEpoch);
  await second.backend.sources.register({
    descriptorId: d.id,
    mapperId: d.id,
    sourceKind: d.sourceKind,
  });
  expect((await second.backend.sources.inventory(d.id)).state).toBe("blocked");
  await expect(second.backend.sources.map(d.id, "preferences")).rejects.toThrow();
  await second.backend.sources.resolvePreferences({
    descriptorId: d.id,
    owner: current,
    evidence: { nonce, digest },
  });
  const expected = snapshotBytes(raw, d.rendererKeyAllowlist!);
  expect(await second.backend.sources.inventory(d.id)).toEqual({
    state: "present",
    entries: [{ key: "preferences", format: 1, byteLength: expected.length, sha256: digest }],
  });
  expect(await second.backend.sources.read(d.id, "preferences", 0, 262144)).toEqual(expected);
  const mapped = await second.backend.sources.map(d.id, "preferences");
  expect(mapped.sourceSha256).toBe(digest);
  expect(mapped.mappedSha256).toBe(digest);
  expect(mapped.byteLength).toBe(expected.length);
  await second.backend.sources.releaseMapped(mapped.mapped);
  await expect(
    second.backend.sources.resolvePreferences({
      descriptorId: d.id,
      owner: current,
      evidence: { nonce: randomUUID(), digest },
    }),
  ).rejects.toThrow();
  await expect(second.backend.sources.read(d.id, "preferences", 0, 262145)).rejects.toThrow();
  await second.backend.dispose();
}, 30000);
it("strictly validates both new private tuples", () => {
  const owner = ownerFor(randomUUID()),
    nonce = randomUUID(),
    digest = "0".repeat(64);
  const valid = [
    { operation: "imports.admit", args: [owner, "import/" + digest, "item"] },
    {
      operation: "sources.resolvePreferences",
      args: [{ descriptorId: "test.synthetic-preferences", owner, evidence: { nonce, digest } }],
    },
  ];
  for (const request of valid) {
    expect(PersistenceWorkerRequest.safeParse({ version: 1, id: 1, ...request }).success).toBe(
      true,
    );
    expect(
      PersistenceWorkerRequest.safeParse({
        version: 1,
        id: 1,
        ...request,
        args: [...request.args, "extra"],
      }).success,
    ).toBe(false);
  }
  for (const evidence of [
    { nonce, digest, raw: [] },
    { nonce, digest, path: "/tmp/source" },
    { nonce: "bad", digest },
    { nonce, digest: "bad" },
    { nonce, digest, map() {} },
  ])
    expect(
      PersistenceWorkerRequest.safeParse({
        version: 1,
        id: 1,
        operation: "sources.resolvePreferences",
        args: [{ descriptorId: "test.synthetic-preferences", owner, evidence }],
      }).success,
    ).toBe(false);
});
import { WorkerSources, persistenceWorkerCount } from "./worker.js";
import { AtomicStore } from "./atomic-store.js";
import { createNodePersistenceFs } from "./filesystem.js";
import type { LegacyImportDescriptor } from "./import-sources.js";
it("sourceRoots rejects unknown, renderer, relative and conflicting roots before ready", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "sources-")));
  try {
    const fs = await createNodePersistenceFs(root, { hostEpoch: randomUUID(), assertHeld() {} }),
      store = new AtomicStore(fs);
    const descriptor: LegacyImportDescriptor = {
      id: "test.file",
      mappingVersion: 1,
      targetSourceKey: "builtin:kobrixa.lab",
      sourceKind: "sensor-lab",
      sourceFormatVersions: [1],
      targetRecordSchemaVersions: [1],
      validate: () => true,
      map: () => {
        throw new Error("unused");
      },
    };
    const renderer = {
        ...descriptor,
        id: "test.renderer",
        sourceKind: "renderer-preferences" as const,
      },
      other = { ...descriptor, id: "test.other" },
      mappers = new Map([descriptor, renderer, other].map((d) => [d.id, d]));
    for (const roots of [
      new Map([["unknown", root]]),
      new Map([[renderer.id, root]]),
      new Map([[descriptor.id, "relative"]]),
      new Map([[descriptor.id, path.join(root, "..", "bad") + "/../bad"]]),
      new Map([
        [descriptor.id, root],
        [other.id, root],
      ]),
    ])
      expect(() => new WorkerSources(fs.root, store, mappers, roots)).toThrow();
    const sources = new WorkerSources(fs.root, store, mappers, new Map([[descriptor.id, root]]));
    await sources.validateRoots();
    await sources.register({
      descriptorId: descriptor.id,
      mapperId: descriptor.id,
      sourceKind: descriptor.sourceKind,
    });
    await expect(
      sources.register({
        descriptorId: descriptor.id,
        mapperId: other.id,
        sourceKind: descriptor.sourceKind,
      }),
    ).rejects.toThrow();
    await sources.register({
      descriptorId: renderer.id,
      mapperId: renderer.id,
      sourceKind: renderer.sourceKind,
    });
    expect(await sources.inventory(renderer.id)).toEqual({ state: "blocked", entries: [] });
    await expect(sources.read(renderer.id, "preferences", 0, 1)).rejects.toThrow(
      "missing-evidence",
    );
    await expect(sources.map(renderer.id, "preferences")).rejects.toThrow("missing-evidence");
    await store.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("persistenceWorkerCount rejects objects that are not registered backends", () => {
  expect(() => persistenceWorkerCount({} as PersistenceBackend)).toThrow("unknown-instance");
});
it("accepts finite fractional monotonic deadlines without relaxing integer counters", () => {
  const owner = ownerFor(randomUUID()),
    t = { ...make(owner, new Uint8Array()), deadlineMonotonicMs: 1234.5 };
  expect(
    PersistenceWorkerRequest.safeParse({
      version: 1,
      id: 1,
      operation: "engine.reserve",
      args: [t, 0],
      gate: { slot: 0, sequence: 1 },
    }).success,
  ).toBe(true);
  expect(
    PersistenceWorkerRequest.safeParse({
      version: 1,
      id: 1.5,
      operation: "engine.reserve",
      args: [t, 0],
      gate: { slot: 0, sequence: 1 },
    }).success,
  ).toBe(false);
});

async function mappedSetup(options: { hash?: string; schema?: number; large?: boolean } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "mapped-source-")));
  const profile = { hostEpoch: randomUUID(), assertHeld() {} },
    fs = await createNodePersistenceFs(root, profile, { now: () => 0 }),
    store = new AtomicStore(fs);
  const legacy = path.join(root, "legacy");
  await mkdir(legacy);
  await writeFile(path.join(legacy, "item"), '{"formatVersion":1}');
  const payload = new Uint8Array(options.large ? 262145 : 3).fill(7),
    owner = ownerFor(profile.hostEpoch),
    original = make(owner, payload);
  if (original.metadata.kind !== "record") throw new Error("test-target");
  if (options.hash) original.metadata.record.sha256 = options.hash;
  const descriptor: LegacyImportDescriptor = {
    id: "test.mapped",
    mappingVersion: 1,
    targetSourceKey: owner.sourceKey,
    sourceKind: "sensor-lab",
    sourceFormatVersions: [1],
    targetRecordSchemaVersions: [1],
    validate: () => true,
    map: () => ({
      kind: "record",
      bytes: payload,
      metadata: {
        kind: "test",
        schemaVersion: options.schema ?? 1,
        label: "Mapped",
        mediaType: "application/octet-stream",
        byteLength: payload.length,
        sha256: hash(payload),
      },
    }),
  };
  const sources = new WorkerSources(
    fs.root,
    store,
    new Map([[descriptor.id, descriptor]]),
    new Map([[descriptor.id, legacy]]),
  );
  await sources.validateRoots();
  await sources.register({
    descriptorId: descriptor.id,
    mapperId: descriptor.id,
    sourceKind: descriptor.sourceKind,
  });
  const mapped = await sources.map(descriptor.id, "item"),
    id = "import/" + hash(Buffer.from(JSON.stringify([descriptor.id, owner.sourceKey]))),
    tag = { importId: id, itemKey: "item", sourceSha256: mapped.sourceSha256 };
  const plan: ImportPlan = {
    formatVersion: 1,
    id,
    descriptorId: descriptor.id,
    preferencesEvidence: null,
    mappingVersion: 1,
    targetSourceKey: owner.sourceKey,
    items: [
      {
        key: "item",
        sourceFormat: 1,
        sourceSha256: mapped.sourceSha256,
        mappedSha256: options.hash ?? mapped.mappedSha256,
        byteLength: payload.length,
        ticket: original,
        tag,
      },
    ],
  };
  await store.planImport(owner, plan);
  const attempt = await store.admitImport(owner, id, "item");
  await store.reserve(attempt, payload.length);
  return {
    sources,
    store,
    mapped,
    attempt,
    tag,
    payload,
    close: async () => {
      await store.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}
it("appendMapped requires the matching tag before the first byte", async () => {
  const env = await mappedSetup();
  try {
    await expect(
      env.sources.appendMapped({
        mapped: env.mapped.mapped,
        ticket: env.attempt,
        offset: 0,
        maxBytes: 262144,
      }),
    ).rejects.toThrow("input-changed");
    await env.store.tagImport(env.attempt, env.tag);
    expect(
      await env.sources.appendMapped({
        mapped: env.mapped.mapped,
        ticket: env.attempt,
        offset: 0,
        maxBytes: 262144,
      }),
    ).toEqual({ nextOffset: 3, done: true });
  } finally {
    await env.close();
  }
});
it("file mapping binds attempt, sequential offset, bounded chunks and unresolved release", async () => {
  const env = await mappedSetup({ large: true });
  try {
    await env.store.tagImport(env.attempt, env.tag);
    const input = { mapped: env.mapped.mapped, ticket: env.attempt, offset: 0, maxBytes: 262144 };
    for (const invalid of [
      { ...input, ticket: { ...env.attempt, id: randomUUID() } },
      { ...input, offset: 1 },
      { ...input, maxBytes: 262145 },
    ])
      await expect(env.sources.appendMapped(invalid)).rejects.toThrow();
    expect(await env.sources.appendMapped(input)).toEqual({ nextOffset: 262144, done: false });
    expect(await env.sources.appendMapped({ ...input, offset: 262144 })).toEqual({
      nextOffset: 262145,
      done: true,
    });
    await env.store.seal(env.attempt, env.payload.length, hash(env.payload));
    const replace = env.store.fs.atomicReplace.bind(env.store.fs);
    let resume!: () => void, entered!: () => void;
    const reached = new Promise<void>((r) => {
        entered = r;
      }),
      release = new Promise<void>((r) => {
        resume = r;
      });
    env.store.fs.atomicReplace = async (a, b) => {
      if (env.store.fs.name(b).endsWith("head.json")) {
        entered();
        await release;
      }
      return replace(a, b);
    };
    const publish = env.store.publish(env.attempt);
    await reached;
    try {
      await expect(env.sources.releaseMapped(env.mapped.mapped)).rejects.toThrow(
        "publish-uncertain",
      );
    } finally {
      resume();
    }
    expect((await publish).disposition).toBe("committed");
    await env.sources.releaseMapped(env.mapped.mapped);
    await expect(env.sources.appendMapped(input)).rejects.toThrow("stale");
  } finally {
    await env.close();
  }
});
it.each([{ hash: "0".repeat(64) }, { schema: 2 }])(
  "rejects mismatched plan hash or schema %j",
  async (options) => {
    const env = await mappedSetup(options);
    try {
      await env.store.tagImport(env.attempt, env.tag);
      await expect(
        env.sources.appendMapped({
          mapped: env.mapped.mapped,
          ticket: env.attempt,
          offset: 0,
          maxBytes: 262144,
        }),
      ).rejects.toThrow("input-changed");
    } finally {
      await env.close();
    }
  },
);
it("T5 private continuations require original ticket, exact grant and a bound reserve gate", () => {
  const owner = ownerFor(randomUUID()),
    t = make(owner, new Uint8Array([1]));
  const grant = {
    owner,
    recordId: t.target.kind === "record" ? t.target.id : randomUUID(),
    checkpoint: randomUUID(),
    token: randomUUID(),
    deadlineMonotonicMs: performance.now() + 1000,
  };
  const request = {
    version: 1,
    id: 1,
    operation: "engine.reserveFinal",
    args: [t, 1, grant],
    gate: { slot: 0, sequence: 1 },
  };
  expect(PersistenceWorkerRequest.safeParse(request).success).toBe(true);
  expect(PersistenceWorkerRequest.safeParse({ ...request, gate: undefined }).success).toBe(false);
  expect(
    PersistenceWorkerRequest.safeParse({
      ...request,
      args: [t, 1, { ...grant, invocation: "forged" }],
    }).success,
  ).toBe(false);
  expect(
    PersistenceWorkerRequest.safeParse({
      version: 1,
      id: 2,
      operation: "engine.publishRecovery",
      args: [t, randomUUID(), performance.now() + 1000],
    }).success,
  ).toBe(true);
  expect(
    PersistenceWorkerRequest.safeParse({
      version: 1,
      id: 3,
      operation: "evidence.retainSealed",
      args: [t],
    }).success,
  ).toBe(true);
  expect(
    PersistenceWorkerRequest.safeParse({
      version: 1,
      id: 4,
      operation: "engine.publishRecovery",
      args: [t, "fabricated", performance.now() + 1000],
    }).success,
  ).toBe(false);
});

import { createLegacyImportCoordinator } from "./import-coordinator.js";
import { createLegacyWriterBarrier, importIdFor } from "./import-sources.js";
import { syntheticImportDescriptor } from "./import-fixtures.js";
it("T6 fix round1 child ENOENT blocks actual-worker import and retry imports the survivor", async () => {
  const sourceRoot = path.join(directory, "legacy", "sensor-lab"),
    survivor = "11111111-1111-4111-8111-111111111111.json",
    lost = "22222222-2222-4222-8222-222222222222.json",
    bytes = Buffer.from(JSON.stringify({ formatVersion: 1, value: "survivor" }));
  await writeFile(path.join(sourceRoot, survivor), bytes);
  await writeFile(
    path.join(sourceRoot, lost),
    Buffer.from(JSON.stringify({ formatVersion: 1, value: "lost" })),
  );
  const env = await launch(path.join(directory, randomUUID())),
    d = syntheticImportDescriptor,
    owner = { ...ownerFor(env.profile.hostEpoch), sourceKey: d.targetSourceKey, pluginId: d.id };
  const barrier = createLegacyWriterBarrier({
    backend: env.backend,
    descriptors: [d],
    writers: [],
    importOwner: () => owner,
  });
  const coordinator = createLegacyImportCoordinator({
    backend: env.backend,
    sources: env.backend.sources,
    barrier,
    descriptors: [d],
    currentScope: () => true,
    currentSource: () => true,
    importOwner: () => owner,
  });
  try {
    await writeFile(path.join(directory, "child-race.trigger"), "");
    expect(await coordinator.run(d, new AbortController().signal)).toEqual({
      state: "blocked",
      completedItems: 0,
      totalItems: 0,
    });
    expect(await env.backend.imports.load(owner, importIdFor(d.id, d.targetSourceKey))).toBeNull();
    expect((await env.backend.sources.inventory(d.id)).entries.map((e) => e.key)).toEqual([
      survivor,
    ]);
    expect(await coordinator.run(d, new AbortController().signal)).toEqual({
      state: "complete",
      completedItems: 1,
      totalItems: 1,
    });
    const saved = await env.backend.imports.load(owner, importIdFor(d.id, d.targetSourceKey));
    expect(saved?.plan.items.map((i) => i.key)).toEqual([survivor]);
    const records = await env.backend.reads.list(owner, { limit: 64 });
    expect(records.entries).toHaveLength(1);
    expect(records.entries[0]?.sha256).toBe(hash(bytes));
    // Only a subsequent conclusive check of the fixed root may report absent.
    await rm(sourceRoot, { recursive: true });
    expect(await env.backend.sources.inventory(d.id)).toEqual({ state: "absent", entries: [] });
  } finally {
    await env.backend.dispose();
    await rm(sourceRoot, { recursive: true, force: true });
    await mkdir(sourceRoot, { recursive: true });
    await rm(path.join(directory, "child-race.trigger"), { force: true });
  }
}, 30000);

it("settings saved by the service reopen through the real worker with CAS, reset and migration", async () => {
  const { createSettingsService } = await import("./settings-service.js");
  const userData = path.join(directory, randomUUID());
  let resource: SettingsResourceV1 = {
    schemaVersion: 1,
    title: { en: "Settings" },
    fields: [{ key: "enabled", type: "boolean", label: { en: "Enabled" }, default: true }],
  };
  let validationDigest = "a".repeat(64);
  const setup = (env: Awaited<ReturnType<typeof launch>>) => {
    const owner = ownerFor(env.profile.hostEpoch);
    const service = createSettingsService({
      now: () => performance.now(),
      allowed: () => true,
      readResource: async () => ({ resource, digest: "b".repeat(64), validationDigest }),
      validateResource: () => true,
      evidence: env.backend.evidence,
      read: env.backend.reads,
      engine: env.backend.engine,
      watch: { register: () => randomUUID(), changed: () => {}, invalidate: () => {} },
    });
    return {
      owner,
      service,
      principal: { kind: "plugin" as const, owner, authorityContext: null },
    };
  };
  const signal = () => new AbortController().signal;
  const first = await launch(userData);
  let savedRevision: string;
  try {
    const f = setup(first);
    const saved = await f.service.request(
      f.principal,
      "settings/update",
      {
        schemaVersion: 1,
        expectedRevision: null,
        changes: [{ key: "enabled", value: false }],
      },
      signal(),
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error("save failed");
    savedRevision = saved.value.snapshot.revision!;
    expect(
      await f.service.request(f.principal, "settings/read", { schemaVersion: 1 }, signal()),
    ).toEqual({ ok: true, value: saved.value.snapshot });
    expect(await first.backend.reads.settings(f.owner)).toEqual(saved.value.snapshot);
  } finally {
    await first.backend.dispose();
  }
  const second = await launch(userData);
  try {
    expect(second.profile.hostEpoch).not.toBe(first.profile.hostEpoch);
    const f = setup(second);
    expect(
      await f.service.request(f.principal, "settings/read", { schemaVersion: 1 }, signal()),
    ).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        revision: savedRevision!,
        values: [{ key: "enabled", value: false }],
      },
    });
    expect(
      await f.service.request(
        f.principal,
        "settings/update",
        {
          schemaVersion: 1,
          expectedRevision: null,
          changes: [{ key: "enabled", value: true }],
        },
        signal(),
      ),
    ).toMatchObject({ ok: false, error: { code: "PLUGIN_E_SETTINGS_CONFLICT" } });
    const reset = await f.service.request(
      f.principal,
      "settings/reset",
      {
        schemaVersion: 1,
        expectedRevision: savedRevision!,
        keys: ["enabled"],
      },
      signal(),
    );
    expect(reset.ok).toBe(true);
    if (!reset.ok) throw new Error("reset failed");
    expect(await second.backend.reads.settings(f.owner)).toEqual(reset.value.snapshot);
    resource = { ...resource, schemaVersion: 2 };
    validationDigest = "c".repeat(64);
    const migrated = await f.service.request(
      f.principal,
      "settings/migrate",
      {
        fromSchemaVersion: 1,
        schemaVersion: 2,
        expectedRevision: reset.value.receipt.revision,
        values: [{ key: "enabled", value: false }],
      },
      signal(),
    );
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) throw new Error("migration failed");
    expect(await second.backend.reads.settings(f.owner)).toEqual(migrated.value.snapshot);
    expect(await second.backend.evidence.settingsDigest(f.owner)).toMatchObject({
      schemaVersion: 2,
      validationDigest,
    });
  } finally {
    await second.backend.dispose();
  }
});

it("preserves denied admission errors and cleanup through the real worker after unknown publication", async () => {
  const env = await launch(path.join(directory, randomUUID())),
    owner = ownerFor(env.profile.hostEpoch),
    bytes = Buffer.from("payload");
  const service = createRecordService({
    now: () => performance.now(),
    wall: Date.now,
    live: () => true,
    permission: () => true,
    engine: env.backend.engine,
    read: env.backend.reads,
    evidence: env.backend.evidence,
    checkpoint: {
      authorize: () => "none",
      committed() {},
      open: () => false,
      register: async () => {
        throw new Error("unused");
      },
      abandon: async () => {
        throw new Error("unused");
      },
    },
  });
  const principal = { kind: "plugin" as const, owner, authorityContext: null },
    signal = new AbortController().signal;
  const t = make(owner, bytes);
  try {
    await stage(env.backend, t, bytes);
    env.control.arm("after-publish", "fail");
    expect(await env.backend.engine.publish(t)).toEqual({ disposition: "unknown" });
    const quota = await env.backend.evidence.quota(owner),
      denied = make(owner, bytes);
    await expect(env.backend.engine.reserve(denied, bytes.length)).rejects.toThrow(
      "publish-uncertain",
    );
    await expect(
      env.backend.engine.abort({ ...denied, owner: { ...owner, processEpoch: randomUUID() } }),
    ).rejects.toThrow("stale");
    const input = {
      target: { mode: "create" as const },
      kind: "test",
      schemaVersion: 1,
      label: "Denied",
      mediaType: "application/octet-stream" as const,
      byteLength: bytes.length,
      sha256: hash(bytes),
    };
    for (let i = 0; i < 3; i++) {
      expect(await service.request(principal, "storage/beginWrite", input, signal)).toMatchObject({
        ok: false,
        error: { detail: { reason: "publish-uncertain" } },
      });
      expect(service.admittedWrites(owner)).toEqual([]);
    }
    const scope = { kind: "namespace" as const, owner };
    const ordinary = env.backend.evidence.capture(scope, performance.now() + 10000);
    const uncertain = env.backend.evidence.captureDrain!(scope, performance.now() + 10000);
    expect(env.backend.evidence.tickets(uncertain)).toContainEqual(t);
    expect(await env.backend.engine.abort(denied)).toBe("aborted");
    expect(await env.backend.engine.abort(denied)).toBe("aborted");
    await expect(env.backend.engine.reserve(denied, bytes.length)).rejects.toThrow("stale");
    await expect(env.backend.engine.append(denied, 0, bytes)).rejects.toThrow("stale");
    await expect(env.backend.engine.publish(denied)).rejects.toThrow("stale");
    expect(await env.backend.evidence.quota(owner)).toEqual(quota);
    expect(env.control.trace().filter((e) => e.point === "open-temp")).toHaveLength(1);
    expect((await env.backend.engine.reconcile(t)).disposition).toBe("committed");
    expect(await env.backend.engine.abort(t)).toBe("committed");
    expect(env.backend.evidence.tickets(ordinary)).toContainEqual(denied);
    expect(await env.backend.evidence.flush(ordinary)).toMatchObject({
      state: "failed",
      incomplete: expect.arrayContaining([denied.id]),
    });
    const clean = env.backend.evidence.captureDrain!(scope, performance.now() + 10000);
    expect(env.backend.evidence.tickets(clean)).toEqual([t]);
    expect(await env.backend.evidence.flush(clean)).toMatchObject({
      state: "saved",
      incomplete: [],
      unknown: [],
    });
    expect(await env.backend.evidence.flush(uncertain)).toMatchObject({ state: "saved" });
    const begun = await service.request(principal, "storage/beginWrite", input, signal);
    expect(begun.ok).toBe(true);
    for (const write of service.admittedWrites(owner))
      expect(await env.backend.engine.abort(write.ticket)).toBe("aborted");
    const incomplete = env.backend.evidence.captureDrain!(scope, performance.now() + 10000);
    expect(await env.backend.evidence.flush(incomplete)).toMatchObject({
      state: "failed",
      incomplete: expect.arrayContaining(service.admittedWrites(owner).map((w) => w.ticket.id)),
    });
  } finally {
    await env.backend.engine.reconcile(t);
    await service.close();
    await env.backend.dispose();
  }
});

import { createPersistenceHost } from "./host-port.js";
async function hostFor(env: Awaited<ReturnType<typeof launch>>, owner: PublicationTicket["owner"]) {
  const fail = () => {
    throw new Error("Unexpected I/O");
  };
  const dispatchDrain = async () => ({
    ok: true as const,
    value: { status: "checkpoint-only" as const, writes: [] },
  });
  const host = await createPersistenceHost({
    profile: env.profile,
    now: () => performance.now(),
    hasPermission: () => true,
    composition: {
      backend: env.backend,
      sources: { current: () => true, settings: async () => null, coreOwner: () => owner },
      dispatchDrain,
      events: {
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
        onRemoved: () => () => {},
      },
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
  });
  return { host, dispatchDrain };
}
it("real host drains rejected-clean attempts without source recovery after reconciliation and reload", async () => {
  const userData = path.join(directory, randomUUID()),
    env = await launch(userData),
    owner = ownerFor(env.profile.hostEpoch),
    bytes = Buffer.from("payload");
  const { host, dispatchDrain } = await hostFor(env, owner);
  try {
    const original = make(owner, bytes);
    await stage(env.backend, original, bytes);
    env.control.arm("after-publish", "fail");
    expect(await env.backend.engine.publish(original)).toEqual({ disposition: "unknown" });
    const denied = make(owner, bytes);
    await expect(env.backend.engine.reserve(denied, bytes.length)).rejects.toThrow(
      "publish-uncertain",
    );
    expect(await env.backend.engine.abort(denied)).toBe("aborted");
    expect((await env.backend.engine.reconcile(original)).disposition).toBe("committed");
    const second = make(owner, bytes);
    await stage(env.backend, second, bytes);
    expect((await env.backend.engine.publish(second)).disposition).toBe("committed");
    for (const current of [owner, { ...owner, generation: 2, processEpoch: randomUUID() }]) {
      const offer = host.participant.freeze(current, "disable", performance.now() + 10000);
      expect(await host.participant.drain(offer, dispatchDrain)).toMatchObject({
        state: "saved",
        blocker: false,
        records: [],
      });
      expect(host.recovery.snapshot().items).toEqual([]);
    }
    expect((await env.backend.evidence.recoveryPage()).items).toEqual([]);
    await expect(env.backend.engine.reserve(denied, bytes.length)).rejects.toThrow("stale");
  } finally {
    await host.dispose();
  }
  expect(persistenceWorkerCount(env.backend)).toBe(0);
  const reopened = await launch(userData),
    nextOwner = ownerFor(reopened.profile.hostEpoch),
    next = await hostFor(reopened, nextOwner);
  try {
    expect(next.host.recovery.snapshot().items).toEqual([]);
  } finally {
    await next.host.dispose();
  }
  expect(persistenceWorkerCount(reopened.backend)).toBe(0);
});
it("drain keeps unknown publication and unconfirmed abort, then admitted aborted work", async () => {
  const env = await launch(path.join(directory, randomUUID())),
    owner = ownerFor(env.profile.hostEpoch),
    bytes = Buffer.from("payload"),
    t = make(owner, bytes);
  let publication: Promise<unknown> | undefined;
  try {
    await stage(env.backend, t, bytes);
    env.control.arm("after-publish", "pause");
    const reached = env.control.reached("after-publish");
    publication = env.backend.engine.publish(t);
    await reached;
    expect(await env.backend.engine.abort(t)).toBe("unknown");
    const barrier = env.backend.evidence.captureDrain!(
      { kind: "namespace", owner },
      performance.now() + 10000,
    );
    expect(await env.backend.evidence.flush(barrier)).toMatchObject({
      state: "unknown",
      unknown: [t.id],
    });
    env.control.release("after-publish");
    await publication;
    const aborted = make(owner, bytes);
    await env.backend.engine.reserve(aborted, bytes.length);
    expect(await env.backend.engine.abort(aborted)).toBe("aborted");
    const next = env.backend.evidence.captureDrain!(
      { kind: "namespace", owner },
      performance.now() + 10000,
    );
    expect(await env.backend.evidence.flush(next)).toMatchObject({
      state: "failed",
      incomplete: [aborted.id],
    });
  } finally {
    env.control.release("after-publish");
    await publication;
    await env.backend.dispose();
  }
});
it("a lost reserve response remains in both fixed drain and ordinary snapshots", async () => {
  const env = await launch(path.join(directory, randomUUID())),
    owner = ownerFor(env.profile.hostEpoch),
    bytes = Buffer.from("payload"),
    t = make(owner, bytes);
  env.control.arm("open-temp", "pause");
  const reached = env.control.reached("open-temp");
  const reserve = env.backend.engine.reserve(t, bytes.length).catch((e) => e);
  await reached;
  const scope = { kind: "namespace" as const, owner },
    old = env.backend.evidence.captureDrain!(scope, performance.now() + 10000);
  await env.control.terminate();
  expect(await reserve).toBeInstanceOf(Error);
  for (const barrier of [
    old,
    env.backend.evidence.captureDrain!(scope, performance.now() + 10000),
    env.backend.evidence.capture(scope, performance.now() + 10000),
  ]) {
    expect(env.backend.evidence.tickets(barrier)).toEqual([t]);
    await expect(env.backend.evidence.flush(barrier)).rejects.toThrow("worker-lost");
  }
  await expect(env.backend.dispose()).rejects.toThrow("worker-dispose-unknown");
});
it("new drains omit confirmed clean reserve failure without rewriting earlier snapshots", async () => {
  const env = await launch(path.join(directory, randomUUID())),
    owner = ownerFor(env.profile.hostEpoch),
    bytes = Buffer.from("payload"),
    t = make(owner, bytes);
  let reservation: Promise<unknown> | undefined;
  try {
    env.control.arm("reserve", "pause");
    const reached = env.control.reached("reserve");
    reservation = env.backend.engine.reserve(t, bytes.length).catch((e) => e);
    await reached;
    const scope = { kind: "namespace" as const, owner };
    const oldDrain = env.backend.evidence.captureDrain!(scope, performance.now() + 10000),
      ordinary = env.backend.evidence.capture(scope, performance.now() + 10000);
    env.control.arm("open-temp", "fail");
    env.control.release("reserve");
    expect(await reservation).toBeInstanceOf(Error);
    expect(await env.backend.engine.abort(t)).toBe("aborted");
    for (const old of [oldDrain, ordinary]) {
      expect(env.backend.evidence.tickets(old)).toEqual([t]);
      expect(await env.backend.evidence.flush(old)).toMatchObject({
        state: "failed",
        incomplete: [t.id],
      });
    }
    const fresh = env.backend.evidence.captureDrain!(scope, performance.now() + 10000);
    expect(env.backend.evidence.tickets(fresh)).toEqual([]);
    expect(await env.backend.evidence.flush(fresh)).toMatchObject({ state: "saved" });
    await expect(env.backend.engine.reserve(t, bytes.length)).rejects.toThrow("stale");
  } finally {
    env.control.release("reserve");
    await reservation;
    await env.backend.dispose();
  }
});
it("failed reserve cleanup and wrong-owner abort cannot clear a drain obligation", async () => {
  const env = await launch(path.join(directory, randomUUID())),
    owner = ownerFor(env.profile.hostEpoch),
    bytes = Buffer.from("payload"),
    t = make(owner, bytes);
  const trigger = path.join(directory, "cleanup-failure.trigger"),
    scope = { kind: "namespace" as const, owner };
  try {
    await writeFile(trigger, "");
    env.control.arm("open-temp", "fail");
    await expect(env.backend.engine.reserve(t, bytes.length)).rejects.toThrow();
    await expect(
      env.backend.engine.abort({ ...t, owner: { ...owner, processEpoch: randomUUID() } }),
    ).rejects.toThrow("stale");
    await expect(env.backend.engine.abort(t)).rejects.toThrow();
    const failed = env.backend.evidence.captureDrain!(scope, performance.now() + 10000);
    expect(env.backend.evidence.tickets(failed)).toEqual([t]);
    expect(await env.backend.evidence.flush(failed)).toMatchObject({
      state: "unknown",
      unknown: [t.id],
    });
    await rm(trigger);
    expect(await env.backend.engine.abort(t)).toBe("aborted");
    // A later settlement is not retroactively classified as a clean reserve rejection.
    const settled = env.backend.evidence.captureDrain!(scope, performance.now() + 10000);
    expect(await env.backend.evidence.flush(settled)).toMatchObject({
      state: "failed",
      incomplete: [t.id],
    });
  } finally {
    await rm(trigger, { force: true });
    await env.backend.engine.abort(t);
    await env.backend.dispose();
  }
});

it("seals the zero-byte deletion through the public record service and real worker", async () => {
  const env = await launch(path.join(directory, randomUUID())),
    owner = ownerFor(env.profile.hostEpoch),
    bytes = Buffer.from("delete original");
  const service = createRecordService({
    now: () => performance.now(),
    wall: Date.now,
    live: () => true,
    permission: () => true,
    engine: env.backend.engine,
    read: env.backend.reads,
    evidence: env.backend.evidence,
    checkpoint: {
      authorize: () => "none",
      committed() {},
      open: () => false,
      register: async () => {
        throw new Error("unused");
      },
      abandon: async () => {
        throw new Error("unused");
      },
    },
  });
  const principal = { kind: "plugin" as const, owner, authorityContext: null },
    signal = new AbortController().signal,
    t = make(owner, bytes);
  try {
    await stage(env.backend, t, bytes);
    expect((await env.backend.engine.publish(t)).disposition).toBe("committed");
    if (t.metadata.kind !== "record") throw new Error("record required");
    const params = { id: t.metadata.record.id, expectedRevision: t.metadata.record.revision };
    const deleted = await service.request(principal, "storage/delete", params, signal);
    expect(deleted).toMatchObject({ ok: true, value: { deleted: true } });
    expect(await service.request(principal, "storage/delete", params, signal)).toEqual(deleted);
    expect((await env.backend.reads.list(owner, { limit: 64 })).entries).toEqual([]);
  } finally {
    await env.backend.dispose();
  }
});

it("preserves the record on delete seal failure and permits a fresh explicit retry after proven abort", async () => {
  const env = await launch(path.join(directory, randomUUID())),
    owner = ownerFor(env.profile.hostEpoch),
    bytes = Buffer.from("keep on failure");
  const service = createRecordService({
    now: () => performance.now(),
    wall: Date.now,
    live: () => true,
    permission: () => true,
    engine: env.backend.engine,
    read: env.backend.reads,
    evidence: env.backend.evidence,
    checkpoint: {
      authorize: () => "none",
      committed() {},
      open: () => false,
      register: async () => {
        throw new Error("unused");
      },
      abandon: async () => {
        throw new Error("unused");
      },
    },
  });
  const principal = { kind: "plugin" as const, owner, authorityContext: null },
    signal = new AbortController().signal,
    t = make(owner, bytes);
  try {
    await stage(env.backend, t, bytes);
    await env.backend.engine.publish(t);
    if (t.metadata.kind !== "record") throw new Error("record required");
    const params = { id: t.metadata.record.id, expectedRevision: t.metadata.record.revision };
    env.control.arm("seal-sync", "fail");
    expect(await service.request(principal, "storage/delete", params, signal)).toMatchObject({
      ok: false,
    });
    expect(await env.backend.reads.stat(owner, params.id)).toMatchObject({
      revision: params.expectedRevision,
    });
    expect(await service.request(principal, "storage/delete", params, signal)).toMatchObject({
      ok: true,
      value: { deleted: true },
    });
  } finally {
    await env.backend.dispose();
  }
});

it.each(["confirmed", "unknown-delete", "unknown-final"])(
  "deletes a terminal drained final through the same owner without reopening old writes: %s",
  async (mode) => {
    const env = await launch(path.join(directory, randomUUID())),
      owner = ownerFor(env.profile.hostEpoch),
      bytes = Buffer.from("final recording");
    const service = createRecordService({
      now: () => performance.now(),
      wall: Date.now,
      live: () => true,
      permission: () => true,
      engine: env.backend.engine,
      read: env.backend.reads,
      evidence: env.backend.evidence,
      checkpoint: {
        authorize: () => "none",
        committed() {},
        open: () => false,
        register: async () => {
          throw new Error("unused");
        },
        abandon: async () => {
          throw new Error("unused");
        },
      },
    });
    const principal = { kind: "plugin" as const, owner, authorityContext: null },
      signal = new AbortController().signal,
      initial = make(owner, bytes);
    try {
      await stage(env.backend, initial, bytes);
      await env.backend.engine.publish(initial);
      if (initial.metadata.kind !== "record" || initial.target.kind !== "record")
        throw new Error("record required");
      const checkpoint = randomUUID(),
        document: PublicationTicket = {
          id: randomUUID(),
          owner,
          deadlineMonotonicMs: performance.now() + 120000,
          target: { kind: "recovery", key: checkpoint },
          metadata: { kind: "recovery", key: checkpoint },
        };
      await stage(
        env.backend,
        document,
        Buffer.from(
          JSON.stringify({
            formatVersion: 1,
            checkpoint,
            record: initial.metadata.record,
            binding: null,
            state: "open",
          }),
        ),
      );
      await env.backend.engine.publish(document);
      const deadline = performance.now() + 10000;
      env.backend.engine.fenceTarget(owner, initial.target.id, deadline);
      const early = await service.request(
        principal,
        "storage/delete",
        { id: initial.target.id, expectedRevision: initial.metadata.record.revision },
        signal,
      );
      expect(early.ok).toBe(false);
      expect(await env.backend.reads.stat(owner, initial.target.id)).toMatchObject({
        revision: initial.metadata.record.revision,
      });
      const final: PublicationTicket = {
        ...initial,
        id: randomUUID(),
        target: { ...initial.target, expectedRevision: initial.metadata.record.revision },
        metadata: {
          ...initial.metadata,
          record: {
            ...initial.metadata.record,
            revision: `r_${randomUUID().replaceAll("-", "")}`,
            checkpoint: "final",
          },
        },
      };
      await env.backend.engine.reserveFinal!(final, bytes.length, {
        owner,
        recordId: initial.target.id,
        checkpoint,
        token: randomUUID(),
        deadlineMonotonicMs: deadline,
      });
      await env.backend.engine.append(final, 0, bytes);
      await env.backend.engine.seal(final, bytes.length, hash(bytes));
      if (final.metadata.kind !== "record") throw new Error("record required");
      if (mode === "unknown-final") {
        env.control.arm("after-publish", "fail");
        expect(await env.backend.engine.publish(final)).toMatchObject({ disposition: "unknown" });
        expect(
          (
            await service.request(
              principal,
              "storage/delete",
              { id: initial.target.id, expectedRevision: final.metadata.record.revision },
              signal,
            )
          ).ok,
        ).toBe(false);
        expect(await env.backend.engine.reconcile(final)).toMatchObject({
          disposition: "committed",
        });
      } else
        expect(await env.backend.engine.publish(final)).toMatchObject({ disposition: "committed" });
      const barrier = env.backend.evidence.captureDrain!(
        { kind: "target", owner, recordId: initial.target.id },
        deadline,
      );
      expect(await env.backend.evidence.flush(barrier)).toMatchObject({ state: "saved" });
      const params = { id: initial.target.id, expectedRevision: final.metadata.record.revision };
      // Final bytes are committed, but an open checkpoint is still an active drain.
      const active = await service.request(principal, "storage/delete", params, signal);
      expect(active.ok).toBe(false);
      expect(JSON.stringify(active)).not.toContain("publish-uncertain");
      expect(await env.backend.reads.stat(owner, params.id)).toMatchObject({
        revision: params.expectedRevision,
      });
      await env.backend.evidence.saveCheckpoint!(owner, {
        checkpoint,
        record: final.metadata.record,
        binding: null,
        state: "final",
      });
      expect(
        await service.request(
          principal,
          "storage/delete",
          { ...params, expectedRevision: initial.metadata.record.revision },
          signal,
        ),
      ).toMatchObject({ ok: false, error: { detail: { reason: "revision-mismatch" } } });
      if (mode === "unknown-delete") {
        env.control.arm("after-publish", "fail");
        expect(await service.request(principal, "storage/delete", params, signal)).toMatchObject({
          ok: false,
          error: { detail: { reason: "publish-uncertain" } },
        });
        expect(
          await service.request(
            principal,
            "storage/delete",
            { ...params, expectedRevision: initial.metadata.record.revision },
            signal,
          ),
        ).toMatchObject({ ok: false, error: { code: "PLUGIN_E_STALE_RESOURCE" } });
      }
      const deleted = await service.request(principal, "storage/delete", params, signal);
      expect(deleted).toMatchObject({ ok: true, value: { deleted: true } });
      expect(await service.request(principal, "storage/delete", params, signal)).toEqual(deleted);
      expect((await env.backend.reads.list(owner, { limit: 64 })).entries).toEqual([]);
      await expect(
        env.backend.engine.reserve({ ...final, id: randomUUID() }, bytes.length),
      ).rejects.toThrow("stale");
      await expect(
        env.backend.engine.reserveFinal!({ ...final, id: randomUUID() }, bytes.length, {
          owner,
          recordId: initial.target.id,
          checkpoint,
          token: randomUUID(),
          deadlineMonotonicMs: deadline,
        }),
      ).rejects.toThrow("stale");
      await expect(env.backend.engine.append(final, 0, bytes)).rejects.toThrow();
    } finally {
      await service.close();
      await env.backend.dispose();
    }
  },
);

it("does not turn a never-admitted retired-owner delete into unknown publication", async () => {
  const env = await launch(path.join(directory, randomUUID())),
    owner = ownerFor(env.profile.hostEpoch),
    bytes = Buffer.from("retired");
  const service = createRecordService({
    now: () => performance.now(),
    wall: Date.now,
    live: () => true,
    permission: () => true,
    engine: env.backend.engine,
    read: env.backend.reads,
    evidence: env.backend.evidence,
    checkpoint: {
      authorize: () => "none",
      committed() {},
      open: () => false,
      register: async () => {
        throw new Error("unused");
      },
      abandon: async () => {
        throw new Error("unused");
      },
    },
  });
  const t = make(owner, bytes),
    principal = { kind: "plugin" as const, owner, authorityContext: null },
    signal = new AbortController().signal;
  try {
    await stage(env.backend, t, bytes);
    await env.backend.engine.publish(t);
    if (t.metadata.kind !== "record") throw new Error("record required");
    env.backend.engine.fence(owner, performance.now());
    expect(
      await service.request(
        principal,
        "storage/delete",
        { id: t.metadata.record.id, expectedRevision: t.metadata.record.revision },
        signal,
      ),
    ).toMatchObject({ ok: false, error: { code: "PLUGIN_E_STALE_RESOURCE" } });
  } finally {
    await service.close();
    await env.backend.dispose();
  }
});

// B2 N01/N02/N06: serialized public RPC -> actual host -> worker thread/filesystem.
// Not an Electron/primary-lock/installed-plugin test; launch() retains its lock stub.
import { createMemoryChannelPair, RpcPeer, RPC_ERRORS } from "@kobrixa/plugin-protocol";
import { bindPersistenceRoutes170 } from "../controller.js";
import { EventLedger } from "../../device-broker/registry.js";
import { settingsRequests } from "./settings-service.js";
import { readdir, lstat, readFile, appendFile } from "node:fs/promises";

type NegativeReply = {
  id: number;
  result?: { ok: boolean; value?: unknown; error?: { code: string } };
  error?: { code: number; message: string };
};
const negativeResource: SettingsResourceV1 = {
  schemaVersion: 1,
  title: { en: "Negative fixture" },
  fields: [
    { key: "count", type: "integer", label: { en: "Count" }, default: 1, minimum: 0, maximum: 10 },
    {
      key: "text",
      type: "string",
      label: { en: "Text" },
      default: "",
      minLength: 0,
      maxLength: 4000,
      maxBytes: 4096,
    },
  ],
};
async function negativeTree(root: string, prefix = ""): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (const name of (await readdir(path.join(root, prefix))).sort()) {
    const relative = path.join(prefix, name),
      absolute = path.join(root, relative),
      stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Unexpected symlink: ${relative}`);
    rows.push(
      stat.isDirectory()
        ? { path: relative, kind: "directory" }
        : { path: relative, kind: "file", size: stat.size, sha256: hash(await readFile(absolute)) },
    );
    if (stat.isDirectory()) rows.push(...(await negativeTree(root, relative)));
  }
  return rows;
}
async function negativeHost(userData: string, journal: (row: unknown) => void) {
  const env = await launch(userData),
    a = ownerFor(env.profile.hostEpoch),
    b = {
      ...ownerFor(env.profile.hostEpoch),
      sourceKey: "builtin:test.other",
      pluginId: "test.other",
    };
  const owners = [a, b],
    denied = new Set<string>(),
    calls: string[] = [],
    pins = new Set<string>(),
    sent: unknown[] = [];
  let resourceReads = 0;
  // Forwarding observers never replace a backend result or omit an actual operation.
  for (const group of ["engine", "reads"] as const) {
    const port = env.backend[group];
    for (const key of Object.keys(port)) {
      const methods = port as unknown as Record<string, (...args: unknown[]) => unknown>;
      const original = methods[key];
      if (typeof original !== "function") continue;
      methods[key] = function (...args: unknown[]) {
        calls.push(`${group}.${key}`);
        const result = original.apply(port, args);
        const observe = (value: unknown) => {
          if (group === "reads" && key === "open") {
            expect(typeof value).toBe("string");
            pins.add(value as string);
          }
          if (group === "reads" && key === "close") pins.delete(args[1] as string);
          journal({
            operation: `${group}.${key}`,
            result:
              value instanceof Uint8Array ? { bytes: value.length, sha256: hash(value) } : value,
          });
          return value;
        };
        return result instanceof Promise ? result.then(observe) : observe(result);
      };
    }
  }
  const events = new EventLedger(
    () => performance.now(),
    (event) => {
      sent.push(event);
      journal({ event });
    },
    () => {
      throw new Error("Unexpected watch revocation");
    },
  );
  const fail = () => {
    throw new Error("Unexpected collaborator");
  };
  const resolved = (owner: typeof a) => ({
    owner: { sourceKey: owner.sourceKey, pluginId: owner.pluginId, uiResourceGeneration: 1 },
    resource: negativeResource,
    validationDigest: "b".repeat(64),
  });
  const host = await createPersistenceHost({
    profile: env.profile,
    now: () => performance.now(),
    hasPermission: (_p, p) => !denied.has(p),
    composition: {
      backend: env.backend,
      sources: {
        current: (o) => owners.some((x) => JSON.stringify(x) === JSON.stringify(o)),
        settings: async (input) => {
          resourceReads++;
          const o = owners.find((x) => x.sourceKey === input.sourceKey);
          return o ? resolved(o) : null;
        },
        coreOwner: () => a,
      },
      events,
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
  });
  for (const owner of owners)
    settingsRequests(env.backend).admit(owner, "a".repeat(64), resolved(owner));
  const channels = owners.map((owner) => {
    const [server, client] = createMemoryChannelPair(),
      peer = new RpcPeer(server);
    const detach = bindPersistenceRoutes170({
      context: {
        peer,
        owner,
        principal: () => ({ kind: "plugin", owner, authorityContext: null }),
        requirements: [],
      },
      host,
      attachment: {
        owner,
        negotiated() {},
        activate: (id) => events.activate(owner, id),
        abandon: (id) => {
          events.unsubscribe(owner, id);
        },
        dispose() {},
      },
      apiVersion: () => "1.7.0",
      admitted: () => true,
    });
    let sequence = 0;
    const waiting = new Map<
      number,
      {
        resolve: (reply: NegativeReply) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    const off = client.onMessage((text) => {
      journal({
        direction: "reply",
        sourceKey: owner.sourceKey,
        text,
        sha256: hash(Buffer.from(text)),
      });
      const reply = JSON.parse(text) as NegativeReply;
      const pending = waiting.get(reply.id);
      if (pending) {
        clearTimeout(pending.timer);
        waiting.delete(reply.id);
        pending.resolve(reply);
      }
    });
    return {
      request(method: string, params: unknown, rawParams?: string) {
        const id = ++sequence;
        const text = `{"jsonrpc":"2.0","id":${id},"method":${JSON.stringify(method)},"params":${rawParams ?? JSON.stringify(params)}}`;
        journal({
          direction: "request",
          sourceKey: owner.sourceKey,
          id,
          text,
          sha256: hash(Buffer.from(text)),
        });
        return new Promise<NegativeReply>((resolve, reject) => {
          const timer = setTimeout(() => {
            waiting.delete(id);
            reject(new Error(`RPC timeout: ${method}`));
          }, 10000);
          waiting.set(id, { resolve, reject, timer });
          client.send(text);
        });
      },
      close() {
        detach();
        off();
        peer.close();
        for (const p of waiting.values()) {
          clearTimeout(p.timer);
          p.reject(new Error("Fixture closed"));
        }
        waiting.clear();
      },
    };
  });
  return {
    env,
    host,
    a,
    b,
    owners,
    denied,
    calls,
    pins,
    sent,
    events,
    channels,
    resourceReads: () => resourceReads,
    async snapshot() {
      const barrier = env.backend.evidence.capture(
        { kind: "namespace", owner: a },
        performance.now() + 10000,
      );
      const tickets = env.backend.evidence.tickets(barrier);
      return {
        tree: await negativeTree(userData),
        quota: await Promise.all(owners.map((o) => env.backend.evidence.quota(o))),
        tickets,
        barrier: await env.backend.evidence.flush(barrier),
        core: host.recovery.snapshot(),
        pins: [...pins],
        events: events.diagnostics(),
        hostEpoch: env.profile.hostEpoch,
        owners,
        workerCount: persistenceWorkerCount(env.backend),
      };
    },
    async close() {
      for (const c of channels) c.close();
      await host.dispose();
      events.dispose();
      expect(pins.size).toBe(0);
      expect(persistenceWorkerCount(env.backend)).toBe(0);
    },
  };
}
type NegativeValue = {
  snapshot: SettingsSnapshot;
  record: RecordMeta;
  entries: RecordMeta[];
  write: string;
  read: string;
  subscriptionId: string;
  nextCursor?: string;
  receivedBytes: number;
  receipt: { revision: string; commitId: string; durability: string };
  deleted: boolean;
  data: string;
  offset: number;
  nextOffset: number;
  eof: boolean;
};
function negativeValue(reply: NegativeReply): NegativeValue {
  expect(reply.error).toBeUndefined();
  expect(reply.result?.ok).toBe(true);
  if (!reply.result?.ok) throw new Error(JSON.stringify(reply));
  return reply.result.value as NegativeValue;
}
function negativeDenied(reply: NegativeReply, code?: string) {
  if (code) expect(reply.result).toMatchObject({ ok: false, error: { code } });
  else
    expect(reply.error?.code === RPC_ERRORS.invalidParams || reply.result?.ok === false).toBe(true);
}
const negativeCases = [
  "N01-storage-permission",
  "N01-settings-permission",
  "N01-foreign-record",
  "N01-foreign-handles",
  "N01-owner-fields",
  "N02-unknown",
  "N02-duplicate",
  "N02-coercion",
  "N02-nonfinite",
  "N02-byte-limit",
  "N02-total-byte-limit",
  "N06-oversize",
  "N06-base64",
  "N06-offset",
  "N06-retry",
  "N06-checksum",
] as const;
it.each(negativeCases)(
  "B2-%s public rejection preserves real durable state across fresh epoch",
  async (name) => {
    const userData = path.join(directory, randomUUID()),
      rows: unknown[] = [],
      journal = (row: unknown) => rows.push(row);
    const evidenceRoot = process.env.B2_NEGATIVE_EVIDENCE_DIR;
    if (evidenceRoot && !path.isAbsolute(evidenceRoot))
      throw new Error("B2_NEGATIVE_EVIDENCE_DIR must be absolute");
    let f: Awaited<ReturnType<typeof negativeHost>> | undefined,
      success = false;
    try {
      f = await negativeHost(userData, journal);
      const first = f,
        request = first.channels[0]!.request,
        other = first.channels[1]!.request;
      const seeds = await Promise.all(
        first.owners.map(async (owner, index) => {
          const t = make(owner, Buffer.from(`original-${index}`));
          await stage(first.env.backend, t, Buffer.from(`original-${index}`));
          await first.env.backend.engine.publish(t);
          if (t.metadata.kind !== "record") throw new Error("record");
          return t.metadata.record;
        }),
      );
      const settings = negativeValue(
        await request("settings/update", {
          schemaVersion: 1,
          expectedRevision: null,
          changes: [{ key: "count", value: 7 }],
        }),
      ).snapshot;
      negativeValue(
        await other("settings/update", {
          schemaVersion: 1,
          expectedRevision: null,
          changes: [{ key: "count", value: 8 }],
        }),
      );
      const watch = negativeValue(await request("settings/watch", { schemaVersion: 1 }));
      // Actual control event proves the ledger/attachment is live before negative injections.
      const control = negativeValue(
        await request("settings/update", {
          schemaVersion: 1,
          expectedRevision: settings.revision,
          changes: [{ key: "text", value: "baseline" }],
        }),
      ).snapshot;
      expect(first.sent).toHaveLength(1);
      const event = first.sent[0] as { sequence: number };
      first.events.ack(first.a, watch.subscriptionId, event.sequence);
      const body = Buffer.alloc(262144, 0x61),
        writeInput = {
          target: { mode: "create" },
          kind: "test",
          schemaVersion: 1,
          label: "negative",
          mediaType: "application/octet-stream",
          byteLength: body.length,
          sha256: hash(body),
        };
      let write: string | undefined, read: string | undefined, cursor: string | undefined;
      let extra: (typeof seeds)[number] | undefined;
      if (name === "N01-foreign-handles") {
        const t = make(first.a, Buffer.from("second-page"));
        await stage(first.env.backend, t, Buffer.from("second-page"));
        await first.env.backend.engine.publish(t);
        if (t.metadata.kind !== "record") throw new Error("record");
        extra = t.metadata.record;
        cursor = negativeValue(await request("storage/list", { limit: 1 })).nextCursor;
        expect(typeof cursor).toBe("string");
      }
      if (name.startsWith("N06") || name === "N01-foreign-handles")
        write = negativeValue(
          await request("storage/beginWrite", {
            ...writeInput,
            ...(name === "N06-checksum" ? { sha256: hash(Buffer.from("wrong")) } : {}),
          }),
        ).write;
      if (name === "N01-foreign-handles")
        read = negativeValue(
          await request("storage/openRead", {
            id: seeds[0]!.id,
            expectedRevision: seeds[0]!.revision,
            schemaVersion: 1,
          }),
        ).read;
      if (["N06-offset", "N06-retry", "N06-checksum"].includes(name))
        negativeValue(
          await request("storage/writeChunk", { write, offset: 0, data: body.toString("base64") }),
        );
      const before = await first.snapshot(),
        callCount = first.calls.length,
        resourceReads = first.resourceReads(),
        eventCount = first.sent.length;
      journal({ phase: "before", snapshot: before });
      if (name === "N01-storage-permission" || name === "N01-settings-permission") {
        first.denied.add(name === "N01-storage-permission" ? "storage.write" : "settings.write");
        negativeDenied(
          await request(
            name === "N01-storage-permission" ? "storage/beginWrite" : "settings/update",
            name === "N01-storage-permission"
              ? writeInput
              : {
                  schemaVersion: 1,
                  expectedRevision: control.revision,
                  changes: [{ key: "count", value: 9 }],
                },
          ),
          "PLUGIN_E_PERMISSION_DENIED",
        );
        expect(first.calls.length).toBe(callCount);
        expect(first.resourceReads()).toBe(resourceReads);
        first.denied.clear();
      } else if (name === "N01-foreign-record") {
        const foreign = await request("storage/stat", { id: seeds[1]!.id }),
          missing = await request("storage/stat", { id: randomUUID() });
        negativeDenied(foreign, "PLUGIN_E_STALE_RESOURCE");
        expect(foreign.result).toEqual(missing.result);
      } else if (name === "N01-foreign-handles") {
        negativeDenied(
          await other("storage/readChunk", { read, offset: 0, maxBytes: 1 }),
          "PLUGIN_E_STALE_RESOURCE",
        );
        negativeDenied(await other("storage/abortWrite", { write }), "PLUGIN_E_STALE_RESOURCE");
        negativeDenied(
          await other("storage/list", { limit: 1, cursor }),
          "PLUGIN_E_STALE_RESOURCE",
        );
        expect(first.calls.length).toBe(callCount);
      } else if (name === "N01-owner-fields") {
        for (const field of ["owner", "sourceKey", "pluginId", "path"])
          expect(
            (
              await request("storage/stat", {
                id: seeds[0]!.id,
                [field]: field === "owner" ? first.b : first.b.sourceKey,
              })
            ).error?.code,
          ).toBe(RPC_ERRORS.invalidParams);
        expect(first.calls.length).toBe(callCount);
      } else if (name.startsWith("N02")) {
        const changes: Array<{ key: string; value: string | number }> =
          name === "N02-unknown"
            ? [{ key: "unknown", value: 1 }]
            : name === "N02-duplicate"
              ? [
                  { key: "count", value: 2 },
                  { key: "count", value: 3 },
                ]
              : name === "N02-coercion"
                ? [{ key: "count", value: "2" }]
                : [{ key: "text", value: "é".repeat(2048) + "a" }];
        if (name === "N02-total-byte-limit") {
          changes.splice(
            0,
            changes.length,
            ...Array.from({ length: 17 }, (_, i) => ({
              key: `text${i}`,
              value: i < 16 ? "a".repeat(4000) : "",
            })),
          );
          changes[16]!.value = "a".repeat(65537 - Buffer.byteLength(JSON.stringify(changes)));
          expect(Buffer.byteLength(JSON.stringify(changes))).toBe(65537);
        }
        const params = { schemaVersion: 1, expectedRevision: control.revision, changes };
        const raw =
          name === "N02-nonfinite"
            ? `{"schemaVersion":1,"expectedRevision":${JSON.stringify(control.revision)},"changes":[{"key":"count","value":1e999}]}`
            : undefined;
        const rejected = await request("settings/update", params, raw);
        if (name === "N02-unknown" || name === "N02-coercion")
          negativeDenied(rejected, "PLUGIN_E_SETTINGS_SCHEMA");
        else expect(rejected.error?.code).toBe(RPC_ERRORS.invalidParams);
        expect(first.calls.slice(callCount)).not.toContain("engine.reserve");
      } else if (name === "N06-oversize" || name === "N06-base64") {
        for (const data of name === "N06-oversize"
          ? [Buffer.alloc(262145).toString("base64")]
          : ["!===", "YQ=", "YR=="])
          expect(
            (await request("storage/writeChunk", { write, offset: 0, data })).error?.code,
          ).toBe(RPC_ERRORS.invalidParams);
        expect(first.calls.length).toBe(callCount);
      } else if (name === "N06-offset") {
        for (const offset of [1, body.length + 1])
          negativeDenied(
            await request("storage/writeChunk", { write, offset, data: "Yg==" }),
            "PLUGIN_E_STORAGE_CONFLICT",
          );
        expect(first.calls.length).toBe(callCount);
      } else if (name === "N06-retry") {
        expect(
          negativeValue(
            await request("storage/writeChunk", {
              write,
              offset: 0,
              data: body.toString("base64"),
            }),
          ).receivedBytes,
        ).toBe(body.length);
        negativeDenied(
          await request("storage/writeChunk", {
            write,
            offset: 0,
            data: Buffer.alloc(body.length, 0x62).toString("base64"),
          }),
          "PLUGIN_E_STORAGE_CONFLICT",
        );
        expect(first.calls.length).toBe(callCount);
      } else {
        negativeDenied(await request("storage/sealWrite", { write }), "PLUGIN_E_STORAGE_CONFLICT");
        negativeDenied(await request("storage/commitWrite", { write }));
      }
      const after = await first.snapshot();
      journal({ phase: "after", snapshot: after });
      expect(first.sent.length).toBe(eventCount);
      expect(after.core).toEqual(before.core);
      if (name !== "N06-checksum") {
        expect(after.tree).toEqual(before.tree);
        expect(after.quota).toEqual(before.quota);
      }
      expect(negativeValue(await request("settings/read", { schemaVersion: 1 }))).toEqual(control);
      for (const [index, c] of first.channels.entries())
        expect(
          negativeValue(await c.request("storage/stat", { id: seeds[index]!.id })).record,
        ).toEqual(seeds[index]);
      if (read) negativeValue(await request("storage/closeRead", { read }));
      if (write) negativeValue(await request("storage/abortWrite", { write }));
      if (cursor) negativeValue(await request("storage/list", { limit: 1, cursor }));
      first.events.unsubscribe(first.a, watch.subscriptionId);
      const cleaned = await first.snapshot();
      journal({ phase: "cleaned", snapshot: cleaned });
      expect(cleaned.pins).toEqual([]);
      expect(cleaned.events.subscriptions).toBe(0);
      for (const [index, q] of cleaned.quota.entries())
        expect(q).toMatchObject({
          ok: true,
          value: {
            recordCount: index === 0 && extra ? 2 : 1,
            reservedCreates: 0,
            reservedBytes: 0,
            pinnedBytes: 0,
            temporaryBytes: 0,
          },
        });
      await first.close();
      f = undefined;
      const next = await negativeHost(userData, journal);
      f = next;
      expect(next.env.profile.hostEpoch).not.toBe(first.env.profile.hostEpoch);
      for (const [index, c] of next.channels.entries())
        expect(
          negativeValue(await c.request("storage/stat", { id: seeds[index]!.id })).record,
        ).toEqual(seeds[index]);
      expect(
        negativeValue(await next.channels[0]!.request("settings/read", { schemaVersion: 1 })),
      ).toEqual(control);
      if (write)
        negativeDenied(
          await next.channels[0]!.request("storage/writeStatus", { write }),
          "PLUGIN_E_STALE_RESOURCE",
        );
      if (read)
        negativeDenied(
          await next.channels[0]!.request("storage/readChunk", { read, offset: 0, maxBytes: 1 }),
          "PLUGIN_E_STALE_RESOURCE",
        );
      if (cursor)
        negativeDenied(
          await next.channels[0]!.request("storage/list", { limit: 1, cursor }),
          "PLUGIN_E_STALE_RESOURCE",
        );
      for (const [index, c] of next.channels.entries()) {
        const actual = negativeValue(await c.request("storage/list", { limit: 64 }))
          .entries.map((r: { id: string }) => r.id)
          .sort();
        expect(actual).toEqual(
          [seeds[index]!.id, ...(index === 0 && extra ? [extra.id] : [])].sort(),
        );
      }
      const reopened = await next.snapshot();
      journal({ phase: "reopened", snapshot: reopened });
      expect(reopened.quota).toEqual(cleaned.quota); // An admitted/aborted attempt remains an honest shutdown obligation; it is
      // not a live write/pin and must never be projected as publishable data.
      if (write) {
        expect(reopened.core.items).toHaveLength(1);
        expect(reopened.core.items[0]).toMatchObject({
          sourceKey: first.a.sourceKey,
          pluginId: first.a.pluginId,
          state: "checkpoint-only",
          payload: "none",
          recordId: null,
          committedRevision: null,
        });
        expect(reopened.core.items[0]!.actions.map((a) => a.kind)).toEqual(["discard"]);
      } else expect(reopened.core.items).toEqual([]);
      await next.close();
      f = undefined;
      success = true;
    } finally {
      try {
        if (f) await f.close();
      } finally {
        await retainNegativeEvidence(name, userData, rows, success);
      }
    }
  },
  60000,
);

async function retainNegativeEvidence(
  name: string,
  userData: string,
  rows: unknown[],
  success: boolean,
) {
  const evidenceRoot = process.env.B2_NEGATIVE_EVIDENCE_DIR;
  if (evidenceRoot) {
    await mkdir(evidenceRoot, { recursive: true });
    const output = path.join(evidenceRoot, `${name}-${path.basename(userData)}.jsonl`);
    await appendFile(output, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    await writeFile(
      output + ".receipt.json",
      JSON.stringify(
        {
          case: name,
          success,
          userData,
          workerBundle: { path: entry, sha256: hash(await readFile(entry)) },
          sourceSha256: hash(await readFile(fileURLToPath(import.meta.url))),
          productSources: await Promise.all(
            [
              "./host-port.ts",
              "./record-service.ts",
              "./settings-service.ts",
              "./worker.ts",
              "./atomic-store.ts",
              "./filesystem.ts",
            ].map(async (relative) => ({
              relative,
              sha256: hash(await readFile(fileURLToPath(new URL(relative, import.meta.url)))),
            })),
          ),
          candidate: process.env.B2_CANDIDATE_COMMIT ?? null,
          limits: [
            "worker thread count/epochs observed; no private thread-ID diagnostic",
            "not Electron utility process",
            "test profile lock stub",
            "observed public handles/backend pins, not private-map census",
            "no SIGKILL",
            "candidate supplied by controller; not inferred",
          ],
          transcriptSha256: hash(await readFile(output)),
        },
        null,
        2,
      ),
    );
  }
}

it("B2-N04-N13 replacement/delete conflict preserves pinned revisions and immutable pages across a fresh epoch", async () => {
  const name = "N04-N13-record-race",
    userData = path.join(directory, randomUUID()),
    rows: unknown[] = [];
  const journal = (row: unknown) => rows.push(row),
    evidenceRoot = process.env.B2_NEGATIVE_EVIDENCE_DIR;
  if (evidenceRoot && !path.isAbsolute(evidenceRoot))
    throw new Error("B2_NEGATIVE_EVIDENCE_DIR must be absolute");
  let f: Awaited<ReturnType<typeof negativeHost>> | undefined,
    success = false;
  try {
    f = await negativeHost(userData, journal);
    const first = f,
      request = first.channels[0]!.request;
    const input = (bytes: Buffer, target: unknown = { mode: "create" }) => ({
      target,
      kind: "test",
      schemaVersion: 1,
      label: "N04/N13",
      mediaType: "application/octet-stream",
      byteLength: bytes.length,
      sha256: hash(bytes),
    });
    const commit = async (bytes: Buffer) => {
      const begun = negativeValue(await request("storage/beginWrite", input(bytes)));
      negativeValue(
        await request("storage/writeChunk", {
          write: begun.write,
          offset: 0,
          data: bytes.toString("base64"),
        }),
      );
      negativeValue(await request("storage/sealWrite", { write: begun.write }));
      const result = negativeValue(await request("storage/commitWrite", { write: begun.write }));
      expect(result.receipt.revision).toBe(result.record.revision);
      expect(result.record.sha256).toBe(hash(bytes));
      return result;
    };
    const seedBytes = [
      Buffer.from([0, 255, 11, 12, 13, 14, 15, 16, 17, 18, 19]),
      Buffer.from("delete-while-pinned\0old-bytes"),
    ];
    const seeds = [await commit(seedBytes[0]!), await commit(seedBytes[1]!)];
    const bytesById = new Map(seeds.map((s, i) => [s.record.id, seedBytes[i]!]));
    const baseline = negativeValue(await request("storage/list", { limit: 64 })).entries;
    expect(baseline).toHaveLength(2);
    const page1 = negativeValue(await request("storage/list", { limit: 1 }));
    expect(page1.entries).toEqual(baseline.slice(0, 1));
    expect(typeof page1.nextCursor).toBe("string");
    const original = baseline[0]!,
      deleted = baseline[1]!,
      originalBytes = bytesById.get(original.id)!,
      deletedBytes = bytesById.get(deleted.id)!;
    const oldRead = negativeValue(
      await request("storage/openRead", {
        id: original.id,
        expectedRevision: original.revision,
        schemaVersion: 1,
      }),
    ).read;
    const deletedRead = negativeValue(
      await request("storage/openRead", {
        id: deleted.id,
        expectedRevision: deleted.revision,
        schemaVersion: 1,
      }),
    ).read;
    const prefix = negativeValue(
      await request("storage/readChunk", { read: oldRead, offset: 0, maxBytes: 3 }),
    );
    expect(Buffer.from(prefix.data, "base64")).toEqual(originalBytes.subarray(0, 3));
    expect(prefix.nextOffset).toBe(3);
    const replacementBytes = Buffer.from([99, 0, 254, 42, 43, 44, 45, 46, 47, 48, 49, 50]);
    const replacementInput = input(replacementBytes, {
      mode: "replace",
      id: original.id,
      expectedRevision: original.revision,
    });
    const winner = negativeValue(await request("storage/beginWrite", replacementInput));
    negativeValue(
      await request("storage/writeChunk", {
        write: winner.write,
        offset: 0,
        data: replacementBytes.toString("base64"),
      }),
    );
    negativeValue(await request("storage/sealWrite", { write: winner.write }));
    const before = await first.snapshot();
    journal({ phase: "before-competing-requests", snapshot: before, baseline, seeds });
    // Two real public requests contend against an admitted, sealed replacement.
    // Its commit is deliberately withheld, so both must lose the target gate.
    const calls = first.calls.length;
    const competing = await Promise.all([
      request("storage/beginWrite", replacementInput),
      request("storage/delete", { id: original.id, expectedRevision: original.revision }),
    ]);
    for (const reply of competing)
      expect(reply.result).toMatchObject({
        ok: false,
        error: { code: "PLUGIN_E_STORAGE_CONFLICT", detail: { reason: "write-in-progress" } },
      });
    expect(first.calls.slice(calls)).not.toContain("engine.reserve");
    const after = await first.snapshot();
    journal({ phase: "after-competing-requests", snapshot: after, outcomes: competing });
    expect(after.tree).toEqual(before.tree);
    expect(after.quota).toEqual(before.quota);
    expect(after.pins).toEqual(before.pins);
    expect(after.core).toEqual(before.core);
    const won = negativeValue(await request("storage/commitWrite", { write: winner.write }));
    expect(won.record.id).toBe(original.id);
    expect(won.record.revision).not.toBe(original.revision);
    expect(won.receipt.revision).toBe(won.record.revision);
    expect(won.record.sha256).toBe(hash(replacementBytes));
    expect(negativeValue(await request("storage/commitWrite", { write: winner.write }))).toEqual(
      won,
    );
    for (const method of ["storage/beginWrite", "storage/delete"]) {
      const prior = await first.snapshot();
      journal({ phase: `before-stale-${method}`, snapshot: prior });
      const reply = await request(
        method,
        method === "storage/beginWrite"
          ? replacementInput
          : { id: original.id, expectedRevision: original.revision },
      );
      expect(reply.result).toMatchObject({
        ok: false,
        error: { code: "PLUGIN_E_STORAGE_CONFLICT", detail: { reason: "revision-mismatch" } },
      });
      const next = await first.snapshot();
      journal({ phase: `after-stale-${method}`, snapshot: next, outcome: reply });
      expect(next.tree).toEqual(prior.tree);
      expect(next.quota).toEqual(prior.quota);
      expect(next.core).toEqual(prior.core);
    }
    const removed = negativeValue(
      await request("storage/delete", { id: deleted.id, expectedRevision: deleted.revision }),
    );
    expect(removed.deleted).toBe(true);
    expect(
      negativeValue(
        await request("storage/delete", { id: deleted.id, expectedRevision: deleted.revision }),
      ),
    ).toEqual(removed);
    negativeDenied(await request("storage/stat", { id: deleted.id }), "PLUGIN_E_STALE_RESOURCE");
    const page2 = negativeValue(
      await request("storage/list", { limit: 1, cursor: page1.nextCursor }),
    );
    expect(page2.entries).toEqual(baseline.slice(1));
    expect(page2.nextCursor).toBeUndefined();
    expect([...page1.entries, ...page2.entries]).toEqual(baseline);
    expect(
      negativeValue(await request("storage/list", { limit: 1, cursor: page1.nextCursor })),
    ).toEqual(page2);
    expect(negativeValue(await request("storage/list", { limit: 64 })).entries).toEqual([
      won.record,
    ]);
    const suffix = negativeValue(
      await request("storage/readChunk", { read: oldRead, offset: 3, maxBytes: 262144 }),
    );
    expect(suffix.offset).toBe(3);
    expect(suffix.nextOffset).toBe(originalBytes.length);
    expect(suffix.eof).toBe(true);
    expect(
      Buffer.concat([Buffer.from(prefix.data, "base64"), Buffer.from(suffix.data, "base64")]),
    ).toEqual(originalBytes);
    const deletedChunk = negativeValue(
      await request("storage/readChunk", { read: deletedRead, offset: 0, maxBytes: 262144 }),
    );
    expect(Buffer.from(deletedChunk.data, "base64")).toEqual(deletedBytes);
    expect(deletedChunk.eof).toBe(true);
    const newRead = negativeValue(
      await request("storage/openRead", {
        id: won.record.id,
        expectedRevision: won.record.revision,
        schemaVersion: 1,
      }),
    ).read;
    const currentChunk = negativeValue(
      await request("storage/readChunk", { read: newRead, offset: 0, maxBytes: 262144 }),
    );
    expect(Buffer.from(currentChunk.data, "base64")).toEqual(replacementBytes);
    expect(currentChunk.eof).toBe(true);
    const pinned = await first.snapshot();
    journal({
      phase: "committed-and-deleted-with-pins",
      snapshot: pinned,
      won,
      removed,
      page1,
      page2,
      oldRead,
      deletedRead,
      newRead,
    });
    expect(pinned.pins).toHaveLength(3);
    expect(pinned.quota[0]).toMatchObject({
      ok: true,
      value: { recordCount: 1, reservedCreates: 0, reservedBytes: 0 },
    });
    for (const read of [oldRead, deletedRead, newRead])
      negativeValue(await request("storage/closeRead", { read }));
    negativeDenied(
      await request("storage/readChunk", { read: oldRead, offset: 0, maxBytes: 1 }),
      "PLUGIN_E_STALE_RESOURCE",
    );
    const cleaned = await first.snapshot();
    journal({ phase: "cleaned", snapshot: cleaned });
    expect(cleaned.pins).toEqual([]);
    expect(cleaned.core.items).toEqual([]);
    expect(cleaned.quota[0]).toMatchObject({
      ok: true,
      value: {
        recordCount: 1,
        committedBytes: replacementBytes.length,
        reservedCreates: 0,
        reservedBytes: 0,
        pinnedBytes: 0,
        temporaryBytes: 0,
      },
    });
    await first.close();
    f = undefined;
    f = await negativeHost(userData, journal);
    const next = f,
      again = next.channels[0]!.request;
    expect(next.env.profile.hostEpoch).not.toBe(first.env.profile.hostEpoch);
    expect(negativeValue(await again("storage/list", { limit: 64 })).entries).toEqual([won.record]);
    expect(negativeValue(await again("storage/stat", { id: original.id })).record).toEqual(
      won.record,
    );
    negativeDenied(await again("storage/stat", { id: deleted.id }), "PLUGIN_E_STALE_RESOURCE");
    for (const read of [oldRead, deletedRead, newRead])
      negativeDenied(
        await again("storage/readChunk", { read, offset: 0, maxBytes: 1 }),
        "PLUGIN_E_STALE_RESOURCE",
      );
    negativeDenied(
      await again("storage/list", { limit: 1, cursor: page1.nextCursor }),
      "PLUGIN_E_STALE_RESOURCE",
    );
    negativeDenied(
      await again("storage/writeStatus", { write: winner.write }),
      "PLUGIN_E_STALE_RESOURCE",
    );
    const reopenedRead = negativeValue(
      await again("storage/openRead", {
        id: won.record.id,
        expectedRevision: won.record.revision,
        schemaVersion: 1,
      }),
    ).read;
    const reopenedChunk = negativeValue(
      await again("storage/readChunk", { read: reopenedRead, offset: 0, maxBytes: 262144 }),
    );
    expect(Buffer.from(reopenedChunk.data, "base64")).toEqual(replacementBytes);
    expect(hash(Buffer.from(reopenedChunk.data, "base64"))).toBe(won.record.sha256);
    expect(reopenedChunk.eof).toBe(true);
    negativeValue(await again("storage/closeRead", { read: reopenedRead }));
    const reopened = await next.snapshot();
    journal({
      phase: "reopened",
      snapshot: reopened,
      winningReceipt: won.receipt,
      deleteReceipt: removed.receipt,
    });
    expect(reopened.quota).toEqual(cleaned.quota);
    expect(reopened.core.items).toEqual([]);
    expect(reopened.pins).toEqual([]);
    await next.close();
    f = undefined;
    success = true;
  } finally {
    try {
      if (f) await f.close();
    } finally {
      await retainNegativeEvidence(name, userData, rows, success);
    }
  }
}, 60000);

it.each([
  "payload",
  "head",
  "head-version-invalid",
  "identity-version-invalid",
  "symlink",
  "hardlink",
  "head-newer",
  "identity-newer",
] as const)(
  "N14/N29: reopened %s retains its failure class and never returns empty history",
  async (mode) => {
    const userData = path.join(directory, randomUUID()),
      first = await launch(userData);
    const owner = ownerFor(first.profile.hostEpoch),
      bytes = Buffer.from("committed original"),
      ticket = make(owner, bytes);
    try {
      await stage(first.backend, ticket, bytes);
      expect((await first.backend.engine.publish(ticket)).disposition).toBe("committed");
    } finally {
      await first.backend.dispose();
    }
    if (ticket.metadata.kind !== "record") throw new Error("record required");
    const record = ticket.metadata.record;
    const namespace = path.join(
      userData,
      "plugins",
      "persistence-v1",
      "namespaces",
      hash(Buffer.from(owner.sourceKey)),
    );
    const headPath = path.join(namespace, "records", record.id, "head.json");
    const objectPath = path.join(
      namespace,
      "records",
      record.id,
      "objects",
      record.revision + ".bin",
    );
    const identityPath = path.join(namespace, "identity.json");
    const outside = path.join(directory, randomUUID() + ".outside");
    if (mode === "payload") await writeFile(objectPath, "corrupted payload");
    else if (mode === "head") await writeFile(headPath, "{invalid-json");
    else if (mode === "symlink" || mode === "hardlink") {
      await writeFile(outside, bytes);
      await unlink(objectPath);
      if (mode === "symlink") await symlink(outside, objectPath);
      else await link(outside, objectPath);
    } else {
      const file = mode.startsWith("identity") ? identityPath : headPath;
      const raw = JSON.parse(await readFile(file, "utf8"));
      raw.formatVersion = mode.endsWith("newer") ? 2 : "2";
      await writeFile(file, JSON.stringify(raw));
    }
    const before = await Promise.all(
      [headPath, objectPath, identityPath].map((file) => readFile(file)),
    );
    const reopened = await launch(userData),
      nextOwner = ownerFor(reopened.profile.hostEpoch);
    const expected = {
      result: {
        ok: false,
        error: {
          code: mode.endsWith("newer") ? "PLUGIN_E_STORAGE_VERSION" : "PLUGIN_E_STORAGE_IO",
          detail: { reason: mode.endsWith("newer") ? "unsupported-format" : "corrupt" },
        },
      },
    };
    try {
      expect(reopened.recovery).toBe("blocked");
      await expect(reopened.backend.reads.stat(nextOwner, record.id)).rejects.toMatchObject(
        expected,
      );
      await expect(reopened.backend.reads.list(nextOwner, { limit: 64 })).rejects.toMatchObject(
        expected,
      );
      await expect(
        reopened.backend.reads.open(nextOwner, record.id, record.revision),
      ).rejects.toMatchObject(expected);
      // Blocked startup closes host admission before a worker write is allocated.
      await expect(
        reopened.backend.engine.reserve(make(nextOwner, bytes), bytes.length),
      ).rejects.toThrow("stale");
      expect(
        await Promise.all([headPath, objectPath, identityPath].map((file) => readFile(file))),
      ).toEqual(before);
      if (mode === "symlink" || mode === "hardlink") expect(await readFile(outside)).toEqual(bytes);
    } finally {
      await reopened.backend.dispose();
    }
  },
);
