import { readFileSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import type * as PluginProtocol from "@kobrixa/plugin-protocol";
import type { languages } from "monaco-editor";
import { validateStaticLanguageResources } from "@kobrixa/plugin-protocol";
import type { ValidatedStaticLanguage } from "../../shared/static-languages.js";
import { adaptStaticLanguage, StaticLanguageAdapterError } from "./static-language-adapter.js";

vi.mock("@kobrixa/plugin-protocol", async (original) => ({
  ...(await original<typeof PluginProtocol>()),
  validateStaticLanguageResources: vi.fn(),
}));
vi.mock("monaco-editor", () => ({
  languages: { IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 } },
}));
const validate = vi.mocked(validateStaticLanguageResources);
function fixture(name = "minimal"): ValidatedStaticLanguage {
  const root = new URL(
    `../../../../../packages/plugin-protocol/test-fixtures/static-languages/${name}/`,
    import.meta.url,
  );
  const tokenizer = readFileSync(new URL("tokenizer.json", root));
  const configuration = readFileSync(new URL("configuration.json", root));
  return {
    id: name === "basic-plus" ? "bp" : "toy",
    pluginId: "acme.toy",
    sourceKey: "development:toy",
    generation: 1,
    extensions: ["toy"],
    aliases: [],
    resourceDigest: "fixture",
    tokenizer: JSON.parse(tokenizer.toString()),
    configuration: JSON.parse(configuration.toString()),
    resourceBytes: { tokenizer: tokenizer.byteLength, configuration: configuration.byteLength },
    expandedRules: name === "basic-plus" ? 9 : 1,
  };
}
function accept(value: ValidatedStaticLanguage): void {
  validate.mockReturnValue({
    ok: true,
    tokenizer: value.tokenizer,
    configuration: value.configuration,
    resourceBytes: value.resourceBytes,
    expandedRules: value.expandedRules,
    rules: value.expandedRules,
    regexes: value.expandedRules,
  });
}
beforeEach(() => validate.mockReset());

it("checks original bytes and recomputed expansion counts before adapting", () => {
  const value = fixture();
  accept(value);
  const result = adaptStaticLanguage(value);
  expect(validate).toHaveBeenCalledWith({
    languageId: "toy",
    formatVersion: 1,
    limitsVersion: 1,
    tokenizer: value.tokenizer,
    configuration: value.configuration,
    resourceBytes: value.resourceBytes,
  });
  expect(result.configuration).toEqual({});
  expect(result.tokenizer).toMatchObject({ start: "root", defaultToken: "", tokenPostfix: ".toy" });
  expect(() => adaptStaticLanguage({ ...value, expandedRules: 2 })).toThrow(
    StaticLanguageAdapterError,
  );
  validate.mockReturnValue({
    ok: false,
    problems: [
      { message: "invalid resource", detail: { languageId: "toy", fieldPath: "states[0]" } },
    ],
  });
  expect(() => adaptStaticLanguage(value)).toThrow("invalid resource");
});

it("counts decoded code points and preserves literal macro characters", async () => {
  const value = fixture();
  value.aliases = ["😀".repeat(80)];
  const sources = ["@", "@@", "@name", String.raw`\@`, String.raw`\$`];
  value.tokenizer.states[0]!.rules = sources.map((pattern) => ({
    regex: { pattern, flags: "" },
    action: { token: "identifier" },
  }));
  value.expandedRules = sources.length;
  accept(value);
  const definition = adaptStaticLanguage(value);
  const compilerPath = "monaco-editor/editor/standalone/common/monarch/monarchCompile.js";
  const compiler = (await import(compilerPath)) as {
    compile(
      id: string,
      input: languages.IMonarchLanguage,
    ): {
      tokenizer: Record<string, { regex: RegExp }[]>;
    };
  };
  const compiled = compiler.compile("toy", definition.tokenizer);
  for (const [index, pattern] of sources.entries()) {
    const expected = new RegExp(`^(?:${pattern})`);
    for (const sample of ["@", "@@", "@name", "\\@", "$", "name"]) {
      expect(compiled.tokenizer.root![index]!.regex.exec(sample)?.[0]).toBe(
        expected.exec(sample)?.[0],
      );
    }
  }
  // T1 owns the AST/code-point check. Assert its rejection propagates unchanged.
  for (const pattern of [String.raw`\$S1`, "$s2"]) {
    const bad = fixture();
    bad.tokenizer.states[0]!.rules = [{ regex: { pattern, flags: "" }, action: { token: "x" } }];
    validate.mockReturnValue({
      ok: false,
      problems: [{ message: "state substitution forbidden", detail: { languageId: "toy" } }],
    });
    expect(() => adaptStaticLanguage(bad)).toThrow("state substitution forbidden");
  }
});

