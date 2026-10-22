import { expect, expectTypeOf, it } from "vitest";
import type { CoreActionReference, CoreWindowScope } from "./plugin-ui.js";
import type { CoreActionReference as RuntimeAction } from "@kobrixa/plugin-runtime";
it("does not manufacture a second core action shape or runtime bridge", async () => {
  expectTypeOf<CoreActionReference>().toEqualTypeOf<RuntimeAction>();
  expectTypeOf<CoreActionReference["scope"]>().toEqualTypeOf<CoreWindowScope>();
  expect(Object.keys(await import("./plugin-ui.js"))).toEqual([]);
});
