import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { RecordMeta, Receipt, RecordRevision } from "@kobrixa/plugin-protocol";
import type { PublicationTicket, ImportTag } from "./engine-port.js";
import { NodePersistenceFs, writeAll, type StorePath } from "./filesystem.js";
import { persistenceErrorSchema } from "../../../../../../packages/plugin-protocol/src/persistence-validation.js";
import path from "node:path";
const scopedPaths=new WeakMap<NodePersistenceFs,WeakMap<StorePath,string>>();
export function createStorePath(fs:NodePersistenceFs,parts:readonly string[]):StorePath {
  if(parts.some(p=>!p || p==="." || p===".." || /[\\/:\0]/.test(p)))throw new Error("unsafe-path");
  let paths=scopedPaths.get(fs);if(!paths){paths=new WeakMap();scopedPaths.set(fs,paths);}
  const token=Object.freeze({}) as StorePath;paths.set(token,path.join(fs.root,...parts));return token;
}
export function storePathName(fs:NodePersistenceFs,p:StorePath):string {const name=scopedPaths.get(fs)?.get(p);if(!name)throw new Error("unsafe-path");return name;}
const h = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const r = z.string().regex(/^r_[0-9a-f]{32}$/), hash = z.string().regex(/^[0-9a-f]{64}$/);
const n = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), v = n.min(1).max(2147483647);
const key = z.string().min(1).refine(s => Buffer.byteLength(s) <= 128 && !s.includes("\0"));
const record = z.strictObject({ id: h, revision: r, kind: z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/), schemaVersion: v,
  label: z.string().refine(s => [...s].length <= 160 && Buffer.byteLength(s) <= 640 && !/[\u0000-\u001f\u007f]/.test(s)),
  mediaType: z.enum(["application/json", "text/plain", "text/csv", "application/octet-stream"]), byteLength: n.max(8388608), sha256: hash,
  createdAt: n, updatedAt: n, checkpoint: z.enum(["none", "open", "final"]), interrupted: z.boolean() });
const metadata = z.union([z.strictObject({ kind: z.literal("settings"), schemaVersion: v, validationDigest: hash }),
  z.strictObject({ kind: z.literal("record"), record, deleted: z.boolean() }), z.strictObject({ kind: z.enum(["import", "recovery"]), key })]);
const target = z.union([z.strictObject({ kind: z.literal("settings"), expectedRevision: r.nullable() }),
  z.strictObject({ kind: z.literal("record"), id: h, expectedRevision: r.nullable() }), z.strictObject({ kind: z.enum(["import", "recovery"]), key })]);
