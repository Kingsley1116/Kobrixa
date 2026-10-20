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
