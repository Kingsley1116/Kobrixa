import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import type { languages } from "monaco-editor";
import type { StaticLanguageTokenizerV1 } from "@kobrixa/plugin-protocol";
import { BASIC_PLUS_KEYWORDS, formatBasicPlus } from "@kobrixa/basic-plus/language";

import type { LanguageCompanion } from "./language-companion.js";
import { workspaceSessionSchema } from "../../shared/workspace-session.js";
import { Documents } from "./documents.js";
import { initializeEditorThemes } from "./editor-theme.js";
import { basicPlusCompanion } from "./companions/basic-plus/companion.js";
import { basicPlusCompletions } from "./companions/basic-plus/completions.js";
import { basicPlusSignatureHelp } from "./companions/basic-plus/signatures.js";
import { basicPlusRangeFormattingEdits } from "./companions/basic-plus/formatting.js";
import { legend, structuralChange } from "./companions/basic-plus/structure.js";

const lexicalCalls = vi.hoisted(() => ({
  register: vi.fn(() => {
    throw new Error("T6 must not register a language.");
  }),
  setMonarchTokensProvider: vi.fn(() => {
    throw new Error("T6 must not install a tokenizer.");
  }),
  setLanguageConfiguration: vi.fn(() => {
    throw new Error("T6 must not install configuration.");
  }),
}));
vi.mock("monaco-editor", () => ({ languages: lexicalCalls }));

const repository = new URL("../../../../../", import.meta.url);
const tokenizerFile = new URL("plugins/basic-plus/language/tokenizer.json", repository);

// A test-only projection of the nine-rule fixture, never a public adapter API.
function basicPlusFixtureDefinition(input: StaticLanguageTokenizerV1): languages.IMonarchLanguage {
  expect(input.states.map((state) => state.name)).toEqual(["root"]);
  expect(input.states[0]!.rules).toHaveLength(9);
  const root: languages.IMonarchLanguageRule[] = input.states[0]!.rules.map((rule) => {
    if (!("regex" in rule)) throw new Error("Unexpected include in Basic Plus fixture.");
    const regex = new RegExp(rule.regex.pattern.replaceAll("@", "@@"), rule.regex.flags);
    if ("cases" in rule.action) {
      const cases: Record<string, string> = {};
      for (const branch of rule.action.cases) {
        expect(Object.keys(branch.action)).toEqual(["token"]);
        const key = branch.when === "@default" ? "@default" : `@list_${branch.when.slice(1)}`;
        cases[key] = branch.action.token;
      }
      return [regex, { cases }];
    }
    expect(Object.keys(rule.action)).toEqual(["token"]);
    return [regex, rule.action.token];
  });
  return {
    ignoreCase: input.ignoreCase,
    defaultToken: input.defaultToken!,
    tokenPostfix: input.tokenPostfix!,
    ...Object.fromEntries(input.lists!.map((list) => [`list_${list.name}`, [...list.words]])),
    tokenizer: { root },
  };
}

const legacyDefinition: languages.IMonarchLanguage = {
  ignoreCase: true,
  tokenPostfix: ".basic-plus",
  defaultToken: "invalid",
  keywords: [...BASIC_PLUS_KEYWORDS],
  control: [
    "If",
    "Then",
    "Else",
    "ElseIf",
    "EndIf",
    "For",
    "To",
    "Step",
    "EndFor",
    "While",
    "EndWhile",
    "Break",
    "Continue",
    "Return",
    "Goto",
  ],
  types: ["Number", "String"],
  booleans: ["True", "False"],
  wordOperators: ["And", "Or", "Not"],
  tokenizer: {
    root: [
      [/[ \t\r]+/, "white"],
      [/'[^\r\n]*/, "comment"],
      [/"(?:[^"\r\n]|"")*"(?!")/, "string"],
      [/"[^\r\n]*$/, "string.invalid"],
      [
        /[A-Za-z_][\w.]*/,
        {
          cases: {
            "@types": "type",
            "@booleans": "constant.language",
            "@wordOperators": "operator.word",
            "@control": "keyword.control",
            "@keywords": "keyword",
            "@default": "identifier",
          },
        },
      ],
      [/(?:\d+\.\d*|\.\d+|\d+)/, "number"],
      [/!=|<=|>=|<>|\+=|-=|\*=|\/=|\+\+|--|[=<>+\-*/%]/, "operator"],
      [/@/, "operator"],
      [/[()[\],.:]/, "delimiter"],
    ],
  },
};

