import { useEffect, useState } from "react";
import { DIAGNOSTIC_HELP } from "@kobrixa/compiler/diagnostic-help";
import { Icon, type IconName } from "../../components/ui/icon.js";
import { AppLink } from "../../components/app-link.js";
import { SiteHeader } from "../../components/site-header.js";
import { BRAND_TAGLINES } from "../../shared/brand.js";
import { docsImageUrl } from "../../shared/docs-images.js";
import { PLATFORMS, RELEASES_URL, formatSize } from "../../shared/releases.js";
import { platformInfo, useLatestRelease, visitorPlatform } from "../../shared/latest-release.js";
import metadata from "../../../../../package.json" with { type: "json" };
import "./home-page.css";

type Locale = "zh-TW" | "en";
type Props = { locale: Locale; onLocaleChange: (locale: Locale) => void };
type Highlight = {
  tag: string;
  shot: string;
  title: string;
  body: string;
  points: string[];
  link: { href: string; label: string };
};

const github = "https://github.com/Kingsley1116/Kobrixa";

/** Docs screenshots are 3200×1944; fixed dimensions keep the layout from shifting while they load. */
function HomeShot({ src, alt, eager = false }: { src: string; alt: string; eager?: boolean }) {
  return (
    <div className="hm-shot">
      <span className="hm-shot-bar" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <img
        src={src}
        alt={alt}
        width={3200}
        height={1944}
        decoding="async"
        {...(eager ? { fetchPriority: "high" as const } : { loading: "lazy" as const })}
      />
    </div>
  );
}

function Eyebrow({ children }: { children: string }) {
  return (
    <p className="hm-eyebrow">
      <i aria-hidden="true" />
      {children}
    </p>
  );
}

