import { readFile } from "node:fs/promises";
import { PluginManager } from "../../packages/plugin-runtime/dist/index.js";

export async function basicPlusSmokeCatalog() {
  const base = new URL("../../plugins/basic-plus/", import.meta.url);
  const manager = await PluginManager.create({
    sources: [
      {
        kind: "builtin",
        policy: "required",
        manifest: JSON.parse(await readFile(new URL("kobrixa-plugin.json", base), "utf8")),
        resources: {
          "language/tokenizer.json": await readFile(
            new URL("language/tokenizer.json", base),
            "utf8",
          ),
          "language/configuration.json": await readFile(
            new URL("language/configuration.json", base),
            "utf8",
          ),
        },
      },
    ],
    store: {
      load: async () => ({ disabled: new Set(), legacyDisabledIds: new Set() }),
      save: async () => {},
    },
    safeMode: false,
    locale: "en",
    launcher: async () => {
      throw new Error("Unexpected static launch");
    },
  });
  try {
    const catalog = manager.staticLanguages();
    if (!catalog.languages.some((language) => language.id === "bp"))
      throw new Error("Missing Basic Plus catalog");
    return catalog;
  } finally {
    await manager.shutdown();
  }
}

export function createStaticLanguagesHarness(catalog) {
  const value = structuredClone(catalog);
  return {
    state: () => ({
      revision: 0,
      diagnosticHelpRevision: 0,
      staticLanguagesRevision: value.revision,
      staticLanguageOwners: value.languages.map((language) => ({
        sourceKey: language.sourceKey,
        pluginId: language.pluginId,
        generation: language.generation,
        languageId: language.id,
        extensions: [...language.extensions],
      })),
      safeMode: false,
      developmentMode: false,
      plugins: [],
      developer: { enabled: false, commandLine: false, linkedCount: 0 },
      origins: {},
      python: { pendingReload: [] },
      inflight: [],
    }),
    staticLanguages: () => structuredClone(value),
    reportLanguageRegistrationFailure: () => ({ accepted: false, revision: value.revision }),
  };
}
