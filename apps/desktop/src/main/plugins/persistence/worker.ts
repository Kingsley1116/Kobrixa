import { Worker, MessageChannel, parentPort, workerData, type MessagePort } from "node:worker_threads";
import { createHash,randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { z } from "zod";
import type { ProfileWriterLock,PersistenceOwner } from "@kobrixa/plugin-runtime";
import type { LegacyImportDescriptor,LegacySourceItem,LegacyMappedItem,LegacySourceResolver } from "./import-sources.js";
import type { ExportDestination } from "./actions.js";
import { AtomicStore, checkpointDocumentSchema } from "./atomic-store.js";
import { NodePersistenceFs,NativeOutput,storeRootPath,type StoreRoot,type PersistenceFaultPoint } from "./filesystem.js";
import { WorkQueue } from "./quota.js";
import { PublicationGate,ownerKey,type PersistenceBackend,type PublicationTicket,type PersistenceBarrier,type PersistenceScope, type FinalWriteGrant } from "./engine-port.js";
import { publicationTicketSchema,persistenceOwnerSchema,persistenceBarrierSchema,importPlanSchema,
  importTagSchema,importItemEvidenceSchema,storedRecoverySchema } from "./namespace.js";
import type { Handle,Counter } from "@kobrixa/plugin-protocol";
export interface PersistenceFaultControl {
  arm(point:PersistenceFaultPoint,action:"pause"|"fail"|"kill"):void;
  reached(point:PersistenceFaultPoint):Promise<void>;
  release(point:PersistenceFaultPoint):void;
  trace():readonly {point:PersistenceFaultPoint;time:number;ticket:Handle|null}[];
  terminate():Promise<void>;
}
import type { FoundationDiagnostics } from "@kobrixa/plugin-runtime";
const diagnosticInstances=new WeakMap<object,FoundationDiagnostics>();
const workerInstances=new WeakMap<PersistenceBackend,()=>number>();
export function persistenceWorkerCount(backend:PersistenceBackend):number {
  const count=workerInstances.get(backend);if(!count)throw new Error("unknown-instance");return count();
}
export function diagnosticsFor(instance:object):FoundationDiagnostics {const value=diagnosticInstances.get(instance);if(!value)throw new Error("unknown-instance");return value;}
type Qualified<P,Prefix extends string> = {[K in keyof P as K extends string?`${Prefix}.${K}`:never]:P[K]};
export type WorkerOperations=Qualified<Required<Omit<PersistenceBackend["engine"],"fence"|"fenceTarget">>,"engine"> &
  Qualified<PersistenceBackend["reads"],"reads"> & Qualified<Required<Omit<PersistenceBackend["evidence"],"capture"|"captureDrain"|"tickets">>,"evidence"> &
  Qualified<PersistenceBackend["imports"],"imports"> & Qualified<PersistenceBackend["output"],"output"> &
  Qualified<PersistenceBackend["destinations"],"destinations"> & Qualified<PersistenceBackend["sources"],"sources">;
type Operation=keyof WorkerOperations;
const count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),handle=z.string().uuid(),digest=z.string().regex(/^[0-9a-f]{64}$/);
const text=z.string().min(1).refine(s=>Buffer.byteLength(s)<=128),revision=z.string().regex(/^r_[0-9a-f]{32}$/);
const bytes=z.instanceof(Uint8Array).refine(b=>b.byteLength<=262144),ticket=publicationTicketSchema,owner=persistenceOwnerSchema;
const monotonic=z.number().min(0).max(Number.MAX_SAFE_INTEGER);
const scope=z.strictObject({hostEpoch:handle,workbenchInstance:handle});
// Use CoreWindowScope's F keys verbatim; do not accept renderer-created scope.
const finalGrant=z.strictObject({owner,recordId:handle,checkpoint:handle,token:handle,deadlineMonotonicMs:monotonic,
  deviceDrain:z.strictObject({owner,reservationId:handle,lastSequence:count,expiresMonotonicMs:monotonic}).optional()});
