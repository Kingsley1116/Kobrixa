import { AppLink } from "../../components/app-link.js";
import { SiteHeader } from "../../components/site-header.js";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { apiEntries, apiRoute, BasicPlusReference, syntaxEntries } from "./basic-plus-reference.js";
import {
  documents,
  findDocument,
  findTutorial,
  tutorials,
  type DocsLocale,
  type DocumentEntry,
  type TutorialEntry,
} from "./docs-content.js";

type DocsPageProps = {
  locale: DocsLocale;
  onLocaleChange: (locale: DocsLocale) => void;
  path: string;
};
type Heading = { level: 2 | 3; text: string; id: string };

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
  },
} as const;

function toText(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(toText).join("");
  if (value && typeof value === "object" && "props" in value)
    return toText((value as { props: { children?: ReactNode } }).props.children);
  return "";
}

function toSlug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/(^-|-$)/g, "");
}

function headingsFor(content: string): Heading[] {
  return content.split("\n").flatMap((line) => {
    const match = /^(#{2,3})\s+(.+)$/.exec(line);
    if (!match) return [];
    const markers = match[1];
    const heading = match[2];
    if (!markers || !heading) return [];
    const text = heading.replace(/[`*_]/g, "");
    return [{ level: markers.length as 2 | 3, text, id: toSlug(text) }];
  });
}

function normalizeDocLink(href: string | undefined): string | undefined {
  if (!href || href.startsWith("#") || /^(https?:|mailto:)/.test(href)) return href;
  const match = /(?:\.\.\/)?(?:zh-TW|en)\/([a-z-]+)\.md(?:#(.*))?$/.exec(href);
  if (!match) return href;
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
          ↗
        </span>
      ) : null}
    </AppLink>
  );
}

function KnowledgeSidebar({ locale, activePath }: { locale: DocsLocale; activePath: string }) {
  const t = ui[locale];
  const sidebarRef = useRef<HTMLElement>(null);
  const active = (path: string) =>
    activePath === path ||
    (path === "/docs/reference/basic-plus" && activePath.startsWith(`${path}/`))
      ? "active"
      : "";
  const inSection = (path: string) => activePath === path || activePath.startsWith(`${path}/`);
  const categories =
    locale === "zh-TW"
      ? {
          motor: "馬達",
          sensor: "感測器",
          display: "顯示",
          speaker: "聲音",
          button: "按鍵",
          file: "檔案",
          mailbox: "信箱",
          program: "本體與執行期",
          math: "數學",
          utility: "文字與工具",
        }
      : {
          motor: "Motors",
          sensor: "Sensors",
          display: "Display",
          speaker: "Sound",
          button: "Buttons",
          file: "Files",
          mailbox: "Mailboxes",
          program: "Brick and runtime",
          math: "Math",
          utility: "Text, data, and utilities",
        };
  useEffect(() => {
    if (window.matchMedia("(min-width: 721px)").matches)
      sidebarRef.current
        ?.querySelector<HTMLAnchorElement>("a.active")
        ?.scrollIntoView({ block: "nearest" });
  }, [activePath]);
  return (
    <aside className="doc-sidebar knowledge-sidebar" aria-label={t.docs} ref={sidebarRef}>
      <section>
        <p>{t.start}</p>
        <AppLink className={`sidebar-parent ${active("/docs")}`} href="/docs">
          {t.start}
        </AppLink>
      </section>
      <details open={inSection("/docs/tutorial")}>
        <summary className="ui-disclosure">{t.course}</summary>
        <AppLink className={`sidebar-parent ${active("/docs/tutorial")}`} href="/docs/tutorial">
          {t.overview}
        </AppLink>
        {tutorials.map((lesson) => (
          <AppLink
            className={`sidebar-child ${active(`/docs/tutorial/${lesson.slug}`)}`}
            href={`/docs/tutorial/${lesson.slug}`}
            key={lesson.slug}
          >
            <span>{lesson.number}</span>
            {lesson.title[locale]}
          </AppLink>
        ))}
      </details>
      <details open={inSection("/docs/reference/basic-plus")}>
        <summary className="ui-disclosure">{t.basicPlus}</summary>
        <AppLink
          className={`sidebar-parent ${active("/docs/reference/basic-plus")}`}
          href="/docs/reference/basic-plus"
        >
          {t.overview}
        </AppLink>
        <details
          className="sidebar-syntax-group"
          open={activePath.startsWith("/docs/reference/basic-plus/syntax/")}
        >
          <summary className="ui-disclosure">{t.syntax}</summary>
          {syntaxEntries.map((entry) => (
            <AppLink
              className={`sidebar-child ${active(`/docs/reference/basic-plus/syntax/${entry.slug}`)}`}
              href={`/docs/reference/basic-plus/syntax/${entry.slug}`}
              key={entry.slug}
            >
              {entry.title[locale]}
            </AppLink>
          ))}
        </details>
        <p className="sidebar-level">{t.functions}</p>
        {Object.entries(categories).map(([category, label]) => {
          const operations = apiEntries.filter((operation) => operation.category === category);
          const namespaces = [
            ...new Set(operations.map((operation) => operation.name.split(".")[0]!)),
          ];
          return (
            <details
              className="sidebar-api-group"
              open={operations.some((operation) => activePath === apiRoute(operation))}
              key={category}
            >
              <summary className="ui-disclosure">{label}</summary>
              {namespaces.map((namespace) => {
                const members = operations.filter((operation) =>
                  operation.name.startsWith(`${namespace}.`),
                );
                return (
                  <details
                    className="sidebar-api-namespace"
                    open={members.some((operation) => activePath === apiRoute(operation))}
                    key={namespace}
                  >
                    <summary className="ui-disclosure">{namespace}</summary>
                    {members.map((operation) => (
                      <AppLink
                        aria-label={operation.name}
                        className={`sidebar-child sidebar-api ${active(apiRoute(operation))}`}
                        href={apiRoute(operation)}
                        key={operation.name}
                      >
                        {operation.name.slice(namespace.length + 1)}
                      </AppLink>
                    ))}
                  </details>
                );
              })}
            </details>
          );
        })}
      </details>
      <details
        open={
          inSection("/docs/reference") &&
          documents.some(
            (document) =>
              document.category === "product" && activePath === `/docs/reference/${document.slug}`,
          )
        }
      >
        <summary className="ui-disclosure">{t.productDocs}</summary>
        {documents
          .filter((document) => document.category === "product")
          .map((document) => (
            <AppLink
              className={`sidebar-child ${active(`/docs/reference/${document.slug}`)}`}
              href={`/docs/reference/${document.slug}`}
              key={document.slug}
            >
              {document.title[locale]}
            </AppLink>
          ))}
      </details>
      <details
        open={
          inSection("/docs/reference") &&
          documents.some(
            (document) =>
              document.category === "technical" &&
              activePath === `/docs/reference/${document.slug}`,
          )
        }
      >
        <summary className="ui-disclosure">{t.technicalDocs}</summary>
        {documents
          .filter((document) => document.category === "technical")
          .map((document) => (
            <AppLink
              className={`sidebar-child ${active(`/docs/reference/${document.slug}`)}`}
              href={`/docs/reference/${document.slug}`}
              key={document.slug}
            >
              {document.title[locale]}
            </AppLink>
          ))}
      </details>
      <section className="sidebar-examples">
        <p>{t.examples}</p>
        <AppLink
          href={`${github}/blob/main/examples/LEARNING-PATH.md`}
          target="_blank"
          rel="noreferrer"
        >
          {t.learningPath} <span aria-hidden="true">↗</span>
        </AppLink>
        <AppLink href={`${github}/tree/main/examples`} target="_blank" rel="noreferrer">
          {t.browseExamples} <span aria-hidden="true">↗</span>
        </AppLink>
      </section>
    </aside>
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
  useEffect(() => {
    document.title = locale === "zh-TW" ? "開始使用 Kobrixa" : "Get started with Kobrixa";
  }, [locale]);
  const first = tutorials[0]!;
  return (
    <main className="docs-layout unified-layout" id="content">
      <KnowledgeSidebar locale={locale} activePath="/docs" />
      <div className="getting-started">
        <section className="start-heading">
          <p className="eyebrow">
            <span className="eyebrow-marker" />
            {t.start}
          </p>
          <h1>{locale === "zh-TW" ? "開始使用 Kobrixa" : "Get started with Kobrixa"}</h1>
          <p>
            {locale === "zh-TW"
              ? "依序完成準備、第一個程式與基礎課程。每一課都可連到現有、可建置的 Kobrixa 專案。"
              : "Work through setup, your first program, and the foundations. Every lesson links to an existing Kobrixa project you can build."}
          </p>
        </section>
        <section className="start-checklist">
          <div>
            <span>01</span>
            <h2>{t.ready}</h2>
            <p>
              {locale === "zh-TW"
                ? "安裝 Kobrixa、連接一台 EV3，馬達測試前先架高輪子。"
                : "Install Kobrixa, connect one EV3, and lift wheels before motor tests."}
            </p>
            <AppLink href="/docs/tutorial/getting-ready">{first.title[locale]} →</AppLink>
          </div>
          <div>
            <span>02</span>
            <h2>{locale === "zh-TW" ? "第一個程式" : "First program"}</h2>
            <p>
              {locale === "zh-TW"
                ? "使用 EV3 本體的顯示器與喇叭完成安全的第一次建置。"
                : "Use the EV3 display and speaker for a safe first build."}
            </p>
            <AppLink href="/docs/tutorial/first-program">{t.firstLesson} →</AppLink>
          </div>
          <div>
            <span>03</span>
            <h2>{t.recovery}</h2>
            <p>
              {locale === "zh-TW"
                ? "遇到連線或上傳問題時，停止程式、重新連線，並查閱復原指引。"
                : "If connection or upload fails, stop the program, reconnect, and use the recovery guide."}
            </p>
            <AppLink href="/docs/reference/installation">
              {locale === "zh-TW" ? "安裝與復原 →" : "Installation and recovery →"}
            </AppLink>
          </div>
        </section>
        <section className="course-map">
          <div className="course-map-header">
            <div>
              <p className="eyebrow">
                <span className="eyebrow-marker" />
                {t.course}
              </p>
              <h2>
                {locale === "zh-TW"
                  ? "12 個單元，從程式到機器人。"
                  : "Twelve lessons, from code to robot."}
              </h2>
            </div>
            <AppLink className="button primary" href="/docs/tutorial">
              {t.course} <span aria-hidden="true">→</span>
            </AppLink>
          </div>
          <ol>
            {tutorials.map((lesson) => (
              <li key={lesson.slug}>
                <AppLink href={`/docs/tutorial/${lesson.slug}`}>
                  <span>{lesson.number}</span>
                  <div>
                    <strong>{lesson.title[locale]}</strong>
                    <p>{lesson.summary[locale]}</p>
                  </div>
                  <i aria-hidden="true">→</i>
                </AppLink>
              </li>
            ))}
          </ol>
        </section>
        <section className="reference-entry">
          <div>
            <p className="eyebrow">
              <span className="eyebrow-marker" />
              {t.reference}
            </p>
            <h2>
              {locale === "zh-TW" ? "需要查語法或產品契約？" : "Need syntax or product contracts?"}
            </h2>
            <p>
              {locale === "zh-TW"
                ? "使用 Basic Plus 與 EV3 參考文件查閱語言支援、裝置、架構與路線圖。"
                : "Use the Basic Plus and EV3 reference material for language support, devices, architecture, and the roadmap."}
            </p>
          </div>
          <AppLink className="text-link" href="/docs/reference/basic-plus">
            {t.basicPlus} →
          </AppLink>
        </section>
      </div>
    </main>
  );
}

function CopyCode({
  value,
  label,
  copiedLabel,
}: {
  value: string;
  label: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard?.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <button className="copy-code" onClick={() => void copy()}>
      {copied ? "✓" : "⧉"} {copied ? copiedLabel : label}
    </button>
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
  useEffect(() => {
    document.title = locale === "zh-TW" ? "Kobrixa 完整課程" : "Kobrixa complete course";
  }, [locale]);
  return (
    <main className="docs-layout unified-layout" id="content">
      <KnowledgeSidebar locale={locale} activePath="/docs/tutorial" />
      <div className="tutorial-overview">
        <section className="docs-intro">
          <p className="eyebrow">
            <span className="eyebrow-marker" />
            {t.course}
          </p>
          <h1>
            {locale === "zh-TW"
              ? "Kobrixa 與 Basic Plus 完整課程"
              : "The complete Kobrixa and Basic Plus course"}
          </h1>
          <p>
            {locale === "zh-TW"
              ? "依序學習；每個單元都有目標、程式碼、實作與可建置的範例。"
              : "Work in order. Each lesson has a goal, code, practice, and a runnable example."}
          </p>
        </section>
        <div className="tutorial-grid">
          {tutorials.map((lesson) => (
            <AppLink href={`/docs/tutorial/${lesson.slug}`} key={lesson.slug}>
              <span>{lesson.number}</span>
              <h2>{lesson.title[locale]}</h2>
              <p>{lesson.summary[locale]}</p>
              <small>
                {t.hardware}: {lesson.hardware[locale]}
              </small>
              <i aria-hidden="true">→</i>
            </AppLink>
          ))}
        </div>
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
              {t.example} ↗
            </AppLink>
          </div>
        </header>
        <div className="article-content tutorial-content">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: MarkdownLink,
              h2: ({ children }) => <h2 id={toSlug(toText(children))}>{children}</h2>,
              h3: ({ children }) => <h3 id={toSlug(toText(children))}>{children}</h3>,
              pre: ({ children }) => (
                <div className="code-block">
                  <CopyCode value={toText(children)} label={t.copy} copiedLabel={t.copied} />
                  <pre>{children}</pre>
                </div>
              ),
            }}
          >
            {content}
          </ReactMarkdown>
        </div>
        <nav className="article-pager" aria-label="Lesson pagination">
          {previous ? (
            <AppLink href={`/docs/tutorial/${previous.slug}`}>
              <span>← {t.previous}</span>
              <strong>{previous.title[locale]}</strong>
            </AppLink>
          ) : (
            <span />
          )}
          {next ? (
            <AppLink href={`/docs/tutorial/${next.slug}`}>
              <span>{t.next} →</span>
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
            {t.source} <span aria-hidden="true">↗</span>
          </AppLink>
        </header>
        <div className="article-content">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: MarkdownLink,
              h2: ({ children }) => <h2 id={toSlug(toText(children))}>{children}</h2>,
              h3: ({ children }) => <h3 id={toSlug(toText(children))}>{children}</h3>,
            }}
          >
            {content}
          </ReactMarkdown>
        </div>
        <nav className="article-pager" aria-label="Document pagination">
          {previous ? (
            <AppLink href={`/docs/reference/${previous.slug}`}>
              <span>← {t.previous}</span>
              <strong>{previous.title[locale]}</strong>
            </AppLink>
          ) : (
            <span />
          )}
          {next ? (
            <AppLink href={`/docs/reference/${next.slug}`}>
              <span>{t.next} →</span>
              <strong>{next.title[locale]}</strong>
            </AppLink>
          ) : (
            <span />
          )}
        </nav>
      </article>
      <aside className="toc" aria-label={t.tableOfContents}>
        <p>{t.tableOfContents}</p>
        {headings.map((heading) => (
          <AppLink
            className={heading.level === 3 ? "nested" : ""}
            href={`#${heading.id}`}
            key={heading.id}
          >
            {heading.text}
          </AppLink>
        ))}
      </aside>
    </main>
  );
}

function NotFound({ locale }: { locale: DocsLocale }) {
  const t = ui[locale];
  useEffect(() => {
    document.title = locale === "zh-TW" ? "找不到文件 — Kobrixa" : "Document not found — Kobrixa";
  }, [locale]);
  return (
    <main className="doc-not-found" id="content">
      <p className="eyebrow">
        <span className="eyebrow-marker" />
        404
      </p>
      <h1>{t.notFound}</h1>
      <p>{t.notFoundBody}</p>
      <AppLink className="button primary" href="/docs">
        {t.backToDocs} <span aria-hidden="true">→</span>
      </AppLink>
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
