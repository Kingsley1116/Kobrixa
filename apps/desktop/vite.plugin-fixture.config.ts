import { fileURLToPath } from "node:url";
import { builtinPluginConfig } from "./vite.plugin.config.js";
import type { UserConfigExport } from "vite";
const config: UserConfigExport = builtinPluginConfig({
  slug: "acceptance-builtin",
  pluginId: "acceptance.ui",
  sourceRoot: fileURLToPath(
    new URL("../../tests/desktop/fixtures/builtin-process", import.meta.url),
  ),
});
export default config;
