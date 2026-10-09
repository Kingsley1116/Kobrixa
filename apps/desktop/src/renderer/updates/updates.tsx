import { useEffect, useState } from "react";
import type { UpdateState } from "../../shared/updates.js";
import type { Locale } from "../i18n/copy.js";

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
type Tone = "ok" | "info" | "progress" | "warning" | "error";
function statusTone(state: UpdateState): Tone {
  if (state.reason === "development") return "info";
  switch (state.phase) {
    case "current":
      return "ok";
    case "checking":
    case "downloading":
    case "preparing":
    case "installing":
      return "progress";
    case "ready":
    case "manual":
      return "warning";
    case "error":
      return "error";
    default:
      return "info";
  }
}
function statusTitle(state: UpdateState, locale: Locale): string {
  const t = (zh: string, en: string) => (locale === "zh-TW" ? zh : en);
  if (state.reason === "development") return t("開發模式", "Development build");
  const titles: Record<UpdateState["phase"], string> = {
    idle: t("尚未檢查", "Not checked yet"),
    checking: t("正在檢查…", "Checking…"),
    current: t("已是最新版本", "Kobrixa is up to date"),
    "no-release": t("尚無正式版", "No stable release yet"),
    downloading: t("正在下載更新", "Downloading update"),
    ready: t("更新已就緒", "Update ready"),
    manual: t("有可用的新版本", "Update available"),
    preparing: t("正在準備更新", "Preparing update"),
    installing: t("正在安裝更新", "Installing update"),
    error: t("無法完成更新", "Update could not finish"),
  };
  return titles[state.phase];
}
const STATUS_GLYPHS: Record<Tone, string> = {
  ok: "M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-11.5 0 2.5 2.5 4.5-5",
  info: "M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-8-1v5m0-8.5v.5",
  progress: "M20 12a8 8 0 1 1-8-8",
  warning: "M12 4v11m-4-4 4 4 4-4M5 20h14",
  error: "M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-8-4.5v5m0 3v.5",
};
function KobrixaMark(): React.JSX.Element {
  return (
    <svg className="about-mark" viewBox="0 0 512 512" aria-hidden="true">
      <rect x="20" y="20" width="472" height="472" rx="104" fill="#2457D6" />
      <rect x="116" y="108" width="78" height="296" rx="20" fill="#F5F0E7" />
      <path d="M210 242 312 108h86L278 256l120 148h-86L210 270Z" fill="#F5F0E7" />
      <rect x="183" y="221" width="56" height="70" rx="16" fill="#E86F3D" />
    </svg>
  );
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
  const action = async (run: () => Promise<unknown>) => {
    setError(false);
    try {
      await run();
    } catch {
      setError(true);
    }
  };
  if (!state)
    return (
      <p className="settings-hint" role="status">
        {t("正在載入版本資訊…", "Loading version information…")}
      </p>
    );
  const locked = state.phase === "preparing" || state.phase === "installing";
  const development = state.reason === "development";
  const tone = statusTone(state);
  const channel = development
    ? t("開發版", "Development")
    : state.preferences.channel === "preview"
      ? t("預覽版通道", "Preview channel")
      : t("正式版通道", "Stable channel");
  const openRelease = () => void action(() => window.kobrixa.updates.openRelease());
  const check = () => void action(() => window.kobrixa.updates.check());
  const checking = state.phase === "checking";
  const primary =
    state.phase === "ready" ? (
      <button className="primary" disabled={busy} onClick={onInstall}>
        {t("重新啟動並更新", "Restart and update")}
      </button>
    ) : state.phase === "manual" ? (
      <button className="primary" onClick={openRelease}>
        {t("下載新版", "Download update")}
      </button>
    ) : (
      <button
        className="primary"
        aria-busy={checking || undefined}
        disabled={locked || development || checking || state.phase === "downloading"}
        onClick={check}
      >
        {checking ? t("檢查中…", "Checking…") : t("檢查更新", "Check for updates")}
      </button>
    );
  const notes = [
    busy &&
      state.phase === "ready" &&
      t(
        "請先完成目前的編譯、傳輸或檔案操作，再重新啟動更新。",
        "Finish the current build, transfer or file operation before restarting to update.",
      ),
    !state.supported &&
      !development &&
      (state.reason === "unsigned-mac"
        ? t(
            "此 macOS 版本未簽章，請從版本頁手動安裝新版。",
            "This macOS build is unsigned. Install new versions manually from the release page.",
          )
        : t(
            "此版本僅提供更新提示；請使用 Windows 安裝版或 Linux AppImage 以自動更新。",
            "This distribution offers update notifications. Use the Windows installer or Linux AppImage for automatic updates.",
          )),
  ].filter((note): note is string => Boolean(note));
  return (
    <div className="about-updates">
      <div className="about-card">
        <KobrixaMark />
        <div className="about-text">
          <h3>Kobrixa</h3>
          <p>
            {t(
              "以 BASIC+ 為 LEGO® MINDSTORMS® EV3 編寫、模擬與部署程式的桌面工作室。",
              "A desktop studio for writing, simulating and deploying BASIC+ programs to LEGO® MINDSTORMS® EV3.",
            )}
          </p>
          <dl className="about-meta">
            <div>
              <dt>{t("版本", "Version")}</dt>
              <dd>
                <code>{state.currentVersion}</code>
                <span
                  className="about-badge"
                  data-channel={development ? "development" : state.preferences.channel}
                >
                  {channel}
                </span>
              </dd>
            </div>
            <div>
              <dt>{t("授權", "License")}</dt>
              <dd>Apache-2.0</dd>
            </div>
          </dl>
        </div>
        <button className="about-link" onClick={openRelease}>
          {t("版本說明", "Release notes")}
        </button>
      </div>
      <div className="update-status" data-tone={tone} aria-busy={tone === "progress" || undefined}>
        <svg className="update-status-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d={STATUS_GLYPHS[tone]} />
        </svg>
        <div className="update-status-text" role="status" aria-live="polite">
          <strong>{statusTitle(state, locale)}</strong>
          <p>{updateMessage(state, locale)}</p>
        </div>
        <div className="update-status-action">{primary}</div>
        {state.phase === "downloading" && (
          <div className="update-progress">
            <progress
              max={100}
              value={state.progress ?? 0}
              aria-label={t("下載進度", "Download progress")}
            />
            <span>{Math.floor(state.progress ?? 0)}%</span>
          </div>
        )}
        {notes.map((note) => (
          <p className="update-note" key={note}>
            {note}
          </p>
        ))}
        {error && (
          <p className="update-note" data-tone="error" role="alert">
            {t("操作失敗，請稍後重試。", "The action failed. Please try again.")}
          </p>
        )}
      </div>
    </div>
  );
}
