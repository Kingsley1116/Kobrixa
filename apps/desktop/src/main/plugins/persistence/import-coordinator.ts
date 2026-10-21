import { randomUUID, createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Handle } from "@kobrixa/plugin-protocol";
import type { CoreWindowScope } from "@kobrixa/plugin-runtime";
import type {
  PersistenceBackend,
  PersistenceEnginePort,
  PublicationTicket,
  PersistenceOwner,
  ImportPlan,
  ImportPlannedItem,
  LegacyPreferencesEvidenceRef,
} from "./engine-port.js";
import type {
  LegacySourceResolver,
  LegacyWriterBarrier,
  LegacyImportDescriptor,
  LegacyImportHostPort,
  LegacyPreferencesSnapshot,
  LegacyNonceDocument,
  LegacyMappedItem,
} from "./import-sources.js";
import { snapshotBytes, parseNonceDocument, importIdFor } from "./import-sources.js";
import {
  loadImport,
  planImport,
  recordImport,
  reconcileImport,
  finishImport,
  publishGuardedImportDocument,
  assertImportBudget,
} from "./import-journal.js";
import { sameImportValue, sameImportAttempt, publicationTicketSchema } from "./namespace.js";
export function createLegacyImportCoordinator(input: {
  backend: PersistenceBackend;
  sources: LegacySourceResolver;
  barrier: LegacyWriterBarrier;
  descriptors: readonly LegacyImportDescriptor[];
  currentScope: (scope: CoreWindowScope) => boolean;
  currentSource: (sourceKey: string) => boolean;
  importOwner: (sourceKey: string) => PersistenceOwner;
}): LegacyImportHostPort {
  if (input.sources !== input.backend.sources) throw new Error("backend-mismatch");
  const { backend, sources, barrier } = input,
    imports = backend.imports;
  const descriptors = new Map<string, LegacyImportDescriptor>();
  for (const source of input.descriptors) {
    if (
      !/^[a-z][a-z0-9-]*(?:[.:][a-z0-9-]+)+$/.test(source.id) ||
      Buffer.byteLength(source.id) > 128 ||
      descriptors.has(source.id) ||
      !source.targetSourceKey ||
      Buffer.byteLength(source.targetSourceKey) > 160 ||
      source.targetSourceKey.includes("\0") ||
      !["sensor-lab", "device-settings", "renderer-preferences"].includes(source.sourceKind) ||
      new Set(source.sourceFormatVersions).size !== source.sourceFormatVersions.length ||
      new Set(source.targetRecordSchemaVersions).size !==
        source.targetRecordSchemaVersions.length ||
      !Number.isInteger(source.mappingVersion) ||
      source.mappingVersion < 1 ||
      source.mappingVersion > 2147483647 ||
      (source.targetSettingsSchemaVersion !== undefined &&
        (!Number.isInteger(source.targetSettingsSchemaVersion) ||
          source.targetSettingsSchemaVersion < 1 ||
          source.targetSettingsSchemaVersion > 2147483647)) ||
      !source.sourceFormatVersions.length ||
      [...source.sourceFormatVersions, ...source.targetRecordSchemaVersions].some(
        (v) => !Number.isInteger(v) || v < 1 || v > 2147483647,
      )
    )
      throw new Error("invalid-descriptor");
    const copy = {
      ...source,
      sourceFormatVersions: [...source.sourceFormatVersions],
      targetRecordSchemaVersions: [...source.targetRecordSchemaVersions],
      ...(source.rendererKeyAllowlist
        ? { rendererKeyAllowlist: [...source.rendererKeyAllowlist] }
        : {}),
    };
    if (copy.sourceKind === "renderer-preferences") {
      const keys = copy.rendererKeyAllowlist;
      if (
        !keys ||
        keys.length > 128 ||
        new Set(keys).size !== keys.length ||
        keys.some((k) => !k || Buffer.byteLength(k) > 128) ||
        !copy.sourceFormatVersions.includes(1)
      )
        throw new Error("invalid-descriptor");
    }
    descriptors.set(copy.id, copy);
  }
  const queues = new Map<string, Promise<unknown>>(),
    retired = new Set<string>();
  const nonces = new Map<Handle, LegacyNonceDocument>(),
    challenges = new Map<string, Handle>();
  const pending = new Map<
    Handle,
    { document: LegacyNonceDocument; promise: ReturnType<typeof publishGuardedImportDocument> }
  >();
  const retainedPins = new Map<string, { mapped: Handle; ticket: PublicationTicket }>();
  const scopeKey = (scope: CoreWindowScope) =>
    JSON.stringify([scope.hostEpoch, scope.workbenchInstance]);
  function serial<T>(id: string, body: () => Promise<T>): Promise<T> {
    const result = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(body);
    queues.set(id, result);
    void result
      .finally(() => {
        if (queues.get(id) === result) queues.delete(id);
      })
      .catch(() => {});
    return result;
  }
  function metadataTicket(d: LegacyImportDescriptor, nonce: Handle): PublicationTicket {
    const key = "nonce/" + nonce;
    return {
      id: randomUUID(),
      owner: structuredClone(input.importOwner(d.targetSourceKey)),
      deadlineMonotonicMs: performance.now() + 10000,
      metadata: { kind: "import", key },
      target: { kind: "import", key },
    };
  }
  function live(d: LegacyImportDescriptor, scope?: CoreWindowScope): void {
    if (
      !input.currentSource(d.targetSourceKey) ||
      (scope && (!input.currentScope(scope) || retired.has(scopeKey(scope))))
    )
      throw new Error("stale");
  }
  async function save(
    document: LegacyNonceDocument,
    admit: () => void = () => {},
  ): Promise<boolean> {
    let operation = pending.get(document.nonce);
    if (operation && !sameImportValue(operation.document, document))
      throw new Error("import-pending");
    if (!operation && sameImportValue(nonces.get(document.nonce), document)) return true;
    if (!operation) {
      const copy = parseNonceDocument(Buffer.from(JSON.stringify(document)));
      operation = {
        document: copy,
        promise: Promise.resolve().then(() => publishGuardedImportDocument(backend, copy, admit)),
      };
      pending.set(document.nonce, operation);
    }
    let result: Awaited<ReturnType<typeof publishGuardedImportDocument>>;
    try {
      result = await operation.promise;
    } catch (error) {
      pending.delete(document.nonce);
      throw error;
    }
    if (result.disposition === "unknown")
      result = await imports.reconcile(operation.document.ticket);
    if (result.disposition === "unknown") return false;
    pending.delete(document.nonce);
    if (result.disposition !== "committed") throw new Error("not-committed");
    nonces.set(document.nonce, operation.document);
    return true;
  }
  async function consume(
    d: LegacyImportDescriptor,
    document: LegacyNonceDocument,
  ): Promise<LegacyNonceDocument | null> {
    const unresolved = pending.get(document.nonce);
    if (unresolved && !(await save(unresolved.document))) return null;
    const current = nonces.get(document.nonce) ?? document;
    if (current.state === "consumed") return current;
    if (!current.raw || !current.digest) throw new Error("missing-evidence");
    const next: LegacyNonceDocument = {
      ...current,
      state: "consumed",
      ticket: metadataTicket(d, current.nonce),
    };
    return (await save(next)) ? next : null;
  }
  function captured(
    d: LegacyImportDescriptor,
    ref: LegacyPreferencesEvidenceRef | null,
  ): LegacyNonceDocument | null {
    const available = new Map(nonces);
    for (const [nonce, operation] of pending) available.set(nonce, operation.document);
    const candidates = [...available.values()].filter(
      (n) => n.descriptorId === d.id && n.sourceKey === d.targetSourceKey && n.raw !== null,
    );
    if (ref) {
      const selected = candidates.find((n) => n.nonce === ref.nonce && n.digest === ref.digest);
      if (!selected) throw new Error("missing-evidence");
      return selected;
    }
    if (candidates.length > 1) throw new Error("ambiguous-evidence");
    return candidates[0] ?? null;
  }
  // Invoke restore synchronously: all registered legacy writer admission closes now.
  const restoredBarrier = barrier.restore();
  const restored = restoredBarrier.then(async () => {
    let count = 0,
      totalBytes = 0;
    for (const d of descriptors.values()) {
      const owner = input.importOwner(d.targetSourceKey);
      let cursor: Handle | undefined;
      do {
        const page = await backend.evidence.auxiliaryKeys(owner, "import", cursor);
        if (page.keys.length > 64 || Buffer.byteLength(JSON.stringify(page)) > 262144)
          throw new Error("size-limit");
        for (const key of page.keys) {
          if (!key.startsWith("nonce/")) continue;
          const bytes = await backend.evidence.auxiliary(owner, "import", key);
          if (!bytes) throw new Error("missing-evidence");
          if (++count > 512 || (totalBytes += bytes.length) > 2097152)
            throw new Error("size-limit");
          const document = parseNonceDocument(bytes);
          if (document.sourceKey !== d.targetSourceKey || key !== "nonce/" + document.nonce)
            throw new Error("evidence-binding");
          if (document.descriptorId !== d.id) continue;
          if (!sameImportValue(document.allowlist, d.rendererKeyAllowlist))
            throw new Error("evidence-binding");
          retired.add(scopeKey(document.scope));
          if ((await imports.reconcile(document.ticket)).disposition !== "committed")
            throw new Error("import-pending");
          nonces.set(document.nonce, document);
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      const saved = await loadImport(imports, owner, d);
      if (saved?.complete) continue;
      const selected = captured(d, saved?.plan.preferencesEvidence ?? null);
      if (selected && selected.state === "issued" && !(await consume(d, selected)))
        throw new Error("import-pending");
    }
  });
  // Keep a rejection observed while allowing each public operation to report restoration failure.
  void restored.catch(() => {});
  async function run(
    requested: LegacyImportDescriptor,
    signal: AbortSignal,
  ): ReturnType<LegacyImportHostPort["run"]> {
    const registered = descriptors.get(requested.id);
    if (!registered) throw new Error("invalid-descriptor");
    const descriptor: LegacyImportDescriptor = registered;
    return serial(descriptor.id, async () => {
      let saved: Awaited<ReturnType<typeof loadImport>> = null;
      const progress = (state: Awaited<ReturnType<LegacyImportHostPort["run"]>>["state"]) => ({
        state,
        completedItems:
          saved?.items.filter((e) => e.state === "committed" || e.state === "skipped").length ?? 0,
        totalItems: saved?.plan.items.length ?? 0,
      });
      let admittedOwner: PersistenceOwner | undefined;
      const check = () => {
        signal.throwIfAborted();
        live(descriptor);
        if (
          admittedOwner &&
          !sameImportValue(admittedOwner, input.importOwner(descriptor.targetSourceKey))
        )
          throw new Error("stale");
      };
      // This helper closes over the serialized run's descriptor and factory input.
      async function publishMapped(
        backend: PersistenceBackend,
        sources: LegacySourceResolver,
        item: ImportPlannedItem,
        mapped: LegacyMappedItem,
        ticket: PublicationTicket,
        signal: AbortSignal,
      ): Promise<Awaited<ReturnType<PersistenceEnginePort["publish"]>>> {
        const consequential = () => {
          signal.throwIfAborted();
          if (
            !input.currentSource(descriptor.targetSourceKey) ||
            !sameImportValue(ticket.owner, input.importOwner(descriptor.targetSourceKey))
          )
            throw new Error("stale");
        };
        if (
          !sameImportAttempt(item.ticket, ticket) ||
          mapped.sourceSha256 !== item.sourceSha256 ||
          mapped.mappedSha256 !== item.mappedSha256 ||
          mapped.byteLength !== item.byteLength
        )
          throw new Error("input-changed");
        consequential();
        await backend.engine.reserve(ticket, item.byteLength);
        consequential();
        await backend.imports.tagImport(ticket, item.tag);
        let offset = 0,
          done = item.byteLength === 0;
        while (!done) {
          consequential();
          const next = await sources.appendMapped({
            mapped: mapped.mapped,
            ticket,
            offset,
            maxBytes: 262144,
          });
          if (
            next.nextOffset <= offset ||
            next.nextOffset > item.byteLength ||
            next.nextOffset - offset > 262144 ||
            next.done !== (next.nextOffset === item.byteLength)
          )
            throw new Error("mapped-offset");
          offset = next.nextOffset;
          done = next.done;
        }
        consequential();
        await backend.engine.seal(ticket, item.byteLength, item.mappedSha256);
        consequential();
        const result = await backend.engine.publish(ticket);
        return result.disposition === "unknown" ? await backend.imports.reconcile(ticket) : result;
      }
      const recordMetadata = (
        mapped: Extract<LegacyMappedItem, { kind: "record" }>,
        original: PublicationTicket,
      ) => {
        if (original.metadata.kind !== "record") throw new Error("input-changed");
        const record = original.metadata.record;
        const metadata = {
          kind: record.kind,
          schemaVersion: record.schemaVersion,
          label: record.label,
          mediaType: record.mediaType,
          byteLength: record.byteLength,
          sha256: record.sha256,
        };
        if (!sameImportValue(metadata, mapped.metadata)) throw new Error("input-changed");
      };
      try {
        await restored;
        const owner = structuredClone(input.importOwner(descriptor.targetSourceKey));
        admittedOwner = owner;
        saved = await loadImport(imports, owner, descriptor);
        if (saved?.complete) {
          const handle = await barrier.enter(descriptor.targetSourceKey, descriptor.id);
          await barrier.complete(handle);
          return progress(saved.plan.items.length ? "complete" : "complete-empty");
        }
        if (!input.currentSource(descriptor.targetSourceKey)) return progress("pending");
        check();
        const handle = await barrier.enter(descriptor.targetSourceKey, descriptor.id);
        if (saved) saved = await reconcileImport(imports, owner, saved.plan);
        check();
        await sources.register({
          descriptorId: descriptor.id,
          mapperId: descriptor.id,
          sourceKind: descriptor.sourceKind,
        });
        let preferencesEvidence: LegacyPreferencesEvidenceRef | null = null;
        if (descriptor.sourceKind === "renderer-preferences") {
          const selected = captured(descriptor, saved?.plan.preferencesEvidence ?? null);
          if (!selected) return progress("pending");
          const consumed = await consume(descriptor, selected);
          if (!consumed || !consumed.digest) return progress("blocked");
          preferencesEvidence = { nonce: consumed.nonce, digest: consumed.digest };
          check();
          await backend.sources.resolvePreferences({
            descriptorId: descriptor.id,
            owner,
            evidence: preferencesEvidence,
          });
        }
        check();
        const inventory = await sources.inventory(descriptor.id);
        if (inventory.state === "blocked") return progress("blocked");
        if (
          descriptor.sourceKind === "renderer-preferences" &&
          (inventory.state !== "present" || inventory.entries.length !== 1)
        )
          return progress("pending");
        if (
          (inventory.state === "absent" && inventory.entries.length !== 0) ||
          inventory.entries.some(
            (e) =>
              typeof e.key !== "string" ||
              !e.key ||
              Buffer.byteLength(e.key) > 128 ||
              e.key.includes("\0") ||
              !/^[0-9a-f]{64}$/.test(e.sha256) ||
              !Number.isSafeInteger(e.byteLength) ||
              e.byteLength < 0 ||
              e.byteLength > (descriptor.sourceKind === "sensor-lab" ? 8388608 : 65536),
          ) ||
          inventory.entries.length > 512 ||
          new Set(inventory.entries.map((e) => e.key)).size !== inventory.entries.length ||
          inventory.entries.some((e) => !descriptor.sourceFormatVersions.includes(e.format))
        )
          throw new Error("input-changed");
        if (saved) {
          const planned = saved.plan.items;
          if (
            planned.length !== inventory.entries.length ||
            planned.some(
              (item) =>
                !inventory.entries.some(
                  (e) =>
                    e.key === item.key &&
                    e.format === item.sourceFormat &&
                    e.sha256 === item.sourceSha256,
                ),
            )
          )
            throw new Error("input-changed");
        } else {
          const id = importIdFor(descriptor.id, descriptor.targetSourceKey),
            items: ImportPlannedItem[] = [];
          for (let start = 0; start < inventory.entries.length; start += 64)
            for (const source of inventory.entries.slice(start, start + 64)) {
              check();
              const mapped = await sources.map(descriptor.id, source.key);
              try {
                check();
                if (mapped.sourceSha256 !== source.sha256) throw new Error("input-changed");
                let target: PublicationTicket["target"], metadata: PublicationTicket["metadata"];
                if (mapped.kind === "record") {
                  if (
                    !descriptor.targetRecordSchemaVersions.includes(
                      mapped.metadata.schemaVersion,
                    ) ||
                    mapped.metadata.byteLength !== mapped.byteLength ||
                    mapped.metadata.sha256 !== mapped.mappedSha256
                  )
                    throw new Error("schema-mismatch");
                  const recordId = randomUUID(),
                    now = Date.now();
                  target = { kind: "record", id: recordId, expectedRevision: null };
                  metadata = {
                    kind: "record",
                    deleted: false,
                    record: {
                      ...mapped.metadata,
                      id: recordId,
                      revision: "r_" + randomUUID().replaceAll("-", ""),
                      createdAt: now,
                      updatedAt: now,
                      checkpoint: "none",
                      interrupted: false,
                    },
                  };
                } else {
                  const digest = await backend.evidence.settingsDigest(owner);
                  if (
                    !digest ||
                    digest.schemaVersion !== descriptor.targetSettingsSchemaVersion ||
                    digest.schemaVersion !== mapped.schemaVersion
                  )
                    throw new Error("schema-mismatch");
                  target = { kind: "settings", expectedRevision: digest.revision };
                  metadata = {
                    kind: "settings",
                    schemaVersion: digest.schemaVersion,
                    validationDigest: digest.validationDigest,
                  };
                }
                const ticket: PublicationTicket = {
                  id: randomUUID(),
                  owner: structuredClone(owner),
                  target,
                  metadata,
                  deadlineMonotonicMs: performance.now() + 10000,
                };
                publicationTicketSchema.parse(ticket);
                items.push({
                  key: source.key,
                  sourceFormat: source.format,
                  sourceSha256: source.sha256,
                  mappedSha256: mapped.mappedSha256,
                  byteLength: mapped.byteLength,
                  ticket,
                  tag: { importId: id, itemKey: source.key, sourceSha256: source.sha256 },
                });
              } finally {
                await sources.releaseMapped(mapped.mapped);
              }
            }
          const plan: ImportPlan = {
            formatVersion: 1,
            id,
            descriptorId: descriptor.id,
            mappingVersion: descriptor.mappingVersion,
            targetSourceKey: descriptor.targetSourceKey,
            preferencesEvidence,
            items,
          };
          // Include immutable plan and initial evidence in the shared auxiliary budget.
          const document = {
            formatVersion: 1,
            plan,
            items: items.map((item) => ({
              key: item.key,
              state: "pending",
              receipt: null,
              skipReason: null,
              publicationTicket: null,
            })),
            complete: false,
          };
          check();
          await assertImportBudget(backend, owner, plan.id, Buffer.from(JSON.stringify(document)));
          check();
          await planImport(imports, owner, descriptor, plan);
          saved = await loadImport(imports, owner, descriptor);
        }
        if (!saved) throw new Error("missing-import-plan");
        for (const item of saved.plan.items) {
          saved = await loadImport(imports, owner, descriptor);
          if (!saved) throw new Error("missing-import-plan");
          const prior = saved.items.find((e) => e.key === item.key)!;
          const pin = retainedPins.get(saved.plan.id + "/" + item.key);
          if (pin) {
            const settled = await imports.reconcile(pin.ticket);
            if (settled.disposition === "unknown") return progress("blocked");
            await sources.releaseMapped(pin.mapped);
            retainedPins.delete(saved.plan.id + "/" + item.key);
          }
          if (prior.state === "committed" || prior.state === "skipped") continue;
          check();
          const mapped = await sources.map(descriptor.id, item.key);
          let attempt: PublicationTicket | undefined;
          let release = true;
          try {
            check();
            if (
              mapped.sourceSha256 !== item.sourceSha256 ||
              mapped.mappedSha256 !== item.mappedSha256 ||
              mapped.byteLength !== item.byteLength
            )
              throw new Error("input-changed");
            if (mapped.kind === "record") recordMetadata(mapped, item.ticket);
            else {
              const digest = await backend.evidence.settingsDigest(owner);
              if (
                item.ticket.metadata.kind !== "settings" ||
                !digest ||
                digest.validationDigest !== item.ticket.metadata.validationDigest ||
                mapped.schemaVersion !== item.ticket.metadata.schemaVersion ||
                digest.schemaVersion !== mapped.schemaVersion
              )
                throw new Error("schema-mismatch");
            }
            check();
            attempt = await imports.admit(owner, saved.plan.id, item.key);
            check();
            const result = await publishMapped(backend, sources, item, mapped, attempt, signal);
            if (result.disposition === "unknown") {
              release = false;
              retainedPins.set(saved.plan.id + "/" + item.key, {
                mapped: mapped.mapped,
                ticket: attempt,
              });
              return progress("blocked");
            }
            if (result.disposition === "not-committed") {
              const aborted = await backend.engine.abort(attempt);
              if (
                aborted === "unknown" &&
                (await imports.reconcile(attempt)).disposition === "unknown"
              ) {
                release = false;
                retainedPins.set(saved.plan.id + "/" + item.key, {
                  mapped: mapped.mapped,
                  ticket: attempt,
                });
              }
              return progress("blocked");
            }
            if (!result.receipt) throw new Error("unverified-receipt");
            await recordImport(imports, owner, saved.plan.id, {
              key: item.key,
              state: "committed",
              receipt: result.receipt,
              skipReason: null,
              publicationTicket: attempt,
            });
            check();
          } catch (error) {
            if (attempt) {
              release = false;
              retainedPins.set(saved.plan.id + "/" + item.key, {
                mapped: mapped.mapped,
                ticket: attempt,
              });
              // An unreserved admitted attempt may have no engine entry. Durable reconciliation
              // still proves its outcome; a failed abort alone grants no cleanup authority.
              try {
                await backend.engine.abort(attempt);
              } catch {
                /* reconcile below */
              }
              const result = await imports.reconcile(attempt);
              if (result.disposition !== "unknown") {
                release = true;
                retainedPins.delete(saved.plan.id + "/" + item.key);
              }
            }
            throw error;
          } finally {
            if (release) await sources.releaseMapped(mapped.mapped);
          }
        }
        saved = await loadImport(imports, owner, descriptor);
        if (!saved) throw new Error("missing-import-plan");
        check();
        if (
          saved.items.every((e) => e.state === "committed" || e.state === "skipped") &&
          (await finishImport(imports, owner, saved.plan))
        ) {
          check();
          await barrier.complete(handle);
          check();
          return progress(saved.plan.items.length ? "complete" : "complete-empty");
        }
        return progress("blocked");
      } catch {
        // Report only evidence that is actually durable, including a receipt written
        // just before cancellation or a failed barrier-completion publication.
        try {
          saved = await loadImport(
            imports,
            input.importOwner(descriptor.targetSourceKey),
            descriptor,
          );
        } catch {
          /* retain last verified progress */
        }
        return progress("blocked");
      }
    });
  }
  async function issuePreferences(
    request: Parameters<LegacyImportHostPort["issuePreferences"]>[0],
  ): ReturnType<LegacyImportHostPort["issuePreferences"]> {
    const descriptor = descriptors.get(request.descriptorId),
      scope = structuredClone(request.scope);
    if (!descriptor || descriptor.sourceKind !== "renderer-preferences")
      throw new Error("invalid-descriptor");
    return serial(descriptor.id, async () => {
      await restored;
      live(descriptor, scope);
      const saved = await loadImport(
        imports,
        input.importOwner(descriptor.targetSourceKey),
        descriptor,
      );
      if (saved?.complete) throw new Error("stale");
      if (saved || captured(descriptor, null)) throw new Error("import-pending");
      await barrier.enter(descriptor.targetSourceKey, descriptor.id);
      live(descriptor, scope);
      const key = JSON.stringify([descriptor.id, scopeKey(scope)]),
        existing = challenges.get(key);
      let document = existing
        ? (pending.get(existing)?.document ?? nonces.get(existing))
        : undefined;
      if (!document) {
        // A later workbench may replace an uncaptured challenge, but never revive it.
        const issued = new Map(nonces);
        for (const [nonce, operation] of pending) issued.set(nonce, operation.document);
        for (const prior of issued.values())
          if (prior.descriptorId === descriptor.id && !sameImportValue(prior.scope, scope))
            retired.add(scopeKey(prior.scope));
        const nonce = randomUUID(),
          ticket = metadataTicket(descriptor, nonce);
        document = {
          formatVersion: 1,
          kind: "nonce",
          descriptorId: descriptor.id,
          sourceKey: descriptor.targetSourceKey,
          nonce,
          scope,
          allowlist: [...descriptor.rendererKeyAllowlist!],
          state: "issued",
          raw: null,
          digest: null,
          originalTicket: ticket,
          ticket,
        };
        challenges.set(key, nonce);
      }
      if (!(await save(document))) throw new Error("import-pending");
      live(descriptor, scope);
      return structuredClone({
        nonce: document.nonce,
        scope: document.scope,
        descriptorId: descriptor.id,
        keys: document.allowlist,
      });
    });
  }
  async function acceptPreferencesEvidence(
    snapshot: LegacyPreferencesSnapshot,
  ): ReturnType<LegacyImportHostPort["acceptPreferencesEvidence"]> {
    // Copy and validate before joining any promise; keys are checked again against the issued allowlist.
    const copy = structuredClone(snapshot);
    snapshotBytes(copy, Array.isArray(copy?.entries) ? copy.entries.map((e) => e?.key) : []);
    await restored;
    const issued = pending.get(copy.nonce)?.document ?? nonces.get(copy.nonce);
    if (!issued) return Promise.reject(new Error("stale"));
    const descriptor = descriptors.get(issued.descriptorId);
    if (!descriptor) return Promise.reject(new Error("stale"));
    return serial(descriptor.id, async () => {
      await restored;
      live(descriptor, copy.scope);
      if (!sameImportValue(copy.scope, issued.scope)) throw new Error("stale");
      const bytes = snapshotBytes(copy, issued.allowlist),
        digest = createHash("sha256").update(bytes).digest("hex");
      let document = pending.get(copy.nonce)?.document ?? nonces.get(copy.nonce);
      if (!document) throw new Error("stale");
      const replay = document.raw !== null;
      if (
        document.raw &&
        (document.digest !== digest ||
          !Buffer.from(snapshotBytes(document.raw, document.allowlist)).equals(bytes))
      )
        throw new Error("changed-replay");
      const unresolved = pending.get(copy.nonce);
      if (unresolved && !(await save(unresolved.document))) return { state: "pending" };
      document = nonces.get(copy.nonce)!;
      if (document.state === "consumed") return { state: "reconciled" };
      live(descriptor, copy.scope);
      if (!document.raw) {
        document = {
          ...document,
          raw: JSON.parse(new TextDecoder().decode(bytes)),
          digest,
          ticket: metadataTicket(descriptor, copy.nonce),
        };
        const owner = structuredClone(document.ticket.owner);
        const admit = () => {
          live(descriptor, copy.scope);
          if (!sameImportValue(owner, input.importOwner(descriptor.targetSourceKey)))
            throw new Error("stale");
        };
        if (!(await save(document, admit))) return { state: "pending" };
      }
      // If the window retired during raw persistence, preserve its durable capture for host recovery.
      live(descriptor, copy.scope);
      const consumed = await consume(descriptor, document);
      live(descriptor, copy.scope);
      if (!consumed) return { state: "pending" };
      return { state: replay ? "reconciled" : "accepted" };
    });
  }
  return {
    run,
    issuePreferences,
    acceptPreferencesEvidence,
    retirePreferences(scope) {
      retired.add(scopeKey(scope));
    },
    async acceptPreferences(snapshot) {
      const result = await acceptPreferencesEvidence(snapshot);
      if (result.state === "pending") throw new Error("import-pending");
    },
  };
}
