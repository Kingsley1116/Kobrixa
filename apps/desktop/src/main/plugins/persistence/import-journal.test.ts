import { expect, it, vi } from "vitest";
import { finishImport } from "./import-journal.js";
import type {
  DurableImportPort,
  ImportPlan,
  PersistenceOwner,
  PublicationTicket,
} from "./engine-port.js";
function completionCases(owner: PersistenceOwner, plan: ImportPlan, imports: DurableImportPort) {
  it("does not complete unknown or pending items", async () => {
    for (const state of ["pending", "unknown"] as const) {
      vi.spyOn(imports, "load").mockResolvedValue({
        plan,
        complete: false,
        items: plan.items.map((item) => ({
          key: item.key,
          state,
          receipt: null,
          skipReason: null,
          publicationTicket: state === "unknown" ? item.ticket : null,
        })),
      });
      const complete = vi.spyOn(imports, "complete");
      expect(await finishImport(imports, owner, plan)).toBe(false);
      expect(complete).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    }
  });
  it("preserves explicit skip evidence across completion", async () => {
    for (const item of plan.items)
      await imports.record(owner, plan.id, {
        key: item.key,
        state: "skipped",
        receipt: null,
        skipReason: "trusted-user-skip",
        publicationTicket: null,
      });
    expect(await finishImport(imports, owner, plan)).toBe(true);
    const restored = await imports.load(owner, plan.id);
    expect(restored?.complete).toBe(true);
    expect(
      restored?.items.every(
        (item) => item.state === "skipped" && item.skipReason === "trusted-user-skip",
      ),
    ).toBe(true);
  });
}

import { beforeEach, afterEach, describe } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AtomicStore } from "./atomic-store.js";
import { createNodePersistenceFs } from "./filesystem.js";
import { importIdFor } from "./import-sources.js";
import { importPlanSchema, importDocumentSchema } from "./namespace.js";
const owner: PersistenceOwner = {
  sourceKey: "builtin:test.synthetic",
  pluginId: "test.synthetic",
  generation: 1,
  hostEpoch: randomUUID(),
  processEpoch: randomUUID(),
};
const bytes = new Uint8Array([0, 255, 7]),
  digest = createHash("sha256").update(bytes).digest("hex");
const recordId = randomUUID(),
  id = importIdFor("test.synthetic-import", owner.sourceKey);