interface ClassicTokenizer {
  getInitialState(): unknown;
  tokenize(
    line: string,
    hasEOL: boolean,
    state: unknown,
  ): {
    tokens: { offset: number; type: string; language: string }[];
    endState: unknown;
  };
  dispose(): void;
}
async function monarch(
  id: string,
  definition: languages.IMonarchLanguage,
): Promise<ClassicTokenizer> {
  // Monaco 0.57.0 maps package subpaths to esm/vs; do not add an esm/vs prefix.
  // Variable imports avoid inventing declarations for Monaco's private JS modules.
  const compilePath = "monaco-editor/editor/standalone/common/monarch/monarchCompile.js";
  const lexerPath = "monaco-editor/editor/standalone/common/monarch/monarchLexer.js";
  const { compile } = (await import(compilePath)) as {
    compile(languageId: string, source: languages.IMonarchLanguage): unknown;
  };
  const { MonarchTokenizer } = (await import(lexerPath)) as {
    MonarchTokenizer: new (
      languageService: object,
      themeService: object,
      languageId: string,
      lexer: unknown,
      configuration: {
        getValue(): number;
        onDidChangeConfiguration(): { dispose(): void };
      },
    ) => ClassicTokenizer;
  };
  // Classic tokenize needs no DOM, embedded language service, or token theme.
  return new MonarchTokenizer({}, {}, id, compile(id, definition), {
    getValue: () => 10000,
    onDidChangeConfiguration: () => ({ dispose() {} }),
  });
}
function spans(tokenizer: ClassicTokenizer, text: string) {
  let state = tokenizer.getInitialState();
  return text.split("\n").map((line) => {
    const result = tokenizer.tokenize(line, true, state);
    state = result.endState;
    return result.tokens.map((token, index) => ({
      start: token.offset,
      end: result.tokens[index + 1]?.offset ?? line.length,
      type: token.type,
    }));
  });
}

it("preserves legacy token classes and UTF-16 ranges for all nine rules", async () => {
  const wire = JSON.parse(await readFile(tokenizerFile, "utf8")) as StaticLanguageTokenizerV1;
  const old = await monarch("basic-plus", legacyDefinition);
  const current = await monarch("bp", basicPlusFixtureDefinition(wire));
  try {
    const samples = [
      " \t\r",
      "' 中文😀 If True @",
      'caption = "say ""hello"""',
      'caption = "unfinished""\nEndIf',
      '""',
      '"""',
      "rEgIoN Demo\nIf True And count != @value Then\nEndRegion",
      "If.member ElseIf.member foo.bar _value",
      "0 12 3.14 .5 12.",
      "!= <= >= <> += -= *= /= ++ -- = < > + - * / %",
      "@ @@ @name \\@ $",
      "(value)[index],.:",
      "中文😀",
      "LCD.Clear()\r\nReturn 1",
      ...BASIC_PLUS_KEYWORDS.flatMap((word) => [word, word.toLowerCase(), word.toUpperCase()]),
    ];
    for (const sample of samples)
      expect(spans(current, sample), sample).toEqual(spans(old, sample));
    expect(
      spans(current, "nUmBeR tRuE aNd iF dIm x")[0]!
        .filter((token) => token.type !== "white.basic-plus")
        .map((token) => token.type),
    ).toEqual([
      "type.basic-plus",
      "constant.language.basic-plus",
      "operator.word.basic-plus",
      "keyword.control.basic-plus",
      "keyword.basic-plus",
      "identifier.basic-plus",
    ]);
    expect(spans(current, '"say ""hello"""')[0]).toEqual([
      { start: 0, end: 15, type: "string.basic-plus" },
    ]);
    expect(spans(current, '"unfinished""\nEndIf').map((line) => line[0]!.type)).toEqual([
      "string.invalid.basic-plus",
      "keyword.control.basic-plus",
    ]);
    expect(
      spans(current, "@ @@ @name")[0]!
        .filter((token) => token.type === "operator.basic-plus")
        .map(({ start, end }) => [start, end]),
    ).toEqual([
      [0, 1],
      [2, 4],
      [5, 6],
    ]);
  } finally {
    old.dispose();
    current.dispose();
  }
});

