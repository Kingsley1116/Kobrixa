import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import {
  staticLanguageDeclSchema,
  validateStaticLanguageResources,
  type Rule,
  type StaticLanguageTokenizerV1,
  type StaticLanguageConfigurationV1,
  type ValidateStaticLanguageResourcesInput,
} from "./index.js";
import * as regex from "./static-language-regex.js";

const leaf: Rule = { regex: { pattern: ".", flags: "" }, action: { token: "identifier" } };
const grammar = (): StaticLanguageTokenizerV1 => ({
  ignoreCase: false,
  states: [{ name: "root", rules: [structuredClone(leaf)] }],
});
const input = (
  tokenizer: unknown = grammar(),
  configuration: unknown = {},
): ValidateStaticLanguageResourcesInput => ({
  languageId: "toy",
  formatVersion: 1,
  limitsVersion: 1,
  tokenizer,
  configuration,
  resourceBytes: { tokenizer: 100, configuration: 2 },
  resourcePaths: {
    tokenizer: "language/tokenizer.json",
    configuration: "language/configuration.json",
  },
});
const validate = (tokenizer: unknown = grammar(), configuration: unknown = {}) =>
  validateStaticLanguageResources(input(tokenizer, configuration));
function failure(value: ValidateStaticLanguageResourcesInput) {
  const result = validateStaticLanguageResources(value);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected validation failure.");
  expect(result.problems.length).toBeGreaterThan(0);
  expect(result.problems[0]!.detail.languageId).toBe("toy");
  return result.problems[0]!;
}

it.each(["minimal", "basic-plus", "toy/language"])(
  "validates the frozen %s fixture",
  async (folder) => {
    const read = (name: string) =>
      readFile(
        new URL(`../test-fixtures/static-languages/${folder}/${name}.json`, import.meta.url),
      );
    const [tokenizer, configuration] = await Promise.all([
      read("tokenizer"),
      read("configuration"),
    ]);
    const result = validateStaticLanguageResources({
      ...input(JSON.parse(tokenizer.toString("utf8")), JSON.parse(configuration.toString("utf8"))),
      resourceBytes: { tokenizer: tokenizer.byteLength, configuration: configuration.byteLength },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resourceBytes).toEqual({
        tokenizer: tokenizer.byteLength,
        configuration: configuration.byteLength,
      });
      expect(result.rules).toBe(folder === "basic-plus" ? 9 : folder === "minimal" ? 1 : 3);
      expect(result.expandedRules).toBe(result.rules);
      expect(result.regexes).toBe(result.rules + (folder === "basic-plus" ? 2 : 0));
    }
  },
);

it("rejects invalid versions, original byte counts and exact byte budget overflow", () => {
  for (const field of ["formatVersion", "limitsVersion"]) failure({ ...input(), [field]: 2 });
  for (const bytes of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    failure({ ...input(), resourceBytes: { tokenizer: bytes, configuration: 2 } });
  expect(
    validateStaticLanguageResources({
      ...input(),
      resourceBytes: { tokenizer: 524288, configuration: 262144 },
    }).ok,
  ).toBe(true);
  expect(
    failure({ ...input(), resourceBytes: { tokenizer: 524289, configuration: 2 } }).detail,
  ).toMatchObject({
    resourcePath: "language/tokenizer.json",
    limit: "STATIC_LANGUAGE_LIMITS_V1.resourceFileBytes",
    allowed: 524288,
    actual: 524289,
  });
  expect(
    failure({ ...input(), resourceBytes: { tokenizer: 524288, configuration: 262145 } }).detail,
  ).toMatchObject({
    limit: "STATIC_LANGUAGE_LIMITS_V1.resourceBytesPerLanguage",
    allowed: 786432,
    actual: 786433,
  });
});

it("counts decoded code points and preserves literal macro characters", () => {
  const declaration = {
    id: "toy",
    extensions: ["toy"],
    aliases: ["😀".repeat(80)],
    tokenizer: { version: 1, path: "language/tokenizer.json" },
    configuration: { version: 1, path: "language/configuration.json" },
  };
  expect(staticLanguageDeclSchema.safeParse(declaration).success).toBe(true);
  expect(
    staticLanguageDeclSchema.safeParse({ ...declaration, aliases: ["😀".repeat(81)] }).success,
  ).toBe(false);
  for (const pattern of ["@", "@@", "@name", "\\@", "\\$", "😀".repeat(2048)]) {
    const tokenizer = grammar();
    tokenizer.states[0]!.rules = [{ regex: { pattern, flags: "" }, action: { token: "" } }];
    const result = validate(tokenizer);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tokenizer.states[0]!.rules).toEqual(tokenizer.states[0]!.rules);
  }
  for (const pattern of ["$S1", "$s1", "\\$S1", "\\$s1"])
    expect(
      failure(
        input({
          ...grammar(),
          states: [
            { name: "root", rules: [{ regex: { pattern, flags: "" }, action: { token: "" } }] },
          ],
        }),
      ).detail,
    ).toMatchObject({
      resourcePath: "language/tokenizer.json",
      fieldPath: "states[0].rules[0].regex.pattern",
    });
});

