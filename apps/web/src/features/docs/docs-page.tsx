import { Icon } from "../../components/ui/icon.js";
import { AppLink } from "../../components/app-link.js";
import { SiteHeader } from "../../components/site-header.js";
import { useEffect } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BasicPlusReference } from "./basic-plus-reference.js";
import { DiagnosticsPage } from "./diagnostics-page.js";
import { DocsSearchPage } from "./docs-search-page.js";
import { KnowledgeSidebar } from "./knowledge-sidebar.js";
import { MarkdownHeading } from "./markdown-heading.js";
import { MarkdownImage } from "./markdown-image.js";
import { MarkdownCallout } from "./markdown-callout.js";
import { MarkdownPre } from "./markdown-code.js";
import { MarkdownTable } from "./markdown-table.js";
import { DocsToc, DocsTocDisclosure, headingsFor, toSlug } from "./docs-toc.js";
import {
  documents,
  findDocument,
  findTutorial,
  tutorials,
  type DocsLocale,
  type DocumentEntry,
  type TutorialEntry,
} from "./docs-content.js";
import "./styles/tokens.css";
import "./styles/layout.css";

type DocsPageProps = {
  locale: DocsLocale;
  onLocaleChange: (locale: DocsLocale) => void;
  path: string;
};

const github = "https://github.com/Kingsley1116/Kobrixa";

const ui = {
  "zh-TW": {
    home: "首頁",
    docs: "文件",
    product: "產品與使用",
    technical: "技術參考",
    examples: "範例與學習",
    examplesBody: "依照學習路徑，從小型程式一路做到機器人挑戰。",
    learningPath: "學習路徑",
    browseExamples: "所有範例",
    tableOfContents: "本頁內容",
    previous: "上一篇",
    next: "下一篇",
    source: "在 GitHub 查看原始檔",
    notFound: "找不到這篇文件。",
    notFoundBody: "這個路徑目前沒有對應的 Kobrixa 文件。",
    backToDocs: "返回文件首頁",
    language: "English",
    guideLabel: "Kobrixa 文件中心",
    overviewTitle: "從第一個程式，到每一次可靠的部署。",
    overviewBody:
      "Kobrixa 的產品說明、安裝指引與工程契約都在這裡。先選擇你的下一步，再深入需要的細節。",
    openGithub: "在 GitHub 開啟",
    updated: "內容來自 Kobrixa 原始碼倉庫",
    start: "開始使用",
    firstLesson: "開始第一課",
    course: "完整課程",
    reference: "參考手冊",
    ready: "準備清單",
    recovery: "常見復原",
    copy: "複製程式",
    copied: "已複製",
    hardware: "需要準備",
    example: "開啟可建置範例",
    safety: "安全提醒",
    basicPlus: "Basic Plus 參考",
    productDocs: "產品文件",
    technicalDocs: "技術文件",
    overview: "總覽",
    syntax: "語法",
    functions: "API 函數",
    diagnostics: "錯誤索引",
  },
  en: {
    home: "Home",
    docs: "Documentation",
    product: "Product & usage",
    technical: "Technical reference",
    examples: "Examples & learning",
    examplesBody: "Follow the learning path from a small program to robot challenges.",
    learningPath: "Learning path",
    browseExamples: "All examples",
    tableOfContents: "On this page",
    previous: "Previous",
    next: "Next",
    source: "View source on GitHub",
    notFound: "This document could not be found.",
    notFoundBody: "This path does not match a Kobrixa document yet.",
    backToDocs: "Back to documentation",
    language: "繁中",
    guideLabel: "Kobrixa documentation",
    overviewTitle: "From a first program to every reliable deployment.",
    overviewBody:
      "Kobrixa's product notes, installation guidance, and engineering contracts live here. Choose your next step, then go deeper when needed.",
    openGithub: "Open on GitHub",
    updated: "Content comes from the Kobrixa source repository",
    start: "Get started",
    firstLesson: "Start lesson one",
    course: "Full course",
    reference: "Reference",
    ready: "Preparation",
    recovery: "Common recovery",
    copy: "Copy code",
    copied: "Copied",
    hardware: "What you need",
    example: "Open runnable example",
    safety: "Safety reminder",
    basicPlus: "Basic Plus reference",
    productDocs: "Product docs",
    technicalDocs: "Technical docs",
    overview: "Overview",
    syntax: "Syntax",
    functions: "API functions",
    diagnostics: "Diagnostic index",
  },
} as const;

