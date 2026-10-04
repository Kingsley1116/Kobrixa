import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { WorkspaceSummary } from "../../shared/api.js";
import {
  replaceSearchMatches,
  type WorkspaceSearchFile,
  type WorkspaceSearchMatch,
  type WorkspaceSearchResult,
} from "../../shared/workspace-search.js";
import { Dialog, DialogActions } from "../components/dialog.js";
import type { Documents } from "../editor/documents.js";
import type { Locale } from "../i18n/copy.js";
import { FileDiff } from "./file-review-dialog.js";
import { SearchController } from "./search-controller.js";
import "./search.css";

const copy = {
  en: {
    query: "Search in project",
    placeholder: "Find text…",
    replacement: "Replace with",
    replacePlaceholder: "Replacement text…",
    matchCase: "Match case",
    wholeWord: "Whole word",
    refresh: "Refresh search",
    preview: "Preview replacement",
    scope: "Current project · Basic Plus & JSON",
    hint: "Search saved files and unsaved edits in this project.",
    searching: "Searching…",
    empty: "No matches.",
    summary: (matches: number, files: number) => `${matches} matches in ${files} files`,
    limited:
      "Results are incomplete, so replacement is unavailable. Refine the query or check the skipped files.",
    skipped: "Files skipped",
    cancel: "Cancel",
    before: "Before",
    after: "After",
    previewHint:
      "Review all changes before applying. Each file can be undone separately. Changes follow your save settings.",
    stale: "The search or project changed. Close this preview and search again.",
    apply: (files: number) => `Replace in ${files} files`,
    applying: "Applying…",
    noChanges: "The replacement would not change any text.",
    close: "Close search",
    failure: "Unable to open this result. Refresh the search and try again.",
  },
  "zh-TW": {
    query: "在專案中搜尋",
    placeholder: "搜尋文字…",
    replacement: "取代為",
    replacePlaceholder: "取代文字…",
    matchCase: "區分大小寫",
    wholeWord: "全字相符",
    refresh: "重新搜尋",
    preview: "預覽取代",
    scope: "目前專案 · Basic Plus 與 JSON",
    hint: "搜尋此專案的已儲存檔案與未儲存修改。",
    searching: "搜尋中…",
    empty: "沒有相符結果。",
    summary: (matches: number, files: number) => `${files} 個檔案中有 ${matches} 個結果`,
    limited: "結果不完整，暫時無法取代。請調整搜尋文字或檢查略過的檔案。",
    skipped: "略過的檔案",
    cancel: "取消",
    before: "取代前",
    after: "取代後",
    previewHint: "確認所有變更後再套用。各檔案可分別復原，變更會依照你的儲存設定處理。",
    stale: "搜尋或專案內容已變更，請關閉預覽並重新搜尋。",
    apply: (files: number) => `取代 ${files} 個檔案`,
    applying: "套用中…",
    noChanges: "取代後的內容與原文相同。",
    close: "關閉搜尋",
    failure: "無法開啟此結果，請重新搜尋後再試。",
  },
};

interface Preview {
  result: WorkspaceSearchResult;
  files: WorkspaceSearchFile[];
  replacement: string;
}

function matchPreview(file: WorkspaceSearchFile, match: WorkspaceSearchMatch): React.ReactNode {
  const lineStart = match.start - match.startColumn + 1;
  const start = Math.max(lineStart, match.start - 80);
  let end = Math.min(file.content.length, start + 320);
  for (const newline of ["\r", "\n"]) {
    const at = file.content.indexOf(newline, match.start);
    if (at >= 0) end = Math.min(end, at);
  }
  return (
    <>
      {start > lineStart && "…"}
      {file.content.slice(start, match.start)}
      <mark>{file.content.slice(match.start, Math.min(match.end, end))}</mark>
      {file.content.slice(Math.min(match.end, end), end)}
      {end < file.content.length && !/[\r\n]/.test(file.content[end]!) && "…"}
    </>
  );
}

function matchLocation(file: WorkspaceSearchFile, match: WorkspaceSearchMatch): string {
  const bom = match.startLine === 1 && file.content.startsWith("\uFEFF") ? 1 : 0;
  return `${match.startLine}:${Math.max(1, match.startColumn - bom)}`;
}

