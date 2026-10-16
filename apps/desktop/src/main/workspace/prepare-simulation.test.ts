import { expect, it, vi } from "vitest";
import type { CompilerSnapshot } from "@kobrixa/plugin-runtime";
import { prepareSimulation } from "./prepare-simulation.js";
import {
  testBackend,
  testFrontend,
  testProject,
  TEST_BACKEND_DECL,
} from "../../../../../packages/compiler/src/test-build.js";
const declaration = {
  language: "toy",
  entryExtensions: ["toy"],
  sourceExtensions: ["toy", "inc"],
  ir: { min: 1, max: 1 },
};
const snapshot: CompilerSnapshot = {
  ok: true,
  ir: 1,
  frontend: { pluginId: "test.front", sourceKey: "builtin:test.front", contribution: declaration },
  backend: {
    pluginId: "test.back",
    sourceKey: "builtin:test.back",
    contribution: TEST_BACKEND_DECL,
  },
};
it("requires backend success for all four simulation entries", async () => {
  const project = testProject("/unused");
  const entries = ["a.toy", "b.toy", "c.toy", "d.toy"];
  project.sources = entries.map((path) => ({ path, content: "test" }));
  const backend = testBackend();
  const compile = vi.spyOn(backend, "compile");
  const create = () => ({
    frontend: testFrontend,
    backend,
    sources: { frontend: "test.front", backend: "test.back" },
  });
  const result = await prepareSimulation(
    project,
    entries,
    {},
    new AbortController().signal,
    snapshot,
    create,
  );
  expect(result.success).toBe(true);
  expect(compile).toHaveBeenCalledTimes(4);
  compile.mockResolvedValueOnce({ artifacts: [], diagnostics: [] });
  expect(
    await prepareSimulation(project, entries, {}, new AbortController().signal, snapshot, create),
  ).toMatchObject({
    success: false,
    diagnostics: [expect.objectContaining({ code: "BUILD1003" })],
  });
  expect(
    (
      await prepareSimulation(
        project,
        [...entries, "a.toy"],
        {},
        new AbortController().signal,
        snapshot,
        create,
      )
    ).success,
  ).toBe(false);
});
it("keeps 64 resources and 1 MiB inclusive and rejects overflow", async () => {
  const project = testProject("/unused");
  const files = Object.fromEntries(
    Array.from({ length: 64 }, (_, i) => [`a${i}`, Array(16 * 1024).fill(1)]),
  );
  project.assets = Object.keys(files).map((path) => ({ path, absolutePath: "/not-read" }));
  const create = () => ({
    frontend: testFrontend,
    backend: testBackend(),
    sources: { frontend: "test.front", backend: "test.back" },
  });
  expect(
    (
      await prepareSimulation(
        project,
        ["main.toy"],
        files,
        new AbortController().signal,
        snapshot,
        create,
      )
    ).success,
  ).toBe(true);
  expect(
    (
      await prepareSimulation(
        project,
        ["main.toy"],
        { ...files, extra: [] },
        new AbortController().signal,
        snapshot,
        create,
      )
    ).success,
  ).toBe(false);
  files.a0!.push(1);
  expect(
    (
      await prepareSimulation(
        project,
        ["main.toy"],
        files,
        new AbortController().signal,
        snapshot,
        create,
      )
    ).success,
  ).toBe(false);
});

it("stamps frontend diagnostics with the snapshot provider and SIM1001 with core", async () => {
  const project = testProject("/unused");
  project.sources = [{ path: "a.toy", content: "test" }];
  const warn = {
    code: "TOY1",
    severity: "warning" as const,
    file: "a.toy",
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
    message: "w",
  };
  const frontend = {
    id: "toy",
    compile: async (input: Parameters<typeof testFrontend.compile>[0], signal: AbortSignal) => ({
      ...(await testFrontend.compile(input, signal)),
      diagnostics: [warn],
    }),
  };
  const create = () => ({
    frontend,
    backend: testBackend(),
    sources: { frontend: snapshot.frontend.pluginId, backend: snapshot.backend.pluginId },
  });
  const signal = new AbortController().signal;
  const ok = await prepareSimulation(project, ["a.toy"], {}, signal, snapshot, create);
  expect(ok.diagnostics).toEqual([expect.objectContaining({ code: "TOY1", source: "test.front" })]);
  const missing = await prepareSimulation(project, ["missing.toy"], {}, signal, snapshot, create);
  expect(missing.diagnostics).toEqual([
    expect.objectContaining({ code: "SIM1001", source: "kobrixa.core" }),
  ]);
});
