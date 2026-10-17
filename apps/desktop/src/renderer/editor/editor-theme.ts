import type { editor } from "monaco-editor";
import { basicPlusThemeRules } from "./companions/basic-plus/theme.js";

export interface EditorThemeApi {
  defineTheme(name: string, data: editor.IStandaloneThemeData): void;
}

export function initializeEditorThemes(api: EditorThemeApi): void {
  for (const theme of ["light", "dark"] as const) {
    const dark = theme === "dark";
    api.defineTheme(`kobrixa-${theme}`, {
      base: dark ? "vs-dark" : "vs",
      inherit: true,
      rules: basicPlusThemeRules(dark),
      colors: {
        "editor.background": dark ? "#18212b" : "#fdfaf4",
        "editor.foreground": dark ? "#e6eaf0" : "#1e2933",
        "editorLineNumber.foreground": dark ? "#697a8b" : "#91958f",
        "editorLineNumber.activeForeground": dark ? "#88acff" : "#2457d6",
        "editor.lineHighlightBackground": dark ? "#202c3a" : "#f0ede5",
        "editor.selectionBackground": dark ? "#344a72" : "#cddbf8",
        "editorCursor.foreground": dark ? "#88acff" : "#2457d6",
        "editorWidget.background": dark ? "#222e3b" : "#fdfaf4",
        "editorWidget.border": dark ? "#3a4857" : "#d7d1c7",
      },
    });
  }
}
