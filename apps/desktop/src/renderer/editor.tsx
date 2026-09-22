import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as monaco from "monaco-editor";
import {
  BASIC_PLUS_API_COMPLETIONS,
  BASIC_PLUS_KEYWORDS,
  formatBasicPlus,
} from "@kobrixa/basic-plus/language";
import type { Theme } from "./theme.js";
import type { Diagnostic } from "../shared/api.js";

let registered = false;
function registerLanguage(): void {
  if (registered) return;
  registered = true;
  monaco.languages.register({ id: "basic-plus", extensions: [".bp", ".bpi", ".bpm"] });
  monaco.languages.setLanguageConfiguration("basic-plus", {
    comments: { lineComment: "'" },
    brackets: [
      ["(", ")"],
      ["[", "]"],
    ],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
      { open: '"', close: '"', notIn: ["string", "comment"] },
    ],
    surroundingPairs: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
      { open: '"', close: '"' },
    ],
    indentationRules: {
      increaseIndentPattern:
        /^\s*(?:If\b.*\bThen\s*$|Else\s*$|ElseIf\b.*\bThen\s*$|While\b|For\b|Sub\b|Function\b|Module\b)/i,
      decreaseIndentPattern:
        /^\s*(?:Else\s*$|ElseIf\b|EndIf\b|EndWhile\b|EndFor\b|EndSub\b|EndFunction\b|EndModule\b)/i,
    },
  });
  const ev3Namespaces = [
    ...new Set(BASIC_PLUS_API_COMPLETIONS.map((item) => item.label.split(".")[0]!)),
  ];
  monaco.languages.setMonarchTokensProvider("basic-plus", {
    ignoreCase: true,
    keywords: [...BASIC_PLUS_KEYWORDS],
    ev3Namespaces,
    tokenizer: {
      root: [
        [/[ \t\r]+/, "white"],
        [/'[^\n]*/, "comment"],
        [/[A-Za-z_]\w*(?=\s*\()/, { cases: { "@keywords": "keyword", "@default": "function" } }],
        [
          /[A-Za-z_]\w*/,
          {
            cases: {
              "@keywords": "keyword",
              "@ev3Namespaces": "ev3.namespace",
              "@default": "identifier",
            },
          },
        ],
        [/(?:\d+\.\d*|\.\d+|\d+)/, "number"],
        [/"(?:[^"]|"")*"/, "string"],
        [/"[^\n]*$/, "string.invalid"],
        [/[=<>+\-*/%]+/, "operator"],
        [/[()[\],.:]/, "delimiter"],
      ],
    },
  });
  for (const theme of ["light", "dark"] as const) {
    const dark = theme === "dark";
    monaco.editor.defineTheme(`kobrixa-${theme}`, {
      base: dark ? "vs-dark" : "vs",
      inherit: true,
      rules: [
        { token: "keyword", foreground: dark ? "88ACFF" : "2457D6" },
        { token: "ev3.namespace", foreground: dark ? "88ACFF" : "2457D6", fontStyle: "bold" },
        { token: "function", foreground: dark ? "F2CA6A" : "875A0B" },
        { token: "string", foreground: dark ? "EBA884" : "994622" },
        { token: "number", foreground: dark ? "C6ACF1" : "7752A0" },
        { token: "comment", foreground: dark ? "8998A7" : "68746B", fontStyle: "italic" },
      ],
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
  monaco.languages.registerCompletionItemProvider("basic-plus", {
    triggerCharacters: ["."],
    provideCompletionItems: (model, position) => {
      const beforeCursor = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const prefix = beforeCursor.match(/[A-Za-z_][\w.]*$/)?.[0] ?? "";
      const range = new monaco.Range(
        position.lineNumber,
        position.column - prefix.length,
        position.lineNumber,
        position.column,
      );
      const keywordSuggestions = prefix.includes(".")
        ? []
        : BASIC_PLUS_KEYWORDS.map((label) => ({
            label,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: label,
            range,
          }));
      const apiSuggestions = BASIC_PLUS_API_COMPLETIONS.map((completion) => ({
        label: completion.label,
        kind: monaco.languages.CompletionItemKind.Method,
        insertText: completion.insertText,
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        detail: completion.signature,
        documentation: {
          value: `**${completion.signature}**\n\n${completion.documentation}`,
        },
        range,
      }));
      return { suggestions: [...keywordSuggestions, ...apiSuggestions] };
    },
  });
  monaco.languages.registerDocumentFormattingEditProvider("basic-plus", {
    provideDocumentFormattingEdits: (model, options) => [
      {
        range: model.getFullModelRange(),
        text: formatBasicPlus(model.getValue(), { indentSize: options.tabSize === 4 ? 4 : 2 }),
      },
    ],
  });
}

export interface CursorPosition {
  line: number;
  column: number;
}

export interface EditorFocusTarget {
  file: string;
  range: Diagnostic["range"];
  requestId: number;
}

export interface EditorHandle {
  focus(): void;
  format(): Promise<void>;
  reveal(range: Diagnostic["range"]): void;
  remapFiles(moved: Readonly<Record<string, string>>): void;
}

interface EditorProps {
  theme: Theme;
  fontSize: number;
  wordWrap: boolean;
  indentSize: 2 | 4;
  reducedMotion: boolean;
  readOnly: boolean;
  file: string;
  value: string;
  openFiles: string[];
  diagnostics: Diagnostic[];
  focusTarget: EditorFocusTarget | undefined;
  ariaLabel: string;
  onChange(file: string, value: string): void;
  onCursorChange(position: CursorPosition): void;
}

function modelUri(file: string): monaco.Uri {
  return monaco.Uri.from({ scheme: "kobrixa", path: `/${file}` });
}

function languageFor(file: string): string {
  return file.toLocaleLowerCase("en-US").endsWith(".json") ? "json" : "basic-plus";
}

function markerSeverity(severity: Diagnostic["severity"]): monaco.MarkerSeverity {
  if (severity === "error") return monaco.MarkerSeverity.Error;
  if (severity === "warning") return monaco.MarkerSeverity.Warning;
  return monaco.MarkerSeverity.Info;
}

function toMonacoRange(range: Diagnostic["range"]): monaco.Range {
  return new monaco.Range(range.startLine, range.startColumn, range.endLine, range.endColumn);
}

export const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(
  {
    file,
    value,
    openFiles,
    diagnostics,
    focusTarget,
    ariaLabel,
    theme,
    fontSize,
    wordWrap,
    indentSize,
    reducedMotion,
    readOnly,
    onChange,
    onCursorChange,
  },
  handleRef,
): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const models = useRef(new Map<string, monaco.editor.ITextModel>());
  const viewStates = useRef(new Map<string, monaco.editor.ICodeEditorViewState>());
  const activeFile = useRef<string | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  const onCursorChangeRef = useRef(onCursorChange);
  onChangeRef.current = onChange;
  onCursorChangeRef.current = onCursorChange;

  const reveal = (range: Diagnostic["range"]): void => {
    const instance = editor.current;
    const model = instance?.getModel();
    if (!instance || !model) return;
    const validated = model.validateRange(toMonacoRange(range));
    instance.setSelection(validated);
    instance.revealRangeInCenter(validated, monaco.editor.ScrollType.Smooth);
    instance.focus();
  };

  useImperativeHandle(
    handleRef,
    () => ({
      focus: () => editor.current?.focus(),
      format: async () => {
        await editor.current?.getAction("editor.action.formatDocument")?.run();
      },
      reveal,
      remapFiles: (moved) => {
        const instance = editor.current;
        const currentFile = activeFile.current;
        if (instance && currentFile) {
          const state = instance.saveViewState();
          if (state) viewStates.current.set(currentFile, state);
        }
        for (const [source, target] of Object.entries(moved)) {
          const model = models.current.get(source);
          if (model) {
            models.current.delete(source);
            models.current.set(target, model);
            monaco.editor.setModelLanguage(model, languageFor(target));
          }
          const state = viewStates.current.get(source);
          if (state) {
            viewStates.current.delete(source);
            viewStates.current.set(target, state);
          }
        }
        if (currentFile && moved[currentFile]) activeFile.current = moved[currentFile];
      },
    }),
    [],
  );

  useEffect(() => {
    registerLanguage();
    if (!container.current) return undefined;
    const instance = monaco.editor.create(container.current, {
      model: null,
      theme: `kobrixa-${theme}`,
      readOnly,
      ariaLabel,
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily: "JetBrains Mono, SFMono-Regular, Consolas, monospace",
      fontSize,
      lineHeight: Math.round((fontSize * 25) / 16),
      padding: { top: 16 },
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true },
      glyphMargin: true,
      folding: true,
      lineNumbersMinChars: 3,
      wordWrap: wordWrap ? "on" : "off",
      detectIndentation: false,
      tabSize: indentSize,
      insertSpaces: true,
      smoothScrolling: !reducedMotion,
      cursorSmoothCaretAnimation: reducedMotion ? "off" : "on",
      renderWhitespace: "selection",
      renderValidationDecorations: "on",
      scrollBeyondLastLine: false,
      formatOnPaste: true,
      stickyScroll: { enabled: true, maxLineCount: 3 },
      overviewRulerBorder: false,
    });
    editor.current = instance;
    instance.focus();
    const contentSubscription = instance.onDidChangeModelContent(() => {
      const currentFile = activeFile.current;
      if (currentFile) onChangeRef.current(currentFile, instance.getValue());
    });
    const cursorSubscription = instance.onDidChangeCursorPosition(({ position }) =>
      onCursorChangeRef.current({ line: position.lineNumber, column: position.column }),
    );
    return () => {
      contentSubscription.dispose();
      cursorSubscription.dispose();
      instance.dispose();
      for (const model of models.current.values()) model.dispose();
      models.current.clear();
      viewStates.current.clear();
    };
  }, []);

  useEffect(() => {
    const instance = editor.current;
    if (!instance) return;
    const previousFile = activeFile.current;
    if (previousFile) {
      const state = instance.saveViewState();
      if (state) viewStates.current.set(previousFile, state);
    }
    let model = models.current.get(file);
    if (!model) {
      model = monaco.editor.createModel(value, languageFor(file), modelUri(file));
      models.current.set(file, model);
    }
    model.updateOptions({ tabSize: indentSize, indentSize, insertSpaces: true });
    activeFile.current = file;
    instance.setModel(model);
    const savedState = viewStates.current.get(file);
    if (savedState) instance.restoreViewState(savedState);
    const position = instance.getPosition();
    if (position) onCursorChangeRef.current({ line: position.lineNumber, column: position.column });
  }, [file]);

  useEffect(() => {
    const open = new Set(openFiles);
    for (const [modelFile, model] of models.current) {
      if (open.has(modelFile)) continue;
      models.current.delete(modelFile);
      viewStates.current.delete(modelFile);
      model.dispose();
    }
  }, [openFiles]);

  useEffect(() => {
    editor.current?.updateOptions({ ariaLabel, readOnly });
  }, [ariaLabel, readOnly]);
  useEffect(() => {
    editor.current?.updateOptions({ fontSize, lineHeight: Math.round((fontSize * 25) / 16) });
  }, [fontSize]);
  useEffect(() => {
    editor.current?.updateOptions({
      wordWrap: wordWrap ? "on" : "off",
      smoothScrolling: !reducedMotion,
      cursorSmoothCaretAnimation: reducedMotion ? "off" : "on",
    });
    for (const model of models.current.values())
      model.updateOptions({ tabSize: indentSize, indentSize, insertSpaces: true });
  }, [wordWrap, indentSize, reducedMotion]);
  useEffect(() => {
    monaco.editor.setTheme(`kobrixa-${theme}`);
  }, [theme]);

  useEffect(() => {
    const model = models.current.get(file);
    if (model && model.getValue() !== value) model.setValue(value);
  }, [file, value]);

  useEffect(() => {
    for (const [modelFile, model] of models.current) {
      monaco.editor.setModelMarkers(
        model,
        "kobrixa",
        diagnostics
          .filter((item) => item.file === modelFile)
          .map((item) => ({
            severity: markerSeverity(item.severity),
            message: `${item.code}: ${item.message}`,
            startLineNumber: item.range.startLine,
            startColumn: item.range.startColumn,
            endLineNumber: item.range.endLine,
            endColumn: item.range.endColumn,
          })),
      );
    }
  }, [diagnostics, file, openFiles]);

  useEffect(() => {
    if (focusTarget?.file === file) reveal(focusTarget.range);
  }, [file, focusTarget]);

  return <div className="editor" ref={container} />;
});
