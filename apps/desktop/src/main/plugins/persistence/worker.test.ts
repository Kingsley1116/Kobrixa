import { createHash,randomUUID } from "node:crypto";
import { mkdtemp,rm,mkdir,realpath,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll,beforeAll,expect,it } from "vitest";
import { startPersistenceWorker,PersistenceWorkerRequest,PersistenceWorkerResponse,type PersistenceFaultControl } from "./worker.js";
import { openStoreRoot,type PersistenceFaultPoint } from "./filesystem.js";
import type { PersistenceBackend,PublicationTicket,ImportPlan } from "./engine-port.js";
import { createRecordService } from "./record-service.js";
import { PersistenceFault } from "./record-port.js";
let directory:string,entry:string;
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
beforeAll(async()=>{
  directory=await realpath(await mkdtemp(path.join(tmpdir(),"persistence-worker-test-")));
  await mkdir(path.join(directory,"legacy","sensor-lab"),{recursive:true});
  const workerPath=fileURLToPath(new URL("./worker.ts",import.meta.url)),fixturesPath=fileURLToPath(new URL("./import-fixtures.ts",import.meta.url));
  const fixtureEntry=path.join(directory,"worker-entry.ts");
  await writeFile(fixtureEntry,`import {runPersistenceWorker} from ${JSON.stringify(workerPath)};
      import {syntheticImportDescriptor,syntheticPreferencesImportDescriptor} from ${JSON.stringify(fixturesPath)};
      runPersistenceWorker({mappers:new Map([syntheticImportDescriptor,syntheticPreferencesImportDescriptor].map(d=>[d.id,d])),
        sourceRoots:new Map([[syntheticImportDescriptor.id,${JSON.stringify(path.join(directory,"legacy","sensor-lab"))}]])});`);
  await build({configFile:false,logLevel:"error",
    build:{target:"node24",outDir:path.join(directory,"bundle"),emptyOutDir:true,
      lib:{entry:fixtureEntry,formats:["cjs"],fileName:()=>"persistence-worker.cjs"},rollupOptions:{external:[/^node:/]},minify:false}});
  entry=path.join(directory,"bundle","persistence-worker.cjs");
},60000);
afterAll(async()=>{await rm(directory,{recursive:true,force:true});});
async function launch(userData:string){
  await mkdir(userData,{recursive:true});const profile={hostEpoch:randomUUID(),assertHeld(){}};
  const root=await openStoreRoot({userData,profile});let control:PersistenceFaultControl|undefined;
  const started=await startPersistenceWorker({profile,root,workerEntry:entry,now:()=>performance.now(),testControl:c=>{control=c;}});
  return {...started,profile,control:control!};
}
function make(owner:PublicationTicket["owner"],bytes:Uint8Array):PublicationTicket {
  const id=randomUUID();return {id:randomUUID(),owner,deadlineMonotonicMs:performance.now()+120000,
    target:{kind:"record",id,expectedRevision:null},metadata:{kind:"record",deleted:false,record:{id,revision:"r_"+randomUUID().replaceAll("-",""),kind:"test",schemaVersion:1,label:"Worker",mediaType:"application/octet-stream",byteLength:bytes.length,sha256:hash(bytes),createdAt:1,updatedAt:1,checkpoint:"none",interrupted:false}}};
}
const ownerFor=(epoch:string)=>({sourceKey:"builtin:kobrixa.lab",pluginId:"kobrixa.lab",generation:1,hostEpoch:epoch,processEpoch:randomUUID()});
async function stage(backend:PersistenceBackend,t:PublicationTicket,bytes:Uint8Array){await backend.engine.reserve(t,bytes.length);for(let n=0;n<bytes.length;n+=262144)await backend.engine.append(t,n,bytes.subarray(n,n+262144));await backend.engine.seal(t,bytes.length,hash(bytes));}
it('preserves checksum, missing-record and read-quota failures through the real worker',async()=>{
  const env=await launch(path.join(directory,randomUUID())),owner=ownerFor(env.profile.hostEpoch);
  const service=createRecordService({now:()=>performance.now(),wall:Date.now,live:()=>true,permission:()=>true,
    engine:env.backend.engine,read:env.backend.reads,evidence:env.backend.evidence,
    checkpoint:{authorize:()=>"none",committed(){},open:()=>false,
      register:async()=>{throw new Error("unused");},abandon:async()=>{throw new Error("unused");}}});
  const principal={kind:"plugin" as const,owner,authorityContext:null},signal=new AbortController().signal;
  try {
    const missing=await service.request(principal,'storage/stat',{id:randomUUID()},signal);
    expect(missing).toMatchObject({ok:false,error:{code:'PLUGIN_E_STORAGE_IO',detail:{kind:'persistence',reason:'not-found'}}});
    const bytes=Buffer.from('payload'),begin=await service.request(principal,'storage/beginWrite',{
      target:{mode:'create'},kind:'test',schemaVersion:1,label:'Bad checksum',mediaType:'application/octet-stream',
      byteLength:bytes.length,sha256:hash(Buffer.from('different'))},signal);
    expect(begin.ok).toBe(true);if(!begin.ok)throw new Error('begin failed');
    expect((await service.request(principal,'storage/writeChunk',{write:begin.value.write,offset:0,data:bytes.toString('base64')},signal)).ok).toBe(true);
    expect(await service.request(principal,'storage/sealWrite',{write:begin.value.write},signal)).toMatchObject({
      ok:false,error:{code:'PLUGIN_E_STORAGE_CONFLICT',detail:{kind:'persistence',reason:'checksum-mismatch'}}});
    expect(await service.request(principal,'storage/writeStatus',{write:begin.value.write},signal)).toMatchObject({ok:true,value:{state:'failed'}});
    const t=make(owner,bytes);await stage(env.backend,t,bytes);await env.backend.engine.publish(t);
    if(t.metadata.kind!=='record')throw new Error('record required');
    const record=t.metadata.record,pins:string[]=[];
    for(let i=0;i<4;i++)pins.push(await env.backend.reads.open(owner,record.id,record.revision));
    try {
      const error=await env.backend.reads.open(owner,record.id,record.revision).catch((error:unknown)=>error);
      expect(error).toBeInstanceOf(PersistenceFault);
      expect(error).toMatchObject({result:{ok:false,error:{code:'PLUGIN_E_RESOURCE_LIMIT',detail:{kind:'resource',reason:'quota',resource:'storage-read'}}}});
    } finally {for(const pin of pins)await env.backend.reads.close(owner,pin);}
  } finally {await service.close();await env.backend.dispose();}
});
it("rejects malformed private messages and missing capabilities",async()=>{
  const directory=await realpath(await mkdtemp(path.join(tmpdir(),"malformed-worker-")));
  try {
  expect(PersistenceWorkerRequest.safeParse({version:1,id:1,operation:"engine.fence",args:[]}).success).toBe(false);
  expect(PersistenceWorkerRequest.safeParse({version:1,id:1,operation:"reads.settings",args:[{sourceKey:"forged"}]}).success).toBe(false);
  expect(PersistenceWorkerResponse.safeParse({version:1,id:1,ok:false,error:{code:"io",message:"io",path:"private"}}).success).toBe(false);
  await expect(openStoreRoot({userData:directory,profile:{hostEpoch:randomUUID(),assertHeld(){throw new Error("not-primary");}}})).rejects.toThrow("not-primary");
  await expect(startPersistenceWorker({profile:{hostEpoch:randomUUID(),assertHeld(){}},root:{} as never,workerEntry:path.join(directory,"unused.cjs"),now:()=>0})).rejects.toThrow("unsafe-root");
  }finally{await rm(directory,{recursive:true,force:true});}
});
it("preserves exact opaque bytes, scoped barriers and one idempotent disposal",async()=>{
  const env=await launch(path.join(directory,randomUUID())),bytes=new Uint8Array([0,255,123,0,10]),owner=ownerFor(env.profile.hostEpoch),t=make(owner,bytes);
  expect(persistenceWorkerCount(env.backend)).toBe(1);
  await stage(env.backend,t,bytes);
  const incomplete=env.backend.evidence.capture({kind:"namespace",owner},performance.now()+10000);
  expect(env.backend.evidence.tickets(incomplete)).toEqual([t]);
  expect((await env.backend.evidence.flush(incomplete)).state).toBe("failed");
  expect(()=>env.backend.evidence.tickets(incomplete)).toThrow("stale");
  const barrier=env.backend.evidence.capture({kind:"namespace",owner},performance.now()+10000);
  const committed=await env.backend.engine.publish(t);expect(committed.disposition).toBe("committed");
  const id=t.target.kind==="record"?t.target.id:"",meta=await env.backend.reads.stat(owner,id);
  expect([meta.byteLength,meta.sha256]).toEqual([bytes.length,hash(bytes)]);
  const pin=await env.backend.reads.open(owner,id,meta.revision);expect(await env.backend.reads.read(owner,pin,0,256)).toEqual(bytes);await env.backend.reads.close(owner,pin);
  const late=make(owner,bytes);await env.backend.engine.reserve(late,bytes.length);
  expect(env.backend.evidence.tickets(barrier)).toEqual([t]);
  expect((await env.backend.evidence.flush(barrier)).state).toBe("saved");
  await env.backend.engine.abort(late);
  const one=env.backend.dispose();expect(env.backend.dispose()).toBe(one);expect(persistenceWorkerCount(env.backend)).toBe(1);await one;expect(persistenceWorkerCount(env.backend)).toBe(0);
});
const points:PersistenceFaultPoint[]=["reserve","open-temp","chunk-write","seal-sync","object-rename","object-dir-sync","backup-head","head-write","before-publish","after-publish","head-dir-sync","cache-publish","receipt-send","cleanup","import-marker"];
for(const point of points)it(`real worker kill at ${point}`,async()=>{
  const userData=path.join(directory,randomUUID()),env=await launch(userData),owner=ownerFor(env.profile.hostEpoch),bytes=Buffer.from(JSON.stringify({formatVersion:1,value:1}));
  const target={kind:"import" as const,key:"fault-matrix"};
  const ticket=():PublicationTicket=>({id:randomUUID(),owner,deadlineMonotonicMs:performance.now()+120000,target,metadata:target});
  const old=ticket();await stage(env.backend,old,bytes);await env.backend.engine.publish(old);
  env.control.arm(point,"pause");const reached=env.control.reached(point),next=ticket();
  const pending=stage(env.backend,next,bytes).then(()=>env.backend.engine.publish(next)).catch(()=>null);
  await reached;expect(persistenceWorkerCount(env.backend)).toBe(1);await env.control.terminate();expect(persistenceWorkerCount(env.backend)).toBe(0);await pending;
  for(let attempt=0;attempt<3;attempt++){
    const reopened=await launch(userData);
    try {
      expect(reopened.recovery).toBe("ready");
      expect(await reopened.backend.evidence.auxiliary(ownerFor(reopened.profile.hostEpoch),"import","fault-matrix")).toEqual(Uint8Array.from(bytes));
    } finally {await reopened.backend.dispose();}
  }
},30000);
it("kill after imported head before receipt reconciles original ticket without new IDs",async()=>{
  const userData=path.join(directory,randomUUID()),env=await launch(userData),owner=ownerFor(env.profile.hostEpoch),bytes=new Uint8Array([7,0,255]);
  const id="import/"+hash(Buffer.from(JSON.stringify(["test.synthetic-import",owner.sourceKey])));
  const t=make(owner,bytes),tag={importId:id,itemKey:"item",sourceSha256:hash(bytes)},skipTicket=make(owner,bytes);
  const plan:ImportPlan={formatVersion:1,id,descriptorId:"test.synthetic-import",preferencesEvidence:null,mappingVersion:1,targetSourceKey:owner.sourceKey,items:[
    {key:"item",sourceFormat:1,sourceSha256:hash(bytes),mappedSha256:hash(bytes),byteLength:bytes.length,ticket:t,tag},
    {key:"skip",sourceFormat:1,sourceSha256:hash(bytes),mappedSha256:hash(bytes),byteLength:bytes.length,ticket:skipTicket,tag:{...tag,itemKey:"skip"}},
  ]};
  await env.backend.imports.plan(owner,plan);
  await env.backend.imports.record(owner,id,{key:"skip",state:"skipped",receipt:null,skipReason:"already-new",publicationTicket:null});
  await expect(env.backend.imports.complete(owner,id)).rejects.toThrow();
  const publication=await env.backend.imports.admit(owner,id,"item");
  await env.backend.engine.reserve(publication,bytes.length);await env.backend.imports.tagImport(publication,tag);
  await env.backend.engine.append(publication,0,bytes);await env.backend.engine.seal(publication,bytes.length,hash(bytes));
  env.control.arm("after-publish","pause");const reached=env.control.reached("after-publish");const pending=env.backend.engine.publish(publication).catch(()=>null);
  await reached;expect(persistenceWorkerCount(env.backend)).toBe(1);await env.control.terminate();expect(persistenceWorkerCount(env.backend)).toBe(0);await pending;
  for(let attempt=0;attempt<3;attempt++){
    const next=await launch(userData),current=ownerFor(next.profile.hostEpoch),saved=await next.backend.imports.load(current,id);
    expect(current.hostEpoch).not.toBe(owner.hostEpoch);
    await expect(next.backend.engine.reserve(t,bytes.length)).rejects.toThrow();
    expect(saved?.plan).toEqual(plan);expect(saved?.items[1]?.skipReason).toBe("already-new");
    expect((await next.backend.imports.reconcile(t)).disposition).toBe("committed");
    const receipts=await next.backend.imports.importReceipts(current,id);expect(receipts).toHaveLength(1);expect(receipts[0]?.ticket.id).toBe(publication.id);
    await next.backend.imports.complete(current,id);expect((await next.backend.imports.load(current,id))?.complete).toBe(true);
    expect((await next.backend.reads.list(current,{limit:64})).entries).toHaveLength(1);
    await next.backend.dispose();
  }
},30000);