const plan: ImportPlan = {
  formatVersion: 1,
  id,
  descriptorId: "test.synthetic-import",
  mappingVersion: 1,
  targetSourceKey: owner.sourceKey,
  preferencesEvidence: null,
  items: [
    {
      key: "one",
      sourceFormat: 1,
      sourceSha256: digest,
      mappedSha256: digest,
      byteLength: bytes.length,
      tag: { importId: id, itemKey: "one", sourceSha256: digest },
      ticket: {
        id: randomUUID(),
        owner,
        deadlineMonotonicMs: 10000,
        target: { kind: "record", id: recordId, expectedRevision: null },
        metadata: {
          kind: "record",
          deleted: false,
          record: {
            id: recordId,
            revision: "r_" + randomUUID().replaceAll("-", ""),
            kind: "test.synthetic",
            schemaVersion: 1,
            label: "Synthetic",
            mediaType: "application/octet-stream",
            byteLength: bytes.length,
            sha256: digest,
            createdAt: 1,
            updatedAt: 1,
            checkpoint: "none",
            interrupted: false,
          },
        },
      },
    },
  ],
};
let directory: string, store: AtomicStore;
const typedImports: DurableImportPort = {
  load: (o, id) => store.loadImport(o, id),
  plan: (o, p) => store.planImport(o, p),
  admit: (o, id, key) => store.admitImport(o, id, key),
  tagImport: (t, tag) => store.tagImport(t, tag),
  importReceipts: (o, id) => store.importReceipts(o, id),
  record: (o, id, e) => store.recordImport(o, id, e),
  reconcile: (t) => store.reconcileImport(t),
  complete: (o, id) => store.completeImport(o, id),
};
describe("durable completion", () => {
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "import-journal-"));
    const fs = await createNodePersistenceFs(
      directory,
      { hostEpoch: owner.hostEpoch, assertHeld() {} },
      { now: () => 0 },
    );
    store = new AtomicStore(fs);
    await store.initialize();
    await typedImports.plan(owner, plan);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await store.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  completionCases(owner, plan, typedImports);
  it("stores admission before reserve and rejects attempts installed through record", async () => {
    const original = await typedImports.load(owner, id);
    expect(original?.items[0]?.publicationTicket).toBeNull();
    const first = await typedImports.admit(owner, id, "one"),
      again = await typedImports.admit(owner, id, "one");
    expect(first).toEqual(again);
    expect(first.id).not.toBe(plan.items[0]!.ticket.id);
    expect(first.target).toEqual(plan.items[0]!.ticket.target);
    expect(first.metadata).toEqual(plan.items[0]!.ticket.metadata);
    const saved = await typedImports.load(owner, id);
    expect(saved?.items[0]?.publicationTicket).toEqual(first);
    await expect(
      typedImports.record(owner, id, {
        ...saved!.items[0]!,
        publicationTicket: { ...first, id: randomUUID() },
      }),
    ).rejects.toThrow();
    expect((await typedImports.load(owner, id))?.plan).toEqual(plan);
  });
  it("joins concurrent unreserved admission and never renews its deadline", async () => {
    const attempts = await Promise.all([
      typedImports.admit(owner, id, "one"),
      typedImports.admit(owner, id, "one"),
    ]);
    expect(attempts[0]).toEqual(attempts[1]);
    expect(attempts[0]!.deadlineMonotonicMs).toBe(10000);
  });
  it("requires an actual tagged head before recording a committed receipt", async () => {
    const ticket = await typedImports.admit(owner, id, "one");
    await expect(
      typedImports.record(owner, id, {
        key: "one",
        state: "committed",
        publicationTicket: ticket,
        skipReason: null,
        receipt: {
          revision:
            ticket.metadata.kind === "record"
              ? ticket.metadata.record.revision
              : "r_" + "0".repeat(32),
          commitId: ticket.id,
          durability: "file-and-directory-sync",
        },
      }),
    ).rejects.toThrow();
    await store.reserve(ticket, bytes.length);
    await typedImports.tagImport(ticket, plan.items[0]!.tag);
    await store.append(ticket, 0, bytes);
    await store.seal(ticket, bytes.length, digest);
    const outcome = await store.publish(ticket);
    expect(outcome.disposition).toBe("committed");
    expect(outcome.receipt?.commitId).toBe(ticket.id);
    await typedImports.record(owner, id, {
      key: "one",
      state: "committed",
      publicationTicket: ticket,
      skipReason: null,
      receipt: outcome.receipt!,
    });
    expect(await finishImport(typedImports, owner, plan)).toBe(true);
    await expect(typedImports.admit(owner, id, "one")).rejects.toThrow();
  });
  it("accepts only an exactly repeated plan", async () => {
    await expect(typedImports.plan(owner, structuredClone(plan))).resolves.toBeUndefined();
    await expect(typedImports.plan(owner, { ...plan, mappingVersion: 2 })).rejects.toThrow(
      "input-changed",
    );
  });
  it("rejects malformed journals and forged complete evidence", () => {
    for (const invalid of [
      { ...plan, formatVersion: 2 },
      { ...plan, extra: true },
      { ...plan, items: [plan.items[0], plan.items[0]] },
      { ...plan, id: "import/" + "0".repeat(64) },
      { ...plan, preferencesEvidence: { nonce: "bad", digest } },
    ])
      expect(importPlanSchema.safeParse(invalid).success).toBe(false);
    const pending = {
      key: "one",
      state: "pending",
      receipt: null,
      skipReason: null,
      publicationTicket: null,
    };
    for (const items of [
      [],
      [pending, pending],
      [{ ...pending, key: "foreign" }],
      [{ ...pending, state: "committed" }],
    ])
      expect(
        importDocumentSchema.safeParse({ formatVersion: 1, plan, items, complete: true }).success,
      ).toBe(false);
  });
});

