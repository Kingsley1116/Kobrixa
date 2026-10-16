import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  LANGUAGE_CAPABILITIES,
  languageServiceDeclarationProblems,
  pluginManifestSchema,
  SCHEMA_DEFINITIONS,
} from "./index.js";

interface Case {
  name: string;
  definition: string;
  valid: boolean;
  value: unknown;
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

it.each(cases)("$name", ({ definition, valid, value }) => {
  const schema = SCHEMA_DEFINITIONS[definition];
  expect(schema, definition).toBeDefined();
  expect(schema!.safeParse(expand(value)).success).toBe(valid);
});

it("declares every Basic Plus language capability with its frontend in API 1.3", async () => {
  const manifest = pluginManifestSchema.parse(
    JSON.parse(
      await readFile(
        new URL("../../../plugins/basic-plus/kobrixa-plugin.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  expect(manifest.apiVersion).toBe("^1.3.0");
  expect(manifest.contributes?.languageServices).toEqual([
    {
      language: "bp",
      extensions: ["bp", "bpi", "bpm"],
      capabilities: [...LANGUAGE_CAPABILITIES],
    },
  ]);
  expect(languageServiceDeclarationProblems(manifest)).toEqual([]);
});