function toText(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(toText).join("");
  if (value && typeof value === "object" && "props" in value)
    return toText((value as { props: { children?: ReactNode } }).props.children);
  return "";
}

function normalizeDocLink(href: string | undefined): string | undefined {
  if (!href || href.startsWith("#") || /^(https?:|mailto:)/.test(href)) return href;
  const repositoryPath = /^\.\.\/\.\.\/((?:examples|tests)\/[^#]*)(#.*)?$/.exec(href);
  if (repositoryPath) {
    const path = repositoryPath[1]!;
    return `${github}/${path.endsWith("/") ? "tree" : "blob"}/main/${path}${repositoryPath[2] ?? ""}`;
  }
  const match = /^(?:(?:\.\.\/)?(?:zh-TW|en)\/)?([a-z-]+)\.md(?:#(.*))?$/.exec(href);
  if (!match || !documents.some((document) => document.slug === match[1])) return href;
  const fragment = match[2] ? `#${match[2]}` : "";
  return `/docs/reference/${match[1]}${fragment}`;
}

function MarkdownLink({
  href,
  children,
}: {
  href?: string | undefined;
  children?: ReactNode | undefined;
}) {
  const target = normalizeDocLink(href);
  const external = target?.startsWith("http");
  return (
    <AppLink
      href={target}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
    >
      {children}
      {external ? (
        <span className="external-mark" aria-hidden="true">
          <Icon name="external" />
        </span>
      ) : null}
    </AppLink>
  );
}

function DocSidebar({ locale, activeSlug }: { locale: DocsLocale; activeSlug?: string }) {
  return (
    <KnowledgeSidebar
      locale={locale}
      activePath={activeSlug ? `/docs/reference/${activeSlug}` : "/docs"}
    />
  );
}

function GettingStarted({ locale }: { locale: DocsLocale }) {
  const t = ui[locale];
  const zh = locale === "zh-TW";
  useEffect(() => {
    document.title = zh ? "開始使用 Kobrixa" : "Get started with Kobrixa";
  }, [zh]);
  const first = tutorials[0]!;
  const steps = [
    {
      title: t.ready,
      body: zh
        ? "安裝 Kobrixa。連接 EV3；實機馬達測試前先架高輪子。"
        : "Install Kobrixa. Connect an EV3; lift wheels before physical motor tests.",
      href: "/docs/tutorial/getting-ready",
      label: first.title[locale],
    },
    {
      title: zh ? "第一個程式" : "First program",
      body: zh
        ? "使用 EV3 本體的顯示器與喇叭完成安全的第一次建置。"
        : "Use the EV3 display and speaker for a safe first build.",
      href: "/docs/tutorial/first-program",
      label: t.firstLesson,
    },
    {
      title: t.recovery,
      body: zh
        ? "遇到連線或上傳問題時，停止程式、重新連線，並查閱復原指引。"
        : "If connection or upload fails, stop the program, reconnect, and use the recovery guide.",
      href: "/docs/reference/installation",
      label: zh ? "安裝與復原" : "Installation and recovery",
    },
  ];
  return (
    <main className="docs-layout unified-layout" id="content">
      <KnowledgeSidebar locale={locale} activePath="/docs" />
      <div className="getting-started">
        <header className="landing-heading">
          <p className="eyebrow">
            <span className="eyebrow-marker" />
            {t.start}
          </p>
          <h1>{zh ? "開始使用 Kobrixa" : "Get started with Kobrixa"}</h1>
          <p>
            {zh
              ? "依序完成準備、第一個程式與基礎課程。每一課都可連到現有、可建置的 Kobrixa 專案。"
              : "Work through setup, your first program, and the foundations. Every lesson links to an existing Kobrixa project you can build."}
          </p>
        </header>
        <section className="landing-section" aria-labelledby="start-steps-title">
          <div className="landing-section-heading">
            <h2 id="start-steps-title">{zh ? "三步開始" : "Start in three steps"}</h2>
          </div>
          <ol className="landing-cards">
            {steps.map((step, index) => (
              <li className="landing-card" key={step.href}>
                <span className="lesson-number">{String(index + 1).padStart(2, "0")}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
                <AppLink className="landing-card-link" href={step.href}>
                  {step.label} <Icon name="arrow" />
                </AppLink>
              </li>
            ))}
          </ol>
        </section>
        <section className="landing-section" aria-labelledby="product-guides-title">
          <div className="landing-section-heading">
            <h2 id="product-guides-title">{zh ? "探索目前功能" : "Explore current features"}</h2>
          </div>
          <ul className="landing-cards">
            {[
              { slug: "collaboration", icon: "users" as const },
              { slug: "sensor-lab", icon: "chart" as const },
              { slug: "motor-test", icon: "device" as const },
            ].map(({ slug, icon }) => {
              const guide = findDocument(slug)!;
              return (
                <li className="landing-card" key={slug}>
                  <span className="landing-card-icon" aria-hidden="true">
                    <Icon name={icon} size={20} />
                  </span>
                  <h3>{guide.title[locale]}</h3>
                  <p>{guide.summary[locale]}</p>
                  <AppLink className="landing-card-link" href={`/docs/reference/${slug}`}>
                    {zh ? "閱讀使用指南" : "Read the guide"} <Icon name="arrow" />
                  </AppLink>
                </li>
              );
            })}
          </ul>
        </section>
        <section
          className="landing-callout diagnostic-entry"
          aria-labelledby="diagnostic-entry-title"
        >
          <div>
            <p className="landing-kicker">
              {zh ? "診斷解說與 Quick Fix" : "Diagnostic explanations & Quick Fix"}
            </p>
            <h2 id="diagnostic-entry-title">{zh ? "遇到程式錯誤？" : "Stuck on a code error?"}</h2>
            <p>
              {zh
                ? "用診斷代碼查找原因與範例。IDE 內可離線閱讀完整解說；有確定的修正方式時，選取 Quick Fix 即可套用，也能一步復原。"
                : "Look up a diagnostic code for causes and examples. Read full explanations offline in the IDE; choose a Quick Fix when an unambiguous correction is available, with one-step Undo."}
            </p>
          </div>
          <div className="landing-callout-links">
            <AppLink className="landing-pill-link" href={`/docs/diagnostics?lang=${locale}`}>
              {zh ? "查閱錯誤索引" : "Browse the diagnostic index"} <Icon name="arrow" />
            </AppLink>
            <AppLink
              className="landing-pill-link"
              href={`/docs/reference/keyboard-settings?lang=${locale}`}
            >
              {zh ? "操作與快捷鍵" : "Controls and shortcuts"} <Icon name="arrow" />
            </AppLink>
          </div>
        </section>
        <section className="landing-section" aria-labelledby="course-map-title">
          <div className="landing-section-heading">
            <h2 id="course-map-title">
              {zh ? "12 個單元，從程式到機器人" : "Twelve lessons, from code to robot"}
            </h2>
            <AppLink className="landing-pill-link" href="/docs/tutorial">
              {t.course} <Icon name="arrow" />
            </AppLink>
          </div>
          <ol className="course-map-list">
            {tutorials.map((lesson) => (
              <li key={lesson.slug}>
                <AppLink href={`/docs/tutorial/${lesson.slug}`}>
                  <span className="lesson-number">{lesson.number}</span>
                  <span className="course-map-text">
                    <strong>{lesson.title[locale]}</strong>
                    <span>{lesson.summary[locale]}</span>
                  </span>
                  <span className="course-map-arrow" aria-hidden="true">
                    <Icon name="arrow" />
                  </span>
                </AppLink>
              </li>
            ))}
          </ol>
        </section>
        <section className="landing-callout" aria-labelledby="reference-entry-title">
          <div>
            <p className="landing-kicker">{t.reference}</p>
            <h2 id="reference-entry-title">
              {zh ? "需要查語法或產品契約？" : "Need syntax or product contracts?"}
            </h2>
            <p>
              {zh
                ? "使用 Basic Plus 與 EV3 參考文件查閱語言支援、裝置、架構與路線圖。"
                : "Use the Basic Plus and EV3 reference material for language support, devices, architecture, and the roadmap."}
            </p>
          </div>
          <div className="landing-callout-links">
            <AppLink className="landing-pill-link" href="/docs/reference/basic-plus">
              {t.basicPlus} <Icon name="arrow" />
            </AppLink>
          </div>
        </section>
      </div>
    </main>
  );
}

function TutorialSidebar({ locale, activeSlug }: { locale: DocsLocale; activeSlug?: string }) {
  return (
    <KnowledgeSidebar
      locale={locale}
      activePath={activeSlug ? `/docs/tutorial/${activeSlug}` : "/docs/tutorial"}
    />
  );
}

function TutorialOverview({ locale }: { locale: DocsLocale }) {
  const t = ui[locale];
  const zh = locale === "zh-TW";
  useEffect(() => {
    document.title = zh ? "Kobrixa 完整課程" : "Kobrixa complete course";
  }, [zh]);
  return (
    <main className="docs-layout unified-layout" id="content">
      <KnowledgeSidebar locale={locale} activePath="/docs/tutorial" />
      <div className="tutorial-overview">
        <header className="landing-heading">
          <p className="eyebrow">
            <span className="eyebrow-marker" />
            {t.course}
          </p>
          <h1>
            {zh ? "Kobrixa 與 Basic Plus 完整課程" : "The complete Kobrixa and Basic Plus course"}
          </h1>
          <p>
            {zh
              ? "依序學習；每個單元都有目標、程式碼、實作與可建置的範例。"
              : "Work in order. Each lesson has a goal, code, practice, and a runnable example."}
          </p>
          <p className="landing-meta">
            {zh ? `共 ${tutorials.length} 個單元` : `${tutorials.length} lessons`}
          </p>
        </header>
        <ol className="tutorial-list">
          {tutorials.map((lesson) => (
            <li className="landing-card tutorial-card" key={lesson.slug}>
              <span className="lesson-number">{lesson.number}</span>
              <div className="tutorial-card-body">
                <h2>
                  <AppLink className="landing-card-link" href={`/docs/tutorial/${lesson.slug}`}>
                    {lesson.title[locale]}
                  </AppLink>
                </h2>
                <p>{lesson.summary[locale]}</p>
                <p className="tutorial-card-meta">
                  <span>{t.hardware}</span>
                  {lesson.hardware[locale]}
                </p>
              </div>
              <span className="tutorial-card-arrow" aria-hidden="true">
                <Icon name="arrow" />
              </span>
            </li>
          ))}
        </ol>
      </div>
    </main>
  );
}

function TutorialArticle({ locale, tutorial }: { locale: DocsLocale; tutorial: TutorialEntry }) {
  const t = ui[locale];
  const index = tutorials.findIndex((lesson) => lesson.slug === tutorial.slug);
  const previous = tutorials[index - 1];
  const next = tutorials[index + 1];
  const content = tutorial.content[locale];
  useEffect(() => {
    document.title = `${tutorial.title[locale]} — Kobrixa`;
  }, [locale, tutorial]);
  return (
    <main className="docs-layout docs-article-layout tutorial-article-layout" id="content">
      <TutorialSidebar locale={locale} activeSlug={tutorial.slug} />
      <article className="article">
        <header className="article-header">
          <p className="eyebrow">
            <span className="eyebrow-marker" />
            {t.course} · {tutorial.number}
          </p>
          <h1>{tutorial.title[locale]}</h1>
          <p>{tutorial.summary[locale]}</p>
          <div className="lesson-meta">
            <span>
              {t.hardware}: {tutorial.hardware[locale]}
            </span>
            <AppLink
              href={`${github}/tree/main/examples/${tutorial.example}`}
              target="_blank"
              rel="noreferrer"
            >
              {t.example} <Icon name="external" />
            </AppLink>
          </div>
        </header>
        <div className="article-content tutorial-content">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: MarkdownLink,
              blockquote: MarkdownCallout,
              table: MarkdownTable,
              h2: ({ children }) => (
                <MarkdownHeading level={2} id={toSlug(toText(children))} locale={locale}>
                  {children}
                </MarkdownHeading>
              ),
              h3: ({ children }) => (
                <MarkdownHeading level={3} id={toSlug(toText(children))} locale={locale}>
                  {children}
                </MarkdownHeading>
              ),
              img: ({ src, alt, title }) => <MarkdownImage src={src} alt={alt} title={title} />,
              pre: ({ children }) => (
                <MarkdownPre copyLabel={t.copy} copiedLabel={t.copied}>
                  {children}
                </MarkdownPre>
              ),
            }}
          >
            {content}
          </ReactMarkdown>
        </div>
        <nav className="article-pager" aria-label="Lesson pagination">
          {previous ? (
            <AppLink className="pager-previous" href={`/docs/tutorial/${previous.slug}`}>
              <span>
                <Icon name="arrow-left" /> {t.previous}
              </span>
              <strong>{previous.title[locale]}</strong>
            </AppLink>
          ) : (
            <span />
          )}
          {next ? (
            <AppLink className="pager-next" href={`/docs/tutorial/${next.slug}`}>
              <span>
                {t.next} <Icon name="arrow" />
              </span>
              <strong>{next.title[locale]}</strong>
            </AppLink>
          ) : (
            <span />
          )}
        </nav>
      </article>
    </main>
  );
}

function BasicPlusPage({
  locale,
  apiName,
  syntaxSlug,
}: {
  locale: DocsLocale;
  apiName?: string | undefined;
  syntaxSlug?: string | undefined;
}) {
  const suffix = apiName ? `/api/${apiName}` : syntaxSlug ? `/syntax/${syntaxSlug}` : "";
  const detail = Boolean(apiName || syntaxSlug);
  const links = apiName
    ? [
        ["overview", locale === "zh-TW" ? "說明" : "Description"],
        ["syntax", "Syntax"],
        ["parameters", locale === "zh-TW" ? "參數" : "Parameters"],
        ["return-value", locale === "zh-TW" ? "回傳值" : "Return value"],
        ["examples", locale === "zh-TW" ? "範例" : "Examples"],
        ["related", locale === "zh-TW" ? "相關連結" : "See also"],
      ]
    : [
        ["overview", locale === "zh-TW" ? "說明" : "Description"],
        ["syntax", "Syntax"],
        ["examples", locale === "zh-TW" ? "範例" : "Examples"],
        ["related", locale === "zh-TW" ? "相關連結" : "See also"],
      ];
  return (
    <main
      className={`docs-layout unified-layout${detail ? " reference-detail-layout" : ""}`}
      id="content"
    >
      <KnowledgeSidebar locale={locale} activePath={`/docs/reference/basic-plus${suffix}`} />
      <BasicPlusReference locale={locale} apiName={apiName} syntaxSlug={syntaxSlug} />
      {detail ? (
        <aside
          className="toc reference-toc"
          aria-label={locale === "zh-TW" ? "本頁內容" : "On this page"}
        >
          <p>{locale === "zh-TW" ? "本頁內容" : "On this page"}</p>
          {links.map(([id, label]) => (
            <AppLink href={`#${id}`} key={id}>
              {label}
            </AppLink>
          ))}
        </aside>
      ) : null}
    </main>
  );
}

function Article({ locale, document: entry }: { locale: DocsLocale; document: DocumentEntry }) {
  const t = ui[locale];
  const index = documents.findIndex((document) => document.slug === entry.slug);
  const previous = documents[index - 1];
  const next = documents[index + 1];
  const content = entry.content[locale];
  const headings = headingsFor(content);
  const source = `${github}/blob/main/docs/${locale}/${entry.slug}.md`;
  useEffect(() => {
    window.document.title = `${entry.title[locale]} — Kobrixa`;
  }, [entry, locale]);

  return (
    <main className="docs-layout docs-article-layout" id="content">
      <DocSidebar locale={locale} activeSlug={entry.slug} />
      <article className="article">
        <header className="article-header">
          <p className="eyebrow">
            <span className="eyebrow-marker" />
            {entry.category === "product" ? t.product : t.technical}
          </p>
          <h1>{entry.title[locale]}</h1>
          <p>{entry.summary[locale]}</p>
          <AppLink className="source-link" href={source} target="_blank" rel="noreferrer">
            {t.source}{" "}
            <span aria-hidden="true">
              <Icon name="external" />
            </span>
          </AppLink>
        </header>
        <DocsTocDisclosure headings={headings} label={t.tableOfContents} />
        <div className="article-content">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: MarkdownLink,
              blockquote: MarkdownCallout,
              table: MarkdownTable,
              h2: ({ children }) => (
                <MarkdownHeading level={2} id={toSlug(toText(children))} locale={locale}>
                  {children}
                </MarkdownHeading>
              ),
              h3: ({ children }) => (
                <MarkdownHeading level={3} id={toSlug(toText(children))} locale={locale}>
                  {children}
                </MarkdownHeading>
              ),
              img: ({ src, alt, title }) => <MarkdownImage src={src} alt={alt} title={title} />,
              pre: ({ children }) => (
                <MarkdownPre copyLabel={t.copy} copiedLabel={t.copied}>
                  {children}
                </MarkdownPre>
              ),
            }}
          >
            {content}
          </ReactMarkdown>
        </div>
        <nav className="article-pager" aria-label="Document pagination">
          {previous ? (
            <AppLink className="pager-previous" href={`/docs/reference/${previous.slug}`}>
              <span>
                <Icon name="arrow-left" /> {t.previous}
              </span>
              <strong>{previous.title[locale]}</strong>
            </AppLink>
          ) : (
            <span />
          )}
          {next ? (
            <AppLink className="pager-next" href={`/docs/reference/${next.slug}`}>
              <span>
                {t.next} <Icon name="arrow" />
              </span>
              <strong>{next.title[locale]}</strong>
            </AppLink>
          ) : (
            <span />
          )}
        </nav>
      </article>
      <DocsToc headings={headings} label={t.tableOfContents} />
    </main>
  );
}

