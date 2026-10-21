import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { PersistenceOwner } from "@kobrixa/plugin-runtime";
import type { PublicationTicket } from "./engine-port.js";
import { AtomicStore } from "./atomic-store.js";
import { createNodePersistenceFs, NodePersistenceFs, type PersistenceFaultPoint } from "./filesystem.js";
const owner: PersistenceOwner = { sourceKey: "builtin:kobrixa.lab", pluginId: "kobrixa.lab", generation: 1, hostEpoch: "00000000-0000-4000-8000-000000000001", processEpoch: "00000000-0000-4000-8000-000000000002" };
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
function ticket(bytes: Uint8Array, id: string = randomUUID(), expectedRevision: string | null = null): PublicationTicket {
  return { id: randomUUID(), owner, deadlineMonotonicMs: 120000,
    target: { kind: "record", id, expectedRevision }, metadata: { kind: "record", deleted: false,
      record: { id, revision: "r_" + randomUUID().replaceAll("-", ""), kind: "lab.samples", schemaVersion: 1, label: "Lab", mediaType: "application/octet-stream", byteLength: bytes.length, sha256: hash(bytes), createdAt: 1, updatedAt: 1, checkpoint: "none", interrupted: false } } };
}
async function setup(fault: (point: PersistenceFaultPoint) => Promise<void> = async () => {}) {
  const root = await mkdtemp(path.join(tmpdir(), "atomic-")); let now = 0;
  const fs = await createNodePersistenceFs(root, { hostEpoch: owner.hostEpoch, assertHeld() {} }, { now: () => now, fault });
  const store = new AtomicStore(fs); await store.initialize();
  return { fs, store, advance: (n: number) => { now += n; }, close: async () => { await store.dispose(); await rm(root, { recursive: true, force: true }); } };
}
async function stage(s: AtomicStore, t: PublicationTicket, bytes: Uint8Array) {
  await s.reserve(t, bytes.length);
  for (let offset = 0; offset < bytes.length; offset += 262144) await s.append(t, offset, bytes.subarray(offset, offset + 262144));
  await s.seal(t, bytes.length, hash(bytes));
}
it("B2-RF1: cancellation before dispatch wins; after dispatch stays unknown until original reconciliation", async () => {
  const env = await setup();
  try {
    const first = ticket(new Uint8Array([1])); await stage(env.store, first, new Uint8Array([1])); const old = await env.store.publish(first);
    expect(old.disposition).toBe("committed");
    const blocked = ticket(new Uint8Array([2]), first.target.kind === "record" ? first.target.id : "", old.receipt!.revision);
    await stage(env.store, blocked, new Uint8Array([2])); env.store.fenceTarget(owner, blocked.target.kind === "record" ? blocked.target.id : "", 0);
    expect((await env.store.publish(blocked)).disposition).toBe("not-committed");
    await env.store.abort(blocked);
  } finally { await env.close(); }
  let pause = false, entered!: () => void, resume!: () => void;
  const atRename = new Promise<void>(r => { entered = r; }), release = new Promise<void>(r => { resume = r; });
  const env2 = await setup();
  try {
    const replace = env2.fs.atomicReplace.bind(env2.fs);
    env2.fs.atomicReplace = async (from, to) => {
      if (pause && env2.fs.name(to).endsWith("head.json")) { entered(); await release; }
      return replace(from, to);
    };
    const t = ticket(new Uint8Array([7])); await stage(env2.store, t, new Uint8Array([7])); pause = true;
    const pending = env2.store.publish(t); await atRename;
    env2.store.fence(owner, 0);
    expect(await env2.store.abort(t)).toBe("unknown");
    expect(env2.store.settledDisposition(t.id)).toBeNull();
    expect((await env2.store.reconcile(t)).disposition).toBe("unknown");
    await expect(env2.store.reserve(ticket(new Uint8Array([8])), 1)).rejects.toThrow();
    resume(); const result = await pending;
    const reconciled = await env2.store.reconcile(t);
    expect(reconciled.receipt).toEqual(result.receipt);
    expect(reconciled.disposition).toBe("committed");
    expect((await env2.store.reconcile(t)).receipt).toEqual(reconciled.receipt);
  } finally { resume?.(); await env2.close(); }
});
it("pins old bytes, rejects gaps and altered retries, and retains a stable list snapshot", async () => {
  const env = await setup();
  try {
    const t = ticket(new Uint8Array([1, 2])); await env.store.reserve(t, 2);
    await expect(env.store.append({ ...t, owner: { ...owner, processEpoch: randomUUID() } }, 0, new Uint8Array([1]))).rejects.toThrow("stale");
    expect(env.store.quota.snapshot(owner.sourceKey).reservedBytes).toBe(2);
    expect(await env.store.append(t, 0, new Uint8Array([1]))).toBe(1);
    env.advance(1000); expect(await env.store.append(t, 0, new Uint8Array([1]))).toBe(1);
    await expect(env.store.append(t, 0, new Uint8Array([9]))).rejects.toThrow("offset-mismatch");
    await expect(env.store.append(t, 2, new Uint8Array([2]))).rejects.toThrow("offset-mismatch");
    await env.store.append(t, 1, new Uint8Array([2])); await env.store.seal(t, 2, hash(new Uint8Array([1, 2])));
    const committed = await env.store.publish(t), id = t.target.kind === "record" ? t.target.id : "";
    const pin = await env.store.open(owner, id, committed.receipt!.revision);
    const replacement = ticket(new Uint8Array([3]), id, committed.receipt!.revision);
    await stage(env.store, replacement, new Uint8Array([3])); await env.store.publish(replacement);
    expect([...await env.store.read(owner, pin, 0, 2)]).toEqual([1, 2]);
    await expect(env.store.read({ ...owner, generation: 2 }, pin, 0, 2)).rejects.toThrow("stale");
    await env.store.close(owner, pin); await env.store.close(owner, pin);
    expect((await env.store.list(owner, { limit: 64 })).entries).toHaveLength(1);
  } finally { await env.close(); }
});
it("keeps pagination immutable across a new commit and expires both read and list handles", async () => {
  const env = await setup();
  try {
    const a = ticket(new Uint8Array([1])), b = ticket(new Uint8Array([2]));
    await stage(env.store, a, new Uint8Array([1])); const receipt = await env.store.publish(a);
    await stage(env.store, b, new Uint8Array([2])); await env.store.publish(b);
    const pin = await env.store.open(owner, a.target.kind === "record" ? a.target.id : "", receipt.receipt!.revision);
    const first = await env.store.list(owner, { limit: 1 });
    const c = ticket(new Uint8Array([3])); await stage(env.store, c, new Uint8Array([3])); await env.store.publish(c);
    const second = await env.store.list(owner, { limit: 1, cursor: first.nextCursor! });
    expect(second.entries).toHaveLength(1); expect(second.nextCursor).toBeUndefined();
    expect(second.entries[0]?.id).not.toBe(first.entries[0]?.id);
    expect((await env.store.list(owner, { limit: 64 })).entries).toHaveLength(3);
    env.advance(30000);
    await expect(env.store.read(owner, pin, 0, 1)).rejects.toThrow("stale");
    await expect(env.store.list(owner, { limit: 1, cursor: first.nextCursor! })).rejects.toThrow("stale");
  } finally { await env.close(); }
});
it("does not renew the original staging lease for repeated seal/retry", async () => {
  const env = await setup();
  try {
    const t = ticket(new Uint8Array()); await stage(env.store, t, new Uint8Array());
    env.advance(30000); await expect(env.store.seal(t, 0, hash(new Uint8Array()))).rejects.toThrow("expired");
    expect((await env.store.publish(t)).disposition).toBe("not-committed");
  } finally { await env.close(); }
});
it("B2-RF5: item receipt binds the durable attempt and original evidence reconciles it", async () => {
  const env=await setup();
  try {
    const bytes=new Uint8Array([9]),original=ticket(bytes),descriptorId="test.synthetic-import";
    const id="import/"+hash(Buffer.from(JSON.stringify([descriptorId,owner.sourceKey])));
    const tag={importId:id,itemKey:"record-0",sourceSha256:hash(bytes)};
    await env.store.planImport(owner,{formatVersion:1,id,descriptorId,mappingVersion:1,preferencesEvidence:null,
      targetSourceKey:owner.sourceKey,items:[{key:"record-0",sourceFormat:1,sourceSha256:hash(bytes),mappedSha256:hash(bytes),
        byteLength:1,ticket:original,tag}]});
    const attempt=await env.store.admitImport(owner,id,"record-0");
    expect((await env.store.loadImport(owner,id))?.items[0]?.publicationTicket).toEqual(attempt);
    await env.store.reserve(attempt,1);await env.store.tagImport(attempt,tag);
    await env.store.append(attempt,0,bytes);await env.store.seal(attempt,1,hash(bytes));
    const result=await env.store.publish(attempt),receipts=await env.store.importReceipts(owner,id);
    expect(receipts).toHaveLength(1);expect(receipts[0]?.receipt).toEqual(result.receipt);
    expect(receipts[0]?.ticket).toEqual(attempt);expect(result.receipt?.commitId).toBe(attempt.id);
    expect(await env.store.reconcileImport(original)).toEqual(result);
    await expect(env.store.admitImport(owner,id,"record-0")).rejects.toThrow("already-committed");
    expect((await env.store.loadImport(owner,id))?.items[0]?.state).toBe("committed");
  } finally {await env.close();}
});
it("B2-RF5: streams 50 maximum records plus two complete reservations without retaining 400 MiB", async () => {
  const env = await setup();
  try {
    const chunk = new Uint8Array(262144), digest = createHash("sha256");
    for (let i = 0; i < 32; i++) digest.update(chunk);
    const sha256 = digest.digest("hex");
    const make = (): PublicationTicket => {
      const t = ticket(new Uint8Array());
      if (t.metadata.kind !== "record") throw new Error("test-target");
      return { ...t, metadata: { ...t.metadata, record: { ...t.metadata.record, byteLength: 8388608, sha256 } } };
    };
    for (let index = 0; index < 50; index++) {
      const t = make(); await env.store.reserve(t, 8388608);
      for (let offset = 0; offset < 8388608; offset += chunk.length) await env.store.append(t, offset, chunk);
      await env.store.seal(t, 8388608, sha256);
      expect((await env.store.publish(t)).disposition).toBe("committed");
    }
    const a = make(), b = make(); await env.store.reserve(a, 8388608); await env.store.reserve(b, 8388608);
    const q = env.store.quota.snapshot(owner.sourceKey);
    expect(q.recordCount).toBe(50); expect(q.committedBytes).toBe(419430400); expect(q.reservedBytes).toBe(16777216);
    expect(q.committedBytes + q.reservedBytes).toBe(436207616); expect(q.writeSlotsAvailable).toBe(0);
    const first = await env.store.list(owner, { limit: 16 }); expect(first.entries).toHaveLength(16);
    const next = await env.store.list(owner, { limit: 16, cursor: first.nextCursor! });
    expect(await env.store.list(owner, { limit: 16, cursor: first.nextCursor! })).toEqual(next);
    await env.store.abort(a); await env.store.abort(b);
  } finally { await env.close(); }
}, 120000);

