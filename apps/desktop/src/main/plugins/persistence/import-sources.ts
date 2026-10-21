import type { Handle, Sha256, Version, Values, RecordWrite } from "@kobrixa/plugin-protocol";
import type { CoreWindowScope } from "@kobrixa/plugin-runtime";
export type LegacyPreferencesSnapshot = {
  nonce: Handle;
  scope: CoreWindowScope;
  entries: Array<{ key: string; raw: string | null }>;
};
export type LegacyImportInput = {
  sourceKind: "sensor-lab" | "device-settings" | "renderer-preferences";
  bytes: Uint8Array;
  sha256: Sha256;
};
export type LegacyImportItem =
  | { kind: "settings"; schemaVersion: Version; values: Values }
  | {
      kind: "record";
      metadata: Omit<RecordWrite, "target" | "checkpoint" | "drainToken">;
      bytes: Uint8Array;
    };
export interface LegacyImportDescriptor {
  id: string;
  mappingVersion: Version;
  targetSourceKey: string;
  sourceKind: LegacyImportInput["sourceKind"];
  sourceFormatVersions: readonly Version[];
  targetSettingsSchemaVersion?: Version;
  targetRecordSchemaVersions: readonly Version[];
  rendererKeyAllowlist?: readonly string[];
  validate(input: LegacyImportInput): boolean;
  map(input: LegacyImportInput): LegacyImportItem;
}
export interface LegacyImportCoordinator {
  run(
    descriptor: LegacyImportDescriptor,
    signal: AbortSignal,
  ): Promise<{
    state: "pending" | "planned" | "copying" | "complete" | "complete-empty" | "blocked";
    completedItems: number;
    totalItems: number;
  }>;
  acceptPreferences(snapshot: LegacyPreferencesSnapshot): Promise<void>;
}

import type { PersistenceOwner } from "@kobrixa/plugin-runtime";
import type {
  PersistenceBackend,
  PublicationTicket,
  LegacyPreferencesEvidenceRef,
} from "./engine-port.js";
export type LegacySourceItem = Readonly<{
  key: string;
  format: Version;
  byteLength: number;
  sha256: Sha256;
}>;

export type LegacyMappedItem = Readonly<
  { mapped: Handle; sourceSha256: Sha256; mappedSha256: Sha256; byteLength: number } & (
    | { kind: "settings"; schemaVersion: Version }
    | { kind: "record"; metadata: Omit<RecordWrite, "target" | "checkpoint" | "drainToken"> }
  )
>;

export interface LegacySourceResolver {
  resolvePreferences(input: {
    descriptorId: string;
    owner: PersistenceOwner;
    evidence: LegacyPreferencesEvidenceRef;
  }): Promise<void>;
  register(input: {
    descriptorId: string;
    mapperId: string;
    sourceKind: LegacyImportInput["sourceKind"];
  }): Promise<void>;
  map(descriptorId: string, key: string): Promise<LegacyMappedItem>;
  appendMapped(input: {
    mapped: Handle;
    ticket: PublicationTicket;
    offset: number;
    maxBytes: number;
  }): Promise<{ nextOffset: number; done: boolean }>;
  releaseMapped(mapped: Handle): Promise<void>;
  inventory(
    descriptorId: string,
  ): Promise<{ state: "present" | "absent" | "blocked"; entries: readonly LegacySourceItem[] }>;
  read(descriptorId: string, key: string, offset: number, maxBytes: number): Promise<Uint8Array>;
}

export type LegacyPreferenceChallenge = Readonly<{
  nonce: Handle;
  scope: CoreWindowScope;
  descriptorId: string;
  keys: readonly string[];
}>;

export interface LegacyWriterBarrier {
  enter(sourceKey: string, descriptorId: string): Promise<Handle>;
  restore(): Promise<readonly { sourceKey: string; descriptorId: string; barrier: Handle }[]>;
  complete(barrier: Handle): Promise<void>;
}