import { snapshotBytes, snapshotDigest, type LegacyNonceDocument } from "./import-sources.js";
it("resolves a consumed nonce after host change without a renderer or filesystem fallback",async()=>{
  const {syntheticPreferencesImportDescriptor}=await import("./import-fixtures.js");
  const userData=path.join(directory,randomUUID()),first=await launch(userData),d=syntheticPreferencesImportDescriptor;
  const owner={...ownerFor(first.profile.hostEpoch),sourceKey:d.targetSourceKey,pluginId:d.id};
  const nonce=randomUUID(),scope={hostEpoch:owner.hostEpoch,workbenchInstance:randomUUID()},raw={nonce,scope,entries:[{key:"test.preference",raw:null}]};
  const key="nonce/"+nonce,ticket:PublicationTicket={id:randomUUID(),owner,deadlineMonotonicMs:performance.now()+10000,
    target:{kind:"import",key},metadata:{kind:"import",key}};
  const digest=snapshotDigest(raw,d.rendererKeyAllowlist!),document:LegacyNonceDocument={formatVersion:1,kind:"nonce",descriptorId:d.id,
    sourceKey:d.targetSourceKey,nonce,scope,allowlist:[...d.rendererKeyAllowlist!],state:"consumed",raw,digest,originalTicket:ticket,ticket};
  await stage(first.backend,ticket,Buffer.from(JSON.stringify(document)));expect((await first.backend.engine.publish(ticket)).disposition).toBe("committed");
  await first.backend.dispose();
  const second=await launch(userData),current={...ownerFor(second.profile.hostEpoch),sourceKey:d.targetSourceKey,pluginId:d.id};
  expect(current.hostEpoch).not.toBe(owner.hostEpoch);
  await second.backend.sources.register({descriptorId:d.id,mapperId:d.id,sourceKind:d.sourceKind});
  expect((await second.backend.sources.inventory(d.id)).state).toBe("blocked");
  await expect(second.backend.sources.map(d.id,"preferences")).rejects.toThrow();
  await second.backend.sources.resolvePreferences({descriptorId:d.id,owner:current,evidence:{nonce,digest}});
  const expected=snapshotBytes(raw,d.rendererKeyAllowlist!);
  expect(await second.backend.sources.inventory(d.id)).toEqual({state:"present",entries:[{key:"preferences",format:1,byteLength:expected.length,sha256:digest}]});
  expect(await second.backend.sources.read(d.id,"preferences",0,262144)).toEqual(expected);
  const mapped=await second.backend.sources.map(d.id,"preferences");expect(mapped.sourceSha256).toBe(digest);expect(mapped.mappedSha256).toBe(digest);
  expect(mapped.byteLength).toBe(expected.length);await second.backend.sources.releaseMapped(mapped.mapped);
  await expect(second.backend.sources.resolvePreferences({descriptorId:d.id,owner:current,evidence:{nonce:randomUUID(),digest}})).rejects.toThrow();
  await expect(second.backend.sources.read(d.id,"preferences",0,262145)).rejects.toThrow();
  await second.backend.dispose();
},30000);
it("strictly validates both new private tuples",()=>{
  const owner=ownerFor(randomUUID()),nonce=randomUUID(),digest="0".repeat(64);
  const valid=[{operation:"imports.admit",args:[owner,"import/"+digest,"item"]},
    {operation:"sources.resolvePreferences",args:[{descriptorId:"test.synthetic-preferences",owner,evidence:{nonce,digest}}]}];
  for(const request of valid) {
    expect(PersistenceWorkerRequest.safeParse({version:1,id:1,...request}).success).toBe(true);
    expect(PersistenceWorkerRequest.safeParse({version:1,id:1,...request,args:[...request.args,"extra"]}).success).toBe(false);
  }
  for(const evidence of [{nonce,digest,raw:[]},{nonce,digest,path:"/tmp/source"},{nonce:"bad",digest},{nonce,digest:"bad"},{nonce,digest,map(){}}])
    expect(PersistenceWorkerRequest.safeParse({version:1,id:1,operation:"sources.resolvePreferences",
      args:[{descriptorId:"test.synthetic-preferences",owner,evidence}]}).success).toBe(false);
});
import { WorkerSources,persistenceWorkerCount } from "./worker.js";
import { AtomicStore } from "./atomic-store.js";
import { createNodePersistenceFs } from "./filesystem.js";
import type { LegacyImportDescriptor } from "./import-sources.js";
it("sourceRoots rejects unknown, renderer, relative and conflicting roots before ready",async()=>{
  const root=await realpath(await mkdtemp(path.join(tmpdir(),"sources-")));
  try {
    const fs=await createNodePersistenceFs(root,{hostEpoch:randomUUID(),assertHeld(){}}),store=new AtomicStore(fs);
    const descriptor:LegacyImportDescriptor={id:"test.file",mappingVersion:1,targetSourceKey:"builtin:kobrixa.lab",sourceKind:"sensor-lab",sourceFormatVersions:[1],targetRecordSchemaVersions:[1],validate:()=>true,map:()=>{throw new Error("unused");}};
    const renderer={...descriptor,id:"test.renderer",sourceKind:"renderer-preferences" as const},other={...descriptor,id:"test.other"},mappers=new Map([descriptor,renderer,other].map(d=>[d.id,d]));
    for(const roots of [new Map([["unknown",root]]),new Map([[renderer.id,root]]),new Map([[descriptor.id,"relative"]]),new Map([[descriptor.id,path.join(root,"..","bad")+"/../bad"]]),new Map([[descriptor.id,root],[other.id,root]])])
      expect(()=>new WorkerSources(fs.root,store,mappers,roots)).toThrow();
    const sources=new WorkerSources(fs.root,store,mappers,new Map([[descriptor.id,root]]));
    await sources.validateRoots();
    await sources.register({descriptorId:descriptor.id,mapperId:descriptor.id,sourceKind:descriptor.sourceKind});
    await expect(sources.register({descriptorId:descriptor.id,mapperId:other.id,sourceKind:descriptor.sourceKind})).rejects.toThrow();
    await sources.register({descriptorId:renderer.id,mapperId:renderer.id,sourceKind:renderer.sourceKind});
    expect(await sources.inventory(renderer.id)).toEqual({state:"blocked",entries:[]});
    await expect(sources.read(renderer.id,"preferences",0,1)).rejects.toThrow("missing-evidence");
    await expect(sources.map(renderer.id,"preferences")).rejects.toThrow("missing-evidence");
    await store.dispose();
  }finally{await rm(root,{recursive:true,force:true});}
});
it("persistenceWorkerCount rejects objects that are not registered backends",()=>{
  expect(()=>persistenceWorkerCount({} as PersistenceBackend)).toThrow("unknown-instance");
});
it("accepts finite fractional monotonic deadlines without relaxing integer counters",()=>{
  const owner=ownerFor(randomUUID()),t={...make(owner,new Uint8Array()),deadlineMonotonicMs:1234.5};
  expect(PersistenceWorkerRequest.safeParse({version:1,id:1,operation:"engine.reserve",args:[t,0],gate:{slot:0,sequence:1}}).success).toBe(true);
  expect(PersistenceWorkerRequest.safeParse({version:1,id:1.5,operation:"engine.reserve",args:[t,0],gate:{slot:0,sequence:1}}).success).toBe(false);
});