for (const point of ["reserve", "open-temp", "chunk-write", "seal-sync", "object-rename", "object-dir-sync", "backup-head", "head-write", "before-publish", "after-publish", "head-dir-sync", "cache-publish", "receipt-send", "cleanup"] as const) {
  for (const edge of ["before", "after"] as const) {
    it(`failed ${point}/${edge} never exposes a partial replacement`, async () => {
      let armed = false;
      const root = await mkdtemp(path.join(tmpdir(), "fault-matrix-"));
      const fs = await createNodePersistenceFs(root, { hostEpoch: owner.hostEpoch, assertHeld() {} }, { now: () => 0,
        fault: async (p, e) => { if (armed && p === point && e === edge) throw Object.assign(new Error("injected"), { code: "EIO" }); } });
      const store = new AtomicStore(fs); await store.initialize();
      try {
        const oldTicket = ticket(new Uint8Array([1])); await stage(store, oldTicket, new Uint8Array([1]));
        const old = await store.publish(oldTicket), id = oldTicket.target.kind === "record" ? oldTicket.target.id : "";
        const next = ticket(new Uint8Array([2]), id, old.receipt!.revision); armed = true;
        let result: Awaited<ReturnType<AtomicStore["publish"]>> | null = null;
        try { await stage(store, next, new Uint8Array([2])); result = await store.publish(next); } catch { /* Failure is the injection's expected result. */ }
        armed = false;
        if (result?.disposition === "unknown") {
          const reconciled = await store.reconcile(next); expect(reconciled.disposition).toBe("committed");
        }
        const meta = await store.stat(owner, id);
        expect([hash(new Uint8Array([1])), hash(new Uint8Array([2]))]).toContain(meta.sha256);
        if (["reserve", "open-temp", "chunk-write", "seal-sync", "object-rename", "object-dir-sync", "backup-head", "head-write", "before-publish"].includes(point)) expect(meta.revision).toBe(old.receipt!.revision);
        else expect(meta.sha256).toBe(hash(new Uint8Array([2])));
      } finally { armed = false; await store.dispose().catch(() => {}); await rm(root, { recursive: true, force: true }); }
    });
  }
}

