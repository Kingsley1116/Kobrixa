import { expect, it } from "vitest";
import { loadPlugins } from "@kobrixa/plugin-runtime";
import { BUILTIN_FRONTENDS } from "../workspace/builtin-frontends.js";
import { BUILTIN_PLUGIN_SOURCES } from "./builtin.js";

it("registers Basic Plus as a valid built-in frontend with an implementation", async () => {
  const plugins = await loadPlugins(BUILTIN_PLUGIN_SOURCES, {
    disabled: new Set(),
    safeMode: true,
  });
  expect(plugins.map((plugin) => [plugin.id, plugin.status])).toEqual([
    ["kobrixa.basic-plus", "enabled"],
  ]);
  for (const plugin of plugins) expect(BUILTIN_FRONTENDS[plugin.id]).toBeTypeOf("function");
});
