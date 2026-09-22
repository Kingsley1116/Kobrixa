import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Locale, Copy } from "./copy.js";
import type { ExecutionState } from "./execution.js";
import { Modal } from "./workbench-ui.js";
import {
  PROJECT_ROOT,
  protectedRemotePath,
  type RemoteFilesController,
  type RemoteFilesState,
} from "./remote-files.js";
import type { RemoteEntry } from "../shared/api.js";

export type ToolTab = "connection" | "files" | "activity";
const labels = {
  en: {
    tools: "EV3 tools",
    connection: "Connection",
    files: "EV3 files",
    activity: "Activity",
    close: "Close tools",
    up: "Up",
    refresh: "Refresh",
    upload: "Upload file",
    download: "Download",
    mkdir: "New folder",
    rename: "Rename",
    remove: "Delete",
    cancel: "Cancel",
    save: "Apply",
    name: "Name",
    folder: "Folder",
    file: "File",
    size: "Size",
    root: "Projects",
    loading: "Reading EV3…",
    empty: "This folder is empty.",
    disconnected: "Connect an EV3 to browse its project files.",
    connect: "Open connection",
    retry: "Read folder again",
    failed: "File operation failed",
    permission: "EV3 denied access to this location.",
    missing: "This folder or file no longer exists.",
    interrupted: "The transfer was interrupted. Check the connection.",
    hint: "Refresh to check the result before retrying a change. Writes are never retried automatically.",
    details: "Original details",
    busy: "EV3 operation in progress…",
    readonly: "Storage root",
    renameHint: "Renaming copies and verifies the contents before removing the source.",
    folderHint: "Use letters, numbers, spaces, underscores or hyphens.",
  },
  "zh-TW": {
    tools: "EV3 工具",
    connection: "連線",
    files: "EV3 檔案",
    activity: "操作紀錄",
    close: "關閉工具面板",
    up: "上一層",
    refresh: "重新整理",
    upload: "上傳檔案",
    download: "下載",
    mkdir: "建立資料夾",
    rename: "重新命名",
    remove: "刪除",
    cancel: "取消",
    save: "套用",
    name: "名稱",
    folder: "資料夾",
    file: "檔案",
    size: "大小",
    root: "專案區",
    loading: "正在讀取 EV3…",
    empty: "此資料夾沒有內容。",
    disconnected: "連線 EV3 後，即可瀏覽裝置上的專案檔案。",
    connect: "開啟連線頁",
    retry: "重新讀取資料夾",
    failed: "檔案操作失敗",
    permission: "EV3 不允許存取此位置。",
    missing: "此資料夾或檔案已不存在。",
    interrupted: "傳輸已中斷，請檢查連線。",
    hint: "請重新整理確認結果，再決定是否重做修改；不會自動重試寫入。",
    details: "原始詳細資訊",
    busy: "正在操作 EV3…",
    readonly: "儲存區根目錄",
    renameHint: "重新命名會先複製並核對內容，再刪除來源。",
    folderHint: "請使用英文字母、數字、空格、底線或連字號。",
  },
};
export function ToolsPanel({
  tab,
  onTab,
  locale,
  onClose,
  connection,
  files,
  activity,
}: {
  tab: ToolTab;
  onTab(tab: ToolTab): void;
  locale: Locale;
  onClose(): void;
  connection: ReactNode;
  files: ReactNode;
  activity: ReactNode;
}): React.JSX.Element {
  const t = labels[locale];
  const tabs: ToolTab[] = ["connection", "files", "activity"];
  const bar = useRef<HTMLDivElement>(null);
  return (
    <>
      <div className="tools-heading">
        <h2>{t.tools}</h2>
        <button aria-label={t.close} onClick={onClose}>
          ×
        </button>
      </div>
      <div
        className="tools-tabs"
        data-active-tab={tab}
        role="tablist"
        aria-label={t.tools}
        ref={bar}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const index =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? 2
                : (tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : 2)) % 3;
          onTab(tabs[index]!);
          bar.current?.querySelectorAll<HTMLButtonElement>("button")[index]?.focus();
        }}
      >
        {tabs.map((value) => (
          <button
            key={value}
            id={`tool-tab-${value}`}
            role="tab"
            aria-selected={tab === value}
            aria-controls={`tool-panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => onTab(value)}
          >
            {t[value]}
          </button>
        ))}
      </div>
      {tabs.map((value) => (
        <div
          className="tool-content"
          key={value}
          id={`tool-panel-${value}`}
          role="tabpanel"
          aria-labelledby={`tool-tab-${value}`}
          hidden={tab !== value}
          tabIndex={0}
        >
          {value === "connection" ? connection : value === "files" ? files : activity}
        </div>
      ))}
    </>
  );
}
export function ActivityPanel({
  t,
  locale,
  state,
}: {
  t: Copy;
  locale: Locale;
  state: ExecutionState;
}): React.JSX.Element {
  return (
    <div className="activity-list" role="log" aria-label={t.activity}>
      {!state.logs.length && <p>{t.noActivity}</p>}
      {[...state.logs].reverse().map((entry) => (
        <div className={`activity-row ${entry.failed ? "failed" : ""}`} key={entry.id}>
          <time>{new Date(entry.time).toLocaleTimeString(locale, { hour12: false })}</time>
          <div>
            <span>
              {entry.failed ? `${t.phases.error} · ` : ""}
              {t.messages[entry.message]}
            </span>
            {entry.detail && <pre>{entry.detail}</pre>}
          </div>
        </div>
      ))}
    </div>
  );
}
export function RemoteFilesPanel({
  controller,
  state,
  active,
  locale,
  locked,
  deployedPath,
  onConnect,
}: {
  controller: RemoteFilesController;
  state: RemoteFilesState;
  active: boolean;
  locale: Locale;
  locked: boolean;
  deployedPath: string | undefined;
  onConnect(): void;
}): React.JSX.Element {
  const t = labels[locale];
  const [selected, setSelected] = useState<string>();
  const [form, setForm] = useState<{ action: "mkdir" | "rename"; path: string; name: string }>();
  const [name, setName] = useState("");
  useEffect(() => {
    setSelected(undefined);
    setForm(undefined);
  }, [state.path, state.sessionId]);
  useEffect(() => {
    if (active && state.sessionId && !state.loaded && !state.busy && !locked) {
      const initial = deployedPath?.slice(0, deployedPath.lastIndexOf("/"));
      void controller.perform(
        "list",
        initial?.startsWith(`${PROJECT_ROOT}/`) ? initial : state.path,
        locale,
      );
    }
  }, [
    active,
    state.sessionId,
    state.loaded,
    state.busy,
    locked,
    deployedPath,
    controller,
    locale,
    state.path,
  ]);
  const busy = state.busy || locked;
  const item = state.entries.find((entry) => entry.path === selected);
  const mutable = item && !protectedRemotePath(item.path);
  const navigate = (path: string): void => {
    void controller.perform("list", path, locale);
  };
  const openForm = (action: "mkdir" | "rename", item?: RemoteEntry): void => {
    setName(item?.name ?? "");
    setForm({ action, path: item?.path ?? state.path, name: item?.name ?? "" });
  };
  const crumbs = [
    PROJECT_ROOT,
    ...state.path
      .slice(PROJECT_ROOT.length)
      .split("/")
      .filter(Boolean)
      .map((_, index, parts) => `${PROJECT_ROOT}/${parts.slice(0, index + 1).join("/")}`),
  ];
  return (
    <div className="remote-files">
      {!state.sessionId ? (
        <div className="remote-empty">
          <p>{t.disconnected}</p>
          <button onClick={onConnect}>{t.connect}</button>
          {state.error && (
            <div role="alert">
              <p>{t.interrupted}</p>
              <details>
                <summary>{t.details}</summary>
                <pre>{state.error.message}</pre>
              </details>
            </div>
          )}
        </div>
      ) : (
        <>
          <nav className="remote-breadcrumbs" aria-label={t.files}>
            {crumbs.map((path, index) => (
              <button
                key={path}
                title={path}
                disabled={busy || path === state.path}
                onClick={() => navigate(path)}
              >
                {index === 0 ? t.root : path.split("/").at(-1)}
                {index < crumbs.length - 1 ? " ›" : ""}
              </button>
            ))}
          </nav>
          <div className="remote-actions">
            <button
              disabled={busy || state.path === PROJECT_ROOT}
              onClick={() => navigate(state.path.slice(0, state.path.lastIndexOf("/")))}
            >
              {t.up}
            </button>
            <button disabled={busy} onClick={() => navigate(state.path)}>
              {t.refresh}
            </button>
            <button
              disabled={busy}
              onClick={() => void controller.perform("upload", state.path, locale)}
            >
              {t.upload}
            </button>
            <button disabled={busy} onClick={() => openForm("mkdir")}>
              {t.mkdir}
            </button>
          </div>
          {state.error && (
            <div className="operation-error" role="alert">
              <strong>{t.failed}</strong>
              <p>
                {state.error.category === "permission"
                  ? t.permission
                  : state.error.category === "not-found"
                    ? t.missing
                    : ["connection", "timeout", "transfer"].includes(state.error.category)
                      ? t.interrupted
                      : t.hint}
              </p>
              <details>
                <summary>{t.details}</summary>
                <pre>{state.error.message}</pre>
              </details>
              <button disabled={busy} onClick={() => navigate(state.path)}>
                {t.retry}
              </button>
              <button onClick={onConnect}>{t.connect}</button>
            </div>
          )}
          <div className="remote-status" role="status" aria-live="polite">
            {state.busy
              ? state.progress
                ? `${state.progress.transferred.toLocaleString()} / ${state.progress.total.toLocaleString()} ${locale === "en" ? "bytes" : "位元組"}`
                : t.loading
              : locked
                ? t.busy
                : ""}
          </div>
          {!state.entries.length && state.loaded && !state.busy && !state.error && (
            <p className="remote-empty">{t.empty}</p>
          )}
          <div
            className="remote-list"
            role="listbox"
            aria-label={t.files}
            aria-busy={state.busy}
            onKeyDown={(event) => {
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
              const index = rows.indexOf(document.activeElement as HTMLButtonElement);
              rows[
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? rows.length - 1
                    : Math.max(
                        0,
                        Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)),
                      )
              ]?.focus();
            }}
          >
            {state.entries.map((entry) => (
              <button
                key={entry.path}
                role="option"
                aria-selected={selected === entry.path}
                disabled={busy}
                title={entry.path}
                onFocus={() => setSelected(entry.path)}
                onClick={() => setSelected(entry.path)}
                onDoubleClick={() => {
                  if (entry.kind === "directory") navigate(entry.path);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && entry.kind === "directory") navigate(entry.path);
                }}
              >
                <span className="remote-entry-name">
                  {entry.kind === "directory" ? "▸" : "·"} {entry.name}
                </span>
                <span>
                  {entry.kind === "directory" ? t.folder : t.file} ·{" "}
                  {entry.size === undefined ? "—" : formatSize(entry.size)}
                </span>
              </button>
            ))}
          </div>
          {item && (
            <div className="remote-selection">
              <strong title={item.path}>{item.name}</strong>
              <div className="remote-actions">
                {item.kind === "directory" ? (
                  <button disabled={busy} onClick={() => navigate(item.path)}>
                    {t.files} →
                  </button>
                ) : (
                  <button
                    disabled={busy}
                    onClick={() => void controller.perform("download", item.path, locale)}
                  >
                    {t.download}
                  </button>
                )}
                <button disabled={busy || !mutable} onClick={() => openForm("rename", item)}>
                  {t.rename}
                </button>
                <button
                  className="danger"
                  disabled={busy || !mutable}
                  onClick={() => void controller.perform("delete", item.path, locale)}
                >
                  {t.remove}
                </button>
              </div>
              {!mutable && <small>{t.readonly}</small>}
            </div>
          )}
        </>
      )}
      {form && (
        <Modal onClose={() => setForm(undefined)}>
          <form
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="remote-form-title"
            onSubmit={(event) => {
              event.preventDefault();
              if (busy || !name.trim()) return;
              const pending = form;
              setForm(undefined);
              void controller.perform(pending.action, pending.path, locale, name);
            }}
          >
            <h2 id="remote-form-title">{form.action === "mkdir" ? t.mkdir : t.rename}</h2>
            <p className="remote-target">{form.path}</p>
            <label>
              {t.name}
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                pattern="[A-Za-z0-9_. -]+"
              />
            </label>
            <p>{form.action === "rename" ? t.renameHint : t.folderHint}</p>
            <div className="modal-actions">
              <button type="button" onClick={() => setForm(undefined)}>
                {t.cancel}
              </button>
              <button className="primary" type="submit" disabled={busy || !name.trim()}>
                {t.save}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
function formatSize(bytes: number): string {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
