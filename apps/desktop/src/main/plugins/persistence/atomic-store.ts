import type { CheckpointRegistration } from "./engine-port.js";
import { z } from "zod";
import { recordMetaSchema } from "../../../../../../packages/plugin-protocol/src/storage.js";
import { persistenceOwnerSchema } from "./namespace.js";
import type { FinalWriteGrant, SealedPayloadPin } from "./engine-port.js";
const uuid = z.string().uuid();
export const checkpointDocumentSchema = z.strictObject({ formatVersion: z.literal(1), checkpoint: uuid,
  record: recordMetaSchema, binding: z.strictObject({owner:persistenceOwnerSchema,reservationId:uuid,
    sessionId:uuid,providerGeneration:z.number().int().nonnegative()}).nullable(),
  state:z.enum(["open","final","interrupted"]) });
import { createHash, randomUUID, type Hash } from "node:crypto";
import type { Handle, RecordId, RecordRevision, RecordMeta, SettingsSnapshot } from "@kobrixa/plugin-protocol";
import type { PersistenceOwner } from "@kobrixa/plugin-runtime";
import { PublicationGate, ownerKey, checkpointRecoveryId, type PublicationTicket, type PersistenceEnginePort, type PersistenceReadPort, type ImportTag } from "./engine-port.js";
import { type NodePersistenceFs, writeAll, type StoreFd, type StorePath } from "./filesystem.js";
import { Namespace, parseHead, liveRecord, importTagSchema, type DiskHead, type Location } from "./namespace.js";
import { QuotaLedger } from "./quota.js";
import { scanNamespace, garbageCandidates, resolvedImport } from "./recovery-scan.js";
import type { DurableImportPort, ImportPlan, ImportItemEvidence, PersistenceEvidencePort, StoredRecovery, PersistenceBarrier, PersistenceBarrierEvidence } from "./engine-port.js";
import { importDocumentSchema, importPlanSchema, importItemEvidenceSchema, storedRecoverySchema,
  publicationTicketSchema, sameImportAttempt, sameImportValue } from "./namespace.js";
import { parseNonceDocument, parseBarrierDocument } from "./import-sources.js";
type Outcome = Awaited<ReturnType<PersistenceEnginePort["publish"]>>;
type Entry = { ticket: PublicationTicket; signature: string; ns: Namespace; location: Location; old: DiskHead | null; size: number;
  fd: StoreFd | null; temp: StorePath; object: StorePath | null; gate: PublicationGate; hash: Hash; received: number; last: { offset: number; bytes: Uint8Array } | null;
  created: number; progress: number; state: "receiving" | "sealed" | "publishing" | "committed" | "unknown" | "aborted"; busy: boolean;
  head: DiskHead | null; accounted: boolean; finished: number | null; oldHeld: boolean; cleaned: boolean; tag?: ImportTag; retained?: SealedPayloadPin; recoveryGate?: PublicationGate };
