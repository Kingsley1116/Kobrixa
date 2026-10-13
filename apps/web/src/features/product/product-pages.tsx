import { Icon } from "../../components/ui/icon.js";
import { AppLink } from "../../components/app-link.js";
import { useEffect, type ReactNode } from "react";
import { SiteHeader } from "../../components/site-header.js";
import { docsImageUrl } from "../../shared/docs-images.js";
import { DiagnosticShowcase } from "./diagnostic-showcase.js";
import { featureContent, type Stage } from "./feature-content.js";
import metadata from "../../../../../package.json" with { type: "json" };
import "./product-pages.css";

type Locale = "zh-TW" | "en";
type Props = { locale: Locale; onLocaleChange: (locale: Locale) => void };
const mediaCode =
  'LCD.Clear()\nLCD.BmpFile(1, 0, 0, "assets/deploy/kobrixa-mascot")\nLCD.Update()\nSpeaker.Play(35, "assets/deploy/kobrixa-chime")\nSpeaker.Wait()';

/** Docs screenshots are 3200×1944; fixed dimensions keep the layout from shifting while they load. */
function Screenshot({ name, alt, eager = false }: { name: string; alt: string; eager?: boolean }) {
  return (
    <div className="fp-shot">
      <span className="fp-shot-bar" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <img
        src={docsImageUrl(name)}
        alt={alt}
        width={3200}
        height={1944}
        decoding="async"
        {...(eager ? { fetchPriority: "high" as const } : { loading: "lazy" as const })}
      />
    </div>
  );
}

function StageSection({
  stage,
  visual,
  flip = false,
}: {
  stage: Stage;
  visual: ReactNode;
  flip?: boolean;
}) {
  return (
    <section
      className={flip ? "fp-stage is-flipped" : "fp-stage"}
      id={stage.id}
      aria-labelledby={`${stage.id}-title`}
    >
      <div className="fp-stage-copy">
        <p className="fp-eyebrow">
          <span className="fp-step">{stage.step}</span>
          {stage.tag}
        </p>
        <h2 id={`${stage.id}-title`}>{stage.title}</h2>
        <p className="fp-lead">{stage.lead}</p>
        <dl className="fp-points">
          {stage.points.map(([title, body]) => (
            <div key={title}>
              <dt>
                <Icon name="check" />
                {title}
              </dt>
              <dd>{body}</dd>
            </div>
          ))}
        </dl>
        <AppLink className="fp-text-link" href={stage.link.href}>
          {stage.link.label} <Icon name="arrow" />
        </AppLink>
      </div>
      <div className="fp-stage-visual">{visual}</div>
    </section>
  );
}