it("keeps the Basic Plus root state after skipped long lines", async () => {
  const wire = JSON.parse(await readFile(tokenizerFile, "utf8")) as StaticLanguageTokenizerV1;
  const current = await monarch("bp", basicPlusFixtureDefinition(wire));
  try {
    for (const length of [9999, 10000, 10001]) {
      const sample = `"${"x".repeat(length - 1)}\nIf True Then`;
      const result = spans(current, sample);
      expect(result[0]![0]!.type).toBe(length < 10000 ? "string.invalid.basic-plus" : "");
      expect(result[1]![0]!.type).toBe("keyword.control.basic-plus");
    }
    const astral = `"${"😀".repeat(4999)}x`;
    expect(astral.length).toBe(10000);
    expect(spans(current, astral)[0]![0]!.type).toBe("");
  } finally {
    current.dispose();
  }
});

it("removes the handwritten production grammar and registration bridge", async () => {
  const registration = await readFile(
    new URL("./companions/basic-plus/registration.ts", import.meta.url),
    "utf8",
  );
  expect(registration.trim()).toBe('export { basicPlusThemeRules } from "./theme.js";');
});

it("leaves the companion's dynamic behavior intact without a lexical id", () => {
  const dynamic: Omit<LanguageCompanion, "monacoLanguage"> = basicPlusCompanion;
  expect(dynamic).not.toHaveProperty("monacoLanguage");
  expect(dynamic.legend).toBe(legend);
  expect(dynamic.completions).toBe(basicPlusCompletions);
  expect(dynamic.signatureHelp).toBe(basicPlusSignatureHelp);
  expect(dynamic.structuralChange).toBe(structuralChange);
  expect(dynamic.rangeFormatting).toBe(basicPlusRangeFormattingEdits);
  expect(dynamic.triggerCharacters).toEqual([".", "@"]);
  expect(dynamic.signatureTriggers).toEqual(["(", ","]);
  expect(dynamic.signatureRetriggers).toEqual([")"]);
  for (const size of [2, 4] as const) {
    const source = "If True Then\nLCD.Clear()\nEndIf\n";
    expect(dynamic.formatSource(source, size)).toBe(formatBasicPlus(source, { indentSize: size }));
  }
});

it("restores renamed drafts across failed generations without registering a shell twice", async () => {
  // Boundary test: the persisted session is real; failed generations are supplied
  // by a contract-level caller. Registrar/model reconciliation belongs to T4/T5.
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const location = { line: 2, column: 3, endLine: 2, endColumn: 6, scrollTop: 12, scrollLeft: 0 };
  const restored = workspaceSessionSchema.parse({
    projects: [
      {
        workspaceId,
        files: ["renamed.bpi"],
        activeFile: "renamed.bpi",
        selectedTreePath: "renamed.bpi",
        expandedTreePaths: [""],
        locations: { "renamed.bpi": location },
        monacoLanguage: "basic-plus",
      },
    ],
    activeWorkspaceId: workspaceId,
  });
  expect(restored.projects[0]).not.toHaveProperty("monacoLanguage");
  expect(restored.projects[0]!.locations["renamed.bpi"]).toEqual(location);
  const documents = new Documents();
  const draft = "If True Then\n  LCD.Clear()\nEndIf\n";
  documents.replace([{ file: "renamed.bpi", content: draft, saved: "LCD.Clear()\n" }]);
  const tab = documents.getSnapshot()[0]!;
  expect(tab.dirty).toBe(true);
  const defineTheme = vi.fn();
  for (const generation of [1, 2, 3, 4]) {
    // T6 initialization has no dependency on generation/catalog success. A caller
    // may replay it after failed loads; it must never allocate another id shell.
    initializeEditorThemes({ defineTheme });
    expect(documents.getSnapshot()[0], `generation ${generation}`).toBe(tab);
    expect(tab.content).toBe(draft);
    expect(tab.file).toBe(restored.projects[0]!.activeFile);
  }
  expect(defineTheme).toHaveBeenCalledTimes(8);
  expect(basicPlusCompanion).not.toHaveProperty("monacoLanguage");
  const manifest = JSON.parse(
    await readFile(new URL("plugins/basic-plus/kobrixa-plugin.json", repository), "utf8"),
  );
  expect(manifest.contributes.languages[0].id).toBe("bp");
  expect(manifest.contributes.languages[0].extensions).toContain("bpi");
  for (const call of Object.values(lexicalCalls)) expect(call).not.toHaveBeenCalled();
});
