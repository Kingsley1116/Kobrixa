import { useEffect, useState } from "react";
import type { Locale } from "../i18n/copy.js";
import type { PluginsView } from "../../shared/plugins.js";
import { pluginCopy, problemText, readableError } from "./plugin-copy.js";

/** Offers recovery after an unclean exit or a session-source startup failure. */
export function PluginRecoveryNotice({
  locale,
  onOpenSettings,
}: {
  locale: Locale;
  onOpenSettings(): void;
}): React.JSX.Element | null {
  const t = pluginCopy[locale];
  const [state, setState] = useState<PluginsView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const accept = (next: PluginsView) =>
    setState((current) => (current && current.revision > next.revision ? current : next));
  useEffect(() => {
    let live = true;
    void window.kobrixa.plugins.state().then(
      (value) => {
        if (live) accept(value);
      },
      () => {},
    );
    const off = window.kobrixa.plugins.onEvent((event) => {
      if (event.type === "state") accept(event.state);
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  if (!state?.safeModeLock && !state?.sessionRecovery) return null;
  const restore = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await window.kobrixa.plugins.clearSafeModeLock();
      if (result.ok) accept(result.state);
      else setError(problemText(result, locale));
    } catch (reason) {
      setError(
        `${t.requestFailed}${locale === "zh-TW" ? "：" : ": "}${readableError(reason) ?? t.unknownError}`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside className="update-notice plugin-recovery" role="status">
      <span>{state.sessionRecovery ? t.sessionRecovery : t.safeModeLocked}</span>
      {error && <span role="alert">{error}</span>}
      <button disabled={busy} onClick={() => void restore()}>
        {t.restore}
      </button>
      <button onClick={onOpenSettings}>{t.openSettings}</button>
    </aside>
  );
}