it("rejects duplicate/reserved names, missing root and all invalid action references", () => {
  for (const name of ["pop", "popall", "push", "constructor", "prototype", "__proto__"])
    expect(validate({ ...grammar(), states: [...grammar().states, { name, rules: [] }] }).ok).toBe(
      false,
    );
  expect(validate({ ...grammar(), states: [{ name: "other", rules: [] }] }).ok).toBe(false);
  expect(validate({ ...grammar(), states: [...grammar().states, ...grammar().states] }).ok).toBe(
    false,
  );
  for (const name of ["default", "eos", "constructor", "prototype", "__proto__"])
    expect(validate({ ...grammar(), lists: [{ name, words: [] }] }).ok).toBe(false);
  expect(
    validate({
      ...grammar(),
      lists: [
        { name: "words", words: [] },
        { name: "words", words: [] },
      ],
    }).ok,
  ).toBe(false);
  for (const next of ["@missing", "@push", "@root.child", "$1", "@$S2"])
    expect(
      validate({
        ...grammar(),
        states: [
          {
            name: "root",
            rules: [{ regex: { pattern: ".", flags: "" }, action: { token: "", next } }],
          },
        ],
      }).ok,
    ).toBe(false);
  for (const next of ["@root", "@pop", "@popall"])
    expect(
      validate({
        ...grammar(),
        states: [
          {
            name: "root",
            rules: [{ regex: { pattern: ".", flags: "" }, action: { token: "", next } }],
          },
        ],
      }).ok,
    ).toBe(true);
  for (const cases of [
    [],
    ["@words"],
    ["@default", "@eos"],
    ["@eos", "@eos", "@default"],
    ["@missing", "@default"],
    ["~x", "@default"],
  ])
    expect(
      validate({
        ...grammar(),
        states: [
          {
            name: "root",
            rules: [
              {
                regex: { pattern: ".", flags: "" },
                action: { cases: cases.map((when) => ({ when, action: { token: "" } })) },
              },
            ],
          },
        ],
      }).ok,
    ).toBe(false);
});

it("checks keyword folding, ordered cases, brackets and notIn without mutating resources", () => {
  const tokenizer = grammar();
  tokenizer.lists = [{ name: "words", words: ["If", "if"] }];
  tokenizer.states[0]!.rules = [
    {
      regex: { pattern: ".", flags: "" },
      action: {
        cases: [
          { when: "@words", action: { token: "keyword" } },
          { when: "@eos", action: { token: "" } },
          { when: "@default", action: { token: "identifier" } },
        ],
      },
    },
  ];
  expect(validate(tokenizer).ok).toBe(true);
  tokenizer.ignoreCase = true;
  expect(validate(tokenizer).ok).toBe(false);
  tokenizer.lists[0]!.words = ["if"];
  (tokenizer.states[0]!.rules[0] as Extract<Rule, { regex: unknown }>).regex.flags = "i";
  tokenizer.lists.push({ name: "second", words: ["IF"] });
  const before = structuredClone(tokenizer);
  expect(validate(tokenizer).ok).toBe(true);
  expect(tokenizer).toEqual(before);
  const brackets = grammar();
  brackets.states[0]!.rules = [
    { regex: { pattern: ".", flags: "" }, action: { token: "@brackets" } },
  ];
  expect(validate(brackets).ok).toBe(false);
  brackets.brackets = [{ open: "(", close: ")", token: "delimiter" }];
  expect(validate(brackets).ok).toBe(true);
  brackets.states[0]!.rules = [
    { regex: { pattern: ".", flags: "" }, action: { token: "@brackets", bracket: "@open" } },
  ];
  expect(validate(brackets).ok).toBe(false);
  expect(
    validate(grammar(), {
      autoClosingPairs: [{ open: '"', close: '"', notIn: ["string", "string"] }],
    }).ok,
  ).toBe(false);
});

