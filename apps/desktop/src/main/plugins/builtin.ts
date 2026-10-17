import type { PluginSource } from "@kobrixa/plugin-runtime";
import basicPlus from "../../../../../plugins/basic-plus/kobrixa-plugin.json" with { type: "json" };
import tokenizer from "../../../../../plugins/basic-plus/language/tokenizer.json?raw";
import configuration from "../../../../../plugins/basic-plus/language/configuration.json?raw";
import ev3 from "../../../../../plugins/ev3/kobrixa-plugin.json" with { type: "json" };

/** Built-in manifests and raw resources are bundled; the registry validates both. */
export const BUILTIN_PLUGIN_SOURCES: readonly PluginSource[] = [
  {
    kind: "builtin",
    manifest: basicPlus,
    resources: {
      "language/tokenizer.json": tokenizer,
      "language/configuration.json": configuration,
    },
  },
  { kind: "builtin", manifest: ev3, resources: {} },
];
