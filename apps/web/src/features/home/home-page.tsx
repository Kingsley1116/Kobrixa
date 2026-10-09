import { Icon } from "../../components/ui/icon.js";
import { AppLink } from "../../components/app-link.js";
import { SiteHeader } from "../../components/site-header.js";
import { DIAGNOSTIC_HELP } from "@kobrixa/compiler/diagnostic-help";
import metadata from "../../../../../package.json" with { type: "json" };
import { useEffect } from "react";

type Locale = "zh-TW" | "en";

const github = "https://github.com/Kingsley1116/Kobrixa";

const copy = {
  "zh-TW": {
    hero: {
      label: "為 EV3 而生的程式環境",
      title: "用程式，讓創意真的動起來。",
      body: "從 Basic Plus 編輯、編譯與本地模擬，到 USB／Wi-Fi 實機部署；也能邀請夥伴共同編輯，讓每個想法一起前進。",
      learn: "開始學習",
      source: "查看原始碼",
      note: `v${metadata.version} · 離線優先 · 開源`,
    },
    proof: ["從 .bp 原始碼開始", "在本機建置 .rbf", "USB 或 Wi-Fi 連接"],
    features: {
      eyebrow: "為清楚的實作流程設計",
      title: "少一點猜測，多一點實際回饋。",
      cards: [
        [
          "離線也能專心做",
          "編輯、建置與完整診斷解說都在你的電腦上完成，不需要雲端帳號或持續網路連線。",
        ],
        [
          "讀得懂的診斷",
          `${DIAGNOSTIC_HELP.length} 個診斷代碼提供中英雙語離線解說。遇到可確定修正的語法問題，可選取 Quick Fix，並隨時復原。`,
          "/docs/diagnostics?lang=zh-TW",
        ],
        ["為實體機器人而建", "將支援的 Basic Plus 程式編譯為原生 EV3 .rbf，然後上傳、執行、停止。"],
        [
          "先在本機試跑",
          "內建 WRO Double Tennis 2026 模擬場地，觀察機器人、感測器與變數，不需要連接 EV3。物理模型為近似，仍需實機驗證。",
          "/docs/reference/offline-preview",
        ],
        [
          "邀請夥伴一起寫",
          "用邀請碼加入雲端房間，即時共同編輯、聊天與分配 EV3 控制權。支援返回最近房間，並在重新加入前處理本機變更。",
          "/docs/reference/collaboration",
        ],
        [
          "準備畫面與聲音",
          "在瀏覽器製作 RGF 圖片與 RSF 音訊，也能從社群素材庫下載已審核作品及使用範例。",
          "/gallery",
        ],
      ],
    },
    flow: {
      eyebrow: "一條能看見終點的路",
      title: "從想法到機器人的四個步驟。",
      steps: [
        ["01", "寫下程式", "以熟悉的 Basic Plus 開始，專心描述機器人該做什麼。"],
        ["02", "在本機建置", "Kobrixa 會檢查程式並產生可部署的 EV3 成品。"],
        ["03", "連接你的 EV3", "透過 USB 搜尋，或輸入受信任網路中的 Wi-Fi 位址。"],
        ["04", "上傳並觀察", "把程式送上主機，執行、停止，再調整下一個想法。"],
      ],
    },
    learn: {
      eyebrow: "從一個小專案開始",
      title: "學習時，手邊就有能跑的範例。",
      body: "依照學習路徑，從顯示、按鈕、感測器到完整的機器人挑戰。每個範例都附帶可閱讀的原始碼。",
      path: "查看學習路徑",
      examples: "瀏覽全部範例",
      cards: ["顯示與按鈕", "感測器", "聲音與動作"],
    },
    download: {
      eyebrow: "取得桌面版",
      title: "從你的電腦，開始 EV3 專案。",
      body: "Windows、macOS 與 Linux 的安裝與自動更新流程已實作。前往下載頁查看 GitHub Releases 的可用版本、安裝方式與簽署狀態。",
      status: "v1 候選版 · 可用版本以 Releases 為準",
    },
  },
  en: {
    hero: {
      label: "A programming environment for EV3",
      title: "Make ideas move with code.",
      body: "Write and compile Basic Plus, try it in the local simulator, then deploy over USB or Wi-Fi. Invite others to edit with you and move ideas forward together.",
      learn: "Start learning",
      source: "View source",
      note: `v${metadata.version} · Offline-first · Open source`,
    },
    proof: ["Start with .bp source", "Build .rbf locally", "Connect over USB or Wi-Fi"],
    features: {
      eyebrow: "Built for a clear path from code to robot",
      title: "Less guessing. More useful feedback.",
      cards: [
        [
          "Stay focused offline",
          "Editing, builds and full diagnostic explanations happen on your computer, without a cloud account or a continuous internet connection.",
        ],
        [
          "Diagnostics that make sense",
          `${DIAGNOSTIC_HELP.length} diagnostic codes have offline explanations in English and Traditional Chinese. Choose a Quick Fix for supported, unambiguous syntax errors, then undo it whenever needed.`,
          "/docs/diagnostics?lang=en",
        ],
        [
          "Made for physical robots",
          "Compile supported Basic Plus programs to native EV3 .rbf files, then upload, run, and stop them.",
        ],
        [
          "Try it locally first",
          "Explore the WRO Double Tennis 2026 field, robots, sensors and variables without an EV3. The physics model is approximate; physical testing is still needed.",
          "/docs/reference/offline-preview",
        ],
        [
          "Invite others to build with you",
          "Join cloud rooms by invite code to co-edit, chat and share EV3 control. Return to recent rooms and resolve local changes before rejoining.",
          "/docs/reference/collaboration",
        ],
        [
          "Prepare images and sound",
          "Make RGF images and RSF audio in your browser, or download reviewed community assets with usage examples from the gallery.",
          "/gallery",
        ],
      ],
    },
    flow: {
      eyebrow: "A path with a visible finish line",
      title: "Four steps from an idea to a robot.",
      steps: [
        [
          "01",
          "Write the program",
          "Start with familiar Basic Plus and describe what your robot should do.",
        ],
        [
          "02",
          "Build locally",
          "Kobrixa checks your program and produces an EV3 artifact ready to deploy.",
        ],
        [
          "03",
          "Connect your EV3",
          "Search over USB or enter a Wi-Fi address on a trusted network.",
        ],
        [
          "04",
          "Upload and observe",
          "Send the program to the brick, run it, stop it, and refine the next idea.",
        ],
      ],
    },
    learn: {
      eyebrow: "Begin with a small project",
      title: "Examples you can run while you learn.",
      body: "Follow a learning path from displays, buttons, and sensors to complete robot challenges. Every example includes source you can read.",
      path: "View learning path",
      examples: "Browse all examples",
      cards: ["Displays & buttons", "Sensors", "Sound & motion"],
    },
    download: {
      eyebrow: "Get the desktop app",
      title: "Start an EV3 project on your computer.",
      body: "Installer and automatic update workflows are implemented for Windows, macOS and Linux. Visit the download page for available GitHub Releases, setup instructions and signing status.",
      status: "v1 candidate · Availability follows Releases",
    },
  },
} as const;

