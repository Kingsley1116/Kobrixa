import { expect, expectTypeOf, it } from "vitest";
import type { CoreActionReference, CoreWindowScope } from "./plugin-ui.js";
import type { CoreActionReference as RuntimeAction } from "@kobrixa/plugin-runtime";
import type { CoreRecoveryPort, PluginUiBridge } from "@kobrixa/plugin-runtime";
import type { PluginsApi } from "./plugins.js";
it("does not manufacture a second core action shape or runtime bridge", async () => {
  expectTypeOf<CoreActionReference>().toEqualTypeOf<RuntimeAction>();
  expectTypeOf<CoreActionReference["scope"]>().toEqualTypeOf<CoreWindowScope>();
  expectTypeOf<PluginsApi["ui"]>().toEqualTypeOf<PluginUiBridge>();
  expectTypeOf<PluginsApi["recovery"]>().toEqualTypeOf<CoreRecoveryPort>();
  expect(Object.keys(await import("./plugin-ui.js"))).toEqual([]);
});
