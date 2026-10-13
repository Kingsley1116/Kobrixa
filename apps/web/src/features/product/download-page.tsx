import { useEffect, useState } from "react";
import { AppLink } from "../../components/app-link.js";
import { SiteHeader } from "../../components/site-header.js";
import { Icon } from "../../components/ui/icon.js";
import { PLATFORMS, RELEASES_URL, formatSize, type Platform } from "../../shared/releases.js";
import { platformInfo, useLatestRelease, visitorPlatform } from "../../shared/latest-release.js";
import "./download-page.css";

type Locale = "zh-TW" | "en";
type Props = { locale: Locale; onLocaleChange: (locale: Locale) => void };
const github = "https://github.com/Kingsley1116/Kobrixa";
const buildCommands = `git clone ${github}.git\ncd Kobrixa\npnpm install\npnpm dev`;

export function DownloadPage({ locale, onLocaleChange }: Props) {
  const t = (zh: string, en: string) => (locale === "zh-TW" ? zh : en);
  const [platform] = useState(visitorPlatform);
  const release = useLatestRelease();
  const [copied, setCopied] = useState(false),
    [copyError, setCopyError] = useState(false);
  useEffect(() => {
    document.title = locale === "zh-TW" ? "下載 — Kobrixa" : "Download — Kobrixa";
  }, [locale]);

  const loaded = typeof release === "object" ? release : null;
  const latestPage = loaded?.url ?? `${RELEASES_URL}/latest`;
  const fileFor = (p: Platform) => loaded?.platforms[p].installer ?? null;
  const date = loaded?.publishedAt
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(loaded.publishedAt))
    : null;
  const primary = platform ? fileFor(platform) : null;
  const ordered = platform ? [platform, ...PLATFORMS.filter((p) => p !== platform)] : PLATFORMS;

  return (
    <>
      <AppLink className="skip-link" href="#content">
        {t("跳到主要內容", "Skip to content")}
      </AppLink>
      <SiteHeader locale={locale} page="download" onLocaleChange={onLocaleChange} />
      <main id="content" className="download-page">
        <section className="dl-hero" aria-labelledby="dl-title">
          <div className="dl-hero-copy">
            <p className="dl-eyebrow">
              <i aria-hidden="true" />
              {t("下載", "DOWNLOAD")}
            </p>
            <h1 id="dl-title">{t("下一個想法，\n從這裡開始。", "Your next idea\nstarts here.")}</h1>
            <p className="dl-lead">
              {t(
                "免費、開源的 EV3 桌面開發環境。編輯、編譯與下載到機器人，全部在你的電腦上完成。",
                "A free, open-source desktop environment for EV3. Edit, compile and send programs to your robot, all on your own computer.",
              )}
            </p>
            {platform ? (
              <div className="dl-cta">
                <AppLink
                  className="dl-primary"
                  href={primary?.url ?? latestPage}
                  {...(primary ? {} : { target: "_blank", rel: "noreferrer" })}
                >
                  <span className="dl-primary-glyph" aria-hidden="true">
                    <Icon name={platformInfo[platform].icon} />
                  </span>
                  <span className="dl-primary-text">
                    <strong>
                      {t(
                        `下載 ${platformInfo[platform].name} 版`,
                        `Download for ${platformInfo[platform].name}`,
                      )}
                    </strong>
                    <small>
                      {primary && loaded
                        ? `v${loaded.version} · ${platformInfo[platform].arch} · ${platformInfo[platform].installer} · ${formatSize(primary.size)}`
                        : release === "loading"
                          ? t("正在取得最新版本…", "Checking the latest version…")
                          : t("前往 GitHub Releases 下載", "Get it from GitHub Releases")}
                    </small>
                  </span>
                  <Icon name="download" />
                </AppLink>
                {platform === "macos" && (
                  <p className="dl-cta-note">
                    {t(
                      "需要搭載 Apple Silicon（M 系列晶片）的 Mac。",
                      "Requires a Mac with Apple Silicon (M-series chip).",
                    )}
                  </p>
                )}
              </div>
            ) : (
              <div className="dl-cta">
                <AppLink className="dl-primary" href="#platforms">
                  <span className="dl-primary-text">
                    <strong>{t("選擇你的平台", "Choose your platform")}</strong>
                    <small>Windows · macOS · Linux</small>
                  </span>
                  <Icon name="arrow" />
                </AppLink>
                <p className="dl-cta-note">
                  {t(
                    "Kobrixa 是桌面應用程式，請在 Windows、macOS 或 Linux 電腦上下載安裝。",
                    "Kobrixa is a desktop app. Download it on a Windows, macOS or Linux computer.",
                  )}
                </p>
              </div>
            )}
            <p className="dl-hero-links">
              {platform && (
                <a href="#platforms">
                  {t("其他平台", "Other platforms")} <Icon name="arrow" />
                </a>
              )}
              <a href={latestPage} target="_blank" rel="noreferrer">
                {t("版本說明", "Release notes")} <Icon name="external" />
              </a>
            </p>
          </div>
          <aside className="dl-release" aria-label={t("最新版本", "Latest release")}>
            <div className="dl-release-bar" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <img src="/icons/kobrixa-mark.svg" alt="" />
            <p className="dl-release-name">Kobrixa</p>
            <p className="dl-release-version">
              {loaded ? `v${loaded.version}` : release === "loading" ? "…" : "—"}
              <span>{t("穩定版", "Stable")}</span>
            </p>
            <dl>
              <div>
                <dt>{t("發布日期", "Released")}</dt>
                <dd>{date ?? "—"}</dd>
              </div>
              <div>
                <dt>{t("平台", "Platforms")}</dt>
                <dd>Windows · macOS · Linux</dd>
              </div>
              <div>
                <dt>{t("授權", "License")}</dt>
                <dd>Apache-2.0</dd>
              </div>
            </dl>
          </aside>
        </section>

        <section id="platforms" className="dl-section" aria-labelledby="dl-platforms-title">
          <div className="dl-section-head">
            <h2 id="dl-platforms-title">{t("所有平台", "All platforms")}</h2>
            <p>
              {loaded?.checksums && (
                <a href={loaded.checksums.url}>
                  SHA256SUMS <Icon name="download" />
                </a>
              )}
              <a href={RELEASES_URL} target="_blank" rel="noreferrer">
                {t("所有版本（含預覽版）", "All releases, including previews")}{" "}
                <Icon name="external" />
              </a>
            </p>
          </div>
          {release === "error" && (
            <p className="dl-notice" role="status">
              <Icon name="info" />
              {t(
                "暫時無法取得最新版本資訊，下方按鈕會帶你前往 GitHub Releases。",
                "Release details are unavailable right now. The buttons below open GitHub Releases instead.",
              )}
            </p>
          )}
          <ul className="dl-platforms">
            {ordered.map((p) => {
              const info = platformInfo[p];
              const installer = fileFor(p);
              const archive = loaded?.platforms[p].archive ?? null;
              return (
                <li key={p} className={p === platform ? "is-current" : undefined}>
                  <span className="dl-platform-glyph" aria-hidden="true">
                    <Icon name={info.icon} />
                  </span>
                  <div className="dl-platform-name">
                    <h3>
                      {info.name}
                      {p === platform && <span>{t("你的系統", "Your system")}</span>}
                    </h3>
                    <p>
                      {info.arch} · {info.installer}
                      {p === "linux" &&
                        t("・USB 連線可能需要 udev 規則", " · USB may need a udev rule")}
                    </p>
                  </div>
                  <div className="dl-platform-actions">
                    {archive && info.archive && (
                      <a className="dl-alt" href={archive.url}>
                        {info.archive}
                        <small>{formatSize(archive.size)}</small>
                      </a>
                    )}
                    <a
                      className="dl-get"
                      href={installer?.url ?? latestPage}
                      {...(installer ? {} : { target: "_blank", rel: "noreferrer" })}
                      aria-label={t(`下載 ${info.name} 版`, `Download for ${info.name}`)}
                    >
                      {installer ? (
                        <>
                          {info.installer}
                          <small>{formatSize(installer.size)}</small>
                          <Icon name="download" />
                        </>
                      ) : (
                        <>
                          GitHub <Icon name="external" />
                        </>
                      )}
                    </a>
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="dl-fineprint">
            {t(
              "未簽署的安裝檔在第一次開啟時，系統可能顯示警告；各版本的簽署狀態列在版本說明中。",
              "Your system may warn you the first time you open an unsigned build. Each release lists its signing status in the release notes.",
            )}{" "}
            <AppLink href="/docs/reference/code-signing">
              {t("了解簽署政策", "Code signing policy")}
            </AppLink>
          </p>
        </section>

        <section className="dl-section" aria-labelledby="dl-next-title">
          <div className="dl-section-head">
            <h2 id="dl-next-title">{t("接下來", "What's next")}</h2>
          </div>
          <ol className="dl-steps">
            {[
              {
                icon: "build" as const,
                title: t("安裝", "Install"),
                body: t(
                  "Windows 執行安裝程式；macOS 將 Kobrixa 拖進「應用程式」；Linux 讓 AppImage 可執行後開啟。",
                  "Run the installer on Windows, drag Kobrixa into Applications on macOS, or make the AppImage executable on Linux.",
                ),
                href: "/docs/reference/installation",
                label: t("安裝與復原說明", "Installation guide"),
              },
              {
                icon: "device" as const,
                title: t("連接 EV3", "Connect your EV3"),
                body: t(
                  "使用 USB 線，或讓電腦與 EV3 連上同一個可信任的 Wi-Fi。",
                  "Use a USB cable, or put the computer and EV3 on the same trusted Wi-Fi network.",
                ),
                href: "/docs/tutorial/getting-ready",
                label: t("準備工作", "Getting ready"),
              },
              {
                icon: "code" as const,
                title: t("寫第一個程式", "Write your first program"),
                body: t(
                  "跟著教學，幾分鐘內讓機器人動起來。",
                  "Follow the tutorial and get your robot moving in minutes.",
                ),
                href: "/docs/tutorial/first-program",
                label: t("開始教學", "Start the tutorial"),
              },
            ].map((step, index) => (
              <li key={step.href}>
                <span className="dl-step-index">0{index + 1}</span>
                <span className="dl-step-icon" aria-hidden="true">
                  <Icon name={step.icon} />
                </span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
                <AppLink href={step.href}>
                  {step.label} <Icon name="arrow" />
                </AppLink>
              </li>
            ))}
          </ol>
        </section>

        <section className="dl-section dl-more" aria-label={t("其他選項", "More options")}>
          <details id="source-build" className="dl-source">
            <summary>
              <span>
                <strong>{t("從原始碼建置", "Build from source")}</strong>
                <small>
                  {t(
                    "給開發者：需要 Git、Node.js 24 與 pnpm 10.15。",
                    "For developers: requires Git, Node.js 24 and pnpm 10.15.",
                  )}
                </small>
              </span>
              <Icon name="chevron-right" />
            </summary>
            <div className="dl-source-body">
              <div className="dl-terminal">
                <div className="dl-terminal-head">
                  <span>TERMINAL</span>
                  <button
                    type="button"
                    onClick={() => {
                      void Promise.resolve()
                        .then(() => navigator.clipboard.writeText(buildCommands))
                        .then(() => {
                          setCopied(true);
                          setCopyError(false);
                        })
                        .catch(() => {
                          setCopied(false);
                          setCopyError(true);
                        });
                    }}
                  >
                    <Icon name={copied ? "check" : "copy"} />
                    {copied ? t("已複製", "Copied") : t("複製", "Copy")}
                  </button>
                </div>
                <pre>
                  <code>{buildCommands}</code>
                </pre>
                <p role="status">
                  {copyError
                    ? t(
                        "請選取上方指令手動複製。",
                        "Select the commands above to copy them manually.",
                      )
                    : copied
                      ? t("建置指令已複製。", "Build commands copied.")
                      : ""}
                </p>
              </div>
              <p>
                {t(
                  "首次安裝需要網路下載相依套件；之後編輯與編譯都在本機執行。想產生本機應用程式，請在專案根目錄執行 ",
                  "Initial setup downloads dependencies; after that, editing and compiling run locally. To create a local app, run ",
                )}
                <code>pnpm package</code>
                {t("。", " from the repository root.")}{" "}
                <a href={`${github}/archive/refs/heads/main.zip`}>
                  {t("下載原始碼 ZIP", "Download source ZIP")}
                </a>
              </p>
            </div>
          </details>
          <div className="dl-tools">
            <span className="dl-step-icon" aria-hidden="true">
              <Icon name="image" />
            </span>
            <div>
              <h2>{t("還不想安裝？", "Not ready to install?")}</h2>
              <p>
                {t(
                  "先在瀏覽器裡準備 EV3 圖片與音頻。",
                  "Prepare EV3 images and audio in your browser first.",
                )}
              </p>
            </div>
            <AppLink href="/tools">
              {t("開啟媒體工具", "Open media tools")} <Icon name="arrow" />
            </AppLink>
          </div>
        </section>
      </main>
    </>
  );
}
