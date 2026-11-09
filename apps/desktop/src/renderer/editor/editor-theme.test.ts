import { expect, it, vi } from "vitest";
import type { editor } from "monaco-editor";
import { initializeEditorThemes } from "./editor-theme.js";
import { basicPlusThemeRules } from "./companions/basic-plus/theme.js";

const colors = [
  ["keyword.basic-plus", "569CD6", "0000FF"],
  ["keyword.control.basic-plus", "C586C0", "AF00DB"],
  ["constant.language.basic-plus", "569CD6", "0000FF"],
  ["operator.word.basic-plus", "569CD6", "0000FF"],
  ["operator.basic-plus", "E6EAF0", "1E2933"],
  ["delimiter.basic-plus", "E6EAF0", "1E2933"],
  ["string.basic-plus", "CE9178", "A31515"],
  ["string.invalid.basic-plus", "CE9178", "A31515"],
  ["number.basic-plus", "B5CEA8", "098658"],
  ["comment.basic-plus", "6A9955", "008000"],
  ["identifier.basic-plus", "9CDCFE", "001080"],
  ["invalid.basic-plus", "F44747", "CD3131"],
] as const;
const semantic = [
  ["type", "4EC9B0", "267F99"],
  ["namespace", "4EC9B0", "267F99"],
  ["function", "DCDCAA", "795E26"],
  ["method", "DCDCAA", "795E26"],
  ["variable", "9CDCFE", "001080"],
  ["parameter", "9CDCFE", "001080"],
  ["label", "C8C8C8", "000000"],
] as const;

it.each([false, true])("preserves every lexical and semantic theme rule: dark=%s", (dark) => {
  expect(basicPlusThemeRules(dark)).toEqual([
    ...colors.map(([token, night, day]) => ({
      token,
      foreground: dark ? night : day,
      fontStyle: "",
    })),
    ...semantic.flatMap(([token, night, day]) =>
      [token, `${token}.basic-plus`].map((name) => ({
        token: name,
        foreground: dark ? night : day,
        fontStyle: "",
      })),
    ),
  ]);
});

it("initializes both themes with only defineTheme, even when no grammar is available", () => {
  const defineTheme = vi.fn<(name: string, data: editor.IStandaloneThemeData) => void>();
  initializeEditorThemes({ defineTheme });
  expect(defineTheme.mock.calls).toEqual([
    [
      "kobrixa-light",
      {
        base: "vs",
        inherit: true,
        rules: basicPlusThemeRules(false),
        colors: {
          "editor.background": "#fdfaf4",
          "editor.foreground": "#1e2933",
          "editorLineNumber.foreground": "#91958f",
          "editorLineNumber.activeForeground": "#2457d6",
          "editor.lineHighlightBackground": "#f0ede5",
          "editor.selectionBackground": "#cddbf8",
          "editorCursor.foreground": "#2457d6",
          "editorWidget.background": "#fdfaf4",
          "editorWidget.border": "#d7d1c7",
        },
      },
    ],
    [
      "kobrixa-dark",
      {
        base: "vs-dark",
        inherit: true,
        rules: basicPlusThemeRules(true),
        colors: {
          "editor.background": "#18212b",
          "editor.foreground": "#e6eaf0",
          "editorLineNumber.foreground": "#697a8b",
          "editorLineNumber.activeForeground": "#88acff",
          "editor.lineHighlightBackground": "#202c3a",
          "editor.selectionBackground": "#344a72",
          "editorCursor.foreground": "#88acff",
          "editorWidget.background": "#222e3b",
          "editorWidget.border": "#3a4857",
        },
      },
    ],
  ]);
});
