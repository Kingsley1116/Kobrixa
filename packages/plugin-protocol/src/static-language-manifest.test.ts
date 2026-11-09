import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  pluginManifestSchema,
  staticLanguageDeclarationProblems,
  staticLanguageDeclSchema,
} from "./index.js";

const fixture: unknown = JSON.parse(
  await readFile(
    new URL("../test-fixtures/static-languages/toy/kobrixa-plugin.json", import.meta.url),
    "utf8",
  ),
);
const toy = pluginManifestSchema.parse(fixture);
const language = toy.contributes!.languages![0]!;
const check = (value: unknown) =>
  staticLanguageDeclarationProblems(pluginManifestSchema.parse(value));

it("accepts static languages, diagnostic-help-only and executable mixed contributions", () => {
  expect(check(toy)).toEqual([]);
  expect(
    check({ ...toy, contributes: { diagnosticHelp: { version: 1, path: "help.json" } } }),
  ).toEqual([]);
  for (const kind of ["node", "python"])
    expect(check({ ...toy, runtime: { kind, entry: "main.js", future: true } })).toEqual([]);
  expect(
    check({ ...toy, future: true, contributes: { ...toy.contributes, future: true } }),
  ).toEqual([]);
});

it("rejects every prohibited static field even when it is an empty array", () => {
  for (const key of ["activationEvents", "permissions"])
    expect(check({ ...toy, [key]: [] })).not.toEqual([]);
  for (const key of ["commands", "frontends", "backends", "languageServices"])
    expect(check({ ...toy, contributes: { ...toy.contributes, [key]: [] } })).not.toEqual([]);
  for (const contributes of [undefined, {}, { languages: [] }])
    expect(check({ ...toy, contributes })).not.toEqual([]);
  for (const runtime of [
    undefined,
    { kind: "static", entry: "main.js" },
    { kind: "static", future: true },
  ])
    expect(pluginManifestSchema.safeParse({ ...toy, runtime }).success).toBe(false);
});

it("keeps uniqueness and same-owner extension equality in semantic validation", () => {
  for (const languages of [
    [language, language],
    [{ ...language, extensions: ["toy", "toy"] }],
    [{ ...language, aliases: ["Toy", "Toy"] }],
  ])
    expect(check({ ...toy, contributes: { languages } })).not.toEqual([]);
  const frontend = {
    language: "toy",
    entryExtensions: ["toy"],
    sourceExtensions: ["inc", "toy"],
    ir: { min: 1, max: 1 },
  };
  const service = { language: "toy", extensions: ["toy", "inc"], capabilities: ["analysis"] };
  const value = {
    ...toy,
    runtime: { kind: "builtin" },
    contributes: {
      languages: [{ ...language, extensions: ["toy", "inc"] }],
      frontends: [frontend],
      languageServices: [service],
    },
  };
  expect(check(value)).toEqual([]);
  for (const field of ["frontends", "languageServices"] as const) {
    const contributes =
      field === "frontends"
        ? { ...value.contributes, frontends: [{ ...frontend, sourceExtensions: ["toy"] }] }
        : { ...value.contributes, languageServices: [{ ...service, extensions: ["toy"] }] };
    expect(check({ ...value, contributes })).not.toEqual([]);
  }
  expect(check({ ...value, contributes: { frontends: [frontend] } })).toEqual([]);
});