import { Namespace } from "./namespace.js";
it("record objects have no version prefix and unknown head versions never rewrite bytes",async()=>{
  const env=await setup(),bytes=new Uint8Array([0,255,123,34,0,10]),t=ticket(bytes);
  try {
    await stage(env.store,t,bytes);await env.store.publish(t);
    const ns=await Namespace.open(env.fs,owner.sourceKey),loc=await ns.location(t.target),head=(await ns.head(loc))!;
    const raw=await env.fs.bytes(ns.object(loc,head),8388608);expect(raw).toEqual(bytes);expect(raw.length).toBe(bytes.length);expect(hash(raw)).toBe(hash(bytes));
    await env.fs.unlink(loc.head);await ns.writeNew(loc.head,{...head,formatVersion:99});
    await expect(ns.head(loc)).rejects.toThrow("unsupported-format");
    expect(await env.fs.bytes(ns.object(loc,head),8388608)).toEqual(bytes);
  }finally{await env.close();}
});
async function planned(env:Awaited<ReturnType<typeof setup>>, original=ticket(new Uint8Array([1]))) {
  const descriptorId="test.attempt",id="import/"+hash(Buffer.from(JSON.stringify([descriptorId,owner.sourceKey])));
  const tag={importId:id,itemKey:"one",sourceSha256:hash(new Uint8Array([1]))};
  await env.store.planImport(owner,{formatVersion:1,id,descriptorId,mappingVersion:1,targetSourceKey:owner.sourceKey,preferencesEvidence:null,
    items:[{key:"one",sourceFormat:1,sourceSha256:tag.sourceSha256,mappedSha256:tag.sourceSha256,byteLength:1,ticket:original,tag}]});
  return {id,original,tag};
}
it("serializes duplicate admission and replaces a tagged receiving attempt without renewing its deadline",async()=>{
  const env=await setup();try {
    const p=await planned(env);
    expect((await env.store.loadImport(owner,p.id))?.items[0]?.publicationTicket).toBeNull();
    const [a,b]=await Promise.all([env.store.admitImport(owner,p.id,"one"),env.store.admitImport(owner,p.id,"one")]);
    expect(b).toEqual(a);expect(a.id).not.toBe(p.original.id);expect(a.metadata).toEqual(p.original.metadata);expect(a.target).toEqual(p.original.target);
    await env.store.reserve(a,1);await env.store.tagImport(a,p.tag);await env.store.append(a,0,new Uint8Array([1]));env.advance(100);
    const replacement=await env.store.admitImport(owner,p.id,"one");
    expect(replacement.id).not.toBe(a.id);expect(replacement.deadlineMonotonicMs).toBe(a.deadlineMonotonicMs);
    await expect(env.store.append(a,0,new Uint8Array([1]))).rejects.toThrow();
    env.advance(10000);await expect(env.store.admitImport(owner,p.id,"one")).rejects.toThrow("stale");
  }finally{await env.close();}
});
it("fresh-host admission preserves original evidence and uses the entire current owner",async()=>{
  const env=await setup();try {
    const p=await planned(env),a=await env.store.admitImport(owner,p.id,"one");await env.store.dispose();
    const current={...owner,hostEpoch:randomUUID(),processEpoch:randomUUID(),generation:9};
    const fs=await createNodePersistenceFs(path.resolve(env.fs.root,"../.."),{hostEpoch:current.hostEpoch,assertHeld(){}},{now:()=>500});
    const next=new AtomicStore(fs);await next.initialize();
    for(const operation of [()=>next.reserve(a,1),()=>next.append(a,0,new Uint8Array([1])),()=>next.seal(a,1,p.tag.sourceSha256),()=>next.publish(a)])await expect(operation()).rejects.toThrow();
    const fresh=await next.admitImport(current,p.id,"one");expect(fresh.owner).toEqual(current);expect(fresh.target).toEqual(a.target);expect(fresh.metadata).toEqual(a.metadata);expect(fresh.deadlineMonotonicMs).toBe(10500);
    await expect(next.reconcileImport({...p.original,owner:{...owner,processEpoch:randomUUID()}})).rejects.toThrow("stale");
    await next.dispose();
  }finally{await env.close();}
});
it("committed durable import evidence stays terminal after target deletion",async()=>{
  const env=await setup();try {
    const p=await planned(env),a=await env.store.admitImport(owner,p.id,"one");
    await env.store.reserve(a,1);await env.store.tagImport(a,p.tag);await env.store.append(a,0,new Uint8Array([1]));await env.store.seal(a,1,p.tag.sourceSha256);
    const committed=await env.store.publish(a);await env.store.completeImport(owner,p.id);
    if(a.metadata.kind!=="record" || a.target.kind!=="record")throw new Error("test-target");
    const deletion:PublicationTicket={...a,id:randomUUID(),target:{...a.target,expectedRevision:committed.receipt!.revision},metadata:{kind:"record",deleted:true,record:{...a.metadata.record,revision:"r_"+randomUUID().replaceAll("-","")}}};
    await stage(env.store,deletion,new Uint8Array());expect((await env.store.publish(deletion)).disposition).toBe("committed");
    expect(await env.store.reconcileImport(p.original)).toEqual(committed);
    expect((await env.store.importReceipts(owner,p.id))[0]?.ticket).toEqual(a);
    await expect(env.store.admitImport(owner,p.id,"one")).rejects.toThrow("stale");
  }finally{await env.close();}
});
it("unknown association publication retains the original metadata ticket and blocks a replacement",async()=>{
  const env=await setup();try {
    const p=await planned(env),replace=env.fs.atomicReplace.bind(env.fs);let fail=true,writes=0;
    env.fs.atomicReplace=async(from,to)=>{if(fail && env.fs.name(to).includes("/imports/") && !env.fs.name(to).includes("/objects/") && env.fs.name(to).endsWith(".json")){writes++;throw new Error("unknown-rename");}return replace(from,to);};
    const originalBytes=env.fs.bytes.bind(env.fs);let deny=false;
    env.fs.bytes=async(path,max)=>{if(deny && env.fs.name(path).includes("/imports/") && env.fs.name(path).endsWith(".json"))throw Object.assign(new Error("denied"),{code:"EACCES"});return originalBytes(path,max);};
    // Make the post-dispatch head inspection unreadable; absence must never be inferred.
    env.fs.atomicReplace=async(from,to)=>{if(fail && env.fs.name(to).includes("/imports/") && !env.fs.name(to).includes("/objects/") && env.fs.name(to).endsWith(".json")){writes++;deny=true;throw new Error("unknown-rename");}return replace(from,to);};
    await expect(env.store.admitImport(owner,p.id,"one")).rejects.toThrow("publish-uncertain");
    await expect(env.store.admitImport(owner,p.id,"one")).rejects.toThrow();expect(writes).toBe(1);
    deny=false;fail=false;
    // Reconciliation can prove the unchanged predecessor, then a single new association may proceed.
    const next=await env.store.admitImport(owner,p.id,"one");expect((await env.store.loadImport(owner,p.id))?.items[0]?.publicationTicket).toEqual(next);
  }finally{await env.close();}
});
it("loss of the held profile denies import admission and all payload mutation",async()=>{
  const env=await setup();try {
    const p=await planned(env),a=await env.store.admitImport(owner,p.id,"one");await env.store.reserve(a,1);
    env.fs.profile.assertHeld=()=>{throw new Error("not-primary");};
    await expect(env.store.admitImport(owner,p.id,"one")).rejects.toThrow("not-primary");
    await expect(env.store.append(a,0,new Uint8Array([1]))).rejects.toThrow("not-primary");
    env.fs.profile.assertHeld=()=>{};
  }finally{await env.close();}
});

