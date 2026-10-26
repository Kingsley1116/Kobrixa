export declare const storeRootBrand: unique symbol;
export type StoreRoot = {readonly [storeRootBrand]:true};
export declare const storePathBrand: unique symbol;
export declare const storeFdBrand: unique symbol;
export type StorePath = { readonly [storePathBrand]: true };
export type StoreFd = { readonly [storeFdBrand]: true };
export type PersistenceFaultPoint =
  | "reserve"
  | "open-temp"
  | "chunk-write"
  | "seal-sync"
  | "object-rename"
  | "object-dir-sync"
  | "backup-head"
  | "head-write"
  | "before-publish"
  | "after-publish"
  | "head-dir-sync"
  | "cache-publish"
  | "receipt-send"
  | "cleanup"
  | "import-marker";
export interface PersistenceFsPort {
  readonly durability: Durability;
  now(): number;
  open(path: StorePath, mode: "read" | "create-exclusive"): Promise<StoreFd>;
  read(fd: StoreFd, offset: number, maxBytes: number): Promise<Uint8Array>;
  write(fd: StoreFd, offset: number, bytes: Uint8Array): Promise<number>;
  sync(fd: StoreFd): Promise<void>;
  close(fd: StoreFd): Promise<void>;
  syncDirectory(path: StorePath): Promise<void>;
  atomicReplace(from: StorePath, to: StorePath): Promise<void>;
  mkdir(path: StorePath): Promise<void>;
  statfs(path: StorePath): Promise<{ availableBytes: number }>;
  unlink(path: StorePath): Promise<void>;
  fault(point: PersistenceFaultPoint): Promise<void>;
}

