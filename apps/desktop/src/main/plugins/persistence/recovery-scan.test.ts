import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createNodePersistenceFs, type StoreFd } from "./filesystem.js";
import { Namespace, parseHead, type DiskHead } from "./namespace.js";
import { AtomicStore } from "./atomic-store.js";
import { scanNamespace, garbageCandidates } from "./recovery-scan.js";
it("keeps a complete new head, protects pins, and refuses unknown format without destructive repair", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "recover-"));
  try {
    const epoch = randomUUID(),
      fs = await createNodePersistenceFs(root, { hostEpoch: epoch, assertHeld() {} });
    const ns = await Namespace.open(fs, "builtin:kobrixa.lab"),
      target = { kind: "settings" as const, expectedRevision: null },
      loc = await ns.location(target, true);
    const body = {
      formatVersion: 1,
      schemaVersion: 1,
      validationDigest: "0".repeat(64),
      values: [],
    };
    const raw = Buffer.from(JSON.stringify(body)),
      revision = "r_" + "1".repeat(32);
    const head: DiskHead = {
      formatVersion: 1,
      target,
      metadata: { kind: "settings", schemaVersion: 1, validationDigest: "0".repeat(64) },
      object: revision + ".json",
      byteLength: raw.length,
      sha256: createHash("sha256").update(raw).digest("hex"),
      receipt: { revision, commitId: randomUUID(), durability: fs.durability },
    };
    await ns.writeNew(ns.object(loc, head), body);
    await ns.writeNew(loc.head, head);
    await ns.writeNew(loc.previous, head);
    expect((await scanNamespace(ns, epoch)).heads[0]?.receipt).toEqual(head.receipt);
    const orphan = ns.path("settings", "objects", "r_" + "2".repeat(32) + ".json");
    await ns.writeNew(orphan, { untouched: true });
    expect(
      (await garbageCandidates(ns, new Set([fs.name(orphan)]))).map((p) => fs.name(p)),
    ).not.toContain(fs.name(orphan));
    expect((await garbageCandidates(ns, new Set())).map((p) => fs.name(p))).toContain(
      fs.name(orphan),
    );
    await fs.unlink(loc.head);
    await ns.writeNew(loc.head, { formatVersion: 1, broken: true });
    const rollback = await scanNamespace(ns, epoch);
    expect(rollback.problems).toContain("rollback-interrupted");
    expect((await ns.head(loc))?.receipt).toEqual(head.receipt);
    expect(await fs.entries(ns.path("quarantine"), 4096)).toHaveLength(1);
    await fs.unlink(loc.head);
    await ns.writeNew(loc.head, { ...head, formatVersion: 99 });
    await expect(scanNamespace(ns, epoch)).rejects.toThrow("unsupported-format");
    expect(JSON.parse(Buffer.from(await fs.bytes(loc.head, 8192)).toString()).formatVersion).toBe(
      99,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("does not treat EACCES as corruption or manufacture defaults", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "recover-permission-"));
  try {
    const fs = await createNodePersistenceFs(root, { hostEpoch: randomUUID(), assertHeld() {} });
    const ns = await Namespace.open(fs, "builtin:kobrixa.lab"),
      original = fs.entries.bind(fs);
    fs.entries = async (p, max) => {
      if (fs.name(p).endsWith("settings"))
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      return original(p, max);
    };
    await expect(scanNamespace(ns, fs.profile.hostEpoch)).rejects.toMatchObject({ code: "EACCES" });
    expect(await original(ns.path("quarantine"), 4096)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
for (const kind of ["settings", "import", "recovery"] as const)
  it(`blocks unknown ${kind} payload versions without rewriting evidence`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "unknown-envelope-"));
    try {
      const fs = await createNodePersistenceFs(root, { hostEpoch: randomUUID(), assertHeld() {} }),
        ns = await Namespace.open(fs, "builtin:kobrixa.lab");
      const target = kind === "settings" ? { kind, expectedRevision: null } : { kind, key: "test" };
      const metadata =
        kind === "settings"
          ? { kind, schemaVersion: 1, validationDigest: "0".repeat(64) }
          : { kind, key: "test" };
      const loc = await ns.location(target, true),
        body = { formatVersion: 99, value: "preserve" },
        raw = Buffer.from(JSON.stringify(body)),
        revision = "r_" + "a".repeat(32);
      const head: DiskHead = {
        formatVersion: 1,
        target,
        metadata,
        object: revision + ".json",
        byteLength: raw.length,
        sha256: createHash("sha256").update(raw).digest("hex"),
        receipt: { revision, commitId: randomUUID(), durability: fs.durability },
      };
      await ns.writeNew(ns.object(loc, head), body);
      await ns.writeNew(loc.head, head);
      await expect(scanNamespace(ns, fs.profile.hostEpoch)).rejects.toThrow("unsupported-format");
      expect(await fs.bytes(ns.object(loc, head), 2097152)).toEqual(new Uint8Array(raw));
      expect(await ns.head(loc)).toEqual(head);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
it("classifies a recovered import metadata candidate before cleaning staging", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "import-recover-"));
  try {
    const epoch = randomUUID(),
      fs = await createNodePersistenceFs(root, { hostEpoch: epoch, assertHeld() {} }),
      ns = await Namespace.open(fs, "builtin:kobrixa.lab");
    const owner = {
        sourceKey: ns.sourceKey,
        pluginId: "kobrixa.lab",
        generation: 1,
        hostEpoch: randomUUID(),
        processEpoch: randomUUID(),
      },
      target = { kind: "import" as const, key: "fault-matrix" };
    const ticket = {
        id: randomUUID(),
        owner,
        deadlineMonotonicMs: 10000,
        target,
        metadata: target,
      },
      loc = await ns.location(target, true),
      body = { formatVersion: 1, value: 1 },
      raw = Buffer.from(JSON.stringify(body)),
      revision = "r_" + "b".repeat(32);
    const head: DiskHead = {
      formatVersion: 1,
      target,
      metadata: target,
      object: revision + ".json",
      byteLength: raw.length,
      sha256: createHash("sha256").update(raw).digest("hex"),
      receipt: { revision, commitId: randomUUID(), durability: fs.durability },
    };
    await ns.writeNew(ns.object(loc, head), body);
    await ns.writeNew(loc.head, head);
    await fs.mkdir(ns.path("staging", ticket.id));
    await ns.writeNew(ns.path("staging", ticket.id, "intent.json"), {
      formatVersion: 1,
      ticket,
      byteLength: raw.length,
      predecessor: null,
    });
    await ns.writeNew(ns.path("staging", ticket.id, "publication.json"), head);
    const payload = ns.path("staging", ticket.id, "payload.tmp");
    await ns.writeNew(payload, { leftover: true });
    const replace = fs.atomicReplace.bind(fs);
    fs.atomicReplace = async (from, to) => {
      if (fs.name(to).endsWith("resolved.json")) expect(await fs.exists(payload)).toBe(false);
      await replace(from, to);
    };
    const scan = await scanNamespace(ns, epoch);
    expect(scan.problems).toEqual([]);
    expect(await fs.exists(ns.path("staging", ticket.id, "intent.json"))).toBe(true);
    const resolved = { formatVersion: 1, disposition: "committed", receipt: head.receipt };
    expect(
      JSON.parse(
        Buffer.from(
          await fs.bytes(ns.path("staging", ticket.id, "resolved.json"), 8192),
        ).toString(),
      ),
    ).toEqual(resolved);
    // Recreate the state left by older writers crashing after verdict publication.
    await ns.writeNew(payload, { leftover: true });
    await fs.unlink(loc.head);
    await ns.writeNew(loc.head, { ...head, receipt: { ...head.receipt, commitId: randomUUID() } });
    expect((await scanNamespace(ns, epoch)).problems).toEqual([]);
    expect(await fs.exists(payload)).toBe(false);
    const store = new AtomicStore(fs);
    await store.initialize();
    expect(await store.reconcileImport(ticket)).toEqual({
      disposition: "committed",
      receipt: head.receipt,
    });
    await store.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { cp, link, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { importIdFor } from "./import-sources.js";
import type { PublicationTicket } from "./engine-port.js";
function recordFixture(byteLength: number) {
  const owner = {
    sourceKey: "builtin:test.synthetic",
    pluginId: "test.synthetic",
    generation: 1,
    hostEpoch: randomUUID(),
    processEpoch: randomUUID(),
  };
  const bytes = Buffer.alloc(byteLength, 42),
    sha = createHash("sha256").update(bytes).digest("hex"),
    id = randomUUID();
  const planned: PublicationTicket = {
    id: randomUUID(),
    owner,
    deadlineMonotonicMs: 10000,
    target: { kind: "record", id, expectedRevision: null },
    metadata: {
      kind: "record",
      deleted: false,
      record: {
        id,
        revision: "r_" + randomUUID().replaceAll("-", ""),
        kind: "test.synthetic",
        schemaVersion: 1,
        label: "import",
        mediaType: "application/octet-stream",
        byteLength: bytes.length,
        sha256: sha,
        createdAt: 1,
        updatedAt: 1,
        checkpoint: "none",
        interrupted: false,
      },
    },
  };
  return { owner, bytes, sha, planned };
}
async function preHeadImport(
  ordinary = false,
  keepLive = false,
  byteLength = 8388608,
  itemKey = "first",
  captureSidecars = false,
) {
  const root = await mkdtemp(path.join(tmpdir(), "pre-head-import-"));
  const snapshot = path.join(root, "snapshot");
  let copying = false;
  const { owner, bytes, sha, planned } = recordFixture(byteLength);
  const fs = await createNodePersistenceFs(
    root,
    { hostEpoch: owner.hostEpoch, assertHeld() {} },
    {
      now: () => 0,
      fault: async (point, edge) => {
        if (copying && point === "before-publish" && edge === "before") {
          await cp(path.join(root, "plugins"), path.join(snapshot, "plugins"), { recursive: true });
          throw Error("simulated-process-loss-after-filesystem-snapshot");
        }
      },
    },
  );
  const store = new AtomicStore(fs);
  await store.initialize();
  const descriptorId = "test.synthetic.files",
    planId = importIdFor(descriptorId, owner.sourceKey),
    tag = { importId: planId, itemKey, sourceSha256: sha };
  if (!ordinary)
    await store.planImport(owner, {
      formatVersion: 1,
      id: planId,
      descriptorId,
      mappingVersion: 1,
      targetSourceKey: owner.sourceKey,
      preferencesEvidence: null,
      items: [
        {
          key: itemKey,
          sourceFormat: 1,
          sourceSha256: sha,
          mappedSha256: sha,
          byteLength: bytes.length,
          ticket: planned,
          tag,
        },
      ],
    });
  const attempt = ordinary ? planned : await store.admitImport(owner, planId, itemKey);
  await store.reserve(attempt, bytes.length);
  if (captureSidecars) {
    const open = fs.openOwned.bind(fs),
      close = fs.closeOwned.bind(fs);
    const captures = new Map<StoreFd, string>();
    fs.openOwned = async (file, mode) => {
      const fd = await open(file, mode);
      const filename = fs.name(file);
      const leaf = path.basename(filename);
      if (
        mode === "create-exclusive" &&
        path.basename(path.dirname(filename)) === attempt.id &&
        ["import-tag.json", "sealed.json", "publication.json"].includes(leaf)
      )
        captures.set(fd, leaf);
      return fd;
    };
    fs.closeOwned = async (fd, id) => {
      await close(fd, id);
      const leaf = captures.get(fd);
      if (leaf) {
        captures.delete(fd);
        await cp(path.join(root, "plugins"), path.join(root, leaf, "plugins"), { recursive: true });
      }
    };
  }
  if (!ordinary) await store.tagImport(attempt, tag);
  for (let offset = 0; offset < bytes.length; offset += 262144)
    await store.append(attempt, offset, bytes.subarray(offset, offset + 262144));
  await store.seal(attempt, bytes.length, sha);
  let safeAttempt: PublicationTicket | undefined;
  if (ordinary && planned.metadata.kind === "record") {
    const safeId = randomUUID(),
      safeBytes = Buffer.from("abc"),
      safeHash = createHash("sha256").update(safeBytes).digest("hex");
    safeAttempt = {
      ...planned,
      id: randomUUID(),
      target: { kind: "record", id: safeId, expectedRevision: null },
      metadata: {
        kind: "record",
        deleted: false,
        record: {
          ...planned.metadata.record,
          id: safeId,
          revision: "r_" + randomUUID().replaceAll("-", ""),
          byteLength: 3,
          sha256: safeHash,
        },
      },
    };
    await store.reserve(safeAttempt, 3);
    await store.append(safeAttempt, 0, safeBytes);
    await store.seal(safeAttempt, 3, safeHash);
  }
  copying = true;
  await expect(store.publish(attempt)).rejects.toThrow("simulated-process-loss");
  copying = false;
  if (!keepLive) await store.dispose();
  const nextOwner = { ...owner, hostEpoch: randomUUID(), processEpoch: randomUUID() };
  const nextFs = await createNodePersistenceFs(
    snapshot,
    { hostEpoch: nextOwner.hostEpoch, assertHeld() {} },
    { now: () => 0 },
  );
  const ns = await Namespace.open(nextFs, owner.sourceKey),
    loc = await ns.location(attempt.target);
  return {
    root,
    snapshot,
    nextFs,
    ns,
    loc,
    planned,
    attempt,
    nextOwner,
    planId,
    tag,
    bytes,
    safeAttempt,
    store,
    fs,
  };
}
it("pre-head import restart preserves unpublished evidence, reconciles not committed and admits only a fresh attempt", async () => {
  const f = await preHeadImport();
  try {
    // Repeated scans also cover the older failed recovery which removed staging intent.
    for (let n = 0; n < 3; n++) {
      const scan = await scanNamespace(f.ns, f.nextOwner.hostEpoch);
      expect(scan.problems).toEqual([]);
      expect(scan.totals.committed).toBe(0);
      expect(scan.totals.temporary).toBe(f.bytes.length);
      expect(await f.ns.head(f.loc)).toBeNull();
    }
    const evidence = f.ns.path("quarantine", `${f.attempt.id}.prepublish.bin`);
    expect(
      createHash("sha256")
        .update(await f.nextFs.bytes(evidence, 8388608))
        .digest("hex"),
    ).toBe(f.tag.sourceSha256);
    const store = new AtomicStore(f.nextFs);
    await store.initialize();
    expect(await store.reconcileImport(f.attempt)).toEqual({ disposition: "not-committed" });
    expect((await store.list(f.nextOwner, { limit: 64 })).entries).toEqual([]);
    await expect(store.reserve(f.attempt, f.bytes.length)).rejects.toThrow("stale");
    const fresh = await store.admitImport(f.nextOwner, f.planId, "first");
    expect(fresh.id).not.toBe(f.attempt.id);
    expect(fresh.target).toEqual(f.attempt.target);
    await store.reserve(fresh, f.bytes.length);
    await store.tagImport(fresh, f.tag);
    for (let offset = 0; offset < f.bytes.length; offset += 262144)
      await store.append(fresh, offset, f.bytes.subarray(offset, offset + 262144));
    await store.seal(fresh, f.bytes.length, f.tag.sourceSha256);
    const committed = await store.publish(fresh);
    expect(committed.disposition).toBe("committed");
    await store.recordImport(f.nextOwner, f.planId, {
      key: "first",
      state: "committed",
      receipt: committed.receipt!,
      skipReason: null,
      publicationTicket: fresh,
    });
    await store.completeImport(f.nextOwner, f.planId);
    await store.dispose();
    const reopened = new AtomicStore(f.nextFs);
    await reopened.initialize();
    expect((await reopened.list(f.nextOwner, { limit: 64 })).entries).toHaveLength(1);
    expect(await reopened.reconcileImport(f.planned)).toEqual(committed);
    await reopened.dispose();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
for (const alteration of [
  "missing-candidate",
  "zero-copy",
  "wrong-object-hash",
  "foreign-attempt",
  "terminal-journal",
  "extra-object",
  "extra-candidate",
  "corrupt-payload",
  "unknown-version",
] as const)
  it(`pre-head import recovery blocks ${alteration} without publishing`, async () => {
    const f = await preHeadImport();
    try {
      const candidate = f.ns.path(...f.loc.parts, `head.${f.attempt.id}.tmp`);
      const raw = JSON.parse(Buffer.from(await f.nextFs.bytes(candidate, 8192)).toString());
      if (alteration === "corrupt-payload")
        await writeFile(f.nextFs.name(f.ns.object(f.loc, raw)), Buffer.alloc(f.bytes.length, 13));
      if (alteration === "missing-candidate") await f.nextFs.unlink(candidate);
      if (alteration === "zero-copy") await f.nextFs.unlink(f.ns.object(f.loc, raw));
      if (alteration === "extra-candidate")
        await f.ns.writeNew(f.ns.path(...f.loc.parts, `head.${randomUUID()}.tmp`), raw);
      if (alteration === "extra-object")
        await f.ns.writeNew(f.ns.path(...f.loc.parts, "objects", "r_" + "a".repeat(32) + ".bin"), {
          extra: true,
        });
      if (alteration === "terminal-journal") await f.ns.writeNew(f.loc.head, raw); // then remove it after terminal evidence is durable
      if (alteration === "terminal-journal") {
        const s = new AtomicStore(f.nextFs);
        await s.initialize();
        await s.recordImport(f.nextOwner, f.planId, {
          key: "first",
          state: "committed",
          receipt: raw.receipt,
          skipReason: null,
          publicationTicket: f.attempt,
        });
        await s.dispose();
        await f.nextFs.unlink(f.loc.head);
      }
      if (["wrong-object-hash", "foreign-attempt", "unknown-version"].includes(alteration)) {
        if (alteration === "wrong-object-hash") {
          raw.sha256 = "0".repeat(64);
          raw.metadata.record.sha256 = raw.sha256;
        }
        if (alteration === "foreign-attempt") raw.receipt.commitId = randomUUID();
        if (alteration === "unknown-version") raw.formatVersion = 99;
        await f.nextFs.unlink(candidate);
        await f.ns.writeNew(candidate, raw);
      }
      for (let epoch = 0; epoch < 2; epoch++) {
        const fs = await createNodePersistenceFs(f.snapshot, {
          hostEpoch: randomUUID(),
          assertHeld() {},
        });
        await expect(new AtomicStore(fs).initialize()).rejects.toThrow("recovery-blocked");
        if (alteration === "zero-copy") {
          expect(await f.nextFs.exists(candidate)).toBe(true);
          expect(await f.nextFs.exists(f.ns.path("staging", f.attempt.id, "intent.json"))).toBe(
            true,
          );
        }
      }

      expect(await f.ns.head(f.loc)).toBeNull();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
for (const edge of [".prepublish.bin", ".prepublish-head"])
  it(`pre-head import quarantine interruption after ${edge} retains bytes and no head`, async () => {
    const f = await preHeadImport();
    try {
      const replace = f.nextFs.atomicReplace.bind(f.nextFs);
      let injected = false;
      f.nextFs.atomicReplace = async (from, to) => {
        await replace(from, to);
        if (!injected && f.nextFs.name(to).endsWith(edge)) {
          injected = true;
          throw Error("quarantine-interrupted");
        }
      };
      await expect(scanNamespace(f.ns, f.nextOwner.hostEpoch)).rejects.toThrow(
        "quarantine-interrupted",
      );
      f.nextFs.atomicReplace = replace;
      const scan = await scanNamespace(f.ns, f.nextOwner.hostEpoch);
      expect(scan.problems).toEqual([]);
      expect(scan.totals.temporary).toBe(f.bytes.length);
      expect(await f.ns.head(f.loc)).toBeNull();
      const retained = await f.nextFs.bytes(
        f.ns.path("quarantine", `${f.attempt.id}.prepublish.bin`),
        8388608,
      );
      expect(createHash("sha256").update(retained).digest("hex")).toBe(f.tag.sourceSha256);
      const store = new AtomicStore(f.nextFs);
      await store.initialize();
      expect(await store.reconcileImport(f.attempt)).toEqual({ disposition: "not-committed" });
      await store.dispose();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

it("unresolved ordinary first-create retains exact evidence across unavailable startups while safe old staging is cleaned", async () => {
  const f = await preHeadImport(true);
  try {
    // This independent sealed write was made through the actual engine before the snapshot.
    expect(f.safeAttempt).toBeDefined();
    const safeDir = f.ns.path("staging", f.safeAttempt!.id);
    const evidence = async () => {
      const files = (await f.ns.inventory()).filter(
        (file) =>
          file.relative.startsWith(`staging/${f.attempt.id}/`) ||
          file.relative.startsWith(
            `records/${f.attempt.target.kind === "record" ? f.attempt.target.id : ""}/`,
          ),
      );
      return Promise.all(
        files
          .sort((a, b) => a.relative.localeCompare(b.relative))
          .map(async (file) => ({
            name: file.relative,
            bytes: file.bytes,
            sha256: createHash("sha256")
              .update(await f.nextFs.bytes(file.path, 8388608))
              .digest("hex"),
          })),
      );
    };
    const before = await evidence();
    expect(before.some((e) => e.name.endsWith("intent.json"))).toBe(true);
    expect(before.some((e) => e.name.endsWith("sealed.json"))).toBe(true);
    for (let n = 0; n < 3; n++) {
      const fs = await createNodePersistenceFs(f.snapshot, {
        hostEpoch: randomUUID(),
        assertHeld() {},
      });
      await expect(new AtomicStore(fs).initialize()).rejects.toThrow("recovery-blocked");
      expect(await evidence()).toEqual(before);
      expect(await f.ns.head(f.loc)).toBeNull();
      expect(await f.nextFs.entries(f.ns.path("quarantine"), 4096)).toEqual([]);
      expect(await f.nextFs.exists(safeDir)).toBe(false);
    }
    // Already-erased evidence is not recreated and does not grant recovery authority.
    await f.nextFs.unlink(f.ns.path("staging", f.attempt.id, "intent.json"));
    await expect(new AtomicStore(f.nextFs).initialize()).rejects.toThrow("recovery-blocked");
    expect(await f.nextFs.exists(f.ns.path("staging", f.attempt.id, "intent.json"))).toBe(false);
    expect(await f.nextFs.exists(f.ns.path("staging", f.attempt.id, "sealed.json"))).toBe(true);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it("two consecutive prepublish crashes finish half quarantine and retain both 8 MiB payloads", async () => {
  const f = await preHeadImport();
  try {
    const original = structuredClone(f.attempt),
      planned = structuredClone(f.planned);
    const replace = f.nextFs.atomicReplace.bind(f.nextFs);
    let interrupted = false;
    f.nextFs.atomicReplace = async (from, to) => {
      await replace(from, to);
      if (!interrupted && f.nextFs.name(to).endsWith(".prepublish.bin")) {
        interrupted = true;
        throw Error("half-quarantine");
      }
    };
    await expect(scanNamespace(f.ns, f.nextOwner.hostEpoch)).rejects.toThrow("half-quarantine");
    f.nextFs.atomicReplace = replace;
    const oldCandidate = f.ns.path(...f.loc.parts, `head.${f.attempt.id}.tmp`);
    expect(await f.nextFs.exists(oldCandidate)).toBe(true);
    const reopened = new AtomicStore(f.nextFs);
    await reopened.initialize();
    const fresh = await reopened.admitImport(f.nextOwner, f.planId, "first");
    expect(fresh.id).not.toBe(f.attempt.id);
    expect(fresh.target).toEqual(f.attempt.target);
    await expect(reopened.reserve(f.attempt, f.bytes.length)).rejects.toThrow("stale");
    await reopened.reserve(fresh, f.bytes.length);
    await reopened.tagImport(fresh, f.tag);
    for (let offset = 0; offset < f.bytes.length; offset += 262144)
      await reopened.append(fresh, offset, f.bytes.subarray(offset, offset + 262144));
    await reopened.seal(fresh, f.bytes.length, f.tag.sourceSha256);
    const secondSnapshot = path.join(f.root, "second-snapshot");
    const fault = f.nextFs.fault.bind(f.nextFs);
    f.nextFs.fault = async (point, ...args) => {
      if (point === "before-publish") {
        await cp(path.join(f.snapshot, "plugins"), path.join(secondSnapshot, "plugins"), {
          recursive: true,
        });
        throw Error("second-prepublish-process-loss");
      }
      return fault(point, ...args);
    };
    await expect(reopened.publish(fresh)).rejects.toThrow("second-prepublish-process-loss");
    f.nextFs.fault = fault;
    await reopened.dispose();
    const owner = { ...f.nextOwner, hostEpoch: randomUUID(), processEpoch: randomUUID() };
    const fs = await createNodePersistenceFs(secondSnapshot, {
      hostEpoch: owner.hostEpoch,
      assertHeld() {},
    });
    const ns = await Namespace.open(fs, owner.sourceKey),
      loc = await ns.location(fresh.target);
    const store = new AtomicStore(fs);
    await store.initialize();
    for (let n = 0; n < 2; n++) {
      const scan = await scanNamespace(ns, owner.hostEpoch);
      expect(scan.problems).toEqual([]);
      expect(scan.totals.temporary).toBe(16777216);
      expect(scan.totals.committed).toBe(0);
      expect(await ns.head(loc)).toBeNull();
      expect((await store.list(owner, { limit: 64 })).entries).toEqual([]);
    }
    for (const ticket of [f.attempt, fresh]) {
      expect(await fs.exists(ns.path(...loc.parts, `head.${ticket.id}.tmp`))).toBe(false);
      const payload = await fs.bytes(ns.path("quarantine", `${ticket.id}.prepublish.bin`), 8388608);
      expect(createHash("sha256").update(payload).digest("hex")).toBe(f.tag.sourceSha256);
      const head = JSON.parse(
        Buffer.from(
          await fs.bytes(ns.path("quarantine", `${ticket.id}.prepublish-head`), 8192),
        ).toString(),
      );
      expect(head.receipt.commitId).toBe(ticket.id);
      expect(head.metadata).toEqual(ticket.metadata);
      await expect(store.reserve(ticket, f.bytes.length)).rejects.toThrow("stale");
    }
    expect(await store.reconcileImport(fresh)).toEqual({ disposition: "not-committed" });
    expect(await store.reconcileImport(f.planned)).toEqual({ disposition: "not-committed" });
    expect(f.attempt).toEqual(original);
    expect(f.planned).toEqual(planned);
    await store.dispose();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

for (const alteration of [
  "foreign-payload",
  "occupied-head-destination",
  "extra-candidate",
  "foreign-journal",
] as const)
  it(`half quarantine fails closed for ${alteration}`, async () => {
    const f = await preHeadImport();
    try {
      const replace = f.nextFs.atomicReplace.bind(f.nextFs);
      let interrupted = false;
      f.nextFs.atomicReplace = async (from, to) => {
        await replace(from, to);
        if (!interrupted && f.nextFs.name(to).endsWith(".prepublish.bin")) {
          interrupted = true;
          throw Error("half-quarantine");
        }
      };
      await expect(scanNamespace(f.ns, f.nextOwner.hostEpoch)).rejects.toThrow("half-quarantine");
      f.nextFs.atomicReplace = replace;
      const candidate = f.ns.path(...f.loc.parts, `head.${f.attempt.id}.tmp`),
        payload = f.ns.path("quarantine", `${f.attempt.id}.prepublish.bin`),
        destination = f.ns.path("quarantine", `${f.attempt.id}.prepublish-head`);
      if (alteration === "foreign-payload")
        await writeFile(f.nextFs.name(payload), Buffer.alloc(f.bytes.length, 13));
      if (alteration === "occupied-head-destination")
        await f.ns.writeNew(destination, { foreign: true });
      if (alteration === "extra-candidate")
        await f.ns.writeNew(
          f.ns.path(...f.loc.parts, `head.${randomUUID()}.tmp`),
          JSON.parse(Buffer.from(await f.nextFs.bytes(candidate, 8192)).toString()),
        );
      if (alteration === "foreign-journal") {
        const raw = JSON.parse(Buffer.from(await f.nextFs.bytes(candidate, 8192)).toString());
        raw.importTag.itemKey = "foreign";
        await writeFile(f.nextFs.name(candidate), JSON.stringify(raw));
      }
      const inventory = async () =>
        Promise.all(
          (await f.ns.inventory())
            .filter(
              (file) =>
                file.relative.startsWith("records/") ||
                file.relative.startsWith("quarantine/") ||
                file.relative.startsWith(`staging/${f.attempt.id}/`),
            )
            .map(async (file) => ({
              name: file.relative,
              sha: createHash("sha256")
                .update(await f.nextFs.bytes(file.path, 8388608))
                .digest("hex"),
            })),
        );
      const before = await inventory();
      await expect(new AtomicStore(f.nextFs).initialize()).rejects.toThrow("recovery-blocked");
      expect(await inventory()).toEqual(before);
      expect(await f.ns.head(f.loc)).toBeNull();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

it.each([0, 8388608])(
  "confirmed installed abort releases %i payload bytes and retires its reservation once",
  async (byteLength) => {
    const f = await preHeadImport(false, true, byteLength);
    try {
      const owner = f.attempt.owner;
      const call = vi.spyOn(f.store.quota, "commit");
      const ns = await Namespace.open(f.fs, owner.sourceKey);
      const loc = await ns.location(f.attempt.target);
      const candidate = ns.path(...loc.parts, "head." + f.attempt.id + ".tmp");
      expect((await stat(f.fs.name(candidate))).size).toBeGreaterThan(0);
      expect(f.store.quota.snapshot(owner.sourceKey)).toMatchObject({
        reservedBytes: f.bytes.length,
        recordCount: 0,
        temporaryBytes: 0,
      });
      expect(await f.store.abort(f.attempt)).toBe("aborted");
      expect(await f.store.abort(f.attempt)).toBe("aborted");
      expect(call.mock.calls).toEqual([
        [f.attempt.id, { committed: 0, records: 0, temporary: 0, metadata: 0 }],
      ]);
      expect(await f.fs.entries(ns.path("quarantine"), 4096)).toEqual([]);
      const live = f.store.quota.snapshot(owner.sourceKey);
      expect(live).toMatchObject({
        reservedBytes: 0,
        reservedCreates: 0,
        recordCount: 0,
        committedBytes: 0,
        pinnedBytes: 0,
        temporaryBytes: 0,
      });
      const nextFs = await createNodePersistenceFs(f.root, {
        hostEpoch: randomUUID(),
        assertHeld() {},
      });
      const next = new AtomicStore(nextFs);
      await next.initialize();
      expect(next.quota.snapshot(owner.sourceKey)).toEqual(live);
      await next.dispose();
    } finally {
      await f.store.dispose();
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

for (const defect of [
  "object collision",
  "head collision",
  "unknown version",
  "wrong ticket",
  "wrong intent target",
  "wrong bytes",
  "unsafe alias",
  "unexpected record name",
  "unexpected stage name",
  "unexpected quarantine name",
  "failed descriptor close",
  "failed second directory sync",
  "failed final directory sync",
  "temporary quota exhausted",
] as const)
  it("live abort retains the exact obligation on " + defect, async () => {
    const f = await preHeadImport(false, true);
    const source = f.attempt.owner.sourceKey;
    try {
      const ns = await Namespace.open(f.fs, source);
      const loc = await ns.location(f.attempt.target);
      const candidate = ns.path(...loc.parts, "head." + f.attempt.id + ".tmp");
      const raw = parseHead(await f.fs.bytes(candidate, 8192));
      const object = ns.object(loc, raw);
      const stage = ns.path("staging", f.attempt.id, "intent.json");
      if (defect === "object collision" || defect === "head collision")
        await ns.writeNew(
          ns.path(
            "quarantine",
            f.attempt.id + (defect === "head collision" ? ".prepublish-head" : ".prepublish.bin"),
          ),
          { collision: true },
        );
      if (defect === "wrong bytes")
        await writeFile(f.fs.name(object), Buffer.alloc(f.bytes.length, 17));
      if (defect === "unsafe alias") await link(f.fs.name(object), path.join(f.root, "alias"));
      if (defect === "wrong ticket" || defect === "wrong intent target") {
        const intent = JSON.parse(Buffer.from(await f.fs.bytes(stage, 8192)).toString());
        if (defect === "wrong ticket") intent.ticket.id = randomUUID();
        else intent.ticket.target.id = randomUUID();
        await writeFile(f.fs.name(stage), JSON.stringify(intent));
      }
      if (defect === "unknown version")
        await writeFile(f.fs.name(candidate), JSON.stringify({ ...raw, formatVersion: 99 }));
      if (defect === "unexpected quarantine name")
        await ns.writeNew(ns.path("quarantine", "unexplained"), {});
      if (defect === "unexpected record name")
        await ns.writeNew(ns.path(...loc.parts, "unexplained"), {});
      if (defect === "unexpected stage name")
        await ns.writeNew(ns.path("staging", f.attempt.id, "unexplained"), {});
      if (defect === "temporary quota exhausted")
        f.store.quota.holdTemporary(source, "independent-pin", 33554432 - f.bytes.length + 1);
      if (defect === "failed second directory sync" || defect === "failed final directory sync") {
        const sync = f.fs.syncDirectory.bind(f.fs);
        f.fs.syncDirectory = async (p) => {
          const destination =
            defect === "failed final directory sync" ? loc.directory : loc.objects;
          if (f.fs.name(p) === f.fs.name(destination)) throw Error("sync-failed");
          return sync(p);
        };
      }
      if (defect === "failed descriptor close") {
        const close = f.fs.close.bind(f.fs);
        const open = f.fs.open.bind(f.fs);
        let fd: Awaited<ReturnType<typeof open>> | undefined;
        f.fs.open = async (...args) => {
          const result = await open(...args);
          if (f.fs.name(args[0]) === f.fs.name(object)) fd = result;
          return result;
        };
        f.fs.close = async (handle) => {
          await close(handle);
          if (handle === fd) throw Error("close-failed");
        };
      }
      for (let i = 0; i < 2; i++) {
        await expect(f.store.abort(f.attempt)).rejects.toThrow();
        expect(f.store.settlement(f.attempt.id)).toBeNull();
        expect(await f.store.reconcile(f.attempt)).toEqual({ disposition: "unknown" });
        expect(await f.store.reconcileImport(f.planned)).toEqual({ disposition: "unknown" });
        expect(f.store.quota.snapshot(source)).toMatchObject({
          reservedBytes: f.bytes.length,
          reservedCreates: 1,
          recordCount: 0,
        });
        const moved = defect === "failed final directory sync";
        expect(await f.fs.exists(candidate)).toBe(!moved);
        if (moved) {
          const evidence = ns.path("quarantine", f.attempt.id + ".prepublish-head");
          expect(parseHead(await f.fs.bytes(evidence, 8192))).toEqual(raw);
        }
        expect(await f.fs.exists(stage)).toBe(true);
        expect(await ns.head(loc)).toBeNull();
      }
      const newFs = await createNodePersistenceFs(f.root, {
        hostEpoch: randomUUID(),
        assertHeld() {},
      });
      const restart = new AtomicStore(newFs);
      if (defect.startsWith("failed ") || defect === "temporary quota exhausted") {
        await restart.initialize();
        expect(restart.quota.snapshot(source).temporaryBytes).toBe(
          defect === "failed descriptor close" ? f.bytes.length : 0,
        );
      } else {
        await expect(restart.initialize()).rejects.toThrow("recovery-blocked");
        const again = new AtomicStore(newFs);
        await expect(again.initialize()).rejects.toThrow("recovery-blocked");
        expect(await f.fs.exists(candidate)).toBe(true);
        expect(await f.fs.exists(stage)).toBe(true);
      }
      await restart.dispose();
    } finally {
      await expect(f.store.dispose()).rejects.toThrow();
      await rm(f.root, { recursive: true, force: true });
    }
  });

it.each([
  "exact prefix",
  "competing empty journal scratch",
  "competing shared journal prefix",
  "truncated legacy final",
  "empty legacy final",
  "foreign prefix",
  "malformed UTF-8 scratch",
  "reordered scratch",
  "illegal ticket token",
  "wrong planned size",
  "trailing byte",
  "oversized scratch",
  "unexpected sibling",
  "unknown version",
  "other ticket",
])(
  "interrupted initial record intent with %s requires its positive journal binding",
  async (shape) => {
    const f = await preHeadImport();
    try {
      const ns = f.ns,
        fs = f.nextFs;
      const candidate = ns.path(...f.loc.parts, "head." + f.attempt.id + ".tmp");
      await fs.unlink(ns.object(f.loc, parseHead(await fs.bytes(candidate, 8192))));
      await fs.unlink(candidate);
      for (const leaf of ["sealed.json", "import-tag.json"])
        await fs.unlink(ns.path("staging", f.attempt.id, leaf));
      const id = shape === "other ticket" ? randomUUID() : f.attempt.id;
      if (id !== f.attempt.id)
        await fs.atomicReplace(ns.path("staging", f.attempt.id), ns.path("staging", id));
      const intent = ns.path("staging", id, "intent.json");
      const original = Buffer.from(await fs.bytes(intent, 8192));
      let prefix: Buffer = original.subarray(0, Math.floor(original.length / 2));
      if (shape === "empty legacy final") prefix = Buffer.alloc(0);
      if (shape === "unknown version") prefix = Buffer.from('{"formatVersion":2}');
      if (shape === "foreign prefix") prefix.writeUInt8(prefix.readUInt8(4) ^ 1, 4);
      if (shape === "malformed UTF-8 scratch") prefix = damageDocument(original, "invalid UTF-8");
      if (shape === "reordered scratch") prefix = damageDocument(original, "reordered keys");
      if (shape === "illegal ticket token") prefix = Buffer.from('{"formatVersion":1,"ticket":!');
      if (shape === "wrong planned size")
        prefix = Buffer.from(JSON.stringify({ ...JSON.parse(original.toString()), byteLength: 1 }));
      if (shape === "trailing byte") prefix = Buffer.concat([original, Buffer.from(" ")]);
      if (shape === "oversized scratch")
        prefix = Buffer.concat([original, Buffer.alloc(8193 - original.length)]);
      if (shape === "competing empty journal scratch") prefix = Buffer.alloc(0);
      if (shape === "competing shared journal prefix")
        prefix = Buffer.from('{"formatVersion":1,"ticket":');
      const file = shape.endsWith("legacy final")
        ? intent
        : ns.path(
            "staging",
            id,
            shape.startsWith("competing") ? "journal-intent.tmp" : "import-record-intent.tmp",
          );
      if (file !== intent) await fs.atomicReplace(intent, file);
      await writeFile(fs.name(file), prefix);
      if (shape === "unexpected sibling") await ns.writeNew(ns.path("staging", id, "extra"), {});
      const before = await snapshotNamespace(ns);
      for (let i = 0; i < 2; i++) {
        const fresh = await createNodePersistenceFs(f.snapshot, {
          hostEpoch: randomUUID(),
          assertHeld() {},
        });
        const store = new AtomicStore(fresh);
        if (shape === "exact prefix") {
          await store.initialize();
          expect(await fs.exists(ns.path("staging", id))).toBe(false);
          expect(await store.reconcileImport(f.planned)).toEqual({ disposition: "not-committed" });
        } else {
          await expect(store.initialize()).rejects.toThrow("recovery-blocked");
          expect(await snapshotNamespace(ns)).toEqual(before);
          expect(Buffer.from(await fs.bytes(file, Math.max(8192, prefix.length)))).toEqual(prefix);
          expect(await fs.exists(ns.path("staging", id, "resolved.json"))).toBe(false);
        }
        await store.dispose();
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

it("uses direct final intents for ordinary first-create records and settings", async () => {
  const { root, fs, ticket } = await journalStage();
  try {
    const id = randomUUID();
    const regular: PublicationTicket[] = [
      {
        ...ticket,
        target: { kind: "record", id, expectedRevision: null },
        metadata: {
          kind: "record",
          deleted: false,
          record: {
            id,
            revision: "r_" + "1".repeat(32),
            kind: "test.synthetic",
            schemaVersion: 1,
            label: "",
            mediaType: "text/plain",
            byteLength: 0,
            sha256: createHash("sha256").digest("hex"),
            createdAt: 0,
            updatedAt: 0,
            checkpoint: "none",
            interrupted: false,
          },
        },
      },
      {
        ...ticket,
        id: randomUUID(),
        target: { kind: "settings", expectedRevision: null },
        metadata: { kind: "settings", schemaVersion: 1, validationDigest: "0".repeat(64) },
      },
    ];
    const store = new AtomicStore(fs);
    await store.initialize();
    const open = vi.spyOn(fs, "openOwned");
    for (const t of regular) {
      open.mockClear();
      await store.reserve(t, 0);
      const created = open.mock.calls
        .filter(([, mode]) => mode === "create-exclusive")
        .map(([p]) => fs.name(p))
        .filter((p) => path.basename(path.dirname(p)) === t.id);
      expect(created.map((p) => path.basename(p))).toEqual(["intent.json", "payload.tmp"]);
      await store.abort(t);
    }
    await store.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function journalStage() {
  const root = await mkdtemp(path.join(tmpdir(), "journal-install-"));
  const owner = {
    sourceKey: "builtin:test.synthetic",
    pluginId: "test.synthetic",
    generation: 1,
    hostEpoch: randomUUID(),
    processEpoch: randomUUID(),
  };
  const fs = await createNodePersistenceFs(
    root,
    { hostEpoch: owner.hostEpoch, assertHeld() {} },
    { now: () => 0 },
  );
  const ns = await Namespace.open(fs, owner.sourceKey);
  const target = {
    kind: "import" as const,
    key: importIdFor("test.synthetic.files", owner.sourceKey),
  };
  const ticket = { id: randomUUID(), owner, target, metadata: target, deadlineMonotonicMs: 10000 };
  const intent = { formatVersion: 1, ticket, byteLength: 0, predecessor: null };
  return { root, fs, ns, ticket, intent, dir: ns.path("staging", ticket.id) };
}

it.each([
  ["intent.json", ""],
  ["intent.json", '{"formatVersion":1,'],
  ["publication.json", ""],
  ["publication.json", '{"formatVersion":1,'],
  ["sealed.json", ""],
  ["sealed.json", '{"formatVersion":9}'],
  ["unexplained.tmp", ""],
  ["journal-intent.tmp", '{"formatVersion":9}'],
  ["journal-intent.tmp", '{"formatVersion":1,"ticket":!'],
])(
  "retains ambiguous private journal file %s with contents %j on both restarts",
  async (leaf, contents) => {
    const { root, fs, ns, ticket, intent, dir } = await journalStage();
    try {
      await fs.mkdir(dir);
      if (leaf !== "intent.json" && leaf !== "journal-intent.tmp") {
        await ns.writeNew(ns.path("staging", ticket.id, "intent.json"), intent);
      }
      const file = ns.path("staging", ticket.id, leaf);
      await writeFile(fs.name(file), contents);
      for (let i = 0; i < 2; i++) {
        const fresh = new AtomicStore(
          await createNodePersistenceFs(root, { hostEpoch: randomUUID(), assertHeld() {} }),
        );
        await expect(fresh.initialize()).rejects.toThrow("recovery-blocked");
        expect(Buffer.from(await fs.bytes(file, 8192)).toString()).toBe(contents);
        expect(await fs.exists(ns.path("staging", ticket.id, "resolved.json"))).toBe(false);
        await fresh.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each(["collision", "foreign stage", "alias", "extra name"])(
  "preserves a journal installation with %s and creates no resolution",
  async (defect) => {
    const { root, fs, ns, ticket, intent, dir } = await journalStage();
    try {
      await fs.mkdir(dir);
      const file = ns.path("staging", ticket.id, "journal-intent.tmp");
      await ns.writeNew(
        file,
        defect === "foreign stage"
          ? { ...intent, ticket: { ...ticket, id: randomUUID() } }
          : intent,
      );
      if (defect === "collision")
        await ns.writeNew(ns.path("staging", ticket.id, "intent.json"), intent);
      if (defect === "extra name")
        await ns.writeNew(ns.path("staging", ticket.id, "extra.tmp"), {});
      if (defect === "alias") await link(fs.name(file), path.join(root, "alias"));
      for (let i = 0; i < 2; i++) {
        const fresh = new AtomicStore(
          await createNodePersistenceFs(root, { hostEpoch: randomUUID(), assertHeld() {} }),
        );
        await expect(fresh.initialize()).rejects.toThrow("recovery-blocked");
        // Use native stat for the alias: the persistence adapter must reject that path.
        expect((await stat(fs.name(file))).size).toBeGreaterThan(0);
        expect(await fs.exists(ns.path("staging", ticket.id, "resolved.json"))).toBe(false);
        await fresh.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

function failIntentInstall(
  fs: Namespace["fs"],
  ns: Namespace,
  id: string,
  leaf: string,
  fault: string,
) {
  const dir = ns.path("staging", id);
  const scratch = ns.path("staging", id, leaf);
  const final = ns.path("staging", id, "intent.json");
  let fd: StoreFd | undefined;
  let failures = 0;
  const open = fs.openOwned.bind(fs),
    sync = fs.sync.bind(fs),
    close = fs.close.bind(fs),
    syncDirectory = fs.syncDirectory.bind(fs);
  fs.openOwned = async (p, mode) => {
    const opened = await open(p, mode);
    if (fs.name(p) === fs.name(scratch) && mode === "create-exclusive") fd = opened;
    return opened;
  };
  fs.sync = async (opened) => {
    if (fault === "sync" && opened === fd) {
      failures++;
      throw new Error("test-sync");
    }
    await sync(opened);
  };
  fs.close = async (opened) => {
    await close(opened);
    if (fault === "close" && opened === fd) {
      failures++;
      throw new Error("test-close");
    }
  };
  fs.syncDirectory = async (p) => {
    if (fault === "directory sync" && fs.name(p) === fs.name(dir) && (await fs.exists(final))) {
      failures++;
      throw new Error("test-directory-sync");
    }
    await syncDirectory(p);
  };
  const rename = fs.atomicReplace.bind(fs);
  fs.atomicReplace = async (from, to) => {
    if (fault === "rename" && fs.name(from) === fs.name(scratch)) {
      failures++;
      throw Error("test-rename");
    }
    return rename(from, to);
  };
  return () => failures;
}
it.each(["sync", "close", "directory sync"])(
  "keeps the exact journal reserve and source blocked after an install %s failure",
  async (fault) => {
    const { root, fs, ns, ticket, intent } = await journalStage();
    const store = new AtomicStore(fs);
    try {
      await store.initialize();
      const scratch = ns.path("staging", ticket.id, "journal-intent.tmp");
      const final = ns.path("staging", ticket.id, "intent.json");
      const failures = failIntentInstall(fs, ns, ticket.id, "journal-intent.tmp", fault);
      await expect(store.reserve(ticket, intent.byteLength)).rejects.toThrow();
      expect(failures()).toBe(1);
      const installed = fault === "directory sync";
      expect(await fs.exists(scratch)).toBe(!installed);
      expect(await fs.exists(final)).toBe(installed);
      expect(
        JSON.parse(Buffer.from(await fs.bytes(installed ? final : scratch, 8192)).toString()),
      ).toEqual(intent);
      expect(await store.abort(ticket)).toBe("unknown");
      expect(await store.reconcileImport(ticket)).toEqual({ disposition: "unknown" });
      expect(
        await store.flushEvidence(
          {
            id: randomUUID(),
            scope: { kind: "namespace", owner: ticket.owner },
            through: 1,
            deadlineMonotonicMs: 10000,
          },
          [ticket],
        ),
      ).toMatchObject({ state: "unknown", unknown: expect.arrayContaining([ticket.id]) });
      await expect(
        store.reserve({ ...ticket, id: randomUUID() }, intent.byteLength),
      ).rejects.toThrow("recovery-blocked");
      await expect(store.dispose()).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
it.each(["sync", "close", "rename", "directory sync"])(
  "keeps the exact authenticated record reserve and source blocked after an install %s failure",
  async (fault) => {
    const f = await preHeadImport(false, false, 16);
    const { root, nextFs: fs, ns } = f;
    const intent = { byteLength: f.bytes.length };
    const store = new AtomicStore(fs);
    try {
      await store.initialize();
      const ticket = await store.admitImport(f.nextOwner, f.planId, "first");
      const scratch = ns.path("staging", ticket.id, "import-record-intent.tmp");
      const final = ns.path("staging", ticket.id, "intent.json");
      const failures = failIntentInstall(fs, ns, ticket.id, "import-record-intent.tmp", fault);
      const reserve = store.reserve(ticket, intent.byteLength);
      if (fault === "close")
        await expect(reserve).rejects.toMatchObject({
          message: "recovery-blocked",
          cause: { message: "test-close" },
        });
      else await expect(reserve).rejects.toThrow("test-" + fault.replace(" ", "-"));
      expect(failures()).toBe(1);
      const installed = fault === "directory sync";
      expect(await fs.exists(scratch)).toBe(!installed);
      expect(await fs.exists(final)).toBe(installed);
      expect(
        JSON.parse(Buffer.from(await fs.bytes(installed ? final : scratch, 8192)).toString()),
      ).toEqual({ formatVersion: 1, ticket, byteLength: intent.byteLength, predecessor: null });
      expect(await store.reconcileImport(f.planned)).toEqual({ disposition: "unknown" });
      expect(await store.abort(ticket)).toBe("unknown");
      expect(await store.reconcileImport(ticket)).toEqual({ disposition: "unknown" });
      expect(
        await store.flushEvidence(
          {
            id: randomUUID(),
            scope: { kind: "namespace", owner: ticket.owner },
            through: 1,
            deadlineMonotonicMs: 10000,
          },
          [ticket],
        ),
      ).toMatchObject({ state: "unknown", unknown: expect.arrayContaining([ticket.id]) });
      await expect(
        store.reserve({ ...ticket, id: randomUUID() }, intent.byteLength),
      ).rejects.toThrow("recovery-blocked");
      await expect(store.dispose()).rejects.toThrow(
        fault === "close" ? "recovery-blocked" : "publish-uncertain",
      );
      const fresh = new AtomicStore(
        await createNodePersistenceFs(f.snapshot, { hostEpoch: randomUUID(), assertHeld() {} }),
      );
      await fresh.initialize();
      for (const identity of [ticket, f.planned])
        expect(await fresh.reconcileImport(identity)).toEqual({ disposition: "not-committed" });
      await fresh.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each([
  "exact receipt",
  "legacy unrelated receipt",
  "altered journal bytes",
  "contradictory seal",
  "surviving payload",
  "contradictory resolution scratch",
])(
  "resolves a stopped committed journal cleanup only with its own verified head (%s)",
  async (shape) => {
    const {
      root,
      fs,
      ticket: { owner, target },
    } = await journalStage();
    const snapshot = path.join(root, "snapshot");
    try {
      const writer = new AtomicStore(fs);
      await writer.initialize();
      await writer.planImport(owner, {
        formatVersion: 1,
        id: target.key,
        descriptorId: "test.synthetic.files",
        mappingVersion: 1,
        targetSourceKey: owner.sourceKey,
        preferencesEvidence: null,
        items: [],
      });
      // Stop the observation between the two real unlinks, before the predecessor object is collected.
      let id: string | undefined;
      const unlink = fs.unlink.bind(fs);
      fs.unlink = async (p) => {
        await unlink(p);
        if (path.basename(fs.name(p)) !== "publication.json") return;
        expect(id).toBeUndefined();
        id = path.basename(path.dirname(fs.name(p)));
        await cp(path.join(root, "plugins"), path.join(snapshot, "plugins"), { recursive: true });
      };
      await writer.completeImport(owner, target.key);
      await writer.dispose();
      expect(id).toBeDefined();
      const disk = await createNodePersistenceFs(snapshot, {
        hostEpoch: randomUUID(),
        assertHeld() {},
      });
      const ns = await Namespace.open(disk, owner.sourceKey);
      const loc = await ns.location(target),
        head = (await ns.head(loc))!;
      expect(head.receipt.commitId).toBe(id);
      const intent = ns.path("staging", id!, "intent.json");
      const stored = JSON.parse(Buffer.from(await disk.bytes(intent, 8192)).toString());
      expect(stored.ticket.id).toBe(id);
      expect(stored.predecessor.receipt.commitId).not.toBe(id);
      expect(await disk.exists(ns.path("staging", id!, "publication.json"))).toBe(false);
      if (shape === "legacy unrelated receipt") {
        await writeFile(
          disk.name(loc.head),
          JSON.stringify({ ...head, receipt: { ...head.receipt, commitId: randomUUID() } }),
        );
      }
      if (shape === "altered journal bytes") {
        const object = ns.object(loc, head);
        const bytes = Buffer.from(await disk.bytes(object, 2097152));
        bytes[0] = 0;
        await writeFile(disk.name(object), bytes);
      }
      if (shape === "contradictory seal")
        await ns.writeNew(ns.path("staging", id!, "sealed.json"), {
          formatVersion: 1,
          byteLength: head.byteLength,
          sha256: "0".repeat(64),
        });
      if (shape === "contradictory resolution scratch")
        await ns.writeNew(ns.path("staging", id!, "resolved.tmp"), {
          formatVersion: 1,
          disposition: "not-committed",
          receipt: null,
        });
      if (shape === "surviving payload")
        await writeFile(disk.name(ns.path("staging", id!, "payload.tmp")), "unexpected");
      const inventory = async () =>
        Promise.all(
          (await ns.inventory()).map(async (file) => [
            file.relative,
            createHash("sha256")
              .update(await disk.bytes(file.path, 2097152))
              .digest("hex"),
          ]),
        );
      const before = await inventory();
      for (let i = 0; i < 2; i++) {
        const boot = new AtomicStore(
          await createNodePersistenceFs(snapshot, { hostEpoch: randomUUID(), assertHeld() {} }),
        );
        if (shape === "exact receipt") {
          await boot.initialize();
          expect(await boot.reconcileImport(stored.ticket)).toEqual({
            disposition: "committed",
            receipt: head.receipt,
          });
        } else {
          await expect(boot.initialize()).rejects.toThrow("recovery-blocked");
          expect(await inventory()).toEqual(before);
          expect(await boot.reconcileImport(stored.ticket)).toEqual({ disposition: "unknown" });
          expect(await disk.exists(ns.path("staging", id!, "resolved.json"))).toBe(false);
        }
        expect(JSON.parse(Buffer.from(await disk.bytes(intent, 8192)).toString())).toEqual(stored);
        await boot.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("preserves an oversized seal scratch and its payload on repeated boots", async () => {
  const { root, fs, ns, ticket, intent, dir } = await journalStage();
  try {
    await fs.mkdir(dir);
    await ns.writeNew(ns.path("staging", ticket.id, "intent.json"), { ...intent, byteLength: 1 });
    const payload = ns.path("staging", ticket.id, "payload.tmp");
    await writeFile(fs.name(payload), "x");
    const scratch = ns.path("staging", ticket.id, "journal-sealed.tmp");
    const bytes = Buffer.alloc(9000, 255);
    await writeFile(fs.name(scratch), bytes);
    for (let i = 0; i < 2; i++) {
      const boot = new AtomicStore(
        await createNodePersistenceFs(root, { hostEpoch: randomUUID(), assertHeld() {} }),
      );
      await expect(boot.initialize()).rejects.toThrow("recovery-blocked");
      expect(Buffer.from(await fs.bytes(scratch, 9000))).toEqual(bytes);
      expect(Buffer.from(await fs.bytes(payload, 1)).toString()).toBe("x");
      expect(await fs.exists(ns.path("staging", ticket.id, "resolved.json"))).toBe(false);
      await boot.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps a repeated planImport publish-uncertain after its interrupted reserve", async () => {
  const {
    root,
    fs,
    ticket: { owner, target },
  } = await journalStage();
  try {
    const store = new AtomicStore(fs);
    await store.initialize();
    const plan = {
      formatVersion: 1 as const,
      id: target.key,
      descriptorId: "test.synthetic.files",
      mappingVersion: 1,
      targetSourceKey: owner.sourceKey,
      preferencesEvidence: null,
      items: [],
    };
    const open = fs.openOwned.bind(fs),
      sync = fs.sync.bind(fs);
    let pending: StoreFd | undefined;
    fs.openOwned = async (p, m) => {
      const fd = await open(p, m);
      if (m === "create-exclusive" && path.basename(fs.name(p)) === "journal-intent.tmp")
        pending = fd;
      return fd;
    };
    fs.sync = async (fd) => {
      if (fd === pending) {
        pending = undefined;
        throw Error("intent-sync");
      }
      await sync(fd);
    };
    for (let i = 0; i < 2; i++)
      await expect(store.planImport(owner, plan)).rejects.toThrow("publish-uncertain");
    await expect(store.dispose()).rejects.toThrow("publish-uncertain");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["nonce", "barrier"])(
  "retains the auxiliary %s writer's disk names and receipt identity",
  async (kind) => {
    const { root, fs, ticket } = await journalStage();
    try {
      const store = new AtomicStore(fs);
      await store.initialize();
      const target = { kind: "import" as const, key: kind + "/" + "a".repeat(64) };
      const aux = { ...ticket, target, metadata: target };
      const paths: string[] = [];
      const open = fs.openOwned.bind(fs);
      fs.openOwned = async (p, m) => {
        if (m === "create-exclusive" && fs.name(p).includes(path.sep + aux.id + path.sep))
          paths.push(path.basename(fs.name(p)));
        return open(p, m);
      };
      const body = Buffer.from(JSON.stringify({ formatVersion: 1 }));
      await store.reserve(aux, body.length);
      await store.append(aux, 0, body);
      await store.seal(aux, body.length, createHash("sha256").update(body).digest("hex"));
      const result = await store.publish(aux);
      expect(paths).toEqual(["intent.json", "payload.tmp", "sealed.json", "publication.json"]);
      expect(result.disposition).toBe("committed");
      expect(result.receipt?.commitId).toEqual(expect.any(String));
      expect(result.receipt!.commitId).not.toBe(aux.id);
      await store.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each(["headless entry", "older stage ID", "extra stage file", "failed unlink"])(
  "retains ordinary old-epoch cleanup semantics for %s",
  async (shape) => {
    const { root, fs, ns, ticket } = await journalStage();
    try {
      const id = randomUUID();
      const target = { kind: "record" as const, id, expectedRevision: null };
      const record = {
        id,
        revision: "r_" + "1".repeat(32),
        kind: "test.synthetic",
        schemaVersion: 1,
        label: "ordinary",
        mediaType: "text/plain" as const,
        byteLength: 0,
        sha256: createHash("sha256").digest("hex"),
        createdAt: 0,
        updatedAt: 0,
        checkpoint: "none" as const,
        interrupted: false,
      };
      const loc = await ns.location(target, true);
      const stage = shape === "older stage ID" ? randomUUID() : ticket.id;
      const dir = ns.path("staging", stage);
      const intent = ns.path("staging", stage, "intent.json");
      const payload = ns.path("staging", stage, "payload.tmp");
      const extra =
        shape === "headless entry"
          ? ns.path(...loc.parts, "extra")
          : ns.path("staging", stage, "extra");
      await fs.mkdir(dir);
      await ns.writeNew(intent, {
        formatVersion: 1,
        ticket: { ...ticket, target, metadata: { kind: "record", record, deleted: false } },
        byteLength: 0,
        predecessor: null,
      });
      await writeFile(fs.name(payload), "");
      if (shape === "headless entry" || shape === "extra stage file")
        await ns.writeNew(extra, { untouched: true });
      const unlink = fs.unlink.bind(fs);
      fs.unlink = async (p) => {
        if (shape === "failed unlink" && fs.name(p) === fs.name(payload))
          throw Object.assign(Error("denied"), { code: "EACCES" });
        await unlink(p);
      };
      const result = await scanNamespace(ns, randomUUID());
      expect(result.problems).toEqual(shape === "failed unlink" ? ["permission"] : []);
      expect(await fs.exists(intent)).toBe(false);
      expect(await fs.exists(payload)).toBe(shape === "failed unlink");
      if (shape === "headless entry" || shape === "extra stage file")
        expect(Buffer.from(await fs.bytes(extra, 128)).toString()).toBe('{"untouched":true}');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each(["nonce", "barrier"])(
  "keeps the %s reserve failure and old-stage validation contract",
  async (kind) => {
    const { root, fs, ns, ticket } = await journalStage();
    try {
      const target = { kind: "import" as const, key: kind + "/" + "a".repeat(64) };
      const aux = { ...ticket, target, metadata: target };
      const writer = new AtomicStore(fs);
      await writer.initialize();
      const open = fs.openOwned.bind(fs),
        sync = fs.sync.bind(fs);
      let descriptor: StoreFd | undefined;
      fs.openOwned = async (p, mode) => {
        const fd = await open(p, mode);
        if (
          mode === "create-exclusive" &&
          ["intent.json", "journal-intent.tmp"].includes(path.basename(fs.name(p)))
        )
          descriptor = fd;
        return fd;
      };
      fs.sync = async (fd) => {
        if (fd === descriptor) throw Error("aux-intent-sync");
        return sync(fd);
      };
      await expect(writer.reserve(aux, 0)).rejects.toThrow("aux-intent-sync");
      expect(await writer.abort(aux)).toBe("aborted");
      expect(await fs.exists(ns.path("staging", aux.id))).toBe(false);
      fs.sync = sync;
      const retry = { ...aux, id: randomUUID() };
      await writer.reserve(retry, 0);
      expect(await writer.abort(retry)).toBe("aborted");
      await writer.dispose();
      // Older auxiliary stages classify from the intent, predecessor and head.
      // A pre-existing seal is outside that classifier.
      await fs.mkdir(ns.path("staging", aux.id));
      await ns.writeNew(ns.path("staging", aux.id, "intent.json"), {
        formatVersion: 1,
        ticket: aux,
        byteLength: 0,
        predecessor: null,
      });
      const seal = ns.path("staging", aux.id, "sealed.json");
      await writeFile(fs.name(seal), "{");
      for (let i = 0; i < 2; i++) {
        const boot = new AtomicStore(
          await createNodePersistenceFs(root, { hostEpoch: randomUUID(), assertHeld() {} }),
        );
        await boot.initialize();
        expect(await boot.reconcileImport(aux)).toEqual({ disposition: "not-committed" });
        expect(Buffer.from(await fs.bytes(seal, 1)).toString()).toBe("{");
        await boot.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each([
  [10004.277183553204, "10004.27718355320"],
  [3.3023803867399694e-80, "3.3023803867399694e-"],
] as const)(
  "recovers a real private intent write interrupted inside deadline %s",
  async (deadline, prefix) => {
    const { root, fs, ns, ticket } = await journalStage();
    try {
      const store = new AtomicStore(fs);
      await store.initialize();
      const scratch = ns.path("staging", ticket.id, "journal-intent.tmp");
      const open = fs.openOwned.bind(fs),
        write = fs.write.bind(fs);
      let descriptor: StoreFd | undefined;
      fs.openOwned = async (p, mode) => {
        const fd = await open(p, mode);
        if (fs.name(p) === fs.name(scratch) && mode === "create-exclusive") descriptor = fd;
        return fd;
      };
      fs.write = async (fd, offset, bytes) => {
        if (fd !== descriptor) return write(fd, offset, bytes);
        if (offset) throw Error("interrupted-short-write");
        const through = '"deadlineMonotonicMs":' + prefix;
        const start = Buffer.from(bytes).indexOf(through);
        expect(start).toBeGreaterThan(0);
        return write(fd, 0, bytes.subarray(0, start + through.length));
      };
      const exact = { ...ticket, deadlineMonotonicMs: deadline };
      await expect(store.reserve(exact, 0)).rejects.toThrow("interrupted-short-write");
      expect(
        Buffer.from(await fs.bytes(scratch, 8192))
          .toString()
          .endsWith(prefix),
      ).toBe(true);
      await expect(store.dispose()).rejects.toThrow("publish-uncertain");
      const boot = new AtomicStore(
        await createNodePersistenceFs(root, { hostEpoch: randomUUID(), assertHeld() {} }),
      );
      await boot.initialize();
      expect(await fs.exists(scratch)).toBe(false);
      expect(await boot.reconcileImport(exact)).toEqual({ disposition: "unknown" });
      await boot.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("cleans an ordinary settings stage named by an unresolved ordinary record candidate", async () => {
  const f = await preHeadImport(true, false, 16);
  try {
    const { ns, nextFs: fs } = f;
    const id = f.safeAttempt!.id;
    const candidate = ns.path(...f.loc.parts, "head." + f.attempt.id + ".tmp");
    await fs.atomicReplace(candidate, ns.path(...f.loc.parts, "head." + id + ".tmp"));
    const intent = ns.path("staging", id, "intent.json");
    const raw = JSON.parse(Buffer.from(await fs.bytes(intent, 8192)).toString());
    raw.ticket.target = { kind: "settings", expectedRevision: null };
    raw.ticket.metadata = { kind: "settings", schemaVersion: 1, validationDigest: "0".repeat(64) };
    await writeFile(fs.name(intent), JSON.stringify(raw));
    expect((await scanNamespace(ns, f.nextOwner.hostEpoch)).problems).toContain("corrupt");
    expect(await fs.exists(ns.path("staging", id))).toBe(false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it.each(["confirmed", "interrupted"])(
  "five %s 7 MiB aborts release the real files on fresh epochs",
  async (mode) => {
    const f = await preHeadImport(false, true, 7 * 1048576);
    let { store, fs, attempt } = f;
    const source = attempt.owner.sourceKey;
    try {
      for (let round = 0; round < 5; round++) {
        if (mode === "interrupted") {
          const unlink = fs.unlink.bind(fs);
          fs.unlink = async (p) => {
            await unlink(p);
            if (fs.name(p).endsWith(attempt.id + ".prepublish.bin"))
              throw Error("after payload unlink");
          };
          await expect(store.abort(attempt)).rejects.toThrow("after payload unlink");
          await expect(store.dispose()).rejects.toThrow("publish-uncertain");
        } else {
          expect(await store.abort(attempt)).toBe("aborted");
          expect(store.quota.snapshot(source).temporaryBytes).toBe(0);
          await store.dispose();
        }
        const owner = { ...f.nextOwner, hostEpoch: randomUUID(), processEpoch: randomUUID() };
        fs = await createNodePersistenceFs(
          f.root,
          { hostEpoch: owner.hostEpoch, assertHeld() {} },
          { now: () => 0 },
        );
        store = new AtomicStore(fs);
        await store.initialize();
        expect(store.quota.snapshot(source).temporaryBytes).toBe(0);
        const ns = await Namespace.open(fs, source);
        expect(await fs.entries(ns.path("quarantine"), 4096)).toEqual([]);
        expect(await store.reconcileImport(attempt)).toEqual({ disposition: "not-committed" });
        if (round === 4) break;
        attempt = await store.admitImport(owner, f.planId, "first");
        await store.reserve(attempt, f.bytes.length);
        await store.tagImport(attempt, f.tag);
        for (let offset = 0; offset < f.bytes.length; offset += 262144)
          await store.append(attempt, offset, f.bytes.subarray(offset, offset + 262144));
        await store.seal(attempt, f.bytes.length, f.tag.sourceSha256);
        const fault = fs.fault.bind(fs);
        fs.fault = async (point, ...args) => {
          if (point === "before-publish") throw Error("pre-dispatch");
          return fault(point, ...args);
        };
        await expect(store.publish(attempt)).rejects.toThrow("pre-dispatch");
      }
      await store.dispose();
      const again = new AtomicStore(
        await createNodePersistenceFs(f.root, { hostEpoch: randomUUID(), assertHeld() {} }),
      );
      await again.initialize();
      expect(again.quota.snapshot(source).temporaryBytes).toBe(0);
      await again.dispose();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

it.each(["planned", "admitted"])(
  "rejects a private journal scratch claimed by a %s settings item",
  async (identity) => {
    const {
      root,
      fs,
      ns,
      ticket: { owner, target },
    } = await journalStage();
    try {
      const writer = new AtomicStore(fs);
      await writer.initialize();
      const planned: PublicationTicket = {
        id: randomUUID(),
        owner,
        deadlineMonotonicMs: 10000,
        target: { kind: "settings", expectedRevision: null },
        metadata: { kind: "settings", schemaVersion: 1, validationDigest: "0".repeat(64) },
      };
      const sha = createHash("sha256").digest("hex");
      await writer.planImport(owner, {
        formatVersion: 1,
        id: target.key,
        descriptorId: "test.synthetic.files",
        mappingVersion: 1,
        targetSourceKey: owner.sourceKey,
        preferencesEvidence: null,
        items: [
          {
            key: "settings",
            sourceFormat: 1,
            sourceSha256: sha,
            mappedSha256: sha,
            byteLength: 0,
            ticket: planned,
            tag: { importId: target.key, itemKey: "settings", sourceSha256: sha },
          },
        ],
      });
      const attempt = await writer.admitImport(owner, target.key, "settings");
      await writer.dispose();
      const id = identity === "planned" ? planned.id : attempt.id;
      await fs.mkdir(ns.path("staging", id));
      const scratch = ns.path("staging", id, "journal-intent.tmp"),
        prefix = Buffer.from('{"formatVersion":1,');
      await writeFile(fs.name(scratch), prefix);
      for (let i = 0; i < 2; i++) {
        const boot = new AtomicStore(
          await createNodePersistenceFs(root, { hostEpoch: randomUUID(), assertHeld() {} }),
        );
        await expect(boot.initialize()).rejects.toThrow("recovery-blocked");
        expect(Buffer.from(await fs.bytes(scratch, 8192))).toEqual(prefix);
        await boot.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("classifies an unrecognized sole staging filename without reading its bytes", async () => {
  const { root, fs, ns, ticket, dir } = await journalStage();
  try {
    await fs.mkdir(dir);
    const file = ns.path("staging", ticket.id, "unexplained.bin");
    await writeFile(fs.name(file), "preserve");
    const reads = vi.spyOn(fs, "bytes");
    expect((await scanNamespace(ns, randomUUID())).problems).toContain("corrupt");
    expect(reads.mock.calls.map(([p]) => fs.name(p))).not.toContain(fs.name(file));
    expect(Buffer.from(await fs.bytes(file, 8192)).toString()).toBe("preserve");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["owned record", "unrelated settings"])(
  "limits duplicate pending attempt IDs to the matched stage (%s)",
  async (shape) => {
    const f = await preHeadImport(false, false, 16);
    try {
      const { ns, nextFs: fs } = f;
      const candidate = ns.path(...f.loc.parts, "head." + f.attempt.id + ".tmp");
      await fs.unlink(ns.object(f.loc, parseHead(await fs.bytes(candidate, 8192))));
      await fs.unlink(candidate);
      const loc = await ns.location({ kind: "import", key: f.planId }),
        head = (await ns.head(loc))!;
      const journal = JSON.parse(
        Buffer.from(await fs.bytes(ns.object(loc, head), 2097152)).toString(),
      );
      const other = structuredClone(journal.plan.items[0]),
        evidence = structuredClone(journal.items[0]);
      other.key = "other";
      other.tag.itemKey = other.key;
      other.ticket.id = randomUUID();
      other.ticket.target.id = randomUUID();
      other.ticket.metadata.record.id = other.ticket.target.id;
      evidence.key = other.key;
      evidence.publicationTicket.target = other.ticket.target;
      evidence.publicationTicket.metadata = other.ticket.metadata;
      journal.plan.items.push(other);
      journal.items.push(evidence);
      const raw = Buffer.from(JSON.stringify(journal));
      await writeFile(fs.name(ns.object(loc, head)), raw);
      await writeFile(
        fs.name(loc.head),
        JSON.stringify({
          ...head,
          byteLength: raw.length,
          sha256: createHash("sha256").update(raw).digest("hex"),
        }),
      );
      const dir = ns.path("staging", f.attempt.id),
        intent = ns.path("staging", f.attempt.id, "intent.json");
      if (shape === "unrelated settings") {
        const old = JSON.parse(Buffer.from(await fs.bytes(intent, 8192)).toString());
        old.ticket.target = { kind: "settings", expectedRevision: null };
        old.ticket.metadata = {
          kind: "settings",
          schemaVersion: 1,
          validationDigest: "0".repeat(64),
        };
        await writeFile(fs.name(intent), JSON.stringify(old));
        expect((await scanNamespace(ns, randomUUID())).problems).toEqual([]);
        expect(await fs.exists(dir)).toBe(false);
      } else {
        const before = await fs.bytes(intent, 8192);
        await expect(scanNamespace(ns, randomUUID())).rejects.toThrow("identity-mismatch");
        expect(await fs.bytes(intent, 8192)).toEqual(before);
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

it.each([
  "post-unlink",
  "scanner seal removed",
  "live marker removed",
  "directory marker",
  "extra payload",
  "foreign tag",
  "published",
  "previous head",
  "foreign intent",
])("validates the entire marked stage before cleanup on two boots: %s", async (shape) => {
  const f = await preHeadImport(false, true, 16);
  try {
    const { fs, attempt } = f;
    const ns = await Namespace.open(fs, attempt.owner.sourceKey);
    const loc = await ns.location(attempt.target);
    const leaf = (name: string) => ns.path("staging", attempt.id, name);
    const marker = leaf("abort-tag.json");
    if (shape === "published" || shape === "previous head") {
      await fs.atomicReplace(
        ns.path(...loc.parts, `head.${attempt.id}.tmp`),
        shape === "published" ? loc.head : loc.previous,
      );
      await fs.atomicReplace(leaf("import-tag.json"), marker);
    } else {
      const unlink = fs.unlink.bind(fs);
      fs.unlink = async (p) => {
        await unlink(p);
        if (fs.name(p).endsWith(attempt.id + ".prepublish-head")) throw Error("post-witness cut");
      };
      await expect(f.store.abort(attempt)).rejects.toThrow("post-witness cut");
      fs.unlink = unlink;
      expect(await fs.exists(marker)).toBe(true);
      expect(await fs.entries(ns.path("quarantine"), 4096)).toEqual([]);
      if (shape === "extra payload") await writeFile(fs.name(leaf("payload.tmp")), "evidence");
      if (shape === "live marker removed") await fs.unlink(marker);
      if (shape === "directory marker") {
        await fs.unlink(marker);
        await fs.mkdir(marker);
      }
      if (shape === "scanner seal removed") await fs.unlink(leaf("sealed.json"));
      if (shape === "foreign tag")
        await writeFile(
          fs.name(marker),
          JSON.stringify({ formatVersion: 1, tag: { ...f.tag, itemKey: "foreign" } }),
        );
      if (shape === "foreign intent") {
        const intent = leaf("intent.json");
        const raw = JSON.parse(Buffer.from(await fs.bytes(intent, 8192)).toString());
        raw.ticket.id = randomUUID();
        await writeFile(fs.name(intent), JSON.stringify(raw));
      }
    }
    const inventory = async () => ({
      paths: (await readdir(fs.name(ns.path()), { recursive: true })).sort(),
      digests: await Promise.all(
        (await ns.inventory()).map(async (file) => [
          file.relative,
          createHash("sha256")
            .update(await fs.bytes(file.path, 2097152))
            .digest("hex"),
        ]),
      ),
    });
    const before = await inventory();
    for (let i = 0; i < 2; i++) {
      const boot = new AtomicStore(
        await createNodePersistenceFs(f.root, { hostEpoch: randomUUID(), assertHeld() {} }),
      );
      if (["post-unlink", "scanner seal removed", "live marker removed"].includes(shape)) {
        await boot.initialize();
        expect(await fs.exists(ns.path("staging", attempt.id))).toBe(false);
        expect(await ns.head(loc)).toBeNull();
        expect(boot.quota.snapshot(attempt.owner.sourceKey).temporaryBytes).toBe(0);
      } else {
        await expect(boot.initialize()).rejects.toThrow("recovery-blocked");
        expect(await inventory()).toEqual(before);
      }
      await boot.dispose();
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it.each(
  ["settings", "ordinary record", "nonce", "barrier"].flatMap((kind) =>
    ["absent", "truncated", "read failure"].map((tag) => [kind, tag] as const),
  ),
)(
  "keeps baseline %s stage handling beside an untagged candidate with an unrelated receipt (%s tag)",
  async (kind, tag) => {
    const f = await preHeadImport(false, false, 16);
    try {
      const { ns, nextFs: fs, attempt } = f;
      const candidate = ns.path(...f.loc.parts, `head.${attempt.id}.tmp`);
      const head = JSON.parse(Buffer.from(await fs.bytes(candidate, 8192)).toString());
      delete head.importTag;
      head.receipt.commitId = randomUUID();
      await writeFile(fs.name(candidate), JSON.stringify(head));
      const leaf = (name: string) => ns.path("staging", attempt.id, name);
      for (const name of ["sealed.json", "import-tag.json"]) await fs.unlink(leaf(name));
      if (tag !== "absent") await writeFile(fs.name(leaf("import-tag.json")), "{");
      if (tag === "read failure") {
        const bytes = fs.bytes.bind(fs);
        fs.bytes = async (p, size) => {
          if (fs.name(p) === fs.name(leaf("import-tag.json"))) throw Error("read failed");
          return bytes(p, size);
        };
      }
      const raw = JSON.parse(Buffer.from(await fs.bytes(leaf("intent.json"), 8192)).toString());
      raw.byteLength = 0;
      if (kind === "settings") {
        raw.ticket.target = { kind: "settings", expectedRevision: null };
        raw.ticket.metadata = {
          kind: "settings",
          schemaVersion: 1,
          validationDigest: "0".repeat(64),
        };
      } else if (kind === "ordinary record") {
        raw.ticket.target.id = randomUUID();
        raw.ticket.metadata.record.id = raw.ticket.target.id;
      } else {
        raw.ticket.target = { kind: "import", key: kind + "/" + f.tag.sourceSha256 };
        raw.ticket.metadata = raw.ticket.target;
      }
      await writeFile(fs.name(leaf("intent.json")), JSON.stringify(raw));
      await writeFile(fs.name(leaf("payload.tmp")), "");
      for (let boot = 0; boot < 2; boot++) {
        expect((await scanNamespace(ns, randomUUID())).problems).toEqual(["corrupt"]);
        expect(parseHead(await fs.bytes(candidate, 8192))).toEqual(head);
        if (kind === "nonce" || kind === "barrier") {
          expect(await fs.exists(leaf("payload.tmp"))).toBe(false);
          expect(
            JSON.parse(Buffer.from(await fs.bytes(leaf("resolved.json"), 8192)).toString()),
          ).toEqual({ formatVersion: 1, disposition: "not-committed", receipt: null });
        } else expect(await fs.exists(ns.path("staging", attempt.id))).toBe(false);
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

const documentDamage = ["invalid UTF-8", "truncated", "trailing byte", "reordered keys"] as const;
function damageDocument(raw: Buffer, damage: (typeof documentDamage)[number] | "BOM") {
  if (damage === "BOM") return Buffer.concat([Buffer.from([239, 187, 191]), raw]);
  if (damage === "truncated") return raw.subarray(0, -1);
  if (damage === "trailing byte") return Buffer.concat([raw, Buffer.from(" ")]);
  if (damage === "reordered keys")
    return Buffer.from(
      JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(raw.toString())).reverse())),
    );
  const index = raw.indexOf(Buffer.from("�"));
  if (index >= 0)
    return Buffer.concat([raw.subarray(0, index), Buffer.from([255]), raw.subarray(index + 3)]);
  const bytes = Buffer.from(raw);
  bytes[2] = 255;
  return bytes;
}

async function snapshotNamespace(ns: Namespace) {
  return {
    paths: (await readdir(ns.fs.name(ns.path()), { recursive: true })).sort(),
    digests: await Promise.all(
      (await ns.inventory()).map(async (f) => [
        f.relative,
        createHash("sha256")
          .update(await ns.fs.bytes(f.path, f.bytes))
          .digest("hex"),
      ]),
    ),
  };
}

it.each(
  [
    "abort-tag.json",
    "import-tag.json",
    "intent.json",
    "sealed.json",
    "candidate",
    "quarantined head",
    "published head",
    "publication.json",
  ].flatMap((name) => {
    const variants = ["sealed.json", "import-tag.json", "publication.json"].includes(name)
      ? [...documentDamage, "BOM" as const]
      : documentDamage;
    return variants.map((damage) => [name, damage] as const);
  }),
)("recovers the writer layout with %s containing %s across two boots", async (name, damage) => {
  const f = await preHeadImport(false, true, 16, "first�");
  try {
    const { fs, attempt } = f;
    const ns = await Namespace.open(fs, attempt.owner.sourceKey);
    const loc = await ns.location(attempt.target);
    const stage = (leaf: string) => ns.path("staging", attempt.id, leaf);
    const candidate = ns.path(...loc.parts, `head.${attempt.id}.tmp`);
    const witness = ns.path("quarantine", attempt.id + ".prepublish-head");
    if (name === "abort-tag.json" || name === "quarantined head") {
      const stop = name === "abort-tag.json" ? stage(name) : witness;
      const replace = fs.atomicReplace.bind(fs);
      fs.atomicReplace = async (from, to) => {
        await replace(from, to);
        if (fs.name(to) === fs.name(stop)) throw Error("after rename");
      };
      await expect(f.store.abort(attempt)).rejects.toThrow("after rename");
      fs.atomicReplace = replace;
    }
    if (name === "publication.json") {
      await fs.atomicReplace(
        ns.object(loc, parseHead(await fs.bytes(candidate, 8192))),
        stage("payload.tmp"),
      );
      await fs.atomicReplace(candidate, stage(name));
    }
    if (name === "published head") await fs.atomicReplace(candidate, loc.head);
    const file =
      name === "published head"
        ? loc.head
        : name === "candidate"
          ? candidate
          : name === "quarantined head"
            ? witness
            : stage(name);
    const raw = Buffer.from(await fs.bytes(file, 8192));
    await writeFile(fs.name(file), damageDocument(raw, damage));
    const before = await snapshotNamespace(ns);
    for (let boot = 0; boot < 2; boot++) {
      const store = new AtomicStore(
        await createNodePersistenceFs(f.root, { hostEpoch: randomUUID(), assertHeld() {} }),
      );
      const ready =
        name === "publication.json" ||
        (["import-tag.json", "sealed.json"].includes(name) &&
          ["truncated", "trailing byte", "reordered keys"].includes(damage)) ||
        (name === "import-tag.json" && damage === "invalid UTF-8");
      if (ready) {
        await store.initialize();
        expect(await fs.exists(ns.path("staging", attempt.id))).toBe(false);
        expect(await fs.exists(loc.head)).toBe(false);
        const evidence = ns.path("quarantine", attempt.id + ".prepublish.bin");
        if (name === "publication.json") expect(await fs.exists(evidence)).toBe(false);
        else expect(await readFile(fs.name(evidence))).toEqual(f.bytes);
      } else {
        await expect(store.initialize()).rejects.toThrow("recovery-blocked");
        expect(await snapshotNamespace(ns)).toEqual(before);
      }
      await store.dispose();
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it.each(
  [
    "intent.json",
    "sealed.json",
    "publication.json",
    "journal destination head",
    "journal-intent.tmp",
    "journal-sealed.tmp",
    "journal-publication.tmp",
    "resolved.tmp",
    "resolved.json",
  ].flatMap((name) => documentDamage.map((damage) => [name, damage] as const)),
)("validates private journal %s with %s on both boots", async (name, damage) => {
  const { root, fs, ticket } = await journalStage();
  const snapshot = path.join(root, "cut");
  try {
    const writer = new AtomicStore(fs);
    await writer.initialize();
    const bytes = Buffer.from(
      JSON.stringify({
        formatVersion: 1,
        plan: {
          formatVersion: 1,
          id: ticket.target.key,
          descriptorId: "test.synthetic.files",
          mappingVersion: 1,
          targetSourceKey: ticket.owner.sourceKey,
          preferencesEvidence: null,
          items: [],
        },
        items: [],
        complete: false,
      }),
    );
    const replace = fs.atomicReplace.bind(fs);
    const copy = () =>
      cp(path.join(root, "plugins"), path.join(snapshot, "plugins"), { recursive: true });
    fs.atomicReplace = async (from, to) => {
      if (path.basename(fs.name(from)) === name) await copy();
      await replace(from, to);
      if (
        path.basename(fs.name(to)) ===
        (name === "journal destination head" ? "publication.json" : name)
      )
        await copy();
    };
    await writer.reserve(ticket, bytes.length);
    if (name.startsWith("resolved")) {
      await writer.dispose();
      const ns = await Namespace.open(fs, ticket.owner.sourceKey);
      expect((await scanNamespace(ns, randomUUID())).problems).toEqual([]);
    } else {
      await writer.append(ticket, 0, bytes);
      await writer.seal(ticket, bytes.length, createHash("sha256").update(bytes).digest("hex"));
      expect((await writer.publish(ticket)).disposition).toBe("committed");
    }
    const next = await createNodePersistenceFs(snapshot, {
      hostEpoch: randomUUID(),
      assertHeld() {},
    });
    const ns = await Namespace.open(next, ticket.owner.sourceKey);
    const loc = await ns.location(ticket.target);
    const file =
      name === "journal destination head"
        ? ns.path(...loc.parts, loc.name + "." + ticket.id + ".tmp")
        : ns.path("staging", ticket.id, name);
    const raw = Buffer.from(await next.bytes(file, 8192));
    await writeFile(next.name(file), damageDocument(raw, damage));
    const before = await snapshotNamespace(ns);
    for (let boot = 0; boot < 2; boot++) {
      const store = new AtomicStore(
        await createNodePersistenceFs(snapshot, { hostEpoch: randomUUID(), assertHeld() {} }),
      );
      if (name.endsWith(".tmp") && damage === "truncated") {
        await store.initialize();
        expect(await next.exists(file)).toBe(false);
        expect(await store.reconcileImport(ticket)).toEqual(
          name === "journal-intent.tmp"
            ? { disposition: "unknown" }
            : { disposition: "not-committed" },
        );
      } else {
        await expect(store.initialize()).rejects.toThrow("recovery-blocked");
        expect(await snapshotNamespace(ns)).toEqual(before);
      }
      await store.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Split the byte offsets across cases so each real-profile replay stays within the
// existing per-test timeout. Offset -1 represents the cut before exclusive create.
describe("in-place record writes", () => {
  let f: Awaited<ReturnType<typeof preHeadImport>>;
  beforeAll(async () => {
    f = await preHeadImport(false, false, 16, "first�", true);
  });
  afterAll(async () => {
    if (f) await rm(f.root, { recursive: true, force: true });
  });
  const prefixGroups = 32;
  it.each(
    ["import-tag.json", "sealed.json", "publication.json"].flatMap((name) =>
      Array.from({ length: prefixGroups }, (_, group) => [name, group] as const),
    ),
  )("retires every writer prefix of %s, offset group %i", async (name, group) => {
    const { ns, attempt } = f;
    const relative = path.relative(
      await realpath(f.snapshot),
      ns.fs.name(ns.path("staging", attempt.id, name)),
    );
    const snapshot = path.join(f.root, name);
    const raw = await readFile(path.join(snapshot, relative));
    const replay = path.join(f.root, name + "-" + group);
    for (let length = group - 1; length <= raw.length; length += prefixGroups) {
      await cp(snapshot, replay, { recursive: true });
      const replayFile = path.join(replay, relative);
      if (length < 0) await rm(replayFile);
      else await writeFile(replayFile, raw.subarray(0, length));
      for (let boot = 0; boot < 2; boot++) {
        const disk = await createNodePersistenceFs(replay, {
          hostEpoch: randomUUID(),
          assertHeld() {},
        });
        const store = new AtomicStore(disk);
        await store.initialize();
        const recovered = await Namespace.open(disk, attempt.owner.sourceKey);
        expect(await disk.exists(recovered.path("staging", attempt.id))).toBe(false);
        expect(await disk.entries(recovered.path("quarantine"), 4096)).toEqual([]);
        expect(await recovered.head(await recovered.location(attempt.target))).toBeNull();
        await store.dispose();
      }
      await rm(replay, { recursive: true });
    }
  });
});

it.each(["settings", "record", "nonce", "barrier"] as const)(
  "keeps the aec11f5 %s byte-variant outcome on two boots",
  async (family) => {
    const root = await mkdtemp(path.join(tmpdir(), "ordinary-byte-variant-"));
    try {
      const { planned } = recordFixture(16);
      const target =
        family === "settings"
          ? { kind: family, expectedRevision: null }
          : family === "record"
            ? planned.target
            : { kind: "import" as const, key: family + "/" + "0".repeat(64) };
      const ticket: PublicationTicket = {
        ...planned,
        id: randomUUID(),
        owner: { ...planned.owner, pluginId: "test.�" },
        target,
        metadata:
          target.kind === "settings"
            ? { kind: "settings", schemaVersion: 1, validationDigest: "0".repeat(64) }
            : target.kind === "import"
              ? target
              : planned.metadata,
      };
      const fs = await createNodePersistenceFs(
        root,
        { hostEpoch: ticket.owner.hostEpoch, assertHeld() {} },
        { now: () => 0 },
      );
      const writer = new AtomicStore(fs);
      await writer.initialize();
      await writer.reserve(ticket, 0);
      const replay = path.join(root, "replay");
      await cp(path.join(root, "plugins"), path.join(replay, "plugins"), { recursive: true });
      await writer.dispose();
      const replayFs = await createNodePersistenceFs(replay, {
        hostEpoch: randomUUID(),
        assertHeld() {},
      });
      const ns = await Namespace.open(replayFs, ticket.owner.sourceKey);
      const leaf = (name: string) => ns.path("staging", ticket.id, name);
      if (target.kind === "import") {
        const boot = new AtomicStore(
          await createNodePersistenceFs(replay, { hostEpoch: randomUUID(), assertHeld() {} }),
        );
        await boot.initialize();
        await boot.dispose();
        const filename = replayFs.name(leaf("resolved.json"));
        await writeFile(filename, Buffer.concat([await readFile(filename), Buffer.from(" ")]));
      } else {
        const filename = replayFs.name(leaf("intent.json"));
        await writeFile(filename, damageDocument(await readFile(filename), "invalid UTF-8"));
      }
      for (let boot = 0; boot < 2; boot++) {
        const next = new AtomicStore(
          await createNodePersistenceFs(replay, { hostEpoch: randomUUID(), assertHeld() {} }),
        );
        await next.initialize();
        expect(await replayFs.exists(leaf("payload.tmp"))).toBe(false);
        if (target.kind === "import")
          expect(await next.reconcileImport(ticket)).toEqual({ disposition: "not-committed" });
        await next.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

async function expectPayloadRetired(
  root: string,
  ns: Namespace,
  id: string,
  family: "journal" | "record" | "ordinary-collision",
) {
  const stage = "staging/" + id;
  const removed = (
    family === "journal"
      ? ["payload.tmp"]
      : family === "record"
        ? ["payload.tmp", "sealed.json", "import-tag.json", "intent.json"]
        : ["payload.tmp", "intent.json"]
  )
    .map((leaf) => stage + "/" + leaf)
    .sort();
  const before = await snapshotNamespace(ns);
  for (const file of removed) expect(before.paths).toContain(file.split("/").join(path.sep));
  const paths = before.paths
    .map((file) => file.split(path.sep).join("/"))
    .filter((file) => !removed.includes(file) && !(family !== "journal" && file === stage));
  const digests = before.digests.filter(([file]) => !removed.includes(file!));
  if (family === "journal") {
    paths.push(stage + "/resolved.json");
    digests.push([
      stage + "/resolved.json",
      createHash("sha256")
        .update('{"formatVersion":1,"disposition":"not-committed","receipt":null}')
        .digest("hex"),
    ]);
  }
  for (let boot = 0; boot < 2; boot++) {
    const fs = await createNodePersistenceFs(root, { hostEpoch: randomUUID(), assertHeld() {} });
    const unlink = vi.spyOn(fs, "unlink");
    const store = new AtomicStore(fs);
    await store.initialize();
    expect(
      unlink.mock.calls
        .map(([file]) =>
          path.relative(ns.fs.name(ns.path()), fs.name(file)).split(path.sep).join("/"),
        )
        .sort(),
    ).toEqual(boot === 0 ? removed : []);
    const after = await snapshotNamespace(ns);
    expect(after.paths.map((file) => file.split(path.sep).join("/")).sort()).toEqual(paths.sort());
    expect(after.digests.sort()).toEqual(digests.sort());
    await store.dispose();
  }
}

it.each(["reserve", "seal"])(
  "known limitation matching aec11f5: retires a private payload after %s with FF in its target key",
  async (phase) => {
    const { root, fs, ticket } = await journalStage();
    try {
      const store = new AtomicStore(fs);
      await store.initialize();
      const document = Buffer.from(
        JSON.stringify({
          formatVersion: 1,
          plan: {
            formatVersion: 1,
            id: ticket.target.key,
            descriptorId: "test.synthetic.files",
            mappingVersion: 1,
            targetSourceKey: ticket.owner.sourceKey,
            preferencesEvidence: null,
            items: [],
          },
          items: [],
          complete: false,
        }),
      );
      await store.reserve(ticket, phase === "seal" ? document.length : 0);
      if (phase === "seal") {
        await store.append(ticket, 0, document);
        await store.seal(
          ticket,
          document.length,
          createHash("sha256").update(document).digest("hex"),
        );
      }
      const replay = path.join(root, "replay");
      await cp(path.join(root, "plugins"), path.join(replay, "plugins"), { recursive: true });
      await store.dispose();
      const ns = await Namespace.open(
        await createNodePersistenceFs(replay, { hostEpoch: randomUUID(), assertHeld() {} }),
        ticket.owner.sourceKey,
      );
      const file = ns.fs.name(ns.path("staging", ticket.id, "intent.json"));
      const raw = await readFile(file);
      const prefix = '"target":{"kind":"import","key":"import/';
      const index = raw.indexOf(prefix);
      expect(index).toBeGreaterThan(0);
      raw[index + prefix.length] = 255;
      await writeFile(file, raw);
      await expectPayloadRetired(replay, ns, ticket.id, "journal");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("known limitation matching aec11f5: retires a sealed private record with FF in its label", async () => {
  const f = await preHeadImport(false, false, 16, "first", true);
  try {
    const root = path.join(f.root, "sealed.json");
    const ns = await Namespace.open(
      await createNodePersistenceFs(root, { hostEpoch: randomUUID(), assertHeld() {} }),
      f.attempt.owner.sourceKey,
    );
    const file = ns.fs.name(ns.path("staging", f.attempt.id, "intent.json"));
    const raw = await readFile(file);
    const index = raw.indexOf('"label":"import"');
    expect(index).toBeGreaterThan(0);
    raw[index + '"label":"'.length] = 255;
    await writeFile(file, raw);
    await expectPayloadRetired(root, ns, f.attempt.id, "record");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it.each([
  ["invalid UTF-8", false, "unknown"],
  ["BOM", false, "not-committed"],
  ["invalid UTF-8", true, "not-committed"],
  ["BOM", true, "unknown"],
  ["BOM", false, "stale"],
] as const)(
  "reconciles ordinary %s intent with resolution %s as %s",
  async (damage, resolved, expected) => {
    const { root, fs, ns, ticket: plan } = await journalStage();
    try {
      const target = { kind: "import" as const, key: "nonce/" + randomUUID() };
      const ticket = {
        ...plan,
        owner: { ...plan.owner, pluginId: "test.�" },
        target,
        metadata: target,
      };
      const writer = new AtomicStore(fs);
      await writer.initialize();
      await writer.reserve(ticket, 0);
      const intent = fs.name(ns.path("staging", ticket.id, "intent.json"));
      const resolution = fs.name(ns.path("staging", ticket.id, "resolved.json"));
      const original = await readFile(intent);
      const edited = damageDocument(original, damage);
      if (expected === "stale") await writeFile(intent, edited);
      for (let boot = 0; boot < 2; boot++) {
        const next = new AtomicStore(
          await createNodePersistenceFs(root, { hostEpoch: randomUUID(), assertHeld() {} }),
        );
        if (expected === "stale") {
          await expect(next.initialize()).rejects.toThrow("recovery-blocked");
          await expect(
            next.reconcileImport({
              ...ticket,
              deadlineMonotonicMs: ticket.deadlineMonotonicMs + 1,
            }),
          ).rejects.toThrow("stale");
          expect(await readFile(intent)).toEqual(edited);
          expect(await fs.exists(ns.path("staging", ticket.id, "resolved.json"))).toBe(false);
        } else {
          await writeFile(intent, original);
          await next.initialize();
          if (!resolved) await rm(resolution);
          await writeFile(intent, edited);
          expect(await next.reconcileImport(ticket)).toEqual({ disposition: expected });
        }
        await next.dispose();
      }
      await writer.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each([
  "nonce-metaPattern",
  "nonce-head-id",
  "nonce-stray-scratch",
  "legacy-key",
  "legacy-key after payload unlink",
  "legacy-key during resolution write",
  "nonce-targetPattern",
])("keeps the aec11f5 ordinary %s startup and query on two boots", async (row) => {
  const { root, ns, ticket: plan, fs } = await journalStage();
  const headFixture = row === "nonce-head-id" ? await preHeadImport(false, false, 16) : null;
  try {
    const head =
      headFixture && (await headFixture.ns.head(await headFixture.ns.location(plan.target)));
    if (headFixture) {
      expect(head).toBeTruthy();
      await cp(
        headFixture.ns.fs.name(headFixture.ns.path("imports")),
        fs.name(ns.path("imports")),
        { recursive: true },
      );
    }
    const legacy = row.startsWith("legacy-key");
    const target = legacy ? plan.target : { kind: "import" as const, key: "nonce/" + randomUUID() };
    // aec11f5 reserve serialized this caller ticket directly, including its field order.
    const ticket = {
      id: head?.receipt.commitId ?? plan.id,
      owner: { ...plan.owner, pluginId: "test.�" },
      deadlineMonotonicMs: 10000,
      target,
      metadata: target,
    };
    const dir = ns.path("staging", ticket.id);
    await fs.mkdir(dir);
    const leaf = (name: string) => ns.path("staging", ticket.id, name);
    const metadata = row === "nonce-metaPattern" ? plan.target : target;
    const installed = {
      ...ticket,
      metadata,
      target: row === "nonce-targetPattern" ? plan.target : target,
    };
    if (row === "nonce-stray-scratch") {
      installed.target = { ...target, key: "no�ce/" + target.key.slice(6) };
      await writeFile(fs.name(leaf("journal-sealed.tmp")), "");
    }
    const raw = Buffer.from(
      JSON.stringify({ formatVersion: 1, ticket: installed, byteLength: 0, predecessor: null }),
    );
    const edited =
      row === "nonce-stray-scratch"
        ? Buffer.concat([
            raw.subarray(0, raw.lastIndexOf("�")),
            Buffer.from([255]),
            raw.subarray(raw.lastIndexOf("�") + 3),
          ])
        : damageDocument(raw, "invalid UTF-8");
    await writeFile(fs.name(leaf("intent.json")), edited);
    if (row === "legacy-key during resolution write")
      await writeFile(fs.name(leaf("resolved.tmp")), "{");
    else if (row !== "legacy-key after payload unlink")
      await writeFile(fs.name(leaf("payload.tmp")), "");
    for (let boot = 0; boot < 2; boot++) {
      const store = new AtomicStore(
        await createNodePersistenceFs(root, { hostEpoch: randomUUID(), assertHeld() {} }),
      );
      await store.initialize();
      expect(await fs.exists(leaf("payload.tmp"))).toBe(false);
      if (legacy || row === "nonce-head-id") {
        expect(await store.reconcileImport(ticket)).toEqual({ disposition: "not-committed" });
      } else await expect(store.reconcileImport(ticket)).rejects.toThrow("stale");
      await store.dispose();
    }
  } finally {
    if (headFixture) await rm(headFixture.root, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps the aec11f5 ordinary-collision outcome on two boots", async () => {
  const f = await preHeadImport(false, false, 16);
  const { root, ns, fs, ticket: plan } = await journalStage();
  try {
    const ticket = {
      ...f.attempt,
      owner: { ...f.attempt.owner, pluginId: "other.plugin", hostEpoch: plan.owner.hostEpoch },
    };
    if (ticket.metadata.kind !== "record") throw new Error("expected record");
    ticket.metadata = {
      ...ticket.metadata,
      record: { ...ticket.metadata.record, label: "ordinary" },
    };
    const writer = new AtomicStore(fs);
    await writer.initialize();
    await writer.reserve(ticket, 16);
    await cp(f.ns.fs.name(f.ns.path("imports")), fs.name(ns.path("imports")), { recursive: true });
    const replay = path.join(root, "cut");
    await cp(path.join(root, "plugins"), path.join(replay, "plugins"), { recursive: true });
    await writer.dispose();
    const replayNs = await Namespace.open(
      await createNodePersistenceFs(replay, { hostEpoch: randomUUID(), assertHeld() {} }),
      ticket.owner.sourceKey,
    );
    await expectPayloadRetired(replay, replayNs, ticket.id, "ordinary-collision");
    expect(await replayNs.fs.exists(replayNs.path("staging", ticket.id))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(f.root, { recursive: true, force: true });
  }
});

it("rejects mismatched first-import keys before changing the namespace", async () => {
  const { root, fs, ns, ticket } = await journalStage();
  try {
    const writer = new AtomicStore(fs);
    await writer.initialize();
    const before = await snapshotNamespace(ns);
    await expect(
      writer.reserve({ ...ticket, metadata: { kind: "import", key: "nonce/" + randomUUID() } }, 0),
    ).rejects.toThrow("invalid-target");
    expect(await snapshotNamespace(ns)).toEqual(before);
    await writer.dispose();
    const boot = new AtomicStore(
      await createNodePersistenceFs(root, { hostEpoch: randomUUID(), assertHeld() {} }),
    );
    await boot.initialize();
    expect(await snapshotNamespace(ns)).toEqual(before);
    await boot.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["journal", "record"] as const)(
  "recovers reordered %s publication bytes at each writer cut",
  async (family) => {
    const { root, fs, ns, ticket: journal } = await journalStage();
    try {
      const { planned: fixture, bytes, sha } = recordFixture(16);
      const planned = { ...fixture, owner: journal.owner };
      const tag = { sourceSha256: sha, itemKey: "first", importId: journal.target.key };
      const item = {
        key: tag.itemKey,
        sourceFormat: 1,
        sourceSha256: sha,
        mappedSha256: sha,
        byteLength: bytes.length,
        ticket: planned,
        tag,
      };
      const plan = {
        formatVersion: 1 as const,
        id: journal.target.key,
        descriptorId: "test.synthetic.files",
        mappingVersion: 1,
        targetSourceKey: journal.owner.sourceKey,
        preferencesEvidence: null,
        items: family === "record" ? [item] : [],
      };
      const writer = new AtomicStore(fs);
      await writer.initialize();
      const target = { key: plan.id, kind: "import" as const };
      let ticket: PublicationTicket = { ...journal, target, metadata: target };
      let payload: Uint8Array = Buffer.from(
        JSON.stringify({ formatVersion: 1, plan, items: [], complete: false }),
      );
      if (family === "record") {
        await writer.planImport(journal.owner, plan);
        ticket = await writer.admitImport(journal.owner, plan.id, item.key);
        if (ticket.metadata.kind !== "record") throw Error("expected record");
        ticket = {
          ...ticket,
          metadata: { kind: "record", deleted: false, record: ticket.metadata.record },
        };
        payload = bytes;
      }
      await writer.reserve(ticket, payload.length);
      if (family === "record") await writer.tagImport(ticket, tag);
      await writer.append(ticket, 0, payload);
      await writer.seal(ticket, payload.length, createHash("sha256").update(payload).digest("hex"));
      const loc = await ns.location(ticket.target);
      const snapshot = (cut: string) =>
        cp(path.join(root, "plugins"), path.join(root, cut, "plugins"), { recursive: true });
      const head = fs.name(loc.head);
      const replace = fs.atomicReplace.bind(fs);
      fs.atomicReplace = async (from, to) => {
        const file = fs.name(to);
        if (
          family === "record" &&
          fs.name(from) === fs.name(ns.path("staging", ticket.id, "publication.json"))
        )
          await snapshot("sidecar");
        await replace(from, to);
        if (file === head) await snapshot("after-head");
        if (file === fs.name(ns.path("staging", ticket.id, "publication.json")))
          await snapshot("sidecar");
        if (
          family === "record" &&
          file === fs.name(ns.path(...loc.parts, "head." + ticket.id + ".tmp"))
        )
          await snapshot("candidate");
      };
      const fault = fs.fault.bind(fs);
      fs.fault = async (point) => {
        if (point === "before-publish") await snapshot("before-publish");
        return fault(point);
      };
      const published = await writer.publish(ticket);
      expect(published.disposition).toBe("committed");
      await writer.dispose();
      for (const cut of [
        "before-publish",
        "after-head",
        "sidecar",
        ...(family === "record" ? ["candidate"] : []),
      ]) {
        for (let boot = 0; boot < 2; boot++) {
          const reader = new AtomicStore(
            await createNodePersistenceFs(path.join(root, cut), {
              hostEpoch: randomUUID(),
              assertHeld() {},
            }),
          );
          await reader.initialize();
          expect(await reader.reconcileImport(ticket)).toEqual(
            cut === "after-head" ? published : { disposition: "not-committed" },
          );
          await reader.dispose();
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
