import { z } from "zod";
import { receiptSchema } from "../../../../../../packages/plugin-protocol/src/persistence-validation.js";
import { randomUUID } from "node:crypto";
import type { StorePath } from "./filesystem.js";
import { type Namespace, parseHead, liveRecord, publicationTicketSchema, sameImportValue, type DiskHead, importDocumentSchema } from "./namespace.js";
import { parseNonceDocument, parseBarrierDocument } from "./import-sources.js";
export type NamespaceScan = { heads: DiskHead[]; problems: string[]; totals: { committed: number; records: number; metadata: number; temporary: number } };
const contentError = (e: unknown): boolean => e instanceof Error && (e.message === "corrupt" || e instanceof SyntaxError || e instanceof TypeError);
const resolvedSchema=z.discriminatedUnion("disposition",[
  z.strictObject({formatVersion:z.literal(1),disposition:z.literal("committed"),receipt:receiptSchema}),
  z.strictObject({formatVersion:z.literal(1),disposition:z.literal("not-committed"),receipt:z.null()}),
]);
export async function resolvedImport(ns:Namespace,id:string) {
  const path=ns.path("staging",id,"resolved.json");
  if(!await ns.fs.exists(path))return null;
  return resolvedSchema.parse(JSON.parse(Buffer.from(await ns.fs.bytes(path,8192)).toString("utf8")));
}
async function persistResolution(ns:Namespace,id:string,value:z.infer<typeof resolvedSchema>):Promise<void> {
  const temp=ns.path("staging",id,"resolved.tmp");
  if(await ns.fs.exists(temp))await ns.fs.unlink(temp);
  await ns.writeNew(temp,resolvedSchema.parse(value));
  await ns.fs.atomicReplace(temp,ns.path("staging",id,"resolved.json"));
  await ns.fs.syncDirectory(ns.path("staging",id));
}
// A first imported record can have its immutable object and temporary head on disk
// before the head rename. Only the durable pending journal can authorize classifying
// that exact candidate as uncommitted; never promote it or infer an empty default.
// The journal also survives older recovery scans that already removed staging intent.
async function quarantinePendingImportCandidate(ns:Namespace,loc:Awaited<ReturnType<Namespace["location"]>>):Promise<boolean> {
  const fs=ns.fs;
  if(loc.parts[0]!=="records" || await fs.exists(loc.head) || await fs.exists(loc.previous))return false;
  const candidates=(await fs.entries(loc.directory,4096)).filter(e=>!e.directory && /^head\.[0-9a-f-]{36}\.tmp$/.test(e.name));
  if(candidates.length!==1)return false;
  const candidate=parseHead(await fs.bytes(ns.path(...loc.parts,candidates[0]!.name),8192));
  if(candidate.target.kind!=="record" || candidate.target.expectedRevision!==null ||
      candidate.target.id!==loc.parts[1] || candidate.metadata.kind!=="record" || candidate.metadata.deleted ||
      !candidate.importTag || candidates[0]!.name!==`head.${candidate.receipt.commitId}.tmp`)return false;
  const objects=await fs.entries(loc.objects,4096);
  if(objects.length!==1 || objects[0]!.directory || objects[0]!.name!==candidate.object)return false;
  const journalLoc=await ns.location({kind:"import",key:candidate.importTag.importId});
  const journalHead=await ns.head(journalLoc);
  if(!journalHead || journalHead.target.kind!=="import" || journalHead.target.key!==candidate.importTag.importId)return false;
  await ns.verify(journalLoc,journalHead);
  const journal=importDocumentSchema.parse(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(
    await fs.bytes(ns.object(journalLoc,journalHead),2097152))));
  if(journal.complete || journal.plan.id!==candidate.importTag.importId || journal.plan.targetSourceKey!==ns.sourceKey)return false;
  const index=journal.plan.items.findIndex(i=>i.key===candidate.importTag!.itemKey);
  if(index<0)return false;
  const item=journal.plan.items[index]!,evidence=journal.items[index]!,attempt=evidence.publicationTicket;
  if(evidence.state!=="pending" || evidence.receipt!==null || !attempt || attempt.owner.sourceKey!==ns.sourceKey ||
      attempt.id!==candidate.receipt.commitId || !sameImportValue(attempt.target,candidate.target) ||
      !sameImportValue(attempt.metadata,candidate.metadata) || !sameImportValue(item.tag,candidate.importTag) ||
      item.byteLength!==candidate.byteLength || item.mappedSha256!==candidate.sha256)return false;
  await ns.verify(loc,candidate);
  // Preserve all bytes while freeing the fixed planned revision for a fresh attempt.
  // A crash between the moves leaves no published head and cannot replay payload.
  const objectEvidence=ns.path("quarantine",`${candidate.receipt.commitId}.prepublish.bin`);
  const headEvidence=ns.path("quarantine",`${candidate.receipt.commitId}.prepublish-head`);
  if(await fs.exists(objectEvidence) || await fs.exists(headEvidence))throw new Error("corrupt");
  await fs.atomicReplace(ns.object(loc,candidate),objectEvidence);
  await fs.syncDirectory(ns.path("quarantine"));await fs.syncDirectory(loc.objects);
  await fs.atomicReplace(ns.path(...loc.parts,candidates[0]!.name),headEvidence);
  await fs.syncDirectory(ns.path("quarantine"));await fs.syncDirectory(loc.directory);
  return true;
}
export async function scanNamespace(ns: Namespace, hostEpoch: string): Promise<NamespaceScan> {
  const fs = ns.fs; fs.profile.assertHeld();
  const result: NamespaceScan = { heads: [], problems: [], totals: { committed: 0, records: 0, metadata: 0, temporary: 0 } };
  await ns.inventory(); // Bound traversal and reject unsafe aliases before any repair.
  const payloads = new Set<string>(), retained = new Set<string>();
  for (const loc of await ns.locations()) {
    let head: DiskHead | null = null;
    try { head = await ns.head(loc); if (head) await ns.verify(loc, head); }
    catch (e) { if (!contentError(e)) throw e; head = null; result.problems.push("corrupt"); }
    if (!head && await fs.exists(loc.previous)) {
      const previous = parseHead(await fs.bytes(loc.previous, 8192)); await ns.verify(loc, previous);
      if (await fs.exists(loc.head)) await ns.quarantine(loc.head);
      const restore = ns.path(...loc.parts, `${loc.name}.${randomUUID()}.restore`);
      await ns.writeNew(restore, previous); await fs.atomicReplace(restore, loc.head); await fs.syncDirectory(loc.directory);
      head = previous; result.problems.push("rollback-interrupted");
    }
    if (!head) {
      if (await fs.exists(loc.objects) && (await fs.entries(loc.objects, 4096)).length &&
          !await quarantinePendingImportCandidate(ns,loc)) result.problems.push("corrupt");
      continue;
    }
    if(head.metadata.kind!=="record") {
      const raw:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await fs.bytes(ns.object(loc,head),2097152)));
      if(raw===null || typeof raw!=="object" || !("formatVersion" in raw))throw new Error("corrupt");
      if(raw.formatVersion!==1)throw new Error("unsupported-format");
    }
    result.heads.push(head);
    const record = liveRecord(head);
    if (record) { result.totals.committed += record.byteLength; result.totals.records++; if (head.object) payloads.add(fs.name(ns.object(loc, head))); }
    if (await fs.exists(loc.previous)) {
      const previous = parseHead(await fs.bytes(loc.previous, 8192)); await ns.verify(loc, previous);
      if (previous.object && previous.object !== head.object && previous.metadata.kind === "record") retained.add(fs.name(ns.object(loc, previous)));
    }
  }
  // A completed process cannot own resumable staging in this new host epoch. Clean only the
  // recognized transient files after validating their identity; never replay their payload.
  for (const entry of await fs.entries(ns.path("staging"), 4096)) {
    if (!entry.directory || !/^[0-9a-f-]{36}$/.test(entry.name)) throw new Error("corrupt");
    const intent = ns.path("staging", entry.name, "intent.json");
    if (!await fs.exists(intent)) {
      if ((await fs.entries(ns.path("staging", entry.name), 4096)).length === 0) await fs.removeEmpty(ns.path("staging", entry.name));
      else result.problems.push("corrupt");
      continue;
    }
    const value = JSON.parse(Buffer.from(await fs.bytes(intent, 8192)).toString("utf8")) as { formatVersion?: unknown; ticket?: { owner?: { hostEpoch?: unknown; sourceKey?: unknown } } };
    if (value.formatVersion !== 1) throw new Error("unsupported-format");
    if (value.ticket?.owner?.sourceKey !== ns.sourceKey) throw new Error("identity-mismatch");
    const checkedTicket=publicationTicketSchema.parse(value.ticket);
    if(checkedTicket.target.kind==="import") {
      const payload=ns.path("staging",entry.name,"payload.tmp");
      if(await resolvedImport(ns,entry.name)){if(await fs.exists(payload))await fs.unlink(payload);continue;}
      // Classify verified heads before touching the only persisted association.
      const loc=await ns.location(checkedTicket.target),head=await ns.head(loc);
      if(head)await ns.verify(loc,head);
      const raw=JSON.parse(Buffer.from(await fs.bytes(intent,32768)).toString("utf8"));
      if(Object.keys(raw).sort().join(",")!=="byteLength,formatVersion,predecessor,ticket")throw new Error("corrupt");
      const predecessor=raw.predecessor===null?null:parseHead(Buffer.from(JSON.stringify(raw.predecessor)));
      if(predecessor)await ns.verify(loc,predecessor);
      let matching=false;
      const candidatePath=ns.path("staging",entry.name,"publication.json");
      if(head && await fs.exists(candidatePath)) {
        const candidate=parseHead(await fs.bytes(candidatePath,8192));
        if(!sameImportValue(candidate.target,checkedTicket.target) || !sameImportValue(candidate.metadata,checkedTicket.metadata))throw new Error("identity-mismatch");
        matching=sameImportValue(candidate,head);
      }
      if(head && (checkedTicket.target.key.startsWith("nonce/") || checkedTicket.target.key.startsWith("barrier/"))) {
        const bytes=await fs.bytes(ns.object(loc,head),2097152);
        const document=checkedTicket.target.key.startsWith("nonce/")?parseNonceDocument(bytes):parseBarrierDocument(bytes);
        matching=sameImportValue(document.ticket,checkedTicket);
      }
      if(await fs.exists(payload))await fs.unlink(payload);
      if(matching) {
        await fs.syncDirectory(loc.directory);
        await persistResolution(ns,entry.name,{formatVersion:1,disposition:"committed",receipt:head!.receipt});
      } else if(sameImportValue(head,predecessor)) {
        await persistResolution(ns,entry.name,{formatVersion:1,disposition:"not-committed",receipt:null});
      } else result.problems.push("import-uncertain");
      // Retain bounded metadata association under the existing metadata quota. Never promote payload.tmp.
      continue;
    }
    if (value.ticket.owner.hostEpoch !== hostEpoch) {
      for (const name of ["payload.tmp", "sealed.json", "import-tag.json", "publication.json", "intent.json"]) {
        const p = ns.path("staging", entry.name, name);
        try { if (await fs.exists(p)) await fs.unlink(p); }
        catch (e) { result.problems.push((e as NodeJS.ErrnoException).code === "EACCES" ? "permission" : "cleanup-failed"); }
      }
      if ((await fs.entries(ns.path("staging", entry.name), 4096)).length === 0) await fs.removeEmpty(ns.path("staging", entry.name));
    }
  }
  for (const file of await ns.inventory()) {
    const name = fs.name(file.path);
    if (payloads.has(name)) continue;
    if (/^quarantine\/[0-9a-f-]{36}\.prepublish\.bin$/.test(file.relative) || retained.has(name) || /(?:^|\/)objects\/r_[0-9a-f]{32}\.bin$/.test(file.relative) || file.relative.endsWith("/payload.tmp")) result.totals.temporary += file.bytes;
    else result.totals.metadata += file.bytes;
  }
  if (result.totals.committed > 536870912 || result.totals.records > 256 || result.totals.temporary > 33554432 || result.totals.metadata > 4194304) result.problems.push("quota");
  return result;
}
export async function garbageCandidates(ns: Namespace, protectedPaths: ReadonlySet<string>): Promise<StorePath[]> {
  const refs = new Set(protectedPaths), fs = ns.fs;
  for (const loc of await ns.locations()) {
    for (const p of [loc.head, loc.previous]) if (await fs.exists(p)) {
      const head = parseHead(await fs.bytes(p, 8192)); await ns.verify(loc, head);
      if (head.object) refs.add(fs.name(ns.object(loc, head)));
    }
  }
  return (await ns.inventory()).filter(file => /(?:^|\/)objects\/r_[0-9a-f]{32}\.(?:bin|json)$/.test(file.relative) && !refs.has(fs.name(file.path))).map(file => file.path);
}
