import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createNodePersistenceFs } from "./filesystem.js";
import { Namespace, type DiskHead } from "./namespace.js";
import { AtomicStore } from "./atomic-store.js";
import { scanNamespace, garbageCandidates } from "./recovery-scan.js";
it("keeps a complete new head, protects pins, and refuses unknown format without destructive repair", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "recover-"));
  try {
    const epoch = randomUUID(), fs = await createNodePersistenceFs(root, { hostEpoch: epoch, assertHeld() {} });
    const ns = await Namespace.open(fs, "builtin:kobrixa.lab"), target = { kind: "settings" as const, expectedRevision: null }, loc = await ns.location(target, true);
    const body = { formatVersion: 1, schemaVersion: 1, validationDigest: "0".repeat(64), values: [] };
    const raw = Buffer.from(JSON.stringify(body)), revision = "r_" + "1".repeat(32);
    const head: DiskHead = { formatVersion: 1, target, metadata: { kind: "settings", schemaVersion: 1, validationDigest: "0".repeat(64) }, object: revision + ".json", byteLength: raw.length, sha256: createHash("sha256").update(raw).digest("hex"), receipt: { revision, commitId: randomUUID(), durability: fs.durability } };
    await ns.writeNew(ns.object(loc, head), body); await ns.writeNew(loc.head, head); await ns.writeNew(loc.previous, head);
    expect((await scanNamespace(ns, epoch)).heads[0]?.receipt).toEqual(head.receipt);
    const orphan = ns.path("settings", "objects", "r_" + "2".repeat(32) + ".json"); await ns.writeNew(orphan, { untouched: true });
    expect((await garbageCandidates(ns, new Set([fs.name(orphan)]))).map(p => fs.name(p))).not.toContain(fs.name(orphan));
    expect((await garbageCandidates(ns, new Set())).map(p => fs.name(p))).toContain(fs.name(orphan));
    await fs.unlink(loc.head); await ns.writeNew(loc.head, { formatVersion: 1, broken: true });
    const rollback = await scanNamespace(ns, epoch);
    expect(rollback.problems).toContain("rollback-interrupted");
    expect((await ns.head(loc))?.receipt).toEqual(head.receipt);
    expect(await fs.entries(ns.path("quarantine"), 4096)).toHaveLength(1);
    await fs.unlink(loc.head); await ns.writeNew(loc.head, { ...head, formatVersion: 99 });
    await expect(scanNamespace(ns, epoch)).rejects.toThrow("unsupported-format");
    expect(JSON.parse(Buffer.from(await fs.bytes(loc.head, 8192)).toString()).formatVersion).toBe(99);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("does not treat EACCES as corruption or manufacture defaults", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "recover-permission-"));
  try {
    const fs = await createNodePersistenceFs(root, { hostEpoch: randomUUID(), assertHeld() {} });
    const ns = await Namespace.open(fs, "builtin:kobrixa.lab"), original = fs.entries.bind(fs);
    fs.entries = async (p, max) => { if (fs.name(p).endsWith("settings")) throw Object.assign(new Error("denied"), { code: "EACCES" }); return original(p, max); };
    await expect(scanNamespace(ns, fs.profile.hostEpoch)).rejects.toMatchObject({ code: "EACCES" });
    expect(await original(ns.path("quarantine"), 4096)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
for (const kind of ["settings", "import", "recovery"] as const) it(`blocks unknown ${kind} payload versions without rewriting evidence`, async () => {
  const root=await mkdtemp(path.join(tmpdir(),"unknown-envelope-"));
  try {
    const fs=await createNodePersistenceFs(root,{hostEpoch:randomUUID(),assertHeld(){}}),ns=await Namespace.open(fs,"builtin:kobrixa.lab");
    const target=kind==="settings"?{kind,expectedRevision:null}:{kind,key:"test"};
    const metadata=kind==="settings"?{kind,schemaVersion:1,validationDigest:"0".repeat(64)}:{kind,key:"test"};
    const loc=await ns.location(target,true),body={formatVersion:99,value:"preserve"},raw=Buffer.from(JSON.stringify(body)),revision="r_"+"a".repeat(32);
    const head:DiskHead={formatVersion:1,target,metadata,object:revision+".json",byteLength:raw.length,sha256:createHash("sha256").update(raw).digest("hex"),receipt:{revision,commitId:randomUUID(),durability:fs.durability}};
    await ns.writeNew(ns.object(loc,head),body);await ns.writeNew(loc.head,head);
    await expect(scanNamespace(ns,fs.profile.hostEpoch)).rejects.toThrow("unsupported-format");
    expect(await fs.bytes(ns.object(loc,head),2097152)).toEqual(new Uint8Array(raw));
    expect(await ns.head(loc)).toEqual(head);
  } finally {await rm(root,{recursive:true,force:true});}
});
it("classifies a recovered import metadata candidate before cleaning staging",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"import-recover-"));try {
    const epoch=randomUUID(),fs=await createNodePersistenceFs(root,{hostEpoch:epoch,assertHeld(){}}),ns=await Namespace.open(fs,"builtin:kobrixa.lab");
    const owner={sourceKey:ns.sourceKey,pluginId:"kobrixa.lab",generation:1,hostEpoch:randomUUID(),processEpoch:randomUUID()},target={kind:"import" as const,key:"fault-matrix"};
    const ticket={id:randomUUID(),owner,deadlineMonotonicMs:10000,target,metadata:target},loc=await ns.location(target,true),body={formatVersion:1,value:1},raw=Buffer.from(JSON.stringify(body)),revision="r_"+"b".repeat(32);
    const head:DiskHead={formatVersion:1,target,metadata:target,object:revision+".json",byteLength:raw.length,sha256:createHash("sha256").update(raw).digest("hex"),receipt:{revision,commitId:randomUUID(),durability:fs.durability}};
    await ns.writeNew(ns.object(loc,head),body);await ns.writeNew(loc.head,head);await fs.mkdir(ns.path("staging",ticket.id));
    await ns.writeNew(ns.path("staging",ticket.id,"intent.json"),{formatVersion:1,ticket,byteLength:raw.length,predecessor:null});
    await ns.writeNew(ns.path("staging",ticket.id,"publication.json"),head);
    const payload=ns.path("staging",ticket.id,"payload.tmp");
    await ns.writeNew(payload,{leftover:true});
    const replace=fs.atomicReplace.bind(fs);
    fs.atomicReplace=async(from,to)=>{if(fs.name(to).endsWith("resolved.json"))expect(await fs.exists(payload)).toBe(false);await replace(from,to);};
    const scan=await scanNamespace(ns,epoch);expect(scan.problems).toEqual([]);
    expect(await fs.exists(ns.path("staging",ticket.id,"intent.json"))).toBe(true);
    const resolved={formatVersion:1,disposition:"committed",receipt:head.receipt};
    expect(JSON.parse(Buffer.from(await fs.bytes(ns.path("staging",ticket.id,"resolved.json"),8192)).toString())).toEqual(resolved);
    // Recreate the state left by older writers crashing after verdict publication.
    await ns.writeNew(payload,{leftover:true});
    await fs.unlink(loc.head);await ns.writeNew(loc.head,{...head,receipt:{...head.receipt,commitId:randomUUID()}});
    expect((await scanNamespace(ns,epoch)).problems).toEqual([]);
    expect(await fs.exists(payload)).toBe(false);
    const store=new AtomicStore(fs);await store.initialize();
    expect(await store.reconcileImport(ticket)).toEqual({disposition:"committed",receipt:head.receipt});await store.dispose();
  }finally{await rm(root,{recursive:true,force:true});}
});

