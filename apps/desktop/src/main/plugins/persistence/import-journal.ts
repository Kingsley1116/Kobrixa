import type {
  DurableImportPort,
  ImportItemEvidence,
  ImportPlan,
  PersistenceOwner,
  PersistenceBackend,
  PersistenceEnginePort,
} from "./engine-port.js";
import type { LegacyImportDescriptor, ImportAuxiliaryDocument } from "./import-sources.js";
import { importIdFor, parseNonceDocument, parseBarrierDocument } from "./import-sources.js";
import {
  importDocumentSchema,
  importPlanSchema,
  importItemEvidenceSchema,
  sameImportValue,
} from "./namespace.js";
import { createHash } from "node:crypto";
function checkDescriptor(
  plan: ImportPlan,
  owner: PersistenceOwner,
  descriptor: LegacyImportDescriptor,
  complete: boolean,
): void {
  if (
    plan.id !== importIdFor(descriptor.id, owner.sourceKey) ||
    plan.descriptorId !== descriptor.id ||
    plan.targetSourceKey !== owner.sourceKey ||
    descriptor.targetSourceKey !== owner.sourceKey ||
    plan.items.some((item) => item.ticket.owner.pluginId !== owner.pluginId)
  )
    throw new Error("input-changed");
  if (complete) return;
  if (
    plan.mappingVersion !== descriptor.mappingVersion ||
    (plan.preferencesEvidence !== null) !== (descriptor.sourceKind === "renderer-preferences")
  )
    throw new Error("input-changed");
  for (const item of plan.items) {
    if (!descriptor.sourceFormatVersions.includes(item.sourceFormat))
      throw new Error("unsupported-format");
    const metadata = item.ticket.metadata;
    if (
      metadata.kind === "settings" &&
      metadata.schemaVersion !== descriptor.targetSettingsSchemaVersion
    )
      throw new Error("schema-mismatch");
    if (
      metadata.kind === "record" &&
      !descriptor.targetRecordSchemaVersions.includes(metadata.record.schemaVersion)
    )
      throw new Error("schema-mismatch");
  }
}
export async function loadImport(
  imports: DurableImportPort,
  owner: PersistenceOwner,
  descriptor: LegacyImportDescriptor,
): ReturnType<DurableImportPort["load"]> {
  const saved = await imports.load(owner, importIdFor(descriptor.id, descriptor.targetSourceKey));
  if (!saved) return null;
  const checked = importDocumentSchema.parse({ formatVersion: 1, ...saved });
  checkDescriptor(checked.plan, owner, descriptor, checked.complete);
  return structuredClone({ plan: checked.plan, items: checked.items, complete: checked.complete });
}
export async function planImport(
  imports: DurableImportPort,
  owner: PersistenceOwner,
  descriptor: LegacyImportDescriptor,
  plan: ImportPlan,
): Promise<void> {
  const checked = importPlanSchema.parse(plan);
  checkDescriptor(checked, owner, descriptor, false);
  const initial = {
    formatVersion: 1,
    plan: checked,
    items: checked.items.map((item) => ({
      key: item.key,
      state: "pending",
      receipt: null,
      skipReason: null,
      publicationTicket: null,
    })),
    complete: false,
  };
  importDocumentSchema.parse(initial);
  await imports.plan(owner, structuredClone(checked));
}
export async function recordImport(
  imports: DurableImportPort,
  owner: PersistenceOwner,
  id: string,
  evidence: ImportItemEvidence,
): Promise<void> {
  const next = importItemEvidenceSchema.parse(evidence),
    saved = await imports.load(owner, id);
  if (!saved) throw new Error("missing-import-plan");
  importDocumentSchema.parse({ formatVersion: 1, ...saved });
  const item = saved.plan.items.find((item) => item.key === next.key),
    prior = saved.items.find((item) => item.key === next.key);
  if (!item || !prior || !sameImportValue(prior.publicationTicket, next.publicationTicket))
    throw new Error("input-changed");
  if (prior.state === "committed" || prior.state === "skipped") {
    if (!sameImportValue(prior, next)) throw new Error("input-changed");
    return;
  }
  if (saved.complete) throw new Error("stale");
  if (next.state === "committed") {
    const verified = await imports.reconcile(item.ticket);
    if (verified.disposition !== "committed" || !sameImportValue(verified.receipt, next.receipt))
      throw new Error("unverified-receipt");
  }
  // AtomicStore.recordImport revokes/settles the actual attempt before admitting a trusted skip.
  if (
    next.state === "skipped" &&
    (await imports.reconcile(item.ticket)).disposition !== "not-committed"
  )
    throw new Error("publish-uncertain");
  await imports.record(owner, id, structuredClone(next));
}
export async function reconcileImport(
  imports: DurableImportPort,
  owner: PersistenceOwner,
  plan: ImportPlan,
): ReturnType<DurableImportPort["load"]> {
  let saved = await imports.load(owner, plan.id);
  if (!saved) throw new Error("missing-import-plan");
  importDocumentSchema.parse({ formatVersion: 1, ...saved });
  if (!sameImportValue(saved.plan, plan)) throw new Error("input-changed");
  if (saved.complete) return structuredClone(saved);
  for (const item of saved.plan.items) {
    const prior = saved.items.find((e) => e.key === item.key)!;
    if (prior.state === "committed" || prior.state === "skipped") continue;
    const result = await imports.reconcile(item.ticket);
    if (result.disposition === "unknown") throw new Error("publish-uncertain");
    if (result.disposition === "committed") {
      if (!result.receipt || !prior.publicationTicket) throw new Error("unverified-receipt");
      await recordImport(imports, owner, plan.id, {
        ...prior,
        state: "committed",
        receipt: result.receipt,
        skipReason: null,
      });
    }
  }
  saved = await imports.load(owner, plan.id);
  if (!saved) throw new Error("missing-import-plan");
  importDocumentSchema.parse({ formatVersion: 1, ...saved });
  return structuredClone(saved);
}
export async function publishImportDocument(
  backend: PersistenceBackend,
  document: ImportAuxiliaryDocument,
): ReturnType<PersistenceEnginePort["publish"]> {
  return publishGuardedImportDocument(backend, document, () => {});
}

