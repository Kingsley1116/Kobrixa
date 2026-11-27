import type { CheckpointRegistration } from "./engine-port.js";
import { z } from "zod";
import { recordMetaSchema } from "../../../../../../packages/plugin-protocol/src/storage.js";
import { persistenceOwnerSchema } from "./namespace.js";
import type { FinalWriteGrant, SealedPayloadPin } from "./engine-port.js";
const uuid = z.string().uuid();
export const checkpointDocumentSchema = z.strictObject({
  formatVersion: z.literal(1),
  checkpoint: uuid,
  record: recordMetaSchema,
  binding: z
    .strictObject({
      owner: persistenceOwnerSchema,
      reservationId: uuid,
      sessionId: uuid,
      providerGeneration: z.number().int().nonnegative(),
    })
    .nullable(),
  state: z.enum(["open", "final", "interrupted"]),
});
import { createHash, randomUUID, type Hash } from "node:crypto";
import type {
  Handle,
  RecordId,
  RecordRevision,
  RecordMeta,
  SettingsSnapshot,
} from "@kobrixa/plugin-protocol";
import type { PersistenceOwner } from "@kobrixa/plugin-runtime";
import {
  PublicationGate,
  ownerKey,
  checkpointRecoveryId,
  type PublicationTicket,
  type PersistenceEnginePort,
  type PersistenceReadPort,
  type ImportTag,
} from "./engine-port.js";
import {
  type NodePersistenceFs,
  writeAll,
  type StoreFd,
  type StorePath,
  type SourceIdentity,
} from "./filesystem.js";
import {
  Namespace,
  assertDiskFormat,
  parseHead,
  liveRecord,
  importTagSchema,
  type DiskHead,
  type Location,
} from "./namespace.js";
import { QuotaLedger } from "./quota.js";
import {
  scanNamespace,
  garbageCandidates,
  resolvedImport,
  exactDocument,
  canonicalHead,
  isFirstImportPlan,
  legacyImportReserve,
  retirePendingImportCandidate,
} from "./recovery-scan.js";
import type {
  DurableImportPort,
  ImportPlan,
  ImportItemEvidence,
  PersistenceEvidencePort,
  StoredRecovery,
  PersistenceBarrier,
  PersistenceBarrierEvidence,
} from "./engine-port.js";
import {
  importDocumentSchema,
  importPlanSchema,
  importItemEvidenceSchema,
  storedRecoverySchema,
  publicationTicketSchema,
  sameImportAttempt,
  sameImportValue,
} from "./namespace.js";
import { parseNonceDocument, parseBarrierDocument } from "./import-sources.js";
// Stage envelopes have fixed field order, including the nested ticket, head and tag.
const privateIntentSchema = z.strictObject({
  formatVersion: z.literal(1),
  ticket: publicationTicketSchema,
  byteLength: z.number().int().nonnegative().max(8388608),
  predecessor: z
    .unknown()
    .transform((value) => (value === null ? null : parseHead(Buffer.from(JSON.stringify(value))))),
});
const sealDocumentSchema = z.strictObject({
  formatVersion: z.literal(1),
  byteLength: z.number().int().nonnegative().max(8388608),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const importTagDocumentSchema = z.strictObject({
  formatVersion: z.literal(1),
  tag: importTagSchema,
});
type Outcome = Awaited<ReturnType<PersistenceEnginePort["publish"]>>;
type Settlement =
  { disposition: "aborted" } | { disposition: "committed"; receipt: DiskHead["receipt"] };
type Entry = {
  ticket: PublicationTicket;
  ns: Namespace;
  location: Location;
  old: DiskHead | null;
  size: number;
  fd: StoreFd | null;
  temp: StorePath;
  object: StorePath | null;
  gate: PublicationGate;
  hash: Hash;
  received: number;
  last: { offset: number; bytes: Uint8Array } | null;
  created: number;
  progress: number;
  state: "receiving" | "sealed" | "publishing" | "committed" | "unknown" | "aborted";
  busy: boolean;
  head: DiskHead | null;
  accounted: boolean;
  finished: number | null;
  oldHeld: boolean;
  cleaned: boolean;
  tag?: ImportTag;
  original?: SourceIdentity;
  verifiedItem?: {
    item: ImportPlan["items"][number];
    head: StorePath;
    object: StorePath;
    revision: string;
    digest: string;
  };
  retained?: SealedPayloadPin;
  recoveryGate?: PublicationGate;
  abortRequested?: boolean;
  installedCandidate?: true;
};
function verifyImportIntent(
  bytes: Uint8Array,
  ticket: PublicationTicket,
  raw: { byteLength: number; predecessor: unknown },
) {
  if (
    !Number.isSafeInteger(raw.byteLength) ||
    raw.byteLength < 0 ||
    raw.byteLength > 2097152 ||
    !exactDocument(bytes, {
      formatVersion: 1,
      ticket: publicationTicketSchema.parse(ticket),
      byteLength: raw.byteLength,
      predecessor:
        raw.predecessor === null
          ? null
          : canonicalHead(Buffer.from(JSON.stringify(raw.predecessor))),
    })
  )
    throw new Error("corrupt");
}
function isFirstRecordImport(e: Entry): e is Entry & { tag: ImportTag } {
  return !!e.tag && e.ticket.target.kind === "record" && e.ticket.target.expectedRevision === null;
}
type Pin = {
  owner: string;
  source: string;
  ns: Namespace;
  path: StorePath;
  fd: StoreFd;
  length: number;
  created: number;
  used: number;
  busy: Promise<unknown>;
  ticket?: string;
  expires?: number;
  closing?: Promise<void>;
  closeFailed?: true;
};
type Page = {
  owner: string;
  source: string;
  kind: string | undefined;
  limit: number;
  entries: RecordMeta[];
  created: number;
  used: number;
  bytes: number;
  tokens: Map<number, string>;
};
export class AtomicStore implements PersistenceEnginePort, PersistenceReadPort {
  readonly quota = new QuotaLedger();
  private readonly namespaces = new Map<string, Promise<Namespace>>();
  private readonly blockedSources = new Map<string, Error>();
  // Verified committed sizes and outstanding candidates share one synchronous admission
  // boundary. Namespace recovery owns disk reconciliation before this ledger is exposed.
  private readonly importCommitted = new WeakMap<Namespace, Map<string, number>>();
  private readonly importReservations = new Map<
    string,
    { ns: Namespace; key: string; bytes: number }
  >();
  private readonly failedReserves = new Map<
    string,
    { ticket: PublicationTicket; ns: Namespace; interruptedInstall?: true }
  >();
  private readonly tombstones = new Map<
    string,
    { ticket: PublicationTicket; settlement: Settlement; until: number }
  >();
  private readonly entries = new Map<string, Entry>();
  private readonly targets = new Map<string, string>();
  private readonly finalAdmissions = new Map<string, FinalWriteGrant>();
  private readonly finalConsumed = new Set<string>();
  private readonly recoveryDocuments = new Set<string>();
  private readonly frozen = new Map<string, number>();
  private readonly frozenTargets = new Map<string, number>();
  private readonly uncertain = new Map<string, string>();
  private readonly publication = new Map<string, Promise<unknown>>();
  private readonly pins = new Map<string, Pin>();
  private readonly failedDescriptorCloses = new Set<StoreFd>();
  private readonly quarantinedSources = new Map<string, Handle>();
  private readonly closed = new Map<string, { owner: string; until: number }>();
  private readonly pages = new Set<Page>();
  private readonly cursors = new Map<string, { page: Page; offset: number }>();
  private readonly gcHeld = new Map<string, { source: string; key: string }>();
  constructor(readonly fs: NodePersistenceFs) {}
  async initialize(): Promise<void> {
    this.fs.profile.assertHeld();
    for (const dir of await this.fs.entries(this.fs.path("namespaces"), 4096)) {
      if (!dir.directory || !/^[0-9a-f]{64}$/.test(dir.name)) throw new Error("corrupt");
      const identity = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await this.fs.bytes(this.fs.path("namespaces", dir.name, "identity.json"), 4096),
        ),
      ) as { sourceKey?: unknown; formatVersion?: unknown };
      assertDiskFormat(identity);
      if (typeof identity.sourceKey !== "string") throw new Error("identity-mismatch");
      const ns = await this.ns(identity.sourceKey);
      if (ns.hash !== dir.name) throw new Error("identity-mismatch");
    }
    if (this.blockedSources.size)
      throw new Error("recovery-blocked", { cause: this.blockedSources.values().next().value });
  }
  private ns(source: string): Promise<Namespace> {
    let pending = this.namespaces.get(source);
    if (!pending) {
      pending = Namespace.open(this.fs, source, (fd) => {
        this.failedDescriptorCloses.add(fd);
        this.quarantineClose(source, randomUUID());
      }).then(async (ns) => {
        try {
          const scanned = await scanNamespace(ns, this.fs.profile.hostEpoch);
          this.quota.restore(source, scanned.totals);
          const imports = new Map<string, number>();
          let bytes = 0;
          for (const head of scanned.heads)
            if (head.target.kind === "import") {
              bytes += head.byteLength;
              if (imports.size >= 512 || bytes > 2097152) throw new Error("size-limit");
              imports.set(head.target.key, head.byteLength);
            }
          this.importCommitted.set(ns, imports);
          if (scanned.problems.length)
            this.blockedSources.set(source, new Error(scanned.problems[0]!));
        } catch (e) {
          this.blockedSources.set(source, e instanceof Error ? e : new Error("corrupt"));
        }
        return ns;
      });
      this.namespaces.set(source, pending);
    }
    return pending;
  }
  private reserveImportBudget(ns: Namespace, ticket: PublicationTicket, bytes: number): void {
    if (ticket.target.kind !== "import") return;
    const committed = this.importCommitted.get(ns);
    if (!committed) throw new Error("recovery-blocked");
    // Match the existing 64-per-source / 1024-host admission bounds even while
    // reserve is awaiting IO and has not installed its engine Entry yet.
    let own = 0;
    const projected = new Map(committed);
    for (const held of this.importReservations.values())
      if (held.ns === ns) {
        own++;
        projected.set(held.key, Math.max(projected.get(held.key) ?? 0, held.bytes));
      }
    if (this.importReservations.has(ticket.id) || this.importReservations.size >= 1024 || own >= 64)
      throw new Error("quota");
    // A pending shrink grants no space until commit. One key counts once; neither
    // an uncertain candidate nor its old head may be evicted to admit another key.
    projected.set(ticket.target.key, Math.max(projected.get(ticket.target.key) ?? 0, bytes));
    if (projected.size > 512 || [...projected.values()].reduce((sum, n) => sum + n, 0) > 2097152)
      throw new Error("size-limit");
    this.importReservations.set(ticket.id, { ns, key: ticket.target.key, bytes });
  }
  private targetKey(t: PublicationTicket): string {
    return JSON.stringify([
      t.owner.sourceKey,
      t.target.kind,
      t.target.kind === "record"
        ? t.target.id
        : t.target.kind === "settings"
          ? "settings"
          : t.target.key,
    ]);
  }
  private releaseTarget(t: PublicationTicket): void {
    const key = this.targetKey(t);
    if (this.targets.get(key) === t.id) this.targets.delete(key);
  }
  private readonly terminalDeletes = new Map<string, PublicationTicket>();
  private async admitTerminalDelete(t: PublicationTicket, byteLength: number): Promise<void> {
    if (
      this.finalAdmissions.has(t.id) ||
      t.target.kind !== "record" ||
      !this.frozenTargets.has(JSON.stringify([ownerKey(t.owner), t.target.id]))
    )
      return;
    if (
      this.frozen.has(ownerKey(t.owner)) ||
      byteLength !== 0 ||
      t.metadata.kind !== "record" ||
      !t.metadata.deleted ||
      t.target.expectedRevision === null ||
      t.metadata.record.checkpoint !== "final"
    )
      throw new Error("stale");
    const record = await this.stat(t.owner, t.target.id);
    if (record.revision !== t.target.expectedRevision) throw new Error("revision-mismatch");
    if (record.checkpoint !== "final") throw new Error("stale");
    if (
      [...this.entries.values()].some(
        (e) =>
          e.ticket.target.kind === "record" &&
          e.ticket.owner.sourceKey === t.owner.sourceKey &&
          e.ticket.target.id === record.id &&
          e.state !== "committed" &&
          e.state !== "aborted",
      )
    )
      throw new Error("write-in-progress");
    // A final head alone is insufficient while its checkpoint/drain is still open.
    let cursor: string | undefined,
      terminal = false;
    do {
      const page = await this.auxiliaryKeys(t.owner, "recovery", cursor);
      for (const key of page.keys) {
        const bytes = await this.auxiliary(t.owner, "recovery", key);
        if (!bytes) continue;
        const parsed = checkpointDocumentSchema.safeParse(
          JSON.parse(Buffer.from(bytes).toString("utf8")),
        );
        if (!parsed.success || parsed.data.record.id !== record.id) continue;
        if (parsed.data.state === "open") throw new Error("stale");
        if (parsed.data.state === "final" && parsed.data.record.revision === record.revision)
          terminal = true;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    if (!terminal) throw new Error("stale");
    this.terminalDeletes.set(t.id, structuredClone(t));
  }
  private quarantined(t: PublicationTicket): boolean {
    return !this.recoveryDocuments.has(t.id) && this.quarantinedSources.has(t.owner.sourceKey);
  }
  private admitted(t: PublicationTicket): void {
    this.fs.profile.assertHeld();
    if (
      t.owner.hostEpoch !== this.fs.profile.hostEpoch ||
      (!this.finalAdmissions.has(t.id) &&
        !this.recoveryDocuments.has(t.id) &&
        (this.frozen.has(ownerKey(t.owner)) ||
          (t.target.kind === "record" &&
            this.frozenTargets.has(JSON.stringify([ownerKey(t.owner), t.target.id])) &&
            !sameImportValue(this.terminalDeletes.get(t.id), t))))
    )
      throw new Error("stale");
    if (this.quarantined(t)) throw new Error("recovery-blocked");
    if (this.blockedSources.has(t.owner.sourceKey))
      throw this.blockedSources.get(t.owner.sourceKey);
    if (this.uncertain.has(t.owner.sourceKey)) throw new Error("publish-uncertain");
  }
  private entry(t: PublicationTicket): Entry {
    this.fs.profile.assertHeld();
    const e = this.entries.get(t.id);
    if (!e || !sameImportValue(e.ticket, t)) throw new Error("stale");
    if (
      e.finished !== null &&
      e.finished + 120000 <= this.fs.now() &&
      (e.cleaned || e.state === "aborted")
    ) {
      this.forgetEntry(t.id, e);
      throw new Error("stale");
    }
    return e;
  }
  private live(e: Entry, gate = e.gate): void {
    if (
      e.state === "aborted" ||
      this.fs.now() >= Math.min(e.created + 120000, e.progress + 30000, gate.deadline)
    )
      throw new Error("expired");
  }
  private cas(t: PublicationTicket, head: DiskHead | null): void {
    if (t.target.kind === "record" || t.target.kind === "settings") {
      if ((head?.receipt.revision ?? null) !== t.target.expectedRevision)
        throw new Error("revision-mismatch");
    }
  }
  private forgetEntry(id: string, e: Entry): void {
    if (e.state !== "committed" && e.state !== "aborted") return;
    // Retain a second bounded window for barriers captured before live-entry expiry.
    this.tombstones.set(id, {
      ticket: e.ticket,
      settlement:
        e.state === "committed"
          ? { disposition: e.state, receipt: e.head!.receipt }
          : { disposition: e.state },
      until: this.fs.now() + 120000,
    });
    while (this.tombstones.size > 1024)
      this.tombstones.delete(this.tombstones.keys().next().value!);
    this.entries.delete(id);
  }
  private async prune(): Promise<void> {
    const now = this.fs.now();
    for (const [id, t] of this.tombstones) if (t.until <= now) this.tombstones.delete(id);
    for (const failed of this.failedReserves.values())
      await this.abort(failed.ticket).catch(() => {});
    for (const [id, e] of this.entries)
      if (
        e.finished !== null &&
        e.finished + 120000 <= now &&
        !e.busy &&
        (e.cleaned || e.state === "aborted")
      )
        this.forgetEntry(id, e);
    for (const [id, pin] of this.pins)
      if (
        !pin.closeFailed &&
        now >= Math.min(pin.created + 120000, pin.used + 30000, pin.expires ?? Infinity)
      )
        await this.closePin(id, pin).catch((error) => {
          if (!pin.closeFailed) throw error;
        });
    for (const [id, c] of this.closed) if (c.until <= now) this.closed.delete(id);
    for (const page of this.pages)
      if (now >= Math.min(page.created + 120000, page.used + 30000)) {
        this.pages.delete(page);
        for (const token of page.tokens.values()) this.cursors.delete(token);
      }
    for (const e of this.entries.values())
      if (
        (e.state === "receiving" || e.state === "sealed") &&
        !e.busy &&
        !(e.retained && this.pins.get(e.retained.pin)?.closeFailed) &&
        now >=
          Math.min(e.created + 120000, e.progress + 30000, e.retained ? Infinity : e.gate.deadline)
      )
        await this.abort(e.ticket).catch((error) => {
          if (!(e.retained && this.pins.get(e.retained.pin)?.closeFailed)) throw error;
        });
  }
  private async checkImportAdmission(ticket: PublicationTicket): Promise<boolean> {
    if (ticket.target.kind !== "record" && ticket.target.kind !== "settings") return false;
    const ns = await this.ns(ticket.owner.sourceKey);
    let blocked = false,
      associated = false;
    for (const loc of await ns.locations()) {
      const head = await ns.head(loc);
      if (head?.target.kind !== "import") continue;
      if (!head.target.key.startsWith("import/") && !head.target.key.startsWith("barrier/"))
        continue;
      await ns.verify(loc, head);
      const bytes = await this.fs.bytes(ns.object(loc, head), 2097152);
      if (head.target.key.startsWith("barrier/")) {
        const barrier = parseBarrierDocument(bytes);
        if (barrier.sourceKey !== ns.sourceKey) throw new Error("evidence-binding");
        if (barrier.state === "active") blocked = true;
      } else {
        const saved = importDocumentSchema.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        );
        if (saved.plan.targetSourceKey !== ns.sourceKey || saved.plan.id !== head.target.key)
          throw new Error("evidence-binding");
        if (!saved.complete) {
          blocked = true;
          if (
            saved.items.some(
              (e) => e.state === "pending" && sameImportValue(e.publicationTicket, ticket),
            )
          )
            associated = true;
        }
      }
    }
    if (blocked && !associated) throw new Error("import-pending");
    return associated && ticket.target.kind === "record" && ticket.target.expectedRevision === null;
  }
  recordUnadmittedReserve(ticket: PublicationTicket): void {
    if (
      !this.entries.has(ticket.id) &&
      !this.failedReserves.has(ticket.id) &&
      !this.tombstones.has(ticket.id)
    ) {
      this.tombstones.set(ticket.id, {
        ticket: structuredClone(ticket),
        settlement: { disposition: "aborted" },
        until: this.fs.now() + 120000,
      });
      while (this.tombstones.size > 1024)
        this.tombstones.delete(this.tombstones.keys().next().value!);
    }
  }
  private async ownsCheckpoint(
    owner: PersistenceOwner,
    checkpoint: string,
    recordId: string,
  ): Promise<boolean> {
    if (
      [...this.entries.values()].some(
        (e) =>
          e.state === "committed" &&
          e.ticket.target.kind === "recovery" &&
          e.ticket.target.key === checkpoint &&
          ownerKey(e.ticket.owner) === ownerKey(owner),
      )
    )
      return true;
    const retained = await this.loadRecovery(checkpointRecoveryId(checkpoint));
    return (
      !!retained &&
      ownerKey(retained.owner) === ownerKey(owner) &&
      retained.report.records.some((r) => r.id === recordId)
    );
  }
  async reserveFinal(
    ticket: PublicationTicket,
    byteLength: number,
    grant: FinalWriteGrant,
    memory?: SharedArrayBuffer,
    byteOffset = 0,
  ): Promise<void> {
    const identity = JSON.stringify([ownerKey(ticket.owner), grant.checkpoint]);
    const deadline = Math.min(
      grant.deadlineMonotonicMs,
      this.frozen.get(ownerKey(ticket.owner)) ?? Infinity,
      this.frozenTargets.get(JSON.stringify([ownerKey(ticket.owner), grant.recordId])) ?? Infinity,
      grant.deviceDrain?.expiresMonotonicMs ?? Infinity,
    );
    if (
      ownerKey(grant.owner) !== ownerKey(ticket.owner) ||
      ticket.target.kind !== "record" ||
      ticket.target.id !== grant.recordId ||
      ticket.target.expectedRevision === null ||
      ticket.metadata.kind !== "record" ||
      ticket.metadata.deleted ||
      ticket.metadata.record.checkpoint !== "final" ||
      this.finalConsumed.has(identity) ||
      this.fs.now() >= deadline ||
      !uuid.safeParse(grant.token).success ||
      (!this.frozen.has(ownerKey(ticket.owner)) &&
        !this.frozenTargets.has(JSON.stringify([ownerKey(ticket.owner), grant.recordId])))
    )
      throw new Error("stale");
    const bytes = await this.auxiliary(ticket.owner, "recovery", grant.checkpoint);
    if (!bytes) throw new Error("stale");
    const document = checkpointDocumentSchema.parse(
      JSON.parse(Buffer.from(bytes).toString("utf8")),
    );
    const ns = await this.ns(ticket.owner.sourceKey),
      loc = await ns.location({ kind: "recovery", key: grant.checkpoint });
    // Registration identity is preserved by the original metadata publication intent/head.
    if (
      document.checkpoint !== grant.checkpoint ||
      document.record.id !== grant.recordId ||
      document.state !== "open" ||
      (document.binding &&
        (ownerKey(document.binding.owner) !== ownerKey(ticket.owner) ||
          !grant.deviceDrain ||
          ownerKey(grant.deviceDrain.owner) !== ownerKey(ticket.owner) ||
          grant.deviceDrain.reservationId !== document.binding.reservationId))
    )
      throw new Error("stale");
    if (
      !(await ns.head(loc)) ||
      !(await this.ownsCheckpoint(ticket.owner, grant.checkpoint, grant.recordId))
    )
      throw new Error("stale");
    if (this.finalConsumed.has(identity) || this.fs.now() >= deadline) throw new Error("stale");
    this.finalConsumed.add(identity);
    this.finalAdmissions.set(ticket.id, {
      ...structuredClone(grant),
      deadlineMonotonicMs: deadline,
    });
    try {
      await this.reserve(ticket, byteLength, memory, byteOffset);
      this.entry(ticket).gate.shorten(deadline, this.fs.now());
    } finally {
      this.finalAdmissions.delete(ticket.id);
    }
  }
  async retainSealed(ticket: PublicationTicket): Promise<SealedPayloadPin> {
    const e = this.entry(ticket),
      expiresMonotonicMs = Math.min(e.created + 120000, e.progress + 30000);
    if (
      e.state !== "sealed" ||
      e.abortRequested ||
      e.busy ||
      e.gate.dispatched ||
      e.received !== e.size ||
      this.fs.now() >= expiresMonotonicMs
    )
      throw new Error("incomplete");
    const retainedPin = e.retained && this.pins.get(e.retained.pin);
    if (e.retained && retainedPin) {
      if (retainedPin.closing) throw new Error("stale");
      return { ...e.retained };
    }
    if ([...this.pins.values()].filter((p) => p.source === ticket.owner.sourceKey).length >= 4)
      throw new Error("quota");
    e.busy = true;
    try {
      const path = e.object ?? e.temp,
        key = this.fs.name(path),
        pin = randomUUID();
      this.quota.holdTemporary(ticket.owner.sourceKey, key, e.size);
      const fd = await this.fs.open(path, "read").catch((error) => {
        this.quota.releaseTemporary(ticket.owner.sourceKey, key);
        throw error;
      });
      this.pins.set(pin, {
        owner: ownerKey(ticket.owner),
        source: ticket.owner.sourceKey,
        ns: e.ns,
        path,
        fd,
        length: e.size,
        created: e.created,
        used: e.progress,
        busy: Promise.resolve(),
        ticket: ticket.id,
        expires: expiresMonotonicMs,
      });
      e.retained = { pin, expiresMonotonicMs };
      return { ...e.retained };
    } finally {
      e.busy = false;
    }
  }
  retainedSealed(ticket: PublicationTicket): boolean {
    const e = this.entries.get(ticket.id);
    const pin = e?.retained && this.pins.get(e.retained.pin);
    return (
      !!e?.retained &&
      sameImportValue(e.ticket, ticket) &&
      !!pin &&
      !pin.closing &&
      this.fs.now() < e.retained.expiresMonotonicMs &&
      e.state === "sealed" &&
      !e.gate.dispatched &&
      !e.recoveryGate?.dispatched
    );
  }
  async publishRecovery(
    ticket: PublicationTicket,
    pin: string,
    deadline: number,
  ): Promise<Outcome> {
    const e = this.entry(ticket),
      p = this.pins.get(pin);
    if (
      !p ||
      p.ticket !== ticket.id ||
      p.owner !== ownerKey(ticket.owner) ||
      e.retained?.pin !== pin ||
      e.recoveryGate ||
      e.abortRequested ||
      !this.retainedSealed(ticket) ||
      e.busy
    )
      throw new Error("stale");
    const gate = new PublicationGate(
      Math.min(deadline, this.fs.now() + 10000, e.retained.expiresMonotonicMs),
    );
    e.recoveryGate = gate;
    const previous = this.publication.get(ticket.owner.sourceKey) ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(() => {
        if (!this.retainedSealed(ticket) || e.busy) throw new Error("stale");
        return this.publishOne(e, gate);
      })
      .finally(() => {
        if (!gate.dispatched) delete e.recoveryGate;
      });
    this.publication.set(ticket.owner.sourceKey, run);
    return run;
  }
  async reserve(
    ticket: PublicationTicket,
    byteLength: number,
    memory?: SharedArrayBuffer,
    byteOffset = 0,
  ): Promise<void> {
    try {
      if (isFirstImportPlan(ticket.target)) ticket = publicationTicketSchema.parse(ticket);
      if (
        ticket.target.kind === "import" &&
        isFirstImportPlan(ticket.target) &&
        (ticket.metadata.kind !== "import" || ticket.metadata.key !== ticket.target.key)
      )
        throw new Error("invalid-target");
      await this.admitTerminalDelete(ticket, byteLength);
      await this.reserveOne(ticket, byteLength, memory, byteOffset);
    } catch (error) {
      this.recordUnadmittedReserve(ticket);
      throw error;
    } finally {
      this.terminalDeletes.delete(ticket.id);
    }
  }
  // Only a temporary name is visible until the complete document is synced and closed.
  // The profile lease and ticket admission serialize installation in this directory.
  private async installImportDocument(
    ns: Namespace,
    ticket: PublicationTicket,
    name: "intent" | "sealed" | "publication" | "record-intent",
    value: unknown,
  ): Promise<void> {
    if (
      name === "record-intent"
        ? ticket.target.kind !== "record" || ticket.target.expectedRevision !== null
        : !isFirstImportPlan(ticket.target)
    )
      throw new Error("invalid-target");
    if (Buffer.byteLength(JSON.stringify(value)) > 8192) throw new Error("size-limit");
    const dir = ns.path("staging", ticket.id);
    const dest = ns.path(
      "staging",
      ticket.id,
      name === "record-intent" ? "intent.json" : name + ".json",
    );
    const temp = ns.path(
      "staging",
      ticket.id,
      name === "record-intent" ? "import-record-intent.tmp" : "journal-" + name + ".tmp",
    );
    try {
      if (await this.fs.exists(dest)) throw new Error("corrupt");
      await ns.writeNew(temp, value);
      await this.fs.atomicReplace(temp, dest);
      await this.fs.syncDirectory(dir);
    } catch (error) {
      this.quarantineClose(ns.sourceKey, ticket.id);
      throw error;
    }
  }
  private async reserveOne(
    ticket: PublicationTicket,
    byteLength: number,
    memory?: SharedArrayBuffer,
    byteOffset = 0,
  ): Promise<void> {
    await this.prune();
    this.admitted(ticket);
    const associatedRecordCreate = await this.checkImportAdmission(ticket);
    const atomicIntent = associatedRecordCreate || isFirstImportPlan(ticket.target);
    if (
      associatedRecordCreate &&
      (ticket.metadata.kind !== "record" || ticket.metadata.record.byteLength !== byteLength)
    )
      throw new Error("size-limit");
    if (
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0 ||
      byteLength >
        (ticket.metadata.kind === "record"
          ? 8388608
          : ticket.metadata.kind === "settings"
            ? 69632
            : 2097152)
    )
      throw new Error("size-limit");
    if (
      this.entries.has(ticket.id) ||
      this.failedReserves.has(ticket.id) ||
      this.entries.size + this.failedReserves.size >= 1024 ||
      [...this.entries.values()].filter((e) => e.ticket.owner.sourceKey === ticket.owner.sourceKey)
        .length >= 64
    )
      throw new Error("quota");
    if (ticket.metadata.kind !== ticket.target.kind) throw new Error("invalid-target");
    const targetKey = this.targetKey(ticket);
    if (ticket.target.kind !== "settings" && this.targets.has(targetKey))
      throw new Error("write-in-progress");
    if (ticket.target.kind !== "settings") this.targets.set(targetKey, ticket.id);
    let held: { source: string; key: string } | null = null;
    let opened: StoreFd | null = null;
    let allocated: Namespace | null = null;
    let importBudgetHeld = false;
    try {
      const ns = await this.ns(ticket.owner.sourceKey),
        location = await ns.location(ticket.target, true),
        old = await ns.head(location);
      this.admitted(ticket);
      this.cas(ticket, old);
      if (old) {
        await ns.verify(location, old);
        if (old.object) {
          const key = this.fs.name(ns.object(location, old));
          this.quota.holdTemporary(ticket.owner.sourceKey, key, old.byteLength);
          held = { source: ticket.owner.sourceKey, key };
        }
      }
      this.reserveImportBudget(ns, ticket, byteLength);
      importBudgetHeld = ticket.target.kind === "import";
      await this.fs.at("reserve", async () => {
        this.quota.reserve(
          ticket.id,
          ticket.owner.sourceKey,
          {
            bytes: ticket.metadata.kind === "record" ? byteLength : 0,
            create: ticket.target.kind === "record" && old === null,
            metadata: 32768 + (ticket.metadata.kind === "record" ? 0 : byteLength),
            lane: ticket.metadata.kind === "record" ? "write" : "metadata",
          },
          (await this.fs.statfs(ns.path())).availableBytes,
        );
      });
      if (atomicIntent && (await this.fs.exists(ns.path("staging", ticket.id))))
        throw new Error("write-in-progress");
      allocated = ns;
      await this.fs.mkdir(ns.path("staging", ticket.id));
      const rawIntent = {
        formatVersion: 1,
        ticket,
        byteLength,
        predecessor: old,
      };
      const intent = atomicIntent ? privateIntentSchema.parse(rawIntent) : rawIntent;
      if (atomicIntent)
        await this.installImportDocument(
          ns,
          ticket,
          associatedRecordCreate ? "record-intent" : "intent",
          intent,
        );
      else await ns.writeNew(ns.path("staging", ticket.id, "intent.json"), intent);
      const temp = ns.path("staging", ticket.id, "payload.tmp");
      await this.fs.at("open-temp", async () => {
        opened = await this.fs.openOwned(temp, "create-exclusive");
      });
      const fd = opened;
      const frozen = atomicIntent ? intent.ticket : structuredClone(ticket);
      this.admitted(ticket);
      this.entries.set(ticket.id, {
        ticket: frozen,
        ns,
        location,
        old,
        size: byteLength,
        fd,
        temp,
        object: null,
        gate: new PublicationGate(ticket.deadlineMonotonicMs, memory, byteOffset),
        hash: createHash("sha256"),
        received: 0,
        last: null,
        created: this.fs.now(),
        progress: this.fs.now(),
        state: "receiving",
        busy: false,
        head: null,
        accounted: false,
        finished: null,
        oldHeld: held !== null,
        cleaned: false,
      });
    } catch (e) {
      if (opened) await this.fs.closeOwned(opened).catch(() => {});
      if (atomicIntent && allocated && this.quarantined(ticket)) {
        this.failedReserves.set(ticket.id, {
          ticket: structuredClone(ticket),
          ns: allocated,
          interruptedInstall: true,
        });
        throw e;
      }
      let clean = true;
      if (allocated)
        for (const name of [
          "payload.tmp",
          "sealed.json",
          "import-tag.json",
          "publication.json",
          "intent.json",
        ]) {
          const p = allocated.path("staging", ticket.id, name);
          try {
            if (await this.fs.exists(p)) await this.fs.unlink(p);
          } catch {
            clean = false;
          }
        }
      if (clean && allocated) {
        try {
          await this.fs.removeEmpty(allocated.path("staging", ticket.id));
        } catch {
          clean = false;
        }
      }
      if (clean) {
        this.releaseTarget(ticket);
        this.quota.release(ticket.id);
        if (importBudgetHeld) this.importReservations.delete(ticket.id);
      } else
        this.failedReserves.set(ticket.id, { ticket: structuredClone(ticket), ns: allocated! });
      if (held) this.quota.releaseTemporary(held.source, held.key);
      throw e;
    }
  }
  async append(ticket: PublicationTicket, offset: number, bytes: Uint8Array): Promise<number> {
    const e = this.entry(ticket);
    this.live(e);
    if (e.state !== "receiving" || e.busy) throw new Error("sealed");
    if (bytes.length < 1 || bytes.length > 262144) throw new Error("size-limit");
    if (e.last && offset === e.last.offset && Buffer.from(bytes).equals(Buffer.from(e.last.bytes)))
      return e.received;
    if (offset !== e.received || offset + bytes.length > e.size) throw new Error("offset-mismatch");
    e.busy = true;
    try {
      this.live(e);
      await this.fs.at("chunk-write", () => writeAll(this.fs, e.fd!, offset, bytes));
      e.hash.update(bytes);
      e.received += bytes.length;
      if (e.last?.bytes.length === bytes.length) {
        e.last.offset = offset;
        e.last.bytes.set(bytes);
      } else e.last = { offset, bytes: Uint8Array.from(bytes) };
      e.progress = this.fs.now();
      return e.received;
    } finally {
      e.busy = false;
    }
  }
  async seal(ticket: PublicationTicket, byteLength: number, sha256: string): Promise<void> {
    const e = this.entry(ticket);
    this.live(e);
    if (e.state === "sealed") {
      if (byteLength !== e.size || e.hash.copy().digest("hex") !== sha256)
        throw new Error("checksum-mismatch");
      return;
    }
    if (e.state !== "receiving" || e.busy) throw new Error("sealed");
    if (byteLength !== e.size || e.received !== e.size) throw new Error("incomplete");
    if (
      e.tag &&
      (e.verifiedItem?.item.mappedSha256 !== sha256 ||
        e.verifiedItem.item.byteLength !== byteLength)
    )
      throw new Error("checksum-mismatch");
    if (e.hash.copy().digest("hex") !== sha256) throw new Error("checksum-mismatch");
    e.busy = true;
    try {
      await this.fs.at("seal-sync", () => this.fs.sync(e.fd!));
      await this.fs.closeOwned(e.fd!);
      e.fd = null;
      e.state = "sealed";
      const seal = sealDocumentSchema.parse({
        formatVersion: 1,
        byteLength,
        sha256,
      });
      if (isFirstImportPlan(ticket.target))
        await this.installImportDocument(e.ns, ticket, "sealed", seal);
      else {
        await e.ns.writeNew(e.ns.path("staging", ticket.id, "sealed.json"), seal);
        await this.fs.syncDirectory(e.ns.path("staging", ticket.id));
      }
      e.state = "sealed";
      e.progress = this.fs.now();
      e.last = null;
    } finally {
      e.busy = false;
    }
  }
  fence(owner: PersistenceOwner, deadlineMonotonicMs: number): readonly Handle[] {
    const key = ownerKey(owner),
      deadline = Math.min(this.frozen.get(key) ?? Infinity, deadlineMonotonicMs);
    this.frozen.set(key, deadline);
    const accepted: string[] = [];
    for (const e of this.entries.values())
      if (ownerKey(e.ticket.owner) === key && e.finished === null) {
        e.gate.shorten(deadline, this.fs.now());
        accepted.push(e.ticket.id);
      }
    return Object.freeze(accepted);
  }
  fenceTarget(
    owner: PersistenceOwner,
    id: RecordId,
    deadlineMonotonicMs: number,
  ): readonly Handle[] {
    const key = JSON.stringify([ownerKey(owner), id]),
      deadline = Math.min(this.frozenTargets.get(key) ?? Infinity, deadlineMonotonicMs);
    this.frozenTargets.set(key, deadline);
    const accepted: string[] = [];
    for (const e of this.entries.values())
      if (
        ownerKey(e.ticket.owner) === ownerKey(owner) &&
        e.ticket.target.kind === "record" &&
        e.ticket.target.id === id &&
        e.finished === null
      ) {
        e.gate.shorten(deadline, this.fs.now());
        accepted.push(e.ticket.id);
      }
    return Object.freeze(accepted);
  }
  async publish(ticket: PublicationTicket): Promise<Outcome> {
    const e = this.entry(ticket);
    if (e.state === "committed") return { disposition: "committed", receipt: e.head!.receipt };
    if (e.state === "unknown" || e.state === "publishing") return this.reconcile(ticket);
    const previous = this.publication.get(ticket.owner.sourceKey) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => this.publishOne(e));
    this.publication.set(ticket.owner.sourceKey, run);
    return run;
  }
  private async publishOne(e: Entry, gate = e.gate): Promise<Outcome> {
    if (e.state !== "sealed" || this.quarantined(e.ticket)) return { disposition: "not-committed" };
    try {
      this.live(e, gate);
    } catch {
      return { disposition: "not-committed" };
    }
    if (this.uncertain.has(e.ticket.owner.sourceKey)) return { disposition: "unknown" };
    e.busy = true;
    try {
      const { ticket: t, ns, location: loc } = e;
      const revision =
        t.metadata.kind === "record"
          ? t.metadata.record.revision
          : "r_" + randomUUID().replaceAll("-", "");
      const deleted = t.metadata.kind === "record" && t.metadata.deleted;
      if (!e.head)
        e.head = {
          formatVersion: 1,
          metadata: t.metadata,
          target: t.target,
          object: deleted ? null : `${revision}.${t.metadata.kind === "record" ? "bin" : "json"}`,
          byteLength: e.size,
          sha256: e.hash.copy().digest("hex"),
          receipt: {
            revision,
            commitId: e.tag || isFirstImportPlan(t.target) ? t.id : randomUUID(),
            durability: this.fs.durability,
          },
          ...(e.tag ? { importTag: e.tag } : {}),
        };
      const parsedHead = parseHead(Buffer.from(JSON.stringify(e.head)));
      if (isFirstRecordImport(e) || isFirstImportPlan(t.target)) e.head = parsedHead;
      const headTemp = ns.path(
        ...loc.parts,
        `${loc.name === "head.json" ? "head" : loc.name}.${t.id}.tmp`,
      );
      const firstImport = isFirstRecordImport(e);
      if (firstImport || isFirstImportPlan(t.target)) await this.validateImportStage(e);
      if (!deleted && !e.object) {
        this.live(e, gate);
        const destination = ns.object(loc, e.head);
        if (await this.fs.exists(destination)) throw new Error("revision-mismatch");
        if (firstImport) {
          // Publish a complete candidate name before moving the only payload. Recovery
          // authenticates it against the pending attempt and never installs it as head.
          if (await this.fs.exists(headTemp)) {
            if (!exactDocument(await this.fs.bytes(headTemp, 8192), e.head))
              throw new Error("corrupt");
          } else {
            const staging = ns.path("staging", t.id, "publication.json");
            if (await this.fs.exists(staging)) {
              if (!exactDocument(await this.fs.bytes(staging, 8192), e.head))
                throw new Error("corrupt");
              await this.fs.unlink(staging);
            }
            await this.fs.at("head-write", () => ns.writeNew(staging, e.head));
            await this.fs.atomicReplace(staging, headTemp);
          }
          e.installedCandidate = true;
          await this.fs.syncDirectory(loc.directory);
        }
        await this.fs.at("object-rename", async () => {
          await this.fs.atomicReplace(e.temp, destination);
          e.object = destination;
          for (const pin of this.pins.values())
            if (pin.ticket === t.id) {
              const oldKey = this.fs.name(pin.path);
              pin.path = destination;
              this.quota.releaseTemporary(pin.source, oldKey);
              this.quota.holdTemporary(pin.source, this.fs.name(destination), pin.length);
            }
        });
        await this.fs.at("object-dir-sync", async () => {
          await this.fs.syncDirectory(loc.objects);
          await this.fs.syncDirectory(ns.path("staging", t.id));
        });
      }
      this.live(e, gate);
      const current = await ns.head(loc);
      this.cas(t, current);
      if (current) {
        await this.fs.at("backup-head", async () => {
          const backup = ns.path(...loc.parts, `${loc.name}.${t.id}.backup`);
          if (await this.fs.exists(backup)) await this.fs.unlink(backup);
          await ns.writeNew(backup, current);
          await this.fs.atomicReplace(backup, loc.previous);
          await this.fs.syncDirectory(loc.directory);
        });
      }
      if (!firstImport) {
        if (await this.fs.exists(headTemp)) await this.fs.unlink(headTemp);
        await this.fs.at("head-write", () => ns.writeNew(headTemp, e.head));
      }
      if (t.target.kind === "import") {
        const candidate = ns.path("staging", t.id, "publication.json");
        if (!(await this.fs.exists(candidate))) {
          if (isFirstImportPlan(t.target))
            await this.installImportDocument(ns, t, "publication", e.head);
          else {
            await ns.writeNew(candidate, e.head);
            await this.fs.syncDirectory(ns.path("staging", t.id));
          }
        } else {
          const bytes = await this.fs.bytes(candidate, 8192);
          const matches = isFirstImportPlan(t.target)
            ? exactDocument(bytes, e.head)
            : sameImportValue(parseHead(bytes), e.head);
          if (!matches) throw new Error("input-changed");
          await this.fs.syncDirectory(ns.path("staging", t.id));
        }
        if (isFirstImportPlan(t.target)) e.installedCandidate = true;
      }
      await this.fs.fault("before-publish");
      if (e.tag) {
        const binding = e.verifiedItem;
        if (!binding) throw new Error("input-changed");
        // Verify the installed payload itself before the new head can name it.
        if (e.head.sha256 !== binding.item.mappedSha256) throw new Error("checksum-mismatch");
        await ns.verify(loc, e.head);
        if (firstImport && !exactDocument(await this.fs.bytes(headTemp, 8192), e.head))
          throw new Error("corrupt");
        const journal = await ns.location({ kind: "import", key: e.tag.importId });
        const head = await ns.head(journal);
        if (!head || head.sha256 !== binding.digest) throw new Error("input-changed");
        await ns.verify(journal, head);
        if ((await this.journalRevision(binding.head, binding.object)) !== binding.revision)
          throw new Error("input-changed");
      }
      this.live(e, gate);
      this.cas(t, await ns.head(loc));
      // Last observation of the original. External writers may change it after this check.
      if (e.original) {
        const { fs, path, stamp } = e.original;
        if (
          (await fs.pathStamp(path).catch((error) => {
            if (error.code === "ENOENT" || error.message === "unsafe-path")
              throw new Error("input-changed");
            throw error;
          })) !== stamp
        )
          throw new Error("input-changed");
      }
      this.fs.profile.assertHeld();
      if (this.quarantined(t) || !gate.dispatch(this.fs.now()))
        return { disposition: "not-committed" };
      e.state = "publishing";
      this.uncertain.set(t.owner.sourceKey, t.id);
      if (t.metadata.kind === "import")
        await this.fs.at("import-marker", () => this.fs.atomicReplace(headTemp, loc.head));
      else await this.fs.atomicReplace(headTemp, loc.head);
      await this.fs.fault("after-publish");
      await this.fs.at("head-dir-sync", () => this.fs.syncDirectory(loc.directory));
      await this.fs.at("cache-publish", async () => {
        this.confirm(e);
      });
      await this.cleanup(e, true).catch(() => {
        /* Committed receipt survives; referenced bytes keep their charge. */
      });
      await this.fs.fault("receipt-send");
      return { disposition: "committed", receipt: e.head.receipt };
    } catch (error) {
      if (gate.dispatched) {
        e.state = "unknown";
        this.uncertain.set(e.ticket.owner.sourceKey, e.ticket.id);
        return { disposition: "unknown" };
      }
      throw error;
    } finally {
      e.busy = false;
    }
  }
  private confirm(e: Entry): void {
    if (!e.accounted) {
      const oldRecord = liveRecord(e.old),
        nextRecord = liveRecord(e.head);
      const size = (h: DiskHead | null) =>
        h
          ? Buffer.byteLength(JSON.stringify(h)) + (h.metadata.kind === "record" ? 0 : h.byteLength)
          : 0;
      this.quota.commit(e.ticket.id, {
        committed: (nextRecord?.byteLength ?? 0) - (oldRecord?.byteLength ?? 0),
        records: Number(nextRecord !== null) - Number(oldRecord !== null),
        metadata: size(e.head) - size(e.old) + 32768,
        temporary: 0,
      });
      if (e.ticket.target.kind === "import") {
        // Transfer the charge synchronously: no scan/commit gap and no double charge.
        this.importCommitted.get(e.ns)!.set(e.ticket.target.key, e.size);
        this.importReservations.delete(e.ticket.id);
      }
      e.accounted = true;
    }
    delete e.original;
    e.state = "committed";
    e.finished ??= this.fs.now();
    this.uncertain.delete(e.ticket.owner.sourceKey);
    this.releaseTarget(e.ticket);
  }
  async reconcile(ticket: PublicationTicket): Promise<Outcome> {
    const e = this.entry(ticket);
    if (!e.busy && e.state === "committed")
      return { disposition: "committed", receipt: e.head!.receipt };
    if (e.state === "aborted") return { disposition: "not-committed" };
    if (isFirstImportPlan(ticket.target) && this.quarantined(ticket))
      return { disposition: "unknown" };
    if (
      isFirstRecordImport(e) &&
      e.abortRequested &&
      e.state === "unknown" &&
      this.quarantined(e.ticket)
    )
      return { disposition: "unknown" };
    if (e.busy && (e.gate.dispatched || e.recoveryGate?.dispatched))
      return { disposition: "unknown" };
    if (!(e.gate.dispatched || e.recoveryGate?.dispatched)) return { disposition: "not-committed" };
    return this.settleUnpublished(e);
  }
  private settleUnpublished(e: Entry): Promise<Outcome> {
    const source = e.ticket.owner.sourceKey;
    const prior = this.publication.get(source) ?? Promise.resolve();
    const outcome = prior.catch(() => {}).then(() => this.checkAndClean(e));
    this.publication.set(source, outcome);
    return outcome;
  }
  private async checkAndClean(e: Entry): Promise<Outcome> {
    if (e.state === "committed") return { disposition: "committed", receipt: e.head!.receipt };
    if (e.state === "aborted") return { disposition: "not-committed" };
    if (e.busy) return { disposition: "unknown" };
    const dispatched = e.gate.dispatched || e.recoveryGate?.dispatched;
    try {
      const current = await e.ns.head(e.location);
      if (current && e.head && current.receipt.commitId === e.head.receipt.commitId) {
        if (
          (isFirstRecordImport(e) || isFirstImportPlan(e.ticket.target)) &&
          !exactDocument(await this.fs.bytes(e.location.head, 8192), e.head)
        )
          throw new Error("publish-uncertain");
        await e.ns.verify(e.location, current);
        await this.fs.syncDirectory(e.location.directory);
        this.confirm(e);
        return { disposition: "committed", receipt: current.receipt };
      }
      if (dispatched) {
        if ((current?.receipt.commitId ?? null) !== (e.old?.receipt.commitId ?? null))
          throw new Error("publish-uncertain");
        if (current) await e.ns.verify(e.location, current);
      }
      if (
        current?.object &&
        e.object &&
        this.fs.name(e.object) === this.fs.name(e.ns.object(e.location, current))
      )
        return { disposition: "unknown" };
      await this.removeUnpublished(e, current);
      if (this.uncertain.get(e.ticket.owner.sourceKey) === e.ticket.id)
        this.uncertain.delete(e.ticket.owner.sourceKey);
      return { disposition: "not-committed" };
    } catch (error) {
      if (!dispatched) throw error;
      this.uncertain.set(e.ticket.owner.sourceKey, e.ticket.id);
      return { disposition: "unknown" };
    }
  }
  async abort(ticket: PublicationTicket): Promise<"aborted" | "committed" | "unknown"> {
    this.fs.profile.assertHeld();
    const tombstone = this.tombstones.get(ticket.id);
    // A denied admission has no Entry, but its exact ticket still needs idempotent cleanup.
    if (
      !this.entries.has(ticket.id) &&
      !this.failedReserves.has(ticket.id) &&
      ticket.owner.hostEpoch === this.fs.profile.hostEpoch &&
      tombstone?.settlement.disposition === "aborted" &&
      tombstone.until > this.fs.now() &&
      sameImportValue(tombstone.ticket, ticket)
    )
      return "aborted";
    const failed = this.failedReserves.get(ticket.id);
    if (failed) {
      if (!sameImportValue(ticket, failed.ticket)) throw new Error("stale");
      if (failed.interruptedInstall) return "unknown";
      for (const name of [
        "payload.tmp",
        "sealed.json",
        "import-tag.json",
        "publication.json",
        "intent.json",
      ]) {
        const p = failed.ns.path("staging", ticket.id, name);
        if (await this.fs.exists(p)) await this.fs.unlink(p);
      }
      await this.fs.removeEmpty(failed.ns.path("staging", ticket.id));
      this.quota.release(ticket.id);
      this.releaseTarget(ticket);
      this.failedReserves.delete(ticket.id);
      this.importReservations.delete(ticket.id);
      for (const [identity, write] of this.documentWrites)
        if (write.ticket.id === ticket.id) this.documentWrites.delete(identity);
      this.tombstones.set(ticket.id, {
        ticket: structuredClone(ticket),
        settlement: { disposition: "aborted" },
        until: this.fs.now() + 120000,
      });
      while (this.tombstones.size > 1024)
        this.tombstones.delete(this.tombstones.keys().next().value!);
      return "aborted";
    }
    const e = this.entry(ticket);
    if (e.state === "committed" && !e.busy) return "committed";
    if (e.state === "aborted") return "aborted";
    e.abortRequested = true;
    e.gate.shorten(this.fs.now(), this.fs.now());
    e.recoveryGate?.shorten(this.fs.now(), this.fs.now());
    if (e.busy) return "unknown";
    const outcome = await this.settleUnpublished(e);
    return outcome.disposition === "not-committed" ? "aborted" : outcome.disposition;
  }
  private async validateImportStage(e: Entry): Promise<void> {
    const dir = e.ns.path("staging", e.ticket.id);
    const docs = new Map<string, unknown>([
      [
        "intent.json",
        {
          formatVersion: 1,
          ticket: e.ticket,
          byteLength: e.size,
          predecessor: e.old,
        },
      ],
      [
        "sealed.json",
        { formatVersion: 1, byteLength: e.size, sha256: e.hash.copy().digest("hex") },
      ],
    ]);
    if (isFirstImportPlan(e.ticket.target)) {
      for (const [suffix, expected] of [
        ["tmp", e.head],
        ["backup", e.old],
      ] as const) {
        const path = e.ns.path(
          ...e.location.parts,
          e.location.name + "." + e.ticket.id + "." + suffix,
        );
        if (!(await this.fs.exists(path))) continue;
        if (!expected) throw new Error("corrupt");
        const full = Buffer.from(JSON.stringify(expected));
        const actual = await this.fs.bytes(path, full.length);
        if (
          !full.subarray(0, actual.length).equals(actual) ||
          (suffix === "tmp" &&
            (await this.fs.exists(e.ns.path("staging", e.ticket.id, "publication.json"))) &&
            actual.length !== full.length)
        )
          throw new Error("corrupt");
      }
    }
    if (e.head) docs.set("publication.json", e.head);
    if (e.tag) docs.set("import-tag.json", { formatVersion: 1, tag: e.tag });
    for (const entry of await this.fs.entries(dir, 4096)) {
      if (entry.directory) throw new Error("corrupt");
      if (entry.name === "payload.tmp") continue;
      if (
        !docs.has(entry.name) ||
        !exactDocument(
          await this.fs.bytes(e.ns.path("staging", e.ticket.id, entry.name), 8192),
          docs.get(entry.name),
        )
      )
        throw new Error("corrupt");
    }
  }
  private async removeUnpublished(e: Entry, current: DiskHead | null): Promise<void> {
    if (isFirstImportPlan(e.ticket.target)) this.assertSourceAvailable(e.ns.sourceKey);
    const pin = e.retained && this.pins.get(e.retained.pin);
    if (pin && e.retained) await this.closePin(e.retained.pin, pin);
    if (e.fd) {
      await this.fs.closeOwned(e.fd);
      e.fd = null;
    }
    let retained: { temporary: number; metadata: number } | undefined;
    let chargeKey: string | undefined;
    if (isFirstRecordImport(e)) {
      this.assertSourceAvailable(e.ns.sourceKey);
      try {
        const result = await retirePendingImportCandidate(e.ns, e.location, {
          ticket: e.ticket,
          head: e.head,
          installedCandidate: !!e.installedCandidate,
          tag: e.tag,
          reserveQuarantine: (p, bytes) => {
            chargeKey = this.fs.name(p);
            this.quota.holdTemporary(e.ns.sourceKey, chargeKey, bytes);
          },
        });
        if (!result) throw new Error("publish-uncertain");
        retained = result;
        await this.cleanImportStage(e, chargeKey !== undefined);
      } catch (error) {
        // The source stays fenced with its exact reservation until a fresh scan.
        // In particular a repeat after a failed directory sync cannot infer abort
        // from a now-absent candidate.
        e.state = "unknown";
        this.quarantineClose(e.ns.sourceKey, e.ticket.id);
        throw error;
      }
    } else {
      if (isFirstImportPlan(e.ticket.target)) {
        const witness = e.ns.path("staging", e.ticket.id, "publication.json");
        try {
          await this.validateImportStage(e);
          if (!sameImportValue(current, e.old)) throw new Error("publish-uncertain");
          if (current) await e.ns.verify(e.location, current);
          if (e.installedCandidate || (await this.fs.exists(witness))) {
            const candidate = canonicalHead(await this.fs.bytes(witness, 8192));
            if (!e.object || !sameImportValue(candidate, e.head))
              throw new Error("publish-uncertain");
            await e.ns.verify(e.location, candidate);
            await this.fs.unlink(witness);
            await this.fs.syncDirectory(e.ns.path("staging", e.ticket.id));
            delete e.installedCandidate;
          }
        } catch (error) {
          this.quarantineClose(e.ns.sourceKey, e.ticket.id);
          throw error;
        }
      }
      for (const p of [
        e.temp,
        e.object,
        e.ns.path(
          ...e.location.parts,
          `${e.location.name === "head.json" ? "head" : e.location.name}.${e.ticket.id}.tmp`,
        ),
        e.ns.path(...e.location.parts, `${e.location.name}.${e.ticket.id}.backup`),
        e.ns.path("staging", e.ticket.id, "sealed.json"),
        e.ns.path("staging", e.ticket.id, "import-tag.json"),
        e.ns.path("staging", e.ticket.id, "publication.json"),
        e.ns.path("staging", e.ticket.id, "intent.json"),
      ])
        if (p && (await this.fs.exists(p))) await this.fs.unlink(p);
      if (
        current?.receipt.commitId === e.old?.receipt.commitId &&
        (await this.fs.exists(e.location.previous))
      ) {
        const backup = parseHead(await this.fs.bytes(e.location.previous, 8192));
        if (backup.receipt.commitId === current?.receipt.commitId)
          await this.fs.unlink(e.location.previous);
      }
      await this.fs.removeEmpty(e.ns.path("staging", e.ticket.id));
    }
    if (retained && chargeKey !== undefined) {
      this.quota.commit(e.ticket.id, { committed: 0, records: 0, ...retained });
      this.quota.releaseTemporary(e.ns.sourceKey, chargeKey);
    } else this.quota.release(e.ticket.id);
    this.releaseOld(e);
    delete e.original;
    e.state = "aborted";
    e.finished ??= this.fs.now();
    this.releaseTarget(e.ticket);
    this.importReservations.delete(e.ticket.id);
  }
  private async cleanImportStage(e: Entry, movedToQuarantine: boolean): Promise<void> {
    const stage = e.ns.path("staging", e.ticket.id);
    const names = [
      ...(movedToQuarantine ? ["abort-tag.json"] : []),
      "payload.tmp",
      "sealed.json",
      "import-tag.json",
      "publication.json",
      "intent.json",
    ];
    const entries = await this.fs.entries(stage, 4096);
    if (entries.some((entry) => entry.directory || !names.includes(entry.name)))
      throw new Error("corrupt");
    for (const name of names) {
      const p = e.ns.path("staging", e.ticket.id, name);
      if (await this.fs.exists(p)) await this.fs.unlink(p);
    }
    await this.fs.removeEmpty(stage);
  }
  private releaseOld(e: Entry): void {
    if (e.oldHeld && e.old?.object) {
      this.quota.releaseTemporary(
        e.ticket.owner.sourceKey,
        this.fs.name(e.ns.object(e.location, e.old)),
      );
      e.oldHeld = false;
    }
  }
  private async cleanup(e: Entry, serialized = false): Promise<void> {
    if (!serialized) {
      const prior = this.publication.get(e.ticket.owner.sourceKey) ?? Promise.resolve();
      const cleanup = prior.catch(() => {}).then(() => this.cleanup(e, true));
      this.publication.set(e.ticket.owner.sourceKey, cleanup);
      await cleanup;
      return;
    }
    if (e.cleaned) return;
    await this.fs.at("cleanup", async () => {
      if (isFirstRecordImport(e) || isFirstImportPlan(e.ticket.target)) {
        await this.validateImportStage(e);
        if (!exactDocument(await this.fs.bytes(e.location.head, 8192), e.head))
          throw new Error("corrupt");
      }
      if (
        (await e.ns.head(e.location))?.receipt.commitId === e.head?.receipt.commitId &&
        (await this.fs.exists(e.location.previous))
      )
        await this.fs.unlink(e.location.previous);
      for (const name of [
        "payload.tmp",
        "sealed.json",
        "import-tag.json",
        "publication.json",
        "intent.json",
      ]) {
        const p = e.ns.path("staging", e.ticket.id, name);
        if (await this.fs.exists(p)) await this.fs.unlink(p);
      }
      if (e.old?.object) {
        const p = e.ns.object(e.location, e.old),
          key = this.fs.name(p);
        if ([...this.pins.values()].some((pin) => this.fs.name(pin.path) === key)) {
          this.gcHeld.set(key, { source: e.ticket.owner.sourceKey, key });
          e.oldHeld = false;
        } else {
          if (await this.fs.exists(p)) await this.fs.unlink(p);
          this.releaseOld(e);
        }
      }
      await this.fs.removeEmpty(e.ns.path("staging", e.ticket.id));
      await this.fs.syncDirectory(e.location.directory);
    });
    this.quota.adjustMetadata(e.ticket.owner.sourceKey, -32768);
    e.cleaned = true;
  }
  private async settled(owner: PersistenceOwner): Promise<Namespace> {
    if (owner.hostEpoch !== this.fs.profile.hostEpoch) throw new Error("stale");
    await this.prune();
    for (
      let id = this.uncertain.get(owner.sourceKey);
      id;
      id = this.uncertain.get(owner.sourceKey)
    ) {
      const e = this.entries.get(id)!;
      const publishing = this.publication.get(owner.sourceKey);
      if (e.busy && publishing) {
        // Dispatch fences the source before rename/sync completes. A read must
        // join that work, not mistake reconcile's nonblocking "busy" observation
        // for a failed publication. Recheck the marker after the join: a queued
        // publication may now own it, or a real failure may still need reconciliation.
        await publishing.catch(() => {});
        continue;
      }
      if ((await this.reconcile(e.ticket)).disposition === "unknown")
        throw new Error("publish-uncertain");
    }
    return this.ns(owner.sourceKey);
  }
  async settings(owner: PersistenceOwner): Promise<SettingsSnapshot | null> {
    const ns = await this.settled(owner),
      loc = await ns.location({ kind: "settings", expectedRevision: null }),
      head = await ns.head(loc);
    if (!head) return null;
    await ns.verify(loc, head);
    const body = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await this.fs.bytes(ns.object(loc, head), 69632),
      ),
    ) as {
      formatVersion: number;
      schemaVersion: number;
      validationDigest: string;
      values: SettingsSnapshot["values"];
    };
    assertDiskFormat(body);
    if (
      head.metadata.kind !== "settings" ||
      body.schemaVersion !== head.metadata.schemaVersion ||
      body.validationDigest !== head.metadata.validationDigest ||
      Buffer.byteLength(JSON.stringify(body.values)) > 65536
    )
      throw new Error("corrupt");
    return {
      schemaVersion: body.schemaVersion,
      revision: head.receipt.revision,
      values: body.values,
    };
  }
  async stat(owner: PersistenceOwner, id: RecordId): Promise<RecordMeta> {
    const ns = await this.settled(owner),
      loc = await ns.location({ kind: "record", id, expectedRevision: null }),
      head = await ns.head(loc),
      record = liveRecord(head);
    if (!head || !record) throw new Error("not-found");
    await ns.verify(loc, head);
    return structuredClone(record);
  }
  async open(owner: PersistenceOwner, id: RecordId, revision: RecordRevision): Promise<Handle> {
    return (await this.openRecord(owner, id, revision)).pin;
  }
  async openRecord(
    owner: PersistenceOwner,
    id: RecordId,
    revision: RecordRevision,
    schemaVersion?: number,
  ) {
    const ns = await this.settled(owner);
    if ([...this.pins.values()].filter((p) => p.source === owner.sourceKey).length >= 4)
      throw new Error("quota");
    const loc = await ns.location({ kind: "record", id, expectedRevision: revision }),
      head = await ns.head(loc);
    const record = liveRecord(head);
    if (!record || !head) throw new Error("not-found");
    if (head.receipt.revision !== revision) throw new Error("revision-mismatch");
    if (schemaVersion !== undefined && record.schemaVersion !== schemaVersion)
      throw new Error("schema-mismatch");
    const p = ns.object(loc, head),
      key = this.fs.name(p);
    this.quota.holdTemporary(owner.sourceKey, key, head.byteLength);
    const fd = await this.fs.open(p, "read").catch((error) => {
      this.quota.releaseTemporary(owner.sourceKey, key);
      throw error;
    });
    const pin = randomUUID();
    const opened: Pin = {
      owner: ownerKey(owner),
      source: owner.sourceKey,
      ns,
      path: p,
      fd,
      length: head.byteLength,
      created: this.fs.now(),
      used: this.fs.now(),
      busy: ns.verifyFd(fd, head),
    };
    this.pins.set(pin, opened);
    try {
      await opened.busy;
      if (opened.closing) throw new Error("stale");
      return { pin, record };
    } catch (error) {
      await this.closePin(pin, opened);
      throw error;
    }
  }
  read(owner: PersistenceOwner, pin: Handle, offset: number, maxBytes: number) {
    return this.readPin(owner, pin, offset, maxBytes, (fd, length) =>
      length ? this.fs.read(fd, offset, length) : Promise.resolve(new Uint8Array()),
    );
  }
  private encodedScratch?: Buffer;
  readEncoded(owner: PersistenceOwner, pin: Handle, offset: number, maxBytes: number) {
    return this.readPin(owner, pin, offset, maxBytes, async (fd, length) => {
      if (!length) return { data: "", length: 0 };
      const scratch = this.encodedScratch ?? Buffer.alloc(262144);
      delete this.encodedScratch;
      try {
        const bytes = await this.fs.readInto(fd, offset, scratch.subarray(0, length));
        return { data: scratch.toString("base64", 0, bytes.length), length: bytes.length };
      } finally {
        this.encodedScratch = scratch;
      }
    });
  }
  private async readPin<T extends { length: number }>(
    owner: PersistenceOwner,
    pin: Handle,
    offset: number,
    maxBytes: number,
    read: (fd: StoreFd, length: number) => Promise<T>,
  ): Promise<T> {
    await this.prune();
    const p = this.pins.get(pin);
    if (!p || p.closing || p.owner !== ownerKey(owner)) throw new Error("stale");
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > p.length ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 262144
    )
      throw new Error("invalid-range");
    const work = p.busy
      .catch(() => {})
      .then(async () => {
        p.used = this.fs.now();
        const length = Math.min(maxBytes, p.length - offset);
        const result = await read(p.fd, length);
        if (length && !result.length) throw new Error("corrupt");
        return result;
      });
    p.busy = work;
    return work;
  }
  private closePin(id: string, p: Pin): Promise<void> {
    return (p.closing ??= this.finishClosePin(id, p));
  }
  quarantineClose(source: string, id: Handle): void {
    if (!this.quarantinedSources.has(source)) this.quarantinedSources.set(source, id);
  }
  assertSourceAvailable(source: string): void {
    if (this.quarantinedSources.has(source)) throw new Error("recovery-blocked");
  }
  private async finishClosePin(id: string, p: Pin): Promise<void> {
    await p.busy.catch(() => {});
    await this.fs.close(p.fd).catch((cause) => {
      // Keep the descriptor, candidate and quota until worker teardown. Only
      // this source needs recovery; global pruning can continue past this pin.
      p.closeFailed = true;
      this.quarantineClose(p.source, id);
      throw new Error("recovery-blocked", { cause });
    });
    this.pins.delete(id);
    const key = this.fs.name(p.path);
    this.quota.releaseTemporary(p.source, key);
    if (
      ![...this.pins.values()].some((pin) => this.fs.name(pin.path) === key) &&
      this.gcHeld.has(key)
    ) {
      try {
        await this.fs.unlink(p.path);
        this.quota.releaseTemporary(p.source, key);
        this.gcHeld.delete(key);
      } catch {
        /* Charge and retry evidence stay retained. */
      }
    }
    if (
      this.closed.size < 1024 &&
      [...this.closed.values()].filter((c) => c.owner === p.owner).length < 64
    )
      this.closed.set(id, { owner: p.owner, until: this.fs.now() + 120000 });
  }
  async close(owner: PersistenceOwner, pin: Handle): Promise<void> {
    const p = this.pins.get(pin);
    if (!p) {
      const old = this.closed.get(pin);
      if (old?.owner === ownerKey(owner) && old.until > this.fs.now()) return;
      throw new Error("stale");
    }
    if (p.owner !== ownerKey(owner)) throw new Error("stale");
    await this.closePin(pin, p);
  }
  async list(
    owner: PersistenceOwner,
    input: { kind?: string; limit: number; cursor?: Handle },
  ): Promise<{ entries: RecordMeta[]; nextCursor?: Handle }> {
    const ns = await this.settled(owner);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 64)
      throw new Error("invalid-range");
    let page: Page,
      offset = 0;
    if (input.cursor) {
      const cursor = this.cursors.get(input.cursor);
      if (
        !cursor ||
        cursor.page.owner !== ownerKey(owner) ||
        cursor.page.kind !== input.kind ||
        cursor.page.limit !== input.limit
      )
        throw new Error("stale");
      page = cursor.page;
      offset = cursor.offset;
    } else {
      if ([...this.pages].filter((p) => p.source === owner.sourceKey).length >= 4)
        throw new Error("quota");
      const entries: RecordMeta[] = [];
      for (const loc of await ns.locations()) {
        const r = liveRecord(await ns.head(loc));
        if (r && (input.kind === undefined || input.kind === r.kind))
          entries.push(structuredClone(r));
      }
      entries.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const bytes = Buffer.byteLength(JSON.stringify(entries));
      if (
        [...this.pages]
          .filter((p) => p.source === owner.sourceKey)
          .reduce((n, p) => n + p.bytes, bytes) > 524288 ||
        [...this.pages].reduce((n, p) => n + p.bytes, bytes) > 8388608
      )
        throw new Error("quota");
      page = {
        owner: ownerKey(owner),
        source: owner.sourceKey,
        kind: input.kind,
        limit: input.limit,
        entries,
        created: this.fs.now(),
        used: this.fs.now(),
        bytes,
        tokens: new Map(),
      };
      this.pages.add(page);
    }
    page.used = this.fs.now();
    const entries = page.entries.slice(offset, offset + page.limit),
      next = offset + entries.length;
    if (next === page.entries.length) {
      // With no issued cursor there is no handle to replay or retain. Keeping
      // empty/single-page results would exhaust the four snapshot slots after
      // four ordinary refreshes. Multi-page cursor snapshots keep their TTL.
      if (page.tokens.size === 0) this.pages.delete(page);
      return { entries: structuredClone(entries) };
    }
    let token = page.tokens.get(next);
    if (!token) {
      token = randomUUID();
      page.tokens.set(next, token);
      this.cursors.set(token, { page, offset: next });
    }
    const result = { entries: structuredClone(entries), nextCursor: token };
    if (Buffer.byteLength(JSON.stringify({ ok: true, value: result })) > 262144)
      throw new Error("size-limit");
    return result;
  }
  async tagImport(ticket: PublicationTicket, tag: ImportTag): Promise<void> {
    const e = this.entry(ticket);
    this.live(e);
    if (e.state !== "receiving" || e.received !== 0 || e.busy || e.tag) throw new Error("sealed");
    e.busy = true;
    try {
      const document = importTagDocumentSchema.parse({ formatVersion: 1, tag });
      const parsed = document.tag;
      const loc = await e.ns.location({ kind: "import", key: parsed.importId });
      const head = await e.ns.head(loc);
      if (!head) throw new Error("input-changed");
      const object = e.ns.object(loc, head);
      const revision = await this.journalRevision(loc.head, object);
      if (!sameImportValue(await e.ns.head(loc), head)) throw new Error("input-changed");
      const saved = await this.readImport(e.ns, loc, head, parsed.importId);
      const item = saved?.plan.items.find((i) => i.key === parsed.itemKey);
      const attempt = saved?.items.find((i) => i.key === parsed.itemKey)?.publicationTicket;
      if (
        !item ||
        (await this.journalRevision(loc.head, object)) !== revision ||
        !attempt ||
        !sameImportValue(attempt, ticket) ||
        !sameImportAttempt(item.ticket, ticket) ||
        !sameImportValue(item.tag, parsed)
      )
        throw new Error("input-changed");
      // Persist the immutable binding before append can be admitted. The published head includes it.
      await e.ns.writeNew(e.ns.path("staging", ticket.id, "import-tag.json"), document);
      await this.fs.syncDirectory(e.ns.path("staging", ticket.id));
      e.tag = parsed;
      e.verifiedItem = { item, head: loc.head, object, revision, digest: head.sha256 };
    } finally {
      e.busy = false;
    }
  }
  async importReceipts(
    owner: PersistenceOwner,
    id: string,
  ): ReturnType<DurableImportPort["importReceipts"]> {
    const saved = await this.loadImport(owner, id);
    if (!saved) return [];
    const ns = await this.ns(owner.sourceKey),
      receipts: Awaited<ReturnType<DurableImportPort["importReceipts"]>>[number][] = [];
    for (const item of saved.plan.items) {
      const evidence = saved.items.find((e) => e.key === item.key)!,
        attempt = evidence.publicationTicket;
      if (!attempt) continue;
      if (evidence.state === "committed" && evidence.receipt) {
        receipts.push({ tag: item.tag, ticket: attempt, receipt: evidence.receipt });
        continue;
      }
      const loc = await ns.location(attempt.target),
        head = await ns.head(loc);
      if (!head?.importTag || !sameImportValue(head.importTag, item.tag)) continue;
      await ns.verify(loc, head);
      if (
        !exactDocument(await this.fs.bytes(loc.head, 8192), head) ||
        head.receipt.commitId !== attempt.id ||
        head.sha256 !== item.mappedSha256 ||
        head.byteLength !== item.byteLength ||
        !sameImportValue(head.metadata, attempt.metadata) ||
        !sameImportValue(head.target, attempt.target)
      )
        throw new Error("input-changed");
      await this.fs.syncDirectory(loc.directory);
      receipts.push({ tag: item.tag, ticket: attempt, receipt: head.receipt });
    }
    if (Buffer.byteLength(JSON.stringify(receipts)) > 2097152) throw new Error("size-limit");
    return receipts;
  }
  async auxiliary(
    owner: PersistenceOwner,
    kind: "import" | "recovery",
    key: string,
  ): Promise<Uint8Array | null> {
    this.fs.profile.assertHeld();
    if (owner.hostEpoch !== this.fs.profile.hostEpoch) throw new Error("stale");
    const ns = await this.ns(owner.sourceKey),
      loc = await ns.location({ kind, key }),
      head = await ns.head(loc);
    if (!head) return null;
    await ns.verify(loc, head);
    return this.fs.bytes(ns.object(loc, head), 2097152);
  }
  private readonly importMutations = new Map<string, Promise<unknown>>();
  private mutateImport<T>(owner: PersistenceOwner, id: string, run: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([owner.sourceKey, id]),
      previous = this.importMutations.get(key) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(run);
    this.importMutations.set(key, result);
    void result
      .finally(() => {
        if (this.importMutations.get(key) === result) this.importMutations.delete(key);
      })
      .catch(() => {});
    return result;
  }
  planImport(owner: PersistenceOwner, plan: ImportPlan): Promise<void> {
    return this.mutateImport(owner, plan.id, () => this.planImportOne(owner, plan));
  }
  recordImport(owner: PersistenceOwner, id: string, evidence: ImportItemEvidence): Promise<void> {
    return this.mutateImport(owner, id, () => this.recordImportOne(owner, id, evidence));
  }
  completeImport(owner: PersistenceOwner, id: string): Promise<void> {
    return this.mutateImport(owner, id, () => this.completeImportOne(owner, id));
  }
  private readonly documentWrites = new Map<
    string,
    { ticket: PublicationTicket; bytes: Uint8Array; result: Promise<Outcome> }
  >();
  private async reconcileDocument(ticket: PublicationTicket): Promise<Outcome> {
    if (this.failedReserves.has(ticket.id)) {
      const result = await this.abort(ticket);
      if (result === "aborted") return { disposition: "not-committed" };
      if (result === "unknown" && isFirstImportPlan(ticket.target))
        return { disposition: "unknown" };
    }
    const tombstone = this.tombstones.get(ticket.id);
    if (
      tombstone &&
      sameImportValue(tombstone.ticket, ticket) &&
      tombstone.settlement.disposition === "aborted"
    )
      return { disposition: "not-committed" };
    return this.reconcile(ticket);
  }
  private async writeDocument(
    owner: PersistenceOwner,
    kind: "import" | "recovery",
    key: string,
    value: unknown,
  ): Promise<void> {
    if (kind === "import" && key.startsWith("import/")) value = importDocumentSchema.parse(value);
    const bytes = Buffer.from(JSON.stringify(value)),
      identity = JSON.stringify([owner.sourceKey, kind, key]);
    if (bytes.length > 2097152 || Buffer.byteLength(key) > 128) throw new Error("size-limit");
    const previous = this.documentWrites.get(identity);
    if (previous) {
      let result = await previous.result;
      if (result.disposition === "unknown") result = await this.reconcileDocument(previous.ticket);
      if (result.disposition === "unknown") throw new Error("publish-uncertain");
      this.documentWrites.delete(identity);
      if (result.disposition === "committed") this.forgetCompletedDocument(previous.ticket);
      if (result.disposition === "committed" && Buffer.from(previous.bytes).equals(bytes)) return;
      if (result.disposition === "committed") throw new Error("reload-import");
    }
    const ticket: PublicationTicket = {
      id: randomUUID(),
      owner: structuredClone(owner),
      deadlineMonotonicMs: this.fs.now() + 10000,
      metadata: { kind, key },
      target: { kind, key },
    };
    if (kind === "recovery") this.recoveryDocuments.add(ticket.id);
    this.admitted(ticket);
    // Schedule only after the exact candidate is installed. A thrown write retains its identity.
    const result = Promise.resolve().then(async (): Promise<Outcome> => {
      try {
        await this.reserve(ticket, bytes.length);
        for (let offset = 0; offset < bytes.length; offset += 262144)
          await this.append(ticket, offset, bytes.subarray(offset, offset + 262144));
        await this.seal(ticket, bytes.length, createHash("sha256").update(bytes).digest("hex"));
        const outcome = await this.publish(ticket);
        return outcome.disposition === "unknown" ? await this.reconcile(ticket) : outcome;
      } catch {
        if (this.entries.has(ticket.id)) {
          const disposition = await this.abort(ticket);
          if (disposition !== "aborted") return this.reconcile(ticket);
        }
        if (this.failedReserves.has(ticket.id)) return { disposition: "unknown" };
        return { disposition: "not-committed" };
      }
    });
    void result.finally(() => this.recoveryDocuments.delete(ticket.id)).catch(() => {});
    this.documentWrites.set(identity, { ticket, bytes, result });
    const outcome = await result;
    if (outcome.disposition === "unknown") throw new Error("publish-uncertain");
    this.documentWrites.delete(identity);
    if (outcome.disposition !== "committed") throw new Error("not-committed");
    this.forgetCompletedDocument(ticket);
  }
  private forgetCompletedDocument(ticket: PublicationTicket): void {
    // These host-only journal/recovery writes return no write handle or ticket.
    // Once their exact result was observed and cleanup finished, the durable head
    // is authoritative. Do not consume the 64 public/uncertain live-entry slots
    // for every internal progress update in a many-record import.
    const entry = this.entries.get(ticket.id);
    if (
      entry &&
      entry.state === "committed" &&
      entry.cleaned &&
      !entry.busy &&
      (ticket.target.kind === "import" || ticket.target.kind === "recovery")
    )
      this.forgetEntry(ticket.id, entry);
  }
  admitImport(owner: PersistenceOwner, id: string, key: string): Promise<PublicationTicket> {
    return this.mutateImport(owner, id, async () => {
      this.fs.profile.assertHeld();
      if (owner.hostEpoch !== this.fs.profile.hostEpoch) throw new Error("stale");
      const identity = JSON.stringify([owner.sourceKey, "import", id]),
        pending = this.documentWrites.get(identity);
      if (pending) {
        let outcome = await pending.result;
        if (outcome.disposition === "unknown")
          outcome = await this.reconcileDocument(pending.ticket);
        if (outcome.disposition === "unknown") throw new Error("publish-uncertain");
        this.documentWrites.delete(identity);
      }
      const saved = await this.loadImport(owner, id);
      if (!saved || saved.complete) throw new Error("stale");
      const index = saved.plan.items.findIndex((item) => item.key === key),
        item = saved.plan.items[index],
        prior = saved.items[index];
      if (
        !item ||
        !prior ||
        prior.state === "committed" ||
        prior.state === "skipped" ||
        owner.pluginId !== item.ticket.owner.pluginId ||
        owner.sourceKey !== item.ticket.owner.sourceKey
      )
        throw new Error("stale");
      const old = prior.publicationTicket;
      const competing = this.targets.get(this.targetKey(item.ticket));
      if (competing && competing !== old?.id) throw new Error("write-in-progress");
      if (old && !sameImportAttempt(item.ticket, old)) throw new Error("input-changed");
      if (old && this.entries.has(old.id)) {
        const live = this.entry(old);
        if (live.state !== "committed" && live.state !== "aborted")
          live.gate.shorten(this.fs.now(), this.fs.now());
        if ((await this.abort(old)) === "unknown") throw new Error("publish-uncertain");
      }
      const outcome = await this.reconcileImport(item.ticket, id);
      if (outcome.disposition === "committed") {
        if (!old || !outcome.receipt) throw new Error("unverified-receipt");
        await this.recordImportOne(owner, id, {
          ...prior,
          state: "committed",
          receipt: outcome.receipt,
          skipReason: null,
        });
        throw new Error("already-committed");
      }
      if (outcome.disposition !== "not-committed") throw new Error("publish-uncertain");
      if (
        old &&
        sameImportValue(old.owner, owner) &&
        !this.entries.has(old.id) &&
        old.deadlineMonotonicMs > this.fs.now()
      ) {
        this.admitted(old);
        return structuredClone(old);
      }
      const deadline =
        old?.owner.hostEpoch === owner.hostEpoch ? old.deadlineMonotonicMs : this.fs.now() + 10000;
      if (deadline <= this.fs.now()) throw new Error("stale");
      const attempt: PublicationTicket = {
        ...structuredClone(item.ticket),
        id: randomUUID(),
        owner: structuredClone(owner),
        deadlineMonotonicMs: deadline,
      };
      this.admitted(attempt);
      const items = saved.items.map((e, i) =>
        i === index
          ? {
              ...e,
              state: "pending" as const,
              receipt: null,
              skipReason: null,
              publicationTicket: attempt,
            }
          : e,
      );
      await this.writeDocument(owner, "import", id, { formatVersion: 1, ...saved, items });
      return structuredClone(attempt);
    });
  }
  // A single small decoded journal may be reused by concurrent integrity checks. A
  // cache hit still hashes the live object. Returned graphs belong to their caller.
  private lastImport?: {
    digest: string;
    value: NonNullable<Awaited<ReturnType<DurableImportPort["load"]>>>;
  };
  private async readImport(ns: Namespace, loc: Location, head: DiskHead, id: string) {
    if (head.target.kind !== "import" || head.target.key !== id || !head.object)
      throw new Error("corrupt");
    if (!exactDocument(await this.fs.bytes(loc.head, 8192), head)) throw new Error("corrupt");
    const cached = this.lastImport;
    if (
      cached?.digest === head.sha256 &&
      cached.value.plan.id === id &&
      cached.value.plan.targetSourceKey === ns.sourceKey
    ) {
      await ns.verify(loc, head);
      return structuredClone(cached.value);
    }
    const bytes = await this.fs.bytes(ns.object(loc, head), 2097152);
    if (
      head.byteLength !== bytes.length ||
      createHash("sha256").update(bytes).digest("hex") !== head.sha256
    )
      throw new Error("corrupt");
    const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    assertDiskFormat(raw);
    const { plan, items, complete } = importDocumentSchema.parse(raw);
    if (plan.id !== id || plan.targetSourceKey !== ns.sourceKey) throw new Error("input-changed");
    const value = { plan, items, complete };
    if (bytes.length <= 131072)
      this.lastImport = { digest: head.sha256, value: structuredClone(value) };
    return value;
  }
  async loadImport(owner: PersistenceOwner, id: string): ReturnType<DurableImportPort["load"]> {
    if (Buffer.byteLength(id) > 128 || !id.startsWith("import/")) throw new Error("size-limit");
    this.fs.profile.assertHeld();
    if (owner.hostEpoch !== this.fs.profile.hostEpoch) throw new Error("stale");
    const ns = await this.ns(owner.sourceKey),
      loc = await ns.location({ kind: "import", key: id }),
      head = await ns.head(loc);
    return head ? this.readImport(ns, loc, head, id) : null;
  }
  private async planImportOne(owner: PersistenceOwner, plan: ImportPlan): Promise<void> {
    plan = importPlanSchema.parse(plan);
    if (
      plan.targetSourceKey !== owner.sourceKey ||
      plan.items.some((i) => ownerKey(i.ticket.owner) !== ownerKey(owner))
    )
      throw new Error("stale");
    const old = await this.loadImport(owner, plan.id);
    if (old) {
      if (!sameImportValue(old.plan, plan)) throw new Error("input-changed");
      return;
    }
    await this.writeDocument(owner, "import", plan.id, {
      formatVersion: 1,
      plan,
      items: plan.items.map((i) => ({
        key: i.key,
        state: "pending",
        receipt: null,
        skipReason: null,
        publicationTicket: null,
      })),
      complete: false,
    });
  }
  private async recordImportOne(
    owner: PersistenceOwner,
    id: string,
    evidence: ImportItemEvidence,
  ): Promise<void> {
    evidence = importItemEvidenceSchema.parse(evidence);
    const saved = await this.loadImport(owner, id);
    if (!saved) throw new Error("not-found");
    if (saved.plan.devicePreferencesEvidence && evidence.state === "skipped")
      throw new Error("unverified-receipt");
    const index = saved.plan.items.findIndex((i) => i.key === evidence.key);
    if (index < 0 || saved.complete) throw new Error("stale");
    if (evidence.state === "committed") {
      const receipt = (await this.importReceipts(owner, id)).find(
        (r) => r.tag.itemKey === evidence.key,
      );
      if (!receipt || JSON.stringify(receipt.receipt) !== JSON.stringify(evidence.receipt))
        throw new Error("input-changed");
    }
    const prior = saved.items[index]!;
    if (!sameImportValue(prior.publicationTicket, evidence.publicationTicket))
      throw new Error("input-changed");
    if (evidence.state === "skipped") {
      const attempt = prior.publicationTicket;
      if (attempt && this.entries.has(attempt.id)) {
        this.fenceTargetOrTicket(attempt);
        if ((await this.abort(attempt)) !== "aborted") throw new Error("publish-uncertain");
      }
      if (
        (await this.reconcileImport(saved.plan.items[index]!.ticket)).disposition !==
        "not-committed"
      )
        throw new Error("publish-uncertain");
    }
    if (
      (prior.state === "committed" || prior.state === "skipped") &&
      JSON.stringify(prior) !== JSON.stringify(evidence)
    )
      throw new Error("input-changed");
    const items = [...saved.items];
    items[index] = evidence;
    await this.writeDocument(owner, "import", id, { formatVersion: 1, ...saved, items });
  }
  async reconcileImport(
    ticket: PublicationTicket,
    knownPlan?: string,
  ): ReturnType<PersistenceEnginePort["reconcile"]> {
    publicationTicketSchema.parse(ticket);
    this.fs.profile.assertHeld();
    try {
      return await this.reconcileImportEvidence(ticket, knownPlan);
    } catch (error) {
      if (error instanceof Error && ["stale", "not-primary"].includes(error.message)) throw error;
      return { disposition: "unknown" };
    }
  }
  private async reconcileImportEvidence(
    ticket: PublicationTicket,
    knownPlan?: string,
  ): ReturnType<PersistenceEnginePort["reconcile"]> {
    const ns = await this.ns(ticket.owner.sourceKey);
    if (ticket.target.kind === "import") {
      if (isFirstImportPlan(ticket.target) && this.blockedSources.has(ns.sourceKey))
        return { disposition: "unknown" };
      const resolved = await resolvedImport(ns, ticket.id, isFirstImportPlan(ticket.target));
      if (resolved) {
        const intentBytes = await this.fs.bytes(
          ns.path("staging", ticket.id, "intent.json"),
          32768,
        );
        const raw = JSON.parse(Buffer.from(intentBytes).toString("utf8"));
        const installedTicket = publicationTicketSchema.parse(raw.ticket);
        if (!sameImportValue(installedTicket, ticket)) throw new Error("stale");
        if (
          isFirstImportPlan(ticket.target) &&
          !(await legacyImportReserve(ns, ticket.id, raw.ticket, installedTicket))
        )
          verifyImportIntent(intentBytes, ticket, raw);
        return resolved.disposition === "committed"
          ? { disposition: "committed", receipt: resolved.receipt }
          : { disposition: "not-committed" };
      }
      const loc = await ns.location(ticket.target),
        head = await ns.head(loc);
      if (head) {
        if (
          isFirstImportPlan(ticket.target) &&
          !exactDocument(await this.fs.bytes(loc.head, 8192), head)
        )
          throw new Error("corrupt");
        await ns.verify(loc, head);
        const bytes = await this.fs.bytes(ns.object(loc, head), 2097152);
        if (ticket.target.key.startsWith("nonce/") || ticket.target.key.startsWith("barrier/")) {
          const document = ticket.target.key.startsWith("nonce/")
            ? parseNonceDocument(bytes)
            : parseBarrierDocument(bytes);
          if (sameImportValue(document.ticket, ticket)) {
            await this.fs.syncDirectory(loc.directory);
            return { disposition: "committed", receipt: head.receipt };
          }
        }
      }
      // Live metadata uses the exact retained engine entry, including its dispatch gate.
      if (this.entries.has(ticket.id)) return this.reconcile(ticket);
      if (this.failedReserves.get(ticket.id)?.interruptedInstall) return { disposition: "unknown" };
      const intentPath = ns.path("staging", ticket.id, "intent.json");
      if (!(await this.fs.exists(intentPath))) return { disposition: "unknown" };
      const intentBytes = await this.fs.bytes(intentPath, 32768);
      const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(intentBytes));
      if (isFirstImportPlan(ticket.target)) verifyImportIntent(intentBytes, ticket, raw);
      if (
        raw.formatVersion !== 1 ||
        Object.keys(raw).sort().join(",") !== "byteLength,formatVersion,predecessor,ticket" ||
        !sameImportValue(publicationTicketSchema.parse(raw.ticket), ticket)
      )
        throw new Error("stale");
      const candidatePath = ns.path("staging", ticket.id, "publication.json");
      if (head && (await this.fs.exists(candidatePath))) {
        const bytes = await this.fs.bytes(candidatePath, 8192);
        const candidate = isFirstImportPlan(ticket.target)
          ? canonicalHead(bytes)
          : parseHead(bytes);
        if (
          sameImportValue(candidate.target, ticket.target) &&
          sameImportValue(candidate.metadata, ticket.metadata) &&
          sameImportValue(candidate, head)
        ) {
          await this.fs.syncDirectory(loc.directory);
          return { disposition: "committed", receipt: head.receipt };
        }
      }
      const predecessor =
        raw.predecessor === null ? null : parseHead(Buffer.from(JSON.stringify(raw.predecessor)));
      if (predecessor) await ns.verify(loc, predecessor);
      if (
        this.blockedSources.has(ticket.owner.sourceKey) ||
        this.uncertain.has(ticket.owner.sourceKey)
      )
        return { disposition: "unknown" };
      return sameImportValue(head, predecessor)
        ? { disposition: "not-committed" }
        : { disposition: "unknown" };
    }
    // A live tag identifies the journal without walking every unrelated record. A
    // reopened worker still discovers historical tickets from the durable namespace.
    if (!knownPlan) {
      for (const entry of this.entries.values()) {
        if (
          entry.verifiedItem &&
          (sameImportValue(entry.ticket, ticket) ||
            sameImportValue(entry.verifiedItem.item.ticket, ticket))
        ) {
          knownPlan = entry.verifiedItem.item.tag.importId;
          break;
        }
      }
    }
    const locations = knownPlan
      ? [await ns.location({ kind: "import", key: knownPlan })]
      : await ns.locations();
    for (const loc of locations) {
      const head = await ns.head(loc);
      if (head?.target.kind !== "import" || !head.target.key.startsWith("import/")) continue;
      if (knownPlan && head.target.key !== knownPlan) throw new Error("input-changed");
      const saved = await this.readImport(ns, loc, head, head.target.key);
      const index = saved.plan.items.findIndex(
        (item, i) =>
          sameImportValue(item.ticket, ticket) ||
          sameImportValue(saved.items[i]!.publicationTicket, ticket),
      );
      if (index < 0) continue;
      const item = saved.plan.items[index]!,
        evidence = saved.items[index]!,
        attempt = evidence.publicationTicket;
      if (evidence.state === "committed" && evidence.receipt)
        return { disposition: "committed", receipt: evidence.receipt };
      const failed = attempt && this.failedReserves.get(attempt.id);
      if (failed?.interruptedInstall && sameImportValue(failed.ticket, attempt))
        return { disposition: "unknown" };
      if (attempt && this.entries.has(attempt.id)) {
        const live = await this.reconcile(attempt);
        if (live.disposition !== "not-committed") return live;
        if (this.unresolvedTicket(attempt.id)) return { disposition: "unknown" };
      }
      const target = await ns.location(item.ticket.target),
        current = await ns.head(target);
      if (current) {
        if (current.importTag && !exactDocument(await this.fs.bytes(target.head, 8192), current))
          throw new Error("corrupt");
        await ns.verify(target, current);
      }
      if (
        attempt &&
        current?.importTag &&
        sameImportValue(current.importTag, item.tag) &&
        current.receipt.commitId === attempt.id &&
        sameImportValue(current.metadata, attempt.metadata) &&
        sameImportValue(current.target, attempt.target) &&
        current.sha256 === item.mappedSha256 &&
        current.byteLength === item.byteLength
      ) {
        await this.fs.syncDirectory(target.directory);
        return { disposition: "committed", receipt: current.receipt };
      }
      if (
        this.blockedSources.has(ns.sourceKey) ||
        this.uncertain.has(ns.sourceKey) ||
        [...this.entries.values()].some(
          (e) =>
            e.ticket.owner.sourceKey === ns.sourceKey &&
            (e.busy || e.state === "publishing" || e.state === "unknown"),
        )
      )
        return { disposition: "unknown" };
      if (
        (item.ticket.target.kind === "record" || item.ticket.target.kind === "settings") &&
        (current?.receipt.revision ?? null) === item.ticket.target.expectedRevision
      )
        return { disposition: "not-committed" };
      return { disposition: "unknown" };
    }
    throw new Error("stale");
  }
  private async completeImportOne(owner: PersistenceOwner, id: string): Promise<void> {
    const saved = await this.loadImport(owner, id);
    if (!saved) throw new Error("not-found");
    if (saved.complete) return;
    const receipts = await this.importReceipts(owner, id);
    const items = saved.items.map((e) => {
      const r = receipts.find((r) => r.tag.itemKey === e.key);
      return e.state === "committed" || e.state === "skipped"
        ? e
        : r
          ? {
              key: e.key,
              state: "committed" as const,
              receipt: r.receipt,
              skipReason: null,
              publicationTicket: r.ticket,
            }
          : e;
    });
    if (
      items.length !== saved.plan.items.length ||
      items.some((e) => e.state !== "committed" && e.state !== "skipped")
    )
      throw new Error("incomplete");
    await this.writeDocument(owner, "import", id, {
      formatVersion: 1,
      ...saved,
      items,
      complete: true,
    });
  }
  async settingsDigest(
    owner: PersistenceOwner,
  ): ReturnType<PersistenceEvidencePort["settingsDigest"]> {
    const ns = await this.settled(owner),
      loc = await ns.location({ kind: "settings", expectedRevision: null }),
      head = await ns.head(loc);
    if (!head) return null;
    await ns.verify(loc, head);
    if (head.metadata.kind !== "settings") throw new Error("corrupt");
    return {
      schemaVersion: head.metadata.schemaVersion,
      validationDigest: head.metadata.validationDigest,
      revision: head.receipt.revision,
    };
  }
  private readonly evidencePages = new Map<
    string,
    { signature: string; items: string[]; offset: number; expires: number }
  >();
  async auxiliaryKeys(
    owner: PersistenceOwner,
    kind: "import" | "recovery",
    cursor?: Handle,
  ): ReturnType<PersistenceEvidencePort["auxiliaryKeys"]> {
    const signature = JSON.stringify([ownerKey(owner), kind]);
    let page;
    if (cursor) {
      page = this.evidencePages.get(cursor);
      if (!page || page.signature !== signature || page.expires <= this.fs.now())
        throw new Error("stale");
    } else {
      const ns = await this.ns(owner.sourceKey),
        items: string[] = [];
      for (const loc of await ns.locations()) {
        const h = await ns.head(loc);
        if (h?.target.kind === kind && "key" in h.target) items.push(h.target.key);
      }
      if (items.length > 512 || this.evidencePages.size >= 32) throw new Error("quota");
      page = { signature, items: items.sort(), offset: 0, expires: this.fs.now() + 30000 };
    }
    const keys = page.items.slice(page.offset, page.offset + 64),
      next = page.offset + keys.length;
    if (next === page.items.length) return { keys, nextCursor: null };
    const nextCursor = randomUUID();
    this.evidencePages.set(nextCursor, { ...page, offset: next });
    return { keys, nextCursor };
  }
  async saveCheckpoint(owner: PersistenceOwner, value: CheckpointRegistration): Promise<void> {
    const document = checkpointDocumentSchema.parse({ formatVersion: 1, ...value });
    const bytes = await this.auxiliary(owner, "recovery", value.checkpoint);
    if (!bytes) throw new Error("stale");
    const old = checkpointDocumentSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
    if (
      old.record.id !== document.record.id ||
      !(await this.ownsCheckpoint(owner, value.checkpoint, value.record.id))
    )
      throw new Error("stale");
    await this.writeDocument(owner, "recovery", value.checkpoint, document);
  }
  async saveRecovery(value: StoredRecovery): Promise<void> {
    storedRecoverySchema.parse(value);
    if (value.ticket && ownerKey(value.ticket.owner) !== ownerKey(value.owner))
      throw new Error("stale");
    if (value.sealedPin) {
      const e = value.ticket ? this.entries.get(value.ticket.id) : undefined;
      const pin = this.pins.get(value.sealedPin);
      if (
        !e ||
        !sameImportValue(e.ticket, value.ticket) ||
        !pin ||
        pin.ticket !== e.ticket.id ||
        pin.owner !== ownerKey(value.owner) ||
        e.retained?.pin !== value.sealedPin ||
        this.fs.now() >= e.retained.expiresMonotonicMs ||
        !["sealed", "publishing", "unknown", "committed"].includes(e.state) ||
        e.received !== e.size
      )
        throw new Error("incomplete");
      const expiresAt = Math.min(
        value.expiresAt ?? Infinity,
        Date.now() + e.retained.expiresMonotonicMs - this.fs.now(),
      );
      value = {
        ...value,
        expiresAt,
        report: {
          ...value.report,
          records: value.report.records.map((r) =>
            r.payload === "complete-staging"
              ? { ...r, expiresAt: Math.min(r.expiresAt ?? Infinity, expiresAt) }
              : r,
          ),
        },
      };
    }
    await this.writeDocument(value.owner, "recovery", value.id, { formatVersion: 1, value });
  }
  async recoveryPage(cursor?: Handle): ReturnType<PersistenceEvidencePort["recoveryPage"]> {
    const all: StoredRecovery[] = [];
    for (const pending of this.namespaces.values()) {
      const ns = await pending;
      for (const loc of await ns.locations()) {
        const head = await ns.head(loc);
        if (head?.target.kind !== "recovery") continue;
        await ns.verify(loc, head);
        const raw = JSON.parse(
          Buffer.from(await this.fs.bytes(ns.object(loc, head), 2097152)).toString("utf8"),
        );
        assertDiskFormat(raw);
        if ("checkpoint" in raw) {
          const document = checkpointDocumentSchema.parse(raw);
          if (document.checkpoint !== head.target.key) throw new Error("corrupt");
          continue;
        }
        if (raw.removed === true) {
          z.strictObject({ formatVersion: z.literal(1), removed: z.literal(true), id: uuid }).parse(
            raw,
          );
          if (raw.id !== head.target.key) throw new Error("corrupt");
          continue;
        }
        z.strictObject({ formatVersion: z.literal(1), value: storedRecoverySchema }).parse(raw);
        const value = storedRecoverySchema.parse(raw.value);
        if (value.id !== head.target.key || value.owner.sourceKey !== ns.sourceKey)
          throw new Error("corrupt");
        // Retained handles are worker capabilities, not durable UUID-based authority.
        const retained = value.sealedPin ? this.pins.get(value.sealedPin) : undefined;
        const entry = value.ticket ? this.entries.get(value.ticket.id) : undefined;
        if (value.ticket && entry && !sameImportValue(entry.ticket, value.ticket))
          throw new Error("stale");
        if (entry) value.ticket = structuredClone(entry.ticket);
        if (value.ticket && entry && (entry.state === "unknown" || entry.state === "publishing")) {
          const result = await this.reconcile(value.ticket);
          if (result.disposition === "unknown")
            value.report = { ...value.report, state: "uncertain", blocker: true };
        }
        if (
          value.sealedPin &&
          (!retained ||
            retained.closeFailed ||
            !entry ||
            retained.ticket !== value.ticket?.id ||
            retained.owner !== ownerKey(value.owner) ||
            !retained.expires ||
            this.fs.now() >= retained.expires ||
            value.ticket?.owner.hostEpoch !== this.fs.profile.hostEpoch)
        ) {
          value.sealedPin = null;
          value.report = {
            ...value.report,
            state: value.report.state === "uncertain" ? "uncertain" : "checkpoint-only",
            blocker: true,
            records: value.report.records.map((r) => ({
              id: r.id,
              committedRevision: r.committedRevision,
              final: r.final,
              payload: r.committedRevision ? "checkpoint-only" : "none",
            })),
          };
        }
        if (
          value.ticket &&
          value.ticket.owner.hostEpoch !== this.fs.profile.hostEpoch &&
          value.ticket.target.kind === "record"
        ) {
          const original = value.ticket,
            target = original.target;
          const location = await ns.location(target),
            current = await ns.head(location);
          if (current) await ns.verify(location, current);
          if (
            original.metadata.kind === "record" &&
            current &&
            sameImportValue(current.metadata, original.metadata) &&
            sameImportValue(current.target, target) &&
            current.receipt.revision === original.metadata.record.revision
          ) {
            const record = original.metadata.record,
              final = record.checkpoint === "final";
            value.ticket = null;
            value.sealedPin = null;
            value.report = {
              ...value.report,
              state: record.checkpoint === "open" ? "checkpoint-only" : "saved",
              blocker: record.checkpoint === "open",
              records: [
                {
                  id: record.id,
                  committedRevision: record.revision,
                  final,
                  payload: "checkpoint-only",
                },
              ],
            };
          } else if (
            target.kind === "record" &&
            (current?.receipt.revision ?? null) === target.expectedRevision
          ) {
            // Verified predecessor plus discarded transient staging is known unpublished, never a new retry lease.
            value.ticket = null;
            value.sealedPin = null;
            value.report = { ...value.report, state: "checkpoint-only", blocker: true };
          } else value.report = { ...value.report, state: "uncertain", blocker: true };
        }
        all.push(value);
      }
    }
    all.sort((a, b) => a.id.localeCompare(b.id));
    const signature = "recovery",
      page = cursor ? this.evidencePages.get(cursor) : undefined;
    if (cursor && (!page || page.signature !== signature || page.expires <= this.fs.now()))
      throw new Error("stale");
    const offset = page?.offset ?? 0,
      items: StoredRecovery[] = [];
    for (const value of all.slice(offset, offset + 64)) {
      if (Buffer.byteLength(JSON.stringify([...items, value])) > 262144) break;
      items.push(value);
    }
    const next = offset + items.length;
    if (next === all.length) return { items, nextCursor: null };
    if (!items.length || this.evidencePages.size >= 32) throw new Error("quota");
    const nextCursor = randomUUID();
    this.evidencePages.set(nextCursor, {
      signature,
      items: all.map((v) => v.id),
      offset: next,
      expires: this.fs.now() + 30000,
    });
    return { items, nextCursor };
  }
  async loadRecovery(id: Handle): Promise<StoredRecovery | null> {
    let cursor: Handle | undefined;
    do {
      const p = await this.recoveryPage(cursor);
      const found = p.items.find((v) => v.id === id);
      if (found) return found;
      cursor = p.nextCursor ?? undefined;
    } while (cursor);
    return null;
  }
  async removeRecovery(id: Handle): Promise<void> {
    const old = await this.loadRecovery(id);
    if (!old) return;
    await this.writeDocument(
      { ...old.owner, hostEpoch: this.fs.profile.hostEpoch },
      "recovery",
      id,
      { formatVersion: 1, removed: true, id },
    );
  }
  async flushEvidence(
    barrier: PersistenceBarrier,
    tickets: readonly PublicationTicket[],
  ): Promise<PersistenceBarrierEvidence> {
    const accepted = tickets.map((t) => t.id),
      incomplete: Handle[] = [],
      unknown: Handle[] = [];
    for (const t of tickets) {
      const e = this.entries.get(t.id);
      if (!e) {
        const tombstone = this.tombstones.get(t.id);
        if (!tombstone || tombstone.until <= this.fs.now() || !sameImportValue(tombstone.ticket, t))
          unknown.push(t.id);
        else if (tombstone.settlement.disposition === "aborted") incomplete.push(t.id);
        continue;
      }
      if (e.retained && e.state === "sealed" && !e.gate.dispatched && !e.recoveryGate?.dispatched) {
        incomplete.push(t.id);
        continue;
      }
      if (
        this.fs.now() >= barrier.deadlineMonotonicMs ||
        e.state === "unknown" ||
        e.state === "publishing"
      ) {
        if ((await this.reconcile(t)).disposition !== "committed") unknown.push(t.id);
      } else if (e.state !== "committed") incomplete.push(t.id);
    }
    const ns = await this.ns(barrier.scope.owner.sourceKey);
    for (const loc of await ns.locations()) {
      const record = liveRecord(await ns.head(loc));
      if (
        record?.checkpoint === "open" &&
        (barrier.scope.kind === "namespace" || record.id === barrier.scope.recordId)
      )
        incomplete.push(record.id);
    }
    // A failed descriptor close remains an independent cleanup obligation even
    // when main has already received a publication receipt for the record.
    const restartBlocker = this.quarantinedSources.get(barrier.scope.owner.sourceKey);
    if (restartBlocker)
      for (const [id, pin] of this.pins)
        if (pin.closeFailed && pin.source === barrier.scope.owner.sourceKey) unknown.push(id);
    if (restartBlocker && !unknown.includes(restartBlocker)) unknown.push(restartBlocker);
    return {
      ...(restartBlocker ? { restartBlocker } : {}),
      state: unknown.length ? "unknown" : incomplete.length ? "failed" : "saved",
      accepted,
      incomplete,
      unknown,
    };
  }
  fenceTargetOrTicket(ticket: PublicationTicket): void {
    const e = this.entries.get(ticket.id);
    if (
      e &&
      e.state !== "committed" &&
      e.state !== "aborted" &&
      sameImportValue(e.ticket, ticket)
    ) {
      e.gate.shorten(this.fs.now(), this.fs.now());
      e.recoveryGate?.shorten(this.fs.now(), this.fs.now());
    }
  }
  settlement(id: string, ticket?: PublicationTicket): Settlement | null {
    const e = this.entries.get(id);
    if (e) {
      if (e.busy || (ticket && !sameImportValue(e.ticket, ticket))) return null;
      if (e.state === "committed") return { disposition: "committed", receipt: e.head!.receipt };
      return e.state === "aborted" ? { disposition: "aborted" } : null;
    }
    const saved = this.tombstones.get(id);
    return saved &&
      saved.until > this.fs.now() &&
      (!ticket || sameImportValue(ticket, saved.ticket))
      ? saved.settlement
      : null;
  }
  private async journalRevision(head: StorePath, object: StorePath) {
    return (await this.fs.pathStamp(head)) + ":" + (await this.fs.pathStamp(object));
  }
  bindImportSource(ticket: PublicationTicket, source: SourceIdentity) {
    const e = this.entry(ticket);
    if (!e.verifiedItem || e.received || e.state !== "receiving") throw new Error("stale");
    e.original = { fs: source.fs, path: source.path, stamp: source.stamp };
  }
  async verifiedImportItem(ticket: PublicationTicket) {
    const e = this.entry(ticket);
    this.live(e);
    const binding = e.verifiedItem;
    if (!binding || e.state !== "receiving" || !sameImportValue(e.tag, binding.item.tag))
      throw new Error("input-changed");
    if ((await this.journalRevision(binding.head, binding.object)) !== binding.revision) {
      delete e.verifiedItem;
      throw new Error("input-changed");
    }
    return binding.item;
  }
  unresolvedTicket(id: string): boolean {
    const e = this.entries.get(id);
    return !!e && (e.state === "unknown" || e.state === "publishing" || e.busy);
  }
  async collect(owner: PersistenceOwner): Promise<void> {
    const ns = await this.settled(owner),
      protectedPaths = new Set<string>();
    for (const e of this.entries.values())
      if (e.ticket.owner.sourceKey === owner.sourceKey && e.state === "committed" && !e.cleaned)
        await this.cleanup(e);
    for (const pin of this.pins.values()) protectedPaths.add(this.fs.name(pin.path));
    for (const e of this.entries.values())
      if (e.ticket.owner.sourceKey === owner.sourceKey && e.finished === null) {
        protectedPaths.add(this.fs.name(e.temp));
        if (e.object) protectedPaths.add(this.fs.name(e.object));
        if (e.old?.object) protectedPaths.add(this.fs.name(ns.object(e.location, e.old)));
      }
    for (const p of await garbageCandidates(ns, protectedPaths)) await this.fs.unlink(p);
  }
  async dispose(): Promise<void> {
    for (const e of this.entries.values())
      if (e.state !== "committed" && e.state !== "aborted")
        e.gate.shorten(this.fs.now(), this.fs.now());
    const failures: unknown[] = [];
    for (const [id, pin] of this.pins) await this.closePin(id, pin).catch((e) => failures.push(e));
    for (const e of this.entries.values())
      if (e.fd && !e.busy) {
        try {
          await this.fs.closeOwned(e.fd);
          e.fd = null;
        } catch (error) {
          failures.push(error);
        }
      }
    if (failures.length) throw failures[0];
    if (this.failedDescriptorCloses.size) throw new Error("recovery-blocked");
    if (
      this.failedReserves.size ||
      [...this.entries.values()].some((e) => e.busy || e.state === "unknown")
    )
      throw new Error("publish-uncertain");
  }
}
