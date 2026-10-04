import { expect, it } from "vitest";
import { editorOptions } from "./editor-options.js";
import { defaultSettings } from "../settings/settings.js";
it("maps editor preferences and preserves legacy defaults", () => {
  const values = defaultSettings("en");
  expect(editorOptions(values, 16, false, false)).toMatchObject({
    lineHeight: 25,
    cursorBlinking: "blink",
    quickSuggestions: { other: "on", strings: "off", comments: "off" },
    stickyScroll: { enabled: true, maxLineCount: 3 },
    smoothScrolling: false,
  });
  Object.assign(values, {
    lineHeight: "relaxed",
    cursorStyle: "block",
    cursorBlinking: false,
    renderLineHighlight: "all",
    bracketPairColorization: false,
    bracketGuides: false,
    indentationGuides: false,
    folding: false,
    stickyScroll: false,
    autoClosingBrackets: false,
    autoClosingQuotes: false,
    autoSuggestions: false,
    hover: false,
    parameterHints: false,
    smoothScrolling: true,
    scrollBeyondLastLine: true,
  });
  expect(editorOptions(values, 20, true, false)).toMatchObject({
    fontSize: 20,
    lineHeight: 36,
    cursorStyle: "block",
    cursorBlinking: "solid",
    renderLineHighlight: "all",
    bracketPairColorization: { enabled: false },
    guides: { bracketPairs: false, indentation: false },
    folding: false,
    stickyScroll: { enabled: false },
    autoClosingBrackets: "never",
    autoClosingQuotes: "never",
    quickSuggestions: { other: "off" },
    suggestOnTriggerCharacters: false,
    hover: { enabled: false },
    parameterHints: { enabled: false },
    smoothScrolling: true,
    scrollBeyondLastLine: true,
    wordWrap: "on",
  });
});
it("temporarily overrides motion without overwriting the preference", () => {
  const values = { ...defaultSettings("en"), smoothScrolling: true };
  expect(editorOptions(values, 16, false, true)).toMatchObject({
    cursorBlinking: "solid",
    smoothScrolling: false,
  });
  expect(editorOptions(values, 16, false, false)).toMatchObject({
    cursorBlinking: "blink",
    smoothScrolling: true,
  });
});