export interface LegacyImportHostPort extends LegacyImportCoordinator {
  issuePreferences(input: {
    descriptorId: string;
    scope: CoreWindowScope;
  }): Promise<LegacyPreferenceChallenge>;
  retirePreferences(scope: CoreWindowScope): void;
  acceptPreferencesEvidence(snapshot: LegacyPreferencesSnapshot): Promise<{
    state: "accepted" | "pending" | "reconciled";
  }>;
}

export interface LegacyWriterPort {
  readonly sourceKey: string;
  freezeAdmission(): void;
  settled(): Promise<void>;
}

export const IMPORT_LIMITS = Object.freeze({
  candidateNames: 4096,
  items: 512,
  journalBytes: 2 * 1024 * 1024,
  batch: 64,
  recordBytes: 8 * 1024 * 1024,
  preferenceBytes: 64 * 1024,
  preferenceKeys: 128,
});
const canonicalHandle = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuidFile = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
export type InventoryFact = {
  name: string;
  regular: boolean;
  contained: boolean;
  links: number;
  bytes: number;
};
export function assertInventory(candidateCount: number, entries: readonly InventoryFact[]): void {
  if (
    !Number.isSafeInteger(candidateCount) ||
    candidateCount < entries.length ||
    candidateCount > IMPORT_LIMITS.candidateNames ||
    entries.length > IMPORT_LIMITS.items ||
    new Set(entries.map((entry) => entry.name)).size !== entries.length
  )
    throw new Error("inventory-limit");
  for (const file of entries) {
    if (
      !uuidFile.test(file.name) ||
      !file.regular ||
      !file.contained ||
      file.links !== 1 ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > IMPORT_LIMITS.recordBytes
    )
      throw new Error("unsafe-source");
  }
}
export function classifySourceError(error: unknown): "absent" | "blocked" {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT"
    ? "absent"
    : "blocked";
}
export function snapshotBytes(
  snapshot: LegacyPreferencesSnapshot,
  allowlist: readonly string[],
): Uint8Array {
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (
    !object(snapshot) ||
    Object.keys(snapshot).sort().join(",") !== "entries,nonce,scope" ||
    typeof snapshot.nonce !== "string" ||
    !canonicalHandle.test(snapshot.nonce) ||
    !object(snapshot.scope) ||
    Object.keys(snapshot.scope).sort().join(",") !== "hostEpoch,workbenchInstance" ||
    typeof snapshot.scope.hostEpoch !== "string" ||
    !canonicalHandle.test(snapshot.scope.hostEpoch) ||
    typeof snapshot.scope.workbenchInstance !== "string" ||
    !canonicalHandle.test(snapshot.scope.workbenchInstance) ||
    !Array.isArray(snapshot.entries) ||
    !Array.isArray(allowlist) ||
    allowlist.some((key) => typeof key !== "string" || !key || Buffer.byteLength(key) > 128)
  )
    throw new Error("snapshot-shape");
  if (
    allowlist.length > IMPORT_LIMITS.preferenceKeys ||
    snapshot.entries.length > IMPORT_LIMITS.preferenceKeys
  )
    throw new Error("snapshot-limit");
  const allowed = new Set(allowlist),
    seen = new Set<string>();
  if (allowed.size !== allowlist.length || snapshot.entries.length !== allowed.size)
    throw new Error("snapshot-keys");
  for (const entry of snapshot.entries) {
    if (
      !object(entry) ||
      Object.keys(entry).sort().join(",") !== "key,raw" ||
      typeof entry.key !== "string" ||
      !allowed.has(entry.key) ||
      seen.has(entry.key) ||
      (entry.raw !== null && typeof entry.raw !== "string")
    )
      throw new Error("snapshot-keys");
    seen.add(entry.key);
  }
  const copy: LegacyPreferencesSnapshot = {
    nonce: snapshot.nonce,
    scope: {
      hostEpoch: snapshot.scope.hostEpoch,
      workbenchInstance: snapshot.scope.workbenchInstance,
    },
    entries: snapshot.entries.map((entry) => ({ key: entry.key, raw: entry.raw })),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(copy));
  if (bytes.byteLength > IMPORT_LIMITS.preferenceBytes) throw new Error("snapshot-limit");
  return bytes;
}
const sameScope = (a: CoreWindowScope, b: CoreWindowScope): boolean =>
  a.hostEpoch === b.hostEpoch && a.workbenchInstance === b.workbenchInstance;

