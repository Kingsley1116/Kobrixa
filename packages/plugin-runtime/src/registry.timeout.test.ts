import { expect, it, vi } from "vitest";
import { readSource } from "./index.js";

// A folder on a hung network disk: realpath never settles.
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  realpath: vi.fn(() => new Promise(() => {})),
}));

it("gives up on a development folder that does not answer in time", async () => {
  const read = await readSource(
    { kind: "development", directory: "/hung/plugin" },
    { safeMode: false, timeoutMs: 20 },
  );
  expect(read).toMatchObject({ id: "plugin", source: "development" });
  expect(read.problems.map((problem) => problem.code)).toEqual(["PLUGIN_E_SOURCE_TIMEOUT"]);
});
