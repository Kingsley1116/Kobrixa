import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { EventEmitter } from 'node:events';
import type * as WorkerThreads from 'node:worker_threads';
import { WorkQueue } from './quota.js';
import { afterEach, expect, it, vi } from 'vitest';
import { PublicationGate, type PublicationTicket } from './engine-port.js';

type TestFrame = {kind?:string;held:SharedArrayBuffer;operation?:string;id:number;args:[{id:string},...unknown[]];gate?:{slot:number;sequence:number}};
type TestPort = EventEmitter & {postMessage(frame:unknown):void;close():void};
type TestWorker = EventEmitter & {held:SharedArrayBuffer;frames:TestFrame[];gates:Map<string,PublicationGate>;terminate():Promise<number>};
const harness = vi.hoisted(() => ({ worker: null as unknown as TestWorker, hold: false, disposition: 'committed', settledId: null as string|null, runner: null as null|(()=>void), port: null as unknown as TestPort }));
vi.mock('node:worker_threads', async importOriginal => {
  const { EventEmitter } = await import('node:events');
  const original = await importOriginal<typeof WorkerThreads>();
  const port = new EventEmitter() as TestPort;
  port.postMessage = (frame: unknown) => queueMicrotask(() => harness.worker.emit('message', frame));
  port.close = () => queueMicrotask(() => harness.worker.emit('exit', 0));
  harness.port = port;
  class Worker extends EventEmitter {
    held!: SharedArrayBuffer;
    frames: TestFrame[] = [];
    gates = new Map<string, PublicationGate>();
    exited=false;
    postMessage(frame: TestFrame) {
      if(this.exited)return;
      if(harness.runner){this.frames.push(frame);queueMicrotask(()=>port.emit('message',frame));return;}
      if (frame.kind === 'boot') { this.held = frame.held; queueMicrotask(() => this.emit('message', {version:1,kind:'ready',recovery:'ready'})); return; }
      if (frame.kind === 'close') { queueMicrotask(() => this.emit('exit', 0)); return; }
      if (frame.kind === 'cancel') return;
      this.frames.push(frame);
      if (harness.hold) return;
      let value: unknown;
      if (frame.operation === 'engine.reserve') {
        // Emulate the receiver's shared gate, using the private frame (legacy fallback exposes drift).
        const slot = frame.gate?.slot ?? this.gates.size;
        this.gates.set(frame.args[0].id, new PublicationGate(0, this.held, 16 + 16 * slot));
      }
      if (frame.operation === 'engine.publish') value = {disposition: harness.disposition};
      if (frame.operation === 'engine.abort') value = 'aborted';
      const settled = frame.operation === 'engine.publish' && harness.disposition !== 'unknown' ? harness.disposition : frame.operation === 'engine.abort' ? 'aborted' : undefined;
      queueMicrotask(() => this.emit('message', {version:1,id:frame.id,ok:true,value,...(harness.settledId || settled ? {settled:[{id:harness.settledId??frame.args[0].id,disposition:settled??'committed'}]} : {})}));
    }
    async terminate() { this.exited=true;this.emit('exit', 1); return 1; }
    constructor(..._args: unknown[]) { super(); harness.worker = this; harness.runner?.(); }
  }
  return {...original, Worker, parentPort: port, workerData: {}};
});
import { startPersistenceWorker, runPersistenceWorker, privateError, reserveGateOffset } from './worker.js';
import { openStoreRoot } from './filesystem.js';
import { PersistenceFault } from './record-port.js';
const roots: string[] = [];
afterEach(async () => { harness.runner=null; harness.port.removeAllListeners(); vi.restoreAllMocks(); harness.hold=false; harness.disposition='committed'; harness.settledId=null; vi.useRealTimers(); for (const root of roots.splice(0)) await rm(root,{recursive:true,force:true}); });
async function setup() {
  const root=await realpath(await mkdtemp(path.join(await realpath(tmpdir()),'.transport-'))); roots.push(root);
  const profile={hostEpoch:randomUUID(),assertHeld(){}}; let now=0;
  const result=await startPersistenceWorker({profile,root:await openStoreRoot({userData:root,profile}),workerEntry:path.join(root,'unused.cjs'),now:()=>now});
  const owner={sourceKey:'builtin:kobrixa.lab',pluginId:'kobrixa.lab',generation:1,hostEpoch:profile.hostEpoch,processEpoch:randomUUID()};
  const ticket=():PublicationTicket=>{const id=randomUUID();return {id:randomUUID(),owner,deadlineMonotonicMs:now+10000,target:{kind:'record',id,expectedRevision:null},metadata:{kind:'record',deleted:false,record:{id,revision:'r_'+'0'.repeat(32),kind:'test',schemaVersion:1,label:'Test',mediaType:'application/octet-stream',byteLength:0,sha256:'0'.repeat(64),createdAt:1,updatedAt:1,checkpoint:'none',interrupted:false}}};};
  return {...result,owner,ticket,advance:()=>{now+=120001;}};
}
it('queue-rejected reserve releases its slot; the next frame shares the fenced gate', async () => {
  const env=await setup(); harness.hold=true;
  const jobs=Array.from({length:16},()=>env.backend.reads.settings(env.owner).catch(()=>null));
  const rejected=env.ticket(); await expect(env.backend.engine.reserve(rejected,0)).rejects.toThrow('queue');
  expect(env.backend.evidence.tickets(env.backend.evidence.capture({kind:'namespace',owner:env.owner},10000))).toEqual([]);
  harness.hold=false;
  for (const frame of harness.worker.frames) harness.worker.emit('message',{version:1,id:frame.id,ok:true,value:null});
  await Promise.all(jobs);
  const t=env.ticket(); await env.backend.engine.reserve(t,0);
  const frame=harness.worker.frames.at(-1)!; expect(frame.gate).toEqual({slot:0,sequence:2});
  expect(reserveGateOffset(harness.worker.held,frame.gate)).toBe(16);
  env.backend.engine.fenceTarget(env.owner,t.target.kind==='record'?t.target.id:'',0);
  expect(harness.worker.gates.get(t.id)!.dispatch(0)).toBe(false);
  await env.backend.dispose();
});
it('validates explicit gate slots and rejects slots main never allocated', () => {
  const held=new SharedArrayBuffer(16+1024*16+1024*4);
  expect(()=>reserveGateOffset(held,{slot:0,sequence:1})).toThrow("invalid-gate");
  Atomics.store(new Int32Array(held,16+1024*16),0,1);
  expect(reserveGateOffset(held,{slot:0,sequence:1})).toBe(16);
  for (const gate of [{slot:-1,sequence:1},{slot:1024,sequence:1},{slot:0.5,sequence:1},{slot:1,sequence:1}]) expect(()=>reserveGateOffset(held,gate)).toThrow();
});
it('recycles settled slots only after 120 seconds and prunes captured ledger tickets', async () => {
  const env=await setup(); vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  for(let i=0;i<1026;i++) {
    const t=env.ticket(); await env.backend.engine.reserve(t,0); await env.backend.engine.publish(t); env.advance(); await vi.advanceTimersByTimeAsync(120001);
    const barrier=env.backend.evidence.capture({kind:'namespace',owner:env.owner},1e9);
    expect(env.backend.evidence.tickets(barrier)).toEqual([]);await env.backend.evidence.flush(barrier);
  }
  await env.backend.dispose();
});
it('unknown slots are never reused and exhaustion has a quota error', async () => {
  const env=await setup(); harness.disposition='unknown';
  for(let i=0;i<1024;i++){const t=env.ticket();await env.backend.engine.reserve(t,0);await env.backend.engine.publish(t);env.advance();}
  await expect(env.backend.engine.reserve(env.ticket(),0)).rejects.toThrow('gate-slot-limit');
  await env.backend.dispose();
});
it.each([0,1])('dispose after an observed exit %s settles immediately',async code=>{
  const env=await setup(); if(code===1)await harness.worker.terminate();else harness.worker.emit('exit',code);
  const result=env.backend.dispose();
  if(code===0) await expect(result).resolves.toBeUndefined(); else await expect(result).rejects.toThrow('worker-dispose-unknown');
  expect(Atomics.load(new Int32Array(harness.worker.held),0)).toBe(0);
},500);
it.each([['stale','stale'],['expired','stale'],['not-primary','stale'],['quota','quota'],['queue','quota'],['size-limit','quota'],['host-bytes','quota'],['publish-uncertain','unknown'],['input-changed','invalid'],['invalid-resource','invalid'],['revision-mismatch','invalid'],['already-committed','invalid'],['EACCES /private/path','io']])('sanitizes private error %s', (message,code)=>{
  expect(privateError(new Error(message))).toEqual({code,message:code==='io'?'persistence-io':message});
});

