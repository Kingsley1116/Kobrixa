import { fileURLToPath } from "node:url";
import { builtinPluginConfig } from "./vite.plugin.config.js";
import type { UserConfigExport } from "vite";
const config: UserConfigExport = builtinPluginConfig({
  slug: "motor-test",
  pluginId: "kobrixa.motor-test",
  sourceRoot: fileURLToPath(
    new URL("../../tests/desktop/fixtures/builtin-process", import.meta.url),
  ),
});
export default config;