it('retains committed and aborted tombstones for captured evidence after entry pruning',async()=>{
  const env=await setup();try {
    const a=ticket(new Uint8Array([1])),b=ticket(new Uint8Array([2]));
    await stage(env.store,a,new Uint8Array([1]));await env.store.publish(a);
    await env.store.reserve(b,1);await env.store.abort(b);env.advance(120001);
    const c={...ticket(new Uint8Array()),deadlineMonotonicMs:240001};await env.store.reserve(c,0);
    const barrier={id:randomUUID(),scope:{kind:'namespace' as const,owner},through:2,deadlineMonotonicMs:240000};
    expect(await env.store.flushEvidence(barrier,[a,b])).toEqual({state:'failed',accepted:[a.id,b.id],incomplete:[b.id],unknown:[]});
    await env.store.abort(c);
  }finally{await env.close();}
});
it.each(['owner','target'] as const)('reserve rechecks %s fence after awaited temp creation',async kind=>{
  const env=await setup();try {
    const t=ticket(new Uint8Array([1])),open=env.fs.open.bind(env.fs);
    env.fs.open=async(p,mode)=>{const fd=await open(p,mode);if(env.fs.name(p).endsWith('payload.tmp')) {
      if(kind==='owner')env.store.fence(owner,0);else env.store.fenceTarget(owner,t.target.kind==='record'?t.target.id:'',0);
    }return fd;};
    await expect(env.store.reserve(t,1)).rejects.toThrow('stale');
    expect(env.store.quota.snapshot(owner.sourceKey).reservedBytes).toBe(0);
    await expect(env.store.append(t,0,new Uint8Array([1]))).rejects.toThrow('stale');
  }finally{await env.close();}
});
it.each(['document','admit','pruned'] as const)('clears failed reserve identity before retrying %s metadata',async mode=>{
  const env=await setup();try {
    const p=await planned(env),open=env.fs.open.bind(env.fs),unlink=env.fs.unlink.bind(env.fs);let fail=true;
    env.fs.open=async(path,access)=>{if(fail && env.fs.name(path).endsWith('payload.tmp'))throw new Error('injected');return open(path,access);};
    env.fs.unlink=async path=>{if(fail && env.fs.name(path).endsWith('intent.json'))throw new Error('injected-cleanup');return unlink(path);};
    const run=()=>mode==='admit'?env.store.admitImport(owner,p.id,'one'):env.store.recordImport(owner,p.id,{key:'one',state:'skipped',receipt:null,skipReason:'skip',publicationTicket:null});
    await expect(run()).rejects.toThrow('publish-uncertain');fail=false;
    if(mode==='pruned') {
      // Unrelated work prunes the failed reserve before its owning document retries.
      await env.store.settings(owner);env.advance(240001);await env.store.settings(owner);
    }
    await run();
  }finally{await env.close().catch(()=>rm(path.dirname(path.dirname(env.fs.root)),{recursive:true,force:true}));}
});
it('a skipped item cannot admit a publication',async()=>{
  const env=await setup();try {const p=await planned(env);await env.store.recordImport(owner,p.id,{key:'one',state:'skipped',receipt:null,skipReason:'skip',publicationTicket:null});await expect(env.store.admitImport(owner,p.id,'one')).rejects.toThrow('stale');}finally{await env.close();}
});
it.each(['foreign-tag','newer-untagged'] as const)('a %s destination head remains unknown and cannot admit',async kind=>{
  const env=await setup();try {
    const p=await planned(env),a=await env.store.admitImport(owner,p.id,'one');
    await env.store.reserve(a,1);await env.store.tagImport(a,p.tag);await env.store.append(a,0,new Uint8Array([1]));await env.store.seal(a,1,p.tag.sourceSha256);await env.store.publish(a);
    const ns=await Namespace.open(env.fs,owner.sourceKey),loc=await ns.location(a.target),head=(await ns.head(loc))!;
    const {importTag,...untagged}=head;
    await env.fs.unlink(loc.head);await ns.writeNew(loc.head,kind==='foreign-tag'?{...head,importTag:{...importTag,itemKey:'foreign'}}:{...untagged,receipt:{...head.receipt,commitId:randomUUID()}});
    const fs=new NodePersistenceFs(env.fs.root,{hostEpoch:randomUUID(),assertHeld(){}},{now:()=>500}),next=new AtomicStore(fs);await next.initialize();
    const current={...owner,hostEpoch:fs.profile.hostEpoch,processEpoch:randomUUID()};
    expect(await next.reconcileImport(p.original)).toEqual({disposition:'unknown'});
    await expect(next.admitImport(current,p.id,'one')).rejects.toThrow('publish-uncertain');await next.dispose();
  }finally{await env.close();}
});
it.each(['permission','corrupt'] as const)('%s failure reading the plan head yields unknown',async kind=>{
  const env=await setup();try {
    const p=await planned(env),bytes=env.fs.bytes.bind(env.fs);
    env.fs.bytes=async(path,max)=>{if(env.fs.name(path).includes('/imports/') && !env.fs.name(path).includes('/objects/')) {
      if(kind==='permission')throw Object.assign(new Error('denied'),{code:'EACCES'});return Buffer.from('{}');
    }return bytes(path,max);};
    expect(await env.store.reconcileImport(p.original)).toEqual({disposition:'unknown'});
    await expect(env.store.admitImport(owner,p.id,'one')).rejects.toThrow();env.fs.bytes=bytes;
  }finally{await env.close();}
});
it('restart after tagged destination head before receipt reconciles original without reviving write rights',async()=>{
  const env=await setup();try {
    const p=await planned(env),a=await env.store.admitImport(owner,p.id,'one');
    await env.store.reserve(a,1);await env.store.tagImport(a,p.tag);await env.store.append(a,0,new Uint8Array([1]));await env.store.seal(a,1,p.tag.sourceSha256);
    const receipt=await env.store.publish(a);expect((await env.store.loadImport(owner,p.id))?.items[0]?.state).toBe('pending');
    const fs=new NodePersistenceFs(env.fs.root,{hostEpoch:randomUUID(),assertHeld(){}},{now:()=>500}),next=new AtomicStore(fs);await next.initialize();
    const current={...owner,hostEpoch:fs.profile.hostEpoch,processEpoch:randomUUID()};
    expect(await next.reconcileImport(p.original)).toEqual(receipt);expect(await next.reconcileImport(a)).toEqual(receipt);
    expect((await next.importReceipts(current,p.id))[0]?.ticket).toEqual(a);
    for(const t of [p.original,a])for(const run of [()=>next.reserve(t,1),()=>next.append(t,0,new Uint8Array([1])),()=>next.seal(t,1,p.tag.sourceSha256),()=>next.publish(t)])await expect(run()).rejects.toThrow();
    await expect(next.admitImport(current,p.id,'one')).rejects.toThrow('already-committed');await next.dispose();
  }finally{await env.close();}
});