type Pin = { owner: string; source: string; ns: Namespace; path: StorePath; fd: StoreFd; length: number; created: number; used: number; busy: Promise<unknown>; ticket?: string; expires?: number };
type Page = { owner: string; source: string; kind: string | undefined; limit: number; entries: RecordMeta[]; created: number; used: number; bytes: number; tokens: Map<number, string> };
export class AtomicStore implements PersistenceEnginePort, PersistenceReadPort {
  readonly quota = new QuotaLedger();
  private readonly namespaces = new Map<string, Promise<Namespace>>();
  private readonly blockedSources = new Map<string,string>();
  private readonly failedReserves = new Map<string, { ticket: PublicationTicket; ns: Namespace }>();
  private readonly tombstones=new Map<string,{signature:string;disposition:"committed"|"aborted";until:number}>();
  private readonly entries = new Map<string, Entry>(); private readonly targets = new Map<string, string>();
  private readonly finalAdmissions = new Map<string, FinalWriteGrant>();
  private readonly finalConsumed = new Set<string>();
  private readonly recoveryDocuments = new Set<string>();
  private readonly frozen = new Map<string, number>(); private readonly frozenTargets = new Map<string, number>();
  private readonly uncertain = new Map<string, string>(); private readonly publication = new Map<string, Promise<unknown>>();
  private readonly pins = new Map<string, Pin>(); private readonly closed = new Map<string, { owner: string; until: number }>();
  private readonly pages = new Set<Page>(); private readonly cursors = new Map<string, { page: Page; offset: number }>();
  private readonly gcHeld = new Map<string, { source: string; key: string }>();
  constructor(readonly fs: NodePersistenceFs) {}
  async initialize(): Promise<void> {
    this.fs.profile.assertHeld();
    for (const dir of await this.fs.entries(this.fs.path("namespaces"), 4096)) {
      if (!dir.directory || !/^[0-9a-f]{64}$/.test(dir.name)) throw new Error("corrupt");
      const identity = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await this.fs.bytes(this.fs.path("namespaces", dir.name, "identity.json"), 4096))) as { sourceKey?: unknown; formatVersion?: unknown };
      if (identity.formatVersion !== 1) throw new Error("unsupported-format");
      if (typeof identity.sourceKey !== "string") throw new Error("identity-mismatch");
      const ns = await this.ns(identity.sourceKey); if (ns.hash !== dir.name) throw new Error("identity-mismatch");
    }
    if(this.blockedSources.size)throw new Error("recovery-blocked");
  }
  private ns(source: string): Promise<Namespace> {
    let pending = this.namespaces.get(source);
    if (!pending) {
      pending = Namespace.open(this.fs, source).then(async ns => {
        try {
          const scanned=await scanNamespace(ns,this.fs.profile.hostEpoch);this.quota.restore(source,scanned.totals);
          if(scanned.problems.length)this.blockedSources.set(source,scanned.problems[0]!);
        }catch(e){this.blockedSources.set(source,e instanceof Error?e.message:"corrupt");}
        return ns;
      }); this.namespaces.set(source, pending);
    }
    return pending;
  }
  private targetKey(t: PublicationTicket): string { return JSON.stringify([t.owner.sourceKey, t.target.kind, t.target.kind === "record" ? t.target.id : t.target.kind === "settings" ? "settings" : t.target.key]); }
  private releaseTarget(t: PublicationTicket): void { const key = this.targetKey(t); if (this.targets.get(key) === t.id) this.targets.delete(key); }
  private admitted(t: PublicationTicket): void {
    this.fs.profile.assertHeld();
    if (t.owner.hostEpoch !== this.fs.profile.hostEpoch || (!this.finalAdmissions.has(t.id) && !this.recoveryDocuments.has(t.id) && (this.frozen.has(ownerKey(t.owner)) || (t.target.kind === "record" && this.frozenTargets.has(JSON.stringify([ownerKey(t.owner), t.target.id])))))) throw new Error("stale");
    if(this.blockedSources.has(t.owner.sourceKey))throw new Error(this.blockedSources.get(t.owner.sourceKey));
    if (this.uncertain.has(t.owner.sourceKey)) throw new Error("publish-uncertain");
  }
  private entry(t: PublicationTicket): Entry {
    this.fs.profile.assertHeld();
    const e = this.entries.get(t.id); if (!e || e.signature !== JSON.stringify(t)) throw new Error("stale");
    if (e.finished !== null && e.finished + 120000 <= this.fs.now() && (e.cleaned || e.state === "aborted")) { this.forgetEntry(t.id,e); throw new Error("stale"); }
    return e;
  }
  private live(e: Entry, gate = e.gate): void {
    if (e.state === "aborted" || this.fs.now() >= Math.min(e.created + 120000, e.progress + 30000, gate.deadline)) throw new Error("expired");
  }
  private cas(t: PublicationTicket, head: DiskHead | null): void {
    if (t.target.kind === "record" || t.target.kind === "settings") {
      if ((head?.receipt.revision ?? null) !== t.target.expectedRevision) throw new Error("revision-mismatch");
    }
  }
  private forgetEntry(id:string,e:Entry):void {
    if(e.state!=="committed" && e.state!=="aborted")return;
    // Retain a second bounded window for barriers captured before live-entry expiry.
    this.tombstones.set(id,{signature:e.signature,disposition:e.state,until:this.fs.now()+120000});
    while(this.tombstones.size>1024)this.tombstones.delete(this.tombstones.keys().next().value!);
    this.entries.delete(id);
  }
  private async prune(): Promise<void> {
    const now = this.fs.now();
    for(const [id,t] of this.tombstones)if(t.until<=now)this.tombstones.delete(id);
    for (const failed of this.failedReserves.values()) await this.abort(failed.ticket).catch(() => {});
    for (const [id, e] of this.entries) if (e.finished !== null && e.finished + 120000 <= now && !e.busy && (e.cleaned || e.state === "aborted")) this.forgetEntry(id,e);
    for (const [id, pin] of this.pins) if (now >= Math.min(pin.created + 120000, pin.used + 30000, pin.expires ?? Infinity)) await this.closePin(id, pin);
    for (const [id, c] of this.closed) if (c.until <= now) this.closed.delete(id);
    for (const page of this.pages) if (now >= Math.min(page.created + 120000, page.used + 30000)) {
      this.pages.delete(page); for (const token of page.tokens.values()) this.cursors.delete(token);
    }
    for (const e of this.entries.values()) if ((e.state === "receiving" || e.state === "sealed") && !e.busy && now >= Math.min(e.created + 120000, e.progress + 30000, e.retained ? Infinity : e.gate.deadline)) await this.abort(e.ticket);
  }
  private async checkImportAdmission(ticket:PublicationTicket):Promise<void> {
    if(ticket.target.kind!=="record" && ticket.target.kind!=="settings")return;
    const ns=await this.ns(ticket.owner.sourceKey);let blocked=false,associated=false;
    for(const loc of await ns.locations()) {
      const head=await ns.head(loc);if(head?.target.kind!=="import")continue;
      if(!head.target.key.startsWith("import/") && !head.target.key.startsWith("barrier/"))continue;
      await ns.verify(loc,head);const bytes=await this.fs.bytes(ns.object(loc,head),2097152);
      if(head.target.key.startsWith("barrier/")) {
        const barrier=parseBarrierDocument(bytes);if(barrier.sourceKey!==ns.sourceKey)throw new Error("evidence-binding");
        if(barrier.state==="active")blocked=true;
      } else {
        const saved=importDocumentSchema.parse(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)));
        if(saved.plan.targetSourceKey!==ns.sourceKey || saved.plan.id!==head.target.key)throw new Error("evidence-binding");
        if(!saved.complete) {
          blocked=true;
          if(saved.items.some(e=>e.state==="pending" && sameImportValue(e.publicationTicket,ticket)))associated=true;
        }
      }
    }
    if(blocked && !associated)throw new Error("import-pending");
  }
  recordUnadmittedReserve(ticket:PublicationTicket):void {
      if(!this.entries.has(ticket.id) && !this.failedReserves.has(ticket.id) && !this.tombstones.has(ticket.id)) {
        this.tombstones.set(ticket.id,{signature:JSON.stringify(ticket),disposition:"aborted",until:this.fs.now()+120000});
        while(this.tombstones.size>1024)this.tombstones.delete(this.tombstones.keys().next().value!);
      }
  }
  private async ownsCheckpoint(owner:PersistenceOwner,checkpoint:string,recordId:string):Promise<boolean> {
    if([...this.entries.values()].some(e=>e.state==="committed" && e.ticket.target.kind==="recovery" &&
      e.ticket.target.key===checkpoint && ownerKey(e.ticket.owner)===ownerKey(owner)))return true;
    const retained=await this.loadRecovery(checkpointRecoveryId(checkpoint));
    return !!retained && ownerKey(retained.owner)===ownerKey(owner) && retained.report.records.some(r=>r.id===recordId);
  }
  async reserveFinal(ticket: PublicationTicket, byteLength: number, grant: FinalWriteGrant, memory?: SharedArrayBuffer, byteOffset=0): Promise<void> {
    const identity=JSON.stringify([ownerKey(ticket.owner),grant.checkpoint]);
    const deadline=Math.min(grant.deadlineMonotonicMs,
      this.frozen.get(ownerKey(ticket.owner)) ?? Infinity,
      this.frozenTargets.get(JSON.stringify([ownerKey(ticket.owner),grant.recordId])) ?? Infinity,
      grant.deviceDrain?.expiresMonotonicMs ?? Infinity);
    if(ownerKey(grant.owner)!==ownerKey(ticket.owner) || ticket.target.kind!=="record" ||
      ticket.target.id!==grant.recordId || ticket.target.expectedRevision===null ||
      ticket.metadata.kind!=="record" || ticket.metadata.deleted || ticket.metadata.record.checkpoint!=="final" ||
      this.finalConsumed.has(identity) || this.fs.now()>=deadline || !uuid.safeParse(grant.token).success ||
      (!this.frozen.has(ownerKey(ticket.owner)) && !this.frozenTargets.has(JSON.stringify([ownerKey(ticket.owner),grant.recordId]))))throw new Error("stale");
    const bytes=await this.auxiliary(ticket.owner,"recovery",grant.checkpoint);
    if(!bytes)throw new Error("stale");
    const document=checkpointDocumentSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
    const ns=await this.ns(ticket.owner.sourceKey),loc=await ns.location({kind:"recovery",key:grant.checkpoint});
    // Registration identity is preserved by the original metadata publication intent/head.
    if(document.checkpoint!==grant.checkpoint || document.record.id!==grant.recordId || document.state!=="open" ||
      (document.binding && (ownerKey(document.binding.owner)!==ownerKey(ticket.owner) ||
        !grant.deviceDrain || ownerKey(grant.deviceDrain.owner)!==ownerKey(ticket.owner) ||
        grant.deviceDrain.reservationId!==document.binding.reservationId)))throw new Error("stale");
    if(!await ns.head(loc) || !await this.ownsCheckpoint(ticket.owner,grant.checkpoint,grant.recordId))throw new Error("stale");
    if(this.finalConsumed.has(identity) || this.fs.now()>=deadline)throw new Error("stale");
    this.finalConsumed.add(identity);this.finalAdmissions.set(ticket.id,{...structuredClone(grant),deadlineMonotonicMs:deadline});
    try {
      await this.reserve(ticket,byteLength,memory,byteOffset);
      this.entry(ticket).gate.shorten(deadline,this.fs.now());
    } finally { this.finalAdmissions.delete(ticket.id); }
  }
  async retainSealed(ticket: PublicationTicket): Promise<SealedPayloadPin> {
    const e=this.entry(ticket),expiresMonotonicMs=Math.min(e.created+120000,e.progress+30000);
    if(e.state!=="sealed" || e.busy || e.gate.dispatched || e.received!==e.size || this.fs.now()>=expiresMonotonicMs)throw new Error("incomplete");
    if(e.retained && this.pins.has(e.retained.pin))return {...e.retained};
    if([...this.pins.values()].filter(p=>p.source===ticket.owner.sourceKey).length>=4)throw new Error("quota");
    e.busy=true;
    try {
      const path=e.object??e.temp,fd=await this.fs.open(path,"read"),pin=randomUUID();
      this.quota.holdTemporary(ticket.owner.sourceKey,this.fs.name(path),e.size);
      this.pins.set(pin,{owner:ownerKey(ticket.owner),source:ticket.owner.sourceKey,ns:e.ns,path,fd,length:e.size,
        created:e.created,used:e.progress,busy:Promise.resolve(),ticket:ticket.id,expires:expiresMonotonicMs});
      e.retained={pin,expiresMonotonicMs};return {...e.retained};
    } finally {e.busy=false;}
  }
  retainedSealed(ticket: PublicationTicket): boolean {
    const e=this.entries.get(ticket.id);
    return !!e && e.signature===JSON.stringify(ticket) && !!e.retained && this.pins.has(e.retained.pin) &&
      this.fs.now()<e.retained.expiresMonotonicMs && e.state==="sealed" && !e.gate.dispatched && !e.recoveryGate?.dispatched;
  }
  async publishRecovery(ticket: PublicationTicket, pin: string, deadline: number): Promise<Outcome> {
    const e=this.entry(ticket),p=this.pins.get(pin);
    if(!p || p.ticket!==ticket.id || p.owner!==ownerKey(ticket.owner) || e.retained?.pin!==pin ||
      !this.retainedSealed(ticket) || e.busy)throw new Error("stale");
    const gate=new PublicationGate(Math.min(deadline,this.fs.now()+10000,e.retained.expiresMonotonicMs));
    const previous=this.publication.get(ticket.owner.sourceKey)??Promise.resolve();
    const run=previous.catch(()=>{}).then(()=>{
      if(!this.retainedSealed(ticket) || e.busy)throw new Error("stale");
      e.recoveryGate=gate;return this.publishOne(e,gate);
    });
    this.publication.set(ticket.owner.sourceKey,run);return run;
  }
  async reserve(ticket: PublicationTicket, byteLength: number, memory?: SharedArrayBuffer, byteOffset=0): Promise<void> {
    try {await this.reserveOne(ticket,byteLength,memory,byteOffset);}catch(error) {
      this.recordUnadmittedReserve(ticket);
      throw error;
    }
  }
  private async reserveOne(ticket: PublicationTicket, byteLength: number, memory?: SharedArrayBuffer, byteOffset=0): Promise<void> {
    await this.prune(); this.admitted(ticket);await this.checkImportAdmission(ticket);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > (ticket.metadata.kind === "record" ? 8388608 : ticket.metadata.kind === "settings" ? 69632 : 2097152)) throw new Error("size-limit");
    if (this.entries.has(ticket.id) || this.failedReserves.has(ticket.id) || this.entries.size + this.failedReserves.size >= 1024 || [...this.entries.values()].filter(e => e.ticket.owner.sourceKey === ticket.owner.sourceKey).length >= 64) throw new Error("quota");
    if (ticket.metadata.kind !== ticket.target.kind) throw new Error("invalid-target");
    const targetKey = this.targetKey(ticket); if (ticket.target.kind !== "settings" && this.targets.has(targetKey)) throw new Error("write-in-progress");
    if (ticket.target.kind !== "settings") this.targets.set(targetKey, ticket.id);
    let held: { source: string; key: string } | null = null;
    let opened: StoreFd | null = null; let allocated: Namespace | null = null;
    try {
      const ns = await this.ns(ticket.owner.sourceKey), location = await ns.location(ticket.target, true), old = await ns.head(location);
      this.admitted(ticket); this.cas(ticket, old);
      if (old) { await ns.verify(location, old); if (old.object) { const key = this.fs.name(ns.object(location, old)); this.quota.holdTemporary(ticket.owner.sourceKey, key, old.byteLength); held = { source: ticket.owner.sourceKey, key }; } }
      await this.fs.at("reserve", async () => { this.quota.reserve(ticket.id, ticket.owner.sourceKey, { bytes: ticket.metadata.kind === "record" ? byteLength : 0, create: ticket.target.kind === "record" && old === null, metadata: 32768 + (ticket.metadata.kind === "record" ? 0 : byteLength), lane: ticket.metadata.kind === "record" ? "write" : "metadata" }, (await this.fs.statfs(ns.path())).availableBytes); });
      allocated = ns; await this.fs.mkdir(ns.path("staging", ticket.id));
      await ns.writeNew(ns.path("staging", ticket.id, "intent.json"), { formatVersion: 1, ticket, byteLength, predecessor: old });
      const temp = ns.path("staging", ticket.id, "payload.tmp");
      await this.fs.at("open-temp", async () => { opened = await this.fs.open(temp, "create-exclusive"); });
      const fd = opened;
      const frozen = JSON.parse(JSON.stringify(ticket)) as PublicationTicket;
      this.admitted(ticket);
      this.entries.set(ticket.id, { ticket: frozen, signature: JSON.stringify(ticket), ns, location, old, size: byteLength, fd, temp, object: null,
        gate: new PublicationGate(ticket.deadlineMonotonicMs, memory, byteOffset), hash: createHash("sha256"), received: 0, last: null, created: this.fs.now(), progress: this.fs.now(), state: "receiving", busy: false, head: null, accounted: false, finished: null, oldHeld: held !== null, cleaned: false });
    } catch (e) {
      if (opened) await this.fs.close(opened).catch(() => {});
      let clean = true;
      if (allocated) for (const name of ["payload.tmp", "sealed.json", "import-tag.json", "publication.json", "intent.json"]) {
        const p = allocated.path("staging", ticket.id, name);
        try { if (await this.fs.exists(p)) await this.fs.unlink(p); } catch { clean = false; }
      }
      if (clean && allocated) { try { await this.fs.removeEmpty(allocated.path("staging", ticket.id)); } catch { clean = false; } }
      if (clean) { this.releaseTarget(ticket); this.quota.release(ticket.id); }
      else this.failedReserves.set(ticket.id, { ticket: structuredClone(ticket), ns: allocated! });
      if (held) this.quota.releaseTemporary(held.source, held.key); throw e;
    }
  }
  async append(ticket: PublicationTicket, offset: number, bytes: Uint8Array): Promise<number> {
    const e = this.entry(ticket); this.live(e);
    if (e.state !== "receiving" || e.busy) throw new Error("sealed");
    if (bytes.length < 1 || bytes.length > 262144) throw new Error("size-limit");
    if (e.last && offset === e.last.offset && Buffer.from(bytes).equals(Buffer.from(e.last.bytes))) return e.received;
    if (offset !== e.received || offset + bytes.length > e.size) throw new Error("offset-mismatch");
    e.busy = true;
    try {
      this.live(e);
      await this.fs.at("chunk-write", () => writeAll(this.fs, e.fd!, offset, bytes)); e.hash.update(bytes); e.received += bytes.length;
      e.last = { offset, bytes: Uint8Array.from(bytes) }; e.progress = this.fs.now(); return e.received;
    } finally { e.busy = false; }
  }
  async seal(ticket: PublicationTicket, byteLength: number, sha256: string): Promise<void> {
    const e = this.entry(ticket); this.live(e); if (e.state === "sealed") { if (byteLength !== e.size || e.hash.copy().digest("hex") !== sha256) throw new Error("checksum-mismatch"); return; }
    if (e.state !== "receiving" || e.busy) throw new Error("sealed");
    if (byteLength !== e.size || e.received !== e.size) throw new Error("incomplete");
    if (e.hash.copy().digest("hex") !== sha256) throw new Error("checksum-mismatch");
    e.busy = true;
    try {
      await this.fs.at("seal-sync", () => this.fs.sync(e.fd!)); await this.fs.close(e.fd!); e.fd = null; e.state = "sealed";
      await e.ns.writeNew(e.ns.path("staging", ticket.id, "sealed.json"), { formatVersion: 1, byteLength, sha256 });
      await this.fs.syncDirectory(e.ns.path("staging", ticket.id)); e.state = "sealed"; e.progress = this.fs.now(); e.last = null;
    } finally { e.busy = false; }
  }
  fence(owner: PersistenceOwner, deadlineMonotonicMs: number): readonly Handle[] {
    const key = ownerKey(owner), deadline = Math.min(this.frozen.get(key) ?? Infinity, deadlineMonotonicMs); this.frozen.set(key, deadline);
    const accepted: string[] = [];
    for (const e of this.entries.values()) if (ownerKey(e.ticket.owner) === key && e.finished === null) { e.gate.shorten(deadline, this.fs.now()); accepted.push(e.ticket.id); }
    return Object.freeze(accepted);
  }
  fenceTarget(owner: PersistenceOwner, id: RecordId, deadlineMonotonicMs: number): readonly Handle[] {
    const key = JSON.stringify([ownerKey(owner), id]), deadline = Math.min(this.frozenTargets.get(key) ?? Infinity, deadlineMonotonicMs); this.frozenTargets.set(key, deadline);
    const accepted: string[] = [];
    for (const e of this.entries.values()) if (ownerKey(e.ticket.owner) === ownerKey(owner) && e.ticket.target.kind === "record" && e.ticket.target.id === id && e.finished === null) { e.gate.shorten(deadline, this.fs.now()); accepted.push(e.ticket.id); }
    return Object.freeze(accepted);
  }
  async publish(ticket: PublicationTicket): Promise<Outcome> {
    const e = this.entry(ticket);
    if (e.state === "committed") return { disposition: "committed", receipt: e.head!.receipt };
    if (e.state === "unknown" || e.state === "publishing") return this.reconcile(ticket);
    const previous = this.publication.get(ticket.owner.sourceKey) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => this.publishOne(e)); this.publication.set(ticket.owner.sourceKey, run);
    return run;
  }
  private async publishOne(e: Entry, gate = e.gate): Promise<Outcome> {
    if (e.state !== "sealed") return { disposition: "not-committed" };
    try { this.live(e,gate); } catch { return { disposition: "not-committed" }; }
    if (this.uncertain.has(e.ticket.owner.sourceKey)) return { disposition: "unknown" };
    e.busy = true;
    try {
      const { ticket: t, ns, location: loc } = e;
      const revision = t.metadata.kind === "record" ? t.metadata.record.revision : "r_" + randomUUID().replaceAll("-", "");
      const deleted = t.metadata.kind === "record" && t.metadata.deleted;
      if (!e.head) e.head = { formatVersion: 1, metadata: t.metadata, target: t.target, object: deleted ? null : `${revision}.${t.metadata.kind === "record" ? "bin" : "json"}`,
        byteLength: e.size, sha256: e.hash.copy().digest("hex"), receipt: { revision, commitId: e.tag ? t.id : randomUUID(), durability: this.fs.durability }, ...(e.tag ? { importTag: e.tag } : {}) };
      parseHead(Buffer.from(JSON.stringify(e.head)));
      if (!deleted && !e.object) {
        this.live(e,gate);
        const destination = ns.object(loc, e.head);
        if (await this.fs.exists(destination)) throw new Error("revision-mismatch");
        await this.fs.at("object-rename", async () => { await this.fs.atomicReplace(e.temp, destination); e.object = destination;
          for(const pin of this.pins.values())if(pin.ticket===t.id) {
            const oldKey=this.fs.name(pin.path);pin.path=destination;
            this.quota.releaseTemporary(pin.source,oldKey);
            this.quota.holdTemporary(pin.source,this.fs.name(destination),pin.length);
          } });
        await this.fs.at("object-dir-sync", async () => { await this.fs.syncDirectory(loc.objects); await this.fs.syncDirectory(ns.path("staging", t.id)); });
      }
      this.live(e,gate); const current = await ns.head(loc); this.cas(t, current);
      if (current) {
        await this.fs.at("backup-head", async () => {
        const backup = ns.path(...loc.parts, `${loc.name}.${t.id}.backup`);
        if (await this.fs.exists(backup)) await this.fs.unlink(backup);
        await ns.writeNew(backup, current); await this.fs.atomicReplace(backup, loc.previous); await this.fs.syncDirectory(loc.directory); });
      }
      const headTemp = ns.path(...loc.parts, `${loc.name === "head.json" ? "head" : loc.name}.${t.id}.tmp`);
      if (await this.fs.exists(headTemp)) await this.fs.unlink(headTemp);
      await this.fs.at("head-write", () => ns.writeNew(headTemp, e.head));
      if(t.target.kind==="import") {
        const candidate=ns.path("staging",t.id,"publication.json");
        if(!await this.fs.exists(candidate))await ns.writeNew(candidate,e.head);
        else if(!sameImportValue(parseHead(await this.fs.bytes(candidate,8192)),e.head))throw new Error("input-changed");
        await this.fs.syncDirectory(ns.path("staging",t.id));
      }
      await this.fs.fault("before-publish"); this.live(e,gate); this.cas(t, await ns.head(loc));
      this.fs.profile.assertHeld();
      if (!gate.dispatch(this.fs.now())) return { disposition: "not-committed" };
      e.state = "publishing"; this.uncertain.set(t.owner.sourceKey, t.id);
      if (t.metadata.kind === "import") await this.fs.at("import-marker", () => this.fs.atomicReplace(headTemp, loc.head));
      else await this.fs.atomicReplace(headTemp, loc.head);
      await this.fs.fault("after-publish"); await this.fs.at("head-dir-sync", () => this.fs.syncDirectory(loc.directory));
      await this.fs.at("cache-publish", async () => { this.confirm(e); });
      await this.cleanup(e, true).catch(() => { /* Committed receipt survives; referenced bytes keep their charge. */ });
      await this.fs.fault("receipt-send"); return { disposition: "committed", receipt: e.head.receipt };
    } catch (error) {
      if (gate.dispatched) { e.state = "unknown"; this.uncertain.set(e.ticket.owner.sourceKey, e.ticket.id); return { disposition: "unknown" }; }
      throw error;
    } finally { e.busy = false; }
  }
  private confirm(e: Entry): void {
    if (!e.accounted) {
      const oldRecord = liveRecord(e.old), nextRecord = liveRecord(e.head);
      const size = (h: DiskHead | null) => h ? Buffer.byteLength(JSON.stringify(h)) + (h.metadata.kind === "record" ? 0 : h.byteLength) : 0;
      this.quota.commit(e.ticket.id, { committed: (nextRecord?.byteLength ?? 0) - (oldRecord?.byteLength ?? 0), records: Number(nextRecord !== null) - Number(oldRecord !== null), metadata: size(e.head) - size(e.old) + 32768, temporary: 0 }); e.accounted = true;
    }
    e.state = "committed"; e.finished ??= this.fs.now(); this.uncertain.delete(e.ticket.owner.sourceKey); this.releaseTarget(e.ticket);
  }
  async reconcile(ticket: PublicationTicket): Promise<Outcome> {
    const e = this.entry(ticket);
    if(!e.busy && e.state==="committed")return {disposition:"committed",receipt:e.head!.receipt};
    if(e.state==="aborted")return {disposition:"not-committed"};
    if (e.busy && (e.gate.dispatched || e.recoveryGate?.dispatched)) return { disposition: "unknown" };
    if (!(e.gate.dispatched || e.recoveryGate?.dispatched)) return { disposition: "not-committed" };
    try {
      const current = await e.ns.head(e.location);
      if (current && e.head && current.receipt.commitId === e.head.receipt.commitId) {
        await e.ns.verify(e.location, current); await this.fs.syncDirectory(e.location.directory); this.confirm(e);
        return { disposition: "committed", receipt: current.receipt };
      }
      if ((current?.receipt.commitId ?? null) === (e.old?.receipt.commitId ?? null)) {
        if (current) await e.ns.verify(e.location, current);
        this.uncertain.delete(e.ticket.owner.sourceKey); e.state = "sealed";
        await this.abortKnownUnpublished(e); return { disposition: "not-committed" };
      }
    } catch { /* Evidence remains fenced. Permission failures are not corruption repair. */ }
    this.uncertain.set(ticket.owner.sourceKey, ticket.id); return { disposition: "unknown" };
  }
  async abort(ticket: PublicationTicket): Promise<"aborted" | "committed" | "unknown"> {
    const failed = this.failedReserves.get(ticket.id);
    if (failed) {
      if (JSON.stringify(ticket) !== JSON.stringify(failed.ticket)) throw new Error("stale");
      for (const name of ["payload.tmp", "sealed.json", "import-tag.json", "publication.json", "intent.json"]) { const p = failed.ns.path("staging", ticket.id, name); if (await this.fs.exists(p)) await this.fs.unlink(p); }
      await this.fs.removeEmpty(failed.ns.path("staging", ticket.id));
      this.quota.release(ticket.id); this.releaseTarget(ticket); this.failedReserves.delete(ticket.id);
      for(const [identity,write] of this.documentWrites)if(write.ticket.id===ticket.id)this.documentWrites.delete(identity);
      this.tombstones.set(ticket.id,{signature:JSON.stringify(ticket),disposition:"aborted",until:this.fs.now()+120000});
      while(this.tombstones.size>1024)this.tombstones.delete(this.tombstones.keys().next().value!);
      return "aborted";
    }
    const e = this.entry(ticket);
    if (e.state === "committed" && !e.busy) return "committed";
    if (e.state === "aborted") return "aborted";
    e.gate.shorten(this.fs.now(), this.fs.now());
    e.recoveryGate?.shorten(this.fs.now(), this.fs.now());
    if (e.busy) return "unknown";
    if ((e.gate.dispatched || e.recoveryGate?.dispatched)) {
      const result = await this.reconcile(ticket); if (result.disposition === "committed") return "committed"; if (result.disposition === "unknown") return "unknown";
    }
    await this.abortKnownUnpublished(e); return "aborted";
  }
  private async abortKnownUnpublished(e: Entry): Promise<void> {
    const prior = this.publication.get(e.ticket.owner.sourceKey) ?? Promise.resolve();
    const cleanup = prior.catch(() => {}).then(() => this.removeUnpublished(e));
    this.publication.set(e.ticket.owner.sourceKey, cleanup); await cleanup;
  }
  private async removeUnpublished(e: Entry): Promise<void> {
    if (e.fd) { await this.fs.close(e.fd); e.fd = null; }
    // Release reservations only after bytes have been removed; an unlink failure keeps the slot.
    for (const p of [e.temp, e.object, e.ns.path(...e.location.parts, `${e.location.name === "head.json" ? "head" : e.location.name}.${e.ticket.id}.tmp`), e.ns.path(...e.location.parts, `${e.location.name}.${e.ticket.id}.backup`), e.ns.path("staging", e.ticket.id, "sealed.json"), e.ns.path("staging", e.ticket.id, "import-tag.json"), e.ns.path("staging", e.ticket.id, "publication.json"), e.ns.path("staging", e.ticket.id, "intent.json")]) if (p && await this.fs.exists(p)) await this.fs.unlink(p);
    const current = await e.ns.head(e.location);
    if (current?.receipt.commitId === e.old?.receipt.commitId && await this.fs.exists(e.location.previous)) {
      const backup = parseHead(await this.fs.bytes(e.location.previous, 8192));
      if (backup.receipt.commitId === current?.receipt.commitId) await this.fs.unlink(e.location.previous);
    }
    await this.fs.removeEmpty(e.ns.path("staging", e.ticket.id));
    this.quota.release(e.ticket.id); this.releaseOld(e); e.state = "aborted"; e.finished ??= this.fs.now(); this.releaseTarget(e.ticket);
  }
  private releaseOld(e: Entry): void {
    if (e.oldHeld && e.old?.object) { this.quota.releaseTemporary(e.ticket.owner.sourceKey, this.fs.name(e.ns.object(e.location, e.old))); e.oldHeld = false; }
  }
  private async cleanup(e: Entry, serialized = false): Promise<void> {
    if (!serialized) {
      const prior = this.publication.get(e.ticket.owner.sourceKey) ?? Promise.resolve();
      const cleanup = prior.catch(() => {}).then(() => this.cleanup(e, true));
      this.publication.set(e.ticket.owner.sourceKey, cleanup); await cleanup; return;
    }
    if (e.cleaned) return;
    await this.fs.at("cleanup", async () => {
    if ((await e.ns.head(e.location))?.receipt.commitId === e.head?.receipt.commitId && await this.fs.exists(e.location.previous)) await this.fs.unlink(e.location.previous);
    for (const name of ["payload.tmp", "sealed.json", "import-tag.json", "publication.json", "intent.json"]) { const p = e.ns.path("staging", e.ticket.id, name); if (await this.fs.exists(p)) await this.fs.unlink(p); }
    if (e.old?.object) {
      const p = e.ns.object(e.location, e.old), key = this.fs.name(p);
      if ([...this.pins.values()].some(pin => this.fs.name(pin.path) === key)) { this.gcHeld.set(key, { source: e.ticket.owner.sourceKey, key }); e.oldHeld = false; }
      else { if (await this.fs.exists(p)) await this.fs.unlink(p); this.releaseOld(e); }
    }
    await this.fs.removeEmpty(e.ns.path("staging", e.ticket.id));
    await this.fs.syncDirectory(e.location.directory);
    });
    this.quota.adjustMetadata(e.ticket.owner.sourceKey, -32768); e.cleaned = true;
  }
  private async settled(owner: PersistenceOwner): Promise<Namespace> {
    if (owner.hostEpoch !== this.fs.profile.hostEpoch) throw new Error("stale");
    await this.prune(); const id = this.uncertain.get(owner.sourceKey);
    if (id) { const e = this.entries.get(id)!; if ((await this.reconcile(e.ticket)).disposition === "unknown") throw new Error("publish-uncertain"); }
    return this.ns(owner.sourceKey);
  }
  async settings(owner: PersistenceOwner): Promise<SettingsSnapshot | null> {
    const ns = await this.settled(owner), loc = await ns.location({ kind: "settings", expectedRevision: null }), head = await ns.head(loc);
    if (!head) return null; await ns.verify(loc, head);
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await this.fs.bytes(ns.object(loc, head), 69632))) as { formatVersion: number; schemaVersion: number; validationDigest: string; values: SettingsSnapshot["values"] };
    if (body.formatVersion !== 1) throw new Error("unsupported-format");
    if (head.metadata.kind !== "settings" || body.schemaVersion !== head.metadata.schemaVersion || body.validationDigest !== head.metadata.validationDigest || Buffer.byteLength(JSON.stringify(body.values)) > 65536) throw new Error("corrupt");
    return { schemaVersion: body.schemaVersion, revision: head.receipt.revision, values: body.values };
  }
  async stat(owner: PersistenceOwner, id: RecordId): Promise<RecordMeta> {
    const ns = await this.settled(owner), loc = await ns.location({ kind: "record", id, expectedRevision: null }), head = await ns.head(loc), record = liveRecord(head);
    if (!head || !record) throw new Error("not-found"); await ns.verify(loc, head); return structuredClone(record);
  }
  async open(owner: PersistenceOwner, id: RecordId, revision: RecordRevision): Promise<Handle> {
    const ns = await this.settled(owner);
    if ([...this.pins.values()].filter(p => p.source === owner.sourceKey).length >= 4) throw new Error("quota");
    const loc = await ns.location({ kind: "record", id, expectedRevision: revision }), head = await ns.head(loc);
    if (!liveRecord(head) || !head) throw new Error("not-found"); if (head.receipt.revision !== revision) throw new Error("revision-mismatch");
    await ns.verify(loc, head); const p = ns.object(loc, head), key = this.fs.name(p); this.quota.holdTemporary(owner.sourceKey, key, head.byteLength);
    try { const fd = await this.fs.open(p, "read"), pin = randomUUID(); this.pins.set(pin, { owner: ownerKey(owner), source: owner.sourceKey, ns, path: p, fd, length: head.byteLength, created: this.fs.now(), used: this.fs.now(), busy: Promise.resolve() }); return pin; }
    catch (e) { this.quota.releaseTemporary(owner.sourceKey, key); throw e; }
  }
  async read(owner: PersistenceOwner, pin: Handle, offset: number, maxBytes: number): Promise<Uint8Array> {
    await this.prune(); const p = this.pins.get(pin); if (!p || p.owner !== ownerKey(owner)) throw new Error("stale");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > p.length || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 262144) throw new Error("invalid-range");
    const work = p.busy.catch(() => {}).then(async () => { p.used = this.fs.now(); return offset === p.length ? new Uint8Array() : this.fs.read(p.fd, offset, Math.min(maxBytes, p.length - offset)); });
    p.busy = work; return work;
  }
  private async closePin(id: string, p: Pin): Promise<void> {
    this.pins.delete(id); await p.busy.catch(() => {}); await this.fs.close(p.fd);
    const key = this.fs.name(p.path); this.quota.releaseTemporary(p.source, key);
    if (![...this.pins.values()].some(pin => this.fs.name(pin.path) === key) && this.gcHeld.has(key)) {
      try { await this.fs.unlink(p.path); this.quota.releaseTemporary(p.source, key); this.gcHeld.delete(key); } catch { /* Charge and retry evidence stay retained. */ }
    }
    if (this.closed.size < 1024 && [...this.closed.values()].filter(c => c.owner === p.owner).length < 64) this.closed.set(id, { owner: p.owner, until: this.fs.now() + 120000 });
  }
  async close(owner: PersistenceOwner, pin: Handle): Promise<void> {
    const p = this.pins.get(pin);
    if (!p) { const old = this.closed.get(pin); if (old?.owner === ownerKey(owner) && old.until > this.fs.now()) return; throw new Error("stale"); }
    if (p.owner !== ownerKey(owner)) throw new Error("stale"); await this.closePin(pin, p);
  }
  async list(owner: PersistenceOwner, input: { kind?: string; limit: number; cursor?: Handle }): Promise<{ entries: RecordMeta[]; nextCursor?: Handle }> {
    const ns = await this.settled(owner); if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 64) throw new Error("invalid-range");
    let page: Page, offset = 0;
    if (input.cursor) {
      const cursor = this.cursors.get(input.cursor); if (!cursor || cursor.page.owner !== ownerKey(owner) || cursor.page.kind !== input.kind || cursor.page.limit !== input.limit) throw new Error("stale");
      page = cursor.page; offset = cursor.offset;
    } else {
      if ([...this.pages].filter(p => p.source === owner.sourceKey).length >= 4) throw new Error("quota");
      const entries: RecordMeta[] = [];
      for (const loc of await ns.locations()) { const r = liveRecord(await ns.head(loc)); if (r && (input.kind === undefined || input.kind === r.kind)) entries.push(structuredClone(r)); }
      entries.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const bytes = Buffer.byteLength(JSON.stringify(entries));
      if ([...this.pages].filter(p => p.source === owner.sourceKey).reduce((n, p) => n + p.bytes, bytes) > 524288 || [...this.pages].reduce((n, p) => n + p.bytes, bytes) > 8388608) throw new Error("quota");
      page = { owner: ownerKey(owner), source: owner.sourceKey, kind: input.kind, limit: input.limit, entries, created: this.fs.now(), used: this.fs.now(), bytes, tokens: new Map() }; this.pages.add(page);
    }
    page.used = this.fs.now(); const entries = page.entries.slice(offset, offset + page.limit), next = offset + entries.length;
    if (next === page.entries.length) return { entries: structuredClone(entries) };
    let token = page.tokens.get(next); if (!token) { token = randomUUID(); page.tokens.set(next, token); this.cursors.set(token, { page, offset: next }); }
    const result = { entries: structuredClone(entries), nextCursor: token };
    if (Buffer.byteLength(JSON.stringify({ ok: true, value: result })) > 262144) throw new Error("size-limit"); return result;
  }
  async tagImport(ticket: PublicationTicket, tag: ImportTag): Promise<void> {
    const e = this.entry(ticket); this.live(e);
    if (e.state !== "receiving" || e.received !== 0 || e.busy || e.tag) throw new Error("sealed");
    e.busy=true;
    try {
      const parsed=importTagSchema.parse(tag);
      const saved=await this.loadImport(ticket.owner,parsed.importId);
      const item=saved?.plan.items.find(i=>i.key===parsed.itemKey);
      const attempt=saved?.items.find(i=>i.key===parsed.itemKey)?.publicationTicket;
      if (!item || !attempt || !sameImportValue(attempt,ticket) || !sameImportAttempt(item.ticket,ticket) || !sameImportValue(item.tag,parsed)) throw new Error("input-changed");
      // Persist the immutable binding before append can be admitted. The published head includes it.
      await e.ns.writeNew(e.ns.path("staging",ticket.id,"import-tag.json"),{formatVersion:1,tag:parsed});
      await this.fs.syncDirectory(e.ns.path("staging",ticket.id)); e.tag=parsed;
    } finally { e.busy=false; }
  }
  async importReceipts(owner:PersistenceOwner,id:string):ReturnType<DurableImportPort["importReceipts"]> {
    const saved=await this.loadImport(owner,id);if(!saved)return [];
    const ns=await this.ns(owner.sourceKey),receipts:Awaited<ReturnType<DurableImportPort["importReceipts"]>>[number][]=[];
    for(const item of saved.plan.items) {
      const evidence=saved.items.find(e=>e.key===item.key)!,attempt=evidence.publicationTicket;
      if(!attempt)continue;
      if(evidence.state==="committed" && evidence.receipt) {
        receipts.push({tag:item.tag,ticket:attempt,receipt:evidence.receipt});continue;
      }
      const loc=await ns.location(attempt.target),head=await ns.head(loc);
      if(!head?.importTag || !sameImportValue(head.importTag,item.tag))continue;
      await ns.verify(loc,head);
      if(head.receipt.commitId!==attempt.id || head.sha256!==item.mappedSha256 || head.byteLength!==item.byteLength ||
          !sameImportValue(head.metadata,attempt.metadata) || !sameImportValue(head.target,attempt.target))throw new Error("input-changed");
      await this.fs.syncDirectory(loc.directory);
      receipts.push({tag:item.tag,ticket:attempt,receipt:head.receipt});
    }
    if(Buffer.byteLength(JSON.stringify(receipts))>2097152)throw new Error("size-limit");return receipts;
  }
  async auxiliary(owner: PersistenceOwner, kind: "import" | "recovery", key: string): Promise<Uint8Array | null> {
    this.fs.profile.assertHeld();
    if(owner.hostEpoch!==this.fs.profile.hostEpoch)throw new Error("stale");
    const ns = await this.ns(owner.sourceKey), loc = await ns.location({ kind, key }), head = await ns.head(loc);
    if (!head) return null; await ns.verify(loc, head); return this.fs.bytes(ns.object(loc, head), 2097152);
  }
  private readonly importMutations=new Map<string,Promise<unknown>>();
  private mutateImport<T>(owner:PersistenceOwner,id:string,run:()=>Promise<T>):Promise<T> {
    const key=JSON.stringify([owner.sourceKey,id]),previous=this.importMutations.get(key)??Promise.resolve();
    const result=previous.catch(()=>{}).then(run);this.importMutations.set(key,result);
    void result.finally(()=>{if(this.importMutations.get(key)===result)this.importMutations.delete(key);}).catch(()=>{});return result;
  }
  planImport(owner:PersistenceOwner,plan:ImportPlan):Promise<void>{return this.mutateImport(owner,plan.id,()=>this.planImportOne(owner,plan));}
  recordImport(owner:PersistenceOwner,id:string,evidence:ImportItemEvidence):Promise<void>{return this.mutateImport(owner,id,()=>this.recordImportOne(owner,id,evidence));}
  completeImport(owner:PersistenceOwner,id:string):Promise<void>{return this.mutateImport(owner,id,()=>this.completeImportOne(owner,id));}
  private readonly documentWrites=new Map<string,{ticket:PublicationTicket;bytes:Uint8Array;result:Promise<Outcome>}>();
  private async reconcileDocument(ticket:PublicationTicket):Promise<Outcome> {
    if(this.failedReserves.has(ticket.id) && await this.abort(ticket)==="aborted")return {disposition:"not-committed"};
    const tombstone=this.tombstones.get(ticket.id);
    if(tombstone?.signature===JSON.stringify(ticket) && tombstone.disposition==="aborted")return {disposition:"not-committed"};
    return this.reconcile(ticket);
  }
  private async writeDocument(owner:PersistenceOwner,kind:"import"|"recovery",key:string,value:unknown):Promise<void> {
    const bytes=Buffer.from(JSON.stringify(value)),identity=JSON.stringify([owner.sourceKey,kind,key]);
    if(bytes.length>2097152 || Buffer.byteLength(key)>128)throw new Error("size-limit");
    if(kind==="import" && key.startsWith("import/"))importDocumentSchema.parse(value);
    const previous=this.documentWrites.get(identity);
    if(previous) {
      let result=await previous.result;
      if(result.disposition==="unknown")result=await this.reconcileDocument(previous.ticket);
      if(result.disposition==="unknown")throw new Error("publish-uncertain");
      this.documentWrites.delete(identity);
      if(result.disposition==="committed" && Buffer.from(previous.bytes).equals(bytes))return;
      if(result.disposition==="committed")throw new Error("reload-import");
    }
    const ticket:PublicationTicket={id:randomUUID(),owner:structuredClone(owner),deadlineMonotonicMs:this.fs.now()+10000,
      metadata:{kind,key},target:{kind,key}};
    if(kind==="recovery")this.recoveryDocuments.add(ticket.id);
    this.admitted(ticket);
    // Schedule only after the exact candidate is installed. A thrown write retains its identity.
    const result=Promise.resolve().then(async():Promise<Outcome>=>{
      try {
        await this.reserve(ticket,bytes.length);
        for(let offset=0;offset<bytes.length;offset+=262144)await this.append(ticket,offset,bytes.subarray(offset,offset+262144));
        await this.seal(ticket,bytes.length,createHash("sha256").update(bytes).digest("hex"));
        const outcome=await this.publish(ticket);
        return outcome.disposition==="unknown"?await this.reconcile(ticket):outcome;
      } catch {
        if(this.entries.has(ticket.id)) {
          const disposition=await this.abort(ticket);
          if(disposition!=="aborted")return this.reconcile(ticket);
        }
        if(this.failedReserves.has(ticket.id))return {disposition:"unknown"};
        return {disposition:"not-committed"};
      }
    });
    void result.finally(()=>this.recoveryDocuments.delete(ticket.id)).catch(()=>{});
    this.documentWrites.set(identity,{ticket,bytes,result});
    const outcome=await result;
    if(outcome.disposition==="unknown")throw new Error("publish-uncertain");
    this.documentWrites.delete(identity);
    if(outcome.disposition!=="committed")throw new Error("not-committed");
  }
  admitImport(owner:PersistenceOwner,id:string,key:string):Promise<PublicationTicket> {
    return this.mutateImport(owner,id,async()=>{
      this.fs.profile.assertHeld();
      if(owner.hostEpoch!==this.fs.profile.hostEpoch)throw new Error("stale");
      const identity=JSON.stringify([owner.sourceKey,"import",id]),pending=this.documentWrites.get(identity);
      if(pending) {
        let outcome=await pending.result;
        if(outcome.disposition==="unknown")outcome=await this.reconcileDocument(pending.ticket);
        if(outcome.disposition==="unknown")throw new Error("publish-uncertain");
        this.documentWrites.delete(identity);
      }
      const saved=await this.loadImport(owner,id);if(!saved || saved.complete)throw new Error("stale");
      const index=saved.plan.items.findIndex(item=>item.key===key),item=saved.plan.items[index],prior=saved.items[index];
      if(!item || !prior || prior.state==="committed" || prior.state==="skipped" ||
          owner.pluginId!==item.ticket.owner.pluginId || owner.sourceKey!==item.ticket.owner.sourceKey)throw new Error("stale");
      const old=prior.publicationTicket;
      const competing=this.targets.get(this.targetKey(item.ticket));
      if(competing && competing!==old?.id)throw new Error("write-in-progress");
      if(old && !sameImportAttempt(item.ticket,old))throw new Error("input-changed");
      if(old && this.entries.has(old.id)) {
        const live=this.entry(old);if(live.state!=="committed" && live.state!=="aborted")live.gate.shorten(this.fs.now(),this.fs.now());
        if(await this.abort(old)==="unknown")throw new Error("publish-uncertain");
      }
      const outcome=await this.reconcileImport(item.ticket);
      if(outcome.disposition==="committed") {
        if(!old || !outcome.receipt)throw new Error("unverified-receipt");
        await this.recordImportOne(owner,id,{...prior,state:"committed",receipt:outcome.receipt,skipReason:null});
        throw new Error("already-committed");
      }
      if(outcome.disposition!=="not-committed")throw new Error("publish-uncertain");
      if(old && sameImportValue(old.owner,owner) && !this.entries.has(old.id) && old.deadlineMonotonicMs>this.fs.now()) {
        this.admitted(old);return structuredClone(old);
      }
      const deadline=old?.owner.hostEpoch===owner.hostEpoch?old.deadlineMonotonicMs:this.fs.now()+10000;
      if(deadline<=this.fs.now())throw new Error("stale");
      const attempt:PublicationTicket={...structuredClone(item.ticket),id:randomUUID(),owner:structuredClone(owner),deadlineMonotonicMs:deadline};
      this.admitted(attempt);
      const items=saved.items.map((e,i)=>i===index?{...e,state:"pending" as const,receipt:null,skipReason:null,publicationTicket:attempt}:e);
      await this.writeDocument(owner,"import",id,{formatVersion:1,...saved,items});
      return structuredClone(attempt);
    });
  }
  async loadImport(owner:PersistenceOwner,id:string):ReturnType<DurableImportPort["load"]> {
    if (Buffer.byteLength(id)>128 || !id.startsWith("import/")) throw new Error("size-limit");
    const bytes=await this.auxiliary(owner,"import",id); if (!bytes) return null;
    const raw=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
    if (raw.formatVersion!==1) throw new Error("unsupported-format");
    const saved=importDocumentSchema.parse(raw);
    if (saved.plan.id!==id || saved.plan.targetSourceKey!==owner.sourceKey) throw new Error("input-changed");
    return {plan:saved.plan,items:saved.items,complete:saved.complete};
  }
  private async planImportOne(owner:PersistenceOwner,plan:ImportPlan):Promise<void> {
    importPlanSchema.parse(plan);
    if (plan.targetSourceKey!==owner.sourceKey || plan.items.some(i=>ownerKey(i.ticket.owner)!==ownerKey(owner))) throw new Error("stale");
    const old=await this.loadImport(owner,plan.id);
    if (old) { if (!sameImportValue(old.plan,plan)) throw new Error("input-changed"); return; }
    await this.writeDocument(owner,"import",plan.id,{formatVersion:1,plan,items:plan.items.map(i=>({key:i.key,state:"pending",receipt:null,skipReason:null,publicationTicket:null})),complete:false});
  }
  private async recordImportOne(owner:PersistenceOwner,id:string,evidence:ImportItemEvidence):Promise<void> {
    importItemEvidenceSchema.parse(evidence);
    const saved=await this.loadImport(owner,id); if (!saved) throw new Error("not-found");
    const index=saved.plan.items.findIndex(i=>i.key===evidence.key); if (index<0 || saved.complete) throw new Error("stale");
    if (evidence.state==="committed") {
      const receipt=(await this.importReceipts(owner,id)).find(r=>r.tag.itemKey===evidence.key);
      if (!receipt || JSON.stringify(receipt.receipt)!==JSON.stringify(evidence.receipt)) throw new Error("input-changed");
    }
    const prior=saved.items[index]!;
    if(!sameImportValue(prior.publicationTicket,evidence.publicationTicket))throw new Error("input-changed");
    if(evidence.state==="skipped") {
      const attempt=prior.publicationTicket;
      if(attempt && this.entries.has(attempt.id)) {
        this.fenceTargetOrTicket(attempt);
        if(await this.abort(attempt)!=="aborted")throw new Error("publish-uncertain");
      }
      if((await this.reconcileImport(saved.plan.items[index]!.ticket)).disposition!=="not-committed")throw new Error("publish-uncertain");
    }
    if ((prior.state==="committed" || prior.state==="skipped") && JSON.stringify(prior)!==JSON.stringify(evidence)) throw new Error("input-changed");
    const items=[...saved.items]; items[index]=evidence;
    await this.writeDocument(owner,"import",id,{formatVersion:1,...saved,items});
  }
  async reconcileImport(ticket:PublicationTicket):ReturnType<PersistenceEnginePort["reconcile"]> {
    publicationTicketSchema.parse(ticket);this.fs.profile.assertHeld();
    try {return await this.reconcileImportEvidence(ticket);}catch(error){
      if(error instanceof Error && ["stale","not-primary"].includes(error.message))throw error;
      return {disposition:"unknown"};
    }
  }
  private async reconcileImportEvidence(ticket:PublicationTicket):ReturnType<PersistenceEnginePort["reconcile"]> {
    const ns=await this.ns(ticket.owner.sourceKey);
    if(ticket.target.kind==="import") {
      const resolved=await resolvedImport(ns,ticket.id);
      if(resolved) {
        const raw=JSON.parse(Buffer.from(await this.fs.bytes(ns.path("staging",ticket.id,"intent.json"),32768)).toString("utf8"));
        if(!sameImportValue(publicationTicketSchema.parse(raw.ticket),ticket))throw new Error("stale");
        return resolved.disposition==="committed"?{disposition:"committed",receipt:resolved.receipt}:{disposition:"not-committed"};
      }
      const loc=await ns.location(ticket.target),head=await ns.head(loc);
      if(head) {
        await ns.verify(loc,head);
        const bytes=await this.fs.bytes(ns.object(loc,head),2097152);
        if(ticket.target.key.startsWith("nonce/") || ticket.target.key.startsWith("barrier/")) {
          const document=ticket.target.key.startsWith("nonce/")?parseNonceDocument(bytes):parseBarrierDocument(bytes);
          if(sameImportValue(document.ticket,ticket)) {
            await this.fs.syncDirectory(loc.directory);return {disposition:"committed",receipt:head.receipt};
          }
        }
      }
      // Live metadata uses the exact retained engine entry, including its dispatch gate.
      if(this.entries.has(ticket.id))return this.reconcile(ticket);
      const intentPath=ns.path("staging",ticket.id,"intent.json");
      if(!await this.fs.exists(intentPath))return {disposition:"unknown"};
      const raw=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await this.fs.bytes(intentPath,32768)));
      if(raw.formatVersion!==1 || Object.keys(raw).sort().join(",")!=="byteLength,formatVersion,predecessor,ticket" ||
          !sameImportValue(publicationTicketSchema.parse(raw.ticket),ticket))throw new Error("stale");
      const candidatePath=ns.path("staging",ticket.id,"publication.json");
      if(head && await this.fs.exists(candidatePath)) {
        const candidate=parseHead(await this.fs.bytes(candidatePath,8192));
        if(sameImportValue(candidate.target,ticket.target) && sameImportValue(candidate.metadata,ticket.metadata) && sameImportValue(candidate,head)) {
          await this.fs.syncDirectory(loc.directory);return {disposition:"committed",receipt:head.receipt};
        }
      }
      const predecessor=raw.predecessor===null?null:parseHead(Buffer.from(JSON.stringify(raw.predecessor)));
      if(predecessor)await ns.verify(loc,predecessor);
      if(this.blockedSources.has(ticket.owner.sourceKey) || this.uncertain.has(ticket.owner.sourceKey))return {disposition:"unknown"};
      return sameImportValue(head,predecessor)?{disposition:"not-committed"}:{disposition:"unknown"};
    }
    for(const loc of await ns.locations()) {
      const head=await ns.head(loc);
      if(head?.target.kind!=="import" || !head.target.key.startsWith("import/"))continue;
      await ns.verify(loc,head);
      const saved=importDocumentSchema.parse(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(
        await this.fs.bytes(ns.object(loc,head),2097152))));
      if(saved.plan.targetSourceKey!==ns.sourceKey || saved.plan.id!==head.target.key)throw new Error("input-changed");
      const index=saved.plan.items.findIndex((item,i)=>sameImportValue(item.ticket,ticket) ||
        sameImportValue(saved.items[i]!.publicationTicket,ticket));
      if(index<0)continue;
      const item=saved.plan.items[index]!,evidence=saved.items[index]!,attempt=evidence.publicationTicket;
      if(evidence.state==="committed" && evidence.receipt)return {disposition:"committed",receipt:evidence.receipt};
      if(attempt && this.entries.has(attempt.id)) {
        const live=await this.reconcile(attempt);
        if(live.disposition!=="not-committed")return live;
        if(this.unresolvedTicket(attempt.id))return {disposition:"unknown"};
      }
      const target=await ns.location(item.ticket.target),current=await ns.head(target);
      if(current)await ns.verify(target,current);
      if(attempt && current?.importTag && sameImportValue(current.importTag,item.tag) &&
          current.receipt.commitId===attempt.id && sameImportValue(current.metadata,attempt.metadata) &&
          sameImportValue(current.target,attempt.target) && current.sha256===item.mappedSha256 && current.byteLength===item.byteLength) {
        await this.fs.syncDirectory(target.directory);return {disposition:"committed",receipt:current.receipt};
      }
      if(this.blockedSources.has(ns.sourceKey) || this.uncertain.has(ns.sourceKey) ||
          [...this.entries.values()].some(e=>e.ticket.owner.sourceKey===ns.sourceKey &&
            (e.busy || e.state==="publishing" || e.state==="unknown")))return {disposition:"unknown"};
      if((item.ticket.target.kind==="record" || item.ticket.target.kind==="settings") &&
          (current?.receipt.revision??null)===item.ticket.target.expectedRevision)return {disposition:"not-committed"};
      return {disposition:"unknown"};
    }
    throw new Error("stale");
  }
  private async completeImportOne(owner:PersistenceOwner,id:string):Promise<void> {
    const saved=await this.loadImport(owner,id); if (!saved) throw new Error("not-found"); if (saved.complete) return;
    const receipts=await this.importReceipts(owner,id);
    const items=saved.items.map(e=>{
      const r=receipts.find(r=>r.tag.itemKey===e.key);
      return e.state==="committed" || e.state==="skipped"?e:r?{key:e.key,state:"committed" as const,receipt:r.receipt,skipReason:null,publicationTicket:r.ticket}:e;
    });
    if (items.length!==saved.plan.items.length || items.some(e=>e.state!=="committed" && e.state!=="skipped")) throw new Error("incomplete");
    await this.writeDocument(owner,"import",id,{formatVersion:1,...saved,items,complete:true});
  }
  async settingsDigest(owner:PersistenceOwner):ReturnType<PersistenceEvidencePort["settingsDigest"]> {
    const ns=await this.settled(owner),loc=await ns.location({kind:"settings",expectedRevision:null}),head=await ns.head(loc);
    if (!head) return null; await ns.verify(loc,head);
    if (head.metadata.kind!=="settings") throw new Error("corrupt");
    return {schemaVersion:head.metadata.schemaVersion,validationDigest:head.metadata.validationDigest,revision:head.receipt.revision};
  }
  private readonly evidencePages=new Map<string,{signature:string;items:string[];offset:number;expires:number}>();
  async auxiliaryKeys(owner:PersistenceOwner,kind:"import"|"recovery",cursor?:Handle):ReturnType<PersistenceEvidencePort["auxiliaryKeys"]> {
    const signature=JSON.stringify([ownerKey(owner),kind]); let page;
    if (cursor) { page=this.evidencePages.get(cursor); if (!page || page.signature!==signature || page.expires<=this.fs.now()) throw new Error("stale"); }
    else {
      const ns=await this.ns(owner.sourceKey),items:string[]=[];
      for (const loc of await ns.locations()) {const h=await ns.head(loc);if (h?.target.kind===kind && "key" in h.target) items.push(h.target.key);}
      if (items.length>512 || this.evidencePages.size>=32) throw new Error("quota");
      page={signature,items:items.sort(),offset:0,expires:this.fs.now()+30000};
    }
    const keys=page.items.slice(page.offset,page.offset+64),next=page.offset+keys.length;
    if (next===page.items.length) return {keys,nextCursor:null};
    const nextCursor=randomUUID();this.evidencePages.set(nextCursor,{...page,offset:next});return {keys,nextCursor};
  }
  async saveCheckpoint(owner:PersistenceOwner,value:CheckpointRegistration):Promise<void> {
    const document=checkpointDocumentSchema.parse({formatVersion:1,...value});
    const bytes=await this.auxiliary(owner,"recovery",value.checkpoint);
    if(!bytes)throw new Error("stale");
    const old=checkpointDocumentSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
    if(old.record.id!==document.record.id || !await this.ownsCheckpoint(owner,value.checkpoint,value.record.id))throw new Error("stale");
    await this.writeDocument(owner,"recovery",value.checkpoint,document);
  }
  async saveRecovery(value:StoredRecovery):Promise<void> {
    storedRecoverySchema.parse(value);
    if (value.ticket && ownerKey(value.ticket.owner)!==ownerKey(value.owner)) throw new Error("stale");
    if (value.sealedPin) {
      const e=value.ticket?this.entries.get(value.ticket.id):undefined;
      const pin=this.pins.get(value.sealedPin);
      if (!e || e.signature!==JSON.stringify(value.ticket) || !pin || pin.ticket!==e.ticket.id ||
        pin.owner!==ownerKey(value.owner) || e.retained?.pin!==value.sealedPin ||
        this.fs.now()>=e.retained.expiresMonotonicMs || !["sealed","publishing","unknown","committed"].includes(e.state) || e.received!==e.size) throw new Error("incomplete");
      const expiresAt=Math.min(value.expiresAt??Infinity,Date.now()+e.retained.expiresMonotonicMs-this.fs.now());
      value={...value,expiresAt,report:{...value.report,records:value.report.records.map(r=>
        r.payload==="complete-staging"?{...r,expiresAt:Math.min(r.expiresAt??Infinity,expiresAt)}:r)}};
    }
    await this.writeDocument(value.owner,"recovery",value.id,{formatVersion:1,value});
  }
  async recoveryPage(cursor?:Handle):ReturnType<PersistenceEvidencePort["recoveryPage"]> {
    const all:StoredRecovery[]=[];
    for (const pending of this.namespaces.values()) {
      const ns=await pending;
      for (const loc of await ns.locations()) {
        const head=await ns.head(loc);if (head?.target.kind!=="recovery") continue;
        await ns.verify(loc,head);
        const raw=JSON.parse(Buffer.from(await this.fs.bytes(ns.object(loc,head),2097152)).toString("utf8"));
        if (raw.formatVersion!==1) throw new Error("unsupported-format");
        if ("checkpoint" in raw) {
          const document=checkpointDocumentSchema.parse(raw);
          if(document.checkpoint!==head.target.key)throw new Error("corrupt");
          continue;
        }
        if (raw.removed===true) {
          z.strictObject({formatVersion:z.literal(1),removed:z.literal(true),id:uuid}).parse(raw);
          if(raw.id!==head.target.key)throw new Error("corrupt");continue;
        }
        z.strictObject({formatVersion:z.literal(1),value:storedRecoverySchema}).parse(raw);
        const value=storedRecoverySchema.parse(raw.value);
        if(value.id!==head.target.key || value.owner.sourceKey!==ns.sourceKey)throw new Error("corrupt");
        // Retained handles are worker capabilities, not durable UUID-based authority.
        const retained=value.sealedPin?this.pins.get(value.sealedPin):undefined;
        const entry=value.ticket?this.entries.get(value.ticket.id):undefined;
        if(value.ticket && entry && !sameImportValue(entry.ticket,value.ticket))throw new Error("stale");
        if(entry)value.ticket=structuredClone(entry.ticket);
        if(value.ticket && entry && (entry.state==="unknown" || entry.state==="publishing")) {
          const result=await this.reconcile(value.ticket);
          if(result.disposition==="unknown")value.report={...value.report,state:"uncertain",blocker:true};
        }
        if(value.sealedPin && (!retained || !entry || retained.ticket!==value.ticket?.id ||
          retained.owner!==ownerKey(value.owner) || !retained.expires || this.fs.now()>=retained.expires ||
          value.ticket?.owner.hostEpoch!==this.fs.profile.hostEpoch)) {
          value.sealedPin=null;
          value.report={...value.report,state:value.report.state==="uncertain"?"uncertain":"checkpoint-only",blocker:true,
            records:value.report.records.map(r=>({id:r.id,committedRevision:r.committedRevision,final:r.final,
              payload:r.committedRevision?"checkpoint-only":"none"}))};
        }
        if(value.ticket && value.ticket.owner.hostEpoch!==this.fs.profile.hostEpoch && value.ticket.target.kind==="record") {
          const original=value.ticket,target=original.target;
          const location=await ns.location(target),current=await ns.head(location);
          if(current)await ns.verify(location,current);
          if(original.metadata.kind==="record" && current && sameImportValue(current.metadata,original.metadata) &&
            sameImportValue(current.target,target) && current.receipt.revision===original.metadata.record.revision) {
            const record=original.metadata.record,final=record.checkpoint==="final";
            value.ticket=null;value.sealedPin=null;
            value.report={...value.report,state:record.checkpoint==="open"?"checkpoint-only":"saved",
              blocker:record.checkpoint==="open",records:[{id:record.id,committedRevision:record.revision,final,payload:"checkpoint-only"}]};
          } else if(target.kind==="record" && (current?.receipt.revision??null)===target.expectedRevision) {
            // Verified predecessor plus discarded transient staging is known unpublished, never a new retry lease.
            value.ticket=null;value.sealedPin=null;
            value.report={...value.report,state:"checkpoint-only",blocker:true};
          } else value.report={...value.report,state:"uncertain",blocker:true};
        }
        all.push(value);
      }
    }
    all.sort((a,b)=>a.id.localeCompare(b.id));
    const signature="recovery",page=cursor?this.evidencePages.get(cursor):undefined;
    if (cursor && (!page || page.signature!==signature || page.expires<=this.fs.now())) throw new Error("stale");
    const offset=page?.offset??0,items:StoredRecovery[]=[];
    for (const value of all.slice(offset,offset+64)) {if (Buffer.byteLength(JSON.stringify([...items,value]))>262144) break;items.push(value);}
    const next=offset+items.length;if (next===all.length) return {items,nextCursor:null};
    if (!items.length || this.evidencePages.size>=32) throw new Error("quota");
    const nextCursor=randomUUID();this.evidencePages.set(nextCursor,{signature,items:all.map(v=>v.id),offset:next,expires:this.fs.now()+30000});
    return {items,nextCursor};
  }
  async loadRecovery(id:Handle):Promise<StoredRecovery|null> {
    let cursor:Handle|undefined;
    do {const p=await this.recoveryPage(cursor);const found=p.items.find(v=>v.id===id);if(found)return found;cursor=p.nextCursor??undefined;}while(cursor);
    return null;
  }
  async removeRecovery(id:Handle):Promise<void> {
    const old=await this.loadRecovery(id);if(!old)return;
    await this.writeDocument({...old.owner,hostEpoch:this.fs.profile.hostEpoch},"recovery",id,{formatVersion:1,removed:true,id});
  }
  async flushEvidence(barrier:PersistenceBarrier,tickets:readonly PublicationTicket[]):Promise<PersistenceBarrierEvidence> {
    const accepted=tickets.map(t=>t.id),incomplete:Handle[]=[],unknown:Handle[]=[];
    for (const t of tickets) {
      const e=this.entries.get(t.id);
      if (!e) {
        const tombstone=this.tombstones.get(t.id);
        if(!tombstone || tombstone.until<=this.fs.now() || tombstone.signature!==JSON.stringify(t))unknown.push(t.id);
        else if(tombstone.disposition==="aborted")incomplete.push(t.id);
        continue;
      }
      if(e.retained && e.state==="sealed" && !e.gate.dispatched && !e.recoveryGate?.dispatched) {
        incomplete.push(t.id);continue;
      }
      if (this.fs.now()>=barrier.deadlineMonotonicMs || e.state==="unknown" || e.state==="publishing") {
        if ((await this.reconcile(t)).disposition!=="committed") unknown.push(t.id);
      } else if (e.state!=="committed") incomplete.push(t.id);
    }
    const ns=await this.ns(barrier.scope.owner.sourceKey);
    for (const loc of await ns.locations()) {
      const record=liveRecord(await ns.head(loc));
      if (record?.checkpoint==="open" && (barrier.scope.kind==="namespace" || record.id===barrier.scope.recordId)) incomplete.push(record.id);
    }
    return {state:unknown.length?"unknown":incomplete.length?"failed":"saved",accepted,incomplete,unknown};
  }
  fenceTargetOrTicket(ticket:PublicationTicket):void {const e=this.entries.get(ticket.id);if(e && e.state!=="committed" && e.state!=="aborted" && e.signature===JSON.stringify(ticket)){e.gate.shorten(this.fs.now(),this.fs.now());e.recoveryGate?.shorten(this.fs.now(),this.fs.now());}}
  settledDisposition(id:string):"committed"|"aborted"|null {
    const e=this.entries.get(id);
    if(e)return !e.busy && (e.state==="committed" || e.state==="aborted")?e.state:null;
    const tombstone=this.tombstones.get(id);
    return tombstone && tombstone.until>this.fs.now()?tombstone.disposition:null;
  }
  taggedImport(ticket:PublicationTicket,tag:ImportTag):boolean {
    const e=this.entries.get(ticket.id);
    return !!e && e.signature===JSON.stringify(ticket) && sameImportValue(e.tag,tag);
  }
  unresolvedTicket(id:string):boolean {const e=this.entries.get(id);return !!e && (e.state==="unknown" || e.state==="publishing" || e.busy);}
  async collect(owner: PersistenceOwner): Promise<void> {
    const ns = await this.settled(owner), protectedPaths = new Set<string>();
    for (const e of this.entries.values()) if (e.ticket.owner.sourceKey === owner.sourceKey && e.state === "committed" && !e.cleaned) await this.cleanup(e);
    for (const pin of this.pins.values()) protectedPaths.add(this.fs.name(pin.path));
    for (const e of this.entries.values()) if (e.ticket.owner.sourceKey === owner.sourceKey && e.finished === null) {
      protectedPaths.add(this.fs.name(e.temp)); if (e.object) protectedPaths.add(this.fs.name(e.object)); if (e.old?.object) protectedPaths.add(this.fs.name(ns.object(e.location, e.old)));
    }
    for (const p of await garbageCandidates(ns, protectedPaths)) await this.fs.unlink(p);
  }
  async dispose(): Promise<void> {
    for (const e of this.entries.values()) if(e.state!=="committed" && e.state!=="aborted")e.gate.shorten(this.fs.now(), this.fs.now());
    for (const [id, pin] of this.pins) await this.closePin(id, pin);
    for (const e of this.entries.values()) if (e.fd && !e.busy) { await this.fs.close(e.fd); e.fd = null; }
    if (this.failedReserves.size || [...this.entries.values()].some(e => e.busy || e.state === "unknown")) throw new Error("publish-uncertain");
  }
}