const args={
  "engine.reserveFinal":z.tuple([ticket,count.max(8388608),finalGrant]),
  "engine.publishRecovery":z.tuple([ticket,handle,monotonic]),
  "evidence.retainSealed":z.tuple([ticket]),
  "evidence.saveCheckpoint":z.tuple([owner,checkpointDocumentSchema.omit({formatVersion:true})]),
  "engine.reserve":z.tuple([ticket,count.max(8388608)]),"engine.append":z.tuple([ticket,count,bytes]),
  "engine.seal":z.tuple([ticket,count.max(8388608),digest]),"engine.publish":z.tuple([ticket]),"engine.reconcile":z.tuple([ticket]),"engine.abort":z.tuple([ticket]),
  "reads.settings":z.tuple([owner]),"reads.stat":z.tuple([owner,handle]),
  "reads.list":z.tuple([owner,z.strictObject({kind:z.string().optional(),limit:count.min(1).max(64),cursor:handle.optional()})]),
  "reads.open":z.tuple([owner,handle,revision]),"reads.read":z.tuple([owner,handle,count,count.min(1).max(262144)]),"reads.close":z.tuple([owner,handle]),
  "evidence.flush":z.tuple([persistenceBarrierSchema,z.array(ticket).max(1024)]),"evidence.quota":z.tuple([owner]),"evidence.settingsDigest":z.tuple([owner]),
  "evidence.auxiliary":z.tuple([owner,z.enum(["import","recovery"]),text]),"evidence.auxiliaryKeys":z.tuple([owner,z.enum(["import","recovery"]),handle.optional()]),
  "evidence.recoveryPage":z.tuple([handle.optional()]),"evidence.loadRecovery":z.tuple([handle]),"evidence.saveRecovery":z.tuple([storedRecoverySchema]),"evidence.removeRecovery":z.tuple([handle]),
  "imports.admit":z.tuple([owner,text,text]),
  "imports.load":z.tuple([owner,text]),"imports.plan":z.tuple([owner,importPlanSchema]),"imports.tagImport":z.tuple([ticket,importTagSchema]),
  "imports.importReceipts":z.tuple([owner,text]),"imports.record":z.tuple([owner,text,importItemEvidenceSchema]),"imports.reconcile":z.tuple([ticket]),"imports.complete":z.tuple([owner,text]),
  "output.begin":z.tuple([handle,owner,handle,count.max(8388608),digest,monotonic]),"output.append":z.tuple([handle,count,bytes]),
  "output.commit":z.tuple([handle]),"output.reconcile":z.tuple([handle]),"output.abort":z.tuple([handle]),
  "destinations.register":z.tuple([z.strictObject({action:handle,scope,nativePath:z.string().min(1),deadlineMonotonicMs:monotonic})]),"destinations.release":z.tuple([handle]),
  "sources.resolvePreferences":z.tuple([z.strictObject({descriptorId:text,owner,evidence:z.strictObject({nonce:z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),digest})})]),
  "sources.register":z.tuple([z.strictObject({descriptorId:text,mapperId:text,sourceKind:z.enum(["sensor-lab","device-settings","renderer-preferences"])})]),
  "sources.map":z.tuple([text,text]),"sources.appendMapped":z.tuple([z.strictObject({mapped:handle,ticket,offset:count,maxBytes:count.min(1).max(262144)})]),
  "sources.releaseMapped":z.tuple([handle]),"sources.inventory":z.tuple([text]),"sources.read":z.tuple([text,text,count,count.min(1).max(262144)]),
} satisfies Record<Operation,z.ZodType>;
const gateBinding=z.strictObject({slot:count.max(1023),sequence:count.min(1)});
const envelope=z.strictObject({gate:gateBinding.optional(),version:z.literal(1),id:count.min(1),operation:z.enum(Object.keys(args) as [Operation,...Operation[]]),args:z.array(z.unknown())});
export const PersistenceWorkerRequest=envelope.superRefine((r,ctx)=>{if((["engine.reserve","engine.reserveFinal"].includes(r.operation))!==!!r.gate || !args[r.operation].safeParse(r.args).success)ctx.addIssue({code:"custom",message:"invalid-args"});});
export type PersistenceWorkerRequest<K extends Operation=Operation>=K extends Operation?
  {version:1;id:Counter;operation:K;args:K extends "evidence.flush"?[PersistenceBarrier,readonly PublicationTicket[]]:Parameters<WorkerOperations[K]>} &
  (K extends "engine.reserve"|"engine.reserveFinal"?{gate:z.infer<typeof gateBinding>}:{gate?:never}):never;
const settledMarkers=z.array(z.strictObject({id:handle,disposition:z.enum(["committed","not-committed","aborted"])})).max(1024);
export const PersistenceWorkerResponse=z.union([
  z.strictObject({version:z.literal(1),id:count.min(1),ok:z.literal(true),value:z.unknown(),settled:settledMarkers.optional()}),
  z.strictObject({version:z.literal(1),id:count.min(1),ok:z.literal(false),settled:settledMarkers.optional(),error:z.strictObject({code:z.enum(["io","invalid","stale","quota","unknown"]),message:z.string().max(128)})}),
]);
export type PersistenceWorkerResponse<K extends Operation=Operation>={version:1;id:Counter;ok:true;value:Awaited<ReturnType<WorkerOperations[K]>>;settled?:readonly {id:Handle;disposition:"committed"|"not-committed"|"aborted"}[]}|{version:1;id:Counter;ok:false;settled?:readonly {id:Handle;disposition:"committed"|"not-committed"|"aborted"}[];error:{code:"io"|"invalid"|"stale"|"quota"|"unknown";message:string}};
const bootSchema=z.strictObject({version:z.literal(1),kind:z.literal("boot"),hostEpoch:handle,root:z.string().min(1),held:z.instanceof(SharedArrayBuffer)});
const readySchema=z.strictObject({version:z.literal(1),kind:z.literal("ready"),recovery:z.enum(["ready","blocked"])});
const matches=(scope:PersistenceScope,t:PublicationTicket)=>ownerKey(scope.owner)===ownerKey(t.owner) && (scope.kind==="namespace" || t.target.kind==="record" && t.target.id===scope.recordId);
const gateBytes=16+1024*16, sharedBytes=gateBytes+1024*4;
const gateOffset=(slot:number)=>16+16*slot;
export function reserveGateOffset(memory:SharedArrayBuffer,binding:unknown):number {
  const {slot}=gateBinding.parse(binding);
  if(memory.byteLength!==sharedBytes || Atomics.load(new Int32Array(memory,gateBytes,1024),slot)!==1)throw new Error("invalid-gate");
  return gateOffset(slot);
}
export function privateError(error:unknown):{code:"io"|"invalid"|"stale"|"quota"|"unknown";message:string} {
  const message=error instanceof Error?error.message:"";
  if(message.length>128 || !/^[a-z]+(?:-[a-z]+)*$/.test(message))return {code:"io",message:"persistence-io"};
  const code=["stale","expired","not-primary"].includes(message)?"stale":
    ["quota","queue"].includes(message) || /-(limit|bytes)$/.test(message)?"quota":
    message==="publish-uncertain"?"unknown":
    ["input-changed","revision-mismatch","already-committed"].includes(message) || message.startsWith("invalid-")?"invalid":"io";
  return {code,message:code==="io"?"persistence-io":message};
}
const charge=(value:unknown):number=>value instanceof Uint8Array?value.byteLength:Array.isArray(value)?value.reduce((n,v)=>n+charge(v),0):Buffer.byteLength(JSON.stringify(value)??"null");

