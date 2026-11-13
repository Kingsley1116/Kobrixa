import { useEffect, useState } from "react";
import type { CoreRecoveryPort } from "@kobrixa/plugin-runtime";
import type { Locale } from "../i18n/copy.js";
import type {
  LocalizedText,
  PluginCommandResult,
  PluginsResult,
  PluginsView,
  PluginSummary,
  PythonChoice,
  PythonChoiceId,
  StoredNotice,
} from "../../shared/plugins.js";
import {
  problemDetailLines,
  pluginCopy,
  problemText,
  pythonChoiceText,
  readableError,
} from "./plugin-copy.js";
import { PluginLog } from "./plugin-log.js";

export const localizedText = (text: LocalizedText, locale: Locale): string =>
  typeof text === "string" ? text : locale === "zh-TW" ? (text["zh-TW"] ?? text.en) : text.en;
export const pluginRowId = (sourceKey: string): string => `plugin-${sourceKey.replace(":", "-")}`;

/** Navigate only after main acknowledges the original opaque manage option. */
export function pluginRecoveryPort(port: CoreRecoveryPort, onManage: () => void): CoreRecoveryPort {
  return {
    snapshot: (input) => port.snapshot(input),
    onChanged: (listener) => port.onChanged(listener),
    async act(input) {
      const result = await port.act(input);
      if (
        result.ok &&
        result.value.items.some(
          (item) =>
            item.id === input.itemId &&
            item.actions.some((action) => action.id === input.actionId && action.kind === "manage"),
        )
      )
        onManage();
      return result;
    },
  };
}

const NOTICE_DISPLAY_LIMIT = 20;
type PanelError =
  | { kind: "problem"; code: string; message: string }
  | { kind: "request"; message?: string }
  | { kind: "notice"; copy: "notPersisted" | "alreadyLinked" };
type Pending = Readonly<Record<string, true>>;

const requestError = (reason: unknown): PanelError => {
  const message = readableError(reason);
  return message === undefined ? { kind: "request" } : { kind: "request", message };
};
const without = (pending: Pending, key: string): Pending => {
  const next: Record<string, true> = { ...pending };
  delete next[key];
  return next;
};
const mergeNotices = (incoming: readonly StoredNotice[], list: readonly StoredNotice[]) =>
  [...new Map([...list, ...incoming].map((notice) => [notice.id, notice])).values()]
    .sort((a, b) => b.id - a.id)
    .slice(0, NOTICE_DISPLAY_LIMIT);