export const importTagSchema = z.strictObject({ importId: key, itemKey: key, sourceSha256: hash }).refine(t => Buffer.byteLength(JSON.stringify(t)) <= 256);
export const persistenceOwnerSchema=z.strictObject({sourceKey:z.string().min(1).max(160),pluginId:z.string().min(1),generation:n,hostEpoch:h,processEpoch:h});
export const publicationTicketSchema=z.strictObject({id:h,owner:persistenceOwnerSchema,deadlineMonotonicMs:z.number().min(0).max(Number.MAX_SAFE_INTEGER),metadata,target});
export const legacyPreferencesEvidenceRefSchema=z.strictObject({nonce:h,digest:hash});
export function sameImportValue(a:unknown,b:unknown):boolean {
  if(a===b)return true;
  if(a===null || b===null || typeof a!=="object" || typeof b!=="object")return false;
  if(Array.isArray(a) || Array.isArray(b))return Array.isArray(a) && Array.isArray(b) &&
    a.length===b.length && a.every((value,index)=>sameImportValue(value,b[index]));
  const left=Object.entries(a),right=Object.entries(b);
  return left.length===right.length && left.every(([key,value])=>
    Object.prototype.hasOwnProperty.call(b,key) && sameImportValue(value,Reflect.get(b,key)));
}
export function sameImportAttempt(original:PublicationTicket,attempt:PublicationTicket):boolean {
  return sameImportValue(original.metadata,attempt.metadata) && sameImportValue(original.target,attempt.target) &&
    original.owner.sourceKey===attempt.owner.sourceKey && original.owner.pluginId===attempt.owner.pluginId;
}
export const importPlanSchema=z.strictObject({formatVersion:z.literal(1),id:key,descriptorId:key,mappingVersion:v,
  targetSourceKey:z.string().min(1).max(160),preferencesEvidence:legacyPreferencesEvidenceRefSchema.nullable(),
  items:z.array(z.strictObject({key,sourceFormat:v,sourceSha256:hash,mappedSha256:hash,byteLength:n.max(8388608),ticket:publicationTicketSchema,tag:importTagSchema})).max(512)
}).superRefine((plan,ctx)=>{
  const expectedId="import/"+createHash("sha256").update(JSON.stringify([plan.descriptorId,plan.targetSourceKey]),"utf8").digest("hex");
  const ids=plan.items.flatMap(item=>item.ticket.target.kind==="record"?[item.ticket.target.id]:["settings"]);
  if(plan.id!==expectedId || new Set(ids).size!==ids.length ||
      new Set(plan.items.map(i=>i.key)).size!==plan.items.length ||
      new Set(plan.items.map(i=>i.ticket.id)).size!==plan.items.length ||
      Buffer.byteLength(JSON.stringify(plan))>2097152 ||
      plan.items.some(i=>i.tag.importId!==plan.id || i.tag.itemKey!==i.key ||
        i.sourceSha256!==i.tag.sourceSha256 || i.ticket.owner.sourceKey!==plan.targetSourceKey ||
        i.ticket.metadata.kind!==i.ticket.target.kind ||
        (i.ticket.metadata.kind!=="settings" && i.ticket.metadata.kind!=="record") ||
        (i.ticket.metadata.kind==="record" && (i.ticket.metadata.deleted || i.ticket.target.kind!=="record" ||
          i.ticket.metadata.record.id!==i.ticket.target.id || i.ticket.metadata.record.byteLength!==i.byteLength ||
          i.ticket.metadata.record.sha256!==i.mappedSha256))))ctx.addIssue({code:"custom",message:"input-changed"});
});
const receipt=z.strictObject({revision:r,commitId:h,durability:z.enum(["file-and-directory-sync","file-sync-only"])});
export const importItemEvidenceSchema=z.strictObject({key,state:z.enum(["pending","committed","skipped","unknown"]),
  receipt:receipt.nullable(),skipReason:z.string().refine(s=>Buffer.byteLength(s)<=256).nullable(),
  publicationTicket:publicationTicketSchema.nullable()}).refine(e=>{
    if(e.state==="committed")return e.receipt!==null && e.publicationTicket!==null && e.skipReason===null &&
      e.receipt.commitId===e.publicationTicket.id && (e.publicationTicket.metadata.kind!=="record" ||
        e.receipt.revision===e.publicationTicket.metadata.record.revision);
    if(e.state==="skipped")return !!e.skipReason && e.receipt===null;
    return e.receipt===null && e.skipReason===null && (e.state!=="unknown" || e.publicationTicket!==null);
  });
export const importDocumentSchema=z.strictObject({formatVersion:z.literal(1),plan:importPlanSchema,
  items:z.array(importItemEvidenceSchema).max(512),complete:z.boolean()}).refine(d=>
    Buffer.byteLength(JSON.stringify(d))<=2097152 && d.items.length===d.plan.items.length &&
    new Set(d.items.map(e=>e.key)).size===d.items.length && d.items.every((e,i)=>e.key===d.plan.items[i]?.key &&
      (e.publicationTicket===null || sameImportAttempt(d.plan.items[i]!.ticket,e.publicationTicket))) &&
    (!d.complete || d.items.every(e=>e.state==="committed" || e.state==="skipped")));
export const storedRecoverySchema=z.strictObject({id:h,owner:persistenceOwnerSchema,
  report:z.strictObject({state:z.enum(["saved","retryable","checkpoint-only","uncertain"]),blocker:z.boolean(),recovery:h.exactOptional(),retryAction:h.exactOptional(),pendingSettings:z.boolean(),
    records:z.array(z.strictObject({id:h,committedRevision:r.nullable(),final:z.boolean(),payload:z.enum(["complete-staging","checkpoint-only","none"]),expiresAt:n.exactOptional()})).max(2),
    errors:z.array(persistenceErrorSchema).max(16)}),ticket:publicationTicketSchema.nullable(),sealedPin:h.nullable(),expiresAt:n.nullable()});
