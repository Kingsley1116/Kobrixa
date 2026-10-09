import { Icon, type IconName } from "../../components/ui/icon.js";
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
  const features: {
    tag: string;
    icon: IconName;
    title: string;
    body: string;
    link: string;
    label: string;
  }[] = [
    {
      icon: "code",
      tag: "EDITOR",
      title: t("在本機，專心寫程式。", "A focused place to write."),
      body: t(
        "在多個專案間切換，保留分頁與草稿。使用補全、雙語離線診斷與 Quick Fix；編輯器與編譯器不需要雲端帳號。",
        "Switch between projects while keeping tabs and drafts. Use completion, bilingual offline diagnostics and Quick Fix without a cloud account.",
      ),
      link: "/docs/tutorial/first-program",
      label: t("寫第一個程式", "Write your first program"),
    },
    {
      icon: "build",
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
      icon: "device",
      tag: "CONNECTION",
      title: t("把程式帶到機器人上。", "Put your code on the brick."),
      body: t(
        "透過 USB 或 Wi-Fi 上傳、執行、停止程式及管理 EV3 檔案。內建馬達點動、定時與角度測試；三平台實機矩陣仍待完成。",
        "Upload, run and stop programs and manage EV3 files over USB or Wi-Fi. Test motors with jog, timed and angle controls; the three-platform hardware matrix remains pending.",
      ),
      link: "/docs/reference/device-support",
      label: t("查看裝置支援", "Check device support"),
    },
    {
      icon: "simulator",
      tag: "LOCAL SIMULATOR",
      title: t("沒有 EV3，也能先試跑。", "Try your program before connecting."),
      body: t(
        "按 Alt+F5 開啟本地 WRO Double Tennis 2026 模擬器。支援差速與全向驅動、多機程式、感測器及變數檢視；物理為近似，不能取代實機驗證。",
        "Open the local WRO Double Tennis 2026 simulator with Alt+F5. Explore differential and omni drives, multiple robot programs, sensors and variables. Approximate physics does not replace physical testing.",
      ),
      link: "/docs/reference/offline-preview",
      label: t("探索本地模擬器", "Explore the local simulator"),
    },
    {
      icon: "users",
      tag: "COLLABORATION",
      title: t("同一個專案，一起完成。", "Work on the same project together."),
      body: t(
        "不需帳號，以邀請碼與選填密碼共同編輯、聊天及分配 EV3 控制權。candidate.14 提供本機變更處理與更新的房間面板；協作需要網路連線。",
        "Co-edit, chat and share EV3 control using an invite code and optional password, without an account. Candidate.14 adds local-change choices and an updated room panel. Collaboration requires internet access.",
      ),
      link: "/docs/reference/collaboration",
      label: t("了解雲端協作", "Explore cloud collaboration"),
    },
    {
      icon: "chart",
      tag: "SENSOR LAB",
      title: t("把讀值，變成看得見的曲線。", "Turn readings into visible patterns."),
      body: t(
        "記錄感測器與馬達計數、比較實驗曲線，並匯出 CSV。兩點校正與歸零可產生 Basic Plus 範例，方便帶回程式使用。",
        "Record sensor readings and motor counts, compare experiments and export CSV. Generate Basic Plus examples for two-point calibration and zeroing.",
      ),
      link: "/docs/reference/sensor-lab",
      label: t("使用 Sensor Lab", "Use Sensor Lab"),
    },
    {
      icon: "audio",
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
      icon: "image",
      tag: "COMMUNITY GALLERY",
      title: t("讓素材，也能一起分享。", "Share what your robot shows and plays."),
      body: t(
        "瀏覽與下載已審核的 EV3 圖片、音訊及播放範例。用 GitHub 登入後可提交作品，經審核後以 CC BY 4.0 公開分享。",
        "Browse and download reviewed EV3 images, audio and playback examples. Sign in with GitHub to submit your own work for review and publication under CC BY 4.0.",
      ),
      link: "/gallery",
      label: t("瀏覽社群素材庫", "Browse the community gallery"),
    },
    {
      icon: "book",
      tag: "LEARNING",
      title: t("從小練習，走到完整專案。", "Start small. Build something real."),
      body: t(
        "透過教學、API 參考和可閱讀的範例，逐步練習顯示、聲音、馬達與感測器，再組合成自己的機器人專案。",
        "Learn displays, sound, motors and sensors through tutorials, API references and readable examples, then bring them together in a robot project.",
      ),
      link: "/docs/tutorial",
      label: t("瀏覽學習路徑", "Explore the learning path"),
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
                {t("取得 Kobrixa", "Get Kobrixa")}{" "}
                <span>
                  <Icon name="external" />
                </span>
              </AppLink>
              <AppLink className="product-button secondary" href="/docs">
                {t("開始學習", "Start learning")}{" "}
                <span>
                  <Icon name="arrow" />
                </span>
              </AppLink>
            </div>
            <p className="product-note">
              v{metadata.version} · {t("本機優先", "Local-first")} · Apache-2.0
            </p>
          </div>
          <div className="feature-visual">
            <div className="visual-caption">
              <span className="visual-dot" /> BASIC PLUS <Icon name="arrow" /> EV3
            </div>
            <div className="product-code">
              <div>
                <span className="code-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>{" "}
                original-media.bp
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
              <i aria-hidden="true">
                <Icon name="arrow" />
              </i>
              <span>
                .rbf <small>{t("建置成品", "Build")}</small>
              </span>
              <i aria-hidden="true">
                <Icon name="arrow" />
              </i>
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
            {features.map((feature, index) => (
              <article className="capability-card" key={feature.tag}>
                <div className="capability-meta">
                  <span>
                    <Icon name={feature.icon} size={20} />
                  </span>
                  <span>{feature.tag}</span>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                </div>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
                <AppLink
                  href={feature.link}
                  {...(feature.link.startsWith("https:")
                    ? { target: "_blank", rel: "noreferrer" }
                    : {})}
                >
                  {feature.label}{" "}
                  <span aria-hidden="true">
                    <Icon name="external" />
                  </span>
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
                "目前候選版已包含本地模擬器、雲端協作與設備實驗工具。接下來持續完成 Basic Plus 相容覆蓋、三平台實機驗收與發布驗證。Python、TypeScript、C++ 前端、藍牙與積木編輯器仍屬未來規劃。",
                "The current candidate includes local simulation, cloud collaboration and device experiments. Work continues on Basic Plus compatibility, three-platform hardware acceptance and release verification. Python, TypeScript and C++ frontends, Bluetooth and a block editor remain future plans.",
              )}
            </p>
          </div>
          <AppLink className="product-button secondary" href="/docs/reference/roadmap">
            {t("查看開發路線圖", "View the roadmap")} <Icon name="arrow" />
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
                "Kobrixa 桌面版目前為 v1 候選版，已實作安裝套件與自動更新。請到 GitHub Releases 選擇已發布的版本，或取得原始碼自行建置。",
                "The Kobrixa desktop app is a v1 candidate with installer packaging and automatic updates implemented. Choose a published version on GitHub Releases, or build from source.",
              )}
            </p>
            <div className="product-actions">
              <AppLink className="product-button primary" href={`${github}/releases`}>
                {t("查看已發布版本", "View published releases")}{" "}
                <span>
                  <Icon name="external" />
                </span>
              </AppLink>
              <AppLink
                className="product-button secondary"
                href={`${github}/archive/refs/heads/main.zip`}
                target="_blank"
                rel="noreferrer"
              >
                {t("下載原始碼 ZIP", "Download source ZIP")} <Icon name="download" />
              </AppLink>
              <AppLink className="product-inline-link" href="/docs/reference/code-signing">
                Code signing policy <Icon name="external" />
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
                "此為網站對應的原始碼版本。可下載套件與逐平台簽章狀態以各 Release 為準；三平台 USB／Wi-Fi 實機矩陣尚待完成。",
                "This is the website's source version. Available packages and per-platform signing status are listed in each release; the three-platform USB / Wi-Fi hardware matrix is still pending.",
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
              {t("安裝與復原說明", "Installation & recovery")} <Icon name="external" />
            </AppLink>
          </div>
          <div className="download-platforms">
            {["Windows", "macOS", "Linux"].map((platform, index) => (
              <article key={platform} className="download-platform">
                <span className="platform-glyph" aria-hidden="true">
                  <Icon
                    name={
                      platform === "Windows" ? "windows" : platform === "macOS" ? "mac" : "terminal"
                    }
                  />
                </span>
                <h3>{platform}</h3>
                <span className="platform-state">
                  {["x64 · NSIS", "Apple Silicon · DMG", "x64 · AppImage"][index]}
                </span>
                <p>
                  {platform === "Linux"
                    ? t(
                        "USB 存取可能需要 EV3 專用的 udev 規則，詳見安裝文件。",
                        "USB access may require an EV3-specific udev rule. See the installation guide.",
                      )
                    : t(
                        "請依 Release 說明選擇套件，確認該版本的簽章與驗收狀態。",
                        "Choose a package using its release notes and check that version's signing and acceptance status.",
                      )}
                </p>
                <AppLink href={`${github}/releases`}>
                  {t("查看版本與下載", "View releases and downloads")} <Icon name="external" />
                </AppLink>
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
              {t("閱讀完整安裝說明", "Read the installation guide")} <Icon name="external" />
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
            <AppLink href="/docs/tutorial/getting-ready">
              {t("開始使用", "Get started")} <Icon name="arrow" />
            </AppLink>
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
            {t("開啟工具", "Open tools")} <Icon name="arrow" />
          </AppLink>
        </div>
      </main>
    </>
  );
}