export async function startPersistenceWorker(input:{profile:ProfileWriterLock;root:StoreRoot;workerEntry:string;now:()=>number;testControl?:(control:PersistenceFaultControl)=>void}):Promise<{backend:PersistenceBackend;recovery:"ready"|"blocked"}> {
  input.profile.assertHeld();const root=await storeRootPath(input.root,input.profile);
  if(!path.isAbsolute(input.workerEntry))throw new Error("invalid-worker-entry");
  const held=new SharedArrayBuffer(sharedBytes);Atomics.store(new Int32Array(held),0,1);
  const channel=input.testControl?new MessageChannel():null;
  const worker=new Worker(input.workerEntry,{workerData:channel?{faultPort:channel.port2}:{},transferList:channel?[channel.port2]:[]});
  let exited=false,exitCode:number|undefined;worker.once("exit",code=>{exited=true;exitCode=code;channel?.port1.close();});
  const queue=new WorkQueue(input.now),ledger=new Map<string,{ticket:PublicationTicket;gate:PublicationGate;sequence:number;slot:number;settledAt:number|null}>(),freeSlots=Array.from({length:1024},(_,i)=>1023-i);
  const inUse=new Int32Array(held,gateBytes,1024);
  function releaseSlot(id:string){const e=ledger.get(id);if(!e)return;ledger.delete(id);Atomics.store(inUse,e.slot,0);freeSlots.push(e.slot);}
  function pruneLedger(){for(const [id,e] of ledger)if(e.settledAt!==null && e.settledAt+120000<=input.now())releaseSlot(id);}
  const ownerDeadlines=new Map<string,number>(),targetDeadlines=new Map<string,number>(),finalClaims=new Set<string>();
  const retired=new Set<string>(),targets=new Set<string>(),barriers=new Map<string,{barrier:PersistenceBarrier;tickets:readonly PublicationTicket[];expires:number}>();
  function pruneBarriers(){for(const [id,e] of barriers)if(e.expires<=input.now())barriers.delete(id);}
  const destinations=new WeakMap<ExportDestination,string>();let sequence=0,next=0,dead=false,closing:Promise<void>|null=null;
  const pending=new Map<number,{resolve:(v:unknown)=>void;reject:(e:unknown)=>void;ticketId?:string}>();
  const lost=()=>{dead=true;Atomics.store(new Int32Array(held),0,0);for(const e of ledger.values())e.gate.shorten(input.now(),input.now());for(const p of pending.values())p.reject(new Error("worker-lost"));pending.clear();};
  worker.once("error",lost);worker.once("exit",lost);
  worker.on("message",raw=>{
    const parsed=PersistenceWorkerResponse.safeParse(raw);if(!parsed.success)return;
    const r=parsed.data,p=pending.get(r.id);if(!p)return;pending.delete(r.id);
    for(const marker of r.settled??[]) {const settled=ledger.get(marker.id);if(settled)settled.settledAt??=input.now();}
    if(!r.ok){p.reject(new Error(r.error.message));return;}
    const e=p.ticketId?ledger.get(p.ticketId):undefined;
    if(e && ((r.value as {disposition?:string}|null)?.disposition==="unknown" || r.value==="unknown"))e.settledAt=null;
    p.resolve(r.value);
  });
  if(channel){
    const trace:Array<{point:PersistenceFaultPoint;time:number;ticket:string|null}>=[],waiters=new Map<string,Array<()=>void>>();
    channel.port1.on("message",(e:{point:PersistenceFaultPoint;time:number;ticket:string|null})=>{trace.push(e);for(const resolve of waiters.get(e.point)??[])resolve();waiters.delete(e.point);});
    input.testControl!({arm(point,action){channel.port1.postMessage({kind:"arm",point,action});},reached(point){return new Promise(resolve=>{const list=waiters.get(point)??[];list.push(resolve);waiters.set(point,list);});},release(point){channel.port1.postMessage({kind:"release",point});},trace:()=>trace.slice(),async terminate(){await worker.terminate();lost();}});
  }
  const ready=await new Promise<z.infer<typeof readySchema>>((resolve,reject)=>{
    const timer=setTimeout(()=>{void worker.terminate().finally(()=>{channel?.port1.close();channel?.port2.close();reject(new Error("worker-ready-timeout"));});},10000);
    const onMessage=(raw:unknown)=>{const r=readySchema.safeParse(raw);if(r.success){clearTimeout(timer);worker.off("message",onMessage);resolve(r.data);}};
    worker.on("message",onMessage);worker.once("error",e=>{clearTimeout(timer);reject(e);});worker.once("exit",()=>{clearTimeout(timer);reject(new Error("worker-before-ready"));});
    worker.postMessage({version:1,kind:"boot",hostEpoch:input.profile.hostEpoch,root,held});
  });
  function send<K extends Operation>(operation:K,parameters:unknown[],gate?:z.infer<typeof gateBinding>,posted?:()=>void):Promise<Awaited<ReturnType<WorkerOperations[K]>>> {
    input.profile.assertHeld();if(dead)return Promise.reject(new Error("worker-lost"));
    const first=parameters[0] as {owner?:PersistenceOwner;sourceKey?:string}|undefined,source=first?.owner?.sourceKey??first?.sourceKey??"core";
    let requestId:number|undefined,cancelled=false;
    const work=queue.run(source,charge(parameters)+256,input.now()+10000,()=>new Promise<Awaited<ReturnType<WorkerOperations[K]>>>((resolve,reject)=>{
      if(cancelled || dead || closing){reject(new Error("worker-lost"));return;}
      const id=++next;
      try {
        const request=PersistenceWorkerRequest.parse({version:1,id,operation,args:parameters,...(gate?{gate}:{})});
        const ticketId=(parameters[0] as {id?:string}|undefined)?.id;
        pending.set(id,{resolve:resolve as (v:unknown)=>void,reject,...(ticketId?{ticketId}:{})});
        worker.postMessage(request);requestId=id;posted?.();
      }catch(e){pending.delete(id);reject(e);}
    }));
    let timer:ReturnType<typeof setTimeout>;
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{
      cancelled=true;const t=parameters[0] as PublicationTicket|undefined;if(t?.id)ledger.get(t.id)?.gate.shorten(input.now(),input.now());
      if(requestId!==undefined)worker.postMessage({version:1,kind:"cancel",id:requestId});reject(new Error("timeout"));
    },10000);});
    return Promise.race([work,timeout]).finally(()=>clearTimeout(timer));
  }
  async function admit(t:PublicationTicket,size:number,grant?:FinalWriteGrant) {
    input.profile.assertHeld();pruneLedger();
    const target=t.target.kind==="record"?JSON.stringify([ownerKey(t.owner),t.target.id]):"";
    if(ready.recovery!=="ready" || ledger.has(t.id))throw new Error("stale");
    if(grant) {
      finalGrant.parse(grant);
      const deadline=Math.min(ownerDeadlines.get(ownerKey(t.owner))??Infinity,targetDeadlines.get(target)??Infinity,
        grant.deadlineMonotonicMs,grant.deviceDrain?.expiresMonotonicMs??Infinity);
      const identity=JSON.stringify([ownerKey(t.owner),grant.checkpoint]);
      if((!retired.has(ownerKey(t.owner)) && !targets.has(target)) || finalClaims.has(identity) ||
        ownerKey(grant.owner)!==ownerKey(t.owner) || t.target.kind!=="record" || t.target.id!==grant.recordId ||
        input.now()>=deadline)throw new Error("stale");
      grant={...structuredClone(grant),deadlineMonotonicMs:deadline};finalClaims.add(identity);
    } else if(retired.has(ownerKey(t.owner)) || targets.has(target))throw new Error("stale");
    args["engine.reserve"].parse([t,size]);
    const slot=freeSlots.pop();if(slot===undefined)throw new Error("gate-slot-limit");
    Atomics.store(inUse,slot,1);const gate=new PublicationGate(Math.min(t.deadlineMonotonicMs,grant?.deadlineMonotonicMs??Infinity),held,gateOffset(slot),true);
    const accepted=++sequence;ledger.set(t.id,{ticket:structuredClone(t),gate,sequence:accepted,slot,settledAt:null});
    let posted=false;
    try{await send(grant?"engine.reserveFinal":"engine.reserve",grant?[t,size,grant]:[t,size],{slot,sequence:accepted},()=>{posted=true;});}
    catch(e){if(!posted)releaseSlot(t.id);throw e;}
  }
  const engine:PersistenceBackend["engine"]={
    reserve:(t,size)=>admit(t,size),reserveFinal:(t,size,grant)=>admit(t,size,grant),
    publishRecovery:(t,p,d)=>send("engine.publishRecovery",[t,p,Math.min(d,input.now()+10000)]),
    append:(t,o,b)=>send("engine.append",[t,o,b]),seal:(t,n,h)=>send("engine.seal",[t,n,h]),
    async publish(t){try{return await send("engine.publish",[t]);}catch(e){if(ledger.get(t.id)?.gate.dispatched)return {disposition:"unknown"};throw e;}},
    reconcile:t=>send("engine.reconcile",[t]),abort:t=>send("engine.abort",[t]),
    fence(owner,deadline){deadline=Math.min(deadline,ownerDeadlines.get(ownerKey(owner))??Infinity);ownerDeadlines.set(ownerKey(owner),deadline);retired.add(ownerKey(owner));const ids:string[]=[];for(const e of ledger.values())if(ownerKey(e.ticket.owner)===ownerKey(owner)){e.gate.shorten(deadline,input.now());ids.push(e.ticket.id);}return ids;},
    fenceTarget(owner,id,deadline){const key=JSON.stringify([ownerKey(owner),id]);deadline=Math.min(deadline,targetDeadlines.get(key)??Infinity);targetDeadlines.set(key,deadline);targets.add(JSON.stringify([ownerKey(owner),id]));const ids:string[]=[];for(const e of ledger.values())if(ownerKey(e.ticket.owner)===ownerKey(owner) && e.ticket.target.kind==="record" && e.ticket.target.id===id){e.gate.shorten(deadline,input.now());ids.push(e.ticket.id);}return ids;},
  };
  function captureBarrier(scope:PersistenceScope,deadline:number,retain:boolean):PersistenceBarrier {
    input.profile.assertHeld();pruneLedger();pruneBarriers();if(barriers.size>=1024)throw new Error("barrier-limit");
    const barrier=Object.freeze({id:randomUUID(),scope:structuredClone(scope),through:sequence,deadlineMonotonicMs:deadline});
    barriers.set(barrier.id,{barrier,expires:retain?input.now()+120000:deadline,
      tickets:[...ledger.values()].filter(e=>e.sequence<=barrier.through && matches(scope,e.ticket)).map(e=>e.ticket)});
    return barrier;
  }
  const backend:PersistenceBackend={engine,
    reads:{settings:o=>send("reads.settings",[o]),stat:(o,id)=>send("reads.stat",[o,id]),list:(o,p)=>send("reads.list",[o,p]),open:(o,id,r)=>send("reads.open",[o,id,r]),read:(o,p,n,m)=>send("reads.read",[o,p,n,m]),close:(o,p)=>send("reads.close",[o,p])},
    evidence:{saveCheckpoint:(o,v)=>send("evidence.saveCheckpoint",[o,v]),retainSealed:t=>send("evidence.retainSealed",[t]),
      capture:(scope,deadline)=>captureBarrier(scope,deadline,false),
      captureDrain:(scope,deadline)=>captureBarrier(scope,deadline,true),
      tickets(b){pruneBarriers();const saved=barriers.get(b.id);if(!saved || JSON.stringify(saved.barrier)!==JSON.stringify(b))throw new Error("stale");return structuredClone(saved.tickets);},
      async flush(b){const tickets=backend.evidence.tickets(b);try{return await send("evidence.flush",[b,tickets]);}finally{barriers.delete(b.id);pruneBarriers();}},quota:o=>send("evidence.quota",[o]),settingsDigest:o=>send("evidence.settingsDigest",[o]),
      auxiliary:(o,k,key)=>send("evidence.auxiliary",[o,k,key]),auxiliaryKeys:(o,k,c)=>send("evidence.auxiliaryKeys",[o,k,c]),recoveryPage:c=>send("evidence.recoveryPage",[c]),
      loadRecovery:id=>send("evidence.loadRecovery",[id]),saveRecovery:v=>send("evidence.saveRecovery",[v]),removeRecovery:id=>send("evidence.removeRecovery",[id]),
    },
    imports:{admit:(o,id,k)=>send("imports.admit",[o,id,k]),load:(o,id)=>send("imports.load",[o,id]),plan:(o,p)=>send("imports.plan",[o,p]),tagImport:(t,tag)=>send("imports.tagImport",[t,tag]),importReceipts:(o,id)=>send("imports.importReceipts",[o,id]),record:(o,id,e)=>send("imports.record",[o,id,e]),reconcile:t=>send("imports.reconcile",[t]),complete:(o,id)=>send("imports.complete",[o,id])},
    destinations:{async register(i){const id=await send("destinations.register",[i]) as unknown as string;const token=Object.freeze({}) as ExportDestination;destinations.set(token,id);return token;},release:d=>{const id=destinations.get(d);if(!id)throw new Error("stale");return send("destinations.release",[id]);}},
    output:{begin:(id,o,d,n,h,deadline)=>{const token=destinations.get(d);if(!token)throw new Error("stale");return send("output.begin",[id,o,token,n,h,deadline]);},append:(id,o,b)=>send("output.append",[id,o,b]),commit:id=>send("output.commit",[id]),reconcile:id=>send("output.reconcile",[id]),abort:id=>send("output.abort",[id])},
    sources:{resolvePreferences:i=>send("sources.resolvePreferences",[i]),register:i=>send("sources.register",[i]),map:(d,k)=>send("sources.map",[d,k]),appendMapped:i=>send("sources.appendMapped",[i]),releaseMapped:m=>send("sources.releaseMapped",[m]),inventory:d=>send("sources.inventory",[d]),read:(d,k,o,n)=>send("sources.read",[d,k,o,n])},
    dispose(){return closing??=new Promise<void>((resolve,reject)=>{if(exited || dead){Atomics.store(new Int32Array(held),0,0);channel?.port1.close();if(exitCode===0)resolve();else reject(new Error("worker-dispose-unknown"));return;}input.profile.assertHeld();for(const e of ledger.values())e.gate.shorten(input.now(),input.now());worker.once("exit",code=>{channel?.port1.close();Atomics.store(new Int32Array(held),0,0);if(code===0)resolve();else reject(new Error("worker-dispose-unknown"));});worker.postMessage({version:1,kind:"close"});});},
  };
  workerInstances.set(backend,()=>exited?0:1);
  diagnosticInstances.set(backend,{snapshot:()=>({owners:0,bindings:0,subscriptions:0,queuedEvents:0,queuedBytes:0,timers:0,pendingInvocations:0,actionTokens:0,resourceReaders:0,workerJobs:queue.pending}),onEvent:()=>()=>{}});
  return {backend,recovery:ready.recovery};
}

