import { pluginManifestSchema } from "@kobrixa/plugin-protocol";
import {
  resolvePlugins,
  resolveLanguageService,
  type LanguageServiceResolution,
} from "@kobrixa/plugin-runtime";
import { BUILTIN_PLUGIN_SOURCES } from "../plugins/builtin.js";
export function resolveBuiltinLanguageService(language: string): LanguageServiceResolution {
  const plugins = resolvePlugins(
    BUILTIN_PLUGIN_SOURCES.map((source) => {
      if (source.kind !== "builtin") throw new Error("Built-in sources only.");
      const manifest = pluginManifestSchema.parse(source.manifest);
      return {
        id: manifest.id,
        sourceKey: `builtin:${manifest.id}`,
        source: "builtin" as const,
        problems: [],
        manifest,
      };
    }),
    { safeMode: false, disabled: new Set() },
  );
  return resolveLanguageService(plugins, language);
}