function CodeWorkbench({ locale }: { locale: Locale }) {
  return (
    <div
      className="workbench"
      aria-label={locale === "zh-TW" ? "Kobrixa 編輯器示意" : "Kobrixa editor illustration"}
    >
      <div className="workbench-bar">
        <span className="dot orange" />
        <span className="dot yellow" />
        <span className="dot blue" />
        <span>hello-ev3 / main.bp</span>
      </div>
      <div className="workbench-body">
        <div className="code-lines" aria-hidden="true">
          <span>1</span>
          <span>2</span>
          <span>3</span>
          <span>4</span>
          <span>5</span>
          <span>6</span>
        </div>
        <pre>
          <code>
            LCD.Clear()
            <br />
            LCD.Text(<b>1</b>, <b>8</b>, <b>18</b>, <b>1</b>, <strong>"Hello from Kobrixa"</strong>)
            <br />
            LCD.Line(<b>1</b>, <b>8</b>, <b>38</b>, <b>165</b>, <b>38</b>)<br />
            LCD.Update()
            <br />
            Speaker.Tone(<b>35</b>, <b>440</b>, <b>180</b>)<br />
            Program.Delay(<b>250</b>)
          </code>
        </pre>
      </div>
      <div className="workbench-status">
        <span>
          <Icon name="check" /> {locale === "zh-TW" ? "本機建置" : "Local build"}
        </span>
        <span>{locale === "zh-TW" ? "編輯器示意" : "Editor illustration"}</span>
      </div>
    </div>
  );
}

