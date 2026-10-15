import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  BUILD_LIMITS,
  validateArtifacts,
  validateArtifactLayout,
  validateBuildLimits,
} from "./artifacts.js";
import { minimalIR, TEST_BACKEND_DECL, testProject } from "./test-build.js";
import { readBoundedFile } from "./safe-files.js";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-artifacts-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));
const data = new Uint8Array([1]);
const signal = () => new AbortController().signal;
const entry = (relativePath = "x", byteLength = 1) => ({ relativePath, byteLength });
it.each(["ir", "asset"])("rejects reserved backend result slot %s", async (slot) => {
  await expect(
    validateArtifacts(
      testProject(root),
      TEST_BACKEND_DECL,
      {
        artifacts: [
          { slot: "program", data },
          { slot, data },
        ],
        diagnostics: [],
      },
      minimalIR,
      signal(),
    ),
  ).rejects.toThrow("BUILD1003");
});
it.skipIf(process.platform === "win32")("rejects FIFO assets promptly", async (context) => {
  const fifo = path.join(root, "pipe");
  const created = spawnSync("mkfifo", [fifo]);
  if ((created.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    context.skip();
    return;
  }
  expect(created.error).toBeUndefined();
  expect(created.status).toBe(0);
  const project = testProject(root);
  project.assets = [{ path: "pipe", absolutePath: fifo }];
  const pending = validateArtifacts(
    project,
    TEST_BACKEND_DECL,
    { artifacts: [{ slot: "program", data }], diagnostics: [] },
    minimalIR,
    signal(),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await expect(
      Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("FIFO read timed out after 2 s")), 2000);
        }),
      ]),
    ).rejects.toThrow("BUILD1003");
  } finally {
    clearTimeout(timer);
    // Release a blocked reader on regression so the test process can exit.
    const rescue = await open(fifo, constants.O_RDWR | constants.O_NONBLOCK);
    await pending.catch(() => undefined);
    await rescue.close();
  }
});
it("accepts every numeric limit exactly and rejects one beyond", () => {
  expect(BUILD_LIMITS).toEqual({
    backendArtifacts: 64,
    artifacts: 1024,
    artifactBytes: 64 * 1024 * 1024,
    totalBytes: 256 * 1024 * 1024,
    filenameBytes: 128,
    relativePathBytes: 512,
  });
  expect(() => validateBuildLimits(64, [entry()])).not.toThrow();
  expect(() => validateBuildLimits(65, [entry()])).toThrow("BUILD1003");
  expect(() =>
    validateBuildLimits(
      0,
      Array.from({ length: 1024 }, (_, i) => entry(`f${i}`)),
    ),
  ).not.toThrow();
  expect(() =>
    validateBuildLimits(
      0,
      Array.from({ length: 1025 }, (_, i) => entry(`f${i}`)),
    ),
  ).toThrow("BUILD1003");
  expect(() => validateBuildLimits(1, [entry("a", 64 * 1024 * 1024)])).not.toThrow();
  expect(() => validateBuildLimits(1, [entry("a", 64 * 1024 * 1024 + 1)])).toThrow("BUILD1003");
  const maximum = Array.from({ length: 4 }, (_, i) => entry(`a${i}`, 64 * 1024 * 1024));
  expect(() => validateBuildLimits(4, maximum)).not.toThrow();
  expect(() => validateBuildLimits(4, [...maximum, entry("extra")])).toThrow("BUILD1003");
  expect(() => validateBuildLimits(1, [entry("é".repeat(64))])).not.toThrow();
  expect(() => validateBuildLimits(1, [entry("é".repeat(64) + "x")])).toThrow("BUILD1003");
  const exactPath = ["a".repeat(127), "b".repeat(127), "c".repeat(127), "d".repeat(128)].join("/");
  expect(Buffer.byteLength(exactPath)).toBe(512);
  expect(() => validateBuildLimits(1, [entry(exactPath)])).not.toThrow();
  expect(() => validateBuildLimits(1, [entry("x/" + exactPath)])).toThrow("BUILD1003");
});
it.each(
  [
    [{ slot: "unknown", data }],
    [
      { slot: "program", data },
      { slot: "program", data },
    ],
    [],
    [{ slot: "program", data: new Uint8Array() }],
  ].map((artifacts) => ({ artifacts })),
)("rejects undeclared, duplicate, missing or empty-main slots (%#)", async ({ artifacts }) => {
  await expect(
    validateArtifacts(
      testProject(root),
      TEST_BACKEND_DECL,
      { artifacts, diagnostics: [] },
      minimalIR,
      signal(),
    ),
  ).rejects.toThrow("BUILD1003");
});
it("rejects NFC case collisions, reserved paths and file-directory conflicts", () => {
  for (const paths of [
    ["assets/É.txt", "assets/e\u0301.TXT"],
    [".kobrixa-build.lock"],
    ["assets/.KOBRIXA-other"],
    ["assets/a", "assets/A/b"],
    ["demo.bin", "DEMO.BIN"],
  ])
    expect(() => validateArtifactLayout(paths.map((relativePath) => ({ relativePath })))).toThrow(
      "BUILD1003",
    );
  expect(() =>
    validateArtifactLayout([
      { relativePath: "demo.bin" },
      { relativePath: "assets/demo.bin", remotePath: "DEMO.BIN" },
    ]),
  ).toThrow("BUILD1003");
});
it("rejects asset symlinks and traversal before output exists", async () => {
  await writeFile(path.join(root, "real.txt"), "safe");
  await symlink(path.join(root, "real.txt"), path.join(root, "link.txt"));
  await mkdir(path.join(root, "folder"));
  await writeFile(path.join(root, "folder/x.txt"), "safe");
  await symlink(path.join(root, "folder"), path.join(root, "linked"), "dir");
  for (const relative of [
    "link.txt",
    "linked/x.txt",
    "../outside",
    "/absolute",
    "C:\\outside",
    "a/../real.txt",
  ]) {
    const project = testProject(root);
    project.assets = [{ path: relative, absolutePath: path.resolve(root, relative) }];
    await expect(
      validateArtifacts(
        project,
        TEST_BACKEND_DECL,
        { artifacts: [{ slot: "program", data }], diagnostics: [] },
        minimalIR,
        signal(),
      ),
    ).rejects.toThrow("BUILD1003");
  }
});
it("owns metadata, snapshots backend bytes and accepts optional aux absence", async () => {
  const bytes = new Uint8Array([9]);
  const result = await validateArtifacts(
    testProject(root),
    TEST_BACKEND_DECL,
    { artifacts: [{ slot: "program", data: bytes }], diagnostics: [] },
    minimalIR,
    signal(),
  );
  bytes[0] = 0;
  expect(result.map((item) => [item.slot, item.role, item.relativePath])).toEqual([
    ["program", "deploy-main", "demo.bin"],
    ["ir", "aux", "demo.ir.json"],
  ]);
  expect(result[0]!.data[0]).toBe(9);
});
it("rejects declared filename collisions and counts host IR and resources", async () => {
  const declaration = structuredClone(TEST_BACKEND_DECL);
  declaration.artifacts[1]!.extension = "bin";
  await expect(
    validateArtifacts(
      testProject(root),
      declaration,
      {
        artifacts: [
          { slot: "program", data },
          { slot: "notes", data },
        ],
        diagnostics: [],
      },
      minimalIR,
      signal(),
    ),
  ).rejects.toThrow("BUILD1003");
  await writeFile(path.join(root, "a.txt"), "asset");
  const project = testProject(root);
  project.assets = [{ path: "a.txt", absolutePath: path.join(root, "a.txt") }];
  const result = await validateArtifacts(
    project,
    TEST_BACKEND_DECL,
    { artifacts: [{ slot: "program", data }], diagnostics: [] },
    minimalIR,
    signal(),
  );
  expect(result).toHaveLength(3);
  expect(result[2]).toMatchObject({
    slot: "asset",
    role: "deploy-asset",
    relativePath: "assets/a.txt",
    remotePath: "a.txt",
  });
});

it("bounds real reads at the remaining budget without allocating a huge fixture", async () => {
  const file = await open(path.join(root, "large.bin"), "w");
  await file.truncate(64 * 1024 * 1024 + 1);
  await file.close();
  await expect(readBoundedFile(root, "large.bin", 64 * 1024 * 1024, signal())).rejects.toThrow(
    "BUILD1003",
  );
  await writeFile(path.join(root, "small.bin"), new Uint8Array([1, 2, 3, 4]));
  expect(await readBoundedFile(root, "small.bin", 4, signal())).toEqual(Buffer.from([1, 2, 3, 4]));
  await expect(readBoundedFile(root, "small.bin", 3, signal())).rejects.toThrow("BUILD1003");
});