it("counts raw rules, all regex occurrences and words before AST parsing", () => {
  const tokenizer = grammar();
  tokenizer.states[0]!.rules = Array.from({ length: 1020 }, () => leaf);
  const data = { pattern: "^", flags: "" as const };
  const configuration: StaticLanguageConfigurationV1 = {
    indentationRules: {
      increaseIndentPattern: data,
      decreaseIndentPattern: data,
      indentNextLinePattern: data,
      unIndentedLinePattern: data,
    },
  };
  const accepted = validate(tokenizer, configuration);
  expect(accepted).toMatchObject({ ok: true, rules: 1020, regexes: 1024 });
  const ast = vi.spyOn(regex, "checkStaticRegex");
  try {
    expect(failure(input(tokenizer, { ...configuration, wordPattern: data })).detail).toMatchObject(
      { limit: "STATIC_LANGUAGE_LIMITS_V1.regexesPerLanguage", actual: 1025 },
    );
    expect(ast).not.toHaveBeenCalled();
    const tooManyRules = grammar();
    tooManyRules.states.push({
      name: "second",
      rules: Array.from({ length: 1024 }, () => ({ include: "@root" })),
    });
    expect(failure(input(tooManyRules)).detail).toMatchObject({
      limit: "STATIC_LANGUAGE_LIMITS_V1.rulesPerLanguage",
      actual: 1025,
    });
    expect(ast).not.toHaveBeenCalled();
    const words = Array.from({ length: 4096 }, (_, i) => `w${i}`);
    const tooManyWords = {
      ...grammar(),
      lists: [
        { name: "a", words },
        { name: "b", words: ["last"] },
      ],
    };
    expect(failure(input(tooManyWords)).detail).toMatchObject({
      limit: "STATIC_LANGUAGE_LIMITS_V1.wordsPerLanguage",
      actual: 4097,
    });
    expect(ast).not.toHaveBeenCalled();
    expect(validate({ ...grammar(), lists: [{ name: "a", words }] }).ok).toBe(true);
  } finally {
    ast.mockRestore();
  }
  expect(
    validate(grammar(), {
      ...configuration,
      wordPattern: data,
      onEnterRules: [
        {
          beforeText: data,
          afterText: data,
          previousLineText: data,
          action: { indentAction: "none" },
        },
      ],
    }),
  ).toMatchObject({ ok: true, regexes: 9 });
});

