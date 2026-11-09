import { readFile } from "node:fs/promises";
import { expect, expectTypeOf, it } from "vitest";
import {
  PLUGIN_API_VERSION,
  STATIC_LANGUAGE_FORMAT_VERSION,
  STATIC_LANGUAGE_LIMITS_V1,
  pluginManifestSchema,
  validateStaticLanguageResources,
  type PluginManifest,
  type StaticRuntime,
  type StaticLanguageDecl,
  type ValidateStaticLanguageResourcesInput,
  type StaticLanguageValidationResult,
} from "./index.js";

it("freezes the public types, strict static variant and immutable v1 limits", async () => {
  expect(PLUGIN_API_VERSION).toBe("1.4.0");
  expect(STATIC_LANGUAGE_FORMAT_VERSION).toBe(1);
  expect(STATIC_LANGUAGE_LIMITS_V1).toEqual({
    patternLength: 2048,
    compiledPatternLength: 4096,
    rulesPerLanguage: 1024,
    regexesPerLanguage: 1024,
    statesPerLanguage: 64,
    resourceFileBytes: 524288,
    resourceBytesPerLanguage: 786432,
    resourceBytesPerPlugin: 1048576,
    resourceBytesTotal: 8388608,
    expandedRulesPerLanguage: 8192,
    expandedRulesTotal: 65536,
    includeDepth: 16,
    regexFlags: ["", "i"],
    listsPerLanguage: 32,
    wordsPerLanguage: 4096,
    casesPerRule: 32,
    onEnterRules: 32,
    languagesPerPlugin: 8,
    languagesTotal: 128,
    sessionLanguageIds: 256,
    maxTokenizationLineLength: 10000,
  });
  expect(Object.isFrozen(STATIC_LANGUAGE_LIMITS_V1)).toBe(true);
  expect(Object.isFrozen(STATIC_LANGUAGE_LIMITS_V1.regexFlags)).toBe(true);
  expectTypeOf<StaticRuntime>().toEqualTypeOf<{ kind: "static" }>();
  expectTypeOf<NonNullable<PluginManifest["contributes"]>["languages"]>().toEqualTypeOf<
    StaticLanguageDecl[] | undefined
  >();
  expectTypeOf(validateStaticLanguageResources).toEqualTypeOf<
    (input: ValidateStaticLanguageResourcesInput) => StaticLanguageValidationResult
  >();
  const fixture: unknown = JSON.parse(
    await readFile(
      new URL("../test-fixtures/static-languages/toy/kobrixa-plugin.json", import.meta.url),
      "utf8",
    ),
  );
  const manifest = pluginManifestSchema.parse(fixture);
  expect(manifest.runtime).toEqual({ kind: "static" });
  expect(manifest.contributes?.languages?.[0]?.id).toBe("toy");
  expect(
    pluginManifestSchema.safeParse({
      ...manifest,
      runtime: { kind: "static", entry: "main.js" },
    }).success,
  ).toBe(false);
});
