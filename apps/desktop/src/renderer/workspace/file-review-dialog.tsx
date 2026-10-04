import { useEffect, useId, useRef } from "react";
import * as monaco from "monaco-editor";
import type { LocalHistoryEntry } from "../../shared/workspace-files.js";
import { DEFAULT_FILE_PREFERENCES, type FilePreferences } from "../../shared/file-preferences.js";
import { Dialog, DialogActions } from "../components/dialog.js";
import type { Locale } from "../i18n/copy.js";
import { restoreEditorHoverDelegate } from "../editor/monaco-services.js";
import "./file-review-dialog.css";

const copy = {
  en: {
    conflictTitle: "File changed outside Kobrixa",
    conflictDescription:
      "Compare the disk version with your edits before choosing which version to keep. Closing this dialog keeps your edits in the editor.",
    missingDescription:
      "This file is no longer on disk. Your edits are still in the editor. Recreate the file to save them.",
    overwriteHint: "Saving the local version replaces the version currently on disk.",
    disk: "Disk version (read-only)",
    missing: "Missing from disk",
    local: "Your edits (read-only)",
    reload: "Use disk version",
    save: "Save local version",
    recreate: "Recreate file",
    close: "Close",
    historyTitle: "Local history",
    historyDescription:
      "Choose a saved version to compare with the editor. Restoring applies an undoable edit and follows your current save settings.",
    historyList: "Saved versions",
    savedVersion: "Selected version (read-only)",
    editor: "Current editor (read-only)",
    restore: "Restore to editor",
    loading: "Loading history…",
    empty: "No saved versions yet. Local history records earlier contents when files change.",
    select: "Choose a version to preview.",
    retention: (preferences: FilePreferences) =>
      `Kept on this computer for up to ${preferences.localHistoryDays} days: ${preferences.localHistoryVersions} versions per file, ${preferences.localHistorySnapshotMiB} MiB per new version, and ${preferences.localHistoryWorkspaceMiB} MiB per workspace. Older versions may be removed sooner when a limit is reached.`,
    retentionTiming: "Lower retention limits apply the next time history is read or written.",
    historyDisabled: "New local history versions are disabled. Existing versions remain available.",
    reasons: { save: "Saved version", external: "External change", delete: "Deletion" },
  },
  "zh-TW": {
    conflictTitle: "檔案已在 Kobrixa 外變更",
    conflictDescription:
      "比較磁碟版本與你的修改，再選擇要保留的版本。關閉此視窗會保留編輯器中的修改。",
    missingDescription:
      "此檔案已不存在於磁碟上。你的修改仍保留在編輯器中，可以重新建立檔案來儲存。",
    overwriteHint: "以本機內容儲存會取代磁碟上目前的版本。",
    disk: "磁碟版本（唯讀）",
    missing: "磁碟上已不存在",
    local: "你的修改（唯讀）",
    reload: "使用磁碟版本",
    save: "以本機內容儲存",
    recreate: "重新建立檔案",
    close: "關閉",
    historyTitle: "本機歷史",
    historyDescription:
      "選擇過去的版本與編輯器比較。還原會套用可復原的編輯，並依照目前的儲存設定處理。",
    historyList: "歷史版本",
    savedVersion: "選取的版本（唯讀）",
    editor: "目前編輯器（唯讀）",
    restore: "還原到編輯器",
    loading: "正在載入歷史版本…",
    empty: "尚無歷史版本。檔案內容變更時，本機歷史會保留較早的內容。",
    select: "選擇一個版本以預覽內容。",
    retention: (preferences: FilePreferences) =>
      `歷史儲存在這部電腦，最多保留 ${preferences.localHistoryDays} 天：每個檔案 ${preferences.localHistoryVersions} 個版本、每個新版本 ${preferences.localHistorySnapshotMiB} MiB、每個工作區 ${preferences.localHistoryWorkspaceMiB} MiB。達到容量限制時，較早版本可能提前移除。`,
    retentionTiming: "降低保留上限會在下次讀取或寫入歷史時套用。",
    historyDisabled: "已停止新增本機歷史版本，既有版本仍可瀏覽。",
    reasons: { save: "已儲存版本", external: "外部變更", delete: "刪除" },
  },
} as const;

