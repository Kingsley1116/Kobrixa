import { SourceReadBudget } from "./packaged-json-resource.js";
import type * as Protocol from "@kobrixa/plugin-protocol";
import { expect, it, vi } from "vitest";
import {
  STATIC_LANGUAGE_LIMITS_V1 as L,
  staticLanguageDeclarationProblems,
  validateStaticLanguageResources,
  type PluginManifest,
} from "@kobrixa/plugin-protocol";
import { readSource, resolvePlugins, type PluginSource } from "./registry.js";
import { buildStaticLanguageCatalog } from "./static-language-catalog.js";
import { acceptFixture, builtinToy } from "./test-static-languages.js";

vi.mock("@kobrixa/plugin-protocol", async (importOriginal) => ({
  ...(await importOriginal<typeof Protocol>()),
  staticLanguageDeclarationProblems: vi.fn(() => []),
  validateStaticLanguageResources: vi.fn((input) => acceptFixture(input)),
}));

async function build(sources: PluginSource[], disabled = new Set<string>()) {
  const reads = await Promise.all(sources.map((source) => readSource(source, { safeMode: false })));
  const resolved = resolvePlugins(reads, { disabled, safeMode: false });
  return buildStaticLanguageCatalog(
    sources.map((source, i) => ({ source, plugin: resolved[i]!, generation: 0 })),
    new Set(),
  );
}

it("retains frontend reservation after resource failure in either source order", async () => {
  const owner = builtinToy("test.owner", "bp", ["bp"]);
  const manifest = owner.manifest as PluginManifest;
  manifest.contributes!.frontends = [
    {
      language: "bp",
      entryExtensions: ["bp"],
      sourceExtensions: ["bp"],
      ir: { min: 1, max: 1 },
    },
  ];
  manifest.contributes!.languageServices = [
    { language: "bp", extensions: ["bp"], capabilities: ["analysis"] },
  ];
  owner.resources = {};
  const impostor = builtinToy("test.impostor", "bp", ["bp"]);
  const other = builtinToy("test.other", "other", ["bp"]);
  for (const order of [
    [owner, impostor, other],
    [other, impostor, owner],
  ]) {
    const result = await build(order);
    expect(result.catalog.languages.map((language) => language.id)).toEqual(["other"]);
    expect(result.catalog.conflicts).toContainEqual({
      kind: "frontend-owner",
      key: "bp",
      sources: [
        { pluginId: "test.impostor", sourceKey: "builtin:test.impostor", languageId: "bp" },
        { pluginId: "test.owner", sourceKey: "builtin:test.owner", languageId: "bp" },
      ],
    });
    expect(result.problems.get("builtin:test.owner")).toContainEqual(
      expect.objectContaining({
        code: "PLUGIN_E_STATIC_LANGUAGE",
        detail: expect.objectContaining({ languageId: "bp" }),
      }),
    );
    // The foreign /bp global route is retained, but there is no static record matching
    // the selected owner. T4/T8 prove its applicable binding therefore falls to plaintext.
    expect(result.catalog.languages.some((language) => language.pluginId === "test.owner")).toBe(
      false,
    );
  }
});

it("resolves id conflicts from declarations, even when one resource is missing", async () => {
  const a = builtinToy("test.a");
  const b = builtinToy("test.b");
  b.resources = {};
  for (const order of [
    [a, b],
    [b, a],
  ]) {
    const result = await build(order);
    expect(result.catalog.languages).toEqual([]);
    expect(result.catalog.conflicts).toEqual([
      {
        kind: "id",
        key: "toy",
        sources: [
          { pluginId: "test.a", sourceKey: "builtin:test.a", languageId: "toy" },
          { pluginId: "test.b", sourceKey: "builtin:test.b", languageId: "toy" },
        ],
      },
    ]);
  }
});

it("keeps both owners and unique routes when extensions are ambiguous", async () => {
  const a = builtinToy("test.a", "toy-a", ["toy", "ta"]);
  const b = builtinToy("test.b", "toy-b", ["toy", "tb"]);
  const first = await build([a, b]);
  const reversed = await build([b, a]);
  expect(reversed.catalog).toEqual(first.catalog);
  expect(first.catalog.languages).toHaveLength(2);
  expect(first.catalog.extensionRoutes).toEqual({ toy: null, ta: "toy-a", tb: "toy-b" });
  expect(first.catalog.conflicts[0]?.sources).toHaveLength(2);
});

it("reserves installed core ids and only removes the reserved json extension", async () => {
  const result = await build([
    builtinToy("test.json", "json"),
    builtinToy("test.plain", "plaintext"),
    builtinToy("test.js", "javascript"),
    builtinToy("test.good", "toy", ["json", "toy"]),
  ]);
  expect(result.catalog.languages.map((language) => language.id)).toEqual(["toy"]);
  expect(result.catalog.extensionRoutes).toEqual({ toy: "toy" });
  expect(result.catalog.conflicts.map(({ kind, key }) => [kind, key])).toEqual([
    ["reserved-extension", "json"],
    ["reserved-id", "javascript"],
    ["reserved-id", "json"],
    ["reserved-id", "plaintext"],
  ]);
});