it.each(['checksum-mismatch','not-found','record-count','disk-full'])('preserves the bounded storage reason %s',message=>{
  expect(privateError(new Error(message)).message).toBe(message);
});

it.each([['ENOSPC','disk-full'],['EDQUOT','disk-full'],['EACCES','permission'],['EPERM','permission'],['EROFS','read-only']])('sanitizes filesystem error %s without losing its actionable reason', (code,reason)=>{
  expect(privateError(Object.assign(new Error('operation failed at /private/user/data'),{code}))).toEqual({code:'io',message:reason});
});

it.each([
  ['checksum-mismatch','PLUGIN_E_STORAGE_CONFLICT'],
  ['not-found','PLUGIN_E_STORAGE_IO'],
  ['source-bytes','PLUGIN_E_STORAGE_QUOTA'],
] as const)('reconstructs typed storage failure %s without losing internal reconciliation tokens',async(reason,code)=>{
  const env=await setup();
  try {
    harness.hold=true;
    const result=env.backend.reads.stat(env.owner,randomUUID()).catch((error:unknown)=>error);
    const frame=harness.worker.frames.at(-1)!;
    harness.worker.emit('message',{version:1,id:frame.id,ok:false,error:privateError(new Error(reason))});
    const error=await result;
    expect(error).toBeInstanceOf(PersistenceFault);
    expect(error).toMatchObject({message:reason,result:{ok:false,error:{code,detail:{kind:'persistence',reason}}}});
    if(error instanceof PersistenceFault)expect(error.result.error.message).toBe('Persistence request could not be completed.');
  } finally { harness.hold=false;await env.backend.dispose(); }
});