export const persistenceScopeSchema=z.union([z.strictObject({kind:z.literal("namespace"),owner:persistenceOwnerSchema}),z.strictObject({kind:z.literal("target"),owner:persistenceOwnerSchema,recordId:h})]);
export const persistenceBarrierSchema=z.strictObject({id:h,scope:persistenceScopeSchema,through:n,deadlineMonotonicMs:z.number().min(0).max(Number.MAX_SAFE_INTEGER)});
const diskHeadSchema = z.strictObject({ formatVersion: z.literal(1), metadata, target, object: z.string().regex(/^r_[0-9a-f]{32}\.(?:bin|json)$/).nullable(),
  byteLength: n.max(8388608), sha256: hash, receipt: z.strictObject({ revision: r, commitId: h, durability: z.enum(["file-and-directory-sync", "file-sync-only"]) }), importTag: importTagSchema.optional() });
export type DiskHead = { formatVersion: 1; metadata: PublicationTicket["metadata"]; target: PublicationTicket["target"]; object: string | null;
  byteLength: number; sha256: string; receipt: Receipt<RecordRevision>; importTag?: ImportTag };
export function parseHead(bytes: Uint8Array): DiskHead {
  if (bytes.length > 8192) throw new Error("corrupt");
  let raw: unknown; try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("corrupt"); }
  if (typeof raw === "object" && raw !== null && "formatVersion" in raw && raw.formatVersion !== 1) throw new Error("unsupported-format");
  const parsed = diskHeadSchema.safeParse(raw); if (!parsed.success) throw new Error("corrupt");
  const head = parsed.data as DiskHead;
  if ((head.metadata.kind === "record" && head.metadata.deleted && (head.object !== null || head.byteLength !== 0)) || head.metadata.kind !== head.target.kind || (head.metadata.kind === "record" && (head.target.kind !== "record" || head.metadata.record.id !== head.target.id || head.metadata.record.revision !== head.receipt.revision || (!head.metadata.deleted && (head.metadata.record.sha256 !== head.sha256 || head.metadata.record.byteLength !== head.byteLength)))) || (head.object !== null && !head.object.startsWith(head.receipt.revision + "."))) throw new Error("corrupt");
  return head;
}
export type Location = { directory: StorePath; head: StorePath; previous: StorePath; objects: StorePath; parts: string[]; name: string };
export class Namespace {
  readonly hash: string;
  private constructor(readonly fs: NodePersistenceFs, readonly sourceKey: string) { this.hash = createHash("sha256").update(sourceKey).digest("hex"); }
  path(...parts: string[]): StorePath { return this.fs.path("namespaces", this.hash, ...parts); }
  static async open(fs: NodePersistenceFs, sourceKey: string): Promise<Namespace> {
    if (!sourceKey || sourceKey.length > 160 || sourceKey.includes("\0")) throw new Error("identity-mismatch");
    const ns = new Namespace(fs, sourceKey), identity = ns.path("identity.json");
    const exists = await fs.exists(ns.path());
    if (!exists) {
      await fs.mkdir(ns.path());
      await ns.writeNew(identity, { formatVersion: 1, sourceKey }); await fs.syncDirectory(ns.path());
    } else if (!await fs.exists(identity)) throw new Error("identity-mismatch");
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await fs.bytes(identity, 4096))) as { formatVersion?: unknown; sourceKey?: unknown };
    if (data.formatVersion !== 1) throw new Error("unsupported-format");
    if (data.sourceKey !== sourceKey || Object.keys(data).sort().join(",") !== "formatVersion,sourceKey") throw new Error("identity-mismatch");
    for (const name of ["settings", "records", "staging", "imports", "recovery", "quarantine"]) await fs.mkdir(ns.path(name));
    return ns;
  }
  async writeNew(p: StorePath, value: unknown): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(value)); const fd = await this.fs.open(p, "create-exclusive");
    try { await writeAll(this.fs, fd, 0, bytes); await this.fs.sync(fd); } finally { await this.fs.close(fd); }
  }
  async location(t: PublicationTicket["target"], create = false): Promise<Location> {
    let parts: string[], name: string;
    if (t.kind === "settings") { parts = ["settings"]; name = "head.json"; }
    else if (t.kind === "record") { h.parse(t.id); parts = ["records", t.id]; name = "head.json"; }
    else { key.parse(t.key); parts = [t.kind === "import" ? "imports" : "recovery"]; name = createHash("sha256").update(t.key).digest("hex") + ".json"; }
    if (create) { await this.fs.mkdir(this.path(...parts)); await this.fs.mkdir(this.path(...parts, "objects")); }
    return { directory: this.path(...parts), head: this.path(...parts, name), previous: this.path(...parts, name === "head.json" ? "head.previous" : name + ".previous"), objects: this.path(...parts, "objects"), parts, name };
  }
  object(location: Location, head: DiskHead): StorePath {
    if (!head.object) throw new Error("not-found"); return this.path(...location.parts, "objects", head.object);
  }
  async head(location: Location): Promise<DiskHead | null> {
    return await this.fs.exists(location.head) ? parseHead(await this.fs.bytes(location.head, 8192)) : null;
  }
  async verify(location: Location, head: DiskHead): Promise<void> {
    if (head.object === null) { if (head.metadata.kind !== "record" || !head.metadata.deleted) throw new Error("corrupt"); return; }
    const object = this.object(location, head), fd = await this.fs.open(object, "read"), digest = createHash("sha256"); let offset = 0;
    try {
      if (await this.fs.size(object) !== head.byteLength) throw new Error("corrupt");
      while (offset < head.byteLength) { const bytes = await this.fs.read(fd, offset, Math.min(262144, head.byteLength - offset)); if (!bytes.length) throw new Error("corrupt"); digest.update(bytes); offset += bytes.length; }
      if (digest.digest("hex") !== head.sha256) throw new Error("corrupt");
    } finally { await this.fs.close(fd); }
  }
  async locations(): Promise<Location[]> {
    const result: Location[] = [await this.location({ kind: "settings", expectedRevision: null })];
    for (const entry of await this.fs.entries(this.path("records"), 4096)) {
      if (!entry.directory || !h.safeParse(entry.name).success) throw new Error("corrupt");
      result.push(await this.location({ kind: "record", id: entry.name, expectedRevision: null }));
    }
    for (const kind of ["import", "recovery"] as const) {
      for (const entry of await this.fs.entries(this.path(kind === "import" ? "imports" : "recovery"), 4096)) {
        if (!entry.directory && entry.name.endsWith(".json")) {
          const head=parseHead(await this.fs.bytes(this.path(kind === "import" ? "imports" : "recovery",entry.name),8192));
          if (head.target.kind!==kind || !("key" in head.target)) throw new Error("corrupt");
          const loc=await this.location(head.target);
          if (loc.name!==entry.name) throw new Error("identity-mismatch"); result.push(loc);
        }
      }
    }
    return result;
  }
  async inventory(): Promise<Array<{ path: StorePath; relative: string; bytes: number }>> {
    const result: Array<{ path: StorePath; relative: string; bytes: number }> = []; let count = 0;
    const walk = async (parts: string[], depth: number): Promise<void> => {
      if (depth > 6) throw new Error("scan-limit");
      for (const entry of await this.fs.entries(this.path(...parts), 4096 - count)) {
        if (++count > 4096) throw new Error("scan-limit");
        const next = [...parts, entry.name];
        if (entry.directory) await walk(next, depth + 1);
        else result.push({ path: this.path(...next), relative: next.join("/"), bytes: entry.bytes });
      }
    };
    await walk([], 0); return result;
  }
  async quarantine(p: StorePath): Promise<void> {
    await this.fs.atomicReplace(p, this.path("quarantine", randomUUID() + ".evidence"));
    await this.fs.syncDirectory(this.path("quarantine"));
  }
}
export const liveRecord = (head: DiskHead | null): RecordMeta | null => head?.metadata.kind === "record" && !head.metadata.deleted ? head.metadata.record : null;
