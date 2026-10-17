import { useStaticLanguages } from "./static-language-bootstrap.js";
import {
  sameBinding,
  modelLanguageSelector,
  type ModelLanguageRoute,
} from "./model-language-route.js";
import type { LanguageFeatureQuery, LanguageFeatureReply } from "../../shared/language-query.js";
import { routeLanguage, replaceModelRoute } from "./language-routing.js";
import type { LanguageBinding, LanguageStatus } from "../../shared/language-services.js";
import { diagnosticSourceLabel, type PluginHelpCatalogView } from "../../shared/diagnostic-help.js";
import { EditorModels } from "./editor-models.js";
import { completionWidget } from "./completion-widget.js";
import type { CompletionSession } from "./completion-session.js";
import type { PublishedAnalysis } from "../../shared/language-sync.js";
import type { Documents, DocumentBuffer } from "./documents.js";
import type { AnalysisSession } from "./analysis-session.js";
import { ModelSnapshots } from "./model-snapshots.js";
import { LanguageSemanticTokens } from "./semantic-tokens.js";
import { LanguageFeatures, normalizeSource } from "./language-features.js";
import {
  bindWorkspaceEdits,
  workspaceEditContext,
  workspaceEditService,
  validateTextEdits,
  type WorkspaceEditContext,
} from "./workspace-edits.js";
import type { QuickFixReply } from "../../shared/quick-fixes.js";
import { diagnosticMarkerMessage } from "./diagnostic-presentation.js";
import type { DiagnosticLocale } from "@kobrixa/compiler/diagnostic-help";
import { editorRange } from "./language-features.js";
import { editorOptions as resolveEditorOptions, type EditorSettings } from "./editor-options.js";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/languages/features/json/json.worker?worker";
import type { Theme } from "../settings/theme.js";
import type { Diagnostic } from "../../shared/api.js";
import type { WorkspaceSearchFile } from "../../shared/workspace-search.js";
import type { CollabSession } from "../collab/types.js";
import { EditorCollab } from "../collab/editor-binding.js";

// Without worker factories Monaco falls back to running worker tasks on the UI
// thread. Vite bundles these for both the dev server and the packaged file URL.
self.MonacoEnvironment = {
  getWorker: (_workerId, label) => (label === "json" ? new JsonWorker() : new EditorWorker()),
};

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
  quickFixes(diagnostic: Diagnostic, signal?: AbortSignal): Promise<monaco.languages.CodeAction[]>;
  applyQuickFix(action: monaco.languages.CodeAction): Promise<void>;
  captureView(): void;
  applySavedFormat(file: string, before: string, after: string): void;
  replaceMatches(files: WorkspaceSearchFile[], replacement: string): Record<string, string>;
  focus(): void;
  format(): Promise<void>;
  reveal(range: Diagnostic["range"]): void;
  remapFiles(moved: Readonly<Record<string, string>>): void;
  /** The shared model of an open file, for a side editor showing the same buffer. */
  modelFor(file: string): monaco.editor.ITextModel | undefined;
}

export interface EditorAnalysis {
  epoch: number;
  binding: LanguageBinding;
  analysis: PublishedAnalysis;
  overlays: Record<string, string>;
}

interface EditorProps {
  workspaceId?: string;
  status: LanguageStatus | undefined;
  query(
    snapshot: EditorAnalysis,
    query: LanguageFeatureQuery,
    signal: AbortSignal,
  ): Promise<LanguageFeatureReply>;
  helpCatalog: PluginHelpCatalogView | undefined;
  locale?: DiagnosticLocale;
  onQuickFixes?(
    snapshot: EditorAnalysis,
    diagnostic: Diagnostic,
    signal: AbortSignal,
  ): Promise<QuickFixReply>;
  retainedModels?: EditorModels;
  focusOnMount?: boolean;
  onViewChange?(): void;
  documents: Documents;
  analysisSession: AnalysisSession;
  completionSession?: CompletionSession;
  editorOptions?: EditorSettings;
  onEditorReady?(editor: monaco.editor.IStandaloneCodeEditor): () => void;
  onBlur?(file: string): void;
  onOpenLocation?(file: string, range: Diagnostic["range"]): Promise<boolean>;
  onWorkspaceEdit?(
    snapshot: EditorAnalysis,
    apply: () => Record<string, string>,
    context?: WorkspaceEditContext,
  ): Promise<void>;
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
  /** Active collaboration session; shared files are bound to its document. */
  collabSession?: CollabSession | null;
  /** A shared edit exceeded the room's file capacity. */
  onCollabLimit?(file: string): void;
}