// These codecs are pure: no filesystem, coordinator instance or renderer authority.
import { createHash } from "node:crypto";
import { z } from "zod";
import { publicationTicketSchema } from "./namespace.js";
import { sameImportValue } from "./namespace.js";
export type LegacyNonceDocument = Readonly<{
  formatVersion: 1;
  kind: "nonce";
  descriptorId: string;
  sourceKey: string;
  nonce: Handle;
  scope: CoreWindowScope;
  allowlist: readonly string[];
  state: "issued" | "consumed";
  raw: LegacyPreferencesSnapshot | null;
  digest: Sha256 | null;
  originalTicket: PublicationTicket;
  ticket: PublicationTicket;
}>;
export type LegacyBarrierDocument = Readonly<{
  formatVersion: 1;
  kind: "barrier";
  descriptorId: string;
  sourceKey: string;
  barrier: Handle;
  state: "active" | "complete";
  originalTicket: PublicationTicket;
  ticket: PublicationTicket;
}>;
export type ImportAuxiliaryDocument = LegacyNonceDocument | LegacyBarrierDocument;
const sha256 = (bytes: Uint8Array): Sha256 => createHash("sha256").update(bytes).digest("hex");
export function importIdFor(descriptorId: string, sourceKey: string): string {
  return "import/" + sha256(new TextEncoder().encode(JSON.stringify([descriptorId, sourceKey])));
}
export function barrierKeyFor(descriptorId: string): string {
  return "barrier/" + sha256(new TextEncoder().encode(descriptorId));
}
export function snapshotDigest(
  snapshot: LegacyPreferencesSnapshot,
  allowlist: readonly string[],
): Sha256 {
  return sha256(snapshotBytes(snapshot, allowlist));
}
const boundedId = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value) <= 128 && !value.includes("\0"));
const descriptorIdSchema = boundedId.refine((value) =>
  /^[a-z][a-z0-9-]*(?:[.:][a-z0-9-]+)+$/.test(value),
);
const handleSchema = z.string().regex(canonicalHandle);
const scopeSchema = z.strictObject({ hostEpoch: handleSchema, workbenchInstance: handleSchema });
const rawSchema = z.strictObject({
  nonce: handleSchema,
  scope: scopeSchema,
  entries: z.array(z.strictObject({ key: boundedId, raw: z.string().nullable() })).max(128),
});
const commonAuxiliary = {
  formatVersion: z.literal(1),
  descriptorId: descriptorIdSchema,
  sourceKey: z.string().min(1).max(160),
  originalTicket: publicationTicketSchema,
  ticket: publicationTicketSchema,
};
const nonceSchema = z.strictObject({
  ...commonAuxiliary,
  kind: z.literal("nonce"),
  nonce: handleSchema,
  scope: scopeSchema,
  allowlist: z.array(boundedId).max(128),
  state: z.enum(["issued", "consumed"]),
  raw: rawSchema.nullable(),
  digest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
});
const barrierSchema = z.strictObject({
  ...commonAuxiliary,
  kind: z.literal("barrier"),
  barrier: handleSchema,
  state: z.enum(["active", "complete"]),
});
function decodeAuxiliary(bytes: Uint8Array): unknown {
  if (bytes.byteLength > IMPORT_LIMITS.journalBytes) throw new Error("size-limit");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
function checkAuxiliaryTickets(document: ImportAuxiliaryDocument, key: string): void {
  if (
    document.originalTicket.id === document.ticket.id &&
    !sameImportValue(document.originalTicket, document.ticket)
  )
    throw new Error("evidence-binding");
  for (const ticket of [document.originalTicket, document.ticket]) {
    if (
      ticket.owner.sourceKey !== document.sourceKey ||
      ticket.owner.pluginId !== document.originalTicket.owner.pluginId ||
      ticket.metadata.kind !== "import" ||
      ticket.metadata.key !== key ||
      ticket.target.kind !== "import" ||
      ticket.target.key !== key
    )
      throw new Error("evidence-binding");
  }
}
export function parseNonceDocument(bytes: Uint8Array): LegacyNonceDocument {
  const document = nonceSchema.parse(decodeAuxiliary(bytes));
  checkAuxiliaryTickets(document, "nonce/" + document.nonce);
  if (
    new Set(document.allowlist).size !== document.allowlist.length ||
    (document.raw === null) !== (document.digest === null) ||
    (document.state === "consumed" && document.raw === null) ||
    document.originalTicket.owner.hostEpoch !== document.scope.hostEpoch
  )
    throw new Error("evidence-binding");
  if (
    document.raw &&
    (document.raw.nonce !== document.nonce ||
      !sameScope(document.raw.scope, document.scope) ||
      snapshotDigest(document.raw, document.allowlist) !== document.digest)
  )
    throw new Error("evidence-binding");
  if (document.raw === null && !sameImportValue(document.originalTicket, document.ticket))
    throw new Error("evidence-binding");
  return structuredClone(document);
}
export function parseBarrierDocument(bytes: Uint8Array): LegacyBarrierDocument {
  const document = barrierSchema.parse(decodeAuxiliary(bytes));
  checkAuxiliaryTickets(document, barrierKeyFor(document.descriptorId));
  if (
    document.state === "active" &&
    document.originalTicket.id === document.ticket.id &&
    !sameImportValue(document.originalTicket, document.ticket)
  )
    throw new Error("evidence-binding");
  return structuredClone(document);
}

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { publishImportDocument } from "./import-journal.js";

export function createLegacyWriterBarrier(input: {
  backend: PersistenceBackend;
  descriptors: readonly Pick<LegacyImportDescriptor, "id" | "targetSourceKey">[];
  writers: readonly LegacyWriterPort[];
  importOwner: (sourceKey: string) => PersistenceOwner;
}): LegacyWriterBarrier {
  const descriptors = new Map(input.descriptors.map((d) => [d.id, { ...d }]));
  if (descriptors.size !== input.descriptors.length) throw new Error("duplicate-descriptor");
  for (const d of descriptors.values()) descriptorIdSchema.parse(d.id);
  for (const w of input.writers)
    if (![...descriptors.values()].some((d) => d.targetSourceKey === w.sourceKey))
      throw new Error("invalid-writer");
  const entries = new Map<string, LegacyBarrierDocument>(),
    operations = new Map<string, Promise<unknown>>();
  const pending = new Map<
    string,
    { document: LegacyBarrierDocument; promise: ReturnType<typeof publishImportDocument> }
  >();
  let restoration: ReturnType<LegacyWriterBarrier["restore"]> | undefined;
  function serialize<T>(id: string, body: () => Promise<T>): Promise<T> {
    const result = (operations.get(id) ?? Promise.resolve()).catch(() => {}).then(body);
    operations.set(id, result);
    void result
      .finally(() => {
        if (operations.get(id) === result) operations.delete(id);
      })
      .catch(() => {});
    return result;
  }
  function ticket(sourceKey: string, key: string): PublicationTicket {
    return {
      id: randomUUID(),
      owner: structuredClone(input.importOwner(sourceKey)),
      deadlineMonotonicMs: performance.now() + 10000,
      metadata: { kind: "import", key },
      target: { kind: "import", key },
    };
  }
  async function save(document: LegacyBarrierDocument): Promise<void> {
    let operation = pending.get(document.descriptorId);
    if (operation && !sameImportValue(operation.document, document))
      throw new Error("import-pending");
    if (!operation) {
      const copy = parseBarrierDocument(Buffer.from(JSON.stringify(document)));
      operation = {
        document: copy,
        promise: Promise.resolve().then(() => publishImportDocument(input.backend, copy)),
      };
      pending.set(document.descriptorId, operation);
    }
    let result: Awaited<ReturnType<typeof publishImportDocument>>;
    try {
      result = await operation.promise;
    } catch (error) {
      pending.delete(document.descriptorId);
      throw error;
    }
    if (result.disposition === "unknown")
      result = await input.backend.imports.reconcile(operation.document.ticket);
    if (result.disposition === "unknown") throw new Error("import-pending");
    pending.delete(document.descriptorId);
    if (result.disposition !== "committed") throw new Error("not-committed");
    entries.set(document.descriptorId, operation.document);
  }
  function restore(): ReturnType<LegacyWriterBarrier["restore"]> {
    if (restoration) return restoration;
    for (const writer of input.writers) writer.freezeAdmission();
    restoration = Promise.resolve().then(async () => {
      for (const descriptor of descriptors.values()) {
        const owner = input.importOwner(descriptor.targetSourceKey),
          key = barrierKeyFor(descriptor.id);
        let cursor: Handle | undefined;
        do {
          const page = await input.backend.evidence.auxiliaryKeys(owner, "import", cursor);
          if (page.keys.length > 64 || Buffer.byteLength(JSON.stringify(page)) > 262144)
            throw new Error("size-limit");
          if (page.keys.includes(key)) {
            const bytes = await input.backend.evidence.auxiliary(owner, "import", key);
            if (!bytes) throw new Error("missing-evidence");
            const document = parseBarrierDocument(bytes);
            if (
              document.descriptorId !== descriptor.id ||
              document.sourceKey !== descriptor.targetSourceKey ||
              barrierKeyFor(document.descriptorId) !== key
            )
              throw new Error("evidence-binding");
            const result = await input.backend.imports.reconcile(document.ticket);
            if (result.disposition !== "committed") throw new Error("import-pending");
            entries.set(descriptor.id, document);
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
      }
      return [...entries.values()].map((d) => ({
        sourceKey: d.sourceKey,
        descriptorId: d.descriptorId,
        barrier: d.barrier,
      }));
    });
    return restoration;
  }
  const entering = new Map<string, Promise<Handle>>(),
    completing = new Map<Handle, Promise<void>>();
  function enter(sourceKey: string, descriptorId: string): Promise<Handle> {
    const descriptor = descriptors.get(descriptorId);
    if (!descriptor || descriptor.targetSourceKey !== sourceKey)
      return Promise.reject(new Error("invalid-descriptor"));
    for (const writer of input.writers)
      if (writer.sourceKey === sourceKey) writer.freezeAdmission();
    const existing = entering.get(descriptorId);
    if (existing) return existing;
    const operation = serialize(descriptorId, async () => {
      await restore();
      const unresolved = pending.get(descriptorId);
      if (unresolved) await save(unresolved.document);
      let document = entries.get(descriptorId);
      if (!document) {
        const originalTicket = ticket(sourceKey, barrierKeyFor(descriptorId));
        document = {
          formatVersion: 1,
          kind: "barrier",
          sourceKey,
          descriptorId,
          barrier: randomUUID(),
          state: "active",
          originalTicket,
          ticket: originalTicket,
        };
        await save(document);
      }
      await Promise.all(
        input.writers.filter((w) => w.sourceKey === sourceKey).map((w) => w.settled()),
      );
      return document.barrier;
    });
    entering.set(descriptorId, operation);
    void operation
      .finally(() => {
        if (entering.get(descriptorId) === operation) entering.delete(descriptorId);
      })
      .catch(() => {});
    return operation;
  }
  function complete(barrier: Handle): Promise<void> {
    const existing = completing.get(barrier);
    if (existing) return existing;
    const operation = (async () => {
      await restore();
      const document = [...entries.values()].find((d) => d.barrier === barrier);
      if (!document) throw new Error("stale");
      return serialize(document.descriptorId, async () => {
        const unresolved = pending.get(document.descriptorId);
        if (unresolved) await save(unresolved.document);
        const current = entries.get(document.descriptorId)!;
        if (current.state === "complete") return;
        const saved = await input.backend.imports.load(
          input.importOwner(current.sourceKey),
          importIdFor(current.descriptorId, current.sourceKey),
        );
        if (!saved?.complete) throw new Error("incomplete");
        await save({
          ...current,
          state: "complete",
          ticket: ticket(current.sourceKey, barrierKeyFor(current.descriptorId)),
        });
      });
    })();
    completing.set(barrier, operation);
    void operation
      .finally(() => {
        if (completing.get(barrier) === operation) completing.delete(barrier);
      })
      .catch(() => {});
    return operation;
  }
  return { restore, enter, complete };
}
