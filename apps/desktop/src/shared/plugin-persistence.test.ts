import { expect, expectTypeOf, it } from "vitest";
import type { DrainReport } from "./plugin-persistence.js";
import type { DrainReport as RuntimeReport } from "@kobrixa/plugin-runtime";
it("keeps the sole persistence participant report type without publishing runtime API", async () => {
  expectTypeOf<DrainReport>().toEqualTypeOf<RuntimeReport>();
  expect(Object.keys(await import("./plugin-persistence.js"))).toEqual([]);
});