/** Internal renderer admission fence; called after asynchronous preflight and before dispatch. */
export async function publishGuardedImportDocument(
  backend: PersistenceBackend,
  document: ImportAuxiliaryDocument,
  admit: () => void,
): ReturnType<PersistenceEnginePort["publish"]> {
  const encoded = Buffer.from(JSON.stringify(document));
  const checked =
    document.kind === "nonce" ? parseNonceDocument(encoded) : parseBarrierDocument(encoded);
  const bytes = Buffer.from(JSON.stringify(checked)),
    ticket = checked.ticket;
  await assertImportBudget(
    backend,
    ticket.owner,
    ticket.target.kind === "import" ? ticket.target.key : "",
    bytes,
  );
  let reserved = false;
  try {
    admit();
    await backend.engine.reserve(ticket, bytes.length);
    reserved = true;
    for (let offset = 0; offset < bytes.length; offset += 262144)
      await backend.engine.append(ticket, offset, bytes.subarray(offset, offset + 262144));
    await backend.engine.seal(
      ticket,
      bytes.length,
      createHash("sha256").update(bytes).digest("hex"),
    );
    const result = await backend.engine.publish(ticket);
    return result.disposition === "unknown" ? await backend.imports.reconcile(ticket) : result;
  } catch (error) {
    if (reserved) {
      let disposition: "aborted" | "committed" | "unknown";
      try {
        disposition = await backend.engine.abort(ticket);
      } catch {
        disposition = "unknown";
      }
      if (disposition === "unknown" || disposition === "committed") {
        try {
          return await backend.imports.reconcile(ticket);
        } catch {
          return { disposition: "unknown" };
        }
      }
    }
    throw error;
  }
}

export async function finishImport(
  imports: DurableImportPort,
  owner: PersistenceOwner,
  plan: ImportPlan,
): Promise<boolean> {
  const stored = await imports.load(owner, plan.id);
  if (!stored) throw new Error("missing-import-plan");
  if (stored.complete) return true;
  const evidence = new Map<string, ImportItemEvidence>(
    stored.items.map((item) => [item.key, item]),
  );
  const terminal = plan.items.every((item) => {
    const result = evidence.get(item.key);
    return (
      (result?.state === "committed" && result.receipt !== null) ||
      (result?.state === "skipped" && result.skipReason !== null && result.skipReason.length > 0)
    );
  });
  if (!terminal) return false;
  await imports.complete(owner, plan.id);
  return true;
}

/** Check the namespace's complete import metadata budget before admitting a replacement.
 * Enumeration contains keys only; payloads are read one at a time and never retained here.
 */
export async function assertImportBudget(
  backend: PersistenceBackend,
  owner: PersistenceOwner,
  key: string,
  bytes: Uint8Array,
): Promise<void> {
  let size = bytes.byteLength,
    count = 1,
    cursor: string | undefined;
  const cursors = new Set<string>(),
    keys = new Set<string>();
  do {
    const page = await backend.evidence.auxiliaryKeys(owner, "import", cursor);
    if (page.keys.length > 64 || Buffer.byteLength(JSON.stringify(page)) > 262144)
      throw new Error("size-limit");
    for (const existing of page.keys) {
      if (keys.has(existing)) throw new Error("evidence-binding");
      keys.add(existing);
      if (existing === key) continue;
      const saved = await backend.evidence.auxiliary(owner, "import", existing);
      if (!saved) throw new Error("missing-evidence");
      size += saved.byteLength;
      count++;
      if (size > 2097152 || count > 512) throw new Error("size-limit");
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor) {
      if (cursors.has(cursor)) throw new Error("evidence-binding");
      cursors.add(cursor);
    }
  } while (cursor);
  if (size > 2097152 || count > 512) throw new Error("size-limit");
}
