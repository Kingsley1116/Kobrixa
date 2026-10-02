import { completionWidget } from "./completion-widget.js";
import type { CompletionSession } from "./completion-session.js";
import type { BasicPlusProjectAnalysis } from "@kobrixa/basic-plus";
import { basicPlusMonarch, basicPlusThemeRules } from "./basic-plus-language.js";
import type { Documents, DocumentBuffer } from "./documents.js";
import type { AnalysisSession } from "./analysis-session.js";
import { ModelSnapshots } from "./model-snapshots.js";
import { BasicPlusSemanticTokens } from "./semantic-tokens.js";
import { BasicPlusLanguageFeatures, normalizeSource } from "./language-features.js";
import { bindWorkspaceEdits, renameSnapshot, validateTextEdits } from "./workspace-edits.js";
import type { Settings } from "../settings/settings.js";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import { BASIC_PLUS_INDENTATION_RULES, formatBasicPlus } from "@kobrixa/basic-plus/language";
import { basicPlusRangeFormattingEdits } from "./basic-plus-formatting.js";
import type { Theme } from "../settings/theme.js";
import type { Diagnostic } from "../../shared/api.js";

// Without worker factories Monaco falls back to running worker tasks on the UI
// thread. Vite bundles these for both the dev server and the packaged file URL.
self.MonacoEnvironment = {
  getWorker: (_workerId, label) => (label === "json" ? new JsonWorker() : new EditorWorker()),
};

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
    indentationRules: BASIC_PLUS_INDENTATION_RULES,
  });
  monaco.languages.setMonarchTokensProvider("basic-plus", basicPlusMonarch);
  for (const theme of ["light", "dark"] as const) {
    const dark = theme === "dark";
    monaco.editor.defineTheme(`kobrixa-${theme}`, {
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
  monaco.languages.registerDocumentFormattingEditProvider("basic-plus", {
    provideDocumentFormattingEdits: (model, options) => [
      {
        range: model.getFullModelRange(),
        text: formatBasicPlus(model.getValue(), { indentSize: options.tabSize === 4 ? 4 : 2 }),
      },
    ],
  });
  monaco.languages.registerDocumentRangeFormattingEditProvider("basic-plus", {
    provideDocumentRangeFormattingEdits: basicPlusRangeFormattingEdits,
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
  applySavedFormat(file: string, before: string, after: string): void;
  focus(): void;
  format(): Promise<void>;
  reveal(range: Diagnostic["range"]): void;
  remapFiles(moved: Readonly<Record<string, string>>): void;
}

export interface EditorAnalysis {
  analysis: BasicPlusProjectAnalysis;
  overlays: Record<string, string>;
}

interface EditorProps {
  documents: Documents;
  analysisSession: AnalysisSession;
  completionSession?: CompletionSession;
  editorOptions?: Pick<Settings, "lineNumbers" | "minimap" | "renderWhitespace" | "formatOnPaste">;
  onEditorReady?(editor: monaco.editor.IStandaloneCodeEditor): () => void;
  onBlur?(file: string): void;
  onOpenLocation?(file: string, range: Diagnostic["range"]): Promise<boolean>;
  onWorkspaceEdit?(snapshot: EditorAnalysis, apply: () => Record<string, string>): Promise<void>;
  theme: Theme;
  fontSize: number;
  wordWrap: boolean;
  indentSize: 2 | 4;
  reducedMotion: boolean;
  readOnly: boolean;
  file: string;
  openFiles: string[];
  diagnostics: Diagnostic[];
  focusTarget: EditorFocusTarget | undefined;
  ariaLabel: string;
  onChange(file: string): void;
  onCursorChange(position: CursorPosition): void;
}

let modelSequence = 0;
function modelUri(file: string): monaco.Uri {
  return monaco.Uri.from({
    scheme: "kobrixa",
    path: `/${file}`,
    query: `model=${++modelSequence}`,
  });
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
    documents,
    analysisSession,
    completionSession,
    editorOptions,
    onEditorReady,
    onBlur,
    onOpenLocation,
    onWorkspaceEdit,
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
  const [modelSnapshots] = useState(() => new ModelSnapshots());
  const [semanticTokens] = useState(() => new BasicPlusSemanticTokens());
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const models = useRef(new Map<string, monaco.editor.ITextModel>());
  const viewStates = useRef(new Map<string, monaco.editor.ICodeEditorViewState>());
  const activeFile = useRef<string | undefined>(undefined);
  const applyingValue = useRef(false);
  const composing = useRef(false);
  const suggestions = useRef<ReturnType<typeof completionWidget> | undefined>(undefined);
  const features = useRef<BasicPlusLanguageFeatures | undefined>(undefined);
  const modelSubscriptions = useRef(new Map<monaco.editor.ITextModel, monaco.IDisposable>());
  const currentProps = useRef({ readOnly, onOpenLocation, onWorkspaceEdit });
  currentProps.current = { readOnly, onOpenLocation, onWorkspaceEdit };
  const buffers = useRef(new Map<monaco.editor.ITextModel, DocumentBuffer>());
  const fileFor = (model: monaco.editor.ITextModel): string | undefined =>
    [...models.current].find(([, item]) => item === model)?.[0];
  const ensureModel = (file: string, content: string): monaco.editor.ITextModel => {
    const existing = models.current.get(file);
    if (existing) {
      const buffer = buffers.current.get(existing);
      if (buffer) documents.bind(file, buffer);
      return existing;
    }
    const model = monaco.editor.createModel(content, languageFor(file), modelUri(file));
    models.current.set(file, model);
    modelSnapshots.bind(model, file, content);
    const snapshot = analysisSession.getCurrent();
    if (snapshot?.analysis.index.sources[file] === content) modelSnapshots.accept(model, snapshot);
    semanticTokens.bind(model, file);
    const buffer: DocumentBuffer = {
      getValue: () => model.getValue(undefined, true),
      getValueLength: () => model.getValueLength(undefined, true),
      getVersionId: () => model.getVersionId(),
      getAlternativeVersionId: () => model.getAlternativeVersionId(),
      setValue: (value) => {
        applyingValue.current = true;
        try {
          model.setValue(value);
        } finally {
          applyingValue.current = false;
        }
      },
    };
    buffers.current.set(model, buffer);
    documents.bind(file, buffer);
    modelSubscriptions.current.set(
      model,
      model.onDidChangeContent(() => {
        if (applyingValue.current) return;
        features.current?.update(undefined);
        const currentFile = fileFor(model);
        if (currentFile) {
          documents.changed(currentFile);
          onChangeRef.current(currentFile);
        }
      }),
    );
    completionSession?.bind(file, model);
    return model;
  };
  const disposeModel = (file: string, model: monaco.editor.ITextModel) => {
    completionSession?.unbind(file, model);
    documents.unbind(file);
    buffers.current.delete(model);
    models.current.delete(file);
    viewStates.current.delete(file);
    modelSubscriptions.current.get(model)?.dispose();
    modelSubscriptions.current.delete(model);
    modelSnapshots.unbind(model);
    semanticTokens.unbind(model);
    model.dispose();
  };
  const onBlurRef = useRef(onBlur);
  onBlurRef.current = onBlur;
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
      applySavedFormat: (file, before, after) => {
        const model = models.current.get(file);
        if (!model || model.getValue(undefined, true) !== before || before === after) return;
        const edits = [{ range: model.getFullModelRange(), text: after }];
        if (editor.current?.getModel() === model) {
          editor.current.pushUndoStop();
          editor.current.executeEdits("kobrixa.formatOnSave", edits);
          editor.current.pushUndoStop();
        } else {
          model.pushStackElement();
          model.pushEditOperations(null, edits, () => null);
          model.pushStackElement();
        }
      },
      focus: () => editor.current?.focus(),
      format: async () => {
        await editor.current?.getAction("editor.action.formatDocument")?.run();
      },
      reveal,
      remapFiles: (moved) => {
        features.current?.update(undefined);
        const instance = editor.current;
        const currentFile = activeFile.current;
        if (instance && currentFile) {
          const state = instance.saveViewState();
          if (state) viewStates.current.set(currentFile, state);
        }
        for (const [source, target] of Object.entries(moved)) {
          const model = models.current.get(source);
          if (model) {
            documents.unbind(source);
            models.current.delete(source);
            models.current.set(target, model);
            completionSession?.unbind(source, model);
            completionSession?.bind(target, model);
            modelSnapshots.remap(model, target);
            semanticTokens.bind(model, target);
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
    const semanticRegistration = monaco.languages.registerDocumentSemanticTokensProvider(
      { language: "basic-plus", scheme: "kobrixa" },
      semanticTokens,
    );
    const languageFeatures = new BasicPlusLanguageFeatures({
      fileFor,
      ensureModel,
      completionSymbols: (model, position) => {
        const file = fileFor(model);
        const symbols = file && completionSession?.symbols(file, position);
        if (!symbols) completionSession?.request();
        return symbols || undefined;
      },
      isCurrent: (model, file, snapshot) =>
        analysisSession.getCurrent() === snapshot &&
        modelSnapshots.isCurrent(model, file, snapshot),
      refreshCompletions: (model, position) => suggestions.current?.refresh(model, position),
      canEdit: () => !currentProps.current.readOnly && !editor.current?.getRawOptions().readOnly,
    });
    features.current = languageFeatures;
    languageFeatures.register();
    let mounted = true;
    const detachEdits = bindWorkspaceEdits(async (edit) => {
      const snapshot = renameSnapshot(edit);
      const validate = () => {
        if (
          !mounted ||
          currentProps.current.readOnly ||
          editor.current?.getRawOptions().readOnly ||
          !snapshot ||
          analysisSession.getCurrent() !== snapshot
        )
          throw new Error("The workspace changed while preparing the rename. Try again.");
        const groups = validateTextEdits(edit, (resource) =>
          [...models.current.values()].find((model) => model.uri.toString() === resource),
        );
        for (const model of groups.keys()) {
          const file = fileFor(model);
          if (
            !file ||
            normalizeSource(snapshot.analysis.index.sources[file] ?? "") !==
              normalizeSource(model.getValue())
          )
            throw new Error("A source file changed while preparing the rename.");
        }
        return groups;
      };
      validate();
      if (!currentProps.current.onWorkspaceEdit)
        throw new Error("Workspace editing is unavailable.");
      await currentProps.current.onWorkspaceEdit(snapshot!, () => {
        const groups = validate();
        const changes: Record<string, string> = {};
        applyingValue.current = true;
        try {
          for (const [model, edits] of groups) {
            model.pushStackElement();
            model.pushEditOperations(null, edits, () => null);
            model.pushStackElement();
            changes[fileFor(model)!] = model.getValue(undefined, true);
          }
        } finally {
          applyingValue.current = false;
        }
        languageFeatures.update(undefined);
        return changes;
      });
      return { isApplied: true, ariaSummary: `${edit.edits.length} occurrences renamed.` };
    });
    const detachCompletion = completionSession?.subscribe(() => {
      const snapshot = analysisSession.getCurrent();
      if (snapshot) completionSession.enrich(snapshot.analysis.index.symbols);
      languageFeatures.refreshCompletion();
    });
    const instance = monaco.editor.create(container.current, {
      model: null,
      "semanticHighlighting.enabled": true,
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
      autoIndent: "full",
      tabSize: indentSize,
      insertSpaces: true,
      smoothScrolling: false,
      cursorSmoothCaretAnimation: "off",
      renderWhitespace: "selection",
      renderValidationDecorations: "on",
      scrollBeyondLastLine: false,
      formatOnPaste: true,
      stickyScroll: { enabled: true, maxLineCount: 3 },
      overviewRulerBorder: false,
    });
    const opener = monaco.editor.registerEditorOpener({
      openCodeEditor: async (_source, resource, selection) => {
        const model = [...models.current.values()].find(
          (model) => model.uri.toString() === resource.toString(),
        );
        const file = model && fileFor(model);
        if (!file || !currentProps.current.onOpenLocation) return false;
        const range =
          selection && "startLineNumber" in selection
            ? {
                startLine: selection.startLineNumber,
                startColumn: selection.startColumn,
                endLine: selection.endLineNumber,
                endColumn: selection.endColumn,
              }
            : {
                startLine: selection?.lineNumber ?? 1,
                startColumn: selection?.column ?? 1,
                endLine: selection?.lineNumber ?? 1,
                endColumn: selection?.column ?? 1,
              };
        return currentProps.current.onOpenLocation(file, range);
      },
    });
    editor.current = instance;
    if (completionSession)
      suggestions.current = completionWidget(
        instance,
        () => composing.current,
        () => completionSession.request(),
      );
    const compositionStart = instance.onDidCompositionStart?.(() => {
      composing.current = true;
    });
    const compositionEnd = instance.onDidCompositionEnd?.(() => {
      composing.current = false;
    });
    const disposeKeyboard = onEditorReady?.(instance);
    const blurSubscription = onBlur
      ? instance.onDidBlurEditorWidget(() => {
          const file = activeFile.current;
          if (file) onBlurRef.current?.(file);
        })
      : undefined;
    instance.focus();
    const cursorSubscription = instance.onDidChangeCursorPosition(({ position }) =>
      onCursorChangeRef.current({ line: position.lineNumber, column: position.column }),
    );
    return () => {
      compositionStart?.dispose();
      compositionEnd?.dispose();
      disposeKeyboard?.();
      blurSubscription?.dispose();
      mounted = false;
      opener.dispose();
      detachEdits();
      suggestions.current?.dispose();
      suggestions.current = undefined;
      detachCompletion?.();
      languageFeatures.dispose();
      features.current = undefined;
      cursorSubscription.dispose();
      semanticRegistration.dispose();
      semanticTokens.dispose();
      instance.dispose();
      for (const [file, model] of models.current) disposeModel(file, model);
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
    const model = ensureModel(file, documents.reader(file)());
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
    // Retain models used by Peek and workspace edits while their source exists.
    // A fresh snapshot reconciles closed files changed externally or removed.
    for (const [modelFile, model] of models.current) {
      if (open.has(modelFile)) continue;
      const source = analysisSession.getCurrent()?.analysis.index.sources[modelFile];
      if (source === undefined) {
        disposeModel(modelFile, model);
      } else if (modelSnapshots.source(model) !== source) {
        applyingValue.current = true;
        try {
          model.setValue(source);
          modelSnapshots.bind(model, modelFile, source);
        } finally {
          applyingValue.current = false;
        }
      }
    }
  }, [openFiles]);

  useEffect(() => {
    editor.current?.updateOptions({
      lineNumbers: editorOptions?.lineNumbers ?? "on",
      minimap: { enabled: editorOptions?.minimap ?? false },
      renderWhitespace: editorOptions?.renderWhitespace ?? "selection",
      formatOnPaste: editorOptions?.formatOnPaste ?? true,
    });
  }, [
    editorOptions?.lineNumbers,
    editorOptions?.minimap,
    editorOptions?.renderWhitespace,
    editorOptions?.formatOnPaste,
  ]);
  useEffect(() => {
    editor.current?.updateOptions({ ariaLabel, readOnly });
  }, [ariaLabel, readOnly]);
  useEffect(() => {
    editor.current?.updateOptions({ fontSize, lineHeight: Math.round((fontSize * 25) / 16) });
  }, [fontSize]);
  useEffect(() => {
    editor.current?.updateOptions({
      wordWrap: wordWrap ? "on" : "off",
      smoothScrolling: false,
      cursorSmoothCaretAnimation: "off",
    });
    for (const model of models.current.values())
      model.updateOptions({ tabSize: indentSize, indentSize, insertSpaces: true });
  }, [wordWrap, indentSize, reducedMotion]);
  useEffect(() => {
    monaco.editor.setTheme(`kobrixa-${theme}`);
  }, [theme]);

  useEffect(() => {
    const update = (
      snapshot: EditorAnalysis | undefined,
      event: "result" | "invalidate" | "reset" | "failure",
    ) => {
      if (event === "result" && snapshot) {
        const open = new Set(documents.getOpenFiles());
        for (const [modelFile, model] of models.current) {
          if (open.has(modelFile)) {
            if (snapshot.overlays[modelFile] === snapshot.analysis.index.sources[modelFile])
              modelSnapshots.accept(model, snapshot);
            continue;
          }
          const source = snapshot.analysis.index.sources[modelFile];
          if (source === undefined) disposeModel(modelFile, model);
          else {
            if (modelSnapshots.source(model) !== source)
              buffers.current.get(model)?.setValue(source);
            modelSnapshots.accept(model, snapshot);
          }
        }
        semanticTokens.update(
          snapshot.analysis.tokensByFile,
          snapshot.analysis.index.sources,
          modelSnapshots.versions(snapshot),
        );
      } else if (event === "reset") semanticTokens.update(undefined);
      else if (event === "failure") semanticTokens.fail();
      if (snapshot) completionSession?.enrich(snapshot.analysis.index.symbols);
      features.current?.update(snapshot);
    };
    update(analysisSession.getCurrent(), "result");
    return analysisSession.subscribe(update);
  }, [analysisSession, semanticTokens]);

  useEffect(
    () =>
      documents.onChange(() => {
        for (const [modelFile, model] of models.current) {
          const buffer = buffers.current.get(model);
          if (buffer) documents.bind(modelFile, buffer);
        }
      }),
    [documents],
  );

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
  }, [diagnostics, file]);

  useEffect(() => {
    if (focusTarget?.file === file) reveal(focusTarget.range);
  }, [file, focusTarget]);

  return <div className="editor" ref={container} />;
});
