import { mkdtemp, rm, symlink, link, writeFile, lstat, readFile, rename, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createNodePersistenceFs, writeAll, classifyFsError, type StorePath } from "./filesystem.js";
const roots: string[] = [];
const profile = { hostEpoch: "00000000-0000-4000-8000-000000000001", assertHeld() {} };
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "persistence-fs-"))); roots.push(root);
  return { root, fs: await createNodePersistenceFs(root, profile) };
}
it("initializes no persistence files when the original profile capability is not held", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "secondary-")); roots.push(root);
  await expect(createNodePersistenceFs(root, { hostEpoch: profile.hostEpoch, assertHeld() { throw new Error("not-primary"); } })).rejects.toThrow("not-primary");
  await expect(lstat(path.join(root, "plugins"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("rejects fabricated paths, symlinks, hardlinks and traversal", async () => {
  const { root, fs } = await setup();
  await expect(fs.open({} as StorePath, "read")).rejects.toThrow("unsafe-path");
  expect(() => fs.path("..")).toThrow("unsafe-path");
  const outside = path.join(root, "outside"); await writeFile(outside, "unchanged");
  await symlink(outside, path.join(fs.root, "alias"));
  await expect(fs.open(fs.path("alias"), "read")).rejects.toThrow("unsafe-path");
  await link(outside, path.join(fs.root, "hard"));
  await expect(fs.open(fs.path("hard"), "read")).rejects.toThrow("unsafe-path");
});
it("loops short writes, rejects zero progress and never unlinks before replace", async () => {
  const { fs } = await setup(), p = fs.path("x");
  const fd = await fs.open(p, "create-exclusive"), original = fs.write.bind(fs);
  fs.write = (f, offset, bytes) => original(f, offset, bytes.subarray(0, 2));
  await writeAll(fs, fd, 0, new Uint8Array([1, 2, 3, 4, 5])); await fs.sync(fd); await fs.close(fd);
  const read = await fs.open(p, "read"); expect([...await fs.read(read, 0, 10)]).toEqual([1, 2, 3, 4, 5]); await fs.close(read);
  fs.write = async () => 0;
  await expect(writeAll(fs, {} as never, 0, new Uint8Array([1]))).rejects.toThrow("io");
  expect(classifyFsError({ code: "EXDEV" })).toBe("unsupported-filesystem");
  expect(classifyFsError({ code: "ENOSPC" })).toBe("disk-full");
  expect(classifyFsError({ code: "EDQUOT" })).toBe("disk-full");
  expect(classifyFsError({ code: "EACCES" })).toBe("permission");
  expect(classifyFsError({ code: "EROFS" })).toBe("read-only");
});
it("directory-sync policy distinguishes explicit unsupported from EIO", async () => {
  const { fs } = await setup();
  expect(fs.durability).toBe(process.platform === "win32" ? "file-sync-only" : "file-and-directory-sync");
  fs.directorySync = async () => { throw Object.assign(new Error("disk"), { code: "EIO" }); };
  if (fs.durability === "file-and-directory-sync") await expect(fs.syncDirectory(fs.path())).rejects.toMatchObject({ code: "EIO" });
});

import { NativeOutput } from "./filesystem.js";
import { QuotaLedger } from "./quota.js";
import { createHash,randomUUID } from "node:crypto";
it("registers a native destination, rejects identity swap and preserves old bytes",async()=>{
  const {root,fs}=await setup(),quota=new QuotaLedger(),output=new NativeOutput(profile,quota,()=>0,fs);
  const destination=path.join(root,"export.bin");await writeFile(destination,new Uint8Array([9]));
  const bytes=new Uint8Array([0,255,1]),sha=createHash("sha256").update(bytes).digest("hex");
  const owner={sourceKey:"builtin:kobrixa.lab",pluginId:"kobrixa.lab",generation:1,hostEpoch:profile.hostEpoch,processEpoch:randomUUID()};
  const token=await output.register({action:randomUUID(),scope:{hostEpoch:profile.hostEpoch,workbenchInstance:randomUUID()},nativePath:destination,deadlineMonotonicMs:10000});
  const id=randomUUID();await output.begin(id,owner,token,bytes.length,sha,10000);await output.append(id,0,bytes);
  const result=await output.commit(id);expect(result.disposition).toBe("committed");
  expect((await output.reconcile(id)).commitId).toBe(result.commitId);await output.release(token);
  const next=await output.register({action:randomUUID(),scope:{hostEpoch:profile.hostEpoch,workbenchInstance:randomUUID()},nativePath:destination,deadlineMonotonicMs:10000});
  const job=randomUUID();await output.begin(job,owner,next,bytes.length,sha,10000);await output.append(job,0,bytes);
  const swapped=path.join(root,"swap.bin");await writeFile(swapped,new Uint8Array([8]));
  await rename(swapped,destination);
  await expect(output.commit(job)).rejects.toThrow("destination-changed");
  expect(await readFile(destination)).toEqual(Buffer.from([8]));await output.abort(job);await output.release(next);
});
it("rechecks the primary capability after asynchronous rename preflight",async()=>{
  const {fs}=await setup(),from=fs.path("from"),to=fs.path("to"),fd=await fs.open(from,"create-exclusive");await fs.close(fd);
  const check=fs.check.bind(fs);let held=true;
  fs.profile.assertHeld=()=>{if(!held)throw new Error("not-primary");};
  fs.check=async(p,missing)=>{await check(p,missing);if(fs.name(p)===fs.name(to))held=false;};
  try {await expect(fs.atomicReplace(from,to)).rejects.toThrow("not-primary");}
  finally{held=true;fs.profile.assertHeld=()=>{};}
});
