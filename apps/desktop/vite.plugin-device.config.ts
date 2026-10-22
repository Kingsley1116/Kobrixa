import { fileURLToPath } from "node:url";
import { builtinPluginConfig } from "./vite.plugin.config.js";
export default builtinPluginConfig({
  slug: "device-ev3",
  pluginId: "kobrixa.device-ev3",
  sourceRoot: fileURLToPath(new URL("../../plugins/device-ev3", import.meta.url)),
});