async function mappedSetup(options:{hash?:string;schema?:number;large?:boolean}={}) {
  const root=await realpath(await mkdtemp(path.join(tmpdir(),"mapped-source-")));
  const profile={hostEpoch:randomUUID(),assertHeld(){}},fs=await createNodePersistenceFs(root,profile,{now:()=>0}),store=new AtomicStore(fs);
  const legacy=path.join(root,"legacy");await mkdir(legacy);await writeFile(path.join(legacy,"item"),'{"formatVersion":1}');
  const payload=new Uint8Array(options.large?262145:3).fill(7),owner=ownerFor(profile.hostEpoch),original=make(owner,payload);
  if(original.metadata.kind!=="record")throw new Error("test-target");
  if(options.hash)original.metadata.record.sha256=options.hash;
  const descriptor:LegacyImportDescriptor={id:"test.mapped",mappingVersion:1,targetSourceKey:owner.sourceKey,sourceKind:"sensor-lab",sourceFormatVersions:[1],targetRecordSchemaVersions:[1],validate:()=>true,
    map:()=>({kind:"record",bytes:payload,metadata:{kind:"test",schemaVersion:options.schema??1,label:"Mapped",mediaType:"application/octet-stream",byteLength:payload.length,sha256:hash(payload)}})};
  const sources=new WorkerSources(fs.root,store,new Map([[descriptor.id,descriptor]]),new Map([[descriptor.id,legacy]]));await sources.validateRoots();
  await sources.register({descriptorId:descriptor.id,mapperId:descriptor.id,sourceKind:descriptor.sourceKind});
  const mapped=await sources.map(descriptor.id,"item"),id="import/"+hash(Buffer.from(JSON.stringify([descriptor.id,owner.sourceKey]))),tag={importId:id,itemKey:"item",sourceSha256:mapped.sourceSha256};
  const plan:ImportPlan={formatVersion:1,id,descriptorId:descriptor.id,preferencesEvidence:null,mappingVersion:1,targetSourceKey:owner.sourceKey,
    items:[{key:"item",sourceFormat:1,sourceSha256:mapped.sourceSha256,mappedSha256:options.hash??mapped.mappedSha256,byteLength:payload.length,ticket:original,tag}]};
  await store.planImport(owner,plan);const attempt=await store.admitImport(owner,id,"item");await store.reserve(attempt,payload.length);
  return {sources,store,mapped,attempt,tag,payload,close:async()=>{await store.dispose();await rm(root,{recursive:true,force:true});}};
}
it("appendMapped requires the matching tag before the first byte",async()=>{
  const env=await mappedSetup();try {
    await expect(env.sources.appendMapped({mapped:env.mapped.mapped,ticket:env.attempt,offset:0,maxBytes:262144})).rejects.toThrow("input-changed");
    await env.store.tagImport(env.attempt,env.tag);
    expect(await env.sources.appendMapped({mapped:env.mapped.mapped,ticket:env.attempt,offset:0,maxBytes:262144})).toEqual({nextOffset:3,done:true});
  }finally{await env.close();}
});
it("file mapping binds attempt, sequential offset, bounded chunks and unresolved release",async()=>{
  const env=await mappedSetup({large:true});try {
    await env.store.tagImport(env.attempt,env.tag);
    const input={mapped:env.mapped.mapped,ticket:env.attempt,offset:0,maxBytes:262144};
    for(const invalid of [{...input,ticket:{...env.attempt,id:randomUUID()}},{...input,offset:1},{...input,maxBytes:262145}])await expect(env.sources.appendMapped(invalid)).rejects.toThrow();
    expect(await env.sources.appendMapped(input)).toEqual({nextOffset:262144,done:false});
    expect(await env.sources.appendMapped({...input,offset:262144})).toEqual({nextOffset:262145,done:true});
    await env.store.seal(env.attempt,env.payload.length,hash(env.payload));
    const replace=env.store.fs.atomicReplace.bind(env.store.fs);let resume!:()=>void,entered!:()=>void;
    const reached=new Promise<void>(r=>{entered=r;}),release=new Promise<void>(r=>{resume=r;});
    env.store.fs.atomicReplace=async(a,b)=>{if(env.store.fs.name(b).endsWith('head.json')){entered();await release;}return replace(a,b);};
    const publish=env.store.publish(env.attempt);await reached;
    try{await expect(env.sources.releaseMapped(env.mapped.mapped)).rejects.toThrow("publish-uncertain");}finally{resume();}
    expect((await publish).disposition).toBe("committed");await env.sources.releaseMapped(env.mapped.mapped);
    await expect(env.sources.appendMapped(input)).rejects.toThrow("stale");
  }finally{await env.close();}
});
it.each([{hash:"0".repeat(64)},{schema:2}])("rejects mismatched plan hash or schema %j",async options=>{
  const env=await mappedSetup(options);try {
    await env.store.tagImport(env.attempt,env.tag);
    await expect(env.sources.appendMapped({mapped:env.mapped.mapped,ticket:env.attempt,offset:0,maxBytes:262144})).rejects.toThrow("input-changed");
  }finally{await env.close();}
});
it("T5 private continuations require original ticket, exact grant and a bound reserve gate",()=>{
  const owner=ownerFor(randomUUID()),t=make(owner,new Uint8Array([1]));
  const grant={owner,recordId:t.target.kind==="record"?t.target.id:randomUUID(),checkpoint:randomUUID(),token:randomUUID(),deadlineMonotonicMs:performance.now()+1000};
  const request={version:1,id:1,operation:"engine.reserveFinal",args:[t,1,grant],gate:{slot:0,sequence:1}};
  expect(PersistenceWorkerRequest.safeParse(request).success).toBe(true);
  expect(PersistenceWorkerRequest.safeParse({...request,gate:undefined}).success).toBe(false);
  expect(PersistenceWorkerRequest.safeParse({...request,args:[t,1,{...grant,invocation:"forged"}]}).success).toBe(false);
  expect(PersistenceWorkerRequest.safeParse({version:1,id:2,operation:"engine.publishRecovery",args:[t,randomUUID(),performance.now()+1000]}).success).toBe(true);
  expect(PersistenceWorkerRequest.safeParse({version:1,id:3,operation:"evidence.retainSealed",args:[t]}).success).toBe(true);
  expect(PersistenceWorkerRequest.safeParse({version:1,id:4,operation:"engine.publishRecovery",args:[t,"fabricated",performance.now()+1000]}).success).toBe(false);
});
