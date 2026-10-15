import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { compileToMemory } from "./compile-memory.js";
import { testBackend, testFrontend, testProject, minimalIR } from "./test-build.js";
import { diagnostic } from "./diagnostics.js";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-memory-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));
it("compiles a non-rbf main and multiple aux entirely in memory", async () => {
  const backend = testBackend();
  backend.compile = vi.fn(async () => ({
    artifacts: [
      { slot: "program", data: new Uint8Array([1]) },
      { slot: "notes", data: new Uint8Array([2]) },
      { slot: "map", data: new Uint8Array([3]) },
    ],
    diagnostics: [],
  }));
  const result = await compileToMemory(
    testProject(root),
    testFrontend,
    backend,
    new AbortController().signal,
  );
  expect(result.success).toBe(true);
  expect(result.artifacts.map((item) => item.relativePath)).toEqual([
    "demo.bin",
    "demo.txt",
    "demo.map",
    "demo.ir.json",
  ]);
  expect(await readdir(root)).toEqual([]);
});
it("stops on frontend errors, invalid IR, selected-version mismatch and backend errors", async () => {
  const backend = testBackend();
  const compile = vi.spyOn(backend, "compile");
  const project = testProject(root);
  const signal = new AbortController().signal;
  const badFrontend = {
    id: "toy",
    compile: async () => ({ diagnostics: [diagnostic("BUILD9000", "frontend failed")] }),
  };
  expect((await compileToMemory(project, badFrontend, backend, signal)).success).toBe(false);
  const badIR = structuredClone(minimalIR);
  badIR.program.entryFunction = "missing";
  expect(
    (
      await compileToMemory(
        project,
        { id: "toy", compile: async () => ({ ir: badIR, diagnostics: [] }) },
        backend,
        signal,
      )
    ).diagnostics[0]!.code,
  ).toBe("IR1001");
  backend.irVersion = 2;
  expect((await compileToMemory(project, testFrontend, backend, signal)).diagnostics[0]!.code).toBe(
    "BUILD1002",
  );
  expect(compile).not.toHaveBeenCalled();
  backend.irVersion = 1;
  compile.mockResolvedValue({
    artifacts: [],
    diagnostics: [diagnostic("EV39000", "backend failed")],
  });
  expect(await compileToMemory(project, testFrontend, backend, signal)).toMatchObject({
    success: false,
    artifacts: [],
    diagnostics: [expect.objectContaining({ code: "EV39000" })],
  });
});
it("keeps cancellation and never rereads captured simulation resources", async () => {
  const project = testProject(root);
  project.assets = [{ path: "a.txt", absolutePath: path.join(root, "not-present") }];
  project.assetSnapshots = { "a.txt": new Uint8Array([7]) };
  const result = await compileToMemory(
    project,
    testFrontend,
    testBackend(),
    new AbortController().signal,
  );
  expect(result.success).toBe(true);
  expect(result.artifacts.find((item) => item.role === "deploy-asset")!.data).toEqual(
    new Uint8Array([7]),
  );
  const controller = new AbortController();
  controller.abort();
  expect(
    await compileToMemory(project, testFrontend, testBackend(), controller.signal),
  ).toMatchObject({
    success: false,
    artifacts: [],
    diagnostics: [expect.objectContaining({ code: "BUILD0001" })],
  });
});
