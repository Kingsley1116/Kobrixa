import { AppLink } from "../../components/app-link.js";
import { useEffect, useState } from "react";
import { SiteHeader } from "../../components/site-header.js";
import { DiagnosticShowcase } from "./diagnostic-showcase.js";
import metadata from "../../../../../package.json" with { type: "json" };
import "./product-pages.css";

type Locale = "zh-TW" | "en";
type Props = { locale: Locale; onLocaleChange: (locale: Locale) => void };
const github = "https://github.com/Kingsley1116/Kobrixa";
const buildCommands = `git clone ${github}.git\ncd Kobrixa\npnpm install\npnpm dev`;
const mediaCode =
  'LCD.Clear()\nLCD.BmpFile(1, 0, 0, "assets/deploy/kobrixa-mascot")\nLCD.Update()\nSpeaker.Play(35, "assets/deploy/kobrixa-chime")\nSpeaker.Wait()';
export function FeaturesPage({ locale, onLocaleChange }: Props) {
  const t = (zh: string, en: string) => (locale === "zh-TW" ? zh : en);
  useEffect(() => {
    document.title = locale === "zh-TW" ? "功能 — Kobrixa" : "Features — Kobrixa";
  }, [locale]);
  const features = [
    {
      number: "01",
      tag: "EDITOR",
      title: t("在本機，專心寫程式。", "A focused place to write."),
      body: t(
        "編輯 Basic Plus 原始碼，查看程式診斷；編輯器與編譯器不需要雲端帳號。",
        "Edit Basic Plus source and inspect diagnostics. The editor and compiler work without a cloud account.",
      ),
      link: "/docs/tutorial/first-program",
      label: t("寫第一個程式", "Write your first program"),
    },
    {
      number: "02",
      tag: "COMPILER",
      title: t("從 .bp 到原生 .rbf。", "From .bp to native .rbf."),
      body: t(
        "將支援的 Basic Plus 程式在本機編譯成 EV3 執行檔。不支援的語法會提供明確診斷，方便回到原始碼修正。",
        "Compile supported Basic Plus programs locally into native EV3 executables. Unsupported syntax produces diagnostics you can act on.",
      ),
      link: "/docs/reference/language-support",
      label: t("了解語言支援", "Explore language support"),
    },
    {
      number: "03",
      tag: "CONNECTION",
      title: t("把程式帶到機器人上。", "Put your code on the brick."),
      body: t(
        "透過 USB 或 Wi-Fi 連接 EV3，執行上傳、啟動與停止流程。三平台實機相容性仍在候選版驗證中。",
        "Connect to EV3 over USB or Wi-Fi to upload, run and stop programs. Physical compatibility across all three platforms remains under candidate validation.",
      ),
      link: "/docs/reference/device-support",
      label: t("查看裝置支援", "Check device support"),
    },
    {
      number: "04",
      tag: "MEDIA STUDIO",
      title: t("讓 EV3 有畫面，也有聲音。", "Give your EV3 a face and a voice."),
      body: t(
        "在瀏覽器將圖片轉為 RGF、音頻轉為 RSF。使用黑白預覽、抖色與波形裁切，檔案全程留在本機。",
        "Convert images to RGF and audio to RSF in your browser. Use monochrome previews, dithering and waveform trimming while your files stay local.",
      ),
      link: "/tools",
      label: t("開啟媒體工作室", "Open the media studio"),
    },
    {
      number: "05",
      tag: "LEARNING",
      title: t("從小練習，走到完整專案。", "Start small. Build something real."),
      body: t(
        "透過教學、API 參考和可閱讀的範例，逐步練習顯示、聲音、馬達與感測器，再組合成自己的機器人專案。",
        "Learn displays, sound, motors and sensors through tutorials, API references and readable examples, then bring them together in a robot project.",
      ),
      link: "/docs/tutorial",
      label: t("瀏覽學習路徑", "Explore the learning path"),
    },
    {
      number: "06",
      tag: "OPEN SOURCE",
      title: t("看得見，也改得動。", "Open to explore and improve."),
      body: t(
        "Kobrixa 的原創程式碼採 Apache-2.0 授權。你可以閱讀原始碼、從本機建置，並參與測試與開發。",
        "Original Kobrixa code is licensed under Apache-2.0. Read the source, build locally and contribute to testing and development.",
      ),
      link: github,
      label: t("查看原始碼", "View the source"),
    },
  ];
  return (
    <>
      <AppLink className="skip-link" href="#content">
        {t("跳到主要內容", "Skip to content")}
      </AppLink>
      <SiteHeader locale={locale} page="features" onLocaleChange={onLocaleChange} />
      <main id="content" className="product-page">
        <section className="product-hero feature-hero">
          <div>
            <p className="product-eyebrow">KOBRIXA / FEATURES</p>
            <h1>{t("從一行程式，\n到真正的動作。", "From a line of code\nto real movement.")}</h1>
            <p className="product-lead">
              {t(
                "為學生、創客與教學者，把編寫、建置和 EV3 實作串在一起。每個小想法，都有下一步。",
                "A connected workflow for students, makers and educators: write, build and bring your EV3 to life. Give every small idea a next step.",
              )}
            </p>
            <div className="product-actions">
              <AppLink className="product-button primary" href="/download">
                {t("取得 Kobrixa", "Get Kobrixa")} <span>↗</span>
              </AppLink>
              <AppLink className="product-button secondary" href="/docs">
                {t("開始學習", "Start learning")} <span>→</span>
              </AppLink>
            </div>
            <p className="product-note">
              {t("v1 候選版 · 本機優先 · Apache-2.0", "v1 candidate · Local-first · Apache-2.0")}
            </p>
          </div>
          <div className="feature-visual">
            <div className="visual-caption">
              <span className="visual-dot" /> BASIC PLUS → EV3
            </div>
            <div className="product-code">
              <div>
                <span className="code-dots">● ● ●</span> original-media.bp
              </div>
              <pre>
                <code>{mediaCode}</code>
              </pre>
              <p>
                {t(
                  "取自原創媒體範例；需一併部署圖片與音頻素材。",
                  "From the original-media example; deploy its image and audio assets too.",
                )}
              </p>
            </div>
            <div className="build-path" aria-label={t("程式建置流程", "Build workflow")}>
              <span>
                .bp <small>{t("原始碼", "Source")}</small>
              </span>
              <i aria-hidden="true">→</i>
              <span>
                .rbf <small>{t("建置成品", "Build")}</small>
              </span>
              <i aria-hidden="true">→</i>
              <span>
                EV3 <small>{t("實際動作", "Motion")}</small>
              </span>
            </div>
          </div>
        </section>
        <section className="product-section">
          <div className="product-section-heading">
            <div>
              <p className="product-eyebrow">THE TOOLKIT</p>
              <h2>{t("需要的工具，都在同一條路上。", "Everything along the way.")}</h2>
            </div>
            <p>
              {t(
                "從程式碼到實體機器人，逐步完成。",
                "One step at a time, from source code to a physical robot.",
              )}
            </p>
          </div>
          <div className="capability-grid">
            {features.map((feature) => (
              <article className="capability-card" key={feature.tag}>
                <div className="capability-meta">
                  <span>{feature.number}</span>
                  <span>{feature.tag}</span>
                </div>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
                <AppLink
                  href={feature.link}
                  {...(feature.link.startsWith("https:")
                    ? { target: "_blank", rel: "noreferrer" }
                    : {})}
                >
                  {feature.label} <span aria-hidden="true">↗</span>
                </AppLink>
              </article>
            ))}
          </div>
        </section>
        <DiagnosticShowcase locale={locale} />
        <section className="product-roadmap">
          <div>
            <p className="product-eyebrow">WHAT’S NEXT</p>
            <h2>{t("把現在做好，再走向下一步。", "Build the foundation. Then go further.")}</h2>
            <p>
              {t(
                "v1 聚焦 Basic Plus 與 EV3 原生執行流程。Python、TypeScript 和 C++ 前端，以及藍牙、模擬器與積木編輯器屬於後續規劃，目前尚未提供。",
                "v1 focuses on Basic Plus and native EV3 execution. Python, TypeScript and C++ frontends, along with Bluetooth, a simulator and a block editor, are future plans and are not available yet.",
              )}
            </p>
          </div>
          <AppLink className="product-button secondary" href="/docs/reference/roadmap">
            {t("查看開發路線圖", "View the roadmap")} →
          </AppLink>
        </section>
      </main>
    </>
  );
}
export function DownloadPage({ locale, onLocaleChange }: Props) {
  const t = (zh: string, en: string) => (locale === "zh-TW" ? zh : en);
  const [copied, setCopied] = useState(false),
    [copyError, setCopyError] = useState(false);
  useEffect(() => {
    document.title = locale === "zh-TW" ? "下載 — Kobrixa" : "Download — Kobrixa";
  }, [locale]);
  return (
    <>
      <AppLink className="skip-link" href="#content">
        {t("跳到主要內容", "Skip to content")}
      </AppLink>
      <SiteHeader locale={locale} page="download" onLocaleChange={onLocaleChange} />
      <main id="content" className="product-page">
        <section className="product-hero download-hero">
          <div>
            <p className="product-eyebrow">KOBRIXA / DOWNLOAD</p>
            <h1>{t("下一個想法，\n從這裡開始。", "Your next idea\nstarts here.")}</h1>
            <p className="product-lead">
              {t(
                "Kobrixa 桌面版目前為 v1 候選版。正式安裝檔仍在準備中，你可以先取得原始碼，在自己的電腦上建置。",
                "The Kobrixa desktop app is a v1 candidate. Installers are still in preparation; get the source and build it on your own computer today.",
              )}
            </p>
            <div className="product-actions">
              <AppLink
                className="product-button primary"
                href={`${github}/archive/refs/heads/main.zip`}
              >
                {t("下載原始碼 ZIP", "Download source ZIP")} <span>↓</span>
              </AppLink>
              <AppLink
                className="product-button secondary"
                href={`${github}/releases`}
                target="_blank"
                rel="noreferrer"
              >
                GitHub Releases ↗
              </AppLink>
              <AppLink className="product-inline-link" href="/docs/reference/code-signing">
                Code signing policy ↗
              </AppLink>
            </div>
          </div>
          <aside className="release-card">
            <span className="release-label">
              <i />
              {t("開發候選版", "Development candidate")}
            </span>
            <img src="/icons/kobrixa-mark.svg" alt="" />
            <h2>Kobrixa</h2>
            <code>{metadata.version}</code>
            <p>
              {t(
                "三平台 USB／Wi-Fi 實機矩陣尚待完成。此處提供原始碼，不是已簽署的正式安裝程式。",
                "The three-platform USB / Wi-Fi hardware matrix is still pending. The download here is source code, not a signed production installer.",
              )}
            </p>
          </aside>
        </section>
        <section className="product-section" aria-labelledby="platform-heading">
          <div className="product-section-heading">
            <div>
              <p className="product-eyebrow">ON YOUR COMPUTER</p>
              <h2 id="platform-heading">
                {t("熟悉的平台，同一個起點。", "Your platform. The same starting point.")}
              </h2>
            </div>
            <AppLink className="product-inline-link" href="/docs/reference/installation">
              {t("安裝與復原說明", "Installation & recovery")} ↗
            </AppLink>
          </div>
          <div className="download-platforms">
            {["Windows", "macOS", "Linux"].map((platform, index) => (
              <article key={platform} className="download-platform">
                <span className="platform-glyph" aria-hidden="true">
                  {["⊞", "⌘", ">_"][index]}
                </span>
                <h3>{platform}</h3>
                <span className="platform-state">
                  {t("正式安裝檔準備中", "Installer in preparation")}
                </span>
                <p>
                  {platform === "Linux"
                    ? t(
                        "USB 存取可能需要 EV3 專用的 udev 規則，詳見安裝文件。",
                        "USB access may require an EV3-specific udev rule. See the installation guide.",
                      )
                    : t(
                        "目前可在這個平台上從原始碼建置開發版。",
                        "Build a development version from source on this platform.",
                      )}
                </p>
                <AppLink href="#source-build">{t("從原始碼建置", "Build from source")} →</AppLink>
              </article>
            ))}
          </div>
        </section>
        <section id="source-build" className="source-build">
          <div className="source-build-copy">
            <p className="product-eyebrow">BUILD IT YOURSELF</p>
            <h2>{t("四行指令，\n開始開發版。", "Four commands.\nA development build.")}</h2>
            <p>
              {t(
                "先安裝 Git、Node.js 24 和 pnpm 10.15。首次安裝需要網路下載相依套件；安裝完成後，編輯與編譯在本機執行。",
                "Install Git, Node.js 24 and pnpm 10.15 first. Initial setup downloads dependencies; after setup, editing and compilation run locally.",
              )}
            </p>
            <p>
              {t(
                "若使用上方 ZIP，解壓縮後在專案資料夾執行最後兩行即可。",
                "If you downloaded the ZIP above, extract it and run the last two commands from the project folder.",
              )}
            </p>
            <AppLink className="product-inline-link" href="/docs/reference/installation">
              {t("閱讀完整安裝說明", "Read the installation guide")} ↗
            </AppLink>
          </div>
          <div className="source-terminal">
            <div className="terminal-heading">
              <span>TERMINAL</span>
              <button
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
                {copied ? t("已複製", "Copied") : t("複製指令", "Copy commands")}
              </button>
            </div>
            <pre>
              <code>{buildCommands}</code>
            </pre>
            <div className="terminal-foot">
              <span>Node.js 24</span>
              <span>pnpm 10.15</span>
            </div>
            <p role="status">
              {copyError
                ? t("請選取上方指令手動複製。", "Select the commands above to copy them manually.")
                : copied
                  ? t("建置指令已複製。", "Build commands copied.")
                  : ""}
            </p>
          </div>
        </section>
        <section className="download-help">
          <article>
            <span>01 / {t("打包", "PACKAGE")}</span>
            <h3>{t("建立本機應用程式", "Create a local application")}</h3>
            <p>
              {t(
                "在專案根目錄執行 pnpm package，為目前作業系統產生未簽署的開發版應用程式。",
                "Run pnpm package from the repository root to create an unsigned development application for your current operating system.",
              )}
            </p>
            <code>pnpm package</code>
          </article>
          <article>
            <span>02 / {t("開始", "START")}</span>
            <h3>{t("準備好你的 EV3", "Get your EV3 ready")}</h3>
            <p>
              {t(
                "準備一台 EV3 與 USB 連線，或讓電腦和 EV3 位於同一個可信任的 Wi-Fi 網路，再跟著第一個教學開始。",
                "Prepare an EV3 and a USB connection, or put the computer and EV3 on the same trusted Wi-Fi network. Then follow the first tutorial.",
              )}
            </p>
            <AppLink href="/docs/tutorial/getting-ready">{t("開始使用", "Get started")} →</AppLink>
          </article>
        </section>
        <div className="web-tools-callout">
          <div>
            <h2>{t("也可以先試試媒體工具。", "Try the media tools first.")}</h2>
            <p>
              {t(
                "不用安裝桌面版，在瀏覽器就能準備 EV3 圖片與音頻。",
                "Prepare EV3 images and audio in your browser, without installing the desktop app.",
              )}
            </p>
          </div>
          <AppLink className="product-button secondary" href="/tools">
            {t("開啟工具", "Open tools")} →
          </AppLink>
        </div>
      </main>
    </>
  );
}
