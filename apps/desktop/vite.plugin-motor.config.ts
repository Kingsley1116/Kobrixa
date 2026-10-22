import { fileURLToPath } from "node:url";
import { builtinPluginConfig } from "./vite.plugin.config.js";
export default builtinPluginConfig({
  slug: "motor-test",
  pluginId: "kobrixa.motor-test",
  sourceRoot: fileURLToPath(new URL("../../plugins/motor-test", import.meta.url)),
});
