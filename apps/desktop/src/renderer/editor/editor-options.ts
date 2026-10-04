import type { editor } from "monaco-editor";
import { EDITOR_DEFAULTS, type EditorPreferences, type Settings } from "../settings/settings.js";

export type EditorSettings = Partial<EditorPreferences> &
  Pick<Settings, "lineNumbers" | "minimap" | "renderWhitespace" | "formatOnPaste">;
export function editorOptions(
  preferences: EditorSettings | undefined,
  fontSize: number,
  wordWrap: boolean,
  reducedMotion: boolean,
): editor.IEditorOptions {
  const value = { ...EDITOR_DEFAULTS, ...preferences };
  return {
    fontSize,
    lineHeight: Math.round(
      fontSize *
        (value.lineHeight === "compact" ? 1.4 : value.lineHeight === "relaxed" ? 1.8 : 25 / 16),
    ),
    wordWrap: wordWrap ? "on" : "off",
    lineNumbers: value.lineNumbers ?? "on",
    minimap: { enabled: value.minimap ?? false },
    renderWhitespace: value.renderWhitespace ?? "selection",
    formatOnPaste: value.formatOnPaste ?? true,
    cursorStyle: value.cursorStyle,
    cursorBlinking: value.cursorBlinking && !reducedMotion ? "blink" : "solid",
    cursorSmoothCaretAnimation: "off",
    renderLineHighlight: value.renderLineHighlight,
    bracketPairColorization: { enabled: value.bracketPairColorization },
    guides: { bracketPairs: value.bracketGuides, indentation: value.indentationGuides },
    folding: value.folding,
    stickyScroll: { enabled: value.stickyScroll, maxLineCount: 3 },
    autoClosingBrackets: value.autoClosingBrackets ? "languageDefined" : "never",
    autoClosingQuotes: value.autoClosingQuotes ? "languageDefined" : "never",
    quickSuggestions: {
      other: value.autoSuggestions ? "on" : "off",
      comments: "off",
      strings: "off",
    },
    suggestOnTriggerCharacters: value.autoSuggestions,
    hover: { enabled: value.hover },
    parameterHints: { enabled: value.parameterHints },
    smoothScrolling: value.smoothScrolling && !reducedMotion,
    scrollBeyondLastLine: value.scrollBeyondLastLine,
  };
}
