import { useEffect, useState } from "react";
import type { Locale } from "../i18n/copy.js";
import type {
  LocalizedText,
  PluginNotice,
  PluginsSnapshot,
  PluginSummary,
} from "../../shared/plugins.js";
import { pluginCopy, problemText } from "./plugin-copy.js";

export const localizedText = (text: LocalizedText, locale: Locale): string =>
  typeof text === "string" ? text : locale === "zh-TW" ? (text["zh-TW"] ?? text.en) : text.en;

export function PluginsPanel({ locale }: { locale: Locale }): React.JSX.Element {
  const t = pluginCopy[locale];
  const [state, setState] = useState<PluginsSnapshot>();
  const [notices, setNotices] = useState<PluginNotice[]>([]);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    void window.kobrixa.plugins.state().then((value) => {
      if (live) setState(value);
    });
    const off = window.kobrixa.plugins.onEvent((event) => {
      if (event.type === "state") setState(event.state);
      else setNotices((list) => [event.notice, ...list].slice(0, 20));
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  const perform = async (
    key: string,
    work: () => Promise<
      { ok: true; state?: PluginsSnapshot } | { ok: false; code: string; message: string }
    >,
  ) => {
    setBusy(key);
    setError(undefined);
    try {
      const result = await work();
      if (!result.ok) setError(problemText(result, locale));
      else if (result.state) setState(result.state);
    } finally {
      setBusy(undefined);
    }
  };
  if (!state) return <p className="settings-hint">{t.loading}</p>;
  const toggle = (plugin: PluginSummary) => {
    if (plugin.source !== "development" || plugin.status === "invalid") return null;
    const enabling = plugin.status === "disabled" && plugin.disabledBy === "user";
    const label = enabling
      ? t.enable
      : plugin.disabledBy === "safe-mode"
        ? t.keepDisabled
        : t.disable;
    return (
      <button
        disabled={busy !== undefined || (enabling && state.safeMode)}
        onClick={() =>
          void perform(plugin.id, () => window.kobrixa.plugins.setEnabled(plugin.id, enabling))
        }
      >
        {label}
      </button>
    );
  };
  return (
    <div className="plugins-panel">
      <p className="settings-hint">{t.trust}</p>
      {!state.developmentMode && <p className="settings-hint">{t.howTo}</p>}
      {state.safeMode && (
        <p className="settings-hint" role="status">
          {t.safeMode}
        </p>
      )}
      {error && (
        <p className="settings-hint" role="alert">
          {error}
        </p>
      )}
      <ul className="plugins-list">
        {state.plugins.map((plugin) => (
          <li key={`${plugin.source}:${plugin.directory ?? plugin.id}`}>
            <h3 className="settings-subheading">
              {plugin.displayName ? localizedText(plugin.displayName, locale) : plugin.id}
            </h3>
            <p className="settings-hint">
              {[
                plugin.id,
                plugin.version,
                plugin.source === "builtin" ? t.builtin : t.development,
                plugin.runtime,
                t.status[plugin.status],
                plugin.running ? t.running : undefined,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            {plugin.directory && <p className="settings-hint">{plugin.directory}</p>}
            {plugin.problems.map((problem, index) => (
              <p className="settings-hint" key={index}>
                {problemText(problem, locale)}
              </p>
            ))}
            {plugin.commands.length > 0 && (
              <div role="group" aria-label={t.commands}>
                {plugin.commands.map((command) => (
                  <button
                    key={command.id}
                    disabled={busy !== undefined || plugin.status !== "enabled"}
                    onClick={() =>
                      void perform(command.id, () => window.kobrixa.plugins.execute(command.id))
                    }
                  >
                    {localizedText(command.title, locale)}
                  </button>
                ))}
              </div>
            )}
            {toggle(plugin)}
          </li>
        ))}
      </ul>
      <h3 className="settings-subheading">{t.notices}</h3>
      <ul aria-live="polite">
        {notices.length === 0 && <li className="settings-hint">{t.noNotices}</li>}
        {notices.map((notice, index) => (
          <li key={`${notice.at}-${index}`}>
            <strong>{notice.pluginId}</strong> {notice.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