import { cp, writeFile } from "node:fs/promises";
import { importIdFor } from "./import-sources.js";
import type { PublicationTicket } from "./engine-port.js";
async function preHeadImport(ordinary=false) {
  const root=await mkdtemp(path.join(tmpdir(),"pre-head-import-"));
  const snapshot=path.join(root,"snapshot");
  let copying=false;
  const owner={sourceKey:"builtin:test.synthetic",pluginId:"test.synthetic",generation:1,hostEpoch:randomUUID(),processEpoch:randomUUID()};
  const fs=await createNodePersistenceFs(root,{hostEpoch:owner.hostEpoch,assertHeld(){}},{now:()=>0,fault:async(point,edge)=>{
    if(copying && point==="before-publish" && edge==="before") {
      await cp(path.join(root,"plugins"),path.join(snapshot,"plugins"),{recursive:true});
      throw Error("simulated-process-loss-after-filesystem-snapshot");
    }
  }});
  const store=new AtomicStore(fs);await store.initialize();
  const bytes=Buffer.alloc(8388608,42),sha=createHash("sha256").update(bytes).digest("hex"),id=randomUUID();
  const planned:PublicationTicket={id:randomUUID(),owner,deadlineMonotonicMs:10000,target:{kind:"record",id,expectedRevision:null},metadata:{kind:"record",deleted:false,record:{id,revision:"r_"+randomUUID().replaceAll("-",""),kind:"test.synthetic",schemaVersion:1,label:"import",mediaType:"application/octet-stream",byteLength:bytes.length,sha256:sha,createdAt:1,updatedAt:1,checkpoint:"none",interrupted:false}}};
  const descriptorId="test.synthetic.files",planId=importIdFor(descriptorId,owner.sourceKey),tag={importId:planId,itemKey:"first",sourceSha256:sha};
  if(!ordinary)await store.planImport(owner,{formatVersion:1,id:planId,descriptorId,mappingVersion:1,targetSourceKey:owner.sourceKey,preferencesEvidence:null,items:[{key:"first",sourceFormat:1,sourceSha256:sha,mappedSha256:sha,byteLength:bytes.length,ticket:planned,tag}]});
  const attempt=ordinary?planned:await store.admitImport(owner,planId,"first");
  await store.reserve(attempt,bytes.length);if(!ordinary)await store.tagImport(attempt,tag);
  for(let offset=0;offset<bytes.length;offset+=262144)await store.append(attempt,offset,bytes.subarray(offset,offset+262144));
  await store.seal(attempt,bytes.length,sha);
  let safeAttempt:PublicationTicket|undefined;
  if(ordinary && planned.metadata.kind==="record") {
    const safeId=randomUUID(),safeBytes=Buffer.from("abc"),safeHash=createHash("sha256").update(safeBytes).digest("hex");
    safeAttempt={...planned,id:randomUUID(),target:{kind:"record",id:safeId,expectedRevision:null},metadata:{kind:"record",deleted:false,record:{...planned.metadata.record,id:safeId,revision:"r_"+randomUUID().replaceAll("-",""),byteLength:3,sha256:safeHash}}};
    await store.reserve(safeAttempt,3);await store.append(safeAttempt,0,safeBytes);await store.seal(safeAttempt,3,safeHash);
  }
  copying=true;
  await expect(store.publish(attempt)).rejects.toThrow("simulated-process-loss");
  await store.dispose();
  const nextOwner={...owner,hostEpoch:randomUUID(),processEpoch:randomUUID()};
  const nextFs=await createNodePersistenceFs(snapshot,{hostEpoch:nextOwner.hostEpoch,assertHeld(){}},{now:()=>0});
  const ns=await Namespace.open(nextFs,owner.sourceKey),loc=await ns.location(attempt.target);
  return {root,snapshot,nextFs,ns,loc,planned,attempt,nextOwner,planId,tag,bytes,safeAttempt};
}
it("pre-head import restart preserves unpublished evidence, reconciles not committed and admits only a fresh attempt",async()=>{
 const f=await preHeadImport();try {
  // Repeated scans also cover the older failed recovery which removed staging intent.
  for(let n=0;n<3;n++) {
    const scan=await scanNamespace(f.ns,f.nextOwner.hostEpoch);
    expect(scan.problems).toEqual([]);expect(scan.totals.committed).toBe(0);
    expect(scan.totals.temporary).toBe(f.bytes.length);
    expect(await f.ns.head(f.loc)).toBeNull();
  }
  const evidence=f.ns.path("quarantine",`${f.attempt.id}.prepublish.bin`);
  expect(createHash("sha256").update(await f.nextFs.bytes(evidence,8388608)).digest("hex")).toBe(f.tag.sourceSha256);
  const store=new AtomicStore(f.nextFs);await store.initialize();
  expect(await store.reconcileImport(f.attempt)).toEqual({disposition:"not-committed"});
  expect((await store.list(f.nextOwner,{limit:64})).entries).toEqual([]);
  await expect(store.reserve(f.attempt,f.bytes.length)).rejects.toThrow("stale");
  const fresh=await store.admitImport(f.nextOwner,f.planId,"first");
  expect(fresh.id).not.toBe(f.attempt.id);expect(fresh.target).toEqual(f.attempt.target);
  await store.reserve(fresh,f.bytes.length);await store.tagImport(fresh,f.tag);
  for(let offset=0;offset<f.bytes.length;offset+=262144)await store.append(fresh,offset,f.bytes.subarray(offset,offset+262144));
  await store.seal(fresh,f.bytes.length,f.tag.sourceSha256);
  const committed=await store.publish(fresh);expect(committed.disposition).toBe("committed");
  await store.recordImport(f.nextOwner,f.planId,{key:"first",state:"committed",receipt:committed.receipt!,skipReason:null,publicationTicket:fresh});
  await store.completeImport(f.nextOwner,f.planId);await store.dispose();
  const reopened=new AtomicStore(f.nextFs);await reopened.initialize();
  expect((await reopened.list(f.nextOwner,{limit:64})).entries).toHaveLength(1);
  expect(await reopened.reconcileImport(f.planned)).toEqual(committed);await reopened.dispose();
 }finally{await rm(f.root,{recursive:true,force:true});}
});
for(const alteration of ["missing-candidate","wrong-object-hash","foreign-attempt","terminal-journal","extra-object","extra-candidate","corrupt-payload","unknown-version"] as const)it(`pre-head import recovery blocks ${alteration} without publishing`,async()=>{
 const f=await preHeadImport();try {
  const candidate=f.ns.path(...f.loc.parts,`head.${f.attempt.id}.tmp`);
  const raw=JSON.parse(Buffer.from(await f.nextFs.bytes(candidate,8192)).toString());
  if(alteration==="corrupt-payload")await writeFile(f.nextFs.name(f.ns.object(f.loc,raw)),Buffer.alloc(f.bytes.length,13));
  if(alteration==="missing-candidate")await f.nextFs.unlink(candidate);
  if(alteration==="extra-candidate")await f.ns.writeNew(f.ns.path(...f.loc.parts,`head.${randomUUID()}.tmp`),raw);
  if(alteration==="extra-object")await f.ns.writeNew(f.ns.path(...f.loc.parts,"objects","r_"+"a".repeat(32)+".bin"),{extra:true});
  if(alteration==="terminal-journal")await f.ns.writeNew(f.loc.head,raw); // then remove it after terminal evidence is durable
  if(alteration==="terminal-journal") {
    const s=new AtomicStore(f.nextFs);await s.initialize();
    await s.recordImport(f.nextOwner,f.planId,{key:"first",state:"committed",receipt:raw.receipt,skipReason:null,publicationTicket:f.attempt});await s.dispose();
    await f.nextFs.unlink(f.loc.head);
  }
  if(["wrong-object-hash","foreign-attempt","unknown-version"].includes(alteration)) {
    if(alteration==="wrong-object-hash") {raw.sha256="0".repeat(64);raw.metadata.record.sha256=raw.sha256;}
    if(alteration==="foreign-attempt")raw.receipt.commitId=randomUUID();
    if(alteration==="unknown-version")raw.formatVersion=99;
    await f.nextFs.unlink(candidate);await f.ns.writeNew(candidate,raw);
  }
  await expect(new AtomicStore(f.nextFs).initialize()).rejects.toThrow("recovery-blocked");
  expect(await f.ns.head(f.loc)).toBeNull();
 }finally{await rm(f.root,{recursive:true,force:true});}
});
for(const edge of [".prepublish.bin",".prepublish-head"])it(`pre-head import quarantine interruption after ${edge} retains bytes and no head`,async()=>{
 const f=await preHeadImport();try {
  const replace=f.nextFs.atomicReplace.bind(f.nextFs);
  let injected=false;
  f.nextFs.atomicReplace=async(from,to)=>{
    await replace(from,to);
    if(!injected && f.nextFs.name(to).endsWith(edge)){injected=true;throw Error("quarantine-interrupted");}
  };
  await expect(scanNamespace(f.ns,f.nextOwner.hostEpoch)).rejects.toThrow("quarantine-interrupted");
  f.nextFs.atomicReplace=replace;
  const scan=await scanNamespace(f.ns,f.nextOwner.hostEpoch);
  expect(scan.problems).toEqual([]);expect(scan.totals.temporary).toBe(f.bytes.length);
  expect(await f.ns.head(f.loc)).toBeNull();
  const retained=await f.nextFs.bytes(f.ns.path("quarantine",`${f.attempt.id}.prepublish.bin`),8388608);
  expect(createHash("sha256").update(retained).digest("hex")).toBe(f.tag.sourceSha256);
  const store=new AtomicStore(f.nextFs);await store.initialize();
  expect(await store.reconcileImport(f.attempt)).toEqual({disposition:"not-committed"});
  await store.dispose();
 }finally{await rm(f.root,{recursive:true,force:true});}
});


