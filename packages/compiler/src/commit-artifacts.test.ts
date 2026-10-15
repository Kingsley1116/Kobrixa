import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { commitArtifacts } from "./commit-artifacts.js";
import { BuildSession } from "./build-session.js";
import type { MemoryArtifact } from "./contracts.js";
import { testBackend, testFrontend, testProject } from "./test-build.js";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-commit-"));
  await mkdir(path.join(root, "build"));
});
afterEach(() => rm(root, { recursive: true, force: true }));
function entries(): MemoryArtifact[] {
  return [
    {
      slot: "program",
      kind: "toy",
      role: "deploy-main",
      mediaType: "application/octet-stream",
      relativePath: "demo.bin",
      data: new Uint8Array([3]),
    },
    {
      slot: "asset",
      kind: "asset",
      role: "deploy-asset",
      mediaType: "application/octet-stream",
      relativePath: "assets/a",
      remotePath: "a",
      data: new Uint8Array([2]),
    },
    {
      slot: "ir",
      kind: "ir",
      role: "aux",
      mediaType: "application/json",
      relativePath: "demo.ir.json",
      data: new Uint8Array([1]),
    },
  ];
}
it("validates all staging bytes before replacing aux then assets then main", async () => {
  const order: string[] = [];
  const artifacts = await commitArtifacts(
    testProject(root),
    "order",
    entries(),
    new AbortController().signal,
    {
      io: {
        write: (file, bytes) => writeFile(file, bytes),
        rename: async (from, to) => {
          order.push(path.relative(path.join(root, "build"), to));
          await rename(from, to);
        },
      },
    },
  );
  expect(order).toEqual(["demo.ir.json", "assets/a", "demo.bin"]);
  expect(artifacts.map((item) => item.byteLength)).toEqual([1, 1, 1]);
  expect(artifacts.every((item) => /^[a-f0-9]{64}$/.test(item.sha256))).toBe(true);
  expect(
    (await readdir(path.join(root, "build"))).filter((name) => name.startsWith(".kobrixa")),
  ).toEqual([]);
});
it("cancels at the last checkpoint and finishes after the first rename", async () => {
  await writeFile(path.join(root, "build/demo.bin"), "old");
  const before = new AbortController();
  await expect(
    commitArtifacts(testProject(root), "before", entries(), before.signal, {
      beforeRename: (index) => {
        if (index === 0) before.abort();
      },
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(await readFile(path.join(root, "build/demo.bin"), "utf8")).toBe("old");
  const after = new AbortController();
  const committed = await commitArtifacts(testProject(root), "after", entries(), after.signal, {
    beforeRename: (index) => {
      if (index === 1) after.abort();
    },
  });
  expect(committed).toHaveLength(3);
  expect(await readFile(path.join(root, "build/demo.bin"))).toEqual(Buffer.from([3]));
});
it("keeps final files on staging failure and returns no artifacts on rename failure", async () => {
  await writeFile(path.join(root, "build/demo.bin"), "old");
  await expect(
    commitArtifacts(testProject(root), "write-fail", entries(), new AbortController().signal, {
      io: {
        write: async () => {
          throw new Error("disk full");
        },
        rename,
      },
    }),
  ).rejects.toThrow("BUILD9000");
  expect(await readFile(path.join(root, "build/demo.bin"), "utf8")).toBe("old");
  let renamed = 0;
  await expect(
    commitArtifacts(testProject(root), "rename-fail", entries(), new AbortController().signal, {
      io: {
        write: (file, bytes) => writeFile(file, bytes),
        rename: async (from, to) => {
          if (++renamed === 2) throw new Error("I/O failure");
          await rename(from, to);
        },
      },
    }),
  ).rejects.toThrow("BUILD9000");
  // 同一個注入經 BuildSession 路徑，確實測到提交 I/O 失敗而非後端失敗。
  let sessionRenames = 0;
  const session = new BuildSession(
    testFrontend,
    testBackend(),
    undefined,
    undefined,
    "session-fail",
    {
      io: {
        write: (file, bytes) => writeFile(file, bytes),
        rename: async (from, to) => {
          if (++sessionRenames === 2) throw new Error("session rename failure");
          await rename(from, to);
        },
      },
    },
  );
  expect(await session.compile(testProject(root))).toMatchObject({
    success: false,
    artifacts: [],
    diagnostics: [expect.objectContaining({ code: "BUILD9000" })],
  });
  expect(sessionRenames).toBe(2);
});
it("returns BUILD1004 with no final changes when commit lock acquisition times out", async () => {
  const output = path.join(root, "build");
  await writeFile(path.join(output, "demo.bin"), "old");
  const held = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
  await writeFile(path.join(output, ".kobrixa-build.lock"), held);
  let now = Date.now();
  const session = new BuildSession(testFrontend, testBackend(), undefined, undefined, "locked", {
    lock: {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      pidAlive: () => true,
    },
  });
  expect(await session.compile(testProject(root))).toMatchObject({
    success: false,
    artifacts: [],
    diagnostics: [expect.objectContaining({ code: "BUILD1004" })],
  });
  expect(await readFile(path.join(output, "demo.bin"), "utf8")).toBe("old");
  expect(await readFile(path.join(output, ".kobrixa-build.lock"), "utf8")).toBe(held);
  expect((await readdir(output)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});
it("rejects corrupted staging bytes before any final rename", async () => {
  await writeFile(path.join(root, "build/demo.bin"), "old");
  await expect(
    commitArtifacts(testProject(root), "corrupt", entries(), new AbortController().signal, {
      io: {
        write: (file) => writeFile(file, new Uint8Array([99])),
        rename: async () => {
          throw new Error("must not rename");
        },
      },
    }),
  ).rejects.toThrow("BUILD1003");
  expect(await readFile(path.join(root, "build/demo.bin"), "utf8")).toBe("old");
});

it("returns BUILD0001 when cancelled during artifact validation", async () => {
  const controller = new AbortController();
  const session = new BuildSession(testFrontend, testBackend(), undefined, controller);
  const project = testProject(root);
  let assetReads = 0;
  Object.defineProperty(project, "assets", {
    get() {
      assetReads++;
      session.cancel();
      return [{ path: "resource.dat", absolutePath: path.join(root, "resource.dat") }];
    },
  });
  expect(await session.compile(project)).toMatchObject({
    success: false,
    artifacts: [],
    diagnostics: [expect.objectContaining({ code: "BUILD0001" })],
  });
  expect(assetReads).toBe(1);
  expect(controller.signal.reason).toMatchObject({ name: "AbortError" });
  expect(await readdir(path.join(root, "build"))).toEqual([]);
});