it('reports terminal attempts settled by import replacement, but never receiving or unknown attempts',async()=>{
  const env=await setup();try {
    const p=await planned(env),a=await env.store.admitImport(owner,p.id,'one');await env.store.reserve(a,1);
    expect(env.store.settledDisposition(a.id)).toBeNull();
    await env.store.admitImport(owner,p.id,'one');expect(env.store.settledDisposition(a.id)).toBe('aborted');
  }finally{await env.close();}
});
it('reports a clean rejected reserve as terminal without settling an unclean reserve',async()=>{
  const env=await setup();try {
    const t=ticket(new Uint8Array([1])),open=env.fs.open.bind(env.fs),unlink=env.fs.unlink.bind(env.fs);let unclean=false;
    env.fs.open=async(p,mode)=>{if(env.fs.name(p).endsWith('payload.tmp'))throw new Error('open-failed');return open(p,mode);};
    env.fs.unlink=async p=>{if(unclean)throw new Error('unlink-failed');return unlink(p);};
    await expect(env.store.reserve(t,1)).rejects.toThrow('open-failed');expect(env.store.settledDisposition(t.id)).toBe('aborted');
    unclean=true;const uncertain=ticket(new Uint8Array([1]));await expect(env.store.reserve(uncertain,1)).rejects.toThrow('open-failed');
    expect(env.store.settledDisposition(uncertain.id)).toBeNull();unclean=false;await env.store.abort(uncertain);
  }finally{await env.close();}
});
it('late operations on a settled uncleaned entry cannot fence a recycled shared gate',async()=>{
  let fail=false;const env=await setup(async point=>{if(fail && point==='cleanup')throw new Error('cleanup-failed');});
  try {
    const bytes=new Uint8Array([1]),t=ticket(bytes),memory=new SharedArrayBuffer(16);
    const {PublicationGate}=await import('./engine-port.js');new PublicationGate(t.deadlineMonotonicMs,memory,0,true);
    await env.store.reserve(t,1,memory);await env.store.append(t,0,bytes);await env.store.seal(t,1,hash(bytes));fail=true;
    expect((await env.store.publish(t)).disposition).toBe('committed');env.advance(120001);
    const recycled=new PublicationGate(240000,memory,0,true);
    expect(await env.store.abort(t)).toBe('committed');env.store.fenceTargetOrTicket(t);
    expect(recycled.dispatch(120001)).toBe(true);
  }finally{fail=false;await env.close();}
});