it("preserves Basic Plus rule order, flags, postfix, and namespaced list cases", async () => {
  const value = fixture("basic-plus");
  accept(value);
  const result = adaptStaticLanguage(value);
  expect(result.tokenizer.tokenPostfix).toBe(".basic-plus");
  expect(result.tokenizer.ignoreCase).toBe(true);
  expect(result.tokenizer.tokenizer.root).toHaveLength(9);
  const identifier = result.tokenizer.tokenizer.root![4] as languages.IExpandedMonarchLanguageRule;
  const action = identifier.action as languages.IExpandedMonarchLanguageAction;
  expect(Object.keys(action.cases!)).toEqual([
    "@list_types",
    "@list_booleans",
    "@list_word_operators",
    "@list_control",
    "@list_keywords",
    "@default",
  ]);
  expect(result.configuration).not.toHaveProperty("wordPattern");
  expect(result.configuration).not.toHaveProperty("onEnterRules");
  expect(result.configuration.indentationRules!.increaseIndentPattern.flags).toBe("i");
  const compilerPath = "monaco-editor/editor/standalone/common/monarch/monarchCompile.js";
  const compiler = (await import(compilerPath)) as {
    compile(
      id: string,
      input: languages.IMonarchLanguage,
    ): {
      tokenizer: Record<string, { regex: RegExp }[]>;
    };
  };
  const compiled = compiler.compile("bp", result.tokenizer);
  expect(compiled.tokenizer.root).toHaveLength(9);
  expect(compiled.tokenizer.root![2]!.regex.exec('"a""b"')?.[0]).toBe('"a""b"');
  expect(compiled.tokenizer.root![4]!.regex.exec("lcd.clear")?.[0]).toBe("lcd.clear");
});

it("copies only allowed configuration fields and maps all four indent actions", () => {
  const value = fixture();
  value.configuration = {
    comments: { lineComment: "//", blockComment: { open: "/*", close: "*/" } },
    brackets: [{ open: "(", close: ")" }],
    autoClosingPairs: [{ open: '"', close: '"', notIn: ["string", "comment"] }],
    surroundingPairs: [{ open: "[", close: "]" }],
    indentationRules: {
      increaseIndentPattern: { pattern: "^@", flags: "i" },
      decreaseIndentPattern: { pattern: "^", flags: "" },
      indentNextLinePattern: { pattern: "x", flags: "i" },
      unIndentedLinePattern: { pattern: "^$", flags: "" },
    },
    wordPattern: { pattern: "@name", flags: "" },
    onEnterRules: (["none", "indent", "indentOutdent", "outdent"] as const).map((indentAction) => ({
      beforeText: { pattern: "^", flags: "" },
      afterText: { pattern: "@", flags: "i" },
      previousLineText: { pattern: "x", flags: "" },
      action: { indentAction, appendText: "", removeText: 0 },
    })),
  };
  Object.assign(value.configuration, { folding: { offSide: true } });
  accept(value);
  const result = adaptStaticLanguage(value).configuration;
  expect(result.comments!.blockComment).toEqual(["/*", "*/"]);
  expect(result.brackets).toEqual([["(", ")"]]);
  expect(result.wordPattern!.source).toBe("@name");
  expect(result.indentationRules!.increaseIndentPattern.source).toBe("^@");
  expect(result.onEnterRules!.map((rule) => rule.action.indentAction)).toEqual([0, 1, 2, 3]);
  expect(result.onEnterRules![0]!.action).toEqual({
    indentAction: 0,
    appendText: "",
    removeText: 0,
  });
  expect(result).not.toHaveProperty("folding");
  expect(result.autoClosingPairs![0]!.notIn).not.toBe(
    value.configuration.autoClosingPairs![0]!.notIn,
  );
});

it("retains includes and explicit state transitions without expanding arrays", () => {
  const value = fixture();
  value.tokenizer.states = [
    {
      name: "other",
      rules: [{ regex: { pattern: "x", flags: "" }, action: { token: "x", next: "@root" } }],
    },
    { name: "root", rules: [{ include: "@other" }] },
  ];
  value.expandedRules = 2;
  accept(value);
  const result = adaptStaticLanguage(value).tokenizer;
  expect(result.start).toBe("root");
  expect(result.tokenizer.root).toEqual([{ include: "@other" }]);
  expect(Object.keys(result.tokenizer)).toEqual(["other", "root"]);
  expect(Object.hasOwn(result.tokenizer, "root")).toBe(true);
});