export function HomePage({
  locale,
  onLocaleChange,
}: {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
}) {
  const t = copy[locale];
  useEffect(() => {
    document.title =
      locale === "zh-TW" ? "Kobrixa — 用程式驅動創意" : "Kobrixa — Make ideas move with code";
  }, [locale]);
  const learnPath = `${github}/blob/main/examples/LEARNING-PATH.md`;

  return (
    <>
      <AppLink className="skip-link" href="#content">
        {locale === "zh-TW" ? "跳到主要內容" : "Skip to content"}
      </AppLink>
      <SiteHeader locale={locale} page="home" onLocaleChange={onLocaleChange} />

      <main id="content">
        <section className="hero" id="top">
          <div className="hero-copy">
            <p className="eyebrow">
              <span className="eyebrow-marker" />
              {t.hero.label}
            </p>
            <h1>{t.hero.title}</h1>
            <p className="hero-body">{t.hero.body}</p>
            <div className="hero-actions">
              <AppLink className="button primary" href="/docs">
                {t.hero.learn}{" "}
                <span aria-hidden="true">
                  <Icon name="arrow" />
                </span>
              </AppLink>
              <AppLink className="button secondary" href={github} target="_blank" rel="noreferrer">
                {t.hero.source}{" "}
                <span aria-hidden="true">
                  <Icon name="external" />
                </span>
              </AppLink>
            </div>
            <p className="hero-note">{t.hero.note}</p>
          </div>
          <div className="hero-visual">
            <div className="tape">BASIC PLUS</div>
            <CodeWorkbench locale={locale} />
            <div className="brick" aria-hidden="true">
              <div className="brick-screen">
                <span>EV3</span>
                <i />
              </div>
              <div className="brick-controls">
                <b>
                  <Icon name="chevron-left" />
                </b>
                <b>
                  <Icon name="chevron-up" />
                </b>
                <b>
                  <Icon name="chevron-right" />
                </b>
              </div>
              <div className="brick-ports">
                <span />
                <span />
                <span />
                <span />
              </div>
            </div>
          </div>
        </section>

        <section
          className="proof"
          aria-label={locale === "zh-TW" ? "Kobrixa 工作流程" : "Kobrixa workflow summary"}
        >
          {t.proof.map((item, index) => (
            <div key={item}>
              <span>0{index + 1}</span>
              <p>{item}</p>
            </div>
          ))}
        </section>

        <section className="section feature-section" id="features">
          <p className="eyebrow">
            <span className="eyebrow-marker" />
            {t.features.eyebrow}
          </p>
          <h2>{t.features.title}</h2>
          <AppLink className="text-link" href="/features">
            {locale === "zh-TW" ? "探索全部功能" : "Explore all features"} <Icon name="arrow" />
          </AppLink>
          <div className="feature-grid">
            {t.features.cards.map(([title, body, href], index) => (
              <article className="feature-card" key={title}>
                <span className={`feature-number feature-${index + 1}`}>0{index + 1}</span>
                <h3>{title}</h3>
                <p>{body}</p>
                {href && (
                  <AppLink className="feature-diagnostics-link" href={href}>
                    {locale === "zh-TW" ? "了解更多" : "Learn more"} <Icon name="arrow" />
                  </AppLink>
                )}
              </article>
            ))}
          </div>
        </section>

        <section className="section flow-section">
          <div className="section-intro">
            <p className="eyebrow">
              <span className="eyebrow-marker" />
              {t.flow.eyebrow}
            </p>
            <h2>{t.flow.title}</h2>
          </div>
          <ol className="flow-list">
            {t.flow.steps.map(([number, title, body]) => (
              <li key={number}>
                <span>{number}</span>
                <div>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="learn-section" id="learn">
          <div className="learn-copy">
            <p className="eyebrow">
              <span className="eyebrow-marker" />
              {t.learn.eyebrow}
            </p>
            <h2>{t.learn.title}</h2>
            <p>{t.learn.body}</p>
            <div className="learn-actions">
              <AppLink className="button primary" href={learnPath} target="_blank" rel="noreferrer">
                {t.learn.path}{" "}
                <span aria-hidden="true">
                  <Icon name="external" />
                </span>
              </AppLink>
              <AppLink
                className="text-link"
                href={`${github}/tree/main/examples`}
                target="_blank"
                rel="noreferrer"
              >
                {t.learn.examples}{" "}
                <span aria-hidden="true">
                  <Icon name="arrow" />
                </span>
              </AppLink>
            </div>
          </div>
          <div className="lesson-stack">
            {t.learn.cards.map((card, index) => (
              <div className={`lesson lesson-${index + 1}`} key={card}>
                <span>0{index + 1}</span>
                <strong>{card}</strong>
                <i aria-hidden="true">
                  <Icon name="arrow" />
                </i>
              </div>
            ))}
          </div>
        </section>

        <section className="download-section" id="download">
          <p className="eyebrow">
            <span className="eyebrow-marker" />
            {t.download.eyebrow}
          </p>
          <h2>{t.download.title}</h2>
          <p className="download-body">{t.download.body}</p>
          <div className="platform-grid">
            {[
              ["Windows", "NSIS (.exe)"],
              ["macOS", "DMG (.dmg)"],
              ["Linux", "AppImage"],
            ].map(([platform, format]) => (
              <article className="platform-card" key={platform}>
                <span className="platform-icon" aria-hidden="true">
                  <Icon
                    name={
                      platform === "Windows" ? "windows" : platform === "macOS" ? "mac" : "terminal"
                    }
                  />
                </span>
                <h3>{platform}</h3>
                <span className="soon-label">{format}</span>
              </article>
            ))}
          </div>
          <div className="download-footer">
            <span>
              <i />
              {t.download.status}
            </span>
            <AppLink className="text-link" href="/download">
              {locale === "zh-TW" ? "查看下載與安裝方式" : "View download & setup options"}{" "}
              <span aria-hidden="true">
                <Icon name="external" />
              </span>
            </AppLink>
          </div>
        </section>
      </main>
    </>
  );
}
