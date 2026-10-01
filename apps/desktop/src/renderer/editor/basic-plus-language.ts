import type { editor, languages } from "monaco-editor";
import { BASIC_PLUS_KEYWORDS } from "@kobrixa/basic-plus/language";

export const basicPlusMonarch: languages.IMonarchLanguage = {
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
      // A closed literal must not consume a prefix of an unterminated escaped quote.
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

export function basicPlusThemeRules(dark: boolean): editor.ITokenThemeRule[] {
  const color = (darkColor: string, lightColor: string) => (dark ? darkColor : lightColor);
  const rules: editor.ITokenThemeRule[] = [
    { token: "keyword.basic-plus", foreground: color("569CD6", "0000FF") },
    { token: "keyword.control.basic-plus", foreground: color("C586C0", "AF00DB") },
    { token: "constant.language.basic-plus", foreground: color("569CD6", "0000FF") },
    { token: "operator.word.basic-plus", foreground: color("569CD6", "0000FF") },
    { token: "operator.basic-plus", foreground: color("E6EAF0", "1E2933") },
    { token: "delimiter.basic-plus", foreground: color("E6EAF0", "1E2933") },
    { token: "string.basic-plus", foreground: color("CE9178", "A31515") },
    { token: "string.invalid.basic-plus", foreground: color("CE9178", "A31515") },
    { token: "number.basic-plus", foreground: color("B5CEA8", "098658") },
    { token: "comment.basic-plus", foreground: color("6A9955", "008000") },
    { token: "identifier.basic-plus", foreground: color("9CDCFE", "001080") },
    { token: "invalid.basic-plus", foreground: color("F44747", "CD3131") },
  ];
  // Standalone Monaco matches semantic types/modifiers directly against theme rules.
  for (const [type, foreground] of [
    ["type", color("4EC9B0", "267F99")],
    ["namespace", color("4EC9B0", "267F99")],
    ["function", color("DCDCAA", "795E26")],
    ["method", color("DCDCAA", "795E26")],
    ["variable", color("9CDCFE", "001080")],
    ["parameter", color("9CDCFE", "001080")],
    ["label", color("C8C8C8", "000000")],
  ]) {
    rules.push(
      { token: type!, foreground: foreground! },
      { token: `${type}.basic-plus`, foreground: foreground! },
    );
  }
  return rules.map((rule) => ({ ...rule, fontStyle: "" }));
}