it("boundary manifest collections and text", () => {
  for (const count of [0, 1, 7, 8, 9]) {
    const value = {
      ...toy,
      contributes: {
        languages: Array.from({ length: count }, (_, i) => ({ ...language, id: `l${i}` })),
      },
    };
    expect(pluginManifestSchema.safeParse(value).success).toBe(count <= 8);
    if (count <= 8) expect(check(value).length === 0).toBe(count > 0);
    const aliases = Array.from({ length: count }, (_, i) => `Alias ${i}`);
    expect(staticLanguageDeclSchema.safeParse({ ...language, aliases }).success).toBe(
      count >= 1 && count <= 8,
    );
    if (count >= 1 && count <= 8)
      expect(check({ ...toy, contributes: { languages: [{ ...language, aliases }] } })).toEqual([]);
  }
  const { aliases: omittedAliases, ...withoutAliases } = language;
  void omittedAliases;
  expect(staticLanguageDeclSchema.safeParse(withoutAliases).success).toBe(true);
  for (const count of [0, 1, 79, 80, 81])
    expect(
      staticLanguageDeclSchema.safeParse({ ...language, aliases: ["😀".repeat(count)] }).success,
    ).toBe(count >= 1 && count <= 80);
  for (const count of [0, 1, 15, 16, 17]) {
    const extensions = Array.from({ length: count }, (_, i) => `e${i}`);
    expect(staticLanguageDeclSchema.safeParse({ ...language, extensions }).success).toBe(
      count >= 1 && count <= 16,
    );
    if (count >= 1 && count <= 16)
      expect(check({ ...toy, contributes: { languages: [{ ...language, extensions }] } })).toEqual(
        [],
      );
    expect(
      staticLanguageDeclSchema.safeParse({ ...language, extensions: ["a".repeat(count)] }).success,
    ).toBe(count >= 1 && count <= 16);
  }
  for (const count of [0, 1, 31, 32, 33])
    expect(staticLanguageDeclSchema.safeParse({ ...language, id: "a".repeat(count) }).success).toBe(
      count >= 1 && count <= 32,
    );
  for (const aliases of [["a\n"], ["a\u0085"], ["a\u2028"]])
    expect(staticLanguageDeclSchema.safeParse({ ...language, aliases }).success).toBe(false);
  for (const extensions of [[".toy"], ["TOY"]])
    expect(staticLanguageDeclSchema.safeParse({ ...language, extensions }).success).toBe(false);
});

it("boundary resource path grammar and versions", () => {
  for (const field of ["tokenizer", "configuration"] as const) {
    const accepts = (path: string) =>
      staticLanguageDeclSchema.safeParse({
        ...language,
        [field]: { version: 1, path },
      }).success;
    for (const count of [0, 1, 6, 7, 8])
      expect(accepts("a/".repeat(count) + "b.json")).toBe(count <= 7);
    for (const count of [0, 1, 63, 64, 65]) {
      expect(accepts("a".repeat(count) + "/b.json")).toBe(count >= 1 && count <= 64);
      expect(accepts("a".repeat(count) + ".json")).toBe(count >= 1 && count <= 64);
    }
    // Grammar maximum: seven 64-character directories + '/' + 64-character stem + '.json'.
    for (const count of [63, 64, 65]) {
      const path = ("a".repeat(64) + "/").repeat(7) + "b".repeat(count) + ".json";
      expect(path.length).toBe(460 + count);
      expect(accepts(path)).toBe(count <= 64); // 523/524 accepted; 525 rejected.
    }
    // The nominal 600-character cap is dominated by the 524-character grammar maximum.
    for (const count of [599, 600, 601])
      expect(accepts("a".repeat(count - 5) + ".json")).toBe(false);
    for (const path of [
      "",
      "../a.json",
      "/a.json",
      "a/../b.json",
      "a\\b.json",
      "https://a/b.json",
      "a.js",
    ])
      expect(accepts(path)).toBe(false);
    for (const version of [0, 1, 2])
      expect(
        staticLanguageDeclSchema.safeParse({ ...language, [field]: { version, path: "a.json" } })
          .success,
      ).toBe(version === 1);
  }
  for (const tokenizer of [
    { version: 2, path: "a.json" },
    { version: 1, path: "a.json", extra: 1 },
  ])
    expect(staticLanguageDeclSchema.safeParse({ ...language, tokenizer }).success).toBe(false);
  expect(staticLanguageDeclSchema.safeParse({ ...language, configuration: {} }).success).toBe(
    false,
  );
  expect(staticLanguageDeclSchema.safeParse({ ...language, extra: true }).success).toBe(false);
});
