import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  LANGUAGE_CAPABILITIES,
  languageServiceDeclarationProblems,
  pluginManifestSchema,
  SCHEMA_DEFINITIONS,
  staticLanguageDeclarationProblems,
  validateStaticLanguageResources,
} from "./index.js";

interface Case {
  name: string;
  definition: string;
  valid: boolean;
  value: unknown;
  staticSemantic?: boolean;
}
function expand(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.$repeat === "string" && typeof record.count === "number")
      return record.$repeat.repeat(record.count);
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, expand(item)]));
  }
  return value;
}
const cases = JSON.parse(
  await readFile(new URL("../conformance/cases.json", import.meta.url), "utf8"),
) as Case[];

it("boundary structural inventory is complete", () => {
  const bounds: [string, number, number][] = [
    ["languages", 0, 8],
    ["id", 1, 32],
    ["extensions", 1, 16],
    ["extensionText", 1, 16],
    ["aliases", 1, 8],
    ["aliasText", 1, 80],
    ["pathDepth", 0, 7],
    ["directorySegment", 1, 64],
    ["fileStem", 1, 64],
    ["pathLength", 6, 524],
    ["resourceVersion", 1, 1],
    ["states", 1, 64],
    ["stateName", 1, 32],
    ["listName", 1, 32],
    ["include", 2, 33],
    ["next", 2, 33],
    ["when", 2, 33],
    ["defaultToken", 0, 80],
    ["actionToken", 0, 80],
    ["bracketToken", 0, 80],
    ["tokenPostfix", 2, 80],
    ["lists", 0, 32],
    ["words", 0, 4096],
    ["wordText", 1, 64],
    ["rules", 0, 1024],
    ["cases", 1, 32],
    ["tokenizerBrackets", 0, 32],
    ["configurationBrackets", 0, 32],
    ["autoClosingPairs", 0, 32],
    ["surroundingPairs", 0, 32],
    ["pairOpen", 1, 16],
    ["pairClose", 1, 16],
    ["lineComment", 1, 16],
    ["notIn", 0, 3],
    ["onEnterRules", 0, 32],
    ["appendText", 0, 256],
    ["removeText", 0, 256],
    ["tokenizerPattern", 1, 2048],
    ["configurationPattern", 1, 2048],
  ];
  const expected = bounds.flatMap(([id, minimum, maximum]) =>
    [
      ...new Set([
        0,
        Math.max(0, minimum - 1),
        minimum,
        Math.max(1, minimum),
        maximum - 1,
        maximum,
        maximum + 1,
      ]),
    ].map((sample) => ({
      name: `static v1: boundary ${id} ${sample}`,
      valid: sample >= minimum && sample <= maximum,
    })),
  );
  expect(
    cases
      .filter(({ name }) => name.startsWith("static v1: boundary "))
      .map(({ name, valid }) => ({ name, valid }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  ).toEqual(expected.sort((a, b) => a.name.localeCompare(b.name)));
});

it.each(cases)("$name", ({ definition, valid, value }) => {
  const schema = SCHEMA_DEFINITIONS[definition];
  expect(schema, definition).toBeDefined();
  expect(schema!.safeParse(expand(value)).success).toBe(valid);
});

it.each(cases.filter((item) => item.staticSemantic !== undefined))(
  "$name (static declaration semantics)",
  ({ value, staticSemantic }) => {
    const manifest = pluginManifestSchema.parse(expand(value));
    expect(staticLanguageDeclarationProblems(manifest).length === 0).toBe(staticSemantic);
  },
);

it("keeps legacy service declarations compatible and validates frozen Basic Plus resources", async () => {
  const manifest = pluginManifestSchema.parse({
    id: "kobrixa.basic-plus",
    version: "1.0.0",
    apiVersion: "^1.3.0",
    runtime: { kind: "builtin" },
    contributes: {
      frontends: [
        {
          language: "bp",
          entryExtensions: ["bp"],
          sourceExtensions: ["bp", "bpi", "bpm"],
          ir: { min: 1, max: 1 },
        },
      ],
      languageServices: [
        {
          language: "bp",
          extensions: ["bp", "bpi", "bpm"],
          capabilities: [...LANGUAGE_CAPABILITIES],
        },
      ],
    },
  });
  expect(languageServiceDeclarationProblems(manifest)).toEqual([]);
  expect(manifest.contributes?.languageServices?.[0]?.capabilities).toEqual([
    ...LANGUAGE_CAPABILITIES,
  ]);
  const read = (name: string) =>
    readFile(new URL(`../test-fixtures/static-languages/basic-plus/${name}.json`, import.meta.url));
  const [tokenizer, configuration] = await Promise.all([read("tokenizer"), read("configuration")]);
  expect(
    validateStaticLanguageResources({
      languageId: "bp",
      formatVersion: 1,
      limitsVersion: 1,
      tokenizer: JSON.parse(tokenizer.toString("utf8")),
      configuration: JSON.parse(configuration.toString("utf8")),
      resourceBytes: { tokenizer: tokenizer.byteLength, configuration: configuration.byteLength },
    }),
  ).toMatchObject({ ok: true, rules: 9, regexes: 11, expandedRules: 9 });
});
