import { createHash } from "node:crypto";
import { readStaticLanguageFixtures } from "./static-languages-fixtures.mjs";

export async function basicPlusSmokeCatalog() {
  const { basicPlusTokenizer, basicPlusConfiguration } = await readStaticLanguageFixtures();
  return {
    formatVersion: 1,
    limitsVersion: 1,
    revision: 1,
    languages: [
      {
        sourceKey: "builtin:kobrixa.basic-plus",
        pluginId: "kobrixa.basic-plus",
        generation: 1,
        id: "bp",
        extensions: ["bp", "bpi", "bpm"],
        aliases: ["Basic Plus", "Basic+"],
        resourceDigest: createHash("sha256")
          .update(basicPlusTokenizer)
          .update("\0")
          .update(basicPlusConfiguration)
          .digest("hex"),
        tokenizer: JSON.parse(basicPlusTokenizer),
        configuration: JSON.parse(basicPlusConfiguration),
        resourceBytes: {
          tokenizer: Buffer.byteLength(basicPlusTokenizer),
          configuration: Buffer.byteLength(basicPlusConfiguration),
        },
        expandedRules: 9,
      },
    ],
    extensionRoutes: { bp: "bp", bpi: "bp", bpm: "bp" },
    conflicts: [],
  };
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