import { createStorePath,storePathName } from "./namespace.js";
import { constants } from "node:fs";
import { open, mkdir, lstat, realpath, rename, unlink, rmdir, statfs, opendir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Durability } from "@kobrixa/plugin-protocol";
import type { ProfileWriterLock } from "@kobrixa/plugin-runtime";
export type FsOptions = { now?: () => number; fault?: (point: PersistenceFaultPoint, edge: "before" | "after") => Promise<void>; directorySyncSupported?: boolean };
export function classifyFsError(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (code === "ENOSPC" || code === "EDQUOT") return "disk-full";
  if (code === "EACCES" || code === "EPERM") return "permission";
  if (code === "EROFS") return "read-only";
  if (code === "EXDEV" || code === "ENOTSUP") return "unsupported-filesystem";
  return "io";
}
export async function writeAll(fs: PersistenceFsPort, fd: StoreFd, offset: number, bytes: Uint8Array): Promise<void> {
  let done = 0;
  while (done < bytes.byteLength) {
    const written = await fs.write(fd, offset + done, bytes.subarray(done));
    if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.byteLength - done) throw new Error("io");
    done += written;
  }
}
export class NodePersistenceFs implements PersistenceFsPort {
  readonly durability: Durability;
  private readonly descriptors = new WeakMap<StoreFd, FileHandle>();
  constructor(readonly root: string, readonly profile: ProfileWriterLock, private readonly options: FsOptions = {}) {
    // The Windows adapter policy is explicit. A Linux/macOS EIO never silently downgrades it.
    this.durability = (options.directorySyncSupported ?? process.platform !== "win32") ? "file-and-directory-sync" : "file-sync-only";
  }
  now(): number { return this.options.now?.() ?? performance.now(); }
  path(...parts: string[]): StorePath {return createStorePath(this,parts);}
  name(p:StorePath):string {return storePathName(this,p);}
  async check(p: StorePath, missingLeaf = false): Promise<void> {
    this.profile.assertHeld();
    const name = this.name(p), relative = path.relative(this.root, name);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("unsafe-path");
    const parts = relative ? relative.split(path.sep) : [];
    for (let i = 0; i <= parts.length; i++) {
      const current = path.join(this.root, ...parts.slice(0, i));
      let st;
      try { st = await lstat(current); }
      catch (e) { if (missingLeaf && i === parts.length && (e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
      if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile()) || (st.isFile() && st.nlink !== 1) || (i < parts.length && !st.isDirectory()) || await realpath(current) !== current) throw new Error("unsafe-path");
    }
  }
  async open(p: StorePath, mode: "read" | "create-exclusive"): Promise<StoreFd> {
    await this.check(p, mode === "create-exclusive");
    const name = this.name(p), nofollow = constants.O_NOFOLLOW ?? 0;
    this.profile.assertHeld();
    const fd = await open(name, (mode === "read" ? constants.O_RDONLY : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL) | nofollow, 0o600);
    try {
      const a = await fd.stat(), b = await lstat(name);
      if (!a.isFile() || a.nlink !== 1 || a.dev !== b.dev || a.ino !== b.ino || b.isSymbolicLink()) throw new Error("unsafe-path");
      await this.check(p);
      const token = Object.freeze({}) as StoreFd; this.descriptors.set(token, fd); return token;
    } catch (e) { await fd.close(); throw e; }
  }
  private fd(token: StoreFd): FileHandle { const fd = this.descriptors.get(token); if (!fd) throw new Error("stale"); return fd; }
  async read(fd: StoreFd, offset: number, maxBytes: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 262144) throw new Error("invalid-range");
    this.profile.assertHeld();const identity=await this.fd(fd).stat();if(!identity.isFile() || identity.nlink!==1)throw new Error("unsafe-path");
    const buffer = Buffer.allocUnsafe(maxBytes); const { bytesRead } = await this.fd(fd).read(buffer, 0, maxBytes, offset);
    return buffer.subarray(0, bytesRead);
  }
  async write(fd: StoreFd, offset: number, bytes: Uint8Array): Promise<number> {
    this.profile.assertHeld();const identity=await this.fd(fd).stat();if(!identity.isFile() || identity.nlink!==1)throw new Error("unsafe-path");this.profile.assertHeld();return (await this.fd(fd).write(bytes, 0, bytes.byteLength, offset)).bytesWritten;
  }
  async sync(fd: StoreFd): Promise<void> { this.profile.assertHeld(); await this.fd(fd).sync(); }
  async close(token: StoreFd): Promise<void> { const fd = this.fd(token); this.descriptors.delete(token); await fd.close(); }
  async directorySync(name: string): Promise<void> { const fd = await open(name, constants.O_RDONLY); try { this.profile.assertHeld();await fd.sync(); } finally { await fd.close(); } }
  async syncDirectory(p: StorePath): Promise<void> { await this.check(p); if (this.durability === "file-and-directory-sync") await this.directorySync(this.name(p)); }
  async atomicReplace(from: StorePath, to: StorePath): Promise<void> {
    await this.check(from); await this.check(to, true);
    const source = await lstat(this.name(from)), parent = await lstat(path.dirname(this.name(to)));
    if (source.dev !== parent.dev) throw Object.assign(new Error("unsupported-filesystem"), { code: "EXDEV" });
    this.profile.assertHeld();await rename(this.name(from), this.name(to)); // Never unlink/copy as a fallback.
  }
  async mkdir(p: StorePath): Promise<void> {
    await this.check(p, true); this.profile.assertHeld();await mkdir(this.name(p), { mode: 0o700 }).catch(e => { if (e.code !== "EEXIST") throw e; });
    await this.check(p); if (!(await lstat(this.name(p))).isDirectory()) throw new Error("unsafe-path");
    if (this.durability === "file-and-directory-sync") await this.directorySync(path.dirname(this.name(p)));
  }
  async statfs(p: StorePath): Promise<{ availableBytes: number }> {
    await this.check(p); const st = await statfs(this.name(p), { bigint: true });
    return { availableBytes: Number(st.bavail * st.bsize > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : st.bavail * st.bsize) };
  }
  async unlink(p: StorePath): Promise<void> { await this.check(p); this.profile.assertHeld();await unlink(this.name(p)); }
  async removeEmpty(p: StorePath): Promise<void> {
    if (!await this.exists(p)) return; await this.check(p); this.profile.assertHeld();await rmdir(this.name(p));
    if (this.durability === "file-and-directory-sync") await this.directorySync(path.dirname(this.name(p)));
  }
  async fault(point: PersistenceFaultPoint): Promise<void> { await this.at(point, async () => {}); }
  async at<T>(point: PersistenceFaultPoint, work: () => Promise<T>): Promise<T> {
    await this.options.fault?.(point, "before"); const value = await work(); await this.options.fault?.(point, "after"); return value;
  }
  async exists(p: StorePath): Promise<boolean> { try { await this.check(p); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } }
  async size(p: StorePath): Promise<number> { await this.check(p); return (await lstat(this.name(p))).size; }
  async entries(p: StorePath, maximum: number): Promise<Array<{ name: string; directory: boolean; bytes: number }>> {
    await this.check(p); const dir = await opendir(this.name(p)), entries: Array<{ name: string; directory: boolean; bytes: number }> = [];
    for await (const entry of dir) {
      if (entries.length === maximum) throw new Error("scan-limit");
      const name = path.join(this.name(p), entry.name), st = await lstat(name);
      if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory()) || (st.isFile() && st.nlink !== 1) || await realpath(name) !== name) throw new Error("unsafe-path");
      entries.push({ name: entry.name, directory: st.isDirectory(), bytes: st.size });
    }
    return entries;
  }
  async bytes(p: StorePath, maximum: number): Promise<Uint8Array> {
    const fd = await this.open(p, "read");
    try {
      const size = (await this.fd(fd).stat()).size;
      if (size > maximum) throw new Error("size-limit");
      const result = new Uint8Array(size); let offset = 0;
      while (offset < size) { const b = await this.read(fd, offset, Math.min(262144, size - offset)); if (!b.length) throw new Error("corrupt"); result.set(b, offset); offset += b.length; }
      if ((await this.fd(fd).stat()).size !== size) throw new Error("input-changed");
      return result;
    } finally { await this.close(fd); }
  }
}
const roots = new WeakMap<StoreRoot, {profile:ProfileWriterLock; userData:string; root:string; dev:bigint; ino:bigint}>();
export async function openStoreRoot(input:{userData:string;profile:ProfileWriterLock}):Promise<StoreRoot> {
  input.profile.assertHeld();
  if (!path.isAbsolute(input.userData)) throw new Error("unsafe-path");
  const anchor=await realpath(input.userData);
  if (anchor !== path.resolve(input.userData)) throw new Error("unsafe-path");
  const fs=await createNodePersistenceFs(anchor,input.profile), st=await lstat(fs.root,{bigint:true});
  const token=Object.freeze({}) as StoreRoot;
  roots.set(token,{profile:input.profile,userData:anchor,root:fs.root,dev:st.dev,ino:st.ino});
  return token;
}
// Private host bootstrap helper; never a runtime/plugin/preload export.
export async function storeRootPath(root:StoreRoot,profile:ProfileWriterLock):Promise<string> {
  profile.assertHeld(); const value=roots.get(root);
  if (!value || value.profile !== profile) throw new Error("unsafe-root");
  const st=await lstat(value.root,{bigint:true});
  if (st.isSymbolicLink() || !st.isDirectory() || st.dev!==value.dev || st.ino!==value.ino || await realpath(value.root)!==value.root) throw new Error("unsafe-root");
  return value.root;
}
export async function createNodePersistenceFs(userData: string, profile: ProfileWriterLock, options: FsOptions = {}): Promise<NodePersistenceFs> {
  profile.assertHeld();
  const anchor = await realpath(userData);
  let current = anchor;
  for (const component of ["plugins", "persistence-v1"]) {
    const next = path.join(current, component);
    await mkdir(next, { mode: 0o700 }).catch(e => { if (e.code !== "EEXIST") throw e; });
    const st = await lstat(next);
    if (!st.isDirectory() || st.isSymbolicLink() || await realpath(next) !== next) throw new Error("unsafe-path");
    if (options.directorySyncSupported ?? process.platform !== "win32") { const fd = await open(current, constants.O_RDONLY); try { await fd.sync(); } finally { await fd.close(); } }
    current = next;
  }
  const fs = new NodePersistenceFs(current, profile, options);
  await fs.check(fs.path()); await fs.mkdir(fs.path("namespaces")); return fs;
}