it("uses exact raw keys, stable byte digests, and host identity", async () => {
  const source = builtinToy();
  const first = await build([source]);
  const language = first.catalog.languages[0]!;
  expect(language).toMatchObject({
    pluginId: "test.toy",
    sourceKey: "builtin:test.toy",
    generation: 0,
    aliases: ["Toy"],
  });
  expect(language).not.toHaveProperty("directory");
  expect(language.resourceBytes.tokenizer).toBe(
    Buffer.byteLength(source.resources["language/tokenizer.json"]!),
  );
  source.resources = {
    ...source.resources,
    "language/tokenizer.json": source.resources["language/tokenizer.json"]! + " ",
  };
  expect((await build([source])).catalog.languages[0]!.resourceDigest).not.toBe(
    language.resourceDigest,
  );
  source.resources = { "unreferenced.json": "{}" };
  expect((await build([source])).catalog.languages).toEqual([]);
});

it("preserves validator field/limit detail and contains resource failures", async () => {
  vi.mocked(validateStaticLanguageResources).mockReturnValueOnce({
    ok: false,
    problems: [
      {
        message: "Include cycle: root -> child -> root.",
        detail: {
          languageId: "toy",
          resourcePath: "language/tokenizer.json",
          fieldPath: "states[0].rules[0].include",
        },
      },
    ],
  });
  const result = await build([builtinToy()]);
  expect(result.problems.get("builtin:test.toy")?.[0]).toMatchObject({
    code: "PLUGIN_E_STATIC_LANGUAGE",
    message: expect.stringContaining("test.toy"),
    detail: {
      languageId: "toy",
      resourcePath: "language/tokenizer.json",
      fieldPath: "states[0].rules[0].include",
    },
  });
  expect(result.catalog.languages).toEqual([]);
  expect(vi.mocked(staticLanguageDeclarationProblems)).toHaveBeenCalled();
});

it("counts repeated resource references, rejects an over-budget language and continues", async () => {
  const source = builtinToy();
  const manifest = source.manifest as PluginManifest;
  const declaration = manifest.contributes!.languages![0]!;
  manifest.contributes!.languages = ["a", "b", "c"].map((id) => ({
    ...declaration,
    id,
    extensions: [id],
  }));
  source.resources = {
    "language/tokenizer.json": JSON.stringify({}) + " ".repeat(L.resourceFileBytes - 2),
    "language/configuration.json": "{}",
  };
  const result = await build([source]);
  expect(result.catalog.languages.map((language) => language.id)).toEqual(["a"]);
  expect(result.problems.get("builtin:test.toy")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        detail: expect.objectContaining({
          languageId: "b",
          limit: "STATIC_LANGUAGE_LIMITS_V1.resourceBytesPerPlugin",
          allowed: L.resourceBytesPerPlugin,
          actual: (L.resourceFileBytes + 2) * 2,
        }),
      }),
    ]),
  );
});

it("enforces the exact per-language, global byte, id and expanded-rule boundaries", async () => {
  const padded = (bytes: number) => "{}" + " ".repeat(bytes - 2);
  const pair = builtinToy();
  pair.resources = {
    "language/tokenizer.json": padded(L.resourceFileBytes),
    "language/configuration.json": padded(L.resourceBytesPerLanguage - L.resourceFileBytes),
  };
  expect((await build([pair])).catalog.languages).toHaveLength(1);
  pair.resources = {
    ...pair.resources,
    "language/configuration.json": pair.resources["language/configuration.json"]! + " ",
  };
  expect((await build([pair])).problems.get("builtin:test.toy")?.[0]?.detail).toMatchObject({
    limit: "STATIC_LANGUAGE_LIMITS_V1.resourceBytesPerLanguage",
    allowed: L.resourceBytesPerLanguage,
    actual: L.resourceBytesPerLanguage + 1,
  });
  const sources = Array.from({ length: 17 }, (_, i) => {
    const source = builtinToy(`test.p${String(i).padStart(3, "0")}`, `lang${i}`, [`x${i}`]);
    source.resources = {
      "language/tokenizer.json": padded(L.resourceFileBytes - 2),
      "language/configuration.json": "{}",
    };
    return source;
  });
  const bytes = await build(sources.reverse());
  expect(bytes.catalog.languages).toHaveLength(16);
  expect(bytes.problems.get("builtin:test.p016")?.[0]?.detail).toMatchObject({
    limit: "STATIC_LANGUAGE_LIMITS_V1.resourceBytesTotal",
  });
  const ids = await build(
    Array.from({ length: 129 }, (_, i) =>
      builtinToy(`test.i${String(i).padStart(3, "0")}`, `lang${i}`, [`x${i}`]),
    ),
  );
  expect(ids.catalog.languages).toHaveLength(128);
  expect(ids.problems.get("builtin:test.i128")?.[0]?.detail?.limit).toBe(
    "STATIC_LANGUAGE_LIMITS_V1.languagesTotal",
  );
  vi.mocked(validateStaticLanguageResources).mockImplementation((input) => ({
    ...acceptFixture(input),
    ok: true,
    tokenizer: input.tokenizer as Protocol.StaticLanguageTokenizerV1,
    configuration: {},
    resourceBytes: input.resourceBytes,
    rules: 3,
    regexes: 3,
    expandedRules: L.expandedRulesPerLanguage,
  }));
  const rules = await build(
    Array.from({ length: 9 }, (_, i) => builtinToy(`test.r${i}`, `lang${i}`, [`x${i}`])),
  );
  expect(rules.catalog.languages).toHaveLength(8);
  expect(rules.problems.get("builtin:test.r8")?.[0]?.detail?.limit).toBe(
    "STATIC_LANGUAGE_LIMITS_V1.expandedRulesTotal",
  );
  vi.mocked(validateStaticLanguageResources).mockImplementation(acceptFixture);
});

