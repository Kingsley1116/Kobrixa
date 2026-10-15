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
  const create = () => ({ frontend: testFrontend, backend });
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
  const create = () => ({ frontend: testFrontend, backend: testBackend() });
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