import { createHash, randomUUID, type Hash } from "node:crypto";
import type { ExportDestination } from "./actions.js";
import type { ExportDestinationRegistry, PersistenceOutputPort, ExportOutcome } from "./engine-port.js";
import type { CoreWindowScope } from "@kobrixa/plugin-runtime";
import type { ResourceOwner } from "@kobrixa/plugin-protocol";
import type { QuotaLedger } from "./quota.js";
type Destination = {action:string;scope:CoreWindowScope;name:string;parent:string;parentIdentity:string;leafIdentity:string|null;deadline:number;claimed:boolean};
type OutputJob = {destination:Destination;owner:ResourceOwner;temp:string;fd:FileHandle;size:number;sha256:string;offset:number;hash:Hash;last:{offset:number;bytes:Uint8Array}|null;outcome:ExportOutcome;dispatched:boolean};
export class NativeOutput implements ExportDestinationRegistry,PersistenceOutputPort {
  private readonly destinations=new Map<ExportDestination,Destination>();
  private readonly jobs=new Map<string,OutputJob>();
  constructor(private readonly profile:ProfileWriterLock,private readonly quota:QuotaLedger,private readonly now:()=>number,private readonly fs:NodePersistenceFs) {}
  private async identity(name:string):Promise<string|null> {
    try {const s=await lstat(name,{bigint:true});if(s.isSymbolicLink() || (!s.isFile() && !s.isDirectory()) || (s.isFile() && s.nlink!==1n))throw new Error("unsafe-path");return `${s.dev}:${s.ino}`;}
    catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e;}
  }
  private async check(d:Destination,checkDeadline=true):Promise<void> {
    this.profile.assertHeld();
    if(checkDeadline && this.now()>=d.deadline)throw new Error("stale");
    if(await realpath(d.parent)!==d.parent || await this.identity(d.parent)!==d.parentIdentity || await this.identity(d.name)!==d.leafIdentity)throw new Error("destination-changed");
  }
  async register(input:Parameters<ExportDestinationRegistry["register"]>[0]):Promise<ExportDestination> {
    this.profile.assertHeld();if(!path.isAbsolute(input.nativePath) || this.now()>=input.deadlineMonotonicMs)throw new Error("stale");
    const parent=path.dirname(input.nativePath);
    if(await realpath(parent)!==parent)throw new Error("unsafe-path");
    const parentIdentity=await this.identity(parent);if(!parentIdentity)throw new Error("destination-changed");
    const token=Object.freeze({}) as ExportDestination;
    this.destinations.set(token,{action:input.action,scope:structuredClone(input.scope),name:input.nativePath,parent,parentIdentity,
      leafIdentity:await this.identity(input.nativePath),deadline:input.deadlineMonotonicMs,claimed:false});return token;
  }
  assertSettled():void {if([...this.jobs.values()].some(j=>j.outcome.disposition==="unknown"))throw new Error("publish-uncertain");}
  async release(token:ExportDestination):Promise<void> {
    const d=this.destinations.get(token);if(!d)return;
    if([...this.jobs.values()].some(j=>j.destination===d && j.outcome.disposition==="unknown"))return;
    for(const [id,j] of this.jobs)if(j.destination===d){if(j.outcome.disposition!=="committed")await this.abort(id);this.jobs.delete(id);}
    this.destinations.delete(token);
  }
  async begin(id:string,owner:ResourceOwner,destination:ExportDestination,bytes:number,sha256:string,deadline:number):Promise<void> {
    const d=this.destinations.get(destination);
    if(!d || d.scope.hostEpoch!==owner.hostEpoch || d.claimed || this.jobs.has(id) || !Number.isSafeInteger(bytes) || bytes<0 || bytes>8388608 || !/^[0-9a-f]{64}$/.test(sha256))throw new Error("stale");
    d.deadline=Math.min(d.deadline,deadline);await this.check(d);
    const disk=await statfs(d.parent,{bigint:true});
    // Node rename is the supported same-volume replacement primitive. EXDEV/ENOTSUP fail without unlink fallback.
    this.quota.reserve(id,owner.sourceKey,{bytes:0,create:false,metadata:0,lane:"export"},Number(disk.bavail*disk.bsize));
    const temp=path.join(d.parent,`.kobrixa-${randomUUID()}.tmp`);
    try {
      this.quota.holdTemporary(owner.sourceKey,temp,bytes);
      const fd=await open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|(constants.O_NOFOLLOW??0),0o600);
      this.jobs.set(id,{destination:d,owner,temp,fd,size:bytes,sha256,offset:0,hash:createHash("sha256"),last:null,outcome:{disposition:"not-committed"},dispatched:false});d.claimed=true;
    }catch(e){this.quota.releaseTemporary(owner.sourceKey,temp);this.quota.release(id);throw e;}
  }
  private job(id:string):OutputJob {const j=this.jobs.get(id);if(!j)throw new Error("stale");return j;}
  async append(id:string,offset:number,bytes:Uint8Array):Promise<number> {
    const j=this.job(id);await this.check(j.destination);
    if(j.dispatched || bytes.length<1 || bytes.length>262144)throw new Error("sealed");
    if(j.last?.offset===offset && Buffer.from(j.last.bytes).equals(Buffer.from(bytes)))return j.offset;
    if(offset!==j.offset || offset+bytes.length>j.size)throw new Error("offset-mismatch");
    let done=0;while(done<bytes.length){this.profile.assertHeld();const r=await j.fd.write(bytes,done,bytes.length-done,offset+done);if(!r.bytesWritten)throw new Error("io");done+=r.bytesWritten;}
    j.hash.update(bytes);j.offset+=bytes.length;j.last={offset,bytes:Uint8Array.from(bytes)};return j.offset;
  }
  async commit(id:string):Promise<ExportOutcome> {
    const j=this.job(id);if(j.dispatched)return this.reconcile(id);
    if(j.offset!==j.size || j.hash.copy().digest("hex")!==j.sha256)throw new Error("incomplete");
    await j.fd.sync();await this.check(j.destination);
    const source=await j.fd.stat(),atPath=await lstat(j.temp);
    if(source.dev!==atPath.dev || source.ino!==atPath.ino)throw new Error("destination-changed");
    await this.fs.fault("before-publish");await this.check(j.destination);
    j.dispatched=true;j.outcome={disposition:"unknown"};
    try {
      await rename(j.temp,j.destination.name);await this.fs.fault("after-publish");
      if(process.platform!=="win32"){const dir=await open(j.destination.parent,constants.O_RDONLY);try{await dir.sync();}finally{await dir.close();}}
      j.outcome={disposition:"committed",commitId:randomUUID(),durability:process.platform==="win32"?"file-sync-only":"file-and-directory-sync"};
      await j.fd.close();this.quota.releaseTemporary(j.owner.sourceKey,j.temp);this.quota.release(id);return j.outcome;
    }catch(e){if(["EXDEV","ENOTSUP"].includes((e as NodeJS.ErrnoException).code??"")){j.dispatched=false;j.outcome={disposition:"not-committed"};throw new Error("unsupported-filesystem");}return j.outcome;}
  }
  async reconcile(id:string):Promise<ExportOutcome> {
    const j=this.job(id);if(j.outcome.disposition!=="unknown")return j.outcome;
    try {
      this.profile.assertHeld();if(await this.identity(j.destination.parent)!==j.destination.parentIdentity)return j.outcome;
      const current=await open(j.destination.name,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
      try {
        const original=await j.fd.stat(),actual=await current.stat();
        if(original.dev!==actual.dev || original.ino!==actual.ino || actual.size!==j.size)return j.outcome;
        const digest=createHash("sha256"),buffer=Buffer.allocUnsafe(262144);let offset=0;
        while(offset<j.size){const r=await current.read(buffer,0,Math.min(buffer.length,j.size-offset),offset);if(!r.bytesRead)return j.outcome;digest.update(buffer.subarray(0,r.bytesRead));offset+=r.bytesRead;}
        if(digest.digest("hex")!==j.sha256)return j.outcome;
        await j.fd.sync();if(process.platform!=="win32"){const dir=await open(j.destination.parent,constants.O_RDONLY);try{await dir.sync();}finally{await dir.close();}}
        j.outcome={disposition:"committed",commitId:randomUUID(),durability:process.platform==="win32"?"file-sync-only":"file-and-directory-sync"};
        await j.fd.close();this.quota.releaseTemporary(j.owner.sourceKey,j.temp);this.quota.release(id);return j.outcome;
      }finally{await current.close();}
    }catch{return j.outcome;}
  }
  async abort(id:string):Promise<"aborted"|"committed"|"unknown"> {
    const j=this.job(id);if(j.dispatched)return (await this.reconcile(id)).disposition==="committed"?"committed":"unknown";
    this.profile.assertHeld();await j.fd.close();await unlink(j.temp);
    this.quota.releaseTemporary(j.owner.sourceKey,j.temp);this.quota.release(id);this.jobs.delete(id);return "aborted";
  }
}