async function registerCheckpoint(store: AtomicStore, t: PublicationTicket) {
  if(t.metadata.kind!=="record")throw new Error("record required");
  const checkpoint=randomUUID(),bytes=Buffer.from(JSON.stringify({formatVersion:1,checkpoint,record:t.metadata.record,binding:null,state:"open"}));
  const document:PublicationTicket={id:randomUUID(),owner,deadlineMonotonicMs:120000,
    target:{kind:"recovery",key:checkpoint},metadata:{kind:"recovery",key:checkpoint}};
  await stage(store,document,bytes);await store.publish(document);return checkpoint;
}
it("T5: sealed pins validate original ticket, preserve TTL and reject fabricated pins",async()=>{
  const env=await setup();try {
    const bytes=new Uint8Array([1,2]),t=ticket(bytes);
    await env.store.reserve(t,2);await env.store.append(t,0,bytes);
    await expect(env.store.retainSealed(t)).rejects.toThrow();await env.store.seal(t,2,hash(bytes));
    const pin=await env.store.retainSealed(t);expect(pin.expiresMonotonicMs).toBe(30000);
    const row={id:randomUUID(),owner,ticket:t,sealedPin:randomUUID(),expiresAt:Date.now()+30000,
      report:{state:"retryable" as const,blocker:true,pendingSettings:false,records:[],errors:[]}};
    await expect(env.store.saveRecovery(row)).rejects.toThrow();
    await env.store.saveRecovery({...row,sealedPin:pin.pin});
    env.advance(20000);expect([...await env.store.read(owner,pin.pin,0,2)]).toEqual([1,2]);
    env.advance(10000);await expect(env.store.read(owner,pin.pin,0,2)).rejects.toThrow();
  }finally{await env.close();}
});
it("T5: checkpoint documents coexist with recovery rows and unknown shapes fail closed",async()=>{
  const env=await setup();try {
    const t=ticket(new Uint8Array([1]));await stage(env.store,t,new Uint8Array([1]));await env.store.publish(t);
    await registerCheckpoint(env.store,t);expect((await env.store.recoveryPage()).items).toHaveLength(0);
    const key=randomUUID(),bytes=Buffer.from(JSON.stringify({formatVersion:1,unknown:true}));
    const doc:PublicationTicket={id:randomUUID(),owner,deadlineMonotonicMs:120000,target:{kind:"recovery",key},metadata:{kind:"recovery",key}};
    await stage(env.store,doc,bytes);await env.store.publish(doc);await expect(env.store.recoveryPage()).rejects.toThrow();
  }finally{await env.close();}
});
it("T5 fence conflict: only one matching final grant admits after target freeze",async()=>{
  const env=await setup();try {
    const bytes=new Uint8Array([1]),initial=ticket(bytes);await stage(env.store,initial,bytes);await env.store.publish(initial);
    if(initial.metadata.kind!=="record")throw new Error("record required");
    const checkpoint=await registerCheckpoint(env.store,initial),id=initial.metadata.record.id;
    env.store.fenceTarget(owner,id,1000);
    const final=ticket(bytes,id,initial.metadata.record.revision);if(final.metadata.kind==="record")final.metadata.record.checkpoint="final";
    const grant={owner,recordId:id,checkpoint,token:randomUUID(),deadlineMonotonicMs:1000};
    await expect(env.store.reserve(final,1)).rejects.toThrow("stale");
    await expect(env.store.reserveFinal(final,1,{...grant,checkpoint:randomUUID()})).rejects.toThrow();
    await env.store.reserveFinal(final,1,grant);await env.store.append(final,0,bytes);await env.store.seal(final,1,hash(bytes));
    expect((await env.store.publish(final)).disposition).toBe("committed");
    const repeat=ticket(bytes,id,final.metadata.kind==="record"?final.metadata.record.revision:null);
    if(repeat.metadata.kind==="record")repeat.metadata.record.checkpoint="final";
    await expect(env.store.reserveFinal(repeat,1,grant)).rejects.toThrow();
  }finally{await env.close();}
});
it("T5 fence conflict: retained core retry uses original ticket after drain, never extends TTL",async()=>{
  const env=await setup();try {
    const bytes=new Uint8Array([1]),t=ticket(bytes);await stage(env.store,t,bytes);
    const held=await env.store.retainSealed(t);env.store.fence(owner,1000);env.advance(1000);
    expect(await env.store.publish(t)).toMatchObject({disposition:"not-committed"});
    expect(await env.store.reconcile(t)).toMatchObject({disposition:"not-committed"});
    expect([...await env.store.read(owner,held.pin,0,1)]).toEqual([1]);
    expect(await env.store.publishRecovery(t,held.pin,11000)).toMatchObject({disposition:"committed"});
  }finally{await env.close();}
  const env2=await setup();try {
    const bytes=new Uint8Array([1]),t=ticket(bytes);await stage(env2.store,t,bytes);const held=await env2.store.retainSealed(t);
    env2.store.fence(owner,1000);env2.advance(30000);
    await expect(env2.store.publishRecovery(t,held.pin,40000)).rejects.toThrow();
  }finally{await env2.close();}
});
it("T5: unregistered post-deadline publication and foreign core retry remain rejected",async()=>{
  const env=await setup();try {
    const bytes=new Uint8Array([1]),t=ticket(bytes);await stage(env.store,t,bytes);env.store.fence(owner,1000);env.advance(1000);
    expect(await env.store.publish(t)).toMatchObject({disposition:"not-committed"});
    await expect(env.store.publishRecovery(t,randomUUID(),11000)).rejects.toThrow();
    await expect(env.store.reserve(ticket(bytes),1)).rejects.toThrow();
  }finally{await env.close();}
});
it("T5: closing a sealed pin removes retry authority and restored rows cannot advertise missing bytes",async()=>{
  const env=await setup();try {
    const bytes=new Uint8Array([1]),t=ticket(bytes);await stage(env.store,t,bytes);
    if(t.metadata.kind!=="record")throw new Error("record required");
    const held=await env.store.retainSealed(t),id=randomUUID();
    await env.store.saveRecovery({id,owner,ticket:t,sealedPin:held.pin,expiresAt:Date.now()+30000,
      report:{state:"retryable",blocker:true,pendingSettings:false,records:[{id:t.metadata.record.id,committedRevision:null,
        final:false,payload:"complete-staging",expiresAt:Date.now()+30000}],errors:[]}});
    await env.store.close(owner,held.pin);
    await expect(env.store.publishRecovery(t,held.pin,10000)).rejects.toThrow();
    expect(await env.store.loadRecovery(id)).toMatchObject({sealedPin:null,report:{state:"checkpoint-only",records:[{payload:"none"}]}});
  }finally{await env.close();}
});
it("T5: recovery metadata remains writable after owner fence without reopening plugin admissions",async()=>{
  const env=await setup();try {
    const bytes=new Uint8Array([1]),t=ticket(bytes);await stage(env.store,t,bytes);const held=await env.store.retainSealed(t);
    env.store.fence(owner,0);
    const id=randomUUID();await env.store.saveRecovery({id,owner,ticket:t,sealedPin:held.pin,expiresAt:Date.now()+30000,
      report:{state:"retryable",blocker:true,pendingSettings:false,records:[],errors:[]}});
    expect((await env.store.loadRecovery(id))?.ticket?.id).toBe(t.id);
    await expect(env.store.reserve(ticket(bytes),1)).rejects.toThrow("stale");
  }finally{await env.close();}
});
it("T5: failed core retry never renews retention and dispatched retry cannot be reopened",async()=>{
  let failure=false;
  const env=await setup(async point=>{if(failure && point==="before-publish")throw new Error("disk-full");});
  try {
    const bytes=new Uint8Array([1]),t=ticket(bytes);await stage(env.store,t,bytes);const held=await env.store.retainSealed(t);
    env.store.fence(owner,1000);env.advance(20000);failure=true;
    await expect(env.store.publishRecovery(t,held.pin,30000)).rejects.toThrow("disk-full");
    expect((await env.store.retainSealed(t)).expiresMonotonicMs).toBe(30000);
    env.advance(10000);failure=false;await expect(env.store.publishRecovery(t,held.pin,40000)).rejects.toThrow();
  }finally{await env.close();}
  let dispatched=0;
  const unknown=await setup(async point=>{if(point==="after-publish"){dispatched++;throw new Error("lost-reply");}});
  try {
    const bytes=new Uint8Array([1]),t=ticket(bytes);await stage(unknown.store,t,bytes);const held=await unknown.store.retainSealed(t);
    unknown.store.fence(owner,0);
    expect(await unknown.store.publishRecovery(t,held.pin,10000)).toMatchObject({disposition:"unknown"});
    await expect(unknown.store.publishRecovery(t,held.pin,10000)).rejects.toThrow();expect(dispatched).toBe(1);
    expect(await unknown.store.reconcile(t)).toMatchObject({disposition:"committed"});
  }finally{await unknown.close();}
});
it("T5: final registration updates persist under a fence and foreign owners cannot update them",async()=>{
  const env=await setup();try {
    const bytes=new Uint8Array([1]),t=ticket(bytes);await stage(env.store,t,bytes);await env.store.publish(t);
    if(t.metadata.kind!=="record")throw new Error("record required");
    const checkpoint=await registerCheckpoint(env.store,t);env.store.fence(owner,0);
    const value={checkpoint,record:{...t.metadata.record,checkpoint:"final" as const},binding:null,state:"final" as const};
    await expect(env.store.saveCheckpoint({...owner,generation:2},value)).rejects.toThrow();
    await env.store.saveCheckpoint(owner,value);
    expect(JSON.parse(Buffer.from((await env.store.auxiliary(owner,"recovery",checkpoint))!).toString("utf8"))).toMatchObject({state:"final"});
    await expect(env.store.reserve(ticket(bytes),1)).rejects.toThrow("stale");
  }finally{await env.close();}
});
it("T5: cancellation revokes a core retry before its dispatch boundary",async()=>{
  let reached!:()=>void,release!:()=>void;
  const paused=new Promise<void>(r=>reached=r),resume=new Promise<void>(r=>release=r);
  const env=await setup(async point=>{if(point==="before-publish"){reached();await resume;}});
  try {
    const bytes=new Uint8Array([1]),t=ticket(bytes);await stage(env.store,t,bytes);const held=await env.store.retainSealed(t);
    env.store.fence(owner,0);const publishing=env.store.publishRecovery(t,held.pin,10000);await paused;
    env.store.fenceTargetOrTicket(t);release();
    await expect(publishing).rejects.toThrow("expired");
    expect(await env.store.reconcile(t)).toMatchObject({disposition:"not-committed"});
  }finally{release?.();await env.close();}
});
it("T5: restart drops transient retry authority and permits discard of a known unpublished payload",async()=>{
  const env=await setup();let reopened:AtomicStore|undefined;
  try {
    const bytes=new Uint8Array([1]),t=ticket(bytes);await stage(env.store,t,bytes);const pin=await env.store.retainSealed(t);
    if(t.metadata.kind!=="record")throw new Error("record required");
    const id=randomUUID();await env.store.saveRecovery({id,owner,ticket:t,sealedPin:pin.pin,expiresAt:Date.now()+30000,
      report:{state:"retryable",blocker:true,pendingSettings:false,records:[{id:t.metadata.record.id,committedRevision:null,final:false,payload:"complete-staging",expiresAt:Date.now()+30000}],errors:[]}});
    await env.store.dispose();
    reopened=new AtomicStore(new NodePersistenceFs(env.fs.root,{hostEpoch:randomUUID(),assertHeld(){}},{now:()=>0}));await reopened.initialize();
    expect(await reopened.loadRecovery(id)).toMatchObject({ticket:null,sealedPin:null,report:{state:"checkpoint-only",records:[{payload:"none"}]}});
    await reopened.removeRecovery(id);expect(await reopened.loadRecovery(id)).toBeNull();
  }finally{await reopened?.dispose();await env.close();}
});
it("T5: durable checkpoint ownership outlives the registration ticket's terminal cache",async()=>{
  const env=await setup();try {
    const bytes=new Uint8Array([1]),initial=ticket(bytes);await stage(env.store,initial,bytes);await env.store.publish(initial);
    if(initial.metadata.kind!=="record")throw new Error("record required");
    const checkpoint=await registerCheckpoint(env.store,initial),record=initial.metadata.record;
    const {checkpointRecoveryId}=await import('./engine-port.js');
    await env.store.saveRecovery({id:checkpointRecoveryId(checkpoint),owner,ticket:null,sealedPin:null,expiresAt:null,
      report:{state:"checkpoint-only",blocker:true,pendingSettings:false,records:[{id:record.id,committedRevision:record.revision,final:false,payload:"checkpoint-only"}],errors:[]}});
    env.advance(120001);await env.store.stat(owner,record.id);env.store.fenceTarget(owner,record.id,130000);
    const final={...ticket(bytes,record.id,record.revision),deadlineMonotonicMs:240001};
    if(final.metadata.kind==="record")final.metadata.record.checkpoint="final";
    const grant={owner,recordId:record.id,checkpoint,token:randomUUID(),deadlineMonotonicMs:130000};
    await env.store.reserveFinal(final,1,grant);await env.store.append(final,0,bytes);await env.store.seal(final,1,hash(bytes));
    expect(await env.store.publish(final)).toMatchObject({disposition:"committed"});
  }finally{await env.close();}
});