let modelSequence = 0;
function modelUri(file: string): monaco.Uri {
  return monaco.Uri.from({ scheme: "kobrixa", path: `/model-${++modelSequence}/${file}` });
}

function markerSeverity(severity: Diagnostic["severity"]): monaco.MarkerSeverity {
  if (severity === "error") return monaco.MarkerSeverity.Error;
  if (severity === "warning") return monaco.MarkerSeverity.Warning;
  return monaco.MarkerSeverity.Info;
}

function toMonacoRange(range: Diagnostic["range"]): monaco.Range {
  return new monaco.Range(range.startLine, range.startColumn, range.endLine, range.endColumn);
}

const ReadyEditor = forwardRef<EditorHandle, EditorProps>(function ReadyEditor(
  {
    file,
    workspaceId,
    status,
    query,
    locale = "en",
    helpCatalog,
    onQuickFixes,
    retainedModels,
    focusOnMount = true,
    onViewChange,
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
    collabSession,
    onCollabLimit,
  },
  handleRef,
): React.JSX.Element {
  const { runtime: staticLanguages } = useStaticLanguages();
  const [modelSnapshots] = useState(() => new ModelSnapshots());
  const semanticTokens = useRef(new Map<monaco.editor.ITextModel, LanguageSemanticTokens>());
  const modelRoutes = useRef(
    new Map<
      monaco.editor.ITextModel,
      ReturnType<typeof replaceModelRoute<monaco.editor.ITextModel>>
    >(),
  );
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const [ownedModels] = useState(() => retainedModels ?? new EditorModels());
  const models = useRef(ownedModels.models);
  const viewStates = useRef(ownedModels.views);
  const viewChanged = useRef(onViewChange);
  viewChanged.current = onViewChange;
  const captureView = () => {
    if (
      activeFile.current &&
      editor.current?.getModel() &&
      !editor.current.getModel()!.isDisposed()
    ) {
      ownedModels.capture(activeFile.current, editor.current);
      viewChanged.current?.();
    }
  };
  const activeFile = useRef<string | undefined>(undefined);
  const applyingValue = useRef(false);
  const composing = useRef(false);
  const suggestions = useRef<ReturnType<typeof completionWidget> | undefined>(undefined);
  const features = useRef(new Map<monaco.editor.ITextModel, LanguageFeatures>());
  const modelSubscriptions = useRef(new Map<monaco.editor.ITextModel, monaco.IDisposable>());
  const currentProps = useRef({
    readOnly,
    onOpenLocation,
    onWorkspaceEdit,
    locale,
    onQuickFixes,
    workspaceId,
    status,
    query,
  });
  currentProps.current = {
    readOnly,
    onOpenLocation,
    onWorkspaceEdit,
    locale,
    onQuickFixes,
    workspaceId,
    status,
    query,
  };
  const buffers = useRef(new Map<monaco.editor.ITextModel, DocumentBuffer>());
  const collab = useRef<EditorCollab | undefined>(undefined);
  const fileFor = (model: monaco.editor.ITextModel): string | undefined =>
    [...models.current].find(([, item]) => item === model)?.[0];
  const detachModelRoute = (model: monaco.editor.ITextModel) => {
    modelRoutes.current.get(model)?.dispose();
    modelRoutes.current.delete(model);
  };
  const bindModelRoute = (model: monaco.editor.ITextModel, file: string) => {
    const status = currentProps.current.status;
    const context = ownedModels.languageContext(model);
    const route = routeLanguage(
      file,
      status,
      undefined,
      staticLanguages.registrar.resolve(context),
    );
    const attached = replaceModelRoute(
      modelRoutes.current.get(model),
      model,
      file,
      currentProps.current.workspaceId,
      route,
      (_target, selected: ModelLanguageRoute) => {
        const { binding, companion } = selected;
        if (!binding || !companion) return { dispose() {} };
        const uri = model.uri.toString();
        const workspaceId = currentProps.current.workspaceId;
        const currentRoute = (candidate: monaco.editor.ITextModel) => {
          if (
            candidate !== model ||
            candidate.uri.toString() !== uri ||
            fileFor(candidate) !== file ||
            currentProps.current.workspaceId !== workspaceId
          )
            return undefined;
          return modelRoutes.current.get(candidate)?.route;
        };
        const currentBinding = () => {
          const availability = currentProps.current.status?.availability;
          return availability?.kind === "available" && sameBinding(availability.binding, binding)
            ? availability.binding
            : undefined;
        };
        const tokens =
          selected.kind !== "plaintext" && binding.capabilities.includes("semanticTokens")
            ? new LanguageSemanticTokens(
                companion.legend,
                selected.monacoLanguage,
                binding.epoch,
                (candidate) => currentRoute(candidate) === selected && !!currentBinding(),
              )
            : undefined;
        const semanticRegistration = tokens
          ? monaco.languages.registerDocumentSemanticTokensProvider(
              modelLanguageSelector(model, selected),
              tokens,
            )
          : undefined;
        if (tokens) {
          semanticTokens.current.set(model, tokens);
          tokens.bind(model, file);
        }
        const languageFeatures = new LanguageFeatures({
          binding: currentBinding,
          companion: () => companion,
          route: currentRoute,
          query: (snapshot, query, signal) => currentProps.current.query(snapshot, query, signal),
          locale: () => currentProps.current.locale,
          quickFixes: (snapshot, diagnostic, signal) =>
            currentProps.current.onQuickFixes?.(snapshot, diagnostic, signal) ??
            Promise.resolve({ kind: "stale", epoch: binding.epoch }),
          fileFor: (candidate) => (candidate === model ? fileFor(candidate) : undefined),
          ensureModel,
          completionSymbols: (candidate, position) => {
            const name = fileFor(candidate);
            const symbols = name && completionSession?.symbols(name, position);
            if (!symbols) completionSession?.request();
            return symbols || undefined;
          },
          isCurrent: (candidate, name, snapshot) =>
            analysisSession.getCurrent() === snapshot &&
            modelSnapshots.isCurrent(candidate, name, snapshot),
          refreshCompletions: (candidate, position) =>
            suggestions.current?.refresh(candidate, position),
          canEdit: () =>
            !currentProps.current.readOnly && !editor.current?.getRawOptions().readOnly,
        });
        features.current.set(model, languageFeatures);
        languageFeatures.register(selected, model);
        completionSession?.bind(file, model);
        const snapshot = analysisSession.getCurrent();
        languageFeatures.update(snapshot);
        if (snapshot?.epoch === binding.epoch)
          tokens?.update(
            snapshot.analysis.tokensByFile,
            snapshot.analysis.index.sources,
            modelSnapshots.versions(snapshot),
            snapshot.epoch,
          );
        return {
          dispose() {
            tokens?.unbind(model); // Fire empty tokens before unregister/disposal.
            semanticRegistration?.dispose();
            tokens?.dispose();
            semanticTokens.current.delete(model);
            languageFeatures.unbind(model);
            languageFeatures.dispose();
            features.current.delete(model);
            completionSession?.unbind(file, model);
          },
        };
      },
    );
    modelRoutes.current.set(model, attached);
    ownedModels.trackLanguage(model, {
      beforeChange: () => detachModelRoute(model),
      afterChange: () => {
        const currentFile = fileFor(model);
        if (currentFile) bindModelRoute(model, currentFile);
      },
    });
  };
  const ensureModel = (file: string, content: string): monaco.editor.ITextModel => {
    const existing = models.current.get(file);
    if (existing && buffers.current.has(existing)) {
      bindModelRoute(existing, file);
      documents.bind(file, buffers.current.get(existing)!);
      collab.current?.refresh();
      return existing;
    }
    const model =
      existing ??
      monaco.editor.createModel(
        content,
        staticLanguages.registrar.resolve({
          file,
          ...(currentProps.current.workspaceId
            ? { workspaceId: currentProps.current.workspaceId }
            : {}),
          ...(currentProps.current.status?.availability.kind === "available"
            ? { binding: currentProps.current.status.availability.binding }
            : {}),
        }).monacoLanguage,
        modelUri(file),
      );
    models.current.set(file, model);
    modelSnapshots.bind(model, file, content);
    const snapshot = analysisSession.getCurrent();
    if (snapshot?.analysis.index.sources[file] === content) modelSnapshots.accept(model, snapshot);
    bindModelRoute(model, file);
    const buffer: DocumentBuffer = {
      getValue: () => model.getValue(undefined, true),
      getValueLength: () => model.getValueLength(undefined, true),
      getVersionId: () => model.getVersionId(),
      getAlternativeVersionId: () => model.getAlternativeVersionId(),
      setValue: (value) => {
        applyingValue.current = true;
        try {
          if (collab.current?.binding(model))
            model.pushEditOperations(
              null,
              [{ range: model.getFullModelRange(), text: value }],
              () => null,
            );
          else model.setValue(value);
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
        for (const feature of features.current.values()) feature.update(undefined);
        const currentFile = fileFor(model);
        if (currentFile && documents.getOpenFiles().includes(currentFile)) {
          documents.changed(currentFile);
          onChangeRef.current(currentFile);
        }
      }),
    );
    // Workspace edits also create models for closed files. Bind before the caller
    // edits them, so opening the resulting tab cannot overwrite the edit with Y.Text.
    collab.current?.refresh();
    return model;
  };
  const disposeModel = (file: string, model: monaco.editor.ITextModel) => {
    modelRoutes.current.get(model)?.dispose();
    modelRoutes.current.delete(model);
    documents.unbind(file);
    buffers.current.delete(model);
    models.current.delete(file);
    viewStates.current.delete(file);
    modelSubscriptions.current.get(model)?.dispose();
    modelSubscriptions.current.delete(model);
    modelSnapshots.unbind(model);
    ownedModels.forgetLanguage(model);
    model.dispose();
  };
  const onBlurRef = useRef(onBlur);
  onBlurRef.current = onBlur;
  const onChangeRef = useRef(onChange);
  const onCollabLimitRef = useRef(onCollabLimit);
  onCollabLimitRef.current = onCollabLimit;
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
    if (focusOnMount) instance.focus();
  };

  useImperativeHandle(
    handleRef,
    () => ({
      quickFixes: async (diagnostic, signal) => {
        const snapshot = analysisSession.getCurrent();
        const source = snapshot?.analysis.index.sources[diagnostic.file];
        if (!snapshot || source === undefined) return [];
        const model = ensureModel(diagnostic.file, source);
        return features.current.get(model)?.quickFixes(model, diagnostic, undefined, signal) ?? [];
      },
      applyQuickFix: async (action) => {
        if (!action.edit || workspaceEditContext(action.edit)?.kind !== "quick-fix")
          throw new Error("This quick fix is no longer available.");
        await workspaceEditService.apply(action.edit);
        editor.current?.focus();
      },
      captureView,
      replaceMatches: (files, replacement) => {
        if (currentProps.current.readOnly) throw new Error("The editor is read-only.");
        const prepared = files.map((file) => {
          // A closed model may have been created by Peek before the file changed on disk.
          const existing = models.current.get(file.path);
          if (
            existing &&
            !documents.getOpenFiles().includes(file.path) &&
            !collab.current?.binding(existing)
          ) {
            applyingValue.current = true;
            try {
              if (existing.getValue(undefined, true) !== file.content)
                existing.setValue(file.content);
            } finally {
              applyingValue.current = false;
            }
          }
          const model = ensureModel(file.path, file.content);
          if (model.getValue(undefined, true) !== file.content)
            throw new Error("A file changed since the replacement preview. Search again.");
          const bom = file.content.startsWith("\uFEFF") ? 1 : 0;
          let end = 0;
          const edits = file.matches.map((match) => {
            if (
              match.start < end ||
              match.start < bom ||
              match.end > file.content.length ||
              match.end <= match.start
            )
              throw new Error("Invalid replacement range.");
            end = match.end;
            const start = model.getPositionAt(match.start - bom);
            const finish = model.getPositionAt(match.end - bom);
            return {
              range: new monaco.Range(
                start.lineNumber,
                start.column,
                finish.lineNumber,
                finish.column,
              ),
              text: replacement,
            };
          });
          return { file: file.path, model, edits };
        });
        const changes: Record<string, string> = {};
        applyingValue.current = true;
        try {
          for (const { file, model, edits } of prepared) {
            model.pushStackElement();
            model.pushEditOperations(null, edits, () => null);
            model.pushStackElement();
            changes[file] = model.getValue(undefined, true);
          }
        } finally {
          applyingValue.current = false;
        }
        return changes;
      },
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
      modelFor: (file) =>
        editor.current && documents.getOpenFiles().includes(file)
          ? ensureModel(file, documents.reader(file)())
          : undefined,
      remapFiles: (moved) => {
        ownedModels.remap(moved);
        for (const feature of features.current.values()) feature.update(undefined);
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
            modelSnapshots.remap(model, target);
          }
          const state = viewStates.current.get(source);
          if (state) {
            viewStates.current.delete(source);
            viewStates.current.set(target, state);
          }
        }
        staticLanguages.registrar.refreshModels();
        for (const [file, model] of models.current) bindModelRoute(model, file);
        if (currentFile && moved[currentFile]) activeFile.current = moved[currentFile];
        collab.current?.refresh();
      },
    }),
    [],
  );

  useEffect(() => {
    ownedModels.configureLanguages(
      staticLanguages.registrar,
      workspaceId,
      currentProps.current.status,
    );
    if (!container.current) return undefined;
    let mounted = true;
    const detachEdits = bindWorkspaceEdits(async (edit) => {
      const context = workspaceEditContext(edit);
      const snapshot = context?.snapshot;
      const validate = () => {
        if (
          !mounted ||
          currentProps.current.readOnly ||
          editor.current?.getRawOptions().readOnly ||
          !snapshot ||
          analysisSession.getCurrent() !== snapshot
        )
          throw new Error(
            currentProps.current.locale === "zh-TW"
              ? "工作區已變更，請重新取得修正。"
              : "The workspace changed while preparing the edit. Try again.",
          );
        const groups = validateTextEdits(edit, (resource) =>
          [...models.current.values()].find((model) => model.uri.toString() === resource),
        );
        for (const model of groups.keys()) {
          const file = fileFor(model);
          if (
            !file ||
            (context?.kind === "quick-fix" && !context.files?.includes(file)) ||
            normalizeSource(snapshot.analysis.index.sources[file] ?? "") !==
              normalizeSource(model.getValue())
          )
            throw new Error(
              currentProps.current.locale === "zh-TW"
                ? "來源檔案已變更，請重新取得修正。"
                : "A source file changed while preparing the edit.",
            );
        }
        return groups;
      };
      validate();
      if (!currentProps.current.onWorkspaceEdit)
        throw new Error("Workspace editing is unavailable.");
      await currentProps.current.onWorkspaceEdit(
        snapshot!,
        () => {
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
          for (const feature of features.current.values()) feature.update(undefined);
          return changes;
        },
        context,
      );
      return {
        isApplied: true,
        ariaSummary: context?.summary ?? `${edit.edits.length} occurrences renamed.`,
      };
    });
    const instance = monaco.editor.create(container.current, {
      model: null,
      "semanticHighlighting.enabled": true,
      theme: `kobrixa-${theme}`,
      readOnly,
      ariaLabel,
      automaticLayout: true,
      fontFamily: "JetBrains Mono, SFMono-Regular, Consolas, monospace",
      padding: { top: 16 },
      glyphMargin: true,
      lineNumbersMinChars: 3,
      detectIndentation: false,
      autoIndent: "full",
      tabSize: indentSize,
      insertSpaces: true,
      renderValidationDecorations: "on",
      ...resolveEditorOptions(editorOptions, fontSize, wordWrap, reducedMotion),
      overviewRulerBorder: false,
      maxTokenizationLineLength: 10000,
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
    const cursorSubscription = instance.onDidChangeCursorPosition(({ position }) => {
      onCursorChangeRef.current({ line: position.lineNumber, column: position.column });
      captureView();
    });
    const scrollSubscription = instance.onDidScrollChange(captureView);
    return () => {
      captureView();
      scrollSubscription.dispose();
      compositionStart?.dispose();
      compositionEnd?.dispose();
      disposeKeyboard?.();
      blurSubscription?.dispose();
      mounted = false;
      opener.dispose();
      detachEdits();
      suggestions.current?.dispose();
      suggestions.current = undefined;
      cursorSubscription.dispose();
      instance.dispose();
      for (const [file, model] of models.current) {
        modelRoutes.current.get(model)?.dispose();
        modelRoutes.current.delete(model);
        documents.unbind(file);
        modelSubscriptions.current.get(model)?.dispose();
        modelSnapshots.unbind(model);
      }
      ownedModels.releaseLanguageHooks();
      buffers.current.clear();
      modelSubscriptions.current.clear();
      activeFile.current = undefined;
      editor.current = undefined;
      if (!retainedModels) ownedModels.dispose();
    };
  }, []);

  useEffect(() => {
    ownedModels.configureLanguages(staticLanguages.registrar, workspaceId, status);
    for (const [file, model] of models.current) bindModelRoute(model, file);
    const off = completionSession?.subscribe(() => {
      const snapshot = analysisSession.getCurrent();
      if (snapshot) completionSession.enrich(snapshot.analysis.index.symbols);
      for (const feature of features.current.values()) feature.refreshCompletion();
    });
    return () => {
      off?.();
    };
  }, [status?.epoch, workspaceId, analysisSession, completionSession]);

  useEffect(() => {
    const instance = editor.current;
    if (!instance) return;
    const previousFile = activeFile.current;
    if (previousFile) {
      const state = instance.saveViewState();
      if (state) viewStates.current.set(previousFile, state);
    }
    captureView();
    const restoredLocation = ownedModels.locations[file];
    for (const openFile of documents.getOpenFiles()) {
      if (models.current.has(openFile)) ensureModel(openFile, documents.reader(openFile)());
    }
    const model = ensureModel(file, documents.reader(file)());
    model.updateOptions({ tabSize: indentSize, indentSize, insertSpaces: true });
    const savedState = viewStates.current.get(file);
    activeFile.current = file;
    instance.setModel(model);
    if (savedState) instance.restoreViewState(savedState);
    else {
      const location = restoredLocation;
      if (location) {
        instance.setSelection(
          new monaco.Selection(
            location.line,
            location.column,
            location.endLine,
            location.endColumn,
          ),
        );
        instance.setScrollPosition({
          scrollTop: location.scrollTop,
          scrollLeft: location.scrollLeft,
        });
      }
    }
    const position = instance.getPosition();
    if (position) onCursorChangeRef.current({ line: position.lineNumber, column: position.column });
    collab.current?.refresh();
  }, [file]);

  useEffect(() => {
    const instance = editor.current;
    if (!collabSession || !instance) return undefined;
    const attachment = new EditorCollab(instance, collabSession, {
      // Retained models for Peek, search replacement and workspace edits must
      // participate even before they become document tabs.
      models: () => models.current,
      activeFile: () => activeFile.current,
      onLimit: (file) => onCollabLimitRef.current?.(file),
    });
    collab.current = attachment;
    return () => {
      attachment.dispose();
      if (collab.current === attachment) collab.current = undefined;
    };
  }, [collabSession]);

  useEffect(() => {
    // Reconcile only unshared models from disk/analysis; shared models follow Y.Text.
    collab.current?.refresh();
    const open = new Set(openFiles);
    // Retain models used by Peek and workspace edits while their source exists.
    // A fresh snapshot reconciles closed files changed externally or removed.
    for (const [modelFile, model] of models.current) {
      if (open.has(modelFile) || collab.current?.binding(model)) continue;
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
    collab.current?.refresh();
  }, [openFiles]);

  useEffect(() => {
    suggestions.current?.setAutomaticSuggestions(editorOptions?.autoSuggestions ?? true);
    editor.current?.updateOptions({
      ...resolveEditorOptions(editorOptions, fontSize, wordWrap, reducedMotion),
      maxTokenizationLineLength: 10000,
    });
  }, [editorOptions, fontSize, wordWrap, reducedMotion]);
  useEffect(() => {
    editor.current?.updateOptions({ ariaLabel, readOnly, maxTokenizationLineLength: 10000 });
  }, [ariaLabel, readOnly]);
  useEffect(() => {
    for (const model of models.current.values())
      model.updateOptions({ tabSize: indentSize, indentSize, insertSpaces: true });
  }, [indentSize]);
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
          if (collab.current?.binding(model)) {
            // A delayed disk analysis may predate the latest shared edit. Never
            // publish that snapshot back into the room or trust its model version.
            if (
              source !== undefined &&
              normalizeSource(source) === normalizeSource(model.getValue())
            )
              modelSnapshots.accept(model, snapshot);
            continue;
          }
          if (source === undefined) disposeModel(modelFile, model);
          else {
            if (modelSnapshots.source(model) !== source)
              buffers.current.get(model)?.setValue(source);
            modelSnapshots.accept(model, snapshot);
          }
        }
        for (const tokens of semanticTokens.current.values())
          tokens.update(
            snapshot.analysis.tokensByFile,
            snapshot.analysis.index.sources,
            modelSnapshots.versions(snapshot),
            snapshot.epoch,
          );
      } else if (event === "reset") {
        for (const tokens of semanticTokens.current.values())
          tokens.update(undefined, undefined, undefined, currentProps.current.status?.epoch ?? 0);
      } else if (event === "failure") {
        for (const tokens of semanticTokens.current.values()) tokens.fail();
      }
      if (snapshot) completionSession?.enrich(snapshot.analysis.index.symbols);
      for (const feature of features.current.values()) feature.update(snapshot);
    };
    update(analysisSession.getCurrent(), "result");
    return analysisSession.subscribe(update);
  }, [analysisSession, status?.epoch]);

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
            code: item.code,
            source: diagnosticSourceLabel(item.source, helpCatalog, locale),
            message: diagnosticMarkerMessage(item, locale, helpCatalog),
            ...editorRange(item.range, modelSnapshots.source(model) ?? ""),
          })),
      );
    }
  }, [diagnostics, file, locale, helpCatalog, status?.epoch]);

  useEffect(() => {
    if (focusTarget?.file === file) reveal(focusTarget.range);
  }, [file, focusTarget]);

  return <div className="editor" ref={container} />;
});

export const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(props, ref) {
  const { snapshot } = useStaticLanguages();
  return snapshot.settled ? (
    <ReadyEditor {...props} ref={ref} />
  ) : (
    <div className="editor" role="status">
      {props.locale === "zh-TW" ? "正在載入語言…" : "Loading languages…"}
    </div>
  );
});