function NotFound({ locale }: { locale: DocsLocale }) {
  const t = ui[locale];
  const zh = locale === "zh-TW";
  useEffect(() => {
    document.title = zh ? "找不到文件 — Kobrixa" : "Document not found — Kobrixa";
  }, [zh]);
  return (
    <main className="doc-not-found" id="content">
      <p className="landing-kicker">404</p>
      <h1>{t.notFound}</h1>
      <p>{t.notFoundBody}</p>
      <div className="doc-not-found-actions">
        <AppLink className="button primary" href="/docs">
          {t.backToDocs}{" "}
          <span aria-hidden="true">
            <Icon name="arrow" />
          </span>
        </AppLink>
        <AppLink className="landing-pill-link" href={`/docs/search?lang=${locale}`}>
          {zh ? "搜尋所有文件" : "Search all documentation"} <Icon name="arrow" />
        </AppLink>
      </div>
    </main>
  );
}

export function DocsPage({ locale, onLocaleChange, path }: DocsPageProps) {
  const segments = path
    .replace(/^\/docs\/?/, "")
    .split("/")
    .filter(Boolean);
  const [section, slug, itemType, itemName] = segments;
  const legacyDocument = !section ? undefined : findDocument(section);
  const view =
    path === "/docs" || path === "/docs/" ? (
      <GettingStarted locale={locale} />
    ) : section === "search" && segments.length === 1 ? (
      <main className="docs-layout unified-layout" id="content">
        <KnowledgeSidebar locale={locale} activePath={path} />
        <DocsSearchPage locale={locale} />
      </main>
    ) : section === "diagnostics" && segments.length <= 2 ? (
      <main className="docs-layout unified-layout" id="content">
        <KnowledgeSidebar locale={locale} activePath={path} />
        <DiagnosticsPage locale={locale} code={slug} />
      </main>
    ) : section === "tutorial" && !slug ? (
      <TutorialOverview locale={locale} />
    ) : section === "tutorial" && findTutorial(slug) ? (
      <TutorialArticle locale={locale} tutorial={findTutorial(slug)!} />
    ) : section === "reference" && slug === "basic-plus" ? (
      <BasicPlusPage
        locale={locale}
        apiName={itemType === "api" ? itemName : undefined}
        syntaxSlug={itemType === "syntax" ? itemName : undefined}
      />
    ) : section === "reference" && findDocument(slug) ? (
      <Article locale={locale} document={findDocument(slug)!} />
    ) : legacyDocument ? (
      <Article locale={locale} document={legacyDocument} />
    ) : (
      <NotFound locale={locale} />
    );
  return (
    <>
      <AppLink className="skip-link" href="#content">
        {locale === "zh-TW" ? "跳到主要內容" : "Skip to content"}
      </AppLink>
      <SiteHeader locale={locale} page="docs" onLocaleChange={onLocaleChange} />
      {view}
    </>
  );
}