it("unresolved ordinary first-create retains exact evidence across unavailable startups while safe old staging is cleaned",async()=>{
 const f=await preHeadImport(true);try {
  // This independent sealed write was made through the actual engine before the snapshot.
  expect(f.safeAttempt).toBeDefined();
  const safeDir=f.ns.path("staging",f.safeAttempt!.id);
  const evidence=async()=>{
    const files=(await f.ns.inventory()).filter(file=>file.relative.startsWith(`staging/${f.attempt.id}/`) || file.relative.startsWith(`records/${f.attempt.target.kind==="record"?f.attempt.target.id:""}/`));
    return Promise.all(files.sort((a,b)=>a.relative.localeCompare(b.relative)).map(async file=>({name:file.relative,bytes:file.bytes,sha256:createHash("sha256").update(await f.nextFs.bytes(file.path,8388608)).digest("hex")})));
  };
  const before=await evidence();
  expect(before.some(e=>e.name.endsWith("intent.json"))).toBe(true);
  expect(before.some(e=>e.name.endsWith("sealed.json"))).toBe(true);
  for(let n=0;n<3;n++) {
    const fs=await createNodePersistenceFs(f.snapshot,{hostEpoch:randomUUID(),assertHeld(){}});
    await expect(new AtomicStore(fs).initialize()).rejects.toThrow("recovery-blocked");
    expect(await evidence()).toEqual(before);
    expect(await f.ns.head(f.loc)).toBeNull();
    expect(await f.nextFs.entries(f.ns.path("quarantine"),4096)).toEqual([]);
    expect(await f.nextFs.exists(safeDir)).toBe(false);
  }
  // Already-erased evidence is not recreated and does not grant recovery authority.
  await f.nextFs.unlink(f.ns.path("staging",f.attempt.id,"intent.json"));
  await expect(new AtomicStore(f.nextFs).initialize()).rejects.toThrow("recovery-blocked");
  expect(await f.nextFs.exists(f.ns.path("staging",f.attempt.id,"intent.json"))).toBe(false);
  expect(await f.nextFs.exists(f.ns.path("staging",f.attempt.id,"sealed.json"))).toBe(true);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

it("two consecutive prepublish crashes finish half quarantine and retain both 8 MiB payloads",async()=>{
 const f=await preHeadImport();try {
  const original=structuredClone(f.attempt),planned=structuredClone(f.planned);
  const replace=f.nextFs.atomicReplace.bind(f.nextFs);let interrupted=false;
  f.nextFs.atomicReplace=async(from,to)=>{await replace(from,to);if(!interrupted && f.nextFs.name(to).endsWith(".prepublish.bin")){interrupted=true;throw Error("half-quarantine");}};
  await expect(scanNamespace(f.ns,f.nextOwner.hostEpoch)).rejects.toThrow("half-quarantine");
  f.nextFs.atomicReplace=replace;
  const oldCandidate=f.ns.path(...f.loc.parts,`head.${f.attempt.id}.tmp`);
  expect(await f.nextFs.exists(oldCandidate)).toBe(true);
  const reopened=new AtomicStore(f.nextFs);await reopened.initialize();
  const fresh=await reopened.admitImport(f.nextOwner,f.planId,"first");
  expect(fresh.id).not.toBe(f.attempt.id);expect(fresh.target).toEqual(f.attempt.target);
  await expect(reopened.reserve(f.attempt,f.bytes.length)).rejects.toThrow("stale");
  await reopened.reserve(fresh,f.bytes.length);await reopened.tagImport(fresh,f.tag);
  for(let offset=0;offset<f.bytes.length;offset+=262144)await reopened.append(fresh,offset,f.bytes.subarray(offset,offset+262144));
  await reopened.seal(fresh,f.bytes.length,f.tag.sourceSha256);
  const secondSnapshot=path.join(f.root,"second-snapshot");
  const fault=f.nextFs.fault.bind(f.nextFs);
  f.nextFs.fault=async(point,...args)=>{
    if(point==="before-publish") {
      await cp(path.join(f.snapshot,"plugins"),path.join(secondSnapshot,"plugins"),{recursive:true});
      throw Error("second-prepublish-process-loss");
    }
    return fault(point,...args);
  };
  await expect(reopened.publish(fresh)).rejects.toThrow("second-prepublish-process-loss");
  f.nextFs.fault=fault;await reopened.dispose();
  const owner={...f.nextOwner,hostEpoch:randomUUID(),processEpoch:randomUUID()};
  const fs=await createNodePersistenceFs(secondSnapshot,{hostEpoch:owner.hostEpoch,assertHeld(){}});
  const ns=await Namespace.open(fs,owner.sourceKey),loc=await ns.location(fresh.target);
  const store=new AtomicStore(fs);await store.initialize();
  for(let n=0;n<2;n++) {
    const scan=await scanNamespace(ns,owner.hostEpoch);
    expect(scan.problems).toEqual([]);expect(scan.totals.temporary).toBe(16777216);expect(scan.totals.committed).toBe(0);
    expect(await ns.head(loc)).toBeNull();expect((await store.list(owner,{limit:64})).entries).toEqual([]);
  }
  for(const ticket of [f.attempt,fresh]) {
    expect(await fs.exists(ns.path(...loc.parts,`head.${ticket.id}.tmp`))).toBe(false);
    const payload=await fs.bytes(ns.path("quarantine",`${ticket.id}.prepublish.bin`),8388608);
    expect(createHash("sha256").update(payload).digest("hex")).toBe(f.tag.sourceSha256);
    const head=JSON.parse(Buffer.from(await fs.bytes(ns.path("quarantine",`${ticket.id}.prepublish-head`),8192)).toString());
    expect(head.receipt.commitId).toBe(ticket.id);expect(head.metadata).toEqual(ticket.metadata);
    await expect(store.reserve(ticket,f.bytes.length)).rejects.toThrow("stale");
  }
  expect(await store.reconcileImport(fresh)).toEqual({disposition:"not-committed"});
  expect(await store.reconcileImport(f.planned)).toEqual({disposition:"not-committed"});
  expect(f.attempt).toEqual(original);expect(f.planned).toEqual(planned);
  await store.dispose();
 }finally{await rm(f.root,{recursive:true,force:true});}
});

for(const alteration of ["foreign-payload","occupied-head-destination","extra-candidate","foreign-journal"] as const)it(`half quarantine fails closed for ${alteration}`,async()=>{
 const f=await preHeadImport();try {
  const replace=f.nextFs.atomicReplace.bind(f.nextFs);let interrupted=false;
  f.nextFs.atomicReplace=async(from,to)=>{await replace(from,to);if(!interrupted && f.nextFs.name(to).endsWith(".prepublish.bin")){interrupted=true;throw Error("half-quarantine");}};
  await expect(scanNamespace(f.ns,f.nextOwner.hostEpoch)).rejects.toThrow("half-quarantine");f.nextFs.atomicReplace=replace;
  const candidate=f.ns.path(...f.loc.parts,`head.${f.attempt.id}.tmp`),payload=f.ns.path("quarantine",`${f.attempt.id}.prepublish.bin`),destination=f.ns.path("quarantine",`${f.attempt.id}.prepublish-head`);
  if(alteration==="foreign-payload")await writeFile(f.nextFs.name(payload),Buffer.alloc(f.bytes.length,13));
  if(alteration==="occupied-head-destination")await f.ns.writeNew(destination,{foreign:true});
  if(alteration==="extra-candidate")await f.ns.writeNew(f.ns.path(...f.loc.parts,`head.${randomUUID()}.tmp`),JSON.parse(Buffer.from(await f.nextFs.bytes(candidate,8192)).toString()));
  if(alteration==="foreign-journal") {
    const raw=JSON.parse(Buffer.from(await f.nextFs.bytes(candidate,8192)).toString());raw.importTag.itemKey="foreign";
    await writeFile(f.nextFs.name(candidate),JSON.stringify(raw));
  }
  const inventory=async()=>Promise.all((await f.ns.inventory()).filter(file=>file.relative.startsWith("records/") || file.relative.startsWith("quarantine/") || file.relative.startsWith(`staging/${f.attempt.id}/`)).map(async file=>({name:file.relative,sha:createHash("sha256").update(await f.nextFs.bytes(file.path,8388608)).digest("hex")})));
  const before=await inventory();await expect(new AtomicStore(f.nextFs).initialize()).rejects.toThrow("recovery-blocked");
  expect(await inventory()).toEqual(before);expect(await f.ns.head(f.loc)).toBeNull();
 }finally{await rm(f.root,{recursive:true,force:true});}
});