it('keeps settled slots until the full retention window elapses',async()=>{
  const env=await setup();
  for(let i=0;i<1024;i++){const t=env.ticket();await env.backend.engine.reserve(t,0);await env.backend.engine.publish(t);}
  await expect(env.backend.engine.reserve(env.ticket(),0)).rejects.toThrow('gate-slot-limit');
  env.advance();const t=env.ticket();await expect(env.backend.engine.reserve(t,0)).resolves.toBeUndefined();
  await env.backend.dispose();
});
it('drops invalid unposted reserve identities before the next valid reserve',async()=>{
  const env=await setup(),bad={...env.ticket(),metadata:{kind:'invalid'}} as unknown as PublicationTicket;
  await expect(env.backend.engine.reserve(bad,0)).rejects.toThrow();
  expect(env.backend.evidence.tickets(env.backend.evidence.capture({kind:'namespace',owner:env.owner},10000))).toEqual([]);
  const t=env.ticket();await env.backend.engine.reserve(t,0);
  expect(harness.worker.frames.at(-1)!.gate!.slot).toBe(0);await env.backend.dispose();
});

it('applies worker settlement to the actual attempt when historical reconciliation uses a different id',async()=>{
  const env=await setup(),attempt=env.ticket();await env.backend.engine.reserve(attempt,0);
  harness.disposition='unknown';await env.backend.engine.publish(attempt);
  harness.settledId=attempt.id;await env.backend.imports.reconcile(env.ticket());env.advance();
  expect(env.backend.evidence.tickets(env.backend.evidence.capture({kind:'namespace',owner:env.owner},1e9))).toEqual([]);
  await env.backend.dispose();
});
it('invalid gate deadlines cannot consume an unposted slot',async()=>{
  const env=await setup();await expect(env.backend.engine.reserve({...env.ticket(),deadlineMonotonicMs:Infinity},0)).rejects.toThrow();
  await env.backend.engine.reserve(env.ticket(),0);expect(harness.worker.frames.at(-1)!.gate!.slot).toBe(0);await env.backend.dispose();
});

