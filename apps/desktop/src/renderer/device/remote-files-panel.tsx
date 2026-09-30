import { Dialog, DialogActions } from "../components/dialog.js";
import { useEffect, useRef, useState } from "react";
import type { FileBatchSnapshot, RemoteEntry } from "../../shared/api.js";
import type { Locale } from "../i18n/copy.js";
import { ActionMenu } from "../components/action-menu.js";
import { Icon } from "../components/icon.js";
import { canFocus } from "../components/modal.js";
import {
  PROJECT_ROOT,
  protectedRemotePath,
  type RemoteFilesController,
  type RemoteFilesState,
} from "./remote-files.js";
import { remoteCopy, formatSize, type RemoteCopy } from "./remote-files-copy.js";
import { visibleRemoteEntries } from "./remote-selection.js";
import { Picker } from "../components/picker.js";
import { selectVisible } from "../components/selection.js";

function RemoteNavigation({
  path,
  busy,
  t,
  navigate,
  upload,
  create,
}: {
  path: string;
  busy: boolean;
  t: RemoteCopy;
  navigate(path: string): void;
  upload(source: "files" | "folders"): void;
  create(): void;
}): React.JSX.Element {
  const crumbs = [
    PROJECT_ROOT,
    ...path
      .slice(PROJECT_ROOT.length)
      .split("/")
      .filter(Boolean)
      .map((_, index, parts) => `${PROJECT_ROOT}/${parts.slice(0, index + 1).join("/")}`),
  ];
  const crumb = (p: string) => (
    <button
      key={p}
      title={p}
      disabled={busy || path === p}
      aria-current={path === p ? "page" : undefined}
      onClick={() => navigate(p)}
    >
      {p === PROJECT_ROOT ? t.root : p.split("/").at(-1)}
    </button>
  );
  return (
    <header className="remote-navigation">
      <nav className="remote-breadcrumbs" aria-label={t.files}>
        {crumb(PROJECT_ROOT)}
        {crumbs.length > 2 && (
          <ActionMenu label={t.ancestors}>
            {crumbs.slice(1, -1).map((p) => (
              <button role="menuitem" key={p} disabled={busy} title={p} onClick={() => navigate(p)}>
                {p.slice(PROJECT_ROOT.length + 1)}
              </button>
            ))}
          </ActionMenu>
        )}
        {path !== PROJECT_ROOT && (
          <>
            <span aria-hidden="true">/</span>
            {crumb(path)}
          </>
        )}
      </nav>
      <div className="remote-toolbar">
        <button
          className="remote-icon-button"
          title={t.up}
          aria-label={t.up}
          disabled={busy || path === PROJECT_ROOT}
          onClick={() => navigate(path.slice(0, path.lastIndexOf("/")))}
        >
          <span className="remote-up">
            <Icon name="arrow" />
          </span>
        </button>
        <button
          className="remote-icon-button"
          title={t.refresh}
          aria-label={t.refresh}
          disabled={busy}
          onClick={() => navigate(path)}
        >
          <span aria-hidden="true">↻</span>
        </button>
        <ActionMenu
          label={t.upload}
          visibleLabel={
            <>
              {t.upload}
              <span aria-hidden="true">⌄</span>
            </>
          }
        >
          <button role="menuitem" disabled={busy} onClick={() => upload("files")}>
            {t.uploadFiles}
          </button>
          <button role="menuitem" disabled={busy} onClick={() => upload("folders")}>
            {t.uploadFolders}
          </button>
        </ActionMenu>
        <button
          className="remote-icon-button"
          title={t.mkdir}
          aria-label={t.mkdir}
          disabled={busy}
          onClick={create}
        >
          <Icon name="plus" />
        </button>
      </div>
    </header>
  );
}
function RemoteError({
  error,
  refresh,
  t,
  busy,
  retry,
  connect,
}: {
  error: NonNullable<RemoteFilesState["error"]>;
  refresh?: boolean;
  t: RemoteCopy;
  busy: boolean;
  retry(): void;
  connect(): void;
}): React.JSX.Element {
  const message =
    error.category === "permission"
      ? t.permission
      : error.category === "not-found"
        ? t.missing
        : ["connection", "timeout", "transfer"].includes(error.category)
          ? t.interrupted
          : t.generic;
  return (
    <div className="remote-error" role="alert">
      <strong>{refresh ? t.refreshFailed : t.failed}</strong>
      <p>{message}</p>
      <details>
        <summary>{t.details}</summary>
        <pre>{error.message}</pre>
      </details>
      <div className="remote-actions">
        <button disabled={busy} onClick={retry}>
          {t.retry}
        </button>
        <button disabled={busy} onClick={connect}>
          {t.connect}
        </button>
      </div>
    </div>
  );
}
function BatchStatus({
  batch,
  t,
  busy,
  onStop,
  onReview,
  onClear,
}: {
  batch: FileBatchSnapshot;
  t: RemoteCopy;
  busy: boolean;
  onStop(): void;
  onReview(): void;
  onClear(): void;
}): React.JSX.Element {
  const terminal = !["checking", "ready", "running"].includes(batch.phase);
  const completed = batch.items.filter(
    (item) => item.status === "succeeded" || item.status === "skipped",
  ).length;
  const current = batch.items.find((item) => item.id === batch.currentId);
  const phase =
    batch.phase === "running"
      ? t[`${batch.action}Action`]
      : batch.phase === "failed"
        ? t.failed
        : t[batch.phase];
  const statuses = {
    succeeded: t.succeeded,
    skipped: t.skipped,
    pending: t.pending,
    failed: t.failedItem,
    running: t.runningItem,
  };
  if (batch.phase === "cancelled")
    return (
      <section
        className="remote-batch cancelled remote-batch-compact"
        aria-label={t.results}
        tabIndex={-1}
      >
        <span role="status">{t.cancelled}</span>
        <button disabled={busy} aria-label={t.dismiss} title={t.dismiss} onClick={onClear}>
          ×
        </button>
      </section>
    );
  return (
    <section className={`remote-batch ${batch.phase}`} aria-label={t.results} tabIndex={-1}>
      <div className="remote-batch-heading">
        <strong role="status">{phase}</strong>
        <span>
          {completed} / {batch.items.length}
        </span>
      </div>
      {current && !terminal && (
        <p className="remote-current" title={current.label}>
          {current.label}
        </p>
      )}
      {batch.progress && !terminal && (
        <>
          <progress
            max={Math.max(1, batch.progress.total)}
            value={batch.progress.transferred}
            aria-label={phase}
          />
          <small>
            {formatSize(batch.progress.transferred)} / {formatSize(batch.progress.total)}
          </small>
        </>
      )}
      {batch.phase === "ready" && (
        <button className="primary" onClick={onReview}>
          {t.review}
        </button>
      )}
      {["running", "checking"].includes(batch.phase) && (
        <button disabled={batch.stopRequested} title={t.stopHint} onClick={onStop}>
          {batch.stopRequested ? t.stopping : batch.phase === "checking" ? t.cancelCheck : t.stop}
        </button>
      )}
      {batch.issues.length > 0 && (
        <div role="alert">
          <p>{t.generic}</p>
          <details>
            <summary>
              {t.details} ({batch.issues.length})
            </summary>
            {batch.issues.map((issue, i) => (
              <pre key={i}>{issue}</pre>
            ))}
          </details>
        </div>
      )}
      {terminal && (
        <>
          {(batch.phase === "failed" || batch.phase === "stopped") && completed > 0 && (
            <p>{t.partial}</p>
          )}
          {batch.action === "upload" && batch.items.some((item) => item.status === "failed") && (
            <p>{t.uploadPartial}</p>
          )}
          {!!batch.items.length && (
            <details>
              <summary>{t.results}</summary>
              <ul className="remote-results">
                {batch.items.map((item) => (
                  <li key={item.id}>
                    <span title={item.label}>{item.label}</span>
                    <strong data-status={item.status}>{statuses[item.status]}</strong>
                    {item.message && <pre>{item.message}</pre>}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <button disabled={busy} onClick={onClear}>
            {t.dismiss}
          </button>
        </>
      )}
    </section>
  );
}
function DeleteConfirmation({
  batch,
  path,
  t,
  onClose,
  onExecute,
}: {
  batch: FileBatchSnapshot;
  path: string;
  t: RemoteCopy;
  onClose(): void;
  onExecute(): void;
}): React.JSX.Element {
  const submitted = useRef(false);
  const directories = batch.items.filter((item) => item.kind === "directory").length;
  return (
    <Dialog
      onClose={onClose}
      restoreFocus={false}
      title={t.confirmDelete}
      titleId="delete-title"
      className="remote-delete-confirm"
      role="alertdialog"
      descriptionId="delete-warning"
      intro={
        <>
          <p>{t.deleteCount(batch.items.length - directories, directories)}</p>
          <p className="modal-warning" id="delete-warning">
            {t.deleteWarning}
          </p>
        </>
      }
    >
      <ul className="remote-delete-targets" aria-label={t.items} tabIndex={0}>
        {batch.items.map((item) => (
          <li key={item.id}>
            <Icon name={item.kind === "directory" ? "folder" : "code"} />
            <div>
              <strong>{item.label.split("/").at(-1)}</strong>
              <small>{`${path}/${item.label}`}</small>
            </div>
          </li>
        ))}
      </ul>
      <DialogActions>
        <button type="button" data-modal-initial onClick={onClose}>
          {t.cancel}
        </button>
        <button
          type="button"
          className="danger"
          onClick={() => {
            if (submitted.current) return;
            submitted.current = true;
            onExecute();
          }}
        >
          {t.confirmDelete}
        </button>
      </DialogActions>
    </Dialog>
  );
}
function BatchConfirmation({
  batch,
  path,
  locale,
  t,
  onClose,
  onExecute,
}: {
  batch: FileBatchSnapshot;
  path: string;
  locale: Locale;
  t: RemoteCopy;
  onClose(): void;
  onExecute(policy: "skip" | "replace"): void;
}): React.JSX.Element {
  const [policy, setPolicy] = useState<"skip" | "replace">("skip");
  const submitted = useRef(false);
  const conflicts = batch.items.filter((item) => item.conflict);
  const size = batch.items.reduce((sum, item) => sum + (item.size ?? 0), 0);
  if (batch.action === "delete")
    return (
      <DeleteConfirmation
        batch={batch}
        path={path}
        t={t}
        onClose={onClose}
        onExecute={() => onExecute("skip")}
      />
    );
  return (
    <Dialog
      onClose={onClose}
      restoreFocus={false}
      title={t.review}
      titleId="batch-title"
      className="remote-confirm"
      onSubmit={() => {
        if (submitted.current) return;
        submitted.current = true;
        onExecute(policy);
      }}
    >
      <p>
        {batch.items.length} {t.items} · {t.bytesKnown}: {formatSize(size)}
      </p>
      <p>{t.merge}</p>
      <ul className="remote-review-items">
        {batch.items.map((item) => (
          <li key={item.id}>
            <span title={item.label}>{item.label}</span>
            {item.conflict && <strong>{t.conflicts}</strong>}
          </li>
        ))}
      </ul>
      {!!conflicts.length && (
        <label>
          {t.conflicts} ({conflicts.length})
          <Picker<"skip" | "replace">
            locale={locale}
            label={t.conflicts}
            value={policy}
            onChange={setPolicy}
            options={[
              { value: "skip", label: t.skip },
              { value: "replace", label: t.replace },
            ]}
          />
        </label>
      )}
      <DialogActions>
        <button type="button" data-modal-initial onClick={onClose}>
          {t.cancel}
        </button>
        <button type="submit" className="primary">
          {t.confirm}
        </button>
      </DialogActions>
    </Dialog>
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
  const t = remoteCopy[locale];
  const [selected, setSelected] = useState<string[]>([]),
    [query, setQuery] = useState("");
  const [form, setForm] = useState<{ action: "mkdir" | "rename"; path: string }>(),
    [name, setName] = useState("");
  const [formError, setFormError] = useState<string>(),
    [confirm, setConfirm] = useState(false);
  const list = useRef<HTMLDivElement>(null),
    returnFocus = useRef<HTMLElement | null>(null);
  const focusAfterMutation = useRef<string | undefined>(undefined);
  const focusAfterBatch = useRef<"cancel" | "execute" | undefined>(undefined);
  const panel = useRef<HTMLDivElement>(null);
  const selectAll = useRef<HTMLInputElement>(null);
  const busy = state.busy || locked;
  const entries = visibleRemoteEntries(state.entries, query);
  const selectable = entries.filter((entry) => !protectedRemotePath(entry.path));
  const checkedCount = selectable.filter((entry) => selected.includes(entry.path)).length;
  const hiddenCount = selected.filter(
    (path) => !entries.some((entry) => entry.path === path),
  ).length;
  useEffect(() => {
    if (selectAll.current)
      selectAll.current.indeterminate = checkedCount > 0 && checkedCount < selectable.length;
  }, [checkedCount, selectable.length]);
  useEffect(() => {
    if (confirm || !focusAfterBatch.current) return;
    if (focusAfterBatch.current === "cancel") {
      if (busy) return;
      if (canFocus(returnFocus.current)) returnFocus.current.focus();
      else list.current?.querySelector<HTMLElement>("[data-picker-value]")?.focus();
    } else panel.current?.querySelector<HTMLElement>(".remote-batch")?.focus();
    focusAfterBatch.current = undefined;
  }, [busy, confirm]);
  useEffect(() => {
    setSelected([]);
    setQuery("");
    setForm(undefined);
  }, [state.path, state.sessionId]);
  useEffect(() => {
    list.current?.scrollTo({ top: 0 });
  }, [state.path, query]);
  useEffect(() => {
    setSelected((previous) =>
      previous.filter((p) => state.entries.some((item) => item.path === p)),
    );
  }, [state.entries]);
  useEffect(() => {
    if (form || !focusAfterMutation.current) return;
    const target = focusAfterMutation.current;
    focusAfterMutation.current = undefined;
    const frame = window.requestAnimationFrame(() => {
      [...(list.current?.querySelectorAll<HTMLElement>("[data-picker-value]") ?? [])]
        .find((row) => row.dataset.pickerValue === target)
        ?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [form]);
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
  useEffect(() => {
    if (active && state.batch?.phase === "ready") setConfirm(true);
    else if (state.batch?.phase !== "ready") setConfirm(false);
  }, [active, state.batch?.phase]);
  const navigate = (path: string) => {
    const changed = path !== state.path;
    void controller.perform("list", path, locale).then((success) => {
      if (success && changed)
        window.requestAnimationFrame(() =>
          list.current?.querySelector<HTMLElement>("[data-picker-value]")?.focus(),
        );
    });
  };
  const start = (
    action: "upload" | "download" | "delete",
    source: "files" | "folders" = "files",
  ) => {
    returnFocus.current = document.activeElement as HTMLElement;
    void controller.prepareBatch(action, selected, source, locale);
  };
  const restoreFocus = () =>
    window.requestAnimationFrame(() => {
      if (canFocus(returnFocus.current)) returnFocus.current.focus();
      else list.current?.querySelector<HTMLElement>("[data-picker-value]")?.focus();
    });
  const closeForm = () => {
    setForm(undefined);
    restoreFocus();
  };
  const openForm = (action: "mkdir" | "rename", item?: RemoteEntry) => {
    returnFocus.current = document.activeElement as HTMLElement;
    setFormError(undefined);
    setName(item?.name ?? "");
    setForm({ action, path: item?.path ?? state.path });
  };
  const changeQuery = (value: string) => {
    setQuery(value);
  };
  const item =
    selected.length === 1 ? state.entries.find((entry) => entry.path === selected[0]) : undefined;
  const actionLabel =
    state.action === "checking"
      ? t.checking
      : state.action === "refreshing"
        ? t.refreshing
        : state.action
          ? t[`${state.action}Action`]
          : locked
            ? t.busy
            : "";
  const error = state.error ?? state.refreshError;
  return (
    <div
      className="remote-files"
      ref={panel}
      onKeyDown={(event) => {
        if (!busy && !form && !confirm && event.key === "F2" && item) {
          event.preventDefault();
          openForm("rename", item);
        }
      }}
    >
      {!state.sessionId ? (
        <div className="remote-blank">
          <Icon name="device" />
          <p>{t.disconnected}</p>
          <button className="primary" onClick={onConnect}>
            {t.connect}
          </button>
        </div>
      ) : (
        <>
          <RemoteNavigation
            path={state.path}
            busy={busy}
            t={t}
            navigate={navigate}
            upload={(source) => start("upload", source)}
            create={() => openForm("mkdir")}
          />
          <div className="remote-search">
            <input
              type="search"
              aria-label={t.search}
              placeholder={t.search}
              value={query}
              disabled={busy}
              onChange={(event) => changeQuery(event.target.value)}
            />
          </div>
          <div className="remote-list-meta">
            <label className="remote-select-all">
              <input
                type="checkbox"
                ref={selectAll}
                disabled={busy || !selectable.length}
                checked={selectable.length > 0 && checkedCount === selectable.length}
                onChange={(event) =>
                  setSelected(
                    selectVisible(
                      entries.map((entry) => ({
                        value: entry.path,
                        disabled: protectedRemotePath(entry.path),
                      })),
                      selected,
                      event.target.checked,
                    ),
                  )
                }
              />
              {t.selectAll}
            </label>
            <span>
              {entries.length} {t.items}
            </span>
          </div>
          <Picker<string>
            key={`${state.sessionId}:${state.path}`}
            multiple
            presentation="list"
            locale={locale}
            label={t.files}
            value={selected}
            onChange={setSelected}
            disabled={busy}
            listRef={list}
            options={entries.map((entry) => ({
              value: entry.path,
              label: entry.name,
              title: entry.path,
              disabled: protectedRemotePath(entry.path),
              icon: <Icon name={entry.kind === "directory" ? "folder" : "code"} />,
              description: `${protectedRemotePath(entry.path) ? t.storage : entry.kind === "directory" ? t.folder : t.file}${entry.size === undefined ? "" : ` · ${formatSize(entry.size)}`}`,
              ...(entry.kind === "directory"
                ? { action: { label: t.open, run: () => navigate(entry.path) } }
                : {}),
            }))}
            empty={
              <div className="remote-blank">
                <Icon name="folder" />
                <p>{state.busy && !state.loaded ? t.listAction : query ? t.noMatch : t.empty}</p>
                {query && (
                  <button disabled={busy} onClick={() => changeQuery("")}>
                    {t.clearSearch}
                  </button>
                )}
              </div>
            }
          />
          <footer className="remote-selection-bar">
            <div>
              <strong role="status">
                {selected.length} {t.selected}
                {hiddenCount > 0 && ` · ${hiddenCount} ${t.hiddenSelected}`}
              </strong>
              <button disabled={busy || !selected.length} onClick={() => setSelected([])}>
                {t.clear}
              </button>
            </div>
            {hiddenCount > 0 && (
              <button className="remote-reveal" disabled={busy} onClick={() => changeQuery("")}>
                {t.clearSearch}
              </button>
            )}
            <div className="remote-actions">
              <button disabled={busy || !selected.length} onClick={() => start("download")}>
                {t.download}
              </button>
              <button disabled={busy || !item} onClick={() => openForm("rename", item)}>
                {t.rename}
              </button>
              <button
                className="danger"
                disabled={busy || !selected.length}
                onClick={() => start("delete")}
              >
                {t.remove}
              </button>
            </div>
          </footer>
        </>
      )}
      <div className="remote-feedback">
        {error && !form && (
          <RemoteError
            error={error}
            refresh={!!state.refreshError && !state.error}
            t={t}
            busy={busy}
            retry={() => navigate(state.path)}
            connect={onConnect}
          />
        )}
        {state.batch && (
          <BatchStatus
            batch={state.batch}
            t={t}
            busy={busy}
            onStop={() => void controller.stopBatch()}
            onReview={() => setConfirm(true)}
            onClear={() => controller.clearBatch()}
          />
        )}
        {actionLabel && (!state.batch || state.action === "refreshing") && (
          <p className="remote-operation-label" role="status">
            {actionLabel}
          </p>
        )}
      </div>
      {confirm && active && state.batch?.phase === "ready" && (
        <BatchConfirmation
          key={state.batch.planId}
          batch={state.batch}
          path={state.path}
          locale={locale}
          t={t}
          onClose={() => {
            focusAfterBatch.current = "cancel";
            setConfirm(false);
            void controller.stopBatch();
          }}
          onExecute={(policy) => {
            focusAfterBatch.current = "execute";
            setConfirm(false);
            controller.executeBatch(policy);
          }}
        />
      )}
      {form && (
        <Dialog
          onClose={() => {
            if (!state.busy) closeForm();
          }}
          title={form.action === "mkdir" ? t.mkdir : t.rename}
          titleId="remote-form-title"
          className="remote-entry-form"
          onSubmit={async () => {
            if (busy || !name.trim()) return;
            setFormError(undefined);
            if (await controller.perform(form.action, form.path, locale, name)) {
              closeForm();
              const parent =
                form.action === "mkdir"
                  ? form.path
                  : form.path.slice(0, form.path.lastIndexOf("/"));
              const target = `${parent}/${name}`;
              if (controller.getSnapshot().entries.some((entry) => entry.path === target)) {
                setQuery("");
                setSelected([target]);
                focusAfterMutation.current = target;
              }
            } else setFormError(controller.getSnapshot().error?.message ?? t.generic);
          }}
        >
          <p className="remote-target">{form.path}</p>
          <label>
            {t.name}
            <input
              data-modal-initial
              required
              pattern="[A-Za-z0-9_. -]+"
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <p>{form.action === "mkdir" ? t.nameHint : t.renameHint}</p>
          {formError && (
            <div role="alert">
              <strong>{t.failed}</strong>
              <p>{t.generic}</p>
              <pre>{formError}</pre>
            </div>
          )}
          <DialogActions>
            <button type="button" disabled={busy} onClick={closeForm}>
              {t.cancel}
            </button>
            <button className="primary" type="submit" disabled={busy || !name.trim()}>
              {t.apply}
            </button>
          </DialogActions>
        </Dialog>
      )}
    </div>
  );
}
