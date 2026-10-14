import type { PluginSource } from "@kobrixa/plugin-runtime";
import basicPlus from "../../../../../plugins/basic-plus/kobrixa-plugin.json" with { type: "json" };

/** Built-in manifests are bundled and validated by the same registry as development plugins. */
export const BUILTIN_PLUGIN_SOURCES: readonly PluginSource[] = [
  { kind: "builtin", manifest: basicPlus },
];