export function runPersistenceWorker(input:{mappers:ReadonlyMap<string,LegacyImportDescriptor>;sourceRoots?:ReadonlyMap<string,string>}):void {
  if(!parentPort)throw new Error("worker-port-missing");const port=parentPort;
  port.once("message",async raw=>{
    const boot=bootSchema.parse(raw);if(!path.isAbsolute(boot.root) || boot.held.byteLength!==sharedBytes)throw new Error("invalid-boot");
    const profile:ProfileWriterLock={hostEpoch:boot.hostEpoch,assertHeld(){if(Atomics.load(new Int32Array(boot.held),0)!==1)throw new Error("not-primary");}};
    profile.assertHeld();const faultPort=(workerData as {faultPort?:MessagePort}).faultPort;
    const armed=new Map<PersistenceFaultPoint,"pause"|"fail"|"kill">(),paused=new Map<PersistenceFaultPoint,()=>void>();
    faultPort?.on("message",m=>{if(m.kind==="arm")armed.set(m.point,m.action);if(m.kind==="release"){paused.get(m.point)?.();paused.delete(m.point);}});
    const activeTicket=new AsyncLocalStorage<string|null>();
    const fs=new NodePersistenceFs(boot.root,profile,{fault:async(point,edge)=>{
      if(edge!=="before")return;
      faultPort?.postMessage({point,time:performance.now(),ticket:activeTicket.getStore()??null});const action=armed.get(point);if(!action)return;armed.delete(point);
      if(action==="kill")process.exit(71);if(action==="fail")throw Object.assign(new Error("injected"),{code:"EIO"});
      await new Promise<void>(resolve=>paused.set(point,resolve));
    }});
    await fs.check(fs.path());const store=new AtomicStore(fs),output=new NativeOutput(profile,store.quota,()=>performance.now(),fs),sources=new WorkerSources(boot.root,store,input.mappers,input.sourceRoots??new Map());
    await sources.validateRoots();
    let recovery:"ready"|"blocked"="ready";try{await store.initialize();}catch{recovery="blocked";}
    const queue=new WorkQueue(()=>performance.now()),accepted=new Map<number,{ticket:PublicationTicket;until:number|null}>(),destinations=new Map<string,ExportDestination>();let closed=false;const requests=new Map<number,z.infer<typeof PersistenceWorkerRequest>>();
    function collectSettled() {
      const settled:Array<{id:string;disposition:"committed"|"aborted"}>=[];
      // Admission and historical reconciliation may settle a different, actual attempt.
      // Include attempts settled indirectly by the store's pruning.
      for(const e of accepted.values()) {
        const terminal=store.settledDisposition(e.ticket.id);
        if(terminal) {e.until??=performance.now()+120000;settled.push({id:e.ticket.id,disposition:terminal});}
        else if(store.unresolvedTicket(e.ticket.id))e.until=null;
      }
      return settled;
    }
    const api={
      "engine.reserveFinal":(t:PublicationTicket,n:number,g:FinalWriteGrant)=>{
        store.fenceTarget(t.owner,g.recordId,g.deadlineMonotonicMs);
        return store.reserveFinal(t,n,g,boot.held,gateOffset([...accepted].find(([,e])=>e.ticket.id===t.id)![0]));
      },
      "engine.publishRecovery":store.publishRecovery.bind(store),
      "evidence.retainSealed":store.retainSealed.bind(store),
      "evidence.saveCheckpoint":store.saveCheckpoint.bind(store),
      "engine.reserve":(t:PublicationTicket,n:number)=>store.reserve(t,n,boot.held,gateOffset([...accepted].find(([,e])=>e.ticket.id===t.id)![0])),"engine.append":store.append.bind(store),"engine.seal":store.seal.bind(store),"engine.publish":store.publish.bind(store),"engine.reconcile":store.reconcile.bind(store),"engine.abort":store.abort.bind(store),
      "reads.settings":store.settings.bind(store),"reads.stat":store.stat.bind(store),"reads.list":store.list.bind(store),"reads.open":store.open.bind(store),"reads.read":store.read.bind(store),"reads.close":store.close.bind(store),
      "evidence.flush":(b:PersistenceBarrier,tickets:PublicationTicket[])=>store.flushEvidence(b,tickets.filter(t=>matches(b.scope,t))),
      "evidence.quota":async(o:PersistenceOwner)=>({ok:true as const,value:store.quota.snapshot(o.sourceKey)}),"evidence.settingsDigest":store.settingsDigest.bind(store),"evidence.auxiliary":store.auxiliary.bind(store),"evidence.auxiliaryKeys":store.auxiliaryKeys.bind(store),"evidence.recoveryPage":store.recoveryPage.bind(store),"evidence.loadRecovery":store.loadRecovery.bind(store),"evidence.saveRecovery":store.saveRecovery.bind(store),"evidence.removeRecovery":store.removeRecovery.bind(store),
      "imports.admit":store.admitImport.bind(store),"imports.load":store.loadImport.bind(store),"imports.plan":store.planImport.bind(store),"imports.tagImport":store.tagImport.bind(store),"imports.importReceipts":store.importReceipts.bind(store),"imports.record":store.recordImport.bind(store),"imports.reconcile":store.reconcileImport.bind(store),"imports.complete":store.completeImport.bind(store),
      "destinations.register":async(i:Parameters<NativeOutput["register"]>[0])=>{const value=await output.register(i),id=randomUUID();destinations.set(id,value);return id;},"destinations.release":async(id:string)=>{const d=destinations.get(id);if(!d)throw new Error("stale");await output.release(d);},
      "output.begin":(id:string,o:PersistenceOwner,d:string,n:number,h:string,deadline:number)=>{const token=destinations.get(d);if(!token)throw new Error("stale");return output.begin(id,o,token,n,h,deadline);},"output.append":output.append.bind(output),"output.commit":output.commit.bind(output),"output.reconcile":output.reconcile.bind(output),"output.abort":output.abort.bind(output),
      "sources.resolvePreferences":sources.resolvePreferences.bind(sources),"sources.register":sources.register.bind(sources),"sources.map":sources.map.bind(sources),"sources.appendMapped":sources.appendMapped.bind(sources),"sources.releaseMapped":sources.releaseMapped.bind(sources),"sources.inventory":sources.inventory.bind(sources),"sources.read":sources.read.bind(sources),
    };
    port.on("message",raw=>{
      const cancel=z.strictObject({version:z.literal(1),kind:z.literal("cancel"),id:count.min(1)}).safeParse(raw);
      if(cancel.success){const original=requests.get(cancel.data.id);const t=original?.args[0];const parsed=publicationTicketSchema.safeParse(t);if(parsed.success)store.fenceTargetOrTicket(parsed.data);return;}
      if(z.strictObject({version:z.literal(1),kind:z.literal("close")}).safeParse(raw).success){closed=true;void (async()=>{while(queue.pending)await new Promise(r=>setTimeout(r,1));await store.dispose();for(const d of destinations.values())await output.release(d);output.assertSettled();faultPort?.close();port.close();})().catch(()=>{process.exitCode=72;faultPort?.close();port.close();});return;}
      const parsed=PersistenceWorkerRequest.safeParse(raw);if(!parsed.success || closed)return;
      const r=parsed.data;
      requests.set(r.id,r);
      if(recovery==="blocked" && !["evidence.recoveryPage","evidence.loadRecovery","evidence.auxiliary","evidence.auxiliaryKeys","imports.load","imports.importReceipts","imports.reconcile"].includes(r.operation)){port.postMessage({version:1,id:r.id,ok:false,error:{code:"io",message:"unsupported-format"}});return;}
      if(r.operation==="engine.reserve" || r.operation==="engine.reserveFinal") {
        try {
          reserveGateOffset(boot.held,r.gate);
          for(const [slot,e] of accepted)if(e.until!==null && e.until<=performance.now())accepted.delete(slot);
          if(accepted.has(r.gate!.slot))throw new Error("invalid-gate");
          accepted.set(r.gate!.slot,{ticket:publicationTicketSchema.parse(r.args[0]),until:null});
        }catch(error){requests.delete(r.id);port.postMessage({version:1,id:r.id,ok:false,error:privateError(error)});return;}
      }
      const first=r.args[0] as {owner?:PersistenceOwner;sourceKey?:string;id?:string}|undefined;
      void queue.run(first?.owner?.sourceKey??first?.sourceKey??"core",charge(r.args)+256,performance.now()+10000,async()=>{
        profile.assertHeld();
        const fn=api[r.operation] as (...parameters:unknown[])=>Promise<unknown>;return activeTicket.run(first?.owner?first.id??null:null,()=>fn(...r.args));
      }).then(async value=>{
        const disposition=typeof value==="string"?value:(value as {disposition?:string})?.disposition;
        if(["engine.publish","engine.reconcile"].includes(r.operation) && disposition==="not-committed") {
          // A pre-dispatch observation becomes terminal only after revocation and cleanup.
          const original=publicationTicketSchema.parse(r.args[0]);
          if(!store.retainedSealed(original))await store.abort(original);
        }
        const settled=collectSettled();
        port.postMessage({version:1,id:r.id,ok:true,value,settled});
      }).catch(error=>{
        if(r.operation==="engine.reserve" || r.operation==="engine.reserveFinal")store.recordUnadmittedReserve(r.args[0] as PublicationTicket);
        port.postMessage({version:1,id:r.id,ok:false,error:privateError(error),settled:collectSettled()});
      }).finally(()=>requests.delete(r.id));
    });
    port.postMessage({version:1,kind:"ready",recovery});
  });
}
// K170's CJS entry footer calls exports.runPersistenceWorker({mappers:new Map()}).
// The module itself has no auto-start side effect, so T7's wrapper can call the runner once.

