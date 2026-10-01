import { useEffect, useState } from "react";
import type { UpdateState } from "../../shared/updates.js";
import type { Locale } from "../i18n/copy.js";
import { SettingToggle } from "../settings/setting-field.js";

export function useUpdates(): UpdateState | undefined {
  const [state, setState] = useState<UpdateState>();
  useEffect(() => {
    let active = true;
    const accept = (next: UpdateState) => {
      if (active)
        setState((previous) => (!previous || next.revision >= previous.revision ? next : previous));
    };
    const unsubscribe = window.kobrixa.updates.onState(accept);
    void window.kobrixa.updates
      .getState()
      .then(accept)
      .catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return state;
}
export function updateMessage(state: UpdateState, locale: Locale): string {
  const t = (zh: string, en: string) => (locale === "zh-TW" ? zh : en);
  if (state.reason === "development")
    return t("開發模式不檢查更新。", "Updates are disabled in development mode.");
  const messages: Record<UpdateState["phase"], string> = {
    idle: t("尚未檢查更新。", "Updates have not been checked yet."),
    checking: t("正在檢查更新…", "Checking for updates…"),
    current: t("目前已是此通道的最新版本。", "You have the latest version in this channel."),
    "no-release": t(
      "目前尚無正式版，可開啟預覽版更新。",
      "No stable release is available yet. You can enable preview updates.",
    ),
    downloading: t(
      `正在下載 ${state.version}：${Math.floor(state.progress ?? 0)}%`,
      `Downloading ${state.version}: ${Math.floor(state.progress ?? 0)}%`,
    ),
    ready: t(
      `${state.version} 已下載，準備重新啟動並更新。`,
      `${state.version} is downloaded and ready to install.`,
    ),
    manual: t(
      `${state.version} 已推出，請開啟版本頁下載安裝。`,
      `${state.version} is available. Download and install it from the release page.`,
    ),
    preparing: t("正在儲存並準備更新…", "Saving and preparing to update…"),
    installing: t("正在重新啟動並更新…", "Restarting to install the update…"),
    error: t(
      "更新失敗，現有版本仍可使用，請稍後重試。",
      "The update failed. Your current version is unchanged; please retry later.",
    ),
  };
  if (state.phase === "error" && state.error === "source-unavailable")
    return t("更新來源尚未公開或目前無法存取。", "The update source is private or unavailable.");
  if (state.phase === "error" && state.error === "rate-limited")
    return t(
      "更新服務暫時限制請求，請稍後重試。",
      "The update service is rate limited. Please retry later.",
    );
  if (state.phase === "error") {
    const reasons: Record<string, string> = {
      network: t(
        "無法連線到更新服務，請檢查網路後重試。",
        "Cannot connect to the update service. Check your connection and retry.",
      ),
      "download-failed": t(
        "新版下載失敗，請稍後重試；目前版本仍可使用。",
        "The download failed. Please retry; your current version is unchanged.",
      ),
      "verification-failed": t(
        "新版校驗或簽章驗證失敗，已停止更新。",
        "Checksum or signature verification failed. The update was stopped.",
      ),
      "invalid-metadata": t(
        "版本更新資訊不完整或不符，已停止下載。",
        "Release metadata is invalid or does not match. The download was stopped.",
      ),
      "install-failed": t(
        "無法啟動更新安裝，請重試或從版本頁手動下載。",
        "Installation could not start. Retry or download the release manually.",
      ),
    };
    if (state.error && reasons[state.error]) return reasons[state.error]!;
  }
  return messages[state.phase];
}
export function UpdatesPanel({
  state,
  locale,
  busy,
  onInstall,
}: {
  state: UpdateState | undefined;
  locale: Locale;
  busy: boolean;
  onInstall(): void;
}): React.JSX.Element {
  const t = (zh: string, en: string) => (locale === "zh-TW" ? zh : en);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const action = async (run: () => Promise<unknown>) => {
    setError(false);
    try {
      await run();
    } catch {
      setError(true);
    }
  };
  if (!state) return <p role="status">{t("正在載入更新設定…", "Loading update settings…")}</p>;
  const locked = state.phase === "preparing" || state.phase === "installing";
  const preferences = async (patch: Partial<UpdateState["preferences"]>) => {
    setSaving(true);
    await action(() => window.kobrixa.updates.setPreferences({ ...state.preferences, ...patch }));
    setSaving(false);
  };
  return (
    <>
      <p>
        {t("目前版本", "Current version")}: <code>{state.currentVersion}</code>
      </p>
      <fieldset disabled={saving || locked} className="updates-preferences">
        <SettingToggle
          id="updates-enabled"
          label={t("自動檢查並下載", "Automatically check and download")}
          checked={state.preferences.enabled}
          onChange={(enabled) => void preferences({ enabled })}
          onLabel={t("開啟", "On")}
          offLabel={t("關閉", "Off")}
        />
        <SettingToggle
          id="updates-preview"
          label={t("接收預覽版更新", "Receive preview updates")}
          hint={t(
            "預覽版可能仍在測試中；切回正式版不會自動降版。",
            "Preview releases may still be in testing. Switching back to stable never downgrades your app.",
          )}
          hintId="updates-preview-hint"
          checked={state.preferences.channel === "preview"}
          onChange={(preview) => void preferences({ channel: preview ? "preview" : "stable" })}
          onLabel={t("開啟", "On")}
          offLabel={t("關閉", "Off")}
        />
      </fieldset>
      <p role="status" aria-live="polite">
        {updateMessage(state, locale)}
      </p>
      {state.phase === "downloading" && (
        <progress
          max={100}
          value={state.progress ?? 0}
          aria-label={t("下載進度", "Download progress")}
        />
      )}
      {!state.supported && state.reason !== "development" && (
        <p className="settings-hint">
          {state.reason === "unsigned-mac"
            ? t(
                "此 macOS 版本未簽章，請手動安裝新版。",
                "This macOS build is unsigned. Install new versions manually.",
              )
            : t(
                "此版本僅提供更新提示；請使用 Windows 安裝版或 Linux AppImage 以自動更新。",
                "This distribution offers update notifications. Use the Windows installer or Linux AppImage for automatic updates.",
              )}
        </p>
      )}
      <div className="update-actions">
        <button
          disabled={
            locked ||
            saving ||
            state.reason === "development" ||
            ["checking", "downloading", "ready"].includes(state.phase)
          }
          onClick={() => void action(() => window.kobrixa.updates.check())}
        >
          {t("檢查更新", "Check for updates")}
        </button>
        {state.phase === "ready" && (
          <button disabled={busy} onClick={onInstall}>
            {t("重新啟動並更新", "Restart and update")}
          </button>
        )}
        <button onClick={() => void action(() => window.kobrixa.updates.openRelease())}>
          {state.phase === "manual"
            ? t("下載新版", "Download update")
            : t("查看版本說明", "View release notes")}
        </button>
      </div>
      {busy && state.phase === "ready" && (
        <p>
          {t(
            "請先完成目前的編譯、傳輸或檔案操作。",
            "Finish the current build, transfer or file operation before updating.",
          )}
        </p>
      )}
      {error && (
        <p role="alert">
          {t(
            "操作失敗，請重試。設定僅在成功儲存後生效。",
            "The action failed. Please retry. Preferences apply only after they are saved.",
          )}
        </p>
      )}
    </>
  );
}