interface CommonProps {
  locale: Locale;
  resolvedTheme: "dark" | "light";
  file: string;
  busy: boolean;
  error?: string | undefined;
  onClose(): void;
}

export interface FileConflictDialogProps extends CommonProps {
  localContent: string;
  diskContent: string | null;
  onReload(): void;
  onKeepLocal(): void;
}

export interface LocalHistoryDialogProps extends CommonProps {
  preferences?: FilePreferences | undefined;
  currentContent: string;
  entries: LocalHistoryEntry[];
  selectedId?: string | undefined;
  selectedContent?: string | undefined;
  loading: boolean;
  onSelect(id: string): void;
  onRestore(): void;
}

let reviewSequence = 0;

/** Separate models avoid disturbing the live editor, its undo stack, or language services. */
function FileDiff({
  file,
  original,
  modified,
  originalLabel,
  modifiedLabel,
  resolvedTheme,
}: {
  file: string;
  original: string;
  modified: string;
  originalLabel: string;
  modifiedLabel: string;
  resolvedTheme: "dark" | "light";
}): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | undefined>(undefined);
  const models = useRef<monaco.editor.IDiffEditorModel | undefined>(undefined);
  useEffect(() => {
    if (!container.current) return;
    const sequence = ++reviewSequence;
    const language = file.toLowerCase().endsWith(".json") ? "json" : "basic-plus";
    const model = (side: string) =>
      monaco.editor.createModel(
        "",
        language,
        monaco.Uri.from({ scheme: "kobrixa-review", path: `/${sequence}/${side}/${file}` }),
      );
    const pair = { original: model("original"), modified: model("modified") };
    const instance = monaco.editor.createDiffEditor(container.current, {
      automaticLayout: true,
      readOnly: true,
      domReadOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      renderSideBySideInlineBreakpoint: 520,
      useInlineViewWhenSpaceIsLimited: true,
      enableSplitViewResizing: true,
      renderOverviewRuler: false,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      fontSize: 13,
      lineNumbersMinChars: 3,
      wordWrap: "on",
      contextmenu: false,
      renderIndicators: true,
      diffAlgorithm: "advanced",
      maxComputationTime: 2000,
    });
    restoreEditorHoverDelegate();
    models.current = pair;
    editor.current = instance;
    instance.setModel(pair);
    return () => {
      editor.current = undefined;
      models.current = undefined;
      instance.dispose();
      restoreEditorHoverDelegate();
      pair.original.dispose();
      pair.modified.dispose();
    };
  }, [file]);
  useEffect(() => {
    models.current?.original.setValue(original);
    models.current?.modified.setValue(modified);
  }, [file, original, modified]);
  useEffect(() => {
    monaco.editor.setTheme(`kobrixa-${resolvedTheme}`);
    editor.current?.getOriginalEditor().updateOptions({ ariaLabel: `${originalLabel}: ${file}` });
    editor.current?.getModifiedEditor().updateOptions({ ariaLabel: `${modifiedLabel}: ${file}` });
  }, [file, resolvedTheme, originalLabel, modifiedLabel]);
  return (
    <div className="file-review-diff">
      <div className="file-review-diff-labels" aria-hidden="true">
        <span>{originalLabel}</span>
        <span>{modifiedLabel}</span>
      </div>
      <div className="file-review-diff-editor" ref={container} />
    </div>
  );
}