import { loadImport, planImport, recordImport, reconcileImport } from "./import-journal.js";
import { syntheticImportDescriptor } from "./import-fixtures.js";
import { importItemEvidenceSchema, importTagSchema } from "./namespace.js";
describe("T6 import-journal.test.ts: strictness", () => {
  it("bounds actual UTF-8 journal bytes at 2 MiB including attempts and evidence refs", () => {
    const value = {
      formatVersion: 1 as const,
      plan: structuredClone(plan),
      items: [
        {
          key: "one",
          state: "pending" as const,
          receipt: null,
          skipReason: null,
          publicationTicket: null,
        },
      ],
      complete: false,
    };
    const base = Buffer.byteLength(JSON.stringify(value));
    const full = {
      ...value,
      plan: {
        ...value.plan,
        items: [
          {
            ...value.plan.items[0]!,
            ticket: {
              ...value.plan.items[0]!.ticket,
              owner: { ...owner, pluginId: owner.pluginId + "x".repeat(2097152 - base) },
            },
          },
        ],
      },
    };
    expect(Buffer.byteLength(JSON.stringify(full))).toBe(2097152);
    expect(importDocumentSchema.safeParse(full).success).toBe(true);
    full.plan.items[0]!.ticket.owner.pluginId += "x";
    expect(importDocumentSchema.safeParse(full).success).toBe(false);
    const attempted = {
      ...value,
      items: [
        {
          ...value.items[0]!,
          publicationTicket: { ...value.plan.items[0]!.ticket, id: randomUUID() },
        },
      ],
    };
    expect(importDocumentSchema.safeParse(attempted).success).toBe(true);
    const ref = { nonce: randomUUID(), digest };
    expect(importPlanSchema.safeParse({ ...plan, preferencesEvidence: ref }).success).toBe(true);
  });
  it("rejects foreign namespaces, tags, wrong metadata, hash, lengths, CAS and duplicate targets", () => {
    const item = plan.items[0]!;
    const invalid = [
      { ...item, sourceSha256: "0".repeat(64) },
      { ...item, mappedSha256: "0".repeat(64) },
      { ...item, byteLength: 4 },
      { ...item, tag: { ...item.tag, itemKey: "foreign" } },
      { ...item, ticket: { ...item.ticket, owner: { ...owner, sourceKey: "builtin:foreign" } } },
      {
        ...item,
        ticket: { ...item.ticket, target: { ...item.ticket.target, expectedRevision: "bad" } },
      },
      {
        ...item,
        ticket: {
          ...item.ticket,
          metadata: { kind: "settings", schemaVersion: 1, validationDigest: digest },
        },
      },
    ];
    for (const candidate of invalid)
      expect(importPlanSchema.safeParse({ ...plan, items: [candidate] }).success).toBe(false);
    expect(
      importPlanSchema.safeParse({
        ...plan,
        items: [
          item,
          {
            ...item,
            key: "second",
            tag: { ...item.tag, itemKey: "second" },
            ticket: { ...item.ticket, id: randomUUID() },
          },
        ],
      }).success,
    ).toBe(false);
  });
  it("checks byte-exact skip, key and tag limits", () => {
    const skip = {
      key: "one",
      state: "skipped",
      receipt: null,
      publicationTicket: null,
      skipReason: "é".repeat(128),
    };
    expect(importItemEvidenceSchema.safeParse(skip).success).toBe(true);
    expect(
      importItemEvidenceSchema.safeParse({ ...skip, skipReason: skip.skipReason + "x" }).success,
    ).toBe(false);
    expect(importItemEvidenceSchema.safeParse({ ...skip, key: "x".repeat(128) }).success).toBe(
      true,
    );
    expect(importItemEvidenceSchema.safeParse({ ...skip, key: "x".repeat(129) }).success).toBe(
      false,
    );
    const tag = { importId: "i", itemKey: "k", sourceSha256: digest };
    const extra = 256 - Buffer.byteLength(JSON.stringify(tag));
    tag.importId += "i".repeat(Math.min(127, extra));
    tag.itemKey += "k".repeat(extra - Math.min(127, extra));
    expect(Buffer.byteLength(JSON.stringify(tag))).toBe(256);
    expect(importTagSchema.safeParse(tag).success).toBe(true);
    tag.itemKey += "k";
    expect(importTagSchema.safeParse(tag).success).toBe(false);
  });
});
describe("T6 import-journal.test.ts: transitions", () => {
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "import-journal-transition-"));
    const fs = await createNodePersistenceFs(
      directory,
      { hostEpoch: owner.hostEpoch, assertHeld() {} },
      { now: () => 0 },
    );
    store = new AtomicStore(fs);
    await store.initialize();
    await planImport(typedImports, owner, syntheticImportDescriptor, plan);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await store.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  it("normalizes plans, returns defensive copies, and rejects changed descriptor versions", async () => {
    await planImport(typedImports, owner, syntheticImportDescriptor, structuredClone(plan));
    const loaded = (await loadImport(typedImports, owner, syntheticImportDescriptor))!;
    (loaded.plan.items as unknown[]).pop();
    expect(
      (await loadImport(typedImports, owner, syntheticImportDescriptor))?.plan.items,
    ).toHaveLength(1);
    await expect(
      loadImport(typedImports, owner, { ...syntheticImportDescriptor, mappingVersion: 2 }),
    ).rejects.toThrow("input-changed");
    await expect(
      loadImport(typedImports, owner, {
        ...syntheticImportDescriptor,
        targetRecordSchemaVersions: [2],
      }),
    ).rejects.toThrow("schema-mismatch");
  });
  it("refuses forged attempts and unverified receipts through the wrapper", async () => {
    const ticket = await typedImports.admit(owner, id, "one"),
      evidence = (await typedImports.load(owner, id))!.items[0]!;
    await expect(
      recordImport(typedImports, owner, id, {
        ...evidence,
        publicationTicket: { ...ticket, deadlineMonotonicMs: 10001 },
      }),
    ).rejects.toThrow("input-changed");
    await expect(
      recordImport(typedImports, owner, id, {
        ...evidence,
        state: "committed",
        receipt: {
          revision: recordRevision(ticket),
          commitId: ticket.id,
          durability: "file-and-directory-sync",
        },
      }),
    ).rejects.toThrow("unverified-receipt");
  });
  it("unknown cannot be skipped, reconciled to success or completed", async () => {
    const ticket = await typedImports.admit(owner, id, "one");
    vi.spyOn(typedImports, "reconcile").mockResolvedValue({ disposition: "unknown" });
    await expect(
      recordImport(typedImports, owner, id, {
        key: "one",
        state: "skipped",
        receipt: null,
        skipReason: "trusted",
        publicationTicket: ticket,
      }),
    ).rejects.toThrow("publish-uncertain");
    await expect(reconcileImport(typedImports, owner, plan)).rejects.toThrow("publish-uncertain");
    expect(await finishImport(typedImports, owner, plan)).toBe(false);
  });
  it("repairs receipt from tagged head, preserves actual attempt, finishes once", async () => {
    const ticket = await typedImports.admit(owner, id, "one");
    await store.reserve(ticket, bytes.length);
    await store.tagImport(ticket, plan.items[0]!.tag);
    await store.append(ticket, 0, bytes);
    await store.seal(ticket, bytes.length, digest);
    await store.publish(ticket);
    const result = await reconcileImport(typedImports, owner, plan);
    expect(result?.items[0]?.state).toBe("committed");
    expect(result?.items[0]?.receipt?.commitId).toBe(ticket.id);
    expect(result?.items[0]?.publicationTicket).toEqual(ticket);
    expect(await finishImport(typedImports, owner, plan)).toBe(true);
    const complete = vi.spyOn(typedImports, "complete");
    expect(await finishImport(typedImports, owner, plan)).toBe(true);
    expect(complete).not.toHaveBeenCalled();
    expect(
      (
        await loadImport(typedImports, owner, {
          ...syntheticImportDescriptor,
          mappingVersion: 2,
          targetRecordSchemaVersions: [2],
        })
      )?.complete,
    ).toBe(true);
  });
  it("a failed completion marker is not success and explicit skip remains durable", async () => {
    await recordImport(typedImports, owner, id, {
      key: "one",
      state: "skipped",
      receipt: null,
      skipReason: "trusted-user-skip",
      publicationTicket: null,
    });
    vi.spyOn(typedImports, "complete").mockRejectedValueOnce(new Error("publish-uncertain"));
    await expect(finishImport(typedImports, owner, plan)).rejects.toThrow("publish-uncertain");
    expect((await typedImports.load(owner, id))?.complete).toBe(false);
    expect(await finishImport(typedImports, owner, plan)).toBe(true);
    expect((await typedImports.load(owner, id))?.items[0]?.skipReason).toBe("trusted-user-skip");
  });
  it.each(["plan", "attempt", "receipt"] as const)(
    "T6 fix round1 namespace budget includes %s growth",
    async (phase) => {
      let attempt: PublicationTicket | undefined;
      if (phase === "receipt") {
        attempt = await typedImports.admit(owner, id, "one");
        await store.reserve(attempt, bytes.length);
        await store.tagImport(attempt, plan.items[0]!.tag);
        await store.append(attempt, 0, bytes);
        await store.seal(attempt, bytes.length, digest);
        expect((await store.publish(attempt)).disposition).toBe("committed");
      }
      const before = await typedImports.load(owner, id),
        existing = (await store.auxiliary(owner, "import", id))!;
      // Existing opaque import evidence counts too: fill the namespace, not the plan's
      // individual codec limit. The production engine persists and hashes these bytes.
      const padding = Buffer.from(
          JSON.stringify({ padding: "x".repeat(2097152 - existing.length - 32 - 14) }),
        ),
        target = { kind: "import" as const, key: "budget-padding" },
        filler: PublicationTicket = {
          id: randomUUID(),
          owner,
          deadlineMonotonicMs: 10000,
          target,
          metadata: target,
        };
      expect(existing.length + padding.length).toBe(2097152 - 32);
      await store.reserve(filler, padding.length);
      for (let offset = 0; offset < padding.length; offset += 262144)
        await store.append(filler, offset, padding.subarray(offset, offset + 262144));
      await store.seal(filler, padding.length, createHash("sha256").update(padding).digest("hex"));
      expect((await store.publish(filler)).disposition).toBe("committed");
      if (phase === "plan") {
        const descriptorId = "test.other-import",
          nextId = importIdFor(descriptorId, owner.sourceKey),
          next = {
            ...structuredClone(plan),
            id: nextId,
            descriptorId,
            items: plan.items.map((item) => ({
              ...structuredClone(item),
              tag: { ...item.tag, importId: nextId },
            })),
          };
        await expect(typedImports.plan(owner, next)).rejects.toThrow();
        expect(await typedImports.load(owner, nextId)).toBeNull();
      } else if (phase === "attempt") {
        await expect(typedImports.admit(owner, id, "one")).rejects.toThrow();
      } else {
        const outcome = await typedImports.reconcile(attempt!);
        if (outcome.disposition !== "committed" || !outcome.receipt) throw new Error("fixture");
        await expect(
          typedImports.record(owner, id, {
            key: "one",
            state: "committed",
            receipt: outcome.receipt,
            skipReason: null,
            publicationTicket: attempt!,
          }),
        ).rejects.toThrow();
        expect((await typedImports.reconcile(attempt!)).disposition).toBe("committed");
      }
      expect(await typedImports.load(owner, id)).toEqual(before);
      expect(await store.auxiliary(owner, "import", "budget-padding")).toEqual(
        Uint8Array.from(padding),
      );
    },
  );
});
function recordRevision(ticket: PublicationTicket): string {
  if (ticket.metadata.kind !== "record") throw new Error("fixture");
  return ticket.metadata.record.revision;
}