export function PluginsPanel({ locale }: { locale: Locale }): React.JSX.Element {
  const t = pluginCopy[locale];
  const [state, setState] = useState<PluginsView>();
  const [notices, setNotices] = useState<StoredNotice[]>([]);
  const [pending, setPending] = useState<Pending>({});
  const [error, setError] = useState<PanelError>();
  const [highlight, setHighlight] = useState<string>();
  const [logFor, setLogFor] = useState<string>();
  const [candidates, setCandidates] = useState<PythonChoice[]>();
  // Action results can arrive after newer state events; keep the highest revision.
  const accept = (next: PluginsView) =>
    setState((current) => (current && current.revision > next.revision ? current : next));
  useEffect(() => {
    let live = true;
    void window.kobrixa.plugins.state().then(
      (value) => {
        if (live) accept(value);
      },
      (reason: unknown) => {
        if (live) setError(requestError(reason));
      },
    );
    void window.kobrixa.plugins.notices().then(
      (value) => {
        if (live) setNotices((list) => mergeNotices(value, list));
      },
      () => {},
    );
    const off = window.kobrixa.plugins.onEvent((event) => {
      if (event.type === "notice") {
        setNotices((list) => mergeNotices([event.notice], list));
        return;
      }
      accept(event.state);
      // A newer state supersedes a failed request; translated problems and notices stay.
      setError((current) => (current?.kind === "request" ? undefined : current));
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  const developerOn = state?.developer.enabled === true;
  const refreshPython = () =>
    window.kobrixa.plugins.pythonCandidates().then(setCandidates, () => setCandidates([]));
  useEffect(() => {
    if (developerOn) void refreshPython();
  }, [developerOn]);
  useEffect(() => {
    if (highlight)
      document.getElementById(pluginRowId(highlight))?.scrollIntoView?.({ block: "nearest" });
  }, [highlight]);
  const busy = (key: string) => pending[key] === true;
  const perform = async (
    key: string,
    work: () => Promise<PluginsResult | PluginCommandResult>,
  ): Promise<void> => {
    setPending((current) => ({ ...current, [key]: true }));
    setError(undefined);
    try {
      const result = await work();
      if (!result.ok) setError({ kind: "problem", code: result.code, message: result.message });
      else if ("state" in result) {
        accept(result.state);
        if (result.sourceKey) setHighlight(result.sourceKey);
        if (result.outcome === "duplicate") setError({ kind: "notice", copy: "alreadyLinked" });
        else if (result.persisted === false) setError({ kind: "notice", copy: "notPersisted" });
      }
    } catch (reason) {
      setError(requestError(reason));
    } finally {
      setPending((current) => without(current, key));
    }
  };
  const errorAlert = error && (
    <p className="settings-hint" role="alert">
      {error.kind === "problem"
        ? problemText(error, locale)
        : error.kind === "notice"
          ? t[error.copy]
          : `${t.requestFailed}${locale === "zh-TW" ? "：" : ": "}${error.message ?? t.unknownError}`}
    </p>
  );
  if (!state) return errorAlert ?? <p className="settings-hint">{t.loading}</p>;
  const row = (plugin: PluginSummary) => {
    const key = plugin.sourceKey;
    const origin = state.origins[key];
    const rowBusy = busy(`row:${key}`);
    const running = state.inflight.includes(key) || busy(`run:${key}`);
    const rowAction = (work: () => Promise<PluginsResult>) => () =>
      void perform(`row:${key}`, work);
    const enabling = plugin.status === "disabled" && plugin.disabledBy === "user";
    return (
      <li key={key} id={pluginRowId(key)} data-highlighted={highlight === key ? "" : undefined}>
        <h3 className="settings-subheading">
          {plugin.displayName ? localizedText(plugin.displayName, locale) : plugin.id}
        </h3>
        <p className="settings-hint">
          {[
            plugin.id,
            plugin.version,
            plugin.source === "builtin" ? t.builtin : t.development,
            origin === "session" ? t.sessionSource : undefined,
            plugin.runtime === "static" ? t.staticRuntime : plugin.runtime,
            t.status[plugin.status],
            plugin.runtime !== "static" && plugin.running ? t.running : undefined,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {plugin.directory && <p className="settings-hint">{plugin.directory}</p>}
        {plugin.problems.map((problem, index) => (
          <div key={index} className="settings-hint" style={{ overflowWrap: "anywhere" }}>
            <p>{problemText(problem, locale)}</p>
            {problem.detail && (
              <ul>
                {problemDetailLines(problem, locale).map((line, detailIndex) => (
                  <li key={detailIndex}>{line}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {state.python.pendingReload.includes(key) && (
          <p className="settings-hint">{t.pendingReload}</p>
        )}
        {plugin.commands.length > 0 && (
          <div role="group" aria-label={t.commands}>
            {plugin.commands.map((command) => (
              <button
                key={command.id}
                disabled={rowBusy || running || plugin.status !== "enabled"}
                onClick={() =>
                  void perform(`run:${key}`, () => window.kobrixa.plugins.execute(command.id))
                }
              >
                {localizedText(command.title, locale)}
              </button>
            ))}
            {running && (
              <button
                onClick={() =>
                  void window.kobrixa.plugins
                    .cancel(key)
                    .catch((reason: unknown) => setError(requestError(reason)))
                }
              >
                {t.cancel}
              </button>
            )}
          </div>
        )}
        {(plugin.canToggle || plugin.source === "development") && (
          <div className="plugins-actions">
            {plugin.canToggle && !plugin.required && plugin.status !== "invalid" && (
              <button
                disabled={
                  rowBusy ||
                  (enabling &&
                    (state.safeMode ||
                      (plugin.source === "development" && !state.developer.enabled)))
                }
                onClick={rowAction(() => window.kobrixa.plugins.setEnabled(key, enabling))}
              >
                {enabling
                  ? t.enable
                  : plugin.disabledBy === "safe-mode"
                    ? t.keepDisabled
                    : t.disable}
              </button>
            )}
            {plugin.canToggle && !plugin.required && (
              <button
                disabled={
                  rowBusy ||
                  state.safeMode ||
                  (plugin.source === "development" && !state.developer.enabled)
                }
                onClick={rowAction(() => window.kobrixa.plugins.reload(key))}
              >
                {t.reload}
              </button>
            )}
            {plugin.source === "development" &&
              origin === "linked" &&
              plugin.status === "invalid" && (
                <button
                  disabled={rowBusy || state.safeMode}
                  onClick={rowAction(() => window.kobrixa.plugins.relinkFolder(key))}
                >
                  {t.relink}
                </button>
              )}
            {plugin.source === "development" && origin === "linked" && (
              <button
                disabled={rowBusy}
                onClick={rowAction(() => window.kobrixa.plugins.unlink(key))}
              >
                {t.unlink}
              </button>
            )}
            <button
              aria-expanded={logFor === key}
              onClick={() => setLogFor((current) => (current === key ? undefined : key))}
            >
              {logFor === key ? t.hideLog : t.showLog}
            </button>
          </div>
        )}
        {logFor === key && (
          <PluginLog
            sourceKey={key}
            labels={{ title: t.logTitle, empty: t.logEmpty, truncated: t.logTruncated }}
          />
        )}
      </li>
    );
  };
  const selected = candidates?.find((choice) => choice.selected);
  const choosePython = (id: PythonChoiceId) =>
    void perform("python", () => window.kobrixa.plugins.setPython(id)).then(refreshPython);
  return (
    <div className="plugins-panel">
      <p className="settings-hint">{t.trust}</p>
      {state.safeMode && (
        <div role="status">
          <p className="settings-hint">
            {state.sessionRecovery
              ? t.sessionRecovery
              : state.safeModeLock
                ? t.safeModeLocked
                : t.safeMode}
          </p>
          {(state.safeModeLock || state.sessionRecovery) && (
            <button
              disabled={busy("lock")}
              onClick={() => void perform("lock", () => window.kobrixa.plugins.clearSafeModeLock())}
            >
              {t.restore}
            </button>
          )}
        </div>
      )}
      {state.stateProblem && (
        <p className="settings-hint" role="status">
          {problemText(state.stateProblem, locale)}
        </p>
      )}
      {errorAlert}
      <ul className="plugins-list">{state.plugins.map(row)}</ul>
      <h3 className="settings-subheading">{t.notices}</h3>
      <ul aria-live="polite">
        {notices.length === 0 && <li className="settings-hint">{t.noNotices}</li>}
        {notices.map((notice) => (
          <li key={notice.id} data-severity={notice.severity}>
            <span>{t.severity[notice.severity]}</span> <strong>{notice.pluginId}</strong>{" "}
            {notice.message}
          </li>
        ))}
      </ul>
      <section className="plugins-developer" aria-labelledby="plugins-developer-title">
        <h3 className="settings-subheading" id="plugins-developer-title">
          {t.developerMode}
        </h3>
        <label>
          <input
            type="checkbox"
            checked={state.developer.enabled}
            disabled={busy("developer")}
            onChange={() =>
              void perform("developer", () =>
                window.kobrixa.plugins.setDeveloperMode(!state.developer.enabled),
              )
            }
          />{" "}
          {t.developerToggle}
        </label>
        <p className="settings-hint">{state.developer.enabled ? t.developerHint : t.howTo}</p>
        {state.developer.commandLine && <p className="settings-hint">{t.developerCommandLine}</p>}
        {!state.developer.enabled && state.developer.linkedCount > 0 && (
          <p className="settings-hint">{t.keptLinks(state.developer.linkedCount)}</p>
        )}
        {state.developer.enabled && (
          <>
            <button
              disabled={busy("link") || state.safeMode}
              onClick={() => void perform("link", () => window.kobrixa.plugins.linkFolder())}
            >
              {t.linkFolder}
            </button>
            <label className="plugins-python">
              {t.python}{" "}
              <select
                value={selected?.id ?? ""}
                disabled={busy("python") || candidates === undefined}
                onChange={(event) => {
                  if (event.target.value) choosePython(event.target.value as PythonChoiceId);
                }}
              >
                {!selected && <option value="">{t.pythonNone}</option>}
                {candidates?.map((choice) => (
                  <option
                    key={choice.id}
                    value={choice.id}
                    disabled={choice.probe.status === "error"}
                  >
                    {pythonChoiceText(choice, locale)}
                  </option>
                ))}
                <option value="other">{t.pythonOther}</option>
              </select>
            </label>
            <button disabled={busy("python")} onClick={() => void refreshPython()}>
              {t.pythonRefresh}
            </button>
            {state.python.current?.origin === "command-line" && (
              <p className="settings-hint">{t.pythonCommandLine(state.python.current.label)}</p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