export function FileConflictDialog({
  locale,
  resolvedTheme,
  file,
  localContent,
  diskContent,
  busy,
  error,
  onClose,
  onReload,
  onKeepLocal,
}: FileConflictDialogProps): React.JSX.Element {
  const t = copy[locale];
  const descriptionId = useId();
  return (
    <Dialog
      className="file-review-dialog file-conflict-dialog"
      title={t.conflictTitle}
      descriptionId={descriptionId}
      onClose={() => {
        if (!busy) onClose();
      }}
      intro={
        <>
          <p className="file-review-path">{file}</p>
          <p className="file-review-description" id={descriptionId}>
            {diskContent === null ? t.missingDescription : t.conflictDescription}
          </p>
        </>
      }
    >
      <div className="file-review-content" aria-busy={busy}>
        <FileDiff
          file={file}
          resolvedTheme={resolvedTheme}
          original={diskContent ?? ""}
          modified={localContent}
          originalLabel={diskContent === null ? t.missing : t.disk}
          modifiedLabel={t.local}
        />
      </div>
      {diskContent !== null && <p className="file-review-note">{t.overwriteHint}</p>}
      {error && (
        <p className="file-review-error" role="alert">
          {error}
        </p>
      )}
      <DialogActions>
        <button
          data-modal-initial
          data-file-review-action="close"
          disabled={busy}
          onClick={onClose}
        >
          {t.close}
        </button>
        <button
          data-file-review-action="reload"
          disabled={busy || diskContent === null}
          onClick={onReload}
        >
          {t.reload}
        </button>
        <button
          className="primary"
          data-file-review-action="save"
          disabled={busy}
          onClick={onKeepLocal}
        >
          {diskContent === null ? t.recreate : t.save}
        </button>
      </DialogActions>
    </Dialog>
  );
}

function formatSize(size: number, locale: Locale): string {
  return size < 1024
    ? `${size.toLocaleString(locale)} B`
    : `${(size / 1024).toLocaleString(locale, { maximumFractionDigits: 1 })} KiB`;
}

export function LocalHistoryDialog({
  preferences = DEFAULT_FILE_PREFERENCES,
  locale,
  resolvedTheme,
  file,
  currentContent,
  entries,
  selectedId,
  selectedContent,
  loading,
  busy,
  error,
  onSelect,
  onRestore,
  onClose,
}: LocalHistoryDialogProps): React.JSX.Element {
  const t = copy[locale];
  const descriptionId = useId();
  const selected = entries.find((entry) => entry.id === selectedId);
  const formatter = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" });
  const previewReady = !!selected && selectedContent !== undefined && !loading;
  return (
    <Dialog
      className="file-review-dialog local-history-dialog"
      title={t.historyTitle}
      descriptionId={descriptionId}
      onClose={() => {
        if (!busy) onClose();
      }}
      intro={
        <>
          <p className="file-review-path">{file}</p>
          <p className="file-review-description" id={descriptionId}>
            {t.historyDescription}
          </p>
        </>
      }
    >
      <div className="file-review-content file-history-content" aria-busy={loading || busy}>
        <nav className="file-history-versions" aria-label={t.historyList}>
          <h3>{t.historyList}</h3>
          <ul>
            {entries.map((entry) => (
              <li key={entry.id}>
                <button
                  data-history-id={entry.id}
                  aria-pressed={selectedId === entry.id}
                  disabled={busy}
                  onClick={() => onSelect(entry.id)}
                >
                  <time dateTime={new Date(entry.timestamp).toISOString()}>
                    {formatter.format(entry.timestamp)}
                  </time>
                  <span>
                    {t.reasons[entry.reason]} · {formatSize(entry.size, locale)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        {previewReady ? (
          <FileDiff
            file={file}
            resolvedTheme={resolvedTheme}
            original={selectedContent}
            modified={currentContent}
            originalLabel={t.savedVersion}
            modifiedLabel={t.editor}
          />
        ) : (
          <p className="file-review-placeholder" role="status">
            {loading ? t.loading : !entries.length ? t.empty : t.select}
          </p>
        )}
      </div>
      <p className="file-review-note">
        {t.retention(preferences)} {t.retentionTiming}
        {!preferences.localHistoryEnabled && <> {t.historyDisabled}</>}
      </p>
      {error && (
        <p className="file-review-error" role="alert">
          {error}
        </p>
      )}
      <DialogActions>
        <button
          data-modal-initial
          data-file-review-action="close"
          disabled={busy}
          onClick={onClose}
        >
          {t.close}
        </button>
        <button
          className="primary"
          data-file-review-action="restore"
          disabled={busy || !previewReady}
          onClick={onRestore}
        >
          {t.restore}
        </button>
      </DialogActions>
    </Dialog>
  );
}
