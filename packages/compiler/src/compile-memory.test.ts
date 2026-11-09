import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { compileToMemory } from "./compile-memory.js";
import { testBackend, testFrontend, testProject, minimalIR } from "./test-build.js";
import { diagnostic } from "./diagnostics.js";
import type { Diagnostic } from "./contracts.js";
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

const sources = { frontend: "test.front", backend: "test.back" };
// Unstamped producer output: diagnostic() now adds the core source, so remove it again.
const warning = (code: string) => {
  const rest: Diagnostic = diagnostic(code, code);
  delete rest.source;
  return { ...rest, severity: "warning" as const };
};

it("stamps frontend, IR and backend diagnostics independently", async () => {
  const backend = testBackend();
  const compile = backend.compile.bind(backend);
  backend.compile = async (ir, signal) => ({
    ...(await compile(ir, signal)),
    diagnostics: [warning("EV30001")],
  });
  const frontend = {
    id: "toy",
    compile: async (input: Parameters<typeof testFrontend.compile>[0], signal: AbortSignal) => ({
      ...(await testFrontend.compile(input, signal)),
      diagnostics: [warning("BP0001")],
    }),
  };
  const result = await compileToMemory(
    testProject(root),
    frontend,
    backend,
    new AbortController().signal,
    sources,
  );
  expect(result.diagnostics.map((item) => [item.code, item.source])).toEqual([
    ["BP0001", "test.front"],
    ["EV30001", "test.back"],
  ]);
});
it("reports IR validation failures as core", async () => {
  const badIR = structuredClone(minimalIR);
  badIR.program.entryFunction = "missing";
  const result = await compileToMemory(
    testProject(root),
    { id: "toy", compile: async () => ({ ir: badIR, diagnostics: [] }) },
    testBackend(),
    new AbortController().signal,
    sources,
  );
  expect(result.diagnostics[0]).toMatchObject({ code: "IR1001", source: "kobrixa.core" });
});
it("fails with a core BUILD1007 when a provider forges a source", async () => {
  const forged = {
    id: "toy",
    compile: async () => ({ diagnostics: [{ ...warning("BP0001"), source: "kobrixa.ev3" }] }),
  };
  const result = await compileToMemory(
    testProject(root),
    forged,
    testBackend(),
    new AbortController().signal,
    sources,
  );
  expect(result.success).toBe(false);
  expect(result.diagnostics).toEqual([
    expect.objectContaining({ code: "BUILD1007", source: "kobrixa.core" }),
  ]);
  const backend = testBackend();
  backend.compile = async () => ({
    artifacts: [],
    diagnostics: [{ ...warning("EV30001"), source: "x.y" }],
  });
  const late = await compileToMemory(
    testProject(root),
    testFrontend,
    backend,
    new AbortController().signal,
    sources,
  );
  expect(late.diagnostics.at(-1)).toMatchObject({ code: "BUILD1007", source: "kobrixa.core" });
  expect(late.diagnostics.some((item) => item.source === "x.y")).toBe(false);
});
it("keeps library calls without sources unchanged", async () => {
  const frontend = { id: "toy", compile: async () => ({ diagnostics: [warning("BP0001")] }) };
  const result = await compileToMemory(
    testProject(root),
    frontend,
    testBackend(),
    new AbortController().signal,
  );
  expect(result.diagnostics[0]!.source).toBeUndefined();
});
