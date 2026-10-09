import * as monaco from "monaco-editor";
import { useEffect, useRef } from "react";
import type { Locale } from "../i18n/copy.js";
import { editorOptions as resolveEditorOptions, type EditorSettings } from "./editor-options.js";

/**
 * A second view of a file already open in the main editor. It shows the main editor's
 * model, so typing, undo, markers and language features are shared with that buffer.
 */
export function SplitEditor({
  file,
  files,
  modelFor,
  locale,
  readOnly,
  fontSize,
  wordWrap,
  reducedMotion,
  editorOptions,
  onEditorReady,
  onFile,
  onClose,
  onBlur,
}: {
  file: string;
  files: string[];
  modelFor(file: string): monaco.editor.ITextModel | undefined;
  locale: Locale;
  readOnly: boolean;
  fontSize: number;
  wordWrap: boolean;
  reducedMotion: boolean;
  editorOptions?: EditorSettings;
  onEditorReady?(editor: monaco.editor.IStandaloneCodeEditor): () => void;
  onFile(file: string): void;
  onClose(): void;
  onBlur?(file: string): void;
}): React.JSX.Element {
  const zh = locale === "zh-TW";
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const views = useRef(new Map<string, monaco.editor.ICodeEditorViewState>());
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const blur = useRef(() => onBlur?.(file));
  blur.current = () => onBlur?.(file);
  useEffect(() => {
    if (!container.current) return undefined;
    const editor = monaco.editor.create(container.current, {
      model: null,
      "semanticHighlighting.enabled": true,
      automaticLayout: true,
      fontFamily: "JetBrains Mono, SFMono-Regular, Consolas, monospace",
      padding: { top: 16 },
      glyphMargin: true,
      lineNumbersMinChars: 3,
      renderValidationDecorations: "on",
      overviewRulerBorder: false,
      ariaLabel: zh ? "分割編輯器" : "Split editor",
    });
    instance.current = editor;
    const unbind = onEditorReady?.(editor);
    const blurred = editor.onDidBlurEditorWidget(() => blur.current());
    return () => {
      blurred.dispose();
      unbind?.();
      editor.dispose();
      instance.current = undefined;
    };
    // The editor is created once; later prop changes are applied by the effects below.
  }, []);
  useEffect(() => {
    instance.current?.updateOptions({
      ...resolveEditorOptions(editorOptions, fontSize, wordWrap, reducedMotion),
      readOnly,
    });
  }, [editorOptions, fontSize, wordWrap, reducedMotion, readOnly]);
  useEffect(() => {
    const editor = instance.current;
    const model = modelFor(file);
    if (!editor || !model) {
      closeRef.current();
      return undefined;
    }
    editor.setModel(model);
    const view = views.current.get(file);
    if (view) editor.restoreViewState(view);
    // Closing the file's last tab disposes the shared model; close the split with it.
    const disposal = model.onWillDispose(() => closeRef.current());
    return () => {
      disposal.dispose();
      // On unmount the editor itself is already disposed.
      if (instance.current !== editor) return;
      const state = editor.saveViewState();
      if (state) views.current.set(file, state);
      editor.setModel(null);
    };
    // modelFor is stable for the lifetime of the main editor.
  }, [file]);
  return (
    <section className="split-editor" aria-label={zh ? "分割編輯器" : "Split editor"}>
      <header>
        <select
          aria-label={zh ? "分割編輯器檔案" : "Split editor file"}
          value={file}
          onChange={(event) => onFile(event.target.value)}
        >
          {files.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-label={zh ? "關閉分割編輯器" : "Close split editor"}
          title={zh ? "關閉分割編輯器" : "Close split editor"}
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className="editor" ref={container} />
    </section>
  );
}