it("accepts exactly the plugin byte budget, charges shared paths twice and continues after overflow", async () => {
  const source = builtinToy();
  const manifest = source.manifest as PluginManifest;
  const declaration = manifest.contributes!.languages![0]!;
  // The installed core owns "c"; use an unreserved id for budget continuation.
  manifest.contributes!.languages = ["a", "b", "csmall"].map((id) => ({
    ...declaration,
    id,
    extensions: [id],
  }));
  source.resources = {
    "language/tokenizer.json": "{}" + " ".repeat(L.resourceFileBytes - 4),
    "language/configuration.json": "{}",
  };
  const exact = await build([source]);
  expect(exact.catalog.languages.map((language) => language.id)).toEqual(["a", "b"]);
  expect(
    exact.catalog.languages.reduce(
      (sum, language) =>
        sum + language.resourceBytes.tokenizer + language.resourceBytes.configuration,
      0,
    ),
  ).toBe(L.resourceBytesPerPlugin);
  source.resources = {
    "language/tokenizer.json": "{}" + " ".repeat(400000 - 2),
    "language/configuration.json": "{}" + " ".repeat(200000 - 2),
    "small.json": "{}",
  };
  manifest.contributes!.languages![2] = {
    ...manifest.contributes!.languages![2]!,
    tokenizer: { version: 1, path: "small.json" },
    configuration: { version: 1, path: "small.json" },
  };
  expect((await build([source])).catalog.languages.map((language) => language.id)).toEqual([
    "a",
    "csmall",
  ]);
});

it("retains extension ambiguity even when a complete valid candidate loses the id budget", async () => {
  const sources = Array.from({ length: 129 }, (_, i) =>
    builtinToy(
      `test.i${String(i).padStart(3, "0")}`,
      `lang${i}`,
      i === 0 || i === 128 ? ["shared"] : [`x${i}`],
    ),
  );
  const result = await build(sources.reverse());
  expect(result.catalog.languages).toHaveLength(128);
  expect(result.catalog.extensionRoutes.shared).toBeNull();
  expect(
    result.catalog.conflicts.find((conflict) => conflict.key === "shared")?.sources,
  ).toHaveLength(2);
});

it("reports an expired resource deadline per language without invalidating valid metadata", async () => {
  const source = builtinToy();
  const read = await readSource(source, { safeMode: false });
  read.resourceBudget = new SourceReadBudget(-1);
  const [plugin] = resolvePlugins([read], { disabled: new Set(), safeMode: false });
  vi.mocked(validateStaticLanguageResources).mockClear();
  const result = await buildStaticLanguageCatalog(
    [{ source, plugin: plugin!, generation: 0 }],
    new Set(),
  );
  expect(plugin!.status).toBe("enabled");
  expect(result.catalog.languages).toEqual([]);
  expect(result.problems.get(plugin!.sourceKey)?.[0]).toMatchObject({
    code: "PLUGIN_E_STATIC_LANGUAGE",
    message: expect.stringContaining("deadline"),
    detail: { languageId: "toy", resourcePath: "language/tokenizer.json" },
  });
  expect(validateStaticLanguageResources).not.toHaveBeenCalled();
});

it("reads no grammar for plugins invalidated by compiler conflicts", async () => {
  const sources = [builtinToy("test.a", "a"), builtinToy("test.b", "b")];
  for (const source of sources) {
    const manifest = source.manifest as PluginManifest;
    manifest.contributes!.frontends = [
      {
        language: "shared",
        entryExtensions: ["shared"],
        sourceExtensions: ["shared"],
        ir: { min: 1, max: 1 },
      },
    ];
  }
  vi.mocked(validateStaticLanguageResources).mockClear();
  const result = await build(sources);
  expect(result.catalog.languages).toEqual([]);
  expect(validateStaticLanguageResources).not.toHaveBeenCalled();
});
