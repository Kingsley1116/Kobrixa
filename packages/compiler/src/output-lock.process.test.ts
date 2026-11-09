import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
const childSource = `
import { mkdir, rename, writeFile } from "node:fs/promises";
const { commitArtifacts } = await import(process.argv[1]);
const root = process.argv[2], label = process.argv[3], byte = Number(process.argv[4]);
const project = { root, manifest: { schemaVersion: 1, name: "demo", language: "toy", target: "toy-vm", entry: "main.toy", outputDir: "build", assets: [] }, sources: [], assets: [] };
await mkdir(root + "/build", { recursive: true });
const make = (relativePath, role, slot) => ({ relativePath, role, slot, kind: "test", mediaType: "application/octet-stream", data: new Uint8Array([byte]), ...(role === "deploy-asset" ? { remotePath: "a" } : {}) });
let first = true, firstRenameAt = 0, lastRenameAt = 0, reportedWaiting = false;
const released = label === "a" ? new Promise((resolve) => {
  process.once("message", (message) => {
    if (message.type !== "release") throw new Error("Expected release message");
    resolve();
  });
}) : Promise.resolve();
try {
  const artifacts = await commitArtifacts(project, label, [make("demo.bin", "deploy-main", "program"), make("assets/a", "deploy-asset", "asset"), make("demo.ir.json", "aux", "ir")], new AbortController().signal, { io: {
    write: (file, data) => writeFile(file, data),
    rename: async (from, to) => {
      if (first) { first = false; firstRenameAt = Date.now(); process.send({ type: "locked", label }); if (label === "a") await released; }
      await rename(from, to); lastRenameAt = Date.now();
    },
  }, lock: {
    sleep: async (ms) => {
      if (!reportedWaiting) { reportedWaiting = true; process.send({ type: "waiting", label }); }
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
  } });
  process.send({ type: "done", label, count: artifacts.length, firstRenameAt, lastRenameAt });
} catch (error) { process.send({ type: "failed", message: String(error) }); process.exitCode = 1; }
process.disconnect();
`;
it("serializes commits from two real processes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kobrixa-process-lock-"));
  const children: ChildProcess[] = [];
  type Done = {
    type: "done";
    label: string;
    count: number;
    firstRenameAt: number;
    lastRenameAt: number;
  };
  let waitingCount = 0;
  function start(label: string, byte: number, onWaiting?: () => void) {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        childSource,
        new URL("../dist/index.js", import.meta.url).href,
        root,
        label,
        String(byte),
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    children.push(child);
    let stderr = "";
    child.stderr!.on("data", (chunk) => {
      stderr += String(chunk);
    });
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const done = new Promise<Done>((resolve, reject) => {
      let value: Done | undefined;
      child.on("message", (message: unknown) => {
        const item = message as { type: string; message?: string };
        if (item.type === "locked") locked();
        else if (item.type === "waiting") {
          waitingCount++;
          onWaiting?.();
        } else if (item.type === "done") value = message as Done;
        else reject(new Error(item.message));
      });
      child.once("error", reject);
      child.once("close", (code) =>
        value && code === 0
          ? resolve(value)
          : reject(new Error(`Child ${label} exited ${code}: ${stderr}`)),
      );
    });
    return {
      acquired: Promise.race([acquired, done.then(() => undefined)]),
      done,
      release: () => child.send({ type: "release" }),
    };
  }
  try {
    const a = start("a", 1);
    await a.acquired;
    const b = start("b", 2, () => a.release());
    const [first, second] = await Promise.all([a.done, b.done]);
    expect(waitingCount).toBeGreaterThanOrEqual(1);
    expect(first.count).toBe(3);
    expect(second.count).toBe(3);
    expect(second.firstRenameAt).toBeGreaterThanOrEqual(first.lastRenameAt);
    expect(second.lastRenameAt).toBeGreaterThanOrEqual(first.lastRenameAt);
    for (const file of ["demo.bin", "demo.ir.json", "assets/a"])
      expect(await readFile(path.join(root, "build", file))).toEqual(Buffer.from([2]));
    await expect(readFile(path.join(root, "build/.kobrixa-build.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    for (const child of children) child.kill();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
