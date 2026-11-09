import { readFileSync } from "node:fs";
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  PluginManifest,
  StaticLanguageTokenizerV1,
  StaticLanguageConfigurationV1,
  ValidateStaticLanguageResourcesInput,
  StaticLanguageValidationResult,
} from "@kobrixa/plugin-protocol";
import type { PluginSource } from "./registry.js";

export const toyRoot = new URL(
  "../../plugin-protocol/test-fixtures/static-languages/toy/",
  import.meta.url,
);
export const toyManifest = JSON.parse(
  readFileSync(new URL("kobrixa-plugin.json", toyRoot), "utf8"),
) as PluginManifest;
export const tokenizerText = readFileSync(new URL("language/tokenizer.json", toyRoot), "utf8");
export const configurationText = readFileSync(
  new URL("language/configuration.json", toyRoot),
  "utf8",
);
export const tokenizer = JSON.parse(tokenizerText) as StaticLanguageTokenizerV1;
export const configuration = JSON.parse(configurationText) as StaticLanguageConfigurationV1;

// Deliberately a fixture double, not a second resource validator.
export function acceptFixture(
  input: ValidateStaticLanguageResourcesInput,
): StaticLanguageValidationResult {
  return {
    ok: true,
    tokenizer: input.tokenizer as StaticLanguageTokenizerV1,
    configuration: input.configuration as StaticLanguageConfigurationV1,
    resourceBytes: input.resourceBytes,
    expandedRules: 3,
    rules: 3,
    regexes: 3,
  };
}

export function builtinToy(
  pluginId = "test.toy",
  languageId = "toy",
  extensions = ["toy"],
): Extract<PluginSource, { kind: "builtin" }> {
  const manifest = structuredClone(toyManifest);
  manifest.id = pluginId;
  manifest.runtime = { kind: "builtin" };
  manifest.contributes!.languages![0] = {
    ...manifest.contributes!.languages![0]!,
    id: languageId,
    extensions,
  };
  return {
    kind: "builtin",
    manifest,
    resources: {
      "language/tokenizer.json": tokenizerText,
      "language/configuration.json": configurationText,
    },
  };
}

export async function developmentToy(root: string, name = "toy") {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await cp(toyRoot, directory, { recursive: true });
  return { kind: "development" as const, directory };
}

export async function writeManifest(directory: string, manifest: PluginManifest): Promise<void> {
  await writeFile(path.join(directory, "kobrixa-plugin.json"), JSON.stringify(manifest));
}