import { parseNonceDocument, snapshotBytes, importIdFor } from "./import-sources.js";
import { sameImportValue, sameImportAttempt } from "./namespace.js";
import type { LegacyPreferencesEvidenceRef } from "./engine-port.js";
type SourceBinding = {kind:"file";descriptor:LegacyImportDescriptor;fs:NodePersistenceFs} |
  {kind:"renderer";descriptor:LegacyImportDescriptor;resolved:null|{
    owner:PersistenceOwner;evidence:LegacyPreferencesEvidenceRef;bytes:Uint8Array;charge:string}};
export class WorkerSources implements LegacySourceResolver {
  private readonly registered=new Map<string,SourceBinding>();
  private readonly mapped=new Map<string,{bytes:Uint8Array;sourceSha256:string;mappedSha256:string;metadata:LegacyMappedItem;offset:number;ticket:string|null}>();
  constructor(private readonly root:string,private readonly store:AtomicStore,private readonly mappers:ReadonlyMap<string,LegacyImportDescriptor>,private readonly sourceRoots:ReadonlyMap<string,string>) {
    this.sourceRoots=new Map(sourceRoots);this.mappers=new Map(mappers);
    const used=new Set<string>();
    for(const [id,root] of this.sourceRoots) {
      const descriptor=this.mappers.get(id);
      if(!descriptor || descriptor.id!==id || descriptor.sourceKind==="renderer-preferences" ||
          !path.isAbsolute(root) || path.normalize(root)!==root || root.includes("\0") || used.has(root))throw new Error("invalid-source-root");
      used.add(root);
    }
  }
  async validateRoots():Promise<void> {
    for(const root of this.sourceRoots.values()){const fs=new NodePersistenceFs(root,this.store.fs.profile);await fs.check(fs.path());}
  }
  async register(input:Parameters<LegacySourceResolver["register"]>[0]):Promise<void> {
    const descriptor=this.mappers.get(input.mapperId);
    if(!descriptor || descriptor.id!==input.descriptorId || descriptor.sourceKind!==input.sourceKind)throw new Error("invalid-mapper");
    const existing=this.registered.get(input.descriptorId);
    if(existing) {if(existing.descriptor!==descriptor)throw new Error("invalid-mapper");return;}
    if(descriptor.sourceKind==="renderer-preferences") {
      this.registered.set(input.descriptorId,{kind:"renderer",descriptor,resolved:null});return;
    }
    const sourceRoot=this.sourceRoots.get(descriptor.id);
    if(!sourceRoot)throw new Error("missing-source-root");
    this.registered.set(input.descriptorId,{kind:"file",descriptor,fs:new NodePersistenceFs(sourceRoot,this.store.fs.profile)});
  }
  private source(id:string){const s=this.registered.get(id);if(!s)throw new Error("stale");return s;}
  async resolvePreferences(input:Parameters<LegacySourceResolver["resolvePreferences"]>[0]):Promise<void> {
    const binding=this.source(input.descriptorId);
    if(binding.kind!=="renderer" || input.owner.sourceKey!==binding.descriptor.targetSourceKey ||
        input.owner.hostEpoch!==this.store.fs.profile.hostEpoch)throw new Error("stale");
    const plan=await this.store.loadImport(input.owner,importIdFor(binding.descriptor.id,binding.descriptor.targetSourceKey));
    if(plan && !plan.complete && !sameImportValue(plan.plan.preferencesEvidence,input.evidence))throw new Error("input-changed");
    if(binding.resolved && (!sameImportValue(binding.resolved.evidence,input.evidence) ||
        !sameImportValue(binding.resolved.owner,input.owner)))throw new Error("input-changed");
    const encoded=await this.store.auxiliary(input.owner,"import","nonce/"+input.evidence.nonce);
    if(!encoded)throw new Error("missing-evidence");
    const document=parseNonceDocument(encoded);
    if(document.state!=="consumed" || !document.raw || document.nonce!==input.evidence.nonce ||
        document.digest!==input.evidence.digest || document.sourceKey!==input.owner.sourceKey ||
        document.originalTicket.owner.pluginId!==input.owner.pluginId || document.descriptorId!==binding.descriptor.id ||
        !sameImportValue(document.allowlist,binding.descriptor.rendererKeyAllowlist) ||
        !binding.descriptor.sourceFormatVersions.includes(1))throw new Error("evidence-binding");
    const bytes=snapshotBytes(document.raw,document.allowlist);
    if(createHash("sha256").update(bytes).digest("hex")!==input.evidence.digest)throw new Error("evidence-binding");
    if(binding.resolved) {
      if(!Buffer.from(binding.resolved.bytes).equals(bytes))throw new Error("input-changed");return;
    }
    const bindings=[...this.registered.values()].flatMap(s=>s.kind==="renderer" && s.resolved?[s.resolved]:[]);
    if(bindings.reduce((total,b)=>total+b.bytes.length,bytes.length)>8388608 ||
        bindings.filter(b=>b.owner.sourceKey===input.owner.sourceKey).reduce((total,b)=>total+b.bytes.length,bytes.length)>524288)
      throw new Error("quota");
    const charge=randomUUID();this.store.quota.holdTemporary(input.owner.sourceKey,charge,bytes.length);
    binding.resolved={owner:structuredClone(input.owner),evidence:structuredClone(input.evidence),bytes,charge};
  }
  private async preferences(binding:Extract<SourceBinding,{kind:"renderer"}>):Promise<Uint8Array> {
    if(!binding.resolved)throw new Error("missing-evidence");
    await this.resolvePreferences({descriptorId:binding.descriptor.id,owner:binding.resolved.owner,evidence:binding.resolved.evidence});
    return binding.resolved.bytes;
  }
  async inventory(id:string):ReturnType<LegacySourceResolver["inventory"]> {
    const binding=this.source(id),{descriptor}=binding;
    if(binding.kind==="renderer") {
      if(!binding.resolved)return {state:"blocked",entries:[]};
      const bytes=await this.preferences(binding);
      return {state:"present",entries:[{key:"preferences",format:1,byteLength:bytes.length,sha256:binding.resolved.evidence.digest}]};
    }
    const {fs}=binding;
    try {
      await fs.check(fs.path());const entries=await fs.entries(fs.path(),4096),items:LegacySourceItem[]=[];
      if(entries.length>512)throw new Error("size-limit");
      for(let start=0;start<entries.length;start+=64)for(const entry of entries.slice(start,start+64)) {
        if(entry.directory || Buffer.byteLength(entry.name)>128 || entry.bytes>8388608)throw new Error("invalid-resource");
        const bytes=await fs.bytes(fs.path(entry.name),8388608),sha256=createHash("sha256").update(bytes).digest("hex");
        const raw=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)),format=raw.formatVersion;
        if(!descriptor.sourceFormatVersions.includes(format) || !descriptor.validate({sourceKind:descriptor.sourceKind,bytes,sha256}))throw new Error("unsupported-format");
        items.push({key:entry.name,format,byteLength:bytes.length,sha256});
      }
      return {state:"present",entries:items};
    }catch(e){return {state:(e as NodeJS.ErrnoException).code==="ENOENT"?"absent":"blocked",entries:[]};}
  }
  async read(id:string,key:string,offset:number,maxBytes:number):Promise<Uint8Array> {
    const binding=this.source(id);
    if(!Number.isSafeInteger(offset) || offset<0 || !Number.isSafeInteger(maxBytes) || maxBytes<1 || maxBytes>262144)throw new Error("size-limit");
    if(binding.kind==="renderer") {
      if(key!=="preferences")throw new Error("stale");
      const bytes=await this.preferences(binding);if(offset>bytes.length)throw new Error("offset-mismatch");
      return bytes.slice(offset,offset+maxBytes);
    }
    const {fs}=binding;if(Buffer.byteLength(key)>128)throw new Error("size-limit");
    const fd=await fs.open(fs.path(key),"read");try{return await fs.read(fd,offset,maxBytes);}finally{await fs.close(fd);}
  }
  private async settingsValidationDigest(descriptor:LegacyImportDescriptor):Promise<string> {
    const owner:PersistenceOwner={sourceKey:descriptor.targetSourceKey,pluginId:descriptor.id,generation:0,hostEpoch:this.store.fs.profile.hostEpoch,processEpoch:this.store.fs.profile.hostEpoch};
    const committed=await this.store.settingsDigest(owner);
    if(committed && committed.schemaVersion===descriptor.targetSettingsSchemaVersion)return committed.validationDigest;
    // A target without a committed schema is initialized through the bound settings service
    // before import planning; mapping never invents a resource validation digest.
    throw new Error("schema-mismatch");
  }
  async map(id:string,key:string):Promise<LegacyMappedItem> {
    const binding=this.source(id),{descriptor}=binding;
    if(binding.kind==="renderer" && key!=="preferences")throw new Error("stale");
    const bytes=binding.kind==="renderer"?await this.preferences(binding):await binding.fs.bytes(binding.fs.path(key),8388608);
    const sourceSha256=createHash("sha256").update(bytes).digest("hex");
    if(!descriptor.validate({sourceKind:descriptor.sourceKind,bytes,sha256:sourceSha256}))throw new Error("invalid-resource");
    const item=descriptor.map({sourceKind:descriptor.sourceKind,bytes,sha256:sourceSha256});
    const mappedBytes=item.kind==="record"?item.bytes:Buffer.from(JSON.stringify({formatVersion:1,schemaVersion:item.schemaVersion,values:item.values,
      validationDigest:await this.settingsValidationDigest(descriptor)}));
    if(mappedBytes.length>8388608 || this.mapped.size>=4)throw new Error("quota");
    const mapped=randomUUID(),mappedSha256=createHash("sha256").update(mappedBytes).digest("hex");
    this.store.quota.holdTemporary(descriptor.targetSourceKey,mapped,mappedBytes.length);
    const metadata:LegacyMappedItem={mapped,sourceSha256,mappedSha256,byteLength:mappedBytes.length,
      ...(item.kind==="record"?{kind:"record",metadata:item.metadata}:{kind:"settings",schemaVersion:item.schemaVersion})};
    this.mapped.set(mapped,{bytes:mappedBytes,sourceSha256,mappedSha256,metadata,offset:0,ticket:null});return metadata;
  }
  async appendMapped(input:Parameters<LegacySourceResolver["appendMapped"]>[0]):ReturnType<LegacySourceResolver["appendMapped"]> {
    const p=this.mapped.get(input.mapped);
    if(!p || input.offset!==p.offset || input.maxBytes<1 || input.maxBytes>262144 || (p.ticket!==null && p.ticket!==input.ticket.id))throw new Error("stale");
    const planKeys=await this.store.auxiliaryKeys(input.ticket.owner,"import");let cursor=planKeys.nextCursor,keys=[...planKeys.keys],matched=false;
    for(;;){for(const key of keys){
        if(!key.startsWith("import/"))continue;
        const plan=await this.store.loadImport(input.ticket.owner,key);
        if(plan?.plan.items.some(i=>this.store.taggedImport(input.ticket,i.tag) && sameImportValue(plan.items.find(e=>e.key===i.key)?.publicationTicket,input.ticket) &&
          sameImportAttempt(i.ticket,input.ticket) && i.byteLength===p.bytes.length &&
          i.mappedSha256===p.mappedSha256 && i.sourceSha256===p.sourceSha256 &&
          (p.metadata.kind==="settings"?input.ticket.metadata.kind==="settings" &&
            p.metadata.schemaVersion===input.ticket.metadata.schemaVersion:
            input.ticket.metadata.kind==="record" && p.metadata.metadata.kind===input.ticket.metadata.record.kind &&
            p.metadata.metadata.schemaVersion===input.ticket.metadata.record.schemaVersion)))matched=true;
      }
      if(!cursor)break;const next=await this.store.auxiliaryKeys(input.ticket.owner,"import",cursor);keys=[...next.keys];cursor=next.nextCursor;}
    if(!matched)throw new Error("input-changed");p.ticket=input.ticket.id;
    const chunk=p.bytes.subarray(p.offset,p.offset+input.maxBytes);if(chunk.length)p.offset=await this.store.append(input.ticket,p.offset,chunk);
    return {nextOffset:p.offset,done:p.offset===p.bytes.length};
  }
  async releaseMapped(mapped:string):Promise<void> {
    const p=this.mapped.get(mapped);if(!p)return;
    // Unknown publications keep their scratch evidence until original-ticket reconciliation.
    if(p.ticket && this.store.unresolvedTicket(p.ticket))throw new Error("publish-uncertain");
    for(const {descriptor} of this.registered.values())this.store.quota.releaseTemporary(descriptor.targetSourceKey,mapped);
    this.mapped.delete(mapped);
  }
}