export function FeaturesPage({ locale, onLocaleChange }: Props) {
  const t = (zh: string, en: string) => (locale === "zh-TW" ? zh : en);
  useEffect(() => {
    document.title = locale === "zh-TW" ? "功能 — Kobrixa" : "Features — Kobrixa";
  }, [locale]);
  const { stages, tools, audiences, offline, online, faq } = featureContent(t, locale);
  const [write, build, run] = stages as [Stage, Stage, Stage];
  const [collab, sensor, ...compact] = tools;
  const nav = [
    ...stages.map((stage) => ({ id: stage.id, step: stage.step, label: stage.nav })),
    { id: "diagnostics-quick-fix", step: "✓", label: t("診斷", "Diagnostics") },
    { id: "more", step: "+", label: t("延伸工具", "More tools") },
    { id: "faq", step: "?", label: t("常見問題", "FAQ") },
  ];
  const log: [string, string, string][] = [
    ["ok", t("已連線", "Connected"), "USB · EV3"],
    ["skip", t("略過未變更", "Skipped, unchanged"), "kobrixa-mascot.rgf"],
    ["skip", t("略過未變更", "Skipped, unchanged"), "kobrixa-chime.rsf"],
    ["ok", t("已上傳", "Uploaded"), "original-media.rbf"],
    ["run", t("執行中", "Running"), "original-media.rbf"],
  ];

  return (
    <>
      <AppLink className="skip-link" href="#content">
        {t("跳到主要內容", "Skip to content")}
      </AppLink>
      <SiteHeader locale={locale} page="features" onLocaleChange={onLocaleChange} />
      <main id="content" className="product-page">
        <section className="fp-hero" aria-labelledby="fp-title">
          <div className="fp-hero-copy">
            <p className="fp-eyebrow">
              <i aria-hidden="true" />
              {t("功能", "FEATURES")}
            </p>
            <h1 id="fp-title">{t("寫下想法，\n看它動起來。", "Write an idea.\nWatch it move.")}</h1>
            <p className="fp-hero-lead">
              {t(
                "Kobrixa 把編寫、編譯和上機串成一條路：在自己的電腦上寫 Basic Plus，編譯成原生 .rbf，再用 USB 或 Wi-Fi 送到 EV3。不需帳號，離線也能用。",
                "Kobrixa connects writing, building and running into one path: write Basic Plus on your own computer, compile it to native .rbf and send it to your EV3 over USB or Wi-Fi. No account. Works offline.",
              )}
            </p>
            <div className="product-actions">
              <AppLink className="product-button primary" href="/download">
                {t("取得 Kobrixa", "Get Kobrixa")} <Icon name="download" />
              </AppLink>
              <AppLink className="product-button secondary" href="/docs">
                {t("開始學習", "Start learning")} <Icon name="arrow" />
              </AppLink>
            </div>
            <ul className="fp-chips" aria-label={t("版本資訊", "Release facts")}>
              <li>v{metadata.version}</li>
              <li>{t("本機優先", "Local-first")}</li>
              <li>Apache-2.0</li>
              <li>Windows · macOS · Linux</li>
            </ul>
          </div>
          <div className="fp-hero-visual">
            <Screenshot
              name={`editor-${locale}.png`}
              alt={t(
                "Kobrixa 編輯器：專案檔案、Basic Plus 程式碼與建置面板",
                "The Kobrixa editor with project files, Basic Plus code and the build panel",
              )}
              eager
            />
            <ol className="fp-path" aria-label={t("程式建置流程", "Build workflow")}>
              <li>
                .bp <small>{t("原始碼", "Source")}</small>
              </li>
              <li>
                .rbf <small>{t("建置成品", "Build")}</small>
              </li>
              <li>
                EV3 <small>{t("實際動作", "Motion")}</small>
              </li>
            </ol>
          </div>
        </section>

        <nav className="fp-nav" aria-label={t("本頁內容", "On this page")}>
          <ol>
            {nav.map((item) => (
              <li key={item.id}>
                <a href={`#${item.id}`}>
                  <span aria-hidden="true">{item.step}</span>
                  {item.label}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <StageSection
          stage={write}
          visual={
            <Screenshot
              name={`diagnostics-${locale}.png`}
              alt={t(
                "編輯器中的雙語診斷解說與 Quick Fix",
                "Bilingual diagnostic explanations and Quick Fix in the editor",
              )}
            />
          }
        />
        <StageSection
          stage={build}
          flip
          visual={
            <div className="fp-build">
              <div className="fp-code">
                <div className="fp-code-title">
                  <span className="fp-dots" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  original-media.bp
                </div>
                <pre>
                  <code>{mediaCode}</code>
                </pre>
              </div>
              <ol className="fp-pipeline">
                <li>
                  <code>.bp</code>
                  <span>{t("解析與檢查", "Parse & check")}</span>
                </li>
                <li>
                  <code>KobrixaIR</code>
                  <span>{t("驗證中介表示", "Validated IR")}</span>
                </li>
                <li>
                  <code>.rbf</code>
                  <span>{t("EV3 原生執行檔", "Native EV3 executable")}</span>
                </li>
              </ol>
              <p className="fp-caption">
                {t(
                  "取自原創媒體範例；部署時會一併上傳圖片與音訊素材。",
                  "From the original-media example; its image and audio assets are deployed with it.",
                )}
              </p>
            </div>
          }
        />
        <StageSection
          stage={run}
          visual={
            <figure className="fp-device">
              <figcaption>
                <span>
                  <Icon name="device" /> EV3
                </span>
                <span className="fp-live">USB</span>
              </figcaption>
              <ol>
                {log.map(([state, label, file], index) => (
                  <li key={index} className={`is-${state}`}>
                    <Icon name={state === "run" ? "play" : state === "skip" ? "minus" : "check"} />
                    <span>{label}</span>
                    <code>{file}</code>
                  </li>
                ))}
              </ol>
              <div className="fp-device-actions" aria-hidden="true">
                <span>
                  <Icon name="upload" /> {t("上傳", "Upload")}
                </span>
                <span>
                  <Icon name="play" /> {t("執行", "Run")}
                </span>
                <span>
                  <Icon name="stop" /> {t("停止", "Stop")}
                </span>
              </div>
              <p className="fp-caption">
                {t(
                  "示意：每個操作都會回報結構化結果。",
                  "Illustration: every operation reports a structured result.",
                )}
              </p>
            </figure>
          }
        />

        <DiagnosticShowcase locale={locale} />

        <section className="fp-section" id="more" aria-labelledby="more-title">
          <div className="fp-heading">
            <p className="fp-eyebrow">
              <i aria-hidden="true" />
              {t("延伸工具", "BEYOND THE BASICS")}
            </p>
            <h2 id="more-title">{t("寫完之後，還能做更多。", "More once the code runs.")}</h2>
          </div>
          <div className="fp-feature-grid">
            {[collab!, sensor!].map((tool) => (
              <article className="fp-feature" key={tool.tag}>
                <div className="fp-feature-copy">
                  <p className="fp-tag">
                    <Icon name={tool.icon} /> {tool.tag}
                  </p>
                  <h3>{tool.title}</h3>
                  <p>{tool.body}</p>
                  <AppLink className="fp-text-link" href={tool.link.href}>
                    {tool.link.label} <Icon name="arrow" />
                  </AppLink>
                </div>
                <Screenshot name={tool.shot!} alt={tool.title} />
              </article>
            ))}
          </div>
          <div className="fp-tool-grid">
            {compact.map((tool) => (
              <article className="fp-tool" key={tool.tag}>
                <p className="fp-tag">
                  <Icon name={tool.icon} /> {tool.tag}
                </p>
                <h3>{tool.title}</h3>
                <p>{tool.body}</p>
                <AppLink className="fp-text-link" href={tool.link.href}>
                  {tool.link.label} <Icon name="arrow" />
                </AppLink>
              </article>
            ))}
          </div>
        </section>

        <section className="fp-section" aria-labelledby="audience-title">
          <div className="fp-heading">
            <p className="fp-eyebrow">
              <i aria-hidden="true" />
              {t("適合誰", "WHO IT’S FOR")}
            </p>
            <h2 id="audience-title">
              {t("為正在學、正在做、正在教的人。", "For people learning, making and teaching.")}
            </h2>
          </div>
          <ul className="fp-audience">
            {audiences.map(([icon, title, body]) => (
              <li key={title}>
                <span aria-hidden="true">
                  <Icon name={icon} size={20} />
                </span>
                <h3>{title}</h3>
                <p>{body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="fp-section" aria-labelledby="offline-title">
          <div className="fp-heading">
            <p className="fp-eyebrow">
              <i aria-hidden="true" />
              {t("本機優先", "LOCAL-FIRST")}
            </p>
            <h2 id="offline-title">
              {t("核心功能，全部在你的電腦上。", "The core runs on your computer.")}
            </h2>
            <p>
              {t(
                "Wi-Fi 只用來連線 EV3，不是雲端依賴。只有和他人分享或取得線上內容時才需要網路。",
                "Wi-Fi is for talking to your EV3, not a cloud dependency. You only need the internet to share with others or fetch online content.",
              )}
            </p>
          </div>
          <div className="fp-compare">
            <div className="is-offline">
              <h3>
                <Icon name="shield" /> {t("離線可用", "Works offline")}
              </h3>
              <ul>
                {offline.map((item) => (
                  <li key={item}>
                    <Icon name="check" /> {item}
                  </li>
                ))}
              </ul>
            </div>
            <div className="is-online">
              <h3>
                <Icon name="external" /> {t("需要網路", "Needs internet")}
              </h3>
              <ul>
                {online.map((item) => (
                  <li key={item}>
                    <Icon name="arrow" /> {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className="fp-section fp-faq" id="faq" aria-labelledby="faq-title">
          <div className="fp-heading">
            <p className="fp-eyebrow">
              <i aria-hidden="true" />
              FAQ
            </p>
            <h2 id="faq-title">{t("常見問題", "Common questions")}</h2>
          </div>
          <div className="fp-faq-list">
            {faq.map(([question, answer, link]) => (
              <details key={question}>
                <summary>
                  {question}
                  <Icon name="plus" />
                </summary>
                <p>
                  {answer}
                  {link && (
                    <>
                      {" "}
                      <AppLink href={link.href}>
                        {link.label} <Icon name="arrow" />
                      </AppLink>
                    </>
                  )}
                </p>
              </details>
            ))}
          </div>
        </section>

        <section className="fp-closing" aria-labelledby="closing-title">
          <div>
            <p className="fp-eyebrow">
              <i aria-hidden="true" />
              {t("下一步", "WHAT’S NEXT")}
            </p>
            <h2 id="closing-title">
              {t("把現在做好，再走向下一步。", "Build the foundation. Then go further.")}
            </h2>
            <p>
              {t(
                "接下來會持續擴充 Basic Plus 相容性與 EV3 API 覆蓋，並加入命令列工具；Python、TypeScript 與 C++ 前端排在之後。",
                "Next comes broader Basic Plus compatibility, more EV3 API coverage and a command-line tool, followed by Python, TypeScript and C++ frontends.",
              )}
            </p>
          </div>
          <div className="product-actions">
            <AppLink className="product-button primary" href="/download">
              {t("下載 Kobrixa", "Download Kobrixa")} <Icon name="download" />
            </AppLink>
            <AppLink className="product-button secondary" href="/docs/reference/roadmap">
              {t("查看開發路線圖", "View the roadmap")} <Icon name="arrow" />
            </AppLink>
          </div>
        </section>
      </main>
    </>
  );
}