it("T6 import-journal.test.ts: strictness — exact aggregate bytes include the attempt and nonce reference", () => {
  const item = { ...structuredClone(plan.items[0]!) };
  const attempt = { ...structuredClone(item.ticket), id: randomUUID() };
  const document = {
    formatVersion: 1 as const,
    plan: { ...plan, preferencesEvidence: { nonce: randomUUID(), digest }, items: [item] },
    items: [
      {
        key: item.key,
        state: "pending" as const,
        receipt: null,
        skipReason: null,
        publicationTicket: attempt,
      },
    ],
    complete: false,
  };
  if ((2097152 - Buffer.byteLength(JSON.stringify(document))) % 2) {
    item.key += "x";
    item.tag = { ...item.tag, itemKey: item.key };
    document.items[0]!.key = item.key;
  }
  const padding = "x".repeat((2097152 - Buffer.byteLength(JSON.stringify(document))) / 2);
  item.ticket = {
    ...item.ticket,
    owner: { ...item.ticket.owner, pluginId: item.ticket.owner.pluginId + padding },
  };
  attempt.owner = { ...attempt.owner, pluginId: attempt.owner.pluginId + padding };
  expect(Buffer.byteLength(JSON.stringify(document))).toBe(2097152);
  expect(importDocumentSchema.safeParse(document).success).toBe(true);
  document.plan.mappingVersion = 10;
  expect(Buffer.byteLength(JSON.stringify(document))).toBe(2097153);
  expect(importDocumentSchema.safeParse(document).success).toBe(false);
});