it('settles expired worker reserve jobs, preserves incomplete evidence, and reclaims the slot',async()=>{
  harness.runner=()=>runPersistenceWorker({mappers:new Map()});
  const env=await setup();
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  const original=WorkQueue.prototype.run;let calls=0;
  const spy=vi.spyOn(WorkQueue.prototype,'run').mockImplementation(function<T>(this:WorkQueue,source:string,bytes:number,deadline:number,run:()=>Promise<T>){
    calls++;return original.call(this,source,bytes,calls===2?0:deadline,run) as Promise<T>;
  });
  const t=env.ticket(),responses:{ok:boolean;settled?:unknown}[]=[];harness.worker.on('message',(r:{ok:boolean;settled?:unknown})=>responses.push(r));
  await expect(env.backend.engine.reserve(t,0)).rejects.toThrow();spy.mockRestore();
  expect(calls).toBe(2);expect(responses.at(-1)!.ok).toBe(false);
  expect(responses.at(-1)!.settled).toContainEqual({id:t.id,disposition:'aborted'});
  const barrier=env.backend.evidence.capture({kind:'namespace',owner:env.owner},10000);
  const evidence=await env.backend.evidence.flush(barrier);
  expect(evidence).toMatchObject({incomplete:[t.id],unknown:[]});
  env.advance();await vi.advanceTimersByTimeAsync(120001);
  expect(env.backend.evidence.tickets(env.backend.evidence.capture({kind:'namespace',owner:env.owner},1e9))).toEqual([]);
  // The reclaimed slot is reused even though worker-side admission rejects this expired ticket.
  await env.backend.engine.reserve(env.ticket(),0).catch(()=>{});
  expect(harness.worker.frames.filter((f)=>f.operation==='engine.reserve').at(-1)!.gate!.slot).toBe(0);
  await env.backend.dispose();
});
it('bounds barrier snapshots and prunes expired and flushed captures',async()=>{
  const env=await setup(),scope={kind:'namespace' as const,owner:env.owner};
  const first=env.backend.evidence.capture(scope,1e9);
  for(let i=1;i<1024;i++)env.backend.evidence.capture(scope,1e9);
  expect(()=>env.backend.evidence.capture(scope,1e9)).toThrow('barrier-limit');
  await env.backend.evidence.flush(first);
  expect(()=>env.backend.evidence.tickets(first)).toThrow('stale');
  const expiring=env.backend.evidence.capture(scope,10000);env.advance();
  expect(()=>env.backend.evidence.tickets(expiring)).toThrow('stale');
  expect(()=>env.backend.evidence.capture(scope,1e9)).not.toThrow();
  await env.backend.dispose();
});

it('prunes a barrier when flush rejects',async()=>{
  const env=await setup(),barrier=env.backend.evidence.capture({kind:'namespace',owner:env.owner},10000);
  harness.hold=true;const result=env.backend.evidence.flush(barrier);
  const frame=harness.worker.frames.at(-1)!;
  harness.worker.emit('message',{version:1,id:frame.id,ok:false,error:{code:'io',message:'persistence-io'}});
  await expect(result).rejects.toThrow('persistence-io');
  expect(()=>env.backend.evidence.tickets(barrier)).toThrow('stale');
  await env.backend.dispose();
});
it('T5 retains drain captures separately while ordinary deadline expiry stays stale',async()=>{
  const env=await setup(),scope={kind:'namespace' as const,owner:env.owner};
  const t=env.ticket();await env.backend.engine.reserve(t,0);
  const ordinary=env.backend.evidence.capture(scope,0);
  const drain=env.backend.evidence.captureDrain!(scope,0);
  expect(()=>env.backend.evidence.tickets(ordinary)).toThrow('stale');
  expect(env.backend.evidence.tickets(drain)).toEqual([t]);
  env.advance();expect(()=>env.backend.evidence.tickets(drain)).toThrow('stale');
  await env.backend.dispose();
});
it('T5 final admission keeps earliest main-side fence and permits one checkpoint claim',async()=>{
  const env=await setup(),t=env.ticket();
  if(t.target.kind!=='record' || t.metadata.kind!=='record')throw new Error('record required');
  t.target.expectedRevision='r_'+'1'.repeat(32);t.metadata.record.checkpoint='final';
  const grant={owner:env.owner,recordId:t.target.id,checkpoint:randomUUID(),token:randomUUID(),deadlineMonotonicMs:10000};
  env.backend.engine.fenceTarget(env.owner,t.target.id,1000);env.backend.engine.fence(env.owner,500);
  await expect(env.backend.engine.reserve(t,0)).rejects.toThrow('stale');
  await env.backend.engine.reserveFinal!(t,0,grant);
  const frame=harness.worker.frames.find(f=>f.operation==='engine.reserveFinal')!;
  expect(frame.args[2]).toMatchObject({deadlineMonotonicMs:500});
  await expect(env.backend.engine.reserveFinal!({...t,id:randomUUID()},0,grant)).rejects.toThrow('stale');
  await env.backend.dispose();
});