it("boundary semantic totals and byte counters", () => {
  for (const count of [0, 1, 1023, 1024, 1025]) {
    const rules = Array.from({ length: count }, () => leaf);
    const value = {
      ...grammar(),
      states: [
        { name: "root", rules: rules.slice(0, 512) },
        { name: "unused", rules: rules.slice(512) },
      ],
    };
    const result = validate(value);
    expect(result.ok).toBe(count <= 1024);
    if (result.ok)
      expect(result).toMatchObject({ rules: count, regexes: count, expandedRules: count });
    // Configuration supplies the last occurrence without exceeding the raw-rule cap.
    const regexOnly = {
      ...grammar(),
      states: [{ name: "root", rules: rules.slice(0, Math.max(0, count - 1)) }],
    };
    const regexResult = validate(
      regexOnly,
      count === 0 ? {} : { wordPattern: { pattern: "^", flags: "" } },
    );
    expect(regexResult.ok).toBe(count <= 1024);
    if (regexResult.ok) expect(regexResult.regexes).toBe(count);
    else
      expect(regexResult.problems[0]!.detail).toMatchObject({
        limit: "STATIC_LANGUAGE_LIMITS_V1.regexesPerLanguage",
        actual: 1025,
      });
  }
  for (const count of [0, 1, 4095, 4096, 4097]) {
    const words = Array.from({ length: count }, (_, i) => `w${i}`);
    expect(
      validate({
        ...grammar(),
        lists: [
          { name: "a", words: words.slice(0, 2048) },
          { name: "b", words: words.slice(2048) },
        ],
      }).ok,
    ).toBe(count <= 4096);
  }
  for (const count of [0, 1, 31, 32, 33]) {
    const names = Array.from({ length: Math.max(0, count - 1) }, (_, i) => `l${i}`);
    const value = {
      ...grammar(),
      lists: names.map((name) => ({ name, words: [name] })),
      states: [
        {
          name: "root",
          rules: [
            {
              regex: { pattern: ".", flags: "" },
              action: {
                cases: (count === 0 ? [] : [...names.map((name) => `@${name}`), "@default"]).map(
                  (when) => ({ when, action: { token: "" } }),
                ),
              },
            },
          ],
        },
      ],
    };
    expect(validate(value).ok).toBe(count >= 1 && count <= 32);
  }
  for (const field of ["tokenizer", "configuration"] as const)
    for (const count of [0, 1, 524287, 524288, 524289]) {
      const value = input();
      value.resourceBytes[field] = count;
      expect(validateStaticLanguageResources(value).ok).toBe(count <= 524288);
    }
  for (const count of [786431, 786432, 786433])
    expect(
      validateStaticLanguageResources({
        ...input(),
        resourceBytes: {
          tokenizer: 524288,
          configuration: count - 524288,
        },
      }).ok,
    ).toBe(count <= 786432);
  // Zero is a legal nonnegative counter at this pure API; empty bytes are not valid JSON at the reader.
  expect(
    validateStaticLanguageResources({
      ...input(),
      resourceBytes: { tokenizer: 0, configuration: 0 },
    }).ok,
  ).toBe(true);
  for (const field of ["formatVersion", "limitsVersion"] as const)
    for (const version of [0, 1, 2])
      expect(validateStaticLanguageResources({ ...input(), [field]: version }).ok).toBe(
        version === 1,
      );
});

it("returns precise structural, flags and graph problems and retains unexpanded includes", () => {
  expect(
    failure(input(grammar(), { wordPattern: { pattern: "x".repeat(2049), flags: "" } })).detail,
  ).toMatchObject({
    resourcePath: "language/configuration.json",
    fieldPath: "wordPattern.pattern",
    limit: "STATIC_LANGUAGE_LIMITS_V1.patternLength",
    allowed: 2048,
    actual: 2049,
  });
  expect(
    failure(input(grammar(), { wordPattern: { pattern: "x", flags: "g" } })).detail,
  ).toMatchObject({ fieldPath: "wordPattern.flags", allowed: ["", "i"], actual: "g" });
  const tokenizer = grammar();
  tokenizer.states.push({ name: "unused", rules: [{ include: "@unused" }] });
  const cycle = failure(input(tokenizer));
  expect(cycle.detail.fieldPath).toBe("states[1].rules[0].include");
  expect(cycle.message).toContain("unused -> unused");
  tokenizer.states[1]!.rules = [{ include: "@root" }, { include: "@root" }];
  const result = validate(tokenizer);
  expect(result).toMatchObject({ ok: true, rules: 3, regexes: 1, expandedRules: 3 });
  if (result.ok) expect(result.tokenizer).toEqual(tokenizer);
  const noPaths = input({ ...grammar(), extra: true });
  delete noPaths.resourcePaths;
  expect(failure(noPaths).detail).not.toHaveProperty("resourcePath");
});