export function HomePage({ locale, onLocaleChange }: Props) {
  const t = (zh: string, en: string) => (locale === "zh-TW" ? zh : en);
  const shot = (name: string) => docsImageUrl(`${name}-${locale}.png`);
  const [platform] = useState(visitorPlatform);
  const release = useLatestRelease();
  useEffect(() => {
    document.title = `Kobrixa — ${BRAND_TAGLINES[locale]}`;
  }, [locale]);

  const loaded = typeof release === "object" ? release : null;
  const primary = platform ? (loaded?.platforms[platform].installer ?? null) : null;
  const ordered = platform ? [platform, ...PLATFORMS.filter((p) => p !== platform)] : PLATFORMS;

  const steps = [
    [
      t("寫下程式", "Write"),
      t("用 Basic Plus 描述機器人該做什麼。", "Describe what your robot should do in Basic Plus."),
    ],
    [
      t("本機建置", "Build"),
      t("檢查程式並編譯成原生 EV3 .rbf。", "Check the program and compile it to native EV3 .rbf."),
    ],
    [
      t("連接 EV3", "Connect"),
      t("透過 USB 或受信任網路的 Wi-Fi。", "Over USB, or Wi-Fi on a trusted network."),
    ],
    [
      t("上傳並執行", "Run"),
      t("送上主機、執行、停止，再改下一版。", "Upload, run, stop, and refine the next idea."),
    ],
  ];

  const highlights: Highlight[] = [
    {
      tag: "DIAGNOSTICS",
      shot: "diagnostics",
      title: t("錯誤訊息，也能讀得懂。", "Errors you can actually read."),
      body: t(
        `${DIAGNOSTIC_HELP.length} 個診斷代碼都有繁體中文與英文的離線解說，直接告訴你哪裡出錯、該怎麼改。`,
        `All ${DIAGNOSTIC_HELP.length} diagnostic codes come with offline explanations in English and Traditional Chinese that say what went wrong and how to fix it.`,
      ),
      points: [
        t("確定的語法缺漏可一鍵 Quick Fix", "One-click Quick Fix for unambiguous syntax gaps"),
        t("每次修正都能一步 Undo", "Every fix can be undone in one step"),
      ],
      link: {
        href: `/docs/diagnostics?lang=${locale}`,
        label: t("查看診斷說明", "Browse diagnostics"),
      },
    },
    {
      tag: "SENSOR LAB",
      shot: "sensor-lab",
      title: t("把讀值，變成看得見的曲線。", "Turn readings into visible patterns."),
      body: t(
        "即時記錄感測器與馬達計數，比較多次實驗並匯出 CSV。",
        "Record sensor readings and motor counts live, compare runs and export CSV.",
      ),
      points: [
        t("最多四個通道同時繪圖", "Plot up to four channels at once"),
        t(
          "兩點校正後產生可直接複製的 Basic Plus",
          "Two-point calibration generates Basic Plus to copy",
        ),
      ],
      link: { href: "/docs/reference/sensor-lab", label: t("使用 Sensor Lab", "Use Sensor Lab") },
    },
    {
      tag: "COLLABORATION",
      shot: "collaboration",
      title: t("同一個專案，一起完成。", "Work on the same project together."),
      body: t(
        "用邀請碼開房間，即時共同編輯、共享檔案樹與聊天，不需要帳號。",
        "Open a room with an invite code to co-edit, share the file tree and chat. No account needed.",
      ),
      points: [
        t("由一個人持有 EV3 控制權，隨時交接", "One person holds EV3 control and can pass it on"),
        t("重新加入前先處理本機變更", "Resolve local changes before rejoining"),
      ],
      link: {
        href: "/docs/reference/collaboration",
        label: t("了解雲端協作", "Explore collaboration"),
      },
    },
  ];

  const extras: [IconName, string, string, string?][] = [
    [
      "shield",
      t("離線優先", "Offline-first"),
      t(
        "編輯、建置與診斷都在你的電腦上完成，不需雲端帳號。",
        "Editing, builds and diagnostics run on your computer, no cloud account required.",
      ),
    ],
    [
      "device",
      t("不必更換韌體", "No firmware swap"),
      t(
        "直接產生原生 EV3 .rbf，保留主機原本的韌體。",
        "Produces native EV3 .rbf files and keeps the brick's stock firmware.",
      ),
    ],
    [
      "image",
      t("畫面與聲音", "Images & sound"),
      t(
        "在瀏覽器製作 RGF 圖片與 RSF 音訊，或下載社群素材。",
        "Make RGF images and RSF audio in your browser, or grab community assets.",
      ),
      "/gallery",
    ],
  ];

  const lessons = [
    t("顯示與按鈕", "Displays & buttons"),
    t("感測器", "Sensors"),
    t("聲音與動作", "Sound & motion"),
  ];

  return (
    <>
      <AppLink className="skip-link" href="#content">
        {t("跳到主要內容", "Skip to content")}
      </AppLink>
      <SiteHeader locale={locale} page="home" onLocaleChange={onLocaleChange} />

      <main id="content" className="home-page">
        <section className="hm-hero" id="top" aria-labelledby="hm-title">
          <div className="hm-hero-copy">
            <Eyebrow>{t("為 EV3 而生的程式環境", "A PROGRAMMING ENVIRONMENT FOR EV3")}</Eyebrow>
            <h1 id="hm-title">{BRAND_TAGLINES[locale]}</h1>
            <p className="hm-lead">
              {t(
                "從 Basic Plus 編輯與編譯，到 USB／Wi-Fi 實機部署；也能邀請夥伴共同編輯，讓每個想法一起前進。",
                "Write and compile Basic Plus, then deploy over USB or Wi-Fi. Invite others to edit with you and move ideas forward together.",
              )}
            </p>
            <div className="hm-actions">
              <AppLink className="hm-button hm-button-primary" href={primary?.url ?? "/download"}>
                <Icon name="download" />
                {platform
                  ? t(
                      `下載 ${platformInfo[platform].name} 版`,
                      `Download for ${platformInfo[platform].name}`,
                    )
                  : t("下載 Kobrixa", "Download Kobrixa")}
              </AppLink>
              <AppLink className="hm-button" href="/docs">
                {t("開始學習", "Start learning")} <Icon name="arrow" />
              </AppLink>
            </div>
            <p className="hm-meta">
              <span>v{loaded?.version ?? metadata.version}</span>
              <span>{t("離線優先", "Offline-first")}</span>
              <span>{t("免費開源", "Free & open source")}</span>
              <a href={github} target="_blank" rel="noreferrer">
                GitHub <Icon name="external" />
              </a>
            </p>
          </div>
          <div className="hm-hero-visual">
            <HomeShot
              src={shot("editor")}
              alt={t("Kobrixa 編輯器畫面", "The Kobrixa editor")}
              eager
            />
            <div className="hm-lcd" aria-hidden="true">
              <span>EV3</span>
              <strong>Hello from Kobrixa</strong>
            </div>
          </div>
        </section>

        <section className="hm-steps" aria-label={t("從程式到機器人", "From code to robot")}>
          <ol>
            {steps.map(([title, body], index) => (
              <li key={title}>
                <span>0{index + 1}</span>
                <h2>{title}</h2>
                <p>{body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="hm-section" aria-labelledby="hm-highlights-title">
          <div className="hm-section-head">
            <Eyebrow>{t("少一點猜測", "LESS GUESSING")}</Eyebrow>
            <h2 id="hm-highlights-title">
              {t("每一步，都有看得見的回饋。", "Useful feedback at every step.")}
            </h2>
          </div>
          {highlights.map((item, index) => (
            <article
              className={`hm-highlight${index % 2 ? " hm-highlight-flip" : ""}`}
              key={item.tag}
            >
              <div className="hm-highlight-copy">
                <p className="hm-tag">{item.tag}</p>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
                <ul>
                  {item.points.map((point) => (
                    <li key={point}>
                      <Icon name="check" />
                      {point}
                    </li>
                  ))}
                </ul>
                <AppLink className="hm-link" href={item.link.href}>
                  {item.link.label} <Icon name="arrow" />
                </AppLink>
              </div>
              <HomeShot src={shot(item.shot)} alt={item.title} />
            </article>
          ))}
          <div className="hm-extras">
            {extras.map(([icon, title, body, href]) => (
              <article key={title}>
                <span className="hm-extra-icon" aria-hidden="true">
                  <Icon name={icon} />
                </span>
                <h3>{title}</h3>
                <p>{body}</p>
                {href && (
                  <AppLink className="hm-link" href={href}>
                    {t("瀏覽素材庫", "Browse the gallery")} <Icon name="arrow" />
                  </AppLink>
                )}
              </article>
            ))}
          </div>
          <p className="hm-more">
            <AppLink className="hm-link" href="/features">
              {t("探索全部功能", "Explore all features")} <Icon name="arrow" />
            </AppLink>
          </p>
        </section>

        <section className="hm-learn" id="learn" aria-labelledby="hm-learn-title">
          <div>
            <Eyebrow>{t("從一個小專案開始", "BEGIN WITH A SMALL PROJECT")}</Eyebrow>
            <h2 id="hm-learn-title">
              {t("學習時，手邊就有能跑的範例。", "Examples you can run while you learn.")}
            </h2>
            <p>
              {t(
                "依照學習路徑，從顯示、按鈕、感測器到完整的機器人挑戰。每個範例都附帶可閱讀的原始碼。",
                "Follow a learning path from displays, buttons, and sensors to complete robot challenges. Every example includes source you can read.",
              )}
            </p>
            <a
              className="hm-link"
              href={`${github}/tree/main/examples`}
              target="_blank"
              rel="noreferrer"
            >
              {t("瀏覽全部範例", "Browse all examples")} <Icon name="external" />
            </a>
          </div>
          <ol className="hm-lessons">
            {lessons.map((lesson, index) => (
              <li key={lesson}>
                <AppLink href="/docs/tutorial">
                  <span>0{index + 1}</span>
                  <strong>{lesson}</strong>
                  <Icon name="arrow" />
                </AppLink>
              </li>
            ))}
          </ol>
        </section>

        <section className="hm-download" id="download" aria-labelledby="hm-download-title">
          <Eyebrow>{t("取得桌面版", "GET THE DESKTOP APP")}</Eyebrow>
          <h2 id="hm-download-title">
            {t("從你的電腦，開始 EV3 專案。", "Start an EV3 project on your computer.")}
          </h2>
          <div className="hm-platforms">
            {ordered.map((p) => {
              const file = loaded?.platforms[p].installer ?? null;
              const info = platformInfo[p];
              return (
                <AppLink
                  key={p}
                  className={`hm-platform${p === platform ? " hm-platform-current" : ""}`}
                  href={file?.url ?? "/download"}
                >
                  <span className="hm-platform-icon" aria-hidden="true">
                    <Icon name={info.icon} />
                  </span>
                  <span className="hm-platform-text">
                    <strong>{info.name}</strong>
                    <small>
                      {file
                        ? `${info.installer} · ${info.arch} · ${formatSize(file.size)}`
                        : `${info.installer} · ${info.arch}`}
                    </small>
                  </span>
                  <Icon name={file ? "download" : "arrow"} />
                </AppLink>
              );
            })}
          </div>
          <p className="hm-download-links">
            <AppLink className="hm-link" href="/download">
              {t("安裝說明與其他格式", "Setup guide & other formats")} <Icon name="arrow" />
            </AppLink>
            <a className="hm-link" href={RELEASES_URL} target="_blank" rel="noreferrer">
              {t("查看所有版本", "All releases")} <Icon name="external" />
            </a>
          </p>
        </section>
      </main>
    </>
  );
}