export function SearchPanel({
  workspace,
  documents,
  active,
  focusRequest,
  locale,
  resolvedTheme,
  readOnly,
  onOpen,
  onReplace,
  onClose,
}: {
  workspace: WorkspaceSummary;
  documents: Documents;
  active: boolean;
  focusRequest: number;
  locale: Locale;
  resolvedTheme: "dark" | "light";
  readOnly: boolean;
  onOpen(file: WorkspaceSearchFile, match: WorkspaceSearchMatch): Promise<boolean>;
  onReplace(files: WorkspaceSearchFile[], replacement: string): Promise<void>;
  onClose(): void;
}): React.JSX.Element {
  const t = copy[locale];
  const [controller] = useState(
    () =>
      new SearchController(documents, (id, request) =>
        window.kobrixa.workspace.search(id, request),
      ),
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [replacement, setReplacement] = useState("");
  const [preview, setPreview] = useState<Preview>();
  const [selected, setSelected] = useState(0);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string>();
  const query = useRef<HTMLInputElement>(null);
  const cancelPreview = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const id = useId();
  useLayoutEffect(() => controller.configure(workspace, active), [controller, workspace, active]);
  useEffect(() => {
    mounted.current = true;
    const detach = controller.attach();
    return () => {
      mounted.current = false;
      detach();
    };
  }, [controller]);
  useEffect(() => {
    if (active) {
      query.current?.focus();
      query.current?.select();
    }
  }, [active, focusRequest]);
  const count = state.result?.matchCount ?? 0;
  const incomplete = !!state.result && (state.result.truncated || state.result.skipped.length > 0);
  const stale = preview && preview.result !== state.result;
  useEffect(() => {
    // Disabling the clicked Apply button can move native focus to <body>.
    // Restore the dialog's keyboard target after either a failure or invalidation.
    if (preview && !applying) cancelPreview.current?.focus();
  }, [preview, applying, stale]);
  const selectedFile = preview?.files[selected];
  const after = useMemo(
    () => (selectedFile && preview ? replaceSearchMatches(selectedFile, preview.replacement) : ""),
    [selectedFile, preview],
  );

  function showPreview(): void {
    if (!state.result || state.busy || incomplete || readOnly) return;
    const files = state.result.files.filter(
      (file) => replaceSearchMatches(file, replacement) !== file.content,
    );
    if (!files.length) {
      setError(t.noChanges);
      return;
    }
    setError(undefined);
    setSelected(0);
    setPreview({ result: state.result, files, replacement });
  }
  async function apply(): Promise<void> {
    if (!preview || stale || applying || readOnly) return;
    setApplying(true);
    setError(undefined);
    try {
      await onReplace(preview.files, preview.replacement);
      if (!mounted.current) return;
      setPreview(undefined);
      controller.refresh(0);
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mounted.current) setApplying(false);
    }
  }

  return (
    <section
      className="workspace-search"
      data-workspace-search
      hidden={!active}
      aria-label={t.query}
    >
      <div className="workspace-search-fields">
        <label htmlFor={`${id}-query`}>{t.query}</label>
        <input
          id={`${id}-query`}
          data-search-query
          ref={query}
          value={state.options.query}
          placeholder={t.placeholder}
          maxLength={512}
          onChange={(event) => {
            setError(undefined);
            controller.setOptions({ query: event.target.value });
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter") {
              event.preventDefault();
              controller.refresh(0);
            }
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <div className="workspace-search-options">
          <button
            type="button"
            data-search-case
            aria-pressed={state.options.caseSensitive}
            title={t.matchCase}
            aria-label={t.matchCase}
            onClick={() => controller.setOptions({ caseSensitive: !state.options.caseSensitive })}
          >
            Aa
          </button>
          <button
            type="button"
            data-search-word
            aria-pressed={state.options.wholeWord}
            title={t.wholeWord}
            aria-label={t.wholeWord}
            onClick={() => controller.setOptions({ wholeWord: !state.options.wholeWord })}
          >
            ab
          </button>
          <button
            type="button"
            data-search-refresh
            onClick={() => controller.refresh(0)}
            disabled={!state.options.query}
            title={t.refresh}
            aria-label={t.refresh}
          >
            ↻
          </button>
        </div>
        <label htmlFor={`${id}-replacement`}>{t.replacement}</label>
        <input
          id={`${id}-replacement`}
          data-search-replacement
          value={replacement}
          placeholder={t.replacePlaceholder}
          maxLength={4096}
          onChange={(event) => {
            setError(undefined);
            setReplacement(event.target.value);
          }}
        />
        <button
          type="button"
          data-search-preview
          disabled={readOnly || !count || state.busy || incomplete}
          onClick={showPreview}
        >
          {t.preview}
        </button>
        <p className="workspace-search-scope" title={workspace.name}>
          {workspace.name}
          <span>{t.scope}</span>
        </p>
      </div>
      <p className="workspace-search-status" role="status" aria-live="polite">
        {state.busy
          ? t.searching
          : !state.options.query
            ? t.hint
            : state.result
              ? count
                ? t.summary(count, state.result.files.length)
                : t.empty
              : ""}
      </p>
      {(state.error || (error && !preview)) && (
        <p className="workspace-search-error" role="alert">
          {state.error ?? error}
        </p>
      )}
      {incomplete && <p className="workspace-search-notice">{t.limited}</p>}
      {!!state.result?.skipped.length && (
        <details className="workspace-search-skipped">
          <summary>
            {t.skipped} ({state.result.skipped.length})
          </summary>
          <ul>
            {state.result.skipped.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="workspace-search-results" aria-busy={state.busy}>
        {state.result?.files.map((file) => (
          <details open key={file.path}>
            <summary title={file.path}>
              <span>{file.path}</span>
              <small>{file.matches.length}</small>
            </summary>
            <ul>
              {file.matches.map((match) => (
                <li key={match.start}>
                  <button
                    type="button"
                    data-search-path={file.path}
                    data-search-line={match.startLine}
                    title={`${file.path}:${matchLocation(file, match)}\n${match.lineText}`}
                    aria-label={`${file.path}:${matchLocation(file, match)} ${match.lineText}`}
                    onClick={() => {
                      void onOpen(file, match)
                        .then((ok) => {
                          if (!ok && mounted.current) {
                            setError(t.failure);
                            controller.refresh(0);
                          }
                        })
                        .catch((error: unknown) => {
                          if (mounted.current) setError(String(error));
                        });
                    }}
                  >
                    <span className="workspace-search-line">{matchLocation(file, match)}</span>
                    <code>{matchPreview(file, match)}</code>
                  </button>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </div>
      {preview && selectedFile && (
        <Dialog
          className="file-review-dialog search-replace-dialog"
          title={t.preview}
          onClose={() => {
            if (!applying) {
              setPreview(undefined);
              setError(undefined);
            }
          }}
          intro={<p>{t.previewHint}</p>}
        >
          <div className="search-replace-content">
            <nav aria-label={t.preview}>
              {preview.files.map((file, index) => (
                <button
                  key={file.path}
                  type="button"
                  aria-pressed={index === selected}
                  title={file.path}
                  disabled={applying}
                  onClick={() => setSelected(index)}
                >
                  <span>{file.path}</span>
                  <small>{file.matches.length}</small>
                </button>
              ))}
            </nav>
            <FileDiff
              file={selectedFile.path}
              resolvedTheme={resolvedTheme}
              original={selectedFile.content}
              modified={after}
              originalLabel={t.before}
              modifiedLabel={t.after}
            />
          </div>
          {stale && (
            <p className="workspace-search-notice" role="status">
              {t.stale}
            </p>
          )}
          {error && (
            <p className="workspace-search-error" role="alert">
              {error}
            </p>
          )}
          <DialogActions>
            <button
              ref={cancelPreview}
              data-modal-initial
              disabled={applying}
              onClick={() => {
                setPreview(undefined);
                setError(undefined);
              }}
            >
              {t.cancel}
            </button>
            <button
              className="primary"
              data-search-apply
              disabled={!!stale || applying || readOnly}
              onClick={() => void apply()}
            >
              {applying ? t.applying : t.apply(preview.files.length)}
            </button>
          </DialogActions>
        </Dialog>
      )}
    </section>
  );
}
