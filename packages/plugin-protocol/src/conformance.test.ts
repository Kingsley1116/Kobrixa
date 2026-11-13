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

import { z } from "zod";
import { chunkSchema, jsonBytes, validateSettingsResource } from "./persistence-validation.js";
import { settingsResourceV1Schema } from "./settings.js";
// T1's frozen fixtures separate method and phase. Resolve only registered keys.
const fixtureSchemas: Record<string, z.ZodType> = {
  ...SCHEMA_DEFINITIONS,
  settingsResourceV1: settingsResourceV1Schema,
  chunk: chunkSchema(),
};
const definitionFor = (schema: string, phase: string) =>
  (schema === "settingsResourceV1" && phase === "resource") ||
  (schema === "chunk" && phase === "params")
    ? schema
    : `${schema}.${phase}`;
const fixtureExpectedSchema = z.strictObject({
  numericCode: z.number().int().nullable(),
  businessCode: z.string().nullable(),
  reason: z.string().nullable(),
  permission: z.string().nullable(),
  lifetime: z.string().nullable(),
  persistedSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
});
const contractFixtureFileSchema = z.strictObject({
  formatVersion: z.literal(1),
  family: z.literal("settings-storage-v1"),
  cases: z
    .array(
      z
        .strictObject({
          id: z.string().min(1),
          schema: z.string(),
          phase: z.enum(["params", "result", "resource", "event"]),
          input: z.unknown(),
          valid: z.boolean(),
          expected: fixtureExpectedSchema,
        })
        .refine((c) => Object.hasOwn(fixtureSchemas, definitionFor(c.schema, c.phase))),
    )
    .refine((cases) => new Set(cases.map((c) => c.id)).size === cases.length)
    .refine((cases) =>
      cases.every((c) => !c.valid || Object.values(c.expected).every((v) => v === null)),
    ),
});
for (const family of ["valid", "invalid", "maximum"] as const) {
  const document: unknown = JSON.parse(
    await readFile(
      new URL(`../test-fixtures/settings-storage-v1/${family}.json`, import.meta.url),
      "utf8",
    ),
  );
  const file = contractFixtureFileSchema.parse(document);
  it(`${family}: strict persistence fixture format`, () => {
    const entry = file.cases[0]!;
    for (const patch of [
      { extra: true },
      { formatVersion: 2 },
      { family: "foreign" },
      { cases: [entry, entry] },
      { cases: [{ ...entry, extra: true }] },
      { cases: [{ ...entry, schema: "__proto__" }] },
      { cases: [{ ...entry, phase: "arbitrary" }] },
      { cases: [{ ...entry, expected: { ...entry.expected, extra: true } }] },
    ])
      expect(contractFixtureFileSchema.safeParse({ ...file, ...patch }).success).toBe(false);
  });
  for (const entry of file.cases)
    it(`${family}: ${entry.id}`, () => {
      const schema = fixtureSchemas[definitionFor(entry.schema, entry.phase)]!;
      let accepted = schema.safeParse(entry.input).success;
      if (accepted && entry.schema === "settingsResourceV1") {
        try {
          validateSettingsResource(entry.input, jsonBytes(entry.input));
        } catch {
          accepted = false;
        }
      }
      expect(accepted).toBe(entry.valid);
    });
}

it("T8 settings.changed uses segment key semantics and permits duplicate literal dotted keys", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const envelope = (keys: string[]) => ({
    version: 1,
    subscriptionId: id,
    owner: {
      sourceKey: "builtin:acme.test",
      pluginId: "acme.test",
      generation: 1,
      hostEpoch: id,
      processEpoch: id,
    },
    sequence: 1,
    delivery: "telemetry",
    kind: "settings.changed",
    data: { revision: "r_" + "1".repeat(32), schemaVersion: 1, changedKeys: keys, cause: "update" },
  });
  for (const key of [
    "constructor",
    "prototype",
    "__proto__",
    "foo.constructor",
    "prototype.foo",
    "foo.__proto__.bar",
  ])
    expect(SCHEMA_DEFINITIONS["events/deliver.params"]!.safeParse(envelope([key])).success).toBe(
      false,
    );
  expect(
    SCHEMA_DEFINITIONS["events/deliver.params"]!.safeParse(
      envelope(["fixture.enabled", "fixture.enabled", "constructorName.x"]),
    ).success,
  ).toBe(true);
});
