import { fileURLToPath } from "node:url";
import { builtinPluginConfig } from "./vite.plugin.config.js";
export default builtinPluginConfig({
  slug: "sensor-lab",
  pluginId: "kobrixa.sensor-lab",
  sourceRoot: fileURLToPath(new URL("../../plugins/sensor-lab", import.meta.url)),
});
